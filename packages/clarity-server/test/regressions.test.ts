import { expect, test } from "@playwright/test";
import http from "http";
import { IAnalyticsRepository, MemoryAnalyticsRepository } from "../src/db/repository";
import { PgAnalyticsRepository } from "../src/db/postgres";
import { createServer } from "../src/server";
import { DEFAULT_RETENTION_DAYS, pruneRawData, retentionDays } from "../src/services/retention";

type Token = (string | number | null | object)[];

function payload(projectId: string, url: string, sequence: number, events: Token[], sessionId: string = "s1"): string {
  return JSON.stringify({ e: ["0.8.76", sequence, 1000, 500, projectId, "u1", sessionId, 1, 0, 0, 0, url], a: events });
}

const click: Token = [200, 9, 10, 500, 300, 16383, 16383, 0, 1, 0, "Buy", null, "h1.h1b", 1, null, 120, 40, "BUTTON", "buy", "btn"];
const discover: Token = [100, 5, 1, 0, "HTML", {}];

async function withServer(repository: IAnalyticsRepository, fn: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createServer({ repository }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.close();
  }
}

const ORIGIN = "https://site.example.com";

async function register(base: string, id: string): Promise<void> {
  expect((await syncProject(base, { id, name: id, allowedDomains: ["site.example.com"] })).status).toBe(201);
}

async function collect(base: string, body: string, origin?: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (origin) headers.Origin = origin;
  const res = await fetch(`${base}/api/v1/collect`, { method: "POST", headers, body });
  expect(res.status).toBe(204);
}

