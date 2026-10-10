/**
 * Mass import of the patient's own notes (My notes, 2026-10-09) and the reading of them.
 *
 * Import (no AI): the files (dropped or chosen, a zip, or on this computer only a folder) are read into notes by
 * services/notes-formats.ts; each note becomes a document filed in the patient tier ("Your own notes") at once, never
 * by an AI guess, with author role patient and its own date (see notes-formats: its heading, the export's date, the file
 * name, else the file's time marked "date from the file"). The stored file goes through the normal upload path
 * (encrypted in the file store, pages, parts, the likely-copy check, the wrong-patient guard). Exact duplicates are found
 * by the existing byte check and skipped; a note whose copy is in the trash is skipped with a pointer to Restore (an
 * import never brings back what the user deleted). Imported notes are not sorted by Claude (services ingest pipeline:
 * `continueAfterIngest` leaves a note alone) and not read until the user says so.
 *
 * Reading: one estimate for the whole import before any reading. Short notes never read before are read SEVERAL TO A
 * CALL (services/notes-reading.ts): at most PACK_MAX_NOTES notes and PACK_MAX_CHARS characters a call, each note's pages
 * numbered apart in the call so every page number belongs to exactly one note, and each detail is written to the note
 * whose page it cites (citations stay per document, verified on that note's page). Longer notes, notes read before and
 * notes with parts already read are read on their own by the normal reading (one extract_facts job each).
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import fsp from 'node:fs/promises';
import { db, LockedError, schema } from '../db';
import { createDocuments, requestExtraction, type UploadFile } from './documents';
import { collect, resolveImportFolder } from './folder-import';
import { NOTES_MAX_PER_IMPORT, readNoteFiles, type NoteDraft, type NoteSkip, type NoteSourceFile } from './notes-formats';
import { listSegments } from './segments';
import { estimateSegments, priceEstimate } from '../ai/extraction';
import { modelFor } from '../ai/client';
import { enqueueJob } from '../jobs/queue';
import { writeAudit } from './audit';
import { conflict } from '../util/errors';
import { newId, nowIso, parseJson, sha256 } from '../util/ids';
import { parsePartialDate } from '../../shared/dates';
import { noteDateText, type NoteImportMeta, type NoteImportResult, type NoteImportStatus, type NotesReadingEstimate } from '../../shared/notes';
import { QUARANTINED_SQL } from './patient-check-state';

/** Short notes are read this many to a call at most. */
export const PACK_MAX_NOTES = 12;
/** And about this many characters a call (notes and their headers). */
export const PACK_MAX_CHARS = 24_000;
/** A note longer than this (or with more pages) is read on its own, as any document. */
export const SHORT_NOTE_MAX_CHARS = 8_000;
export const SHORT_NOTE_MAX_PAGES = 4;
/** The characters each note's header adds to a packed call (its number, title and date). */
export const NOTE_HEADER_CHARS = 160;
/** The most files a folder import reads. */
export const NOTES_FOLDER_MAX_FILES = 10_000;

const READY_TEXT = ['extracted', 'ocr_done'];
const PENDING_TEXT = ['pending', 'extracting', 'ocr_needed', 'ocr_running'];

type DocRow = typeof schema.documents.$inferSelect;

/** The import record of a note, or null for a document that was not imported as one. */
export function noteMetaOf(metadataJson: string | null | undefined): NoteImportMeta | null {
  const meta = parseJson<Record<string, unknown>>(metadataJson, {});
  const n = meta.note;
  if (!n || typeof n !== 'object') return null;
  const o = n as Partial<NoteImportMeta>;
  return typeof o.batch === 'string' ? (o as NoteImportMeta) : null;
}

/** True for a document the notes import made (the ingest pipeline does not sort or read these by itself). */
export function isImportedNote(documentId: string): boolean {
  const row = db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  return Boolean(row && noteMetaOf(row.m));
}

function trashedBySha(sha: string): { id: string; title: string } | null {
  return (
    db()
      .select({ id: schema.documents.id, title: schema.documents.title })
      .from(schema.documents)
      .where(and(eq(schema.documents.sha256, sha), isNotNull(schema.documents.deletedAt), sql`not ${QUARANTINED_SQL}`))
      .get() ?? null
  );
}

function liveBySha(sha: string): { id: string; title: string } | null {
  return db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(and(eq(schema.documents.sha256, sha), isNull(schema.documents.deletedAt))).get() ?? null;
}

