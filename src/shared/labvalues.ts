/**
 * Lab values as printed, and as read (the user's 12 rules, 2026-10). One pure module, shared by the server and the browser:
 * it parses a value, a reference range, a flag and a unit exactly as printed, never edits the printed text, and builds
 * the one `LabReading` every screen, chart, export and the clinician read.
 *
 * - A value written with a sign ("<3", ">1700", "≤0.02") is a limit, never a measurement: `number` is null, the sign
 *   and the bound are kept apart (rule 2). Words stay words (rule 6).
 * - A range is read into its bounds with their own signs: "<50" is an upper limit of 50 and nothing else, never "-50";
 *   a range the app cannot read is kept as printed and marked, never guessed (rule 3).
 * - A flag is kept as printed ('' blank, '-' dash, "HH"...); "no flag printed" is not "normal"; a flag the app works
 *   out from the value and its own range is always marked as worked out, and a disagreement is a warning (rule 4).
 * - A unit is shown as printed; an exactly repeated unit is shown once; conversions come only from explicit, tested
 *   factors and never relabel a value (rule 5).
 * - A value is judged only against the range printed with it (rule 8); the source's tier decides whether a flag or a
 *   range is the lab's record or a document's claim (rules 11, 12).
 * - Two values of one test, sample and day in one document that differ only by a decimal point, a dropped sign or two
 *   swapped digits are a conflict to show, never to resolve (rule 10); a summary's limit or judgement that differs
 *   from the lab report's is a difference to show (rule 12).
 *
 * No DB, no React, no Node imports: it runs in the browser too.
 */
import { normalizeKey } from './text';
import type { PartialDate } from './dates';

export const LAB_PARSE_VERSION = 1;

export type Comparator = '<' | '<=' | '>' | '>=';
export type ValueKind = 'number' | 'censored' | 'text' | 'range' | 'empty';

export interface ParsedValue {
  /** Exactly as given (not trimmed); null when no text is on record. */
  raw: string | null;
  kind: ValueKind;
  /** 'censored' only: the printed sign, normalised ('≤', '=<', 'up to' -> '<='; '≥', '=>' -> '>='; 'less than' -> '<'). */
  comparator: Comparator | null;
  /** 'number' only: the measured value. Null for every other kind (a limit is not a measurement). */
  number: number | null;
  /** 'censored' only: the limit after the sign ("<3" -> 3). */
  bound: number | null;
  /** 'range' only: a value printed as a range ("10-20" /hpf). */
  low: number | null;
  high: number | null;
  /** 'text' only: the words, trimmed. Never coerced to a number or a boolean. */
  text: string | null;
  /** Decimal places as printed ("0.80" -> 2, "62" -> 0); null when no number. Scientific notation: the mantissa's. */
  decimals: number | null;
  /** Significant digits as printed, without sign, point, leading or trailing zeros ("0.080" -> "8", "3659" -> "3659"). */
  digits: string | null;
  /** A unit printed inside the value ("62 mg/dL" -> "mg/dL"), as printed. */
  unitInValue: string | null;
  /** A flag printed inside the value ("112 H" -> "H", "7.2 (L)" -> "(L)", "60 -" -> "-"), as printed. */
  flagInValue: string | null;
  /** The number as printed ("0.80", "1,200", "-2", "3.4E5"); for 'censored' the bound as printed. Null otherwise. */
  numberText: string | null;
  /** The number was printed in scientific notation ("3.4E5", "3.4 x 10^5"). */
  scientific: boolean;
  /**
   * A lone "L" printed after the number ("2 L"): litres or low. Never read as a flag unless a unit is recorded
   * separately (then it is the flag), never read as a unit. Null otherwise.
   */
  ambiguousTail: string | null;
}

export type RangeStatus = 'parsed' | 'unparsed' | 'none';

export interface ParsedRange {
  raw: string | null;
  status: RangeStatus;
  kind: 'interval' | 'upper' | 'lower' | 'text' | null;
  low: number | null;
  /** '>=' for a printed interval ("0 - 35") or "≥5"; '>' for ">5"; null when unknown (numbers only on record). */
  lowComparator: '>' | '>=' | null;
  high: number | null;
  /** '<=' for a printed interval or "≤0.02"/"<=0.02"; '<' for "<50"; null when unknown. */
  highComparator: '<' | '<=' | null;
  /** kind 'text': the expected answer as printed ("Negative", "Non-reactive"). */
  text: string | null;
  /** A unit printed inside the range ("98-108 mmol/L" -> "mmol/L"). */
  unitInRange: string | null;
  /** Built from stored numbers because no range text is on record (rangeFromNumbers). */
  fromNumbersOnly: boolean;
  /** status 'unparsed': why, in plain words ("several ranges are printed", "a titre range, kept as printed"). */
  reason: string | null;
}

export type FlagState = 'flag' | 'no_flag_printed' | 'not_recorded' | 'not_understood';

export interface ParsedFlag {
  /** Exactly as printed: '' = blank, '-' = dash, 'HH', '(H)', '*'...; null = not recorded. */
  raw: string | null;
  /** What the printed mark means; null when nothing was printed or it was not understood. */
  printed: 'H' | 'L' | 'N' | 'A' | 'C' | null;
  /**
   * The report printed a critical mark: HH, LL, H!, L!, CH, CL, or a word (critical, crit, panic). A bare "C" is not
   * read as critical (some reports use it for "corrected"); it is shown as the report's own letter.
   */
  critical: boolean;
  state: FlagState;
  /** In plain words, for screens: "H", "HH (critical)", "None printed", "Not recorded", "\"Pos\" (not understood)". */
  shown: string;
}

export interface ComputedFlag {
  flag: 'H' | 'L' | 'N' | null;
  /** number: a measurement; limit: a censored value; interval: a value printed as a range. */
  basis: 'number' | 'limit' | 'interval' | null;
  /** The range used, as shown ("98–108", "<50"). */
  against: string | null;
  /** When flag is null: why, in plain words. */
  reason: string | null;
}

export interface ParsedUnit {
  raw: string | null;
  /** Shown: trimmed, inner spaces collapsed, an exactly repeated unit collapsed. Spelling otherwise untouched. */
  unit: string | null;
  /** For equality only, never shown (see unitKey). */
  key: string | null;
  collapsed: boolean;
}

export type LabWarningCode =
  | 'flag_missing_out_of_range' // no flag printed/recorded, value outside its own range
  | 'flag_disagrees' // printed flag says otherwise than the value against its own range
  | 'flag_model_conflict' // the model gave a flag where the page shows none (kept apart by the extraction)
  | 'stored_number_ignored' // a number is stored for a limit or words ("<3" stored with 3)
  | 'stored_number_differs' // a stored number differs from the printed number
  | 'value_read_without_symbol' // the verified quote prints "<3" where the value says "3"
  | 'value_sign_differs_from_page' // the value's sign differs from the sign printed before the same number
  | 'value_not_on_page' // the verified quote does not show the value's number
  | 'unit_not_on_page' // the unit printed next to the number on the page is another unit
  | 'range_unparsed'
  | 'range_numbers_differ' // stored ref_low/ref_high differ from the printed range text
  | 'range_unit_differs' // the range is printed in another unit than the value
  | 'unit_repeated' // "cells/uL cells/uL" collapsed for display
  | 'unit_in_value_differs' // "62 mg/dL" in the value, "g/dL" in the unit field
  | 'date_is_document_date'; // a claimed reading dated on its own document's date

export interface LabWarning {
  code: LabWarningCode;
  /** One plain sentence for the user (no jargon, no internal keys). */
  words: string;
}

/**
 * printed: a clinical record's own (tier primary). claimed: a document that restates results (patient, compilation,
 * external): its flags, ranges and judgements are the document's claims. unclassified: a document not sorted yet
 * (tier unknown): shown neutrally, its printed flag and range mark its own value, never "the record" nor a claim.
 * typed: no document (entered by hand, CSV). computed: worked out by the patient from values printed on lab reports
 * (src/shared/labcompute.ts): never red, never judged by a range, never counted out of range.
 */
export type ReadingRole = 'printed' | 'claimed' | 'unclassified' | 'typed' | 'computed';
export type ReadingDateKind = 'collected' | 'resulted' | 'unknown';

