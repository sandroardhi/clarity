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
  isActive: boolean;
  createdAt: number;
}

export interface CreateProjectInput {
  id: string;
  name: string;
  allowedDomains: string[];
}

export type DeviceType = "desktop" | "mobile" | "tablet";

// ==========================================
// 2. Database & Storage Models
// ==========================================

export interface RawClickRecord {
  id: string;
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  hash: string;
  selector: string;
  eX: number; // 0..32767 (element-relative coordinate)
  eY: number; // 0..32767
  timestamp: number;
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
  timestamp: number;
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
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}

export interface HeatmapClickResponse {
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  from: string;
  to: string;
  totalClicks: number;
  activity: Activity;
}

export interface HeatmapScrollResponse {
  projectId: string;
  pageUrl: string;
  device: DeviceType;
  from: string;
  to: string;
  totalSessions: number;
  scrollMap: ScrollMapInfo[];
  averageFoldY: number;
}

export interface PageSnapshotResponse {
  projectId: string;
  pageUrl: string;
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
}

