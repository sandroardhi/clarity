import { expect, test } from "@playwright/test";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { MemoryAnalyticsRepository } from "../src/db/repository";
import { RowLimiter } from "../src/services/limits";
import { AUTH, click, payload, syncProject, Token, uid, withServer } from "./helper";

const ORIGIN = "https://shop.example.com";

async function post(base: string, body: string): Promise<number> {
  const res = await fetch(`${base}/api/v1/collect`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: ORIGIN }, body });
  return res.status;
}

test("row limiter caps sessions and projects per minute window", () => {
  const limiter = new RowLimiter({ sessionRowsPerMin: 3, projectRowsPerMin: 5 });
  expect(limiter.allow("p", "a", 3, 0)).toBe(true);
  expect(limiter.allow("p", "a", 1, 10)).toBe(false);
  expect(limiter.allow("p", "b", 2, 20)).toBe(true);
  expect(limiter.allow("p", "c", 1, 30)).toBe(false);
  expect(limiter.allow("q", "a", 3, 40)).toBe(true);
  expect(limiter.allow("p", "a", 3, 60000)).toBe(true);
});

test("beacons over the cap get 429 and count as rate_limited", async () => {
  const id = `cap_${uid()}`;
  const repo = new MemoryAnalyticsRepository();
  await withServer(repo, async (base) => {
    expect((await syncProject(base, { id, name: id, allowedDomains: ["shop.example.com"] })).status).toBe(201);
    expect(await post(base, payload(id, `${ORIGIN}/a`, 1, [click]))).toBe(204);
    expect(await post(base, payload(id, `${ORIGIN}/a`, 2, [click]))).toBe(429);
    const res = await fetch(`${base}/api/v1/projects/${id}`, { headers: AUTH });
    expect(((await res.json()) as any).drops.rate_limited.count).toBe(1);
  }, { limits: { sessionRowsPerMin: 3, projectRowsPerMin: 100 } });
});

test("clicks with out-of-range coordinates are skipped and counted", async () => {
  const id = `coord_${uid()}`;
  const bad: Token = [...click.slice(0, 5), 40000, ...click.slice(6)];
  await withServer(new MemoryAnalyticsRepository(), async (base) => {
    expect((await syncProject(base, { id, name: id, allowedDomains: ["shop.example.com"] })).status).toBe(201);
    expect(await post(base, payload(id, `${ORIGIN}/c`, 1, [click, bad]))).toBe(204);
    const heat = await fetch(`${base}/api/v1/heatmaps/click?projectId=${id}&pageKey=shop.example.com/c`, { headers: AUTH });
    expect(((await heat.json()) as any).totalClicks).toBe(1);
    const res = await fetch(`${base}/api/v1/projects/${id}`, { headers: AUTH });
    expect(((await res.json()) as any).drops.invalid.count).toBe(1);
  });
});

test("CORS is sent on collect and scripts only", async () => {
  await withServer(new MemoryAnalyticsRepository(), async (base) => {
    const preflight = await fetch(`${base}/api/v1/collect`, {
      method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" }
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    const api = await fetch(`${base}/api/v1/projects/x`, { headers: { ...AUTH, Origin: ORIGIN } });
    expect(api.headers.get("access-control-allow-origin")).toBeNull();
    const health = await fetch(`${base}/health`, { headers: { Origin: ORIGIN } });
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
  });
});

test("the previous secret is accepted during a rotation", async () => {
  await withServer(new MemoryAnalyticsRepository(), async (base) => {
    expect((await fetch(`${base}/api/v1/projects/x`, { headers: { "X-Internal-Secret": "old-secret" } })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/projects/x`, { headers: AUTH })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/projects/x`, { headers: { "X-Internal-Secret": "other" } })).status).toBe(401);
  }, { previousSecret: "old-secret" });
});

test("tracker.js revalidates with an ETag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clarity-tracker-"));
  const trackerPath = path.join(dir, "clarity.min.js");
  fs.writeFileSync(trackerPath, "/* tracker */");
  await withServer(new MemoryAnalyticsRepository(), async (base) => {
    const first = await fetch(`${base}/tracker.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag") as string;
    expect(etag).toBeTruthy();
    // fetch() adds Cache-Control: no-cache to conditional requests, which defeats the check, so use http.get
    const status = await new Promise<number>((resolve, reject) => {
      http.get(`${base}/tracker.js`, { headers: { "If-None-Match": etag } }, (res) => {
        res.resume();
        resolve(res.statusCode as number);
      }).on("error", reject);
    });
    expect(status).toBe(304);
  }, { trackerPath });
  fs.rmSync(dir, { recursive: true });
});
