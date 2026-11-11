import { IAnalyticsRepository } from "../db/repository";
import { DropCounts, DropEntry, DropReason } from "../types";

const FLUSH_INTERVAL_MS = 60 * 1000;

// Counts dropped beacons in memory and writes them to the repository once a minute, with one log line
// per project and reason. projectId "" holds drops that cannot be tied to a project.
export class DropCounter {
  private pending = new Map<string, DropEntry>();

  constructor(private readonly repository: IAnalyticsRepository) {}

  public record(projectId: string | null, reason: DropReason, at: number = Date.now()): void {
    const key = `${projectId || ""}\u0000${reason}`;
    const entry = this.pending.get(key);
    if (entry) {
      entry.count += 1;
      entry.lastAt = at;
    } else {
      this.pending.set(key, { projectId: projectId || "", reason, count: 1, lastAt: at });
    }
  }

  public async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.values());
    this.pending = new Map();
    for (const e of entries) {
      console.warn(`[collect] dropped ${e.count} beacon(s): project=${e.projectId || "-"} reason=${e.reason}`);
    }
    try {
      await this.repository.addDrops(entries);
    } catch (error) {
      console.error("[collect] could not store drop counts:", error);
    }
  }

  // Stored counts plus the ones not flushed yet. Without projectId, every project.
  public async read(projectId?: string): Promise<Record<string, DropCounts>> {
    const stored = await this.repository.getDrops(projectId);
    for (const e of this.pending.values()) {
      if (projectId !== undefined && e.projectId !== projectId) continue;
      const project = (stored[e.projectId] = stored[e.projectId] || {});
      const current = project[e.reason];
      project[e.reason] = current
        ? { count: current.count + e.count, lastAt: Math.max(current.lastAt, e.lastAt) }
        : { count: e.count, lastAt: e.lastAt };
    }
    return stored;
  }

  public start(intervalMs: number = FLUSH_INTERVAL_MS): () => void {
    const timer = setInterval(() => void this.flush(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
