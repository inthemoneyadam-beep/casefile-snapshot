/**
 * Several of the user's short notes read in one call (My notes, 2026-10-09; job `read_notes`, reading lane, one at a time).
 *
 * How the citations stay exact per note: the notes go into one user message, each under its own "=== NOTE k of N ==="
 * line (its title and its date), and their pages are numbered ACROSS the call (note 1 is page 1, note 2 page 2, ...),
 * so every page number the model can cite belongs to exactly one note. Each detail is written to the note whose page it
 * cites, with the note's own page number, and verified against that note's stored text like any citation (flagged,
 * never dropped). A quote the model put on the wrong page is moved to the note whose text holds it, when exactly one
 * does. A detail citing two notes is written to each, with that note's citations. The model is told the notes are
 * separate and not to combine them.
 *
 * Everything after is what a reading of one document does: per note an extraction run, its parts marked read (schema
 * and segmenter version, as the engine marks them), coverage, the document's status, afterExtraction (precedence,
 * reconciliation, lab checks, brief, medication filing), the ingestion report, the lab check, then the rules once for
 * all. A note held back as someone else's, deleted, or read meanwhile is left out; one that grew parts already read is
 * handed to the normal reading. A call that fails marks its notes' parts failed (read again later, alone); one cut off
 * for length is split in two calls; AI off or no key puts them back unread. A lock leaves them to the unlock repair and
 * the job runs again.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { JobCancelledError, enqueueJob, enqueueRulesAfterIngest, type JobContext } from '../jobs/queue';
import { AiDisabledError, NoApiKeyError, callStructured, modelFor } from '../ai/client';
import { EXTRACTION_SYSTEM_PROMPT, formatPageBlock } from '../ai/prompts/extraction';
import { afterExtraction, applyExtractionOutput, beginRun, classifyFailure } from '../ai/extraction';
import { ensureSegmented, listSegments, markSegments, pageTextFormsLookup, segmentPageTexts, updateSegment, writeCoverage, type SegmentPageText, type SegmentRow } from './segments';
import { afterPass } from './ingest-hooks';
import { labCheckAndFollowUp } from './lab-check';
import { heldBeforeJob } from './patient-check';
import { requestExtraction } from './documents';
import { getSetting } from './settings';
import { noteMetaOf, packable } from './notes-import';
import { liveDocumentRow } from './document-rows';
import { extractionOutput, type ExtractionOutput } from '../../shared/schemas/facts';
import { extractionStatusFor, parseSegmentDetail, segmentResultVersion, type FactSegmentRef } from '../../shared/schemas/segments';
import { EXTRACTION_SCHEMA_VERSION } from '../../shared/constants';
import { formatPartialDate } from '../../shared/dates';
import { nowIso, parseJson } from '../util/ids';

export interface ReadNotesPayload {
  documentIds?: string[];
  by?: string | null;
}

export interface ReadNotesResult {
  notes: number;
  facts: number;
  citations: number;
  verifiedCitations: number;
  /** Handed to the normal reading (a part already read, or no longer short). */
  readAlone: string[];
  /** Held back as someone else's record, deleted, read meanwhile, or no text. */
  leftOut: string[];
  outcome: 'done' | 'split' | 'failed' | 'nothing';
}

type DocRow = typeof schema.documents.$inferSelect;

/** One note in the call, with its pages numbered for the call. */
export interface NoteInCall {
  /** `metadataJson` says where the note's date came from (a file's own time is never given as the note's date). */
  doc: Pick<DocRow, 'id' | 'title' | 'documentDate' | 'documentDatePrecision' | 'documentDateText' | 'sourceTier'> & { metadataJson?: string | null };
  segments: SegmentRow[];
  pages: Array<{ segmentId: string; page: number; text: string; callPage: number }>;
}

/** Where a page number of the call leads: the note and its own page. */
export type CallPageMap = Map<number, { documentId: string; page: number }>;

/** Numbers the notes' pages across the call (note 1 first). */
export function numberPages(notes: Array<Omit<NoteInCall, 'pages'> & { pages: Array<{ segmentId: string; page: number; text: string }> }>): { notes: NoteInCall[]; map: CallPageMap } {
  let n = 0;
  const map: CallPageMap = new Map();
  const out = notes.map((note) => ({
    ...note,
    pages: note.pages.map((p) => {
      n++;
      map.set(n, { documentId: note.doc.id, page: p.page });
      return { ...p, callPage: n };
    }),
  }));
  return { notes: out, map };
}

