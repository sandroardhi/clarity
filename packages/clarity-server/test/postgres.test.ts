import { expect, test } from "@playwright/test";
import { DATA_MIGRATIONS, MIGRATE_LOCK, PgAnalyticsRepository } from "../src/db/postgres";
import { RawClickRecord } from "../src/types";
import { uid } from "./helper";

test.describe("postgres repository", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is not set");

  let repo: PgAnalyticsRepository;
  test.beforeAll(async () => {
    repo = new PgAnalyticsRepository(process.env.DATABASE_URL as string);
    await repo.migrate();
  });
  test.afterAll(async () => {
    await repo.close();
  });

  test("stores and aggregates telemetry", async () => {
    const id = `test_proj_${uid()}`;
    const key = "myskalplstore.com/checkout";
    const now = Date.now();
    await repo.createProject({
      id, name: "Store", allowedDomains: ["myskalplstore.com"], excludePatterns: ["myskalplstore.com/admin*"],
      isActive: true, version: 5, createdAt: now
    });
    expect(await repo.getProject(id)).toMatchObject({ allowedDomains: ["myskalplstore.com"], excludePatterns: ["myskalplstore.com/admin*"], version: 5 });

    const click = (n: number, eX: number, device: "desktop" | "mobile" = "desktop"): RawClickRecord => ({
      id: `${id}-c${n}`, projectId: id, pageUrl: key, device, hash: device === "desktop" ? "btn" : "nav", selector: "button",
      eX, eY: 16000, timestamp: now + n, clientTime: null
    });
    await repo.saveRawClicks([click(1, 16000), click(2, 16000), click(3, 16000), click(4, 18000), click(5, 5000, "mobile")]);

    const desktop = await repo.getClickActivity({ projectId: id, pageUrl: key, device: "desktop" });
    expect(desktop).toHaveLength(1);
    expect(desktop[0]).toMatchObject({ hash: "btn", totalclicks: 4, points: 2 });
    const all = await repo.getClickActivity({ projectId: id, pageUrl: key });
    expect(all.reduce((sum, a) => sum + a.totalclicks, 0)).toBe(5);

    const scroll = { projectId: id, pageUrl: key, device: "desktop" as const, timestamp: now, clientTime: null };
    await repo.saveRawScroll({ ...scroll, id: `${id}-s1`, sessionId: "a", maxScrollReachY: 100, viewportHeight: 900 });
    await repo.saveRawScroll({ ...scroll, id: `${id}-s2`, sessionId: "b", maxScrollReachY: 50, viewportHeight: 700 });
    await repo.saveRawScroll({ ...scroll, id: `${id}-s2`, sessionId: "b", maxScrollReachY: 40, viewportHeight: null });
    const map = await repo.getScrollMap({ projectId: id, pageUrl: key, device: "desktop" });
    expect(map.totalSessions).toBe(2);
    expect(map.avgFoldY).toBe(800);
    expect(map.scrollMap.map((m) => m.percUsers)).toEqual([100, 100, 100, 50, 50]);
    expect(await repo.getViewDevice(`${id}-s1`)).toBe("desktop");
    expect(await repo.getScrollMap({ projectId: id, pageUrl: "myskalplstore.com/none" })).toEqual({ scrollMap: [], totalSessions: 0, avgFoldY: null });

    const snap = { projectId: id, pageUrl: key, domHash: "d1", rawPayload: "{}" };
    await repo.savePageSnapshot({ ...snap, id: `${id}:a`, device: "desktop", timestamp: now });
    await repo.savePageSnapshot({ ...snap, id: `${id}:b`, device: "mobile", timestamp: now + 10 });
    expect((await repo.getPageSnapshot(id, key, "desktop"))?.device).toBe("desktop");
    expect((await repo.getPageSnapshot(id, key))?.device).toBe("mobile");
  });

  test("upsert rejects a lower version and keeps the stored one when none is sent", async () => {
    const id = `ver_${uid()}`;
    const base = { id, name: "V", allowedDomains: [], excludePatterns: [], isActive: true, createdAt: Date.now() };
    expect(await repo.upsertProject({ ...base, version: 200 })).toBe("created");
    expect(await repo.upsertProject({ ...base, name: "Old", version: 100 })).toBe("stale");
    expect((await repo.getProject(id))?.name).toBe("V");
    expect(await repo.upsertProject({ ...base, name: "Same", version: 200 })).toBe("updated");
    expect(await repo.upsertProject({ ...base, name: "None", version: null })).toBe("updated");
    expect(await repo.getProject(id)).toMatchObject({ name: "None", version: 200 });
  });

  test("page index and drop counters accumulate", async () => {
    const id = `idx_${uid()}`;
    await repo.createProject({ id, name: id, allowedDomains: [], excludePatterns: [], isActive: true, version: null, createdAt: Date.now() });
    const a = { projectId: id, pageKey: "x.com/", device: "mobile" as const };
    await repo.recordPageActivity({ ...a, url: "https://www.x.com/", at: 1000, views: 1, clicks: 0 });
    await repo.recordPageActivity({ ...a, url: "https://x.com/", at: 2000, views: 0, clicks: 3 });
    expect(await repo.listPageIndex(id)).toEqual([
      { ...a, lastUrl: "https://x.com/", firstSeen: 1000, lastSeen: 2000, views: 1, clicks: 3 }
    ]);

    await repo.addDrops([{ projectId: id, reason: "origin", count: 2, lastAt: 10 }]);
    await repo.addDrops([{ projectId: id, reason: "origin", count: 1, lastAt: 20 }, { projectId: id, reason: "excluded", count: 1, lastAt: 5 }]);
    expect((await repo.getDrops(id))[id]).toEqual({ origin: { count: 3, lastAt: 20 }, excluded: { count: 1, lastAt: 5 } });
    await repo.ping();
  });

  test("migration 002 canonicalizes old page URLs and 003 backfills the page index", async () => {
    const id = `mig_${uid()}`;
    const pool = repo.getPool();
    await repo.createProject({ id, name: id, allowedDomains: [], excludePatterns: [], isActive: true, version: null, createdAt: 0 });
    const insertClick = "INSERT INTO raw_clicks (id, project_id, page_url, device, hash, selector, e_x, e_y, timestamp) VALUES ($1, $2, $3, 'desktop', 'h', 'a', 1, 1, $4)";
    await pool.query(insertClick, [`${id}-c1`, id, "https://www.Shop.example.com/a/", 1000]);
    await pool.query(insertClick, [`${id}-c2`, id, "https://shop.example.com/a", 3000]);
    await pool.query(
      "INSERT INTO raw_scrolls (id, project_id, page_url, device, session_id, max_scroll_reach_y, timestamp) VALUES ($1, $2, $3, 'desktop', 's', 50, 2000)",
      [`${id}-s1`, id, "https://shop.example.com/a/"]
    );
    const insertSnap = "INSERT INTO page_snapshots (id, project_id, page_url, device, dom_hash, raw_payload, timestamp) VALUES ($1, $2, $3, 'desktop', $4, '{}', $5)";
    await pool.query(insertSnap, [`${id}:old`, id, "https://www.shop.example.com/a", "older", 1000]);
    await pool.query(insertSnap, [`${id}:new`, id, "https://shop.example.com/a/", "newer", 2000]);

    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK]);
      for (const m of DATA_MIGRATIONS.filter((d) => d.name.startsWith("002_") || d.name.startsWith("003_"))) await m.run(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK]);
      client.release();
    }

    const clicks = await pool.query("SELECT DISTINCT page_url FROM raw_clicks WHERE project_id = $1", [id]);
    expect(clicks.rows).toEqual([{ page_url: "shop.example.com/a" }]);
    const snaps = await pool.query("SELECT page_url, dom_hash FROM page_snapshots WHERE project_id = $1", [id]);
    expect(snaps.rows).toEqual([{ page_url: "shop.example.com/a", dom_hash: "newer" }]);
    expect(await repo.listPageIndex(id)).toEqual([{
      projectId: id, pageKey: "shop.example.com/a", device: "desktop", lastUrl: "https://shop.example.com/a",
      firstSeen: 1000, lastSeen: 3000, views: 1, clicks: 2
    }]);
  });
});
