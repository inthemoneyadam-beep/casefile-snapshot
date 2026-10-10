/**
 * Segments of a document (`document_segments`, migration 0005) and its coverage, upload record and confirmation.
 *
 * Owner: WP-A (pages, OCR and segments). The signatures are FROZEN (scratchpad ib_contracts.md section 6).
 * - CRUD, coverage, upload record, confirmation and outline: synchronous, callable inside a caller's transaction.
 * - `segmentDocument`: scans a PDF for image blocks and bookmarks, OCRs scanned images under a printed header page by
 *   page (appended to the text layer, never replacing it), cuts the document (src/server/ingest/epic/segment.ts: Epic
 *   exports by encounter, section and item; any other layout by bookmarks or blocks of pages), writes the segments, the
 *   export record and the coverage, looks for copies, and calls the afterSegmentation hook.
 * - `segmentPageTexts`: what the model reads of a segment (reading order for Epic, stored text otherwise).
 * - `parseSegmentContent`: the Epic parsers (messages, notes, letters, questionnaires, media items), no AI.
 * - `pageTextFormsLookup`: both forms of a page for citation checks (stored stream order and reading order).
 *
 * Rules: db() at call time; segments are never deleted (a re-segmentation sets `superseded_at`); writers of
 * `metadata_json.coverage` patch their own keys (mergeCoverageMeta) in one synchronous read-modify-write. This module
 * also writes `metadata_json.segmentation` (what the cut learned: layout, furniture, OCR counts) and `.export`.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { getFile } from '../files/store';
import { getSetting } from './settings';
import { newId, nowIso, parseJson } from '../util/ids';
import type { JobContext } from '../jobs/queue';
import { afterSegmentation, type AfterSegmentationResult, type SegmentationSummary } from './ingest-hooks';
import {
  buildUploadConfirmation, computeCoverage, documentExportInfo, mergeCoverageMeta, parseCoverage, parseSegmentDetail,
  parseUploadRecord, routeOf, segmentDraft, SEGMENTER_VERSION, uploadRecord,
  type CoveragePageInput, type DocumentCoverage, type DocumentExportInfo, type OutlineEntry, type ParsedSegmentContent,
  type SegmentDetail, type SegmentDraftInput, type SegmentPageInfo, type SegmentView, type UploadConfirmation, type UploadRecord,
} from '../../shared/schemas/segments';
import type { PageCoverageState, SegmentSkipReason, SegmentStatus } from '../../shared/enums';
import { imageRegion, OCR_IMAGE_SHARE, ocrPdfPages, scanPdf, type OcrTarget, type PageOcrResult, type PdfScan } from '../ingest/pdf';
import { appendOcr, pageReading, splitOcr, visualPageText } from '../ingest/reflow';
import { classifyRows, learnFurniture, printedDay, type FurnitureModel } from '../ingest/epic/furniture';
import { pageLines } from '../ingest/epic/lines';
import { needsOcr, segmentPages } from '../ingest/epic/segment';
import { encounterRefFor, furnitureModelFrom, segmentLinesOf, segmenterPagesOf, type StoredPage } from '../ingest/epic/cut';
import { parseSegmentLines } from '../ingest/epic/content';
import { updatePageTexts, type PageTextUpdate } from '../ingest/pages';

export type SegmentRow = typeof schema.documentSegments.$inferSelect;

/** What may change on a segment after it is written. `detail` is merged into the stored detail (top-level keys). */
export interface SegmentPatch {
  status?: SegmentStatus;
  skipReason?: SegmentSkipReason | null;
  attempts?: number;
  error?: string | null;
  extractionRunId?: string | null;
  schemaVersion?: number | null;
  factsCount?: number;
  messagesCount?: number;
  encounterId?: string | null;
  recordId?: string | null;
  sourceTier?: string | null;
  detail?: Partial<SegmentDetail>;
}

const T = schema.documentSegments;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A document's segments in order: live ones only unless asked. */
export function listSegments(documentId: string, opts: { includeSuperseded?: boolean } = {}): SegmentRow[] {
  const where = opts.includeSuperseded ? eq(T.documentId, documentId) : and(eq(T.documentId, documentId), isNull(T.supersededAt));
  return db().select().from(T).where(where).orderBy(asc(T.seq), asc(T.createdAt)).all();
}

export function getSegment(id: string): SegmentRow | null {
  return db().select().from(T).where(eq(T.id, id)).get() ?? null;
}

/** The live segments that include page `page`. */
export function segmentsTouching(documentId: string, page: number): SegmentRow[] {
  return listSegments(documentId).filter((s) => s.pageStart <= page && s.pageEnd >= page);
}

