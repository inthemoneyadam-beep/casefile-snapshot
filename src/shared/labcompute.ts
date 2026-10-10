/**
 * Computed lab values (2026-10-09): a value the patient works out from values printed on lab reports, such as
 * the albumin index (CSF albumin over serum albumin), which a lab rarely prints without the paired serum.
 *
 * Pure (no server, no React): the formulas, the fixed unit table, the arithmetic, the pairing window, the words, the
 * check of a printed index against a computed one, and how a stored computed value finds out that an input changed.
 * The server (services/lab-compute.ts) and the browser read the same rules.
 *
 * Rules (lead's corrections D1-D9):
 * - Inputs are values printed on a lab report (role printed): never a summary's claim, a value typed by hand, another
 *   computed value, or a document not sorted yet. A limit ("<3") or words cannot be used. A flag on an input is shown,
 *   never used.
 * - Units convert only by the fixed table below (powers of ten within a mass per volume); an input whose unit is not
 *   in its slot's table is refused, by name. The conversion used is said.
 * - Every input needs a collection date (a resulted date is not one, rule 7) to the day. A CSF and blood pair may be
 *   up to 48 hours apart; other inputs share one collection day. The gap is said.
 * - The result is stored at full precision and shown the way labs print the index (albumin index 1 decimal, IgG index
 *   2). It is never red, never judged by a range, never counted out of range.
 * - The app never computes one by itself: only the user's own action, or his yes to the clinician's proposal.
 */
import { fmtNum, parseLabValue, unitKey } from './labvalues';

/** lab_results.raw_source of a computed value. */
export const COMPUTED_SOURCE = 'computed';
/** The finding rule: a printed index differs from the one computed for the same collection (worded like rule 12). */
export const COMPUTED_DIFFERS_RULE = 'lab_computed_differs';
/** The filings row of the clinician's proposal to compute a value (it always waits for the user's yes). */
export const COMPUTE_TARGET = 'lab_compute';
export const COMPUTE_ACTION = 'compute';
/** The setting that holds the ranges the patient typed, by the computed test's key. */
export const COMPUTED_RANGES_SETTING = 'labs.computedRanges';
/** Who computes when no name is on record. */
export const DEFAULT_COMPUTER = 'you';
/** The window of a CSF and blood pair, in minutes. */
export const PAIR_WINDOW_MINUTES = 48 * 60;
/** The record's own version (parse_json.computed.v). */
export const COMPUTED_RECORD_VERSION = 1;

export type FormulaId = 'albumin_index' | 'igg_index' | 'ratio';
export const FORMULA_IDS: readonly FormulaId[] = ['albumin_index', 'igg_index', 'ratio'];

/** A sample as the pairing reads it. */
export type SampleGroup = 'csf' | 'blood' | 'other';

export interface FormulaSlot {
  id: string;
  /** "CSF albumin" */
  label: string;
  /** The tests it takes (analyte keys, src/shared/analytes.ts); empty: any test (the general formula). */
  keys: readonly string[];
  /** The samples it takes; empty: any sample. */
  samples: readonly string[];
  /** The unit the formula reads it in; null: as printed, no conversion (the general formula). */
  target: string | null;
  /** The units it accepts (as printed), each by its key. Empty with target null: any unit. */
  units: readonly string[];
}

export interface Formula {
  id: FormulaId;
  version: number;
  /** "Albumin index" */
  name: string;
  /** "CSF albumin (mg/dL) divided by serum albumin (g/dL)" */
  expression: string;
  /** The test the result is filed under; null: the name the user types (the general formula). */
  analyte: string | null;
  /** The sample of the result; null: the first input's. */
  specimen: 'csf' | null;
  /** Decimals shown; null: the user chooses (the general formula). */
  decimals: number | null;
  slots: readonly FormulaSlot[];
}

const SERUM = ['serum', 'plasma'] as const;

/**
 * The fixed unit table (D2): each unit's size in mg/dL. Only these convert, by these factors: mg/dL to g/dL divides by
 * 1000, g/L to g/dL divides by 10, mg/L to mg/dL divides by 10; IgG the same.
 */
export const MASS_UNITS: Readonly<Record<string, { shown: string; mgPerDl: number }>> = Object.freeze({
  'g/dl': { shown: 'g/dL', mgPerDl: 1000 },
  'g/l': { shown: 'g/L', mgPerDl: 100 },
  'mg/dl': { shown: 'mg/dL', mgPerDl: 1 },
  'mg/l': { shown: 'mg/L', mgPerDl: 0.1 },
});

