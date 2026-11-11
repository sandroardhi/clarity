import { test } from "@playwright/test";
import { createServer } from "../src/server";
import { IAnalyticsRepository, MemoryAnalyticsRepository } from "../src/db/repository";
import { PgAnalyticsRepository } from "../src/db/postgres";
import { HeatmapClickResponse, HeatmapScrollResponse, PageSnapshotResponse } from "../src/types";
import http from "http";
import zlib from "zlib";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[AssertionFailed]: ${message}`);
  }
}

async function testServerWithRepository(repoName: string, repository: IAnalyticsRepository) {
  console.log(`\n--- [TEST SUITE] Testing Server with ${repoName} ---`);

  const app = createServer({ repository });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const testSuffix = Date.now();
  const testProjectId = `proj_${testSuffix}`;
  const testPageUrl = `https://store-${testSuffix}.skalpl.com/products`;
  const allowedDomain = `store-${testSuffix}.skalpl.com`;

  try {
    // 1. Healthcheck
    console.log("1. Testing Healthcheck (/health)...");
    const healthRes = await fetch(`${baseUrl}/health`);
    assert(healthRes.status === 200, "Health should return 200");
    const healthJson = (await healthRes.json()) as { status: string };
    assert(healthJson.status === "healthy", "Health status should be healthy");

    // 2. Project Registration (Multi-Tenant)
    console.log("2. Testing Project Registration (POST /api/v1/projects)...");
    const createProjectRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: testProjectId,
        name: `Skalpl Store ${testSuffix}`,
        allowedDomains: [allowedDomain, "localhost"]
      })
    });
    assert(createProjectRes.status === 201, "Create project should return 201");
    const projectJson = (await createProjectRes.json()) as any;
    assert(projectJson.project.id === testProjectId, "Project ID must match");
    assert(projectJson.project.allowedDomains.includes(allowedDomain), "Allowed domains must match");

    // 3. Test Tracker Script Serving (/tracker.js)
    console.log("3. Testing Tracker Script Serving (/tracker.js)...");
    const trackerRes = await fetch(`${baseUrl}/tracker.js`);
    assert(trackerRes.status === 200, "Tracker script should be served with 200");
    const contentType = trackerRes.headers.get("content-type");
    assert(contentType?.includes("javascript") === true, "Content-Type must be javascript");
    const trackerCode = await trackerRes.text();
    assert(trackerCode.length > 1000, "Tracker script must not be empty");

    // 4. Ingestion: Unauthorized Origin should be rejected
    console.log("4. Testing Domain Whitelist Security (Unauthorized Origin)...");
    const samplePayload = JSON.stringify({
      e: [
        "0.8.76",
        1,
        1000,
        500,
        testProjectId,
        "user_123",
        "sess_456",
        1,
        0,
        0,
        0,
        testPageUrl
      ],
      a: [
        [100, 5, 1, 0, "HTML", {}]
      ]
    });

    const unauthorizedRes = await fetch(`${baseUrl}/api/v1/collect`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Origin": "https://malicious-spam-site.com"
      },
      body: samplePayload
    });
    assert(unauthorizedRes.status === 204, "Beacon response must always be 204 No Content");

    // 4b. Unknown project ids are dropped, not auto-created
    console.log("4b. Testing that unknown projects are not auto-created...");
    const autoProjId = `auto_proj_${Date.now()}`;
    const autoPayload = JSON.stringify({
      e: ["0.8.76", 1, 1000, 500, autoProjId, "u1", "s1", 1, 0, 0, 0, "https://auto.com/"],
      a: [[100, 5, 1, 0, "HTML", {}]]
    });
    const autoRes = await fetch(`${baseUrl}/api/v1/collect`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Origin": "https://auto.com" },
      body: autoPayload
    });
    assert(autoRes.status === 204, "Beacon for unknown project should still return 204");
    assert((await repository.getProject(autoProjId)) === null, "Unknown project must not be created");

    // 5. Ingestion: Authorized Origin with Clicks & Scroll
    console.log("5. Testing Telemetry Ingestion (POST /api/v1/collect with Clicks)...");
    const telemetryPayload = JSON.stringify({
      e: [
        "0.8.76",
        1,
        1000,
        500,
        testProjectId,
        "user_123",
        "sess_456",
        1,
        0,
        0,
        0,
        testPageUrl
      ],
      a: [
        // Document size (8 = Event.Document) and viewport (11 = Event.Resize)
        [90, 8, 1200, 1000],
        [95, 11, 1200, 600],
        // Discover DOM (5 = Event.Discover)
        [100, 5, 1, 0, "HTML", {}],
        // Click 1 (9 = Event.Click)
        [200, 9, 10, 500, 300, 16383, 16383, 0, 1, 0, "Buy Now", null, "hash_btn_buy.hash_btn_buy_beta", 1, null, 120, 40, "BUTTON", "cta-buy", "btn-main"],
        // Click 2 (9 = Event.Click)
        [250, 9, 10, 505, 305, 17000, 17000, 0, 1, 0, "Buy Now", null, "hash_btn_buy.hash_btn_buy_beta", 1, null, 120, 40, "BUTTON", "cta-buy", "btn-main"],
        // Scroll event (10 = Event.Scroll): scrollY 150 + viewport 600 of 1000 = 75%
        [300, 10, 1, 0, 150]
      ]
    });

    const collectRes = await fetch(`${baseUrl}/api/v1/collect`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Origin": `https://${allowedDomain}`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: telemetryPayload
    });
    assert(collectRes.status === 204, "Authorized ingestion must return 204 No Content");

    // 5b. Testing Gzipped Telemetry Ingestion (Browser XHR with CompressionStream)
    const telemetryPayloadGzip = JSON.stringify({
      e: [
        "0.8.76",
        2,
        2000,
        500,
        testProjectId,
        "user_123",
        "sess_gzip_789",
        1,
        0,
        0,
        0,
        testPageUrl
      ],
      a: [
        [350, 9, 10, 500, 300, 16383, 16383, 0, 1, 0, "Buy Now", null, "hash_btn_buy.hash_btn_buy_beta", 1, null, 120, 40, "BUTTON", "cta-buy", "btn-main"],
        [400, 9, 10, 505, 305, 17000, 17000, 0, 1, 0, "Buy Now", null, "hash_btn_buy.hash_btn_buy_beta", 1, null, 120, 40, "BUTTON", "cta-buy", "btn-main"]
      ]
    });
    const gzippedPayload = zlib.gzipSync(Buffer.from(telemetryPayloadGzip));
    const collectGzipRes = await fetch(`${baseUrl}/api/v1/collect`, {
      method: "POST",
      headers: {
        "Origin": `https://${allowedDomain}`,
        "Accept": "application/x-clarity-gzip",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: gzippedPayload
    });
    assert(collectGzipRes.status === 204, "Gzipped ingestion must return 204 No Content");

    // 6. Query Click Heatmap (GET /api/v1/heatmaps/click)
    console.log("6. Testing Click Heatmap API (/api/v1/heatmaps/click)...");
    const clickQueryUrl = `${baseUrl}/api/v1/heatmaps/click?projectId=${testProjectId}&pageUrl=${encodeURIComponent(testPageUrl)}&device=desktop`;
    const clickHeatmapRes = await fetch(clickQueryUrl);
    assert(clickHeatmapRes.status === 200, "Click heatmap query should return 200");
    const clickJson = (await clickHeatmapRes.json()) as HeatmapClickResponse;

    assert(clickJson.projectId === testProjectId, "projectId must match");
    assert(clickJson.totalClicks === 4, "totalClicks must be 4 (2 batches of 2 clicks)");
    assert(Array.isArray(clickJson.activity), "activity must be an array");
    assert(clickJson.activity.length === 1, "There should be 1 aggregated element");

    const element = clickJson.activity[0];
    assert(element.hash === "hash_btn_buy_beta", "Hash must match hashBeta");
    assert(element.totalclicks === 4, "Element totalclicks must be 4");
    assert(element.points === 2, "Points count must be 2 (clustered)");
    assert(element.x.length === 2 && element.y.length === 2, "X and Y coordinate arrays must have 2 points");
    console.log("   -> Click heatmap activity verified: Element", element.hash, "clicks:", element.totalclicks);

    // 7. Query Scroll Heatmap (GET /api/v1/heatmaps/scroll)
    console.log("7. Testing Scroll Heatmap API (/api/v1/heatmaps/scroll)...");
    const scrollQueryUrl = `${baseUrl}/api/v1/heatmaps/scroll?projectId=${testProjectId}&pageUrl=${encodeURIComponent(testPageUrl)}&device=desktop`;
    const scrollHeatmapRes = await fetch(scrollQueryUrl);
    assert(scrollHeatmapRes.status === 200, "Scroll heatmap query should return 200");
    const scrollJson = (await scrollHeatmapRes.json()) as HeatmapScrollResponse;

    assert(scrollJson.totalSessions === 1, "totalSessions must be 1");
    assert(Array.isArray(scrollJson.scrollMap), "scrollMap must be an array");
    const reached75 = scrollJson.scrollMap.find((m) => m.scrollReachY === 75);
    assert(reached75?.percUsers === 100, "100% of sessions reached 75% scroll depth");
    const reached100 = scrollJson.scrollMap.find((m) => m.scrollReachY === 100);
    assert(reached100?.percUsers === 0, "No session reached 100% scroll depth");
    console.log("   -> Scroll heatmap verified: 75% reach =", reached75?.percUsers, "%");

    // 8. Query Page Snapshot (GET /api/v1/heatmaps/snapshot)
    console.log("8. Testing Page Snapshot API (/api/v1/heatmaps/snapshot)...");
    const snapshotQueryUrl = `${baseUrl}/api/v1/heatmaps/snapshot?projectId=${testProjectId}&pageUrl=${encodeURIComponent(testPageUrl)}&device=desktop`;
    const snapshotRes = await fetch(snapshotQueryUrl);
    assert(snapshotRes.status === 200, "Snapshot query should return 200");
    const snapshotJson = (await snapshotRes.json()) as PageSnapshotResponse;

    assert(snapshotJson.projectId === testProjectId, "Snapshot projectId must match");
    assert(snapshotJson.payload.length > 0, "Snapshot payload must not be empty");
    console.log("   -> Snapshot payload retrieved successfully, length:", snapshotJson.payload.length);

    // 9. Query Tracked Pages List (GET /api/v1/projects/:projectId/pages)
    console.log("9. Testing Tracked Pages API (/api/v1/projects/:projectId/pages)...");
    const pagesRes = await fetch(`${baseUrl}/api/v1/projects/${testProjectId}/pages`);
    assert(pagesRes.status === 200, "Tracked pages query should return 200");
    const pagesJson = (await pagesRes.json()) as any;
    assert(Array.isArray(pagesJson.pages), "Pages must be an array");
    assert(pagesJson.pages.length === 1, "Should have 1 tracked page");
    assert(pagesJson.pages[0].pageUrl === testPageUrl, "Tracked page URL must match");
    console.log("   -> Tracked pages verified:", pagesJson.pages[0].pageUrl);

    console.log(`>>> ${repoName} PASSED ALL TESTS WITH ZERO ERRORS! <<<`);
  } finally {
    server.close();
  }
}

test("server with in-memory repository", async () => {
  await testServerWithRepository("In-Memory Storage", new MemoryAnalyticsRepository());
});

test("server with postgres repository", async () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is not set");
  const pgRepo = new PgAnalyticsRepository(process.env.DATABASE_URL as string);
  try {
    await pgRepo.migrate();
    await testServerWithRepository("Live PostgreSQL Storage", pgRepo);
  } finally {
    await pgRepo.close();
  }
});
