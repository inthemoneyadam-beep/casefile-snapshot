/**
 * Records inventory: what records exist or should exist, where each lives,
 * whether we hold a copy and in what form, and the request lifecycle.
 *
 * Gap detection lives here too. A gap is either an inventory row that is not
 * held (expected / requested / not_held / denied) or a `record_reference` fact
 * extracted from a document ("compared with the PET of March 2024") whose
 * referenced record is not in the document itself and matches no inventory
 * row. The matching rule is `matchesInventory`, exported and tested on its own.
 */
import { z } from 'zod';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, or, sql, type SQLWrapper } from 'drizzle-orm';
import { db, schema } from '../db';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { badRequest, notFound, parseOrThrow } from '../util/errors';
import { indexEntity, removeEntityIndex } from './search';
import { onLockChange } from '../auth';
import { RECORD_FORMATS, RECORD_STATUSES, RECORD_TYPES } from '../../shared/enums';
import { dateSortKey, datesAgree, daysBetween, parsePartialDate, todayIso, type DatePrecision } from '../../shared/dates';
import { LONG_TEXT_MAX } from '../../shared/constants';
import { localDayOf } from '../util/localtime';

/** Inventory statuses that mean "we do not hold this yet". */
const GAP_STATUSES = new Set<string>(['expected', 'requested', 'not_held', 'denied']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordRow = typeof schema.recordsInventory.$inferSelect;
export type RecordInsert = typeof schema.recordsInventory.$inferInsert;
export type RecordWithNames = RecordRow & { institutionName: string | null; documentTitle: string | null };

export type RecordType = (typeof RECORD_TYPES)[number];
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** The minimum a referenced record must say about itself for matching. */
export interface RecordRef {
  recordType: string;
  description: string;
  institution: string | null;
  institutionId?: string | null;
  date: string | null;
  datePrecision?: DatePrecision | string | null;
}

/** The minimum an inventory row must expose for matching. */
export interface InventoryLike {
  recordType: string;
  title: string;
  institutionId: string | null;
  institutionName?: string | null;
  recordDate: string | null;
  recordDatePrecision?: string | null;
}

export interface GapCitation {
  citationId: string;
  documentId: string;
  documentTitle: string | null;
  pageNumber: number;
  quote: string;
  verified: boolean;
}

export interface Gap {
  kind: 'inventory' | 'inferred';
  id: string;
  title: string;
  recordType: string;
  institution: string | null;
  institutionId: string | null;
  date: string | null;
  datePrecision: DatePrecision | string;
  dateText: string | null;
  status: string;
  sourceFactId: string | null;
  factStatement: string | null;
  factStatus: string | null;
  sourceDocumentId: string | null;
  sourceDocumentTitle: string | null;
  citation?: GapCitation;
  matchedRecordId: string | null;
  likelyHeldDocumentId: string | null;
  likelyHeldDocumentTitle: string | null;
  /** The likely-held document's own date, so the UI only claims a date match when both sides have one. */
  likelyHeldDocumentDate?: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const nullableText = z.string().trim().max(LONG_TEXT_MAX).nullable().optional();
const dayText = z
  .string()
  .trim()
  .max(64)
  .nullable()
  .optional()
  .transform((v) => (v ? toDay(v) : v === '' ? null : v));

/**
 * Field schemas without defaults. The create schema adds defaults; the patch
 * schema must not, because in zod 4 `.partial()` over a `.default()` field
 * still yields the default for a missing key, which would silently reset
 * type, format, held, and status on every PATCH.
 */
const recordFields = {
  title: z.string().trim().min(1).max(500),
  recordType: z.enum(RECORD_TYPES),
  institutionId: nullableText,
  /** Convenience: a name to resolve against people of kind institution/clinic when no id is given. */
  institutionName: nullableText,
  system: nullableText,
  format: z.enum(RECORD_FORMATS),
  held: z.boolean(),
  heldForm: nullableText,
  documentId: nullableText,
  status: z.enum(RECORD_STATUSES),
  recordDate: nullableText,
  recordDateText: nullableText,
  requestedAt: dayText,
  receivedAt: dayText,
  expectedBy: dayText,
  sourceFactId: nullableText,
  notes: nullableText,
};

export const recordInput = z.object({
  ...recordFields,
  recordType: recordFields.recordType.default('other'),
  format: recordFields.format.default('unknown'),
  held: recordFields.held.default(false),
  status: recordFields.status.default('unknown'),
});
export type RecordInput = z.infer<typeof recordInput>;

export const recordPatch = z.object(recordFields).partial();
export type RecordPatch = z.infer<typeof recordPatch>;

export const listQuery = z.object({
  status: z.string().optional(),
  recordType: z.string().optional(),
  institutionId: z.string().optional(),
  q: z.string().optional(),
  held: z.string().optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

function toDay(v: string): string {
  const p = parsePartialDate(v);
  return p.iso ?? v;
}

// ---------------------------------------------------------------------------
// Text helpers: tokens and modality keywords
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'without', 'from', 'that', 'this', 'was', 'were', 'are', 'has', 'had', 'have', 'been',
  'not', 'per', 'via', 'our', 'his', 'her', 'their', 'its', 'any', 'all', 'but', 'into', 'onto', 'over', 'under',
  'report', 'reports', 'record', 'records', 'result', 'results', 'study', 'studies', 'scan', 'scans', 'exam', 'examination',
  'imaging', 'image', 'images', 'film', 'films', 'copy', 'copies', 'note', 'notes', 'outside', 'hospital', 'clinic', 'center', 'centre',
  'medical', 'dated', 'date', 'performed', 'done', 'obtained', 'prior', 'previous', 'recent', 'reviewed', 'review',
  'patient', 'patients', 'please', 'request', 'requested', 'records', 'see', 'per', 'vs', 'etc',
]);

/** Modality keywords, matched as whole words in normalised text. Multi-word entries are allowed. */
export const MODALITY_KEYWORDS = [
  'mri', 'ct', 'pet', 'spect', 'eeg', 'emg', 'ncs', 'ultrasound', 'us', 'xray', 'x-ray', 'lp', 'lumbar', 'puncture', 'csf',
  'biopsy', 'pathology', 'genetic', 'panel', 'labs', 'bloodwork', 'mra', 'mrv', 'angiogram', 'echocardiogram', 'echo', 'ekg', 'ecg',
  'holter', 'sleep study', 'polysomnogram', 'tilt',
] as const;

const NORMALISED_KEYWORDS = MODALITY_KEYWORDS.map((k) => ({ raw: k, norm: normalizeKey(k) }));
/** Every word of every modality keyword, to tell a description's subject ("brain") from its modality ("MRI"). */
const KEYWORD_WORDS = new Set(NORMALISED_KEYWORDS.flatMap((k) => k.norm.split(' ')).filter(Boolean));

/** Tokens of length >= 3 after normalisation, minus stop words. */
export function descriptionTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of normalizeKey(text).split(' ')) {
    if (t.length >= 3 && !STOP_WORDS.has(t)) out.add(t);
  }
  return out;
}

/** |A ∩ B| / min(|A|, |B|); 0 when either side is empty. */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Modality keywords present in a text, as their canonical (raw) spelling. */
export function modalityKeywords(text: string | null | undefined): Set<string> {
  const padded = ` ${normalizeKey(text)} `;
  const out = new Set<string>();
  for (const k of NORMALISED_KEYWORDS) {
    if (!k.norm) continue;
    if (padded.includes(` ${k.norm} `)) out.add(k.norm);
  }
  return out;
}

