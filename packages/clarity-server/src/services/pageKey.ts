import { createHash } from "crypto";
import { DeviceType } from "../types";

export function snapshotId(projectId: string, pageKey: string, device: DeviceType): string {
  return `${projectId}:${createHash("sha1").update(`${pageKey}|${device}`).digest("hex")}`;
}

// The one aggregation key for a page: lowercase host without a leading "www." plus the path without trailing
// slashes; the root is host + "/". No scheme, query or hash. Idempotent, so a key passes through unchanged.
export function canonicalPageKey(url: string | undefined): string | null {
  const raw = (url || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.host.toLowerCase().replace(/^www\./, "");
    if (!host) return null;
    return host + (parsed.pathname.replace(/\/+$/, "") || "/");
  } catch {
    return null;
  }
}

// Same rules as the backend's HeatmapUrlMatcher: "*" matches any run of characters, including "/".
export function isExcluded(pageKey: string, patterns: string[]): boolean {
  const target = pageKey.toLowerCase().replace(/\/+$/, "");
  return patterns.some((pattern) => {
    const clean = normalizePattern(pattern);
    if (!clean) return false;
    const regex = new RegExp(`^${clean.split("*").map(escapeRegex).join(".*")}$`);
    return regex.test(target);
  });
}

function normalizePattern(pattern: string): string {
  const noScheme = pattern.trim().replace(/^https?:\/\//i, "");
  return noScheme.split("?")[0].split("#")[0].replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
