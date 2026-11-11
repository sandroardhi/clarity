import { decode } from "clarity-decode";
import { IAnalyticsRepository } from "../db/repository";
import { DeviceType, IngestionResult, RawClickRecord, RawScrollRecord, PageSnapshot } from "../types";

// Constant for Clarity Data.Event.Discover without importing browser-only clarity-js
const EVENT_DISCOVER = 4;

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

    // 2. Validate Multi-Tenant Project with JIT Auto-Provisioning
    let project = await this.repository.getProject(projectId);
    if (!project) {
      // Handshake was already authorized by Skalpl backend, auto-provision project on-the-fly
      project = {
        id: projectId,
        name: `Store ${projectId}`,
        allowedDomains: ["*"],
        isActive: true,
        createdAt: Date.now()
      };
      await this.repository.createProject(project);
    }

    if (!project.isActive) {
      // If manually suspended, silently ignore data
      return { success: false, projectId, clicksCount: 0, scrollRecorded: false, snapshotSaved: false };
    }

    if (originHeader && project.allowedDomains.length > 0 && !project.allowedDomains.includes("*")) {
      const allowed = this.isOriginAllowed(originHeader, project.allowedDomains);
      if (!allowed) {
        // Discard spam/unauthorized origin silently without throwing 4xx
        return { success: false, projectId, clicksCount: 0, scrollRecorded: false, snapshotSaved: false };
      }
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

    // 4. Process Scroll depth
    if (decoded.scroll && decoded.scroll.length > 0) {
      // Calculate max reach in percent (0..100)
      let maxReachPercent = 0;
      for (const scrollEvent of decoded.scroll) {
        // scroll event gives scrollY or relative reach
        const scrollData = scrollEvent.data;
        if (scrollData && typeof scrollData.y === "number") {
          // Approximate relative percentage reach
          maxReachPercent = Math.min(Math.max(scrollData.y, maxReachPercent), 100);
        }
      }

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
    // Check if payload contains the Discover DOM snapshot event (usually in sequence 1 or 2)
    const hasDiscoverDom = decoded.dom && decoded.dom.some((d) => d.event === EVENT_DISCOVER);
    if (hasDiscoverDom || envelope.sequence === 1) {
      // Store baseline snapshot for reconstructing page in visualizer.html()
      const domHash = `${pageUrl}_${device}_${envelope.version}`;
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

