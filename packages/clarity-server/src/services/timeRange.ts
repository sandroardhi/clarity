export interface TimeRange {
  from: number | null;
  to: number | null;
}

export class BadRequestError extends Error {}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

// from is inclusive and to is exclusive, both epoch ms. A Y-m-d `to` covers that whole day in tz.
export function parseTimeRange(from?: string, to?: string, tz?: string): TimeRange {
  const range = { from: parseBound("from", from, tz, false), to: parseBound("to", to, tz, true) };
  if (range.from !== null && range.to !== null && range.from >= range.to) {
    throw new BadRequestError("from must be before to");
  }
  return range;
}

function parseBound(name: string, value: string | undefined, tz: string | undefined, isEnd: boolean): number | null {
  if (value === undefined || value === "") return null;
  if (ISO_WITH_OFFSET.test(value)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return time;
  }
  const day = DAY.exec(value);
  if (!day) throw new BadRequestError(`${name} must be ISO 8601 with an offset, or Y-m-d with tz`);
  if (!tz) throw new BadRequestError(`${name} is a Y-m-d date, so tz is required`);
  const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const utcDay = Date.UTC(y, m - 1, d + (isEnd ? 1 : 0));
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) throw new BadRequestError(`${name} is not a valid date`);
  return localMidnight(utcDay, tz);
}

// Epoch ms of 00:00 local time in tz on the UTC calendar day that starts at utcDay.
function localMidnight(utcDay: number, tz: string): number {
  const fixed = OFFSET.exec(tz);
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3]);
    return utcDay - (fixed[1] === "-" ? -minutes : minutes) * 60000;
  }
  let guess = utcDay - offsetMs(utcDay, tz);
  const corrected = utcDay - offsetMs(guess, tz);
  if (corrected !== guess) guess = corrected;
  return guess;
}

function offsetMs(time: number, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(new Date(time));
  } catch {
    throw new BadRequestError("tz must be an IANA zone or an offset like +07:00");
  }
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(time / 1000) * 1000;
}