export function toSegmentView(row: SegmentRow): SegmentView {
  const detail = parseSegmentDetail(row.detailJson);
  return {
    id: row.id,
    documentId: row.documentId,
    seq: row.seq,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    kind: row.kind,
    route: routeOf({ kind: row.kind, detail }),
    headerText: row.headerText,
    encounterDate: row.encounterDate,
    encounterDatePrecision: row.encounterDatePrecision,
    encounterDateText: row.encounterDateText,
    encounterType: row.encounterType,
    department: row.department,
    encounterNumber: row.encounterNumber,
    sourceTier: row.sourceTier,
    status: row.status,
    skipReason: row.skipReason,
    attempts: row.attempts,
    error: row.error,
    factsCount: row.factsCount,
    messagesCount: row.messagesCount,
    duplicateOfSegmentId: row.duplicateOfSegmentId,
    encounterId: row.encounterId,
    recordId: row.recordId,
    extractionRunId: row.extractionRunId,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Writes a new segmentation. A live segment with the same pages, kind and text hash as a draft is KEPT with its
 * status and results (only its order and printed fields follow the draft); every other live segment is superseded
 * (`superseded_at`, never deleted); the rest of the drafts are created. One transaction.
 */
export function replaceSegments(documentId: string, drafts: SegmentDraftInput[], opts: { reason?: string } = {}): { created: number; superseded: number; kept: number; ids: string[] } {
  void opts.reason;
  const parsed = drafts.map((d) => segmentDraft.parse(d)).sort((a, b) => a.seq - b.seq);
  const now = nowIso();
  let created = 0;
  let superseded = 0;
  let kept = 0;
  const ids: string[] = [];
  db().transaction((tx) => {
    const live = tx.select().from(T).where(and(eq(T.documentId, documentId), isNull(T.supersededAt))).all();
    const byKey = new Map<string, SegmentRow>();
    for (const s of live) if (s.textHash) byKey.set(`${s.pageStart}|${s.pageEnd}|${s.kind}|${s.textHash}`, s);
    const keptIds = new Set<string>();
    const idBySeq = new Map<number, string>();
    const pending: Array<{ id: string; dupSeq: number | null }> = [];
    for (const d of parsed) {
      const match = d.textHash ? byKey.get(`${d.pageStart}|${d.pageEnd}|${d.kind}|${d.textHash}`) : undefined;
      if (match && !keptIds.has(match.id)) {
        keptIds.add(match.id);
        kept++;
        idBySeq.set(d.seq, match.id);
        ids.push(match.id);
        const detail = { ...parseSegmentDetail(match.detailJson), ...d.detail, segmenter: d.detail.segmenter ?? SEGMENTER_VERSION };
        tx.update(T)
          .set({
            seq: d.seq,
            headerText: d.headerText,
            encounterDate: d.encounterDate,
            encounterDatePrecision: d.encounterDatePrecision,
            encounterDateText: d.encounterDateText,
            encounterType: d.encounterType,
            department: d.department,
            encounterNumber: d.encounterNumber,
            sourceTier: d.sourceTier,
            detailJson: JSON.stringify(detail),
            updatedAt: now,
          })
          .where(eq(T.id, match.id))
          .run();
        pending.push({ id: match.id, dupSeq: d.duplicateOfSeq });
        continue;
      }
      const id = newId();
      idBySeq.set(d.seq, id);
      ids.push(id);
      created++;
      tx.insert(T)
        .values({
          id,
          documentId,
          seq: d.seq,
          pageStart: d.pageStart,
          pageEnd: d.pageEnd,
          kind: d.kind,
          headerText: d.headerText,
          encounterDate: d.encounterDate,
          encounterDatePrecision: d.encounterDatePrecision,
          encounterDateText: d.encounterDateText,
          encounterType: d.encounterType,
          department: d.department,
          encounterNumber: d.encounterNumber,
          sourceTier: d.sourceTier,
          textHash: d.textHash,
          status: d.status,
          skipReason: d.skipReason,
          detailJson: JSON.stringify({ ...d.detail, segmenter: d.detail.segmenter ?? SEGMENTER_VERSION }),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      pending.push({ id, dupSeq: d.duplicateOfSeq });
    }
    for (const p of pending) {
      const dupId = p.dupSeq === null ? null : idBySeq.get(p.dupSeq) ?? null;
      tx.update(T).set({ duplicateOfSegmentId: dupId }).where(eq(T.id, p.id)).run();
    }
    for (const s of live) {
      if (keptIds.has(s.id)) continue;
      tx.update(T).set({ supersededAt: now, updatedAt: now }).where(eq(T.id, s.id)).run();
      superseded++;
    }
  });
  return { created, superseded, kept, ids };
}

function patchValues(row: SegmentRow, patch: SegmentPatch, now: string): Partial<typeof T.$inferInsert> {
  const out: Partial<typeof T.$inferInsert> = { updatedAt: now };
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.skipReason !== undefined) out.skipReason = patch.skipReason;
  if (patch.attempts !== undefined) out.attempts = patch.attempts;
  if (patch.error !== undefined) out.error = patch.error;
  if (patch.extractionRunId !== undefined) out.extractionRunId = patch.extractionRunId;
  if (patch.schemaVersion !== undefined) out.schemaVersion = patch.schemaVersion;
  if (patch.factsCount !== undefined) out.factsCount = patch.factsCount;
  if (patch.messagesCount !== undefined) out.messagesCount = patch.messagesCount;
  if (patch.encounterId !== undefined) out.encounterId = patch.encounterId;
  if (patch.recordId !== undefined) out.recordId = patch.recordId;
  if (patch.sourceTier !== undefined) out.sourceTier = patch.sourceTier;
  if (patch.detail !== undefined) out.detailJson = JSON.stringify({ ...parseSegmentDetail(row.detailJson), ...patch.detail });
  return out;
}

/** Changes one segment; returns it as stored. Throws when there is no such segment. */
export function updateSegment(id: string, patch: SegmentPatch): SegmentRow {
  const row = getSegment(id);
  if (!row) throw new Error(`segment ${id} not found`);
  db().update(T).set(patchValues(row, patch, nowIso())).where(eq(T.id, id)).run();
  return getSegment(id)!;
}

/** The same change to several segments (detail merged per row). Returns how many changed. */
export function markSegments(ids: string[], patch: SegmentPatch): number {
  if (!ids.length) return 0;
  const now = nowIso();
  const rows = db().select().from(T).where(inArray(T.id, ids)).all();
  for (const row of rows) db().update(T).set(patchValues(row, patch, now)).where(eq(T.id, row.id)).run();
  return rows.length;
}

// ---------------------------------------------------------------------------
// Coverage (metadata_json.coverage)
// ---------------------------------------------------------------------------

function documentRow(documentId: string): typeof schema.documents.$inferSelect | undefined {
  return db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
}

/** The pages as the coverage sees them (no page text is loaded). */
function coveragePages(documentId: string): CoveragePageInput[] {
  const P = schema.documentPages;
  return db()
    .select({ pageNumber: P.pageNumber, ocr: P.ocr, hasText: sql<number>`length(trim(${P.text}, char(32, 9, 10, 13))) > 0` })
    .from(P)
    .where(eq(P.documentId, documentId))
    .orderBy(asc(P.pageNumber))
    .all()
    .map((p) => ({ pageNumber: p.pageNumber, ocr: Boolean(p.ocr), hasText: Boolean(p.hasText) }));
}

/** The coverage as stored, or null. */
export function readCoverage(documentId: string): DocumentCoverage | null {
  const doc = documentRow(documentId);
  return doc ? parseCoverage(parseJson<Record<string, unknown>>(doc.metadataJson, {})) : null;
}

/**
 * The coverage worked out now from the live segments. A document with no live segments keeps a stored legacy
 * coverage when it has one (worked out from citations before segments existed); otherwise every page is pending.
 */
export function coverageSummary(documentId: string, opts: { runId?: string | null } = {}): DocumentCoverage {
  const doc = documentRow(documentId);
  const stored = doc ? parseCoverage(parseJson<Record<string, unknown>>(doc.metadataJson, {})) : null;
  const segs = listSegments(documentId);
  if (!segs.length && stored?.basis === 'legacy') return stored;
  const pages = coveragePages(documentId);
  const pagesTotal = Math.max(doc?.pageCount ?? 0, pages.length ? pages[pages.length - 1].pageNumber : 0);
  const fresh = computeCoverage({
    pagesTotal,
    pages,
    segments: segs.map((s) => ({ id: s.id, pageStart: s.pageStart, pageEnd: s.pageEnd, status: s.status, skipReason: s.skipReason, error: s.error, supersededAt: s.supersededAt, detail: parseSegmentDetail(s.detailJson) })),
    runId: opts.runId !== undefined ? opts.runId : stored?.runId ?? null,
    at: nowIso(),
  });
  return {
    ...fresh,
    ...(stored?.legacy ? { legacy: stored.legacy } : {}),
    ...(stored?.resume ? { resume: stored.resume } : {}),
    ...(stored?.report ? { report: stored.report } : {}),
    ...(stored?.labCheck ? { labCheck: stored.labCheck } : {}),
  };
}

/** Works out the coverage and writes it, keeping `legacy`, `resume`, `report` and `labCheck`. Returns what was written. */
export function writeCoverage(documentId: string, opts: { runId?: string | null } = {}): DocumentCoverage {
  let out: DocumentCoverage | null = null;
  db().transaction((tx) => {
    const cov = coverageSummary(documentId, opts);
    out = cov;
    const current = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!current) return;
    const { legacy: _l, resume: _r, report: _p, labCheck: _c, ...computed } = cov;
    void _l;
    void _r;
    void _p;
    void _c;
    const meta = mergeCoverageMeta(parseJson<Record<string, unknown>>(current.metadataJson, {}), computed);
    tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  });
  return out!;
}

/**
 * Patches other writers' keys of the coverage: `legacy` and `resume` (the extraction engine), `report` (the
 * communications side), or a whole legacy coverage before segments exist. Never touches the other keys.
 */
export function patchCoverageMeta(documentId: string, patch: Partial<DocumentCoverage>): void {
  db().transaction((tx) => {
    const current = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!current) return;
    const meta = mergeCoverageMeta(parseJson<Record<string, unknown>>(current.metadataJson, {}), patch);
    tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  });
}

// ---------------------------------------------------------------------------
// Upload record and confirmation
// ---------------------------------------------------------------------------

export function readUploadRecord(documentId: string): UploadRecord | null {
  const doc = documentRow(documentId);
  return doc ? parseUploadRecord(parseJson<Record<string, unknown>>(doc.metadataJson, {})) : null;
}

/** Writes `metadata_json.upload` (validated), keeping every other key. */
export function writeUploadRecord(documentId: string, rec: UploadRecord): void {
  const valid = uploadRecord.parse(rec);
  db().transaction((tx) => {
    const current = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!current) return;
    const meta = parseJson<Record<string, unknown>>(current.metadataJson, {});
    // The upload route's own notes (when it arrived, the browser's file type) stay beside the record.
    const before = meta.upload && typeof meta.upload === 'object' ? (meta.upload as Record<string, unknown>) : {};
    meta.upload = { ...before, ...valid };
    tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  });
}