function sharesKeyword(a: Set<string>, b: Set<string>): boolean {
  for (const k of a) if (b.has(k)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Institution resolution
// ---------------------------------------------------------------------------

interface InstitutionRow {
  id: string;
  name: string;
  aliases: string[];
}

function loadInstitutions(): InstitutionRow[] {
  const rows = db()
    .select({ id: schema.people.id, name: schema.people.name, aliasesJson: schema.people.aliasesJson })
    .from(schema.people)
    .where(and(isNull(schema.people.deletedAt), inArray(schema.people.kind, ['institution', 'clinic'])))
    .all();
  return rows.map((r) => ({ id: r.id, name: r.name, aliases: parseJson<string[]>(r.aliasesJson, []) }));
}

/** Exact or alias match (after normalisation) against people of kind institution/clinic. */
export function resolveInstitutionId(name: string | null | undefined, institutions: InstitutionRow[] = loadInstitutions()): string | null {
  const key = normalizeKey(name);
  if (!key) return null;
  for (const inst of institutions) {
    if (normalizeKey(inst.name) === key) return inst.id;
  }
  for (const inst of institutions) {
    if (inst.aliases.some((a) => normalizeKey(a) === key)) return inst.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The matching rule
// ---------------------------------------------------------------------------

/**
 * Does a referenced record match an inventory row?
 * 1. Same record type (imaging_report and imaging_images are different).
 * 2. Institution equal after normalisation, or missing on either side. Ids
 *    win when both sides have one; otherwise names are compared.
 * 3. Dates agree at their precision; ±14 days when both are day precision.
 * 4. Description token overlap >= 0.4, or a shared modality keyword.
 */
export function matchesInventory(ref: RecordRef, row: InventoryLike): boolean {
  if (normalizeKey(ref.recordType) !== normalizeKey(row.recordType)) return false;

  const refId = ref.institutionId ?? null;
  const rowId = row.institutionId ?? null;
  if (refId && rowId) {
    if (refId !== rowId) return false;
  } else {
    const a = normalizeKey(ref.institution);
    const b = normalizeKey(row.institutionName);
    if (a && b && a !== b) return false;
  }

  if (!datesAgree(ref.date ?? null, row.recordDate ?? null, 14)) return false;

  const refText = ref.description ?? '';
  const rowText = row.title ?? '';
  const overlap = tokenOverlap(descriptionTokens(refText), descriptionTokens(rowText));
  if (overlap >= 0.4) return true;
  return sharesKeyword(modalityKeywords(refText), modalityKeywords(rowText));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const withNames = {
  ...getTableColumns(schema.recordsInventory),
  institutionName: schema.people.name,
  documentTitle: schema.documents.title,
};

function baseSelect() {
  return db()
    .select(withNames)
    .from(schema.recordsInventory)
    .leftJoin(schema.people, eq(schema.people.id, schema.recordsInventory.institutionId))
    .leftJoin(schema.documents, eq(schema.documents.id, schema.recordsInventory.documentId));
}

export function listRecords(q: ListQuery = {}): RecordWithNames[] {
  const conds = [isNull(schema.recordsInventory.deletedAt)];
  if (q.status) conds.push(inArray(schema.recordsInventory.status, q.status.split(',').map((s) => s.trim()).filter(Boolean)));
  if (q.recordType) conds.push(inArray(schema.recordsInventory.recordType, q.recordType.split(',').map((s) => s.trim()).filter(Boolean)));
  if (q.institutionId) conds.push(eq(schema.recordsInventory.institutionId, q.institutionId));
  if (q.held === '1' || q.held === 'true') conds.push(eq(schema.recordsInventory.held, true));
  if (q.held === '0' || q.held === 'false') conds.push(eq(schema.recordsInventory.held, false));
  const needle = (q.q ?? '').trim();
  if (needle) {
    // SQLite LIKE has no default escape character: escape %, _ and the
    // backslash itself, and name the backslash in an ESCAPE clause.
    const pat = `%${needle.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const likeEsc = (col: SQLWrapper) => sql`${col} like ${pat} escape '\\'`;
    conds.push(
      or(
        likeEsc(schema.recordsInventory.title),
        likeEsc(schema.recordsInventory.notes),
        likeEsc(schema.recordsInventory.system),
        likeEsc(schema.recordsInventory.recordType),
        likeEsc(schema.people.name),
        likeEsc(schema.documents.title),
      )!,
    );
  }
  return baseSelect()
    .where(and(...conds))
    .orderBy(desc(sql`coalesce(${schema.recordsInventory.recordDate}, '')`), asc(schema.recordsInventory.title))
    .all();
}

export function getRecord(id: string): RecordWithNames {
  const row = baseSelect().where(and(eq(schema.recordsInventory.id, id), isNull(schema.recordsInventory.deletedAt))).get();
  if (!row) throw notFound('record not found');
  return row;
}

export function recordCounts(): { all: number; held: number; requested: number; gaps: number } {
  const rows = db()
    .select({ status: schema.recordsInventory.status, held: schema.recordsInventory.held, n: sql<number>`count(*)` })
    .from(schema.recordsInventory)
    .where(isNull(schema.recordsInventory.deletedAt))
    .groupBy(schema.recordsInventory.status, schema.recordsInventory.held)
    .all();
  let all = 0, held = 0, requested = 0, gaps = 0;
  for (const r of rows) {
    all += r.n;
    if (r.held) held += r.n;
    if (r.status === 'requested') requested += r.n;
    // A held row re-requested (e.g. asking for the images when we hold the report) is not a gap.
    if (GAP_STATUSES.has(r.status) && !r.held) gaps += r.n;
  }
  return { all, held, requested, gaps };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function indexRecord(row: RecordRow, institutionName: string | null): void {
  const body = [row.recordType.replace(/_/g, ' '), institutionName, row.system, row.notes, row.status.replace(/_/g, ' ')].filter(Boolean).join(' · ');
  indexEntity('record', row.id, row.title, body);
}

/**
 * A row write and its search entry in one transaction: when indexing fails the write is undone, so search never misses
 * a row or keeps its old words (CLAUDE.md: the full-text tables stay in sync; sweep 2026-10-07, PAT-6).
 */
function writeIndexed(id: string, write: () => unknown): RecordWithNames {
  return db().transaction(() => {
    write();
    const saved = getRecord(id);
    indexRecord(saved, saved.institutionName);
    return saved;
  });
}

function assertDocument(documentId: string | null | undefined): void {
  if (!documentId) return;
  const d = db().select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get();
  if (!d) throw badRequest('documentId does not refer to an existing document');
}

function applyRecordDate(input: { recordDate?: string | null; recordDateText?: string | null }, current?: RecordRow): Pick<RecordInsert, 'recordDate' | 'recordDatePrecision' | 'recordDateText'> {
  // An explicit ISO date wins; otherwise derive from the text; otherwise keep what is there.
  if (input.recordDate !== undefined && input.recordDate !== null && input.recordDate !== '') {
    const p = parsePartialDate(input.recordDate);
    return { recordDate: p.iso, recordDatePrecision: p.precision, recordDateText: input.recordDateText ?? current?.recordDateText ?? input.recordDate };
  }
  if (input.recordDateText !== undefined) {
    const p = parsePartialDate(input.recordDateText);
    return { recordDate: p.iso, recordDatePrecision: p.precision, recordDateText: p.text };
  }
  if (input.recordDate === null) return { recordDate: null, recordDatePrecision: 'unknown', recordDateText: current?.recordDateText ?? null };
  return { recordDate: current?.recordDate ?? null, recordDatePrecision: current?.recordDatePrecision ?? 'unknown', recordDateText: current?.recordDateText ?? null };
}

export function createRecord(raw: unknown): RecordWithNames {
  const input = parseOrThrow(recordInput, raw);
  assertDocument(input.documentId);
  const institutionId = input.institutionId || resolveInstitutionId(input.institutionName) || null;
  const now = nowIso();
  const row: RecordInsert = {
    id: newId(),
    title: input.title,
    recordType: input.recordType,
    institutionId,
    system: input.system ?? null,
    format: input.format,
    held: input.held,
    heldForm: input.heldForm ?? null,
    documentId: input.documentId ?? null,
    status: input.status,
    ...applyRecordDate(input),
    requestedAt: input.requestedAt ?? null,
    receivedAt: input.receivedAt ?? null,
    expectedBy: input.expectedBy ?? null,
    sourceFactId: input.sourceFactId ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
  if (row.documentId && !row.held && row.status === 'unknown') {
    // A linked document means we hold it; an explicit status is kept as given.
    row.held = true;
    row.status = 'received';
  }
  return writeIndexed(row.id, () => db().insert(schema.recordsInventory).values(row).run());
}

export function updateRecord(id: string, raw: unknown): RecordWithNames {
  const current = getRecord(id);
  const patch = parseOrThrow(recordPatch, raw);
  if (patch.documentId !== undefined) assertDocument(patch.documentId);
  const set: Partial<RecordInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.recordType !== undefined) set.recordType = patch.recordType;
  if (patch.institutionId !== undefined) set.institutionId = patch.institutionId || null;
  else if (patch.institutionName !== undefined) set.institutionId = resolveInstitutionId(patch.institutionName);
  if (patch.system !== undefined) set.system = patch.system;
  if (patch.format !== undefined) set.format = patch.format;
  if (patch.held !== undefined) set.held = patch.held;
  if (patch.heldForm !== undefined) set.heldForm = patch.heldForm;
  if (patch.documentId !== undefined) set.documentId = patch.documentId || null;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.recordDate !== undefined || patch.recordDateText !== undefined) Object.assign(set, applyRecordDate(patch, current));
  if (patch.requestedAt !== undefined) set.requestedAt = patch.requestedAt;
  if (patch.receivedAt !== undefined) set.receivedAt = patch.receivedAt;
  if (patch.expectedBy !== undefined) set.expectedBy = patch.expectedBy;
  if (patch.sourceFactId !== undefined) set.sourceFactId = patch.sourceFactId;
  if (patch.notes !== undefined) set.notes = patch.notes;
  return writeIndexed(id, () => db().update(schema.recordsInventory).set(set).where(eq(schema.recordsInventory.id, id)).run());
}

export function deleteRecord(id: string): void {
  getRecord(id);
  db().transaction(() => {
    db().update(schema.recordsInventory).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(schema.recordsInventory.id, id)).run();
    removeEntityIndex('record', id);
  });
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export const transitionInput = z.object({
  requestedAt: dayText,
  receivedAt: dayText,
  documentId: nullableText,
  note: nullableText,
});

function appendNote(current: string | null, line: string | null | undefined): string | null {
  if (!line) return current;
  return current ? `${current}\n${line}` : line;
}

export function requestRecord(id: string, raw: unknown = {}): RecordWithNames {
  const current = getRecord(id);
  const input = parseOrThrow(transitionInput, raw ?? {});
  return writeIndexed(id, () =>
    db()
      .update(schema.recordsInventory)
      .set({ status: 'requested', requestedAt: input.requestedAt ?? todayIso(), notes: appendNote(current.notes, input.note), updatedAt: nowIso() })
      .where(eq(schema.recordsInventory.id, id))
      .run(),
  );
}

export function receiveRecord(id: string, raw: unknown = {}): RecordWithNames {
  const current = getRecord(id);
  const input = parseOrThrow(transitionInput, raw ?? {});
  const set: Partial<RecordInsert> = { status: 'received', held: true, receivedAt: input.receivedAt ?? todayIso(), notes: appendNote(current.notes, input.note), updatedAt: nowIso() };
  if (input.documentId) {
    const doc = loadDocument(input.documentId);
    set.documentId = doc.id;
    set.heldForm = current.heldForm ?? heldFormForKind(doc.kind);
    if (current.format === 'unknown') set.format = formatForKind(doc.kind);
  }
  return writeIndexed(id, () => db().update(schema.recordsInventory).set(set).where(eq(schema.recordsInventory.id, id)).run());
}

/**
 * A row we do not hold cannot also link the document that would be its copy.
 * Clear the link and held form, and keep a line in the notes naming the
 * document that was unlinked so the change is visible and reversible.
 */
function notHeldSet(current: RecordWithNames, status: 'not_held' | 'denied', note: string | null | undefined): Partial<RecordInsert> {
  const label = status === 'not_held' ? 'not held' : 'denied';
  let notes = appendNote(current.notes, note);
  if (current.documentId) notes = appendNote(notes, `Unlinked document "${current.documentTitle ?? current.documentId}" (${current.documentId}) when marked ${label}.`);
  return { status, held: false, documentId: null, heldForm: null, notes, updatedAt: nowIso() };
}

export function markNotHeld(id: string, raw: unknown = {}): RecordWithNames {
  const current = getRecord(id);
  const input = parseOrThrow(transitionInput, raw ?? {});
  return writeIndexed(id, () => db().update(schema.recordsInventory).set(notHeldSet(current, 'not_held', input.note)).where(eq(schema.recordsInventory.id, id)).run());
}

export function markDenied(id: string, raw: unknown = {}): RecordWithNames {
  const current = getRecord(id);
  const input = parseOrThrow(transitionInput, raw ?? {});
  return writeIndexed(id, () => db().update(schema.recordsInventory).set(notHeldSet(current, 'denied', input.note)).where(eq(schema.recordsInventory.id, id)).run());
}

// ---------------------------------------------------------------------------
// From a document
// ---------------------------------------------------------------------------

type DocumentRow = typeof schema.documents.$inferSelect;

function loadDocument(documentId: string): DocumentRow {
  const doc = db().select().from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get();
  if (!doc) throw notFound('document not found');
  return doc;
}

/** The form we hold a document in, from its file kind. */
export function heldFormForKind(kind: string): string {
  switch (kind) {
    case 'dicom':
      return 'dicom';
    case 'image':
      return 'images';
    case 'pdf':
    case 'docx':
    case 'text':
    case 'audio_transcript':
      return 'report';
    default:
      return 'raw';
  }
}

export function formatForKind(kind: string): (typeof RECORD_FORMATS)[number] {
  const f = heldFormForKind(kind);
  return (RECORD_FORMATS as readonly string[]).includes(f) ? (f as (typeof RECORD_FORMATS)[number]) : 'unknown';
}

/** Record type implied by a document's category and kind. */
export function recordTypeForDocument(doc: { category: string; kind: string }): RecordType {
  if (doc.kind === 'dicom') return 'dicom';
  switch (doc.category) {
    case 'clinical_note':
      return 'clinical_note';
    case 'lab_report':
      return 'lab';
    case 'imaging_report':
      return 'imaging_report';
    case 'pathology':
      return 'pathology';
    case 'operative_report':
      return 'operative_report';
    case 'discharge_summary':
      return 'discharge_summary';
    case 'portal_message':
      return 'portal_thread';
    default:
      return 'other';
  }
}

export const fromDocumentInput = z.object({
  documentId: z.string().min(1),
  recordType: z.enum(RECORD_TYPES).optional(),
  /** The record_reference fact this document answers (an inferred gap). Stored on the row so the gap resolves. */
  sourceFactId: z.string().min(1).optional(),
});

function assertReferenceFact(factId: string): void {
  const fact = db().select({ id: schema.facts.id, type: schema.facts.type }).from(schema.facts).where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt))).get();
  if (!fact) throw notFound('fact not found');
  if (fact.type !== 'record_reference') throw badRequest('sourceFactId must be a record_reference fact');
}

/**
 * Create a held inventory row for a document. Idempotent: an existing live row
 * linked to the same document is returned with `existing: true`.
 *
 * With `sourceFactId` (the user says this document is the record an inferred
 * gap refers to), the new row remembers the fact so the gap resolves. When a
 * row for the document already exists and answers no fact yet, the fact is
 * set on that row instead of creating a second one. A row that already answers
 * a different fact is left unchanged; `factLinked` tells the caller whether
 * the returned row now carries the requested fact.
 */
export function createFromDocument(raw: unknown): RecordWithNames & { existing: boolean; factLinked: boolean } {
  const input = parseOrThrow(fromDocumentInput, raw);
  const doc = loadDocument(input.documentId);
  if (input.sourceFactId) assertReferenceFact(input.sourceFactId);
  const existing = baseSelect().where(and(eq(schema.recordsInventory.documentId, doc.id), isNull(schema.recordsInventory.deletedAt))).get();
  if (existing) {
    if (input.sourceFactId && !existing.sourceFactId) {
      const saved = writeIndexed(existing.id, () => db().update(schema.recordsInventory).set({ sourceFactId: input.sourceFactId, updatedAt: nowIso() }).where(eq(schema.recordsInventory.id, existing.id)).run());
      return { ...saved, existing: true, factLinked: true };
    }
    return { ...existing, existing: true, factLinked: Boolean(input.sourceFactId) && existing.sourceFactId === input.sourceFactId };
  }
  const now = nowIso();
  const row: RecordInsert = {
    id: newId(),
    title: doc.title,
    recordType: input.recordType ?? recordTypeForDocument(doc),
    institutionId: doc.institutionId ?? null,
    system: null,
    format: formatForKind(doc.kind),
    held: true,
    heldForm: heldFormForKind(doc.kind),
    documentId: doc.id,
    status: 'received',
    recordDate: doc.documentDate ?? null,
    recordDatePrecision: doc.documentDatePrecision ?? 'unknown',
    recordDateText: doc.documentDateText ?? null,
    // The case's local day (TZ), never the UTC day: an evening upload west of UTC was received that day (2026-10-09).
    receivedAt: localDayOf(doc.createdAt ?? now),
    sourceFactId: input.sourceFactId ?? null,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
  const saved = writeIndexed(row.id, () => db().insert(schema.recordsInventory).values(row).run());
  return { ...saved, existing: false, factLinked: Boolean(input.sourceFactId) };
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Document categories that could hold a record of each type. */
export function categoryFamily(recordType: string): string[] {
  switch (recordType) {
    case 'imaging_report':
    case 'imaging_images':
    case 'dicom':
      return ['imaging_report'];
    case 'lab':
    case 'genetic':
      return ['lab_report'];
    case 'pathology':
      return ['pathology'];
    case 'operative_report':
      return ['operative_report'];
    case 'discharge_summary':
      return ['discharge_summary'];
    case 'clinical_note':
      return ['clinical_note'];
    case 'portal_thread':
      return ['portal_message'];
    default:
      return ['other'];
  }
}

interface FactRow {
  id: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  attributesJson: string;
  status: string;
  sourceDocumentId: string | null;
  documentTitle: string | null;
}

interface RefAttrs {
  record_type?: string;
  description?: string;
  institution?: string | null;
  record_date?: string | null;
  present_in_this_document?: boolean;
}

/** Build a matchable reference from a record_reference fact. */
export function refFromFact(fact: { statement: string; date: string | null; datePrecision?: string | null; dateText?: string | null; attributesJson: string }, institutions?: InstitutionRow[]): RecordRef & { datePrecision: DatePrecision | string; dateText: string | null; description: string } {
  const attrs = parseJson<RefAttrs>(fact.attributesJson, {});
  let date = fact.date ?? null;
  let precision: DatePrecision | string = fact.datePrecision ?? 'unknown';
  let dateText = fact.dateText ?? null;
  if (!date && attrs.record_date) {
    const p = parsePartialDate(attrs.record_date);
    date = p.iso;
    precision = p.precision;
    dateText = p.text;
  }
  const institution = attrs.institution?.trim() || null;
  return {
    recordType: attrs.record_type ?? 'other',
    description: attrs.description?.trim() || fact.statement,
    institution,
    institutionId: institution ? resolveInstitutionId(institution, institutions) : null,
    date,
    datePrecision: precision,
    dateText,
  };
}

function candidateFacts(): FactRow[] {
  const rows = db()
    .select({
      id: schema.facts.id,
      statement: schema.facts.statement,
      date: schema.facts.date,
      datePrecision: schema.facts.datePrecision,
      dateText: schema.facts.dateText,
      attributesJson: schema.facts.attributesJson,
      status: schema.facts.status,
      sourceDocumentId: schema.facts.sourceDocumentId,
      documentTitle: schema.documents.title,
      documentDeletedAt: schema.documents.deletedAt,
    })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(and(eq(schema.facts.type, 'record_reference'), isNull(schema.facts.deletedAt), notInArray(schema.facts.status, ['disputed', 'superseded'])))
    .all();
  return rows
    .filter((r) => !(r.sourceDocumentId && r.documentDeletedAt))
    .filter((r) => parseJson<RefAttrs>(r.attributesJson, {}).present_in_this_document === false)
    .map(({ documentDeletedAt: _d, ...r }) => r);
}

/**
 * The first citation of each fact (verified first, then lowest page, then
 * oldest), in one query per 400 facts instead of one per fact.
 */
function firstCitations(factIds: string[]): Map<string, GapCitation> {
  const out = new Map<string, GapCitation>();
  const ids = [...new Set(factIds.filter(Boolean))];
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({ id: c.id, factId: c.factId, documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: c.verified, documentTitle: schema.documents.title })
      .from(c)
      .leftJoin(schema.documents, eq(schema.documents.id, c.documentId))
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .orderBy(desc(c.verified), asc(c.pageNumber), asc(c.createdAt))
      .all();
    for (const r of rows) {
      if (!r.factId || out.has(r.factId)) continue;
      out.set(r.factId, { citationId: r.id, documentId: r.documentId, documentTitle: r.documentTitle ?? null, pageNumber: r.pageNumber, quote: r.quote, verified: Boolean(r.verified) });
    }
  }
  return out;
}

export interface DocCandidate {
  id: string;
  title: string;
  category: string;
  documentDate: string | null;
}

/** Non-deleted documents as likely-held candidates, optionally limited to some categories. */
function loadCandidateDocuments(categories?: string[]): DocCandidate[] {
  const conds = [isNull(schema.documents.deletedAt)];
  if (categories) conds.push(inArray(schema.documents.category, categories));
  return db()
    .select({ id: schema.documents.id, title: schema.documents.title, category: schema.documents.category, documentDate: schema.documents.documentDate })
    .from(schema.documents)
    .where(and(...conds))
    .all();
}

/**
 * Modality keywords on each document's first page (first 4000 characters),
 * read at most once per document. `inferGaps` shares one cache across every
 * gap so the page text is not re-read per gap.
 */
export class PageKeywordCache {
  private readonly map = new Map<string, Set<string>>();

  /** Read page 1 for every id not yet cached, in one query per 400 documents. */
  load(documentIds: string[]): void {
    const missing = [...new Set(documentIds)].filter((id) => !this.map.has(id));
    const p = schema.documentPages;
    for (let i = 0; i < missing.length; i += 400) {
      const chunk = missing.slice(i, i + 400);
      const rows = db()
        .select({ documentId: p.documentId, text: sql<string | null>`substr(${p.text}, 1, 4000)` })
        .from(p)
        .where(and(inArray(p.documentId, chunk), eq(p.pageNumber, 1)))
        .all();
      const text = new Map(rows.map((r) => [r.documentId, r.text ?? '']));
      for (const id of chunk) this.map.set(id, modalityKeywords((text.get(id) ?? '').slice(0, 4000)));
    }
  }

  get(documentId: string): Set<string> {
    if (!this.map.has(documentId)) this.load([documentId]);
    return this.map.get(documentId) ?? new Set();
  }
}

/** Sort distance for a document dated only at a coarser precision than the gap (or vice versa): behind any day match within ±14 days. */
const PARTIAL_DATE_DISTANCE = 15;
/** Sort distance for an undated document against a dated gap: behind every dated candidate. */
const UNDATED_DISTANCE = Number.MAX_SAFE_INTEGER;

function dateDistance(gapDate: string, docDate: string | null): number {
  if (!docDate) return UNDATED_DISTANCE;
  if (gapDate.length === 10 && docDate.length === 10) return Math.abs(daysBetween(gapDate, docDate));
  return PARTIAL_DATE_DISTANCE;
}

/**
 * A document we already hold that probably is the missing record: right
 * category family, date agrees (±14 days), and the title or first page
 * mentions the modality keyword (or, without one, shares the description).
 *
 * Dates are handled explicitly rather than through datesAgree's null pass-through:
 * - a dated gap ranks day matches by distance, then documents that agree only
 *   at month/year precision, then undated documents last;
 * - an undated gap has no date to compare, so the page-1 text is not used and
 *   the title must share the subject as well as the modality ("MRI brain",
 *   not just "MRI"); only a single such document counts, otherwise the hint
 *   would point at an arbitrary year.
 *
 * `docs` and `pageKeywords` let `inferGaps` share one document pool and one
 * page-1 cache across every gap; single-gap callers can omit both.
 */
export function likelyHeldDocumentId(
  gap: { recordType: string; title: string; date: string | null; excludeDocumentId?: string | null },
  docs?: DocCandidate[],
  pageKeywords: PageKeywordCache = new PageKeywordCache(),
): string | null {
  const family = categoryFamily(gap.recordType);
  if (!family.length) return null;
  const pool = docs ?? loadCandidateDocuments(family);
  const kws = modalityKeywords(gap.title);
  const tokens = descriptionTokens(gap.title);
  const titleHit = (doc: DocCandidate) => (kws.size ? sharesKeyword(kws, modalityKeywords(doc.title)) : tokenOverlap(tokens, descriptionTokens(doc.title)) >= 0.4);
  const eligible = pool.filter((doc) => doc.id !== gap.excludeDocumentId && family.includes(doc.category) && datesAgree(gap.date, doc.documentDate, 14));

  if (!gap.date) {
    // No date to compare: the modality alone is not enough. The title must also
    // share the subject (the description minus modality words), and only one
    // document in the family may qualify.
    const subject = new Set([...tokens].filter((t) => !KEYWORD_WORDS.has(t)));
    const titled = eligible.filter((doc) => titleHit(doc) && tokenOverlap(subject, descriptionTokens(doc.title)) >= 0.4);
    return titled.length === 1 ? titled[0].id : null;
  }

  // rank 0: the title says it; rank 1: only the first page says it.
  const hits: Array<{ id: string; distance: number; rank: number }> = [];
  const pageChecks: DocCandidate[] = [];
  for (const doc of eligible) {
    if (titleHit(doc)) hits.push({ id: doc.id, distance: dateDistance(gap.date, doc.documentDate), rank: 0 });
    else if (kws.size) pageChecks.push(doc);
  }
  if (pageChecks.length) {
    pageKeywords.load(pageChecks.map((d) => d.id));
    for (const doc of pageChecks) {
      if (sharesKeyword(kws, pageKeywords.get(doc.id))) hits.push({ id: doc.id, distance: dateDistance(gap.date, doc.documentDate), rank: 1 });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance || a.rank - b.rank);
  return hits[0].id;
}

export interface InferGapsOptions {
  /**
   * Default true. False skips the likely-held document and citation lookups
   * (the gaps come back with `likelyHeldDocumentId: null` and no `citation`);
   * use it when only the number of gaps is needed.
   */
  resolveLikely?: boolean;
}

/**
 * Every gap: inventory rows that are not held, plus record_reference facts
 * whose referenced record matches no inventory row at all.
 *
 * Query cost is O(gaps + documents): the document pool, page-1 keywords and
 * citations are each loaded once for the whole call.
 */
export function inferGaps(opts: InferGapsOptions = {}): Gap[] {
  const resolveLikely = opts.resolveLikely !== false;
  const institutions = loadInstitutions();
  const institutionNames = new Map(institutions.map((i) => [i.id, i.name]));
  const rows = listRecords();
  const held = rows.filter((r) => r.held || r.status === 'received');
  const answeredFacts = new Set(rows.map((r) => r.sourceFactId).filter((id): id is string => Boolean(id)));

  // One document pool for the whole call, grouped by category.
  const docsById = new Map<string, DocCandidate>();
  const docsByCategory = new Map<string, DocCandidate[]>();
  if (resolveLikely) {
    for (const doc of loadCandidateDocuments()) {
      docsById.set(doc.id, doc);
      const list = docsByCategory.get(doc.category);
      if (list) list.push(doc);
      else docsByCategory.set(doc.category, [doc]);
    }
  }
  const pageKeywords = new PageKeywordCache();
  const likelyFor = (gap: { recordType: string; title: string; date: string | null; excludeDocumentId?: string | null }) => {
    if (!resolveLikely) return { likelyHeldDocumentId: null, likelyHeldDocumentTitle: null, likelyHeldDocumentDate: null };
    const pool = categoryFamily(gap.recordType).flatMap((c) => docsByCategory.get(c) ?? []);
    const id = likelyHeldDocumentId(gap, pool, pageKeywords);
    const doc = id ? docsById.get(id) : undefined;
    return { likelyHeldDocumentId: id, likelyHeldDocumentTitle: doc?.title ?? null, likelyHeldDocumentDate: doc?.documentDate ?? null };
  };

  const out: Gap[] = [];

  for (const r of rows) {
    // Not held: a held row that was re-requested (e.g. for the images) is not a gap.
    if (!GAP_STATUSES.has(r.status) || r.held) continue;
    const asRef: RecordRef = { recordType: r.recordType, description: r.title, institution: r.institutionName, institutionId: r.institutionId, date: r.recordDate, datePrecision: r.recordDatePrecision };
    const twin = held.find((h) => h.id !== r.id && matchesInventory(asRef, h));
    const likely = r.documentId ? { likelyHeldDocumentId: null, likelyHeldDocumentTitle: null, likelyHeldDocumentDate: null } : likelyFor({ recordType: r.recordType, title: r.title, date: r.recordDate });
    out.push({
      kind: 'inventory',
      id: r.id,
      title: r.title,
      recordType: r.recordType,
      institution: r.institutionName,
      institutionId: r.institutionId,
      date: r.recordDate,
      datePrecision: r.recordDatePrecision,
      dateText: r.recordDateText,
      status: r.status,
      sourceFactId: r.sourceFactId,
      factStatement: null,
      factStatus: null,
      sourceDocumentId: null,
      sourceDocumentTitle: null,
      matchedRecordId: twin?.id ?? null,
      ...likely,
    });
  }

  const inferred: Array<{ f: FactRow; ref: ReturnType<typeof refFromFact> }> = [];
  const holds = encounterHolds();
  for (const f of candidateFacts()) {
    if (answeredFacts.has(f.id)) continue;
    const ref = refFromFact(f, institutions);
    if (rows.some((r) => matchesInventory(ref, r))) continue;
    // Held inside an export: an encounter of a chart print (its own held row, linked from its pages) answers it.
    if (holds.some((h) => matchesEncounterHold(ref, h))) continue;
    inferred.push({ f, ref });
  }
  const citations = resolveLikely ? firstCitations(inferred.map((x) => x.f.id)) : new Map<string, GapCitation>();
  for (const { f, ref } of inferred) {
    const citation = citations.get(f.id);
    out.push({
      kind: 'inferred',
      id: f.id,
      title: ref.description,
      recordType: ref.recordType,
      institution: ref.institution ?? (ref.institutionId ? (institutionNames.get(ref.institutionId) ?? null) : null),
      institutionId: ref.institutionId ?? null,
      date: ref.date,
      datePrecision: ref.datePrecision,
      dateText: ref.dateText,
      status: 'inferred',
      sourceFactId: f.id,
      factStatement: f.statement,
      factStatus: f.status,
      sourceDocumentId: f.sourceDocumentId,
      sourceDocumentTitle: f.documentTitle,
      ...(citation ? { citation } : {}),
      matchedRecordId: null,
      ...likelyFor({ recordType: ref.recordType, title: ref.description, date: ref.date, excludeDocumentId: f.sourceDocumentId }),
    });
  }

  out.sort((a, b) => dateSortKey(b.date).localeCompare(dateSortKey(a.date)) || a.title.localeCompare(b.title));
  // Undated last, whatever the direction.
  return [...out.filter((g) => g.date), ...out.filter((g) => !g.date)];
}

export const materializeInput = z.object({ factId: z.string().min(1) });

/** Turn an inferred gap into an inventory row (status expected) that remembers its source fact. */
export function materializeGap(raw: unknown): RecordWithNames {
  const { factId } = parseOrThrow(materializeInput, raw);
  const existing = baseSelect().where(and(eq(schema.recordsInventory.sourceFactId, factId), isNull(schema.recordsInventory.deletedAt))).get();
  if (existing) return existing;
  const fact = db()
    .select({ id: schema.facts.id, type: schema.facts.type, statement: schema.facts.statement, date: schema.facts.date, datePrecision: schema.facts.datePrecision, dateText: schema.facts.dateText, attributesJson: schema.facts.attributesJson })
    .from(schema.facts)
    .where(and(eq(schema.facts.id, factId), isNull(schema.facts.deletedAt)))
    .get();
  if (!fact) throw notFound('fact not found');
  if (fact.type !== 'record_reference') throw badRequest('only record_reference facts can be materialised into the inventory');
  const ref = refFromFact(fact);
  const now = nowIso();
  const row: RecordInsert = {
    id: newId(),
    title: ref.description,
    recordType: (RECORD_TYPES as readonly string[]).includes(ref.recordType) ? ref.recordType : 'other',
    institutionId: ref.institutionId ?? null,
    system: null,
    format: 'unknown',
    held: false,
    heldForm: null,
    documentId: null,
    status: 'expected',
    recordDate: ref.date,
    recordDatePrecision: ref.datePrecision,
    recordDateText: ref.dateText,
    sourceFactId: fact.id,
    notes: ref.institution && !ref.institutionId ? `Institution as written: ${ref.institution}` : null,
    createdAt: now,
    updatedAt: now,
  };
  return writeIndexed(row.id, () => db().insert(schema.recordsInventory).values(row).run());
}

// ---------------------------------------------------------------------------
// Records held inside an export, one per encounter (2026-10-07, large exports; WP-C)
// ---------------------------------------------------------------------------
//
// An Epic chart print holds many records: an ED visit printed across eighty of its pages is as much "held" as a separately filed
// ED note. One held row per clinical encounter of an export (title from the printed banner, record date the
// encounter's date, document the export, linked from its segments by `document_segments.record_id`) lets a gap such as
// "Records for the ED visit" close from the encounter's pages. Only encounters that hold clinical
// documentation (notes, results, imaging, procedures, administrations, flowsheets) get a row: a message-only or
// letter encounter is not a record anyone requests. A row the user deleted is never made again.

/** Segment kinds that make an encounter a clinical record worth listing as held. */
const HELD_KINDS = new Set(['note', 'lab_results', 'imaging', 'procedures', 'mar', 'flowsheets']);

/** What a segment row must expose for the grouping (a document_segments row). */
export interface SegmentLike {
  id: string;
  documentId: string;
  pageStart: number;
  pageEnd: number;
  kind: string;
  status: string;
  headerText: string | null;
  encounterDate: string | null;
  encounterDatePrecision: string;
  encounterDateText: string | null;
  encounterType: string | null;
  department: string | null;
  recordId: string | null;
  detailJson: string;
  supersededAt?: string | null;
}

/** One encounter of an export, with the segments it is printed in. */
export interface EncounterGroup {
  key: string;
  documentId: string;
  headerText: string | null;
  type: string | null;
  department: string | null;
  date: string | null;
  precision: string;
  dateText: string | null;
  pages: [number, number];
  kinds: string[];
  segmentIds: string[];
  /** The held row its segments already point at (live or deleted by the user). */
  recordId: string | null;
}

/** An export's encounters (an encounter printed in two places is one), in page order. Pure. */
export function encounterGroupsOf(segments: readonly SegmentLike[]): EncounterGroup[] {
  const groups = new Map<string, EncounterGroup>();
  for (const s of segments) {
    if (s.supersededAt) continue;
    const det = parseJson<Record<string, unknown>>(s.detailJson, {});
    const own = typeof det.encounterKey === 'string' ? det.encounterKey : null;
    const same = typeof det.encounterSameAs === 'string' ? det.encounterSameAs : null;
    const key = same ?? own;
    if (!key || !s.encounterDate) continue; // the patient block and page blocks have no encounter
    let g = groups.get(key);
    if (!g) {
      g = { key, documentId: s.documentId, headerText: s.headerText, type: s.encounterType, department: s.department, date: s.encounterDate, precision: s.encounterDatePrecision, dateText: s.encounterDateText, pages: [s.pageStart, s.pageEnd], kinds: [], segmentIds: [], recordId: null };
      groups.set(key, g);
    }
    g.pages = [Math.min(g.pages[0], s.pageStart), Math.max(g.pages[1], s.pageEnd)];
    if (s.status !== 'skipped' && !g.kinds.includes(s.kind)) g.kinds.push(s.kind);
    g.segmentIds.push(s.id);
    if (s.recordId && !g.recordId) g.recordId = s.recordId;
  }
  return [...groups.values()].sort((a, b) => a.pages[0] - b.pages[0]);
}

/** True when an encounter holds clinical documentation (not only messages, letters, orders or a facesheet). */
export function isHeldEncounter(g: Pick<EncounterGroup, 'kinds'>): boolean {
  return g.kinds.some((k) => HELD_KINDS.has(k));
}

const KIND_WORDS: Record<string, string> = { note: 'notes', lab_results: 'labs', imaging: 'imaging', procedures: 'procedures', mar: 'medications given', flowsheets: 'flowsheets', messages: 'messages', telephone: 'calls', letter: 'letters', orders: 'orders', instructions: 'instructions', education: 'education', media: 'scans', vitals: 'vitals' };

/** "ED" alone is too short a word to match "ED visit": the encounter type as words people use. */
function typeWords(type: string | null): string {
  const t = (type ?? '').trim();
  if (/^(ed|er)$/i.test(t) || /emergency/i.test(t)) return `${t} visit, emergency`;
  return t;
}

/** The record types an encounter holds (a gap of any of these types can close from it). */
export function recordTypesOfEncounter(g: Pick<EncounterGroup, 'kinds' | 'type'>): Set<string> {
  const out = new Set<string>();
  if (g.kinds.includes('note')) out.add('clinical_note');
  if (g.kinds.includes('lab_results')) out.add('lab');
  if (g.kinds.includes('imaging')) out.add('imaging_report');
  if (g.kinds.includes('procedures')) out.add('operative_report');
  if (/hospital|admission|inpatient/i.test(g.type ?? '') && g.kinds.includes('note')) out.add('discharge_summary');
  if (g.kinds.includes('messages')) out.add('portal_thread');
  return out;
}

function primaryRecordType(g: Pick<EncounterGroup, 'kinds' | 'type'>): RecordType {
  if (g.kinds.includes('note')) return 'clinical_note';
  if (g.kinds.includes('lab_results')) return 'lab';
  if (g.kinds.includes('imaging')) return 'imaging_report';
  if (g.kinds.includes('procedures')) return 'operative_report';
  return 'clinical_note';
}

/** The words an encounter is matched by: its type, department, banner, what it holds and what its results are of. */
function encounterWords(g: Pick<EncounterGroup, 'type' | 'department' | 'headerText' | 'kinds'>, content: readonly string[] = []): string {
  return [typeWords(g.type), g.department, g.headerText, ...g.kinds.map((k) => KIND_WORDS[k] ?? ''), ...content].filter(Boolean).join(' ');
}

/**
 * Abbreviations people write for an encounter, spelled out before matching (2026-10-07 review, rev-comms #2): "ED" and
 * "ER" are too short to be words of their own, so "ED visit and LP" never met "Emergency Department ... lumbar
 * puncture". Applied to both sides.
 */
export function expandRecordAbbreviations(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\b(ED|ER)\b/g, '$1 emergency')
    .replace(/\bLP\b/gi, 'LP lumbar puncture')
    .replace(/\bCSF\b/gi, 'CSF cerebrospinal');
}

/** Segment kinds whose text says what an encounter's results are of (a lab panel, a procedure, a study). */
const CONTENT_KINDS = new Set(['lab_results', 'procedures', 'imaging']);

/**
 * Modality words of the results an encounter holds, from its lab, procedure and imaging sections as printed: spinal
 * fluid (CSF) results stand for the lumbar puncture they came from. Words only, never record text.
 */
export function contentKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const k of modalityKeywords(text)) if (k !== 'us') out.add(k);
  if (/\b(csf|cerebrospinal|spinal fluid)\b/i.test(text)) for (const w of ['csf', 'lp', 'lumbar', 'puncture']) out.add(w);
  if (/\blumbar puncture\b|\bLP\b|\bspinal tap\b/i.test(text)) for (const w of ['lp', 'lumbar', 'puncture']) out.add(w);
  return [...out];
}

/** contentKeywords per segment, by its id and text hash (the text of a part never changes under the same hash). */
const contentCache = new Map<string, string[]>();

// Keywords read from page text: dropped when the case locks (sweep 2026-10-07, PAT-2).
onLockChange((unlocked) => {
  if (!unlocked) contentCache.clear();
});

/** For tests: how many parts the keyword cache holds. */
export function contentCacheSize(): number {
  return contentCache.size;
}

function encounterContentWords(rows: ReadonlyArray<{ id: string; documentId: string; kind: string; status: string; pageStart: number; pageEnd: number; textHash?: string | null }>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (!CONTENT_KINDS.has(r.kind) || r.status === 'skipped') continue;
    const key = `${r.id}|${r.textHash ?? ''}`;
    let words = contentCache.get(key);
    if (!words) {
      const text = db()
        .select({ text: schema.documentPages.text })
        .from(schema.documentPages)
        .where(and(eq(schema.documentPages.documentId, r.documentId), sql`${schema.documentPages.pageNumber} between ${r.pageStart} and ${r.pageEnd}`))
        .all()
        .map((p) => p.text)
        .join('\n');
      words = contentKeywords(text);
      if (contentCache.size > 5000) contentCache.clear();
      contentCache.set(key, words);
    }
    for (const w of words) out.add(w);
  }
  return [...out];
}

/** The title of an encounter's held row: "ED visit in Example Emergency Department, 1/15/2019 (pp.6-7 of Example chart print)". */
export function encounterRecordTitle(g: EncounterGroup, docTitle: string): string {
  const type = /^(ed|er)$/i.test((g.type ?? '').trim()) ? `${g.type} visit` : (g.type ?? 'Encounter');
  return `${type}${g.department ? ` in ${g.department}` : ''}${g.dateText ? `, ${g.dateText}` : ''} (pp.${g.pages[0]}-${g.pages[1]} of ${docTitle})`.slice(0, 500);
}

/**
 * The held row of one encounter of an export: the one its segments already point at (kept as the user left it; a row
 * the user deleted is not made again), else a new one. Returns the row id (null when the user deleted it) and whether
 * it was made now.
 */
export function ensureEncounterHeldRow(g: EncounterGroup, doc: { id: string; title: string; institutionId: string | null; kind: string }): { recordId: string | null; created: boolean } {
  const sections = [...new Set(g.kinds.map((k) => KIND_WORDS[k]).filter(Boolean))].join(', ');
  if (g.recordId) {
    const r = db().select({ id: schema.recordsInventory.id, deletedAt: schema.recordsInventory.deletedAt, title: schema.recordsInventory.title, notes: schema.recordsInventory.notes, institutionId: schema.recordsInventory.institutionId }).from(schema.recordsInventory).where(eq(schema.recordsInventory.id, g.recordId)).get();
    if (r) {
      if (!r.deletedAt) refreshHeldRowTitle(r, g, doc.title, sections);
      return { recordId: r.deletedAt ? null : r.id, created: false };
    }
  }
  const now = nowIso();
  const row: RecordInsert = {
    id: newId(),
    title: encounterRecordTitle(g, doc.title),
    recordType: primaryRecordType(g),
    institutionId: doc.institutionId ?? null,
    system: null,
    format: formatForKind(doc.kind),
    held: true,
    heldForm: heldFormForKind(doc.kind),
    documentId: doc.id,
    status: 'received',
    recordDate: g.date,
    recordDatePrecision: g.precision || 'unknown',
    recordDateText: g.dateText,
    receivedAt: localDayOf(now),
    sourceFactId: null,
    notes: heldRowNotes(g, doc.title, sections),
    createdAt: now,
    updatedAt: now,
  };
  writeIndexed(row.id, () => db().insert(schema.recordsInventory).values(row).run());
  return { recordId: row.id, created: true };
}

function heldRowNotes(g: EncounterGroup, docTitle: string, sections: string): string {
  return `Held inside "${docTitle}", pp.${g.pages[0]}-${g.pages[1]}${sections ? ` (${sections})` : ''}. Listed automatically from the encounter's printed banner.`.slice(0, 2000);
}

/**
 * A held row keeps naming the export as it is called now (2026-10-07 review, rev-comms #15: rows made at the cut kept
 * the file name after classification renamed the document). Only a title and notes still exactly as made
 * automatically (for whatever name the export had then) are rewritten; a title or note the user changed stays.
 */
function refreshHeldRowTitle(r: { id: string; title: string; notes: string | null; institutionId: string | null }, g: EncounterGroup, docTitle: string, sections: string): void {
  const title = encounterRecordTitle(g, docTitle);
  const notes = heldRowNotes(g, docTitle, sections);
  const marker = '\u0000';
  const [tHead, tTail] = encounterRecordTitle(g, marker).split(marker);
  const [nHead, nTail] = heldRowNotes(g, marker, sections).split(marker);
  const autoTitle = r.title !== title && tTail !== undefined && r.title.startsWith(tHead) && r.title.endsWith(tTail) && r.title.length > tHead.length + tTail.length;
  const autoNotes = r.notes !== notes && nTail !== undefined && (r.notes ?? '').startsWith(nHead) && (r.notes ?? '').endsWith(nTail);
  if (!autoTitle && !autoNotes) return;
  db().update(schema.recordsInventory)
    .set({ ...(autoTitle ? { title } : {}), ...(autoNotes ? { notes } : {}), updatedAt: nowIso() })
    .where(eq(schema.recordsInventory.id, r.id))
    .run();
  try {
    const saved = getRecord(r.id);
    indexRecord(saved, saved.institutionName);
  } catch {
    // the search index catches up at the next change
  }
}

/** A held encounter of an export, as the gap matching sees it. */
export interface EncounterHold {
  recordId: string;
  documentId: string;
  segmentIds: string[];
  pages: [number, number];
  date: string | null;
  recordTypes: Set<string>;
  words: string;
}

/** Every live held encounter row of every live export (read-only). */
export function encounterHolds(onlyDocumentId?: string): EncounterHold[] {
  const S = schema.documentSegments;
  const rows = db()
    .select({
      id: S.id,
      documentId: S.documentId,
      pageStart: S.pageStart,
      pageEnd: S.pageEnd,
      kind: S.kind,
      status: S.status,
      headerText: S.headerText,
      encounterDate: S.encounterDate,
      encounterDatePrecision: S.encounterDatePrecision,
      encounterDateText: S.encounterDateText,
      encounterType: S.encounterType,
      department: S.department,
      recordId: S.recordId,
      detailJson: S.detailJson,
      textHash: S.textHash,
    })
    .from(S)
    .innerJoin(schema.documents, and(eq(schema.documents.id, S.documentId), isNull(schema.documents.deletedAt)))
    .where(and(isNull(S.supersededAt), onlyDocumentId ? eq(S.documentId, onlyDocumentId) : sql`exists (select 1 from document_segments x where x.document_id = ${S.documentId} and x.record_id is not null and x.superseded_at is null)`))
    .all();
  if (!rows.length) return [];
  const liveRecords = new Set(
    db()
      .select({ id: schema.recordsInventory.id })
      .from(schema.recordsInventory)
      .where(and(isNull(schema.recordsInventory.deletedAt), inArray(schema.recordsInventory.id, [...new Set(rows.map((r) => r.recordId).filter((x): x is string => Boolean(x)))].slice(0, 5000).concat(['']))))
      .all()
      .map((r) => r.id),
  );
  const out: EncounterHold[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const g of encounterGroupsOf(rows)) {
    if (!g.recordId || !liveRecords.has(g.recordId)) continue;
    const content = encounterContentWords(g.segmentIds.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => Boolean(r)));
    out.push({ recordId: g.recordId, documentId: g.documentId, segmentIds: g.segmentIds, pages: g.pages, date: g.date, recordTypes: recordTypesOfEncounter(g), words: encounterWords(g, content) });
  }
  return out;
}

/**
 * Does a referenced record (a gap) match an encounter held inside an export? The record type is one the encounter
 * holds (or the gap says "other"); the dates agree within 3 days (a gap with no date needs a stronger match of its
 * words); the institution, when the gap names one, shares words with the encounter's department; and the gap's words
 * overlap the encounter's (type, department, what it holds) by 0.4, or they share a modality keyword.
 */
export function matchesEncounterHold(ref: RecordRef, hold: Pick<EncounterHold, 'date' | 'recordTypes' | 'words'>): boolean {
  if (ref.recordType !== 'other' && !hold.recordTypes.has(ref.recordType)) return false;
  if (ref.date && !datesAgree(ref.date, hold.date, 3)) return false;
  // ED/ER and LP spelled out on both sides; the hold's words include what its results are of (encounterHolds).
  const holdWords = expandRecordAbbreviations(hold.words);
  const description = expandRecordAbbreviations(ref.description);
  const holdTokens = descriptionTokens(holdWords);
  if (ref.institution) {
    const inst = descriptionTokens(ref.institution);
    if (inst.size && tokenOverlap(inst, holdTokens) < 0.5) return false;
  }
  const refTokens = descriptionTokens(description);
  const overlap = tokenOverlap(refTokens, holdTokens);
  if (!ref.date) return overlap >= 0.6;
  if (overlap >= 0.4) return true;
  return sharesKeyword(modalityKeywords(description), modalityKeywords(holdWords));
}

/** Expected or requested rows (not held) that an export's held encounters answer: each with the encounter that holds it. */
export function openRowsHeldIn(documentId: string): Array<{ rowId: string; title: string; hold: EncounterHold }> {
  const holds = encounterHolds(documentId);
  if (!holds.length) return [];
  const out: Array<{ rowId: string; title: string; hold: EncounterHold }> = [];
  for (const r of listRecords()) {
    if (r.held || !['expected', 'requested'].includes(r.status)) continue;
    const ref: RecordRef = { recordType: r.recordType, description: r.title, institution: r.institutionName, institutionId: r.institutionId, date: r.recordDate, datePrecision: r.recordDatePrecision };
    const hold = holds.find((h) => matchesEncounterHold(ref, h));
    if (hold) out.push({ rowId: r.id, title: r.title, hold });
  }
  return out;
}
