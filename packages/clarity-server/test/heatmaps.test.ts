import { expect, test } from "@playwright/test";
import { IAnalyticsRepository, MemoryAnalyticsRepository } from "../src/db/repository";
import { PgAnalyticsRepository } from "../src/db/postgres";
import { deviceForWidth } from "../src/services/collector";
import { canonicalPageKey, isExcluded } from "../src/services/pageKey";
import { AUTH, click, collect, discover, JSON_AUTH, payload, syncProject, Token, uid, withServer } from "./helper";

const ORIGIN = "https://shop.example.com";
const resize = (width: number, height: number): Token => [95, 11, width, height];
const doc: Token = [90, 8, 1200, 4000];

async function get(base: string, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { headers: AUTH });
  return { status: res.status, json: await res.json() };
}

async function project(base: string, id: string, extra: object = {}): Promise<void> {
  const res = await syncProject(base, { id, name: id, allowedDomains: ["shop.example.com", "www.shop.example.com"], ...extra });
  expect(res.status).toBe(201);
}

test("page keys drop scheme, www, query, hash and trailing slashes", () => {
  expect(canonicalPageKey("https://WWW.Shop.example.com/Promo/?a=1#top")).toBe("shop.example.com/Promo");
  expect(canonicalPageKey("http://shop.example.com")).toBe("shop.example.com/");
  expect(canonicalPageKey("https://shop.example.com:8443/a//")).toBe("shop.example.com:8443/a");
  expect(canonicalPageKey("shop.example.com/a")).toBe("shop.example.com/a");
  expect(canonicalPageKey(canonicalPageKey("https://www.x.com/") as string)).toBe("x.com/");
  expect(canonicalPageKey("")).toBeNull();
  expect(canonicalPageKey("http://")).toBeNull();
});

test("exclude patterns follow the backend matcher", () => {
  expect(isExcluded("shop.example.com/thanks/1", ["https://www.shop.example.com/thanks*"])).toBe(true);
  expect(isExcluded("shop.example.com/", ["shop.example.com/"])).toBe(true);
  expect(isExcluded("shop.example.com/a/b", ["shop.example.com/*/b"])).toBe(true);
  expect(isExcluded("shop.example.com/thanks", ["shop.example.com/thanks/*"])).toBe(false);
  expect(isExcluded("shop.example.com/a", ["", "shop.example.com/a?x=1"])).toBe(true);
});

test("device follows viewport width", () => {
  expect([375, 767, 768, 1023, 1024].map(deviceForWidth)).toEqual(["mobile", "mobile", "tablet", "tablet", "desktop"]);
});

