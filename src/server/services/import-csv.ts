/**
 * Spreadsheet import (docs/API-CONTRACTS-3.md, slice O): one CSV file into
 * the symptom log, the labs ledger or the communications log. Every target
 * supports a dry run that writes nothing and says, row by row, what the
 * import would do; the same call without the dry run writes it. Rows are
 * numbered 1-based over the data rows (the header is not counted), as the
 * symptoms importer numbers them, so a row number means the same in the
 * preview, the result and the file.
 *
 * - symptoms: delegated to the symptoms service (importCsv / parseSymptomCsv,
 *   which already has a dry run and lists every value it would overwrite).
 * - labs: `importLabsCsv`. Columns date and/or result date, analyte, value,
 *   unit, ref_low, ref_high, specimen, lab (synonyms accepted; optional flag,
 *   ref, notes). Each row becomes a `lab_results` row with factId null, its
 *   value, unit, range and flag kept as written (a limit such as "<3" is not
 *   a number; a blank or "-" flag is "no flag printed", not normal), the
 *   collected and result dates apart, the parsed projection of migration 0004
 *   (raw_source 'csv'), and notes "imported from <filename>". A row identical
 *   to a live result (same analyte, specimen, date, value as written and
 *   unit) is skipped as already on file, so importing a file twice does not
 *   double a trend.
 * - communications: `importCommunicationsCsv`. Columns date, direction,
 *   channel, with, subject, summary, outcome, follow_up, follow_up_due,
 *   topics. Names in `with` are matched to people (exact name or alias first,
 *   then the same token-overlap matcher as the calendar import); unmatched
 *   names become people only when "create missing people" is ticked, and a
 *   name left out is written into the summary so it is not lost. A row that
 *   repeats a live communication (same date, subject, direction and channel)
 *   is skipped as already on file.
 *
 * `exclude` leaves rows out (the preview's unticked rows); they are listed
 * as skipped with the reason "left out in the preview". Each written row
 * runs in its own savepoint inside one transaction: a refused row rolls back
 * alone and is reported, and nothing is half-written.
 */
import * as PapaNs from 'papaparse';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { badRequest } from '../util/errors';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { indexEntity } from './search';
import { importCsv as importSymptomCsv, latestLoggableDay, parseSymptomCsv, type ImportOverwrite, type ParsedCsv } from './symptoms';
import { defaultSpecimenFor, normalizeAnalyte, SPECIMEN_LABELS } from '../../shared/analytes';
import { fmtNum, parseFlag, parseLabValue, parseRefRange as readRange, type LabReading } from '../../shared/labvalues';
import { COMPUTED_SOURCE } from '../../shared/labcompute';
import { labValueDedupKey, labValueIdentityOf, unitDedupKey } from './dedup';
import { projectReading, readingForRow, type LabInsert, type LabRow } from './lab-reading';
import { createCommunication, type CommunicationInput } from './communications';
import { createPerson, nameKey } from './people';
import { bestMatch, loadCandidates, PERSON_TITLES, type MatchCandidate } from './import-calendar';
import { parsePartialDate, todayIso, type DatePrecision, type PartialDate, readDateCell, writtenFinerThanRead } from '../../shared/dates';
import { COMM_CHANNELS, COMM_DIRECTIONS, PARTICIPANT_ROLES, type PersonKind } from '../../shared/enums';

// papaparse ships a UMD build; under Node ESM the API lives on `default`.
const Papa = ((PapaNs as unknown as { default?: typeof PapaNs }).default ?? PapaNs) as typeof PapaNs;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const CSV_TARGETS = ['symptoms', 'labs', 'communications'] as const;
export type CsvTarget = (typeof CSV_TARGETS)[number];

export interface CsvSkip {
  row: number;
  reason: string;
}

export interface CsvWarning {
  row: number;
  message: string;
}

export type CsvRowStatus = 'import' | 'skip' | 'excluded';

/** One data row as the import reads it. */
export interface CsvRowBase {
  row: number;
  /** import: written (or would be on a dry run); skip: refused, see reason; excluded: left out by the user. */
  status: CsvRowStatus;
  reason: string | null;
  warnings: string[];
  date: string | null;
  datePrecision: DatePrecision;
  /** The date cell as written. */
  dateText: string | null;
  /** One line saying what the row holds. */
  summary: string;
  /** The row's cells by header, as written. */
  cells: Record<string, string>;
}

export interface CsvOptions {
  filename?: string | null;
  dryRun?: boolean;
  /** Data row numbers (1-based) to leave out. */
  exclude?: number[];
  /** communications: create a person for each name that matches nobody. */
  createPeople?: boolean;
  /** communications: a decision per name as written (or its key): a person id, 'new' or 'none'. */
  map?: Record<string, string>;
}

export interface CsvResultBase<R extends CsvRowBase> {
  target: CsvTarget;
  filename: string | null;
  dryRun: boolean;
  /** Rows written (or that would be). For symptoms: days. */
  imported: number;
  /** Every row not written, with the reason (refused and left out). */
  skipped: CsvSkip[];
  /** Rows written with a caveat (a value kept as text, a specimen read as other, a name left out). */
  warnings: CsvWarning[];
  /** Things about the whole file (a column missing, a default applied to every row). */
  fileNotes: string[];
  /** How each header was read: the field it fills, or 'ignored'. */
  columns: Record<string, string>;
  rows: R[];
}

export const MAX_CSV_ROWS = 20_000;

interface Table {
  headers: string[];
  records: Array<Record<string, string>>;
}

export function readTable(text: string): Table {
  if (!text || !text.trim()) throw badRequest('the CSV is empty');
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h: string) => h.trim() });
  const headers = (res.meta.fields ?? []).filter((h) => h.trim());
  if (!headers.length) throw badRequest('the CSV has no header row');
  if (res.data.length > MAX_CSV_ROWS) throw badRequest(`the CSV has ${res.data.length} rows; split it into files of at most ${MAX_CSV_ROWS}`);
  return { headers, records: res.data };
}

/** Which header fills which field: the first header naming a field wins; the rest are reported as ignored. */
export function mapColumns<F extends string>(headers: string[], synonyms: Record<F, string[]>): { fields: Map<F, string>; columns: Record<string, string> } {
  const lookup = new Map<string, F>();
  for (const [field, names] of Object.entries(synonyms) as Array<[F, string[]]>) for (const n of [field, ...names]) lookup.set(normalizeKey(n), field);
  const fields = new Map<F, string>();
  const columns: Record<string, string> = {};
  for (const h of headers) {
    const f = lookup.get(normalizeKey(h));
    if (!f) columns[h] = 'ignored';
    else if (fields.has(f)) columns[h] = `ignored (a second ${f} column)`;
    else {
      fields.set(f, h);
      columns[h] = f;
    }
  }
  return { fields, columns };
}

function cellOf<F extends string>(rec: Record<string, string>, fields: Map<F, string>, f: F): string {
  const h = fields.get(f);
  return h ? String(rec[h] ?? '').trim() : '';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function finish<R extends CsvRowBase>(rows: R[]): { skipped: CsvSkip[]; warnings: CsvWarning[] } {
  const skipped: CsvSkip[] = [];
  const warnings: CsvWarning[] = [];
  for (const r of rows) {
    if (r.status !== 'import') skipped.push({ row: r.row, reason: r.reason ?? 'skipped' });
    else for (const w of r.warnings) warnings.push({ row: r.row, message: w });
  }
  return { skipped, warnings };
}

const LEFT_OUT = 'left out in the preview';

/** The cells of one record for the header list, as written (papaparse's extra-field array left out). */
export function cellsOf(rec: Record<string, string>, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const v = rec[h];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[h] = String(v);
  }
  const extra = extraCells(rec);
  if (extra.length) out['(past the last header)'] = extra.join(' | ');
  return out;
}

