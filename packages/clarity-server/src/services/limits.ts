const WINDOW_MS = 60 * 1000;

export const DEFAULT_SESSION_ROWS_PER_MIN = 300;
export const DEFAULT_PROJECT_ROWS_PER_MIN = 30000;

export interface IngestLimits {
  sessionRowsPerMin: number;
  projectRowsPerMin: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): IngestLimits {
  return {
    sessionRowsPerMin: positiveInt(env.CLARITY_SESSION_ROWS_PER_MIN, DEFAULT_SESSION_ROWS_PER_MIN),
    projectRowsPerMin: positiveInt(env.CLARITY_PROJECT_ROWS_PER_MIN, DEFAULT_PROJECT_ROWS_PER_MIN)
  };
}

// Fixed one-minute windows of stored rows (clicks plus the scroll row) per session and per project.
// A beacon that would cross either cap is refused whole, and nothing is counted for it.
export class RowLimiter {
  private windowStart = 0;
  private sessions = new Map<string, number>();
  private projects = new Map<string, number>();

  constructor(private readonly limits: IngestLimits) {}

  public allow(projectId: string, sessionId: string, rows: number, now: number = Date.now()): boolean {
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.sessions.clear();
      this.projects.clear();
    }
    const sessionKey = `${projectId}\u0000${sessionId}`;
    const session = (this.sessions.get(sessionKey) || 0) + rows;
    const project = (this.projects.get(projectId) || 0) + rows;
    if (session > this.limits.sessionRowsPerMin || project > this.limits.projectRowsPerMin) return false;
    this.sessions.set(sessionKey, session);
    this.projects.set(projectId, project);
    return true;
  }
}
