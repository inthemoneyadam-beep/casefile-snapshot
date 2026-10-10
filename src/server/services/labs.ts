/**
 * Labs: the ledger of measured values with their reference ranges, flags and
 * provenance. Two sources are merged into one list of entries:
 *   - `lab_results` rows (hand-entered, imported, or seeded), and
 *   - `lab_result` facts the model extracted that have not been imported yet
 *     (virtual entries with id `fact:<factId>`; "from facts" turns them into
 *     rows without losing the link).
 * Every entry points back at its evidence: the document and the page of the
 * fact's first citation (verified first). Analytes are grouped with
 * `normalizeAnalyte` (src/shared/analytes.ts), an audited synonym table that
 * folds the spellings of one test ("sed rate" / "ESR", "CSF WBC" / "nucleated
 * cells") into one key, never two different tests with similar names, and
 * that reads a bare "protein" on a CSF specimen as CSF protein.
 *
 * Every entry carries its `reading` (src/shared/labvalues.ts, read through
 * services/lab-reading.ts): the value, unit, range and flag as printed, a limit
 * ("<3") never a measurement, a flag worked out from the value's own range
 * always marked as such, the collected and resulted dates apart (the user's rules,
 * 2026-10). The legacy fields (valueNum, valueText, refLow...) are filled from it.
 *
 * `findLabSeries` and `buildLabChart` are the functions the consult's
 * `get_lab_series` / `chart_lab_series` tools call.
 */
import { z } from 'zod';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { badRequest, conflict, notFound, parseOrThrow } from '../util/errors';
import { onLockChange } from '../auth';
import { indexEntity, removeEntityIndex } from './search';
import { createManualFact } from './facts';
import { compareLabReading, NO_DATE_REASON, passSetAsideIds, SEPARATE_MARKER, SEVERAL_TESTS_REASON, trustFor, type LabReading as ReconcileLabReading } from './reconcile';
import type { TrustInfo } from '../../shared/reconcile';
import { getMedicationTimeline, medicationCourse, medicationLanes } from './medications';
import { LAB_FLAGS, SPECIMENS } from '../../shared/enums';
import { dateSortKey, formatPartialDate, parsePartialDate, type DatePrecision, type PartialDate } from '../../shared/dates';
import { chartSpec, chartX, type ChartBand, type ChartMarker, type ChartPoint, type ChartSeries, type ChartSpec } from '../../shared/chart';
import {
  BLOOD_SAMPLE,
  CSF_ONLY_KEYS,
  CSF_TOKEN,
  LOOKALIKE_FAMILIES,
  LP_WORDS,
  SPECIMEN_LABELS,
  analyteLabel,
  clearNormalizeMemo,
  defaultSpecimenFor,
  effectiveSpecimen,
  isCsfOnlyKey,
  isKnownKey,
  matchAnalyte,
  nameKeyOf,
  normalizeAnalyte,
  type AnalyteMatch,
} from '../../shared/analytes';
import {
  MMHG_IN_MMH2O,
  buildLabReading,
  clearReadingMemo,
  compactReading,
  computeFlag,
  convertValue,
  formatRange,
  labValueIdentity,
  numberOnlyValue,
  parseFlag,
  parseLabValue,
  parseRefRange,
  rangeFromNumbers,
  unitKey,
  type LabReading,
  type LabReadingView,
  type ReadingRole,
} from '../../shared/labvalues';
import { LAB_FORM_NOTE, pageValueOf, projectReading, readingForFact, readingForRow, readParseJson, rowRawSource, withUserFields, type CiteLite, type FactLite, type LabParseJson, type LabReadingRecord, type LabUserField } from './lab-reading';
import { COMPUTED_SOURCE, INPUT_CHANGED, computedTitle, markComputedEntries, readComputedRecord, typedRangeLabel, type ComputedView } from '../../shared/labcompute';
import { typedRangeFor } from './lab-computed-ranges';

// ---------------------------------------------------------------------------
// Analyte normalisation: the audited synonym table lives in src/shared/analytes.ts (rule 9, 2026-10), shared with the
// browser. The names other modules and tests still import from here are re-exported; new code imports them from there.
// ---------------------------------------------------------------------------

export { analyteLabel, defaultSpecimenFor, effectiveSpecimen, namesCsfSample, normalizeAnalyte } from '../../shared/analytes';

/** A line name that says its sample is blood: a blood sample word, or a blood panel ("CBC", "BMP", "metabolic panel"). */
const BLOOD_NAME = /\b(?:cbc|bmp|cmp|complete blood count|blood count|metabolic panel|hemogram|haemogram|electrolytes|lft|lfts|liver function|renal function)\b/;

const BLOOD_SPECIMENS = new Set(['serum', 'plasma', 'whole_blood']);

/**
 * The specimen a name piece or label states: CSF for a CSF label ("CSF IgG"), plasma or whole blood when it says so,
 * serum for "serum", and for any other blood word ("blood glucose", "fasting glucose") the line's own blood sample, else
 * serum. Null when the piece states none (it is read on the line's sample).
 */
function pieceSpecimen(label: string, lineSpecimen: string | null | undefined): string | null {
  const k = nameKeyOf(label);
  if (CSF_TOKEN.test(k)) return 'csf';
  if (/\bplasma\b/.test(k)) return 'plasma';
  if (/\bwhole blood\b/.test(k)) return 'whole_blood';
  if (/\bserum\b/.test(k)) return 'serum';
  if (BLOOD_SAMPLE.test(k)) return lineSpecimen && BLOOD_SPECIMENS.has(lineSpecimen) ? lineSpecimen : 'serum';
  return null;
}

/** Words of tests that exist both in blood and in CSF (or urine): their sample must be stated to tell them apart. */
const BOTH_SAMPLES_WORDS =
  /\b(?:protein|proteins|glucose|sugar|albumin|ig[gam]|wbc|wbcs|white|leu[ck]ocytes?|rbc|rbcs|red|erythrocytes?|lactate|lactic|ldh|ld|cells?|cell count|nucleated|tnc|differential|diff|neutrophils?|lymphocytes?|monocytes?|eosinophils?|polys|segs|lymphs|monos|pcr|culture|gram|antigen|crag|vdrl|rpr|antibody|antibodies|ab|oligoclonal|ocb|ocbs|kappa|lambda|kflc|ace|appearance|colou?r|clarity|turbidity|xanthochromia|cytology|ferritin|chloride)\b/;

/** A test that exists in blood and in CSF ("protein", "WBC", "glucose", "HSV PCR"): read by its label alone, its sample is unknown. */
function inBothSamples(label: string): boolean {
  return BOTH_SAMPLES_WORDS.test(nameKeyOf(label)) || normalizeAnalyte(label, 'csf') !== normalizeAnalyte(label, 'serum');
}

// ---------------------------------------------------------------------------
// Lines that hold several tests ("CSF opening pressure / protein: OP 17; protein 52")
// ---------------------------------------------------------------------------

/** Where a part came from: the line as written, the part's 0-based place in it, and how many parts it has. */
export interface LabSplitFrom {
  /** `<name>: <value as written>` ("CSF opening pressure / protein: OP 17; protein 52"). */
  text: string;
  index: number;
  of: number;
}

/** One test read out of a line that holds several. */
export interface LabPart {
  /** 0-based place in the line. */
  index: number;
  of: number;
  /** The test's name as listed ("Opening pressure", "CSF protein"). */
  analyte: string;
  /** The label or name piece as written in the line ("OP", "protein", "RBC"). */
  label: string;
  analyteKey: string;
  /** The part's value as written, without its label, unit or flag ("19", "<2", "Colorless"). */
  valueText: string;
  /** The number when the value is a plain number ("<2" has none). */
  valueNum: number | null;
  /** Only a unit written with this part: never one borrowed from another part or from the line. */
  unit: string | null;
  /** A flag written with this part ("58 L"); never the line's own flag. */
  flag: string | null;
  /** That flag exactly as printed ("HH", "(normal)", "*", "-" for a dash: no flag printed); null when none is written. */
  flagRaw: string | null;
  /**
   * The specimen this part's own label states: 'csf' for a CSF label ("CSF IgG"), 'serum' (or the stated plasma /
   * whole blood) for a blood one ("serum glucose", "blood glucose"); null when the label states none and the part is
   * read on the line's sample. A blood value on a CSF line is never filed under CSF, nor a CSF value under blood.
   */
  specimen: string | null;
}

export interface LabLineInput {
  analyte: string | null | undefined;
  valueText: string | null | undefined;
  /** Accepted for symmetry; a part never borrows the line's unit. */
  unit?: string | null;
  specimen?: string | null;
  /**
   * The specimen was stated by the source (default true). False when it is only assumed (a fact that names no sample,
   * read on defaultSpecimenFor): such a line is never split into tests that exist in both blood and CSF unless its
   * name says the sample (CSF, a lumbar puncture, a blood panel); it is kept whole and marked combined.
   */
  specimenStated?: boolean;
}

/** How a line reads: its parts when it splits cleanly, else whether it names several tests the app cannot tell apart. */
export interface LabLineRead {
  parts: LabPart[] | null;
  /** The line names several tests but its values cannot be matched to them ("CSF glucose/PCR/cytokines: normal/negative"). */
  combined: boolean;
}

/** A piece of a name that only names a sample ("Albumin, CSF"): the specimen, not a test. */
const SPECIMEN_ONLY = /^(?:csf|serum|plasma|whole blood|blood|urine|fluid)(?: (?:specimen|sample|fluid))?$/;
/** A name that is one test made of several (a ratio, an index): never a line of several tests. */
const ONE_TEST_NAME = /\b(?:ratio|ratios|index|indices|quotient|gradient)\b/;
/** Bare antibody class words: within a named infection ("Lyme IgG/IgM") they are that infection's antibodies, not total IgG. */
const CLASS_WORDS = new Set(['igg', 'igm', 'iga']);
const PATHOGEN_WORDS =
  /\b(?:lyme|borrelia|hsv|herpes|vzv|varicella|zoster|cmv|cytomegalovirus|ebv|epstein|hiv|measles|mumps|rubella|toxoplasma|toxo|west nile|syphilis|treponema|treponemal|mycoplasma|bartonella|hepatitis|covid|sars|influenza|parvovirus|strep|antibody|antibodies|ab|abs|serology|virus|viral|bacterial|fungal|cryptococcal|coccidioides|histoplasma|enterovirus)\b/;
/** A value that starts with a number (a qualifier first is allowed: "<2", ">= 5"). */
const VALUE_START = /^(?:<=|>=|=<|=>|[<>≤≥~])?\s*[-+]?(?:\d|\.\d)/;
/** A value in words only ("Colorless", "not detected"). */
const TEXT_VALUE = /^[a-z][a-z' -]*$/i;
/** What may follow a unit's slash ("mg/dL", "cells/uL", "x10^9/L", "/hpf"). */
const UNIT_AFTER_SLASH = /^\s?(?:d?l|ml|ul|µl|μl|mm3|mm³|cumm|cu ?mm|hpf|lpf|h|hr|hrs|hour|min|kg|day|24 ?h|24 ?hrs?|s|sec)\b/i;
/** Unit words a part may carry after its number ("cc", "mg/dL", "cmH2O", "%"). Anything else after the number is words ("15 raw"). */
const UNIT_WORD =
  /^(?:%|cc|ml|dl|l|ul|fl|pg|mm|cm|kpa|mmhg|cmh2o|mmh2o|cmh20|mmh20|torr|s|sec|min|h|hr|hrs|cells?|iu|u|mu|miu|units?|mg|g|ug|mcg|ng|mmol|umol|nmol|pmol|meq|mosm|x10\S*|10\^\S*|k)$/i;
const FLAG_BRACKET = /\s*(?:\(\s*(hh|ll|h|l|a|c|n|high|low|abn|abnormal|crit|critical|normal)\s*\)|\[\s*(hh|ll|h|l|a|c|n)\s*\]|(\*+))\s*$/i;
/**
 * A flag printed after a part's number: the letters in upper case only ("5 h" is hours, "3 l" litres, as the shared
 * parser reads them), the words in any case. A lone "L" with no unit before it is litres or low: not read as a flag.
 */
const FLAG_WORD = /\s+(HH|LL|H|L|[Hh][Ii][Gg][Hh]|[Ll][Oo][Ww]|[Aa][Bb][Nn][Oo][Rr][Mm][Aa][Ll]|[Cc][Rr][Ii][Tt][Ii][Cc][Aa][Ll])\s*$/;
const FLAG_OF: Record<string, string> = { h: 'H', hh: 'H', high: 'H', l: 'L', ll: 'L', low: 'L', a: 'A', abn: 'A', abnormal: 'A', c: 'C', crit: 'C', critical: 'C', n: 'N', normal: 'N' };

/** Split text at separators outside brackets; `sepAt` gives the separator's length at a position (0 for none). */
function splitOutside(text: string, sepAt: (s: string, i: number) => number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    else if (depth === 0) {
      const n = sepAt(text, i);
      if (n > 0) {
        out.push(text.slice(start, i));
        start = i + n;
        i += n - 1;
      }
    }
  }
  out.push(text.slice(start));
  return out.map((p) => p.trim());
}

/** Separators between the tests a name lists: "/", ",", ";", "&", " and ", " + " ("HSV 1/2" keeps its slash). */
function nameSepAt(s: string, i: number): number {
  const c = s[i];
  if (c === ',' || c === ';' || c === '&') return 1;
  if (c === '/') return /\d\s*$/.test(s.slice(0, i)) && /^\s*\d/.test(s.slice(i + 1)) ? 0 : 1;
  if (c === ' ') {
    const m = /^ (?:and|\+) /i.exec(s.slice(i));
    if (m) return m[0].length;
  }
  return 0;
}

/**
 * Separators between the values of a line: ";", "," (not a thousands comma: "1,200"), "/" (not a unit's: "mg/dL").
 * A slash between two numbers ("15/10") separates only when the name lists the tests the values belong to.
 */
function valueSepAt(betweenNumbers: boolean): (s: string, i: number) => number {
  return (s, i) => {
    const c = s[i];
    if (c === ';') return 1;
    if (c === ',') return /\d$/.test(s.slice(0, i)) && /^\d{3}(?!\d)/.test(s.slice(i + 1)) ? 0 : 1;
    if (c !== '/') return 0;
    const before = s.slice(0, i);
    const after = s.slice(i + 1);
    if (/[A-Za-zµμ0-9^³]$/.test(before) && UNIT_AFTER_SLASH.test(after)) return 0;
    if (!betweenNumbers && /\d\s*$/.test(before) && /^\s*(?:[<>≤≥]=?)?\s*\d/.test(after)) return 0;
    return 1;
  };
}

/**
 * The specimen a name piece or label is read on: the one it states (blood when it names blood, "blood glucose"; CSF
 * when it says CSF), else CSF when the line is CSF, else the entry's.
 */
function contextFor(label: string, csf: boolean, specimen: string | null | undefined): string | null {
  return pieceSpecimen(label, specimen) ?? (csf ? 'csf' : (specimen ?? null));
}

/** Keys the shared table names as tests of their own (rule 9): a bare "protein" is its own test, not total protein. */
const OWN_TEST_KEYS = new Set(LOOKALIKE_FAMILIES.flat());

/** A test the app knows by name: a key of the synonym table, or a test of its own among similar names ("protein"). */
function knownTestKey(key: string): boolean {
  return isKnownKey(key) || OWN_TEST_KEYS.has(key);
}

/** The canonical key of a label when it is a known test; a bare class word ("IgG") only when `classOk`. */
function knownKey(label: string, ctx: string | null, classOk: boolean): string | null {
  if (!classOk && CLASS_WORDS.has(normalizeKey(label).replace(/\bcsf\b/g, '').trim())) return null;
  const k = normalizeAnalyte(label, ctx);
  return knownTestKey(k) ? k : null;
}

/** A dash printed after a part's number ("60 -"): the flag column printed nothing (rule 4), not a word of the value. */
const FLAG_DASH = /\s+[-–—]+\s*$/;

