import { Pool, PoolClient, PoolConfig } from "pg";
import { buildScrollMap, IAnalyticsRepository, PageActivity, RetentionResult, ScrollMapResult, UpsertResult } from "./repository";
import { SCHEMA_SQL } from "./schema";
import { canonicalPageKey, snapshotId } from "../services/pageKey";
import {
  Project,
  RawClickRecord,
  RawScrollRecord,
  PageSnapshot,
  HeatmapQuery,
  Activity,
  DeviceType,
  DropCounts,
  DropEntry,
  DropReason,
  PageIndexRow
} from "../types";

export const MIGRATE_LOCK = 7461123;

const DEFAULT_POOL_CONFIG: Partial<PoolConfig> = {
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
};

async function canonicalizeColumn(client: PoolClient, table: "raw_clicks" | "raw_scrolls"): Promise<void> {
  const res = await client.query(`SELECT DISTINCT page_url FROM ${table}`);
  for (const row of res.rows) {
    const key = canonicalPageKey(row.page_url);
    if (key && key !== row.page_url) {
      await client.query(`UPDATE ${table} SET page_url = $1 WHERE page_url = $2`, [key, row.page_url]);
    }
  }
}

// Two old URLs can map to one key; the newest snapshot per project, key and device wins.
async function canonicalizeSnapshots(client: PoolClient): Promise<void> {
  const res = await client.query("SELECT id, project_id, page_url, device, timestamp FROM page_snapshots ORDER BY timestamp DESC");
  const winners = new Map<string, { id: string; projectId: string; key: string; device: DeviceType }>();
  for (const row of res.rows) {
    const key = canonicalPageKey(row.page_url) || row.page_url;
    const group = `${row.project_id}\u0000${key}\u0000${row.device}`;
    if (winners.has(group)) {
      await client.query("DELETE FROM page_snapshots WHERE id = $1", [row.id]);
    } else {
      winners.set(group, { id: row.id, projectId: row.project_id, key, device: row.device });
    }
  }
  for (const w of winners.values()) {
    await client.query("UPDATE page_snapshots SET page_url = $1, id = $2 WHERE id = $3", [
      w.key, snapshotId(w.projectId, w.key, w.device), w.id
    ]);
  }
}

// Run once each, in order, after SCHEMA_SQL. Never edit or reorder a released step.
export const DATA_MIGRATIONS: { name: string; run: (client: PoolClient) => Promise<unknown> }[] = [
  {
    // Rows written before receive time existed hold the browser clock in timestamp
    name: "001_client_time_from_timestamp",
    run: async (client) => {
      await client.query("UPDATE raw_clicks SET client_time = timestamp WHERE client_time IS NULL");
      await client.query("UPDATE raw_scrolls SET client_time = timestamp WHERE client_time IS NULL");
    }
  },
  {
    // Older rows hold origin + path in page_url
    name: "002_canonical_page_keys",
    run: async (client) => {
      await canonicalizeColumn(client, "raw_clicks");
      await canonicalizeColumn(client, "raw_scrolls");
      await canonicalizeSnapshots(client);
    }
  },
  {
    // One raw_scrolls row is one page view
    name: "003_backfill_page_index",
    run: (client) => client.query(`
      INSERT INTO page_index (project_id, page_key, device, last_url, first_seen, last_seen, views, clicks)
      SELECT project_id, page_url, device, 'https://' || page_url,
             MIN(first_seen), MAX(last_seen), SUM(views), SUM(clicks)
      FROM (
        SELECT project_id, page_url, device, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen,
               COUNT(*) AS views, 0 AS clicks
        FROM raw_scrolls GROUP BY project_id, page_url, device
        UNION ALL
        SELECT project_id, page_url, device, MIN(timestamp), MAX(timestamp), 0, COUNT(*)
        FROM raw_clicks GROUP BY project_id, page_url, device
      ) seen
      GROUP BY project_id, page_url, device
      ON CONFLICT (project_id, page_key, device) DO NOTHING
    `)
  }
];

