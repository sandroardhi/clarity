import { expect, Page, Route, test } from "@playwright/test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const origin = "https://site.test/";
const upload = `${origin}collect`;
const builds = [join(__dirname, "..", "build"), join(__dirname, "..", "..", "clarity-visualize", "build")];

type TrackerWindow = typeof window & {
    skalplHeatmap: (command: string, config?: object) => void;
    clarity: { v: string; calls: unknown[][] };
};

async function open(page: Page, status: () => number, requests: string[], payloads: string[]): Promise<void> {
    await page.route("**/*", async (route: Route): Promise<void> => {
        const url = route.request().url();
        if (url === origin) {
            await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body><p>hi</p></body></html>" });
            return;
        }
        requests.push(url);
        if (url === upload) {
            payloads.push(route.request().postData() || "");
            await route.fulfill({ status: status(), contentType: "text/plain", body: "" });
        } else {
            await route.abort();
        }
    });
    await page.goto(origin);
}

async function start(page: Page, track: boolean): Promise<void> {
    await page.evaluate(() => Object.defineProperty(window, "CompressionStream", { value: undefined, configurable: true }));
    await page.addScriptTag({ path: join(__dirname, "..", "build", "clarity.min.js") });
    await page.evaluate((settings: { endpoint: string; track: boolean }): void => {
        (window as TrackerWindow).skalplHeatmap("start", { projectId: "test", track: settings.track, delay: 50, upload: settings.endpoint });
    }, { endpoint: upload, track });
}

async function mutate(page: Page, rounds: number): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await page.evaluate((n: number) => { const p = document.createElement("p"); p.textContent = `row ${n}`; document.body.appendChild(p); }, i);
        await page.waitForTimeout(300);
    }
}

test("built bundles contain no Microsoft endpoints or Clarity storage keys", () => {
    for (const dir of builds) {
        const files = readdirSync(dir).filter(f => f.endsWith(".js"));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const source = readFileSync(join(dir, file), "utf8");
            expect(source, file).not.toMatch(/clarity\.ms|bing\.com/i);
            expect(source, file).not.toMatch(/_clck|_clsk|_cltk/);
        }
    }
    expect(readFileSync(join(builds[0], "clarity.min.js"), "utf8")).toContain("skalplHeatmap");
});

test("tracker leaves Microsoft Clarity alone and ignores upload URLs stored in cookies", async ({ page }) => {
    const requests: string[] = [];
    const payloads: string[] = [];
    await open(page, () => 204, requests, payloads);
    await page.evaluate(() => {
        const calls: unknown[][] = [];
        const ms = function(...args: unknown[]): void { calls.push(args); } as unknown as TrackerWindow["clarity"];
        ms.v = "0.8.0";
        ms.calls = calls;
        (window as TrackerWindow).clarity = ms;
        const now = Date.now();
        document.cookie = `_clsk=ms1^${now}^1^1^https://www.clarity.ms/collect;path=/`;
        document.cookie = `_skhms=s1^${now}^1^1^https://evil.example/collect;path=/`;
    });
    await start(page, true);
    await expect.poll(() => payloads.length).toBeGreaterThan(0);
    await mutate(page, 2);
    expect(requests.filter(url => url !== upload)).toEqual([]);
    const ms = await page.evaluate(() => ({ calls: (window as TrackerWindow).clarity.calls.length, v: (window as TrackerWindow).clarity.v }));
    expect(ms).toEqual({ calls: 0, v: "0.8.0" });
});

for (const status of [429, 413]) {
    test(`a ${status} response stops the recorder for the page`, async ({ page }) => {
        const requests: string[] = [];
        const payloads: string[] = [];
        const errors: string[] = [];
        page.on("pageerror", e => errors.push(e.message));
        await open(page, () => status, requests, payloads);
        await start(page, false);
        await expect.poll(() => payloads.length).toBeGreaterThan(0);
        await page.waitForTimeout(500);
        const afterStop = payloads.length;
        await mutate(page, 4);
        expect(payloads.length).toBe(afterStop);
        expect(afterStop).toBeLessThanOrEqual(2);
        expect(errors).toEqual([]);
    });
}

test("other 4xx responses drop the sequence and keep recording", async ({ page }) => {
    const requests: string[] = [];
    const payloads: string[] = [];
    await open(page, () => 400, requests, payloads);
    await start(page, false);
    await expect.poll(() => payloads.length).toBeGreaterThan(0);
    const first = payloads.length;
    await mutate(page, 4);
    expect(payloads.length).toBeGreaterThan(first);
});
