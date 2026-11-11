import { createHash } from "crypto";
import { decode } from "clarity-decode";
import type { DecodedPayload } from "clarity-decode/types/data";
import { IAnalyticsRepository } from "../db/repository";
import { canonicalPageKey, isExcluded, snapshotId } from "./pageKey";
import { DeviceType, DropReason, IngestionResult, RawClickRecord, RawScrollRecord, PageSnapshot } from "../types";

// Data.Event.Discover in clarity-js
const EVENT_DISCOVER = 5;

const MOBILE_MAX_WIDTH = 767;
const TABLET_MAX_WIDTH = 1023;

interface Viewport {
  width: number;
  height: number;
}

export function deviceForWidth(width: number): DeviceType {
  if (width <= MOBILE_MAX_WIDTH) return "mobile";
  if (width <= TABLET_MAX_WIDTH) return "tablet";
  return "desktop";
}

function dropped(projectId: string, reason: DropReason): IngestionResult {
  return { success: false, projectId, clicksCount: 0, scrollRecorded: false, snapshotSaved: false, dropped: reason };
}

export class CollectorService {
  constructor(private readonly repository: IAnalyticsRepository) {}

  // Drops come back as `dropped` with a reason; only repository failures throw
  public async processPayload(
    rawPayload: string,
    originHeader?: string,
    userAgentHeader?: string,
    receivedAt: number = Date.now()
  ): Promise<IngestionResult> {
    if (!rawPayload || typeof rawPayload !== "string") return dropped("", "invalid");

    let decoded: DecodedPayload;
    try {
      decoded = decode(rawPayload);
    } catch {
      return dropped("", "invalid");
    }
    const envelope = decoded.envelope;
    if (!envelope || !envelope.projectId) return dropped("", "invalid");

    const projectId = envelope.projectId;

    // Only projects synced by the Skalpl backend accept data
    const project = await this.repository.getProject(projectId);
    if (!project) return dropped(projectId, "unknown");
    if (!project.isActive) return dropped(projectId, "inactive");

    // Browsers always send Origin on these cross-site posts; a missing or unlisted origin is dropped.
    // An empty list allows nothing; "*" allows every origin.
    if (!project.allowedDomains.includes("*") && (!originHeader || !this.isOriginAllowed(originHeader, project.allowedDomains))) {
      return dropped(projectId, "origin");
    }

    const pageKey = canonicalPageKey(envelope.url);
    if (!pageKey) return dropped(projectId, "invalid");
    if (isExcluded(pageKey, project.excludePatterns || [])) return dropped(projectId, "excluded");

    const scrollId = `${projectId}-${envelope.sessionId}-${envelope.pageNum}`;
    const viewport = this.viewport(decoded);
    const device = viewport.width > 0
      ? deviceForWidth(viewport.width)
      : (await this.repository.getViewDevice(scrollId)) || this.detectDevice(userAgentHeader);
    const timestamp = receivedAt;
    const clientTime = decoded.timestamp || null;

    let clicksCount = 0;
    let scrollRecorded = false;
    let snapshotSaved = false;

    if (decoded.click && decoded.click.length > 0) {
      const clickRecords: RawClickRecord[] = decoded.click.map((clickEvent) => {
        const c = clickEvent.data;
        let selector = "unknown";
        if (c.id) {
          selector = `#${c.id}`;
        } else if (c.tag && c.class) {
          selector = `${c.tag.toLowerCase()}.${c.class.trim().split(/\s+/)[0]}`;
        } else if (c.tag) {
          selector = c.tag.toLowerCase();
        }
        return {
          id: `${projectId}-${envelope.sessionId}-${clickEvent.time}-${c.target}`,
          projectId,
          pageUrl: pageKey,
          device,
          hash: c.hashBeta || c.hash || `hash_${(c.tag || "elem").toLowerCase()}_${c.id || c.target}`,
          selector,
          eX: c.eX,
          eY: c.eY,
          timestamp,
          clientTime
        };
      });
      await this.repository.saveRawClicks(clickRecords);
      clicksCount = clickRecords.length;
    }

    // Sequence 1 also counts sessions that never scroll
    const hasScroll = !!decoded.scroll && decoded.scroll.length > 0;
    const maxReachPercent = hasScroll || envelope.sequence === 1 ? this.scrollReachPercent(decoded, viewport.height) : null;
    if (maxReachPercent !== null) {
      const scrollRecord: RawScrollRecord = {
        id: scrollId,
        projectId,
        pageUrl: pageKey,
        device,
        sessionId: envelope.sessionId,
        maxScrollReachY: maxReachPercent,
        viewportHeight: viewport.height > 0 ? viewport.height : null,
        timestamp,
        clientTime
      };
      await this.repository.saveRawScroll(scrollRecord);
      scrollRecorded = true;
    }

    const discover = (decoded.dom || []).filter((d) => d.event === EVENT_DISCOVER).map((d) => d.data);
    if (discover.length > 0) {
      // domHash covers the Discover DOM only, so repeat views of an unchanged page skip the write
      const domHash = createHash("sha1").update(`${envelope.version}|${JSON.stringify(discover)}`).digest("hex");
      const snapshot: PageSnapshot = {
        id: snapshotId(projectId, pageKey, device),
        projectId,
        pageUrl: pageKey,
        device,
        domHash,
        rawPayload,
        timestamp
      };
      snapshotSaved = await this.repository.savePageSnapshot(snapshot);
    }

    await this.repository.recordPageActivity({
      projectId,
      pageKey,
      device,
      url: this.displayUrl(envelope.url),
      at: timestamp,
      views: envelope.sequence === 1 ? 1 : 0,
      clicks: clicksCount
    });

    return { success: true, projectId, clicksCount, scrollRecorded, snapshotSaved };
  }

  // Last viewport size in the payload, in CSS px; 0 when absent
  private viewport(decoded: DecodedPayload): Viewport {
    const size: Viewport = { width: 0, height: 0 };
    for (const b of decoded.baseline || []) {
      if (b.data.screenWidth > 0) size.width = b.data.screenWidth;
      if (b.data.screenHeight > 0) size.height = b.data.screenHeight;
    }
    for (const r of decoded.resize || []) {
      if (r.data.width > 0) size.width = r.data.width;
      if (r.data.height > 0) size.height = r.data.height;
    }
    return size;
  }

  // Deepest point seen, as (scrollY + viewport height) / document height in percent; null if the payload lacks sizes.
  // No scroll event means the visitor is still at the top.
  private scrollReachPercent(decoded: DecodedPayload, viewportHeight: number): number | null {
    let docHeight = 0;
    let maxScrollY = 0;
    for (const b of decoded.baseline || []) {
      if (b.data.docHeight > 0) docHeight = b.data.docHeight;
      maxScrollY = Math.max(maxScrollY, b.data.scrollY || 0);
    }
    for (const d of decoded.doc || []) {
      if (d.data.height > 0) docHeight = d.data.height;
    }
    for (const e of decoded.scroll || []) {
      if (typeof e.data.y === "number") maxScrollY = Math.max(maxScrollY, e.data.y);
    }
    if (docHeight <= 0 || viewportHeight <= 0) return null;
    return Math.min(100, Math.round(((maxScrollY + viewportHeight) / docHeight) * 100));
  }

  private displayUrl(url: string): string {
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url.split("?")[0].split("#")[0];
    }
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
    if (/ipad|tablet/i.test(userAgent)) return "tablet";
    if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(userAgent)) return "mobile";
    return "desktop";
  }
}
