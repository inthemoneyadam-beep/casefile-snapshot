/**
 * The server's one accessor for lab values (the user's 12 rules, 2026-10). Every reader gets a `LabReading` from
 * `readingForRow` (a lab_results row) or `readingForFact` (a lab_result fact not imported yet), built by the shared
 * parser (src/shared/labvalues.ts). No reader parses value, value_num, ref_*, flag or unit itself.
 *
 * What is read (amendment B1): the CURRENT stored text of every field is parsed and shown - rows: value_text, unit,
 * ref_text, flag; facts: value, unit, ref_text, flag_raw ?? flag - so the user's edits always show. The text as printed
 * (the raw columns, the linked fact's first reading `_aiOriginal`) is provenance: it fills a field whose current text
 * is missing, only when that field was not edited, and gives "As printed: …". A part row (one test of a line that
 * holds several) never falls back to the whole line's printed text.
 *
 * `projectReading` turns a reading into the stored projection columns (migration 0004) for the writers and the
 * one-time re-read; the columns are never read back in place of the text.
 */
import { normalizeKey } from '../../shared/text';
import { parsePartialDate, type DatePrecision, type PartialDate } from '../../shared/dates';
import { normalizeAnalyte } from '../../shared/analytes';
import { LAB_PARSE_VERSION, buildLabReading, compactReading, roleForTier, type LabReading, type LabReadingView, type LabWarningCode } from '../../shared/labvalues';
import type { SettingKey } from '../../shared/constants';
import { raw, type schema } from '../db';
import { factTier } from '../../shared/trust';
import { parseJson } from '../util/ids';
import { getSetting } from './settings';
import { COMPUTED_SOURCE } from '../../shared/labcompute';

export { compactReading, type LabReadingView };

export type LabRow = typeof schema.labResults.$inferSelect;
export type LabInsert = typeof schema.labResults.$inferInsert;

/** The setting that holds the one-time re-read's report (cast to SettingKey: not listed in DEFAULT_SETTINGS, the filing.ts precedent). */
export const LAB_PARSE_SETTING = 'migration.labParseV1';
/** The last failure of the one-time re-read ({ at, error }), kept apart so a failure stays visible (amendment I4). */
export const LAB_PARSE_ERROR_SETTING = 'migration.labParseV1.lastError';

/** The 21 columns migration 0004 added to lab_results, as SQL names. */
export const LAB_PARSE_COLUMNS = [
  'value_raw', 'unit_raw', 'ref_raw', 'flag_raw', 'raw_source', 'value_kind', 'value_comparator', 'value_parsed', 'unit_parsed', 'ref_status', 'ref_parsed_low',
  'ref_low_comparator', 'ref_parsed_high', 'ref_high_comparator', 'flag_computed', 'resulted_at', 'resulted_at_precision', 'resulted_at_text', 'date_kind',
  'parse_version', 'parse_json',
] as const;

/** Every column of migration 0004 is on the open database's lab_results (the re-read checks this before it writes; amendment A1). */
export function labParseColumnsPresent(): { ok: boolean; missing: string[] } {
  const have = new Set((raw().prepare("select name from pragma_table_info('lab_results')").all() as Array<{ name: string }>).map((r) => r.name));
  const missing = LAB_PARSE_COLUMNS.filter((c) => !have.has(c));
  return { ok: missing.length === 0, missing };
}

export interface FactLite {
  id: string;
  attributesJson: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  status: string;
  sourceDocumentId: string | null;
  /** 'manual' for a fact the user typed (its words are the user's). */
  origin?: string | null;
  /** LAB_FORM_NOTE on the detail the Labs form made for a typed row (rowRawSource). */
  verdictNote?: string | null;
  /**
   * Who asserts it (facts.asserted_by), when the caller has it. With the passage link in attributes (`_segment`) it
   * decides the tier the value is read at (trust.ts factTier, 2026-10-07): a value the patient quotes in his own message
   * inside a clinical record is his claim, never a printed result.
   */
  assertedBy?: string | null;
}
export interface CiteLite {
  id: string;
  documentId: string;
  pageNumber: number;
  verified: boolean;
  quote: string;
}
export interface ReadingContext {
  /** The value's first citation (verified first). */
  cite?: CiteLite | null;
  documentTier?: string | null;
  documentDate?: PartialDate | null;
  hasDocument: boolean;
}

