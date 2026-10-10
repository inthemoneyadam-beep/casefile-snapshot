/**
 * Results in words.
 *
 * A test whose results are all words (Negative, Positive, Clear, Colorless, Not detected) gets no chart anywhere: just
 * a dated list of its results, with an abnormal or positive one marked so it stands out. A test with some numbers and
 * some words draws only its numbers and lists every result under the chart. Nothing draws a chart without a number
 * to draw: the Labs page, the document summary's trends, the clinician's charts.
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import type { ChartSpec } from '@shared/chart';
import { limitWords, parseLabValue, type LabReadingView } from '@shared/labvalues';

/** At least one point with a number to draw. A chart without one is never drawn. */
export function hasNumericPoint(spec: Pick<ChartSpec, 'series'> | null | undefined): boolean {
  const series = Array.isArray(spec?.series) ? spec.series : [];
  return series.some((s) => Array.isArray(s?.points) && s.points.some((p) => typeof p?.y === 'number' && Number.isFinite(p.y)));
}

/** The fields the helpers read; optional so any lab row, point or brief row passes. */
export interface ResultLike {
  valueNum?: number | null;
  value?: string | null;
  valueText?: string | null;
  flag?: string | null;
  specimen?: string | null;
  /** The value as read (LabEntry.reading, 2026-10): when present it decides (a limit is never a number). */
  reading?: LabReadingView | null;
}

const textOf = (r: ResultLike): string => (r.reading?.valueShown?.trim() ? r.reading.valueShown : typeof r.value === 'string' && r.value.trim() ? r.value : typeof r.valueText === 'string' ? r.valueText : '').trim();

/** A measurement: the reading's ("62"), never a limit ("<3") or words stored with a number; without a reading, a stored number. */
const hasNumber = (r: ResultLike): boolean => (r.reading ? r.reading.measurement != null : typeof r.valueNum === 'number' && Number.isFinite(r.valueNum));

/** A result with no measurement, written as text: words ("Negative", "Clear", "Not detected"), or a limit ("<2"). */
export function isWordResult(r: ResultLike): boolean {
  return !hasNumber(r) && textOf(r) !== '';
}

/**
 * The number a value written as text starts with ("60", "<2", ">= 5", "1,250"), or null for a value in words
 * ("Negative", "Clear"). For rows that carry only the value as written (the document summary's).
 */