/** A part's value as written: its number (or words), a unit written with it, a flag written with it (and that flag as printed). */
function parsePartValue(raw: string): { valueText: string; valueNum: number | null; unit: string | null; flag: string | null; flagRaw: string | null } | null {
  let t = raw.trim().replace(/^[:=]\s*/, '');
  let flag: string | null = null;
  let flagRaw: string | null = null;
  const fb = t.match(FLAG_BRACKET);
  if (fb && fb.index && fb.index > 0) {
    flag = fb[3] ? 'A' : (FLAG_OF[(fb[1] ?? fb[2] ?? '').toLowerCase()] ?? null);
    flagRaw = fb[0].trim();
    t = t.slice(0, fb.index).trim();
  } else if (VALUE_START.test(t)) {
    const fw = t.match(FLAG_WORD);
    const fd = fw ? null : t.match(FLAG_DASH);
    // "58 L" (no unit before the L): litres or low, so neither; kept in the value as written (the shared parser reads it so).
    const loneL = Boolean(fw && fw[1] === 'L' && /^(?:<=|>=|=<|=>|[<>≤≥~])?\s*[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)$/.test(t.slice(0, fw.index).trim()));
    if (fw && fw.index && fw.index > 0 && !loneL) {
      flag = FLAG_OF[fw[1].toLowerCase()] ?? null;
      flagRaw = fw[1];
      t = t.slice(0, fw.index).trim();
    } else if (loneL) {
      return { valueText: t, valueNum: parseNumeric(t.slice(0, fw!.index).trim()), unit: null, flag: null, flagRaw: null };
    } else if (fd && fd.index && fd.index > 0) {
      flagRaw = fd[0].trim();
      t = t.slice(0, fd.index).trim();
    }
  }
  if (!t) return null;
  const m = t.match(/^((?:<=|>=|=<|=>|[<>≤≥~])?\s*[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*(.*)$/);
  if (m) {
    const num = m[1].trim();
    const rest = m[2].trim();
    const plain = parseNumeric(num);
    if (!rest) return { valueText: num, valueNum: plain, unit: null, flag, flagRaw };
    const u = rest.replace(/\s+/g, '').toLowerCase().replace(/[µμ]/g, 'u');
    if (/^[a-z%µμ/x^0-9.³]+$/i.test(rest.replace(/\s+/g, '')) && (UNIT_WORD.test(u) || (/\//.test(u) && /[a-z]/.test(u)))) return { valueText: num, valueNum: plain, unit: rest, flag, flagRaw };
    // Words after the number ("15 raw"): kept as written, not a plain number.
    return { valueText: t, valueNum: null, unit: null, flag, flagRaw };
  }
  return { valueText: t, valueNum: null, unit: null, flag, flagRaw };
}

/** A value piece of a positional line: a number (with its qualifier) or a few words. */
function looksLikeValue(v: string): boolean {
  return VALUE_START.test(v) || (TEXT_VALUE.test(v) && v.split(/\s+/).length <= 4);
}

/** "OP 17", "RBC <2", "protein: 52 mg/dL", "HSV PCR not detected": the label (a known test) and the value after it. */
function labelledSegment(seg: string, csf: boolean, specimen: string | null | undefined, classOk: boolean): { label: string; key: string; rest: string } | null {
  const s = seg
    .replace(/([A-Za-z)\]])\s*([<>≤≥])/g, '$1 $2')
    .replace(/([A-Za-z)\]])\s*[:=]\s*/g, '$1 ')
    .trim();
  const words = s.split(/\s+/);
  if (words.length < 2) return null;
  for (let k = Math.min(6, words.length - 1); k >= 1; k--) {
    const label = words.slice(0, k).join(' ');
    const rest = words.slice(k).join(' ');
    if (!VALUE_START.test(rest) && !(TEXT_VALUE.test(rest) && rest.split(' ').length <= 3)) continue;
    const key = knownKey(label, contextFor(label, csf, specimen), classOk);
    if (key) return { label, key, rest };
  }
  return null;
}

/** "nucleated 1", "OP: 19": a label in words, then a number. */
const LABEL_THEN_NUMBER = /^[A-Za-z][A-Za-z0-9 .'()-]*?\s*[:=]?\s*(?:<=|>=|[<>≤≥~])?\s*[-+]?\d/;

const NO_SPLIT: LabLineRead = { parts: null, combined: false };
const LINE_MEMO = new Map<string, LabLineRead>();

// The memos of lab lines, readings and analyte names hold text from the record: dropped when the case locks, as the
// reconciliation model is (sweep 2026-10-07, PAT-2).
onLockChange((unlocked) => {
  if (unlocked) return;
  LINE_MEMO.clear();
  clearReadingMemo();
  clearNormalizeMemo();
});

/**
 * How a lab line reads when its name or value holds several tests:
 *   a) labelled parts: the value is label + value pairs ("OP 16; protein 49", "nucleated 2, RBC 11, glucose 58,
 *      protein 44", "WBC 4, RBC <3") whose labels are all known tests (read on CSF when the line is CSF): one part each;
 *   a2) the name is one known test, the value starts with that test's own value, and every other piece is labelled with
 *      another known test ("Opening pressure: 24 cm H2O; closing 14"): the name's test, then one part per label;
 *   b) by position: the name lists N known tests ("CSF cell count / RBC", "CSF Color / Appearance") and the value has
 *      exactly N parts ("<4 / <3", "Colorless; Clear"): part i is test i;
 *   c) otherwise no split; `combined` when the name lists several tests the values cannot be matched to ("CSF
 *      glucose/PCR/cytokines: normal/negative") or the value is label + number pairs the app does not know. Under a
 *      name that is one known test, only when at least two different known tests are labelled in the value ("Protein
 *      49 mg/dL, reference 15-45", "WBC raw 14, WBC corrected 9" stay one test, compared as usual).
 * A value with descriptive extras ("clear without evidence of hemorrhage; 8 cc") is never split into invented parts.
 * A name that is itself one known test ("ICP (opening pressure)", "CSF/serum albumin ratio") is never several by its name.
 *
 * The line is read on CSF when its specimen is CSF or its name says CSF or a lumbar puncture ("Lumbar puncture", "LP",
 * "LP results", "Spinal tap", "CSF studies"). Each part keeps the specimen its own label states (LabPart.specimen):
 * "serum glucose" on a CSF line is a blood value. A line whose specimen is only assumed (specimenStated false) and
 * whose name says no sample is read on CSF when one of its tests exists only in CSF ("OP 16; protein 49"); otherwise it
 * is never split into tests that exist in both blood and CSF: it is kept whole and marked combined.
 */
export function readLabLine(input: LabLineInput): LabLineRead {
  const analyte = (input.analyte ?? '').trim();
  const text = (input.valueText ?? '').trim();
  if (!analyte || !text || !/[;,/&]|\s(?:and|\+)\s/i.test(`${analyte} ${text}`)) return NO_SPLIT;
  const stated = input.specimenStated !== false;
  const memoKey = `${input.specimen ?? ''}\u0001${stated ? 1 : 0}\u0001${analyte}\u0001${text}`;
  const hit = LINE_MEMO.get(memoKey);
  if (hit) return hit;
  const out = readLabLineUncached(analyte, text, input.specimen ?? null, stated);
  if (LINE_MEMO.size >= 20000) LINE_MEMO.clear();
  LINE_MEMO.set(memoKey, out);
  return out;
}

function readLabLineUncached(analyte: string, text: string, specimen: string | null, stated: boolean): LabLineRead {
  const read = readLabLineOn(analyte, text, specimen);
  if (stated || !read.parts) return read;
  const nameKey = nameKeyOf(analyte);
  // The name says the sample (CSF, a lumbar puncture, blood): the line is read on it.
  if (CSF_TOKEN.test(nameKey) || LP_WORDS.test(nameKey) || BLOOD_SAMPLE.test(nameKey) || BLOOD_NAME.test(nameKey)) return read;
  // A test that exists only in CSF (opening pressure, IgG index, "CSF protein") says the line is a lumbar puncture's.
  if (read.parts.some((p) => isCsfOnlyKey(p.analyteKey))) {
    const csf = normalizeKey(specimen) === 'csf' ? read : readLabLineOn(analyte, text, 'csf');
    if (csf.parts) return { combined: false, parts: csf.parts.map((p) => ({ ...p, specimen: p.specimen ?? 'csf' })) };
    return csf;
  }
  // Otherwise a test that exists in blood and in CSF, with no sample of its own, cannot be filed: the line stays whole.
  if (read.parts.some((p) => !p.specimen && !isCsfOnlyKey(p.analyteKey) && inBothSamples(p.label))) return { parts: null, combined: true };
  return read;
}

function readLabLineOn(analyte: string, text: string, specimen: string | null): LabLineRead {
  const nameKey = nameKeyOf(analyte);
  const csf = normalizeKey(specimen) === 'csf' || CSF_TOKEN.test(nameKey) || LP_WORDS.test(nameKey);
  const classOk = !PATHOGEN_WORDS.test(nameKey);
  const named = (key: string, label: string) => analyteLabel(key, label);
  const part = (i: number, of: number, key: string, label: string, v: NonNullable<ReturnType<typeof parsePartValue>>): LabPart => ({
    index: i,
    of,
    analyte: named(key, label),
    label,
    analyteKey: key,
    ...v,
    specimen: pieceSpecimen(label, specimen),
  });
  const whole = normalizeAnalyte(analyte, csf ? 'csf' : specimen);

  // a) Labelled parts.
  const segs = splitOutside(text, valueSepAt(false));
  const labelled = segs.length >= 2 && segs.every(Boolean) ? segs.map((s) => labelledSegment(s, csf, specimen, classOk)) : [];
  if (labelled.length && labelled.every(Boolean) && new Set(labelled.map((r) => r!.key)).size === labelled.length) {
    const values = labelled.map((r) => parsePartValue(r!.rest));
    if (values.every(Boolean)) return { combined: false, parts: labelled.map((r, i) => part(i, labelled.length, r!.key, r!.label, values[i]!)) };
  }

  // a2) The name's own test first, then other tests by their labels ("Opening pressure: 26 cm H2O; closing 16").
  if (knownTestKey(whole) && labelled.length && !labelled[0] && VALUE_START.test(segs[0])) {
    const rest = labelled.slice(1);
    if (rest.every(Boolean) && new Set([whole, ...rest.map((r) => r!.key)]).size === segs.length) {
      const first = parsePartValue(segs[0]);
      const values = rest.map((r) => parsePartValue(r!.rest));
      if (first && values.every(Boolean)) {
        return { combined: false, parts: [part(0, segs.length, whole, analyte, first), ...rest.map((r, i) => part(i + 1, segs.length, r!.key, r!.label, values[i]!))] };
      }
    }
  }

  // The tests the name lists (pieces that only name the sample, "Albumin, CSF", say the specimen).
  const pieces = splitOutside(analyte, nameSepAt).filter((p) => {
    const k = nameKeyOf(p);
    return k && !SPECIMEN_ONLY.test(k);
  });
  const oneTest = knownTestKey(whole) || ONE_TEST_NAME.test(nameKey) || pieces.length < 2;
  const keys = oneTest ? [] : pieces.map((p) => knownKey(p, contextFor(p, csf, specimen), true));

  // b) By position.
  const values = splitOutside(text, valueSepAt(true));
  if (!oneTest && keys.every(Boolean) && new Set(keys).size === keys.length && values.length === pieces.length && values.every((v) => v && looksLikeValue(v))) {
    const parsed = values.map((v) => parsePartValue(v));
    if (parsed.every(Boolean)) return { combined: false, parts: pieces.map((p, i) => part(i, pieces.length, keys[i]!, p, parsed[i]!)) };
  }

  // c) Kept whole: is it a line of several tests?
  const known = keys.filter(Boolean).length;
  const valueParts = values.filter(Boolean).length;
  const byName = !oneTest && ((known >= 1 && valueParts >= 2) || (known === pieces.length && !VALUE_START.test(text)));
  // Under one known test's name, a note or a reference range after the value is no second test: only two different
  // known tests labelled in the value make it a line of several.
  const labelledKeys = new Set(labelled.filter(Boolean).map((r) => r!.key));
  const byLabels = segs.length >= 2 && segs.every((s) => LABEL_THEN_NUMBER.test(s)) && labelledKeys.size >= 2;
  return { parts: null, combined: byName || byLabels };
}

/** The parts of a line that holds several tests, or null. */
export function splitCombinedLab(input: LabLineInput): LabPart[] | null {
  return readLabLine(input).parts;
}

/** A line that names several tests the app could not tell apart (kept whole, labelled, not compared). */
export function isCombinedLab(input: LabLineInput): boolean {
  return readLabLine(input).combined;
}

// ---------------------------------------------------------------------------
// Panel taxonomy: which panel an analyte belongs to, so the CSF studies stack
// together, a CBC reads as a CBC, and a document's results sit under headers.
// ---------------------------------------------------------------------------

export type PanelSpecimen = 'csf' | 'serum' | 'urine' | 'other';

export interface LabPanel {
  specimen: PanelSpecimen;
  panel: string;
  /** Display order of the panel inside its specimen. */
  order: number;
  /** Report order of the analyte inside its panel (-1 when the analyte is not a named member). */
  position: number;
}

/** Display order of the specimen groups: CSF first, as everywhere else in the labs ledger. */
export const PANEL_SPECIMEN_ORDER: PanelSpecimen[] = ['csf', 'serum', 'urine', 'other'];
export const PANEL_SPECIMEN_LABELS: Record<PanelSpecimen, string> = { csf: 'CSF', serum: 'Serum', urine: 'Urine', other: 'Other specimens' };

/** Raw specimen -> taxonomy bucket. Plasma and whole blood are blood work and read as serum. */
export function panelSpecimenFor(specimen: string | null | undefined): PanelSpecimen {
  const s = normalizeKey(specimen).replace(/ /g, '_');
  if (s === 'csf') return 'csf';
  if (s === 'serum' || s === 'plasma' || s === 'whole_blood' || s === 'blood') return 'serum';
  if (s === 'urine') return 'urine';
  return 'other';
}

interface PanelDef {
  panel: string;
  /** Named members (canonical keys) in report order. */
  keys: string[];
  /** Specific patterns over the normalised key, tried in panel order before any loose pattern. */
  match: RegExp[];
  /** Generic patterns, tried only when no panel matched specifically. */
  loose?: RegExp[];
}

const CSF_PANELS: PanelDef[] = [
  {
    panel: 'CSF basic',
    keys: ['opening pressure', 'csf protein', 'csf glucose', 'csf cell count', 'csf cell count corrected', 'csf rbc', 'csf lactate', 'closing pressure', 'csf appearance', 'csf color', 'csf xanthochromia', 'csf ldh', 'csf serum glucose ratio'],
    match: [
      /\bopening pressure\b/, /\b(appearance|colou?r|clarity|turbid|xanthochrom|clear|cloudy)\b/, /\b(differential|diff|neutrophil|lymphocyte|monocyte|eosinophil|mononuclear|polymorph|pmn|segs|polys|lymphs|monos)\b/,
      /\bprotein\b/, /\bglucose\b/, /\b(wbc|rbc|cells?|nucleated|leu[ck]ocyte|erythrocyte|cell count)\b/, /\blactate\b|\blactic\b/, /\bldh\b/,
    ],
  },
  {
    panel: 'CSF immunology',
    keys: ['oligoclonal bands', 'igg index', 'igg synthesis rate', 'albumin index', 'albumin quotient', 'csf igg', 'csf albumin', 'csf kappa free light chains', 'csf myelin basic protein'],
    match: [/oligoclonal|\bocb\b/, /\bigg (index|synthesis|ratio|quotient)\b/, /\balbumin\b|\bqalb\b/, /\bkappa\b|\bkflc\b|\blambda\b|free light chain|\bflc\b/, /intrathecal/, /\bmrz\b/],
    // A bare "IgG" is immunology, but "HSV IgG" is infectious: the pathogen patterns run first.
    loose: [/\bigg\b|\bigm\b|\biga\b/],
  },
  {
    panel: 'CSF autoimmune and paraneoplastic',
    keys: [],
    match: [
      /nmda/, /\blgi ?1\b/, /\bcaspr ?2\b/, /\bgad ?65\b|\bgad\b|glutamic acid decarboxylase/, /\bmog\b|myelin oligodendrocyte/, /\baqp ?4\b|aquaporin|\bnmo\b/,
      /\b(hu|yo|ri|ma ?2|cv2|crmp5|amphiphysin|sox1|tr|dppx|gaba ?[ab]|ampa|ampar|iglon5|glycine receptor|neurexin|dner|zic4|pca|anna|mglur)\b/, /paraneoplastic/, /autoimmune/, /(?<!meningitis )encephalitis panel|encephalopathy panel/, /neuronal/,
    ],
    loose: [/antibod|\bab\b|\babs\b|\bigg\b/],
  },
  {
    panel: 'CSF infectious',
    keys: ['meningitis encephalitis panel', 'hsv pcr', 'vzv pcr', 'enterovirus pcr', 'cryptococcal antigen', 'vdrl', 'csf gram stain', 'csf culture'],
    match: [
      /\bhsv\b|herpes/, /\bvzv\b|varicella|zoster/, /enterovirus/, /lyme|borrelia/, /cryptococc/, /\bcmv\b|cytomegalo/, /\bebv\b|epstein/, /\bhhv\b/, /\bjc\b|\bjcv\b/, /west nile/, /syphilis|vdrl|\brpr\b|treponem|\bfta\b/,
      /\btb\b|tuberc|mycobact|\bafb\b/, /fung|crypto|histoplasm|coccidio/, /gram stain/, /meningitis|biofire|film ?array|\bme panel\b/, /toxoplasm/, /\bhiv\b/, /measles|rubeola|mumps|rubella/, /bacterial|viral|virus|\bpcr\b|culture/, /antigen/,
    ],
    loose: [/\bigm\b/],
  },
  { panel: 'CSF cytology and flow', keys: ['csf cytology'], match: [/cytolog/, /flow cytometry|\bflow\b/, /malignant|atypical cells|immunophenotyp/] },
  { panel: 'CSF other', keys: [], match: [] },
];

const SERUM_PANELS: PanelDef[] = [
  {
    panel: 'CBC',
    keys: ['wbc', 'rbc', 'hemoglobin', 'hematocrit', 'mcv', 'mch', 'mchc', 'rdw', 'rdw cv', 'rdw sd', 'platelets', 'mpv', 'neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils', 'neutrophils absolute', 'lymphocytes absolute', 'monocytes absolute', 'eosinophils absolute', 'basophils absolute', 'neutrophil count', 'lymphocyte count', 'monocyte count', 'eosinophil count', 'basophil count'],
    match: [
      /\b(wbc|rbc|hgb|hct|mcv|mch|mchc|rdw|plt|mpv|anc|alc|nrbc)\b/, /(?<!glycated )h(a)?emoglobin(?! a1c)|h(a)?ematocrit|platelet|thrombocyte/, /neutrophil|lymphocyte|monocyte|eosinophil|basophil|reticulocyte|granulocyte|(?<!oligoclonal )\bbands?\b|\bsegs\b|\bblasts?\b|\bpolys\b|\blymphs\b|\bmonos\b|\beos\b|\bbasos\b/,
      /white (blood )?cell|red (blood )?cell|leu[ck]ocyte|erythrocyte|differential|\bcbc\b|complete blood count|\bdiff\b/,
    ],
  },
  {
    panel: 'Metabolic',
    keys: ['sodium', 'potassium', 'chloride', 'co2', 'bun', 'urea', 'creatinine', 'egfr', 'egfr african american', 'egfr non african american', 'egfr ckd epi 2021', 'egfr ckd epi', 'egfr mdrd', 'measured gfr', 'gfr', 'glucose', 'calcium', 'magnesium', 'phosphorus', 'albumin', 'total protein', 'protein', 'ast', 'alt', 'alkaline phosphatase', 'bilirubin', 'ggt'],
    match: [
      /\b(na|k|cl|co2|hco3|bun|cr|creat|egfr|gfr|ca|mg|phos|ast|alt|alp|ggt|ldh|ck|cpk|a1c|hba1c|bnp|uric|tp|alb|sgot|sgpt)\b/,
      /sodium|potassium|chloride|bicarbonate|carbon dioxide|\burea\b|creatinine|glucose|calcium|magnesium|phosph|albumin|total protein|aspartate|alanine|aminotransferase|transaminase|alkaline phosphatase|bilirubin|gamma glutamyl|anion gap|osmolal|lactate|lactic|ammonia|lipase|amylase|troponin|creatine kinase|glycated|c peptide|globulin|a g ratio|\bbmp\b|\bcmp\b|metabolic panel|liver function|renal function|hepatic/,
    ],
  },
  {
    panel: 'Inflammatory',
    keys: ['esr', 'crp', 'hs crp', 'ferritin', 'procalcitonin', 'il 6'],
    match: [/\besr\b|sed rate|sedimentation/, /\bcrp\b|c reactive/, /ferritin/, /procalcitonin/, /\bil ?\d+\b|interleukin/, /\btnf\b|tumou?r necrosis/, /neopterin/, /serum amyloid|\bsaa\b/, /haptoglobin/, /cytokine/],
  },
  {
    panel: 'Autoimmune',
    keys: ['ana', 'ana titer', 'ana pattern', 'dsdna', 'rf', 'ccp', 'anca', 'c3', 'c4', 'tpo antibody'],
    match: [
      /\bana\b|antinuclear/, /dsdna|ds dna|double stranded/, /\bena\b|extractable nuclear/, /\b(ssa|ssb|ro|la|ro52|ro60|sm|rnp|scl ?70|jo ?1|u1)\b|sjo?gren|smith|ribonucleoprotein|topoisomerase|centromere|histone|chromatin|nucleosome|ribosomal p/,
      /\brf\b|rheumatoid factor/, /\bccp\b|citrullinated|\bacpa\b/, /\banca\b|\bmpo\b|\bpr3\b|myeloperoxidase|proteinase 3/, /complement|\bc3\b|\bc4\b|\bch50\b|\bc1q\b/, /cardiolipin|phospholipid|beta 2 glycoprotein|b2 glycoprotein|b2gp|lupus anticoagulant|\bapl\b|beta 2 gp/,
      /\btpo\b|thyroid peroxidase|thyroglobulin ab|thyroglobulin antibod|\btrab\b|\btsi\b|thyroid stimulating immunoglobulin|thyroid antibod|thyroid ab/, /celiac|coeliac|transglutaminase|\bttg\b|gliadin|endomysial|\bema\b/, /intrinsic factor|parietal cell/,
      /mitochondrial|smooth muscle|\bama\b|\basma\b|\blkm\b/, /acetylcholine receptor|\bachr\b|\bmusk\b|striational|striated/, /ganglioside|\bgm1\b|\bgq1b\b|\bgd1[ab]\b/, /\bigg4\b/, /\bhla\b/,
    ],
    loose: [/antibod|\bab\b|\babs\b|titer|titre|autoantibod/],
  },
  {
    panel: 'Neuro antibodies',
    keys: ['mog antibody', 'aqp4 antibody', 'nmdar antibody', 'lgi1 antibody', 'caspr2 antibody', 'gad65 antibody'],
    match: [
      /nmda/, /\blgi ?1\b/, /\bcaspr ?2\b/, /\bgad ?65\b|\bgad\b|glutamic acid decarboxylase/, /\bmog\b|myelin oligodendrocyte/, /\baqp ?4\b|aquaporin|\bnmo\b/, /paraneoplastic/,
      /\b(hu|yo|ri|ma ?2|cv2|crmp5|amphiphysin|sox1|dppx|gaba ?[ab]|ampa|ampar|iglon5|dner|zic4|anna|pca|mglur)\b/, /autoimmune encephal|(?<!meningitis )encephalitis panel|encephalopathy panel/, /neuronal antibod|neuronal ab/, /\bvgkc\b|voltage gated|\bvgcc\b/,
    ],
  },
  {
    panel: 'Infectious serology',
    keys: [],
    match: [
      /lyme|borrelia/, /\bhsv\b|herpes/, /\bvzv\b|varicella|zoster/, /\bcmv\b|cytomegalo/, /\bebv\b|epstein|\bvca\b|\bebna\b/, /\bhiv\b/, /hepatitis|\bhbsag\b|\bhbv\b|\bhcv\b|\bhav\b|\bhbs\b|\bhbc\b/, /syphilis|\brpr\b|vdrl|treponem|\bfta\b/,
      /\btb\b|quantiferon|tuberc|t spot|interferon gamma release|\bigra\b/, /toxoplasm/, /bartonella/, /mycoplasma/, /west nile/, /covid|sars cov|coronavirus/, /influenza/, /parvovirus|\bb19\b/, /\bhhv\b/, /\bjc\b|\bjcv\b/, /measles|rubeola|rubella|mumps/,
      /strep|\baso\b|antistreptolysin|dnase b/, /coccidio|histoplasm|blastomyc|aspergill|cryptococc|fungal|candida|galactomannan|beta d glucan/, /enterovirus|adenovirus|\brsv\b/, /\bpcr\b|culture|serolog/,
    ],
    loose: [/antigen/],
  },
  {
    panel: 'Immunoglobulins and electrophoresis',
    keys: ['igg', 'iga', 'igm', 'kappa free light chains', 'lambda free light chains'],
    match: [/^ig[gamde]\b|\bimmunoglobulin/, /oligoclonal/, /\bspep\b|electrophoresis|immunofixation|\bife\b|m spike|m protein|paraprotein|monoclonal/, /free light chain|\bkappa\b|\blambda\b|\bflc\b|\bkflc\b/, /igg subclass|\bigg ?[1-4]\b/, /beta 2 microglobulin/, /cryoglobulin/, /\bige\b/],
  },
  {
    panel: 'Endocrine',
    keys: ['tsh', 'free t4', 'free t3', 'cortisol', 'acth', 'prolactin'],
    match: [
      /\btsh\b|thyrotropin|thyroid stimulating hormone/, /\bt4\b|thyroxine|\bt3\b|triiodothyronine|\brt3\b/, /cortisol/, /\bacth\b|adrenocorticotrop|corticotropin/, /prolactin/, /\bfsh\b|\blh\b|estradiol|testosterone|progesterone|\bdhea/, /growth hormone|\bigf/,
      /\bpth\b|parathyroid/, /aldosterone|renin/, /vasopressin|\badh\b|copeptin/, /insulin/, /metanephrine|catecholamine/, /\bshbg\b|\bamh\b/,
    ],
  },
  {
    panel: 'Vitamins and nutrition',
    keys: ['vitamin b12', 'folate', 'rbc folate', 'vitamin d', 'vitamin d3', 'vitamin b1', 'vitamin b6', 'copper', 'zinc', 'methylmalonic acid', 'homocysteine'],
    match: [
      /vitamin|\bvit\b/, /\bb ?12\b|cobalamin|methylmalonic|\bmma\b|homocysteine/, /folate|folic/, /thiamine|\bb ?1\b/, /pyridox|\bb ?6\b/, /copper|ceruloplasmin/, /\bzinc\b/, /selenium|\biron\b|transferrin|\btibc\b|\buibc\b|iron saturation/,
      /carnitine|coenzyme q|coq10/, /prealbumin|retinol|tocopherol|ascorb/, /omega/,
    ],
  },
  {
    panel: 'Coagulation',
    keys: ['pt', 'inr', 'ptt', 'fibrinogen', 'd dimer'],
    match: [/\bpt\b|prothrombin/, /\binr\b/, /\bptt\b|\baptt\b|thromboplastin/, /fibrinogen/, /d dimer|ddimer/, /thrombin time/, /\bfactor (v|viii|ix|xi|xii|ii|vii|x|\d+)\b/, /antithrombin|protein c\b|protein s\b|von willebrand|\bvwf\b|anti xa|heparin/, /bleeding time|platelet function/],
  },
  { panel: 'Lipids', keys: ['cholesterol', 'ldl', 'ldl direct', 'hdl', 'triglycerides'], match: [/cholesterol|\bldl\b|\bhdl\b|triglycerid|\bvldl\b|non hdl|lipoprotein|apolipoprotein|\bapo ?[ab]\b|\blp ?a\b|\blipid/] },
  {
    panel: 'Drug levels',
    keys: [],
    match: [
      /lamotrigine|levetiracetam|keppra|valpro|carbamazepine|phenytoin|dilantin|lacosamide|topiramate|oxcarbazepine|phenobarbital|zonisamide/, /lithium|digoxin|clozapine|theophylline/, /tacrolimus|cyclosporin|sirolimus|everolimus|mycophenol|\bmpa\b|methotrexate|azathioprine|thiopurine|\btgn\b|\btpmt\b/,
      /vancomycin|gentamicin|tobramycin|amikacin/, /infliximab|adalimumab|vedolizumab|ustekinumab|rituximab|natalizumab|ocrelizumab|anti drug antibod|\btrough\b|\bpeak\b/, /hydroxychloroquine/, /acetaminophen|salicylate|ethanol|alcohol|drug screen|toxicolog|\btox\b/,
    ],
    loose: [/\blevel\b/],
  },
  { panel: 'Other', keys: [], match: [] },
];

const URINE_PANELS: PanelDef[] = [
  {
    panel: 'Urinalysis',
    keys: [],
    match: [/urinalysis|\bua\b|dipstick/, /specific gravity|\bsg\b/, /\bph\b/, /ketone/, /nitrite/, /leukocyte esterase|leuk est/, /urobilinogen/, /epithelial|\bcasts?\b|crystal|bacteria|yeast|mucus|appearance|colou?r|clarity|turbid|microscop/],
    loose: [/protein|albumin|glucose|blood|h(a)?emoglobin|bilirubin|\brbc\b|\bwbc\b|leukocyte|erythrocyte|sugar/],
  },
  {
    panel: 'Urine other',
    keys: [],
    match: [/ratio|24 ?h|24 hour|clearance|microalbumin|culture|cytolog|porphyr|copper|metanephrine|catecholamine|drug|\btox\b|osmolal|electrolyte|oxalate|citrate|cortisol|heavy metal|arsenic|mercury|\blead\b|amino acid|organic acid|bence jones|light chain|electrophoresis|\bupep\b|sodium|potassium|calcium|uric|creatinine/],
  },
];

const OTHER_PANELS: PanelDef[] = [{ panel: 'Other', keys: [], match: [] }];

const PANELS: Record<PanelSpecimen, PanelDef[]> = { csf: CSF_PANELS, serum: SERUM_PANELS, urine: URINE_PANELS, other: OTHER_PANELS };

/** The panels of one specimen bucket, in display order. */
export function labPanels(specimen: PanelSpecimen): string[] {
  return PANELS[specimen].map((p) => p.panel);
}

/**
 * Where an analyte belongs: its specimen bucket and panel, with the panel's
 * display order and the analyte's report position inside it. Synonyms fold
 * through `normalizeAnalyte` first ("ICP" and "opening pressure" are one
 * key), named members win, then specific patterns in panel order, then loose
 * ones; anything unknown lands in the specimen's "Other" panel. A key that
 * names a CSF study ("csf protein", "igg index") is CSF whatever the row says.
 */
export function labPanelFor(analyteKey: string, specimen: string | null | undefined): LabPanel {
  const key = normalizeAnalyte(analyteKey, specimen) || normalizeKey(analyteKey);
  let bucket = panelSpecimenFor(specimen);
  if (key.startsWith('csf ') || CSF_ONLY_KEYS.has(key)) bucket = 'csf';
  const defs = PANELS[bucket];
  const at = (i: number): LabPanel => ({ specimen: bucket, panel: defs[i].panel, order: i, position: defs[i].keys.indexOf(key) });
  for (let i = 0; i < defs.length; i++) if (defs[i].keys.includes(key)) return at(i);
  for (let i = 0; i < defs.length; i++) if (defs[i].match.some((re) => re.test(key))) return at(i);
  for (let i = 0; i < defs.length; i++) if (defs[i].loose?.some((re) => re.test(key))) return at(i);
  return at(defs.length - 1);
}

// ---------------------------------------------------------------------------
// Values, ranges, flags
// ---------------------------------------------------------------------------

export function parseNumeric(s: string | number | null | undefined): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

export function formatValue(e: { valueNum: number | null; valueText: string | null }): string {
  if (e.valueText && e.valueText.trim()) return e.valueText.trim();
  if (e.valueNum != null) return fmtNum(e.valueNum);
  return '';
}

/**
 * The range as shown: the text as printed when on record (`refText`), else the stored numbers read with
 * formatRange(rangeFromNumbers): "15–45", "upper limit 50", "lower limit 5". Never "≤ 50" for a single stored
 * bound (its sign is not on record), never a "-" or "–" standing for a missing bound (rule 3).
 */
export function formatRef(e: { refLow: number | null; refHigh: number | null; refText: string | null }): string | null {
  if (e.refText && e.refText.trim()) return e.refText.trim();
  return formatRange(rangeFromNumbers(e.refLow, e.refHigh));
}

/**
 * H / L / N from a measured number and a range stored as numbers, worked out with the shared rule (computeFlag): a
 * single stored bound has no sign on record, so a value exactly at it is not judged. Null when nothing can be said.
 */
export function deriveFlag(valueNum: number | null, refLow: number | null, refHigh: number | null): 'H' | 'L' | 'N' | null {
  if (valueNum == null || !Number.isFinite(valueNum)) return null;
  return computeFlag(numberOnlyValue(valueNum), rangeFromNumbers(refLow, refHigh)).flag;
}

export function isOutOfRange(flag: string | null | undefined): boolean {
  return flag === 'H' || flag === 'L' || flag === 'A' || flag === 'C';
}

// ---------------------------------------------------------------------------
// Entries: rows and unimported facts, merged
// ---------------------------------------------------------------------------

export type LabRow = typeof schema.labResults.$inferSelect;
export type LabInsert = typeof schema.labResults.$inferInsert;

/** An open finding of the lab checks (rule 10: one document gives two values like a typing error; rule 12: a summary's limit or judgement differs from the lab report's) that names a value. */
export interface LabIssue {
  findingId: string;
  ruleId: 'lab_same_source_conflict' | 'lab_claim_differs' | 'lab_computed_differs';
  title: string;
  detail: string | null;
  status: string;
}

/** The rule ids of the lab checks (services/lab-rules.ts). */
export const LAB_ISSUE_RULES = ['lab_same_source_conflict', 'lab_claim_differs', 'lab_computed_differs'] as const;

export interface LabEntry {
  /** lab_results id, or `fact:<factId>` for an extracted result not imported yet. */
  id: string;
  source: 'row' | 'fact';
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  analyteKey: string;
  specimen: string;
  /** The measurement (reading.measurement): null for a limit ("<3"), words, a value printed as a range, or blank. */
  valueNum: number | null;
  /** The value as shown (reading.valueShown): as printed, or the user's own words. */
  valueText: string | null;
  /** The unit as shown (an exactly repeated unit shown once). */
  unit: string | null;
  /** The bounds of the value's own range when read as numbers (reading.range); null otherwise. */
  refLow: number | null;
  refHigh: number | null;
  /** The value's own range as shown (reading.rangeShown): as printed, or "upper limit 50" from a stored number. */
  refText: string | null;
  /**
   * Effective flag: the flag printed with the value (H, L, N, A, C), else the flag worked out from the value and the
   * range printed with it (flagDerived). Null for a document that restates results (a summary, a patient note): its
   * flag is that document's claim, kept in `reading`, never counted as the lab's (rules 11, 12).
   */
  flag: string | null;
  flagDerived: boolean;
  /** The reading's date: collected, else a date of unknown kind, else resulted (reading.dateKind says which). */
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  /** The value as read (src/shared/labvalues.ts compactReading): what every screen shows and judges. */
  reading: LabReadingView;
  /** Open findings of the lab checks naming this value (rule 10 and rule 12), newest first. */
  labIssues: LabIssue[];
  labName: string | null;
  institutionId: string | null;
  institutionName: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  quote: string | null;
  factStatus: string | null;
  /** How a confirmed fact was checked: against the original record, or only against a summary. Null otherwise. */
  factBasis: 'original' | 'summary' | 'unsure' | 'correction' | null;
  factStatement: string | null;
  /**
   * The row was imported from (or cited by) a fact that has since been
   * deleted in the Facts ledger. The row stays listed, never labelled as
   * entered by hand, and is set aside from trends like a disputed one.
   */
  factDeleted: boolean;
  /** The automatic trust level of the fact behind the entry (services/reconcile.ts); null for a row entered by hand. */
  trust: TrustInfo | null;
  /**
   * A row whose value, unit or date was changed by hand so that it no longer equals its own detail's (labRowEditedFrom):
   * what the detail reads ("0.62 g/L on 2024-03-18"); null otherwise. Such a row is the patient's own value, like a row
   * typed by hand: no trust from the detail, never set aside by the detail's status (factStatus and factBasis are null),
   * listed normally. factId and factStatement still name the detail it was made from.
   */
  editedFrom: string | null;
  /**
   * With editedFrom: the row's detail is a clinical record's own (its document is of tier primary), so what it reads
   * is the clinical record as read: that document's id. Null otherwise.
   */
  editedFromRecord: string | null;
  /**
   * A row changed by hand to exactly the value of the detail that replaced its own (keeperOf: the clinical record's,
   * which has its own row here): that detail's id. The row is then a copy of that line, like a copy the check set
   * aside: set aside (factStatus 'superseded'), never listed, plotted or printed twice; its note goes on that line.
   * Its trust says it matches that record. Null otherwise.
   */
  copyOf: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * One test read out of a line that holds several (readLabLine): the line as written, this part's 0-based place and
   * the number of parts. The entry's id is then `<row or fact id>#<index>`; labResultId and factId still name the
   * original row or fact, which is what opening, editing or deleting acts on. Null for an entry as stored.
   */
  splitFrom: LabSplitFrom | null;
  /** A line that names several tests the app could not tell apart: kept whole, labelled, not compared with the records. */
  combined: boolean;
  /**
   * One test of a line that holds several (a part, or a row made from one), compared when read with the clinical records
   * of its test, sample and day (checkLabParts; nothing is written): 'copy' when it repeats a record's value (trust
   * accurate), 'inaccurate' when it differs from it (trust inaccurate, the record's value in the trust). While the line's
   * detail is still open to the automatic check (pending, read by the model, never edited, no note), such a part is set
   * aside as the check sets aside a copy or a contradiction (factStatus 'superseded'): listed, never counted, plotted or
   * printed as a reading. Null otherwise.
   */
  partCheck: 'copy' | 'inaccurate' | null;
  /** The specimen was not stated by the source (a default, defaultSpecimenFor). Sent only when true. */
  specimenAssumed?: boolean;
  /**
   * A value the patient computed from printed values (raw_source 'computed', src/shared/labcompute.ts): its formula, inputs,
   * citations and pairing, the inputs that changed since, and the lab's own printed value of the same index beside it.
   * Sent only on a computed value.
   */
  computed?: ComputedView;
}

export type LabSeriesRow = LabEntry & { value: string; ref: string | null; href: string | null };

/**
 * Set aside by the user's verdict: the fact behind the entry was disputed,
 * superseded (a newer reading or the kept duplicate replaces it) or deleted.
 * Listed with a tag, left out of analytes, panels, series and charts.
 */
export function isSetAside(e: Pick<LabEntry, 'factStatus' | 'factDeleted'>): boolean {
  return e.factStatus === 'disputed' || e.factStatus === 'superseded' || e.factDeleted;
}

function firstCitations(factIds: string[]): Map<string, CiteLite> {
  const out = new Map<string, CiteLite>();
  const ids = [...new Set(factIds.filter(Boolean))];
  if (!ids.length) return out;
  const d = db();
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = d
      .select({ id: c.id, factId: c.factId, documentId: c.documentId, pageNumber: c.pageNumber, verified: c.verified, quote: c.quote })
      .from(c)
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .orderBy(desc(c.verified), asc(c.pageNumber), asc(c.createdAt))
      .all();
    for (const r of rows) if (r.factId && !out.has(r.factId)) out.set(r.factId, { id: r.id, documentId: r.documentId, pageNumber: r.pageNumber, verified: Boolean(r.verified), quote: r.quote });
  }
  return out;
}

export function hrefFor(e: { documentId: string | null; pageNumber: number | null }): string | null {
  if (!e.documentId) return null;
  return e.pageNumber ? `/documents/${e.documentId}?page=${e.pageNumber}` : `/documents/${e.documentId}`;
}

/** Entries of one day and time by test; the parts of one line together, in the line's order. */
function byDate(a: LabEntry, b: LabEntry): number {
  return (
    dateSortKey(a.date).localeCompare(dateSortKey(b.date)) ||
    a.createdAt.localeCompare(b.createdAt) ||
    (a.splitFrom?.text ?? a.analyteKey).localeCompare(b.splitFrom?.text ?? b.analyteKey) ||
    (a.splitFrom && b.splitFrom ? originalLabId(a.id).localeCompare(originalLabId(b.id)) || a.splitFrom.index - b.splitFrom.index : 0)
  );
}

interface LabAttrs {
  analyte?: string | null;
  value?: string | null;
  value_num?: number | null;
  unit?: string | null;
  ref_low?: number | null;
  ref_high?: number | null;
  ref_text?: string | null;
  flag?: string | null;
  specimen?: string | null;
  lab_name?: string | null;
  collected_date?: string | null;
  resulted_date?: string | null;
}

/** The verdict basis as the API reports it: only a confirmed fact carries one. */
function basisOf(status: string | null | undefined, basis: string | null | undefined): 'original' | 'summary' | 'unsure' | 'correction' | null {
  if (status === 'unverified') return basis === 'unsure' ? 'unsure' : null;
  if (status !== 'confirmed') return null;
  return basis === 'original' || basis === 'summary' || basis === 'correction' ? basis : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

type LabFactRow = typeof schema.facts.$inferSelect & { documentTitle: string | null; documentJoinedId: string | null; documentDeletedAt: string | null; documentTier?: string | null };

// ---------------------------------------------------------------------------
// Readings: every entry's value as read by the shared parser (src/shared/labvalues.ts)
// ---------------------------------------------------------------------------

/** What a reading needs to know about a document: its tier (a lab report, a summary, not sorted yet) and its own date. */
export interface LabDocMeta {
  tier: string | null;
  date: PartialDate | null;
}

/** The tier and the date of each of these documents (deleted ones included: callers filter them). */
export function labDocumentMeta(ids: Iterable<string | null | undefined>): Map<string, LabDocMeta> {
  const want = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  const out = new Map<string, LabDocMeta>();
  const d = schema.documents;
  for (let i = 0; i < want.length; i += 400) {
    const rows = db()
      .select({ id: d.id, tier: d.sourceTier, date: d.documentDate, precision: d.documentDatePrecision, text: d.documentDateText })
      .from(d)
      .where(inArray(d.id, want.slice(i, i + 400)))
      .all();
    for (const r of rows) {
      const date: PartialDate | null = r.date || (r.text && r.text.trim()) ? { iso: r.date, precision: (r.precision || 'unknown') as DatePrecision, text: r.text } : null;
      out.set(r.id, { tier: r.tier ?? null, date });
    }
  }
  return out;
}

const VIEW_MEMO = new WeakMap<LabReading, LabReadingView>();

/** The compact view of a reading that every entry carries and the client receives (frozen; one per reading). */
export function readingView(r: LabReading): LabReadingView {
  let v = VIEW_MEMO.get(r);
  if (!v) {
    v = Object.freeze(compactReading(r));
    VIEW_MEMO.set(r, v);
  }
  return v;
}

/** The full reading behind an entry (the checks, the writers); the client gets only its compact view. */
const FULL_READING = new WeakMap<object, LabReading>();

/** The full reading of an entry as loadLabEntries made it; null for a copy made elsewhere (a spread of an entry). */
export function fullReadingOf(e: LabEntry): LabReading | null {
  return FULL_READING.get(e) ?? null;
}

function withReading<T extends LabEntry>(e: T, r: LabReading): T {
  FULL_READING.set(e, r);
  return e;
}

/**
 * The flag an entry is marked with (LabEntry.flag): the flag printed with the value, else the flag worked out from
 * the value and the range printed with it (flagDerived). A document that restates results (role claimed) marks
 * nothing: its flag is its claim, read from `reading` and never counted as the lab's.
 */
function entryFlag(r: LabReading): { flag: string | null; flagDerived: boolean } {
  // A computed value is never marked (labcompute.ts): never red, never counted out of range.
  if (r.role === 'claimed' || r.role === 'computed') return { flag: null, flagDerived: false };
  if (r.flag.state === 'flag' && r.flag.printed) return { flag: r.flag.printed, flagDerived: false };
  if (r.computed.flag) return { flag: r.computed.flag, flagDerived: true };
  return { flag: null, flagDerived: false };
}

/** A computed row's stored record (parse_json.computed), as the entry's `computed` (marked later by loadLabEntries). */
function computedOf(r: Pick<LabRow, 'rawSource' | 'parseJson'>): { computed?: ComputedView } {
  if (r.rawSource !== COMPUTED_SOURCE) return {};
  const record = readComputedRecord(r.parseJson);
  return record ? { computed: { record, changes: [], printed: [] } } : {};
}

/** The legacy fields of an entry, filled from its reading, and the reading's compact view. */
function readingFields(r: LabReading): Pick<LabEntry, 'valueNum' | 'valueText' | 'unit' | 'refLow' | 'refHigh' | 'refText' | 'flag' | 'flagDerived' | 'date' | 'datePrecision' | 'dateText' | 'reading'> {
  const parsed = r.range.status === 'parsed' || r.range.fromNumbersOnly;
  const d = r.dates.reading;
  return {
    valueNum: r.measurement,
    valueText: r.valueShown !== '' ? r.valueShown : null,
    unit: r.unit.unit,
    refLow: parsed ? r.range.low : null,
    refHigh: parsed ? r.range.high : null,
    refText: r.rangeShown,
    ...entryFlag(r),
    date: d?.iso ?? null,
    datePrecision: d?.precision ?? 'unknown',
    dateText: d?.text ?? null,
    reading: readingView(r),
  };
}

/** A reading's date as a PartialDate, from an entry's fields (the compact view keeps only the collected and resulted dates). */
function entryDate(e: Pick<LabEntry, 'date' | 'datePrecision' | 'dateText'>): PartialDate | null {
  return e.date || (e.dateText && e.dateText.trim()) ? { iso: e.date, precision: (e.datePrecision || 'unknown') as DatePrecision, text: e.dateText } : null;
}

/** The text of one test of a line that holds several, as written in the line. */
export interface LabPartText {
  valueText: string | null;
  valueNum: number | null;
  unit: string | null;
  /** The flag written with this part, as printed; null when none. */
  flagRaw?: string | null;
}

/**
 * One test of a line that holds several ("OP 17; protein 52"), read on its own text (rule 1): its value, and the unit
 * and flag written with it; never the line's range (a part never borrows one, DECISIONS.md:2012). The role, dates,
 * lab and quote are the line's (`line`: the line's reading and its date).
 */
export function partLabReading(p: LabPartText, line: { reading: LabReadingView | null; date: PartialDate | null; quote?: { text: string; verified: boolean; citationId?: string | null } | null }): LabReading {
  const v = line.reading;
  const userEdited = v?.valueFrom === 'user';
  const kind = v?.dateKind ?? 'unknown';
  return buildLabReading({
    value: { shown: p.valueText, raw: null, storedNumber: p.valueText == null || !p.valueText.trim() ? p.valueNum : null, userEdited },
    unit: { shown: p.unit, raw: null, userEdited },
    range: { shown: null, raw: null, storedLow: null, storedHigh: null },
    flag: { shown: p.flagRaw ?? null, raw: null, userEdited },
    quote: line.quote ?? null,
    role: v?.role ?? 'typed',
    dates: { collected: v?.collected ?? null, resulted: v?.resulted ?? null, unknownKind: kind === 'unknown' ? line.date : null, document: null, received: v?.received ?? null },
    labName: v?.lab ?? null,
    claim: null,
    sampleLabel: null,
  });
}

/** A lab_result fact read as a ledger entry: the virtual `fact:<id>` entry until it is imported. */
function factEntry(x: LabFactRow, cite: CiteLite | undefined, docs?: Map<string, LabDocMeta>): LabEntry {
  const a = parseJson<LabAttrs>(x.attributesJson, {});
  const analyte = str(a.analyte) ?? (x.subjectKey?.split('|')[1]?.trim() || x.statement.slice(0, 80));
  // Panel rows rarely restate the specimen: CSF-only studies (IgG index, OCB) default to CSF, not serum.
  const stated = str(a.specimen);
  const analyteKey = normalizeAnalyte(analyte, stated ?? defaultSpecimenFor(analyte));
  const specimen = effectiveSpecimen(analyteKey, stated ?? defaultSpecimenFor(analyte), analyte);
  const documentId = x.sourceDocumentId ?? cite?.documentId ?? null;
  const samePage = cite && cite.documentId === documentId;
  const meta = documentId ? docs?.get(documentId) : undefined;
  const reading = readingForFact(x, {
    cite: samePage ? cite! : null,
    documentTier: meta?.tier ?? (documentId === x.sourceDocumentId ? (x.documentTier ?? null) : null),
    documentDate: meta?.date ?? null,
    hasDocument: Boolean(documentId),
  });
  return withReading(
    {
      id: `fact:${x.id}`,
      source: 'fact',
      labResultId: null,
      factId: x.id,
      analyte,
      analyteKey,
      specimen,
      ...readingFields(reading),
      labIssues: [],
      labName: str(a.lab_name),
      institutionId: null,
      institutionName: null,
      documentId,
      documentTitle: x.documentTitle ?? null,
      pageNumber: samePage ? cite!.pageNumber : null,
      citationId: samePage ? cite!.id : null,
      citationVerified: samePage ? cite!.verified : null,
      quote: samePage ? cite!.quote : null,
      factStatus: x.status,
      factBasis: basisOf(x.status, x.verdictBasis),
      factStatement: x.statement,
      factDeleted: false,
      trust: null,
      editedFrom: null,
      editedFromRecord: null,
      copyOf: null,
      notes: null,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
      splitFrom: null,
      combined: false,
      partCheck: null,
      ...(stated ? {} : { specimenAssumed: true }),
    },
    reading,
  );
}

/** A reading as compared for "changed by hand": the value as shown (and its number), the unit, the date. */
interface Reading {
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  date: string | null;
  /** A detail's other reading of its number: the number its text measures when the stored one differs (a row may hold either). */
  alsoNum?: number | null;
  /** A detail's own collected and resulted dates (2026-10): a row made from it holds one of them. */
  alsoDates?: string[];
}

/** The number a value as written measures (shared parser): "62 mg/dL" 62; "<3", words or a range none. */
function measuredNumber(text: string | null | undefined): number | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const v = parseLabValue(text);
  return v.kind === 'number' ? v.number : null;
}

/**
 * A detail's reading for "changed by hand": its stored number (rows imported before 2026-10 copied it), else the
 * number its value as written measures. Rows are compared on their own columns (labRowEditedFrom), so no row reads as
 * changed by hand because the reading of values changed.
 */
function readingOf(a: LabAttrs, date: string | null | undefined): Reading {
  const stored = num(a.value_num);
  const measured = measuredNumber(a.value);
  const alsoDates = [a.collected_date, a.resulted_date].map((t) => (str(t) ? parsePartialDate(str(t)).iso : null)).filter((x): x is string => Boolean(x));
  return { valueNum: stored ?? measured, valueText: str(a.value), unit: str(a.unit), date: date ?? null, alsoNum: stored != null && measured != null && stored !== measured ? measured : null, alsoDates };
}

const plainWords = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The same reading: the same number (when both have one), the same value as shown (or two spellings of one number,
 * "62" and "62.0"), the same unit (case and spaces aside) and the same date. Saving the edit form without changing
 * anything keeps a row the same as its detail: the form sends back the value as shown and the date as written.
 */
function sameReading(a: Reading, b: Reading): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
  if (a.valueNum != null && b.valueNum != null && !near(a.valueNum, b.valueNum) && !(b.alsoNum != null && near(a.valueNum, b.alsoNum))) return false;
  const at = formatValue(a);
  const bt = formatValue(b);
  if (plainWords(at) !== plainWords(bt)) {
    const an = parseNumeric(at);
    const bn = parseNumeric(bt);
    if (an == null || bn == null || an !== bn) return false;
  }
  if (plainWords(a.unit).replace(/ /g, '') !== plainWords(b.unit).replace(/ /g, '')) return false;
  return (a.date ?? null) === (b.date ?? null) || Boolean(a.date && b.alsoDates?.includes(a.date));
}