/** Store one note: the upload path, then its tier, author, date and import record (same tick as the insert). */
function storeNote(draft: NoteDraft, batch: string, by: string | null): { id: string; title: string; duplicate: boolean } {
  const upload: UploadFile = { name: draft.file.name, mime: draft.file.mime, buffer: draft.file.buffer };
  const [doc] = createDocuments([upload], { category: 'other', title: draft.title, autoExtract: false });
  if (doc.duplicate) return { id: doc.id, title: doc.title, duplicate: true };
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const note: NoteImportMeta = {
    v: 1,
    batch,
    format: draft.format,
    from: draft.from,
    container: draft.container,
    index: draft.index,
    sourceSha256: draft.sourceSha256,
    dateFrom: draft.date.from,
    dateText: draft.date.text,
    at: nowIso(),
    by,
    ...(draft.attachmentsLeftOut ? { attachmentsLeftOut: draft.attachmentsLeftOut } : {}),
  };
  meta.note = note;
  // A date the note itself gives (its heading, the export's record) is the document's date and is never replaced by a
  // guess; a date from the file name or the file's time may give way to one read from the note later.
  if (draft.date.from === 'content' || draft.date.from === 'export') meta.dateSource = 'text';
  else if (draft.date.from === 'filename' || draft.date.from === 'file') meta.dateSource = 'filename';
  else delete meta.dateSource;
  db()
    .update(schema.documents)
    .set({
      sourceTier: 'patient',
      authorRole: 'patient',
      documentDate: draft.date.iso,
      documentDatePrecision: draft.date.iso ? draft.date.precision : 'unknown',
      documentDateText: draft.date.text,
      metadataJson: JSON.stringify(meta),
      updatedAt: nowIso(),
    })
    .where(eq(schema.documents.id, doc.id))
    .run();
  return { id: doc.id, title: doc.title, duplicate: false };
}

