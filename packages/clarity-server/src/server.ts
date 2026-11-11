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
import {
  CreateProjectInput,
  DeviceType,
  HeatmapClickResponse,
  HeatmapQuery,
  HeatmapScrollResponse,
  PageSnapshotResponse,
  Project
} from "./types";

const gunzipAsync = promisify(zlib.gunzip);

export interface ServerOptions {
  repository?: IAnalyticsRepository;
  port?: number;
  host?: string;
  trackerPath?: string;
  internalSecret?: string;
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

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "healthy", timestamp: Date.now() });
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

  // ----------------------------------------------------
  // 2. Ingestion Route (Telemetry Collector)
  // ----------------------------------------------------
  app.post("/api/v1/collect", async (req: Request, res: Response) => {
    try {
      let rawPayload = "";
      if (Buffer.isBuffer(req.body)) {
        // Automatically decompress gzip payloads sent by clarity-js
        if (req.body.length >= 2 && req.body[0] === 0x1f && req.body[1] === 0x8b) {
          try {
            // Asynchronously decompress with a strict 10MB maximum output length to prevent zip-bomb DoS
            const decompressed = await gunzipAsync(req.body, { maxOutputLength: 10 * 1024 * 1024 });
            rawPayload = decompressed.toString("utf-8");
          } catch {
            rawPayload = req.body.toString("utf-8");
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

        await collector.processPayload(rawPayload, origin, userAgent);
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

  // Click Heatmap
  app.get("/api/v1/heatmaps/click", async (req: Request, res: Response) => {
    const { projectId, pageUrl, device, from, to } = req.query as Record<string, string | undefined>;

    if (!projectId || !pageUrl) {
      res.status(400).json({ error: "Missing required query parameters: projectId, pageUrl" });
      return;
    }

    const query: HeatmapQuery = {
      projectId,
      pageUrl,
      device: device as DeviceType | undefined,
      from,
      to
    };

    const activity = await repository.getClickActivity(query);
    const totalClicks = activity.reduce((sum, item) => sum + item.totalclicks, 0);

    const response: HeatmapClickResponse = {
      projectId,
      pageUrl,
      device: (device as DeviceType) || "desktop",
      from: from || "all",
      to: to || "now",
      totalClicks,
      activity
    };

    res.status(200).json(response);
  });

  // Scroll Heatmap
  app.get("/api/v1/heatmaps/scroll", async (req: Request, res: Response) => {
    const { projectId, pageUrl, device, from, to } = req.query as Record<string, string | undefined>;

    if (!projectId || !pageUrl) {
      res.status(400).json({ error: "Missing required query parameters: projectId, pageUrl" });
      return;
    }

    const query: HeatmapQuery = {
      projectId,
      pageUrl,
      device: device as DeviceType | undefined,
      from,
      to
    };

    const { scrollMap, totalSessions, avgFoldY } = await repository.getScrollMap(query);

    const response: HeatmapScrollResponse = {
      projectId,
      pageUrl,
      device: (device as DeviceType) || "desktop",
      from: from || "all",
      to: to || "now",
      totalSessions,
      scrollMap,
      averageFoldY: avgFoldY
    };

    res.status(200).json(response);
  });

  // Page DOM Snapshot for visualizer.html()
  app.get("/api/v1/heatmaps/snapshot", async (req: Request, res: Response) => {
    const { projectId, pageUrl, device } = req.query as Record<string, string | undefined>;

    if (!projectId || !pageUrl) {
      res.status(400).json({ error: "Missing required query parameters: projectId, pageUrl" });
      return;
    }

    const snapshot = await repository.getPageSnapshot(projectId, pageUrl, (device as DeviceType) || "desktop");
    if (!snapshot) {
      res.status(404).json({ error: "Page snapshot not found for this URL and device" });
      return;
    }

    const response: PageSnapshotResponse = {
      projectId: snapshot.projectId,
      pageUrl: snapshot.pageUrl,
      device: snapshot.device,
      domHash: snapshot.domHash,
      payload: snapshot.rawPayload
    };

    res.status(200).json(response);
  });

  // List Tracked Pages for a Project
  app.get("/api/v1/projects/:projectId/pages", async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId);
    const pages = await repository.listTrackedPages(projectId);
    res.status(200).json({ projectId, pages });
  });

  // ----------------------------------------------------
  // 4. Multi-Tenant Project Management Routes
  // ----------------------------------------------------
  // Create or update. The backend re-syncs domains and the heatmap toggle on every change.
  // 201 created, 200 updated, 400 invalid body, 401 bad secret.
  const upsertProject = async (req: Request, res: Response, pathId?: string): Promise<void> => {
    let body = req.body as Partial<CreateProjectInput> & { isActive?: unknown };
    if (typeof req.body === "string") {
      try {
        body = JSON.parse(req.body);
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
    }
    const { name, allowedDomains, isActive } = body || {};
    const id = pathId || (body || {}).id;

    if (!id || !name) {
      res.status(400).json({ error: "Missing required fields: id, name" });
      return;
    }
    if (pathId && body && body.id !== undefined && body.id !== pathId) {
      res.status(400).json({ error: "Body id does not match path id" });
      return;
    }
    if (allowedDomains !== undefined && (!Array.isArray(allowedDomains) || allowedDomains.some((d) => typeof d !== "string"))) {
      res.status(400).json({ error: "allowedDomains must be an array of strings" });
      return;
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }

    const existing = await repository.getProject(id);
    const project: Project = {
      id,
      name,
      allowedDomains: allowedDomains || (existing ? existing.allowedDomains : []),
      isActive: isActive !== undefined ? isActive : existing ? existing.isActive : true,
      createdAt: existing ? existing.createdAt : Date.now()
    };

    const created = await repository.upsertProject(project);
    res.status(created ? 201 : 200).json({ success: true, project });
  };

  app.post("/api/v1/projects", (req: Request, res: Response) => upsertProject(req, res));
  app.put("/api/v1/projects/:projectId", (req: Request, res: Response) => upsertProject(req, res, String(req.params.projectId)));

  app.get("/api/v1/projects/:projectId", async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId);
    const project = await repository.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    res.status(200).json({ project });
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
