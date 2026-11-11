import { test } from "@playwright/test";
import { PgAnalyticsRepository } from "../src/db/postgres";
import { Activity, DeviceType, HeatmapQuery, PageSnapshot, Project, RawClickRecord, RawScrollRecord } from "../src/types";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[AssertionFailed]: ${message}`);
  }
}

async function runPostgresTests() {
  console.log("=== Running PostgreSQL Real Database Integration Tests ===");

  const repo = new PgAnalyticsRepository(process.env.DATABASE_URL as string);

  try {
    // 1. Initialize Schema
    console.log("1. Initializing schema in PostgreSQL...");
    await repo.initSchema();

    const testProjectId = `test_proj_${Date.now()}`;
    const testPageUrl = "https://myskalplstore.com/checkout";

    // 2. Create Project
    console.log("2. Testing Project creation...");
    const project: Project = {
      id: testProjectId,
      name: "Skalpl Production Store",
      allowedDomains: ["myskalplstore.com", "app.myskalplstore.com"],
      isActive: true,
      createdAt: Date.now()
    };
    await repo.createProject(project);

    const fetchedProject = await repo.getProject(testProjectId);
    assert(fetchedProject !== null, "Project should exist in PostgreSQL");
    assert(fetchedProject?.id === testProjectId, "Project ID should match");
    assert(fetchedProject?.name === "Skalpl Production Store", "Project name should match");
    assert(fetchedProject?.allowedDomains.includes("myskalplstore.com") === true, "Allowed domains should match");
    console.log("   -> Project successfully stored and retrieved from PostgreSQL.");

    // 3. Insert Raw Clicks
    console.log("3. Testing batch Raw Clicks insertion in PostgreSQL...");
    const now = Date.now();
    const rawClicks: RawClickRecord[] = [
      // 3 clicks at coordinate (16000, 16000) on CTA button
      {
        id: `click_1_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "desktop" as DeviceType,
        hash: "hash_checkout_btn",
        selector: "button.btn-primary#checkout",
        eX: 16000,
        eY: 16000,
        timestamp: now
      },
      {
        id: `click_2_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "desktop" as DeviceType,
        hash: "hash_checkout_btn",
        selector: "button.btn-primary#checkout",
        eX: 16000,
        eY: 16000,
        timestamp: now + 10
      },
      {
        id: `click_3_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "desktop" as DeviceType,
        hash: "hash_checkout_btn",
        selector: "button.btn-primary#checkout",
        eX: 16000,
        eY: 16000,
        timestamp: now + 20
      },
      // 1 click at coordinate (18000, 17000) on the same CTA button
      {
        id: `click_4_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "desktop" as DeviceType,
        hash: "hash_checkout_btn",
        selector: "button.btn-primary#checkout",
        eX: 18000,
        eY: 17000,
        timestamp: now + 30
      },
      // 1 click on a mobile device to test device filtering
      {
        id: `click_5_mobile_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "mobile" as DeviceType,
        hash: "hash_mobile_nav",
        selector: "nav.mobile-menu",
        eX: 5000,
        eY: 5000,
        timestamp: now
      }
    ];

    await repo.saveRawClicks(rawClicks);
    console.log("   -> Inserted", rawClicks.length, "clicks into raw_clicks table.");

    // 4. Query Click Heatmap (Desktop)
    console.log("4. Testing SQL GROUP BY Heatmap aggregation in PostgreSQL...");
    const desktopQuery: HeatmapQuery = {
      projectId: testProjectId,
      pageUrl: testPageUrl,
      device: "desktop"
    };

    const activity: Activity = await repo.getClickActivity(desktopQuery);
    assert(activity.length === 1, "There should be exactly 1 aggregated element on desktop");
    const checkoutBtn = activity[0];
    assert(checkoutBtn.hash === "hash_checkout_btn", "Element hash should match");
    assert(checkoutBtn.totalclicks === 4, "Total clicks on checkout button should be 4");
    assert(checkoutBtn.points === 2, "There should be 2 distinct coordinate clusters");

    // Check grouping of coordinate (16000, 16000)
    const coordIdx = checkoutBtn.x.findIndex((x, idx) => x === 16000 && checkoutBtn.y[idx] === 16000);
    assert(coordIdx !== -1, "Coordinate (16000, 16000) must exist");
    assert(checkoutBtn.clicks[coordIdx] === 3, "Coordinate (16000, 16000) must have 3 grouped clicks");
    console.log("   -> SQL GROUP BY verified: 4 total clicks aggregated into 2 distinct coordinate points.");

    // 5. Test Scroll Tracking & Distribution
    console.log("5. Testing Scroll Distribution in PostgreSQL...");
    const scrolls: RawScrollRecord[] = [
      {
        id: `scroll_sess_1_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "desktop",
        sessionId: "sess_user_1",
        maxScrollReachY: 100, // Reached footer
        timestamp: now
      },
      {
        id: `scroll_sess_2_${now}`,
        projectId: testProjectId,
        pageUrl: testPageUrl,
        device: "desktop",
        sessionId: "sess_user_2",
        maxScrollReachY: 50, // Reached 50%
        timestamp: now
      }
    ];

    for (const s of scrolls) {
      await repo.saveRawScroll(s);
    }

    const scrollRes = await repo.getScrollMap(desktopQuery);
    assert(scrollRes.totalSessions === 2, "Total sessions should be 2");
    const m0 = scrollRes.scrollMap.find((m) => m.scrollReachY === 0);
    const m50 = scrollRes.scrollMap.find((m) => m.scrollReachY === 50);
    const m100 = scrollRes.scrollMap.find((m) => m.scrollReachY === 100);

    assert(m0?.percUsers === 100, "100% of sessions reached 0%");
    assert(m50?.percUsers === 100, "100% of sessions reached 50%");
    assert(m100?.percUsers === 50, "50% of sessions reached 100%");
    console.log("   -> Scroll reach distribution verified: 0% = 100%, 50% = 100%, 100% = 50%.");

    // 6. Test Page Snapshot (Upsert)
    console.log("6. Testing Page Snapshot in PostgreSQL...");
    const snapshot: PageSnapshot = {
      id: `${testProjectId}:snap_1`,
      projectId: testProjectId,
      pageUrl: testPageUrl,
      device: "desktop",
      domHash: "dom_v1_abc",
      rawPayload: '{"e":["0.8.76",1],"a":[[100,5,1,0,"HTML",{}]]}',
      timestamp: now
    };
    await repo.savePageSnapshot(snapshot);

    const retrievedSnapshot = await repo.getPageSnapshot(testProjectId, testPageUrl, "desktop");
    assert(retrievedSnapshot !== null, "Page snapshot should be retrieved");
    assert(retrievedSnapshot?.domHash === "dom_v1_abc", "DOM Hash should match");
    console.log("   -> Page snapshot stored and retrieved successfully.");

    // 7. Test Tracked Pages List
    console.log("7. Testing Tracked Pages Listing...");
    const pages = await repo.listTrackedPages(testProjectId);
    assert(pages.length === 1, "Should list 1 tracked page");
    assert(pages[0].pageUrl === testPageUrl, "Tracked page URL should match");
    assert(pages[0].totalClicks === 5, "Total clicks across all devices should be 5");
    console.log("   -> Tracked pages verified:", pages[0].pageUrl, "clicks:", pages[0].totalClicks);

    console.log("\n>>> POSTGRESQL DATABASE TESTS PASSED 100% WITH ZERO ERRORS! <<<");
  } finally {
    await repo.close();
  }
}

test("postgres repository stores and aggregates telemetry", async () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is not set");
  await runPostgresTests();
});