/** The files of a folder on this computer (read only), for an import. Refused when hosted, by the route. */
export async function readNotesFolder(folderPath: string, recursive: boolean): Promise<{ files: NoteSourceFile[]; skipped: NoteSkip[]; truncated: boolean }> {
  const folder = resolveImportFolder(folderPath);
  const skipped: NoteSkip[] = [];
  const walk = await collect(folder, recursive, (s) => skipped.push(s));
  const files: NoteSourceFile[] = [];
  let truncated = walk.truncated;
  for (const f of walk.files) {
    if (files.length >= NOTES_FOLDER_MAX_FILES) {
      truncated = true;
      break;
    }
    try {
      const st = await fsp.stat(f.full);
      if (!st.isFile()) continue;
      if (st.size > 512 * 1024 * 1024) {
        skipped.push({ file: f.rel, reason: 'larger than 512 MB' });
        continue;
      }
      files.push({ name: f.rel, buffer: await fsp.readFile(f.full), lastModified: st.mtimeMs });
    } catch (err) {
      skipped.push({ file: f.rel, reason: `could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
    }
  }
  return { files, skipped, truncated };
}

/**
 * Import notes: read every file into notes, store each new one as a document of the patient's own notes. Nothing is read by
 * Claude here. The result lists what was added, what was already in, and every file that held no note, with why.
 */
export async function importNotes(files: readonly NoteSourceFile[], opts: { by: string | null; byId?: string | null; skipped?: NoteSkip[] } = { by: null }): Promise<NoteImportResult> {
  if (!files.length && !opts.skipped?.length) throw conflict('no files were given');
  const read = await readNoteFiles(files);
  const skipped: NoteSkip[] = [...(opts.skipped ?? []), ...read.skipped];
  const batch = newId();
  const items: NoteImportResult['items'] = [];
  let added = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (const draft of read.drafts) {
    if (added >= NOTES_MAX_PER_IMPORT) {
      skipped.push({ file: draft.from, reason: `more than ${NOTES_MAX_PER_IMPORT} notes in one import; import again for the rest (what is in already is skipped)` });
      continue;
    }
    try {
      const sha = sha256(draft.file.buffer);
      if (seen.has(sha)) {
        duplicates++;
        continue;
      }
      seen.add(sha);
      const live = liveBySha(sha);
      if (live) {
        duplicates++;
        items.push({ documentId: live.id, title: live.title, duplicate: true, from: draft.from, dateFrom: draft.date.from, date: draft.date.iso });
        continue;
      }
      const trashed = trashedBySha(sha);
      if (trashed) {
        skipped.push({ file: draft.from, reason: `in the trash as "${trashed.title}"; restore it from Documents, Deleted documents` });
        continue;
      }
      const stored = storeNote(draft, batch, opts.by);
      if (stored.duplicate) duplicates++;
      else added++;
      items.push({ documentId: stored.id, title: stored.title, duplicate: stored.duplicate, from: draft.from, dateFrom: draft.date.from, date: draft.date.iso });
    } catch (err) {
      if (err instanceof LockedError) throw err;
      skipped.push({ file: draft.from, reason: `could not be stored: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}` });
    }
  }
  writeAudit({ userName: opts.by, userId: opts.byId ?? null, action: 'create', entityType: 'notes_import', entityId: batch, summary: `Imported ${added} note${added === 1 ? '' : 's'}; ${duplicates} already in; ${skipped.length} skipped` });
  return { batch, added, duplicates, skipped: skipped.slice(0, 1000), skippedTotal: skipped.length, items };
}

// ---------------------------------------------------------------------------
// Status, dates read after the text is stored, and the estimate
// ---------------------------------------------------------------------------

function batchRows(batch: string): DocRow[] {
  return db()
    .select()
    .from(schema.documents)
    .where(and(sql`instr(${schema.documents.metadataJson}, '"note"') > 0 and json_valid(${schema.documents.metadataJson}) and json_extract(${schema.documents.metadataJson}, '$.note.batch') = ${batch}`, sql`(${schema.documents.deletedAt} is null or ${QUARANTINED_SQL})`))
    .all();
}

/**
 * A PDF or a picture has no words until its pages are stored: once they are, its first lines are read for a date
 * heading, which replaces a date from the export, the file name or the file's time (never one the user or Claude set).
 * Once per note.
 */
export function settleNoteDates(rows: readonly DocRow[]): number {
  let changed = 0;
  for (const r of rows) {
    if (r.deletedAt || !READY_TEXT.includes(r.textStatus)) continue;
    const meta = parseJson<Record<string, unknown>>(r.metadataJson, {});
    const note = noteMetaOf(r.metadataJson);
    if (!note || (meta.note as Record<string, unknown>).contentChecked) continue;
    const mark = (patch: Partial<typeof schema.documents.$inferInsert>) => {
      (meta.note as Record<string, unknown>).contentChecked = true;
      db().update(schema.documents).set({ ...patch, metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, r.id)).run();
    };
    if (note.dateFrom === 'content' || meta.dateSource === 'user' || meta.dateSource === 'ai') {
      mark({});
      continue;
    }
    const first = db().select({ text: schema.documentPages.text }).from(schema.documentPages).where(eq(schema.documentPages.documentId, r.id)).orderBy(schema.documentPages.pageNumber).limit(1).get();
    const t = first ? noteDateText(first.text) : null;
    const pd = t ? parsePartialDate(t) : null;
    if (pd?.iso) {
      (meta.note as Record<string, unknown>).dateFrom = 'content';
      (meta.note as Record<string, unknown>).dateText = t;
      meta.dateSource = 'text';
      mark({ documentDate: pd.iso, documentDatePrecision: pd.precision, documentDateText: t, updatedAt: nowIso() });
      changed++;
    } else mark({});
  }
  return changed;
}

export function importStatus(batch: string): NoteImportStatus {
  let rows = batchRows(batch);
  if (settleNoteDates(rows) + healQueuedNotes(rows.map((r) => r.id))) rows = batchRows(batch);
  const live = rows.filter((r) => !r.deletedAt);
  const pending = live.filter((r) => PENDING_TEXT.includes(r.textStatus)).length;
  const ready = live.filter((r) => READY_TEXT.includes(r.textStatus)).length;
  const read = live.filter((r) => r.extractionStatus === 'done' || r.extractionStatus === 'partial').length;
  const reading = live.filter((r) => r.extractionStatus === 'queued' || r.extractionStatus === 'running').length;
  const failed = live.filter((r) => r.extractionStatus === 'failed' || r.textStatus === 'failed').length;
  const likelyCopies = live.filter((r) => {
    const m = parseJson<Record<string, unknown>>(r.metadataJson, {});
    return Boolean(m.possibleCopyOf);
  }).length;
  const estimate = pending === 0 ? planNotesReading(live.map((r) => r.id)).estimate : null;
  return { batch, notes: live.length, pending, ready, read, reading, failed, held: rows.length - live.length, likelyCopies, estimate: estimate && estimate.calls > 0 ? estimate : null };
}

interface PackNote {
  id: string;
  chars: number;
  date: string | null;
  title: string;
}

/** The characters of a document's pages that hold text, and how many such pages. */
function textSize(documentId: string): { chars: number; pages: number } {
  const r = db().get<{ chars: number; pages: number }>(sql`select coalesce(sum(length(text)), 0) as chars, count(*) as pages from document_pages where document_id = ${documentId} and length(trim(text)) > 0`);
  return { chars: Number(r?.chars ?? 0), pages: Number(r?.pages ?? 0) };
}

/**
 * A note that may be read together with others: of the patient's own notes, its text stored, never read (no part read, no
 * detail Claude read from it), no part read by a parser, and short. `inFlight` lets the job itself take notes it has
 * already marked queued or running.
 */
export function packable(r: DocRow, opts: { inFlight?: boolean } = {}): boolean {
  if (r.deletedAt || r.sourceTier !== 'patient' || !READY_TEXT.includes(r.textStatus)) return false;
  const statuses = opts.inFlight ? ['none', 'queued', 'running', 'failed'] : ['none'];
  if (!statuses.includes(r.extractionStatus)) return false;
  const segs = listSegments(r.id);
  if (segs.some((s) => s.status === 'done' || s.status === 'parsed')) return false;
  if (segs.some((s) => /"route"\s*:\s*"(parse|parse_and_extract)"/.test(s.detailJson))) return false;
  const facts = db().get<{ n: number }>(sql`select count(*) as n from facts where source_document_id = ${r.id} and deleted_at is null and origin = 'ai'`);
  if (Number(facts?.n ?? 0) > 0) return false;
  const size = textSize(r.id);
  return size.pages > 0 && size.pages <= SHORT_NOTE_MAX_PAGES && size.chars <= SHORT_NOTE_MAX_CHARS;
}

/** Notes cut into calls: in date order, at most PACK_MAX_NOTES notes and PACK_MAX_CHARS characters a call. */
export function packNotes(notes: readonly PackNote[]): string[][] {
  const sorted = [...notes].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.title.localeCompare(b.title));
  const packs: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const n of sorted) {
    const size = n.chars + NOTE_HEADER_CHARS;
    if (cur.length && (cur.length >= PACK_MAX_NOTES || chars + size > PACK_MAX_CHARS)) {
      packs.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(n.id);
    chars += size;
  }
  if (cur.length) packs.push(cur);
  return packs;
}

export interface NotesReadingPlan {
  packs: string[][];
  alone: string[];
  /** Notes left out, with why (already read, being read, no text, not the patient's own notes). */
  left: Array<{ documentId: string; reason: string }>;
  estimate: NotesReadingEstimate;
}

/** What reading these notes would take: which are read together, which alone, and what it costs. No AI. */
export function planNotesReading(documentIds: readonly string[]): NotesReadingPlan {
  const ids = [...new Set(documentIds)];
  healQueuedNotes(ids);
  const rows = ids.length ? db().select().from(schema.documents).where(inArray(schema.documents.id, ids)).all() : [];
  const short: PackNote[] = [];
  const alone: string[] = [];
  const left: NotesReadingPlan['left'] = [];
  for (const r of rows) {
    if (r.deletedAt) {
      left.push({ documentId: r.id, reason: 'held back or deleted' });
      continue;
    }
    if (r.sourceTier !== 'patient') {
      left.push({ documentId: r.id, reason: 'not one of your own notes' });
      continue;
    }
    if (!READY_TEXT.includes(r.textStatus)) {
      left.push({ documentId: r.id, reason: PENDING_TEXT.includes(r.textStatus) ? 'its text is not ready yet' : 'it has no text' });
      continue;
    }
    if (r.extractionStatus === 'queued' || r.extractionStatus === 'running') {
      left.push({ documentId: r.id, reason: 'being read' });
      continue;
    }
    if (r.extractionStatus === 'done') {
      left.push({ documentId: r.id, reason: 'read already' });
      continue;
    }
    if (textSize(r.id).pages === 0) {
      left.push({ documentId: r.id, reason: 'it has no text' });
      continue;
    }
    if (packable(r)) short.push({ id: r.id, chars: textSize(r.id).chars, date: r.documentDate, title: r.title });
    else alone.push(r.id);
  }
  const packs = packNotes(short);
  const model = modelFor(false);
  let usd = 0;
  for (const p of packs) {
    const chars = p.reduce((n, id) => n + (short.find((s) => s.id === id)?.chars ?? 0) + NOTE_HEADER_CHARS, 0);
    usd += priceEstimate(chars, 1, model).approxUsd;
  }
  let aloneCalls = 0;
  for (const id of alone) {
    try {
      const e = estimateSegments(id, 'missing');
      aloneCalls += e.calls;
      usd += e.approxUsd;
    } catch {
      aloneCalls += 1;
    }
  }
  const approxUsd = Math.round(usd * 100) / 100;
  const calls = packs.length + aloneCalls;
  const packedNotes = short.length;
  const most = packs.reduce((m, p) => Math.max(m, p.length), 0);
  const bits: string[] = [];
  if (packedNotes) bits.push(`${packedNotes} short note${packedNotes === 1 ? '' : 's'} read ${most > 1 ? `up to ${most} at a time` : 'one at a time'} in ${packs.length} call${packs.length === 1 ? '' : 's'}`);
  if (alone.length) bits.push(`${alone.length} longer note${alone.length === 1 ? '' : 's'} read on ${alone.length === 1 ? 'its' : 'their'} own (${aloneCalls} call${aloneCalls === 1 ? '' : 's'})`);
  const words = calls ? `${bits.join(', and ')}: about $${approxUsd.toFixed(2)}.` : 'Nothing to read: every note is read already, being read, or has no text.';
  return { packs, alone, left, estimate: { packedNotes, packedCalls: packs.length, aloneNotes: alone.length, aloneCalls, calls, approxUsd, model, words } };
}

/** The patient's own notes Claude has not read yet (with their text stored). */
export function unreadNoteIds(): string[] {
  return db()
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(and(isNull(schema.documents.deletedAt), eq(schema.documents.sourceTier, 'patient'), inArray(schema.documents.textStatus, READY_TEXT), inArray(schema.documents.extractionStatus, ['none', 'failed', 'partial'])))
    .all()
    .map((r) => r.id);
}

/** Every note of an import. */
export function batchNoteIds(batch: string): string[] {
  return batchRows(batch)
    .filter((r) => !r.deletedAt)
    .map((r) => r.id);
}

/**
 * Read the notes (after the user saw the estimate): one read_notes job per call of short notes (they wait in the reading
 * lane, one call at a time), and the normal reading for each longer one. Returns what was started.
 */
export function startNotesReading(documentIds: readonly string[], by: string | null): { packs: number; alone: number; jobs: number; estimate: NotesReadingEstimate } {
  const plan = planNotesReading(documentIds);
  let jobs = 0;
  for (const pack of plan.packs) {
    enqueueJob({ type: 'read_notes', payload: { documentIds: pack, by }, documentId: pack[0] });
    db().update(schema.documents).set({ extractionStatus: 'queued', updatedAt: nowIso() }).where(and(inArray(schema.documents.id, pack), eq(schema.documents.extractionStatus, 'none'))).run();
    jobs++;
  }
  for (const id of plan.alone) {
    try {
      requestExtraction(id);
      jobs++;
    } catch {
      // its text went away meanwhile: it is listed again next time
    }
  }
  if (jobs) writeAudit({ userName: by, action: 'ai', entityType: 'notes_reading', entityId: null, summary: `Asked Claude to read ${plan.estimate.packedNotes + plan.estimate.aloneNotes} notes (about $${plan.estimate.approxUsd.toFixed(2)})` });
  return { packs: plan.packs.length, alone: plan.alone.length, jobs, estimate: plan.estimate };
}

/**
 * Notes left "queued" or "running" by a read_notes job that is gone (cancelled while it waited, or lost): put back as
 * not read, so they can be read again. A note waiting for a live job is left alone.
 */
export function healQueuedNotes(ids: readonly string[]): number {
  if (!ids.length) return 0;
  const rows = db()
    .select({ id: schema.documents.id, status: schema.documents.extractionStatus })
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, [...ids]), inArray(schema.documents.extractionStatus, ['queued', 'running'])))
    .all();
  if (!rows.length) return 0;
  const waiting = new Set<string>();
  for (const j of db().select({ payloadJson: schema.jobs.payloadJson, type: schema.jobs.type, documentId: schema.jobs.documentId }).from(schema.jobs).where(and(inArray(schema.jobs.type, ['read_notes', 'extract_facts', 'resume_extraction']), inArray(schema.jobs.status, ['queued', 'running']))).all()) {
    if (j.type === 'read_notes') for (const id of parseJson<{ documentIds?: unknown }>(j.payloadJson, {}).documentIds as string[] | undefined ?? []) waiting.add(id);
    else if (j.documentId) waiting.add(j.documentId);
  }
  let n = 0;
  for (const r of rows) {
    if (waiting.has(r.id)) continue;
    const facts = db().get<{ n: number }>(sql`select count(*) as n from facts where source_document_id = ${r.id} and deleted_at is null`);
    db().update(schema.documents).set({ extractionStatus: Number(facts?.n ?? 0) > 0 ? 'partial' : 'none', updatedAt: nowIso() }).where(eq(schema.documents.id, r.id)).run();
    n++;
  }
  return n;
}