/** The user message of a call that reads several notes. */
export function buildNotesMessage(notes: readonly NoteInCall[]): string {
  const total = notes.length;
  const header = [
    `These are ${total} separate notes written by the patient or his chief of staff, read together in one call. Source tier: patient (assume the patient is speaking: asserted_by patient for first-person statements).`,
    'Each note starts with a "=== NOTE k of N ===" line, its title and its date. Its pages carry page numbers that are unique across this call: cite those numbers. The notes are separate documents: never combine facts from two notes into one fact, and cite only the pages of the note a fact comes from. A statement with no date of its own takes no date (the note\'s date is when it was written, not when something happened, unless the note says so).',
    'Leave document_title, document_summary and document_date empty and document_category, institution and author null: each note keeps its own.',
    '',
    'Extract every fact from the notes below.',
    '',
  ].join('\n');
  const blocks = notes.map((n, i) => [`=== NOTE ${i + 1} of ${total} ===`, `Title: ${n.doc.title || '(untitled)'}`, `Date of the note: ${noteDateLine(n.doc)}`, ...n.pages.map((p) => formatPageBlock({ pageNumber: p.callPage, text: p.text }))].join('\n'));
  return header + blocks.join('\n');
}

/**
 * The note's date as the model is told it (review 2026-10-09). A date from the file's own time (saved, copied or
 * exported, not written) is never given: "started it yesterday" would be dated from it. A date from the file name is
 * said to be a guess, as the normal reading says it (prompts/extraction.ts). A date the user set, Claude read or the note
 * itself gives is plain.
 */