/** "0.62 g/L on 2024-03-18", "NONREACTIVE in 2024-03", "62 mg/dL, no date". */
function readingWords(r: Reading): string {
  const value = `${formatValue(r) || 'no value'}${r.unit ? ` ${r.unit}` : ''}`;
  if (!r.date) return `${value}, no date`;
  return `${value} ${r.date.length === 10 ? 'on' : 'in'} ${r.date}`;
}

/**
 * Was this lab row changed by hand so that its value, unit or date no longer equals its own detail's (the lab_result
 * fact it was imported from, or linked to)? Then the row is the patient's own value: returns what the detail reads
 * ("0.62 g/L on 2024-03-18"); null when the row still says what its detail says.
 *
 * A detail corrected on Details from documents after the row was made from it (attributes._userEdited, the model's
 * reading kept in _aiOriginal) leaves the row holding the detail's earlier reading: that is not an edit of the row,
 * and null is returned.
 *
 * A row never saved after it was made (updatedAt equal to createdAt; callers pass both) was not changed by hand,
 * whatever became of its detail since (a detail typed with a citation, then corrected on Details; a detail corrected
 * twice, the row made between the two): null. updateLab always moves updatedAt past createdAt.
 *
 * A row made from one test of a detail whose line holds several ("OP 17; protein 52" made two rows) is compared with
 * that test's part of the line (the part with the row's own test, when the row passes its analyte and specimen).
 */
export function labRowEditedFrom(
  row: { valueNum: number | null; valueText: string | null; unit: string | null; collectedAt: string | null; resultedAt?: string | null; createdAt?: string | null; updatedAt?: string | null; analyte?: string | null; specimen?: string | null; parseJson?: string | null },
  fact: { attributesJson: string; date: string | null },
): string | null {
  if (row.createdAt && row.updatedAt && row.createdAt === row.updatedAt) return null;
  const a = parseJson<LabAttrs & { _userEdited?: unknown; _aiOriginal?: unknown }>(fact.attributesJson, {});
  // A row made from a value dated only by its result (2026-10) holds that date in resulted_at. A row "Add all" wrote with
  // the page's sign ("<3" where the detail reads "3": parse_json.pageValue) still holds what the app wrote, not a change
  // by hand: it is compared as the detail's own text.
  const page = pageValueOf(row);
  const mine: Reading = { valueNum: row.valueNum, valueText: page ? page.readAs : row.valueText, unit: row.unit, date: row.collectedAt ?? row.resultedAt ?? null };
  const detail = partReading(a, fact.date, row) ?? readingOf(a, fact.date);
  if (sameReading(mine, detail)) return null;
  const original = a._userEdited && a._aiOriginal && typeof a._aiOriginal === 'object' ? (a._aiOriginal as { date?: string | null; attributes?: LabAttrs }) : null;
  if (original?.attributes && typeof original.attributes === 'object' && sameReading(mine, partReading(original.attributes, original.date, row) ?? readingOf(original.attributes, original.date))) return null;
  return readingWords(detail);
}

