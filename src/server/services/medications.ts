/**
 * Medications, medication events, intolerances, the emergency card, and the
 * medication timeline other ledgers overlay on their charts.
 *
 * Provenance: a medication or intolerance may carry `sourceFactId` (the fact
 * it was accepted from) and every event may carry one too, so the UI can walk
 * from a row to the cited passage. Nothing here calls the model; proposals
 * come from facts that already exist.
 *
 * Soft delete (`deleted_at`) for medications, intolerances and medication
 * events; every reader here filters it. Removing an event never changes the
 * medication row or its facts.
 */
import { z } from 'zod';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { badRequest, notFound } from '../util/errors';
import { indexEntity, removeEntityIndex } from './search';
import { parseInput } from './communications';
import { getSetting } from './settings';
import { loadPeopleIndex } from './facts';
import { hasSubject, subjectKey as factSubjectKey } from './dedup';
import { INTOLERANCE_KINDS, INTOLERANCE_SEVERITIES, MED_EVENT_KINDS, MED_STATUSES } from '../../shared/enums';
import { dateSortKey, parsePartialDate, type DatePrecision } from '../../shared/dates';
import type { ChartBand, ChartMarker, ChartTone } from '../../shared/chart';
import type { MedicationSettled } from '../../shared/notes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MedicationRow = typeof schema.medications.$inferSelect;
export type MedicationInsert = typeof schema.medications.$inferInsert;
export type MedicationEventRow = typeof schema.medicationEvents.$inferSelect;
export type IntoleranceRow = typeof schema.intolerances.$inferSelect;
export type IntoleranceInsert = typeof schema.intolerances.$inferInsert;

export type MedStatus = (typeof MED_STATUSES)[number];
export type MedEventKind = (typeof MED_EVENT_KINDS)[number];

/** Statuses that count as "current" (shown on the Current view and the emergency card). */
export const CURRENT_STATUSES: readonly MedStatus[] = ['active', 'prn', 'planned'];

/** The fact a row or event was accepted from, with its first (preferably verified) citation. */
export interface SourceFactRef {
  id: string;
  type: string;
  statement: string;
  status: string;
  /** The user's basis for their answer (accurate, inferred, unsure, correction), when they gave one. */
  verdictBasis: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
  deleted: boolean;
  citation: { citationId: string; documentId: string; pageNumber: number; quote: string; verified: boolean } | null;
}

/** A medication row as the list query reads it (before its start is read, see StartReading). */
export interface MedicationRowItem extends MedicationRow {
  prescriberName: string | null;
  eventCount: number;
  lastEventAt: string | null;
  /** Status of the fact the row was accepted from (null when entered by hand or the fact is gone). */
  sourceFactStatus: string | null;
  /** The user's basis for their answer on that fact, when they gave one. */
  sourceFactBasis: string | null;
}

/**
 * How far the row's start date can be trusted, read without changing the row (2026-10-06). Before that day a
 * medication filed from a document that only mentioned the drug (a medication list, a note) took the document's date as
 * its start; such a start is not a start.
 */
export interface StartReading {
  /**
   * True when the row's start was stated: by the document (its start_date), by hand, or by a start line. False when
   * the row has no start, or its start is only the date of the document that mentioned the drug (and nobody changed
   * the row since; when unsure it reads as recorded).
   */
  startRecorded: boolean;
  /** The earliest date the records place the drug: its source detail's date, its live history lines, its recorded start. */
  firstSeen: string | null;
  firstSeenPrecision: string;
}

export interface MedicationListItem extends MedicationRowItem, StartReading {
  /**
   * The settled timeline of the drug (My notes, 2026-10-09; services/med-timeline.ts), once the user answered something on
   * it: the start and stop with who said them. The row's own dates are unchanged; null otherwise.
   */
  settled?: MedicationSettled | null;
}

export interface MedicationEventItem extends MedicationEventRow {
  sourceFact: SourceFactRef | null;
}

export interface MedicationDetail extends MedicationListItem {
  events: MedicationEventItem[];
  sourceFact: SourceFactRef | null;
}

export interface IntoleranceItem extends IntoleranceRow {
  sourceFact: SourceFactRef | null;
}

export interface MedicationTimelineEvent {
  id: string;
  kind: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  detail: string | null;
  dose: string | null;
  sourceFactId: string | null;
}

export interface MedicationTimelineItem extends StartReading {
  medicationId: string;
  name: string;
  status: string;
  /** The row's start as stored; see startRecorded before reading it as when the drug was started. */
  start: string | null;
  startPrecision: string;
  startText: string | null;
  stop: string | null;
  stopPrecision: string;
  stopText: string | null;
  prescriberName: string | null;
  events: MedicationTimelineEvent[];
  /** Set when the start and stop above are the settled timeline's (with who said them), not the row's own. */
  settled?: MedicationSettled | null;
}

export interface EmergencyCardDiagnosis {
  id: string;
  statement: string;
  name: string | null;
  certainty: string | null;
  statedBy: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
}

export interface EmergencyCardContact {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionName: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  portal: string | null;
}

export interface EmergencyCard {
  patient: { name: string; dob: string; bloodType: string; emergencyContacts: string; emergencyContactLines: string[]; summary: string };
  hardStops: IntoleranceItem[];
  intolerances: IntoleranceItem[];
  activeMedications: MedicationListItem[];
  diagnoses: EmergencyCardDiagnosis[];
  keyContacts: EmergencyCardContact[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Validation (services validate; routes pass the raw body)
// ---------------------------------------------------------------------------

/** Optional free text: '' and whitespace become null; undefined stays undefined (not provided). */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null));

/**
 * Field schemas without defaults. The create schema adds them; the patch
 * schema must not (zod 4 keeps an inner `.default()` under `.partial()`,
 * which would reset status on every PATCH).
 */
const medicationFields = {
  name: z.string().trim().min(1, 'name is required').max(300),
  genericName: text(300),
  drugClass: text(300),
  dose: text(100),
  unit: text(50),
  route: text(100),
  frequency: text(200),
  status: z.enum(MED_STATUSES),
  startDate: text(32),
  startDateText: text(200),
  stopDate: text(32),
  stopDateText: text(200),
  prescriberId: text(64),
  indication: text(1000),
  reasonStopped: text(1000),
  effect: text(4000),
  notes: text(20000),
  sourceFactId: text(64),
};
export const medicationInput = z.object({ ...medicationFields, status: medicationFields.status.default('unknown') });
export const medicationPatch = z.object(medicationFields).partial();
export type MedicationInput = z.input<typeof medicationInput>;
export type MedicationPatch = z.input<typeof medicationPatch>;

export const eventInput = z.object({
  kind: z.enum(MED_EVENT_KINDS),
  date: text(32),
  dateText: text(200),
  detail: text(4000),
  dose: text(100),
  sourceFactId: text(64),
});
export type EventInput = z.input<typeof eventInput>;

const intoleranceFields = {
  substance: z.string().trim().min(1, 'substance is required').max(300),
  kind: z.enum(INTOLERANCE_KINDS),
  reaction: text(2000),
  severity: z.enum(INTOLERANCE_SEVERITIES),
  hardStop: z.boolean(),
  date: text(32),
  dateText: text(200),
  notes: text(20000),
  sourceFactId: text(64),
  active: z.boolean(),
};
export const intoleranceInput = z.object({
  ...intoleranceFields,
  kind: intoleranceFields.kind.default('intolerance'),
  severity: intoleranceFields.severity.default('unknown'),
  hardStop: intoleranceFields.hardStop.optional(),
  active: intoleranceFields.active.default(true),
});
export const intolerancePatch = z.object(intoleranceFields).partial();
export type IntoleranceInput = z.input<typeof intoleranceInput>;
export type IntolerancePatch = z.input<typeof intolerancePatch>;