const PROJECT_COLUMNS = `
  id, name, allowed_domains AS "allowedDomains", exclude_patterns AS "excludePatterns",
  is_active AS "isActive", version, created_at AS "createdAt"
`;

function toProject(row: any): Project {
  return {
    ...row,
    version: row.version === null ? null : Number(row.version),
    createdAt: Number(row.createdAt)
  };
}

export class PgAnalyticsRepository implements IAnalyticsRepository {
  private pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    if (config instanceof Pool) {
      this.pool = config;
    } else if (typeof config === "string") {
      this.pool = new Pool({ ...DEFAULT_POOL_CONFIG, connectionString: config });
    } else {
      this.pool = new Pool({ ...DEFAULT_POOL_CONFIG, ...config });
    }
  }

  public getPool(): Pool {
    return this.pool;
  }

  // Applies the schema. Idempotent; run it as a deploy step with `yarn migrate:server`, not per request.
  // An advisory lock keeps concurrent runs from racing on CREATE TABLE.
  public async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK]);
      await client.query(SCHEMA_SQL);
      for (const migration of DATA_MIGRATIONS) {
        try {
          await client.query("BEGIN");
          const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [migration.name]);
          if (done.rowCount === 0) {
            await migration.run(client);
            await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [migration.name, Date.now()]);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => undefined);
      client.release();
    }
  }

  public async deleteOlderThan(cutoff: number): Promise<RetentionResult> {
    const clicks = await this.pool.query(`DELETE FROM raw_clicks WHERE timestamp < $1`, [cutoff]);
    const scrolls = await this.pool.query(`DELETE FROM raw_scrolls WHERE timestamp < $1`, [cutoff]);
    const snapshots = await this.pool.query(
      `DELETE FROM page_snapshots s WHERE s.timestamp < $1 AND NOT EXISTS (
         SELECT 1 FROM page_index p
         WHERE p.project_id = s.project_id AND p.page_key = s.page_url AND p.device = s.device AND p.last_seen >= $1)`,
      [cutoff]
    );
    const pages = await this.pool.query(`DELETE FROM page_index WHERE last_seen < $1`, [cutoff]);
    return { clicks: clicks.rowCount ?? 0, scrolls: scrolls.rowCount ?? 0, snapshots: snapshots.rowCount ?? 0, pages: pages.rowCount ?? 0 };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async createProject(project: Project): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, name, allowed_domains, exclude_patterns, is_active, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [project.id, project.name, project.allowedDomains, project.excludePatterns, project.isActive, project.version, project.createdAt]
    );
  }

  public async upsertProject(project: Project): Promise<UpsertResult> {
    const res = await this.pool.query(
      `INSERT INTO projects (id, name, allowed_domains, exclude_patterns, is_active, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           allowed_domains = EXCLUDED.allowed_domains,
           exclude_patterns = EXCLUDED.exclude_patterns,
           is_active = EXCLUDED.is_active,
           version = COALESCE(EXCLUDED.version, projects.version)
       WHERE EXCLUDED.version IS NULL OR projects.version IS NULL OR EXCLUDED.version >= projects.version
       RETURNING (xmax = 0) AS inserted`,
      [project.id, project.name, project.allowedDomains, project.excludePatterns, project.isActive, project.version, project.createdAt]
    );
    if (res.rowCount === 0) return "stale";
    return res.rows[0].inserted === true ? "created" : "updated";
  }

  public async getProject(id: string): Promise<Project | null> {
    const res = await this.pool.query(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [id]);
    return res.rows.length > 0 ? toProject(res.rows[0]) : null;
  }

  public async listProjects(): Promise<Project[]> {
    const res = await this.pool.query(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at DESC`);
    return res.rows.map(toProject);
  }

  public async saveRawClicks(clicks: RawClickRecord[]): Promise<void> {
    if (clicks.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    clicks.forEach((c, idx) => {
      const offset = idx * 10;
      placeholders.push(`(${Array.from({ length: 10 }, (_, i) => `$${offset + i + 1}`).join(", ")})`);
      values.push(c.id, c.projectId, c.pageUrl, c.device, c.hash, c.selector, c.eX, c.eY, c.timestamp, c.clientTime);
    });

    await this.pool.query(
      `INSERT INTO raw_clicks (id, project_id, page_url, device, hash, selector, e_x, e_y, timestamp, client_time)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (id) DO NOTHING`,
      values
    );
  }

  public async getClickActivity(query: HeatmapQuery): Promise<Activity> {
    const res = await this.pool.query(
      `SELECT hash, selector, e_x, e_y, COUNT(*)::int AS clicks
       FROM raw_clicks
       WHERE project_id = $1
         AND page_url = $2
         AND ($3::text IS NULL OR device = $3)
         AND ($4::bigint IS NULL OR timestamp >= $4)
         AND ($5::bigint IS NULL OR timestamp < $5)
       GROUP BY hash, selector, e_x, e_y`,
      [query.projectId, query.pageUrl, query.device || null, query.from ?? null, query.to ?? null]
    );

    const elementMap = new Map<string, { selector: string; x: number[]; y: number[]; clicks: number[]; totalclicks: number }>();
    for (const row of res.rows) {
      let elem = elementMap.get(row.hash);
      if (!elem) {
        elem = { selector: row.selector, x: [], y: [], clicks: [], totalclicks: 0 };
        elementMap.set(row.hash, elem);
      }
      elem.x.push(row.e_x);
      elem.y.push(row.e_y);
      elem.clicks.push(row.clicks);
      elem.totalclicks += row.clicks;
    }

    const activity: Activity = [];
    for (const [hash, elem] of elementMap.entries()) {
      activity.push({ hash, selector: elem.selector, totalclicks: elem.totalclicks, points: elem.x.length, x: elem.x, y: elem.y, clicks: elem.clicks });
    }
    return activity;
  }

  public async saveRawScroll(scroll: RawScrollRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO raw_scrolls (id, project_id, page_url, device, session_id, max_scroll_reach_y, viewport_height, timestamp, client_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
       SET max_scroll_reach_y = GREATEST(raw_scrolls.max_scroll_reach_y, EXCLUDED.max_scroll_reach_y),
           viewport_height = COALESCE(EXCLUDED.viewport_height, raw_scrolls.viewport_height),
           timestamp = EXCLUDED.timestamp,
           client_time = EXCLUDED.client_time`,
      [scroll.id, scroll.projectId, scroll.pageUrl, scroll.device, scroll.sessionId, scroll.maxScrollReachY,
        scroll.viewportHeight, scroll.timestamp, scroll.clientTime]
    );
  }

  public async getScrollMap(query: HeatmapQuery): Promise<ScrollMapResult> {
    const res = await this.pool.query(
      `WITH matched AS (
         SELECT session_id, max_scroll_reach_y, viewport_height
         FROM raw_scrolls
         WHERE project_id = $1
           AND page_url = $2
           AND ($3::text IS NULL OR device = $3)
           AND ($4::bigint IS NULL OR timestamp >= $4)
           AND ($5::bigint IS NULL OR timestamp < $5)
       )
       SELECT session_id, MAX(max_scroll_reach_y)::int AS reach,
              (SELECT ROUND(AVG(viewport_height))::int FROM matched WHERE viewport_height > 0) AS avg_fold
       FROM matched
       GROUP BY session_id`,
      [query.projectId, query.pageUrl, query.device || null, query.from ?? null, query.to ?? null]
    );
    return {
      scrollMap: buildScrollMap(res.rows.map((r) => r.reach)),
      totalSessions: res.rows.length,
      avgFoldY: res.rows.length > 0 ? res.rows[0].avg_fold : null
    };
  }

  public async getViewDevice(scrollId: string): Promise<DeviceType | null> {
    const res = await this.pool.query("SELECT device FROM raw_scrolls WHERE id = $1", [scrollId]);
    return res.rows.length > 0 ? res.rows[0].device : null;
  }

  public async savePageSnapshot(snapshot: PageSnapshot): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO page_snapshots (id, project_id, page_url, device, dom_hash, raw_payload, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, page_url, device) DO UPDATE
       SET dom_hash = EXCLUDED.dom_hash,
           raw_payload = EXCLUDED.raw_payload,
           timestamp = EXCLUDED.timestamp
       WHERE page_snapshots.dom_hash <> EXCLUDED.dom_hash`,
      [snapshot.id, snapshot.projectId, snapshot.pageUrl, snapshot.device, snapshot.domHash, snapshot.rawPayload, snapshot.timestamp]
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async getPageSnapshot(projectId: string, pageKey: string, device?: DeviceType): Promise<PageSnapshot | null> {
    const res = await this.pool.query(
      `SELECT id, project_id AS "projectId", page_url AS "pageUrl", device, dom_hash AS "domHash",
              raw_payload AS "rawPayload", timestamp
       FROM page_snapshots
       WHERE project_id = $1 AND page_url = $2 AND ($3::text IS NULL OR device = $3)
       ORDER BY timestamp DESC
       LIMIT 1`,
      [projectId, pageKey, device || null]
    );
    return res.rows.length > 0 ? { ...res.rows[0], timestamp: Number(res.rows[0].timestamp) } : null;
  }

  public async recordPageActivity(a: PageActivity): Promise<void> {
    await this.pool.query(
      `INSERT INTO page_index (project_id, page_key, device, last_url, first_seen, last_seen, views, clicks)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7)
       ON CONFLICT (project_id, page_key, device) DO UPDATE
       SET last_url = EXCLUDED.last_url,
           last_seen = GREATEST(page_index.last_seen, EXCLUDED.last_seen),
           views = page_index.views + EXCLUDED.views,
           clicks = page_index.clicks + EXCLUDED.clicks`,
      [a.projectId, a.pageKey, a.device, a.url, a.at, a.views, a.clicks]
    );
  }

  public async listPageIndex(projectId: string): Promise<PageIndexRow[]> {
    const res = await this.pool.query(
      `SELECT project_id AS "projectId", page_key AS "pageKey", device, last_url AS "lastUrl",
              first_seen AS "firstSeen", last_seen AS "lastSeen", views, clicks
       FROM page_index WHERE project_id = $1`,
      [projectId]
    );
    return res.rows.map((r) => ({
      ...r,
      firstSeen: Number(r.firstSeen),
      lastSeen: Number(r.lastSeen),
      views: Number(r.views),
      clicks: Number(r.clicks)
    }));
  }

  public async addDrops(entries: DropEntry[]): Promise<void> {
    for (const e of entries) {
      await this.pool.query(
        `INSERT INTO ingest_drops (project_id, reason, count, last_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, reason) DO UPDATE
         SET count = ingest_drops.count + EXCLUDED.count,
             last_at = GREATEST(ingest_drops.last_at, EXCLUDED.last_at)`,
        [e.projectId, e.reason, e.count, e.lastAt]
      );
    }
  }

  public async getDrops(projectId?: string): Promise<Record<string, DropCounts>> {
    const res = await this.pool.query(
      `SELECT project_id, reason, count, last_at FROM ingest_drops WHERE ($1::text IS NULL OR project_id = $1)`,
      [projectId ?? null]
    );
    const result: Record<string, DropCounts> = {};
    for (const r of res.rows) {
      (result[r.project_id] = result[r.project_id] || {})[r.reason as DropReason] = {
        count: Number(r.count),
        lastAt: Number(r.last_at)
      };
    }
    return result;
  }

  public async clearProjectData(projectId: string, pageKey?: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM raw_clicks WHERE project_id = $1 AND ($2::text IS NULL OR page_url = $2)`,
      [projectId, pageKey || null]
    );
    await this.pool.query(
      `DELETE FROM raw_scrolls WHERE project_id = $1 AND ($2::text IS NULL OR page_url = $2)`,
      [projectId, pageKey || null]
    );
  }
}