/** What the "adding" banner shows for one document. Throws when there is no such document. */
export function uploadConfirmation(documentId: string): UploadConfirmation {
  const doc = documentRow(documentId);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  let coverage = parseCoverage(meta);
  if (!coverage && listSegments(documentId).length) coverage = coverageSummary(documentId);
  // Details are being pulled out only while a reading is queued or running (2026-10-07 review, rev-comms #7: an upload
  // whose reading was never queued, because Claude is off, the key is missing, or the reading was stopped, said
  // "pulling out the details" for ever). Otherwise the banner settles and says why.
  const jobs = db()
    .select({ status: schema.jobs.status, error: schema.jobs.error })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, documentId), inArray(schema.jobs.type, ['extract_facts', 'resume_extraction'])))
    .orderBy(sql`${schema.jobs.createdAt} desc`)
    .limit(5)
    .all();
  const live = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  const extractionWanted = ['queued', 'running'].includes(doc.extractionStatus) || live;
  return buildUploadConfirmation({
    document: { id: doc.id, title: doc.title, sizeBytes: doc.sizeBytes, pageCount: doc.pageCount, textStatus: doc.textStatus, textError: doc.textError, extractionStatus: doc.extractionStatus },
    upload: parseUploadRecord(meta),
    coverage,
    extractionWanted,
    notRequestedReason: extractionWanted ? null : notRequestedReason(meta, jobs[0] ?? null),
  });
}