type Attrs = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
/** A string as stored, keeping '' and '-' (a blank or dashed flag is "no flag printed", not "not recorded"). */
function strKeep(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function sameAttr(a: unknown, b: unknown): boolean {
  if (a == null || a === '') return b == null || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a).trim() === String(b ?? '').trim();
}
function datePart(text: unknown): PartialDate | null {
  const t = str(text);
  if (!t) return null;
  return parsePartialDate(t);
}
function samePartial(a: PartialDate | null, b: PartialDate | null): boolean {
  if (!a || !b) return false;
  if (a.iso || b.iso) return a.iso === b.iso;
  return (a.text ?? '').trim() === (b.text ?? '').trim();
}

/** The fact's first reading by the model, when the fact was corrected on Details (attributes._aiOriginal). */
function originalAttrs(a: Attrs): Attrs | null {
  if (!a._userEdited) return null;
  const o = a._aiOriginal;
  if (!o || typeof o !== 'object') return null;
  const at = (o as { attributes?: unknown }).attributes;
  return at && typeof at === 'object' ? (at as Attrs) : null;
}

const VERDICT = new Set(['confirmed', 'disputed']);

/**
 * The tier a fact's value is read at: its passage's (trust.ts factTier: the patient's own words inside a clinical record
 * are his), never above the document's; the document's tier when nothing says otherwise. The user's lab rules are unchanged:
 * only the role (printed or claimed) follows the passage.
 */
function passageTier(documentTier: string | null | undefined, fact: Pick<FactLite, 'attributesJson' | 'assertedBy'>, attributes?: Attrs | null): string | null | undefined {
  // Only a clinical record is re-tiered by its passage: any other tier is read exactly as before (and fast).
  if (documentTier !== 'primary') return documentTier;
  return factTier(documentTier, attributes ? { assertedBy: fact.assertedBy ?? null, attributes } : { assertedBy: fact.assertedBy ?? null, attributesJson: fact.attributesJson });
}

/** A lab_result fact read as a reading: the fact's current attributes, its first reading as provenance. */
export function readingForFact(fact: FactLite, ctx: ReadingContext): LabReading {
  const a = parseJson<Attrs>(fact.attributesJson, {});
  const original = originalAttrs(a);
  const manual = fact.origin === 'manual';
  const edited = (k: string) => manual || (original != null && !sameAttr(a[k], original[k]));
  const flagEdited = edited('flag') || edited('flag_raw');
  let flagShown: string | null;
  if (original && flagEdited) flagShown = edited('flag_raw') ? strKeep(a.flag_raw) : strKeep(a.flag);
  else flagShown = strKeep(a.flag_raw) ?? strKeep(a.flag);

  const collected = datePart(a.collected_date);
  const resulted = datePart(a.resulted_date);
  const factDate: PartialDate | null = fact.date || str(fact.dateText) ? { iso: fact.date, precision: (fact.datePrecision || 'unknown') as DatePrecision, text: fact.dateText } : null;
  // The fact's own date is a date of unknown kind unless it is the collected or the resulted date printed with it.
  const unknownKind = factDate && !samePartial(factDate, collected) && !samePartial(factDate, resulted) ? factDate : null;

  return buildLabReading({
    value: {
      shown: strKeep(a.value),
      raw: original ? strKeep(original.value) : null,
      storedNumber: num(a.value_num),
      userEdited: edited('value'),
      verdictLocked: VERDICT.has(fact.status),
    },
    unit: { shown: strKeep(a.unit), raw: original ? strKeep(original.unit) : null, userEdited: edited('unit') },
    range: {
      shown: strKeep(a.ref_text),
      raw: original ? strKeep(original.ref_text) : null,
      storedLow: num(a.ref_low),
      storedHigh: num(a.ref_high),
      userEdited: edited('ref_text') || edited('ref_low') || edited('ref_high'),
    },
    flag: {
      shown: flagShown,
      raw: original ? (strKeep(original.flag_raw) ?? strKeep(original.flag)) : null,
      stored: strKeep(a.flag),
      userEdited: flagEdited,
      modelConflict: str(a._flagConflict),
    },
    quote: ctx.cite ? { text: ctx.cite.quote, verified: Boolean(ctx.cite.verified), citationId: ctx.cite.id } : null,
    role: roleForTier(passageTier(ctx.documentTier, fact, a), ctx.hasDocument),
    dates: { collected, resulted, unknownKind, document: ctx.documentDate ?? null, received: datePart(a.received_date) },
    labName: str(a.lab_name),
    claim: { interpretation: str(a.interpretation), limitUsed: str(a.limit_used) },
    sampleLabel: str(a.sample_label),
  });
}