/** The reading of the row's own test within a detail whose line holds several tests; null when the line is one test. */
function partReading(a: LabAttrs, date: string | null | undefined, row: { analyte?: string | null; specimen?: string | null }): Reading | null {
  const analyte = str(a.analyte);
  if (!row.analyte || !analyte) return null;
  const specimen = str(a.specimen) ?? defaultSpecimenFor(analyte);
  const parts = splitCombinedLab({ analyte, valueText: str(a.value), specimen, specimenStated: Boolean(str(a.specimen)) });
  if (!parts) return null;
  const key = normalizeAnalyte(row.analyte, row.specimen ?? specimen);
  // The part of the row's own test and sample ("serum glucose" on a CSF line is the blood glucose, not CSF glucose).
  const rowSample = row.specimen ? panelSpecimenFor(effectiveSpecimen(key, row.specimen, row.analyte)) : null;
  // The part "Add all" made the row from carries the row's own name ("Glucose" for the blood glucose of "CSF glucose /
  // serum glucose"); else the part of the row's test and sample.
  const named = parts.filter((x) => x.analyte === row.analyte);
  const same = parts.filter((x) => x.analyteKey === key);
  const p = (named.length === 1 ? named[0] : null) ?? same.find((x) => !rowSample || panelSpecimenFor(effectiveSpecimen(x.analyteKey, x.specimen ?? specimen, x.label)) === rowSample) ?? same[0];
  return p ? { valueNum: p.valueNum, valueText: p.valueText, unit: p.unit, date: date ?? null } : null;
}

/** Follow a superseded fact to the live fact that replaced it (the kept duplicate or the newer reading); null when the chain ends nowhere live. */
function keeperOf(id: string, byId: Map<string, LabFactRow>): LabFactRow | null {
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && cur.status === 'superseded' && cur.supersededById && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.supersededById);
  }
  return cur && cur.id !== id && cur.status !== 'superseded' ? cur : null;
}

/** What makes two values one measurement: the test, the value's identity (labValueIdentity), the unit key and the date. */
interface Measurement {
  analyteKey: string;
  identity: string;
  unitKey: string | null;
  date: string | null;
}

/** An entry's measurement, from its reading ("62" and "62.0" are one value; "<3" is not "3"). */
function measurementOf(e: Pick<LabEntry, 'analyteKey' | 'reading' | 'date'>): Measurement {
  return { analyteKey: e.analyteKey, identity: e.reading.identity, unitKey: e.reading.unitKey, date: e.date ?? null };
}

/** A stored row's measurement, from its own columns (the text as stored, else its number). */
function rowMeasurement(analyteKey: string, valueText: string | null, valueNum: number | null, unit: string | null, date: string | null): Measurement {
  const v = valueText && valueText.trim() ? parseLabValue(valueText) : valueNum != null && Number.isFinite(valueNum) ? numberOnlyValue(valueNum) : parseLabValue(null);
  return { analyteKey, identity: labValueIdentity(v), unitKey: unitKey(unit), date: date ?? null };
}

/** One measurement: same analyte, value, unit and date (a merged duplicate rather than a corrected reading). */
function sameMeasurement(a: Measurement, b: Measurement): boolean {
  return a.analyteKey === b.analyteKey && a.identity === b.identity && (a.unitKey ?? '') === (b.unitKey ?? '') && (a.date ?? null) === (b.date ?? null);
}

/**
 * Every live entry, rows first merged with unimported lab facts, oldest
 * first. Entries set aside by the user's verdict (disputed, superseded, fact
 * deleted) are included and flagged; the filters decide where they show.
 *
 * Merges and supersessions are read here, without touching the rows: a row
 * whose fact was superseded by a live fact recording the same measurement
 * (an accepted duplicate merge) stands in for that keeper, so the keeper is
 * neither listed twice nor imported again; a row whose fact was superseded by
 * a different reading keeps its superseded status and the newer fact shows.
 * A row changed by hand so that its value, unit or date no longer equals its own detail's is the patient's value
 * (editedFrom): it carries no trust and no fact status, so it is listed and plotted like a row typed by hand, even when
 * the reconciliation set its detail aside as a copy of a clinical record. A row changed by hand to exactly the value of
 * the detail that replaced its own, while that detail's line is listed here (the clinical record's own row), is a copy
 * of that line (copyOf): set aside like a copy the check set aside, so the value is listed once.
 *
 * A line that holds several tests ("CSF opening pressure / protein: OP 17; protein 52") is read as one entry per test
 * (expandLabEntry): each part keeps the line's date, document, citation, fact or row link and trust, with its own
 * analyte, value and unit, id `<row or fact id>#<index>` and `splitFrom`. A line of several tests that cannot be
 * split is kept whole and marked `combined`. Nothing stored is rewritten.
 */
export function loadLabEntries(): LabEntry[] {
  const whole = readWholeLabEntries();
  const out = checkLabParts(expandLabEntries(whole.entries), whole.details);
  attachLabIssues(out);
  // Computed values: which inputs changed since, and the lab's own printed value of the same index beside each.
  markComputedEntries(out, isSetAside);
  return out;
}

/** Each entry read for the tests it holds (parts in place of a line of several tests), oldest first. */
export function expandLabEntries(entries: LabEntry[]): LabEntry[] {
  const out = entries.flatMap(expandLabEntry);
  out.sort(byDate);
  return out;
}

/**
 * One entry read for the tests it holds: its parts when its line splits (readLabLine), else the entry itself, marked
 * `combined` when its line names several tests that cannot be told apart. A part has no reference range (the line's
 * belongs to no one part), only a flag written with it, and the specimen its own label states ("serum glucose" on a CSF
 * line is a blood value), else the line's. Each part carries its own reading, built from its own text (partLabReading).
 */
export function expandLabEntry(e: LabEntry): LabEntry[] {
  const read = readLabValues({ ...e, specimen: e.specimen });
  if (read.length === 1 && !read[0].splitFrom) {
    if (read[0].combined === e.combined) return [e];
    const copy = { ...e, combined: read[0].combined };
    const r = fullReadingOf(e);
    return [r ? withReading(copy, r) : copy];
  }
  const quote = e.quote && e.citationVerified ? { text: e.quote, verified: true, citationId: e.citationId } : null;
  const line = { reading: e.reading, date: entryDate(e), quote };
  return read.map((p) => {
    const reading = partLabReading(p, line);
    return withReading(
      {
        ...e,
        id: `${e.id}#${p.splitFrom!.index}`,
        analyte: p.analyte,
        analyteKey: p.analyteKey,
        specimen: p.specimen,
        ...readingFields(reading),
        // The part keeps the line's date as stored (its reading carries the line's dates).
        date: e.date,
        datePrecision: e.datePrecision,
        dateText: e.dateText,
        refLow: null,
        refHigh: null,
        refText: null,
        flagDerived: false,
        splitFrom: p.splitFrom,
        combined: false,
        specimenAssumed: p.specimenAssumed ? true : undefined,
      },
      reading,
    );
  });
}

/** A lab line as stored anywhere (a row, a fact's attributes, a document's detail), for readLabValues. */
export interface LabLineValue {
  analyte: string;
  /** The specimen as stated, else as assumed (defaultSpecimenFor). */
  specimen: string;
  /** The specimen was not stated (a default). */
  specimenAssumed?: boolean;
  valueText: string | null;
  valueNum: number | null;
  unit: string | null;
  flag: string | null;
  /** The flag as printed, when known (a part: the flag written with it, "HH", "-"). */
  flagRaw?: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
}
/** One test read out of a lab line (or the line itself), with the key and specimen it is listed under. */
export interface LabValueRead extends LabLineValue {
  analyteKey: string;
  /** The line as written and this part's place in it; null for a line read whole. */
  splitFrom: LabSplitFrom | null;
  /** A line that names several tests that cannot be told apart, kept whole. */
  combined: boolean;
}

/**
 * The tests a lab line holds, each with the key and specimen it is listed under: its parts when the line splits
 * (readLabLine), else the line itself. Grouping is by the name as written (normalizeAnalyte), never a stored key; a test
 * that exists only in CSF, or a name that says CSF, is CSF (effectiveSpecimen); a part keeps the specimen its own label
 * states. The one reading used by the Labs page, the clinician, the printed packet, the cross-reference rules and the
 * document summary.
 */
export function readLabValues(v: LabLineValue): LabValueRead[] {
  const valueText = v.valueText ?? (v.valueNum != null ? fmtNum(v.valueNum) : null);
  const line = readLabLine({ analyte: v.analyte, valueText, unit: v.unit, specimen: v.specimen, specimenStated: !v.specimenAssumed });
  if (!line.parts) {
    const key = normalizeAnalyte(v.analyte, v.specimen);
    return [{ ...v, analyteKey: key, specimen: effectiveSpecimen(key, v.specimen, v.analyte), splitFrom: null, combined: line.combined }];
  }
  const text = `${v.analyte}: ${formatValue({ valueText, valueNum: v.valueNum })}${v.unit ? ` ${v.unit}` : ''}`;
  const lineSpecimen = effectiveSpecimen(normalizeAnalyte(v.analyte, v.specimen), v.specimen, v.analyte);
  return line.parts.map((p) => ({
    analyte: p.analyte,
    analyteKey: p.analyteKey,
    // The part's own sample ("serum glucose"), else the line's; a test that exists only in CSF is CSF.
    specimen: effectiveSpecimen(p.analyteKey, p.specimen ?? lineSpecimen, p.specimen ? null : p.label),
    ...(v.specimenAssumed && !p.specimen && lineSpecimen === v.specimen ? { specimenAssumed: true } : {}),
    valueText: p.valueText,
    valueNum: p.valueNum,
    unit: p.unit,
    flag: p.flag,
    flagRaw: p.flagRaw,
    refLow: null,
    refHigh: null,
    refText: null,
    splitFrom: { text, index: p.index, of: p.of },
    combined: false,
  }));
}

/** What the part check needs to know about the details behind the entries (see checkLabParts). */
interface DetailState {
  /** Details whose parts may be compared at all (not marked "another occasion" by the user). */
  checkable: Set<string>;
  /** Details still open to the automatic check: pending, read by the model, never edited, no note, not "Not sure". */
  open: Set<string>;
}

/** The person's own note on a row (the import provenance the app wrote is not one). */
function ownNote(notes: string | null | undefined): string {
  return (notes ?? '').replace(IMPORT_PREFIX, '').replace(/^;\s*/, '').trim();
}

/** A same-day key a part and the clinical records of its test meet on: test, sample (blood work as one) and day. */
function readingKey(e: Pick<LabEntry, 'analyteKey' | 'specimen' | 'date'>): string {
  return `${e.analyteKey}\u0001${panelSpecimenFor(e.specimen)}\u0001${e.date}`;
}

const isDayDate = (d: string | null | undefined): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * One test of a line that holds several, compared with the clinical records of its test, sample and day (read only).
 *
 * The reconciliation never compares a line of several tests part by part (reconcile.ts SEVERAL_TESTS_REASON): one
 * differing part must not set the whole line aside. Here, when the entries are read, each part (and each row made from
 * one by "Add all") is compared with the verified values of its test, sample and day, with the reconciliation's own
 * comparison (reconcile.ts compareLabReading: units that scale converted, a rougher number equal, answers in words):
 *   - equal to a record's value: a copy (partCheck 'copy', trust accurate, naming the record);
 *   - different from it: inaccurate (partCheck 'inaccurate', trust inaccurate, with what the record says);
 *   - not comparable (another unit, other words): "Not compared: …" with what the record gives;
 *   - no record that day: not backed by a clinical record yet.
 * A copy or an inaccurate part of a detail still open to the automatic check is set aside as the check sets aside a
 * copy or a contradiction (factStatus 'superseded'): listed, never counted, plotted or printed as a reading. A detail
 * the user has answered, edited or annotated, a row changed by hand or carrying the person's note, keeps its parts
 * listed, each with its trust. The user's verdict is never overridden; nothing is written.
 */
function checkLabParts(entries: LabEntry[], details: DetailState): LabEntry[] {
  const records = new Map<string, LabEntry[]>();
  for (const e of entries) {
    if (e.trust?.trust !== 'verified' || e.combined || !e.factId || isSetAside(e) || !isDayDate(e.date)) continue;
    const k = readingKey(e);
    const list = records.get(k);
    if (list) list.push(e);
    else records.set(k, [e]);
  }
  for (const e of entries) {
    const t = e.trust;
    if (!t || t.byUser || t.trust !== 'unbacked' || t.reason !== SEVERAL_TESTS_REASON) continue;
    if (e.combined || !e.factId || e.editedFrom || isSetAside(e) || !details.checkable.has(e.factId)) continue;
    const recs = isDayDate(e.date) ? (records.get(readingKey(e)) ?? []).filter((r) => r.factId !== e.factId) : [];
    const reading = (x: LabEntry): ReconcileLabReading => ({ factId: x.factId, analyte: x.analyte, analyteKey: x.analyteKey, valueText: x.valueText, valueNum: x.valueNum, unit: x.unit, date: x.date });
    const found = recs.length ? compareLabReading(reading(e), recs.map(reading)) : null;
    if (!found) {
      // Read on its own, with no clinical record of its test that day: not backed yet (no longer "several tests").
      e.trust = { trust: 'unbacked', byUser: false, recordFactId: null, recordDocumentId: null, recordDocumentTitle: null, recordValue: null, recordDate: null, recordByUser: false, reason: e.date ? null : NO_DATE_REASON, eventKey: null, canSeparate: false };
      continue;
    }
    e.trust = found;
    if (found.trust !== 'accurate' && found.trust !== 'inaccurate') continue;
    e.partCheck = found.trust === 'accurate' ? 'copy' : 'inaccurate';
    if (details.open.has(e.factId) && !(e.source === 'row' && ownNote(e.notes))) {
      e.factStatus = 'superseded';
      e.factBasis = null;
    }
  }
  return entries;
}

/** The status of the detail behind an entry, before the part check set the part aside (LabEntry.partCheck). */
export function lineFactStatus(e: Pick<LabEntry, 'factStatus' | 'partCheck'>): string | null {
  return e.partCheck && e.factStatus === 'superseded' ? 'unverified' : e.factStatus;
}

/** A part set aside by the part check (a copy of a clinical record's value, or one it contradicts), not its whole line. */
export function isPartSetAside(e: Pick<LabEntry, 'factStatus' | 'partCheck' | 'factDeleted'>): boolean {
  return Boolean(e.partCheck) && e.factStatus === 'superseded' && !e.factDeleted;
}

/**
 * The parts the part check set aside (checkLabParts), by the entry they were read from: `<row id>` or `fact:<fact id>`
 * -> part indexes; a row made from one part by "Add all" (no index) is listed with -1. For the views that read rows and
 * facts themselves (the printed packet, the cross-reference rules, the document summary).
 */
export function setAsideLabParts(entries: LabEntry[] = loadLabEntries()): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const e of entries) {
    if (!isPartSetAside(e)) continue;
    const k = originalLabId(e.id);
    const set = out.get(k) ?? new Set<number>();
    set.add(e.splitFrom ? e.splitFrom.index : -1);
    out.set(k, set);
  }
  return out;
}

/**
 * The part check's reading of each part of these details' lines: `<fact id>#<index>` -> the part's trust and whether it
 * is set aside; also `<fact id>|<test>|<sample>` for a row made from one part. For the document summary.
 */
export function labPartChecks(factIds: string[], entries: LabEntry[] = loadLabEntries()): Map<string, { trust: TrustInfo | null; setAside: boolean }> {
  const want = new Set(factIds);
  const out = new Map<string, { trust: TrustInfo | null; setAside: boolean }>();
  for (const e of entries) {
    if (!e.factId || !want.has(e.factId)) continue;
    const v = { trust: e.trust, setAside: isPartSetAside(e) };
    if (e.splitFrom) {
      const k = `${e.factId}#${e.splitFrom.index}`;
      // A fact's own part wins over a row's part of the same index.
      if (!out.has(k) || e.source === 'fact') out.set(k, v);
    } else out.set(`${e.factId}|${e.analyteKey}|${panelSpecimenFor(e.specimen)}`, v);
  }
  return out;
}

/** Every live entry as stored (a line of several tests still one entry), oldest first: see loadLabEntries. */
export function loadWholeLabEntries(): LabEntry[] {
  return readWholeLabEntries().entries;
}

/**
 * Every live value as read, for the lab checks (rule 10: one document gives two values like a typing error; rule 12: a
 * summary's limit or judgement differs from the lab report's) and the one-time re-read: the Labs page's own entries as
 * stored (a line of several tests is one value here), less the ones set aside (a disputed or superseded detail, a
 * deleted one, a copy) and those on deleted documents or rows. One loader, so the checks and the Labs page never
 * disagree about which values exist (amendment G1).
 */
export function loadLabReadings(opts: { withPassSetAsideClaims?: boolean } = {}): LabReadingRecord[] {
  const whole = readWholeLabEntries();
  const tiers = labDocumentMeta([...whole.entries.map((e) => e.documentId), ...whole.supersededFacts.map((x) => x.sourceDocumentId)]);
  const out: LabReadingRecord[] = [];
  const record = (e: LabEntry, reading: LabReading, passSetAside: boolean): LabReadingRecord => ({
    source: e.source,
    id: e.id,
    labResultId: e.labResultId,
    factId: e.factId,
    analyte: e.analyte,
    analyteKey: e.analyteKey,
    specimen: e.specimen,
    documentId: e.documentId,
    documentTitle: e.documentTitle,
    documentTier: e.documentId ? (tiers.get(e.documentId)?.tier ?? null) : null,
    pageNumber: e.pageNumber,
    citationId: e.citationId,
    quote: e.citationVerified ? e.quote : null,
    factStatus: e.factStatus,
    reading,
    ...(passSetAside ? { passSetAside: true } : {}),
  });
  // Rule 12 (amendment G4, 2026-10 review): a summary's restated value is set aside by the reconciliation as soon as it
  // is matched with the lab report (a copy, or a value that differs). Its judgement or limit is still that summary's
  // claim to compare, so the claims the pass itself set aside come back here, marked (never a disputed fact, never one
  // the user replaced, never a value the user changed by hand).
  const passIds = opts.withPassSetAsideClaims ? passSetAsideIds([...whole.entries.filter((e) => e.factStatus === 'superseded' && e.factId).map((e) => e.factId!), ...whole.supersededFacts.map((x) => x.id)]) : null;
  for (const e of whole.entries) {
    if (!e.analyteKey) continue;
    const reading = fullReadingOf(e);
    if (!reading) continue;
    if (!isSetAside(e)) {
      out.push(record(e, reading, false));
      continue;
    }
    if (passIds && reading.role === 'claimed' && e.factStatus === 'superseded' && !e.factDeleted && !e.copyOf && e.factId && passIds.has(e.factId)) out.push(record(e, reading, true));
  }
  if (passIds) {
    const claims = whole.supersededFacts.filter((x) => passIds.has(x.id));
    if (claims.length) {
      const cites = firstCitations(claims.map((x) => x.id));
      const docs = labDocumentMeta([...claims.map((x) => x.sourceDocumentId), ...[...cites.values()].map((c) => c.documentId)]);
      for (const x of claims) {
        const e = factEntry(x, cites.get(x.id), docs);
        const reading = fullReadingOf(e);
        if (reading && reading.role === 'claimed' && e.analyteKey) out.push(record(e, reading, true));
      }
    }
  }
  return out;
}

/**
 * The open findings of the lab checks (rules 10 and 12) on each entry, by its fact or its lab row (one query; a
 * dismissed or resolved finding is not listed). Newest first. The lists carry each finding's title only (a summary's
 * finding lists every value it restates, and was copied onto each of them: 2026-10 review, payload size); one value
 * read on its own (getLab) carries the detail too. The value pane loads the finding itself for its words and pages.
 */
function attachLabIssues(entries: LabEntry[], opts: { detail?: boolean } = {}): void {
  if (!entries.length) return;
  const f = schema.findings;
  const ev = schema.findingEvidence;
  const rows = db()
    .select({ id: f.id, ruleId: f.ruleId, title: f.title, detail: opts.detail ? f.detail : sql<string | null>`null`, status: f.status, createdAt: f.createdAt, factId: ev.factId, labResultId: ev.labResultId })
    .from(f)
    .innerJoin(ev, eq(ev.findingId, f.id))
    .where(and(isNull(f.deletedAt), inArray(f.ruleId, [...LAB_ISSUE_RULES]), notInArray(f.status, ['dismissed', 'resolved'])))
    .orderBy(desc(f.createdAt))
    .all();
  if (!rows.length) return;
  const byFact = new Map<string, LabIssue[]>();
  const byRow = new Map<string, LabIssue[]>();
  const add = (m: Map<string, LabIssue[]>, k: string | null, issue: LabIssue) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.some((x) => x.findingId === issue.findingId)) list.push(issue);
    m.set(k, list);
  };
  for (const r of rows) {
    const issue: LabIssue = { findingId: r.id, ruleId: r.ruleId as LabIssue['ruleId'], title: r.title, detail: r.detail ?? null, status: r.status };
    add(byFact, r.factId, issue);
    add(byRow, r.labResultId, issue);
  }
  for (const e of entries) {
    const list: LabIssue[] = [];
    for (const x of [...(e.labResultId ? (byRow.get(e.labResultId) ?? []) : []), ...(e.factId ? (byFact.get(e.factId) ?? []) : [])]) if (!list.some((y) => y.findingId === x.findingId)) list.push(x);
    if (list.length) e.labIssues = list;
  }
}