/** Non-empty cells past the last header (papaparse keeps them in __parsed_extra): a value with an unquoted comma shifted the row. */
export function extraCells(rec: Record<string, string>): string[] {
  const extra = (rec as Record<string, unknown>).__parsed_extra;
  return Array.isArray(extra) ? extra.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
}

/** Why a row with cells past the last header is refused rather than read shifted. */
export function extraCellsReason(n: number): string {
  return `the row has ${n === 1 ? 'a cell' : `${n} cells`} past the last header, so its values are shifted; a value with a comma needs quotes ("5,2")`;
}

export { readDateCell } from '../../shared/dates';

// ---------------------------------------------------------------------------
// Labs
// ---------------------------------------------------------------------------

type LabField = 'date' | 'resulted' | 'analyte' | 'value' | 'unit' | 'ref_low' | 'ref_high' | 'ref' | 'specimen' | 'lab' | 'flag' | 'notes';

/**
 * Header spellings per field. `date` is the date the sample was taken when the header says so (COLLECTED_HEADERS),
 * else a date of unknown kind ("Date", "Day", "Observation date": nothing is inferred). `resulted` is the date the
 * result came back; a file may have either or both (rule 7: the two are never one).
 */
export const LAB_COLUMNS: Record<LabField, string[]> = {
  date: ['collected', 'collected at', 'collected on', 'collection date', 'collection date time', 'collection time', 'date collected', 'specimen date', 'specimen collected', 'drawn', 'date drawn', 'obtained', 'date obtained', 'observation date', 'day'],
  resulted: ['result date', 'result date time', 'resulted', 'resulted on', 'resulted at', 'date resulted', 'reported', 'reported on', 'reported at', 'report date', 'date reported'],
  analyte: ['test', 'test name', 'component', 'name', 'lab test', 'result name', 'observation', 'marker'],
  value: ['result', 'result value', 'value as written', 'reading'],
  unit: ['units', 'uom'],
  ref_low: ['reference low', 'range low', 'normal low', 'low', 'ref min', 'min'],
  ref_high: ['reference high', 'range high', 'normal high', 'high', 'ref max', 'max'],
  ref: ['reference', 'reference range', 'ref range', 'range', 'normal range', 'ref text', 'reference interval'],
  specimen: ['specimen type', 'sample', 'sample type', 'fluid', 'source'],
  lab: ['lab name', 'laboratory', 'performing lab', 'performing laboratory', 'lab location'],
  flag: ['abnormal flag', 'abnormal', 'interpretation', 'h l'],
  notes: ['note', 'comment', 'comments'],
};

/** `date` headers that say the date is when the sample was taken (date_kind 'collected'); any other date header is of unknown kind. */
const COLLECTED_HEADERS = new Set(
  ['collected', 'collected at', 'collected on', 'collection date', 'collection date time', 'collection time', 'date collected', 'specimen date', 'specimen collected', 'drawn', 'date drawn', 'obtained', 'date obtained'].map(normalizeKey),
);

/** A flag column headed "Interpretation" holds the file's own judgement words, kept as written. */
const INTERPRETATION_HEADERS = new Set(['interpretation'].map(normalizeKey));

const LAB_NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

/**
 * A lab value as a number, or null when it is not one. Thousands separators
 * are accepted only in groups of three ("1,234"); "5,2" is not read as 52
 * (or as 5.2): a decimal comma is ambiguous, so the value stays text.
 */
