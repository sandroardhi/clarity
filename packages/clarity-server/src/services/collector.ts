import { createHash } from "crypto";
import { decode } from "clarity-decode";
import type { DecodedPayload } from "clarity-decode/types/data";
import { IAnalyticsRepository } from "../db/repository";
import { DeviceType, IngestionResult, RawClickRecord, RawScrollRecord, PageSnapshot } from "../types";

// Data.Event.Discover in clarity-js
const EVENT_DISCOVER = 5;

export class CollectorService {
  constructor(private readonly repository: IAnalyticsRepository) {}

  /**
   * Process raw string telemetry payload sent by clarity-js
   */
  public async processPayload(
    rawPayload: string,
    originHeader?: string,
    userAgentHeader?: string
  ): Promise<IngestionResult> {
    if (!rawPayload || typeof rawPayload !== "string") {
      throw new Error("Invalid payload: payload must be a non-empty string");
    }

    // 1. Decode payload using clarity-decode
    const decoded = decode(rawPayload);
    const envelope = decoded.envelope;

    if (!envelope || !envelope.projectId) {
      throw new Error("Invalid payload: missing envelope or projectId");
    }

    const projectId = envelope.projectId;

    // 2. Only projects synced by the Skalpl backend accept data; unknown ids are dropped
    const project = await this.repository.getProject(projectId);
    if (!project || !project.isActive) {
      return { success: false, projectId, clicksCount: 0, scrollRecorded: false, snapshotSaved: false };
    }

    // Browsers always send Origin on these cross-site posts; a missing or unlisted origin is dropped.
    // An empty list allows nothing; "*" allows every origin.
    if (!project.allowedDomains.includes("*") && (!originHeader || !this.isOriginAllowed(originHeader, project.allowedDomains))) {
      return { success: false, projectId, clicksCount: 0, scrollRecorded: false, snapshotSaved: false };
    }

    const device = this.detectDevice(userAgentHeader);
    const pageUrl = this.normalizeUrl(envelope.url);
    const timestamp = decoded.timestamp || Date.now();

    let clicksCount = 0;
    let scrollRecorded = false;
    let snapshotSaved = false;

    // 3. Process Clicks
    if (decoded.click && decoded.click.length > 0) {
      const clickRecords: RawClickRecord[] = [];

      for (const clickEvent of decoded.click) {
        const c = clickEvent.data;
        const hash = c.hashBeta || c.hash || `hash_${(c.tag || "elem").toLowerCase()}_${c.id || c.target}`;

        let selector = "unknown";
        if (c.id) {
          selector = `#${c.id}`;
        } else if (c.tag && c.class) {
          selector = `${c.tag.toLowerCase()}.${c.class.trim().split(/\s+/)[0]}`;
        } else if (c.tag) {
          selector = c.tag.toLowerCase();
        }

        clickRecords.push({
          id: `${projectId}-${envelope.sessionId}-${clickEvent.time}-${c.target}`,
          projectId,
          pageUrl,
          device,
          hash,
          selector,
          eX: c.eX,
          eY: c.eY,
          timestamp
        });
      }

      if (clickRecords.length > 0) {
        await this.repository.saveRawClicks(clickRecords);
        clicksCount = clickRecords.length;
      }
    }

    // 4. Process Scroll depth; sequence 1 also counts sessions that never scroll
    const hasScroll = !!decoded.scroll && decoded.scroll.length > 0;
    const maxReachPercent = hasScroll || envelope.sequence === 1 ? this.scrollReachPercent(decoded) : null;
    if (maxReachPercent !== null) {
      const scrollRecord: RawScrollRecord = {
        id: `${projectId}-${envelope.sessionId}-${envelope.pageNum}`,
        projectId,
        pageUrl,
        device,
        sessionId: envelope.sessionId,
        maxScrollReachY: maxReachPercent,
        timestamp
      };

      await this.repository.saveRawScroll(scrollRecord);
      scrollRecorded = true;
    }

    // 5. Process Page Baseline DOM Snapshot (Discover Event)
    const hasDiscoverDom = decoded.dom && decoded.dom.some((d) => d.event === EVENT_DISCOVER);
    if (hasDiscoverDom) {
      // Hashed so long page URLs fit the dom_hash and id columns
      const domHash = createHash("sha1").update(`${pageUrl}|${device}|${envelope.version}`).digest("hex");
      const snapshot: PageSnapshot = {
        id: `${projectId}:${domHash}`,
        projectId,
        pageUrl,
        device,
        domHash,
        rawPayload,
        timestamp
      };

      await this.repository.savePageSnapshot(snapshot);
      snapshotSaved = true;
    }

    return {
      success: true,
      projectId,
      clicksCount,
      scrollRecorded,
      snapshotSaved
    };
  }

  // Deepest point seen, as (scrollY + viewport height) / document height in percent; null if the payload lacks sizes.
  // No scroll event means the visitor is still at the top.
  private scrollReachPercent(decoded: DecodedPayload): number | null {
    let docHeight = 0;
    let viewportHeight = 0;
    let maxScrollY = 0;

    for (const b of decoded.baseline || []) {
      if (b.data.docHeight > 0) docHeight = b.data.docHeight;
      if (b.data.screenHeight > 0) viewportHeight = b.data.screenHeight;
      maxScrollY = Math.max(maxScrollY, b.data.scrollY || 0);
    }
    for (const d of decoded.doc || []) {
      if (d.data.height > 0) docHeight = d.data.height;
    }
    for (const r of decoded.resize || []) {
      if (r.data.height > 0) viewportHeight = r.data.height;
    }
    for (const e of decoded.scroll || []) {
      if (typeof e.data.y === "number") maxScrollY = Math.max(maxScrollY, e.data.y);
    }

    if (docHeight <= 0 || viewportHeight <= 0) return null;
    return Math.min(100, Math.round(((maxScrollY + viewportHeight) / docHeight) * 100));
  }

  private isOriginAllowed(origin: string, allowedDomains: string[]): boolean {
    try {
      const parsed = new URL(origin.startsWith("http") ? origin : `https://${origin}`);
      const hostname = parsed.hostname.toLowerCase();

      return allowedDomains.some((pattern) => {
        const cleanPattern = pattern.toLowerCase().trim();
        if (cleanPattern === "*") return true;
        if (cleanPattern.startsWith("*.")) {
          const rootDomain = cleanPattern.slice(2);
          return hostname === rootDomain || hostname.endsWith(`.${rootDomain}`);
        }
        return hostname === cleanPattern;
      });
    } catch {
      return false;
    }
  }

  private detectDevice(userAgent?: string): DeviceType {
    if (!userAgent) return "desktop";
    const ua = userAgent.toLowerCase();
    if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua)) {
      return "mobile";
    }
    if (/ipad|tablet/i.test(ua)) {
      return "tablet";
    }
    return "desktop";
  }

  private normalizeUrl(url: string): string {
    if (!url) return "/";
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      // Return origin + pathname (stripping query strings & hashes for consistent heatmap aggregation)
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url.split("?")[0].split("#")[0];
    }
  }
}