export const FORMULAS: Readonly<Record<FormulaId, Formula>> = Object.freeze({
  albumin_index: {
    id: 'albumin_index',
    version: 1,
    name: 'Albumin index',
    expression: 'CSF albumin (mg/dL) divided by serum albumin (g/dL)',
    analyte: 'Albumin index',
    specimen: 'csf',
    decimals: 1,
    slots: [
      { id: 'csf_albumin', label: 'CSF albumin', keys: ['csf albumin'], samples: ['csf'], target: 'mg/dl', units: ['mg/dl', 'mg/l'] },
      { id: 'serum_albumin', label: 'Serum albumin', keys: ['albumin'], samples: SERUM, target: 'g/dl', units: ['g/dl', 'g/l', 'mg/dl'] },
    ],
  },
  igg_index: {
    id: 'igg_index',
    version: 1,
    name: 'IgG index',
    expression: '(CSF IgG divided by serum IgG) divided by (CSF albumin divided by serum albumin), every input in mg/dL',
    analyte: 'IgG index',
    specimen: 'csf',
    decimals: 2,
    slots: [
      { id: 'csf_igg', label: 'CSF IgG', keys: ['csf igg'], samples: ['csf'], target: 'mg/dl', units: ['mg/dl', 'mg/l'] },
      { id: 'serum_igg', label: 'Serum IgG', keys: ['igg'], samples: SERUM, target: 'mg/dl', units: ['mg/dl', 'g/dl', 'g/l'] },
      { id: 'csf_albumin', label: 'CSF albumin', keys: ['csf albumin'], samples: ['csf'], target: 'mg/dl', units: ['mg/dl', 'mg/l'] },
      { id: 'serum_albumin', label: 'Serum albumin', keys: ['albumin'], samples: SERUM, target: 'mg/dl', units: ['g/dl', 'g/l', 'mg/dl'] },
    ],
  },
  ratio: {
    id: 'ratio',
    version: 1,
    name: 'A divided by B, times k',
    expression: 'A divided by B, times k (units as printed; you type the unit of the result)',
    analyte: null,
    specimen: null,
    decimals: null,
    slots: [
      { id: 'a', label: 'A (top)', keys: [], samples: [], target: null, units: [] },
      { id: 'b', label: 'B (bottom)', keys: [], samples: [], target: null, units: [] },
    ],
  },
});

export function formulaOf(id: string | null | undefined): Formula | null {
  return id && Object.prototype.hasOwnProperty.call(FORMULAS, id) ? FORMULAS[id as FormulaId] : null;
}

export function sampleGroup(specimen: string | null | undefined): SampleGroup {
  if (specimen === 'csf') return 'csf';
  if (specimen === 'serum' || specimen === 'plasma' || specimen === 'whole_blood') return 'blood';
  return 'other';
}

const SAMPLE_WORD: Record<SampleGroup, string> = { csf: 'CSF', blood: 'serum', other: 'sample' };

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** n times 10^k by its decimal text, exponent form included ("1e-7", "1.5e+21"): never NaN for a finite n. */
function shiftDecimal(n: number, k: number): number {
  const [m, e = '0'] = String(n).split('e');
  return Number(`${m}e${Number(e) + k}`);
}

/** x rounded half away from zero to d decimals, as a number (decimal arithmetic on the shortest text, never 1.005 -> 1.00). */
export function roundTo(x: number, d: number): number {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const r = Math.round(shiftDecimal(Math.abs(x), d));
  return sign * shiftDecimal(r, -d);
}

/** x shown with exactly d decimals ("6.6", "0.52", "12"). */
export function fixedText(x: number, d: number): string {
  return roundTo(x, d).toFixed(d);
}