function readWholeLabEntries(): { entries: LabEntry[]; details: DetailState; supersededFacts: LabFactRow[] } {
  const d = db();
  const l = schema.labResults;
  const rows = d
    .select({
      ...getTableColumns(l),
      institutionName: schema.people.name,
      documentTitle: schema.documents.title,
      documentJoinedId: schema.documents.id,
      documentDeletedAt: schema.documents.deletedAt,
      factStatus: schema.facts.status,
      factVerdictBasis: schema.facts.verdictBasis,
      factStatement: schema.facts.statement,
      factDeletedAt: schema.facts.deletedAt,
      factJoinedId: schema.facts.id,
    })
    .from(l)
    .leftJoin(schema.people, eq(schema.people.id, l.institutionId))
    .leftJoin(schema.documents, eq(schema.documents.id, l.documentId))
    .leftJoin(schema.facts, eq(schema.facts.id, l.factId))
    .where(isNull(l.deletedAt))
    .all()
    .filter((r) => !(r.documentJoinedId && r.documentDeletedAt));

  const f = schema.facts;
  const facts: LabFactRow[] = d
    .select({ ...getTableColumns(f), documentTitle: schema.documents.title, documentJoinedId: schema.documents.id, documentDeletedAt: schema.documents.deletedAt, documentTier: schema.documents.sourceTier })
    .from(f)
    .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
    .where(and(eq(f.type, 'lab_result'), isNull(f.deletedAt)))
    .all()
    .filter((x) => !(x.documentJoinedId && x.documentDeletedAt));
  const factById = new Map(facts.map((x) => [x.id, x]));

  const live = (r: (typeof rows)[number]) => Boolean(r.factId && r.factJoinedId && !r.factDeletedAt);
  const linked = new Set<string>();
  for (const r of rows) if (live(r)) linked.add(r.factId!);

  const standIn = new Map<string, LabFactRow>();
  for (const r of rows) {
    if (!live(r) || r.factStatus !== 'superseded') continue;
    const keeper = keeperOf(r.factId!, factById);
    if (!keeper || linked.has(keeper.id)) continue;
    const mine = rowMeasurement(normalizeAnalyte(r.analyte, r.specimen), r.valueText, r.valueNum, r.unit, r.collectedAt);
    if (!sameMeasurement(mine, measurementOf(factEntry(keeper, undefined)))) continue;
    standIn.set(r.id, keeper);
    linked.add(keeper.id);
  }

  const unimported = facts.filter((x) => x.status !== 'superseded' && !linked.has(x.id));
  const cites = firstCitations([...linked, ...unimported.map((x) => x.id)]);
  // The tier and date of every document a value comes from (who is speaking: a lab report, a summary, not sorted yet).
  const docs = labDocumentMeta([...rows.map((r) => r.documentId), ...facts.map((x) => x.sourceDocumentId), ...[...cites.values()].map((c) => c.documentId)]);

  const out: LabEntry[] = rows.map((r) => {
    const keeper = standIn.get(r.id);
    const factLive = live(r);
    // A row changed by hand away from its own detail is the patient's value: the detail's check and status are not its.
    const own = !keeper && factLive ? factById.get(r.factId!) : undefined;
    const editedFrom = own ? labRowEditedFrom(r, own) : null;
    // Made from a clinical record's own detail: what the detail reads is the record as read.
    const editedFromRecord = editedFrom && own!.documentTier === 'primary' ? (own!.sourceDocumentId ?? r.documentId ?? null) : null;
    const factId = keeper ? keeper.id : factLive ? r.factId : null;
    const cite = factId ? cites.get(factId) : undefined;
    const documentId = r.documentId ?? cite?.documentId ?? null;
    const samePage = cite && cite.documentId === documentId;
    // Grouped by the name as written, read now (never the stored analyte_key): a row joins its test without a rewrite.
    const analyteKey = normalizeAnalyte(r.analyte, r.specimen);
    // A row made from a detail that names no sample, still on the sample the app assumed for it: the sample is assumed.
    const detail = factLive ? factById.get(r.factId!) : undefined;
    const detailAnalyte = detail ? (str(parseJson<LabAttrs>(detail.attributesJson, {}).analyte) ?? r.analyte) : null;
    const assumed = Boolean(detail && !str(parseJson<LabAttrs>(detail.attributesJson, {}).specimen) && r.specimen === defaultSpecimenFor(detailAnalyte));
    // The row read through the one accessor: its current text, its own fact's printed text as provenance (rule 1).
    const meta = documentId ? docs.get(documentId) : undefined;
    const reading = readingForRow(r, { fact: detail ?? null, editedFrom, cite: samePage ? cite! : null, documentTier: meta?.tier ?? null, documentDate: meta?.date ?? null, hasDocument: Boolean(documentId) });
    return withReading(
      {
        id: r.id,
        source: 'row',
        labResultId: r.id,
        factId,
        analyte: r.analyte,
        analyteKey,
        specimen: effectiveSpecimen(analyteKey, r.specimen, r.analyte),
        ...readingFields(reading),
        labIssues: [],
        labName: r.labName,
        institutionId: r.institutionId,
        institutionName: r.institutionName ?? null,
        documentId,
        documentTitle: r.documentTitle ?? null,
        pageNumber: samePage ? cite!.pageNumber : null,
        citationId: samePage ? cite!.id : null,
        citationVerified: samePage ? cite!.verified : null,
        quote: samePage ? cite!.quote : null,
        factStatus: keeper ? keeper.status : editedFrom ? null : factLive ? r.factStatus : null,
        factBasis: keeper ? basisOf(keeper.status, keeper.verdictBasis) : editedFrom ? null : factLive ? basisOf(r.factStatus, r.factVerdictBasis) : null,
        factStatement: keeper ? keeper.statement : factLive ? r.factStatement : null,
        factDeleted: Boolean(r.factId) && !factLive,
        trust: null,
        editedFrom,
        editedFromRecord,
        copyOf: null,
        notes: r.notes,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        splitFrom: null,
        combined: false,
        partCheck: null,
        ...(assumed ? { specimenAssumed: true } : {}),
        ...computedOf(r),
      },
      reading,
    );
  });

  for (const x of unimported) out.push(factEntry(x, cites.get(x.id), docs));

  // A row changed by hand to exactly the value of the detail that replaced its own (the clinical record), while that
  // detail's line is listed here (its own row, or a row standing for it; not changed by hand, not set aside): a copy of
  // that line, set aside as the check sets aside a copy, so the value is never listed, plotted or printed twice.
  const listedLine = new Set<string>();
  for (const e of out) if (e.factId && !e.editedFrom && !isSetAside(e)) listedLine.add(e.factId);
  const copies = new Map<LabEntry, LabFactRow>();
  for (const e of out) {
    if (e.source !== 'row' || !e.editedFrom || !e.factId) continue;
    const own = factById.get(e.factId);
    if (!own || own.status !== 'superseded') continue;
    const keeper = keeperOf(own.id, factById);
    if (!keeper || !listedLine.has(keeper.id) || !sameMeasurement(measurementOf(e), measurementOf(factEntry(keeper, undefined)))) continue;
    e.editedFrom = null;
    e.editedFromRecord = null;
    e.copyOf = keeper.id;
    e.factStatus = own.status;
    e.factBasis = basisOf(own.status, own.verdictBasis);
    copies.set(e, keeper);
  }

  // Each entry carries the trust of the fact behind it (a row entered by hand, or changed by hand away from its detail, has none).
  const trust = trustFor([...out.filter((e) => !e.editedFrom).map((e) => e.factId ?? ''), ...[...copies.values()].map((k) => k.id)].filter(Boolean));
  for (const e of out) {
    const keeper = copies.get(e);
    e.trust = keeper ? copyTrust(keeper, trust.get(keeper.id)) : e.factId && !e.editedFrom ? (trust.get(e.factId) ?? null) : null;
  }
  out.sort(byDate);

  // What the part check may do with each detail's parts (checkLabParts): the pass's own rule for setting a detail aside.
  const details: DetailState = { checkable: new Set(), open: new Set() };
  for (const x of facts) {
    const a = parseJson<Record<string, unknown>>(x.attributesJson, {});
    if (a[SEPARATE_MARKER] === true) continue;
    details.checkable.add(x.id);
    if (x.status === 'unverified' && x.verdictBasis !== 'unsure' && x.origin === 'ai' && a._userEdited !== true && !(x.verdictNote ?? '').trim()) details.open.add(x.id);
  }
  // Superseded facts no live row stands for (never listed here): the lab checks read the ones the reconciliation set
  // aside as a summary's claims (loadLabReadings).
  const supersededFacts = facts.filter((x) => x.status === 'superseded' && !linked.has(x.id));
  return { entries: out, details, supersededFacts };
}

/**
 * The trust of a row changed by hand to exactly the value of a clinical record's line (LabEntry.copyOf): it matches
 * that record (accurate, naming it), like a copy the check set aside. When that line is not a clinical record's
 * verified value (a duplicate merged by hand), the row holds that line's value and reads as that line does: never
 * called accurate on its own.
 */