/** Fields of a row the user changed by hand (recorded by updateLab in parse_json.userFields; amendment B2). */
export type LabUserField = 'value' | 'unit' | 'range' | 'flag' | 'date' | 'resulted' | 'lab' | 'specimen' | 'analyte' | 'notes';

/** What parse_json holds. Only the keys below; written by projectReading and updateLab. */
export interface LabParseJson {
  v: number;
  parsedFrom: 'raw' | 'user';
  /** Where the printed text came from: the linked fact and its citation, or the CSV column. */
  rawFrom: { factId?: string | null; citationId?: string | null; column?: string | null } | null;
  warnings: LabWarningCode[];
  /** This row's side of a same-document conflict (rule 10), written by the re-read. */
  conflicts?: unknown[];
  /** The fields the user changed by hand (merged, never dropped). */
  userFields?: LabUserField[];
  /** A received date as written (CSV, hand entry). */
  received?: string | null;
  /** A slot printed with the value (tube 1-4, a time, "repeat"). */
  sampleLabel?: string | null;
  /** 'flag field': the printed flag was copied from the normalised flag because none was recorded as printed. */
  flagFrom?: string | null;
  /**
   * The flag the user chose on a row from a document, as chosen ('' none printed, '-', "HH", "*"; null not recorded):
   * the row's flag_raw keeps the printed flag as provenance, so the user's own text lives here (read when userFields
   * names 'flag').
   */
  userFlag?: string | null;
  /**
   * A copy written with the page's sign in place of the detail's text ("Add all" of a value read as "3" whose verified
   * page prints "<3"): the value as the page prints it (`shown`, the row's value_text) and as the detail reads it
   * (`readAs`). The copy keeps saying the page was followed, and is never taken for a change by hand.
   */
  pageValue?: { shown: string; readAs: string } | null;
  /** A value the patient computed (raw_source 'computed', src/shared/labcompute.ts ComputedRecord): kept by every rewrite. */
  computed?: unknown;
}

/** The page's text a copy was written with, when the row still holds it (never after the user changed the value). */
export function pageValueOf(row: { valueText: string | null; parseJson?: string | null }): { shown: string; readAs: string } | null {
  const pv = readParseJson(row.parseJson ?? null)?.pageValue;
  if (!pv || typeof pv.shown !== 'string' || typeof pv.readAs !== 'string') return null;
  const plain = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
  return plain(row.valueText) === plain(pv.shown) ? pv : null;
}

export function readParseJson(text: string | null | undefined): Partial<LabParseJson> | null {
  const v = parseJson<unknown>(text ?? null, null);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<LabParseJson>) : null;
}

/** parse_json with these fields added to userFields (merged with the ones already there, never dropped). */
export function withUserFields(previous: string | null | undefined, fields: LabUserField[]): string {
  const pj = readParseJson(previous) ?? {};
  const merged = [...new Set([...(Array.isArray(pj.userFields) ? pj.userFields : []), ...fields])];
  return JSON.stringify({ ...pj, userFields: merged });
}

/** The note the Labs form's own detail carries (createLab, before and since 2026-10): the row and its detail are one typed entry. */
export const LAB_FORM_NOTE = 'Entered from the labs ledger.';

/**
 * Where a row's text came from: the column when filled; else a linked fact, a CSV import ("imported from …"), or typed
 * by hand. A row the Labs form made with a citation (its detail is a manual fact carrying LAB_FORM_NOTE) is typed: its
 * words, and the date entered under "Date taken", are the user's own. A row "Add all" copied from any other detail,
 * a manual one included, is 'fact': its date's kind is not known (rule 7: never inferred).
 */