export const listQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export const acceptInput = z.object({
  factId: z.string().min(1),
  /** Attach a medication fact to this existing medication as an event instead of creating a row. */
  medicationId: text(64),
  eventKind: z.enum(MED_EVENT_KINDS).optional(),
  /** Field overrides applied on top of the proposal (same keys as the create inputs). */
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type AcceptInput = z.input<typeof acceptInput>;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

interface Partial3 {
  iso: string | null;
  precision: DatePrecision | string;
  text: string | null;
}

/**
 * An explicit ISO value wins; otherwise the text is parsed; `null` for the
 * ISO clears the date; nothing provided keeps the current value.
 */
function partialFrom(iso: string | null | undefined, textIn: string | null | undefined, current?: Partial3): Partial3 {
  if (iso) {
    const p = parsePartialDate(iso);
    return { iso: p.iso, precision: p.precision, text: textIn ?? current?.text ?? iso };
  }
  if (textIn !== undefined) {
    const p = parsePartialDate(textIn);
    return { iso: p.iso, precision: p.precision, text: p.text };
  }
  if (iso === null) return { iso: null, precision: 'unknown', text: current?.text ?? null };
  return { iso: current?.iso ?? null, precision: current?.precision ?? 'unknown', text: current?.text ?? null };
}

function hasDate(p: Partial3): boolean {
  return Boolean(p.iso || p.text);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function assertPerson(id: string | null | undefined): void {
  if (!id) return;
  const p = db().select({ id: schema.people.id }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get();
  if (!p) throw badRequest('prescriberId does not refer to an existing person');
}

function assertFact(id: string | null | undefined): void {
  if (!id) return;
  const f = db().select({ id: schema.facts.id }).from(schema.facts).where(eq(schema.facts.id, id)).get();
  if (!f) throw badRequest('sourceFactId does not refer to an existing fact');
}

/** The fact behind a row, with its document and first (verified first) citation. */
export function sourceFactRef(factId: string | null | undefined): SourceFactRef | null {
  if (!factId) return null;
  const d = db();
  const f = d
    .select({
      id: schema.facts.id,
      type: schema.facts.type,
      statement: schema.facts.statement,
      status: schema.facts.status,
      verdictBasis: schema.facts.verdictBasis,
      date: schema.facts.date,
      datePrecision: schema.facts.datePrecision,
      dateText: schema.facts.dateText,
      documentId: schema.facts.sourceDocumentId,
      documentTitle: schema.documents.title,
      deletedAt: schema.facts.deletedAt,
    })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(eq(schema.facts.id, factId))
    .get();
  if (!f) return null;
  const c = d
    .select({ id: schema.citations.id, documentId: schema.citations.documentId, pageNumber: schema.citations.pageNumber, quote: schema.citations.quote, verified: schema.citations.verified })
    .from(schema.citations)
    .where(eq(schema.citations.factId, factId))
    .orderBy(desc(schema.citations.verified), asc(schema.citations.pageNumber), asc(schema.citations.createdAt))
    .limit(1)
    .get();
  return {
    id: f.id,
    type: f.type,
    statement: f.statement,
    status: f.status,
    verdictBasis: f.verdictBasis ?? null,
    date: f.date,
    datePrecision: f.datePrecision,
    dateText: f.dateText,
    documentId: f.documentId,
    documentTitle: f.documentTitle ?? null,
    deleted: Boolean(f.deletedAt),
    citation: c ? { citationId: c.id, documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified) } : null,
  };
}

// ---------------------------------------------------------------------------
// Start dates as stated (read honestly; rows are never rewritten)
// ---------------------------------------------------------------------------

/** What reading a row's start needs (any medication row or list item has these). */
export interface StartRow {
  id: string;
  sourceFactId: string | null;
  startDate: string | null;
  startDatePrecision: string;
  startDateText: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SourceFactDates {
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  dateEnd: string | null;
  attributesJson: string;
  deleted: boolean;
}

interface DatedLine {
  date: string;
  precision: string;
  /** The line's kind and the detail it came from (a start line from another detail can record the start). */
  kind?: string;
  sourceFactId?: string | null;
}

const CHUNK = 400;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** The source details' dates and attributes, by fact id (deleted ones too, flagged). One query per 400 ids. */
function sourceFactDates(ids: Array<string | null>): Map<string, SourceFactDates> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, SourceFactDates>();
  const f = schema.facts;
  for (const chunk of chunks(want)) {
    for (const r of db()
      .select({ id: f.id, date: f.date, datePrecision: f.datePrecision, dateText: f.dateText, dateEnd: f.dateEnd, attributesJson: f.attributesJson, deletedAt: f.deletedAt })
      .from(f)
      .where(inArray(f.id, chunk))
      .all())
      out.set(r.id, { date: r.date, datePrecision: r.datePrecision, dateText: r.dateText, dateEnd: r.dateEnd, attributesJson: r.attributesJson, deleted: Boolean(r.deletedAt) });
  }
  return out;
}

/** Dated live history lines per medication. One query per 400 medications. */
function datedLines(medicationIds: string[]): Map<string, DatedLine[]> {
  const out = new Map<string, DatedLine[]>();
  const e = schema.medicationEvents;
  for (const chunk of chunks([...new Set(medicationIds)])) {
    for (const r of db()
      .select({ medicationId: e.medicationId, date: e.date, datePrecision: e.datePrecision, kind: e.kind, sourceFactId: e.sourceFactId })
      .from(e)
      .where(and(inArray(e.medicationId, chunk), isNull(e.deletedAt), sql`${e.date} is not null`))
      .all())
      (out.get(r.medicationId) ?? out.set(r.medicationId, []).get(r.medicationId)!).push({ date: r.date!, precision: r.datePrecision, kind: r.kind, sourceFactId: r.sourceFactId });
  }
  return out;
}

/**
 * The document stated when the drug was started: its start_date, or a range the detail gives (its date is where the
 * range begins). A list's or a note's own date is not a start.
 */
function factStatesStart(f: Pick<SourceFactDates, 'attributesJson' | 'dateEnd'>): boolean {
  return Boolean(clean(parseJson<MedicationAttrs>(f.attributesJson, {}).start_date) || clean(f.dateEnd));
}

function readStartRecorded(m: StartRow, f: SourceFactDates | undefined): boolean {
  if (!m.startDate && !m.startDateText) return false;
  // Entered by hand (or its detail is gone): the start is the user's.
  if (!f) return true;
  if (factStatesStart(f)) return true;
  const onMentionDate = Boolean((m.startDate && f.date && m.startDate === f.date) || (m.startDateText && f.dateText && m.startDateText === f.dateText));
  if (!onMentionDate) return true;
  // The old fallback (the document's date taken as the start), unless the row changed since it was made: the user may
  // have kept that date on purpose, and when unsure the start reads as recorded.
  return m.updatedAt > m.createdAt;
}

function precisionOf(iso: string, stored: string | null | undefined): string {
  if (stored && stored !== 'unknown') return stored;
  return iso.length === 4 ? 'year' : iso.length === 7 ? 'month' : 'day';
}

function earliestOf(candidates: DatedLine[]): DatedLine | null {
  let best: DatedLine | null = null;
  for (const c of candidates) if (!best || dateSortKey(c.date) < dateSortKey(best.date)) best = c;
  return best;
}

/**
 * Start lines that may record a start the row's own detail did not state: live 'start' lines dated on the row's start
 * that came from another detail (a later record that states the start filled it in, see acceptFromFacts).
 */
function startLinesOnStart(m: StartRow, lines: DatedLine[]): DatedLine[] {
  if (!m.startDate) return [];
  return lines.filter((l) => l.kind === 'start' && l.date === m.startDate && l.sourceFactId && l.sourceFactId !== m.sourceFactId);
}

function readOne(m: StartRow, f: SourceFactDates | undefined, lines: DatedLine[], lineFacts: Map<string, SourceFactDates>): StartReading {
  // A start line on the start, from another detail that states the start, records it (a list named the drug first,
  // then a record stated when it was started, on the very day of that list).
  const recorded = readStartRecorded(m, f) || startLinesOnStart(m, lines).some((l) => {
    const lf = lineFacts.get(l.sourceFactId!);
    return Boolean(lf && factStatesStart(lf));
  });
  const candidates: DatedLine[] = [...lines];
  if (f && !f.deleted && f.date) candidates.push({ date: f.date, precision: f.datePrecision });
  if (recorded && m.startDate) candidates.push({ date: m.startDate, precision: m.startDatePrecision });
  const first = earliestOf(candidates);
  return { startRecorded: recorded, firstSeen: first?.date ?? null, firstSeenPrecision: first ? precisionOf(first.date, first.precision) : 'unknown' };
}

/**
 * Read the starts of many rows at once (two queries per 400 rows, never one per row). `lines` may pass the dated live
 * history lines already loaded, by medication id.
 */
export function readStarts(meds: StartRow[], lines?: Map<string, DatedLine[]>): Map<string, StartReading> {
  const out = new Map<string, StartReading>();
  if (!meds.length) return out;
  const facts = sourceFactDates(meds.map((m) => m.sourceFactId));
  const byMed = lines ?? datedLines(meds.map((m) => m.id));
  // The details of start lines that could record a start the row's own detail did not state: read only for the rows
  // that would otherwise read not recorded (one more query per 400 such lines, none when there are none).
  const lineFactIds: string[] = [];
  for (const m of meds) {
    const own = m.sourceFactId ? facts.get(m.sourceFactId) : undefined;
    if (readStartRecorded(m, own)) continue;
    for (const l of startLinesOnStart(m, byMed.get(m.id) ?? [])) lineFactIds.push(l.sourceFactId!);
  }
  const lineFacts = lineFactIds.length ? sourceFactDates(lineFactIds) : new Map<string, SourceFactDates>();
  for (const m of meds) out.set(m.id, readOne(m, m.sourceFactId ? facts.get(m.sourceFactId) : undefined, byMed.get(m.id) ?? [], lineFacts));
  return out;
}

/**
 * The start readings of these medications (live or deleted) by id, read in batches: for a caller that holds only ids
 * (the printed export). Ids with no row are left out.
 */
export function readStartsById(ids: string[]): Map<string, StartReading> {
  const m = schema.medications;
  const rows: StartRow[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    rows.push(
      ...db()
        .select({ id: m.id, sourceFactId: m.sourceFactId, startDate: m.startDate, startDatePrecision: m.startDatePrecision, startDateText: m.startDateText, createdAt: m.createdAt, updatedAt: m.updatedAt })
        .from(m)
        .where(inArray(m.id, chunk))
        .all(),
    );
  }
  return readStarts(rows);
}

/** Whether a row's start was stated (see StartReading.startRecorded). */
export function startRecorded(med: StartRow): boolean {
  return readStarts([med]).get(med.id)!.startRecorded;
}

/** The earliest date the records place a medication, with its precision (see StartReading.firstSeen). */
export function firstSeen(med: StartRow): { date: string | null; precision: string } {
  const r = readStarts([med]).get(med.id)!;
  return { date: r.firstSeen, precision: r.firstSeenPrecision };
}

/**
 * The settled medication timeline (My notes, 2026-10-09): services/med-timeline.ts registers the function that reads it
 * (that module imports this one, so it is not imported back). Null for a drug the user never answered on.
 */
export type MedicationOverlayFn = (row: { name: string; start: string | null; stop: string | null }) => MedicationSettled | null;
let overlayFn: MedicationOverlayFn | null = null;
export function setMedicationOverlay(fn: MedicationOverlayFn | null): void {
  overlayFn = fn;
}
function settledFor(row: { name: string; startDate: string | null; stopDate: string | null }): MedicationSettled | null {
  if (!overlayFn) return null;
  try {
    return overlayFn({ name: row.name, start: row.startDate, stop: row.stopDate });
  } catch {
    return null;
  }
}

function withStarts<T extends StartRow>(rows: T[]): Array<T & StartReading> {
  const starts = readStarts(rows);
  return rows.map((r) => ({ ...r, ...starts.get(r.id)! }));
}

// ---------------------------------------------------------------------------
// Medications: reads
// ---------------------------------------------------------------------------

const prescriber = alias(schema.people, 'prescriber');

/** Correlated subqueries name the outer table explicitly (drizzle renders a bare column inside a subquery). */
const medColumns = {
  ...getTableColumns(schema.medications),
  prescriberName: prescriber.name,
  eventCount: sql<number>`(select count(*) from medication_events me where me.medication_id = medications.id and me.deleted_at is null)`.mapWith(Number),
  lastEventAt: sql<string | null>`(select max(me.date) from medication_events me where me.medication_id = medications.id and me.deleted_at is null)`,
  sourceFactStatus: sql<string | null>`(select sf.status from facts sf where sf.id = medications.source_fact_id and sf.deleted_at is null)`,
  sourceFactBasis: sql<string | null>`(select sf.verdict_basis from facts sf where sf.id = medications.source_fact_id and sf.deleted_at is null)`,
};

function medSelect() {
  return db()
    .select(medColumns)
    .from(schema.medications)
    .leftJoin(prescriber, and(eq(prescriber.id, schema.medications.prescriberId), isNull(prescriber.deletedAt)));
}

const STATUS_RANK = sql`case ${schema.medications.status} when 'active' then 0 when 'prn' then 1 when 'planned' then 2 when 'unknown' then 3 else 4 end`;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listMedications(q: ListQuery = {}): MedicationListItem[] {
  const m = schema.medications;
  const conds: SQL[] = [isNull(m.deletedAt)];
  if (q.status) {
    const statuses = q.status === 'current' ? [...CURRENT_STATUSES] : q.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length) conds.push(inArray(m.status, statuses));
  }
  const needle = (q.q ?? '').trim();
  if (needle) {
    const pat = `%${escapeLike(needle)}%`;
    conds.push(
      or(
        sql`${m.name} like ${pat} escape '\\'`,
        sql`${m.genericName} like ${pat} escape '\\'`,
        sql`${m.drugClass} like ${pat} escape '\\'`,
        sql`${m.indication} like ${pat} escape '\\'`,
        sql`${m.effect} like ${pat} escape '\\'`,
        sql`${m.notes} like ${pat} escape '\\'`,
        sql`${prescriber.name} like ${pat} escape '\\'`,
      )!,
    );
  }
  return withStarts(
    medSelect()
      .where(and(...conds))
      .orderBy(STATUS_RANK, desc(sql`coalesce(${m.startDate}, '')`), sql`${m.name} collate nocase`)
      .all(),
  ).map((r) => ({ ...r, settled: settledFor(r) }));
}

function medRow(id: string): MedicationRowItem {
  const row = medSelect().where(and(eq(schema.medications.id, id), isNull(schema.medications.deletedAt))).get();
  if (!row) throw notFound('medication not found');
  return row;
}

export function listEvents(medicationId: string): MedicationEventItem[] {
  const e = schema.medicationEvents;
  const rows = db()
    .select()
    .from(e)
    .where(and(eq(e.medicationId, medicationId), isNull(e.deletedAt)))
    .orderBy(sql`(${e.date} is null) asc`, asc(e.date), asc(e.createdAt))
    .all();
  return rows.map((r) => ({ ...r, sourceFact: sourceFactRef(r.sourceFactId) }));
}

export function getMedication(id: string): MedicationDetail {
  const [row] = withStarts([medRow(id)]);
  return { ...row, settled: settledFor(row), events: listEvents(id), sourceFact: sourceFactRef(row.sourceFactId) };
}

// ---------------------------------------------------------------------------
// Medications: writes
// ---------------------------------------------------------------------------

/** One searchable line per live history event: kind, date as written, dose and detail ("dose change 2024-03 20 mg · raised for tremor"). */
function historyLines(medicationId: string): string[] {
  const e = schema.medicationEvents;
  return db()
    .select({ kind: e.kind, date: e.date, dateText: e.dateText, dose: e.dose, detail: e.detail })
    .from(e)
    .where(and(eq(e.medicationId, medicationId), isNull(e.deletedAt)))
    .orderBy(sql`(${e.date} is null) asc`, asc(e.date), asc(e.createdAt))
    .all()
    .map((x) => [x.kind.replace(/_/g, ' '), x.dateText ?? x.date, x.dose, x.detail].filter(Boolean).join(' '));
}

/**
 * The search entry: what the drug is, plus the words the user wrote about it
 * (notes, effect, reason stopped) and its history lines, so a note or an event
 * detail finds the medication. Rewritten after every change to the row or its
 * events.
 */
function indexMedication(row: MedicationRowItem): void {
  const body = [row.genericName, row.drugClass, row.dose && row.unit ? `${row.dose} ${row.unit}` : row.dose, row.route, row.frequency, row.status, row.indication, row.prescriberName, row.effect, row.reasonStopped, row.notes, ...historyLines(row.id)]
    .filter(Boolean)
    .join(' · ');
  indexEntity('medication', row.id, row.name, body);
}

/** Re-index a medication after one of its events changed; a deleted (or missing) medication is left out of the index. */
function reindexMedication(medicationId: string): void {
  const row = medSelect().where(and(eq(schema.medications.id, medicationId), isNull(schema.medications.deletedAt))).get();
  if (row) indexMedication(row);
  else removeEntityIndex('medication', medicationId);
}

/**
 * Rewrite the search entry of every live medication (one transaction).
 * Entries written before notes and history were indexed only gain them on the
 * next save; this brings them all up to date at once. Returns the count.
 */
export function reindexMedicationsSearch(): number {
  const rows = medSelect().where(isNull(schema.medications.deletedAt)).all();
  db().transaction(() => {
    for (const r of rows) indexMedication(r);
  });
  return rows.length;
}

function doseLabel(m: { dose: string | null; unit: string | null }): string | null {
  if (!m.dose) return null;
  return m.unit ? `${m.dose} ${m.unit}` : m.dose;
}

function insertEvent(medicationId: string, kind: MedEventKind, when: Partial3, sourceFactId: string | null, detail: string | null, dose: string | null): MedicationEventRow {
  const e = schema.medicationEvents;
  const row: typeof schema.medicationEvents.$inferInsert = {
    id: newId(),
    medicationId,
    kind,
    date: when.iso,
    datePrecision: when.precision,
    dateText: when.text,
    detail,
    dose,
    sourceFactId,
    createdAt: nowIso(),
  };
  db().insert(e).values(row).run();
  return db().select().from(e).where(eq(e.id, row.id)).get()!;
}

/** Add a start/stop event when no live one of that kind exists yet (never duplicates, never overwrites). */
function ensureEvent(medicationId: string, kind: 'start' | 'stop', when: Partial3, sourceFactId: string | null, detail: string | null, dose: string | null): MedicationEventRow | null {
  if (!hasDate(when)) return null;
  const e = schema.medicationEvents;
  const existing = db().select({ id: e.id }).from(e).where(and(eq(e.medicationId, medicationId), eq(e.kind, kind), isNull(e.deletedAt))).get();
  if (existing) return null;
  return insertEvent(medicationId, kind, when, sourceFactId, detail, dose);
}

/**
 * The earliest live event of `kind` that still sits on the course date `at`:
 * the same ISO date at the same precision, or (for a date that only exists as
 * written) the same text.
 */
function eventOnCourseDate(medicationId: string, kind: MedEventKind, at: Partial3): MedicationEventRow | null {
  const e = schema.medicationEvents;
  const conds: SQL[] = [eq(e.medicationId, medicationId), eq(e.kind, kind), isNull(e.deletedAt)];
  if (at.iso) conds.push(eq(e.date, at.iso), eq(e.datePrecision, at.precision));
  else if (at.text) conds.push(eq(e.dateText, at.text));
  else return null;
  return db().select().from(e).where(and(...conds)).orderBy(asc(e.createdAt)).limit(1).get() ?? null;
}

function sameCourseDate(a: Partial3, b: Partial3): boolean {
  return a.iso === b.iso && a.precision === b.precision && a.text === b.text;
}

/**
 * A corrected course date moves the start/stop event that still sits on the
 * old course date (the one seeded from it). Without such an event, the event
 * is added only when none of that kind exists. Events at any other date were
 * entered separately and are never rewritten. An unchanged date (the edit
 * form always resends it) touches nothing, so an event the user removed is
 * not brought back; a cleared date (no ISO date left) leaves the events alone.
 */
function syncCourseEvent(medicationId: string, kind: 'start' | 'stop', before: Partial3, next: Partial3, sourceFactId: string | null, detail: string | null, dose: string | null): void {
  if (!hasDate(next) || sameCourseDate(before, next)) return;
  if (before.iso && !next.iso) return;
  const seeded = eventOnCourseDate(medicationId, kind, before);
  if (!seeded) {
    ensureEvent(medicationId, kind, next, sourceFactId, detail, dose);
    return;
  }
  if (seeded.date === next.iso && seeded.datePrecision === next.precision && seeded.dateText === next.text) return;
  const e = schema.medicationEvents;
  db().update(e).set({ date: next.iso, datePrecision: next.precision, dateText: next.text }).where(eq(e.id, seeded.id)).run();
}

function statusGiven(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && 'status' in raw && (raw as { status?: unknown }).status);
}

export function createMedication(raw: unknown): MedicationDetail {
  const input = parseInput(medicationInput, raw);
  assertPerson(input.prescriberId);
  assertFact(input.sourceFactId);
  const start = partialFrom(input.startDate, input.startDateText);
  const stop = partialFrom(input.stopDate, input.stopDateText);
  // A stop date with no explicit status means the course is over.
  const status: MedStatus = !statusGiven(raw) && hasDate(stop) ? 'stopped' : input.status;
  const now = nowIso();
  const row: MedicationInsert = {
    id: newId(),
    name: input.name,
    genericName: input.genericName ?? null,
    drugClass: input.drugClass ?? null,
    dose: input.dose ?? null,
    unit: input.unit ?? null,
    route: input.route ?? null,
    frequency: input.frequency ?? null,
    status,
    startDate: start.iso,
    startDatePrecision: start.precision,
    startDateText: start.text,
    stopDate: stop.iso,
    stopDatePrecision: stop.precision,
    stopDateText: stop.text,
    prescriberId: input.prescriberId ?? null,
    indication: input.indication ?? null,
    reasonStopped: input.reasonStopped ?? null,
    effect: input.effect ?? null,
    notes: input.notes ?? null,
    sourceFactId: input.sourceFactId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db().insert(schema.medications).values(row).run();
  ensureEvent(row.id, 'start', start, row.sourceFactId ?? null, null, doseLabel({ dose: row.dose ?? null, unit: row.unit ?? null }));
  ensureEvent(row.id, 'stop', stop, row.sourceFactId ?? null, row.reasonStopped ?? null, null);
  const saved = getMedication(row.id);
  indexMedication(saved);
  return saved;
}

export function updateMedication(id: string, raw: unknown): MedicationDetail {
  const current = medRow(id);
  const patch = parseInput(medicationPatch, raw);
  if (patch.prescriberId !== undefined) assertPerson(patch.prescriberId);
  if (patch.sourceFactId !== undefined) assertFact(patch.sourceFactId);
  const set: Partial<MedicationInsert> = { updatedAt: nowIso() };
  for (const k of ['name', 'genericName', 'drugClass', 'dose', 'unit', 'route', 'frequency', 'status', 'prescriberId', 'indication', 'reasonStopped', 'effect', 'notes', 'sourceFactId'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  let start: Partial3 | null = null;
  let stop: Partial3 | null = null;
  if (patch.startDate !== undefined || patch.startDateText !== undefined) {
    start = partialFrom(patch.startDate, patch.startDateText, { iso: current.startDate, precision: current.startDatePrecision, text: current.startDateText });
    set.startDate = start.iso;
    set.startDatePrecision = start.precision;
    set.startDateText = start.text;
  }
  if (patch.stopDate !== undefined || patch.stopDateText !== undefined) {
    stop = partialFrom(patch.stopDate, patch.stopDateText, { iso: current.stopDate, precision: current.stopDatePrecision, text: current.stopDateText });
    set.stopDate = stop.iso;
    set.stopDatePrecision = stop.precision;
    set.stopDateText = stop.text;
  }
  db().update(schema.medications).set(set).where(eq(schema.medications.id, id)).run();
  // A corrected date moves the event still on the old course date; a newly supplied date gets its event when none
  // exists; events at other dates are left alone. Clearing a date leaves the events alone.
  const after = medRow(id);
  const beforeStart: Partial3 = { iso: current.startDate, precision: current.startDatePrecision, text: current.startDateText };
  const beforeStop: Partial3 = { iso: current.stopDate, precision: current.stopDatePrecision, text: current.stopDateText };
  if (start) syncCourseEvent(id, 'start', beforeStart, start, after.sourceFactId, null, doseLabel(after));
  if (stop) syncCourseEvent(id, 'stop', beforeStop, stop, after.sourceFactId, after.reasonStopped, null);
  const saved = getMedication(id);
  indexMedication(saved);
  return saved;
}

export function deleteMedication(id: string): void {
  medRow(id);
  const now = nowIso();
  db().update(schema.medications).set({ deletedAt: now, updatedAt: now }).where(eq(schema.medications.id, id)).run();
  removeEntityIndex('medication', id);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Add a history line. `automatic` (automatic filing, never the route): the line may fill in a missing start date and
 * nothing else; it never moves the status, never reopens a stopped course, and leaves the row's update time alone (an
 * update time after the row was made reads as the user's work: Undo, the cleanups, readStartRecorded).
 */
export function addEvent(medicationId: string, raw: unknown, opts: { automatic?: boolean } = {}): MedicationEventItem {
  const med = medRow(medicationId);
  const input = parseInput(eventInput, raw);
  assertFact(input.sourceFactId);
  const when = partialFrom(input.date, input.dateText);
  const e = schema.medicationEvents;
  const row: typeof e.$inferInsert = {
    id: newId(),
    medicationId,
    kind: input.kind,
    date: when.iso,
    datePrecision: when.precision,
    dateText: when.text,
    detail: input.detail ?? null,
    dose: input.dose ?? null,
    sourceFactId: input.sourceFactId ?? null,
    createdAt: nowIso(),
  };
  db().insert(e).values(row).run();

  // A start or stop event fills in a missing date on the medication and moves its status; it never overwrites a date that is already there.
  // The exception is a restart: a start or resume dated after a stopped course's stop reopens it (the closed course stays in the events).
  const set: Partial<MedicationInsert> = {};
  if (opts.automatic) {
    // Automatic filing: a start line fills in a missing start (no start date and no start as written); nothing else.
    if (input.kind === 'start' && !med.startDate && !med.startDateText && hasDate(when)) Object.assign(set, { startDate: when.iso, startDatePrecision: when.precision, startDateText: when.text });
  } else if ((input.kind === 'start' || input.kind === 'resume') && med.status === 'stopped' && restartsAfterStop(med, when)) {
    recordClosedCourse(med);
    Object.assign(set, { status: 'active', startDate: when.iso, startDatePrecision: when.precision, startDateText: when.text, stopDate: null, stopDatePrecision: 'unknown', stopDateText: null, reasonStopped: null });
  } else if (input.kind === 'start') {
    if (!med.startDate && hasDate(when)) Object.assign(set, { startDate: when.iso, startDatePrecision: when.precision, startDateText: when.text });
    if (med.status === 'unknown' || med.status === 'planned') set.status = 'active';
  } else if (input.kind === 'stop') {
    if (!med.stopDate && hasDate(when)) Object.assign(set, { stopDate: when.iso, stopDatePrecision: when.precision, stopDateText: when.text });
    if (med.status !== 'stopped') set.status = 'stopped';
    if (!med.reasonStopped && input.detail) set.reasonStopped = input.detail;
  } else if (input.kind === 'dose_change' && input.dose) {
    set.dose = input.dose;
    set.unit = null;
  }
  if (Object.keys(set).length) {
    if (!opts.automatic) set.updatedAt = nowIso();
    db().update(schema.medications).set(set).where(eq(schema.medications.id, medicationId)).run();
  }
  // The new history line (and any course change) is searchable at once.
  indexMedication(medRow(medicationId));
  const saved = db().select().from(e).where(eq(e.id, row.id)).get()!;
  return { ...saved, sourceFact: sourceFactRef(saved.sourceFactId) };
}

/**
 * The latest known stop of a course: its stop date or its latest live dated
 * stop event, whichever is later. Null when neither exists.
 */
function latestStop(med: MedicationRowItem): string | null {
  const e = schema.medicationEvents;
  const r = db()
    .select({ d: sql<string | null>`max(${e.date})` })
    .from(e)
    .where(and(eq(e.medicationId, med.id), eq(e.kind, 'stop'), isNull(e.deletedAt)))
    .get();
  const fromEvents = r?.d ?? null;
  if (!med.stopDate) return fromEvents;
  if (!fromEvents) return med.stopDate;
  return cmpPrefix(fromEvents, med.stopDate) > 0 ? fromEvents : med.stopDate;
}

/**
 * True when a start/resume dated `when` comes strictly after the course's
 * known stop (compared at the coarser precision). An undated event, a course
 * with no known stop, or a date in the same period never reopens: a
 * backfilled historical start must not put a finished drug back on the
 * emergency card.
 */
function restartsAfterStop(med: MedicationRowItem, when: Partial3): boolean {
  if (!when.iso) return false;
  const stop = latestStop(med);
  return Boolean(stop && cmpPrefix(when.iso, stop) > 0);
}

/**
 * Before a restart overwrites the course dates, make sure the closed course
 * survives in the events: its start, its stop, and the reason it stopped.
 */
function recordClosedCourse(med: MedicationRowItem): void {
  const e = schema.medicationEvents;
  const start: Partial3 = { iso: med.startDate, precision: med.startDatePrecision, text: med.startDateText };
  const stop: Partial3 = { iso: med.stopDate, precision: med.stopDatePrecision, text: med.stopDateText };
  if (hasDate(start) && !eventOnCourseDate(med.id, 'start', start)) insertEvent(med.id, 'start', start, med.sourceFactId, null, doseLabel(med));
  const stopEvent = hasDate(stop) ? eventOnCourseDate(med.id, 'stop', stop) : null;
  if (hasDate(stop) && !stopEvent) {
    insertEvent(med.id, 'stop', stop, med.sourceFactId, med.reasonStopped, null);
    return;
  }
  if (!med.reasonStopped) return;
  const reasonKept = db()
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.medicationId, med.id), isNull(e.deletedAt), eq(e.detail, med.reasonStopped)))
    .get();
  if (!reasonKept) insertEvent(med.id, 'note', stopEvent ? stop : { iso: null, precision: 'unknown', text: null }, null, `Reason stopped: ${med.reasonStopped}`, null);
}

/** Soft delete: the event leaves every view, but the row (date, dose, detail, source fact) stays in the database. */
export function deleteEvent(eventId: string): { medicationId: string } {
  const e = schema.medicationEvents;
  const row = db()
    .select({ id: e.id, medicationId: e.medicationId })
    .from(e)
    .where(and(eq(e.id, eventId), isNull(e.deletedAt)))
    .get();
  if (!row) throw notFound('event not found');
  db().update(e).set({ deletedAt: nowIso() }).where(eq(e.id, eventId)).run();
  // Its history line leaves the search entry with it.
  reindexMedication(row.medicationId);
  return { medicationId: row.medicationId };
}

// ---------------------------------------------------------------------------
// Intolerances
// ---------------------------------------------------------------------------

const SEVERITY_RANK = sql`case ${schema.intolerances.severity} when 'life_threatening' then 0 when 'severe' then 1 when 'moderate' then 2 when 'mild' then 3 else 4 end`;

function intoleranceRow(id: string): IntoleranceRow {
  const row = db().select().from(schema.intolerances).where(and(eq(schema.intolerances.id, id), isNull(schema.intolerances.deletedAt))).get();
  if (!row) throw notFound('intolerance not found');
  return row;
}

function decorateIntolerance(row: IntoleranceRow): IntoleranceItem {
  return { ...row, sourceFact: sourceFactRef(row.sourceFactId) };
}

function indexIntolerance(row: IntoleranceRow): void {
  const body = [row.kind.replace(/_/g, ' '), row.hardStop ? 'hard stop never give' : null, row.severity, row.reaction, row.active ? null : 'inactive', row.notes].filter(Boolean).join(' · ');
  indexEntity('intolerance', row.id, row.substance, body);
}

export function listIntolerances(opts: { active?: boolean; hardStop?: boolean } = {}): IntoleranceItem[] {
  const t = schema.intolerances;
  const conds: SQL[] = [isNull(t.deletedAt)];
  if (opts.active !== undefined) conds.push(eq(t.active, opts.active));
  if (opts.hardStop !== undefined) conds.push(eq(t.hardStop, opts.hardStop));
  return db()
    .select()
    .from(t)
    .where(and(...conds))
    .orderBy(desc(t.hardStop), desc(t.active), SEVERITY_RANK, sql`${t.substance} collate nocase`)
    .all()
    .map(decorateIntolerance);
}

/** Active hard stops: shown on every medication screen, the Today page, and the emergency card. */
export function listHardStops(): IntoleranceItem[] {
  return listIntolerances({ active: true, hardStop: true });
}

export function getIntolerance(id: string): IntoleranceItem {
  return decorateIntolerance(intoleranceRow(id));
}

export function createIntolerance(raw: unknown): IntoleranceItem {
  const input = parseInput(intoleranceInput, raw);
  assertFact(input.sourceFactId);
  const when = partialFrom(input.date, input.dateText);
  const now = nowIso();
  const row: IntoleranceInsert = {
    id: newId(),
    substance: input.substance,
    kind: input.kind,
    reaction: input.reaction ?? null,
    severity: input.severity,
    // Kind hard_stop always carries the flag; any other kind can carry it too (an allergy can be a hard stop).
    hardStop: input.kind === 'hard_stop' ? true : (input.hardStop ?? false),
    date: when.iso,
    datePrecision: when.precision,
    dateText: when.text,
    notes: input.notes ?? null,
    sourceFactId: input.sourceFactId ?? null,
    active: input.active,
    createdAt: now,
    updatedAt: now,
  };
  db().insert(schema.intolerances).values(row).run();
  const saved = intoleranceRow(row.id);
  indexIntolerance(saved);
  return decorateIntolerance(saved);
}

export function updateIntolerance(id: string, raw: unknown): IntoleranceItem {
  const current = intoleranceRow(id);
  const patch = parseInput(intolerancePatch, raw);
  if (patch.sourceFactId !== undefined) assertFact(patch.sourceFactId);
  const set: Partial<IntoleranceInsert> = { updatedAt: nowIso() };
  for (const k of ['substance', 'kind', 'reaction', 'severity', 'hardStop', 'notes', 'sourceFactId', 'active'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  // Kind hard_stop always carries the flag. Dropping the flag on such a row demotes it to a caution
  // (the toggle key does this); asking for both at once is a contradiction.
  const kindAfter = patch.kind ?? current.kind;
  if (patch.hardStop === false && kindAfter === 'hard_stop') {
    if (patch.kind !== undefined) throw badRequest('kind hard_stop always carries the hard-stop flag');
    set.kind = 'caution';
  } else if (kindAfter === 'hard_stop') {
    set.hardStop = true;
  }
  if (patch.date !== undefined || patch.dateText !== undefined) {
    const when = partialFrom(patch.date, patch.dateText, { iso: current.date, precision: current.datePrecision, text: current.dateText });
    set.date = when.iso;
    set.datePrecision = when.precision;
    set.dateText = when.text;
  }
  db().update(schema.intolerances).set(set).where(eq(schema.intolerances.id, id)).run();
  const saved = intoleranceRow(id);
  indexIntolerance(saved);
  return decorateIntolerance(saved);
}

export function deleteIntolerance(id: string): void {
  intoleranceRow(id);
  const now = nowIso();
  db().update(schema.intolerances).set({ deletedAt: now, updatedAt: now }).where(eq(schema.intolerances.id, id)).run();
  removeEntityIndex('intolerance', id);
}

/**
 * Bring back a soft-deleted intolerance as it was (every field kept) and put it back in search. Used only by the
 * filing repair for allergies the one-time cleanup took back (services/filing.ts quietChecksRepairV1b). `at` is the
 * update time written (the repair records the same instant on the placement, so its own change is not counted as the
 * user's work). Returns false when there is no such row or it is not deleted.
 */
export function restoreIntolerance(id: string, at: string = nowIso()): boolean {
  const row = db().select().from(schema.intolerances).where(eq(schema.intolerances.id, id)).get();
  if (!row || !row.deletedAt) return false;
  db().update(schema.intolerances).set({ deletedAt: null, updatedAt: at }).where(eq(schema.intolerances.id, id)).run();
  indexIntolerance(intoleranceRow(id));
  return true;
}

// ---------------------------------------------------------------------------
// Timeline and chart overlays (imported by the symptoms, labs and consult slices)
// ---------------------------------------------------------------------------

export interface TimelineOptions {
  /** YYYY, YYYY-MM or YYYY-MM-DD; items whose course overlaps the window are kept. */
  from?: string | null;
  to?: string | null;
  /** Restrict to these statuses (default: every live medication). */
  statuses?: string[] | null;
}

/** Compare two partial ISO dates at the coarser of their precisions. */
function cmpPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A course overlaps the window unless it stopped before `from` or started after `to`; unknown ends never exclude. */
function overlaps(item: { start: string | null; stop: string | null }, from: string | null | undefined, to: string | null | undefined): boolean {
  if (from && item.stop && cmpPrefix(item.stop, from) < 0) return false;
  if (to && item.start && cmpPrefix(item.start, to) > 0) return false;
  return true;
}

/**
 * Every live medication with its course (start → stop at their precision)
 * and events, ordered by start date. Slices H and I turn this into chart
 * bands and markers; slice F reads it for the ledger.
 */
export function getMedicationTimeline(opts: TimelineOptions = {}): { items: MedicationTimelineItem[] } {
  const d = db();
  const m = schema.medications;
  const conds: SQL[] = [isNull(m.deletedAt)];
  if (opts.statuses && opts.statuses.length) conds.push(inArray(m.status, opts.statuses));
  const meds = d
    .select({ ...getTableColumns(m), prescriberName: prescriber.name })
    .from(m)
    .leftJoin(prescriber, and(eq(prescriber.id, m.prescriberId), isNull(prescriber.deletedAt)))
    .where(and(...conds))
    .all();
  const ids = meds.map((x) => x.id);
  const events = ids.length
    ? d
        .select()
        .from(schema.medicationEvents)
        .where(and(inArray(schema.medicationEvents.medicationId, ids), isNull(schema.medicationEvents.deletedAt)))
        .orderBy(sql`(${schema.medicationEvents.date} is null) asc`, asc(schema.medicationEvents.date), asc(schema.medicationEvents.createdAt))
        .all()
    : [];
  const byMed = new Map<string, MedicationTimelineEvent[]>();
  const dated = new Map<string, DatedLine[]>();
  for (const e of events) {
    if (!byMed.has(e.medicationId)) byMed.set(e.medicationId, []);
    byMed.get(e.medicationId)!.push({ id: e.id, kind: e.kind, date: e.date, datePrecision: e.datePrecision, dateText: e.dateText, detail: e.detail, dose: e.dose, sourceFactId: e.sourceFactId });
    if (e.date) (dated.get(e.medicationId) ?? dated.set(e.medicationId, []).get(e.medicationId)!).push({ date: e.date, precision: e.datePrecision, kind: e.kind, sourceFactId: e.sourceFactId });
  }
  const starts = readStarts(meds, dated);
  const items: MedicationTimelineItem[] = meds
    .map((x) => {
      const it: MedicationTimelineItem = {
        medicationId: x.id,
        name: x.name,
        status: x.status,
        start: x.startDate,
        startPrecision: x.startDatePrecision,
        startText: x.startDateText,
        stop: x.stopDate,
        stopPrecision: x.stopDatePrecision,
        stopText: x.stopDateText,
        prescriberName: x.prescriberName ?? null,
        events: byMed.get(x.id) ?? [],
        ...starts.get(x.id)!,
      };
      // The settled timeline of a drug the user answered on (My notes, 2026-10-09): its start and stop, with who said them;
      // the starts and stops of other courses as marks. The row itself is not changed.
      const s = settledFor(x);
      if (!s) return it;
      it.settled = s;
      if (s.start) Object.assign(it, { start: s.start.date, startPrecision: s.start.precision, startText: s.start.dateText, startRecorded: true });
      if (s.stop) Object.assign(it, { stop: s.stop.date, stopPrecision: s.stop.precision, stopText: s.stop.dateText });
      it.events = [...it.events, ...s.extra.map((e) => ({ id: `settled:${e.kind}:${e.date}`, kind: e.kind, date: e.date, datePrecision: e.precision, dateText: null, detail: e.who, dose: null, sourceFactId: e.factId }))];
      return it;
    })
    // The window is read against when the course is known to begin: its recorded start, else when it was first seen.
    .filter((x) => overlaps({ start: courseFrom(x), stop: x.stop }, opts.from, opts.to));
  items.sort((a, b) => dateSortKey(a.start).localeCompare(dateSortKey(b.start)) || a.name.localeCompare(b.name));
  return { items };
}

export const EVENT_TONE: Record<string, ChartTone> = { start: 'ok', stop: 'ash', dose_change: 'accent', hold: 'warn', resume: 'ok', reaction: 'bad', note: 'info' };

/** When a course is known to begin: its recorded start, else the first time the records place the drug (null: neither). */
function courseFrom(it: Pick<MedicationTimelineItem, 'start' | 'startRecorded' | 'firstSeen'>): string | null {
  return it.startRecorded && it.start ? it.start : it.firstSeen;
}

/** One medication's course as a chart draws it (see medicationCourse). */
export interface MedicationCourse {
  medicationId: string;
  name: string;
  /** The chart lane (medicationLanes; by default medicationKey(name)): one drug under two names ("Metformin ER", "Metformin ER (Example Pharma)") shares one. */
  lane: string;
  /** The recorded start, else the first time the records place the drug; null when only the stop is known. */
  from: string | null;
  /** `from` is the recorded start (false: the drug was first seen then, and may have been started earlier). */
  startKnown: boolean;
  startRecorded: boolean;
  /** The stop date (null while it goes on). */
  to: string | null;
  /** No stop date and the medication is current (active, prn, planned). */
  ongoing: boolean;
  /** The medication's status is stopped. */
  stopped: boolean;
  tone: ChartTone;
}

/**
 * A medication's course for a chart, or null when there is nothing honest to draw: a course is open-ended only while
 * the medication is current, so a stopped or unknown-status course with no stop date gets none (its events still
 * produce markers), and so does a course with no date at all. A start that is only the date of a document that
 * mentioned the drug is not a start: the course runs from when the drug was first seen, marked startKnown false. A
 * first sighting after the stop leaves the start unknown (from null).
 */
export function medicationCourse(it: MedicationTimelineItem, lane: string = medicationKey(it.name) || it.medicationId): MedicationCourse | null {
  const current = (CURRENT_STATUSES as readonly string[]).includes(it.status);
  const to = it.stop ?? null;
  if (!to && !current) return null;
  const startKnown = Boolean(it.startRecorded && it.start);
  let from = courseFrom(it);
  if (from && to && !startKnown && cmpPrefix(from, to) > 0) from = null;
  if (!from && !to) return null;
  return {
    medicationId: it.medicationId,
    name: it.name,
    lane,
    from,
    startKnown: Boolean(from) && startKnown,
    startRecorded: it.startRecorded,
    to,
    ongoing: !to && current,
    stopped: it.status === 'stopped',
    tone: current ? 'accent' : 'ash',
  };
}

/**
 * Chart bands for medication courses (see medicationCourse). Without a window, a course whose start is not known at
 * all (only its stop) has nowhere to begin and is left out.
 */
export function medicationBands(items: MedicationTimelineItem[] = getMedicationTimeline().items): ChartBand[] {
  const out: ChartBand[] = [];
  const lanes = medicationLanes(items);
  for (const it of items) {
    const c = medicationCourse(it, lanes.get(it.medicationId));
    if (!c || !c.from) continue;
    out.push({ from: c.from, to: c.to, label: c.name, tone: c.tone, lane: c.lane, startKnown: c.startKnown, ongoing: c.ongoing });
  }
  return out;
}

/** Chart markers for dated medication events (dose changes, holds, reactions …). */
export function medicationMarkers(items: MedicationTimelineItem[] = getMedicationTimeline().items, kinds?: string[]): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const it of items) {
    for (const e of it.events) {
      if (!e.date) continue;
      if (kinds && !kinds.includes(e.kind)) continue;
      out.push({ x: e.date, label: `${it.name}: ${e.kind.replace(/_/g, ' ')}${e.dose ? ` ${e.dose}` : ''}`, tone: EVENT_TONE[e.kind] ?? 'ash' });
    }
  }
  out.sort((a, b) => String(a.x).localeCompare(String(b.x)));
  return out;
}

// ---------------------------------------------------------------------------
// Proposals from facts
// ---------------------------------------------------------------------------

interface MedicationAttrs {
  name?: string | null;
  dose?: string | null;
  unit?: string | null;
  route?: string | null;
  frequency?: string | null;
  start_date?: string | null;
  stop_date?: string | null;
  status?: string | null;
  indication?: string | null;
  effect?: string | null;
  reason_stopped?: string | null;
  prescriber?: string | null;
}

interface IntoleranceAttrs {
  substance?: string | null;
  kind?: string | null;
  reaction?: string | null;
  severity?: string | null;
}

// ---------------------------------------------------------------------------
// Names: the key a drug is matched by, and names that are not one drug
// ---------------------------------------------------------------------------

/** Bracketed text: a maker, a note or a brand in brackets ("(Example Pharma)", "[generic]"). Innermost first. */
const BRACKETED = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g;

/** A name split into its key (bracketed text removed) and what the brackets said (normalised; '' when none). */
function splitMedicationName(name: string | null | undefined): { key: string; qualifier: string } {
  let s = name ?? '';
  const removed: string[] = [];
  const cut = (m: string) => {
    removed.push(m);
    return ' ';
  };
  for (let i = 0; i < 5; i++) {
    const next = s.replace(BRACKETED, cut);
    if (next === s) break;
    s = next;
  }
  // An opening bracket never closed runs to the end of the name.
  s = s.replace(/[([{][^)\]}]*$/, cut);
  const key = normalizeKey(s);
  return key ? { key, qualifier: normalizeKey(removed.join(' ')) } : { key: normalizeKey(name), qualifier: '' };
}

/**
 * The key a medication is matched by: its normalised name with bracketed text removed, so a maker or a note in
 * brackets does not make a second drug ("Metformin ER (Example Pharma)" and "Metformin ER" are one, "metformin er"). XL, ER,
 * SR, IR, the dose form and a strength that is part of the name are kept. A name that is only brackets keeps its
 * whole normalised name.
 */
export function medicationKey(name: string | null | undefined): string {
  return splitMedicationName(name).key;
}

/**
 * Two medication names are one drug: the same normalised name, or the same medicationKey when the brackets do not
 * disagree. Brackets on one side only (a maker, a note: "Metformin ER (Example Pharma)" and "Metformin ER") are the same
 * drug; different brackets on both sides ("Insulin (Lantus)" and "Insulin (Humalog)") may be two drugs, so they are
 * kept apart (an extra entry can be deleted; a drug merged into another would be missing from the list).
 */
export function sameMedicationName(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const x = splitMedicationName(a);
  const y = splitMedicationName(b);
  return x.key === y.key && !(x.qualifier && y.qualifier && x.qualifier !== y.qualifier);
}

/**
 * The chart lane of each medication (by id): its medicationKey, so two names of one drug share a row. Where names
 * with that key carry different brackets ("Insulin (Lantus)", "Insulin (Humalog)"), each bracketed one gets a lane of
 * its own (its whole name), as sameMedicationName keeps them apart.
 */
export function medicationLanes(items: Array<{ medicationId: string; name: string }>): Map<string, string> {
  const split = items.map((it) => ({ id: it.medicationId, name: it.name, ...splitMedicationName(it.name) }));
  const qualifiers = new Map<string, Set<string>>();
  for (const s of split) if (s.qualifier) (qualifiers.get(s.key) ?? qualifiers.set(s.key, new Set()).get(s.key)!).add(s.qualifier);
  const out = new Map<string, string>();
  for (const s of split) {
    const clash = (qualifiers.get(s.key)?.size ?? 0) > 1 && s.qualifier;
    out.set(s.id, (clash ? normalizeKey(s.name) : s.key) || s.id);
  }
  return out;
}

/**
 * Words of a list heading or section title ("Current working list", "Home medications as of 9/21"). A name made only
 * of these (dates and numbers aside), with at least one that is not a small joining word, is not a drug.
 */
const LIST_HEADING_WORDS = new Set([
  'current', 'currently', 'working', 'active', 'home', 'medication', 'medications', 'med', 'meds', 'list', 'lists',
  'regimen', 'drug', 'drugs', 'prescription', 'prescriptions', 'reconciliation', 'updated', 'new', 'old', 'other',
  'summary', 'plan', 'outpatient', 'inpatient', 'discharge', 'prior', 'previous', 'past', 'taking', 'reviewed',
  // "Supplements", "Current supplements", "Med rec". Not "vitamin(s)": "Vitamin D" names a drug, and a name with any
  // word that is not one of these is never a heading.
  'supplement', 'supplements', 'rec',
]);
const JOINING_WORDS = new Set(['as', 'of', 'the', 'my']);
const MONTH_WORDS = new Set(['jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december']);

/** The name is a list heading or section title, not a drug ("current working list", "Medications"). */
export function isListHeadingName(name: string | null | undefined): boolean {
  const words = normalizeKey(name).split(' ').filter(Boolean);
  if (!words.length) return false;
  let heading = false;
  for (const w of words) {
    if (LIST_HEADING_WORDS.has(w)) heading = true;
    else if (!JOINING_WORDS.has(w) && !MONTH_WORDS.has(w) && !/^\d+$/.test(w)) return false;
  }
  return heading;
}

/**
 * Words of a dose, how often, how and when a drug is taken ("300 mg", "three times daily", "PO", "at bedtime", "PRN"),
 * and release forms ("XR"). Text after a ";" made only of these (and numbers) says how one drug is taken; it is not a
 * second drug.
 */
const DOSING_WORDS = new Set([
  // amounts and forms
  'mg', 'mcg', 'ug', 'g', 'gm', 'gram', 'grams', 'milligram', 'milligrams', 'microgram', 'micrograms', 'ml', 'l', 'iu',
  'u', 'unit', 'units', 'meq', 'mmol', 'kg', 'percent', 'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule',
  'capsules', 'pill', 'pills', 'puff', 'puffs', 'drop', 'drops', 'gtt', 'gtts', 'patch', 'patches', 'spray', 'sprays',
  'injection', 'injections', 'dose', 'doses', 'dosing', 'vial', 'vials', 'pen', 'application', 'applications',
  'sachet', 'sachets', 'scoop', 'scoops', 'tsp', 'teaspoon', 'teaspoons', 'tbsp', 'tablespoon', 'tablespoons',
  'xl', 'xr', 'er', 'sr', 'ir', 'cr', 'dr', 'ec', 'odt', 'la',
  // how many and how often
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'half', 'quarter', 'single', 'double',
  'once', 'twice', 'thrice', 'times', 'time', 'x', 'daily', 'day', 'days', 'a', 'an', 'per', 'each', 'every', 'other',
  'nightly', 'weekly', 'week', 'weeks', 'biweekly', 'monthly', 'month', 'months', 'hourly', 'hour', 'hours', 'hr', 'hrs',
  'h', 'min', 'minute', 'minutes', 'q', 'qd', 'qod', 'qday', 'bid', 'tid', 'qid', 'qhs', 'hs', 'qam', 'qpm', 'qw', 'qwk',
  'prn', 'as', 'needed', 'required', 'directed', 'when', 'if',
  // when
  'morning', 'mornings', 'am', 'pm', 'evening', 'evenings', 'night', 'nights', 'bedtime', 'noon', 'midday', 'afternoon',
  'before', 'after', 'with', 'without', 'food', 'meal', 'meals', 'breakfast', 'lunch', 'dinner', 'supper', 'empty',
  'stomach', 'at', 'in', 'the', 'on', 'and', 'or', 'then', 'for', 'to', 'up', 'until', 'of', 'over', 'from', 'by',
  // how
  'take', 'takes', 'taken', 'taking', 'use', 'used', 'apply', 'inject', 'inhale', 'give', 'given', 'mouth', 'oral',
  'orally', 'po', 'iv', 'im', 'sc', 'sq', 'subq', 'subcut', 'sl', 'sublingual', 'sublingually', 'topical', 'topically',
  'intravenous', 'intravenously', 'intramuscular', 'intramuscularly', 'subcutaneous', 'subcutaneously', 'inhaled',
  'inhalation', 'nasal', 'nasally', 'intranasal', 'rectal', 'rectally', 'pr', 'transdermal', 'vaginal', 'vaginally',
  'ophthalmic', 'otic', 'eye', 'eyes', 'ear', 'ears', 'nostril', 'nostrils', 'left', 'right', 'both', 'taper',
  'tapering', 'increase', 'decrease', 'continue', 'max', 'maximum', 'total',
]);
/** A number, or a number run into its unit or interval ("300mg", "q8h", "x2", "2nd"). */
const DOSING_TOKEN = /^(?:\d+|\d+(?:st|nd|rd|th)|\d+(?:mg|mcg|ug|g|gm|ml|l|iu|u|units?|meq|mmol|kg|h|hr|hrs|d|wk|x|tabs?|caps?)|q\d+(?:h|hr|hrs|d|wk|w)?|x\d+)$/;

/** Text that only says how a drug is taken, not which drug: dosing, frequency, route and timing words and numbers. */
function onlyDosing(text: string): boolean {
  const words = normalizeKey(text).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => DOSING_WORDS.has(w) || DOSING_TOKEN.test(w));
}

/**
 * The name holds two or more drugs joined by ";" or a line break ("Atorvastatin; lisinopril"). A part that
 * only says how the drug is taken ("Amoxicillin 500 mg; three times daily", "Metformin ER 500 mg; take in morning") is
 * not a second drug.
 */
export function isTwoMedicationsName(name: string | null | undefined): boolean {
  return (name ?? '').split(/[;\r\n]+/).filter((part) => normalizeKey(part) && !onlyDosing(part)).length >= 2;
}

export type NotMedicationReason = 'list heading' | 'two medications in one';

/** Why a medication name is not one drug, or null when it is. Automatic filing never makes such an entry. */
export function notMedicationReason(name: string | null | undefined): NotMedicationReason | null {
  if (isTwoMedicationsName(name)) return 'two medications in one';
  if (isListHeadingName(name)) return 'list heading';
  return null;
}

/** The name a medication detail goes by (its name attribute, else its statement), or an allergy detail's substance. */
export function factItemName(fact: { type: string; statement: string; attributesJson: string }): string {
  if (fact.type === 'allergy_intolerance') return clean(parseJson<IntoleranceAttrs>(fact.attributesJson, {}).substance) ?? fact.statement;
  return clean(parseJson<MedicationAttrs>(fact.attributesJson, {}).name) ?? fact.statement;
}

/**
 * The normalised name or substance of a medication or allergy detail. An allergy row matches by exactly this; a
 * medication row matches a detail by sameMedicationName (this key, or medicationKey when brackets do not disagree).
 */
export function factItemKey(fact: { type: string; statement: string; attributesJson: string }): string {
  return normalizeKey(factItemName(fact));
}

interface CandidateFact {
  id: string;
  type: string;
  statement: string;
  status: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  dateEnd: string | null;
  attributesJson: string;
  personId: string | null;
  sourceDocumentId: string | null;
  documentTitle: string | null;
}

export interface MedicationProposal {
  factId: string;
  kind: 'medication' | 'intolerance';
  statement: string;
  factStatus: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
  citation: SourceFactRef['citation'];
  /** The fields a create call would receive (same keys as medicationInput / intoleranceInput). */
  proposed: Record<string, unknown>;
  /** Prescriber as written in the fact, when it could not be matched to a person. */
  prescriberText: string | null;
  /** A live row for the same drug (medicationKey of its name or generic name), so the user can attach instead of duplicating. */
  existing: { id: string; name: string } | null;
  /**
   * Medications only: the name is not one drug (a list heading, or two drugs joined by ";"). Automatic filing never
   * makes it; "Add from documents" lists it with this label, to add with an edited name. Null otherwise.
   */
  notMedication: NotMedicationReason | null;
}

function candidateFacts(onlyId?: string, documentId?: string): CandidateFact[] {
  const f = schema.facts;
  const conds: SQL[] = [
    isNull(f.deletedAt),
    inArray(f.type, ['medication', 'allergy_intolerance']),
    notInArray(f.status, ['disputed', 'superseded']),
    or(isNull(f.sourceDocumentId), isNull(schema.documents.deletedAt))!,
    sql`${f.id} not in (select source_fact_id from medications where source_fact_id is not null and deleted_at is null)`,
    sql`${f.id} not in (select source_fact_id from intolerances where source_fact_id is not null and deleted_at is null)`,
    sql`${f.id} not in (select me.source_fact_id from medication_events me join medications m on m.id = me.medication_id where me.source_fact_id is not null and me.deleted_at is null and m.deleted_at is null)`,
  ];
  if (onlyId) conds.push(eq(f.id, onlyId));
  // One document's details only (automatic filing reads one document at a time, never the whole case).
  if (documentId) conds.push(eq(f.sourceDocumentId, documentId));
  return db()
    .select({
      id: f.id,
      type: f.type,
      statement: f.statement,
      status: f.status,
      date: f.date,
      datePrecision: f.datePrecision,
      dateText: f.dateText,
      dateEnd: f.dateEnd,
      attributesJson: f.attributesJson,
      personId: f.personId,
      sourceDocumentId: f.sourceDocumentId,
      documentTitle: schema.documents.title,
    })
    .from(f)
    .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
    .where(and(...conds))
    .orderBy(sql`(${f.date} is null) asc`, desc(f.date), desc(f.createdAt))
    .all();
}

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function proposalFor(fact: CandidateFact, peopleIdx: Map<string, string>, meds: Array<{ id: string; name: string; genericName: string | null }>, intolerances: Array<{ id: string; substance: string }>): MedicationProposal {
  const ref = sourceFactRef(fact.id);
  const base = {
    factId: fact.id,
    statement: fact.statement,
    factStatus: fact.status,
    date: fact.date,
    datePrecision: fact.datePrecision,
    dateText: fact.dateText,
    documentId: fact.sourceDocumentId,
    documentTitle: fact.documentTitle,
    citation: ref?.citation ?? null,
  };
  if (fact.type === 'allergy_intolerance') {
    const a = parseJson<IntoleranceAttrs>(fact.attributesJson, {});
    const substance = clean(a.substance) ?? fact.statement;
    const kind = (INTOLERANCE_KINDS as readonly string[]).includes(a.kind ?? '') ? (a.kind as string) : 'intolerance';
    const severity = (INTOLERANCE_SEVERITIES as readonly string[]).includes(a.severity ?? '') ? (a.severity as string) : 'unknown';
    const key = normalizeKey(substance);
    const existing = intolerances.find((x) => normalizeKey(x.substance) === key) ?? null;
    return {
      ...base,
      kind: 'intolerance',
      proposed: { substance, kind, reaction: clean(a.reaction), severity, hardStop: kind === 'hard_stop', dateText: fact.dateText ?? fact.date ?? null, sourceFactId: fact.id },
      prescriberText: null,
      existing: existing ? { id: existing.id, name: existing.substance } : null,
      notMedication: null,
    };
  }
  const a = parseJson<MedicationAttrs>(fact.attributesJson, {});
  const name = clean(a.name) ?? fact.statement;
  // A start only when the document states one: its start_date, or the beginning of a range the detail gives. The date
  // of a medication list or a note that merely names the drug is when it was listed, not when it was started (that
  // date stays on the detail, and the medication's history and charts read it as "first seen").
  const startText = clean(a.start_date) ?? (clean(fact.dateEnd) ? (fact.dateText ?? fact.date ?? null) : null);
  const stopText = clean(a.stop_date) ?? fact.dateEnd ?? null;
  const status = (MED_STATUSES as readonly string[]).includes(a.status ?? '') ? (a.status as string) : stopText ? 'stopped' : 'unknown';
  const prescriberText = clean(a.prescriber);
  const prescriberId = (prescriberText ? peopleIdx.get(normalizeKey(prescriberText)) : undefined) ?? fact.personId ?? null;
  const existing = meds.find((x) => sameMedicationName(x.name, name) || (x.genericName && sameMedicationName(x.genericName, name))) ?? null;
  return {
    ...base,
    kind: 'medication',
    proposed: {
      name,
      dose: clean(a.dose),
      unit: clean(a.unit),
      route: clean(a.route),
      frequency: clean(a.frequency),
      status,
      startDateText: startText,
      stopDateText: stopText,
      prescriberId,
      indication: clean(a.indication),
      effect: clean(a.effect),
      reasonStopped: clean(a.reason_stopped),
      sourceFactId: fact.id,
    },
    prescriberText: prescriberId ? null : prescriberText,
    existing: existing ? { id: existing.id, name: existing.name } : null,
    notMedication: notMedicationReason(name),
  };
}

/**
 * Medication and allergy_intolerance facts (not disputed or superseded) that no row or event links to yet. With
 * `documentId`, only that document's facts (the same proposals as the full list filtered to it, without building the
 * whole case's).
 */
export function proposeFromFacts(opts: { documentId?: string } = {}): MedicationProposal[] {
  const facts = candidateFacts(undefined, opts.documentId);
  if (!facts.length) return [];
  const peopleIdx = loadPeopleIndex();
  const meds = db().select({ id: schema.medications.id, name: schema.medications.name, genericName: schema.medications.genericName }).from(schema.medications).where(isNull(schema.medications.deletedAt)).all();
  const intolerances = db().select({ id: schema.intolerances.id, substance: schema.intolerances.substance }).from(schema.intolerances).where(isNull(schema.intolerances.deletedAt)).all();
  return facts.map((f) => proposalFor(f, peopleIdx, meds, intolerances));
}

export type AcceptResult =
  | { kind: 'medication'; existing: boolean; medication: MedicationDetail }
  | { kind: 'intolerance'; existing: boolean; intolerance: IntoleranceItem }
  | { kind: 'event'; existing: boolean; medication: MedicationDetail; event: MedicationEventItem };

/**
 * Whether automatic filing adds a detail to a medication already on the list as a start line rather than a note: the
 * detail states a start (its start_date) and no stop, the medication's start is not recorded (none, or only the date
 * of the list that named the drug on a row filed before 2026-10-06 and never changed since: readStartRecorded), and the
 * stated start does not come after the course's known stop (that would be a restart, which is the user's call). The
 * line then fills in the start (acceptFromFacts); otherwise the detail is a note and changes nothing on the course.
 */
export function statedStartFills(medicationId: string, proposed: Record<string, unknown>): boolean {
  const start = typeof proposed.startDateText === 'string' ? proposed.startDateText.trim() : '';
  const stop = typeof proposed.stopDateText === 'string' ? proposed.stopDateText.trim() : '';
  if (!start || stop) return false;
  const med = medSelect().where(and(eq(schema.medications.id, medicationId), isNull(schema.medications.deletedAt))).get();
  if (!med || startRecorded(med)) return false;
  // Changed by the user since it was made (a start cleared on purpose, say): the user's row is never re-dated.
  if (med.updatedAt > med.createdAt) return false;
  return !restartsAfterStop(med, partialFrom(null, start));
}

/**
 * Accept a proposal: create the medication or intolerance linked to the fact,
 * or (medication facts only, with `medicationId`) attach the fact to an
 * existing medication as an event. Idempotent: a live row or event already
 * linked to the fact is returned with `existing: true`.
 *
 * Attaching a detail that states a start (and no stop) as a start line fills in a start that is not recorded: a
 * missing one (addEvent), or one that is only the date of the list that named the drug (a row filed before 2026-10-06
 * and never changed since, see readStartRecorded), which gives way to the stated start. A start that is recorded is
 * never changed here. `automatic` (automatic filing): the line changes nothing else on the medication (addEvent).
 */
export function acceptFromFacts(raw: unknown, opts: { automatic?: boolean } = {}): AcceptResult {
  const input = parseInput(acceptInput, raw);
  const d = db();
  // Already accepted?
  const med = medSelect().where(and(eq(schema.medications.sourceFactId, input.factId), isNull(schema.medications.deletedAt))).get();
  if (med) return { kind: 'medication', existing: true, medication: getMedication(med.id) };
  const intol = d.select().from(schema.intolerances).where(and(eq(schema.intolerances.sourceFactId, input.factId), isNull(schema.intolerances.deletedAt))).get();
  if (intol) return { kind: 'intolerance', existing: true, intolerance: decorateIntolerance(intol) };
  const ev = d
    .select({ e: schema.medicationEvents, medId: schema.medications.id })
    .from(schema.medicationEvents)
    .innerJoin(schema.medications, and(eq(schema.medications.id, schema.medicationEvents.medicationId), isNull(schema.medications.deletedAt)))
    .where(and(eq(schema.medicationEvents.sourceFactId, input.factId), isNull(schema.medicationEvents.deletedAt)))
    .get();
  if (ev) return { kind: 'event', existing: true, medication: getMedication(ev.medId), event: { ...ev.e, sourceFact: sourceFactRef(ev.e.sourceFactId) } };

  const fact = d
    .select({
      id: schema.facts.id,
      type: schema.facts.type,
      statement: schema.facts.statement,
      status: schema.facts.status,
      date: schema.facts.date,
      datePrecision: schema.facts.datePrecision,
      dateText: schema.facts.dateText,
      dateEnd: schema.facts.dateEnd,
      attributesJson: schema.facts.attributesJson,
      personId: schema.facts.personId,
      sourceDocumentId: schema.facts.sourceDocumentId,
      documentTitle: schema.documents.title,
      deletedAt: schema.facts.deletedAt,
    })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(eq(schema.facts.id, input.factId))
    .get();
  if (!fact || fact.deletedAt) throw notFound('fact not found');
  if (fact.type !== 'medication' && fact.type !== 'allergy_intolerance') throw badRequest('only medication and allergy_intolerance facts can be accepted here');
  if (fact.status === 'disputed' || fact.status === 'superseded') throw badRequest(`a ${fact.status} fact cannot be accepted`);

  const proposal = proposalFor(
    fact,
    loadPeopleIndex(),
    d.select({ id: schema.medications.id, name: schema.medications.name, genericName: schema.medications.genericName }).from(schema.medications).where(isNull(schema.medications.deletedAt)).all(),
    d.select({ id: schema.intolerances.id, substance: schema.intolerances.substance }).from(schema.intolerances).where(isNull(schema.intolerances.deletedAt)).all(),
  );
  const overrides = input.overrides ?? {};

  if (proposal.kind === 'intolerance') {
    if (input.medicationId) throw badRequest('an allergy_intolerance fact cannot be attached to a medication');
    const intolerance = createIntolerance({ ...proposal.proposed, ...overrides, sourceFactId: fact.id });
    return { kind: 'intolerance', existing: false, intolerance };
  }

  if (input.medicationId) {
    const target = medRow(input.medicationId);
    const p = proposal.proposed as { startDateText?: string | null; stopDateText?: string | null; dose?: string | null; unit?: string | null; status?: string };
    const attrs = parseJson<MedicationAttrs>(fact.attributesJson, {});
    const hasStart = Boolean(clean(attrs.start_date));
    const hasStop = Boolean(clean(attrs.stop_date) || fact.dateEnd);
    // The fact becomes a ledger line on the existing course: a stop when it only knows an end, a start when the
    // document states a beginning, else a note. A detail that only says the drug is taken (status active, on a list)
    // is a note dated when it was listed: a start line would give the course that date as its start.
    const inferred: MedEventKind = input.eventKind ?? (hasStop && !hasStart ? 'stop' : hasStart ? 'start' : p.status === 'stopped' ? 'stop' : 'note');
    // A line is dated by the start the document states, else by the detail's own date (when it was written down).
    const mention = fact.dateText ?? fact.date ?? null;
    const startOrMention = p.startDateText ?? mention;
    // A start the detail states, attached as a start line, replaces a start that is only a list's date (read before
    // the line is added: adding it may change the row).
    const listDateStart = inferred === 'start' && hasStart && !hasStop && Boolean(target.startDate || target.startDateText) && !startRecorded(target);
    // Overrides may adjust the date, detail or dose; the kind (eventKind or inferred) and the fact link are pinned.
    const event = addEvent(
      target.id,
      {
        dateText: inferred === 'stop' ? (p.stopDateText ?? startOrMention ?? null) : (startOrMention ?? p.stopDateText ?? null),
        detail: fact.statement,
        dose: doseLabel({ dose: p.dose ?? null, unit: p.unit ?? null }),
        ...overrides,
        kind: inferred,
        sourceFactId: fact.id,
      },
      { automatic: opts.automatic },
    );
    if (listDateStart && (event.date || event.dateText)) {
      const now = medRow(target.id);
      // Only while the row still has that list date (a restart by the user's own line has moved it already).
      if (now.startDate === target.startDate && now.startDatePrecision === target.startDatePrecision && now.startDateText === target.startDateText) {
        const set: Partial<MedicationInsert> = { startDate: event.date, startDatePrecision: event.datePrecision, startDateText: event.dateText };
        if (!opts.automatic) set.updatedAt = nowIso();
        db().update(schema.medications).set(set).where(eq(schema.medications.id, target.id)).run();
        indexMedication(medRow(target.id));
      }
    }
    return { kind: 'event', existing: false, medication: getMedication(target.id), event };
  }

  const medication = createMedication({ ...proposal.proposed, ...overrides, sourceFactId: fact.id });
  return { kind: 'medication', existing: false, medication };
}

// ---------------------------------------------------------------------------
// Emergency card
// ---------------------------------------------------------------------------

interface DiagnosisAttrs {
  name?: string | null;
  certainty?: string | null;
  stated_by?: string | null;
}

/**
 * The subject a diagnosis fact is about: its stored subject key when that
 * names something, else the name (or, unnamed, the statement) keyed the same
 * way. Null when nothing usable is left.
 */
function diagnosisSubject(stored: string | null, a: DiagnosisAttrs, statement: string): string | null {
  if (stored && hasSubject(stored)) return stored;
  const key = factSubjectKey({ type: 'diagnosis', attributes: { name: clean(a.name) ?? statement } });
  return hasSubject(key) ? key : null;
}

/**
 * Confirmed diagnosis facts, newest first, one per subject. The newest
 * confirmed verdict on a subject wins, so a later ruled-out verdict hides
 * older mentions of the same diagnosis.
 */
export function confirmedDiagnoses(): EmergencyCardDiagnosis[] {
  const f = schema.facts;
  const rows = db()
    .select({
      id: f.id,
      statement: f.statement,
      date: f.date,
      datePrecision: f.datePrecision,
      dateText: f.dateText,
      attributesJson: f.attributesJson,
      subjectKey: f.subjectKey,
      documentId: f.sourceDocumentId,
      documentTitle: schema.documents.title,
      createdAt: f.createdAt,
    })
    .from(f)
    .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
    .where(and(eq(f.type, 'diagnosis'), eq(f.status, 'confirmed'), isNull(f.deletedAt), or(isNull(f.sourceDocumentId), isNull(schema.documents.deletedAt))!))
    .orderBy(sql`(${f.date} is null) asc`, desc(f.date), desc(f.createdAt))
    .all();
  const out: EmergencyCardDiagnosis[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const a = parseJson<DiagnosisAttrs>(r.attributesJson, {});
    const key = diagnosisSubject(r.subjectKey, a, r.statement);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (a.certainty === 'ruled_out') continue;
    out.push({
      id: r.id,
      statement: r.statement,
      name: clean(a.name),
      certainty: clean(a.certainty),
      statedBy: clean(a.stated_by),
      date: r.date,
      datePrecision: r.datePrecision,
      dateText: r.dateText,
      documentId: r.documentId,
      documentTitle: r.documentTitle ?? null,
    });
  }
  return out;
}

const CONTACT_KIND_RANK: Record<string, number> = { chief_of_staff: 0, advocate: 1, family: 2, clinician: 3, clinic: 4, institution: 5, other: 6 };

/** People a stranger in an emergency department could call: anyone with a phone, fax or email, support people first. */
export function keyContacts(limit = 16): EmergencyCardContact[] {
  const p = schema.people;
  const inst = alias(schema.people, 'inst');
  const rows = db()
    .select({
      id: p.id,
      name: p.name,
      kind: p.kind,
      role: p.role,
      specialty: p.specialty,
      institutionName: inst.name,
      phone: p.phone,
      fax: p.fax,
      email: p.email,
      portal: p.portal,
    })
    .from(p)
    .leftJoin(inst, eq(inst.id, p.institutionId))
    .where(and(isNull(p.deletedAt), notInArray(p.kind, ['patient']), or(sql`nullif(trim(${p.phone}), '') is not null`, sql`nullif(trim(${p.fax}), '') is not null`, sql`nullif(trim(${p.email}), '') is not null`)!))
    .all();
  rows.sort((a, b) => (CONTACT_KIND_RANK[a.kind] ?? 9) - (CONTACT_KIND_RANK[b.kind] ?? 9) || a.name.localeCompare(b.name));
  return rows.slice(0, limit).map((r) => ({ ...r, institutionName: r.institutionName ?? null }));
}

export function emergencyCard(): EmergencyCard {
  const contacts = String(getSetting('patient.emergencyContacts') ?? '');
  const intolerances = listIntolerances({ active: true });
  return {
    patient: {
      name: String(getSetting('patient.name') ?? ''),
      dob: String(getSetting('patient.dob') ?? ''),
      bloodType: String(getSetting('patient.bloodType') ?? ''),
      emergencyContacts: contacts,
      emergencyContactLines: contacts
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      summary: String(getSetting('patient.summary') ?? ''),
    },
    hardStops: intolerances.filter((i) => i.hardStop),
    intolerances: intolerances.filter((i) => !i.hardStop),
    activeMedications: listMedications({ status: 'current' }),
    diagnoses: confirmedDiagnoses(),
    keyContacts: keyContacts(),
    generatedAt: nowIso(),
  };
}