function copyTrust(keeper: LabFactRow, k: TrustInfo | undefined): TrustInfo | null {
  if (!k) return null;
  if (k.trust !== 'verified') return k;
  const title = k.recordDocumentTitle ?? keeper.documentTitle ?? null;
  const value = k.recordValue ?? null;
  return {
    trust: 'accurate',
    byUser: false,
    recordFactId: keeper.id,
    recordDocumentId: k.recordDocumentId ?? keeper.sourceDocumentId ?? null,
    recordDocumentTitle: title,
    recordValue: value,
    recordDate: k.recordDate ?? keeper.date ?? null,
    recordByUser: k.recordByUser ?? false,
    reason: `Matches ${title ?? 'the clinical record'}${value ? `: ${value}` : ''} (this row was changed by hand to that value).`,
    eventKey: k.eventKey ?? null,
    canSeparate: false,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface LabFilter {
  analyteKey?: string | null;
  /** Free text analyte name: normalised and matched exactly (rule 9: no loose matching). */
  analyte?: string | null;
  specimen?: string | null;
  from?: string | null;
  to?: string | null;
  flag?: string | null;
  q?: string | null;
  /**
   * Default false: entries set aside by the user's verdict (the fact was
   * disputed or superseded, or deleted after import; see isSetAside) are left out.
   */
  includeDisputed?: boolean;
}

const PARTIAL_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** A window bound as an ISO prefix; text that is not a date is a 400, never a silently dropped filter. */
function cleanPartial(s: string | null | undefined, label = 'date'): string | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (PARTIAL_RE.test(t)) return t;
  const iso = parsePartialDate(t).iso;
  if (!iso) throw badRequest(`${label} is not a date: "${t.slice(0, 60)}" (use YYYY, YYYY-MM or YYYY-MM-DD)`);
  return iso;
}

/** Dated entries inside the window (partial dates compare on the prefix); undated entries only when there is no window. */
export function inWindow(date: string | null, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  if (!date) return false;
  const k = dateSortKey(date);
  if (from && k.slice(0, from.length) < from) return false;
  if (to && k.slice(0, to.length) > to) return false;
  return true;
}

/**
 * The test an entry is listed under is exactly the test asked for (rule 9): no loose matching. "IgG" never finds the
 * IgG index, "albumin" never the albumin index; an unclear name finds nothing and matchLabAnalyte names the similar
 * tests on file. `rawKey` and `loose` are kept for the callers' signature; loose matching was removed (2026-10).
 */
export function analyteMatches(entry: Pick<LabEntry, 'analyte' | 'analyteKey'>, key: string, _rawKey?: string, _loose?: boolean): boolean {
  return Boolean(key) && entry.analyteKey === key;
}

/** A value out of its own range: a flag printed with it (H, L, A, C), or worked out from the range printed with it. Never a document's claim (rules 8, 12). */
export function outOfOwnRange(v: LabReadingView): boolean {
  if (v.role === 'claimed' || v.role === 'computed') return false;
  if (v.flagState === 'flag' && (v.flagPrinted === 'H' || v.flagPrinted === 'L' || v.flagPrinted === 'A' || v.flagPrinted === 'C')) return true;
  return v.computed === 'H' || v.computed === 'L';
}

/** A value inside its own range: a printed N or worked out in range, with nothing that says it is out. Never a document's claim. */
export function inOwnRange(v: LabReadingView): boolean {
  if (v.role === 'claimed' || v.role === 'computed' || outOfOwnRange(v)) return false;
  return (v.flagState === 'flag' && v.flagPrinted === 'N') || v.computed === 'N';
}

function applyFilter(entries: LabEntry[], f: LabFilter): LabEntry[] {
  const from = cleanPartial(f.from, 'from');
  const to = cleanPartial(f.to, 'to');
  const specimen = normalizeKey(f.specimen).replace(/ /g, '_') || null;
  const flag = (f.flag ?? '').trim().toUpperCase() || null;
  const q = (f.q ?? '').trim().toLowerCase();
  const rawKey = normalizeKey(f.analyte ?? f.analyteKey);
  const key = rawKey ? normalizeAnalyte(f.analyte ?? f.analyteKey, specimen) : '';
  // A key passed as a key (from the analyte table) also matches itself as stored.
  const asKey = !f.analyte && f.analyteKey ? normalizeKey(f.analyteKey) : '';
  return entries.filter((e) => {
    if (!f.includeDisputed && isSetAside(e)) return false;
    if (specimen && specimen !== 'all' && e.specimen !== specimen) return false;
    if (!inWindow(e.date, from, to)) return false;
    if (flag) {
      // OUT: a printed H, L, A or C, or out of its own range; IN: a printed N or inside its own range, nothing out. A
      // document's claim (a summary's flag) is never counted.
      if (flag === 'OUT' ? !outOfOwnRange(e.reading) : flag === 'IN' ? !inOwnRange(e.reading) : e.flag !== flag) return false;
    }
    if (q) {
      const hay = [e.analyte, e.analyteKey, e.labName, e.documentTitle, e.notes, e.valueText, e.unit, e.specimen, e.splitFrom?.text].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (key && !(analyteMatches(e, key) || (asKey && e.analyteKey === asKey))) return false;
    return true;
  });
}

export function listLabs(f: LabFilter = {}): LabEntry[] {
  return applyFilter(loadLabEntries(), { includeDisputed: true, ...f });
}

/**
 * One entry by id: a part (`<id>#<index>`) or an entry as stored. The original id of a line that was read as parts
 * returns the line as stored (what an edit of that row acts on).
 */
export function getLab(id: string): LabEntry {
  const whole = readWholeLabEntries();
  const expanded = checkLabParts(expandLabEntries(whole.entries), whole.details);
  markComputedEntries(expanded, isSetAside);
  const e = expanded.find((x) => x.id === id) ?? whole.entries.find((x) => x.id === id);
  if (!e) throw notFound('lab result not found');
  attachLabIssues([e], { detail: true });
  return e;
}

/** The stored row or fact entry a part id names ("<id>#2" is "<id>"); any other id as it is. */
export function originalLabId(id: string): string {
  return id.replace(/#\d+$/, '');
}

// ---------------------------------------------------------------------------
// Analytes
// ---------------------------------------------------------------------------

/** A range printed with the values of one test, as printed, with the lab that printed it (rule 8: ranges belong to their lab). */
export interface AnalyteRange {
  /** As shown (reading.rangeShown): the text as printed, or "upper limit 50" from a stored number. */
  shown: string;
  /** The lab that printed it, as named on the report; null when no lab is named. */
  lab: string | null;
  /** The unit of the values printed with it. */
  unit: string | null;
  /** printed (a lab report), unclassified (a document not sorted yet), typed (entered by hand), claimed (a summary's own range). */
  role: ReadingRole;
  /** How many values were printed with it. */
  count: number;
  /** For a claimed range: the document that states it. */
  documentTitle: string | null;
  /** A unit printed inside the range itself ("0.15-0.45 g/L"); null when it prints none (then it is in the values' unit). */
  rangeUnit: string | null;
  /** The range is read as numbers (bounds); false for words ("Negative") or a range kept as printed ("see comment"). */
  asNumbers: boolean;
}

export interface AnalyteSummary {
  analyteKey: string;
  analyte: string;
  specimen: string;
  count: number;
  /** The unit when every value of the test has one and the same unit; null when the units differ or a value printed none (rule 5). */
  unit: string | null;
  /** Every unit as printed, most frequent first; '' stands for "no unit printed". */
  units: string[];
  /** The last value as shown (reading.valueShown). */
  lastValue: string;
  /** Its measurement; null for a limit or words. */
  lastValueNum: number | null;
  lastUnit: string | null;
  lastDate: string | null;
  lastDatePrecision: string;
  lastFlag: string | null;
  /** The last flag was worked out from the value's own range, not printed (shown with `~`). */
  lastFlagDerived: boolean;
  /** Who gives the last value: a lab report (printed), a document not sorted yet, a value entered by hand, or (only when the test has nothing else) a summary (claimed). */
  lastRole: ReadingRole;
  /** "from <document> (a summary)" when the last value comes from a document that restates results; null otherwise. */
  lastNote: string | null;
  firstDate: string | null;
  /** Some value is inside the range printed with it (claims of summaries not counted). */
  everInRange: boolean;
  /** Values outside the range printed with them, or printed with H, L, A or C (claims of summaries not counted). */
  outOfRangeCount: number;
  /** Every range printed with the values, each with its lab and unit: lab reports first, a summary's own ranges last. */
  ranges: AnalyteRange[];
  /** The test's one printed range: set only when every value that printed a range printed the same one (bounds, signs, unit); null otherwise. */
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  unverifiedCount: number;
  factOnlyCount: number;
  documentCount: number;
  /** Some value of this test is a line that names several tests the app could not tell apart (LabEntry.combined). */
  combined: boolean;
  /** The last value was read out of a line that holds several tests: that line as written (LabEntry.splitFrom.text). */
  lastSplitFrom: string | null;
}

function mostCommon(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

/** Values in order of how often they occur ('' counted too). */
function byFrequency(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

const ROLE_ORDER: Record<ReadingRole, number> = { printed: 0, unclassified: 1, typed: 2, computed: 3, claimed: 4 };

/**
 * A range's signature: its bounds, their signs and its unit (rule 8: a band is drawn only when the readings in view
 * share one). A range in words ("Negative") by its words. Null for a value with no range read as such.
 */
export function rangeSignature(v: LabReadingView): string | null {
  if (v.rangeStatus !== 'parsed') return null;
  if (v.rangeKind === 'text') return `t:${normalizeKey(v.rangeShown)}`;
  return `${v.rangeLow ?? ''}|${v.rangeLowComparator ?? ''}|${v.rangeHigh ?? ''}|${v.rangeHighComparator ?? ''}|${v.rangeUnitKey ?? ''}`;
}

/** Every range printed with these values, as printed, with its lab, unit and role: lab reports first. */
function rangesOf(g: LabEntry[]): AnalyteRange[] {
  const map = new Map<string, AnalyteRange>();
  for (const e of g) {
    const v = e.reading;
    if (v.rangeStatus === 'none' || !v.rangeShown) continue;
    const k = `${v.role === 'claimed' ? 'c' : 'p'}|${rangeSignature(v) ?? `x:${v.rangeShown}`}|${v.labKey ?? ''}|${v.role === 'claimed' ? (e.documentId ?? '') : ''}`;
    const cur = map.get(k);
    if (cur) cur.count++;
    else map.set(k, { shown: v.rangeShown, lab: v.lab, unit: v.unit, role: v.role, count: 1, documentTitle: v.role === 'claimed' ? e.documentTitle : null, rangeUnit: v.rangeUnit ?? null, asNumbers: v.rangeStatus === 'parsed' && v.rangeKind !== 'text' });
  }
  return [...map.values()].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.count - a.count || a.shown.localeCompare(b.shown));
}

export function summarizeAnalytes(entries: LabEntry[]): AnalyteSummary[] {
  const groups = new Map<string, LabEntry[]>();
  for (const e of entries) {
    const k = `${e.analyteKey}|${e.specimen}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const out: AnalyteSummary[] = [];
  for (const g of groups.values()) {
    g.sort(byDate);
    // The last value comes from a lab report, a document not sorted yet or a value entered by hand; a summary's value
    // only when the test has nothing else (rule 11).
    const own = g.filter((e) => e.reading.role !== 'claimed');
    const pool = own.length ? own : g;
    const dated = pool.filter((e) => e.date);
    const last = dated.length ? dated[dated.length - 1] : pool[pool.length - 1];
    const allDated = g.filter((e) => e.date);
    // One unit only when every value has the same unit (by its key); else none over mixed values (rule 5).
    const keys = new Set(g.map((e) => e.reading.unitKey ?? ''));
    const oneUnit = keys.size === 1 && !keys.has('') ? mostCommon(g.map((e) => e.unit)) : null;
    // The test's one range: only when every value that printed one (a summary's claim aside) printed the same.
    const sigs = new Map<string, LabEntry[]>();
    for (const e of own) {
      // A range kept as printed ("<1:40", "see comment") is a range too: said as printed, never read as numbers.
      const s = rangeSignature(e.reading) ?? (e.reading.rangeStatus === 'unparsed' && e.reading.rangeShown ? `x:${e.reading.rangeShown}` : null);
      if (!s) continue;
      const list = sigs.get(s) ?? [];
      list.push(e);
      sigs.set(s, list);
    }
    const one = sigs.size === 1 ? [...sigs.values()][0] : null;
    const oneRange = one ? one[one.length - 1].reading : null;
    out.push({
      analyteKey: g[0].analyteKey,
      analyte: analyteLabel(g[0].analyteKey, mostCommon(g.map((e) => e.analyte))),
      specimen: g[0].specimen,
      count: g.length,
      unit: oneUnit,
      units: byFrequency(g.map((e) => e.unit ?? '')),
      lastValue: last.reading.valueShown,
      lastValueNum: last.reading.measurement,
      lastUnit: last.unit,
      lastDate: last.date,
      lastDatePrecision: last.datePrecision,
      lastFlag: last.flag,
      lastFlagDerived: last.flagDerived,
      lastRole: last.reading.role,
      lastNote: last.reading.role === 'claimed' ? `from ${last.documentTitle ?? 'a document'} (a summary)` : last.reading.role === 'computed' ? (last.computed?.record.label ?? 'computed') : null,
      firstDate: allDated.length ? allDated[0].date : null,
      everInRange: g.some((e) => inOwnRange(e.reading)),
      outOfRangeCount: g.filter((e) => outOfOwnRange(e.reading)).length,
      ranges: rangesOf(g),
      refLow: oneRange && oneRange.rangeStatus === 'parsed' && oneRange.rangeKind !== 'text' ? oneRange.rangeLow : null,
      refHigh: oneRange && oneRange.rangeStatus === 'parsed' && oneRange.rangeKind !== 'text' ? oneRange.rangeHigh : null,
      refText: oneRange ? (mostCommon(one!.map((e) => e.reading.rangeShown)) ?? oneRange.rangeShown) : null,
      // Still pending a check (a value marked unsure has been answered).
      unverifiedCount: g.filter((e) => e.factStatus === 'unverified' && e.factBasis !== 'unsure').length,
      factOnlyCount: g.filter((e) => e.source === 'fact').length,
      documentCount: new Set(g.map((e) => e.documentId).filter(Boolean)).size,
      combined: g.some((e) => e.combined),
      lastSplitFrom: last.splitFrom?.text ?? null,
    });
  }
  out.sort((a, b) => (a.specimen === 'csf' ? 0 : 1) - (b.specimen === 'csf' ? 0 : 1) || a.analyte.localeCompare(b.analyte) || a.specimen.localeCompare(b.specimen));
  return out;
}

export interface SpecimenCount {
  specimen: string;
  count: number;
}

export function listAnalytes(f: LabFilter = {}): { items: AnalyteSummary[]; specimens: SpecimenCount[] } {
  const all = loadLabEntries();
  const unfiltered = applyFilter(all, { ...f, specimen: null });
  const counts = new Map<string, number>();
  for (const e of unfiltered) counts.set(e.specimen, (counts.get(e.specimen) ?? 0) + 1);
  const specimens: SpecimenCount[] = SPECIMENS.map((s) => ({ specimen: s, count: counts.get(s) ?? 0 }));
  for (const [s, n] of counts) if (!SPECIMENS.includes(s as (typeof SPECIMENS)[number])) specimens.push({ specimen: s, count: n });
  return { items: summarizeAnalytes(applyFilter(all, f)), specimens };
}

// ---------------------------------------------------------------------------
// Organised views: by specimen and panel, and by document
// ---------------------------------------------------------------------------

/** One dated result inside an analyte's series, with its provenance. */
export interface OrganisedPoint {
  /** The entry's id: a part of a line of several tests is `<row or fact id>#<index>` (labResultId / factId name the original). */
  id: string;
  source: 'row' | 'fact';
  labResultId: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  value: string;
  valueNum: number | null;
  unit: string | null;
  ref: string | null;
  flag: string | null;
  flagDerived: boolean;
  documentId: string | null;
  documentTitle: string | null;
  page: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  factId: string | null;
  factStatus: string | null;
  factBasis: 'original' | 'summary' | 'unsure' | 'correction' | null;
  factDeleted: boolean;
  trust: TrustInfo | null;
  splitFrom: LabSplitFrom | null;
  combined: boolean;
  /** The value as read (LabEntry.reading). */
  reading: LabReadingView;
  /** Open findings of the lab checks naming this value (LabEntry.labIssues). */
  labIssues: LabIssue[];
}

export interface OrganisedAnalyte extends AnalyteSummary {
  panel: string;
  /** Report position inside the panel (-1 for analytes the panel does not name). */
  position: number;
  series: OrganisedPoint[];
}

export interface OrganisedPanel {
  panel: string;
  order: number;
  count: number;
  analytes: OrganisedAnalyte[];
}

export interface OrganisedSpecimen {
  specimen: PanelSpecimen;
  label: string;
  count: number;
  panels: OrganisedPanel[];
}

function toPoint(e: LabEntry): OrganisedPoint {
  return {
    id: e.id,
    source: e.source,
    labResultId: e.labResultId,
    date: e.date,
    datePrecision: e.datePrecision,
    dateText: e.dateText,
    value: formatValue(e),
    valueNum: e.valueNum,
    unit: e.unit,
    ref: formatRef(e),
    flag: e.flag,
    flagDerived: e.flagDerived,
    documentId: e.documentId,
    documentTitle: e.documentTitle,
    page: e.pageNumber,
    citationId: e.citationId,
    citationVerified: e.citationVerified,
    factId: e.factId,
    factStatus: e.factStatus,
    factBasis: e.factBasis,
    factDeleted: e.factDeleted,
    trust: e.trust,
    splitFrom: e.splitFrom,
    combined: e.combined,
    reading: e.reading,
    labIssues: e.labIssues,
  };
}

function byReportOrder(a: { position: number; analyte: string }, b: { position: number; analyte: string }): number {
  const pa = a.position < 0 ? Number.MAX_SAFE_INTEGER : a.position;
  const pb = b.position < 0 ? Number.MAX_SAFE_INTEGER : b.position;
  return pa - pb || a.analyte.localeCompare(b.analyte);
}

/**
 * The labs ledger stacked by specimen, then panel, then analyte: CSF studies
 * together under "CSF basic" / "CSF immunology" / ..., blood work under
 * "CBC" / "Metabolic" / ..., every analyte carrying its full dated series.
 * Entries set aside by the user's verdict (disputed, superseded, fact deleted)
 * are left out, as in the analyte table, unless asked for.
 */
export function organiseLabs(f: LabFilter = {}): { specimens: OrganisedSpecimen[]; specimenCounts: SpecimenCount[]; total: number } {
  const all = loadLabEntries();
  const entries = applyFilter(all, f);
  const unfiltered = applyFilter(all, { ...f, specimen: null });
  const counts = new Map<string, number>();
  for (const e of unfiltered) counts.set(e.specimen, (counts.get(e.specimen) ?? 0) + 1);
  const specimenCounts: SpecimenCount[] = SPECIMENS.map((s) => ({ specimen: s, count: counts.get(s) ?? 0 }));
  for (const [s, n] of counts) if (!SPECIMENS.includes(s as (typeof SPECIMENS)[number])) specimenCounts.push({ specimen: s, count: n });

  const seriesByKey = new Map<string, LabEntry[]>();
  for (const e of entries) {
    const k = `${e.analyteKey}|${e.specimen}`;
    const g = seriesByKey.get(k);
    if (g) g.push(e);
    else seriesByKey.set(k, [e]);
  }
  const buckets = new Map<PanelSpecimen, Map<string, OrganisedPanel>>();
  for (const s of summarizeAnalytes(entries)) {
    const place = labPanelFor(s.analyteKey, s.specimen);
    const series = (seriesByKey.get(`${s.analyteKey}|${s.specimen}`) ?? []).slice().sort(byDate).map(toPoint);
    let panels = buckets.get(place.specimen);
    if (!panels) {
      panels = new Map();
      buckets.set(place.specimen, panels);
    }
    let panel = panels.get(place.panel);
    if (!panel) {
      panel = { panel: place.panel, order: place.order, count: 0, analytes: [] };
      panels.set(place.panel, panel);
    }
    panel.analytes.push({ ...s, panel: place.panel, position: place.position, series });
    panel.count += s.count;
  }
  const specimens: OrganisedSpecimen[] = [];
  for (const specimen of PANEL_SPECIMEN_ORDER) {
    const panels = buckets.get(specimen);
    if (!panels) continue;
    const list = [...panels.values()].sort((a, b) => a.order - b.order);
    for (const p of list) p.analytes.sort(byReportOrder);
    specimens.push({ specimen, label: PANEL_SPECIMEN_LABELS[specimen], count: list.reduce((n, p) => n + p.count, 0), panels: list });
  }
  return { specimens, specimenCounts, total: entries.length };
}

export interface DocumentPanel {
  panel: string;
  order: number;
  count: number;
  rows: LabSeriesRow[];
}

export interface DocumentSpecimen {
  specimen: PanelSpecimen;
  label: string;
  count: number;
  panels: DocumentPanel[];
}

export interface DocumentLabs {
  /** null for results entered by hand with no source document. */
  documentId: string | null;
  title: string;
  /** The document's own date; null when it has none (shown "not dated"; a result's date never stands in for it). */
  date: string | null;
  datePrecision: string;
  /** primary | patient | compilation | external | unknown, or null without a document. */
  tier: string | null;
  category: string | null;
  institutionName: string | null;
  count: number;
  specimens: DocumentSpecimen[];
}

/**
 * Everything pulled from one report, stacked together: a document header,
 * then its CSF studies, then its blood work, each under panel sub-headers in
 * report order. Set-aside entries (disputed, superseded) stay listed, tagged, because this is a
 * faithful view of what each document says. Hand-entered results with no
 * document form one last group.
 */
export function labsByDocument(f: LabFilter = {}): { documents: DocumentLabs[]; total: number } {
  const entries = applyFilter(loadLabEntries(), { includeDisputed: true, ...f });
  const groups = new Map<string, LabEntry[]>();
  for (const e of entries) {
    const k = e.documentId ?? '';
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const ids = [...groups.keys()].filter(Boolean);
  const docs = new Map<string, { title: string; date: string | null; precision: string; tier: string; category: string; institutionName: string | null }>();
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({
        id: schema.documents.id,
        title: schema.documents.title,
        documentDate: schema.documents.documentDate,
        documentDatePrecision: schema.documents.documentDatePrecision,
        sourceTier: schema.documents.sourceTier,
        category: schema.documents.category,
        institutionName: schema.people.name,
      })
      .from(schema.documents)
      .leftJoin(schema.people, eq(schema.people.id, schema.documents.institutionId))
      .where(inArray(schema.documents.id, ids.slice(i, i + 400)))
      .all();
    for (const r of rows) docs.set(r.id, { title: r.title, date: r.documentDate, precision: r.documentDatePrecision, tier: r.sourceTier, category: r.category, institutionName: r.institutionName ?? null });
  }

  const out: DocumentLabs[] = [];
  for (const [documentId, list] of groups) {
    const doc = documentId ? docs.get(documentId) : undefined;
    const specimens = new Map<PanelSpecimen, Map<string, DocumentPanel & { positions: Map<string, number> }>>();
    for (const e of list) {
      const place = labPanelFor(e.analyteKey, e.specimen);
      let panels = specimens.get(place.specimen);
      if (!panels) {
        panels = new Map();
        specimens.set(place.specimen, panels);
      }
      let panel = panels.get(place.panel);
      if (!panel) {
        panel = { panel: place.panel, order: place.order, count: 0, rows: [], positions: new Map() };
        panels.set(place.panel, panel);
      }
      panel.positions.set(e.id, place.position);
      panel.rows.push({ ...e, value: formatValue(e), ref: formatRef(e), href: hrefFor(e) });
      panel.count++;
    }
    const specimenList: DocumentSpecimen[] = [];
    for (const specimen of PANEL_SPECIMEN_ORDER) {
      const panels = specimens.get(specimen);
      if (!panels) continue;
      const sorted = [...panels.values()].sort((a, b) => a.order - b.order);
      const plain: DocumentPanel[] = sorted.map((p) => {
        const pos = (r: LabSeriesRow) => {
          const v = p.positions.get(r.id) ?? -1;
          return v < 0 ? Number.MAX_SAFE_INTEGER : v;
        };
        const rows = p.rows.slice().sort((a, b) => pos(a) - pos(b) || analyteLabel(a.analyteKey, a.analyte).localeCompare(analyteLabel(b.analyteKey, b.analyte)) || byDate(a, b));
        return { panel: p.panel, order: p.order, count: p.count, rows };
      });
      specimenList.push({ specimen, label: PANEL_SPECIMEN_LABELS[specimen], count: plain.reduce((n, p) => n + p.count, 0), panels: plain });
    }
    out.push({
      documentId: documentId || null,
      // Values with no document: typed by hand, or computed by the patient from printed values (2026-10-09), said as such.
      title: doc?.title ?? (documentId ? list[0].documentTitle ?? 'Document' : list.every((e) => e.computed) ? 'Computed by you (no document)' : list.some((e) => e.computed) ? 'Entered by hand or computed by you (no document)' : 'Entered by hand (no document)'),
      // The document's own date only: a document with none is "not dated" (never a result's date put in its place, rule 7).
      date: doc?.date ?? null,
      datePrecision: doc?.date ? doc.precision : 'unknown',
      tier: doc ? doc.tier : null,
      category: doc?.category ?? null,
      institutionName: doc?.institutionName ?? list.find((e) => e.institutionName)?.institutionName ?? null,
      count: list.length,
      specimens: specimenList,
    });
  }
  // Newest document first; undated after dated; hand-entered results last.
  out.sort((a, b) => {
    if (!a.documentId !== !b.documentId) return a.documentId ? -1 : 1;
    if (!a.date !== !b.date) return a.date ? -1 : 1;
    return dateSortKey(b.date).localeCompare(dateSortKey(a.date)) || a.title.localeCompare(b.title);
  });
  return { documents: out, total: entries.length };
}

// ---------------------------------------------------------------------------
// Series and charts (used by the consult tools)
// ---------------------------------------------------------------------------

export interface SeriesQuery {
  analyte: string;
  specimen?: string | null;
  from?: string | null;
  to?: string | null;
}

function seriesRows(all: LabEntry[], q: SeriesQuery, includeSetAside: boolean): LabSeriesRow[] {
  if (!q.analyte || !q.analyte.trim()) return [];
  const rows = applyFilter(all, { analyte: q.analyte, specimen: q.specimen, from: q.from, to: q.to, includeDisputed: includeSetAside });
  return rows.map((e) => ({ ...e, value: formatValue(e), ref: formatRef(e), href: hrefFor(e) }));
}

/**
 * The merged, chronological series for one analyte, with provenance on every
 * row. Results set aside by the user's verdict (disputed, superseded, fact
 * deleted) are left out.
 */
export function findLabSeries(q: SeriesQuery, entries?: LabEntry[]): LabSeriesRow[] {
  if (!q.analyte || !q.analyte.trim()) return [];
  return seriesRows(entries ?? loadLabEntries(), q, false);
}

export interface ChartQuery extends SeriesQuery {
  overlayMedications?: boolean;
  title?: string | null;
}

interface Course {
  name: string;
  /** The recorded start, else the first time the records place the drug (startKnown false); null when only the stop is known. */
  start: string | null;
  stop: string | null;
  status: string;
  /** The chart row: two names of one drug share one (medicationLanes). */
  lane: string;
  /** `start` is the recorded start (false: first seen then; it may have begun earlier). */
  startKnown: boolean;
  /** No stop date and the medication is current: it runs to the right edge. */
  ongoing: boolean;
}

/**
 * Medication courses and dated events (dose changes, holds, resumes, reactions) from slice G's getMedicationTimeline.
 * Courses read their starts honestly through medicationCourse (the symptom chart's rule): from the recorded start, else
 * from when the drug was first seen (startKnown false); open-ended only while current; a stopped or unknown-status
 * course with no stop date has nothing honest to draw and is left out.
 */
export function medicationOverlay(): { courses: Course[]; events: Array<{ name: string; kind: string; date: string }> } {
  const courses: Course[] = [];
  const events: Array<{ name: string; kind: string; date: string }> = [];
  const items = getMedicationTimeline().items;
  const lanes = medicationLanes(items);
  for (const it of items) {
    const c = medicationCourse(it, lanes.get(it.medicationId));
    if (c) courses.push({ name: c.name, start: c.from, stop: c.to, status: it.status, lane: c.lane, startKnown: c.startKnown, ongoing: c.ongoing });
    for (const e of it.events) {
      if (!e.date) continue;
      if (e.kind === 'start' || e.kind === 'stop' || e.kind === 'note') continue;
      events.push({ name: it.name, kind: e.kind, date: e.date });
    }
  }
  return { courses, events };
}

function yearOf(iso: string | null): string {
  return iso ? iso.slice(0, 4) : '';
}

/** The reconciliation's reason when clinical records disagree with each other about the value (services/reconcile.ts). */
const RECORDS_DISAGREE_RE = /^Clinical records disagree\b/;
/** The reconciliation's reason for a value it could not compare (another unit, other words, only a month; not "Not compared automatically"). */
const NOT_COMPARED_RE = /^Not compared:/;
/** Values the record could not be compared with (another unit, other words) that disagree with each other between documents. */
const VALUES_DISAGREE_RE = /^These documents give different values\b/;

/** Source tier of each of these documents. */
function documentTiers(ids: Array<string | null | undefined>): Map<string, string> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, string>();
  for (let i = 0; i < want.length; i += 400) {
    for (const r of db().select({ id: schema.documents.id, tier: schema.documents.sourceTier }).from(schema.documents).where(inArray(schema.documents.id, want.slice(i, i + 400))).all()) out.set(r.id, r.tier);
  }
  return out;
}

/** A unit as a chart groups it (equality only, never shown): the shared unit key ("cm H2O" = "cmH2O" = "cmH20"; "cells/uL" = "/uL"; "cells/uL cells/uL" = "/uL"). */
export function unitCanon(u: string | null | undefined): string {
  return unitKey(u) ?? '';
}

const PRESSURE_KEYS = new Set(['opening pressure', 'closing pressure']);

/**
 * A unit drawn on one axis with the others of its kind, converted (convertValue, src/shared/labvalues.ts): a column of
 * water (cmH2O = 10 mmH2O), and mmHg for a lumbar puncture's pressures only (1 mmHg = 1.35951 cmH2O). Any other pair
 * of units (mg/dL and g/L included) is drawn as a series of its own, never on one axis as if it were the same unit.
 */
function pressureUnit(canon: string, key: string): boolean {
  if (canon === 'cmh2o' || canon === 'mmh2o') return true;
  return canon === 'mmhg' && PRESSURE_KEYS.has(key);
}

interface ChartUnitGroup {
  /** The unit drawn (as most often written), null for values with no unit printed. */
  unit: string | null;
  rows: Array<{ r: LabSeriesRow; y: number | null; converted: boolean }>;
}

/**
 * The drawn values of one test grouped by unit (see buildLabChart), most values first. A value with no unit printed
 * is a series of its own ("no unit printed"), never given the test's unit (rule 5).
 */
function chartUnitGroups(plottable: LabSeriesRow[], key: string): ChartUnitGroup[] {
  const read = plottable.map((r) => {
    const canon = r.reading.unitKey ?? '';
    return { r, canon, pressure: canon ? pressureUnit(canon, key) : false };
  });
  // An index the patient computed carries no unit; the lab may print the same index as a "ratio": one series, one chart (D5).
  const ratioWord = mostCommon(read.filter((x) => x.r.reading.role !== 'computed' && UNITLESS_WORDS.has(x.canon)).map((x) => x.canon));
  const byGroup = new Map<string, typeof read>();
  for (const x of read) {
    const g = x.pressure ? 'dim:pressure' : `unit:${x.r.reading.role === 'computed' && !x.canon && ratioWord ? ratioWord : x.canon}`;
    const list = byGroup.get(g);
    if (list) list.push(x);
    else byGroup.set(g, [x]);
  }
  const out: ChartUnitGroup[] = [];
  for (const list of byGroup.values()) {
    // The most common unit; a tie among a lumbar puncture's pressures is drawn in cmH2O.
    const counts = new Map<string, number>();
    for (const x of list) if (x.canon) counts.set(x.canon, (counts.get(x.canon) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    const tied = [...counts.keys()].filter((c) => counts.get(c) === top);
    const target = tied.includes('cmh2o') ? 'cmh2o' : (tied[0] ?? '');
    const unit = target ? mostCommon(list.filter((x) => x.canon === target).map((x) => x.r.unit)) : null;
    out.push({
      unit,
      rows: list
        .map((x) => {
          const m = x.r.reading.measurement;
          if (m == null || !unit || x.canon === target || !x.pressure) return { r: x.r, y: m, converted: false };
          const c = convertValue(m, x.r.unit, unit, key);
          return c ? { r: x.r, y: c.value, converted: true } : { r: x.r, y: m, converted: false };
        })
        .sort((a, b) => byDate(a.r, b.r)),
    });
  }
  // Most values first; values with no unit printed last (never the axis the band and the label are read on).
  out.sort((a, b) => (a.unit ? 0 : 1) - (b.unit ? 0 : 1) || b.rows.length - a.rows.length);
  return out;
}

/** The words on a computed value an input of which changed since (labcompute.ts INPUT_CHANGED). */
const INPUT_CHANGED_WORDS = INPUT_CHANGED;

/** Units that only say the value is a ratio (an index has no unit): a computed index joins the lab's series of them. */
const UNITLESS_WORDS = new Set(['ratio', 'index']);

/** The days a value can be matched on as one result (amendment G5): its own date, and its collected and resulted days. */
function resultDays(r: LabSeriesRow): Set<string> {
  const out = new Set<string>();
  if (r.date) out.add(r.date);
  for (const d of [r.reading.collected?.iso, r.reading.resulted?.iso]) if (d) out.add(d);
  return out;
}

/**
 * One result in two sources (amendment G5): the same value ("62" = "62.0", "<3" is not "3"), the same unit, the same
 * lab when both name one, and a day in common (a lab report dated by collection and a portal copy dated by its result).
 */
export function sameResult(a: LabSeriesRow, b: LabSeriesRow): boolean {
  if (a.analyteKey !== b.analyteKey || a.reading.identity !== b.reading.identity || !a.reading.identity) return false;
  if ((a.reading.unitKey ?? '') !== (b.reading.unitKey ?? '')) return false;
  if (a.reading.labKey && b.reading.labKey && a.reading.labKey !== b.reading.labKey) return false;
  const da = resultDays(a);
  for (const d of resultDays(b)) if (da.has(d)) return true;
  return false;
}

/** A point's flag (src/shared/chart.ts): the flag printed with it (H, L, A, C), or worked out from its own range ("H~", "L~"). A document's claim never reaches the chart. */
function pointFlag(v: LabReadingView): string | null {
  if (v.role === 'claimed' || v.role === 'computed') return null;
  if (v.flagState === 'flag' && v.flagPrinted && v.flagPrinted !== 'N') return v.flagPrinted;
  if (v.computed === 'H' || v.computed === 'L') return `${v.computed}~`;
  return null;
}

/** The flag said in a point's label: as printed (never "N"), "above its range", or a document's own flag as its claim. */
function pointFlagWords(v: LabReadingView): string {
  if (v.role === 'computed') return '';
  if (v.role === 'claimed') return v.flagState === 'flag' && v.flagRaw ? ` (this document's own flag: ${v.flagRaw.trim()})` : '';
  if (v.flagState === 'flag' && v.flagPrinted && v.flagPrinted !== 'N') return ` ${(v.flagRaw ?? v.flagPrinted).trim()}`;
  if (v.computed === 'H') return ' (above its range)';
  if (v.computed === 'L') return ' (below its range)';
  return '';
}

/**
 * A ChartSpec for one analyte: measurements as a dated line (one series per unit when units differ and do not convert;
 * a value marked inaccurate by the reconciliation is left out and counted in the note), every point linking to its
 * source page, and, on request, medication courses (drawn as rows under the chart, see medicationOverlay) with dose
 * changes, holds, resumes and reactions as markers. Validated against `chartSpec` before it is returned.
 *
 * Only measurements are drawn (rules 2, 6): a limit ("<3"), words, or a value printed as a range is named in the note,
 * never plotted, whatever number is stored with it. One result found in several documents is one point ("and 2
 * copies", amendment G5). A value's flag is the one printed with it, or worked out from the range printed with it
 * ("H~"); a summary's own flag never marks a point. The normal-range band is drawn only when every value in view that
 * printed a range printed the same one (bounds, signs, unit); otherwise there is no band and the note names each range
 * with its lab (rule 8). A summary's values are drawn apart, as separate points, when the test has values from lab
 * reports (rule 11).
 *
 * No chart (null) when nothing in the range can be drawn: a test whose results are all words (Negative, Clear, Not
 * detected) or limits has no chart anywhere, only its dated results (labSeriesView, `wordOnly`); so has a test whose
 * numbers are all marked inaccurate or undated. A test with numbers and words charts its numbers only; its rows keep
 * every result.
 */
export function buildLabChart(q: ChartQuery, entries?: LabEntry[]): ChartSpec | null {
  return labSeriesView(q, entries).chart;
}

/** A test's values and its chart, as the Labs page and the clinician's tools read them. */
export interface LabSeriesView {
  /** Every result in the range, words included, set-aside ones left out (findLabSeries). */
  rows: LabSeriesRow[];
  /** The chart of the numbers that can be drawn; null when there are none (buildLabChart). */
  chart: ChartSpec | null;
  /** Every result in the range is words or limits (Negative, Clear, "<2"), none a measurement: no chart, a dated list. */
  wordOnly: boolean;
  /** Which test on file the name asked for (rule 9): exact, or no rows with the similar tests on file named. */
  match: AnalyteMatch;
}

/**
 * Lab rows whose sample is only assumed (made from a detail that names none, still on the sample the app assumed for
 * it), as the Labs page reads them: the packet and the cross-reference rules read such rows the same way, so a line the
 * Labs page keeps whole is never split there into blood tests.
 */
export function assumedLabRowIds(entries?: LabEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries ?? loadLabEntries()) if (e.source === 'row' && e.labResultId && e.specimenAssumed) out.add(e.labResultId);
  return out;
}

/** Results in words or limits only, none a measurement that can be drawn ("Negative", "Clear", "<2"). False with no results. */
export function isWordOnly(rows: ReadonlyArray<Pick<LabEntry, 'valueNum'> & { valueText?: string | null; reading?: LabReadingView }>): boolean {
  return rows.length > 0 && rows.every((r) => !hasNumber(r));
}

/**
 * A value that is a measurement (rules 2, 6): its reading says so; for a bare value, a stored number whose text, if
 * any, reads as a plain number ("62", "1,250", "62 mg/dL"), never a limit ("<2") or a word answer that happens to
 * carry one ("Nonreactive" stored with 0).
 */
export function hasNumber(r: Pick<LabEntry, 'valueNum'> & { valueText?: string | null; reading?: LabReadingView }): boolean {
  if (r.reading) return r.reading.kind === 'number' && r.reading.measurement != null;
  if (r.valueNum == null || !Number.isFinite(r.valueNum)) return false;
  const t = (r.valueText ?? '').trim();
  return !t || parseLabValue(t).kind === 'number';
}

/**
 * Which test on file a series query names (rule 9): exact, or no rows with the reason and the similar tests on file
 * (shared matchAnalyte). The tests on file are the live values' (set-aside ones aside), on the asked specimen.
 */
export function matchLabAnalyte(q: Pick<SeriesQuery, 'analyte' | 'specimen'>, entries?: LabEntry[]): AnalyteMatch {
  const specimen = normalizeKey(q.specimen).replace(/ /g, '_') || null;
  const all = entries ?? loadLabEntries();
  const known = all.filter((e) => !isSetAside(e) && (!specimen || specimen === 'all' || e.specimen === specimen)).map((e) => ({ key: e.analyteKey, specimen: e.specimen }));
  return matchAnalyte(q.analyte ?? '', known, { specimen: specimen === 'all' ? null : specimen });
}

/** One test's values, its chart (null when nothing can be drawn) and whether its results are all words: one read. */
export function labSeriesView(q: ChartQuery, entries?: LabEntry[]): LabSeriesView {
  const all = entries ?? (q.analyte && q.analyte.trim() ? loadLabEntries() : []);
  const rows = seriesRows(all, q, false);
  return { rows, chart: chartFor(q, all, rows), wordOnly: isWordOnly(rows), match: matchLabAnalyte(q, all) };
}

/** "15–45 mg/dL (Anvale)": a range as printed, with its unit when the text has none, and its lab. */
function rangeWithLab(v: LabReadingView, withLab = true): string {
  const shown = v.rangeShown ?? '';
  // The values' unit only for a range read as numbers that prints no unit of its own ("0.15-0.45 g/L" is never relabelled).
  const unit = v.unit && !v.rangeUnit && v.rangeStatus === 'parsed' && v.rangeKind !== 'text' && !shown.toLowerCase().includes(v.unit.toLowerCase()) ? ` ${v.unit}` : '';
  return `${shown}${unit}${withLab && v.lab ? ` (${v.lab})` : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function chartFor(q: ChartQuery, all: LabEntry[], rows: LabSeriesRow[]): ChartSpec | null {
  const setAside = seriesRows(all, q, true).filter(isSetAside).length;
  const specimen = normalizeKey(q.specimen).replace(/ /g, '_') || null;
  const key = rows[0]?.analyteKey ?? normalizeAnalyte(q.analyte, specimen);
  const label = analyteLabel(key, mostCommon(rows.map((r) => r.analyte)) ?? q.analyte);
  const specimens = [...new Set(rows.map((r) => r.specimen))];
  const specimenLabel = specimen ? (SPECIMEN_LABELS[specimen] ?? specimen) : specimens.length === 1 ? (SPECIMEN_LABELS[specimens[0]] ?? specimens[0]) : null;

  // Only measurements are drawn: never a limit ("<3"), words, or a value printed as a range, whatever number is stored.
  // A value marked inaccurate (it contradicts a clinical record, or the patient's correction of one) is not a reading:
  // it stays in `rows` (the values listed) but is not plotted.
  const numeric = rows.filter((r) => r.date && hasNumber(r));
  const plottable = numeric.filter((r) => r.trust?.trust !== 'inaccurate');
  // Nothing to draw (results in words or limits, or numbers each marked inaccurate or undated): no chart, never an empty one.
  if (!plottable.length) return null;
  const inaccurate = numeric.length - plottable.length;
  const groups = chartUnitGroups(plottable, key);

  // One result in several documents is one point (amendment G5): the clinical record's own value is kept, its copies
  // named in its label.
  const ROLE_RANK: Record<ReadingRole, number> = { printed: 0, unclassified: 1, typed: 2, computed: 3, claimed: 4 };
  type Kept = { r: LabSeriesRow; y: number | null; converted: boolean; copies: number };
  let copies = 0;
  // A computed value is never a copy of the lab's printed one, nor the lab's of it: both are shown (D5).
  const isComputed = (r: LabSeriesRow) => r.reading.role === 'computed';
  const folded = groups.map((g) => {
    const kept: Kept[] = [];
    const ordered = [...g.rows].sort((a, b) => ROLE_RANK[a.r.reading.role] - ROLE_RANK[b.r.reading.role] || byDate(a.r, b.r));
    for (const x of ordered) {
      const same = isComputed(x.r) ? undefined : kept.find((k) => !isComputed(k.r) && sameResult(k.r, x.r));
      if (same) {
        same.copies++;
        copies++;
      } else kept.push({ ...x, copies: 0 });
    }
    kept.sort((a, b) => byDate(a.r, b.r));
    return { unit: g.unit, kept };
  });

  const notes: string[] = [];
  const series: ChartSeries[] = [];
  const point = (g: { unit: string | null }, k: Kept): ChartPoint => {
    const r = k.r;
    const v = r.reading;
    if (isComputed(r)) {
      // An open square, never red; its label says who computed it and from which pages; it links to its first input's page.
      const c = r.computed?.record;
      const first = c?.inputs[0]?.citation;
      const changed = r.computed?.changes.length ? ` · ${INPUT_CHANGED_WORDS}` : '';
      return {
        x: r.date!,
        y: k.y,
        label: `${v.valueShown}${r.unit ? ` ${r.unit}` : ''} · computed · ${c?.label ?? 'computed by you'}${changed}${c ? ` (${computedTitle(c.inputs).replace(/\n/g, '; ')})` : ''}`,
        flag: null,
        href: first ? `/documents/${first.documentId}?page=${first.page}` : null,
        marker: 'square',
      };
    }
    return {
      x: r.date!,
      y: k.y,
      label: `${v.valueShown}${r.unit ? ` ${r.unit}` : ''}${k.converted && g.unit && k.y != null ? ` (= ${fmtNum(Number(k.y.toPrecision(4)))} ${g.unit})` : ''}${pointFlagWords(v)}${k.copies ? ` and ${plural(k.copies, 'copy', 'copies')}` : ''}${r.documentTitle ? ` · ${r.documentTitle}` : ''}${r.pageNumber ? ` p.${r.pageNumber}` : ''}`,
      flag: pointFlag(v),
      href: r.href,
    };
  };
  let claimedApart = 0;
  let computedBeside = 0;
  // Unit series whose values all come from summaries or notes (drawn as the line, said in the note).
  const claimedOnly: Array<string | null> = [];
  for (const g of folded) {
    if (series.length >= 8) break;
    const name = folded.length > 1 ? `${label} (${g.unit ?? 'no unit printed'})` : label;
    const ownAll = g.kept.filter((k) => k.r.reading.role !== 'claimed');
    const claimed = g.kept.filter((k) => k.r.reading.role === 'claimed');
    // One line for the index (D5): the lab's printed value and the user's computed ones, joined in date order. On a day the
    // lab printed it too, the line goes through the lab's value and the computed one is drawn beside it.
    const printedDays = new Set(ownAll.filter((k) => !isComputed(k.r)).flatMap((k) => [...resultDays(k.r)]));
    const beside = ownAll.filter((k) => isComputed(k.r) && k.r.date && printedDays.has(k.r.date));
    const own = ownAll.filter((k) => !beside.includes(k));
    if (own.length) {
      series.push({ name, unit: g.unit, kind: 'line', points: own.map((k) => point(g, k)) });
      if (beside.length && series.length < 8) {
        series.push({ name: `${name}, computed beside the lab's`, unit: g.unit, kind: 'scatter', points: beside.map((k) => point(g, k)) });
        computedBeside += beside.length;
      }
      // A summary's or a note's values are drawn as separate points, never joined into the lab reports' line (rule 11).
      if (claimed.length && series.length < 8) {
        series.push({ name: `${name}, stated in summaries or notes`, unit: g.unit, kind: 'scatter', points: claimed.map((k) => point(g, k)) });
        claimedApart += claimed.length;
      }
    } else {
      series.push({ name, unit: g.unit, kind: 'line', points: claimed.map((k) => point(g, k)) });
      claimedOnly.push(g.unit);
    }
  }
  const units = [...new Set(series.map((s) => s.unit ?? ''))];

  // The normal-range band (rule 8): drawn only when every value in view that printed a range printed the same one
  // (bounds, signs, unit), in the unit of the first series; a value that printed none is not judged by it. Different
  // ranges: no band, each named with its lab, each point judged by its own. A summary's range is never a band.
  // A computed value is never judged by a band (it prints no range; D5): not in view here.
  const inView = folded.flatMap((g) => g.kept.map((k) => ({ k, unit: g.unit }))).filter((x) => x.k.r.reading.role !== 'claimed' && x.k.r.reading.role !== 'computed');
  const sigs = new Map<string, LabReadingView[]>();
  for (const x of inView) {
    const s = rangeSignature(x.k.r.reading);
    if (!s || x.k.r.reading.rangeKind === 'text') continue;
    const list = sigs.get(s) ?? [];
    list.push(x.k.r.reading);
    sigs.set(s, list);
  }
  let referenceBand: ChartSpec['referenceBand'] = null;
  if (sigs.size === 1) {
    const list = [...sigs.values()][0];
    const v = list[list.length - 1];
    const firstUnitKey = unitKey(series[0]?.unit ?? null) ?? '';
    // The values under the band (its axis) that printed no range of their own: not judged by it.
    const unjudged = inView.filter((x) => (unitKey(x.unit) ?? '') === firstUnitKey && (!rangeSignature(x.k.r.reading) || x.k.r.reading.rangeKind === 'text')).length;
    if ((v.rangeUnitKey ?? '') === firstUnitKey || folded.length === 1) {
      referenceBand = { low: v.rangeLow, high: v.rangeHigh, label: `ref ${rangeWithLab({ ...v, rangeShown: mostCommon(list.map((x) => x.rangeShown)) ?? v.rangeShown }, false)}` };
      if (unjudged) notes.push(`${plural(unjudged, 'value')} printed no range of ${unjudged === 1 ? 'its' : 'their'} own; ${unjudged === 1 ? 'it is' : 'they are'} not judged by the band`);
    } else {
      notes.push(`the range ${rangeWithLab(v)} is printed with values in another unit, so no band is drawn`);
    }
  } else if (sigs.size > 1) {
    const named = [...sigs.values()].map((list) => rangeWithLab(list[list.length - 1]));
    notes.push(`The labs print different normal ranges (${[...new Set(named)].join(', ')}), so no band is drawn. Each red point is outside the range printed with it`);
  }
  if (claimedOnly.length && claimedOnly.length === series.filter((x) => x.kind !== 'scatter').length) notes.push('Every value in this chart comes from summaries or notes, not from a lab report');
  else for (const u of claimedOnly) notes.push(`the values ${u ? `in ${u}` : 'with no unit printed'} come from summaries or notes, not from a lab report`);
  if (claimedApart) notes.push(`${plural(claimedApart, 'value')} stated in summaries or notes ${claimedApart === 1 ? 'is' : 'are'} drawn apart, not joined to the lab values`);
  if (copies) notes.push(`${plural(copies, 'copy', 'copies')} of a value in other documents drawn as one point`);
  // Computed values (open squares): never red, never judged by a range; the user's own range is dashed (D5, D6).
  const computedDrawn = plottable.filter(isComputed);
  if (computedDrawn.length) {
    notes.push(`${plural(computedDrawn.length, 'value')} computed by you ${computedDrawn.length === 1 ? 'is an open square' : 'are open squares'}, never judged by a range`);
    if (computedBeside) notes.push(`${plural(computedBeside, 'computed value')} drawn beside the lab's printed value of the same day`);
    const changed = computedDrawn.filter((r) => r.computed?.changes.length).length;
    if (changed) notes.push(`${plural(changed, 'computed value')}: ${INPUT_CHANGED_WORDS}`);
  }
  const typed = computedDrawn.length || rows.some(isComputed) ? typedRangeFor(key) : null;

  const dated = rows.filter((r) => r.date);
  const first = dated[0]?.date ?? null;
  const last = dated.length ? dated[dated.length - 1].date : null;
  // Values with no measurement to draw, said in plain words: a limit ("<2", ">1000") is not a measurement, whatever
  // number is stored with it, and is not a result in words; each is named as what it is.
  const listed = (list: LabSeriesRow[]) => [...new Set(list.map((r) => r.reading.valueShown).filter(Boolean))].slice(0, 3).join(', ');
  const limits = dated.filter((r) => r.reading.kind === 'censored');
  const asRange = dated.filter((r) => r.reading.kind === 'range');
  const words = dated.filter((r) => r.reading.kind === 'text');
  if (limits.length) notes.push(`${plural(limits.length, 'limit')} not drawn (${listed(limits)}: a limit, not a measurement)`);
  if (asRange.length) notes.push(`${plural(asRange.length, 'value')} printed as a range not drawn (${listed(asRange)})`);
  if (words.length) notes.push(`${plural(words.length, 'result')} in words not drawn (${listed(words)})`);
  const undated = rows.filter((r) => !r.date).length;
  if (undated) notes.push(`${undated} undated result${undated === 1 ? '' : 's'} not plotted`);
  // The note is read by the patient on his own Labs page (and by the clinician through chart_lab_series): plain
  // words, never "the patient". By the automatic check, not the review status: a lab report's own value is verified
  // without anyone confirming it.
  if (inaccurate) notes.push(`${inaccurate} value${inaccurate === 1 ? '' : 's'} marked inaccurate not plotted`);
  for (const g of folded) {
    if (!g.unit) continue;
    const from = new Map<string, number>();
    for (const k of g.kept) if (k.converted) from.set(k.r.unit ?? '', (from.get(k.r.unit ?? '') ?? 0) + 1);
    for (const [u, n] of from) notes.push(`${n} value${n === 1 ? '' : 's'} in ${u} converted to ${g.unit}${unitCanon(u) === 'mmhg' ? ` (1 mmHg = ${Number((MMHG_IN_MMH2O / 10).toPrecision(6))} cmH2O)` : ''}`);
  }
  // Clinical records that disagree with each other are records, not values with nothing behind them: said as such.
  const disagree = plottable.filter((r) => r.trust?.trust === 'conflict' && RECORDS_DISAGREE_RE.test((r.trust.reason ?? '').trim()));
  if (disagree.length) {
    const tiers = documentTiers(disagree.map((r) => r.documentId));
    const fromRecords = disagree.every((r) => r.documentId && tiers.get(r.documentId) === 'primary');
    notes.push(`${disagree.length} ${fromRecords ? 'from clinical records that disagree' : 'where clinical records disagree'}`);
  }
  // Not compared (a record that day gives it in another unit that does not convert or in other words, or the value
  // gives only the month): neither backed nor contradicted; each value's reason says why.
  // Values that also disagree with each other (they need a source on the Reconciliation page) were not compared with
  // the record either: the record gives the value in another unit or in other words.
  const notCompared = plottable.filter(
    (r) =>
      !r.trust?.byUser &&
      ((r.trust?.trust === 'unbacked' && NOT_COMPARED_RE.test((r.trust.reason ?? '').trim())) || (r.trust?.trust === 'conflict' && VALUES_DISAGREE_RE.test((r.trust.reason ?? '').trim()))),
  );
  if (notCompared.length) notes.push(`${notCompared.length} not compared with a clinical record`);
  const unbacked = plottable.filter((r) => (r.trust?.trust === 'unbacked' || r.trust?.trust === 'conflict') && !disagree.includes(r) && !notCompared.includes(r)).length;
  if (unbacked) notes.push(`${unbacked} not backed by a clinical record yet`);
  if (setAside) notes.push(`${setAside} disputed, superseded or deleted result${setAside === 1 ? '' : 's'} left out`);

  let bands: ChartBand[] | null = null;
  let markers: ChartMarker[] | null = null;
  if (q.overlayMedications) {
    const xs = plottable.map((r) => chartX(r.date!, 'date'));
    const from = cleanPartial(q.from, 'from');
    const to = cleanPartial(q.to, 'to');
    const lo = from ? chartX(from, 'date') : xs.length ? Math.min(...xs) : Number.NEGATIVE_INFINITY;
    const hi = to ? chartX(to, 'date') + 366 * 86400000 : xs.length ? Math.max(...xs) : Number.POSITIVE_INFINITY;
    const { courses, events } = medicationOverlay();
    bands = [];
    markers = [];
    for (const c of courses) {
      // A course known only by its stop starts at the chart's left edge (start not known), and only while that stop
      // is on the chart.
      const stopX = c.stop ? chartX(c.stop, 'date') : Number.NaN;
      const edge = !c.start && Number.isFinite(lo) && Number.isFinite(stopX) && stopX >= lo && stopX <= hi ? new Date(lo).toISOString().slice(0, 10) : null;
      const begin = c.start ?? edge;
      if (!begin) continue;
      const s = chartX(begin, 'date');
      // medicationCourse gives no stop only to a course that goes on.
      const e = c.stop ? stopX : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(s)) continue;
      if (e < lo || s > hi) continue;
      bands.push({ from: begin, to: c.stop, label: c.name, tone: 'info', lane: c.lane, startKnown: c.start ? c.startKnown : false, ongoing: c.ongoing, ...(edge ? { clippedStart: true } : {}) });
      if (bands.length >= 8) break;
    }
    for (const ev of events) {
      const x = chartX(ev.date, 'date');
      if (!Number.isFinite(x) || x < lo || x > hi) continue;
      markers.push({ x: ev.date, label: `${ev.name}: ${ev.kind.replace(/_/g, ' ')}`, tone: ev.kind === 'reaction' ? 'bad' : 'ash' });
      if (markers.length >= 12) break;
    }
    if (bands.length) notes.push('Medications are the rows under the chart');
    if (!bands.length && !markers.length) notes.push('no medication courses overlap this range');
  }

  const spec: ChartSpec = {
    type: 'line',
    title: q.title?.trim() || `${label}${specimenLabel ? ` — ${specimenLabel}` : ''}`,
    subtitle: `${rows.length} result${rows.length === 1 ? '' : 's'}${first ? ` · ${yearOf(first)}${last && yearOf(last) !== yearOf(first) ? `–${yearOf(last)}` : ''}` : ''}`,
    xType: 'date',
    // The axis is labelled with the unit of its values: one unit when every series has the same, else none (rule 5).
    yLabel: units.length === 1 && units[0] ? units[0] : null,
    series,
    referenceBand,
    ...(typed ? { typedRange: { low: typed.low, high: typed.high, label: typedRangeLabel(typed) } } : {}),
    yDomain: 'auto',
    bands: bands?.length ? bands : null,
    markers: markers?.length ? markers : null,
    source: 'db',
    note: notes.length ? notes.join(' · ') : null,
  };
  return chartSpec.parse(spec);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const optText = (max = 4000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null));
const optNum = z.number().nullish();
const optFlag = z.preprocess((v) => (v === '' ? null : typeof v === 'string' ? v.toUpperCase() : v), z.enum(LAB_FLAGS).nullish());
const optSpecimen = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(SPECIMENS).optional());
/** A flag exactly as printed: '' = none printed, '-' a dash, "HH", "*"...; null = not recorded. Only the outer spaces go. */
const optFlagRaw = z
  .string()
  .max(20)
  .nullish()
  .transform((v) => (v == null ? v : v.trim()));

