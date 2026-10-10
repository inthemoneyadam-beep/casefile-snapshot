/**
 * Ingestion: original bytes -> page map. Writes `document_pages` (replacing
 * any previous pages), keeps `pages_fts` in sync, updates the document's
 * status/metadata, and optionally queues fact extraction.
 *
 * Large exports (2026-10-07): after the pages are written, the upload record proves the whole file arrived and every
 * page was stored (`metadata_json.upload`: bytes read back and hashed, the file's own page count against the pages
 * stored), then the document is cut into segments (services/segments.ts: scanned images under a printed header read
 * by OCR and APPENDED page by page, the Epic layout cut by encounter and section, coverage written). A page whose OCR
 * fails never fails the document. Segmentation is best effort here: if it cannot finish, the extraction pass runs it
 * again (ensureSegmented).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { holdsBeforeReading } from '../services/patient-check';
import { getFile } from '../files/store';
import { indexPage, removeDocumentPagesIndex } from '../services/search';
import { enqueueJob, type JobContext, type JobRow } from '../jobs/queue';
import { aiEnabled, getApiKey } from '../ai/client';
import { newId, nowIso, parseJson } from '../util/ids';
import type { DocumentKind, TextStatus } from '../../shared/enums';
import type { PartialDate } from '../../shared/dates';
import { extractImage, extractPdf, type ExtractedPage } from './pdf';
import { csvToText, decodeText, docxToText, jsonToText, splitPseudoPages } from './text';
import { parseDicomMeta } from './dicom';
import { isAbortError } from './ocr';
import { looksLikeText, mayReplaceDocumentDate } from './detect';
import { checkCopiesQuietly, checkSegmentCopiesQuietly } from '../services/duplicates';
import { buildUploadRecord, type UploadRecord } from '../../shared/schemas/segments';
import { getFile as readStoredFile } from '../files/store';
import { pdfPageCount } from './pdf';
import { reverifyDocumentCitations } from './pages';
import { visualPageText } from './reflow';
import crypto from 'node:crypto';

export { reverifyDocumentCitations, updatePageTexts } from './pages';

export interface IngestPayload {
  documentId: string;
  autoExtract?: boolean;
  forceOcr?: boolean;
  /** Inbox uploads: continue into `triage_document` once the pages are written. */
  thenTriage?: boolean;
}

export interface IngestOptions {
  forceOcr?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number, text?: string) => void;
}

export interface IngestResult {
  documentId: string;
  pageCount: number;
  textStatus: TextStatus;
  ocrApplied: boolean;
  ocrPages: number;
  chars: number;
}

interface Extracted {
  pages: ExtractedPage[];
  ocrApplied: boolean;
  ocrPages: number;
  metadata?: Record<string, unknown>;
  documentDate?: PartialDate | null;
}

type DocumentRow = typeof schema.documents.$inferSelect;

function pseudo(text: string): ExtractedPage[] {
  return splitPseudoPages(text).map((t, i) => ({ pageNumber: i + 1, text: t, ocr: false, confidence: null, width: null, height: null, boxes: null }));
}

