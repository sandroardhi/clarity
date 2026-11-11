import { IAnalyticsRepository } from "../db/repository";

export const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function retentionDays(value: string | undefined): number {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

export async function pruneRawData(repository: IAnalyticsRepository, days: number, now: number = Date.now()) {
  return repository.deleteOlderThan(now - days * DAY_MS);
}

// Prunes once now and then every 6 hours. Returns a function that stops the timer.
export function startRetention(repository: IAnalyticsRepository, days: number, intervalMs: number = PRUNE_INTERVAL_MS): () => void {
  const run = (): void => {
    pruneRawData(repository, days).then(
      (deleted) => {
        if (deleted.clicks > 0 || deleted.scrolls > 0) {
          console.log(`[retention] deleted ${deleted.clicks} clicks and ${deleted.scrolls} scrolls older than ${days} days`);
        }
      },
      (error) => console.error("[retention] prune failed:", error)
    );
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
