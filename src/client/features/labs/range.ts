/**
 * Is a lab value outside its normal range, in plain words, and how many
 * readings does a test really have?
 *
 * The rule (2026-10, rules 4, 8, 11, 12; shared with the chart, ../charts/range.ts): a value is judged only against
 * its OWN range, the one printed with it (features/labs/reading.ts). Never the test's range, never another lab's: a
 * value that printed no range is never marked. A flag the report printed marks it (and says so); else the value
 * against its own range, worked out by the app, marks it "high" or "low" (and says the report printed no flag, or that
 * the report marks it otherwise). A summary's or a note's own flag and range are that document's claim: never red,
 * never counted (they are said in the value's detail as the claim).
 *
 * Copies: one measurement repeated in several documents (a summary, a letter, a call quoting the lab report) is one
 * reading. readings() folds values with the same value (as read: "62" = "62.0", "<3" is not "3"), unit and day (the
 * collected or the resulted day of either, amendment G5), and the same lab when both name one, so "11 values, 7 out
 * of range" becomes "5 readings, all above the normal range".
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import { parseRefRange } from '@shared/labvalues';
import { readingOf, type LabReadingView, type ReadingSource } from './reading';

export type RangeWord = 'high' | 'low' | 'abnormal' | 'critical' | 'flagged C';

export interface RangeMark {
  /** high, low, abnormal, critical (printed as critical), or "flagged C" (a bare C: critical or corrected, the report's own letter). */
  word: RangeWord;
  /** Where the mark comes from: the report printed the flag, or the number is outside the range printed with it. */
  by: 'report' | 'range';
  /** Hover words: "Flagged high on the report", "112 is above the range printed with it (98–108), but the report printed no flag." */
  title: string;
  /** The report printed a critical mark (HH, LL, H!, "critical", "panic"). */
  critical?: boolean;
}

/** The fields the rule reads; every one optional so lab rows, chart rows and summary rows pass. */
export type RangeInput = ReadingSource;

/** A test's one range, as summaries give it (kept for older callers; values are never judged by it). */
export interface TestRange {
  low: number | null;
  high: number | null;
  unit?: string | null;
  /** As written ("15–45"), for the hover words. */
  text?: string | null;
}

const PRINTED_WORD: Record<string, RangeWord> = { H: 'high', L: 'low', A: 'abnormal' };

function whereWords(v: LabReadingView): string {
  return v.role === 'typed' ? 'when it was entered' : v.role === 'unclassified' ? 'on this document' : 'on the report';
}

function warningWords(v: LabReadingView, code: string): string | null {
  const i = v.warningCodes.indexOf(code as LabReadingView['warningCodes'][number]);
  return i >= 0 ? (v.warnings[i] ?? null) : null;
}

/**
 * The mark of a reading (the compact view), or null: within its own range, no range of its own, words, a value that
 * cannot be judged, or a summary's own claim.
 */
export function readingMark(v: LabReadingView): RangeMark | null {
  // A summary's claim, or a value the patient computed (never judged by a range, never red; 2026-10-09).
  if (v.role === 'claimed' || v.role === 'computed') return null;
  const printed = v.flagState === 'flag' ? v.flagPrinted : null;
  const raw = (v.flagRaw ?? '').trim();
  if (printed === 'H' || printed === 'L' || printed === 'A') {
    const word = PRINTED_WORD[printed];
    const extra = v.flagCritical ? ` (${raw || printed}: critical)` : raw && raw.toUpperCase() !== printed ? ` (${raw})` : '';
    return { word, by: 'report', title: `Flagged ${word} ${whereWords(v)}${extra}`, critical: v.flagCritical };
  }
  if (printed === 'C') {
    if (v.flagCritical) return { word: 'critical', by: 'report', title: `Flagged critical ${whereWords(v)}${raw ? ` (${raw})` : ''}`, critical: true };
    return { word: 'flagged C', by: 'report', title: `Flagged ${raw || 'C'} ${whereWords(v)}: critical or corrected, the report's own letter` };
  }
  if (v.computed === 'H' || v.computed === 'L') {
    const word: RangeWord = v.computed === 'H' ? 'high' : 'low';
    const said = printed === 'N' ? warningWords(v, 'flag_disagrees') : warningWords(v, 'flag_missing_out_of_range');
    const title = said ?? `${v.valueShown} is ${v.computed === 'H' ? 'above' : 'below'} the range printed with it (${v.computedAgainst ?? v.rangeShown ?? ''})`;
    return { word, by: 'range', title };
  }
  return null;
}