export function leadingNumber(text: string | null | undefined): number | null {
  const m = (text ?? '').trim().match(/^(?:<=|>=|[<>≤≥~])?\s*([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * How a test's trend is shown:
 *   numbers     the chart, as before;
 *   mixed       the chart draws the numbers, and every result, words included, is listed under it;
 *   words       every result is words: no chart, a dated list;
 *   undrawable  some numbers, but none that can be drawn (each marked inaccurate or undated): no chart, the list;
 *   empty       no result in these dates.
 * The server's `wordOnly` decides when it says so; otherwise the chart and the rows do.
 */
export type TrendShape = 'numbers' | 'mixed' | 'words' | 'undrawable' | 'empty';

export function trendShape({ wordOnly, chart, rows }: { wordOnly?: boolean | null; chart: Pick<ChartSpec, 'series'> | null | undefined; rows: readonly ResultLike[] }): TrendShape {
  const drawable = hasNumericPoint(chart);
  if (!rows.length && !drawable) return 'empty';
  if (wordOnly === true) return 'words';
  const words = rows.filter(isWordResult).length;
  if (drawable) return words ? 'mixed' : 'numbers';
  return words && !rows.some(hasNumber) ? 'words' : 'undrawable';
}

/** The one line said where a chart would be. */
export const WORDS_NOTE = 'Results in words; no chart.';
export const BOUNDS_NOTE = 'Values below or above what the test can measure; no chart.';

/** The note for a test with nothing to draw: values that are all limits ("<2", ">1000") are not words. */
export function noChartNote(rows: readonly ResultLike[]): string {
  return rows.length > 0 && rows.every(isLimitValue) ? BOUNDS_NOTE : WORDS_NOTE;
}
export const UNDRAWABLE_NOTE = 'No value here can be drawn; no chart.';
export const MIXED_NOTE = 'Only the numbers are drawn; every result, words included, is listed below.';

// ---------------------------------------------------------------------------
// Limits ("<2", ">1000"): numbers at the edge of what a test can measure, not words
// ---------------------------------------------------------------------------

/** A value written as a limit: "<2", "< 5", ">1000", "≤0.5", "> OR = 60" (the shared parser's: a limit, not a measurement). */
export function isLimitValue(r: ResultLike): boolean {
  if (r.reading) return r.reading.kind === 'censored';
  return parseLabValue(textOf(r)).kind === 'censored';
}

/** A result in words that is not a limit ("Negative", "Clear"). */
export function isWordOnlyResult(r: ResultLike): boolean {
  return isWordResult(r) && !isLimitValue(r);
}

/** How many distinct points a chart draws (copies of one value on one date are one point). */
export function drawnPointCount(spec: Pick<ChartSpec, 'series'> | null | undefined): number {
  const seen = new Set<string>();
  for (const s of Array.isArray(spec?.series) ? spec.series : []) {
    for (const p of Array.isArray(s?.points) ? s.points : []) {
      if (typeof p?.y === 'number' && Number.isFinite(p.y)) seen.add(`${String(p.x)}|${p.y}`);
    }
  }
  return seen.size;
}

/**
 * What the limits among a test's readings mean, in plain words: '2 readings are limits, not exact numbers: "<2"
 * means the test reads below 2.' Each limit is said as the value detail says it (the shared limitWords: "below 3",
 * "0.02 or below", "above 1700"); a reporting cut-off ("<50") is not called the lowest amount the test can measure
 * (2026-10 review). Null without limits.
 */
export function limitNote(rows: readonly ResultLike[]): string | null {
  const limits = rows.filter(isLimitValue);
  if (!limits.length) return null;
  // Each limit once, as printed ("<2", "less than 3"; the space after a sign symbol dropped), with its own words.
  const said = new Map<string, string>();
  for (const r of limits) {
    const text = textOf(r).replace(/\s+/g, ' ').replace(/([<>≤≥=])\s+(?=[-.\d])/g, '$1').trim();
    if (said.has(text)) continue;
    const words = r.reading?.limit ?? limitWords(parseLabValue(textOf(r)));
    said.set(text, words ? `"${text}" means the test reads ${words}` : `"${text}" is a limit`);
  }
  const meaning = [...said.values()].join('; ');
  const n = limits.length;
  return `${n === 1 ? 'One reading is a limit' : `${n} readings are limits`}, not ${n === 1 ? 'an exact number' : 'exact numbers'}: ${meaning}.`;
}

/**
 * Why a test whose chart would have fewer than two points has no chart (one point makes no line), what its limits
 * mean, and where the readings are.
 */
export function fewPointsNote(drawn: number, rows: readonly ResultLike[]): string {
  const head = drawn === 1 ? 'No chart: only one reading is an exact number, and one point makes no line.' : 'No chart: no reading is an exact number.';
  const words = rows.filter(isWordOnlyResult).length;
  return [head, limitNote(rows), words ? `${words === 1 ? 'One result is' : `${words} results are`} in words.` : null, 'Every reading is listed below.'].filter(Boolean).join(' ');
}

/** The note under a chart that leaves some readings out: limits are said as limits, words as words. Null when every reading is drawn. */
export function notDrawnNote(rows: readonly ResultLike[]): string | null {
  const limits = limitNote(rows);
  const words = rows.filter(isWordOnlyResult).length;
  if (!limits && !words) return null;
  if (!limits) return MIXED_NOTE;
  return `${limits} They are not drawn${words ? ', nor are the results in words' : ''}; every reading is listed below.`;
}

// ---------------------------------------------------------------------------
// Marks: an abnormal or positive result stands out
// ---------------------------------------------------------------------------

export type MarkTone = 'warn' | 'danger';
export interface ResultMark {
  tone: MarkTone;
  /** The plain word on the tag: high, low, abnormal, critical, positive. */
  word: string;
  title: string;
}

// Red, as a value outside its normal range is everywhere (the chart's points, the lab tables): see ../charts/range.ts.
// A bare "C" is the report's own letter (critical on some reports, corrected on others): never called "critical".
const FLAG_MARK: Record<string, ResultMark> = {
  H: { tone: 'danger', word: 'high', title: 'Flagged high on the report' },
  L: { tone: 'danger', word: 'low', title: 'Flagged low on the report' },
  A: { tone: 'danger', word: 'abnormal', title: 'Flagged abnormal on the report' },
  C: { tone: 'danger', word: 'flagged C', title: "Flagged C on the report: critical or corrected, the report's own letter" },
};

/** Words that turn the word after them around: "not detected", "non-reactive", "no bands seen", "without xanthochromia". */
const NEGATION = new Set(['no', 'not', 'non', 'none', 'without', 'never']);
const POSITIVE = new Set(['positive', 'pos', 'detected', 'reactive', 'present', 'isolated', 'grew', 'growth']);
const ABNORMAL = new Set(['abnormal', 'elevated', 'raised', 'increased', 'decreased']);
/** A clause that says the answer is negative or normal gives no mark, wherever the word sits ("Xanthochromia: absent", "Negative for xanthochromia", "Growth: none"). */
const NORMAL_ANSWER = /\b(?:negative|neg|absent|none|normal|unremarkable|nonreactive|non reactive|not detected|no growth|within normal limits|wnl)\b/;
/** "Reactive" before a cell word describes cells ("reactive lymphocytes"), not a reactive test. */
const CELL_WORDS = new Set(['lymphocytes', 'lymphocyte', 'lymphs', 'cells', 'cell', 'changes', 'mesothelial', 'monocytes', 'plasma']);
/** Spinal fluid is clear and colourless: any of these in a CSF result is abnormal. */
const CSF_ABNORMAL = new Set(['cloudy', 'turbid', 'hazy', 'bloody', 'blood', 'tinged', 'xanthochromic', 'xanthochromia', 'pink', 'red', 'yellow', 'purulent', 'milky']);

/** A word of the result that is not turned around by a "no", "not", "non" or "without" just before it (within three words). */
function standsAlone(words: string[], i: number): boolean {
  for (let j = Math.max(0, i - 3); j < i; j++) if (NEGATION.has(words[j])) return false;
  return true;
}

/**
 * How a result in words reads: positive (positive, detected, reactive, present), abnormal (abnormal, elevated; for
 * CSF also cloudy, bloody, xanthochromic and the like), or null for a negative, normal or descriptive answer
 * ("Negative", "Not detected", "Non-reactive", "Clear", "Colorless", "No growth").
 */
export function readWords(text: string | null | undefined, specimen?: string | null): 'positive' | 'abnormal' | null {
  const csf = (specimen ?? '').toLowerCase() === 'csf';
  let abnormal = false;
  const all = (text ?? '').toLowerCase();
  // Oligoclonal bands "in CSF and serum (mirror pattern)" are not made in the spinal fluid: no mark.
  if (/\bmirror\b/.test(all)) return null;
  // Each clause on its own: in "Negative for HSV; positive for VZV" the "no" of one never turns the next around. A
  // label and its answer ("Xanthochromia: absent") are one clause.
  for (const clause of all.split(/[;,./()]+/)) {
    if (NORMAL_ANSWER.test(clause.replace(/-/g, ' '))) continue;
    const words = clause.split(/[^a-z]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === 'reactive' && CELL_WORDS.has(words[i + 1] ?? '')) continue;
      if (POSITIVE.has(w) && standsAlone(words, i)) return 'positive';
      if ((ABNORMAL.has(w) || (csf && CSF_ABNORMAL.has(w))) && standsAlone(words, i)) abnormal = true;
    }
  }
  return abnormal ? 'abnormal' : null;
}

/**
 * The mark a result carries so it stands out, in plain words: the report's own flag (high, low, abnormal, critical),
 * else, for a result in words, how it reads (positive, abnormal). Null for a normal or negative result.
 */
/**
 * The mark of the flag printed with a value (as labs/range.ts readingMark says it; kept here so this file imports
 * nothing of the client): high, low, abnormal, critical (printed as critical), or "flagged C" (a bare C, the report's
 * own letter). Never a summary's own flag (its claim). Null without a printed flag, or for N.
 */
function printedFlagMark(v: LabReadingView): ResultMark | null {
  if (v.role === 'claimed' || v.flagState !== 'flag' || !v.flagPrinted || v.flagPrinted === 'N') return null;
  const where = v.role === 'typed' ? 'when it was entered' : v.role === 'unclassified' ? 'on this document' : 'on the report';
  const raw = (v.flagRaw ?? '').trim();
  if (v.flagPrinted === 'C') {
    return v.flagCritical
      ? { tone: 'danger', word: 'critical', title: `Flagged critical ${where}${raw ? ` (${raw})` : ''}` }
      : { tone: 'danger', word: 'flagged C', title: `Flagged ${raw || 'C'} ${where}: critical or corrected, the report's own letter` };
  }
  const word = v.flagPrinted === 'H' ? 'high' : v.flagPrinted === 'L' ? 'low' : 'abnormal';
  return { tone: 'danger', word, title: `Flagged ${word} ${where}${v.flagCritical ? ` (${raw || v.flagPrinted}: critical)` : ''}` };
}

export function resultMark(r: ResultLike): ResultMark | null {
  const v = r.reading;
  if (v) {
    // The flag printed with it (a summary's own flag is its claim: never a red mark).
    const m = printedFlagMark(v);
    if (m) return m;
    if ((v.role !== 'claimed' && v.flagState === 'flag' && v.flagPrinted === 'N') || !isWordResult(r)) return null;
  } else {
    const flag = (r.flag ?? '').replace('~', '').trim().toUpperCase();
    if (FLAG_MARK[flag]) return FLAG_MARK[flag];
    if (flag === 'N' || !isWordResult(r)) return null;
  }
  const read = readWords(textOf(r), r.specimen);
  if (read === 'positive') return { tone: 'warn', word: 'positive', title: 'The result reads positive' };
  if (read === 'abnormal') return { tone: 'warn', word: 'abnormal', title: (r.specimen ?? '').toLowerCase() === 'csf' ? 'The result reads abnormal: spinal fluid is normally clear and colourless' : 'The result reads abnormal' };
  return null;
}

// ---------------------------------------------------------------------------
// A chart said in words, for a chart with nothing to draw
// ---------------------------------------------------------------------------

export interface ChartWordsItem {
  /** The point's date or label as given. */
  x: string;
  /** The point's own label, else its number with the series' unit. */
  text: string;
  flag: string | null;
  href: string | null;
}

/** The points of a chart as text (date and value), for a chart that is not drawn. */
export function chartWords(spec: Pick<ChartSpec, 'series'> | null | undefined): ChartWordsItem[] {
  const out: ChartWordsItem[] = [];
  const series = Array.isArray(spec?.series) ? spec.series : [];
  for (const s of series) {
    for (const p of Array.isArray(s?.points) ? s.points : []) {
      const label = typeof p?.label === 'string' ? p.label.trim() : '';
      const num = typeof p?.y === 'number' && Number.isFinite(p.y) ? `${p.y}${s.unit ? ` ${s.unit}` : ''}` : '';
      const text = label || num;
      if (!text) continue;
      out.push({ x: String(p.x ?? ''), text, flag: p.flag ?? null, href: p.href ?? null });
    }
  }
  return out;
}