export function rowRawSource(row: Pick<LabRow, 'rawSource' | 'factId' | 'notes'>, fact?: { origin?: string | null; verdictNote?: string | null } | null): string {
  if (row.rawSource) return row.rawSource;
  if (row.factId) return fact?.origin === 'manual' && (fact.verdictNote ?? '').trim() === LAB_FORM_NOTE ? 'typed' : 'fact';
  if (/^imported from /.test(row.notes ?? '')) return 'csv';
  return 'typed';
}

/** One test of the fact's line, not the line itself: the row's name is not the fact's ("Protein" of "OP 17; protein 52"). */
function isPartOf(row: Pick<LabRow, 'analyte' | 'specimen'>, a: Attrs): boolean {
  const name = str(a.analyte) ?? '';
  if (normalizeKey(row.analyte) === normalizeKey(name)) return false;
  return normalizeAnalyte(row.analyte, row.specimen) !== normalizeAnalyte(name, row.specimen);
}

/**
 * A lab_results row read as a reading. ctx.fact: the row's linked fact (for the printed text when the row's own raw
 * columns are empty); ctx.editedFrom: labRowEditedFrom's answer (the row's value was changed by hand); ctx.isPart: the
 * row is one test of a line of several (else inferred from the names).
 */
export function readingForRow(row: LabRow, ctx: ReadingContext & { fact?: FactLite | null; editedFrom?: string | null; isPart?: boolean }): LabReading {
  const pj = readParseJson(row.parseJson);
  const source = rowRawSource(row, ctx.fact);
  const own = source === 'typed' || source === 'csv';
  const fact = !own ? (ctx.fact ?? null) : null;
  const fa = fact ? parseJson<Attrs>(fact.attributesJson, {}) : null;
  const part = fa ? (ctx.isPart ?? isPartOf(row, fa)) : false;
  const printed: Attrs | null = fa && !part ? (originalAttrs(fa) ?? fa) : null;
  const userFields = Array.isArray(pj?.userFields) ? (pj!.userFields as string[]) : null;
  const saved = Boolean(row.createdAt && row.updatedAt && row.createdAt !== row.updatedAt);
  // Without a record of the fields changed (rows edited before 2026-10), a row saved by hand may have had any field
  // changed or cleared: its printed text never fills a field.
  const fieldEdited = (f: LabUserField) => (userFields ? userFields.includes(f) : saved);

  const collectedPd: PartialDate | null =
    row.collectedAt || str(row.collectedAtText) ? { iso: row.collectedAt, precision: (row.collectedAtPrecision || 'unknown') as DatePrecision, text: row.collectedAtText } : null;
  const kind = row.dateKind ?? (source === 'typed' ? 'collected' : 'unknown');
  const resulted: PartialDate | null =
    row.resultedAt || str(row.resultedAtText) ? { iso: row.resultedAt, precision: (row.resultedAtPrecision || 'unknown') as DatePrecision, text: row.resultedAtText } : null;
  const received = datePart(pj?.received) ?? (fa && !part ? datePart(fa.received_date) : null);
  const valueEdited = source === 'typed' || Boolean(ctx.editedFrom) || Boolean(userFields?.includes('value'));
  // A copy written with the page's sign ("Add all" of "3" whose verified page prints "<3"): read as its detail reads,
  // with the page's text remembered, so it says "the page is followed" exactly as its detail does.
  const page = valueEdited ? null : pageValueOf(row);
  // The flag the user chose on a row from a document (its flag_raw keeps the printed one as provenance).
  const userFlag = fieldEdited('flag') && pj && Object.prototype.hasOwnProperty.call(pj, 'userFlag') ? (typeof pj.userFlag === 'string' ? pj.userFlag : null) : undefined;

  return buildLabReading({
    value: {
      shown: page ? page.readAs : row.valueText,
      raw: row.valueRaw ?? (own ? row.valueText : printed ? strKeep(printed.value) : null),
      storedNumber: row.valueNum,
      userEdited: valueEdited,
      verdictLocked: fact ? VERDICT.has(fact.status) : false,
      pageText: page ? page.shown : null,
    },
    unit: { shown: row.unit, raw: row.unitRaw ?? (own ? row.unit : printed ? strKeep(printed.unit) : null), userEdited: source === 'typed' || fieldEdited('unit') },
    range: {
      shown: row.refText,
      raw: row.refRaw ?? (own ? row.refText : printed ? strKeep(printed.ref_text) : null),
      storedLow: row.refLow,
      storedHigh: row.refHigh,
      userEdited: fieldEdited('range'),
    },
    flag: {
      shown: userFlag !== undefined ? userFlag : row.flag,
      raw: row.flagRaw ?? (own ? row.flag : printed ? (strKeep(printed.flag_raw) ?? strKeep(printed.flag)) : null),
      userEdited: fieldEdited('flag'),
      modelConflict: fa && !part ? str(fa._flagConflict) : null,
    },
    quote: ctx.cite ? { text: ctx.cite.quote, verified: Boolean(ctx.cite.verified), citationId: ctx.cite.id } : null,
    // A value the patient computed from printed values (src/shared/labcompute.ts) has its own role: never judged, never red.
    role: source === COMPUTED_SOURCE ? 'computed' : roleForTier(fact ? passageTier(ctx.documentTier, fact, fa) : ctx.documentTier, ctx.hasDocument),
    dates: {
      collected: kind === 'collected' ? collectedPd : null,
      unknownKind: kind === 'collected' ? null : collectedPd,
      resulted,
      document: ctx.documentDate ?? null,
      received,
    },
    labName: row.labName,
    claim: fa && !part ? { interpretation: str(fa.interpretation), limitUsed: str(fa.limit_used) } : null,
    sampleLabel: str(pj?.sampleLabel) ?? (fa && !part ? str(fa.sample_label) : null),
  });
}

