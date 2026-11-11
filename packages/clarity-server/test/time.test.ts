import { expect, test } from "@playwright/test";
import http from "http";
import { MemoryAnalyticsRepository } from "../src/db/repository";
import { createServer } from "../src/server";
import { BadRequestError, DEFAULT_TZ, parseTimeRange } from "../src/services/timeRange";
import { AUTH, JSON_AUTH, SECRET } from "./helper";

test("time range takes ISO with an offset, or Y-m-d with tz", () => {
  expect(parseTimeRange()).toEqual({ from: null, to: null });
  expect(parseTimeRange("2026-11-11T00:00:00+07:00", "2026-11-12T00:00:00Z")).toEqual({
    from: Date.UTC(2026, 10, 10, 17),
    to: Date.UTC(2026, 10, 12)
  });
  const wib = { from: Date.UTC(2026, 10, 10, 17), to: Date.UTC(2026, 10, 11, 17) };
  expect(parseTimeRange("2026-11-11", "2026-11-11", "Asia/Jakarta")).toEqual(wib);
  expect(parseTimeRange("2026-11-11", "2026-11-11", "+07:00")).toEqual(wib);
  expect(parseTimeRange("2026-03-08", undefined, "America/New_York").from).toBe(Date.UTC(2026, 2, 8, 5));
});

test("a Y-m-d bound without tz falls back to the default zone, and an explicit tz wins", () => {
  const wib = { from: Date.UTC(2026, 10, 10, 17), to: Date.UTC(2026, 10, 11, 17) };
  expect(DEFAULT_TZ).toBe("Asia/Jakarta");
  expect(parseTimeRange("2026-11-11", "2026-11-11")).toEqual(wib);
  expect(parseTimeRange("2026-11-11", "2026-11-11", "")).toEqual(wib);
  expect(parseTimeRange("2026-11-11", undefined, undefined, "+00:00").from).toBe(Date.UTC(2026, 10, 11));
  expect(parseTimeRange("2026-11-11", "2026-11-11", "UTC")).toEqual({ from: Date.UTC(2026, 10, 11), to: Date.UTC(2026, 10, 12) });
  expect(parseTimeRange("2026-11-11", undefined, "+09:00", "UTC").from).toBe(Date.UTC(2026, 10, 10, 15));
});

test("an invalid default zone stops the server at boot", () => {
  expect(() => createServer({ repository: new MemoryAnalyticsRepository(), internalSecret: SECRET, defaultTz: "Mars/Base" }))
    .toThrow(/CLARITY_DEFAULT_TZ/);
});

test("time range rejects sentinels, bad formats and bad zones", () => {
  for (const args of [["all"], [undefined, "now"], ["2026-11-11T00:00:00"], ["2026-02-30", undefined, "+07:00"],
    ["2026-11-11", undefined, "Mars/Base"], ["2026-11-12", "2026-11-11", "+07:00"]]) {
    expect(() => parseTimeRange(...(args as [string?, string?, string?]))).toThrow(BadRequestError);
  }
});

test("collect stamps server receive time and keeps the client clock apart", async () => {
  const repository = new MemoryAnalyticsRepository();
  const server = http.createServer(createServer({ repository, internalSecret: SECRET }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ id: "t1", name: "t1", allowedDomains: ["t.example.com"] })
    });
    const before = Date.now();
    const clientStart = Date.UTC(2020, 0, 1);
    const click = [200, 9, 10, 500, 300, 100, 100, 0, 1, 0, "Buy", null, "h1.h1b", 1, null, 120, 40, "BUTTON", "buy", "btn"];
    const body = JSON.stringify({ e: ["0.8.76", 1, clientStart, 500, "t1", "u1", "s1", 1, 0, 0, 0, "https://t.example.com/"], a: [click] });
    await fetch(`${base}/api/v1/collect`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: "https://t.example.com" }, body });

    const url = (q: string): string => `${base}/api/v1/heatmaps/click?projectId=t1&pageUrl=${encodeURIComponent("https://t.example.com/")}${q}`;
    const recent = await fetch(url(`&from=${encodeURIComponent(new Date(before - 1000).toISOString())}`), { headers: AUTH });
    const json = (await recent.json()) as { totalClicks: number; from: number; to: number | null };
    expect(json.totalClicks).toBe(1);
    expect(json.from).toBe(before - 1000);
    expect(json.to).toBeNull();

    const old = await fetch(url("&from=2019-12-31&to=2020-01-02&tz=Asia/Jakarta"), { headers: AUTH });
    expect(((await old.json()) as { totalClicks: number }).totalClicks).toBe(0);

    expect((await fetch(url("&from=all"), { headers: AUTH })).status).toBe(400);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
    const day = await fetch(url(`&from=${today}&to=${today}`), { headers: AUTH });
    expect(day.status).toBe(200);
    expect(((await day.json()) as { totalClicks: number }).totalClicks).toBe(1);
    const noTz = (await (await fetch(url("&from=2026-11-11"), { headers: AUTH })).json()) as { from: number };
    expect(noTz.from).toBe(Date.UTC(2026, 10, 10, 17));
    const utc = (await (await fetch(url("&from=2026-11-11&tz=UTC"), { headers: AUTH })).json()) as { from: number };
    expect(utc.from).toBe(Date.UTC(2026, 10, 11));
  } finally {
    server.close();
  }
});
