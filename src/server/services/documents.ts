/**
 * Documents service: upload, list, detail, pages, file/page images, edit,
 * soft delete, and the job triggers for re-ingestion and extraction.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { getFile, putFile } from '../files/store';
import { cancelJob, enqueueJob, type JobRow } from '../jobs/queue';
import { ftsQuery, indexEntity, indexFact, indexPage, removeDocumentPagesIndex, removeEntityIndex, removeFactIndex } from './search';
import { factSearchText, loadPeopleIndex, releaseOverridesBy } from './facts';
import { defaultSpecimenFor, inOwnRange, labPanelFor, labPartChecks, outOfOwnRange, PANEL_SPECIMEN_ORDER, panelSpecimenFor, partLabReading, rangeSignature, readingView, readLabValues, type PanelSpecimen } from './labs';
import { readingForFact } from './lab-reading';
import type { LabReadingView, ReadingRole } from '../../shared/labvalues';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, normalizeKey, nowIso, parseJson, sha256 } from '../util/ids';
import { dateSortKey, parsePartialDate, type DatePrecision, type PartialDate } from '../../shared/dates';
import { SOURCE_TIERS, type DocumentCategory, type DocumentKind, type ExtractionStatus, type SourceTier, type TextStatus } from '../../shared/enums';
import { chartSpec, type ChartSpec } from '../../shared/chart';
import { effectiveObjectivity } from '../../shared/schemas/facts';
import type { TriageKeyPoint, TriageOutput } from '../../shared/schemas/inbox';
import type {
  BriefDiagnosis,
  BriefEvent,
  BriefFollowUp,
  BriefImaging,
  BriefIntolerance,
  BriefKeyPoint,
  BriefLabGroup,
  BriefLabRow,
  BriefLabTrend,
  BriefMedication,
  BriefProcedure,
  BriefRecommendation,
  BriefRecordReference,
  BriefReferral,
  BriefRowBase,
  BriefStatement,
  BriefSymptom,
  DocumentBrief,
} from '../../shared/schemas/brief';
import { cleanFilename, dateFromFilename, detectKind, documentDateSource, mayReplaceDocumentDate, titleFromFilename, type DateSource } from '../ingest/detect';
import { renderDocumentPagePng } from '../ingest/pdf';
import { onLockChange } from '../auth';
import { runPatientPrecedence } from './precedence';
import { passSetAsideIds, plainTrust, reconcileQuietly, trustFor } from './reconcile';
import type { TrustInfo } from '../../shared/reconcile';
import { NOT_QUARANTINED_SQL, QUARANTINED_SQL, heldState, requarantine } from './patient-check-state';
import { WRONG_PATIENT_REASON } from '../../shared/patient-identity';

export type DocumentRow = typeof schema.documents.$inferSelect;
export type DocumentPageRow = typeof schema.documentPages.$inferSelect;
export type ExtractionRunRow = typeof schema.extractionRuns.$inferSelect;

/**
 * A document that looks like a copy of an older one (services/duplicates.ts): the older document, while it is live,
 * with its current title and how much of the wording the two share (0..1). Null when there is none, when the older
 * document was deleted, or when the user chose Keep both.
 */
export interface LikelyCopy {
  documentId: string;
  title: string;
  similarity: number;
  at: string | null;
}

export interface DocumentListItem extends DocumentRow {
  factsCount: number;
  unverifiedCount: number;
  institutionName: string | null;
  likelyCopyOf: LikelyCopy | null;
}

export interface PageSummary {
  pageNumber: number;
  charCount: number;
  ocr: boolean;
  confidence: number | null;
}

export interface DocumentDetail extends DocumentListItem {
  pages: PageSummary[];
  runs: ExtractionRunRow[];
  jobs: JobRow[];
  /** Where the document date came from (file name, file header, model or user); null when there is no date or it is unknown. */
  dateSource: DateSource | null;
}

/** A page as the viewer reads it: the text without the word boxes (which can be hundreds of KB per OCR page). */
export type ViewerPage = Omit<DocumentPageRow, 'boxesJson'>;

/** The most pages one request returns. */
export const PAGE_WINDOW_MAX = 200;

/** A deleted document as the trash lists it, with the facts a restore brings back. */
export interface DeletedDocumentItem {
  id: string;
  title: string;
  filename: string;
  kind: string;
  category: string;
  pageCount: number;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  deletedAt: string;
  createdAt: string;
  /** Facts deleted together with the document (a restore brings exactly these back). */
  factsCount: number;
  /** A live document holds the same file, so a restore would be refused. */
  duplicateOf: { id: string; title: string } | null;
  /** Set aside with "Set this copy aside" (and not restored since): the title of the document it looked like a copy of (null otherwise). */
  setAsideAsCopyOf: string | null;
  /** Deleted with "Not my record" (wrong patient): Restore brings it back as "May be someone else's record", never trusted. */
  wrongPatient: boolean;
  /** With setAsideAsCopyOf: how many of its details carried the user's answers or notes when it was set aside. */
  setAsideCheckedDetails: number | null;
}

export interface ListFilters {
  q?: string;
  category?: DocumentCategory;
  kind?: DocumentKind;
  textStatus?: TextStatus;
  extractionStatus?: ExtractionStatus;
  institutionId?: string;
  /** primary | patient | compilation | external | unknown */
  tier?: SourceTier;
  sort?: 'date' | '-date' | 'title' | '-title' | 'added' | '-added' | 'pages' | '-pages' | 'tier' | '-tier';
  limit?: number;
  /** Only documents that look like a copy of an older live document (services/duplicates.ts). */
  copies?: boolean;
  /**
   * Documents held back as "May be someone else's record" (services/patient-check.ts): left out by default (the
   * clinician's list, packets and pickers never see them); 'include' adds them (the Documents page), 'only' lists them.
   */
  patient?: 'include' | 'only';
}

export interface UploadFile {
  name: string;
  mime: string | null;
  buffer: Buffer;
}

export interface UploadOptions {
  category?: DocumentCategory;
  title?: string;
  autoExtract?: boolean;
}

export interface DocumentPatch {
  /** Setting a title by hand marks `titleSource = 'user'`; the model never overwrites it afterwards. */
  title?: string;
  category?: DocumentCategory;
  documentDateText?: string | null;
  documentDate?: string | null;
  institutionId?: string | null;
  authorPersonId?: string | null;
  tags?: string[];
  notes?: string | null;
  /** The one-click tier override. */
  sourceTier?: SourceTier;
  authorRole?: string | null;
}

const TIER_RANK_SQL = sql`case ${schema.documents.sourceTier} when 'primary' then 0 when 'patient' then 1 when 'compilation' then 2 when 'external' then 3 else 4 end`;

// Correlated subqueries must name the outer table explicitly: inside the
// subquery a bare "id" would bind to facts.id.
const factsCountSql = sql<number>`(select count(*) from facts f where f.source_document_id = "documents"."id" and f.deleted_at is null)`;
// Details still pending a check (unverified and not answered "unsure").
const unverifiedCountSql = sql<number>`(select count(*) from facts f where f.source_document_id = "documents"."id" and f.deleted_at is null and f.status = 'unverified' and coalesce(f.verdict_basis, '') <> 'unsure')`;
const institutionNameSql = sql<string | null>`(select p.name from people p where p.id = "documents"."institution_id" and p.deleted_at is null)`;
/**
 * The version of the likely-copy rules a flag must have been written under: services/duplicates.ts SIGNATURE_VERSION
 * (kept equal by tests/fix-e4-stamps.test.ts; not imported, since duplicates.ts imports this module). A flag on a
 * document signed under earlier rules is not shown, nor acted on, until the document is compared again (in the
 * background after unlock).
 */
export const LIKELY_COPY_RULES_VERSION = 3;

/**
 * The older document this one looks like a copy of (metadata.possibleCopyOf, written by services/duplicates.ts), as
 * JSON, only while that document is live and the flag was written under the current rules: deleting the original
 * clears the flag, restoring it brings it back. The instr() test keeps the JSON parse off the rows that carry no flag,
 * so the list costs the same as before.
 */
const likelyCopySql = sql<string | null>`(select json_object('documentId', o.id, 'title', o.title, 'similarity', json_extract("documents"."metadata_json", '$.possibleCopyOf.similarity'), 'at', json_extract("documents"."metadata_json", '$.possibleCopyOf.at')) from documents o where o.deleted_at is null and o.id <> "documents"."id" and o.id = (case when instr("documents"."metadata_json", '"possibleCopyOf"') > 0 and json_valid("documents"."metadata_json") then (case when coalesce(json_extract("documents"."metadata_json", '$.textSignature.v'), ${LIKELY_COPY_RULES_VERSION}) = ${LIKELY_COPY_RULES_VERSION} then json_extract("documents"."metadata_json", '$.possibleCopyOf.documentId') end) end))`;

/** The likely-copy column as the API returns it (an object or null). */
export function readLikelyCopy(v: unknown): LikelyCopy | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v) as Partial<LikelyCopy>;
    if (typeof o.documentId !== 'string' || typeof o.title !== 'string') return null;
    const similarity = typeof o.similarity === 'number' && Number.isFinite(o.similarity) ? Math.max(0, Math.min(1, o.similarity)) : 0;
    return { documentId: o.documentId, title: o.title, similarity, at: typeof o.at === 'string' ? o.at : null };
  } catch {
    return null;
  }
}

type ListRowRaw = Omit<DocumentListItem, 'likelyCopyOf'> & { likelyCopyOf: unknown };
function withLikelyCopy<T extends ListRowRaw>(r: T): Omit<T, 'likelyCopyOf'> & { likelyCopyOf: LikelyCopy | null } {
  return { ...r, likelyCopyOf: readLikelyCopy(r.likelyCopyOf) };
}