/** A number for words ("4.12", "6.553398"): integers as they are, else up to 6 decimals. */
export function numberWords(n: number): string {
  return fmtNum(n);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export interface Conversion {
  /** The value as read in the formula's unit. */
  value: number;
  /** The unit as printed and the unit the formula reads it in (null: no conversion). */
  from: string | null;
  to: string | null;
  /** to = from x factor. */
  factor: number;
  /** "4120 mg/dL = 4.12 g/dL (divided by 1000)", "27 mg/dL (no conversion)". */
  words: string;
}

function factorWords(factor: number): string {
  if (factor === 1) return 'no conversion';
  if (factor > 1) return `times ${numberWords(factor)}`;
  return `divided by ${numberWords(Number((1 / factor).toPrecision(12)))}`;
}

/**
 * An input read in its slot's unit by the fixed table, or why not (the unit is not in the slot's table, or none is
 * printed). The general formula takes the value as printed.
 */
export function convertInput(slot: FormulaSlot, value: number, unit: string | null | undefined): { ok: true; conversion: Conversion } | { ok: false; reason: string } {
  const shownUnit = unit && unit.trim() ? unit.trim() : null;
  if (!slot.target) {
    return { ok: true, conversion: { value, from: shownUnit, to: shownUnit, factor: 1, words: `${numberWords(value)}${shownUnit ? ` ${shownUnit}` : ''} (as printed)` } };
  }
  const takes = slot.units.map((k) => MASS_UNITS[k]?.shown ?? k).join(', ');
  if (!shownUnit) return { ok: false, reason: `No unit is printed with it; ${slot.label} is read in ${takes}.` };
  const key = unitKey(shownUnit);
  if (!key || !slot.units.includes(key) || !MASS_UNITS[key]) return { ok: false, reason: `The unit "${shownUnit}" is not one this formula converts; ${slot.label} is read in ${takes}.` };
  const from = MASS_UNITS[key];
  const to = MASS_UNITS[slot.target];
  // Exact decimal steps: the sizes are powers of ten, so value x from / to is cleaned to 15 significant digits.
  const out = Number(((value * from.mgPerDl) / to.mgPerDl).toPrecision(15));
  const factor = Number((from.mgPerDl / to.mgPerDl).toPrecision(15));
  const words = factor === 1 ? `${numberWords(value)} ${shownUnit} (no conversion)` : `${numberWords(value)} ${shownUnit} = ${numberWords(out)} ${to.shown} (${factorWords(factor)})`;
  return { ok: true, conversion: { value: out, from: shownUnit, to: to.shown, factor, words } };
}

// ---------------------------------------------------------------------------
// Dates and the pairing window
// ---------------------------------------------------------------------------

/**
 * The time of day printed in a date text, in minutes after midnight: "09:41", "9:41 AM", "2215" after a date ("07/14/30
 * 2215"), "T09:41"; null when none is printed.
 */
export function timeOfDay(text: string | null | undefined): number | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const colon = t.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?\s*(?:[Mm]\.?)?(?![\d])/);
  if (colon) {
    let h = Number(colon[1]);
    const m = Number(colon[2]);
    const ap = colon[3]?.toLowerCase();
    if (m > 59) return null;
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap === 'p' && h !== 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
    } else if (h > 23) return null;
    return h * 60 + m;
  }
  // A four-digit time after a printed date ("07/14/30 2215", "7/14/2030 1745"): never a year (DECISIONS 2026-10-07).
  const four = t.match(/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\s+(\d{2})(\d{2})(?!\d)/);
  if (four) {
    const h = Number(four[1]);
    const m = Number(four[2]);
    if (h <= 23 && m <= 59) return h * 60 + m;
  }
  return null;
}

export interface PairPoint {
  label: string;
  sample: SampleGroup;
  /** YYYY-MM-DD */
  day: string;
  minutes: number | null;
}

export interface Pairing {
  ok: boolean;
  /** 'pair': a CSF and blood pair (up to 48 hours); 'same_day': one collection day. */
  window: 'pair' | 'same_day';
  timesKnown: boolean;
  /** Earliest to latest, when every input prints a time. */
  gapMinutes: number | null;
  /** Calendar days between the earliest and the latest day. */
  gapDays: number;
  /** "serum drawn 2 h 10 min after CSF" */
  words: string;
  reason: string | null;
}

function dayNumber(day: string): number {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : Number.NaN;
}