/** Why a document's details were not pulled out, in plain words (null when nothing says why). */
function notRequestedReason(meta: Record<string, unknown>, lastJob: { status: string; error: string | null } | null): string | null {
  const inbox = meta.inbox as { status?: string } | undefined;
  if (inbox && typeof inbox.status === 'string' && ['new', 'triaged', 'needs_manual'].includes(inbox.status)) return 'it is waiting in Check before filing';
  let enabled = true;
  let key = true;
  try {
    enabled = Boolean(getSetting('ai.enabled'));
    key = Boolean(process.env.ANTHROPIC_API_KEY?.trim() || getSetting('ai.apiKey')?.trim());
  } catch {
    // settings unreadable: say nothing more
  }
  if (!enabled) return 'Claude is switched off in Settings';
  if (!key) return 'no AI key is set in Settings';
  if (lastJob?.status === 'cancelled') return 'the reading was stopped';
  if (lastJob?.status === 'failed') return 'the last try failed';
  return null;
}

// ---------------------------------------------------------------------------
// Outline and text
// ---------------------------------------------------------------------------

const WORST: PageCoverageState[] = ['failed', 'running', 'pending'];
const BEST: PageCoverageState[] = ['done', 'parsed', 'skipped', 'no_text'];

/** A document's encounters (or one entry for a document without them), each with its live segments. */
export function documentOutline(documentId: string): OutlineEntry[] {
  const segs = listSegments(documentId);
  const groups = new Map<string, SegmentRow[]>();
  for (const s of segs) {
    const key = parseSegmentDetail(s.detailJson).encounterKey ?? 'document';
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const out: OutlineEntry[] = [];
  for (const [key, list] of groups) {
    const first = list[0];
    const states = new Set(list.map((s) => s.status as PageCoverageState));
    const state = WORST.find((w) => states.has(w)) ?? BEST.find((b) => states.has(b)) ?? 'pending';
    out.push({
      encounterKey: key,
      headerText: first.headerText,
      date: first.encounterDate,
      datePrecision: first.encounterDatePrecision,
      dateText: first.encounterDateText,
      type: first.encounterType,
      department: first.department,
      number: list.find((s) => s.encounterNumber)?.encounterNumber ?? null,
      pageStart: Math.min(...list.map((s) => s.pageStart)),
      pageEnd: Math.max(...list.map((s) => s.pageEnd)),
      state,
      factsCount: list.reduce((n, s) => n + s.factsCount, 0),
      messagesCount: list.reduce((n, s) => n + s.messagesCount, 0),
      segments: list.map(toSegmentView),
    });
  }
  return out.sort((a, b) => a.pageStart - b.pageStart);
}

// ---------------------------------------------------------------------------
// Reading order, furniture and lines of stored pages
// ---------------------------------------------------------------------------

/** `metadata_json.segmentation`: what the last segmentation learned (read back by the text and parser paths). */
export interface SegmentationMeta {
  v: 1;
  at: string;
  version: number;
  layout: 'epic' | 'outline' | 'pages';
  /** The PDF was scanned for images and bookmarks (false: the original could not be read). */
  scanned: boolean;
  outline: boolean;
  furniture: { epic: boolean; header: string[]; footer: string[]; printedText: string | null; institutionText: string | null; patientName: string | null; bannerCentre?: number };
  ocr: { tried: number; appended: number; failed: number; nothingNew: number };
  pages: number;
  segments: number;
}

export function readSegmentationMeta(documentId: string): SegmentationMeta | null {
  const doc = documentRow(documentId);
  if (!doc) return null;
  const m = parseJson<Record<string, unknown>>(doc.metadataJson, {}).segmentation as SegmentationMeta | undefined;
  return m && m.v === 1 && m.furniture ? m : null;
}

function furnitureModelOf(meta: SegmentationMeta | null): FurnitureModel {
  return furnitureModelFrom(meta?.furniture);
}

function loadPages(documentId: string, range?: { from: number; to: number }): StoredPage[] {
  const P = schema.documentPages;
  const where = range
    ? and(eq(P.documentId, documentId), sql`${P.pageNumber} between ${range.from} and ${range.to}`)
    : eq(P.documentId, documentId);
  return db()
    .select({ pageNumber: P.pageNumber, text: P.text, ocr: P.ocr, confidence: P.confidence, boxesJson: P.boxesJson })
    .from(P)
    .where(where)
    .orderBy(asc(P.pageNumber))
    .all()
    .map((p) => ({ ...p, ocr: Boolean(p.ocr) }));
}

/** One page of a segment as the model is given it. */
export interface SegmentPageText {
  pageNumber: number;
  text: string;
  ocr: boolean;
}

function readsStoredText(detail: SegmentDetail): boolean {
  const how = (detail as Record<string, unknown>).text;
  return how !== 'visual';
}

/**
 * The text of a segment's pages for the model, in page order, without pages the segment skips. An Epic passage is
 * given in reading order (rebuilt from the line boxes; running header, footer, context line and banner removed; the
 * encounter's banner as printed once at the top; only its own lines on a page it shares; the OCR text of a scanned image
 * it holds appended under its label). A passage of an unknown layout (page blocks, bookmarks) is given its stored text,
 * as before.
 */
export function segmentPageTexts(documentId: string, segment: Pick<SegmentRow, 'pageStart' | 'pageEnd' | 'detailJson'> & Partial<Pick<SegmentRow, 'headerText'>>): SegmentPageText[] {
  const detail = parseSegmentDetail(segment.detailJson);
  const skip = new Set((detail.pages ?? []).filter((p) => p.state === 'skipped' || p.state === 'no_text').map((p) => p.page));
  const pages = loadPages(documentId, { from: segment.pageStart, to: segment.pageEnd });
  if (readsStoredText(detail)) {
    return pages
      .filter((p) => !skip.has(p.pageNumber) && p.text.trim().length > 0)
      .map((p) => ({ pageNumber: p.pageNumber, text: p.text, ocr: p.ocr }));
  }
  const model = furnitureModelOf(readSegmentationMeta(documentId));
  const { lines, ocrByPage } = segmentLinesOf(segment, detail, pages, model);
  const out: SegmentPageText[] = [];
  let first = true;
  for (const p of pages) {
    if (skip.has(p.pageNumber)) continue;
    const own = lines.filter((l) => l.page === p.pageNumber).map((l) => l.text);
    if (first && segment.headerText && own.length) own.unshift(segment.headerText);
    let text = own.join('\n');
    const ocrText = ocrByPage.get(p.pageNumber);
    if (ocrText) text = appendOcr(text, ocrText);
    if (!text.trim()) continue;
    out.push({ pageNumber: p.pageNumber, text, ocr: Boolean(ocrText) || p.ocr });
    first = false;
  }
  return out;
}

/**
 * What the parsers read out of one segment (messages, notes, letters, questionnaires, media items), with no AI, over
 * its reading-order lines. Read-only: the communications side records `detail.parse` once it has imported the result.
 * An unknown segment, or one of a layout the parsers do not know, gives nothing.
 */
export function parseSegmentContent(documentId: string, segmentId: string): ParsedSegmentContent {
  const empty: ParsedSegmentContent = { segmentId, version: SEGMENTER_VERSION, messages: [], notes: [], letters: [], questionnaires: [], media: [] };
  const seg = getSegment(segmentId);
  if (!seg || seg.documentId !== documentId) return empty;
  const detail = parseSegmentDetail(seg.detailJson);
  if (readsStoredText(detail)) return empty;
  const meta = readSegmentationMeta(documentId);
  const model = furnitureModelOf(meta);
  const pages = loadPages(documentId, { from: seg.pageStart, to: seg.pageEnd });
  const { lines } = segmentLinesOf(seg, detail, pages, model);
  const imagePages = new Set((detail.pages ?? []).filter((p) => (p.imageCoverage ?? 0) >= OCR_IMAGE_SHARE).map((p) => p.page));
  return parseSegmentLines(seg.kind, lines, { encounter: encounterRefFor(seg, detail), segmentId: seg.id, patientName: model.patientName, imagePages });
}

/** The two forms of a page's text: as stored (stream order; search and old citations) and in reading order. */
export interface PageTextForms {
  stored: string;
  /** Rebuilt from boxes_json in reading order, OCR appended; null when it cannot be rebuilt (no boxes). */
  visual: string | null;
}

/**
 * Both forms of every page of a document, for citation checks: a quote is verified when found in either (D.1.3). The
 * visual form is every row of the page in reading order (furniture included: it is printed text), then the OCR text.
 */
export function pageTextFormsLookup(documentId: string): (pageNumber: number) => PageTextForms | undefined {
  const rows = loadPages(documentId);
  const byPage = new Map<number, StoredPage>(rows.map((r) => [r.pageNumber, r]));
  const cache = new Map<number, PageTextForms>();
  return (n) => {
    const hit = cache.get(n);
    if (hit) return hit;
    const p = byPage.get(n);
    if (!p) return undefined;
    const forms = { stored: p.text, visual: visualPageText(p) };
    cache.set(n, forms);
    return forms;
  };
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

export interface SegmentDocumentOptions {
  reason?: SegmentationSummary['reason'];
  /** Segment again even when the live segments are current. */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number, text?: string) => void;
  /** Do not run OCR (tests, or a caller that only needs the cut). Pages flagged for OCR are left as they are. */
  skipOcr?: boolean;
  /** The original's bytes when the caller has just read them (the ingest job), so they are not read again. */
  original?: Buffer;
}

export interface SegmentationResult {
  documentId: string;
  segments: { created: number; superseded: number; kept: number; total: number };
  /** Pages whose text changed (OCR appended) in this run. */
  ocrPages: number[];
  hooks: AfterSegmentationResult | null;
  /** Set when nothing was done, in words. */
  skipped?: string;
}

/** Failed OCR attempts in a row on one scan before its failure stands (each segmentation tries again until then). */
export const OCR_MAX_TRIES = 3;
/** OCR adds text to a page only when it reads at least this many words the text layer does not have. */
const OCR_NEW_WORDS_MIN = 3;

function wordsOf(s: string): string[] {
  return (s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

/** Words the OCR read that the page's text layer does not have. */
function newWords(layer: string, ocr: string): number {
  const have = new Set(wordsOf(layer));
  let n = 0;
  for (const w of wordsOf(ocr)) if (!have.has(w)) n++;
  return n;
}

function abortError(): Error {
  const e = new Error('segmentation cancelled');
  e.name = 'AbortError';
  return e;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && (err.name === 'AbortError' || /cancelled|aborted/i.test(err.message)));
}

/**
 * A key the encrypted file store wrote ("ab/<uuid><ext>.cfe"). Rows made by hand (tests, imports of page text alone)
 * carry other keys: their original is never looked for on disk.
 */
export function isStoreKey(storageKey: string | null | undefined): boolean {
  return /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]{1,12})?\.cfe$/.test(storageKey ?? '');
}