/**
 * The value's mark, or null when it is within its own range, has no range of its own to judge by, is words, or is a
 * summary's claim. `_test` is ignored (kept in the signature for older callers): a value is never judged by its test's
 * range or another lab's (rule 8).
 */
export function rangeMark(v: RangeInput, _test?: TestRange | null): RangeMark | null {
  return readingMark(readingOf(v));
}

/** The value is judged within its own range: its printed flag says normal, or the app worked out "in range"; never a claim. */
export function inOwnRange(v: RangeInput): boolean {
  const r = readingOf(v);
  if (r.role === 'claimed' || r.role === 'computed' || readingMark(r)) return false;
  return (r.flagState === 'flag' && r.flagPrinted === 'N') || r.computed === 'N';
}

/** One reading: a value as measured on a date, however many documents repeat it. */
export interface Reading<T> {
  key: string;
  date: string | null;
  /** The copies, in the order given (the first is shown). */
  rows: T[];
}

export interface ReadingInput extends ReadingSource {
  date?: string | null;
}

/** The value's identity for copies: as read ("62" = "62.0", "<3" is "lt:3", never "3"; words by their words). */
function identityOf(r: ReadingInput): string {
  return readingOf(r).identity;
}

/** The same measurement: same day, same value as read, same unit. */
export function readingKey(r: ReadingInput): string {
  const v = readingOf(r);
  return `${r.date ?? ''}|${v.identity}|${v.unitKey ?? ''}`;
}

/** The days a reading can be found on: its own date, and its collected and resulted days. */
function daysOf(r: ReadingInput, v: LabReadingView): Set<string> {
  const out = new Set<string>();
  if (r.date) out.add(r.date);
  for (const d of [v.collected, v.resulted]) if (d?.iso) out.add(d.iso);
  return out;
}

/**
 * Rows folded into readings, in the order of their first copy. Two rows are one reading when they give the same value
 * (as read), in the same unit, from the same lab when both name one, on a day one of them gives (its date, its
 * collected or its resulted day): a lab report collected 02-14 and resulted 03-03, and a portal copy dated 03-03, are
 * one reading, never a two-point trend (amendment G5).
 */
export function readings<T extends ReadingInput>(rows: readonly T[]): Array<Reading<T>> {
  const out: Array<Reading<T> & { v: LabReadingView; days: Set<string> }> = [];
  const byKey = new Map<string, Reading<T> & { v: LabReadingView; days: Set<string> }>();
  for (const r of rows) {
    const v = readingOf(r);
    // A value the patient computed is its own reading: never a copy of the lab's printed value of the same day, nor it of his.
    const key = `${r.date ?? ''}|${v.identity}|${v.unitKey ?? ''}${v.role === 'computed' ? '|computed' : ''}`;
    const days = daysOf(r, v);
    const exact = byKey.get(key);
    const hit =
      (exact && (!exact.v.labKey || !v.labKey || exact.v.labKey === v.labKey) ? exact : undefined) ??
      out.find((x) => x.v.identity === v.identity && (x.v.role === 'computed') === (v.role === 'computed') && (x.v.unitKey ?? '') === (v.unitKey ?? '') && (!x.v.labKey || !v.labKey || x.v.labKey === v.labKey) && [...days].some((d) => x.days.has(d)));
    if (hit) {
      hit.rows.push(r);
      for (const d of days) hit.days.add(d);
      continue;
    }
    // Two labs giving the same value on one day are two readings: their keys stay unique (they key a list's rows).
    const made = { key: byKey.has(key) ? `${key}#${out.length}` : key, date: r.date ?? null, rows: [r], v, days };
    out.push(made);
    if (!byKey.has(key)) byKey.set(key, made);
  }
  return out.map(({ key, date, rows: rs }) => ({ key, date, rows: rs }));
}