export interface LabReading {
  version: number; // LAB_PARSE_VERSION
  role: ReadingRole;
  value: ParsedValue;
  /** What every screen and the clinician show: the current text (as printed, or the user's own words). Never a re-printed number for a printed value. */
  valueShown: string;
  /**
   * The text as printed (provenance), when on record. When the page's sign was followed (valueFrom 'quote') it is the
   * page's own text ("<3"), never the model's transcription. Show "As printed: …" only for the user's own value.
   */
  valueRaw: string | null;
  valueFrom: 'printed' | 'user' | 'number_only' | 'quote';
  /** valueFrom 'quote' only: the text Claude read where the page prints a sign ("3" for the page's "<3"); null otherwise. */
  valueReadAs: string | null;
  /** The number to plot, compare and judge as a measurement: value.number when kind 'number', else null. */
  measurement: number | null;
  unit: ParsedUnit;
  range: ParsedRange;
  rangeShown: string | null; // formatRange(range)
  flag: ParsedFlag;
  computed: ComputedFlag;
  warnings: LabWarning[];
  /** Each field as printed (provenance: the raw columns, the model's first reading), null when not on record. */
  printed: { value: string | null; unit: string | null; range: string | null; flag: string | null };
  dates: {
    collected: PartialDate | null;
    resulted: PartialDate | null;
    /** When the performing lab received the sample: shown, never the reading's date. */
    received: PartialDate | null;
    document: PartialDate | null;
    /** The date the reading is placed at: collected, else a date of unknown kind, else resulted. */
    reading: PartialDate | null;
    readingKind: ReadingDateKind;
  };
  lab: { name: string | null; key: string | null };
  /** A slot printed with the value (tube 1-4, a time, "repeat"), as written; null when none. */
  sampleLabel: string | null;
  /** role 'claimed' only: the source's own judgement words and the limit it says it used, as written. */
  claim: { interpretation: string | null; limitUsed: string | null } | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Equal within a relative 1e-9. */
export function numbersEqual(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** A number for text the app builds ("15–45", "upper limit 50"): integers as they are, else up to 6 decimals. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function nonBlank(s: string | null | undefined): string | null {
  return typeof s === 'string' && s.trim() ? s : null;
}

function strOrNull(s: unknown): string | null {
  return typeof s === 'string' ? s : null;
}

/**
 * The copy every matcher reads (the printed text is never changed): typographic minus and PDF hyphens -> "-",
 * full-width < > -> < >, ⩽ ⩾ -> ≤ ≥, non-breaking and thin spaces -> space, the long comparator spellings
 * ("> OR = 60", ">/=", "less than or equal to") -> ">=" / "<=", whitespace collapsed, trimmed.
 */
export function matchCopy(s: string): string {
  return s
    .replace(/[‐‑‒−﹣－­]/g, '-')
    .replace(/＜/g, '<')
    .replace(/＞/g, '>')
    .replace(/⩽/g, '≤')
    .replace(/⩾/g, '≥')
    .replace(/[    ]/g, ' ')
    .replace(/greater\s+than\s+or\s+equal\s+to/gi, '>=')
    .replace(/less\s+than\s+or\s+equal\s+to/gi, '<=')
    .replace(/>\s*or\s*=/gi, '>=')
    .replace(/<\s*or\s*=/gi, '<=')
    .replace(/>\s*\/\s*=/g, '>=')
    .replace(/<\s*\/\s*=/g, '<=')
    .replace(/([<>])\s+=(?![<>=])/g, '$1=')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A number as printed: thousands in groups of three only ("5,2" is not a number), an optional decimal part. */
const NUM_SRC = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+`;
const SNUM_SRC = String.raw`-?(?:${NUM_SRC})`;

function numberOf(text: string): number {
  return Number(text.replace(/,/g, ''));
}

/** Decimal places and significant digits of a number as printed ("0.80" -> 2, "8"; "1,200" -> 0, "12"). */
function digitsOf(text: string): { decimals: number; digits: string } {
  const t = text.replace(/^[-+]/, '').replace(/,/g, '');
  const dot = t.indexOf('.');
  const decimals = dot >= 0 ? t.length - dot - 1 : 0;
  const digits = t.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return { decimals, digits: digits || '0' };
}

const COMPARATOR_WORDS: Array<[RegExp, Comparator]> = [
  [/^(?:<=|=<|≤|up to)\s*/i, '<='],
  [/^(?:>=|=>|≥|at least)\s*/i, '>='],
  [/^(?:<|less than|fewer than|below|under)\s*/i, '<'],
  [/^(?:>|greater than|more than|above|over)\s*/i, '>'],
];

function comparatorPrefix(s: string): { comparator: Comparator; rest: string; signText: string } | null {
  for (const [re, c] of COMPARATOR_WORDS) {
    const m = s.match(re);
    if (m) return { comparator: c, rest: s.slice(m[0].length), signText: m[0].trim() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flags printed after a value, units printed after a value
// ---------------------------------------------------------------------------

/** Words that never belong to a unit: a tail holding one is not a unit ("15 raw", "5 repeat 50"). */
const NOT_UNIT_WORDS = new Set([
  'raw', 'corrected', 'uncorrected', 'repeat', 'repeated', 'rpt', 'tube', 'about', 'approx', 'approximately', 'see', 'comment', 'comments', 'note', 'notes',
  'final', 'initial', 'prelim', 'preliminary', 'pre', 'post', 'am', 'pm', 'and', 'or', 'then', 'was', 'were', 'is', 'on', 'at', 'by', 'from', 'to', 'of', 'with',
  'after', 'before', 'previously', 'prior', 'result', 'results', 'value', 'positive', 'negative', 'detected', 'reactive', 'nonreactive', 'non', 'not', 'normal',
  'abnormal', 'high', 'low', 'critical', 'panic', 'pending', 'specimen', 'sample', 'hemolyzed', 'haemolysed', 'clotted', 'qns', 'ref', 'range', 'reference', 'if',
  'than', 'less', 'greater', 'more', 'above', 'below', 'under', 'over', 'up', 'until', 'trace', 'few', 'many', 'rare', 'none', 'seen',
]);

const UNIT_CHARS = /^[A-Za-zµμ%/^*0-9.()²³⁰¹⁴⁵⁶⁷⁸⁹⁻₂°×\- ]+$/;

/** A unit as it can follow a value or a range ("mg/dL", "cells/uL", "x10^3/uL", "%", "mmol/L"). */
export function isUnitToken(t: string): boolean {
  const s = t.trim();
  if (!s || s.length > 40) return false;
  if (!UNIT_CHARS.test(s)) return false;
  if (/^[eE][+-]?\d/.test(s)) return false;
  const tokens = s.split(' ');
  if (tokens.length > 3) return false;
  if (tokens.some((x) => /^[-+]?\d[\d,.]*$/.test(x))) return false;
  if (tokens.some((x) => NOT_UNIT_WORDS.has(x.toLowerCase().replace(/[()]/g, '')))) return false;
  const first = s[0];
  if (/[A-Za-zµμ%]/.test(first)) {
    // "x" or "×" alone opens a count unit only when "10" follows ("x 10^3/uL").
    if (/^[x×]$/i.test(tokens[0]) && !(tokens[1] ?? '').startsWith('10')) return false;
    return true;
  }
  if (first === '/' && /^\/[A-Za-zµμ]/.test(s)) return true;
  if (first === '×' && /^×\s*10/.test(s)) return true;
  if (first === '°' && /^°[A-Za-z]/.test(s)) return true;
  return false;
}

const FLAG_LETTER = /^(?:H|L|N|A|C|HH|LL)$/; // upper case only: "2 l" is never a flag
const FLAG_WORD = /^(?:high|low|hi|lo|abnormal|abn|critical|crit|panic|normal|wnl|critical high|critical low|panic high|panic low|crit high|crit low)$/i;

/** A flag token as it can follow a value: H, L, N, A, C, HH, LL (upper case), "(H)", "[L]", "H*", "*", "!", a flag word, or a dash. */
export function isFlagToken(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  if (/^[-–—]+$/.test(s)) return true;
  if (/^[*!]{1,2}$/.test(s)) return true;
  let core = s;
  const br = core.match(/^\((.*)\)$/) ?? core.match(/^\[(.*)\]$/);
  if (br) core = br[1].trim();
  core = core.replace(/[*!]$/, '').trim();
  if (!core) return false;
  return FLAG_LETTER.test(core) || FLAG_WORD.test(core);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function emptyValue(raw: string | null): ParsedValue {
  return { raw, kind: 'empty', comparator: null, number: null, bound: null, low: null, high: null, text: null, decimals: null, digits: null, unitInValue: null, flagInValue: null, numberText: null, scientific: false, ambiguousTail: null };
}

function textValue(raw: string): ParsedValue {
  return { ...emptyValue(raw), kind: 'text', text: raw.trim() };
}

const SUPERSCRIPT_DIGITS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

/** "E5", "e-3" right after the number; " x 10^5", "×10⁵", "x10E5" after it. Returns the exponent and the rest. */
function scientificTail(rest: string): { exp: number; rest: string } | null {
  let len = 0;
  let expText: string | null = null;
  const e = rest.match(/^[eE]([+-]?\d{1,3})(?![\d.])/);
  const p = e ? null : rest.match(/^\s*[x×*]\s*10\s*(?:\^|\*\*|\*|[eE])\s*([+-]?\d{1,3})(?![\d.])/i);
  const sup = e || p ? null : rest.match(/^\s*[x×*]\s*10([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)/i);
  if (e) {
    len = e[0].length;
    expText = e[1];
  } else if (p) {
    len = p[0].length;
    expText = p[1];
  } else if (sup) {
    len = sup[0].length;
    expText = [...sup[1]].map((c) => SUPERSCRIPT_DIGITS[c]).join('');
  }
  if (expText == null) return null;
  const after = rest.slice(len);
  // "7.2 x10^3/uL": the power belongs to a count unit, not to the number.
  if (/^\s*\//.test(after)) return null;
  const exp = Number(expText);
  return Number.isFinite(exp) ? { exp, rest: after } : null;
}

/** Units that may be printed right against the number ("62mg/dL", "17cmH2O", "4.5g"); anything else stuck to a number is a word ("3rd"). */
const ATTACHED_UNIT = /^(?:[a-zµμ]{0,4}(?:g|l|mol|eq|iu|u)|mmhg|cmh2o|mmh2o|cmh20|fl|secs?|mins?|hrs?|h|x10\S*)$/i;

interface TailRead {
  unitInValue: string | null;
  flagInValue: string | null;
  ambiguousTail: string | null;
}

/** What follows a number: nothing, a flag, a unit, or a unit and then a flag. Null when it is anything else (the value is words). */
function readTail(tail: string): TailRead | null {
  const t = tail.trim();
  if (!t) return { unitInValue: null, flagInValue: null, ambiguousTail: null };
  if (t === 'L') return { unitInValue: null, flagInValue: null, ambiguousTail: 'L' };
  if (isFlagToken(t)) return { unitInValue: null, flagInValue: t, ambiguousTail: null };
  // A unit and then a flag ("62 mg/dL H", "112 mg/dL Critical High") before the whole rest as a unit.
  const tokens = t.split(' ');
  for (const n of [2, 1]) {
    if (tokens.length <= n) continue;
    const flag = tokens.slice(-n).join(' ');
    const unit = tokens.slice(0, -n).join(' ');
    if (isFlagToken(flag) && isUnitToken(unit)) return { unitInValue: unit, flagInValue: flag, ambiguousTail: null };
  }
  if (isUnitToken(t)) return { unitInValue: t, flagInValue: null, ambiguousTail: null };
  return null;
}

/**
 * A value exactly as printed, read. Matching is done on a normalised copy (matchCopy); `raw` is returned untouched.
 * "<3" -> censored '<' 3 (number null); "62" -> number 62; "Negative" -> text; "10-20" -> range; "" or "-" -> empty;
 * "1:160", "1/160", "2+", "+2", "5,2", "15 raw, about 10 corrected" -> text; "3.4E5" -> number 340000.
 */
export function parseLabValue(raw: string | null | undefined): ParsedValue {
  if (raw == null) return emptyValue(null);
  const s = matchCopy(String(raw));
  if (!s) return emptyValue(raw);
  if (/^[-–—]+$/.test(s)) return emptyValue(raw);

  // A value printed as a range ("10-20", "10 - 20 /hpf", "1 to 3").
  const rm = s.match(new RegExp(String.raw`^(${SNUM_SRC})\s*(?:-|–|—|to)\s*(${SNUM_SRC})(?:\s+(.+))?$`, 'i'));
  if (rm) {
    const low = numberOf(rm[1]);
    const high = numberOf(rm[2]);
    const tail = rm[3] ? readTail(rm[3]) : { unitInValue: null, flagInValue: null, ambiguousTail: null };
    if (low <= high && tail && !tail.ambiguousTail) {
      return { ...emptyValue(raw), kind: 'range', low, high, unitInValue: tail.unitInValue, flagInValue: tail.flagInValue };
    }
  }

  const cmp = comparatorPrefix(s);
  const body = cmp ? cmp.rest : s;
  const nm = body.match(new RegExp(String.raw`^(${SNUM_SRC})`));
  if (!nm) return textValue(raw);
  const numberText = nm[1];
  let rest = body.slice(numberText.length);
  let value = numberOf(numberText);
  let scientific = false;
  const sci = scientificTail(rest);
  if (sci) {
    value = Number(`${numberText.replace(/,/g, '')}e${sci.exp}`);
    rest = sci.rest;
    scientific = true;
  }
  if (!Number.isFinite(value)) return textValue(raw);
  // Letters right against the number are a unit only when they look like one ("62mg/dL"); else a word ("3rd").
  if (!scientific && /^[A-Za-zµμ]/.test(rest)) {
    const first = rest.split(' ')[0];
    if (/^(?:st|nd|rd|th)$/i.test(first) || !(first.includes('/') || first.includes('%') || ATTACHED_UNIT.test(first))) return textValue(raw);
  }
  const tail = readTail(rest);
  if (!tail) return textValue(raw);
  const { decimals, digits } = digitsOf(numberText);
  const shown = scientific ? s.slice(cmp ? s.length - body.length : 0, s.length - rest.length).trim() : numberText;
  const base: ParsedValue = {
    ...emptyValue(raw),
    decimals,
    digits,
    numberText: shown,
    scientific,
    unitInValue: tail.unitInValue,
    flagInValue: tail.flagInValue,
    ambiguousTail: tail.ambiguousTail,
  };
  if (cmp) return { ...base, kind: 'censored', comparator: cmp.comparator, bound: value };
  return { ...base, kind: 'number', number: value };
}

/** A stored number with no text on record (kind 'number', raw null). */
export function numberOnlyValue(n: number): ParsedValue {
  const text = fmtNum(n);
  const { decimals, digits } = digitsOf(text);
  return { ...emptyValue(null), kind: 'number', number: n, decimals, digits, numberText: text };
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

function emptyRange(raw: string | null): ParsedRange {
  return { raw, status: 'none', kind: null, low: null, lowComparator: null, high: null, highComparator: null, text: null, unitInRange: null, fromNumbersOnly: false, reason: null };
}

function unparsed(raw: string, reason: string): ParsedRange {
  return { ...emptyRange(raw), status: 'unparsed', reason };
}

const RANGE_LABEL_COLON = /^(?:ref(?:erence)?\.?(?:\s+(?:range|interval|values?))?|normal(?:\s+(?:range|values?))?|range|nl)\s*[:=]\s*/i;
const RANGE_LABEL_SPACE = /^(?:ref(?:erence)?\.?(?:\s+(?:range|interval|values?))?|normal\s+(?:range|values?)|normal|range|nl)\s+(?=[\d<>≤≥=.\-]|less |greater |more |fewer |up to |below |above |under |over |at least )/i;

/** The range text without one pair of wrapping brackets and one leading label ("(ref <35)" -> "<35"). */
function rangeBody(s: string): string {
  let t = s.trim();
  const br = t.match(/^\(([^()]*)\)$/) ?? t.match(/^\[([^[\]]*)\]$/);
  if (br) t = br[1].trim();
  const before = t;
  t = t.replace(RANGE_LABEL_COLON, '');
  if (t === before) t = t.replace(RANGE_LABEL_SPACE, '');
  return t.trim();
}

const EXPECTED_WORDS =
  /^(?:neg(?:ative)?|non[- ]?reactive|not reactive|not detected|none detected|undetectable|absent|normal|clear|colou?rless|clear,? (?:and )?colou?rless|no growth|none seen|not seen|none|nr|nd)$/i;

function unitOrNull(u: string | undefined): { ok: boolean; unit: string | null } {
  if (u == null || !u.trim()) return { ok: true, unit: null };
  return isUnitToken(u) ? { ok: true, unit: u.trim() } : { ok: false, unit: null };
}

/**
 * A reference range exactly as printed, read. "0 - 35" -> interval 0..35 (both inclusive); "<50" -> upper limit 50,
 * strict, no low bound; "≤0.02" -> upper 0.02 inclusive; "≥5" / ">5" -> lower; "Negative" -> the expected answer;
 * anything the app does not read with certainty (a titre, several ranges, "see comment", a single number, "50-0") is
 * 'unparsed' with the reason, kept as printed.
 */
export function parseRefRange(raw: string | null | undefined): ParsedRange {
  if (raw == null) return emptyRange(null);
  const s = rangeBody(matchCopy(String(raw)));
  if (!s || /^[-–—]+$/.test(s)) return emptyRange(raw);

  const iv = s.match(new RegExp(String.raw`^(${SNUM_SRC})\s*(?:-|–|—|to)\s*(${SNUM_SRC})(?:\s*(.+))?$`, 'i'));
  if (iv) {
    const u = unitOrNull(iv[3]);
    if (u.ok) {
      const low = numberOf(iv[1]);
      const high = numberOf(iv[2]);
      if (low > high) return unparsed(raw, 'the lower number is above the upper one');
      return { ...emptyRange(raw), status: 'parsed', kind: 'interval', low, lowComparator: '>=', high, highComparator: '<=', unitInRange: u.unit };
    }
  }
  const up = s.match(new RegExp(String.raw`^(<=|=<|≤|<|less than|fewer than|below|under|up to)\s*(${SNUM_SRC})(?:\s*(.+))?$`, 'i'));
  if (up) {
    const u = unitOrNull(up[3]);
    if (u.ok) {
      const word = up[1].toLowerCase();
      const strict = word === '<' || word === 'less than' || word === 'fewer than' || word === 'below' || word === 'under';
      return { ...emptyRange(raw), status: 'parsed', kind: 'upper', high: numberOf(up[2]), highComparator: strict ? '<' : '<=', unitInRange: u.unit };
    }
  }
  const upWords = s.match(new RegExp(String.raw`^(${SNUM_SRC})(?:\s*(.+?))?\s+or (?:less|below|lower|under)$`, 'i'));
  if (upWords) {
    const u = unitOrNull(upWords[2]);
    if (u.ok) return { ...emptyRange(raw), status: 'parsed', kind: 'upper', high: numberOf(upWords[1]), highComparator: '<=', unitInRange: u.unit };
  }
  const lo = s.match(new RegExp(String.raw`^(>=|=>|≥|>|greater than|more than|above|over|at least)\s*(${SNUM_SRC})(?:\s*(.+))?$`, 'i'));
  if (lo) {
    const u = unitOrNull(lo[3]);
    if (u.ok) {
      const word = lo[1].toLowerCase();
      const strict = word === '>' || word === 'greater than' || word === 'more than' || word === 'above' || word === 'over';
      return { ...emptyRange(raw), status: 'parsed', kind: 'lower', low: numberOf(lo[2]), lowComparator: strict ? '>' : '>=', unitInRange: u.unit };
    }
  }
  const loWords = s.match(new RegExp(String.raw`^(${SNUM_SRC})(?:\s*(.+?))?\s+or (?:more|above|greater|higher)$`, 'i'));
  if (loWords) {
    const u = unitOrNull(loWords[2]);
    if (u.ok) return { ...emptyRange(raw), status: 'parsed', kind: 'lower', low: numberOf(loWords[1]), lowComparator: '>=', unitInRange: u.unit };
  }
  if (EXPECTED_WORDS.test(s)) return { ...emptyRange(raw), status: 'parsed', kind: 'text', text: s };
  if (/\d\s*:\s*\d/.test(s) || /\d\s*\/\s*\d/.test(s)) return unparsed(raw, 'a titre range, kept as printed');
  if (/see (?:comment|note|report|below|above|interpretation)|refer to|comment|varies|age[- ]dependent/i.test(s)) return unparsed(raw, 'the range is given elsewhere on the report');
  const intervals = s.match(new RegExp(String.raw`(?:${NUM_SRC})\s*(?:-|–|—|to)\s*(?:${NUM_SRC})`, 'gi')) ?? [];
  const limits = s.match(new RegExp(String.raw`(?:<=|>=|=<|=>|[<>≤≥])\s*(?:${NUM_SRC})`, 'g')) ?? [];
  if (intervals.length + limits.length >= 2 || /\b(?:m|f|male|female|males|females|men|women|adult|adults|child|children|pediatric|paediatric|infant|newborn)\s*:/i.test(s)) {
    return unparsed(raw, 'several ranges are printed; the right one is not chosen automatically');
  }
  const single = s.match(new RegExp(String.raw`^(${SNUM_SRC})(?:\s*(.+))?$`));
  if (single && unitOrNull(single[2]).ok) return unparsed(raw, 'a single number, not a range');
  return unparsed(raw, 'not a range the app reads');
}

/**
 * A range from stored numbers, when no range text is on record. Both: an interval, both ends inclusive (a stored pair
 * was a "low–high" range). One side only: that side with its sign unknown (comparator null), never shown as "-50".
 */
export function rangeFromNumbers(low: number | null, high: number | null): ParsedRange {
  const lo = typeof low === 'number' && Number.isFinite(low) ? low : null;
  const hi = typeof high === 'number' && Number.isFinite(high) ? high : null;
  const base = { ...emptyRange(null), fromNumbersOnly: true };
  if (lo == null && hi == null) return base;
  if (lo != null && hi != null) {
    if (lo > hi) return { ...base, status: 'unparsed', low: lo, high: hi, reason: 'the lower number is above the upper one' };
    return { ...base, status: 'parsed', kind: 'interval', low: lo, lowComparator: '>=', high: hi, highComparator: '<=' };
  }
  if (hi != null) return { ...base, status: 'parsed', kind: 'upper', high: hi };
  return { ...base, status: 'parsed', kind: 'lower', low: lo };
}

/** The printed range text for display: trimmed, one pair of wrapping brackets and one leading label removed ("ref <50" -> "<50"). */
export function rangeText(r: ParsedRange): string | null {
  if (r.raw == null) return null;
  const t = rangeBody(String(r.raw).replace(/\s+/g, ' ').trim());
  return t || null;
}

/**
 * The range as shown: the printed text when on record (trimmed, a leading "ref"/"reference range" label removed);
 * a printed range the app does not read is quoted and marked: "\"see comment\" (not read as numbers)". From numbers
 * only: "15–45", "<50", "≤50", "upper limit 50", ">5", "≥5", "lower limit 5". Never a "-" or "–" standing for a
 * missing bound. Null for status 'none'.
 */
export function formatRange(r: ParsedRange): string | null {
  if (r.status === 'none') return null;
  if (!r.fromNumbersOnly && r.raw != null) {
    const t = rangeText(r);
    if (!t) return null;
    return r.status === 'unparsed' ? `"${t}" (not read as numbers)` : t;
  }
  if (r.status === 'unparsed') return `low ${fmtNum(r.low ?? NaN)}, high ${fmtNum(r.high ?? NaN)} (not read as a range)`;
  if (r.kind === 'interval' && r.low != null && r.high != null) return r.low < 0 || r.high < 0 ? `${fmtNum(r.low)} to ${fmtNum(r.high)}` : `${fmtNum(r.low)}–${fmtNum(r.high)}`;
  if (r.kind === 'upper' && r.high != null) return r.highComparator === '<' ? `<${fmtNum(r.high)}` : r.highComparator === '<=' ? `≤${fmtNum(r.high)}` : `upper limit ${fmtNum(r.high)}`;
  if (r.kind === 'lower' && r.low != null) return r.lowComparator === '>' ? `>${fmtNum(r.low)}` : r.lowComparator === '>=' ? `≥${fmtNum(r.low)}` : `lower limit ${fmtNum(r.low)}`;
  if (r.kind === 'text') return r.text;
  return null;
}

/** "below 3", "3 or below", "above 1700", "5 or above": the plain words for a limit. Null for anything else. */
export function limitWords(v: ParsedValue): string | null {
  if (v.kind !== 'censored' || v.bound == null) return null;
  const t = v.numberText ?? fmtNum(v.bound);
  switch (v.comparator) {
    case '<':
      return `below ${t}`;
    case '<=':
      return `${t} or below`;
    case '>':
      return `above ${t}`;
    case '>=':
      return `${t} or above`;
    default:
      return null;
  }
}

/**
 * A limit a document says it judged by, as written ("age-adjusted limit 0.8", "upper limit of normal 45 mg/dL",
 * "ULN 40", "cut-off 0.7"): a one-sided bound whose sign is not on record (comparator null unless printed), lower for
 * "lower limit"/"LLN", else upper. A range inside the text ("normal (0.00-0.70)") is read with parseRefRange. Anything
 * else is 'unparsed' ("a limit in words, not read as numbers"); empty is 'none'.
 */
export function parseLimitUsed(text: string | null | undefined): ParsedRange {
  if (text == null || !String(text).trim()) return emptyRange(text == null ? null : String(text));
  const raw = String(text);
  const s = matchCopy(raw);
  const m = s.match(
    new RegExp(
      String.raw`\b(?:(upper|lower)\s+)?(limit|cut-?off|uln|lln|reference limit|reference|threshold)(?:\s+of)?(?:\s+normal)?\s*[:=]?\s*(?:is\s+)?(<=|>=|=<|=>|<|>|≤|≥)?\s*(${SNUM_SRC})(?:\s*([A-Za-zµμ%/][^\s,;)]*))?`,
      'i',
    ),
  );
  if (m) {
    const side = (m[1] ?? '').toLowerCase();
    const word = m[2].toLowerCase();
    const n = numberOf(m[4]);
    const unit = m[5] && isUnitToken(m[5]) ? m[5] : null;
    const sign = m[3] ?? null;
    if (side === 'lower' || word === 'lln') {
      const lc: '>' | '>=' | null = sign === '>' ? '>' : sign === '>=' || sign === '≥' || sign === '=>' ? '>=' : null;
      return { ...emptyRange(raw), status: 'parsed', kind: 'lower', low: n, lowComparator: lc, unitInRange: unit };
    }
    const hc: '<' | '<=' | null = sign === '<' ? '<' : sign === '<=' || sign === '≤' || sign === '=<' ? '<=' : null;
    return { ...emptyRange(raw), status: 'parsed', kind: 'upper', high: n, highComparator: hc, unitInRange: unit };
  }
  const inner = s.match(
    new RegExp(String.raw`(?:${SNUM_SRC})\s*(?:-|–|—|to)\s*(?:${SNUM_SRC})(?:\s*[A-Za-zµμ%/][^\s,;)]*)?|(?:<=|>=|=<|=>|<|>|≤|≥)\s*(?:${SNUM_SRC})(?:\s*[A-Za-zµμ%/][^\s,;)]*)?`, 'i'),
  );
  if (inner) {
    const r = parseRefRange(inner[0]);
    if (r.status === 'parsed') return { ...r, raw };
  }
  return unparsed(raw, 'a limit in words, not read as numbers');
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const FLAG_TABLE: Record<string, { printed: 'H' | 'L' | 'N' | 'A' | 'C'; critical: boolean }> = {
  H: { printed: 'H', critical: false },
  HI: { printed: 'H', critical: false },
  HIGH: { printed: 'H', critical: false },
  'ABOVE HIGH NORMAL': { printed: 'H', critical: false },
  L: { printed: 'L', critical: false },
  LO: { printed: 'L', critical: false },
  LOW: { printed: 'L', critical: false },
  'BELOW LOW NORMAL': { printed: 'L', critical: false },
  HH: { printed: 'H', critical: true },
  CH: { printed: 'H', critical: true },
  'CRITICAL HIGH': { printed: 'H', critical: true },
  'CRIT HIGH': { printed: 'H', critical: true },
  'PANIC HIGH': { printed: 'H', critical: true },
  'HIGH CRITICAL': { printed: 'H', critical: true },
  LL: { printed: 'L', critical: true },
  CL: { printed: 'L', critical: true },
  'CRITICAL LOW': { printed: 'L', critical: true },
  'CRIT LOW': { printed: 'L', critical: true },
  'PANIC LOW': { printed: 'L', critical: true },
  'LOW CRITICAL': { printed: 'L', critical: true },
  N: { printed: 'N', critical: false },
  NL: { printed: 'N', critical: false },
  NORMAL: { printed: 'N', critical: false },
  WNL: { printed: 'N', critical: false },
  'WITHIN NORMAL LIMITS': { printed: 'N', critical: false },
  A: { printed: 'A', critical: false },
  ABN: { printed: 'A', critical: false },
  ABNORMAL: { printed: 'A', critical: false },
  // "C" is critical on some reports and "corrected" on others: shown as the report's own letter, not as "critical".
  C: { printed: 'C', critical: false },
  CRIT: { printed: 'C', critical: true },
  CRITICAL: { printed: 'C', critical: true },
  PANIC: { printed: 'C', critical: true },
};

/**
 * A flag exactly as printed, read. null/undefined -> not recorded; '' or a dash -> no flag printed (never "normal");
 * H, HI, HIGH -> H; L, LO, LOW -> L; HH, H! (decided: an exclamation mark after H or L is the report's critical mark),
 * CH, "critical high" -> H critical; LL, L!, CL -> L critical; N, NL, NORMAL, WNL -> N; A, ABN, ABNORMAL, a bare "*" or
 * "!" -> A; C -> C (the report's own letter); CRIT, CRITICAL, PANIC -> C critical. Case-insensitive; brackets and one
 * trailing "*" are ignored for matching. Anything else ("Pos", "R") -> not understood, raw kept.
 */
export function parseFlag(raw: string | null | undefined): ParsedFlag {
  if (raw == null) return { raw: null, printed: null, critical: false, state: 'not_recorded', shown: 'Not recorded' };
  const r = String(raw);
  const s = matchCopy(r);
  if (!s || /^[-–—]+$/.test(s)) return { raw: r, printed: null, critical: false, state: 'no_flag_printed', shown: 'None printed' };
  let t = s.toUpperCase().replace(/\s+/g, ' ');
  const br = t.match(/^\((.*)\)$/) ?? t.match(/^\[(.*)\]$/);
  if (br) t = br[1].trim();
  let hit: { printed: 'H' | 'L' | 'N' | 'A' | 'C'; critical: boolean } | undefined;
  if (/^[*!]{1,2}$/.test(t)) hit = { printed: 'A', critical: false };
  else if (/^[HL]\s*!$/.test(t)) hit = { printed: t[0] as 'H' | 'L', critical: true };
  else hit = FLAG_TABLE[t.replace(/\s*[*!]$/, '').trim()];
  if (!hit) return { raw: r, printed: null, critical: false, state: 'not_understood', shown: `"${r.trim()}" (not understood)` };
  const asPrinted = r.trim();
  const shown = hit.printed === 'C' && !hit.critical ? `${asPrinted} (critical or corrected; the report's own letter)` : hit.critical ? `${asPrinted} (critical)` : asPrinted;
  return { raw: r, printed: hit.printed, critical: hit.critical, state: 'flag', shown };
}

