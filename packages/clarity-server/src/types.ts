/**
 * Comprehensive Strict TypeScript Definitions for Skalpl Clarity Server
 */

// ==========================================
// 1. Multi-Tenant Project / Account Types
// ==========================================

export interface Project {
  id: string; // e.g. "skalpl_tenant_site_123"
  name: string;
  allowedDomains: string[]; // e.g. ["example.com", "www.example.com"]
  // Globs matched against the page key at collect time; a match drops the beacon
  excludePatterns: string[];
  isActive: boolean;
  // Unix ms of the backend change behind the last sync; a lower version is rejected as stale
  version: number | null;
  createdAt: number;
}

export type DeviceType = "desktop" | "mobile" | "tablet";

// ==========================================
// 2. Database & Storage Models
// ==========================================

export interface RawClickRecord {
  id: string;
  projectId: string;
  // Canonical page key (see services/pageKey.ts)
  pageUrl: string;
  device: DeviceType;
  hash: string;
  selector: string;
  eX: number; // 0..32767 (element-relative coordinate)
  eY: number; // 0..32767
  // Server receive time, epoch ms; filters and retention use it
  timestamp: number;
  // Browser clock from the payload; null when the payload has none
  clientTime: number | null;
}

export interface DailyClickRollup {
  date: string; // YYYY-MM-DD
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  hash: string;
  selector: string;
  eX: number;
  eY: number;
  clickCount: number;
}

export interface RawScrollRecord {
  id: string;
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  sessionId: string;
  maxScrollReachY: number; // 0..100 (%)
  // Viewport height in CSS px; null when the payload has none
  viewportHeight: number | null;
  timestamp: number;
  clientTime: number | null;
}

export interface DailyScrollRollup {
  date: string; // YYYY-MM-DD
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  depthPercent: number; // 0, 25, 50, 75, 100
  userCount: number;
}

export interface PageSnapshot {
  id: string;
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  domHash: string;
  rawPayload: string; // Raw discover payload string to reconstruct DOM in visualizer
  timestamp: number;
}

// ==========================================
// 3. Clarity Visualization Protocol Types
// Exact compatibility with packages/clarity-visualize
// ==========================================

export interface ElementData {
  hash: string;
  selector: string;
  totalclicks: number;
  x: number[];
  y: number[];
  clicks: number[];
  points: number;
}

export type Activity = ElementData[];

export interface ScrollMapInfo {
  scrollReachY: number;
  cumulativeSum: number;
  percUsers: number;
}

// ==========================================
// 4. API Request & Response Contracts
// ==========================================

export interface HeatmapQuery {
  projectId: string;
  pageUrl: string;
  device?: DeviceType;
  // Epoch ms; from is inclusive, to is exclusive, null is unbounded
  from?: number | null;
  to?: number | null;
}

export interface HeatmapClickResponse {
  projectId: string;
  pageKey: string;
  device: DeviceType | null;
  from: number | null;
  to: number | null;
  totalClicks: number;
  activity: Activity;
}

export interface HeatmapScrollResponse {
  projectId: string;
  pageKey: string;
  device: DeviceType | null;
  from: number | null;
  to: number | null;
  totalSessions: number;
  scrollMap: ScrollMapInfo[];
  // Mean viewport height in px; null when there are no sessions
  averageFoldY: number | null;
}

export interface PageSnapshotResponse {
  projectId: string;
  pageKey: string;
  device: DeviceType;
  domHash: string;
  payload: string;
}

export interface IngestionResult {
  success: boolean;
  projectId: string;
  clicksCount: number;
  scrollRecorded: boolean;
  snapshotSaved: boolean;
  dropped?: DropReason;
  // Clicks skipped for out-of-range coordinates
  rejectedClicks?: number;
}

export type DropReason = "unknown" | "inactive" | "origin" | "excluded" | "invalid" | "gunzip" | "rate_limited";

export interface DropEntry {
  projectId: string;
  reason: DropReason;
  count: number;
  lastAt: number;
}

export type DropCounts = Partial<Record<DropReason, { count: number; lastAt: number }>>;

// One row per project, page key and device; every accepted beacon updates it
export interface PageIndexRow {
  projectId: string;
  pageKey: string;
  device: DeviceType;
  // Last real URL seen (origin + path), for display
  lastUrl: string;
  firstSeen: number;
  lastSeen: number;
  views: number;
  clicks: number;
}

export interface TrackedPage {
  pageKey: string;
  pageUrl: string;
  firstSeen: number;
  lastSeen: number;
  views: number;
  clicks: number;
  excluded: boolean;
  devices: Partial<Record<DeviceType, { views: number; clicks: number; lastSeen: number }>>;
}

