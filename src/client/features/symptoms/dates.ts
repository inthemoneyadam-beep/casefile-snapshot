/** Day arithmetic on YYYY-MM-DD strings (UTC, so no DST drift) and labels. */

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(day: string, n: number): string {
  return new Date(toUtc(day) + n * 86400000).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekday(day: string): string {
  return WEEKDAYS[new Date(toUtc(day)).getUTCDay()];
}

/** "Mon 10 Jun 2024" */
export function longDay(day: string): string {
  const d = new Date(toUtc(day));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The n days ending at `end`, ascending. */
export function daysEndingAt(end: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

/** 0-10 -> one of five tone classes shared by the grid and the strip. */
export function toneClass(score: number | null | undefined): string {
  if (score == null) return 'sym-tone-empty';
  if (score <= 2) return 'sym-tone-1';
  if (score <= 4) return 'sym-tone-2';
  if (score <= 6) return 'sym-tone-3';
  if (score <= 8) return 'sym-tone-4';
  return 'sym-tone-5';
}

export const RANGES = [30, 90, 180, 365] as const;
export type RangeDays = (typeof RANGES)[number];