/** "2 h 10 min", "45 min", "1 day 3 h", "2 days". */
export function durationWords(minutes: number): string {
  const m = Math.abs(Math.round(minutes));
  if (m < 60) return `${m} min`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} h`);
  if (mins && !days) parts.push(`${mins} min`);
  return parts.join(' ') || '0 min';
}

function absolute(p: PairPoint): number {
  return dayNumber(p.day) * 1440 + (p.minutes ?? 0);
}

/**
 * Do the inputs share one collection: a CSF and blood pair within 48 hours (D4), any other set on one day. With every
 * time printed the gap is exact; without, the dates decide (a day is 24 hours) and the words say no times were
 * printed.
 */
export function pairInputs(points: readonly PairPoint[]): Pairing {
  const groups = new Set(points.map((p) => p.sample));
  const window: Pairing['window'] = groups.has('csf') && groups.has('blood') ? 'pair' : 'same_day';
  const days = points.map((p) => dayNumber(p.day));
  const timesKnown = points.length > 0 && points.every((p) => p.minutes != null);
  if (!points.length || days.some((d) => !Number.isFinite(d))) return { ok: false, window, timesKnown, gapMinutes: null, gapDays: 0, words: '', reason: 'Every input needs a collection date.' };
  const gapDays = Math.max(...days) - Math.min(...days);
  const gapMinutes = timesKnown ? Math.max(...points.map(absolute)) - Math.min(...points.map(absolute)) : null;
  const words = gapWords(points, timesKnown, gapMinutes, gapDays);
  // Values from one fluid come from one collection date (the rule: inputs must come from the same collection date): the
  // IgG index's CSF IgG and CSF albumin share a day, and so do its serum IgG and serum albumin; only a CSF and blood pair
  // may be apart, up to 48 hours.
  if (window === 'pair') {
    for (const g of ['csf', 'blood'] as const) {
      const own = [...new Set(points.filter((p) => p.sample === g).map((p) => p.day))].sort();
      if (own.length > 1) return { ok: false, window, timesKnown, gapMinutes, gapDays, words, reason: `The ${SAMPLE_WORD[g]} values come from different days (${own.join(' and ')}); values from one sample must come from the same collection date.` };
    }
    const span = gapMinutes ?? gapDays * 1440;
    if (span > PAIR_WINDOW_MINUTES) {
      return { ok: false, window, timesKnown, gapMinutes, gapDays, words, reason: `The inputs are ${gapMinutes != null ? durationWords(gapMinutes) : `${gapDays} days`} apart${timesKnown ? '' : ' (no times printed)'}; a CSF and serum pair may be at most 48 hours apart.` };
    }
  } else if (gapDays > 0) {
    const list = [...new Set(points.map((p) => p.day))].sort().join(' and ');
    return { ok: false, window, timesKnown, gapMinutes, gapDays, words, reason: `The inputs come from different days (${list}); they must come from the same collection date.` };
  }
  return { ok: true, window, timesKnown, gapMinutes, gapDays, words, reason: null };
}

function gapWords(points: readonly PairPoint[], timesKnown: boolean, gapMinutes: number | null, gapDays: number): string {
  const csf = points.filter((p) => p.sample === 'csf');
  const blood = points.filter((p) => p.sample === 'blood');
  const oneEach = csf.length > 0 && blood.length > 0 && new Set(csf.map(absoluteKey)).size === 1 && new Set(blood.map(absoluteKey)).size === 1;
  if (timesKnown && gapMinutes != null) {
    if (gapMinutes === 0) return 'drawn at the same time';
    if (oneEach) {
      const diff = absolute(blood[0]) - absolute(csf[0]);
      return `${SAMPLE_WORD.blood} drawn ${durationWords(diff)} ${diff > 0 ? 'after' : 'before'} ${SAMPLE_WORD.csf}`;
    }
    return `drawn within ${durationWords(gapMinutes)} of each other`;
  }
  if (gapDays === 0) return 'drawn the same day (no times printed)';
  if (oneEach) {
    const diff = dayNumber(blood[0].day) - dayNumber(csf[0].day);
    return `${SAMPLE_WORD.blood} drawn ${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} ${diff > 0 ? 'after' : 'before'} ${SAMPLE_WORD.csf} (no times printed)`;
  }
  return `drawn within ${gapDays} day${gapDays === 1 ? '' : 's'} of each other (no times printed)`;
}

function absoluteKey(p: PairPoint): string {
  return `${p.day}|${p.minutes ?? ''}`;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What a candidate input must say about itself (a Labs entry as the server lists it). */
export interface InputCandidate {
  id: string;
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  analyteKey: string;
  specimen: string;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  quote: string | null;
  /** The reading's date (collected, else of unknown kind, else resulted). */
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  unit: string | null;
  role: string;
  kind: string;
  measurement: number | null;
  valueShown: string;
  dateKind: string;
  collected: { iso: string | null; precision: string; text: string | null } | null;
  /** The flag as printed ("H", "None printed"): shown, never used. */
  flagShown: string | null;
  lab: string | null;
  /** Set aside (marked wrong, replaced, its detail deleted). */
  setAside: boolean;
  /** Marked inaccurate by the reconciliation (it disagrees with a clinical record). */
  inaccurate: boolean;
}

const ROLE_REFUSAL: Record<string, string> = {
  claimed: 'it is stated in a summary or a note, not printed by the lab',
  typed: 'it was typed by hand, not printed by the lab',
  unclassified: 'its document is not sorted yet, so it is not known to be a lab report',
  computed: 'it is itself a computed value',
};

/** The input's collection date: its collected date, else a date of unknown kind (said); a resulted date is not one. */
export function collectionOf(c: Pick<InputCandidate, 'dateKind' | 'collected' | 'date' | 'datePrecision' | 'dateText'>): { ok: true; day: string; text: string | null; kind: 'collected' | 'unknown'; minutes: number | null } | { ok: false; reason: string } {
  let iso: string | null = null;
  let precision = 'unknown';
  let text: string | null = null;
  let kind: 'collected' | 'unknown' = 'collected';
  if (c.dateKind === 'collected' && c.collected && (c.collected.iso || c.collected.text)) {
    iso = c.collected.iso;
    precision = c.collected.precision;
    text = c.collected.text;
  } else if (c.dateKind === 'unknown' && (c.date || c.dateText)) {
    iso = c.date;
    precision = c.datePrecision;
    text = c.dateText;
    kind = 'unknown';
  } else if (c.dateKind === 'resulted') {
    return { ok: false, reason: 'Only the date the result came back is printed; that is not when the sample was collected.' };
  } else {
    return { ok: false, reason: 'No collection date is on record for it.' };
  }
  if (!iso || precision !== 'day' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { ok: false, reason: `Its date is not a whole day${text ? ` ("${text}")` : ''}; a computed value needs the day of collection.` };
  return { ok: true, day: iso, text, kind, minutes: timeOfDay(text) };
}

/**
 * Why a value cannot be one of a formula's inputs, in plain words; null when it can. `slot` checks the test and sample
 * too (the picker lists only matching tests; the API may be sent anything).
 */
export function inputProblem(slot: FormulaSlot, c: InputCandidate): string | null {
  if (slot.keys.length && !slot.keys.includes(c.analyteKey)) return `This is ${c.analyte}, not ${slot.label}.`;
  if (slot.samples.length && !slot.samples.includes(c.specimen)) return `This value is from a ${c.specimen === 'csf' ? 'CSF' : c.specimen.replace(/_/g, ' ')} sample; ${slot.label} is not.`;
  if (c.role !== 'printed') return `Only values printed on a lab report can be used: ${ROLE_REFUSAL[c.role] ?? 'it is not a printed lab value'}.`;
  if (c.setAside) return 'It is set aside (marked wrong, replaced by a newer reading, or its detail was deleted).';
  if (c.inaccurate) return 'It disagrees with a clinical record (see Reconciliation), so it is not used.';
  if (c.kind === 'censored') return `"${c.valueShown}" is a limit, not a measurement; it cannot be used.`;
  if (c.kind !== 'number' || c.measurement == null || !Number.isFinite(c.measurement)) return `"${c.valueShown || 'no value'}" is not a number; it cannot be used.`;
  if (!c.documentId || c.pageNumber == null) return 'No page is on record for it, so it cannot be cited.';
  const conv = convertInput(slot, c.measurement, c.unit);
  if (!conv.ok) return conv.reason;
  const when = collectionOf(c);
  if (!when.ok) return when.reason;
  return null;
}

// ---------------------------------------------------------------------------
// The stored record (lab_results.parse_json.computed)
// ---------------------------------------------------------------------------

export interface ComputedInput {
  slot: string;
  slotLabel: string;
  /** The Labs entry id it was ("<row id>", "fact:<id>", with "#n" for one test of a line). */
  entryId: string;
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  analyteKey: string;
  specimen: string;
  valueShown: string;
  value: number;
  unit: string | null;
  conversion: Conversion;
  date: { day: string; text: string | null; kind: 'collected' | 'unknown'; minutes: number | null };
  /** As printed beside it: shown, never used. */
  flagShown: string | null;
  lab: string | null;
  citation: { citationId: string | null; documentId: string; documentTitle: string | null; page: number; quote: string | null; verified: boolean };
}

export interface ComputedRecord {
  v: number;
  formula: { id: FormulaId; version: number; name: string; expression: string; k: number | null; unit: string | null; decimals: number };
  result: { full: number; shown: string; decimals: number };
  inputs: ComputedInput[];
  pairing: Pick<Pairing, 'window' | 'timesKnown' | 'gapMinutes' | 'gapDays' | 'words'>;
  by: { name: string; at: string; via: 'labs' | 'clinician'; proposalId: string | null };
  /** "Computed by you from p.2 and p.3" */
  label: string;
}

/** "Computed by you from p.2 and p.3" (each page once; more pages for four inputs). */
export function computedLabel(inputs: ReadonlyArray<Pick<ComputedInput, 'citation'>>, by: string = DEFAULT_COMPUTER): string {
  const seen = new Set<string>();
  const pages: string[] = [];
  for (const i of inputs) {
    const k = `${i.citation.documentId}|${i.citation.page}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pages.push(`p.${i.citation.page}`);
  }
  const list = pages.length <= 1 ? (pages[0] ?? 'its inputs') : `${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`;
  return `Computed by ${by || DEFAULT_COMPUTER} from ${list}`;
}