async function syncProject(base: string, body: object): Promise<Response> {
  return fetch(`${base}/api/v1/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function clickTotal(base: string, projectId: string, url: string): Promise<number> {
  const res = await fetch(`${base}/api/v1/heatmaps/click?projectId=${projectId}&pageUrl=${encodeURIComponent(url)}`);
  return ((await res.json()) as { totalClicks: number }).totalClicks;
}

function suite(name: string, makeRepo: () => IAnalyticsRepository, needsDb: boolean): void {
  test.describe(name, () => {
    test.skip(needsDb && !process.env.DATABASE_URL, "DATABASE_URL is not set");
    test.beforeAll(async () => {
      if (!needsDb) return;
      const repo = new PgAnalyticsRepository(process.env.DATABASE_URL as string);
      await repo.migrate();
      await repo.migrate();
      await repo.close();
    });

    test("unknown project ids are dropped, not created", async () => {
      const repo = makeRepo();
      const id = `unknown_${Date.now()}`;
      await withServer(repo, async (base) => {
        await collect(base, payload(id, "https://x.example.com/", 1, [click]), "https://x.example.com");
        expect(await repo.getProject(id)).toBeNull();
      });
    });

    test("POST and PUT upsert a project and the collector honors domains and isActive", async () => {
      const repo = makeRepo();
      const id = `sync_${Date.now()}`;
      const url = "https://shop.example.com/p";
      await withServer(repo, async (base) => {
        expect((await syncProject(base, { id, name: "Shop", allowedDomains: ["old.example.com"] })).status).toBe(201);
        expect((await syncProject(base, { id, name: "Shop", allowedDomains: ["shop.example.com", "www.shop.example.com"], isActive: true })).status).toBe(200);
        expect((await repo.getProject(id))?.allowedDomains).toEqual(["shop.example.com", "www.shop.example.com"]);

        await collect(base, payload(id, url, 1, [click]), "https://www.shop.example.com");
        await collect(base, payload(id, url, 1, [click], "s2"), "https://spam.example.net");
        await collect(base, payload(id, url, 1, [click], "s3"));
        expect(await clickTotal(base, id, url)).toBe(1);

        const put = await fetch(`${base}/api/v1/projects/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Shop", allowedDomains: ["shop.example.com"], isActive: false })
        });
        expect(put.status).toBe(200);
        expect((await repo.getProject(id))?.isActive).toBe(false);
        await collect(base, payload(id, url, 1, [click], "s4"), "https://shop.example.com");
        expect(await clickTotal(base, id, url)).toBe(1);

        const created = await fetch(`${base}/api/v1/projects/${id}_new`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "New" })
        });
        expect(created.status).toBe(201);
        expect((await repo.getProject(`${id}_new`))?.allowedDomains).toEqual([]);
      });
    });

    test("project sync rejects malformed fields", async () => {
      await withServer(makeRepo(), async (base) => {
        expect((await syncProject(base, { id: "bad", name: "B", allowedDomains: "x.com" })).status).toBe(400);
        expect((await syncProject(base, { id: "bad", name: "B", isActive: "no" })).status).toBe(400);
        const mismatch = await fetch(`${base}/api/v1/projects/a`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "b", name: "B" })
        });
        expect(mismatch.status).toBe(400);
      });
    });

    test("snapshot is saved from Discover only and survives long URLs", async () => {
      const repo = makeRepo();
      const id = `snap_${Date.now()}`;
      const url = `https://snap.example.com/${"a".repeat(200)}`;
      await withServer(repo, async (base) => {
        await register(base, id);
        await collect(base, payload(id, url, 1, [click]), ORIGIN);
        expect(await repo.getPageSnapshot(id, url, "desktop")).toBeNull();

        const withDom = payload(id, url, 2, [discover]);
        await collect(base, withDom, ORIGIN);
        expect((await repo.getPageSnapshot(id, url, "desktop"))?.rawPayload).toBe(withDom);

        await collect(base, payload(id, url, 1, [click], "s2"), ORIGIN);
        expect((await repo.getPageSnapshot(id, url, "desktop"))?.rawPayload).toBe(withDom);

        await collect(base, payload(id, url, 1, [discover], "s3"), ORIGIN);
        expect((await repo.getPageSnapshot(id, url, "desktop"))?.rawPayload).toBe(withDom);

        const changed = payload(id, url, 1, [[100, 5, 1, 0, "BODY", {}]], "s4");
        await collect(base, changed, ORIGIN);
        expect((await repo.getPageSnapshot(id, url, "desktop"))?.rawPayload).toBe(changed);
      });
    });

    test("retention deletes raw clicks and scrolls older than the cutoff", async () => {
      const repo = makeRepo();
      const id = `ret_${Date.now()}`;
      const url = "https://ret.example.com/";
      const now = Date.now();
      const old = now - (DEFAULT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
      await repo.upsertProject({ id, name: id, allowedDomains: [], isActive: true, createdAt: now });
      const row = { projectId: id, pageUrl: url, device: "desktop" as const, hash: "h", selector: "a", eX: 1, eY: 1 };
      await repo.saveRawClicks([{ ...row, id: `${id}-old`, timestamp: old }, { ...row, id: `${id}-new`, timestamp: now }]);
      const scroll = { projectId: id, pageUrl: url, device: "desktop" as const, maxScrollReachY: 50 };
      await repo.saveRawScroll({ ...scroll, id: `${id}-s-old`, sessionId: "a", timestamp: old });
      await repo.saveRawScroll({ ...scroll, id: `${id}-s-new`, sessionId: "b", timestamp: now });

      const deleted = await pruneRawData(repo, DEFAULT_RETENTION_DAYS, now);
      expect(deleted.clicks).toBeGreaterThanOrEqual(1);
      expect(deleted.scrolls).toBeGreaterThanOrEqual(1);
      const again = await pruneRawData(repo, DEFAULT_RETENTION_DAYS, now);
      expect(again).toEqual({ clicks: 0, scrolls: 0 });
      const left = await repo.getClickActivity({ projectId: id, pageUrl: url, device: "desktop" });
      expect(left.reduce((sum, a) => sum + a.totalclicks, 0)).toBe(1);
    });

    test("scroll reach is a percent of page height and counts non-scrollers", async () => {
      const id = `scroll_${Date.now()}`;
      const url = "https://scroll.example.com/";
      await withServer(makeRepo(), async (base) => {
        await register(base, id);
        const size: Token[] = [[90, 8, 1200, 4000], [95, 11, 1200, 1000]];
        await collect(base, payload(id, url, 1, [...size, [300, 10, 1, 0, 1000]], "deep"), ORIGIN);
        await collect(base, payload(id, url, 1, [...size], "still"), ORIGIN);
        await collect(base, payload(id, url, 2, [[300, 10, 1, 0, 2000]], "nosize"), ORIGIN);

        const res = await fetch(`${base}/api/v1/heatmaps/scroll?projectId=${id}&pageUrl=${encodeURIComponent(url)}`);
        const json = (await res.json()) as { totalSessions: number; scrollMap: { scrollReachY: number; cumulativeSum: number }[] };
        const at = (y: number): number | undefined => json.scrollMap.find((m) => m.scrollReachY === y)?.cumulativeSum;
        expect(json.totalSessions).toBe(2);
        expect(at(25)).toBe(2);
        expect(at(50)).toBe(1);
        expect(at(75)).toBe(0);
      });
    });
  });
}

suite("memory repository", () => new MemoryAnalyticsRepository(), false);
suite("postgres repository", () => new PgAnalyticsRepository(process.env.DATABASE_URL as string), true);

test("retention days default to 90 and accept positive integers only", () => {
  expect(retentionDays(undefined)).toBe(90);
  expect(retentionDays("30")).toBe(30);
  expect(retentionDays("0")).toBe(90);
  expect(retentionDays("-5")).toBe(90);
  expect(retentionDays("abc")).toBe(90);
});

test("server refuses to start in production without DATABASE_URL", async () => {
  const env = { db: process.env.DATABASE_URL, node: process.env.NODE_ENV };
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = "production";
  try {
    expect(() => createServer()).toThrow("DATABASE_URL is required in production");
  } finally {
    if (env.db !== undefined) process.env.DATABASE_URL = env.db;
    if (env.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.node;
  }
});