function suite(name: string, makeRepo: () => IAnalyticsRepository, needsDb: boolean): void {
  test.describe(name, () => {
    test.skip(needsDb && !process.env.DATABASE_URL, "DATABASE_URL is not set");
    test.beforeAll(async () => {
      if (!needsDb) return;
      const repo = new PgAnalyticsRepository(process.env.DATABASE_URL as string);
      await repo.migrate();
      await repo.close();
    });

    test("URL variants land on one page key, and queries canonicalize", async () => {
      const id = `key_${uid()}`;
      await withServer(makeRepo(), async (base) => {
        await project(base, id);
        await collect(base, payload(id, "https://www.shop.example.com/p/?utm=1", 1, [click], "a"), ORIGIN);
        await collect(base, payload(id, "https://shop.example.com/p#x", 1, [click], "b"), ORIGIN);
        for (const q of ["pageKey=shop.example.com/p", `pageUrl=${encodeURIComponent("https://www.shop.example.com/p/")}`]) {
          const res = await get(base, `/api/v1/heatmaps/click?projectId=${id}&${q}`);
          expect(res.json).toMatchObject({ pageKey: "shop.example.com/p", device: null, totalClicks: 2 });
        }
      });
    });

    test("device comes from the viewport and later beacons reuse it", async () => {
      const id = `dev_${uid()}`;
      const url = "https://shop.example.com/d";
      await withServer(makeRepo(), async (base) => {
        await project(base, id);
        await collect(base, payload(id, url, 1, [doc, resize(375, 700)], "m"), ORIGIN);
        await collect(base, payload(id, url, 2, [click], "m"), ORIGIN);
        await collect(base, payload(id, url, 1, [doc, resize(1280, 900), click], "d"), ORIGIN);
        const q = `/api/v1/heatmaps/click?projectId=${id}&pageKey=shop.example.com/d`;
        expect((await get(base, `${q}&device=mobile`)).json.totalClicks).toBe(1);
        expect((await get(base, `${q}&device=desktop`)).json.totalClicks).toBe(1);
        expect((await get(base, `${q}&device=tablet`)).json.totalClicks).toBe(0);
        expect((await get(base, q)).json.totalClicks).toBe(2);
        expect((await get(base, `${q}&device=phone`)).status).toBe(400);
      });
    });

    test("averageFoldY is the mean viewport height, and null with no sessions", async () => {
      const id = `fold_${uid()}`;
      await withServer(makeRepo(), async (base) => {
        await project(base, id);
        await collect(base, payload(id, "https://shop.example.com/f", 1, [doc, resize(1280, 1000)], "a"), ORIGIN);
        await collect(base, payload(id, "https://shop.example.com/f", 1, [doc, resize(1400, 800)], "b"), ORIGIN);
        const scroll = await get(base, `/api/v1/heatmaps/scroll?projectId=${id}&pageKey=shop.example.com/f`);
        expect(scroll.json).toMatchObject({ totalSessions: 2, averageFoldY: 900 });
        const empty = await get(base, `/api/v1/heatmaps/scroll?projectId=${id}&pageKey=shop.example.com/none`);
        expect(empty.json).toMatchObject({ totalSessions: 0, scrollMap: [], averageFoldY: null });
      });
    });

    test("snapshot without a device returns the latest across devices", async () => {
      const id = `snapdev_${uid()}`;
      const url = "https://shop.example.com/s";
      await withServer(makeRepo(), async (base) => {
        await project(base, id);
        await collect(base, payload(id, url, 1, [resize(1280, 900), discover], "a"), ORIGIN);
        await new Promise((r) => setTimeout(r, 5));
        await collect(base, payload(id, url, 1, [resize(375, 700), [100, 5, 1, 0, "BODY", {}]], "b"), ORIGIN);
        const q = `/api/v1/heatmaps/snapshot?projectId=${id}&pageKey=shop.example.com/s`;
        expect((await get(base, q)).json).toMatchObject({ pageKey: "shop.example.com/s", device: "mobile" });
        expect((await get(base, `${q}&device=desktop`)).json.device).toBe("desktop");
        expect((await get(base, `${q}&device=tablet`)).status).toBe(404);
      });
    });

    test("unknown projects get 404 on heatmaps and pages", async () => {
      await withServer(makeRepo(), async (base) => {
        for (const kind of ["click", "scroll", "snapshot"]) {
          expect((await get(base, `/api/v1/heatmaps/${kind}?projectId=nope_${uid()}&pageKey=x.com/`)).status).toBe(404);
        }
        expect((await get(base, `/api/v1/projects/nope_${uid()}/pages`)).status).toBe(404);
      });
    });

    test("pages come from the index with views, clicks, devices and the excluded flag", async () => {
      const id = `pages_${uid()}`;
      await withServer(makeRepo(), async (base) => {
        await project(base, id);
        await collect(base, payload(id, "https://shop.example.com/a", 1, [doc, resize(375, 700), click], "m"), ORIGIN);
        await collect(base, payload(id, "https://shop.example.com/a", 2, [click], "m"), ORIGIN);
        await new Promise((r) => setTimeout(r, 5));
        await collect(base, payload(id, "https://www.shop.example.com/a/", 1, [doc, resize(1280, 900)], "d"), ORIGIN);
        await new Promise((r) => setTimeout(r, 5));
        await collect(base, payload(id, "https://shop.example.com/thanks", 1, [], "t"), ORIGIN);
        const put = await fetch(`${base}/api/v1/projects/${id}`, {
          method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ name: id, excludePatterns: ["shop.example.com/thanks*"] })
        });
        expect(put.status).toBe(200);

        const { json } = await get(base, `/api/v1/projects/${id}/pages`);
        expect(json.pages.map((p: any) => p.pageKey)).toEqual(["shop.example.com/thanks", "shop.example.com/a"]);
        expect(json.pages[0].excluded).toBe(true);
        expect(json.pages[1]).toMatchObject({ pageUrl: "https://www.shop.example.com/a/", views: 2, clicks: 2, excluded: false });
        expect(json.pages[1].devices.mobile).toMatchObject({ views: 1, clicks: 2 });
        expect(json.pages[1].devices.desktop).toMatchObject({ views: 1, clicks: 0 });
      });
    });

    test("versioned upsert: stale writes get 409, omitted fields keep stored values", async () => {
      const id = `ver_${uid()}`;
      await withServer(makeRepo(), async (base) => {
        await project(base, id, { excludePatterns: ["shop.example.com/x"], version: 200 });
        const stale = await syncProject(base, { id, name: "old", version: 100 });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: "stale_version", storedVersion: 200 });
        const same = await syncProject(base, { id, name: "same", version: 200 });
        expect(same.status).toBe(200);
        const none = await syncProject(base, { id, name: "none" });
        expect(((await none.json()) as any).project).toMatchObject({
          name: "none", version: 200, excludePatterns: ["shop.example.com/x"], allowedDomains: ["shop.example.com", "www.shop.example.com"]
        });
        expect((await syncProject(base, { id, name: "bad", version: "1" })).status).toBe(400);
        expect((await syncProject(base, { id, name: "bad", excludePatterns: "x" })).status).toBe(400);
      });
    });

    test("drops are counted per project and reason", async () => {
      const id = `drop_${uid()}`;
      const unknown = `${id}_unknown`;
      const url = "https://shop.example.com/z";
      await withServer(makeRepo(), async (base) => {
        await project(base, id, { excludePatterns: ["shop.example.com/z"] });
        await collect(base, payload(id, url, 1, [click]), ORIGIN);
        await collect(base, payload(id, "https://shop.example.com/ok", 1, [click]), "https://evil.example.net");
        await collect(base, payload(unknown, url, 1, [click]), ORIGIN);
        await collect(base, "not a payload");
        const gz = await fetch(`${base}/api/v1/collect`, { method: "POST", body: Buffer.from([0x1f, 0x8b, 1, 2, 3]) });
        expect(gz.status).toBe(204);

        const known = await get(base, `/api/v1/projects/${id}`);
        expect(known.json.drops).toMatchObject({ excluded: { count: 1 }, origin: { count: 1 } });
        const missing = await get(base, `/api/v1/projects/${unknown}`);
        expect(missing.status).toBe(404);
        expect(missing.json.drops.unknown.count).toBe(1);
        const unattributed = await get(base, "/api/v1/drops");
        expect(unattributed.json.drops.gunzip.count).toBeGreaterThanOrEqual(1);
        expect(unattributed.json.drops.invalid.count).toBeGreaterThanOrEqual(1);
        expect((await fetch(`${base}/api/v1/drops`)).status).toBe(401);
      });
    });
  });
}

suite("memory repository", () => new MemoryAnalyticsRepository(), false);
suite("postgres repository", () => new PgAnalyticsRepository(process.env.DATABASE_URL as string), true);

test("health reports the database state", async () => {
  await withServer(new MemoryAnalyticsRepository(), async (base) => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "healthy", db: "ok" });
  });
  const broken = new MemoryAnalyticsRepository();
  broken.ping = async () => {
    throw new Error("down");
  };
  await withServer(broken, async (base) => {
    expect((await fetch(`${base}/health`)).status).toBe(503);
  });
});
