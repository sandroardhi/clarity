import {
  Project,
  RawClickRecord,
  RawScrollRecord,
  PageSnapshot,
  HeatmapQuery,
  Activity,
  ElementData,
  ScrollMapInfo,
  DeviceType,
  DropCounts,
  DropEntry,
  PageIndexRow
} from "../types";

export type UpsertResult = "created" | "updated" | "stale";

export interface ScrollMapResult {
  scrollMap: ScrollMapInfo[];
  totalSessions: number;
  // Mean viewport height in px; null when no session reported one
  avgFoldY: number | null;
}

export interface PageActivity {
  projectId: string;
  pageKey: string;
  device: DeviceType;
  url: string;
  at: number;
  views: number;
  clicks: number;
}

const MILESTONES = [0, 25, 50, 75, 100];

export function buildScrollMap(reaches: number[]): ScrollMapInfo[] {
  if (reaches.length === 0) return [];
  return MILESTONES.map((reach) => {
    const count = reaches.filter((r) => r >= reach).length;
    return { scrollReachY: reach, cumulativeSum: count, percUsers: Math.round((count / reaches.length) * 100) };
  });
}

function inRange(timestamp: number, query: HeatmapQuery): boolean {
  return (query.from == null || timestamp >= query.from) && (query.to == null || timestamp < query.to);
}

// All page fields are canonical page keys; callers canonicalize first.
export interface IAnalyticsRepository {
  // Inserts unless the id exists
  createProject(project: Project): Promise<void>;
  // "stale" when project.version is lower than the stored version; nothing is written then
  upsertProject(project: Project): Promise<UpsertResult>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  saveRawClicks(clicks: RawClickRecord[]): Promise<void>;
  getClickActivity(query: HeatmapQuery): Promise<Activity>;

  // One row per page view (id); keeps the deepest reach
  saveRawScroll(scroll: RawScrollRecord): Promise<void>;
  getScrollMap(query: HeatmapQuery): Promise<ScrollMapResult>;
  // Device stored for a page view's scroll row, for beacons that carry no viewport size
  getViewDevice(scrollId: string): Promise<DeviceType | null>;

  // Writes only when no snapshot exists or its domHash differs; resolves true when a row was written
  savePageSnapshot(snapshot: PageSnapshot): Promise<boolean>;
  // Without a device, the latest snapshot across devices
  getPageSnapshot(projectId: string, pageKey: string, device?: DeviceType): Promise<PageSnapshot | null>;

  recordPageActivity(activity: PageActivity): Promise<void>;
  listPageIndex(projectId: string): Promise<PageIndexRow[]>;

  addDrops(entries: DropEntry[]): Promise<void>;
  // Keyed by project id; "" holds drops not tied to a project. Without projectId, every project.
  getDrops(projectId?: string): Promise<Record<string, DropCounts>>;

  clearProjectData(projectId: string, pageKey?: string): Promise<void>;
  // Deletes raw clicks and scrolls with a timestamp before cutoff (epoch ms)
  deleteOlderThan(cutoff: number): Promise<{ clicks: number; scrolls: number }>;
  // Throws when the store is unreachable
  ping(): Promise<void>;
}

// In-memory store for tests and the local demo.
export class MemoryAnalyticsRepository implements IAnalyticsRepository {
  private projects: Map<string, Project> = new Map();
  private rawClicks: RawClickRecord[] = [];
  private rawScrolls: RawScrollRecord[] = [];
  private snapshots: Map<string, PageSnapshot> = new Map();
  private pageIndex: Map<string, PageIndexRow> = new Map();
  private drops: Map<string, DropEntry> = new Map();

  public async createProject(project: Project): Promise<void> {
    if (!this.projects.has(project.id)) this.projects.set(project.id, { ...project });
  }

  public async upsertProject(project: Project): Promise<UpsertResult> {
    const existing = this.projects.get(project.id);
    if (existing && existing.version !== null && project.version !== null && project.version < existing.version) {
      return "stale";
    }
    this.projects.set(project.id, existing
      ? { ...project, createdAt: existing.createdAt, version: project.version ?? existing.version }
      : { ...project });
    return existing ? "updated" : "created";
  }

  public async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  public async listProjects(): Promise<Project[]> {
    return Array.from(this.projects.values());
  }

  public async saveRawClicks(clicks: RawClickRecord[]): Promise<void> {
    for (const c of clicks) {
      if (!this.rawClicks.some((r) => r.id === c.id)) this.rawClicks.push(c);
    }
  }

  public async getClickActivity(query: HeatmapQuery): Promise<Activity> {
    const matched = this.rawClicks.filter((c) =>
      c.projectId === query.projectId && c.pageUrl === query.pageUrl &&
      (!query.device || c.device === query.device) && inRange(c.timestamp, query));

    const elementMap = new Map<string, { selector: string; points: Map<string, { eX: number; eY: number; clicks: number }> }>();
    for (const c of matched) {
      let elem = elementMap.get(c.hash);
      if (!elem) {
        elem = { selector: c.selector, points: new Map() };
        elementMap.set(c.hash, elem);
      }
      const coordKey = `${c.eX}:${c.eY}`;
      const point = elem.points.get(coordKey);
      if (point) point.clicks += 1;
      else elem.points.set(coordKey, { eX: c.eX, eY: c.eY, clicks: 1 });
    }

    const activity: Activity = [];
    for (const [hash, elem] of elementMap.entries()) {
      const points = Array.from(elem.points.values());
      const element: ElementData = {
        hash,
        selector: elem.selector,
        totalclicks: points.reduce((sum, p) => sum + p.clicks, 0),
        points: points.length,
        x: points.map((p) => p.eX),
        y: points.map((p) => p.eY),
        clicks: points.map((p) => p.clicks)
      };
      activity.push(element);
    }
    return activity;
  }