interface Edge {
  v: number;
  open: boolean;
}

/** The set of values a reading can be: a number [n, n]; a limit "<3" [0, 3) (or (-inf, 3) when the range allows negatives); a printed range [low, high]. */
function valueInterval(v: ParsedValue, range: ParsedRange): { lo: Edge; hi: Edge } | null {
  const INF = Number.POSITIVE_INFINITY;
  if (v.kind === 'number' && v.number != null) return { lo: { v: v.number, open: false }, hi: { v: v.number, open: false } };
  if (v.kind === 'range' && v.low != null && v.high != null) return { lo: { v: v.low, open: false }, hi: { v: v.high, open: false } };
  if (v.kind === 'censored' && v.bound != null) {
    const b = v.bound;
    // A lab's limit is for an amount that cannot be negative, unless the range itself allows negative values.
    const nonNegative = b > 0 && (range.low == null || range.low >= 0);
    switch (v.comparator) {
      case '<':
        return { lo: nonNegative ? { v: 0, open: false } : { v: -INF, open: true }, hi: { v: b, open: true } };
      case '<=':
        return { lo: nonNegative ? { v: 0, open: false } : { v: -INF, open: true }, hi: { v: b, open: false } };
      case '>':
        return { lo: { v: b, open: true }, hi: { v: INF, open: true } };
      case '>=':
        return { lo: { v: b, open: false }, hi: { v: INF, open: true } };
      default:
        return null;
    }
  }
  return null;
}