export const citationInput = z.object({ documentId: z.string().min(1), pageNumber: z.number().int().min(1), quote: z.string().min(1).max(2000) });

const labFields = {
  analyte: z.string().trim().min(1, 'analyte is required').max(200),
  /** The value as written ("62", "<5", "positive", "1:160"). */
  value: optText(200),
  /** Accepted for older callers; stored only when no value text is given (the printed text decides: "<3" never stores 3). */
  valueNum: optNum,
  unit: optText(60),
  refLow: optNum,
  refHigh: optNum,
  /** The range as printed ("15-45", "<50", "Negative"); read into low/high when no numbers are given. */
  refText: optText(120),
  flag: optFlag,
  /** The flag as printed ('' none printed, '-', "HH", "*"); wins over `flag`. */
  flagRaw: optFlagRaw,
  specimen: optSpecimen,
  collectedAt: optText(32),
  collectedAtText: optText(200),
  /** When the result came back (Resulted, Reported); never the reading's date when a collected date is given. */
  resultedAt: optText(32),
  resultedAtText: optText(200),
  labName: optText(300),
  institutionId: optText(64),
  documentId: optText(64),
  factId: optText(64),
  notes: optText(4000),
};

export const labInput = z.object({
  ...labFields,
  /** When given, a confirmed manual lab_result fact with this citation is created and linked, so the row has page-level provenance. */
  citation: citationInput.nullish(),
  /** Statement for that fact; composed from the values when omitted. */
  statement: optText(2000),
});
export const labPatch = z.object(labFields).partial();
export type LabInput = z.input<typeof labInput>;
export type LabPatch = z.input<typeof labPatch>;

/**
 * A value as typed: the text kept as written, its number only when the text reads as a plain number (the text decides:
 * "<3" never stores 3, "Negative" never 0; rule 2); a number sent alone, with no text, is kept as a number.
 */
function resolveValue(value: string | null | undefined, valueNum: number | null | undefined, current?: { valueNum: number | null; valueText: string | null }): { valueNum: number | null; valueText: string | null } {
  const text = value === undefined ? (current?.valueText ?? null) : value;
  if (text != null && text.trim()) {
    const v = parseLabValue(text);
    return { valueText: text, valueNum: v.kind === 'number' ? v.number : null };
  }
  const n = valueNum === undefined ? (value === undefined ? (current?.valueNum ?? null) : null) : valueNum;
  return { valueNum: n, valueText: text };
}

/**
 * A range as typed: the text as written, its bounds read from it (for "<50": no low, high 50; rule 3) unless numbers
 * are given. Numbers alone stay numbers (their sign is not on record).
 */
function resolveRange(text: string | null | undefined, low: number | null | undefined, high: number | null | undefined): { refText: string | null; refLow: number | null; refHigh: number | null } {
  const t = text ?? null;
  const read = t ? parseRefRange(t) : null;
  const ok = read && read.status === 'parsed' && read.kind !== 'text';
  return {
    refText: t,
    refLow: low !== undefined ? (low ?? null) : ok ? read.low : null,
    refHigh: high !== undefined ? (high ?? null) : ok ? read.high : null,
  };
}

/** A flag as typed: the printed text when given ('' none printed), its meaning (H, L, N, A, C) in `flag`; else the letter. */
function resolveFlag(flag: string | null | undefined, flagRaw: string | null | undefined): { flag: string | null; flagRaw: string | null } {
  if (flagRaw !== undefined && flagRaw !== null) return { flag: parseFlag(flagRaw).printed, flagRaw };
  if (flagRaw === null && flag === undefined) return { flag: null, flagRaw: null };
  return { flag: flag ?? null, flagRaw: flag ?? null };
}

function resolveDate(iso: string | null | undefined, text: string | null | undefined, current?: LabRow): Pick<LabInsert, 'collectedAt' | 'collectedAtPrecision' | 'collectedAtText'> {
  if (iso) {
    const p = parsePartialDate(iso);
    return { collectedAt: p.iso, collectedAtPrecision: p.precision, collectedAtText: text ?? current?.collectedAtText ?? iso };
  }
  if (text !== undefined) {
    const p = parsePartialDate(text);
    return { collectedAt: p.iso, collectedAtPrecision: p.precision, collectedAtText: p.text };
  }
  if (iso === null) return { collectedAt: null, collectedAtPrecision: 'unknown', collectedAtText: current?.collectedAtText ?? null };
  return { collectedAt: current?.collectedAt ?? null, collectedAtPrecision: current?.collectedAtPrecision ?? 'unknown', collectedAtText: current?.collectedAtText ?? null };
}

/** The date a result came back (rule 7: kept apart from the collected date, never put in its place). */
function resolveResulted(iso: string | null | undefined, text: string | null | undefined, current?: LabRow): Pick<LabInsert, 'resultedAt' | 'resultedAtPrecision' | 'resultedAtText'> {
  if (iso) {
    const p = parsePartialDate(iso);
    return { resultedAt: p.iso, resultedAtPrecision: p.precision, resultedAtText: text ?? current?.resultedAtText ?? iso };
  }
  if (text !== undefined && text !== null) {
    const p = parsePartialDate(text);
    return { resultedAt: p.iso, resultedAtPrecision: p.precision, resultedAtText: p.text };
  }
  if (iso === null || text === null) return { resultedAt: null, resultedAtPrecision: null, resultedAtText: null };
  return { resultedAt: current?.resultedAt ?? null, resultedAtPrecision: current?.resultedAtPrecision ?? null, resultedAtText: current?.resultedAtText ?? null };
}

function assertDocument(documentId: string | null | undefined): void {
  if (!documentId) return;
  const d = db().select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get();
  if (!d) throw badRequest('documentId does not refer to an existing document');
}