  public async saveRawScroll(scroll: RawScrollRecord): Promise<void> {
    const existing = this.rawScrolls.find((s) => s.id === scroll.id);
    if (!existing) {
      this.rawScrolls.push({ ...scroll });
      return;
    }
    existing.maxScrollReachY = Math.max(existing.maxScrollReachY, scroll.maxScrollReachY);
    existing.viewportHeight = scroll.viewportHeight ?? existing.viewportHeight;
    existing.timestamp = scroll.timestamp;
    existing.clientTime = scroll.clientTime;
  }

  public async getScrollMap(query: HeatmapQuery): Promise<ScrollMapResult> {
    const matched = this.rawScrolls.filter((s) =>
      s.projectId === query.projectId && s.pageUrl === query.pageUrl &&
      (!query.device || s.device === query.device) && inRange(s.timestamp, query));

    const reach = new Map<string, number>();
    for (const s of matched) reach.set(s.sessionId, Math.max(reach.get(s.sessionId) ?? 0, s.maxScrollReachY));
    const heights = matched.map((s) => s.viewportHeight).filter((h): h is number => typeof h === "number" && h > 0);
    return {
      scrollMap: buildScrollMap(Array.from(reach.values())),
      totalSessions: reach.size,
      avgFoldY: heights.length ? Math.round(heights.reduce((a, b) => a + b, 0) / heights.length) : null
    };
  }

  public async getViewDevice(scrollId: string): Promise<DeviceType | null> {
    return this.rawScrolls.find((s) => s.id === scrollId)?.device ?? null;
  }

  public async savePageSnapshot(snapshot: PageSnapshot): Promise<boolean> {
    const key = `${snapshot.projectId}:${snapshot.pageUrl}:${snapshot.device}`;
    const existing = this.snapshots.get(key);
    if (existing && existing.domHash === snapshot.domHash) return false;
    this.snapshots.set(key, snapshot);
    return true;
  }

  public async getPageSnapshot(projectId: string, pageKey: string, device?: DeviceType): Promise<PageSnapshot | null> {
    const matches = Array.from(this.snapshots.values())
      .filter((s) => s.projectId === projectId && s.pageUrl === pageKey && (!device || s.device === device))
      .sort((a, b) => b.timestamp - a.timestamp);
    return matches[0] ?? null;
  }

  public async recordPageActivity(a: PageActivity): Promise<void> {
    const key = `${a.projectId}\u0000${a.pageKey}\u0000${a.device}`;
    const row = this.pageIndex.get(key);
    if (!row) {
      this.pageIndex.set(key, {
        projectId: a.projectId, pageKey: a.pageKey, device: a.device, lastUrl: a.url,
        firstSeen: a.at, lastSeen: a.at, views: a.views, clicks: a.clicks
      });
      return;
    }
    row.lastUrl = a.url;
    row.lastSeen = Math.max(row.lastSeen, a.at);
    row.views += a.views;
    row.clicks += a.clicks;
  }

  public async listPageIndex(projectId: string): Promise<PageIndexRow[]> {
    return Array.from(this.pageIndex.values()).filter((r) => r.projectId === projectId).map((r) => ({ ...r }));
  }

  public async addDrops(entries: DropEntry[]): Promise<void> {
    for (const e of entries) {
      const key = `${e.projectId}\u0000${e.reason}`;
      const row = this.drops.get(key);
      if (row) {
        row.count += e.count;
        row.lastAt = Math.max(row.lastAt, e.lastAt);
      } else {
        this.drops.set(key, { ...e });
      }
    }
  }

  public async getDrops(projectId?: string): Promise<Record<string, DropCounts>> {
    const result: Record<string, DropCounts> = {};
    for (const e of this.drops.values()) {
      if (projectId !== undefined && e.projectId !== projectId) continue;
      (result[e.projectId] = result[e.projectId] || {})[e.reason] = { count: e.count, lastAt: e.lastAt };
    }
    return result;
  }

  public async clearProjectData(projectId: string, pageKey?: string): Promise<void> {
    const keep = (r: { projectId: string; pageUrl: string }): boolean => !(r.projectId === projectId && (!pageKey || r.pageUrl === pageKey));
    this.rawClicks = this.rawClicks.filter(keep);
    this.rawScrolls = this.rawScrolls.filter(keep);
  }

  public async deleteOlderThan(cutoff: number): Promise<{ clicks: number; scrolls: number }> {
    const clicks = this.rawClicks.length;
    const scrolls = this.rawScrolls.length;
    this.rawClicks = this.rawClicks.filter((c) => c.timestamp >= cutoff);
    this.rawScrolls = this.rawScrolls.filter((s) => s.timestamp >= cutoff);
    return { clicks: clicks - this.rawClicks.length, scrolls: scrolls - this.rawScrolls.length };
  }

  public async ping(): Promise<void> {
    return;
  }
}