function setStatus(id: string, status: TextStatus, error: string | null = null): void {
  try {
    db().update(schema.documents).set({ textStatus: status, textError: error, updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
  } catch {
    // locked mid-job; nothing to record into
  }
}

/** Dispatch on kind. Exported for tests and for re-use by scripts. */
export async function extractByKind(kind: DocumentKind, buffer: Buffer, opts: IngestOptions & { documentId?: string } = {}): Promise<Extracted> {
  const { signal } = opts;
  switch (kind) {
    case 'pdf': {
      let ocrStarted = false;
      const r = await extractPdf(buffer, {
        forceOcr: opts.forceOcr,
        signal,
        onPage: ({ pageNumber, total, ocr }) => {
          if (ocr && !ocrStarted && opts.documentId) {
            ocrStarted = true;
            setStatus(opts.documentId, 'ocr_running');
          }
          opts.onProgress?.(Math.max(0.02, (pageNumber - 1) / Math.max(1, total)), `${ocr ? 'OCR ' : ''}page ${pageNumber} of ${total}`);
        },
      });
      return { pages: r.pages, ocrApplied: r.ocrApplied, ocrPages: r.ocrPages };
    }
    case 'image': {
      if (opts.documentId) setStatus(opts.documentId, 'ocr_running');
      opts.onProgress?.(0.1, 'OCR image');
      let page: ExtractedPage;
      try {
        page = await extractImage(buffer, { signal });
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw new Error(`OCR failed for this image: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { pages: [page], ocrApplied: true, ocrPages: 1 };
    }
    case 'docx': {
      opts.onProgress?.(0.2, 'reading DOCX');
      return { pages: pseudo(await docxToText(buffer)), ocrApplied: false, ocrPages: 0 };
    }
    case 'csv':
      return { pages: pseudo(csvToText(decodeText(buffer))), ocrApplied: false, ocrPages: 0 };
    case 'json':
      return { pages: pseudo(jsonToText(decodeText(buffer))), ocrApplied: false, ocrPages: 0 };
    case 'text':
    case 'audio_transcript':
      return { pages: pseudo(decodeText(buffer)), ocrApplied: false, ocrPages: 0 };
    case 'dicom': {
      opts.onProgress?.(0.2, 'reading DICOM header');
      const r = parseDicomMeta(buffer);
      return {
        pages: [{ pageNumber: 1, text: r.text, ocr: false, confidence: null, width: r.meta.columns ?? null, height: r.meta.rows ?? null, boxes: null }],
        ocrApplied: false,
        ocrPages: 0,
        metadata: { dicom: r.meta, dicomWarnings: r.warnings.slice(0, 20) },
        documentDate: r.studyDate,
      };
    }
    case 'other':
    default: {
      if (looksLikeText(buffer.subarray(0, 4096))) return { pages: pseudo(decodeText(buffer)), ocrApplied: false, ocrPages: 0 };
      throw new Error('unsupported file type: no text could be read from this file');
    }
  }
}

/**
 * Replace a document's pages and keep the full-text index in step. The
 * document's citations are re-verified against the new text in the same
 * transaction, so stale offsets are never visible next to new text.
 */
export function writePages(documentId: string, pages: ExtractedPage[]): number {
  const d = db();
  let chars = 0;
  d.transaction((tx) => {
    tx.delete(schema.documentPages).where(eq(schema.documentPages.documentId, documentId)).run();
    removeDocumentPagesIndex(documentId);
    const rows = pages.map((p) => {
      chars += p.text.length;
      return {
        id: newId(),
        documentId,
        pageNumber: p.pageNumber,
        text: p.text,
        ocr: p.ocr,
        confidence: p.confidence,
        width: p.width,
        height: p.height,
        charCount: p.text.length,
        boxesJson: p.boxes && p.boxes.length ? JSON.stringify(p.boxes) : null,
      };
    });
    for (let i = 0; i < rows.length; i += 50) tx.insert(schema.documentPages).values(rows.slice(i, i + 50)).run();
    for (const r of rows) indexPage(r.id, documentId, r.pageNumber, r.text);
    const byPage = new Map(rows.map((r) => [r.pageNumber, r.text]));
    const byPageRow = new Map(rows.map((r) => [r.pageNumber, r] as const));
    // A quote verified in reading order (an Epic export) stays verified when the pages are written again.
    reverifyDocumentCitations(documentId, (n) => byPage.get(n), undefined, (n) => {
      const r = byPageRow.get(n);
      return r ? visualPageText(r) : null;
    });
  });
  return chars;
}

function kindDateSource(kind: DocumentKind): 'dicom' | 'text' {
  return kind === 'dicom' ? 'dicom' : 'text';
}

/**
 * Ingest one document by id. Throws on failure after recording the error on
 * the document; a cancelled run leaves the document `pending`.
 */
export async function ingestDocument(documentId: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const d = db();
  const doc: DocumentRow | undefined = d
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
    .get();
  if (!doc) throw new Error(`document ${documentId} not found`);
  setStatus(doc.id, 'extracting');
  opts.onProgress?.(0.01, 'reading file');
  try {
    const buffer = getFile(doc.storageKey);
    const out = await extractByKind(doc.kind as DocumentKind, buffer, { ...opts, documentId: doc.id });
    if (opts.signal?.aborted) {
      const e = new Error('ingestion cancelled');
      e.name = 'AbortError';
      throw e;
    }
    opts.onProgress?.(0.9, 'writing pages');
    let chars = writePages(doc.id, out.pages);
    // Cut into segments: scanned images under a printed header read by OCR (appended), the layout cut, coverage.
    const seg = await segmentQuietly(doc.id, opts, buffer);
    if (seg.ocrPages.length) chars = currentChars(doc.id);
    // The whole file arrived and every page was stored: bytes read back and hashed, the file's own page count, the
    // pages with no text even after OCR.
    writeUploadRecordQuietly(doc, buffer);
    // Likely copies: the new text is compared once, here in the background job (services/duplicates.ts), before the
    // document reads as read, so the flag shows with it. A few milliseconds; never throws, never holds anything back.
    checkCopiesQuietly(doc.id, { recompute: true });
    const ocrPagesTotal = out.ocrPages + seg.ocrPages.length;
    const textStatus: TextStatus = out.ocrApplied || seg.ocrPages.length ? 'ocr_done' : 'extracted';
    const ocrFailedPages = out.pages.filter((p) => p.ocrError).map((p) => p.pageNumber);
    // Extraction can take minutes; classification, inbox filing or a retitle may
    // have written the metadata meanwhile. Merge into the row as it is now (one
    // synchronous transaction), never into the snapshot read before the work.
    db().transaction((tx) => {
      const current = tx.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get() ?? doc;
      const meta: Record<string, unknown> = {
        ...parseJson<Record<string, unknown>>(current.metadataJson, {}),
        ...(out.metadata ?? {}),
        ingest: {
          at: nowIso(),
          chars,
          pages: out.pages.length,
          ocrPages: ocrPagesTotal,
          ...(seg.ocrPages.length ? { ocrAppendedPages: seg.ocrPages.length } : {}),
          ...(ocrFailedPages.length ? { ocrFailedPages: ocrFailedPages.slice(0, 200) } : {}),
          ...(seg.error ? { segmentationError: seg.error } : {}),
          forceOcr: Boolean(opts.forceOcr),
          engine: ocrPagesTotal ? 'mupdf+tesseract' : 'mupdf',
        },
      };
      const patch: Partial<typeof schema.documents.$inferInsert> = {
        pageCount: out.pages.length,
        textStatus,
        textError: null,
        ocrApplied: out.ocrApplied || seg.ocrPages.length > 0,
        updatedAt: nowIso(),
      };
      // A date read from the file itself (DICOM StudyDate) replaces a missing date or a file-name guess, never the model's or the user's.
      if (out.documentDate?.iso && mayReplaceDocumentDate(current)) {
        patch.documentDate = out.documentDate.iso;
        patch.documentDatePrecision = out.documentDate.precision;
        patch.documentDateText = out.documentDate.text;
        meta.dateSource = kindDateSource(current.kind as DocumentKind);
      }
      patch.metadataJson = JSON.stringify(meta);
      tx.update(schema.documents).set(patch).where(eq(schema.documents.id, doc.id)).run();
    });
    // A filed message or report held inside an export (or this export holding filed ones): linked, never set aside.
    await checkSegmentCopiesQuietly(doc.id);
    opts.onProgress?.(1, `${out.pages.length} page${out.pages.length === 1 ? '' : 's'}`);
    return { documentId: doc.id, pageCount: out.pages.length, textStatus, ocrApplied: out.ocrApplied || seg.ocrPages.length > 0, ocrPages: ocrPagesTotal, chars };
  } catch (err) {
    if (isAbortError(err) || opts.signal?.aborted) setStatus(doc.id, 'pending', 'cancelled');
    else setStatus(doc.id, 'failed', (err instanceof Error ? err.message : String(err)).slice(0, 1000));
    throw err;
  }
}

/** Characters of the document's pages as stored now (after OCR text was appended). */
function currentChars(documentId: string): number {
  const P = schema.documentPages;
  const rows = db().select({ n: P.charCount }).from(P).where(eq(P.documentId, documentId)).all();
  return rows.reduce((n, r) => n + (r.n ?? 0), 0);
}

/**
 * Writes `metadata_json.upload`: the bytes read back from the encrypted store and hashed against the upload's sha256,
 * the file's own page count (PDF) against the pages stored, and the pages with no text. Never throws.
 */
function writeUploadRecordQuietly(doc: DocumentRow, buffer: Buffer): UploadRecord | null {
  try {
    let pagesInFile: number | null = null;
    if (doc.kind === 'pdf') {
      try {
        pagesInFile = pdfPageCount(buffer);
      } catch {
        pagesInFile = null;
      }
    } else if (doc.kind === 'image' || doc.kind === 'dicom') pagesInFile = 1;
    const P = schema.documentPages;
    const stored = db().select({ pageNumber: P.pageNumber, charCount: P.charCount }).from(P).where(eq(P.documentId, doc.id)).all();
    let bytesStored: number | null = null;
    let readBackOk: boolean | null = null;
    try {
      const again = readStoredFile(doc.storageKey);
      bytesStored = again.length;
      readBackOk = crypto.createHash('sha256').update(again).digest('hex') === doc.sha256;
    } catch {
      bytesStored = null;
      readBackOk = false;
    }
    const rec = buildUploadRecord({
      at: nowIso(),
      bytesReceived: doc.sizeBytes,
      bytesStored,
      readBackOk,
      sha256: doc.sha256,
      pagesInFile,
      pagesStored: stored.length,
      pagesWithText: stored.filter((r) => (r.charCount ?? 0) > 0).length,
      pagesNoText: stored.filter((r) => !r.charCount).map((r) => r.pageNumber),
    });
    db().transaction((tx) => {
      const current = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
      if (!current) return;
      const meta = parseJson<Record<string, unknown>>(current.metadataJson, {});
      const before = meta.upload && typeof meta.upload === 'object' ? (meta.upload as Record<string, unknown>) : {};
      meta.upload = { ...before, ...rec };
      tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, doc.id)).run();
    });
    return rec;
  } catch (err) {
    console.warn(`[ingest] could not write the upload record of ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Segmentation right after the pages are written (OCR of image pages included). A cancellation is passed on; any
 * other failure is recorded (in words, no record text) and left for the extraction pass to retry.
 */
async function segmentQuietly(documentId: string, opts: IngestOptions, original: Buffer): Promise<{ ocrPages: number[]; error: string | null }> {
  try {
    const { segmentDocument } = await import('../services/segments');
    const r = await segmentDocument(documentId, {
      reason: 'ingest',
      force: true,
      original,
      signal: opts.signal,
      onProgress: (p, t) => opts.onProgress?.(0.9 + 0.08 * p, t),
    });
    return { ocrPages: r.ocrPages, error: null };
  } catch (err) {
    if (isAbortError(err) || opts.signal?.aborted) throw err;
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.warn(`[ingest] could not cut ${documentId} into parts: ${msg}`);
    return { ocrPages: [], error: msg };
  }
}

/** Job handler for `ingest_document` and `reingest_document`. */
export async function ingestDocumentJob(ctx: JobContext<IngestPayload>): Promise<IngestResult> {
  const { documentId, autoExtract, forceOcr, thenTriage } = ctx.payload;
  if (!documentId) throw new Error('ingest job has no documentId');
  const started = nowIso();
  const result = await ingestDocument(documentId, { forceOcr: Boolean(forceOcr), signal: ctx.signal, onProgress: (p, t) => ctx.setProgress(p, t) });
  await settleImportedNoteDate(documentId);
  // The wrong-patient guard (2026-10-09, services/patient-check.ts): nothing is sorted or read before the patient
  // printed on every page is checked; a document that may be someone else's waits for the user, with this plan kept.
  const hasText = result.pageCount > 0 && result.chars > 0;
  if (holdsBeforeReading(documentId, { since: started, resume: { sort: Boolean(thenTriage) || hasText, read: Boolean(autoExtract) && hasText } })) return result;
  continueAfterIngest(documentId, { autoExtract, thenTriage, hasText });
  return result;
}

/**
 * What follows the pages being stored: the sorting (classification) for every upload with text, which queues the
 * reading when it ends, or the reading alone. Also "It's mine" on a document the wrong-patient guard held back.
 */
export function continueAfterIngest(documentId: string, opts: { autoExtract?: boolean; thenTriage?: boolean; hasText?: boolean }): void {
  // The patient's own notes imported on My notes (2026-10-09, services/notes-import.ts) are filed at import and read only when
  // he says so, after one estimate for the whole import: neither sorted nor read here.
  if (importedNote(documentId)) return;
  const { autoExtract, thenTriage } = opts;
  const hasText = opts.hasText ?? hasPageText(documentId);
  let aiUsable = false;
  try {
    aiUsable = aiEnabled() && Boolean(getApiKey());
  } catch {
    aiUsable = false;
  }
  const wantExtract = Boolean(autoExtract) && hasText && aiUsable;
  // Classification (tier, author, title, key points) runs for every upload once pages exist; inbox items are queued even without AI so they land in needs_manual.
  // Extraction waits for it: the tier it sets decides each fact's default voice and the prompt's tier hint, so the
  // classification job carries `autoExtract` and queues extract_facts when it ends (src/server/ingest/triage.ts).
  if (thenTriage || (aiUsable && hasText)) {
    const triage = enqueueJob({ type: 'triage_document', payload: { documentId, ...(wantExtract ? { autoExtract: true } : {}) }, documentId, dedupe: true });
    // A classification already running cannot take the follow-up any more: extract alongside it (the tier is re-read per chunk).
    if (wantExtract && !chainExtraction(triage)) enqueueJob({ type: 'extract_facts', payload: { documentId, deep: false }, documentId, dedupe: true });
  } else if (wantExtract) {
    enqueueJob({ type: 'extract_facts', payload: { documentId, deep: false }, documentId, dedupe: true });
  }
  if (wantExtract) {
    db().update(schema.documents).set({ extractionStatus: 'queued', updatedAt: nowIso() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.extractionStatus, 'none'))).run();
  }
}

/**
 * My notes (review 2026-10-09): an imported PDF or picture of a note had no words to read a date from at import; once
 * its text is stored, its first lines' date heading becomes its date (services/notes-import.ts `settleNoteDates`, once
 * per note, never over a date the user or Claude set). Before, this happened only while the import dialog was open.
 */
async function settleImportedNoteDate(documentId: string): Promise<void> {
  if (!importedNote(documentId)) return;
  try {
    const { settleNoteDates } = await import('../services/notes-import');
    const row = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (row) settleNoteDates([row]);
  } catch (err) {
    console.warn(`[ingest] could not read the date heading of note ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A note the notes import made (`metadata_json.note.batch`). */
function importedNote(documentId: string): boolean {
  const row = db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  const note = parseJson<{ note?: { batch?: unknown } }>(row?.m, {}).note;
  return typeof note?.batch === 'string';
}

/** True when the document has a page with text (the stored pages, not a job's result). */
function hasPageText(documentId: string): boolean {
  const P = schema.documentPages;
  return Boolean(db().select({ n: P.charCount }).from(P).where(and(eq(P.documentId, documentId), sql`${P.charCount} > 0`)).get());
}

/**
 * Make sure a classification job will queue the extraction when it ends: true
 * when its payload already says so or a still-queued job could be widened
 * (dedupe can return a job queued earlier without the flag); false for a job
 * that is already running.
 */
function chainExtraction(job: JobRow): boolean {
  const payload = parseJson<Record<string, unknown>>(job.payloadJson, {});
  if (payload.autoExtract === true) return true;
  if (job.status !== 'queued') return false;
  const r = db()
    .update(schema.jobs)
    .set({ payloadJson: JSON.stringify({ ...payload, autoExtract: true }) })
    .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'queued')))
    .run();
  return r.changes > 0;
}