function assertFactFree(factId: string | null | undefined, exceptRowId?: string): void {
  if (!factId) return;
  const f = db().select({ id: schema.facts.id, type: schema.facts.type }).from(schema.facts).where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt))).get();
  if (!f) throw badRequest('factId does not refer to an existing fact');
  if (f.type !== 'lab_result') throw badRequest('factId must point at a lab_result fact');
  const taken = db().select({ id: schema.labResults.id }).from(schema.labResults).where(and(eq(schema.labResults.factId, factId), isNull(schema.labResults.deletedAt))).get();
  if (taken && taken.id !== exceptRowId) throw conflict('that fact is already linked to a lab result');
}

/**
 * A fact statement for a value entered by hand. `flag` is the flag printed with the value, never one worked out from
 * the range (rule 4: a derived flag is never written as "normal" or "high"); a bare "C" is said as the report's letter.
 */
export function labStatement(e: { analyte: string; valueNum: number | null; valueText: string | null; unit: string | null; refLow: number | null; refHigh: number | null; refText: string | null; flag: string | null; specimen: string; date: string | null; datePrecision?: string | null }): string {
  const FLAG_WORD: Record<string, string> = { H: 'high', L: 'low', N: 'normal', A: 'abnormal', C: 'flagged C' };
  const parts = [`${e.analyte} ${formatValue(e)}${e.unit ? ` ${e.unit}` : ''}`.trim()];
  const ref = formatRef(e);
  if (ref) parts[0] += ` (reference ${ref})`;
  if (e.flag && FLAG_WORD[e.flag]) parts.push(FLAG_WORD[e.flag]);
  parts.push(`specimen ${SPECIMEN_LABELS[e.specimen] ?? e.specimen}`);
  if (e.date) parts.push(`collected ${formatPartialDate(e.date, (e.datePrecision as 'day' | 'month' | 'year' | 'unknown' | undefined) ?? undefined)}`);
  return `${parts.join(', ')}.`;
}

/** The provenance prefix a CSV import writes into notes (services/import-csv.ts). */
const IMPORT_PREFIX = /^imported from [^;]*/;

/**
 * Notes on an imported row keep their 'imported from <file>' prefix: an edit
 * may change the rest, never the record of where the value came from.
 */
export function keepImportProvenance(before: string | null | undefined, next: string | null): string | null {
  const prefix = (before ?? '').match(IMPORT_PREFIX)?.[0];
  if (!prefix) return next;
  const rest = (next ?? '').replace(IMPORT_PREFIX, '').replace(/^;\s*/, '').trim();
  return rest ? `${prefix}; ${rest}` : prefix;
}

type LabIndexFields = Pick<LabRow, 'id' | 'analyte' | 'valueNum' | 'valueText' | 'unit' | 'specimen' | 'labName' | 'flag' | 'collectedAt' | 'notes'>;

function indexLab(row: LabIndexFields): void {
  indexEntity('lab', row.id, `${row.analyte} ${formatValue(row)}${row.unit ? ` ${row.unit}` : ''}`.trim(), [SPECIMEN_LABELS[row.specimen] ?? row.specimen, row.labName, row.flag, row.collectedAt, row.notes].filter(Boolean).join(' · '));
}

function rowById(id: string): LabRow | null {
  return db().select().from(schema.labResults).where(and(eq(schema.labResults.id, id), isNull(schema.labResults.deletedAt))).get() ?? null;
}

/** The fact a row is linked to, as the reading needs it (its printed text is the row's provenance); null when none or deleted. */
function linkedFact(factId: string | null | undefined): (FactLite & { attributesJson: string; date: string | null }) | null {
  if (!factId) return null;
  const f = db().select().from(schema.facts).where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt))).get();
  return f ?? null;
}

/**
 * The stored reading of a row as it now stands (migration 0004's columns), for the writers: parsed from the row's
 * current text, its printed text as provenance. Raw columns already filled are never overwritten (write-once), except on
 * a row typed by hand, whose "as written" is the user's own entry. `userFields`: the fields the user changed in this
 * save, merged into parse_json.userFields (never dropped).
 */
function storedReading(row: LabRow, opts: { rawSource: string; parsedFrom: 'raw' | 'user'; rawFrom: { factId?: string | null; citationId?: string | null } | null; userFields?: LabUserField[]; overwriteRaw?: boolean }): Partial<LabInsert> {
  const fact = rowRawSource(row) === 'fact' ? linkedFact(row.factId) : null;
  // The fact's first citation, as the Labs page reads the row (a page that prints "<3" for a value read as "3" is
  // followed there): the stored reading is the one the page shows (2026-10 review).
  const cite = fact ? firstCitations([fact.id]).get(fact.id) : undefined;
  const documentId = row.documentId ?? cite?.documentId ?? null;
  const samePage = Boolean(cite && cite.documentId === documentId);
  const meta = documentId ? labDocumentMeta([documentId]).get(documentId) : undefined;
  const editedFrom = fact ? labRowEditedFrom(row, fact) : null;
  const reading = readingForRow(row, { fact, editedFrom, cite: samePage ? cite! : null, documentTier: meta?.tier ?? null, documentDate: meta?.date ?? null, hasDocument: Boolean(documentId) });
  const dateKind = row.dateKind === 'collected' || row.dateKind === 'unknown' ? row.dateKind : row.collectedAt || row.collectedAtText ? 'unknown' : null;
  const p = projectReading(reading, { rawSource: opts.rawSource, parsedFrom: opts.parsedFrom, rawFrom: opts.rawFrom, dateKind, previous: row.parseJson });
  const keep = <T>(cur: T | null, next: T | null | undefined): T | null => (opts.overwriteRaw ? (next ?? null) : (cur ?? next ?? null));
  return {
    ...p,
    valueRaw: keep(row.valueRaw, p.valueRaw),
    unitRaw: keep(row.unitRaw, p.unitRaw),
    refRaw: keep(row.refRaw, p.refRaw),
    flagRaw: keep(row.flagRaw, p.flagRaw),
    rawSource: row.rawSource ?? opts.rawSource,
    parseJson: opts.userFields ? withUserFields(p.parseJson, opts.userFields) : p.parseJson,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A value entered by hand (the Labs form, or the API): kept as typed (raw_source 'typed', date_kind 'collected': the
 * form asks when the sample was collected), its reading stored beside it (migration 0004). With a citation, a
 * confirmed manual fact gives it page-level provenance; its statement says only the flag as entered, never one worked
 * out from the range.
 */
export function createLab(raw: unknown): LabEntry {
  const input = parseOrThrow(labInput, raw);
  const specimen = input.specimen ?? 'serum';
  const { valueNum, valueText } = resolveValue(input.value, input.valueNum);
  const date = resolveDate(input.collectedAt, input.collectedAtText);
  const resulted = resolveResulted(input.resultedAt, input.resultedAtText);
  const { refText, refLow, refHigh } = resolveRange(input.refText, input.refLow, input.refHigh);
  const { flag, flagRaw } = resolveFlag(input.flag, input.flagRaw);
  assertDocument(input.documentId);
  let factId = input.factId ?? null;
  let documentId = input.documentId ?? null;
  if (input.citation) {
    if (factId) throw badRequest('give either factId or citation, not both');
    const statement =
      input.statement ?? labStatement({ analyte: input.analyte, valueNum, valueText, unit: input.unit ?? null, refLow, refHigh, refText, flag, specimen, date: date.collectedAt ?? null, datePrecision: date.collectedAtPrecision });
    const fact = createManualFact({
      type: 'lab_result',
      statement,
      dateText: date.collectedAtText ?? date.collectedAt ?? resulted.resultedAtText ?? resulted.resultedAt ?? null,
      attributes: {
        analyte: input.analyte,
        value: valueText ?? (valueNum != null ? fmtNum(valueNum) : ''),
        value_num: valueNum,
        unit: input.unit ?? null,
        ref_low: refLow,
        ref_high: refHigh,
        ref_text: refText,
        flag,
        ...(flagRaw !== null ? { flag_raw: flagRaw } : {}),
        specimen,
        lab_name: input.labName ?? null,
        ...(date.collectedAtText || date.collectedAt ? { collected_date: date.collectedAtText ?? date.collectedAt } : {}),
        ...(resulted.resultedAtText || resulted.resultedAt ? { resulted_date: resulted.resultedAtText ?? resulted.resultedAt } : {}),
      },
      citation: input.citation,
      note: LAB_FORM_NOTE,
    });
    factId = fact.id;
    documentId = documentId ?? input.citation.documentId;
  } else {
    assertFactFree(factId);
  }
  const now = nowIso();
  const row: LabInsert = {
    id: newId(),
    analyte: input.analyte,
    analyteKey: normalizeAnalyte(input.analyte, specimen),
    valueNum,
    valueText,
    unit: input.unit ?? null,
    refLow,
    refHigh,
    refText,
    flag,
    flagRaw,
    specimen,
    ...date,
    ...resulted,
    dateKind: date.collectedAt || date.collectedAtText ? 'collected' : null,
    rawSource: 'typed',
    labName: input.labName ?? null,
    institutionId: input.institutionId ?? null,
    documentId,
    factId,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const d = db();
  d.transaction(() => {
    d.insert(schema.labResults).values(row).run();
    const stored = rowById(row.id)!;
    d.update(schema.labResults)
      .set(storedReading(stored, { rawSource: 'typed', parsedFrom: 'user', rawFrom: null }))
      .where(eq(schema.labResults.id, row.id))
      .run();
  });
  indexLab(rowById(row.id)!);
  return getLab(row.id);
}

/** Fields of a patch that change what the row says (recorded in parse_json.userFields, amendment B2). */
function changedFields(current: LabRow, set: Partial<LabInsert>): LabUserField[] {
  const out: LabUserField[] = [];
  const differs = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);
  if ('valueText' in set || 'valueNum' in set) if (differs(set.valueText, current.valueText) || differs(set.valueNum, current.valueNum)) out.push('value');
  if ('unit' in set && differs(set.unit, current.unit)) out.push('unit');
  if (('refText' in set && differs(set.refText, current.refText)) || ('refLow' in set && differs(set.refLow, current.refLow)) || ('refHigh' in set && differs(set.refHigh, current.refHigh))) out.push('range');
  if (('flag' in set && differs(set.flag, current.flag)) || ('flagRaw' in set && differs(set.flagRaw, current.flagRaw))) out.push('flag');
  if (('collectedAt' in set && differs(set.collectedAt, current.collectedAt)) || ('collectedAtText' in set && differs(set.collectedAtText, current.collectedAtText))) out.push('date');
  if (('resultedAt' in set && differs(set.resultedAt, current.resultedAt)) || ('resultedAtText' in set && differs(set.resultedAtText, current.resultedAtText))) out.push('resulted');
  if ('labName' in set && differs(set.labName, current.labName)) out.push('lab');
  if ('specimen' in set && differs(set.specimen, current.specimen)) out.push('specimen');
  if ('analyte' in set && differs(set.analyte, current.analyte)) out.push('analyte');
  if ('notes' in set && differs(set.notes, current.notes)) out.push('notes');
  return out;
}

/**
 * The user's edit of a row: the user's words go to the row's columns (what is shown); the fields they changed are
 * recorded (parse_json.userFields, merged); the stored reading is recomputed from the user's words (parsedFrom 'user');
 * the printed text in the raw columns is never overwritten (a row typed by hand aside: its "as written" is the user's
 * own entry). updated_at moves (it is the user's edit).
 */
export function updateLab(partOrId: string, raw: unknown): LabEntry {
  // A part of a line of several tests edits the row it was read from.
  const id = originalLabId(partOrId);
  if (id.startsWith('fact:')) throw conflict('this result comes straight from an extracted fact; import it (from facts) before editing');
  const current = rowById(id);
  if (!current) throw notFound('lab result not found');
  // A computed value is never changed by hand or recomputed silently (D7): delete it and compute it again.
  if (current.rawSource === COMPUTED_SOURCE) throw conflict('A computed value is not edited. Delete it and compute it again from its inputs.');
  const patch = parseOrThrow(labPatch, raw);
  const typed = rowRawSource(current) === 'typed';
  // A saved row is never "never saved" (labRowEditedFrom reads updatedAt === createdAt that way): move past createdAt.
  let savedAt = nowIso();
  if (savedAt === current.createdAt) savedAt = new Date(Date.parse(savedAt) + 1).toISOString();
  const set: Partial<LabInsert> = { updatedAt: savedAt };
  if (patch.analyte !== undefined) set.analyte = patch.analyte;
  if (patch.specimen !== undefined) set.specimen = patch.specimen;
  if (patch.analyte !== undefined || patch.specimen !== undefined) set.analyteKey = normalizeAnalyte(set.analyte ?? current.analyte, set.specimen ?? current.specimen);
  if (patch.value !== undefined || patch.valueNum !== undefined) Object.assign(set, resolveValue(patch.value, patch.valueNum, current));
  if (patch.unit !== undefined) set.unit = patch.unit;
  if (patch.refText !== undefined || patch.refLow !== undefined || patch.refHigh !== undefined) {
    const r = resolveRange(patch.refText !== undefined ? patch.refText : current.refText, patch.refLow, patch.refHigh);
    if (patch.refText !== undefined) set.refText = r.refText;
    // New range text with no numbers: its bounds are read from it (rule 3); numbers sent are kept as sent.
    if (patch.refLow !== undefined || patch.refText !== undefined) set.refLow = patch.refLow !== undefined ? patch.refLow : r.refLow;
    if (patch.refHigh !== undefined || patch.refText !== undefined) set.refHigh = patch.refHigh !== undefined ? patch.refHigh : r.refHigh;
  }
  const prior = readParseJson(current.parseJson);
  const priorFields = Array.isArray(prior?.userFields) ? prior!.userFields : null;
  // A row saved by hand before the record of changed fields existed (2026-10): any of its unit, range and flag may be the
  // user's (cleared, or changed). Its first save now records them, so the printed text never fills them afterwards (the
  // value's own protection is labRowEditedFrom).
  const legacySaved = !typed && !priorFields && current.createdAt !== current.updatedAt;
  /** The flag text the user chose on a row from a document, when it changes what the row shows ('' none printed, "HH"). */
  let userFlag: { text: string | null } | null = null;
  if (patch.flagRaw !== undefined || patch.flag !== undefined) {
    const f = resolveFlag(patch.flag, patch.flagRaw);
    set.flag = f.flag;
    // A row typed by hand keeps the flag as the user entered it ('' none printed, "HH"); a row from a document keeps its
    // printed flag as provenance (flag_raw) and the user's own text in parse_json.userFlag (with userFields 'flag').
    if (typed) set.flagRaw = f.flagRaw;
    else {
      const flagWasEdited = priorFields ? priorFields.includes('flag') : legacySaved;
      const shownBefore = flagWasEdited ? (prior && Object.prototype.hasOwnProperty.call(prior, 'userFlag') ? (prior.userFlag ?? null) : current.flag) : (current.flagRaw ?? current.flag);
      const next = f.flagRaw ?? null;
      if (next !== (shownBefore ?? null)) userFlag = { text: next };
    }
  }
  if (patch.collectedAt !== undefined || patch.collectedAtText !== undefined) {
    Object.assign(set, resolveDate(patch.collectedAt, patch.collectedAtText, current));
    // The user says when the sample was collected (the form asks "Collected on").
    set.dateKind = set.collectedAt || set.collectedAtText ? 'collected' : null;
  }
  if (patch.resultedAt !== undefined || patch.resultedAtText !== undefined) Object.assign(set, resolveResulted(patch.resultedAt, patch.resultedAtText, current));
  if (patch.labName !== undefined) set.labName = patch.labName;
  if (patch.institutionId !== undefined) set.institutionId = patch.institutionId;
  if (patch.documentId !== undefined) {
    assertDocument(patch.documentId);
    set.documentId = patch.documentId;
  }
  if (patch.factId !== undefined) {
    assertFactFree(patch.factId, id);
    set.factId = patch.factId;
  }
  if (patch.notes !== undefined) set.notes = keepImportProvenance(current.notes, patch.notes);
  // A row typed by hand has no printed text: what the user enters now is its "as entered" text (its raw columns follow).
  if (typed) {
    if ('valueText' in set) set.valueRaw = set.valueText ?? null;
    if ('unit' in set) set.unitRaw = set.unit ?? null;
    if ('refText' in set) set.refRaw = set.refText ?? null;
  }
  // A row typed by hand: a changed flag is its new "as entered" text, not a change over a printed one.
  const fields: LabUserField[] = [
    ...(legacySaved ? (['unit', 'range', 'flag'] as LabUserField[]) : []),
    ...changedFields(current, set).filter((f) => !(typed && f === 'flag')),
    ...(userFlag ? (['flag'] as LabUserField[]) : []),
  ];
  // The fields changed (and the flag chosen) are recorded before the row is read again, so the stored reading is the one
  // the Labs page shows from now on (merged with the fields recorded before, never dropped). Every save writes the
  // record, even an empty one: a saved row with no record reads as "any field may be the user's" (rows saved before it
  // existed), which a row saved now must never become.
  const merged = readParseJson(withUserFields(current.parseJson, fields)) ?? {};
  if (userFlag) merged.userFlag = userFlag.text;
  set.parseJson = JSON.stringify(merged);
  const d = db();
  d.transaction(() => {
    d.update(schema.labResults).set(set).where(eq(schema.labResults.id, id)).run();
    const stored = rowById(id)!;
    d.update(schema.labResults)
      .set(storedReading(stored, { rawSource: rowRawSource(current), parsedFrom: 'user', rawFrom: prior?.rawFrom ?? null, overwriteRaw: typed }))
      .where(eq(schema.labResults.id, id))
      .run();
  });
  indexLab(rowById(id)!);
  return getLab(id);
}

/** Soft delete. The linked fact (if any) is untouched and reappears as an unimported entry. */
export function deleteLab(partOrId: string): void {
  // A part of a line of several tests: the row it was read from (the whole line) is set aside.
  const id = originalLabId(partOrId);
  if (id.startsWith('fact:')) throw conflict('extracted results are deleted from the Facts ledger, not here');
  const current = rowById(id);
  if (!current) throw notFound('lab result not found');
  const now = nowIso();
  db().update(schema.labResults).set({ deletedAt: now, updatedAt: now }).where(eq(schema.labResults.id, id)).run();
  removeEntityIndex('lab', id);
}

export const fromFactsInput = z.object({ factIds: z.array(z.string().min(1)).max(5000).optional() });

/** A PartialDate as the three stored columns. */
function dateColumns(p: PartialDate | null): { at: string | null; precision: string | null; text: string | null } {
  return p ? { at: p.iso, precision: p.precision, text: p.text } : { at: null, precision: null, text: null };
}

/**
 * Turn unimported lab_result facts into rows (idempotent through `factId`).
 * Disputed and superseded facts are skipped; the row keeps every value the
 * fact carried and the fact stays the evidence.
 *
 * Each row is written from the value's reading (2026-10): value_text the value as shown, value_num its measurement only
 * ("<3" stores none, never the model's 3), the range as printed with its bounds read from it, the flag printed with it
 * (never one worked out), the collected date (or a date of unknown kind) in collected_at and the resulted date in
 * resulted_at, kept apart (rule 7: a resulted-only value has no collected date). The printed text, as the model first
 * read it, goes to the raw columns; raw_source 'fact', parse_json.rawFrom the fact and its citation.
 */
export function importFromFacts(raw: unknown = {}): { created: number; skipped: number; items: LabEntry[] } {
  const input = parseOrThrow(fromFactsInput, raw ?? {});
  const wanted = input.factIds ? new Set(input.factIds) : null;
  // A line of several tests is read as its parts: one row per test, each linked to the same fact and document.
  const candidates = loadLabEntries().filter((e) => e.source === 'fact' && e.factId && (!wanted || wanted.has(e.factId)));
  // The unit as each fact writes it (the row is a faithful copy of its detail; labRowEditedFrom compares the two).
  const factUnits = new Map<string, string | null>();
  const ids = [...new Set(candidates.map((e) => e.factId!))];
  for (let i = 0; i < ids.length; i += 400) {
    for (const f of db().select({ id: schema.facts.id, attributesJson: schema.facts.attributesJson }).from(schema.facts).where(inArray(schema.facts.id, ids.slice(i, i + 400))).all()) {
      factUnits.set(f.id, str(parseJson<LabAttrs>(f.attributesJson, {}).unit));
    }
  }
  const d = db();
  const now = nowIso();
  const createdIds: string[] = [];
  let skipped = wanted ? wanted.size - new Set(candidates.map((e) => e.factId)).size : 0;
  const disputed = new Set<string>();
  const rows: Array<LabInsert & LabIndexFields> = [];
  for (const e of candidates) {
    if (e.factStatus === 'disputed') {
      if (!disputed.has(e.factId!)) skipped++;
      disputed.add(e.factId!);
      continue;
    }
    // The entry's own reading (loadLabEntries keeps it); a copy made elsewhere is read again from its own text.
    const reading = fullReadingOf(e) ?? partLabReading({ valueText: e.valueText, valueNum: e.valueNum, unit: e.unit }, { reading: e.reading, date: entryDate(e) });
    const v = e.reading;
    // The collected date, else a date of unknown kind; a resulted-only value has none (amendment E2).
    const collected = v.collected ?? (v.dateKind === 'unknown' ? entryDate(e) : null);
    const c = dateColumns(collected);
    const r = dateColumns(v.resulted);
    const dateKind: 'collected' | 'unknown' | null = collected ? (v.dateKind === 'collected' ? 'collected' : 'unknown') : null;
    const range = reading.range;
    const bounds = range.status === 'parsed' || range.fromNumbersOnly;
    const projection = projectReading(reading, {
      rawSource: 'fact',
      parsedFrom: reading.valueFrom === 'user' ? 'user' : 'raw',
      rawFrom: { factId: e.factId, citationId: e.citationId },
      dateKind,
    });
    // The page's sign was followed ("<3" where the detail reads "3"): the row holds the page's text as its value and as
    // printed (value_raw), and remembers what the detail reads, so it keeps saying "the page is followed" and is never
    // taken for a change by hand (labRowEditedFrom).
    if (reading.valueFrom === 'quote' && reading.valueReadAs) {
      const pj = readParseJson(projection.parseJson) ?? {};
      projection.parseJson = JSON.stringify({ ...pj, pageValue: { shown: reading.valueShown, readAs: reading.valueReadAs } satisfies NonNullable<LabParseJson['pageValue']> });
    }
    rows.push({
      id: newId(),
      analyte: e.analyte,
      analyteKey: e.analyteKey,
      valueNum: reading.measurement,
      valueText: reading.valueShown !== '' ? reading.valueShown : null,
      unit: e.splitFrom ? (reading.unit.raw?.trim() || null) : (factUnits.get(e.factId!) ?? null),
      refLow: bounds ? range.low : null,
      refHigh: bounds ? range.high : null,
      refText: !range.fromNumbersOnly && range.raw != null && range.raw.trim() ? range.raw.trim() : null,
      flag: reading.flag.state === 'flag' ? reading.flag.printed : null,
      specimen: e.specimen,
      collectedAt: c.at,
      collectedAtPrecision: c.precision ?? 'unknown',
      collectedAtText: c.text,
      labName: e.labName,
      institutionId: null,
      documentId: e.documentId,
      factId: e.factId,
      notes: null,
      createdAt: now,
      updatedAt: now,
      ...projection,
      resultedAt: r.at,
      resultedAtPrecision: r.precision,
      resultedAtText: r.text,
    });
  }
  // One transaction: all rows (and their search entries) land together or not at all.
  d.transaction(() => {
    for (const row of rows) {
      d.insert(schema.labResults).values(row).run();
      indexLab(row);
      createdIds.push(row.id);
    }
  });
  const all = createdIds.length ? loadLabEntries() : [];
  const set = new Set(createdIds);
  return { created: createdIds.length, skipped, items: all.filter((e) => set.has(e.id)) };
}
