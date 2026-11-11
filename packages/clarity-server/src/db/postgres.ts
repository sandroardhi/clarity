import { Pool, PoolConfig } from "pg";
import fs from "fs";
import { IAnalyticsRepository, parseSafeTimestamp } from "./repository";
import { SCHEMA_SQL } from "./schema";
import {
  Project,
  RawClickRecord,
  RawScrollRecord,
  PageSnapshot,
  HeatmapQuery,
  Activity,
  ScrollMapInfo,
  DeviceType
} from "../types";

const DEFAULT_POOL_CONFIG: Partial<PoolConfig> = {
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
};

export class PgAnalyticsRepository implements IAnalyticsRepository {
  private pool: Pool;

  constructor(configOrPool?: PoolConfig | string | Pool) {
    if (configOrPool instanceof Pool) {
      this.pool = configOrPool;
    } else if (typeof configOrPool === "string") {
      let resolvedConfig: PoolConfig = { ...DEFAULT_POOL_CONFIG, connectionString: configOrPool };
      try {
        const parsed = new URL(configOrPool);
        // If connecting to localhost without password on Linux, use unix socket for peer auth
        if (
          !parsed.password &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
          fs.existsSync("/var/run/postgresql")
        ) {
          resolvedConfig = {
            ...DEFAULT_POOL_CONFIG,
            host: "/var/run/postgresql",
            database: parsed.pathname.replace(/^\//, "") || "heatmap-backend-local-dummy",
            user: parsed.username || process.env.PGUSER || process.env.USER || "sandro"
          };
        }
      } catch {
        // use default connectionString
      }
      this.pool = new Pool(resolvedConfig);
    } else if (configOrPool) {
      this.pool = new Pool({ ...DEFAULT_POOL_CONFIG, ...configOrPool });
    } else {
      if (fs.existsSync("/var/run/postgresql")) {
        this.pool = new Pool({
          ...DEFAULT_POOL_CONFIG,
          host: "/var/run/postgresql",
          database: process.env.PGDATABASE || "heatmap-backend-local-dummy",
          user: process.env.PGUSER || process.env.USER || "sandro"
        });
      } else {
        this.pool = new Pool(DEFAULT_POOL_CONFIG);
      }
    }
  }

  public getPool(): Pool {
    return this.pool;
  }

  // Applies the schema. Idempotent; run it as a deploy step with `yarn migrate:server`, not per request.
  public async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  public async deleteOlderThan(cutoff: number): Promise<{ clicks: number; scrolls: number }> {
    const clicks = await this.pool.query(`DELETE FROM raw_clicks WHERE timestamp < $1`, [cutoff]);
    const scrolls = await this.pool.query(`DELETE FROM raw_scrolls WHERE timestamp < $1`, [cutoff]);
    return { clicks: clicks.rowCount ?? 0, scrolls: scrolls.rowCount ?? 0 };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async createProject(project: Project): Promise<void> {
    const query = `
      INSERT INTO projects (id, name, allowed_domains, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `;
    await this.pool.query(query, [
      project.id,
      project.name,
      project.allowedDomains,
      project.isActive,
      project.createdAt
    ]);
  }

  public async upsertProject(project: Project): Promise<boolean> {
    const query = `
      INSERT INTO projects (id, name, allowed_domains, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          allowed_domains = EXCLUDED.allowed_domains,
          is_active = EXCLUDED.is_active
      RETURNING (xmax = 0) AS inserted
    `;
    const res = await this.pool.query(query, [
      project.id,
      project.name,
      project.allowedDomains,
      project.isActive,
      project.createdAt
    ]);
    return res.rows[0].inserted === true;
  }

  public async getProject(id: string): Promise<Project | null> {
    const query = `
      SELECT 
        id, 
        name, 
        allowed_domains AS "allowedDomains", 
        is_active AS "isActive", 
        created_at AS "createdAt"
      FROM projects
      WHERE id = $1
    `;
    const res = await this.pool.query(query, [id]);
    return res.rows.length > 0 ? { ...res.rows[0], createdAt: Number(res.rows[0].createdAt) } : null;
  }

  public async listProjects(): Promise<Project[]> {
    const query = `
      SELECT 
        id, 
        name, 
        allowed_domains AS "allowedDomains", 
        is_active AS "isActive", 
        created_at AS "createdAt"
      FROM projects
      ORDER BY created_at DESC
    `;
    const res = await this.pool.query(query);
    return res.rows.map((r) => ({ ...r, createdAt: Number(r.createdAt) }));
  }

  public async saveRawClicks(clicks: RawClickRecord[]): Promise<void> {
    if (clicks.length === 0) return;

    // Build parameterized multi-row insert for high performance
    const values: any[] = [];
    const placeholders: string[] = [];

    clicks.forEach((c, idx) => {
      const offset = idx * 9;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
      );
      values.push(
        c.id,
        c.projectId,
        c.pageUrl,
        c.device,
        c.hash,
        c.selector,
        c.eX,
        c.eY,
        c.timestamp
      );
    });

    const query = `
      INSERT INTO raw_clicks (id, project_id, page_url, device, hash, selector, e_x, e_y, timestamp)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (id) DO NOTHING
    `;

    await this.pool.query(query, values);
  }

  public async getClickActivity(query: HeatmapQuery): Promise<Activity> {
    const fromTimestamp = parseSafeTimestamp(query.from, 0, false);
    const toTimestamp = parseSafeTimestamp(query.to, Number.MAX_SAFE_INTEGER, true);
    const targetDevice = query.device || null;

    const sql = `
      SELECT 
        hash,
        selector,
        e_x,
        e_y,
        COUNT(*)::int AS clicks
      FROM raw_clicks
      WHERE project_id = $1
        AND page_url = $2
        AND ($3::text IS NULL OR device = $3)
        AND timestamp >= $4
        AND timestamp <= $5
      GROUP BY hash, selector, e_x, e_y
    `;

    const res = await this.pool.query(sql, [
      query.projectId,
      query.pageUrl,
      targetDevice,
      fromTimestamp,
      toTimestamp
    ]);

    // Group rows by hash to form the Activity structure (ElementData[])
    const elementMap = new Map<
      string,
      {
        selector: string;
        x: number[];
        y: number[];
        clicks: number[];
        totalclicks: number;
      }
    >();

    for (const row of res.rows) {
      let elem = elementMap.get(row.hash);
      if (!elem) {
        elem = {
          selector: row.selector,
          x: [],
          y: [],
          clicks: [],
          totalclicks: 0
        };
        elementMap.set(row.hash, elem);
      }

      elem.x.push(row.e_x);
      elem.y.push(row.e_y);
      elem.clicks.push(row.clicks);
      elem.totalclicks += row.clicks;
    }

    const activity: Activity = [];
    for (const [hash, elem] of elementMap.entries()) {
      activity.push({
        hash,
        selector: elem.selector,
        totalclicks: elem.totalclicks,
        points: elem.x.length,
        x: elem.x,
        y: elem.y,
        clicks: elem.clicks
      });
    }

    return activity;
  }

  public async saveRawScroll(scroll: RawScrollRecord): Promise<void> {
    const query = `
      INSERT INTO raw_scrolls (id, project_id, page_url, device, session_id, max_scroll_reach_y, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE
      SET max_scroll_reach_y = GREATEST(raw_scrolls.max_scroll_reach_y, EXCLUDED.max_scroll_reach_y),
          timestamp = EXCLUDED.timestamp
    `;

    await this.pool.query(query, [
      scroll.id,
      scroll.projectId,
      scroll.pageUrl,
      scroll.device,
      scroll.sessionId,
      scroll.maxScrollReachY,
      scroll.timestamp
    ]);
  }

  public async getScrollMap(
    query: HeatmapQuery
  ): Promise<{ scrollMap: ScrollMapInfo[]; totalSessions: number; avgFoldY: number }> {
    const fromTimestamp = parseSafeTimestamp(query.from, 0, false);
    const toTimestamp = parseSafeTimestamp(query.to, Number.MAX_SAFE_INTEGER, true);
    const targetDevice = query.device || null;

    const sql = `
      WITH session_reaches AS (
        SELECT 
          session_id,
          MAX(max_scroll_reach_y)::int AS reach
        FROM raw_scrolls
        WHERE project_id = $1
          AND page_url = $2
          AND ($3::text IS NULL OR device = $3)
          AND timestamp >= $4
          AND timestamp <= $5
        GROUP BY session_id
      )
      SELECT 
        COUNT(*)::int AS total_sessions,
        COUNT(*) FILTER (WHERE reach >= 0)::int AS reach_0,
        COUNT(*) FILTER (WHERE reach >= 25)::int AS reach_25,
        COUNT(*) FILTER (WHERE reach >= 50)::int AS reach_50,
        COUNT(*) FILTER (WHERE reach >= 75)::int AS reach_75,
        COUNT(*) FILTER (WHERE reach >= 100)::int AS reach_100
      FROM session_reaches;
    `;

    const res = await this.pool.query(sql, [
      query.projectId,
      query.pageUrl,
      targetDevice,
      fromTimestamp,
      toTimestamp
    ]);

    const row = res.rows[0];
    const totalSessions = row ? row.total_sessions : 0;

    if (totalSessions === 0) {
      return {
        scrollMap: [
          { scrollReachY: 0, cumulativeSum: 0, percUsers: 100 },
          { scrollReachY: 25, cumulativeSum: 0, percUsers: 0 },
          { scrollReachY: 50, cumulativeSum: 0, percUsers: 0 },
          { scrollReachY: 75, cumulativeSum: 0, percUsers: 0 },
          { scrollReachY: 100, cumulativeSum: 0, percUsers: 0 }
        ],
        totalSessions: 0,
        avgFoldY: 600
      };
    }

    const milestones = [
      { reach: 0, count: row.reach_0 },
      { reach: 25, count: row.reach_25 },
      { reach: 50, count: row.reach_50 },
      { reach: 75, count: row.reach_75 },
      { reach: 100, count: row.reach_100 }
    ];

    const scrollMap: ScrollMapInfo[] = milestones.map((m) => ({
      scrollReachY: m.reach,
      cumulativeSum: m.count,
      percUsers: Math.round((m.count / totalSessions) * 100)
    }));

    return {
      scrollMap,
      totalSessions,
      avgFoldY: 768
    };
  }

  public async savePageSnapshot(snapshot: PageSnapshot): Promise<boolean> {
    const query = `
      INSERT INTO page_snapshots (id, project_id, page_url, device, dom_hash, raw_payload, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (project_id, page_url, device) DO UPDATE
      SET dom_hash = EXCLUDED.dom_hash,
          raw_payload = EXCLUDED.raw_payload,
          timestamp = EXCLUDED.timestamp
      WHERE page_snapshots.dom_hash <> EXCLUDED.dom_hash
    `;

    const result = await this.pool.query(query, [
      snapshot.id,
      snapshot.projectId,
      snapshot.pageUrl,
      snapshot.device,
      snapshot.domHash,
      snapshot.rawPayload,
      snapshot.timestamp
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  public async getPageSnapshot(
    projectId: string,
    pageUrl: string,
    device: DeviceType = "desktop"
  ): Promise<PageSnapshot | null> {
    const query = `
      SELECT 
        id,
        project_id AS "projectId",
        page_url AS "pageUrl",
        device,
        dom_hash AS "domHash",
        raw_payload AS "rawPayload",
        timestamp
      FROM page_snapshots
      WHERE project_id = $1 
        AND page_url = $2 
        AND device = $3
    `;

    const res = await this.pool.query(query, [projectId, pageUrl, device]);
    return res.rows.length > 0 ? (res.rows[0] as PageSnapshot) : null;
  }

  public async listTrackedPages(
    projectId: string
  ): Promise<{ pageUrl: string; totalClicks: number; lastActive: number }[]> {
    const query = `
      SELECT 
        page_url AS "pageUrl",
        COUNT(*)::int AS "totalClicks",
        MAX(timestamp)::bigint AS "lastActive"
      FROM raw_clicks
      WHERE project_id = $1
      GROUP BY page_url
      ORDER BY "totalClicks" DESC
    `;

    const res = await this.pool.query(query, [projectId]);
    return res.rows.map((r) => ({
      pageUrl: r.pageUrl,
      totalClicks: Number(r.totalClicks),
      lastActive: Number(r.lastActive)
    }));
  }

  public async clearProjectData(projectId: string, pageUrl?: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM raw_clicks WHERE project_id = $1 AND ($2::text IS NULL OR page_url = $2)`,
      [projectId, pageUrl || null]
    );
    await this.pool.query(
      `DELETE FROM raw_scrolls WHERE project_id = $1 AND ($2::text IS NULL OR page_url = $2)`,
      [projectId, pageUrl || null]
    );
  }
}