/** The document titles behind the label, for its hover ("p.2: Lab report 2030-07-14; p.3: Serum panel"). */
export function computedTitle(inputs: ReadonlyArray<Pick<ComputedInput, 'citation' | 'slotLabel'>>): string {
  return inputs.map((i) => `${i.slotLabel}: ${i.citation.documentTitle ?? 'a document'}, p.${i.citation.page}`).join('\n');
}

/** A record read back from parse_json; null when it is not one. */
export function readComputedRecord(parseJson: unknown): ComputedRecord | null {
  const pj = typeof parseJson === 'string' ? safeJson(parseJson) : parseJson;
  const c = pj && typeof pj === 'object' ? (pj as { computed?: unknown }).computed : null;
  if (!c || typeof c !== 'object') return null;
  const r = c as Partial<ComputedRecord>;
  if (!r.formula || !r.result || !Array.isArray(r.inputs) || typeof r.result.full !== 'number') return null;
  return r as ComputedRecord;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/** The result at full precision from the inputs in the formula's units, or why not (a zero to divide by). */
export function computeValue(formula: Formula, values: Readonly<Record<string, number>>, k: number | null): { ok: true; value: number } | { ok: false; reason: string } {
  const need = (id: string) => values[id];
  const divide = (a: number, b: number, what: string): number | string => (b === 0 ? `${what} is 0; nothing can be divided by 0.` : a / b);
  let out: number | string;
  if (formula.id === 'albumin_index') out = divide(need('csf_albumin'), need('serum_albumin'), 'Serum albumin');
  else if (formula.id === 'igg_index') {
    const igg = divide(need('csf_igg'), need('serum_igg'), 'Serum IgG');
    const alb = divide(need('csf_albumin'), need('serum_albumin'), 'Serum albumin');
    out = typeof igg === 'string' ? igg : typeof alb === 'string' ? alb : alb === 0 ? 'CSF albumin is 0; nothing can be divided by 0.' : igg / alb;
  } else {
    if (k == null || !Number.isFinite(k)) return { ok: false, reason: 'Type k (1 when nothing is to be multiplied).' };
    const ratio = divide(need('a'), need('b'), 'B');
    out = typeof ratio === 'string' ? ratio : ratio * k;
  }
  if (typeof out === 'string') return { ok: false, reason: out };
  if (!Number.isFinite(out)) return { ok: false, reason: 'The result is not a number.' };
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// A printed index beside the computed one (D5)
// ---------------------------------------------------------------------------

/**
 * A printed value of the same index against the computed one, at the printed value's own precision: "6.5" printed and
 * 6.553 computed differ (6.6 at one decimal); "6.6" and 6.553 do not. Null when the printed value is not a number
 * (a limit, words): not compared.
 */
export function printedComparison(full: number, printed: string): { differs: boolean; decimals: number; computedAtPrecision: string } | null {
  const v = parseLabValue(printed);
  if (v.kind !== 'number' || v.number == null) return null;
  const d = v.decimals ?? 0;
  const mine = roundTo(full, d);
  return { differs: Math.abs(mine - roundTo(v.number, d)) > 1e-9 * Math.max(1, Math.abs(mine)), decimals: d, computedAtPrecision: fixedText(full, d) };
}

/** Units that only say a value is a ratio or an index (an index has no unit): an index computed with no unit meets them. */
export const INDEX_UNIT_WORDS: ReadonlySet<string> = new Set(['ratio', 'index']);

/**
 * May a printed value be set beside a computed one and compared with it (D5): the same unit, or no unit or only a ratio
 * word on both sides. "60 %" printed is never compared with a ratio of 0.6 computed with no unit (rule 5: nothing is
 * relabelled or converted here).
 */
export function comparableUnits(computedUnit: string | null | undefined, printedUnit: string | null | undefined): boolean {
  const a = unitKey(computedUnit) ?? '';
  const b = unitKey(printedUnit) ?? '';
  if (a === b) return true;
  const bare = (k: string) => !k || INDEX_UNIT_WORDS.has(k);
  return bare(a) && bare(b);
}

// ---------------------------------------------------------------------------
// An input that changed since (D7)
// ---------------------------------------------------------------------------

/** What the check needs of a Labs entry now. */
export interface CurrentEntry {
  id: string;
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  date: string | null;
  unit: string | null;
  valueShown: string;
  role: string;
  setAside: boolean;
  /** The test and sample it reads now (an input renamed to another test, or moved to another sample, changed). */
  analyteKey?: string;
  specimen?: string;
}

function partIndex(id: string): string {
  const i = id.indexOf('#');
  return i >= 0 ? id.slice(i) : '';
}

/** The entry an input was, now: by its id; a value Claude read and since copied into the lab list by its detail (and part). */
export function findInput(input: Pick<ComputedInput, 'entryId' | 'labResultId' | 'factId'>, entries: ReadonlyMap<string, CurrentEntry> | readonly CurrentEntry[]): CurrentEntry | null {
  const list = Array.isArray(entries) ? (entries as readonly CurrentEntry[]) : [...(entries as ReadonlyMap<string, CurrentEntry>).values()];
  const byId = Array.isArray(entries) ? null : (entries as ReadonlyMap<string, CurrentEntry>);
  const direct = byId ? byId.get(input.entryId) : list.find((e) => e.id === input.entryId);
  if (direct) return direct;
  const part = partIndex(input.entryId);
  if (input.factId) {
    const same = list.filter((e) => e.factId === input.factId && partIndex(e.id) === part);
    // A live copy first (a set-aside one says the input was set aside).
    return same.find((e) => !e.setAside) ?? same[0] ?? null;
  }
  if (input.labResultId) return list.find((e) => e.labResultId === input.labResultId && partIndex(e.id) === part) ?? null;
  return null;
}

/** Each input that changed since the value was computed, in words; empty when none did. Never recomputed here. */
export function inputChanges(record: ComputedRecord, entries: ReadonlyMap<string, CurrentEntry> | readonly CurrentEntry[]): string[] {
  const out: string[] = [];
  for (const i of record.inputs) {
    const now = findInput(i, entries);
    const what = `${i.slotLabel} (p.${i.citation.page})`;
    if (!now) {
      out.push(`${what}: no longer listed (deleted, or its document was removed or set aside).`);
      continue;
    }
    if (now.setAside) {
      out.push(`${what}: marked wrong, or replaced by a newer reading.`);
      continue;
    }
    if (now.role !== 'printed') {
      out.push(`${what}: no longer counted as printed by a lab report.`);
      continue;
    }
    const was = `${i.valueShown}${i.unit ? ` ${i.unit}` : ''}`;
    const is = `${now.valueShown}${now.unit ? ` ${now.unit}` : ''}`;
    if (now.valueShown.trim() !== i.valueShown.trim() || (unitKey(now.unit) ?? '') !== (unitKey(i.unit) ?? '')) out.push(`${what}: now reads ${is || 'no value'} (was ${was}).`);
    else if (!now.date) out.push(`${what}: it has no date now (was ${i.date.day}).`);
    else if (now.date !== i.date.day) out.push(`${what}: its date now reads ${now.date} (was ${i.date.day}).`);
    else if (now.analyteKey != null && now.analyteKey !== i.analyteKey) out.push(`${what}: it is now listed as ${now.analyte} (was ${i.analyte}).`);
    else if (now.specimen != null && now.specimen !== i.specimen) out.push(`${what}: its sample now reads ${now.specimen === 'csf' ? 'CSF' : now.specimen.replace(/_/g, ' ')} (was ${i.specimen === 'csf' ? 'CSF' : i.specimen.replace(/_/g, ' ')}).`);
  }
  return out;
}

/** The words on a computed value whose input changed. */
export const INPUT_CHANGED = 'input changed: compute again';

// ---------------------------------------------------------------------------
// The range the patient types (D6)
// ---------------------------------------------------------------------------

export interface TypedRange {
  low: number | null;
  high: number | null;
  /** Who typed it (the session user's name, or "you"). */
  by: string;
  at: string;
}

/** "range typed by you" (exactly, when no name is on record). */
export function typedRangeLabel(r: Pick<TypedRange, 'by'> | null | undefined): string {
  return `range typed by ${r?.by || DEFAULT_COMPUTER}`;
}

/** "4.0 to 9.0", "up to 9.0", "from 4.0". */
export function typedRangeWords(r: Pick<TypedRange, 'low' | 'high'>): string {
  if (r.low != null && r.high != null) return `${numberWords(r.low)} to ${numberWords(r.high)}`;
  if (r.high != null) return `up to ${numberWords(r.high)}`;
  if (r.low != null) return `from ${numberWords(r.low)}`;
  return '';
}

// ---------------------------------------------------------------------------
// The view the Labs page receives on a computed entry
// ---------------------------------------------------------------------------

export interface PrintedBeside {
  entryId: string;
  valueShown: string;
  unit: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  /** Differs from the computed value at the printed precision. */
  differs: boolean;
  /** The computed value at the printed precision ("6.6"). */
  computedAtPrecision: string;
}

export interface ComputedView {
  record: ComputedRecord;
  /** Inputs that changed since (empty: none). */
  changes: string[];
  /** The lab's own printed value of the same index, same collection day. */
  printed: PrintedBeside[];
  /**
   * Each input's Labs entry id now, by slot (a value Claude read, "fact:<id>", is a row id once copied into the lab
   * list): "Compute again" opens the formula with these. Null: the input is no longer listed.
   */
  inputIds?: Record<string, string | null>;
}

/** What marking needs of a Labs entry (services/labs.ts LabEntry has all of it). */
export interface MarkableEntry {
  id: string;
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  analyteKey: string;
  specimen?: string;
  date: string | null;
  unit: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  reading: { role: string; valueShown: string; collected?: { iso: string | null } | null; resulted?: { iso: string | null } | null };
  computed?: ComputedView;
}

/** The days a value can be matched on: its own date, its collected and its resulted days. */
function daysOfEntry(e: MarkableEntry): Set<string> {
  const out = new Set<string>();
  for (const d of [e.date, e.reading.collected?.iso, e.reading.resulted?.iso]) if (d) out.add(d.slice(0, 10));
  return out;
}

/** The day a computed value stands for: its first input's collection day. */
export function computedDay(record: ComputedRecord, fallback: string | null): string | null {
  return record.inputs[0]?.date.day ?? fallback;
}

/**
 * Each computed entry told, from the entries listed now, which of its inputs changed since (never recomputed) and
 * which printed values of the same index the lab gives for the same collection day (D5: shown beside it). In place.
 */
export function markComputedEntries<T extends MarkableEntry>(entries: T[], setAside: (e: T) => boolean): void {
  const computed = entries.filter((e) => e.computed);
  if (!computed.length) return;
  const current = new Map<string, CurrentEntry>();
  for (const e of entries) {
    current.set(e.id, { id: e.id, labResultId: e.labResultId, factId: e.factId, analyte: e.analyte, analyteKey: e.analyteKey, ...(e.specimen != null ? { specimen: e.specimen } : {}), date: e.date, unit: e.unit, valueShown: e.reading.valueShown, role: e.reading.role, setAside: setAside(e) });
  }
  const printedByKey = new Map<string, T[]>();
  for (const e of entries) {
    if (e.reading.role !== 'printed' || setAside(e)) continue;
    const list = printedByKey.get(e.analyteKey) ?? [];
    list.push(e);
    printedByKey.set(e.analyteKey, list);
  }
  for (const e of computed) {
    const record = e.computed!.record;
    const day = computedDay(record, e.date);
    const printed: PrintedBeside[] = [];
    for (const p of printedByKey.get(e.analyteKey) ?? []) {
      if (!day || !daysOfEntry(p).has(day) || !comparableUnits(e.unit, p.unit)) continue;
      const cmp = printedComparison(record.result.full, p.reading.valueShown);
      if (!cmp) continue;
      printed.push({ entryId: p.id, valueShown: p.reading.valueShown, unit: p.unit, documentId: p.documentId, documentTitle: p.documentTitle, pageNumber: p.pageNumber, differs: cmp.differs, computedAtPrecision: cmp.computedAtPrecision });
    }
    const inputIds: Record<string, string | null> = {};
    for (const i of record.inputs) inputIds[i.slot] = findInput(i, current)?.id ?? null;
    e.computed = { record, changes: inputChanges(record, current), printed, inputIds };
  }
}