/**
 * Dates that hold more than one different reading. `sameDocument` (only when true): every value that day comes from
 * one document ("this document gives two values"), else documents disagree.
 */
export function disagreeingDates<T extends ReadingInput>(rows: readonly T[]): Array<{ date: string; values: string[]; sameDocument?: true }> {
  const byDate = new Map<string, { values: Set<string>; docs: Set<string>; unknownDoc: boolean }>();
  for (const r of readings(rows)) {
    if (!r.date) continue;
    const first = r.rows[0];
    const shown = readingOf(first).valueShown.trim();
    if (!shown) continue;
    const at = byDate.get(r.date) ?? { values: new Set<string>(), docs: new Set<string>(), unknownDoc: false };
    byDate.set(r.date, at);
    at.values.add(`${shown}${first.unit ? ` ${first.unit}` : ''}`);
    for (const x of r.rows) {
      if (typeof x.documentId === 'string' && x.documentId) at.docs.add(x.documentId);
      else at.unknownDoc = true;
    }
  }
  return [...byDate.entries()]
    .filter(([, v]) => v.values.size > 1)
    .map(([date, v]) => (v.docs.size === 1 && !v.unknownDoc ? { date, values: [...v.values], sameDocument: true as const } : { date, values: [...v.values] }));
}

/** A normal range as printed ("15-45", "15–45", "< 45", "≤45", ">= 10") as numbers (the shared parser); null when it is not one. */
export function parseRange(text: string | null | undefined): { low: number | null; high: number | null } | null {
  const r = parseRefRange(text ?? null);
  if (r.status !== 'parsed' || r.kind === 'text' || (r.low == null && r.high == null)) return null;
  return { low: r.low, high: r.high };
}

/**
 * The Range filter of the lab lists: out (outside its own range, or flagged), in (within its own range), or H / L / A /
 * C (high, low, abnormal, critical or a bare C), judged by the same rule as the red marks. A summary's claim is never
 * out and never in. Without the reading, "in" means "not marked" (older callers).
 */
export function passesRange(filter: string | null | undefined, mark: RangeMark | null, value?: RangeInput | null): boolean {
  if (!filter) return true;
  if (filter === 'out') return Boolean(mark);
  if (filter === 'in') return value ? inOwnRange(value) : !mark;
  const f = filter.toUpperCase();
  if (f === 'C') return Boolean(mark && (mark.critical || mark.word === 'critical' || mark.word === 'flagged C'));
  return mark?.word === PRINTED_WORD[f];
}

/** "5 readings · all above the range", "3 readings · 1 high", "1 reading": what a test's values add up to. */
export function readingSummary(n: number, marks: Array<RangeMark | null>): { count: string; out: string | null; outCount: number } {
  const count = `${n} reading${n === 1 ? '' : 's'}`;
  const high = marks.filter((m) => m?.word === 'high').length;
  const low = marks.filter((m) => m?.word === 'low').length;
  const other = marks.filter((m) => m && m.word !== 'high' && m.word !== 'low').length;
  const outCount = high + low + other;
  if (!outCount) return { count, out: null, outCount };
  if (outCount === n && n > 1) return { count, out: high === n ? 'all high' : low === n ? 'all low' : 'all out of range', outCount };
  const parts = [high ? `${high} high` : '', low ? `${low} low` : '', other ? `${other} abnormal` : ''].filter(Boolean);
  return { count, out: parts.join(', '), outCount };
}
