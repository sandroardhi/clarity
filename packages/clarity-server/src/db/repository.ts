import {
  Project,
  RawClickRecord,
  RawScrollRecord,
  PageSnapshot,
  HeatmapQuery,
  Activity,
  ElementData,
  ScrollMapInfo,
  DeviceType
} from "../types";

export function parseSafeTimestamp(
  value: string | undefined,
  defaultVal: number,
  endOfDay: boolean = false
): number {
  if (!value || value === "all" || value === "now") return defaultVal;
  const timeStr = endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00Z`;
  const parsed = new Date(timeStr).getTime();
  return Number.isNaN(parsed) ? defaultVal : parsed;
}

export interface IAnalyticsRepository {
  // Project operations
  // Inserts unless the id exists; safe when two beacons race to provision the same project
  createProject(project: Project): Promise<void>;
  // Inserts, or updates name, allowedDomains and isActive; resolves true when a row was inserted
  upsertProject(project: Project): Promise<boolean>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // Click telemetry & Heatmap aggregation
  saveRawClicks(clicks: RawClickRecord[]): Promise<void>;
  getClickActivity(query: HeatmapQuery): Promise<Activity>;

  // Scroll telemetry & Heatmap aggregation
  saveRawScroll(scroll: RawScrollRecord): Promise<void>;
  getScrollMap(query: HeatmapQuery): Promise<{ scrollMap: ScrollMapInfo[]; totalSessions: number; avgFoldY: number }>;

  // Page DOM Snapshot operations
  savePageSnapshot(snapshot: PageSnapshot): Promise<void>;
  getPageSnapshot(projectId: string, pageUrl: string, device?: DeviceType): Promise<PageSnapshot | null>;
  listTrackedPages(projectId: string): Promise<{ pageUrl: string; totalClicks: number; lastActive: number }[]>;
  clearProjectData(projectId: string, pageUrl?: string): Promise<void>;
}

/**
 * In-Memory Analytics Repository
 * Zero external database dependency for immediate development, testing, and lightweight deployment.
 * Supports exact date-range filtering, element-relative grouping, and scroll distribution.
 */
export class MemoryAnalyticsRepository implements IAnalyticsRepository {
  private projects: Map<string, Project> = new Map();
  private rawClicks: RawClickRecord[] = [];
  private rawScrolls: RawScrollRecord[] = [];
  private snapshots: Map<string, PageSnapshot> = new Map(); // key: `${projectId}:${pageUrl}:${device}`

  public async createProject(project: Project): Promise<void> {
    if (!this.projects.has(project.id)) this.projects.set(project.id, { ...project });
  }

  public async upsertProject(project: Project): Promise<boolean> {
    const existing = this.projects.get(project.id);
    this.projects.set(project.id, existing
      ? { ...existing, name: project.name, allowedDomains: [...project.allowedDomains], isActive: project.isActive }
      : { ...project });
    return !existing;
  }

  public async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  public async listProjects(): Promise<Project[]> {
    return Array.from(this.projects.values());
  }

  public async saveRawClicks(clicks: RawClickRecord[]): Promise<void> {
    this.rawClicks.push(...clicks);
  }

  public async getClickActivity(query: HeatmapQuery): Promise<Activity> {
    const fromTimestamp = parseSafeTimestamp(query.from, 0, false);
    const toTimestamp = parseSafeTimestamp(query.to, Number.MAX_SAFE_INTEGER, true);
    const targetDevice = query.device;

    // Filter clicks
    const matched = this.rawClicks.filter((c) => {
      if (c.projectId !== query.projectId) return false;
      if (c.pageUrl !== query.pageUrl) return false;
      if (targetDevice && c.device !== targetDevice) return false;
      if (c.timestamp < fromTimestamp || c.timestamp > toTimestamp) return false;
      return true;
    });

    // Group by Element Hash -> Coordinates (eX, eY)
    // Map: hash -> { selector, totalclicks, pointsMap: Map<"eX:eY", count> }
    const elementMap = new Map<
      string,
      {
        selector: string;
        pointsMap: Map<string, { eX: number; eY: number; clicks: number }>;
      }
    >();

    for (const c of matched) {
      let elem = elementMap.get(c.hash);
      if (!elem) {
        elem = {
          selector: c.selector,
          pointsMap: new Map()
        };
        elementMap.set(c.hash, elem);
      }

      const coordKey = `${c.eX}:${c.eY}`;
      const point = elem.pointsMap.get(coordKey);
      if (point) {
        point.clicks += 1;
      } else {
        elem.pointsMap.set(coordKey, { eX: c.eX, eY: c.eY, clicks: 1 });
      }
    }

    // Convert grouped map into Activity format (ElementData[])
    const activity: Activity = [];

    for (const [hash, elem] of elementMap.entries()) {
      const xList: number[] = [];
      const yList: number[] = [];
      const clicksList: number[] = [];
      let totalClicks = 0;

      for (const p of elem.pointsMap.values()) {
        xList.push(p.eX);
        yList.push(p.eY);
        clicksList.push(p.clicks);
        totalClicks += p.clicks;
      }

      const elementData: ElementData = {
        hash,
        selector: elem.selector,
        totalclicks: totalClicks,
        points: xList.length,
        x: xList,
        y: yList,
        clicks: clicksList
      };

      activity.push(elementData);
    }

    return activity;
  }

  public async saveRawScroll(scroll: RawScrollRecord): Promise<void> {
    // Upsert or store max scroll reach for this session
    const existing = this.rawScrolls.find(
      (s) => s.projectId === scroll.projectId && s.pageUrl === scroll.pageUrl && s.sessionId === scroll.sessionId
    );
    if (existing) {
      if (scroll.maxScrollReachY > existing.maxScrollReachY) {
        existing.maxScrollReachY = scroll.maxScrollReachY;
        existing.timestamp = scroll.timestamp;
      }
    } else {
      this.rawScrolls.push(scroll);
    }
  }

  public async getScrollMap(
    query: HeatmapQuery
  ): Promise<{ scrollMap: ScrollMapInfo[]; totalSessions: number; avgFoldY: number }> {
    const fromTimestamp = parseSafeTimestamp(query.from, 0, false);
    const toTimestamp = parseSafeTimestamp(query.to, Number.MAX_SAFE_INTEGER, true);
    const targetDevice = query.device;

    const matched = this.rawScrolls.filter((s) => {
      if (s.projectId !== query.projectId) return false;
      if (s.pageUrl !== query.pageUrl) return false;
      if (targetDevice && s.device !== targetDevice) return false;
      if (s.timestamp < fromTimestamp || s.timestamp > toTimestamp) return false;
      return true;
    });

    const totalSessions = matched.length;
    if (totalSessions === 0) {
      return {
        scrollMap: [
          { scrollReachY: 0, cumulativeSum: 0, percUsers: 100 },
          { scrollReachY: 25, cumulativeSum: 0, percUsers: 0 },
          { scrollReachY: 50, cumulativeSum: 0, percUsers: 0 },
          { scrollReachY: 75, cumulativeSum: 0, percUsers: 0 },
          { scrollReachY: 100, cumulativeSum: 0, percUsers: 0 }
        ],
        totalSessions: 0,
        avgFoldY: 600
      };
    }

    // Standard breakpoints: 0%, 25%, 50%, 75%, 100%
    const milestones = [0, 25, 50, 75, 100];
    const scrollMap: ScrollMapInfo[] = milestones.map((reach) => {
      const reachedCount = matched.filter((s) => s.maxScrollReachY >= reach).length;
      const percUsers = Math.round((reachedCount / totalSessions) * 100);
      return {
        scrollReachY: reach,
        cumulativeSum: reachedCount,
        percUsers
      };
    });

    return {
      scrollMap,
      totalSessions,
      avgFoldY: 768 // default average fold height
    };
  }

  public async savePageSnapshot(snapshot: PageSnapshot): Promise<void> {
    const key = `${snapshot.projectId}:${snapshot.pageUrl}:${snapshot.device}`;
    this.snapshots.set(key, snapshot);
  }

  public async getPageSnapshot(projectId: string, pageUrl: string, device: DeviceType = "desktop"): Promise<PageSnapshot | null> {
    const key = `${projectId}:${pageUrl}:${device}`;
    return this.snapshots.get(key) ?? null;
  }

  public async listTrackedPages(projectId: string): Promise<{ pageUrl: string; totalClicks: number; lastActive: number }[]> {
    const pageStats = new Map<string, { totalClicks: number; lastActive: number }>();

    for (const c of this.rawClicks) {
      if (c.projectId !== projectId) continue;
      const existing = pageStats.get(c.pageUrl) || { totalClicks: 0, lastActive: 0 };
      existing.totalClicks += 1;
      if (c.timestamp > existing.lastActive) {
        existing.lastActive = c.timestamp;
      }
      pageStats.set(c.pageUrl, existing);
    }

    return Array.from(pageStats.entries()).map(([pageUrl, stats]) => ({
      pageUrl,
      totalClicks: stats.totalClicks,
      lastActive: stats.lastActive
    }));
  }

  public async clearProjectData(projectId: string, pageUrl?: string): Promise<void> {
    this.rawClicks = this.rawClicks.filter(
      (c) => !(c.projectId === projectId && (!pageUrl || c.pageUrl === pageUrl))
    );
    this.rawScrolls = this.rawScrolls.filter(
      (s) => !(s.projectId === projectId && (!pageUrl || s.pageUrl === pageUrl))
    );
  }
}