export function parseLabNumber(raw: string | null | undefined): number | null {
  const t = (raw ?? '').trim();
  if (!t || !/\d/.test(t) || !LAB_NUMBER.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The bounds of a reference range cell, read by the shared parser (src/shared/labvalues.ts): "3.5-5.0", "3.5 – 5.0",
 * "3.5 to 5" -> both; "<5", "≤ 5", "up to 5" -> high only; ">10", "≥10" -> low only; words, titres, several ranges ->
 * no bounds. Named apart from the shared `parseRefRange`, which returns the whole reading of the range.
 */
export function parseCsvRefBounds(raw: string | null | undefined): { low: number | null; high: number | null } {
  const r = readRange(raw ?? '');
  if (r.status !== 'parsed' || r.kind === 'text') return { low: null, high: null };
  return { low: r.low, high: r.high };
}

const SPECIMEN_WORDS: Record<string, string> = {
  serum: 'serum',
  ser: 'serum',
  'blood serum': 'serum',
  plasma: 'plasma',
  'whole blood': 'whole_blood',
  'whole blood edta': 'whole_blood',
  blood: 'whole_blood',
  wb: 'whole_blood',
  csf: 'csf',
  'cerebrospinal fluid': 'csf',
  'spinal fluid': 'csf',
  'lumbar puncture': 'csf',
  lp: 'csf',
  urine: 'urine',
  ur: 'urine',
  urinalysis: 'urine',
  '24 hour urine': 'urine',
  '24h urine': 'urine',
  'random urine': 'urine',
  other: 'other',
};

/** The stored specimen for a cell; empty means "work it out from the analyte" (CSF-only studies are CSF). */
export function readSpecimen(raw: string, analyte: string): { specimen: string; note: string | null } {
  const key = normalizeKey(raw);
  if (!key) return { specimen: defaultSpecimenFor(analyte), note: null };
  const hit = SPECIMEN_WORDS[key];
  if (hit) return { specimen: hit, note: null };
  return { specimen: 'other', note: `specimen "${raw}" is not one the ledger knows; read as other` };
}

/**
 * A flag cell (rule 4): the cell is kept as written in flag_raw ('' = the file's flag column is blank for this row,
 * "-" = a dash: no flag printed; neither is "normal"); `flag` is what a printed mark means (H, L, N, A, C), never
 * worked out from the range. A mark the app does not read ("Pos") is kept as written, with a note. With no flag
 * column at all, nothing is recorded (null).
 */
export function readFlag(raw: string, columnPresent = true): { flag: string | null; flagRaw: string | null; note: string | null } {
  if (!columnPresent) return { flag: null, flagRaw: null, note: null };
  const t = raw.trim();
  const p = parseFlag(t);
  if (p.state === 'flag') return { flag: p.printed, flagRaw: t, note: null };
  if (p.state === 'not_understood') return { flag: null, flagRaw: t, note: `flag "${t}" is kept as written; it is not read as high, low or normal` };
  return { flag: null, flagRaw: t, note: null };
}

export interface LabCsvRow extends CsvRowBase {
  analyte: string;
  value: string;
  /** The measurement: a plain number as written ("62", "1,234"); null for a limit ("<3"), words, a range or "5,2". */
  valueNum: number | null;
  unit: string | null;
  /** The range as shown: the cell as written, or built from the numbers ("3.5–5", "upper limit 5"); never a lone dash. */
  ref: string | null;
  refLow: number | null;
  refHigh: number | null;
  specimen: string;
  /** What a printed flag means (H, L, N, A, C); null for none, a dash, or a mark the app does not read. */
  flag: string | null;
  /** The flag cell as written ('' blank, '-' dash); null when the file has no flag column. */
  flagRaw: string | null;
  lab: string | null;
  /** The date cell's kind: 'collected' when its header says so, else 'unknown'; 'resulted' when only a result date is given. */
  dateKind: 'collected' | 'unknown' | 'resulted' | null;
  /** The result date, when the file has a result date column. */
  resulted: string | null;
  resultedPrecision: DatePrecision | null;
  resultedText: string | null;
}

export interface LabCsvResult extends CsvResultBase<LabCsvRow> {
  target: 'labs';
  /** Ids of the lab results written (empty on a dry run). */
  ids: string[];
}

/**
 * How a duplicate is recognised: analyte, specimen, a date, the value as written ("<3" is never "3") with its identity
 * (".8" is never "8", "1,500" never "1.500": the written key drops the point and the comma) and the unit.
 */
function labDedupKey(analyteKey: string, specimen: string, date: string, value: string | null, unit: string | null): string {
  return [analyteKey, specimen, date, labValueDedupKey(value ?? ''), labValueIdentityOf(value ?? ''), unitDedupKey(unit)].join('|');
}

/** Every column of a lab_results row, for reading an insert the way the ledger reads a stored row. */
function asLabRow(i: LabInsert): LabRow {
  return {
    id: i.id,
    analyte: i.analyte,
    analyteKey: i.analyteKey,
    valueNum: i.valueNum ?? null,
    valueText: i.valueText ?? null,
    unit: i.unit ?? null,
    refLow: i.refLow ?? null,
    refHigh: i.refHigh ?? null,
    refText: i.refText ?? null,
    flag: i.flag ?? null,
    specimen: i.specimen ?? 'serum',
    collectedAt: i.collectedAt ?? null,
    collectedAtPrecision: i.collectedAtPrecision ?? 'unknown',
    collectedAtText: i.collectedAtText ?? null,
    labName: i.labName ?? null,
    institutionId: i.institutionId ?? null,
    documentId: i.documentId ?? null,
    factId: i.factId ?? null,
    notes: i.notes ?? null,
    createdAt: i.createdAt ?? '',
    updatedAt: i.updatedAt ?? '',
    deletedAt: i.deletedAt ?? null,
    valueRaw: i.valueRaw ?? null,
    unitRaw: i.unitRaw ?? null,
    refRaw: i.refRaw ?? null,
    flagRaw: i.flagRaw ?? null,
    rawSource: i.rawSource ?? null,
    valueKind: i.valueKind ?? null,
    valueComparator: i.valueComparator ?? null,
    valueParsed: i.valueParsed ?? null,
    unitParsed: i.unitParsed ?? null,
    refStatus: i.refStatus ?? null,
    refParsedLow: i.refParsedLow ?? null,
    refLowComparator: i.refLowComparator ?? null,
    refParsedHigh: i.refParsedHigh ?? null,
    refHighComparator: i.refHighComparator ?? null,
    flagComputed: i.flagComputed ?? null,
    resultedAt: i.resultedAt ?? null,
    resultedAtPrecision: i.resultedAtPrecision ?? null,
    resultedAtText: i.resultedAtText ?? null,
    dateKind: i.dateKind ?? null,
    parseVersion: i.parseVersion ?? null,
    parseJson: i.parseJson ?? null,
  };
}

/** A date cell checked the way every CSV date is (readable, not in the future, not read coarser than written). */
function dateProblem(label: string, raw: string, pd: PartialDate, today: string): string | null {
  if (!pd.iso) return `${label} "${raw}" could not be read`;
  if (pd.iso > today) return `${label} ${pd.iso} is in the future`;
  if (writtenFinerThanRead(raw, pd)) return `${label} "${raw}" names a day but could only be read as ${pd.iso}; write it as YYYY-MM-DD`;
  return null;
}

/** Lab results from a CSV; see the file header. */
export function importLabsCsv(text: string, opts: CsvOptions = {}): LabCsvResult {
  const dryRun = Boolean(opts.dryRun);
  const filename = opts.filename?.trim() || null;
  const { headers, records } = readTable(text);
  const { fields, columns } = mapColumns(headers, LAB_COLUMNS);
  const missing: string[] = [];
  if (!fields.has('date') && !fields.has('resulted')) missing.push('date (or a result date)');
  for (const f of ['analyte', 'value'] as const) if (!fields.has(f)) missing.push(f);
  if (missing.length) throw badRequest(`the labs CSV needs the column${missing.length === 1 ? '' : 's'} ${missing.join(', ')} (it has ${headers.join(', ')})`);
  const exclude = new Set(opts.exclude ?? []);
  const today = todayIso();
  const d = db();
  const dateHeader = fields.get('date') ?? null;
  const resultedHeader = fields.get('resulted') ?? null;
  const dateIsCollected = dateHeader != null && COLLECTED_HEADERS.has(normalizeKey(dateHeader));
  const flagHeader = fields.get('flag') ?? null;
  const fileNotes: string[] = [];
  if (dateHeader && !dateIsCollected) fileNotes.push(`column "${dateHeader}" does not say whether it is when the sample was taken or when the result came back; its dates are kept as dates of unknown kind`);
  const interpretationColumn = flagHeader != null && INTERPRETATION_HEADERS.has(normalizeKey(flagHeader));
  if (interpretationColumn) fileNotes.push(`column "${flagHeader}" is the file's own judgement; each cell is kept as written as the flag, not worked out from a range`);

  // Live results on file, keyed the way a duplicate is recognised (analyte keys recomputed, as the ledger reads them),
  // under each of their dates: the collected (or unknown-kind) date and the result date. A row imported before
  // 2026-10 holds a result date in collected_at, so a file's result date matches it too.
  const onFile = new Map<string, string>();
  for (const r of d
    .select({
      id: schema.labResults.id,
      analyte: schema.labResults.analyte,
      specimen: schema.labResults.specimen,
      collectedAt: schema.labResults.collectedAt,
      collectedAtText: schema.labResults.collectedAtText,
      resultedAt: schema.labResults.resultedAt,
      resultedAtText: schema.labResults.resultedAtText,
      valueNum: schema.labResults.valueNum,
      valueText: schema.labResults.valueText,
      unit: schema.labResults.unit,
      rawSource: schema.labResults.rawSource,
    })
    .from(schema.labResults)
    .where(isNull(schema.labResults.deletedAt))
    .all()) {
    // A value the patient computed (2026-10-09) is never the lab's printed value: a file row of the same index is not its copy.
    if (r.rawSource === COMPUTED_SOURCE) continue;
    const key = normalizeAnalyte(r.analyte, r.specimen);
    const value = r.valueText ?? (r.valueNum != null ? fmtNum(r.valueNum) : '');
    for (const date of [r.collectedAt, r.resultedAt]) if (date) onFile.set(labDedupKey(key, r.specimen, date, value, r.unit), r.id);
    // Coarse dates also by the text as written, so importing the same file again does not repeat them.
    for (const written of [r.collectedAtText, r.resultedAtText]) if (written?.trim()) onFile.set(labDedupKey(key, r.specimen, `as written:${written.trim()}`, value, r.unit), r.id);
  }
  const inFile = new Map<string, number>();

  const rows: LabCsvRow[] = [];
  const toWrite: Array<{ row: LabCsvRow; insert: typeof schema.labResults.$inferInsert; reading: LabReading }> = [];
  records.forEach((rec, i) => {
    const n = i + 1;
    const analyte = cellOf(rec, fields, 'analyte');
    const value = cellOf(rec, fields, 'value');
    const dateRaw = cellOf(rec, fields, 'date');
    const resRaw = cellOf(rec, fields, 'resulted');
    const pd = readDateCell(dateRaw);
    const pr = readDateCell(resRaw);
    const warnings: string[] = [];
    const unit = cellOf(rec, fields, 'unit') || null;
    const refCell = cellOf(rec, fields, 'ref');
    const lowCell = cellOf(rec, fields, 'ref_low');
    const highCell = cellOf(rec, fields, 'ref_high');
    let refLow = parseLabNumber(lowCell);
    let refHigh = parseLabNumber(highCell);
    if (lowCell && refLow == null) warnings.push(`ref_low "${lowCell}" is not a number; kept in the reference text`);
    if (highCell && refHigh == null) warnings.push(`ref_high "${highCell}" is not a number; kept in the reference text`);
    // A range written in a bound column ("<5" under ref high) is range text as written, never a number with its sign dropped.
    const badBounds = [lowCell && refLow == null ? lowCell : '', highCell && refHigh == null ? highCell : ''].filter(Boolean);
    let refText: string | null;
    let boundsFrom = refCell;
    if (refCell) refText = [refCell, lowCell && refLow == null ? `low ${lowCell}` : '', highCell && refHigh == null ? `high ${highCell}` : ''].filter(Boolean).join('; ');
    else if (badBounds.length === 1) refText = boundsFrom = badBounds[0];
    else if (badBounds.length) refText = [`low ${lowCell}`, `high ${highCell}`].join('; ');
    else refText = null;
    const fromText = parseCsvRefBounds(boundsFrom);
    if (refLow == null) refLow = fromText.low;
    if (refHigh == null) refHigh = fromText.high;
    const sp = readSpecimen(cellOf(rec, fields, 'specimen'), analyte);
    if (sp.note) warnings.push(sp.note);
    const fl = readFlag(cellOf(rec, fields, 'flag'), flagHeader != null);
    if (fl.note) warnings.push(fl.note);
    const parsed = parseLabValue(value);
    const valueNum = parsed.kind === 'number' ? parsed.number : null;
    if (value && valueNum == null && /\d/.test(value)) {
      warnings.push(parsed.kind === 'censored' ? `value "${value}" is a limit, not a measurement: kept as written (it will not plot on a trend)` : `value "${value}" is kept as written, without a number (it will not plot on a trend)`);
    }
    const lab = cellOf(rec, fields, 'lab') || null;
    const hasDate = Boolean(dateRaw);
    const placed = hasDate ? pd : pr;
    const row: LabCsvRow = {
      row: n,
      status: 'import',
      reason: null,
      warnings,
      date: placed.iso,
      datePrecision: placed.precision,
      dateText: (hasDate ? dateRaw : resRaw) || null,
      summary: `${analyte || '(no analyte)'} ${value}${unit ? ` ${unit}` : ''}`.trim(),
      cells: cellsOf(rec, headers),
      analyte,
      value,
      valueNum,
      unit,
      ref: null,
      refLow,
      refHigh,
      specimen: sp.specimen,
      flag: fl.flag,
      flagRaw: fl.flagRaw,
      lab,
      dateKind: hasDate ? (dateIsCollected ? 'collected' : 'unknown') : resRaw ? 'resulted' : null,
      resulted: resRaw ? pr.iso : null,
      resultedPrecision: resRaw ? pr.precision : null,
      resultedText: resRaw || null,
    };
    rows.push(row);
    const refuse = (reason: string) => {
      row.status = 'skip';
      row.reason = reason;
    };

    // The row as it would be stored, read the way the ledger reads it (the range and value shown in the preview).
    const now = nowIso();
    const note = cellOf(rec, fields, 'notes');
    const base: LabInsert = {
      id: newId(),
      analyte: clip(analyte, 200),
      analyteKey: normalizeAnalyte(analyte, sp.specimen),
      valueNum,
      valueText: value,
      unit: unit ? clip(unit, 60) : null,
      refLow,
      refHigh,
      refText: refText ? clip(refText, 120) : null,
      flag: fl.flag,
      flagRaw: fl.flagRaw != null ? clip(fl.flagRaw, 60) : null,
      specimen: sp.specimen,
      collectedAt: hasDate ? pd.iso : null,
      collectedAtPrecision: hasDate ? pd.precision : 'unknown',
      collectedAtText: hasDate ? dateRaw : null,
      resultedAt: resRaw ? pr.iso : null,
      resultedAtPrecision: resRaw ? pr.precision : null,
      resultedAtText: resRaw || null,
      dateKind: hasDate ? (dateIsCollected ? 'collected' : 'unknown') : null,
      rawSource: 'csv',
      labName: lab ? clip(lab, 300) : null,
      institutionId: null,
      documentId: null,
      factId: null,
      notes: clip(`imported from ${filename ?? 'a CSV file'}${note ? `; ${note}` : ''}`, 4000),
      createdAt: now,
      updatedAt: now,
    };
    const reading = readingForRow(asLabRow(base), { hasDocument: false });
    row.ref = reading.rangeShown;

    if (exclude.has(n)) {
      row.status = 'excluded';
      row.reason = LEFT_OUT;
      return;
    }
    const extra = extraCells(rec);
    if (extra.length) return refuse(extraCellsReason(extra.length));
    if (!analyte) return refuse('missing analyte');
    if (!value) return refuse('missing value');
    if (!dateRaw && !resRaw) return refuse('missing date');
    if (dateRaw) {
      const problem = dateProblem('date', dateRaw, pd, today);
      if (problem) return refuse(problem);
    }
    if (resRaw) {
      const problem = dateProblem('result date', resRaw, pr, today);
      if (problem) return refuse(problem);
    }
    if (analyte.length > 200) return refuse('analyte name is longer than 200 characters');
    if (value.length > 200) return refuse('value is longer than 200 characters');
    const analyteKey = base.analyteKey;
    // Every date of the row identifies it: the collected (or unknown-kind) date and the result date. Only a
    // day-precision date can identify a repeat; two results in the same month or year may both be real.
    const dated: Array<{ raw: string; pd: PartialDate }> = [];
    if (dateRaw) dated.push({ raw: dateRaw, pd });
    if (resRaw) dated.push({ raw: resRaw, pd: pr });
    const dayKeys: string[] = [];
    for (const x of dated) {
      if (x.pd.precision === 'day') {
        const key = labDedupKey(analyteKey, sp.specimen, x.pd.iso!, value, unit);
        if (onFile.has(key)) return refuse('already on file (the same analyte, specimen, date, value and unit)');
        dayKeys.push(key);
      } else if (onFile.has(labDedupKey(analyteKey, sp.specimen, `as written:${x.raw.trim()}`, value, unit))) {
        return refuse('already on file (the same analyte, specimen, value, unit and date as written)');
      }
    }
    for (const key of dayKeys) {
      const twin = inFile.get(key);
      if (twin) return refuse(`same result as row ${twin}`);
    }
    for (const key of dayKeys) inFile.set(key, n);
    if (dateRaw && pd.precision !== 'day') warnings.push(`${dateIsCollected ? 'collected' : 'dated'} ${pd.precision === 'month' ? 'in a month' : 'in a year'} only (${pd.iso}); stored at that precision`);
    if (resRaw && pr.precision !== 'day') warnings.push(`resulted ${pr.precision === 'month' ? 'in a month' : 'in a year'} only (${pr.iso}); stored at that precision`);
    // The parsed projection of migration 0004 (rules 1-7), written with the row; the printed text stays in the row's own columns.
    const projection = projectReading(reading, {
      rawSource: 'csv',
      parsedFrom: 'raw',
      rawFrom: { column: dateHeader ?? resultedHeader },
      dateKind: hasDate ? (dateIsCollected ? 'collected' : 'unknown') : null,
    });
    // A cell of an "Interpretation" column is the file's judgement, recorded as such beside the flag as written.
    if (interpretationColumn && fl.flagRaw?.trim()) projection.parseJson = JSON.stringify({ ...JSON.parse(projection.parseJson ?? '{}'), flagFrom: 'interpretation column' });
    toWrite.push({ row, insert: { ...base, ...projection }, reading });
  });

  const ids: string[] = [];
  if (!dryRun && toWrite.length) {
    d.transaction(() => {
      for (const w of toWrite) {
        try {
          d.transaction(() => {
            d.insert(schema.labResults).values(w.insert).run();
            const r = w.insert;
            indexEntity('lab', r.id, `${r.analyte} ${w.reading.valueShown}${r.unit ? ` ${r.unit}` : ''}`.trim(), [SPECIMEN_LABELS[r.specimen ?? 'serum'] ?? r.specimen, r.labName, r.flag, r.collectedAt ?? r.resultedAt, r.notes].filter(Boolean).join(' · '));
          });
          ids.push(w.insert.id);
        } catch (err) {
          w.row.status = 'skip';
          w.row.reason = err instanceof Error ? err.message : String(err);
        }
      }
    });
  }
  const { skipped, warnings } = finish(rows);
  return { target: 'labs', filename, dryRun, imported: rows.filter((r) => r.status === 'import').length, skipped, warnings, fileNotes, columns, rows, ids };
}

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

type CommField = 'date' | 'direction' | 'channel' | 'with' | 'subject' | 'summary' | 'outcome' | 'follow_up' | 'follow_up_due' | 'topics';
type CommDirection = (typeof COMM_DIRECTIONS)[number];
type CommChannel = (typeof COMM_CHANNELS)[number];
type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const COMM_COLUMNS: Record<CommField, string[]> = {
  date: ['when', 'occurred', 'occurred at', 'occurred on', 'date time', 'datetime', 'day'],
  direction: ['dir', 'in out', 'inbound outbound'],
  channel: ['type', 'method', 'medium', 'via', 'how'],
  with: ['who', 'people', 'person', 'participants', 'participant', 'contact', 'contacts', 'names', 'name', 'from to'],
  subject: ['title', 're', 'regarding', 'about'],
  summary: ['notes', 'note', 'details', 'body', 'description', 'what was said'],
  outcome: ['result', 'resolution'],
  follow_up: ['followup', 'follow up promised', 'promised', 'promise', 'next step', 'next steps'],
  follow_up_due: ['followup due', 'due', 'due date', 'follow up by', 'due by'],
  topics: ['topic', 'tags', 'tag'],
};

/** Words for a direction, by normalised text (the enum values themselves are always accepted). */
const DIRECTION_WORDS: Record<string, CommDirection> = {
  in: 'inbound',
  incoming: 'inbound',
  received: 'inbound',
  from: 'inbound',
  'from them': 'inbound',
  reply: 'inbound',
  out: 'outbound',
  outgoing: 'outbound',
  sent: 'outbound',
  to: 'outbound',
  'to them': 'outbound',
  note: 'internal',
  self: 'internal',
  both: 'bidirectional',
  'two way': 'bidirectional',
  mutual: 'bidirectional',
  'in out': 'bidirectional',
  conversation: 'bidirectional',
};

/** Words for a channel, by normalised text (the enum values themselves are always accepted). */
const CHANNEL_WORDS: Record<string, CommChannel> = {
  mychart: 'portal',
  'my chart': 'portal',
  message: 'portal',
  'portal message': 'portal',
  'patient portal': 'portal',
  phone: 'call',
  'phone call': 'call',
  telephone: 'call',
  voicemail: 'call',
  vm: 'call',
  'e mail': 'email',
  mail: 'letter',
  post: 'letter',
  'in person': 'visit',
  'office visit': 'visit',
  appointment: 'visit',
  appt: 'visit',
  sms: 'text',
  'text message': 'text',
  telehealth: 'video',
  zoom: 'video',
  'video call': 'video',
  teams: 'video',
};

/** A cell read against an enum: its value, or null when the text is not understood; `empty` when the cell is blank. */
function readWord<T extends string>(raw: string, words: Record<string, T>, allowed: readonly T[]): { value: T | null; empty: boolean } {
  const k = normalizeKey(raw);
  if (!k) return { value: null, empty: true };
  if ((allowed as readonly string[]).includes(k)) return { value: k as T, empty: false };
  return { value: words[k] ?? null, empty: false };
}

/** A name without honorifics or degrees, normalised: "Dr. Jane Smith, MD" -> "jane smith". */
export function personKey(name: string): string {
  return normalizeKey(name)
    .split(' ')
    .filter((w) => w && !PERSON_TITLES.has(w))
    .join(' ');
}

function isTitleOnly(part: string): boolean {
  const words = normalizeKey(part).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => PERSON_TITLES.has(w));
}

/**
 * The names in a `with` cell. Names are separated by ; | / & + a line break
 * or the word "and", and by commas, except that a degree after a comma stays
 * with its name ("Jane Smith, MD") and "Smith, Jane" is read as one name,
 * "Jane Smith", when a person of that name is on file (`isKnown`); otherwise
 * it is two names, so nobody is merged by a guess.
 */
export function splitNames(cell: string, isKnown: (name: string) => boolean = () => false): string[] {
  const t = cell.trim();
  if (!t) return [];
  const out: string[] = [];
  for (const chunk of t.split(/\s*(?:[;|\n\r/&+]|\band\b)\s*/i)) {
    const c = chunk.trim();
    if (!c) continue;
    const parts = c.split(/\s*,\s*/).filter(Boolean);
    if (parts.length === 2 && !/\s/.test(parts[0]) && !isTitleOnly(parts[1]) && isKnown(`${parts[1]} ${parts[0]}`)) {
      out.push(`${parts[1]} ${parts[0]}`);
      continue;
    }
    const merged: string[] = [];
    for (const p of parts) {
      if (merged.length && isTitleOnly(p)) merged[merged.length - 1] += `, ${p}`;
      else merged.push(p);
    }
    out.push(...merged.filter((m) => !isTitleOnly(m)));
  }
  const seen = new Set<string>();
  return out.filter((n) => {
    const k = nameKey(n);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const CLINICIAN_WORDS = new Set(['dr', 'doctor', 'md', 'do', 'np', 'pa', 'pac', 'rn', 'aprn', 'dnp', 'fnp', 'mbbs', 'nurse', 'physician', 'neurologist', 'rheumatologist', 'immunologist', 'pcp']);
const ORG_WORDS = new Set([
  'hospital', 'hospitals', 'center', 'centre', 'health', 'healthcare', 'medical', 'medicine', 'university', 'institute', 'laboratory', 'laboratories', 'lab', 'labs',
  'pharmacy', 'insurance', 'insurer', 'associates', 'group', 'practice', 'department', 'dept', 'services', 'system', 'inc', 'llc', 'pllc', 'foundation', 'office',
]);

/** The kind a person created from a name gets: clinic, institution, clinician (a title or degree), else other. */
export function guessPersonKind(name: string): PersonKind {
  const words = normalizeKey(name).split(' ');
  if (words.some((w) => w === 'clinic' || w === 'clinics')) return 'clinic';
  if (words.some((w) => ORG_WORDS.has(w))) return 'institution';
  if (words.some((w) => CLINICIAN_WORDS.has(w))) return 'clinician';
  return 'other';
}

interface PersonLite {
  id: string;
  name: string;
  kind: string;
}

interface PeopleIndex {
  byId: Map<string, PersonLite>;
  /** personKey of every name and alias -> the people carrying it. */
  byKey: Map<string, Array<{ person: PersonLite; via: 'exact' | 'alias' }>>;
  candidates: MatchCandidate[];
}

function loadPeopleIndex(): PeopleIndex {
  const p = schema.people;
  const rows = db().select({ id: p.id, name: p.name, kind: p.kind, aliasesJson: p.aliasesJson }).from(p).where(isNull(p.deletedAt)).all();
  const byId = new Map<string, PersonLite>();
  const byKey: PeopleIndex['byKey'] = new Map();
  const add = (key: string, person: PersonLite, via: 'exact' | 'alias') => {
    if (!key) return;
    const list = byKey.get(key) ?? [];
    if (!list.some((x) => x.person.id === person.id)) list.push({ person, via });
    byKey.set(key, list);
  };
  for (const r of rows) {
    const person = { id: r.id, name: r.name, kind: r.kind };
    byId.set(r.id, person);
    add(personKey(r.name), person, 'exact');
    const aliases = parseJson<unknown>(r.aliasesJson, []);
    if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string') add(personKey(a), person, 'alias');
  }
  return { byId, byKey, candidates: loadCandidates() };
}

/** The one person whose name or alias is this name (titles aside); several are reported, not guessed. */
function exactPerson(name: string, idx: PeopleIndex): { person: PersonLite | null; via: 'exact' | 'alias' | null; ambiguous: string[] } {
  const list = idx.byKey.get(personKey(name)) ?? [];
  if (list.length === 1) return { person: list[0].person, via: list[0].via, ambiguous: [] };
  const byName = list.filter((x) => x.via === 'exact');
  if (byName.length === 1) return { person: byName[0].person, via: 'exact', ambiguous: [] };
  return { person: null, via: null, ambiguous: list.map((x) => x.person.name) };
}

export type NameAction = 'match' | 'create' | 'none';

/** One distinct name of the `with` column and what the import does with it. */
export interface CommCsvName {
  /** The decision key (the name lower-cased, spaces collapsed); `map` takes it. */
  key: string;
  /** The name as first written in the file. */
  name: string;
  /** match: linked to a person on file; create: a new person; none: left out (named in the summary). */
  action: NameAction;
  personId: string | null;
  personName: string | null;
  personKind: string | null;
  /** How the person was found: the exact name, an alias, word overlap (fuzzy), or chosen in the preview. */
  via: 'exact' | 'alias' | 'fuzzy' | 'chosen' | null;
  /** fuzzy: the share of the person's name found in the text. */
  score: number | null;
  /** People who fit the name equally well; none of them is picked. */
  ambiguous: string[];
  /** The kind a person created for this name gets. */
  newKind: PersonKind;
  /** Rows (1-based) naming them. */
  rows: number[];
  note: string | null;
}

function resolveName(name: string, idx: PeopleIndex, decisions: Map<string, string>, createPeople: boolean): CommCsvName {
  const key = nameKey(name);
  const base: CommCsvName = { key, name, action: 'none', personId: null, personName: null, personKind: null, via: null, score: null, ambiguous: [], newKind: guessPersonKind(name), rows: [], note: null };
  const chosen = decisions.get(key);
  if (chosen === 'none') return { ...base, via: 'chosen', note: 'left out in the preview' };
  if (chosen === 'new') return { ...base, action: 'create', via: 'chosen' };
  if (chosen) {
    const p = idx.byId.get(chosen);
    if (p) return { ...base, action: 'match', personId: p.id, personName: p.name, personKind: p.kind, via: 'chosen' };
    base.note = 'the person chosen in the preview is no longer on file';
  }
  const exact = exactPerson(name, idx);
  if (exact.person) return { ...base, action: 'match', personId: exact.person.id, personName: exact.person.name, personKind: exact.person.kind, via: exact.via };
  const fuzzy = exact.ambiguous.length ? { match: null, ambiguous: exact.ambiguous } : bestMatch(name, idx.candidates);
  if (fuzzy.match) return { ...base, action: 'match', personId: fuzzy.match.id, personName: fuzzy.match.name, personKind: fuzzy.match.kind, via: 'fuzzy', score: fuzzy.match.score };
  if (fuzzy.ambiguous.length) return { ...base, ambiguous: fuzzy.ambiguous, note: `fits ${fuzzy.ambiguous.join(' and ')} equally; choose one in the preview` };
  return createPeople ? { ...base, action: 'create' } : { ...base, note: base.note ?? 'nobody on file by this name' };
}

/** The participant role a direction implies: inbound people wrote, outbound people were written to, otherwise present. */
function roleFor(direction: CommDirection): ParticipantRole {
  return direction === 'inbound' ? 'from' : direction === 'outbound' ? 'to' : 'present';
}

export interface CommCsvParticipant {
  key: string;
  name: string;
  action: NameAction;
  personId: string | null;
  personName: string | null;
  role: ParticipantRole;
}

export interface CommCsvRow extends CsvRowBase {
  direction: CommDirection | null;
  channel: CommChannel | null;
  subject: string;
  /** The summary cell as written. */
  body: string | null;
  outcome: string | null;
  followUp: string | null;
  followUpDue: string | null;
  topics: string[];
  participants: CommCsvParticipant[];
}

export interface CommCsvResult extends CsvResultBase<CommCsvRow> {
  target: 'communications';
  createPeople: boolean;
  /** Every distinct name in the rows that would be written, with its decision. */
  names: CommCsvName[];
  /** People created by this import (empty on a dry run). */
  createdPeople: Array<{ id: string; name: string; kind: string }>;
  /** Ids of the communications written (empty on a dry run). */
  ids: string[];
}

/** Communications from a CSV; see the file header. */
export function importCommunicationsCsv(text: string, opts: CsvOptions = {}): CommCsvResult {
  const dryRun = Boolean(opts.dryRun);
  const filename = opts.filename?.trim() || null;
  const createPeople = Boolean(opts.createPeople);
  const { headers, records } = readTable(text);
  const { fields, columns } = mapColumns(headers, COMM_COLUMNS);
  const missing: string[] = [];
  if (!fields.has('date')) missing.push('date');
  if (!fields.has('subject') && !fields.has('summary')) missing.push('subject (or summary)');
  if (missing.length) throw badRequest(`the communications CSV needs the column${missing.length === 1 ? '' : 's'} ${missing.join(' and ')} (it has ${headers.join(', ')})`);
  const fileNotes: string[] = [];
  if (!fields.has('direction')) fileNotes.push('no direction column: every row is recorded as outbound');
  if (!fields.has('channel')) fileNotes.push('no channel column: every row is recorded as other');
  if (!fields.has('with')) fileNotes.push('no with column: no one is linked to these communications');
  const exclude = new Set(opts.exclude ?? []);
  const decisions = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.map ?? {})) if (typeof v === 'string' && v.trim()) decisions.set(nameKey(k), v.trim());
  const latest = latestLoggableDay();
  const source = `Imported from ${filename ?? 'a CSV file'}`;
  const d = db();
  const idx = loadPeopleIndex();

  const keyOf = (date: string | null, subject: string, direction: string, channel: string) => [date ?? '', normalizeKey(subject), direction, channel].join('|');
  const c = schema.communications;
  const onFile = new Set<string>();
  for (const r of d.select({ occurredAt: c.occurredAt, occurredAtText: c.occurredAtText, subject: c.subject, direction: c.direction, channel: c.channel }).from(c).where(isNull(c.deletedAt)).all()) {
    onFile.add(keyOf(r.occurredAt, r.subject, r.direction, r.channel));
    if (r.occurredAtText) onFile.add(keyOf(`as written:${r.occurredAtText.trim()}`, r.subject, r.direction, r.channel));
  }
  const inFile = new Map<string, number>();
  const names = new Map<string, CommCsvName>();
  const nameFor = (raw: string): CommCsvName => {
    const k = nameKey(raw);
    let n = names.get(k);
    if (!n) {
      n = resolveName(raw, idx, decisions, createPeople);
      names.set(k, n);
    }
    return n;
  };
  const isKnown = (n: string) => exactPerson(n, idx).person !== null;

  const rows: CommCsvRow[] = [];
  const toWrite: Array<{ row: CommCsvRow; input: CommunicationInput }> = [];
  records.forEach((rec, i) => {
    const n = i + 1;
    const cell = (f: CommField) => cellOf(rec, fields, f);
    const dateRaw = cell('date');
    const pd = readDateCell(dateRaw);
    const warnings: string[] = [];
    const dir = readWord(cell('direction'), DIRECTION_WORDS, COMM_DIRECTIONS);
    const ch = readWord(cell('channel'), CHANNEL_WORDS, COMM_CHANNELS);
    const direction: CommDirection | null = dir.value ?? (dir.empty ? 'outbound' : null);
    const channel: CommChannel | null = ch.value ?? (ch.empty ? 'other' : null);
    const bodyCell = cell('summary');
    let subject = cell('subject');
    const dueRaw = cell('follow_up_due');
    const due = readDateCell(dueRaw);
    const withCell = cell('with');
    const row: CommCsvRow = {
      row: n,
      status: 'import',
      reason: null,
      warnings,
      date: pd.iso,
      datePrecision: pd.precision,
      dateText: dateRaw || null,
      summary: `${subject || bodyCell.split(/\r?\n/)[0] || '(no subject)'}${withCell ? ` · ${withCell}` : ''}`,
      cells: cellsOf(rec, headers),
      direction,
      channel,
      subject,
      body: bodyCell || null,
      outcome: cell('outcome') || null,
      followUp: cell('follow_up') || null,
      followUpDue: due.iso,
      topics: cell('topics')
        .split(/[;,|]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => clip(t, 120))
        .slice(0, 100),
      participants: [],
    };
    rows.push(row);
    const refuse = (reason: string) => {
      row.status = 'skip';
      row.reason = reason;
    };
    if (exclude.has(n)) {
      row.status = 'excluded';
      row.reason = LEFT_OUT;
      return;
    }
    const extra = extraCells(rec);
    if (extra.length) return refuse(extraCellsReason(extra.length));
    if (!subject && !bodyCell) return refuse('missing subject and summary');
    if (!direction) return refuse(`direction "${cell('direction')}" is not one of ${COMM_DIRECTIONS.join(', ')}`);
    if (!channel) return refuse(`channel "${cell('channel')}" is not one of ${COMM_CHANNELS.join(', ')}`);
    if (dateRaw && !pd.iso) return refuse(`date "${dateRaw}" could not be read`);
    if (pd.iso && pd.iso > latest) return refuse(`date ${pd.iso} is in the future`);
    if (dueRaw && !due.iso) return refuse(`follow_up_due "${dueRaw}" could not be read`);
    if (!subject) {
      subject = clip(bodyCell.split(/\r?\n/)[0].trim(), 120);
      row.subject = subject;
      warnings.push('no subject; the first line of the summary is used');
    }
    if (subject.length > 500) {
      subject = clip(subject, 500);
      row.subject = subject;
      warnings.push('subject cut to 500 characters');
    }
    if (dir.empty && fields.has('direction')) warnings.push('direction not given; recorded as outbound');
    if (ch.empty && fields.has('channel')) warnings.push('channel not given; recorded as other');
    if (!dateRaw) warnings.push('no date; recorded undated');
    else if (pd.precision !== 'day') warnings.push(`dated ${pd.precision === 'month' ? 'to the month' : 'to the year'} only (${pd.iso})`);
    if (due.iso && !row.followUp) {
      row.followUp = `Follow up: ${clip(subject, 200)}`;
      warnings.push('a follow_up_due without a follow_up; recorded as "Follow up: <subject>"');
    }
    if (bodyCell.length > 18_000) warnings.push('summary cut to 18 000 characters');
    if (dateRaw && writtenFinerThanRead(dateRaw, pd)) return refuse(`date "${dateRaw}" names a day but could only be read as ${pd.iso ?? 'nothing'}; write it as YYYY-MM-DD`);
    const key = keyOf(pd.iso, subject, direction, channel);
    if (pd.precision !== 'day' && dateRaw && onFile.has(keyOf(`as written:${dateRaw.trim()}`, subject, direction, channel))) {
      return refuse('already on file (the same subject, direction, channel and date as written)');
    }
    if (pd.precision === 'day') {
      if (onFile.has(key)) return refuse('already on file (the same date, subject, direction and channel)');
      const twin = inFile.get(key);
      if (twin) return refuse(`same communication as row ${twin}`);
      inFile.set(key, n);
    }

    const role = roleFor(direction);
    const listed = withCell ? (isKnown(withCell) ? [withCell] : splitNames(withCell, isKnown)) : [];
    const leftOut: string[] = [];
    for (const nm of listed) {
      const r = nameFor(nm);
      if (!r.rows.includes(n)) r.rows.push(n);
      row.participants.push({ key: r.key, name: nm, action: r.action, personId: r.personId, personName: r.personName, role });
      if (r.action === 'none') leftOut.push(nm);
    }
    if (leftOut.length) warnings.push(`${leftOut.join(', ')} not linked to a person (named in the summary)`);
    const toCreate = row.participants.filter((p) => p.action === 'create');
    if (toCreate.length) warnings.push(`${dryRun ? 'would add' : 'adds'} ${toCreate.map((p) => p.name).join(', ')} to people`);
    const bodyText = [clip(bodyCell, 18_000), leftOut.length ? `Also with (not linked to a person): ${leftOut.join(', ')}` : '', `${source}, row ${n}.`].filter(Boolean).join('\n\n');
    toWrite.push({
      row,
      input: {
        occurredAt: pd.iso,
        occurredAtText: dateRaw ? clip(dateRaw, 200) : null,
        direction,
        channel,
        subject,
        summary: bodyText,
        outcome: row.outcome ? clip(row.outcome, 20_000) : null,
        followUpPromised: row.followUp ? clip(row.followUp, 2000) : null,
        followUpDue: due.iso,
        topics: row.topics,
        participants: [],
      },
    });
  });

  const ids: string[] = [];
  const createdPeople: CommCsvResult['createdPeople'] = [];
  if (!dryRun && toWrite.length) {
    const made = new Map<string, PersonLite>();
    d.transaction(() => {
      for (const w of toWrite) {
        // People created for this row only count once the row is written: a refused row rolls them back with it.
        const pending = new Map<string, PersonLite>();
        try {
          d.transaction(() => {
            const participants: Array<{ personId: string; role: ParticipantRole }> = [];
            for (const p of w.row.participants) {
              if (p.action === 'match' && p.personId) participants.push({ personId: p.personId, role: p.role });
              else if (p.action === 'create') {
                let person = made.get(p.key) ?? pending.get(p.key);
                if (!person) {
                  const kind = names.get(p.key)?.newKind ?? 'other';
                  const created = createPerson({ name: clip(p.name, 300), kind, notes: `Added by the communications import from ${filename ?? 'a CSV file'} (row ${w.row.row}).` });
                  person = { id: created.id, name: created.name, kind: created.kind };
                  pending.set(p.key, person);
                }
                participants.push({ personId: person.id, role: p.role });
              }
            }
            const comm = createCommunication({ ...w.input, participants });
            ids.push(comm.id);
          });
          for (const [k, v] of pending) {
            made.set(k, v);
            createdPeople.push(v);
          }
          for (const p of w.row.participants) {
            const person = p.action === 'create' ? made.get(p.key) : undefined;
            if (person) {
              p.personId = person.id;
              p.personName = person.name;
            }
          }
        } catch (err) {
          w.row.status = 'skip';
          w.row.reason = err instanceof Error ? err.message : String(err);
        }
      }
    });
    for (const n of names.values()) {
      const person = n.action === 'create' ? made.get(n.key) : undefined;
      if (person) {
        n.personId = person.id;
        n.personName = person.name;
        n.personKind = person.kind;
      }
    }
  }
  const { skipped, warnings } = finish(rows);
  const nameList = [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    target: 'communications',
    filename,
    dryRun,
    imported: rows.filter((r) => r.status === 'import').length,
    skipped,
    warnings,
    fileNotes,
    columns,
    rows,
    createPeople,
    names: nameList,
    createdPeople,
    ids,
  };
}

// ---------------------------------------------------------------------------
// Symptoms (delegated to the symptoms service)
// ---------------------------------------------------------------------------

type SymptomParsedRow = ParsedCsv['rows'][number];

export interface SymptomCsvRow extends CsvRowBase {
  scores: Record<string, number>;
  sleepHours: number | null;
  sleepQuality: number | null;
  energy: number | null;
  notes: string | null;
  tags: string[];
}

export interface SymptomCsvResult extends CsvResultBase<SymptomCsvRow> {
  target: 'symptoms';
  /** Scores written (or that would be). */
  entries: number;
  /** Symptom definitions created or reactivated (or that would be). */
  created: string[];
  /** Values already in the log that the file replaces with a different one. */
  overwritten: ImportOverwrite[];
}

const EXCLUDED_DATE = 'left out';

/**
 * The CSV with the date cell of every excluded row replaced by a word the
 * symptoms importer refuses, so it skips those rows without renumbering the
 * others (blanking a row would let the parser drop it as an empty line).
 */
function markExcluded(text: string, exclude: Set<number>, dateHeader: string): string {
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy' });
  const data = res.data;
  if (!data.length) return text;
  const at = data[0].findIndex((h) => String(h ?? '').trim() === dateHeader);
  if (at < 0) return text;
  for (let i = 1; i < data.length; i++) if (exclude.has(i)) data[i][at] = EXCLUDED_DATE;
  return Papa.unparse(data);
}

function describeDay(p: SymptomParsedRow): string {
  const parts = Object.entries(p.scores).map(([h, v]) => `${h} ${v}`);
  if (p.sleepHours !== undefined) parts.push(`sleep ${p.sleepHours} h`);
  if (p.sleepQuality !== undefined) parts.push(`sleep quality ${p.sleepQuality}`);
  if (p.energy !== undefined) parts.push(`energy ${p.energy}`);
  if (p.tags?.length) parts.push(`tags ${p.tags.join(', ')}`);
  if (p.notes) parts.push(`notes "${clip(p.notes, 60)}"`);
  return parts.join(' · ');
}

/**
 * Symptom days from a CSV through the symptoms service's own importer (the
 * same columns, the same dry run and the same list of overwritten values),
 * with rows left out of the preview and a row-by-row account added.
 */
export function importSymptomsCsv(text: string, opts: CsvOptions = {}): SymptomCsvResult {
  const dryRun = Boolean(opts.dryRun);
  const filename = opts.filename?.trim() || null;
  const { headers, records } = readTable(text);
  const clean = text.replace(/^﻿/, '');
  const exclude = new Set(opts.exclude ?? []);
  // A row with cells past the last header is read shifted by the symptoms parser too: refuse it here.
  const shifted = new Map<number, number>();
  records.forEach((rec, i) => {
    const n = extraCells(rec).length;
    if (n) shifted.set(i + 1, n);
  });
  const leaveOut = new Set([...exclude, ...shifted.keys()]);
  const symptomNames = db()
    .select({ name: schema.symptomDefinitions.name })
    .from(schema.symptomDefinitions)
    .all()
    .map((r) => r.name);
  const first = parseSymptomCsv(clean, { symptomNames });
  if (first.error) throw badRequest(first.error);
  const dateHeader = Object.entries(first.columns).find(([, f]) => f === 'date')?.[0] ?? null;
  const source = leaveOut.size && dateHeader ? markExcluded(clean, leaveOut, dateHeader) : clean;
  const parsed = source === clean ? first : parseSymptomCsv(source, { symptomNames });
  const result = importSymptomCsv(source, { dryRun });

  const byRow = new Map(parsed.rows.map((r) => [r.row, r]));
  const skipReason = new Map(result.skipped.map((s) => [s.row, s.reason]));
  const overByDate = new Map<string, ImportOverwrite[]>();
  for (const o of result.overwritten) overByDate.set(o.date, [...(overByDate.get(o.date) ?? []), o]);
  const rows: SymptomCsvRow[] = records.map((rec, i) => {
    const n = i + 1;
    const p = byRow.get(n);
    const dateRaw = dateHeader ? String(rec[dateHeader] ?? '').trim() : '';
    const pd = parsePartialDate(dateRaw);
    const cells = cellsOf(rec, headers);
    const excluded = exclude.has(n);
    const forced = !excluded && shifted.has(n);
    return {
      row: n,
      status: excluded ? 'excluded' : forced || !p ? 'skip' : 'import',
      reason: excluded ? LEFT_OUT : forced ? extraCellsReason(shifted.get(n) ?? 1) : p ? null : (skipReason.get(n) ?? 'skipped'),
      warnings: p && !forced ? (overByDate.get(p.date) ?? []).map((o) => `replaces ${o.field} ${o.from} with ${o.to}`) : [],
      date: pd.iso,
      datePrecision: pd.precision,
      dateText: dateRaw || null,
      summary: p
        ? describeDay(p)
        : Object.entries(cells)
            .filter(([h]) => h !== dateHeader)
            .map(([h, v]) => `${h} ${clip(v, 40)}`)
            .join(' · '),
      cells,
      scores: p?.scores ?? {},
      sleepHours: p?.sleepHours ?? null,
      sleepQuality: p?.sleepQuality ?? null,
      energy: p?.energy ?? null,
      notes: p?.notes ?? null,
      tags: p?.tags ?? [],
    };
  });
  const { skipped, warnings } = finish(rows);
  const fileNotes = Object.entries(result.columns)
    .filter(([, f]) => f === 'ignored')
    .map(([h]) => `column "${h}" is ignored (a second column for a daily-log field)`);
  return {
    target: 'symptoms',
    filename,
    dryRun,
    imported: result.imported,
    skipped,
    warnings,
    fileNotes,
    columns: result.columns,
    rows,
    entries: result.entries,
    created: result.created,
    overwritten: result.overwritten,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type CsvImportResult = SymptomCsvResult | LabCsvResult | CommCsvResult;

export const csvTargetSchema = z.enum(CSV_TARGETS);

/** One CSV into the chosen ledger; `dryRun` writes nothing. */
export function importCsvFile(target: string, text: string, opts: CsvOptions = {}): CsvImportResult {
  const t = csvTargetSchema.safeParse(target);
  if (!t.success) throw badRequest(`target must be one of ${CSV_TARGETS.join(', ')}`);
  if (t.data === 'symptoms') return importSymptomsCsv(text, opts);
  if (t.data === 'labs') return importLabsCsv(text, opts);
  return importCommunicationsCsv(text, opts);
}