export function noteDateLine(doc: NoteInCall['doc']): string {
  if (!doc.documentDate) return 'not dated';
  const shown = doc.documentDateText?.trim() || formatPartialDate(doc.documentDate, doc.documentDatePrecision as 'day');
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const from = noteMetaOf(doc.metadataJson)?.dateFrom ?? null;
  if (meta.dateSource !== 'filename') return shown;
  if (from === 'file') return "not known (only the file's own date is known, which is not when the note was written: date nothing from it)";
  return `${shown} (guessed from the file name; the note's own words decide)`;
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The details of a call, note by note: each citation goes to the note of the page it names, or (its quote is not on
 * that page) to the one note whose text holds the quote; a detail citing two notes is given to each with its own
 * citations. A citation that leads nowhere stays with the first note of the call, where it is flagged as not found.
 */
export function splitByNote(output: Pick<ExtractionOutput, 'facts'>, notes: readonly NoteInCall[], map: CallPageMap): Map<string, ExtractionOutput['facts']> {
  const pageText = new Map<number, string>();
  for (const n of notes) for (const p of n.pages) pageText.set(p.callPage, squash(p.text));
  const firstDoc = notes[0]?.doc.id ?? '';
  const firstPage = notes[0]?.pages[0]?.page ?? 1;
  const out = new Map<string, ExtractionOutput['facts']>();
  for (const f of output.facts ?? []) {
    const byDoc = new Map<string, Array<{ page: number; quote: string }>>();
    for (const c of f.citations ?? []) {
      const q = squash(String(c.quote ?? ''));
      let target = map.get(Number(c.page)) ?? null;
      if (q && (!target || !(pageText.get(Number(c.page)) ?? '').includes(q))) {
        const holders = [...pageText.entries()].filter(([, t]) => t.includes(q)).map(([cp]) => cp);
        if (holders.length === 1) target = map.get(holders[0]) ?? target;
      }
      const t = target ?? { documentId: firstDoc, page: firstPage };
      const list = byDoc.get(t.documentId) ?? [];
      list.push({ page: t.page, quote: String(c.quote ?? '') });
      byDoc.set(t.documentId, list);
    }
    if (!byDoc.size) byDoc.set(firstDoc, []);
    for (const [docId, citations] of byDoc) {
      const list = out.get(docId) ?? [];
      list.push({ ...f, citations: citations.length ? citations : [{ page: firstPage, quote: String(f.statement ?? '').slice(0, 200) }] });
      out.set(docId, list);
    }
  }
  return out;
}

function segmentRef(seg: SegmentRow): FactSegmentRef {
  const detail = parseSegmentDetail(seg.detailJson);
  const tier = seg.sourceTier && ['primary', 'patient', 'compilation', 'external', 'unknown'].includes(seg.sourceTier) ? (seg.sourceTier as FactSegmentRef['tier']) : null;
  return { id: seg.id, seq: seg.seq, kind: seg.kind, ...(tier ? { tier } : {}), ...(detail.encounterKey ? { encounterKey: detail.encounterKey } : {}) };
}

const EMPTY_FIELDS = { document_title: '', document_summary: '', document_date: null, document_category: null, institution: null, author: null } as const;

/** Writes one note's details, its parts read and its run's counters, in one transaction. */
function writeNote(note: NoteInCall, runId: string, facts: ExtractionOutput['facts'], res: { callId: string; model: string }, together: number): { inserted: number; citations: number; verified: number } {
  let result = { inserted: 0, citations: 0, verified: 0 };
  const forms = pageTextFormsLookup(note.doc.id);
  const stored = new Map<number, string>();
  const visual = new Map<number, string>();
  const seen = new Map<number, string>();
  for (const p of note.pages) {
    const f = forms(p.page);
    if (f?.stored != null) stored.set(p.page, f.stored);
    if (f?.visual) visual.set(p.page, f.visual);
    seen.set(p.page, p.text);
  }
  db().transaction(() => {
    const segFor = (page: number) => note.segments.find((s) => page >= s.pageStart && page <= s.pageEnd) ?? note.segments[0];
    const applied = applyExtractionOutput({
      documentId: note.doc.id,
      runId,
      output: { ...EMPTY_FIELDS, facts },
      pages: stored,
      model: res.model,
      sourceTier: note.doc.sourceTier,
      alternatePages: [(n) => visual.get(n), (n) => seen.get(n)],
      segmentFor: (ef) => {
        const cites = (ef as { citations?: Array<{ page: number }> }).citations ?? [];
        const seg = segFor(Number(cites[0]?.page ?? note.pages[0]?.page ?? 1));
        return seg ? { ref: segmentRef(seg), route: 'extract', defaultTier: seg.sourceTier ?? note.doc.sourceTier, passageVoice: null } : null;
      },
    });
    result = { inserted: applied.inserted, citations: applied.citations, verified: applied.verifiedCitations };
    const now = nowIso();
    const version = segmentResultVersion();
    for (const seg of note.segments) {
      const hasPages = note.pages.some((p) => p.segmentId === seg.id);
      if (!hasPages) {
        updateSegment(seg.id, { status: 'no_text', skipReason: 'no_text', extractionRunId: runId, error: null });
        continue;
      }
      const detail = parseSegmentDetail(seg.detailJson);
      updateSegment(seg.id, {
        status: 'done',
        attempts: 0,
        error: null,
        extractionRunId: runId,
        schemaVersion: version,
        factsCount: applied.bySegment.get(seg.id)?.length ?? 0,
        detail: { aiCallIds: [...(detail.aiCallIds ?? []), res.callId].slice(-50), failure: undefined, readAt: now, readHash: seg.textHash ?? null, readTogether: { notes: together, callId: res.callId } } as Record<string, unknown>,
      });
    }
    db()
      .update(schema.extractionRuns)
      .set({ chunks: 1, factsCount: applied.inserted, mergesProposed: applied.mergesProposed, aiCallIdsJson: JSON.stringify([res.callId]) })
      .where(eq(schema.extractionRuns.id, runId))
      .run();
  });
  return result;
}

/** After a note's details are written: coverage, the run's and the document's status, and the steps after a reading. */
async function finishNote(documentId: string, runId: string, jobId: string, factsCreated: number, segmentIds: string[]): Promise<void> {
  const cov = writeCoverage(documentId, { runId });
  const status = extractionStatusFor(cov);
  const now = nowIso();
  db().update(schema.extractionRuns).set({ status: status === 'done' ? 'done' : 'partial', finishedAt: now }).where(eq(schema.extractionRuns.id, runId)).run();
  db()
    .update(schema.documents)
    .set({ extractionStatus: status, ...(status === 'done' ? { extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION } : {}), updatedAt: now })
    .where(eq(schema.documents.id, documentId))
    .run();
  afterExtraction(documentId);
  try {
    await afterPass(documentId, { documentId, runId, outcome: status, segmentIds, factsCreated, coverage: cov });
  } catch (err) {
    console.warn(`[notes] after the reading of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await labCheckAndFollowUp(documentId, { trigger: 'pass', ownJobId: jobId });
  } catch (err) {
    console.warn(`[notes] lab check of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Puts notes back as not read (AI off, no key, a cancel): parts pending, runs ended, status none. */
function putBack(notes: readonly NoteInCall[], runs: Map<string, string>, why: string, runStatus: 'failed' | 'cancelled'): void {
  const now = nowIso();
  for (const n of notes) {
    const ids = n.segments.map((s) => s.id);
    if (ids.length) markSegments(ids, { status: 'pending' });
    const runId = runs.get(n.doc.id);
    if (runId) db().update(schema.extractionRuns).set({ status: runStatus, finishedAt: now, error: why.slice(0, 2000) }).where(eq(schema.extractionRuns.id, runId)).run();
    db().update(schema.documents).set({ extractionStatus: 'none', updatedAt: now }).where(eq(schema.documents.id, n.doc.id)).run();
  }
}

/** The job: read the notes of the payload together (those still to read), write each note's details. */
export async function readNotesJob(ctx: JobContext<ReadNotesPayload>): Promise<ReadNotesResult> {
  const ids = [...new Set((ctx.payload.documentIds ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const result: ReadNotesResult = { notes: 0, facts: 0, citations: 0, verifiedCitations: 0, readAlone: [], leftOut: [], outcome: 'nothing' };
  const prepared: Array<Omit<NoteInCall, 'pages'> & { pages: Array<{ segmentId: string; page: number; text: string }> }> = [];
  for (const id of ids) {
    if (ctx.signal.aborted) throw new Error('cancelled');
    const row = liveDocumentRow(id);
    if (!row || heldBeforeJob(id, 'read_notes')) {
      result.leftOut.push(id);
      continue;
    }
    if (!packable(row, { inFlight: true })) {
      // Read meanwhile, or no longer a short note never read: the normal reading takes it, if anything is left to read.
      if (['queued', 'running', 'failed', 'none'].includes(row.extractionStatus) && ['extracted', 'ocr_done'].includes(row.textStatus) && row.sourceTier === 'patient') {
        try {
          requestExtraction(id);
          result.readAlone.push(id);
          continue;
        } catch {
          // no text: left out below
        }
      }
      if (row.extractionStatus === 'queued') db().update(schema.documents).set({ extractionStatus: 'none', updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
      result.leftOut.push(id);
      continue;
    }
    try {
      await ensureSegmented(id, { reason: 'ingest', signal: ctx.signal });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
    const segments = listSegments(id);
    if (!segments.length) {
      try {
        requestExtraction(id);
        result.readAlone.push(id);
      } catch {
        result.leftOut.push(id);
      }
      continue;
    }
    const pages: Array<{ segmentId: string; page: number; text: string }> = [];
    for (const s of segments) for (const p of segmentPageTexts(id, s) as SegmentPageText[]) pages.push({ segmentId: s.id, page: p.pageNumber, text: p.text });
    if (!pages.length) {
      db().update(schema.documents).set({ extractionStatus: 'none', updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
      result.leftOut.push(id);
      continue;
    }
    prepared.push({ doc: row, segments, pages });
  }
  if (!prepared.length) return result;
  const { notes, map } = numberPages(prepared);
  const model = modelFor(false);
  const runs = new Map<string, string>();
  for (const n of notes) {
    runs.set(n.doc.id, beginRun(n.doc.id, { model, deep: false }));
    markSegments(
      n.segments.map((s) => s.id),
      { status: 'running', extractionRunId: runs.get(n.doc.id)! },
    );
  }
  ctx.setProgress(0.05, `reading ${notes.length} of your notes together`);
  const owned = () => !ctx.stillOwned || ctx.stillOwned();
  let res: { data: ExtractionOutput; callId: string; model: string };
  try {
    res = await callStructured<ExtractionOutput>({
      purpose: 'extract_facts',
      model,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildNotesMessage(notes) }],
      schema: extractionOutput,
      maxTokens: 64_000,
      timeoutMs: 30 * 60 * 1000,
      effort: getSetting('ai.extraction.effort'),
      documentIds: notes.map((n) => n.doc.id),
      jobId: ctx.job.id,
      signal: ctx.signal,
      requestSummary: `read ${notes.length} notes together`,
    });
  } catch (err) {
    // A lock or a restart took the job: write nothing; the unlock repair puts the parts back and the job runs again.
    if (!owned()) throw err;
    if (ctx.signal.aborted) {
      putBack(notes, runs, 'stopped before it finished', 'cancelled');
      throw err;
    }
    if (err instanceof AiDisabledError || err instanceof NoApiKeyError) {
      putBack(notes, runs, err.message, 'failed');
      throw err;
    }
    // Too long an answer: read the notes in two calls.
    if (err instanceof Error && /max_tokens/i.test(err.message) && notes.length > 1) {
      putBack(notes, runs, 'the answer was too long for one call; read again in two', 'cancelled');
      const mid = Math.ceil(notes.length / 2);
      for (const half of [notes.slice(0, mid), notes.slice(mid)]) {
        const halfIds = half.map((n) => n.doc.id);
        enqueueJob({ type: 'read_notes', payload: { documentIds: halfIds, by: ctx.payload.by ?? null }, documentId: halfIds[0] });
        db().update(schema.documents).set({ extractionStatus: 'queued', updatedAt: nowIso() }).where(inArray(schema.documents.id, halfIds)).run();
      }
      result.outcome = 'split';
      return result;
    }
    const f = classifyFailure(err);
    const now = nowIso();
    for (const n of notes) {
      for (const s of n.segments) {
        updateSegment(s.id, { status: 'failed', error: `Could not be read: ${f.message}`.slice(0, 1000), attempts: (s.attempts ?? 0) + 1, extractionRunId: runs.get(n.doc.id)!, detail: { failure: { kind: f.kind, message: f.message.slice(0, 500), at: now } } as Record<string, unknown> });
      }
      db().update(schema.extractionRuns).set({ status: 'failed', finishedAt: now, error: f.message.slice(0, 2000) }).where(eq(schema.extractionRuns.id, runs.get(n.doc.id)!)).run();
      writeCoverage(n.doc.id, { runId: runs.get(n.doc.id)! });
      db().update(schema.documents).set({ extractionStatus: 'failed', updatedAt: now }).where(eq(schema.documents.id, n.doc.id)).run();
    }
    result.outcome = 'failed';
    throw err;
  }
  if (ctx.signal.aborted) {
    if (!owned()) throw new Error('cancelled');
    putBack(notes, runs, 'stopped before it finished', 'cancelled');
    throw new Error('cancelled');
  }
  const perNote = splitByNote(res.data, notes, map);
  const written: string[] = [];
  for (const n of notes) {
    // A note deleted (or held back) while the call ran: nothing is written for it.
    if (!liveDocumentRow(n.doc.id)) {
      db().update(schema.extractionRuns).set({ status: 'cancelled', finishedAt: nowIso(), error: 'cancelled: the document was deleted during extraction' }).where(eq(schema.extractionRuns.id, runs.get(n.doc.id)!)).run();
      result.leftOut.push(n.doc.id);
      continue;
    }
    const w = writeNote(n, runs.get(n.doc.id)!, perNote.get(n.doc.id) ?? [], res, notes.length);
    result.notes++;
    result.facts += w.inserted;
    result.citations += w.citations;
    result.verifiedCitations += w.verified;
    written.push(n.doc.id);
    await finishNote(n.doc.id, runs.get(n.doc.id)!, ctx.job.id, w.inserted, n.segments.map((s) => s.id));
  }
  if (written.length) {
    try {
      enqueueRulesAfterIngest(written, 'ingestion');
    } catch {
      // the next reading or unlock runs them
    }
  }
  if (!written.length && notes.length) throw new JobCancelledError('the notes were deleted while they were read');
  result.outcome = 'done';
  ctx.setProgress(1, `${result.notes} notes read: ${result.facts} details, ${result.verifiedCitations}/${result.citations} citations verified`);
  return result;
}