export type ParsedLabColumns = Pick<
  LabInsert,
  | 'valueRaw'
  | 'unitRaw'
  | 'refRaw'
  | 'flagRaw'
  | 'rawSource'
  | 'valueKind'
  | 'valueComparator'
  | 'valueParsed'
  | 'unitParsed'
  | 'refStatus'
  | 'refParsedLow'
  | 'refLowComparator'
  | 'refParsedHigh'
  | 'refHighComparator'
  | 'flagComputed'
  | 'dateKind'
  | 'parseVersion'
  | 'parseJson'
>;

/**
 * The stored projection of a reading (migration 0004). The raw columns are what was printed (the reading's
 * provenance) and are meant only for write-once (`coalesce(value_raw, ?)`) writes; the parsed columns are the parser's
 * output for SQL readers and counts. parse_json keeps the previous row's userFields, received date, sample label and
 * conflicts (unless new conflicts are given).
 */
export function projectReading(
  r: LabReading,
  meta: {
    rawSource: string;
    parsedFrom: 'raw' | 'user';
    rawFrom: { factId?: string | null; citationId?: string | null; column?: string | null } | null;
    dateKind: 'collected' | 'unknown' | null;
    /** The row's parse_json before this write. */
    previous?: string | null;
    conflicts?: unknown[];
  },
): ParsedLabColumns {
  const prev = readParseJson(meta.previous) ?? {};
  const pj: LabParseJson = {
    v: LAB_PARSE_VERSION,
    parsedFrom: meta.parsedFrom,
    rawFrom: meta.rawFrom,
    warnings: r.warnings.map((w) => w.code),
  };
  if (meta.conflicts) pj.conflicts = meta.conflicts;
  else if (Array.isArray(prev.conflicts)) pj.conflicts = prev.conflicts;
  if (Array.isArray(prev.userFields)) pj.userFields = prev.userFields;
  if (prev.received) pj.received = prev.received;
  if (prev.sampleLabel) pj.sampleLabel = prev.sampleLabel;
  if (prev.flagFrom) pj.flagFrom = prev.flagFrom;
  if (Object.prototype.hasOwnProperty.call(prev, 'userFlag')) pj.userFlag = typeof prev.userFlag === 'string' ? prev.userFlag : null;
  if (prev.pageValue && typeof prev.pageValue === 'object') pj.pageValue = prev.pageValue;
  // A computed value's record (formula, inputs, citations) is never dropped by a re-projection.
  if (prev.computed && typeof prev.computed === 'object') pj.computed = prev.computed;
  const v = r.value;
  return {
    valueRaw: r.printed.value,
    unitRaw: r.printed.unit,
    refRaw: r.printed.range,
    flagRaw: r.printed.flag,
    rawSource: meta.rawSource,
    valueKind: v.kind,
    valueComparator: v.comparator,
    valueParsed: v.kind === 'number' ? v.number : v.kind === 'censored' ? v.bound : null,
    unitParsed: r.unit.unit,
    refStatus: r.range.status,
    refParsedLow: r.range.low,
    refLowComparator: r.range.lowComparator,
    refParsedHigh: r.range.high,
    refHighComparator: r.range.highComparator,
    flagComputed: r.computed.flag,
    dateKind: meta.dateKind,
    parseVersion: LAB_PARSE_VERSION,
    parseJson: JSON.stringify(pj),
  };
}

