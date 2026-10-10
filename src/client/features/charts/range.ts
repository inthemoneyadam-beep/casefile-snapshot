/**
 * The normal-range rule for chart points, in one place.
 *
 * Lab charts (the server's, `source: 'db'`, src/shared/chart.ts): each point carries its own flag. "H", "L", "A" or
 * "C" is the flag printed with the value (the report flagged it: red, with a ring); "H~" or "L~" is outside the range
 * printed with that value, worked out by the app (red, no ring); no flag is inside its own range, or a value that
 * printed no range of its own, or a summary's claim: never red (2026-10, rules 4, 8, 12). The band is the one range
 * the readings in view printed; it never judges a point (`ownFlags`).
 *
 * Other charts (a chart the consult assembled, with a band and no flags): a point outside the band is red.
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import { formatRange, rangeFromNumbers } from '@shared/labvalues';

export type RangeSide = 'high' | 'low';

/** 'high' above the range, 'low' below it, null inside it or when there is no range or no number. */
export function outsideRange(y: number | null | undefined, low: number | null | undefined, high: number | null | undefined): RangeSide | null {
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (typeof high === 'number' && Number.isFinite(high) && y > high) return 'high';
  if (typeof low === 'number' && Number.isFinite(low) && y < low) return 'low';
  return null;
}

/** The report's own flag, read: H high, L low, A abnormal, C critical (a trailing ~ marks one worked out from the range). */
export function reportFlag(flag: string | null | undefined): 'high' | 'low' | 'abnormal' | 'critical' | null {
  const f = (flag ?? '').replace('~', '').trim().toUpperCase();
  if (f === 'H' || f === 'HH' || f === 'HIGH') return 'high';
  if (f === 'L' || f === 'LL' || f === 'LOW') return 'low';
  if (f === 'A' || f === 'ABNORMAL') return 'abnormal';
  if (f === 'C' || f === 'CRITICAL') return 'critical';
  return null;
}

/**
 * A point of a chart: is it out of range, and did the report flag it? `ownFlags` (lab charts): by its own flag only,
 * printed or worked out from its own range (a point with no flag is never red, whatever the band); otherwise also by
 * the band.
 */
export function pointMark(p: { y: number | null; flag?: string | null }, band: { low: number | null; high: number | null } | null | undefined, ownFlags = false): { out: boolean; flagged: boolean } {
  const flagged = reportFlag(p.flag) != null && !(p.flag ?? '').includes('~');
  const derived = reportFlag(p.flag) != null && (p.flag ?? '').includes('~');
  const byBand = !ownFlags && band ? outsideRange(p.y, band.low, band.high) != null : false;
  return { out: flagged || derived || byBand, flagged };
}

/**
 * "Normal range 15–45 mg/dL" from a band label written as "ref 15–45 mg/dL" (the range as printed); from the bare
 * numbers "Normal range 15–45", or "Normal range: upper limit 45" when only one bound is on record (its sign is not:
 * never "up to" or "≤", rule 3).
 */
export function bandWords(band: { low: number | null; high: number | null; label?: string | null } | null | undefined): string {
  if (!band) return '';
  const label = (band.label ?? '').trim();
  if (label) {
    const rest = label.replace(/^(?:ref(?:erence)?(?:\s+range)?|normal(?:\s+range)?)\s*[:.]?\s*/i, '');
    return `Normal range ${rest}`.trim();
  }
  const words = formatRange(rangeFromNumbers(band.low ?? null, band.high ?? null));
  if (!words) return 'Normal range';
  return band.low != null && band.high != null ? `Normal range ${words}` : `Normal range: ${words}`;
}