type Side = 'yes' | 'no' | 'unknown';

/**
 * The value judged against its own range, never from words. H / L / N, or null with the reason in plain words: no
 * range printed, a range in words, a range in another unit, a limit that straddles a bound ("below 3 could be above
 * or below 2"), or a value exactly at a bound whose sign is not on record.
 */
export function computeFlag(value: ParsedValue, range: ParsedRange, units?: { value: ParsedUnit | null; rangeUnit: string | null }): ComputedFlag {
  const against = formatRange(range);
  const basis: ComputedFlag['basis'] = value.kind === 'number' ? 'number' : value.kind === 'censored' ? 'limit' : value.kind === 'range' ? 'interval' : null;
  const none = (reason: string): ComputedFlag => ({ flag: null, basis, against, reason });
  if (range.status === 'none') return none('no range printed with this value');
  if (range.status === 'unparsed') return none(range.reason ?? 'the range is not read as numbers');
  if (value.kind === 'text') return none('results in words are not judged against a range');
  if (value.kind === 'empty') return none('no value');
  if (range.kind === 'text') return none('results in words are not judged against a range');
  const rangeUnit = units?.rangeUnit ?? range.unitInRange;
  const valueUnit = units?.value ?? null;
  if (rangeUnit && valueUnit?.key && !sameUnit(rangeUnit, valueUnit.unit)) {
    return none(`the range is printed in another unit (${rangeUnit}) than the value (${valueUnit.unit})`);
  }
  const iv = valueInterval(value, range);
  if (!iv) return none('no value');
  const eq = (a: number, b: number) => numbersEqual(a, b);
  const loMode = range.low == null ? null : range.lowComparator === '>' ? 'open' : range.lowComparator === '>=' ? 'closed' : 'unknown';
  const hiMode = range.high == null ? null : range.highComparator === '<' ? 'open' : range.highComparator === '<=' ? 'closed' : 'unknown';

  // Inside: every value of the reading is a normal value.
  const lowOk = ((): Side => {
    if (range.low == null) return 'yes';
    if (iv.lo.v === Number.NEGATIVE_INFINITY) return 'no';
    if (eq(iv.lo.v, range.low)) return iv.lo.open || loMode === 'closed' ? 'yes' : loMode === 'open' ? 'no' : 'unknown';
    return iv.lo.v > range.low ? 'yes' : 'no';
  })();
  const highOk = ((): Side => {
    if (range.high == null) return 'yes';
    if (iv.hi.v === Number.POSITIVE_INFINITY) return 'no';
    if (eq(iv.hi.v, range.high)) return iv.hi.open || hiMode === 'closed' ? 'yes' : hiMode === 'open' ? 'no' : 'unknown';
    return iv.hi.v < range.high ? 'yes' : 'no';
  })();
  if (lowOk === 'yes' && highOk === 'yes') return { flag: 'N', basis, against, reason: null };
  // Above: every value of the reading is above every normal value.
  const above = ((): Side => {
    if (range.high == null) return 'no';
    if (eq(iv.lo.v, range.high)) return iv.lo.open || hiMode === 'open' ? 'yes' : hiMode === 'closed' ? 'no' : 'unknown';
    return iv.lo.v > range.high ? 'yes' : 'no';
  })();
  if (above === 'yes') return { flag: 'H', basis, against, reason: null };
  const below = ((): Side => {
    if (range.low == null) return 'no';
    if (eq(iv.hi.v, range.low)) return iv.hi.open || loMode === 'open' ? 'yes' : loMode === 'closed' ? 'no' : 'unknown';
    return iv.hi.v < range.low ? 'yes' : 'no';
  })();
  if (below === 'yes') return { flag: 'L', basis, against, reason: null };
  if (lowOk === 'unknown' || highOk === 'unknown' || above === 'unknown' || below === 'unknown') {
    return none("exactly at the limit, and the report's sign is not on record");
  }
  // The reading straddles a bound: it holds values on both sides of it (">=1700" against "0-1700" straddles 1700, the
  // upper bound, never 0; "<3" against "0-2" straddles 2).
  const straddlesLow = range.low != null && iv.lo.v < range.low && (iv.hi.v > range.low || (eq(iv.hi.v, range.low) && !iv.hi.open));
  const straddlesHigh = range.high != null && iv.hi.v > range.high && (iv.lo.v < range.high || (eq(iv.lo.v, range.high) && !iv.lo.open));
  const bound = straddlesLow ? range.low : straddlesHigh ? range.high : (range.low ?? range.high);
  const what = value.kind === 'censored' ? limitWords(value) : value.kind === 'range' ? `${fmtNum(value.low!)}–${fmtNum(value.high!)}` : null;
  return none(`${what ?? 'the value'} could be above or below ${bound != null ? fmtNum(bound) : 'the limit'}`);
}

const SOURCE_WORDS: Record<ReadingRole, { who: string; Who: string; range: string }> = {
  printed: { who: 'the report', Who: 'The report', range: 'the range printed with it' },
  unclassified: { who: 'this document', Who: 'This document', range: 'the range printed with it' },
  claimed: { who: 'this document', Who: 'This document', range: 'the range this document gives' },
  typed: { who: 'you', Who: 'You', range: 'the range entered with it' },
  computed: { who: 'you', Who: 'You', range: 'the range' },
};

function meaningWords(f: ParsedFlag): string {
  switch (f.printed) {
    case 'H':
      return 'high';
    case 'L':
      return 'low';
    case 'N':
      return 'normal';
    case 'A':
      return 'abnormal';
    default:
      return `with the letter ${(f.raw ?? '').trim()}`;
  }
}

/**
 * Warnings about the flag, in plain words. The printed flag is never changed.
 * - no flag printed (or recorded) while the value is outside its own range: flag_missing_out_of_range (printed,
 *   unclassified and typed readings only: a summary rarely prints flags);
 * - a printed flag that says otherwise than the value against its own range: flag_disagrees.
 */