function orderFor(sort: ListFilters['sort']): SQL[] {
  switch (sort) {
    case 'date':
      return [sql`${schema.documents.documentDate} is null`, asc(schema.documents.documentDate), asc(schema.documents.createdAt)];
    case '-date':
      return [sql`${schema.documents.documentDate} is null`, desc(schema.documents.documentDate), desc(schema.documents.createdAt)];
    case 'title':
      return [asc(sql`lower(${schema.documents.title})`)];
    case '-title':
      return [desc(sql`lower(${schema.documents.title})`)];
    case 'pages':
      return [asc(schema.documents.pageCount)];
    case '-pages':
      return [desc(schema.documents.pageCount)];
    case 'added':
      return [asc(schema.documents.createdAt)];
    case 'tier':
      return [TIER_RANK_SQL, sql`${schema.documents.documentDate} is null`, desc(schema.documents.documentDate)];
    case '-tier':
      return [sql`${TIER_RANK_SQL} desc`, sql`${schema.documents.documentDate} is null`, desc(schema.documents.documentDate)];
    case '-added':
    default:
      return [desc(schema.documents.createdAt)];
  }
}

export function listDocuments(f: ListFilters = {}): DocumentListItem[] {
  const d = db();
  const conds: SQL[] = [f.patient === 'only' ? QUARANTINED_SQL : f.patient === 'include' ? or(isNull(schema.documents.deletedAt), QUARANTINED_SQL)! : isNull(schema.documents.deletedAt)];
  if (f.category) conds.push(eq(schema.documents.category, f.category));
  if (f.kind) conds.push(eq(schema.documents.kind, f.kind));
  if (f.textStatus) conds.push(eq(schema.documents.textStatus, f.textStatus));
  if (f.extractionStatus) conds.push(eq(schema.documents.extractionStatus, f.extractionStatus));
  if (f.institutionId) conds.push(eq(schema.documents.institutionId, f.institutionId));
  if (f.tier) conds.push(eq(schema.documents.sourceTier, f.tier));
  if (f.copies) conds.push(sql`${likelyCopySql} is not null`);
  const q = (f.q ?? '').trim();
  if (q) {
    const pat = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    const parts: SQL[] = [
      sql`${schema.documents.title} like ${pat} escape '\\'`,
      sql`${schema.documents.filename} like ${pat} escape '\\'`,
      sql`coalesce(${schema.documents.notes}, '') like ${pat} escape '\\'`,
      sql`${schema.documents.tagsJson} like ${pat} escape '\\'`,
    ];
    const match = ftsQuery(q);
    if (match) parts.push(sql`${schema.documents.id} in (select document_id from pages_fts where pages_fts match ${match})`);
    conds.push(or(...parts)!);
  }
  const rows = d
    .select({ ...getTableColumns(schema.documents), factsCount: factsCountSql, unverifiedCount: unverifiedCountSql, institutionName: institutionNameSql, likelyCopyOf: likelyCopySql })
    .from(schema.documents)
    .where(and(...conds))
    .orderBy(...orderFor(f.sort))
    .limit(Math.min(Math.max(f.limit ?? 2000, 1), 5000))
    .all();
  return (rows as ListRowRaw[]).map(withLikelyCopy) as DocumentListItem[];
}

/** `held`: a document held back as "May be someone else's record" is found too (its page, file and original only). */
function documentOr404(id: string, opts: { held?: boolean } = {}): DocumentRow {
  const row = db()
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), opts.held ? or(isNull(schema.documents.deletedAt), QUARANTINED_SQL)! : isNull(schema.documents.deletedAt)))
    .get();
  if (!row) throw notFound('document not found');
  return row;
}

/** `held`: also a document held back as "May be someone else's record" (the Documents page; nothing else). */
export function getDocument(id: string, opts: { held?: boolean } = {}): DocumentDetail {
  const d = db();
  const raw = d
    .select({ ...getTableColumns(schema.documents), factsCount: factsCountSql, unverifiedCount: unverifiedCountSql, institutionName: institutionNameSql, likelyCopyOf: likelyCopySql })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), opts.held ? or(isNull(schema.documents.deletedAt), QUARANTINED_SQL)! : isNull(schema.documents.deletedAt)))
    .get();
  if (!raw) throw notFound('document not found');
  const row = withLikelyCopy(raw as ListRowRaw);
  const pages = d
    .select({ pageNumber: schema.documentPages.pageNumber, charCount: schema.documentPages.charCount, ocr: schema.documentPages.ocr, confidence: schema.documentPages.confidence })
    .from(schema.documentPages)
    .where(eq(schema.documentPages.documentId, id))
    .orderBy(asc(schema.documentPages.pageNumber))
    .all();
  const runs = d.select().from(schema.extractionRuns).where(eq(schema.extractionRuns.documentId, id)).orderBy(desc(schema.extractionRuns.startedAt)).limit(20).all();
  const jobs = d.select().from(schema.jobs).where(eq(schema.jobs.documentId, id)).orderBy(desc(schema.jobs.createdAt)).limit(25).all();
  return { ...(row as DocumentListItem), pages, runs, jobs, dateSource: documentDateSource(row) };
}

function pageBounds(from: number, to: number | undefined): { start: number; end: number; requestedEnd: number } {
  const start = Math.max(1, Math.floor(from));
  const requestedEnd = Math.max(start, Math.floor(to ?? start + 29));
  return { start, end: Math.min(requestedEnd, start + PAGE_WINDOW_MAX - 1), requestedEnd };
}

/** Full page rows (with word boxes) for pages from..to, at most PAGE_WINDOW_MAX of them. */
export function getPages(id: string, from = 1, to?: number): DocumentPageRow[] {
  documentOr404(id);
  const { start, end } = pageBounds(from, to);
  return db()
    .select()
    .from(schema.documentPages)
    .where(and(eq(schema.documentPages.documentId, id), gte(schema.documentPages.pageNumber, start), lte(schema.documentPages.pageNumber, end)))
    .orderBy(asc(schema.documentPages.pageNumber))
    .all();
}

/**
 * The viewer's window of pages: text without the word boxes, and the window
 * actually served. A request wider than PAGE_WINDOW_MAX is cut short and says
 * so (`truncated`, `to`), never silently.
 */
export function getPageWindow(id: string, from = 1, to?: number): { items: ViewerPage[]; from: number; to: number; truncated: boolean } {
  // A held document's pages can be read by the user, to decide whose it is.
  documentOr404(id, { held: true });
  const { start, end, requestedEnd } = pageBounds(from, to);
  const { boxesJson: _boxes, ...columns } = getTableColumns(schema.documentPages);
  const items = db()
    .select(columns)
    .from(schema.documentPages)
    .where(and(eq(schema.documentPages.documentId, id), gte(schema.documentPages.pageNumber, start), lte(schema.documentPages.pageNumber, end)))
    .orderBy(asc(schema.documentPages.pageNumber))
    .all();
  return { items, from: start, to: end, truncated: end < requestedEnd };
}

export type UploadedDocument = DocumentRow & { duplicate?: boolean; jobId?: string | null };

/** Store files, dedupe by sha256, and queue ingestion. */
export function createDocuments(files: UploadFile[], opts: UploadOptions = {}): UploadedDocument[] {
  if (!files.length) throw badRequest('no files were uploaded');
  const d = db();
  const items: UploadedDocument[] = [];
  for (const f of files) {
    if (!f.buffer.length) throw badRequest(`${f.name || 'file'} is empty`);
    const sha = sha256(f.buffer);
    // A file held back as "May be someone else's record" is not added twice either.
    const existing = d
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.sha256, sha), or(isNull(schema.documents.deletedAt), QUARANTINED_SQL)))
      .get();
    if (existing) {
      items.push({ ...existing, duplicate: true });
      continue;
    }
    const filename = cleanFilename(f.name);
    const { kind, mime } = detectKind(filename, f.mime, f.buffer.subarray(0, 512));
    const storageKey = putFile(f.buffer, filename);
    const fdate = dateFromFilename(filename);
    const now = nowIso();
    const row: typeof schema.documents.$inferInsert = {
      id: newId(),
      title: (files.length === 1 && opts.title?.trim()) || titleFromFilename(filename),
      filename,
      mime,
      kind,
      category: opts.category ?? 'other',
      sizeBytes: f.buffer.length,
      sha256: sha,
      storageKey,
      documentDate: fdate?.iso ?? null,
      documentDatePrecision: fdate?.precision ?? 'unknown',
      documentDateText: fdate?.text ?? null,
      pageCount: 0,
      textStatus: 'pending',
      extractionStatus: 'none',
      // A date read from the file name is a guess (often the download or scan date): recorded as such so a date
      // from the document itself (file header, model) may replace it later.
      metadataJson: JSON.stringify({ upload: { at: now, originalMime: f.mime || null }, ...(fdate ? { dateSource: 'filename' satisfies DateSource } : {}) }),
      tagsJson: '[]',
      createdAt: now,
      updatedAt: now,
    };
    d.insert(schema.documents).values(row).run();
    indexEntity('document', row.id, row.title, filename);
    const job = enqueueJob({ type: 'ingest_document', payload: { documentId: row.id, autoExtract: opts.autoExtract !== false }, documentId: row.id, dedupe: true });
    const inserted = d.select().from(schema.documents).where(eq(schema.documents.id, row.id)).get()!;
    items.push({ ...inserted, duplicate: false, jobId: job.id });
  }
  return items;
}

/** Called after a document's source tier changed by hand (after its measurements reconcile). */
export type SourceTierHook = (documentId: string, tier: string) => void;
const tierChangeHooks: SourceTierHook[] = [];