/** The live segments' last word on each page (OCR outcome, tries), to carry over to a new segmentation. */
function previousPageInfos(documentId: string): Map<number, SegmentPageInfo> {
  const out = new Map<number, SegmentPageInfo>();
  for (const s of listSegments(documentId)) for (const p of parseSegmentDetail(s.detailJson).pages ?? []) if (!out.has(p.page)) out.set(p.page, p);
  return out;
}

function sameDigests(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...(a ?? [])].sort().join(',');
  const y = [...(b ?? [])].sort().join(',');
  return x === y;
}

/**
 * Cuts a document into segments and writes them, then its coverage, then calls the afterSegmentation hook.
 *
 * For a PDF: the original is scanned for image blocks and bookmarks; a page whose images cover 10% of it (or whose
 * body is near empty over an image) is read by OCR, page by page, each isolated with a time limit; text the OCR adds is
 * APPENDED to the page under its label (the text layer is kept; the page is re-indexed and only its citations are
 * checked again). Then the segmenter (ingest/epic/segment.ts) cuts the pages: Epic exports by encounter and section, any
 * other layout by bookmarks or blocks of pages. Segments are written with replaceSegments (unchanged ones keep their
 * results; the rest are superseded, never deleted), `metadata_json.export` (Epic) and `.segmentation` are written, then
 * the coverage, then copies inside the export are looked for, then the hook.
 */