/** A reading with what the checks (rules 10 and 12) and the re-read need about where it came from. Built by labs.ts's loadLabReadings (WP3). */
export interface LabReadingRecord {
  source: 'row' | 'fact';
  id: string;
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  analyteKey: string;
  specimen: string;
  documentId: string | null;
  documentTitle: string | null;
  documentTier: string | null;
  pageNumber: number | null;
  citationId: string | null;
  /** The verified quote of the value's citation, when there is one. */
  quote?: string | null;
  factStatus: string | null;
  reading: LabReading;
  /**
   * A summary's claim the reconciliation set aside as matched with a lab report (loadLabReadings({
   * withPassSetAsideClaims })): compared by rule 12 only, never a value of its own (not listed, not checked by rule 10).
   */
  passSetAside?: boolean;
}

/** The counters of the one-time re-read (design §4.3); one reading can count under several. */
export const LAB_PARSE_RULES = [
  'limitNotMeasurement',
  'wordsNotNumber',
  'quoteShowsSymbol',
  'rangeShownAsPrinted',
  'rangeNumbersIgnored',
  'rangeUnparsed',
  'flagChanged',
  /** A summary's (or a note's) flag that was marked like a lab's: now that document's own claim, never marked red. */
  'flagNowClaim',
  'flagWarnings',
  'unitCollapsed',
  'regrouped',
  'dateKindUnknown',
  'sameSourceConflicts',
  'claimDifferences',
] as const;
export type LabParseRule = (typeof LAB_PARSE_RULES)[number];

export interface LabParseReport {
  version: number;
  ranAt: string;
  dryRun: boolean;
  rows: { total: number; live: number; deleted: number; filled: number; readingChanged: number };
  facts: { total: number; readingChanged: number };
  byRule: Record<LabParseRule, number>;
  /** Up to 20, for the Labs dialog only (the setting lives in the encrypted database; the audit row gets counts only). */
  examples: Array<{ entryId: string; test: string; rule: string; before: string; after: string }>;
  /** The first reconcile pass after the upgrade (amendment I1): facts put back, set aside, and pairs no longer compared. */
  reconcile?: { undone: number; setAside: number; notCompared: number } | null;
  error?: string;
}

function isReport(v: unknown): v is LabParseReport {
  return Boolean(v && typeof v === 'object' && typeof (v as { version?: unknown }).version === 'number' && (v as { byRule?: unknown }).byRule && typeof (v as { byRule?: unknown }).byRule === 'object');
}

/** The one-time re-read's report, or null when it has not run on this database. */
export function readLabParseReport(): LabParseReport | null {
  const v = getSetting(LAB_PARSE_SETTING as SettingKey) as unknown;
  return isReport(v) ? v : null;
}

/** The re-read's last failure, or null. */
export function readLabParseError(): { at: string; error: string } | null {
  const v = getSetting(LAB_PARSE_ERROR_SETTING as SettingKey) as unknown;
  if (v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string') {
    const o = v as { at?: unknown; error: string };
    return { at: typeof o.at === 'string' ? o.at : '', error: o.error };
  }
  return null;
}