/**
 * Register what follows a tier change. services/filing.ts registers its medication filing here: it imports this
 * module, so a direct import back would be a cycle.
 */
export function onSourceTierChange(fn: SourceTierHook): void {
  if (!tierChangeHooks.includes(fn)) tierChangeHooks.push(fn);
}

/** Called after a document was soft-deleted or restored (its facts already follow). */
export type DocumentLifecycleHook = (documentId: string, event: 'deleted' | 'restored') => void;
const lifecycleHooks: DocumentLifecycleHook[] = [];

/**
 * Register what follows a delete or a restore. services/duplicates.ts registers here (a copy whose original was
 * deleted looks for another original; a restored copy that was set aside is filed again): it imports this module, so
 * a direct import back would be a cycle. A hook never makes the delete or the restore fail.
 */
export function onDocumentDeletedOrRestored(fn: DocumentLifecycleHook): void {
  if (!lifecycleHooks.includes(fn)) lifecycleHooks.push(fn);
}

function runLifecycleHooks(documentId: string, event: 'deleted' | 'restored'): void {
  for (const fn of lifecycleHooks) {
    try {
      fn(documentId, event);
    } catch (err) {
      console.warn(`[documents] after the ${event === 'deleted' ? 'delete' : 'restore'} of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function updateDocument(id: string, patch: DocumentPatch): DocumentDetail {
  const doc = documentOr404(id);
  const set: Partial<typeof schema.documents.$inferInsert> = { updatedAt: nowIso() };
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const triage = (meta.triage && typeof meta.triage === 'object' ? meta.triage : {}) as { title?: unknown; document_date?: unknown };
  if (patch.title !== undefined) {
    const title = patch.title.trim() || doc.title;
    set.title = title;
    // A title typed by the user outranks the model from now on; re-saving the same text changes nothing.
    // Taking the model's proposed title as it stands ("Use it", filing) keeps the model as its source.
    if (title !== doc.title) set.titleSource = typeof triage.title === 'string' && triage.title.trim() === title ? 'ai' : 'user';
  }
  if (patch.sourceTier !== undefined) {
    if (!(SOURCE_TIERS as readonly string[]).includes(patch.sourceTier)) throw badRequest(`sourceTier must be one of ${SOURCE_TIERS.join(', ')}`);
    set.sourceTier = patch.sourceTier;
  }
  if (patch.authorRole !== undefined) set.authorRole = patch.authorRole?.trim() || null;
  if (patch.category !== undefined) set.category = patch.category;
  if (patch.institutionId !== undefined) set.institutionId = patch.institutionId || null;
  if (patch.authorPersonId !== undefined) set.authorPersonId = patch.authorPersonId || null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  if (patch.tags !== undefined) set.tagsJson = JSON.stringify([...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))]);
  if (patch.documentDate !== undefined || patch.documentDateText !== undefined) {
    const source = patch.documentDate ?? patch.documentDateText ?? null;
    if (!source) {
      set.documentDate = null;
      set.documentDatePrecision = 'unknown';
      set.documentDateText = patch.documentDateText?.trim() || null;
    } else {
      const p = parsePartialDate(source);
      set.documentDate = p.iso;
      set.documentDatePrecision = p.precision;
      set.documentDateText = (patch.documentDateText ?? source).trim() || null;
    }
    // Only a date that actually changes takes a new source (the details form re-sends the date with every save).
    // The model's proposed date taken as it stands (filing) keeps the model as its source; anything else is the user's.
    if (set.documentDate !== doc.documentDate || set.documentDateText !== doc.documentDateText) {
      const proposed = typeof triage.document_date === 'string' ? parsePartialDate(triage.document_date).iso : null;
      meta.dateSource = (proposed && set.documentDate === proposed ? 'ai' : 'user') satisfies DateSource;
      set.metadataJson = JSON.stringify(meta);
    }
  }
  db().update(schema.documents).set(set).where(eq(schema.documents.id, id)).run();
  // A document that becomes (or stops being) a clinical record: its measurements reconcile again, both ways. So does a
  // clinical record whose type changes (a lab report outranks a clinic note's restatement of its value; two records of
  // different types can disagree), so the pass's set-asides follow the new type at once, not at the next unlock.
  // Never throws.
  const tierChanged = set.sourceTier !== undefined && set.sourceTier !== doc.sourceTier;
  const typeChanged = set.category !== undefined && set.category !== doc.category && (set.sourceTier ?? doc.sourceTier) === 'primary';
  if (tierChanged || typeChanged) reconcileQuietly({ documentId: id, trigger: tierChanged ? 'tier' : 'classification' });
  if (set.sourceTier !== undefined && tierChanged) {
    // Then what else follows the tier (services/filing.ts: a document marked official, or the patient's own notes,
    // after it was read has its medications filed now). Never throws.
    for (const fn of tierChangeHooks) {
      try {
        fn(id, set.sourceTier);
      } catch (err) {
        console.warn(`[documents] after the tier change of ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const after = getDocument(id);
  indexEntity('document', id, after.title, [after.filename, after.notes ?? '', ...(JSON.parse(after.tagsJson || '[]') as string[])].join(' '));
  // The brief's header shows the tier, role, title source, date, institution and author: any of them changing rebuilds it.
  if (
    patch.sourceTier !== undefined ||
    patch.authorRole !== undefined ||
    patch.title !== undefined ||
    patch.institutionId !== undefined ||
    patch.authorPersonId !== undefined ||
    patch.documentDate !== undefined ||
    patch.documentDateText !== undefined
  )
    rebuildBriefQuietly(id);
  return after;
}

// ---------------------------------------------------------------------------
// Classification: what the model's proposal is allowed to set on a document
// ---------------------------------------------------------------------------

export interface ClassificationApplied {
  title: boolean;
  tier: boolean;
  authorRole: boolean;
  date: boolean;
  category: boolean;
  /** The proposed title when it was not applied (a user-set title stays; the detail pane offers it). */
  titleProposal: string | null;
  /** The proposed date when it differs from a date that may not be replaced (the user's, the file header's, an earlier model's). */
  dateProposal?: string | null;
}

export type VerifiedKeyPoint = TriageKeyPoint & { verified?: boolean };
export type ClassificationInput = Pick<TriageOutput, 'title' | 'category' | 'document_date' | 'source_tier' | 'author_role'> & { key_points?: VerifiedKeyPoint[] };

/**
 * Apply a classification to the document fields it may set: the title only
 * while it still comes from the file name (a re-title also replaces a model
 * title, never a user's), the tier and author role only while unknown, the
 * date and category only while empty. Everything else in the proposal is a
 * filing decision (src/server/services/inbox.ts). The brief is rebuilt.
 */
export function applyClassification(id: string, proposal: ClassificationInput, opts: { titleOnly?: boolean; tierOnly?: boolean } = {}): ClassificationApplied {
  const doc = documentOr404(id);
  const now = nowIso();
  const set: Partial<typeof schema.documents.$inferInsert> = {};
  const applied: ClassificationApplied = { title: false, tier: false, authorRole: false, date: false, category: false, titleProposal: null };
  const title = (proposal.title ?? '').trim();
  if (title && title !== doc.title) {
    // An inbox item (tierOnly) keeps its fields until it is filed; the proposal pre-fills the filing form instead.
    const may = !opts.tierOnly && (doc.titleSource === 'filename' || (opts.titleOnly && doc.titleSource !== 'user'));
    if (may) {
      set.title = title;
      set.titleSource = 'ai';
      applied.title = true;
    } else applied.titleProposal = title;
  }
  if (doc.sourceTier === 'unknown' && proposal.source_tier && proposal.source_tier !== 'unknown' && (SOURCE_TIERS as readonly string[]).includes(proposal.source_tier)) {
    set.sourceTier = proposal.source_tier;
    applied.tier = true;
  }
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const prevClassification = (meta.classification ?? {}) as { previousTitle?: string | null; authorRole?: string | null; applied?: { authorRole?: boolean } };
  // The role an earlier classification set, while the document still carries it (older rows only record that one was applied).
  const modelRole = prevClassification.authorRole !== undefined ? prevClassification.authorRole : prevClassification.applied?.authorRole ? doc.authorRole : null;
  // 'other' is the classification's fallback, not a finding: it is never applied, and an 'other' a classification
  // applied gives way to a specific role. A role the user chose stays.
  const role = proposal.author_role && proposal.author_role !== 'other' ? proposal.author_role : null;
  if (role && role !== doc.authorRole && (!doc.authorRole || (doc.authorRole === 'other' && modelRole === 'other'))) {
    set.authorRole = role;
    applied.authorRole = true;
  }
  // The date: a missing one or a guess from the file name gives way to the model's reading of the document; a
  // date from the file header, the user or an earlier model run stays, and a different proposal is only kept.
  let dateSource: DateSource | null = null;
  if (!opts.tierOnly && proposal.document_date) {
    const pd = parsePartialDate(proposal.document_date);
    if (mayReplaceDocumentDate(doc)) {
      if (pd.iso) {
        set.documentDate = pd.iso;
        set.documentDatePrecision = pd.precision;
        set.documentDateText = pd.text;
        applied.date = true;
        dateSource = 'ai';
      } else if (!doc.documentDateText) {
        set.documentDateText = proposal.document_date;
      }
    } else if (pd.iso && pd.iso !== doc.documentDate) {
      applied.dateProposal = proposal.document_date;
    }
  }
  if (!opts.tierOnly && doc.category === 'other' && proposal.category && proposal.category !== 'other') {
    set.category = proposal.category;
    applied.category = true;
  }
  meta.classification = {
    at: now,
    applied: { ...applied },
    previousTitle: applied.title ? doc.title : prevClassification.previousTitle ?? null,
    authorRole: applied.authorRole ? role : modelRole && modelRole === doc.authorRole ? modelRole : null,
  };
  if (dateSource) meta.dateSource = dateSource;
  set.metadataJson = JSON.stringify(meta);
  set.updatedAt = now;
  db().update(schema.documents).set(set).where(eq(schema.documents.id, id)).run();
  if (applied.title) {
    const after = documentOr404(id);
    indexEntity('document', id, after.title, [after.filename, after.notes ?? '', ...parseJson<string[]>(after.tagsJson, [])].join(' '));
  }
  // A tier decides whether the document's measurements are the clinical record or copies of it, and a clinical
  // record's type decides which record outranks which. Never throws.
  if (applied.tier || (applied.category && (set.sourceTier ?? doc.sourceTier) === 'primary')) reconcileQuietly({ documentId: id, trigger: 'classification' });
  // What follows a tier also follows a tier set by classification (integration, 2026-10-07): the messages read out of
  // a chart print while it was still unsorted take their trust from its new tier (services/filing.ts registers the
  // hooks; each never throws and does nothing twice).
  if (set.sourceTier !== undefined && set.sourceTier !== doc.sourceTier) {
    for (const fn of tierChangeHooks) {
      try {
        fn(id, set.sourceTier);
      } catch (err) {
        console.warn(`[documents] after the classified tier of ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  rebuildBriefQuietly(id);
  return applied;
}

/**
 * Queue a classification pass that re-proposes the title (an explicit user
 * request, so a model title is replaced; a user title is only offered). A
 * classification already queued for the document is widened to a re-title
 * (the way the inbox widens an ingest job); one already running cannot be,
 * so the re-title is queued after it instead of being swallowed.
 */
export function requestRetitle(id: string): JobRow {
  const doc = documentOr404(id);
  if (doc.pageCount < 1 || !['extracted', 'ocr_done'].includes(doc.textStatus)) throw conflict('the document has no page text yet; wait for ingestion or re-ingest it');
  const d = db();
  const open = d
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'triage_document'), eq(schema.jobs.documentId, id), inArray(schema.jobs.status, ['queued', 'running'])))
    .all();
  const payloadOf = (j: JobRow) => parseJson<Record<string, unknown>>(j.payloadJson, {});
  const already = open.find((j) => payloadOf(j).titleOnly === true);
  if (already) return already;
  const queued = open.find((j) => j.status === 'queued');
  if (queued) {
    const widened = d
      .update(schema.jobs)
      .set({ payloadJson: JSON.stringify({ ...payloadOf(queued), titleOnly: true }) })
      .where(and(eq(schema.jobs.id, queued.id), eq(schema.jobs.status, 'queued')))
      .run();
    if (widened.changes > 0) return d.select().from(schema.jobs).where(eq(schema.jobs.id, queued.id)).get()!;
  }
  return enqueueJob({ type: 'triage_document', payload: { documentId: id, titleOnly: true }, documentId: id });
}

export interface ClassifyPendingResult {
  /** Documents a classification was queued for. */
  queued: number;
  /** Unclassified documents left as they are because a classification is already queued or running for them. */
  skipped: number;
}

/** The AI-lane priority of the bulk pass: below new uploads and the user's own actions (priority 0). */
export const CLASSIFY_PENDING_PRIORITY = -1;

/**
 * Queue a classification for every document that never had one: documents
 * uploaded before classification ran for every upload, while AI was off, or
 * whose classification could not run. Selected are live documents with page
 * text whose tier is still unknown or whose title still comes from the file
 * name, and with no classification recorded in their metadata (one that ran
 * and left the tier unknown, or an inbox item that keeps its file name until
 * it is filed, is not asked again on every click; Re-title covers a single
 * document). A document with a classification already queued or running is
 * skipped. The jobs carry no autoExtract, so nothing is re-extracted, and run
 * below new uploads in the AI lane. Classification only fills what is still
 * empty (see applyClassification): a user's title, tier or date is never
 * replaced.
 */
export function classifyPendingDocuments(): ClassifyPendingResult {
  const d = db();
  const meta = schema.documents.metadataJson;
  const candidates = d
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(
      and(
        isNull(schema.documents.deletedAt),
        inArray(schema.documents.textStatus, ['extracted', 'ocr_done']),
        gte(schema.documents.pageCount, 1),
        or(eq(schema.documents.sourceTier, 'unknown'), eq(schema.documents.titleSource, 'filename')),
        sql`(case when json_valid(${meta}) then json_type(${meta}, '$.classification') end) is null`,
        // The patient's own notes imported on My notes (2026-10-09) are filed by him at import, never sorted by Claude.
        sql`(case when json_valid(${meta}) then json_extract(${meta}, '$.note.batch') end) is null`,
      ),
    )
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id))
    .all();
  if (!candidates.length) return { queued: 0, skipped: 0 };
  // The same test requestRetitle makes: a classification queued or running for the document.
  const busy = new Set(
    d
      .select({ documentId: schema.jobs.documentId })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, 'triage_document'), inArray(schema.jobs.status, ['queued', 'running']), isNotNull(schema.jobs.documentId)))
      .all()
      .map((j) => j.documentId as string),
  );
  let queued = 0;
  let skipped = 0;
  d.transaction(() => {
    for (const { id } of candidates) {
      if (busy.has(id)) {
        skipped++;
        continue;
      }
      enqueueJob({ type: 'triage_document', payload: { documentId: id }, documentId: id, priority: CLASSIFY_PENDING_PRIORITY });
      queued++;
    }
  });
  return { queued, skipped };
}

// ---------------------------------------------------------------------------
// The document brief: a summary sheet built from the classification and the
// document's facts (no model call), cached in brief_json
// ---------------------------------------------------------------------------

type FactRow = typeof schema.facts.$inferSelect;

interface BriefFact {
  row: FactRow;
  attributes: Record<string, unknown>;
  cite: { id: string; pageNumber: number; verified: boolean; quote: string } | null;
  trust: TrustInfo;
}

/**
 * Live facts of the document with their best citation and trust. Superseded ones are retired duplicates and stay
 * out, except those the reconciliation set aside (a copy of a clinical record, or one that contradicts it): that
 * bit of information stays in its document, shown with its trust.
 */
function loadBriefFacts(documentId: string): BriefFact[] {
  const d = db();
  const all = d
    .select()
    .from(schema.facts)
    .where(and(eq(schema.facts.sourceDocumentId, documentId), isNull(schema.facts.deletedAt)))
    .all();
  const setAside = passSetAsideIds(all.filter((r) => r.status === 'superseded').map((r) => r.id));
  const rows = all.filter((r) => r.status !== 'superseded' || setAside.has(r.id));
  const trust = trustFor(rows.map((r) => r.id));
  const cites = d
    .select({ id: schema.citations.id, factId: schema.citations.factId, pageNumber: schema.citations.pageNumber, verified: schema.citations.verified, quote: schema.citations.quote })
    .from(schema.citations)
    .where(eq(schema.citations.documentId, documentId))
    .orderBy(desc(schema.citations.verified), asc(schema.citations.pageNumber), asc(schema.citations.createdAt))
    .all();
  const best = new Map<string, { id: string; pageNumber: number; verified: boolean; quote: string }>();
  for (const c of cites) {
    if (!c.factId || best.has(c.factId)) continue;
    best.set(c.factId, { id: c.id, pageNumber: c.pageNumber, verified: Boolean(c.verified), quote: c.quote });
  }
  const out = rows.map((row) => ({ row, attributes: parseJson<Record<string, unknown>>(row.attributesJson, {}), cite: best.get(row.id) ?? null, trust: trust.get(row.id) ?? plainTrust({ id: row.id, status: row.status, verdictBasis: row.verdictBasis, verdictNote: row.verdictNote, documentTier: null }) }));
  out.sort((a, b) => dateSortKey(a.row.date).localeCompare(dateSortKey(b.row.date)) || (a.cite?.pageNumber ?? 1e9) - (b.cite?.pageNumber ?? 1e9) || a.row.createdAt.localeCompare(b.row.createdAt));
  return out;
}

function str(a: Record<string, unknown>, key: string): string | null {
  const v = a[key];
  if (v == null) return null;
  const s = typeof v === 'string' ? v.trim() : String(v);
  return s ? s : null;
}

function base(f: BriefFact): BriefRowBase {
  return {
    factId: f.row.id,
    citationId: f.cite?.id ?? null,
    page: f.cite?.pageNumber ?? null,
    status: f.row.status,
    verdictBasis: f.row.verdictBasis ?? null,
    objectivity: effectiveObjectivity({ type: f.row.type, objectivity: f.row.objectivity, attributes: f.attributes }),
    assertedBy: f.row.assertedBy,
    overriddenByFactId: f.row.overriddenByFactId,
    date: f.row.date,
    datePrecision: f.row.datePrecision,
    statement: f.row.statement,
    trust: f.trust,
  };
}

/** A brief lab row with what the brief needs to place it (stripped before it is sent). */
type PlacedLabRow = BriefLabRow & { specimen: PanelSpecimen; panel: string; order: number; position: number; valueNum: number | null; refLowNum: number | null; refHighNum: number | null; setAside: boolean; rangeSig: string | null; unitKey: string | null; role: ReadingRole };

/** What a lab row's reading needs to know about the brief's document: its tier (a lab report or a summary) and its own date. */
interface BriefDocContext {
  tier: string | null;
  date: PartialDate | null;
}

/** The brief's flag for a row: printed (H, L, N, A, C), else worked out from the value's own range ("H~"); a summary's own flag as printed, never worked out. */
function briefFlag(v: LabReadingView): string | null {
  if (v.role === 'claimed') return v.flagState === 'flag' ? v.flagPrinted : null;
  if (v.flagState === 'flag' && v.flagPrinted) return v.flagPrinted;
  return v.computed ? `${v.computed}~` : null;
}

/**
 * The lab rows of one detail, as the Labs page reads them (labs.ts readLabValues; the reading through
 * services/lab-reading.ts): the line itself, or one row per test when it holds several ("OP 17; protein 52" is Opening
 * pressure 19 and CSF protein 52, each read on its own text), each grouped by its name as written and its own sample,
 * with the line as written. Each row says its value as printed, a limit never as a measurement, its range and flag as
 * printed, the flag worked out from its own range, and whether it is out of that range (never judged against another
 * row's range; a summary's own judgement is its claim and never marks a row). A part carries the part check's trust
 * when one is given (`checks`, labs.ts labPartChecks: a copy of a clinical record's value, or one it contradicts).
 */
function labRows(f: BriefFact, checks?: Map<string, { trust: TrustInfo | null; setAside: boolean }>, ctx?: BriefDocContext): PlacedLabRow[] {
  const a = f.attributes;
  const analyte = str(a, 'analyte') ?? f.row.subjectKey?.split('|')[1] ?? f.row.statement.slice(0, 40);
  const specimenRaw = str(a, 'specimen');
  const cite = f.cite && f.row.sourceDocumentId ? { id: f.cite.id, documentId: f.row.sourceDocumentId, pageNumber: f.cite.pageNumber, verified: f.cite.verified, quote: f.cite.quote } : null;
  const whole = readingForFact(f.row, { cite, documentTier: ctx?.tier ?? null, documentDate: ctx?.date ?? null, hasDocument: Boolean(f.row.sourceDocumentId) });
  const wholeView = readingView(whole);
  const lineDate: PartialDate | null = f.row.date || f.row.dateText ? { iso: f.row.date, precision: (f.row.datePrecision || 'unknown') as DatePrecision, text: f.row.dateText } : null;
  const read = readLabValues({
    analyte,
    specimen: specimenRaw ?? defaultSpecimenFor(analyte),
    specimenAssumed: !specimenRaw,
    valueText: str(a, 'value'),
    // The line's number from its reading (the Labs page passes the same, labs.ts expandLabEntry): never value_num read here.
    valueNum: whole.measurement,
    unit: str(a, 'unit'),
    flag: str(a, 'flag'),
    refLow: typeof a.ref_low === 'number' ? a.ref_low : null,
    refHigh: typeof a.ref_high === 'number' ? a.ref_high : null,
    refText: str(a, 'ref_text'),
  });
  return read.map((v) => {
    const view = v.splitFrom ? readingView(partLabReading(v, { reading: wholeView, date: lineDate, quote: cite?.verified ? { text: cite.quote, verified: true, citationId: cite.id } : null })) : wholeView;
    const analyteKey = v.analyteKey || normalizeKey(v.analyte);
    const place = labPanelFor(analyteKey, v.specimen);
    const partId = v.splitFrom ? `${f.row.id}#${v.splitFrom.index}` : null;
    const check = partId ? (checks?.get(partId) ?? checks?.get(`${f.row.id}|${analyteKey}|${panelSpecimenFor(v.specimen)}`)) : undefined;
    const claimed = view.role === 'claimed';
    return {
      ...base(f),
      ...(check?.trust ? { trust: check.trust } : {}),
      analyte: v.analyte,
      analyteKey,
      value: view.valueShown,
      unit: view.unit,
      ref: view.rangeShown,
      flag: briefFlag(view),
      // Out of its own range only (rule 8); a summary's own judgement never marks a row (rule 12).
      outOfRange: claimed ? null : outOfOwnRange(view) ? true : inOwnRange(view) ? false : null,
      valueKind: view.kind,
      flagRaw: view.flagRaw,
      flagState: view.flagState,
      flagComputed: view.computed,
      rangeStatus: view.rangeStatus,
      rangeRole: view.role,
      warnings: view.warnings,
      lab: view.lab,
      ...(partId ? { partId, splitFrom: v.splitFrom!.text } : {}),
      specimen: place.specimen,
      panel: place.panel,
      order: place.order,
      position: place.position,
      valueNum: view.measurement,
      refLowNum: view.rangeStatus === 'parsed' ? view.rangeLow : null,
      refHighNum: view.rangeStatus === 'parsed' ? view.rangeHigh : null,
      setAside: Boolean(check?.setAside),
      rangeSig: claimed ? null : rangeSignature(view),
      unitKey: view.unitKey,
      role: view.role,
    };
  });
}

/** Labs grouped by specimen, then panel, then date, rows in report order. */
export function groupBriefLabs(rows: PlacedLabRow[]): BriefLabGroup[] {
  const groups = new Map<string, BriefLabGroup & { order: number }>();
  for (const r of rows) {
    const key = `${r.specimen}|${r.panel}|${r.date ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { specimen: r.specimen, panel: r.panel, date: r.date, datePrecision: r.datePrecision, rows: [], order: r.order };
      groups.set(key, g);
    }
    const { specimen: _s, panel: _p, order: _o, position: _q, valueNum: _v, refLowNum: _l, refHighNum: _h, setAside: _a, rangeSig: _r, unitKey: _u, role: _z, ...rest } = r;
    g.rows.push(rest);
  }
  const rowKey = (r: { partId?: string | null; factId: string }) => r.partId ?? r.factId;
  const positionOf = new Map<string, number>();
  for (const r of rows) positionOf.set(rowKey(r), r.position < 0 ? Number.MAX_SAFE_INTEGER : r.position);
  const out = [...groups.values()];
  for (const g of out) g.rows.sort((a, b) => (positionOf.get(rowKey(a)) ?? 0) - (positionOf.get(rowKey(b)) ?? 0) || a.analyte.localeCompare(b.analyte));
  out.sort((a, b) => PANEL_SPECIMEN_ORDER.indexOf(a.specimen) - PANEL_SPECIMEN_ORDER.indexOf(b.specimen) || a.order - b.order || dateSortKey(a.date).localeCompare(dateSortKey(b.date)));
  return out.map(({ order: _o, ...g }) => g);
}

function mostCommon<T>(values: T[]): T | null {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    if (v == null || v === '') continue;
    const k = JSON.stringify(v);
    const cur = counts.get(k);
    if (cur) cur.n++;
    else counts.set(k, { v, n: 1 });
  }
  let best: { v: T; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.v ?? null;
}

/**
 * A small line chart per analyte and unit that this document reports on more than one date: its measurements only (a
 * limit such as "<3" and results in words are never drawn). A test whose results here are all words has no chart; its
 * rows list them. Values in different units are never drawn on one axis (rule 5): each unit is a chart of its own. The
 * normal-range band is drawn only when every value that printed a range printed the same one (rule 8); a summary's
 * own range is never a band. A test read out of a line of several charts its own number ("OP 17; protein 52" gives
 * opening pressure 17 and CSF protein 52).
 */
function labTrends(documentId: string, rows: PlacedLabRow[]): BriefLabTrend[] {
  const bySeries = new Map<string, PlacedLabRow[]>();
  const unitsOf = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.valueNum == null || !r.date) continue;
    // A value the user disputed stays in the ledger (with its tag) but never on the chart, as in the lab trends; so
    // does one the reconciliation set aside (a copy of the lab report, or one that contradicts it), and a test of a
    // line the Labs page sets aside on its own for the same reasons.
    if (r.status === 'disputed' || r.status === 'superseded' || r.setAside) continue;
    const test = `${r.specimen}|${r.analyteKey}`;
    const k = `${test}|${r.unitKey ?? ''}`;
    if (!bySeries.has(k)) bySeries.set(k, []);
    bySeries.get(k)!.push(r);
    if (!unitsOf.has(test)) unitsOf.set(test, new Set());
    unitsOf.get(test)!.add(r.unitKey ?? '');
  }
  const out: BriefLabTrend[] = [];
  for (const list of bySeries.values()) {
    const dates = new Set(list.map((r) => r.date));
    if (dates.size < 2) continue;
    list.sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)));
    const unit = mostCommon(list.map((r) => r.unit));
    const several = (unitsOf.get(`${list[0].specimen}|${list[0].analyteKey}`)?.size ?? 1) > 1;
    const name = several ? `${list[0].analyte} (${unit ?? 'no unit printed'})` : list[0].analyte;
    const sigs = new Set(list.map((r) => r.rangeSig).filter((s): s is string => Boolean(s)));
    const banded = sigs.size === 1 ? list.filter((r) => r.rangeSig === [...sigs][0]) : [];
    const one = banded.length ? banded[banded.length - 1] : null;
    const spec: ChartSpec = {
      type: 'line',
      xType: 'date',
      title: name,
      series: [
        {
          name,
          unit: unit ?? null,
          points: list.map((r) => ({ x: r.date as string, y: r.valueNum as number, flag: r.role === 'claimed' ? null : r.flag && r.flag !== 'N' && r.flag !== 'N~' ? r.flag : null, href: r.page ? `/documents/${documentId}?page=${r.page}${r.citationId ? `&cite=${r.citationId}` : ''}` : null })),
        },
      ],
      referenceBand: one && one.ref && (one.refLowNum != null || one.refHighNum != null) ? { low: one.refLowNum, high: one.refHighNum, label: `ref ${one.ref}` } : null,
      source: 'db',
    };
    const parsed = chartSpec.safeParse(spec);
    if (parsed.success) out.push({ analyteKey: list[0].analyteKey, analyte: name, specimen: list[0].specimen, chart: parsed.data });
  }
  return out;
}

type TriageMetaLite = Partial<Omit<TriageOutput, 'key_points'>> & { model?: string; at?: string; pagesUsed?: number; key_points?: VerifiedKeyPoint[] };

function readTriageMeta(doc: DocumentRow): TriageMetaLite | null {
  const v = parseJson<Record<string, unknown>>(doc.metadataJson, {}).triage;
  return v && typeof v === 'object' ? (v as TriageMetaLite) : null;
}

/** The brief header's institution and author: the linked People entries, else the names the classification proposed. */
function briefPeopleNames(doc: DocumentRow, triage: TriageMetaLite | null): { institution: string | null; author: string | null } {
  const nameOf = (personId: string) => db().select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, personId)).get()?.name ?? null;
  return {
    institution: doc.institutionId ? nameOf(doc.institutionId) : (triage?.institution?.new_name ?? null),
    author: doc.authorPersonId ? nameOf(doc.authorPersonId) : (triage?.author?.new_name ?? null),
  };
}

/** The summary paragraph and which model call wrote it: the classification's, else the fact extraction's document summary. */
function briefSummary(doc: DocumentRow, triage: TriageMetaLite | null): { summary: string | null; source: 'classification' | 'extraction' | null; model: string | null } {
  const classified = triage?.summary?.trim();
  if (classified) return { summary: classified, source: 'classification', model: triage?.model ?? null };
  const extraction = parseJson<Record<string, { summary?: unknown; model?: unknown }>>(doc.metadataJson, {}).extraction;
  const extracted = typeof extraction?.summary === 'string' ? extraction.summary.trim() : '';
  if (extracted) return { summary: extracted, source: 'extraction', model: typeof extraction?.model === 'string' ? extraction.model : null };
  return { summary: null, source: null, model: null };
}

/** The classification call's time as the brief records it (null when no call has run). */
function briefClassificationAt(triage: TriageMetaLite | null): string | null {
  return triage?.model && triage.at ? triage.at : null;
}

/**
 * How the brief reads its lab rows: 2 reads a line that holds several tests as its tests, grouped by their names as
 * written, and charts numbers only; 3 (2026-10) reads every value as printed (src/shared/labvalues.ts): a limit never a
 * number, the range and flag as printed, judged only against its own range, a summary's flag as its claim, one chart
 * per unit. A brief cached by an older reading is rebuilt on read (derived data only).
 */
export const BRIEF_LABS_VERSION = 3;

/** `${live facts}:${latest change}:${overridden}` — a cheap way to know whether the cached ledgers are stale. */
export function briefFactsSignature(documentId: string): string {
  const r = db().get<{ n: number; latest: string | null; overridden: number }>(
    sql`select count(*) as n, max(updated_at) as latest, sum(case when overridden_by_fact_id is not null then 1 else 0 end) as overridden from facts where source_document_id = ${documentId} and deleted_at is null`,
  );
  return `${r?.n ?? 0}:${r?.latest ?? ''}:${r?.overridden ?? 0}`;
}

export function buildDocumentBrief(documentId: string): DocumentBrief {
  const doc = documentOr404(documentId);
  const triage = readTriageMeta(doc);
  const facts = loadBriefFacts(documentId);
  const people = new Map<string, string | null>();
  const idx = loadPeopleIndex();
  const addPerson = (name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const n = name.trim();
    const k = n.toLowerCase();
    if ([...people.keys()].some((x) => x.toLowerCase() === k)) return;
    people.set(n, idx.get(normalizeKey(n)) ?? null);
  };
  for (const n of triage?.people_mentioned ?? []) addPerson(n);
  for (const f of facts) {
    for (const n of Array.isArray(f.attributes._people) ? (f.attributes._people as unknown[]) : []) addPerson(n);
    // Named speakers and actors carried in the typed attributes.
    for (const key of ['stated_by', 'recommended_by', 'prescriber', 'performed_by', 'from', 'who']) addPerson(f.attributes[key]);
  }

  const labFacts: BriefFact[] = [];
  const medications: BriefMedication[] = [];
  const diagnoses: BriefDiagnosis[] = [];
  const imaging: BriefImaging[] = [];
  const procedures: BriefProcedure[] = [];
  const symptoms: BriefSymptom[] = [];
  const recommendations: BriefRecommendation[] = [];
  const followUps: BriefFollowUp[] = [];
  const referrals: BriefReferral[] = [];
  const recordReferences: BriefRecordReference[] = [];
  const statements: BriefStatement[] = [];
  const events: BriefEvent[] = [];
  const intolerances: BriefIntolerance[] = [];
  for (const f of facts) {
    const a = f.attributes;
    switch (f.row.type) {
      case 'lab_result':
        labFacts.push(f);
        break;
      case 'medication':
        medications.push({ ...base(f), name: str(a, 'name') ?? f.row.statement.slice(0, 60), dose: [str(a, 'dose'), str(a, 'unit'), str(a, 'route'), str(a, 'frequency')].filter(Boolean).join(' ') || null, medStatus: str(a, 'status'), effect: str(a, 'effect') });
        break;
      case 'diagnosis':
        diagnoses.push({ ...base(f), name: str(a, 'name') ?? f.row.statement.slice(0, 60), certainty: str(a, 'certainty'), statedBy: str(a, 'stated_by') });
        break;
      case 'imaging_result':
        imaging.push({ ...base(f), modality: str(a, 'modality') ?? 'imaging', bodyPart: str(a, 'body_part'), impression: str(a, 'impression') ?? str(a, 'finding') });
        break;
      case 'procedure':
        procedures.push({ ...base(f), name: str(a, 'name') ?? f.row.statement.slice(0, 60), performedBy: str(a, 'performed_by'), result: str(a, 'result_summary') });
        break;
      case 'symptom':
        symptoms.push({ ...base(f), name: str(a, 'name') ?? f.row.statement.slice(0, 60), severity: str(a, 'severity'), course: str(a, 'course') });
        break;
      case 'recommendation':
        recommendations.push({ ...base(f), action: str(a, 'action') ?? f.row.statement, recommendedBy: str(a, 'recommended_by'), target: str(a, 'target'), actedOn: str(a, 'acted_on') });
        break;
      case 'follow_up':
        followUps.push({ ...base(f), what: str(a, 'what') ?? f.row.statement, who: str(a, 'who'), due: str(a, 'due'), followUpStatus: str(a, 'status') });
        break;
      case 'referral':
        referrals.push({ ...base(f), to: str(a, 'to') ?? f.row.statement.slice(0, 60), specialty: str(a, 'specialty'), referralStatus: str(a, 'status') });
        break;
      case 'record_reference':
        recordReferences.push({ ...base(f), description: str(a, 'description') ?? f.row.statement, recordType: str(a, 'record_type') ?? 'other', presentHere: a.present_in_this_document === true });
        break;
      case 'clinician_statement':
        statements.push({ ...base(f), statedBy: str(a, 'stated_by'), about: str(a, 'about'), stance: str(a, 'stance') });
        break;
      case 'allergy_intolerance':
        intolerances.push({ ...base(f), substance: str(a, 'substance') ?? f.row.statement.slice(0, 60), kind: str(a, 'kind'), reaction: str(a, 'reaction') });
        break;
      default:
        events.push({ ...base(f), name: str(a, 'name') ?? f.row.statement.slice(0, 80), detail: str(a, 'detail') ?? str(a, 'value') });
    }
  }

  // Lines that hold several tests are read as their tests; each test carries the part check's trust (labs.ts). Each
  // value is read with this document's tier (a lab report's own, or a summary's claim) and date.
  const docCtx: BriefDocContext = {
    tier: doc.sourceTier ?? null,
    date: doc.documentDate || doc.documentDateText ? { iso: doc.documentDate, precision: (doc.documentDatePrecision || 'unknown') as DatePrecision, text: doc.documentDateText ?? null } : null,
  };
  let labs = labFacts.flatMap((f) => labRows(f, undefined, docCtx));
  let labSetAside: string[] = [];
  if (labs.some((r) => r.partId)) {
    const checks = labPartChecks(labFacts.map((f) => f.row.id));
    labs = labFacts.flatMap((f) => labRows(f, checks, docCtx));
    labSetAside = setAsideKeys(checks);
  }

  const keyPoints: BriefKeyPoint[] = (triage?.key_points ?? []).map((k) => ({ text: k.text, page: k.page ?? null, quote: k.quote || null, verified: k.quote ? (typeof k.verified === 'boolean' ? k.verified : null) : null }));
  const { institution, author } = briefPeopleNames(doc, triage);
  const summary = briefSummary(doc, triage);
  // Counts as before: the details the reconciliation set aside are shown, not counted.
  const all = facts.map((f) => f.row).filter((r) => r.status !== 'superseded');
  return {
    documentId,
    builtAt: nowIso(),
    factsSignature: briefFactsSignature(documentId),
    summary: summary.summary,
    summarySource: summary.source,
    summaryModel: summary.model,
    keyPoints,
    tier: doc.sourceTier,
    authorRole: doc.authorRole,
    titleSource: doc.titleSource,
    date: doc.documentDate,
    datePrecision: doc.documentDatePrecision,
    institution,
    author,
    people: [...people.entries()].map(([name, personId]) => ({ name, personId })),
    labs: groupBriefLabs(labs),
    labTrends: labTrends(documentId, labs),
    labsVersion: BRIEF_LABS_VERSION,
    labSetAside,
    medications,
    diagnoses,
    imaging,
    procedures,
    symptoms,
    recommendations,
    followUps,
    referrals,
    recordReferences,
    statements,
    events,
    intolerances,
    counts: {
      facts: all.length,
      verified: all.filter((f) => f.status === 'confirmed').length,
      unverified: all.filter((f) => f.status === 'unverified' && f.verdictBasis !== 'unsure').length,
      unsure: all.filter((f) => f.status === 'unverified' && f.verdictBasis === 'unsure').length,
      disputed: all.filter((f) => f.status === 'disputed').length,
      overridden: all.filter((f) => f.overriddenByFactId).length,
      patientAsserted: all.filter((f) => f.assertedBy === 'patient').length,
    },
    classification: triage?.model && triage.at ? { model: triage.model, at: triage.at, pagesUsed: triage.pagesUsed ?? 0, confidence: typeof triage.confidence === 'number' ? triage.confidence : 0, why: triage.why ?? '' } : null,
  };
}

export function readCachedBrief(doc: Pick<DocumentRow, 'briefJson'>): DocumentBrief | null {
  const v = parseJson<DocumentBrief | null>(doc.briefJson, null);
  return v && typeof v === 'object' && typeof v.documentId === 'string' ? v : null;
}

/** Build and cache the brief. */
export function rebuildDocumentBrief(id: string): DocumentBrief {
  const brief = buildDocumentBrief(id);
  db().update(schema.documents).set({ briefJson: JSON.stringify(brief) }).where(eq(schema.documents.id, id)).run();
  return brief;
}

function rebuildBriefQuietly(id: string): void {
  try {
    rebuildDocumentBrief(id);
  } catch {
    // the brief is derived data; a failed rebuild is rebuilt on the next read
  }
}

/**
 * The cached brief when it is current, else a fresh one. Current means the
 * same facts signature and the same header: title source, tier, author role,
 * date, institution and author names (a link or a People entry may change
 * without touching the document's facts), and the same classification and
 * summary.
 */
export function getDocumentBrief(id: string): DocumentBrief {
  const doc = documentOr404(id);
  const cached = readCachedBrief(doc);
  if (cached && cached.labsVersion === BRIEF_LABS_VERSION && cached.factsSignature === briefFactsSignature(id) && cached.tier === doc.sourceTier && cached.authorRole === doc.authorRole && cached.titleSource === doc.titleSource && cached.date === doc.documentDate) {
    const triage = readTriageMeta(doc);
    const names = briefPeopleNames(doc, triage);
    const summary = briefSummary(doc, triage);
    const sameHeader = cached.institution === names.institution && cached.author === names.author && (cached.classification?.at ?? null) === briefClassificationAt(triage);
    const sameSummary = cached.summary === summary.summary && cached.summarySource === summary.source;
    // A test of a several-test line set aside since (a clinical record arrived that it copies or contradicts) changes
    // the trend charts, which are built with the brief: rebuild then. Nothing stored changes when a part is set aside.
    if (sameHeader && sameSummary && sameSetAside(cached)) return withFreshTrust(cached);
  }
  return rebuildDocumentBrief(id);
}

/** The keys of the part checks that set a test aside, sorted. */
function setAsideKeys(checks: Map<string, { setAside: boolean }>): string[] {
  return [...checks.entries()].filter(([, v]) => v.setAside).map(([k]) => k).sort();
}

/** Are the brief's several-test lines set aside as they were when it was built? (Only briefs with such lines are read.) */
function sameSetAside(brief: DocumentBrief): boolean {
  const rows = (brief.labs ?? []).flatMap((g) => g.rows);
  if (!rows.some((r) => r.partId)) return true;
  const now = setAsideKeys(labPartChecks([...new Set(rows.map((r) => r.factId))]));
  const was = brief.labSetAside ?? [];
  return now.length === was.length && now.every((k, i) => k === was[i]);
}

/** Every row of the brief with its trust as of now (trust depends on other documents, so the cached one may be old). */
function withFreshTrust(brief: DocumentBrief): DocumentBrief {
  const rows: BriefRowBase[] = [
    ...brief.labs.flatMap((g) => g.rows),
    ...brief.medications,
    ...brief.diagnoses,
    ...brief.imaging,
    ...brief.procedures,
    ...brief.symptoms,
    ...brief.recommendations,
    ...brief.followUps,
    ...brief.referrals,
    ...brief.recordReferences,
    ...brief.statements,
    ...brief.events,
    ...brief.intolerances,
  ];
  const trust = trustFor(rows.map((r) => r.factId));
  for (const r of rows) r.trust = trust.get(r.factId) ?? r.trust ?? plainTrust({ id: r.factId, status: r.status, verdictBasis: r.verdictBasis ?? null, documentTier: brief.tier });
  // A test read out of a line of several carries the part check's trust as of now (labs.ts labPartChecks).
  const parts = brief.labs.flatMap((g) => g.rows.filter((r) => r.partId).map((r) => ({ r, specimen: g.specimen })));
  if (parts.length) {
    const checks = labPartChecks([...new Set(parts.map((x) => x.r.factId))]);
    for (const { r, specimen } of parts) {
      const c = checks.get(r.partId!) ?? checks.get(`${r.factId}|${r.analyteKey}|${specimen}`);
      if (c?.trust) r.trust = c.trust;
    }
  }
  return brief;
}

/**
 * Soft delete the document and its facts; drop its pages from the search index. `keepRunningTypes`: running jobs of
 * these types are left to finish (the wrong-patient guard holds a document back from inside its own ingestion or
 * sorting job; services/patient-check.ts).
 */
export function deleteDocument(id: string, opts: { keepRunningTypes?: readonly string[] } = {}): { ok: true; factsDeleted: number; jobsCancelled: number } {
  documentOr404(id);
  const d = db();
  const now = nowIso();
  let factsDeleted = 0;
  let jobsCancelled = 0;
  d.transaction((tx) => {
    tx.update(schema.documents).set({ deletedAt: now, updatedAt: now }).where(eq(schema.documents.id, id)).run();
    const factIds = tx
      .select({ id: schema.facts.id })
      .from(schema.facts)
      .where(and(eq(schema.facts.sourceDocumentId, id), isNull(schema.facts.deletedAt)))
      .all()
      .map((r) => r.id);
    if (factIds.length) {
      tx.update(schema.facts).set({ deletedAt: now, updatedAt: now }).where(inArray(schema.facts.id, factIds)).run();
      // Patient statements of this document stop taking precedence now (same connection, so inside this transaction).
      releaseOverridesBy(factIds, now);
      for (const fid of factIds) removeFactIndex(fid);
      factsDeleted = factIds.length;
    }
    removeDocumentPagesIndex(id);
    removeEntityIndex('document', id);
    const r = tx
      .update(schema.jobs)
      .set({ status: 'cancelled', finishedAt: now })
      .where(and(eq(schema.jobs.documentId, id), eq(schema.jobs.status, 'queued')))
      .run();
    jobsCancelled = r.changes;
  });
  // A job already running (an extraction mid-way through its chunks, OCR) is aborted too, so it stops calling the
  // model and writing facts for a deleted document.
  const running = d
    .select({ id: schema.jobs.id, type: schema.jobs.type })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, id), eq(schema.jobs.status, 'running')))
    .all();
  for (const j of running) if (!opts.keepRunningTypes?.includes(j.type) && cancelJob(j.id)) jobsCancelled++;
  // Copies its measurements set aside come back as pending (and meet any other clinical record); never throws.
  if (factsDeleted) reconcileQuietly({ documentId: id, trigger: 'delete' });
  runLifecycleHooks(id, 'deleted');
  return { ok: true, factsDeleted, jobsCancelled };
}

/** Soft-deleted documents, most recently deleted first, with the facts a restore would bring back. */
export function listDeletedDocuments(): DeletedDocumentItem[] {
  const d = db();
  const rows = d
    .select({
      id: schema.documents.id,
      title: schema.documents.title,
      filename: schema.documents.filename,
      kind: schema.documents.kind,
      category: schema.documents.category,
      pageCount: schema.documents.pageCount,
      documentDate: schema.documents.documentDate,
      documentDatePrecision: schema.documents.documentDatePrecision,
      documentDateText: schema.documents.documentDateText,
      deletedAt: schema.documents.deletedAt,
      createdAt: schema.documents.createdAt,
      sha256: schema.documents.sha256,
      factsCount: sql<number>`(select count(*) from facts f where f.source_document_id = "documents"."id" and f.deleted_at = "documents"."deleted_at")`,
      // "Set this copy aside" (services/duplicates.ts) keeps which document it looked like a copy of; only while it
      // was not restored since (a copy restored and then deleted with plain Delete is an ordinary deleted document).
      setAsideAsCopyOf: sql<string | null>`(select o.title from documents o where o.id = (case when instr("documents"."metadata_json", '"copySetAside"') > 0 and json_valid("documents"."metadata_json") and json_extract("documents"."metadata_json", '$.copySetAside.restoredAt') is null then json_extract("documents"."metadata_json", '$.copySetAside.of') end))`,
      setAsideCheckedDetails: sql<number | null>`(case when instr("documents"."metadata_json", '"copySetAside"') > 0 and json_valid("documents"."metadata_json") and json_extract("documents"."metadata_json", '$.copySetAside.restoredAt') is null then json_extract("documents"."metadata_json", '$.copySetAside.checkedDetails') end)`,
      deleteReason: sql<string | null>`(case when instr("documents"."metadata_json", '"deleteReason"') > 0 and json_valid("documents"."metadata_json") then json_extract("documents"."metadata_json", '$.deleteReason') end)`,
    })
    .from(schema.documents)
    // A document held back as "May be someone else's record" waits for the user's answer, not in the trash.
    .where(and(isNotNull(schema.documents.deletedAt), NOT_QUARANTINED_SQL))
    .orderBy(desc(schema.documents.deletedAt))
    .limit(2000)
    .all();
  return rows.map(({ sha256: sha, deletedAt, deleteReason, ...r }) => {
    const live = d
      .select({ id: schema.documents.id, title: schema.documents.title })
      .from(schema.documents)
      .where(and(eq(schema.documents.sha256, sha), isNull(schema.documents.deletedAt)))
      .get();
    const checked = r.setAsideCheckedDetails === null || r.setAsideCheckedDetails === undefined ? null : Number(r.setAsideCheckedDetails);
    return { ...r, setAsideCheckedDetails: r.setAsideAsCopyOf !== null && Number.isFinite(checked) ? checked : null, deletedAt: deletedAt as string, duplicateOf: live ?? null, wrongPatient: deleteReason === WRONG_PATIENT_REASON };
  });
}

/**
 * Undo a soft delete: the document, and exactly the facts deleted with it
 * (same deleted_at stamp, so facts the user had deleted earlier stay deleted),
 * come back with their verdicts; the page, fact and document search rows are
 * written again and the brief rebuilt. Jobs cancelled by the delete are not
 * re-queued: ingestion or extraction cut short is marked failed so the user
 * can run it again. Refused while a live document holds the same file (an
 * upload after the delete), so the case never has the file twice.
 */
export function restoreDocument(id: string, opts: { asMine?: boolean } = {}): { ok: true; factsRestored: number; document: DocumentDetail } {
  const d = db();
  const doc = d.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!doc) throw notFound('document not found');
  const deletedAt = doc.deletedAt;
  if (!deletedAt) throw conflict('this document is not deleted');
  // The wrong-patient guard (2026-10-09): "Not my record" comes back as "May be someone else's record" (still hidden,
  // never trusted); only "It's mine" (services/patient-check.ts) restores a held document.
  const held = opts.asMine ? null : heldState(doc);
  if (held === 'quarantined') throw conflict("this document may be someone else's record: answer It's mine or Not my record");
  if (held === 'not_mine' && requarantine(id)) return { ok: true, factsRestored: 0, document: getDocument(id, { held: true }) };
  const live = d
    .select({ id: schema.documents.id, title: schema.documents.title })
    .from(schema.documents)
    .where(and(eq(schema.documents.sha256, doc.sha256), isNull(schema.documents.deletedAt), ne(schema.documents.id, id)))
    .get();
  if (live) throw conflict(`the same file is already in the case as "${live.title}"; delete that copy first to restore this one`);
  const now = nowIso();
  let factsRestored = 0;
  d.transaction((tx) => {
    const set: Partial<typeof schema.documents.$inferInsert> = { deletedAt: null, updatedAt: now };
    if (['pending', 'extracting', 'ocr_running'].includes(doc.textStatus)) {
      set.textStatus = 'failed';
      set.textError = 'ingestion stopped when the document was deleted; re-ingest it';
    }
    if (['queued', 'running'].includes(doc.extractionStatus)) set.extractionStatus = 'failed';
    tx.update(schema.documents).set(set).where(eq(schema.documents.id, id)).run();
    const facts = tx
      .select({ id: schema.facts.id, statement: schema.facts.statement, subjectKey: schema.facts.subjectKey, verdictNote: schema.facts.verdictNote })
      .from(schema.facts)
      .where(and(eq(schema.facts.sourceDocumentId, id), eq(schema.facts.deletedAt, deletedAt)))
      .all();
    for (let i = 0; i < facts.length; i += 500) {
      tx.update(schema.facts)
        .set({ deletedAt: null, updatedAt: now })
        .where(inArray(schema.facts.id, facts.slice(i, i + 500).map((f) => f.id)))
        .run();
    }
    // Found by statement and by the user's note, as everywhere else (facts.factSearchText).
    for (const f of facts) indexFact(f.id, factSearchText(f.statement, f.verdictNote), f.subjectKey);
    factsRestored = facts.length;
    const pages = tx
      .select({ id: schema.documentPages.id, pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text })
      .from(schema.documentPages)
      .where(eq(schema.documentPages.documentId, id))
      .all();
    for (const p of pages) indexPage(p.id, id, p.pageNumber, p.text);
    indexEntity('document', id, doc.title, [doc.filename, doc.notes ?? '', ...parseJson<string[]>(doc.tagsJson, [])].join(' '));
  });
  if (factsRestored) {
    try {
      // The delete released the overrides this document's patient statements held; the pass re-applies them.
      runPatientPrecedence({ documentId: id, trigger: 'manual' });
    } catch {
      // derived data; the next extraction or a manual run re-applies it
    }
    // The restored measurements reconcile again with the clinical records (never throws).
    reconcileQuietly({ documentId: id, trigger: 'restore' });
  }
  rebuildBriefQuietly(id);
  runLifecycleHooks(id, 'restored');
  // A document never checked for someone else's name is checked as it comes back and may be held back then.
  return { ok: true, factsRestored, document: getDocument(id, { held: true }) };
}

export function reingestDocument(id: string, opts: { forceOcr?: boolean } = {}): JobRow {
  documentOr404(id);
  db().update(schema.documents).set({ textStatus: 'pending', textError: null, updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
  return enqueueJob({ type: 'reingest_document', payload: { documentId: id, forceOcr: Boolean(opts.forceOcr), autoExtract: false }, documentId: id, dedupe: true });
}

/**
 * "Pull out the details" (again). Without a scope, a finished document is read again whole and anything else carries
 * on where it stopped (2026-10-07: a part-read document is resumed, never restarted at page 1). `pages` reads only the
 * given ranges again.
 */
export function requestExtraction(id: string, opts: { deep?: boolean; scope?: 'missing' | 'failed' | 'whole' | 'pages'; pages?: Array<[number, number]> } = {}): JobRow {
  const doc = documentOr404(id);
  if (doc.pageCount < 1 || !['extracted', 'ocr_done'].includes(doc.textStatus)) throw conflict('the document has no page text yet; wait for ingestion or re-ingest it');
  if (opts.scope === 'pages' && !opts.pages?.length) throw badRequest('say which pages to read again');
  const scope = opts.scope ?? (doc.extractionStatus === 'done' ? 'whole' : 'missing');
  const job = enqueueJob({
    type: 'extract_facts',
    payload: { documentId: id, deep: Boolean(opts.deep), scope, ...(scope === 'pages' ? { pages: opts.pages } : {}), reason: 'user', prevStatus: doc.extractionStatus },
    documentId: id,
    dedupe: true,
  });
  db().update(schema.documents).set({ extractionStatus: 'queued', updatedAt: nowIso() }).where(and(eq(schema.documents.id, id), inArray(schema.documents.extractionStatus, ['none', 'done', 'failed', 'partial']))).run();
  return job;
}

// A one-slot plaintext cache so the viewer's page renders do not decrypt a
// large PDF once per page. Cleared whenever the file key goes away (lock).
let lastFile: { key: string; buf: Buffer } | null = null;
export function clearFileCache(): void {
  lastFile = null;
  renderCache.clear();
}
onLockChange((unlocked) => {
  if (!unlocked) clearFileCache();
});

function fileBytes(doc: DocumentRow): Buffer {
  if (lastFile && lastFile.key === doc.storageKey) return lastFile.buf;
  const buf = getFile(doc.storageKey);
  lastFile = buf.length <= 256 * 1024 * 1024 ? { key: doc.storageKey, buf } : null;
  return buf;
}

export function getDocumentFile(id: string): { buffer: Buffer; mime: string; filename: string } {
  // The original of a held document opens too, so the user can see whose it is.
  const doc = documentOr404(id, { held: true });
  return { buffer: fileBytes(doc), mime: doc.mime || 'application/octet-stream', filename: doc.filename };
}

const RENDER_CACHE_MAX = 32;
const renderCache = new Map<string, { bytes: Buffer; mime: string }>();

/** PNG of a PDF page (or the image itself, re-encoded when the browser cannot show it). */
export function getPageImage(id: string, pageNumber: number, scale: number): { bytes: Buffer; mime: string } {
  const doc = documentOr404(id, { held: true });
  if (doc.kind !== 'pdf' && doc.kind !== 'image') throw notFound('no page image for this kind of document');
  const s = Math.min(4, Math.max(0.25, Math.round(scale * 100) / 100));
  const key = `${id}:${pageNumber}:${s}`;
  const hit = renderCache.get(key);
  if (hit) {
    renderCache.delete(key);
    renderCache.set(key, hit);
    return hit;
  }
  const buffer = fileBytes(doc);
  let out: { bytes: Buffer; mime: string };
  if (doc.kind === 'image') {
    if (pageNumber !== 1) throw notFound('images have one page');
    const browserSafe = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(doc.mime);
    if (browserSafe && Math.abs(s - 1) < 0.01) out = { bytes: buffer, mime: doc.mime };
    else {
      try {
        // An image stored without its type (SVG and other types that are never served as sent) is opened by its file name.
        const magic = doc.mime && doc.mime !== 'application/octet-stream' ? doc.mime : doc.filename;
        out = { bytes: renderDocumentPagePng(buffer, magic, 1, s).png, mime: 'image/png' };
      } catch {
        if (!browserSafe) throw notFound('this image format cannot be rendered');
        out = { bytes: buffer, mime: doc.mime };
      }
    }
  } else {
    try {
      out = { bytes: renderDocumentPagePng(buffer, 'application/pdf', pageNumber, s).png, mime: 'image/png' };
    } catch (err) {
      if (err instanceof RangeError) throw notFound(err.message);
      throw err;
    }
  }
  renderCache.set(key, out);
  while (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value as string);
  return out;
}