export async function segmentDocument(documentId: string, opts: SegmentDocumentOptions = {}): Promise<SegmentationResult> {
  const doc = documentRow(documentId);
  if (!doc || doc.deletedAt) throw new Error(`document ${documentId} not found`);
  const reason = opts.reason ?? 'ingest';
  const progress = (p: number, t?: string) => opts.onProgress?.(Math.max(0, Math.min(1, p)), t);
  let pages = loadPages(documentId);
  const prev = previousPageInfos(documentId);

  // 1. Scan the original (PDF): image blocks, digests, bookmarks.
  let scan: PdfScan | null = null;
  let buffer: Buffer | null = null;
  if (doc.kind === 'pdf' && pages.length && (opts.original || isStoreKey(doc.storageKey))) {
    try {
      buffer = opts.original ?? getFile(doc.storageKey);
      progress(0.02, 'looking at the pages');
      scan = await scanPdf(buffer, { signal: opts.signal, onPage: (n, total) => { if (n % 50 === 0) progress(0.02 + 0.18 * (n / total), `looking at page ${n} of ${total}`); } });
    } catch (err) {
      if (isAbort(err, opts.signal)) throw abortError();
      scan = null; // The original could not be read: the cut goes on from the stored pages alone.
    }
  }
  const scanOf = (n: number) => scan?.pages[n - 1];

  // 2. OCR of scanned images under a printed header (appended, never replacing the text layer).
  const ocrInfo = new Map<number, NonNullable<SegmentPageInfo['ocr']>>();
  const ocrTries = new Map<number, number>();
  const ocrPagesChanged: number[] = [];
  const stats = { tried: 0, appended: 0, failed: 0, nothingNew: 0 };
  if (scan && buffer) {
    const learned = learnFurniture(pages.map((p) => pageReading(p)).filter((r) => r.source === 'boxes').map((r) => r.rows), { epicHint: /epic/i.test(scan.info.creator ?? '') });
    const targets: OcrTarget[] = [];
    for (const p of pages) {
      const sp = scanOf(p.pageNumber);
      if (!sp || !sp.images.length) continue;
      const before = prev.get(p.pageNumber);
      const digests = sp.images.map((im) => im.digest);
      // Failed attempts in a row on this scan (a success starts the count again).
      const tries = sameDigests(before?.imageDigests, digests) && before?.ocr?.error ? Number((before as Record<string, unknown>).ocrTries ?? 1) : 0;
      if (before?.ocr && sameDigests(before.imageDigests, digests)) {
        ocrInfo.set(p.pageNumber, before.ocr);
        ocrTries.set(p.pageNumber, tries);
      }
      if (p.ocr || splitOcr(p.text).ocr !== null) continue; // its text already came from OCR
      // Settled earlier: read with nothing new to add, or failed OCR_MAX_TRIES times. A page whose OCR text was appended
      // but is gone (the pages were read again from the file) is read again.
      if (before?.ocr && sameDigests(before.imageDigests, digests) && ((!before.ocr.error && before.ocr.chars === 0) || (before.ocr.error && tries >= OCR_MAX_TRIES))) continue;
      const reading = pageReading(p);
      const classes = classifyRows(reading.rows, learned);
      const bodyChars = pageLines({ page: p.pageNumber, rows: reading.rows, classes, source: reading.source }).reduce((n, l) => n + l.text.length, 0);
      if (!needsOcr({ imageCoverage: sp.imageCoverage, imageDigests: digests, bodyChars })) continue;
      targets.push({ pageNumber: p.pageNumber, region: sp.imageCoverage >= OCR_IMAGE_SHARE ? imageRegion(sp) : null });
      ocrTries.set(p.pageNumber, tries);
    }
    if (targets.length && !opts.skipOcr) {
      progress(0.2, `reading ${targets.length} scanned ${targets.length === 1 ? 'page' : 'pages'}`);
      let results: PageOcrResult[];
      try {
        results = await ocrPdfPages(buffer, targets, { signal: opts.signal, onPage: (done, total) => progress(0.2 + 0.6 * (done / total), `reading scanned page ${done} of ${total}`) });
      } catch (err) {
        if (isAbort(err, opts.signal)) throw abortError();
        throw err;
      }
      const at = nowIso();
      const updates: PageTextUpdate[] = [];
      const byNumber = new Map(pages.map((p) => [p.pageNumber, p]));
      for (const r of results) {
        stats.tried++;
        ocrTries.set(r.pageNumber, r.error ? (ocrTries.get(r.pageNumber) ?? 0) + 1 : 0);
        const page = byNumber.get(r.pageNumber);
        if (!page) continue;
        if (r.error) {
          stats.failed++;
          ocrInfo.set(r.pageNumber, { chars: 0, confidence: null, at, error: r.error });
          continue;
        }
        const layer = splitOcr(page.text).layer;
        if (newWords(layer, r.text) < OCR_NEW_WORDS_MIN) {
          stats.nothingNew++;
          ocrInfo.set(r.pageNumber, { chars: 0, confidence: r.confidence, at, error: null });
          continue;
        }
        stats.appended++;
        ocrInfo.set(r.pageNumber, { chars: r.text.length, confidence: r.confidence, at, error: null });
        updates.push({ pageNumber: r.pageNumber, text: appendOcr(layer, r.text), ocr: true, confidence: r.confidence });
      }
      if (updates.length) {
        updatePageTexts(documentId, updates);
        ocrPagesChanged.push(...updates.map((u) => u.pageNumber));
        db().update(schema.documents).set({ ocrApplied: true, ...(doc.textStatus === 'extracted' ? { textStatus: 'ocr_done' } : {}) }).where(eq(schema.documents.id, documentId)).run();
        pages = loadPages(documentId);
      }
    }
  }
  if (opts.signal?.aborted) throw abortError();

  // 3. Cut.
  progress(0.85, 'cutting into parts');
  const segPages = segmenterPagesOf(pages, scan, { previous: prev, ocrInfo, ocrTries });
  const maxPages = Math.max(1, Math.floor(Number(getSetting('ai.maxPagesPerChunk')) || 24));
  const cut = segmentPages({
    pages: segPages,
    pageCount: Math.max(doc.pageCount, scan?.pageCount ?? 0, pages.length ? pages[pages.length - 1].pageNumber : 0),
    outline: scan?.outline ?? [],
    epicHint: /epic/i.test(scan?.info.creator ?? ''),
    maxPagesPerBlock: maxPages,
  });

  // 4. Write: segments, export info, segmentation record, coverage.
  const written = replaceSegments(documentId, cut.drafts, { reason });
  const at = nowIso();
  const segMeta: SegmentationMeta = {
    v: 1,
    at,
    version: SEGMENTER_VERSION,
    layout: cut.layout,
    scanned: Boolean(scan),
    outline: cut.outlineUsed,
    furniture: {
      epic: cut.furniture.epic,
      header: [...cut.furniture.header],
      footer: [...cut.furniture.footer],
      printedText: cut.furniture.printedText,
      institutionText: cut.furniture.institutionText,
      patientName: cut.furniture.patientName,
      ...(cut.furniture.bannerCentre !== undefined ? { bannerCentre: cut.furniture.bannerCentre } : {}),
    },
    ocr: stats,
    pages: pages.length,
    segments: cut.drafts.length,
  };
  const exportInfo: DocumentExportInfo | null = cut.layout === 'epic'
    ? {
        v: 1,
        at,
        system: 'epic',
        layout: cut.encounters.some((e) => e.date) ? 'chart_print' : 'unknown',
        printedText: cut.furniture.printedText,
        printedAt: printedDay(cut.furniture.printedText),
        institutionText: cut.furniture.institutionText,
        outline: cut.outlineUsed,
        encounters: cut.encounters.filter((e) => !e.patient && e.headerText).length,
        segmenter: SEGMENTER_VERSION,
      }
    : null;
  db().transaction((tx) => {
    const current = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!current) return;
    const meta = parseJson<Record<string, unknown>>(current.metadataJson, {});
    meta.segmentation = segMeta;
    if (exportInfo) meta.export = documentExportInfo.parse(exportInfo);
    else delete meta.export;
    tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  });
  writeCoverage(documentId);

  // 5. Copies: a filed document (a message, a report) that this export also holds, and the other way round. At
  // ingest the pipeline does this once the document reads as read (its page count and status are written then).
  if (reason !== 'ingest') {
    try {
      const dup = await import('./duplicates');
      await dup.checkSegmentCopiesQuietly(documentId);
    } catch {
      // best effort: never fails the segmentation
    }
  }

  const live = listSegments(documentId);
  const summary: SegmentationSummary = {
    documentId,
    reason,
    segmenterVersion: SEGMENTER_VERSION,
    segments: { created: written.created, superseded: written.superseded, kept: written.kept, total: live.length },
    toParse: live.filter((s) => {
      const d = parseSegmentDetail(s.detailJson);
      const route = routeOf({ kind: s.kind, detail: d });
      return (route === 'parse' || route === 'parse_and_extract') && (d.parse?.version ?? 0) < SEGMENTER_VERSION;
    }).map((s) => s.id),
    ocrPages: ocrPagesChanged,
  };
  progress(0.95, 'listing messages and calls');
  let hooks: AfterSegmentationResult | null = null;
  try {
    hooks = await afterSegmentation(documentId, summary);
  } catch {
    hooks = null; // best effort: a hook never fails the segmentation
  }
  progress(1, `${live.length} parts`);
  return { documentId, segments: summary.segments, ocrPages: ocrPagesChanged, hooks };
}