export function flagWarnings(flag: ParsedFlag, computed: ComputedFlag, ctx: { valueShown: string; rangeShown: string | null; role: ReadingRole }): LabWarning[] {
  // A computed value is never judged (labcompute.ts): no flag is printed with it and none is worked out.
  if (!computed.flag || ctx.role === 'computed') return [];
  const w = SOURCE_WORDS[ctx.role] ?? SOURCE_WORDS.printed;
  const rng = `${w.range} (${ctx.rangeShown ?? computed.against ?? ''})`;
  const dir = computed.flag === 'H' ? 'above' : computed.flag === 'L' ? 'below' : 'inside';
  const out: LabWarning[] = [];
  if (computed.flag === 'H' || computed.flag === 'L') {
    if (ctx.role !== 'claimed') {
      if (flag.state === 'no_flag_printed') {
        const tail = ctx.role === 'typed' ? 'but you recorded that no flag was printed.' : `but ${w.who} printed no flag.`;
        out.push({ code: 'flag_missing_out_of_range', words: `${ctx.valueShown} is ${dir} ${rng}, ${tail}` });
      } else if (flag.state === 'not_recorded') {
        out.push({ code: 'flag_missing_out_of_range', words: `${ctx.valueShown} is ${dir} ${rng}; no flag was recorded with it.` });
      }
    }
  }
  if (flag.state === 'flag' && flag.printed) {
    const p = flag.printed;
    const c = computed.flag;
    const disagree = (p === 'N' && (c === 'H' || c === 'L')) || (p === 'H' && (c === 'L' || c === 'N')) || (p === 'L' && (c === 'H' || c === 'N')) || ((p === 'A' || p === 'C') && c === 'N');
    if (disagree) {
      const marks = ctx.role === 'typed' ? 'You marked it' : `${w.Who} marks it`;
      const raw = (flag.raw ?? '').trim();
      const label = p === 'C' ? `with the letter ${raw}` : `${meaningWords(flag)} (${raw})`;
      const rest = c === 'N' ? `it is inside ${rng}.` : `${ctx.valueShown} is ${dir} ${rng}.`;
      out.push({ code: 'flag_disagrees', words: `${marks} ${label}, but ${rest}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Units and conversions
// ---------------------------------------------------------------------------

/**
 * Spellings of one unit (equality only, never shown): the reconcile pass's UNIT_SYNONYMS (reconcile.ts at d43790a) and
 * the chart's folds (cmH20, torr). International units per litre are units per litre; a milli-unit per mL is a unit
 * per litre; a kilo-unit per litre is a unit per mL; a micro-unit per mL is a milli-unit per litre (TSH); beats or
 * breaths per minute are "/min"; millimetres per hour (ESR) are "mm/h"; degrees are "c"/"f"; percent is "%".
 */
export const UNIT_SYNONYMS: Readonly<Record<string, string>> = {
  'iu/l': 'u/l', 'iu/ml': 'u/ml', 'miu/ml': 'u/l', 'mu/ml': 'u/l', 'miu/l': 'mu/l', 'ku/l': 'u/ml', 'kiu/l': 'u/ml', 'uiu/ml': 'mu/l', 'uu/ml': 'mu/l',
  'mm/hr': 'mm/h', 'mm/hour': 'mm/h', 'mm/1hr': 'mm/h', 'mm/1h': 'mm/h',
  lbs: 'lb', pound: 'lb', pounds: 'lb', kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  bpm: '/min', 'b/min': '/min', 'beats/min': '/min', 'beats/minute': '/min', beatsperminute: '/min', 'beat/min': '/min', 'breaths/min': '/min', 'breaths/minute': '/min', breathsperminute: '/min', 'br/min': '/min', '/minute': '/min', permin: '/min', perminute: '/min', 'min-1': '/min', 'min^-1': '/min',
  '°c': 'c', 'ºc': 'c', '℃': 'c', degc: 'c', 'deg.c': 'c', degreesc: 'c', degreec: 'c', celsius: 'c', degreescelsius: 'c', degreecelsius: 'c', 'c°': 'c',
  '°f': 'f', 'ºf': 'f', '℉': 'f', degf: 'f', 'deg.f': 'f', degreesf: 'f', degreef: 'f', fahrenheit: 'f', degreesfahrenheit: 'f', degreefahrenheit: 'f', 'f°': 'f',
  percent: '%', pct: '%', 'per cent': '%', percentage: '%',
  cmh20: 'cmh2o', 'cm h2o': 'cmh2o', cmofwater: 'cmh2o', cmwater: 'cmh2o', mmh20: 'mmh2o', mmofwater: 'mmh2o', mmwater: 'mmh2o',
  torr: 'mmhg',
};

/** Collapse an exactly repeated unit: "cells/uL cells/uL" -> "cells/uL" (also "cells/uLcells/uL"). */
function collapseRepeats(u: string): { unit: string; collapsed: boolean } {
  const tokens = u.split(' ');
  const n = tokens.length;
  for (let len = 1; len <= n / 2; len++) {
    if (n % len) continue;
    const head = tokens.slice(0, len).map((t) => t.toLowerCase());
    let all = true;
    for (let i = len; i < n && all; i++) if (tokens[i].toLowerCase() !== head[i % len]) all = false;
    if (all) return { unit: tokens.slice(0, len).join(' '), collapsed: true };
  }
  if (n === 1 && u.length >= 4 && u.length % 2 === 0) {
    const half = u.slice(0, u.length / 2);
    if (half.includes('/') && half.toLowerCase() === u.slice(u.length / 2).toLowerCase()) return { unit: half, collapsed: true };
  }
  return { unit: u, collapsed: false };
}

function keyOfShownUnit(u: string): string | null {
  let t = u.toLowerCase().replace(/[µμ]/g, 'u').replace(/₂/g, '2').replace(/×/g, 'x');
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (s) => `^${[...s].map((c) => SUPERSCRIPT_DIGITS[c]).join('')}`);
  const spaced = t.replace(/\s+/g, ' ').trim();
  if (UNIT_SYNONYMS[spaced] !== undefined) return UNIT_SYNONYMS[spaced];
  t = spaced.replace(/\bcells?\s+per\s+/g, '/').replace(/^per\s+/, '/');
  t = t.replace(/\s+/g, '').replace(/\.$/, '');
  if (!t) return null;
  if (UNIT_SYNONYMS[t] !== undefined) return UNIT_SYNONYMS[t];
  t = t.replace(/mcg/g, 'ug').replace(/mc(?=l(?:$|[^a-z]))/g, 'u');
  t = t.replace(/cells?(?=\/)/g, '').replace(/^per(?=[a-z])/, '/');
  t = t.replace(/\/(?:cu\.?mm|cumm|mm\^?3)$/, '/ul');
  t = t.replace(/^x?10(?:\^|\*\*|\*|e)(\d{1,2})\/(ul|ml|l)$/, '10^$1/$2');
  if (/^(?:k|thou|thous)\/ul$/.test(t)) t = '10^3/ul';
  if (/^(?:m|mil|mill|million)\/ul$/.test(t)) t = '10^6/ul';
  return UNIT_SYNONYMS[t] ?? t;
}

/** A unit exactly as printed: shown trimmed with inner spaces collapsed and an exact repeat collapsed; its key for equality only. */
export function parseUnit(raw: string | null | undefined): ParsedUnit {
  if (raw == null) return { raw: null, unit: null, key: null, collapsed: false };
  const r = String(raw);
  const t = r.replace(/[    ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { raw: r, unit: null, key: null, collapsed: false };
  const c = collapseRepeats(t);
  return { raw: r, unit: c.unit, key: keyOfShownUnit(c.unit), collapsed: c.collapsed };
}

/**
 * The unit's key, for equality only (never shown): lower case; µ -> u; mcg -> ug; mcL -> uL; "cells/" and "cells
 * per" -> "/"; /cu mm, /mm3 -> /ul; K/uL, x10^3/uL, 10*3/uL -> 10^3/ul; M/uL -> 10^6/ul; cmH20 -> cmh2o; torr ->
 * mmhg; IU/L -> u/l and every other spelling in UNIT_SYNONYMS; spaces removed. Computed from the collapsed unit.
 */
export function unitKey(raw: string | null | undefined): string | null {
  return parseUnit(raw).key;
}

/** The same unit (keys equal); null only equals null. Never a unit that only converts ("g/dL" is not "mg/dL"). */
export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  return unitKey(a) === unitKey(b);
}

export interface UnitConversion {
  from: string; // unit key
  to: string; // unit key
  factor: number; // to = from * factor
  analytes: 'any' | readonly string[]; // canonical analyte keys it applies to
  why: string;
}

const MASS_EXP: Record<string, number> = { g: 0, mg: -3, ug: -6, ng: -9, pg: -12 };
const VOLUME_EXP: Record<string, number> = { l: 0, dl: -1, ml: -3, ul: -6 };
const PER_VOLUME_EXP: Record<string, number> = { ul: 0, ml: -3, l: -6 };

/** A unit key that scales by a power of ten whatever the test is: a mass per volume, a count per volume, a column of water. */
function dimensionOf(key: string): { dim: 'mass' | 'count' | 'water'; exp: number } | null {
  const mv = key.match(/^(g|mg|ug|ng|pg)\/(l|dl|ml|ul)$/);
  if (mv) return { dim: 'mass', exp: MASS_EXP[mv[1]] - VOLUME_EXP[mv[2]] };
  const plain = key.match(/^\/(ul|ml|l)$/);
  if (plain) return { dim: 'count', exp: PER_VOLUME_EXP[plain[1]] };
  const pow = key.match(/^10\^(\d{1,2})\/(ul|ml|l)$/);
  if (pow) return { dim: 'count', exp: Number(pow[1]) + PER_VOLUME_EXP[pow[2]] };
  if (key === 'mmh2o') return { dim: 'water', exp: 0 };
  if (key === 'cmh2o') return { dim: 'water', exp: 1 };
  return null;
}

const PRESSURE_ANALYTES = ['opening pressure', 'closing pressure'] as const;
/** 1 mmHg = 13.5951 mmH2O = 1.35951 cmH2O (a column of water at 4 °C). Lumbar-puncture pressures only. */
export const MMHG_IN_MMH2O = 13.5951;

/** The rows that are not powers of ten: milliequivalents by valence (per test), and mmHg for a lumbar puncture's pressures. */
const TABLE_ROWS: UnitConversion[] = [
  { from: 'meq/l', to: 'mmol/l', factor: 1, analytes: ['sodium', 'potassium', 'chloride', 'co2'], why: 'one charge per ion: 1 mEq/L = 1 mmol/L' },
  { from: 'meq/l', to: 'mmol/l', factor: 0.5, analytes: ['calcium', 'magnesium'], why: 'two charges per ion: 2 mEq/L = 1 mmol/L' },
  { from: 'mmhg', to: 'cmh2o', factor: MMHG_IN_MMH2O / 10, analytes: PRESSURE_ANALYTES, why: '1 mmHg = 1.35951 cmH2O (a column of water at 4 °C)' },
  { from: 'mmhg', to: 'mmh2o', factor: MMHG_IN_MMH2O, analytes: PRESSURE_ANALYTES, why: '1 mmHg = 13.5951 mmH2O (a column of water at 4 °C)' },
];

const DIM_WHY: Record<'mass' | 'count' | 'water', string> = {
  mass: 'the same substance per volume: grams and litres by powers of ten',
  count: 'the same count per volume: powers of ten (10^9 per L = 10^3 per uL)',
  water: 'a column of water: 1 cmH2O = 10 mmH2O',
};

function powerOfTen(n: number): number {
  return Number(`1e${n}`);
}

/** value * 10^n without binary noise ("3659 mg/dL" in g/dL is 3.659, not 3.6590000000000003). */
function scaleByPower(value: number, n: number): number {
  const out = n >= 0 ? value * powerOfTen(n) : value / powerOfTen(-n);
  return Number(out.toPrecision(15));
}

function derivedRows(): UnitConversion[] {
  const keys: string[] = [];
  for (const m of Object.keys(MASS_EXP)) for (const v of Object.keys(VOLUME_EXP)) keys.push(`${m}/${v}`);
  keys.push('/ul', '/ml', '/l');
  for (const p of [3, 6, 9, 12]) for (const v of ['ul', 'ml', 'l']) keys.push(`10^${p}/${v}`);
  keys.push('mmh2o', 'cmh2o');
  const out: UnitConversion[] = [];
  for (const a of keys) {
    for (const b of keys) {
      if (a === b) continue;
      const da = dimensionOf(a)!;
      const db = dimensionOf(b)!;
      if (da.dim !== db.dim) continue;
      out.push({ from: a, to: b, factor: powerOfTen(da.exp - db.exp), analytes: 'any', why: DIM_WHY[da.dim] });
    }
  }
  return out;
}

/**
 * Every conversion the app knows, each exact and tested: every pair of mass-per-volume units (g, mg, ug, ng, pg per
 * L, dL, mL, uL), of count-per-volume units (/uL, /mL, /L, 10^3, 10^6, 10^9, 10^12 per uL, mL, L) and of water columns
 * (cmH2O, mmH2O), plus the table rows (mEq/L by valence for sodium, potassium, chloride, CO2, calcium and magnesium;
 * mmHg for a lumbar puncture's opening and closing pressures). Never between different tests, never mg/dL to mmol/L,
 * BUN to urea, or a percentage to an absolute count.
 */
export const UNIT_CONVERSIONS: readonly UnitConversion[] = [...derivedRows(), ...TABLE_ROWS];

function analyteAllowed(rule: UnitConversion, analyteKey: string | null): boolean {
  return rule.analytes === 'any' || (analyteKey != null && rule.analytes.includes(analyteKey));
}

/**
 * A number in another unit, for comparing or charting; both originals are kept by every caller and nothing is
 * relabelled. Null when no rule applies (different dimensions, mg/dL to mmol/L, a pressure rule for another test...).
 * convertValue(4.4, 'g/dL', 'mg/dL', 'albumin') -> 4400 (factor 1000), which is not 3659.
 */
export function convertValue(value: number, fromUnit: string | null, toUnit: string | null, analyteKey: string | null): { value: number; factor: number; rule: UnitConversion } | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const a = unitKey(fromUnit);
  const b = unitKey(toUnit);
  if (!a || !b) return null;
  if (a === b) return { value, factor: 1, rule: { from: a, to: b, factor: 1, analytes: 'any', why: 'the same unit' } };
  const da = dimensionOf(a);
  const db = dimensionOf(b);
  if (da && db && da.dim === db.dim) {
    const n = da.exp - db.exp;
    return { value: scaleByPower(value, n), factor: powerOfTen(n), rule: { from: a, to: b, factor: powerOfTen(n), analytes: 'any', why: DIM_WHY[da.dim] } };
  }
  for (const rule of TABLE_ROWS) {
    if (!analyteAllowed(rule, analyteKey)) continue;
    if (rule.from === a && rule.to === b) return { value: Number((value * rule.factor).toPrecision(15)), factor: rule.factor, rule };
    if (rule.from === b && rule.to === a) return { value: Number((value / rule.factor).toPrecision(15)), factor: 1 / rule.factor, rule: { ...rule, from: a, to: b, factor: 1 / rule.factor } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function canonicalNumber(n: number): string {
  return String(Number(n.toPrecision(15)));
}

function spellSigns(s: string): string {
  return s.replace(/<=|=<|≤/g, ' le ').replace(/>=|=>|≥/g, ' ge ').replace(/</g, ' lt ').replace(/>/g, ' gt ');
}

const CMP_WORD: Record<Comparator, string> = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

/**
 * Identity of a value: copies, the same measurement, the client's reading key, chart folding, crossref dedupe and
 * conflict grouping. number -> "n:62" ("62" = "62.0", "0.80" = "0.8", "1,200" = "1200"; "-2" is not "2"); censored ->
 * "lt:3" / "le:0.02" / "gt:1700" / "ge:5"; range -> "r:10:20"; text -> "t:" + its key (signs spelled out); empty -> ''.
 */
export function labValueIdentity(v: ParsedValue): string {
  switch (v.kind) {
    case 'number':
      return v.number == null ? '' : `n:${canonicalNumber(v.number)}`;
    case 'censored':
      return v.bound == null || !v.comparator ? '' : `${CMP_WORD[v.comparator]}:${canonicalNumber(v.bound)}`;
    case 'range':
      return `r:${canonicalNumber(v.low ?? NaN)}:${canonicalNumber(v.high ?? NaN)}`;
    case 'text':
      return `t:${normalizeKey(spellSigns(v.text ?? ''))}`;
    default:
      return '';
  }
}

/**
 * The value's part of a dedup key (facts.dedup_key, the CSV duplicate check): number -> normalizeKey of the text as
 * printed ("62" -> "62", today's key; a negative number gets "neg " in front); censored -> "lt 3" / "le 0 02" /
 * "gt 1700" / "ge 5"; range -> "range 10 20"; text -> normalizeKey of the words (any < > sign spelled out). "<3" never
 * keys as "3".
 */
export function labDedupValueKey(v: ParsedValue): string {
  switch (v.kind) {
    case 'number': {
      const k = normalizeKey(v.raw ?? v.numberText ?? (v.number != null ? fmtNum(v.number) : ''));
      return v.number != null && v.number < 0 ? `neg ${k}` : k;
    }
    case 'censored':
      return v.comparator ? normalizeKey(`${CMP_WORD[v.comparator]} ${v.bound != null && v.bound < 0 ? 'neg ' : ''}${v.numberText ?? fmtNum(v.bound ?? NaN)}`) : '';
    case 'range':
      return normalizeKey(`range ${fmtNum(v.low ?? NaN)} ${fmtNum(v.high ?? NaN)}`);
    case 'text':
      return normalizeKey(spellSigns(v.text ?? ''));
    default:
      return '';
  }
}

/** Same as labValueIdentity (amendment C3). For dedup keys use labDedupValueKey. */
export const labValueKey = labValueIdentity;

const LAB_NOISE = new Set(['laboratories', 'laboratory', 'labs', 'lab', 'inc', 'the']);

/** normalizeKey of a lab name minus "laboratories", "laboratory", "labs", "lab", "inc", "the". No folding between different names. */
export function labKey(name: string | null | undefined): string | null {
  const k = normalizeKey(name)
    .split(' ')
    .filter((w) => w && !LAB_NOISE.has(w))
    .join(' ');
  return k || null;
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

export interface LabReadingInput {
  value: {
    /** The current stored text (rows: value_text; facts: attributes.value). Parsed and shown. */
    shown: string | null;
    /** As printed (provenance: value_raw, or the linked fact's first reading). Fills a missing current text only when the value was not edited. */
    raw: string | null;
    storedNumber: number | null;
    /** The current text is the user's own words (typed by hand, edited, a manual fact): the page never changes it. */
    userEdited: boolean;
    /** The fact behind the value carries the user's verdict (confirmed or disputed): the page never changes it either. */
    verdictLocked?: boolean;
    /**
     * The value as the page prints it ("<3"), remembered when a copy was written from a value whose page sign was
     * followed ("Add all": parse_json.pageValue). Read like the verified quote when no verified quote is at hand, so the
     * copy reads exactly as its detail does.
     */
    pageText?: string | null;
  };
  unit: { shown: string | null; raw: string | null; userEdited?: boolean };
  /**
   * shown: the current range text (rows: ref_text; facts: attributes.ref_text); raw: as printed (provenance). When
   * `shown` is left out, `raw` is read as the current text. With no text, the stored numbers are read.
   */
  range: { shown?: string | null; raw: string | null; storedLow: number | null; storedHigh: number | null; userEdited?: boolean };
  /**
   * shown: the current flag text (rows: flag; facts: flag_raw ?? flag) - '' and '-' mean "no flag printed"; raw: as
   * printed (provenance: flag_raw). When `shown` is left out, `raw ?? stored` is read as the current text.
   * modelConflict: the flag the model gave where the page shows none (attributes._flagConflict).
   */
  flag: { shown?: string | null; raw: string | null; stored?: string | null; userEdited?: boolean; modelConflict?: string | null };
  /** The first verified citation of the value's detail. */
  quote: { text: string; verified: boolean; citationId?: string | null } | null;
  role: ReadingRole;
  dates: { collected: PartialDate | null; resulted: PartialDate | null; unknownKind: PartialDate | null; document: PartialDate | null; received?: PartialDate | null };
  labName: string | null;
  claim: { interpretation: string | null; limitUsed: string | null } | null;
  sampleLabel?: string | null;
}

/** A sign before a number on the page, and the number, as whole tokens ("<30" holds 30, never 3; "<1.5" never 1). */
interface QuoteNumber {
  value: number;
  text: string;
  sign: Comparator | null;
  /** The sign as printed: "<", "<=", or words ("less than", "below"). */
  signText: string;
  start: number;
  end: number;
  /** The number sits inside brackets or after a range label ("(ref <5)", "Reference range: <5"): it belongs to the range. */
  inRange: boolean;
}

/** A number as a whole token, never digits glued to a letter or a power on their left ("/mm3", "cmH2O", "B12", "10^3"). */
const QUOTE_NUMBER = new RegExp(String.raw`(?<![\d.,A-Za-zµμ^])(-?)(${NUM_SRC})(?![\d]|[.,]\d)`, 'g');
/** A sign printed before a number: symbols, or the words a report uses ("less than 3", "below 3", "at least 5"). */
const QUOTE_SIGN = /(<=|=<|≤|>=|=>|≥|<|>|\bless than|\bfewer than|\bbelow|\bunder|\bgreater than|\bmore than|\babove|\bover|\bup to|\bat least)\s*$/i;
/** A range label right before a sign or a number ("ref", "Reference range:", "normal"). */
const QUOTE_RANGE_LABEL = /(?:\bref(?:erence)?\.?(?:\s+(?:range|interval|values?))?|\bnormal(?:\s+(?:range|values?))?|\brange|\bnl)\s*[:=]?\s*$/i;

function quoteSign(t: string): Comparator | null {
  const s = t.toLowerCase();
  if (s === '<=' || s === '=<' || s === '≤' || s === 'up to') return '<=';
  if (s === '>=' || s === '=>' || s === '≥' || s === 'at least') return '>=';
  if (s === '<' || s === 'less than' || s === 'fewer than' || s === 'below' || s === 'under') return '<';
  if (s === '>' || s === 'greater than' || s === 'more than' || s === 'above' || s === 'over') return '>';
  return null;
}

function numbersInQuote(quote: string): QuoteNumber[] {
  const s = matchCopy(quote);
  const out: QuoteNumber[] = [];
  for (const m of s.matchAll(QUOTE_NUMBER)) {
    const start = m.index ?? 0;
    let minus = m[1] === '-';
    // "15-45": the dash between two numbers is not a minus sign.
    if (minus && start > 0 && /[\d\w)]/.test(s[start - 1])) minus = false;
    const text = m[2];
    const numStart = start + m[1].length;
    const before = s.slice(0, minus ? start : numStart);
    const sm = before.match(QUOTE_SIGN);
    const sign = sm ? quoteSign(sm[1]) : null;
    // What comes before the sign (or the number): an open bracket or a range label puts the number in the range.
    const head = sm ? before.slice(0, before.length - sm[0].length) : before;
    const depth = (open: string, close: string) => head.split(open).length - head.split(close).length;
    const inRange = depth('(', ')') > 0 || depth('[', ']') > 0 || QUOTE_RANGE_LABEL.test(head);
    out.push({ value: (minus ? -1 : 1) * numberOf(text), text: (minus ? '-' : '') + text, sign, signText: sm ? sm[1] : '', start: numStart, end: numStart + text.length, inRange });
  }
  return out;
}

function fnv(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + c) >>> 0;
  }
  return `${h1.toString(36)}.${h2.toString(36)}.${s.length}`;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const READING_MEMO = new Map<string, LabReading>();

/** Empties the readings memo (names, values and quotes from the record); the server calls it when the case locks. */
export function clearReadingMemo(): void {
  READING_MEMO.clear();
}

/** "This judgement word means": normal, high, low, abnormal; null for words that judge nothing. */
export function judgementOf(words: string | null | undefined): 'N' | 'H' | 'L' | 'A' | null {
  const t = (words ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(?:not|no longer|never)\s+(?:elevated|raised|high|increased|low|decreased|reduced|abnormal)\b/.test(t)) return 'N';
  if (/\babnormal\b/.test(t)) return 'A';
  if (/\b(?:elevated|raised|high|increased)\b/.test(t)) return 'H';
  if (/\b(?:low|decreased|reduced)\b/.test(t)) return 'L';
  if (/\b(?:normal|wnl|within (?:the )?(?:normal|age[- ]adjusted|reference) (?:limits?|range)|unremarkable)\b/.test(t)) return 'N';
  return null;
}

const JUDGEMENT_WORDS = /\b(?:normal|abnormal|elevated|raised|high|low|wnl|within (?:normal|age[- ]adjusted) limits?|unremarkable|increased|decreased)\b/i;

/**
 * The tier of a document decides how its values are read: primary -> printed (the lab's record); patient,
 * compilation, external -> claimed (that document's claims); unknown (not sorted yet) -> unclassified; no document
 * (entered by hand, CSV) -> typed.
 */
export function roleForTier(tier: string | null | undefined, hasDocument: boolean): ReadingRole {
  if (!hasDocument) return 'typed';
  if (tier === 'primary') return 'printed';
  if (tier === 'patient' || tier === 'compilation' || tier === 'external') return 'claimed';
  return 'unclassified';
}

/**
 * The one reading of a lab value. The CURRENT text of every field is parsed and shown (the user's edits always show);
 * the text as printed (raw columns, the model's first reading) fills a field whose current text is missing, only when
 * that field was not edited, and is kept as provenance ("As printed: …"). Memoised (20 000 readings) on the fields, the
 * citation id, its verified flag and a hash of its quote; the result is frozen.
 */
export function buildLabReading(input: LabReadingInput): LabReading {
  const memoKey = JSON.stringify({ ...input, quote: input.quote ? { h: fnv(input.quote.text), v: input.quote.verified, c: input.quote.citationId ?? null } : null });
  const hit = READING_MEMO.get(memoKey);
  if (hit) return hit;
  const out = deepFreeze(buildLabReadingUncached(input));
  if (READING_MEMO.size >= 20000) READING_MEMO.clear();
  READING_MEMO.set(memoKey, out);
  return out;
}

function buildLabReadingUncached(input: LabReadingInput): LabReading {
  const warnings: LabWarning[] = [];
  const role = input.role;

  // 1. The value: the current text, else (never edited) the printed text, else a stored number with no text.
  const cur = nonBlank(input.value.shown);
  const prov = nonBlank(input.value.raw);
  let text: string | null = null;
  let valueFrom: LabReading['valueFrom'] = 'printed';
  if (cur != null) {
    text = cur;
    valueFrom = input.value.userEdited ? 'user' : 'printed';
  } else if (!input.value.userEdited && prov != null) {
    text = prov;
  }
  const stored = typeof input.value.storedNumber === 'number' && Number.isFinite(input.value.storedNumber) ? input.value.storedNumber : null;
  let value: ParsedValue;
  if (text != null) value = parseLabValue(text);
  else if (stored != null) {
    value = numberOnlyValue(stored);
    valueFrom = 'number_only';
  } else value = parseLabValue(null);
  let valueShown = valueFrom === 'number_only' ? fmtNum(stored!) : (text ?? '').trim();
  let printedValue = prov ?? (!input.value.userEdited && cur != null ? cur : null);
  let valueReadAs: string | null = null;

  // 2. A stored number never stands in for a printed limit or words.
  if (stored != null && valueFrom !== 'number_only') {
    if (value.kind !== 'number') {
      warnings.push({ code: 'stored_number_ignored', words: `The value is printed as "${valueShown}"; the stored number ${fmtNum(stored)} is not used as a measurement.` });
    } else if (value.number != null && !numbersEqual(stored, value.number)) {
      warnings.push({ code: 'stored_number_differs', words: `The value is printed as "${valueShown}"; the stored number ${fmtNum(stored)} differs and is not used.` });
    }
  }

  // 3. The verified quote: the page's own text (else the page's text a copy remembered when it followed the page).
  const q = input.quote && input.quote.verified && input.quote.text ? input.quote.text : nonBlank(input.value.pageText ?? null);
  let singleMatch: QuoteNumber | null = null;
  if (q && text != null && !value.scientific && (value.kind === 'number' || value.kind === 'censored')) {
    const target = value.kind === 'number' ? value.number! : value.bound!;
    const shownNumber = value.numberText ?? fmtNum(target);
    const matches = numbersInQuote(q).filter((n) => numbersEqual(n.value, target));
    if (!matches.length) {
      warnings.push({ code: 'value_not_on_page', words: `The quoted page text does not show the number ${shownNumber}.` });
    } else if (matches.length === 1) {
      const m = matches[0];
      singleMatch = m;
      if (value.kind === 'number' && m.sign) {
        // "<3" as printed; a sign printed in words keeps its words ("less than 3").
        const page = /^[<>=≤≥]+$/.test(m.signText) ? `${m.signText}${m.text}` : `${m.signText} ${m.text}`;
        if (m.inRange) {
          // The sign belongs to the printed range ("RBC 3 (ref <5)"): never written in as the value's own.
          warnings.push({ code: 'value_not_on_page', words: `The page shows ${shownNumber} only as "${page}" in the printed range, not as the value; the value is kept as read.` });
        } else if (!input.value.userEdited && !input.value.verdictLocked) {
          const replaced = text.trim().replace(shownNumber, page);
          const reread = parseLabValue(replaced);
          if (reread.kind === 'censored') {
            warnings.push({ code: 'value_read_without_symbol', words: `The page shows "${page}" where the value was read as "${valueShown}"; the page is followed.` });
            valueReadAs = valueShown;
            value = reread;
            valueShown = replaced;
            valueFrom = 'quote';
            // As printed is the page's own text, never the model's transcription (C-L12).
            printedValue = replaced;
          }
        } else {
          const why = input.value.userEdited ? 'it is your own entry' : 'you have already judged this value';
          warnings.push({ code: 'value_read_without_symbol', words: `The page shows "${page}" where the value reads "${valueShown}"; the value is kept as it is because ${why}.` });
        }
      } else if (value.kind === 'censored' && m.sign !== value.comparator) {
        const page = m.sign ? `"${m.signText}${m.text}"` : `"${m.text}" with no sign`;
        warnings.push({ code: 'value_sign_differs_from_page', words: `The value reads "${valueShown}", but the page shows ${page}.` });
      }
    }
  }

  // 4. The unit: the current text, else (never edited) the printed one, else a unit printed inside the value.
  const unitCur = nonBlank(input.unit.shown);
  const unitProv = nonBlank(input.unit.raw);
  const unitField = unitCur ?? (!input.unit.userEdited ? unitProv : null);
  const unit = parseUnit(unitField ?? value.unitInValue);
  const printedUnit = unitProv ?? (!input.unit.userEdited ? unitCur : null);
  if (unit.collapsed) warnings.push({ code: 'unit_repeated', words: `The unit is printed twice ("${(unit.raw ?? '').trim()}"); it is shown once.` });
  if (unitField && value.unitInValue && !sameUnit(value.unitInValue, unit.unit)) {
    warnings.push({ code: 'unit_in_value_differs', words: `The value prints the unit "${value.unitInValue}", but the unit on record is "${unit.unit}".` });
  }
  if (q && singleMatch && unit.key) {
    const after = matchCopy(q).slice(singleMatch.end).trimStart();
    const token = (after.match(/^[^\s,;|]+/)?.[0] ?? '').replace(/[.,;:]+$/, '');
    if ((token.includes('/') || token === '%') && isUnitToken(token)) {
      const words = after.split(/\s+/).slice(0, 3);
      let same = false;
      for (let n = 1; n <= words.length && !same; n++) same = unitKey(words.slice(0, n).join(' ').replace(/[.,;:)]+$/, '')) === unit.key;
      if (!same) warnings.push({ code: 'unit_not_on_page', words: `The page shows the unit "${token}" next to ${singleMatch.text}; the unit on record is "${unit.unit}".` });
    }
  }

  // 5. The range: the current text, else (never edited) the printed text, else the stored numbers.
  const rangeCurRaw = input.range.shown === undefined ? input.range.raw : input.range.shown;
  const rangeProvRaw = input.range.shown === undefined ? null : input.range.raw;
  const rangeCur = nonBlank(rangeCurRaw);
  const rangeProv = nonBlank(rangeProvRaw);
  const rangeTextIn = rangeCur ?? (!input.range.userEdited ? rangeProv : null);
  const range = rangeTextIn != null ? parseRefRange(rangeTextIn) : rangeFromNumbers(input.range.storedLow, input.range.storedHigh);
  const printedRange = rangeProv ?? (!input.range.userEdited ? rangeCur : null);
  const rangeShown = formatRange(range);
  if (rangeTextIn != null && range.status === 'parsed') {
    const sl = input.range.storedLow;
    const sh = input.range.storedHigh;
    const differs = (sl != null && (range.low == null || !numbersEqual(sl, range.low))) || (sh != null && (range.high == null || !numbersEqual(sh, range.high)));
    if (differs) {
      const parts = [sl != null ? `low ${fmtNum(sl)}` : null, sh != null ? `high ${fmtNum(sh)}` : null].filter(Boolean).join(', ');
      warnings.push({ code: 'range_numbers_differ', words: `The range is printed as "${rangeText(range) ?? rangeTextIn.trim()}"; the stored numbers (${parts}) are not used.` });
    }
  }
  if (range.status === 'unparsed') {
    // Said once, with the printed text quoted ("not read as numbers" is already in rangeShown).
    const reason = range.reason ?? 'not a range the app reads';
    warnings.push({
      code: 'range_unparsed',
      words: range.fromNumbersOnly ? `The stored range numbers are not read as a range: ${reason}.` : `The value is not judged against the range "${rangeText(range) ?? (rangeTextIn ?? '').trim()}": ${reason}.`,
    });
  }

  // 6. The flag: the current text; the printed text fills a missing one (never edited) and, when it means the same,
  // keeps the printed detail ("HH" for H). A flag printed inside the value counts when the field says nothing.
  const flagCurIn = input.flag.shown !== undefined ? strOrNull(input.flag.shown) : (strOrNull(input.flag.raw) ?? strOrNull(input.flag.stored));
  const flagProvIn = input.flag.shown !== undefined ? strOrNull(input.flag.raw) : null;
  let flagText: string | null;
  if (input.flag.userEdited) flagText = flagCurIn;
  else if (flagCurIn == null) flagText = flagProvIn;
  else if (flagProvIn != null) {
    const a = parseFlag(flagCurIn);
    const b = parseFlag(flagProvIn);
    flagText = a.state === b.state && a.printed === b.printed ? flagProvIn : flagCurIn;
  } else flagText = flagCurIn;
  let flag = parseFlag(flagText);
  const printedFlag = flagProvIn ?? (!input.flag.userEdited ? flagCurIn : null);
  if (flag.state === 'not_recorded' || flag.state === 'no_flag_printed') {
    const inValue = value.flagInValue ?? (value.ambiguousTail && unitField ? value.ambiguousTail : null);
    if (inValue != null) {
      const f = parseFlag(inValue);
      if (f.state === 'flag' || flag.state === 'not_recorded') flag = f;
    }
  }
  // Once the user has set the flag themselves, the model's earlier disagreement with the page is no longer news: the
  // user's flag is shown and nothing says "the page is followed" (the user's verdict outranks the model).
  if (input.flag.modelConflict && !input.flag.userEdited) {
    const page = flag.state === 'flag' ? `the flag ${(flag.raw ?? '').trim()}` : 'no flag';
    warnings.push({ code: 'flag_model_conflict', words: `The model gave the flag ${input.flag.modelConflict}; the page shows ${page}. The page is followed.` });
  }

  // 7. The flag worked out from the value and its own range.
  const computed = computeFlag(value, range, { value: unit, rangeUnit: range.unitInRange });
  if (range.status === 'parsed' && range.unitInRange && unit.key && !sameUnit(range.unitInRange, unit.unit)) {
    warnings.push({ code: 'range_unit_differs', words: `The range is printed in ${range.unitInRange}, the value in ${unit.unit}; the value is not judged against it.` });
  }
  warnings.push(...flagWarnings(flag, computed, { valueShown, rangeShown, role }));

  // 8. Dates: collected, else a date of unknown kind, else resulted. Received is shown, never used.
  const collected = input.dates.collected ?? null;
  const unknownKind = input.dates.unknownKind ?? null;
  const resulted = input.dates.resulted ?? null;
  const reading = collected ?? unknownKind ?? resulted;
  const readingKind: ReadingDateKind = collected ? 'collected' : unknownKind ? 'unknown' : resulted ? 'resulted' : 'unknown';
  const doc = input.dates.document ?? null;
  if (role === 'claimed' && reading?.iso && doc?.iso && reading.iso === doc.iso) {
    warnings.push({ code: 'date_is_document_date', words: "This date is the date of the document itself; the lab's own date may differ." });
  }

  // 9. The lab, and a claimed reading's own judgement.
  const labName = nonBlank(input.labName)?.trim() ?? null;
  let claim: LabReading['claim'] = null;
  if (role === 'claimed') {
    const interp = nonBlank(input.claim?.interpretation)?.trim() ?? (value.kind === 'text' && value.text && JUDGEMENT_WORDS.test(value.text) ? value.text : null);
    claim = { interpretation: interp, limitUsed: nonBlank(input.claim?.limitUsed)?.trim() ?? null };
  }

  return {
    version: LAB_PARSE_VERSION,
    role,
    value,
    valueShown,
    valueRaw: printedValue,
    valueFrom,
    valueReadAs,
    measurement: value.kind === 'number' ? value.number : null,
    unit,
    range,
    rangeShown,
    flag,
    computed,
    warnings,
    printed: { value: printedValue, unit: printedUnit, range: printedRange, flag: printedFlag },
    dates: { collected, resulted, received: input.dates.received ?? null, document: doc, reading, readingKind },
    lab: { name: labName, key: labKey(labName) },
    sampleLabel: nonBlank(input.sampleLabel)?.trim() ?? null,
    claim,
  };
}

// ---------------------------------------------------------------------------
// The compact view the client receives (amendment I2)
// ---------------------------------------------------------------------------

export interface LabReadingView {
  v: number;
  role: ReadingRole;
  kind: ValueKind;
  comparator: Comparator | null;
  measurement: number | null;
  valueShown: string;
  /** The text as printed when it differs from valueShown; null otherwise. */
  valueRaw: string | null;
  valueFrom: LabReading['valueFrom'];
  /** valueFrom 'quote': what Claude read where the page prints a sign ("3" for the page's "<3"); null otherwise. */
  valueReadAs: string | null;
  /** "below 3" for a limit; null otherwise. */
  limit: string | null;
  /** labValueIdentity: copies and the reading key. */
  identity: string;
  unit: string | null;
  unitKey: string | null;
  rangeShown: string | null;
  rangeStatus: RangeStatus;
  rangeKind: ParsedRange['kind'];
  rangeLow: number | null;
  rangeLowComparator: ParsedRange['lowComparator'];
  rangeHigh: number | null;
  rangeHighComparator: ParsedRange['highComparator'];
  rangeUnitKey: string | null;
  /** A unit printed inside the range itself ("0.15-0.45 g/L"), as printed; null when the range prints none (then it is in the value's unit). */
  rangeUnit: string | null;
  rangeFromNumbersOnly: boolean;
  rangeReason: string | null;
  lab: string | null;
  labKey: string | null;
  flagState: FlagState;
  flagRaw: string | null;
  flagPrinted: ParsedFlag['printed'];
  flagCritical: boolean;
  flagShown: string;
  computed: ComputedFlag['flag'];
  computedAgainst: string | null;
  computedReason: string | null;
  warnings: string[];
  warningCodes: LabWarningCode[];
  dateKind: ReadingDateKind;
  collected: PartialDate | null;
  resulted: PartialDate | null;
  received: PartialDate | null;
  sampleLabel: string | null;
  claim: LabReading['claim'];
}

/** The reading as the client receives it: what the screens show and judge, no nested parse objects. */
export function compactReading(r: LabReading): LabReadingView {
  const raw = r.valueRaw != null && r.valueRaw.trim() !== r.valueShown.trim() ? r.valueRaw : null;
  return {
    v: r.version,
    role: r.role,
    kind: r.value.kind,
    comparator: r.value.comparator,
    measurement: r.measurement,
    valueShown: r.valueShown,
    valueRaw: raw,
    valueFrom: r.valueFrom,
    valueReadAs: r.valueReadAs,
    limit: limitWords(r.value),
    identity: labValueIdentity(r.value),
    unit: r.unit.unit,
    unitKey: r.unit.key,
    rangeShown: r.rangeShown,
    rangeStatus: r.range.status,
    rangeKind: r.range.kind,
    rangeLow: r.range.low,
    rangeLowComparator: r.range.lowComparator,
    rangeHigh: r.range.high,
    rangeHighComparator: r.range.highComparator,
    rangeUnitKey: unitKey(r.range.unitInRange) ?? r.unit.key,
    rangeUnit: r.range.unitInRange,
    rangeFromNumbersOnly: r.range.fromNumbersOnly,
    rangeReason: r.range.reason,
    lab: r.lab.name,
    labKey: r.lab.key,
    flagState: r.flag.state,
    flagRaw: r.flag.raw,
    flagPrinted: r.flag.printed,
    flagCritical: r.flag.critical,
    flagShown: r.flag.shown,
    computed: r.computed.flag,
    computedAgainst: r.computed.against,
    computedReason: r.computed.reason,
    warnings: r.warnings.map((w) => w.words),
    warningCodes: r.warnings.map((w) => w.code),
    dateKind: r.dates.readingKind,
    collected: r.dates.collected,
    resulted: r.dates.resulted,
    received: r.dates.received,
    sampleLabel: r.sampleLabel,
    claim: r.claim,
  };
}

/**
 * The keys of a LabReadingView that are often empty, each with its empty value (null, false or an empty list). The
 * Labs list endpoints send a reading without them (slimReadingView) and the client puts them back (hydrateReadingView),
 * so a value list does not carry forty mostly-null keys per value (2026-10 review, payload size).
 */
export const READING_VIEW_EMPTY: Readonly<Partial<LabReadingView>> = Object.freeze({
  comparator: null,
  measurement: null,
  valueRaw: null,
  valueReadAs: null,
  limit: null,
  unit: null,
  unitKey: null,
  rangeShown: null,
  rangeKind: null,
  rangeLow: null,
  rangeLowComparator: null,
  rangeHigh: null,
  rangeHighComparator: null,
  rangeUnitKey: null,
  rangeUnit: null,
  rangeFromNumbersOnly: false,
  rangeReason: null,
  lab: null,
  labKey: null,
  flagRaw: null,
  flagPrinted: null,
  flagCritical: false,
  computed: null,
  computedAgainst: null,
  computedReason: null,
  warnings: Object.freeze([]) as unknown as string[],
  warningCodes: Object.freeze([]) as unknown as LabWarningCode[],
  collected: null,
  resulted: null,
  received: null,
  sampleLabel: null,
  claim: null,
});

/** A reading without its empty keys (null, false, an empty list), for sending; hydrateReadingView puts them back. */
export function slimReadingView(v: LabReadingView): Partial<LabReadingView> {
  const out: Record<string, unknown> = { ...v };
  for (const k of Object.keys(READING_VIEW_EMPTY)) {
    const x = out[k];
    if (x === null || x === false || (Array.isArray(x) && x.length === 0)) delete out[k];
  }
  return out as Partial<LabReadingView>;
}

/** A reading as sent by a list endpoint, with every empty key put back (the exact view slimReadingView was given). */
export function hydrateReadingView(v: Partial<LabReadingView>): LabReadingView {
  const out: Record<string, unknown> = { ...v };
  for (const [k, empty] of Object.entries(READING_VIEW_EMPTY)) if (out[k] === undefined) out[k] = Array.isArray(empty) ? [] : empty;
  return out as unknown as LabReadingView;
}

// ---------------------------------------------------------------------------
// Rule 10: one document, two values that differ like a typing error
// ---------------------------------------------------------------------------

export interface CheckItem {
  id: string; // row id or `fact:<id>`
  factId: string | null;
  labResultId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  documentTier: string | null;
  pageNumber: number | null;
  citationId: string | null;
  analyte: string; // as written
  analyteKey: string;
  specimen: string;
  reading: LabReading;
  /** The verified quote of the value's citation, when there is one: a slot label in it keeps two values apart. */
  quote?: string | null;
}

export type ConflictKind = 'decimal_shift' | 'symbol_dropped' | 'digit_swap';
export interface SameSourceConflict {
  kind: ConflictKind;
  documentId: string;
  analyteKey: string;
  specimen: string;
  date: string | null;
  a: CheckItem;
  b: CheckItem;
  words: string;
}

const SLOT_LABEL = /tube\s*#?\s*\d|#\s*\d|\b(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\brepeat(?:ed)?\b|\bpost\b|\bpre\b|\bcorrected\b|\braw\b|\binitial\b|\bfinal\b/gi;

function slotLabels(s: string | null | undefined): string {
  const found = (s ?? '').toLowerCase().match(SLOT_LABEL) ?? [];
  return [...new Set(found.map((x) => x.replace(/\s+/g, '')))].sort().join('|');
}

/** Counts printed whole ("1200" and "120" are a tube 1 and a tube 4 more often than a typing error): a decimal point must be printed. */
const COUNT_KEYS = new Set(['csf rbc', 'csf cell count', 'csf cell count corrected']);

function plainDigits(v: ParsedValue): string | null {
  return v.numberText ? v.numberText.replace(/^-/, '').replace(/,/g, '') : null;
}

function isAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  if (diff.length !== 2 || diff[1] !== diff[0] + 1) return false;
  const [i, j] = diff;
  return /\d/.test(a[i]) && /\d/.test(a[j]) && a[i] === b[j] && a[j] === b[i];
}

function conflictKind(a: CheckItem, b: CheckItem): ConflictKind | null {
  const va = a.reading.value;
  const vb = b.reading.value;
  if (va.kind === 'censored' && vb.kind === 'number' && va.bound != null && vb.number != null && numbersEqual(va.bound, vb.number)) return 'symbol_dropped';
  if (vb.kind === 'censored' && va.kind === 'number' && vb.bound != null && va.number != null && numbersEqual(vb.bound, va.number)) return 'symbol_dropped';
  if (va.kind !== 'number' || vb.kind !== 'number' || va.number == null || vb.number == null || va.scientific || vb.scientific) return null;
  if (numbersEqual(va.number, vb.number)) return null;
  const pa = plainDigits(va) ?? '';
  const pb = plainDigits(vb) ?? '';
  const point = pa.includes('.') || pb.includes('.');
  if (va.number !== 0 && vb.number !== 0 && Math.sign(va.number) === Math.sign(vb.number) && va.digits === vb.digits) {
    const sig = (va.digits ?? '').length;
    const countRule = COUNT_KEYS.has(a.analyteKey) ? point : point || sig >= 2;
    if (countRule) return 'decimal_shift';
  }
  if (pa.length >= 2 && pa.indexOf('.') === pb.indexOf('.') && pa.replace('.', '').length >= 2 && isAdjacentSwap(pa, pb)) return 'digit_swap';
  return null;
}

function pageWords(i: CheckItem): string {
  return i.pageNumber != null ? ` (page ${i.pageNumber})` : '';
}

const KIND_WORDS: Record<ConflictKind, string> = {
  decimal_shift: 'They differ by a decimal point, so one may be a typing error.',
  symbol_dropped: 'They differ only by the sign before the number, so one may have lost it in copying.',
  digit_swap: 'They differ by two swapped digits, so one may be a typing error.',
};

/**
 * Two values of one test and sample in one document, on one day (within one document an undated value matches any
 * date), in one unit (or one unit unknown), that differ like a typing error: a decimal shift (0.08 / 0.8), a dropped
 * sign ("<3" / "3") or two swapped digits (62 / 26). Values with different slot labels (tube 1 / tube 4, a time,
 * "repeat", "corrected"...) in their names or sample labels, or any slot label in either verified quote, are a set,
 * not a conflict. Neither value is chosen.
 */
export function findSameSourceConflicts(items: CheckItem[]): SameSourceConflict[] {
  const groups = new Map<string, CheckItem[]>();
  for (const it of items) {
    if (!it.documentId || !it.analyteKey) continue;
    const k = `${it.documentId}\u0001${it.analyteKey}\u0001${it.specimen}`;
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const out: SameSourceConflict[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((x, y) => (x.pageNumber ?? 1e9) - (y.pageNumber ?? 1e9) || x.id.localeCompare(y.id));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const da = a.reading.dates.reading?.iso ?? null;
        const db = b.reading.dates.reading?.iso ?? null;
        if (da && db && da !== db) continue;
        if (a.reading.unit.key && b.reading.unit.key && a.reading.unit.key !== b.reading.unit.key) continue;
        if (slotLabels(a.analyte) !== slotLabels(b.analyte)) continue;
        const la = a.reading.sampleLabel ? normalizeKey(a.reading.sampleLabel) : null;
        const lb = b.reading.sampleLabel ? normalizeKey(b.reading.sampleLabel) : null;
        if (la && lb && la !== lb) continue;
        if (slotLabels(a.quote) || slotLabels(b.quote)) continue;
        const kind = conflictKind(a, b);
        if (!kind) continue;
        const date = da ?? db;
        const words = `This document gives two values for ${a.analyte}${date ? ` on ${date}` : ''}: ${a.reading.valueShown}${pageWords(a)} and ${b.reading.valueShown}${pageWords(b)}. ${KIND_WORDS[kind]} Neither was chosen; the original report decides.`;
        out.push({ kind, documentId: a.documentId!, analyteKey: a.analyteKey, specimen: a.specimen, date, a, b, words });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 12: a document's limit or judgement that differs from the lab report's
// ---------------------------------------------------------------------------

export interface ClaimDifference {
  kind: 'limit_differs' | 'judgement_differs';
  claim: CheckItem;
  record: CheckItem;
  words: string;
}

/** The days a reading can be matched on: its collected, resulted and reading dates, day precision only. */
function readingDays(r: LabReading): string[] {
  const out = new Set<string>();
  for (const d of [r.dates.collected, r.dates.resulted, r.dates.reading]) if (d?.iso && d.iso.length === 10) out.add(d.iso);
  return [...out];
}

/** A one-sided or two-sided range in the record's unit (converted when the units differ and a rule applies); null when it cannot be compared. */
function rangeIn(r: ParsedRange, fromUnit: string | null, toUnit: string | null, analyteKey: string): ParsedRange | null {
  if (!fromUnit || !toUnit || sameUnit(fromUnit, toUnit)) return r;
  const conv = (n: number | null) => (n == null ? null : (convertValue(n, fromUnit, toUnit, analyteKey)?.value ?? NaN));
  const low = conv(r.low);
  const high = conv(r.high);
  if ((low != null && Number.isNaN(low)) || (high != null && Number.isNaN(high))) return null;
  return { ...r, low, high };
}

function sameBound(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return numbersEqual(a, b);
}

/** A claim's limit against a record's printed range: true when they agree on the sides the claim states. */
function limitMatches(claim: ParsedRange, record: ParsedRange): boolean {
  if (claim.kind === 'upper') return record.high != null && sameBound(claim.high, record.high) && (claim.highComparator == null || record.highComparator == null || claim.highComparator === record.highComparator);
  if (claim.kind === 'lower') return record.low != null && sameBound(claim.low, record.low) && (claim.lowComparator == null || record.lowComparator == null || claim.lowComparator === record.lowComparator);
  if (claim.kind === 'interval') return sameBound(claim.low, record.low) && sameBound(claim.high, record.high);
  if (claim.kind === 'text') return record.kind === 'text' && normalizeKey(claim.text) === normalizeKey(record.text);
  return false;
}

function rangeUnitOf(item: CheckItem, r: ParsedRange): string | null {
  return r.unitInRange ?? item.reading.unit.unit;
}

function recordJudgement(r: LabReading): 'H' | 'L' | 'N' | 'A' | 'C' | null {
  if (r.flag.state === 'flag' && r.flag.printed) return r.flag.printed;
  return r.computed.flag;
}

function claimJudgement(r: LabReading): 'H' | 'L' | 'N' | 'A' | null {
  const fromWords = judgementOf(r.claim?.interpretation ?? null);
  if (fromWords) return fromWords;
  if (r.flag.state === 'flag' && r.flag.printed && r.flag.printed !== 'C') return r.flag.printed;
  return null;
}

function judgementConflicts(claim: 'H' | 'L' | 'N' | 'A', record: 'H' | 'L' | 'N' | 'A' | 'C'): boolean {
  if (claim === 'N') return record === 'H' || record === 'L' || record === 'A' || record === 'C';
  if (claim === 'H' || claim === 'L') return record === 'N';
  return claim === 'A' && record === 'N';
}

const JUDGEMENT_NAME: Record<string, string> = { N: 'normal', H: 'high', L: 'low', A: 'abnormal', C: 'critical or corrected' };

function sameValue(a: LabReading, b: LabReading, analyteKey: string): boolean {
  if (labValueIdentity(a.value) === labValueIdentity(b.value)) return !a.unit.key || !b.unit.key || a.unit.key === b.unit.key;
  if (a.measurement != null && b.measurement != null) {
    const c = convertValue(a.measurement, a.unit.unit, b.unit.unit, analyteKey);
    return c != null && numbersEqual(c.value, b.measurement);
  }
  return false;
}

/**
 * For each claimed reading (a summary, a patient note, an external copy), the lab reports (role printed) of the same
 * test, sample and day (a day equal to either side's collected or resulted day):
 * - limit_differs: the limit the document says it used (limitUsed, else its own range) differs from the lab's printed
 *   range after conversion, or is in words while the lab printed a range. The record from the lab the claim names is
 *   preferred; otherwise the claim must match none of that day's printed ranges.
 * - judgement_differs: the document calls the value normal where the record is high, low or abnormal (printed or by
 *   its own range), or high/low where the record is normal; compared with the record whose value matches the claim's
 *   when the claim gives one.
 * The record's value is never changed, and the claim is never set aside here.
 */
export function findClaimDifferences(items: CheckItem[]): ClaimDifference[] {
  const records = new Map<string, CheckItem[]>();
  for (const it of items) {
    if (it.reading.role !== 'printed') continue;
    for (const day of readingDays(it.reading)) {
      const k = `${it.analyteKey}\u0001${it.specimen}\u0001${day}`;
      const list = records.get(k);
      if (list) {
        if (!list.includes(it)) list.push(it);
      } else records.set(k, [it]);
    }
  }
  const out: ClaimDifference[] = [];
  for (const claim of items) {
    if (claim.reading.role !== 'claimed') continue;
    const found = new Set<CheckItem>();
    for (const day of readingDays(claim.reading)) for (const r of records.get(`${claim.analyteKey}\u0001${claim.specimen}\u0001${day}`) ?? []) if (r.documentId !== claim.documentId) found.add(r);
    if (!found.size) continue;
    const all = [...found];
    const named = claim.reading.lab.key ? all.filter((r) => r.reading.lab.key === claim.reading.lab.key) : [];
    const pool = named.length ? named : all;
    const date = claim.reading.dates.reading?.iso ?? readingDays(claim.reading)[0] ?? null;
    const test = claim.analyte;
    // The document that makes the claim, by name: shown on the lab report's own value, "this document" would read as the report.
    const who = claim.documentTitle ? `"${claim.documentTitle}"` : 'This document';

    // Limits.
    const limitText = claim.reading.claim?.limitUsed ?? null;
    const claimLimit = limitText ? parseLimitUsed(limitText) : claim.reading.range.status === 'parsed' && !claim.reading.range.fromNumbersOnly ? claim.reading.range : null;
    const printedRanges = pool.filter((r) => r.reading.range.status === 'parsed' && !r.reading.range.fromNumbersOnly);
    if (claimLimit && printedRanges.length) {
      const claimShown = limitText ? `"${limitText.trim()}"` : (claim.reading.rangeShown ?? '');
      if (claimLimit.status === 'parsed') {
        const compared = printedRanges.map((r) => {
          const conv = rangeIn(claimLimit, rangeUnitOf(claim, claimLimit), rangeUnitOf(r, r.reading.range), claim.analyteKey);
          return { r, matches: conv != null && limitMatches(conv, r.reading.range), comparable: conv != null };
        });
        const anyMatch = compared.some((c) => c.matches);
        if (!anyMatch) {
          const target = compared.find((c) => c.comparable)?.r;
          if (target) {
            const recShown = target.reading.rangeShown ?? '';
            const unitWords = (s: string, u: string | null) => (u && !s.includes(u) ? `${s} ${u}` : s);
            out.push({
              kind: 'limit_differs',
              claim,
              record: target,
              words: `${who} uses ${unitWords(claimShown, limitText ? null : rangeUnitOf(claim, claimLimit))} for ${test}${date ? ` on ${date}` : ''}; the lab report printed ${unitWords(recShown, rangeUnitOf(target, target.reading.range))}.`,
            });
          }
        }
      } else if (claimLimit.status === 'unparsed') {
        const target = printedRanges[0];
        out.push({
          kind: 'limit_differs',
          claim,
          record: target,
          words: `${who} judges ${test}${date ? ` on ${date}` : ''} by "${(limitText ?? '').trim()}" (as written); the lab report printed ${target.reading.rangeShown ?? 'a range'}.`,
        });
      }
    }

    // Judgements.
    const cj = claimJudgement(claim.reading);
    if (cj) {
      const hasValue = claim.reading.value.kind === 'number' || claim.reading.value.kind === 'censored';
      const candidates = hasValue ? pool.filter((r) => sameValue(claim.reading, r.reading, claim.analyteKey)) : pool;
      const judged = candidates.map((r) => ({ r, j: recordJudgement(r.reading) })).filter((x) => x.j != null) as Array<{ r: CheckItem; j: 'H' | 'L' | 'N' | 'A' | 'C' }>;
      if (judged.length && judged.every((x) => judgementConflicts(cj, x.j))) {
        const t = judged[0];
        const how = t.r.reading.flag.state === 'flag' && t.r.reading.flag.printed ? `flagged ${(t.r.reading.flag.raw ?? '').trim()}` : `${JUDGEMENT_NAME[t.j]} by its own range`;
        const rec = `${t.r.reading.valueShown}${t.r.reading.unit.unit ? ` ${t.r.reading.unit.unit}` : ''}${t.r.reading.rangeShown ? ` with the range ${t.r.reading.rangeShown}` : ''} (${how})`;
        out.push({ kind: 'judgement_differs', claim, record: t.r, words: `${who} calls ${test}${date ? ` on ${date}` : ''} ${JUDGEMENT_NAME[cj]}; the lab report printed ${rec}.` });
      }
    }
  }
  return out;
}
