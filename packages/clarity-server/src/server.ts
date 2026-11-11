import express, { Express, Request, Response } from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { IAnalyticsRepository } from "./db/repository";
import { registerDemo } from "./demo";
import { PgAnalyticsRepository } from "./db/postgres";
import { CollectorService } from "./services/collector";
import { DropCounter } from "./services/drops";
import { canonicalPageKey, isExcluded } from "./services/pageKey";
import { BadRequestError, parseTimeRange, TimeRange } from "./services/timeRange";
import {
  DeviceType,
  HeatmapClickResponse,
  HeatmapQuery,
  HeatmapScrollResponse,
  PageIndexRow,
  PageSnapshotResponse,
  Project,
  TrackedPage
} from "./types";

const DEVICES: DeviceType[] = ["desktop", "mobile", "tablet"];

interface PageQuery {
  projectId: string;
  pageKey: string;
  device?: DeviceType;
  range: TimeRange;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((d) => typeof d === "string");
}

// Folds the per-device index rows into one entry per page key, newest first
export function trackedPages(rows: PageIndexRow[], excludePatterns: string[]): TrackedPage[] {
  const pages = new Map<string, TrackedPage & { urlSeen: number }>();
  for (const r of rows) {
    let page = pages.get(r.pageKey);
    if (!page) {
      page = {
        pageKey: r.pageKey, pageUrl: r.lastUrl, firstSeen: r.firstSeen, lastSeen: r.lastSeen, views: 0, clicks: 0,
        excluded: isExcluded(r.pageKey, excludePatterns), devices: {}, urlSeen: r.lastSeen
      };
      pages.set(r.pageKey, page);
    }
    if (r.lastSeen > page.urlSeen) {
      page.pageUrl = r.lastUrl;
      page.urlSeen = r.lastSeen;
    }
    page.firstSeen = Math.min(page.firstSeen, r.firstSeen);
    page.lastSeen = Math.max(page.lastSeen, r.lastSeen);
    page.views += r.views;
    page.clicks += r.clicks;
    page.devices[r.device] = { views: r.views, clicks: r.clicks, lastSeen: r.lastSeen };
  }
  return Array.from(pages.values())
    .map(({ urlSeen, ...page }) => page)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

const gunzipAsync = promisify(zlib.gunzip);

export interface ServerOptions {
  repository?: IAnalyticsRepository;
  port?: number;
  host?: string;
  trackerPath?: string;
  internalSecret?: string;
  drops?: DropCounter;
}

export function createRepository(): IAnalyticsRepository {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  return new PgAnalyticsRepository(process.env.DATABASE_URL);
}

export function createServer(options: ServerOptions = {}): Express {
  const internalSecret = options.internalSecret ?? process.env.CLARITY_INTERNAL_SECRET ?? "";
  if (!internalSecret) {
    throw new Error("CLARITY_INTERNAL_SECRET is required");
  }
  const repository: IAnalyticsRepository = options.repository || createRepository();
  const collector = new CollectorService(repository);
  const drops = options.drops || new DropCounter(repository);
  const trackerScriptPath =
    options.trackerPath ||
    path.resolve(__dirname, "../../clarity-js/build/clarity.min.js");

  const app = express();

  // Enable CORS for telemetry ingestion from client domains
  app.use(
    cors({
      origin: true,
      credentials: true, // Allow all origins for telemetry beacons; origin security enforced via project allowedDomains
      methods: ["GET", "POST", "PUT", "OPTIONS"]
    })
  );

  // Support raw binary / gzip payloads (clarity-js browser XHR upload), JSON objects, and text (sendBeacon)
  app.use("/api/v1/collect", express.raw({ type: () => true, limit: "10mb" }));
  app.use(express.json({ limit: "10mb" }));
  app.use(
    express.text({
      type: ["text/plain", "application/x-www-form-urlencoded"],
      limit: "10mb"
    })
  );

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await repository.ping();
      res.status(200).json({ status: "healthy", db: "ok" });
    } catch {
      res.status(503).json({ status: "unhealthy", db: "error" });
    }
  });

  const internalAuthMiddleware = (req: Request, res: Response, next: () => void) => {
    const headerSecret = (req.headers["x-internal-secret"] || req.headers["x-clarity-secret"]) as string | undefined;
    if (!secretMatches(headerSecret, internalSecret)) {
      res.status(401).json({ error: "Unauthorized: Invalid internal secret" });
      return;
    }
    next();
  };

  app.use("/api/v1/heatmaps", internalAuthMiddleware);
  app.use("/api/v1/projects", internalAuthMiddleware);
  app.use("/api/v1/drops", internalAuthMiddleware);

  // ----------------------------------------------------
  // 2. Ingestion Route (Telemetry Collector)
  // ----------------------------------------------------
  app.post("/api/v1/collect", async (req: Request, res: Response) => {
    const receivedAt = Date.now();
    try {
      let rawPayload = "";
      if (Buffer.isBuffer(req.body)) {
        if (req.body.length >= 2 && req.body[0] === 0x1f && req.body[1] === 0x8b) {
          try {
            // The output cap stops zip bombs
            const decompressed = await gunzipAsync(req.body, { maxOutputLength: 10 * 1024 * 1024 });
            rawPayload = decompressed.toString("utf-8");
          } catch {
            drops.record(null, "gunzip", receivedAt);
            return;
          }
        } else {
          rawPayload = req.body.toString("utf-8");
        }
      } else if (typeof req.body === "string") {
        rawPayload = req.body;
      } else if (req.body && typeof req.body === "object") {
        rawPayload = JSON.stringify(req.body);
      }

      if (rawPayload && rawPayload.trim().length > 0) {
        const origin = (req.headers["origin"] || req.headers["referer"]) as string | undefined;
        const userAgent = req.headers["user-agent"] as string | undefined;

        const result = await collector.processPayload(rawPayload, origin, userAgent, receivedAt);
        if (result.dropped) drops.record(result.projectId, result.dropped, receivedAt);
      }
    } catch (error: any) {
      // Log warning on server, but never return 4xx to prevent client clarity-js from terminating
      console.warn(`[Clarity Collector] Ingestion skipped: ${error.message || "Unknown error"}`);
    } finally {
      // Always return 204 No Content per analytics beacon standard
      res.status(204).end();
    }
  });

  // ----------------------------------------------------
  // 3. Heatmap Query Routes (For Skalpl Dashboard)
  // ----------------------------------------------------

  // Sends 400 or 404 and resolves null when the query is unusable
  const pageQuery = async (req: Request, res: Response, withRange: boolean): Promise<PageQuery | null> => {
    const { projectId, pageKey, pageUrl, device, from, to, tz } = req.query as Record<string, string | undefined>;
    const key = canonicalPageKey(pageKey || pageUrl);
    if (!projectId || !key) {
      res.status(400).json({ error: "Missing required query parameters: projectId, pageKey (or pageUrl)" });
      return null;
    }
    if (device !== undefined && !DEVICES.includes(device as DeviceType)) {
      res.status(400).json({ error: `device must be one of ${DEVICES.join(", ")}` });
      return null;
    }
    let range: TimeRange = { from: null, to: null };
    if (withRange) {
      try {
        range = parseTimeRange(from, to, tz);
      } catch (error) {
        if (!(error instanceof BadRequestError)) throw error;
        res.status(400).json({ error: error.message });
        return null;
      }
    }
    if (!(await repository.getProject(projectId))) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return null;
    }
    return { projectId, pageKey: key, device: device as DeviceType | undefined, range };
  };

  const heatmapQuery = (q: PageQuery): HeatmapQuery => ({ projectId: q.projectId, pageUrl: q.pageKey, device: q.device, ...q.range });

  app.get("/api/v1/heatmaps/click", async (req: Request, res: Response) => {
    const q = await pageQuery(req, res, true);
    if (!q) return;
    const activity = await repository.getClickActivity(heatmapQuery(q));
    const response: HeatmapClickResponse = {
      projectId: q.projectId,
      pageKey: q.pageKey,
      device: q.device || null,
      from: q.range.from,
      to: q.range.to,
      totalClicks: activity.reduce((sum, item) => sum + item.totalclicks, 0),
      activity
    };
    res.status(200).json(response);
  });

  app.get("/api/v1/heatmaps/scroll", async (req: Request, res: Response) => {
    const q = await pageQuery(req, res, true);
    if (!q) return;
    const { scrollMap, totalSessions, avgFoldY } = await repository.getScrollMap(heatmapQuery(q));
    const response: HeatmapScrollResponse = {
      projectId: q.projectId,
      pageKey: q.pageKey,
      device: q.device || null,
      from: q.range.from,
      to: q.range.to,
      totalSessions,
      scrollMap,
      averageFoldY: avgFoldY
    };
    res.status(200).json(response);
  });

  // DOM snapshot for visualizer.html(); without a device, the latest across devices
  app.get("/api/v1/heatmaps/snapshot", async (req: Request, res: Response) => {
    const q = await pageQuery(req, res, false);
    if (!q) return;
    const snapshot = await repository.getPageSnapshot(q.projectId, q.pageKey, q.device);
    if (!snapshot) {
      res.status(404).json({ error: "Page snapshot not found for this page and device" });
      return;
    }
    const response: PageSnapshotResponse = {
      projectId: snapshot.projectId,
      pageKey: snapshot.pageUrl,
      device: snapshot.device,
      domHash: snapshot.domHash,
      payload: snapshot.rawPayload
    };
    res.status(200).json(response);
  });

  app.get("/api/v1/projects/:projectId/pages", async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId);
    const project = await repository.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    const pages = trackedPages(await repository.listPageIndex(projectId), project.excludePatterns);
    res.status(200).json({ projectId, pages });
  });

  // Drops not tied to a project (gunzip failures, undecodable payloads)
  app.get("/api/v1/drops", async (_req: Request, res: Response) => {
    const all = await drops.read("");
    res.status(200).json({ drops: all[""] || {} });
  });

  // ----------------------------------------------------
  // 4. Multi-Tenant Project Management Routes
  // ----------------------------------------------------
  // Create or update. Omitted fields keep their stored values. A version lower than the stored one is stale: 409.
  // 201 created, 200 updated, 400 invalid body, 401 bad secret.
  const upsertProject = async (req: Request, res: Response, pathId?: string): Promise<void> => {
    let body = req.body as Record<string, unknown> | undefined;
    if (typeof req.body === "string") {
      try {
        body = JSON.parse(req.body);
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
    }
    body = body && typeof body === "object" ? body : {};
    const { name, allowedDomains, excludePatterns, isActive, version } = body;
    const id = pathId || body.id;

    if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
      res.status(400).json({ error: "Missing required fields: id, name" });
      return;
    }
    if (pathId && body.id !== undefined && body.id !== pathId) {
      res.status(400).json({ error: "Body id does not match path id" });
      return;
    }
    if (allowedDomains !== undefined && !stringArray(allowedDomains)) {
      res.status(400).json({ error: "allowedDomains must be an array of strings" });
      return;
    }
    if (excludePatterns !== undefined && !stringArray(excludePatterns)) {
      res.status(400).json({ error: "excludePatterns must be an array of strings" });
      return;
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    if (version !== undefined && version !== null && !(Number.isSafeInteger(version) && (version as number) >= 0)) {
      res.status(400).json({ error: "version must be a non-negative integer (unix ms)" });
      return;
    }

    const existing = await repository.getProject(id);
    const project: Project = {
      id,
      name,
      allowedDomains: allowedDomains ?? existing?.allowedDomains ?? [],
      excludePatterns: excludePatterns ?? existing?.excludePatterns ?? [],
      isActive: isActive ?? existing?.isActive ?? true,
      version: (version as number | null | undefined) ?? null,
      createdAt: existing ? existing.createdAt : Date.now()
    };

    const result = await repository.upsertProject(project);
    if (result === "stale") {
      const stored = await repository.getProject(id);
      res.status(409).json({ error: "stale_version", storedVersion: stored ? stored.version : null });
      return;
    }
    const saved = (await repository.getProject(id)) || project;
    res.status(result === "created" ? 201 : 200).json({ success: true, project: saved });
  };

  app.post("/api/v1/projects", (req: Request, res: Response) => upsertProject(req, res));
  app.put("/api/v1/projects/:projectId", (req: Request, res: Response) => upsertProject(req, res, String(req.params.projectId)));

  app.get("/api/v1/projects/:projectId", async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId);
    const [project, counts] = await Promise.all([repository.getProject(projectId), drops.read(projectId)]);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found`, drops: counts[projectId] || {} });
      return;
    }
    res.status(200).json({ project, drops: counts[projectId] || {} });
  });

  // ----------------------------------------------------
  // 5. Serve SDK & Visualize Bundles (Whitelabel Delivery)
  // ----------------------------------------------------
  const visualizeScriptPath = path.resolve(__dirname, "../../clarity-visualize/build/clarity.visualize.min.js");
  let cachedTracker: string | null = null;
  let cachedVisualize: string | null = null;

  app.get("/tracker.js", (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production" && cachedTracker) {
      res
        .setHeader("Content-Type", "application/javascript; charset=utf-8")
        .setHeader("Cache-Control", "public, max-age=3600")
        .status(200)
        .send(cachedTracker);
      return;
    }

    if (fs.existsSync(trackerScriptPath)) {
      const scriptContent = fs.readFileSync(trackerScriptPath, "utf-8");
      if (process.env.NODE_ENV === "production") cachedTracker = scriptContent;
      res
        .setHeader("Content-Type", "application/javascript; charset=utf-8")
        .setHeader("Cache-Control", process.env.NODE_ENV === "production" ? "public, max-age=3600" : "no-cache, must-revalidate")
        .status(200)
        .send(scriptContent);
    } else {
      res.status(404).send("// Clarity tracker bundle not found on server.");
    }
  });

  app.get("/visualize.js", (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production" && cachedVisualize) {
      res
        .setHeader("Content-Type", "application/javascript; charset=utf-8")
        .setHeader("Cache-Control", "public, max-age=3600")
        .status(200)
        .send(cachedVisualize);
      return;
    }

    if (fs.existsSync(visualizeScriptPath)) {
      const scriptContent = fs.readFileSync(visualizeScriptPath, "utf-8");
      if (process.env.NODE_ENV === "production") cachedVisualize = scriptContent;
      res
        .setHeader("Content-Type", "application/javascript; charset=utf-8")
        .setHeader("Cache-Control", process.env.NODE_ENV === "production" ? "public, max-age=3600" : "no-cache, must-revalidate")
        .status(200)
        .send(scriptContent);
    } else {
      res.status(404).send("// Clarity visualize bundle not found on server.");
    }
  });

  registerDemo(app, repository);

  return app;
}

function secretMatches(given: string | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