/**
 * Segments the document unless its live segments are current: same segmenter version, every page covered, and no
 * scanned page waiting for another OCR attempt.
 */
export async function ensureSegmented(documentId: string, opts: SegmentDocumentOptions = {}): Promise<SegmentationResult> {
  const live = listSegments(documentId);
  if (!opts.force && live.length) {
    const doc = documentRow(documentId);
    const details = live.map((s) => parseSegmentDetail(s.detailJson));
    const current = details.every((d) => (d.segmenter ?? 0) >= SEGMENTER_VERSION);
    const lastPage = Math.max(...live.map((s) => s.pageEnd));
    const retryOcr = details.some((d) => (d.pages ?? []).some((p) => p.ocr?.error && Number((p as Record<string, unknown>).ocrTries ?? 1) < OCR_MAX_TRIES));
    if (current && lastPage >= (doc?.pageCount ?? 0) && !retryOcr) {
      return { documentId, segments: { created: 0, superseded: 0, kept: live.length, total: live.length }, ocrPages: [], hooks: null, skipped: 'already segmented' };
    }
  }
  return segmentDocument(documentId, opts);
}

/** Payload of the `segment_document` job (ingest lane; no AI). */
export interface SegmentDocumentPayload {
  documentId: string;
  reason: SegmentationSummary['reason'];
  force?: boolean;
}

/** The `segment_document` job handler (registered by the job registry's owner). */
export async function segmentDocumentJob(ctx: JobContext<SegmentDocumentPayload>): Promise<SegmentationResult> {
  const { documentId, reason, force } = ctx.payload;
  ctx.setProgress(0.01, 'cutting into parts');
  const out = await ensureSegmented(documentId, { reason, force, signal: ctx.signal, onProgress: (p, t) => ctx.setProgress(p, t) });
  ctx.setProgress(1, `${out.segments.total} parts`);
  return out;
}
