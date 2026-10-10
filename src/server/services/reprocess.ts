/**
 * Reading documents again, on request or by itself (2026-10-07, large exports; findings D.1.9, D.3 WP-B, D.5).
 *
 * - `requestReprocess`: the user, the chief of staff or the clinician asks for one or many documents to be read (again): what is
 *   missing, only what failed, everything, or some pages. Each document gets a `filings` row (target `extraction`,
 *   action `reprocess`, one `detail.batchId` for the batch) and, when it goes ahead, an extraction job in the
 *   one-at-a-time lane. A user's request runs without asking up to `ai.autoResumeCeilingUsd`; above it, unless the user
 *   already said yes to the estimate, it waits (askFirst). A request the clinician makes unasked always waits.
 * - `maybeAutoResume`: after an unlock (or an upload), a document whose reading stopped part-way carries on by itself
 *   when the estimate for what is left is at most the ceiling (2026-10-07); above it the app asks once
 *   (`coverage.resume.decision = 'ask'`); "not now" (declined) is respected until someone asks again.
 * - `ingestAfterUnlock`: steps 4-7 of the after-unlock sequence (the evidence and the repair, steps 2-3, run inside the
 *   unlock itself, before the job worker starts: see auth.ts).
 * Never logs record text.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { enqueueJob, type JobContext, type JobRow } from '../jobs/queue';
import { aiEnabled, getApiKey } from '../ai/client';
import {
  adoptLegacySegments, approvalCovers, estimateSegments, hasUnreadModelSegments, labCheckQuestionPending, readResumeDecision, settledExtractionStatus, writeResumeDecision, type ExtractionScope,
} from '../ai/extraction';
import { answerLabRereadQuestion, labCheckAndFollowUp, labLinesOnPages, readLabCheck } from './lab-check';
import { getSetting } from './settings';
import { coverageSummary, listSegments, readCoverage, segmentDocumentJob, writeCoverage, type SegmentDocumentPayload, type SegmentationResult } from './segments';
import { afterUnlock } from './ingest-hooks';
import { backfillLegacyCoverage, captureEvidence, computeLegacyCoverageFor, storedEvidence, writeLegacyCoverage } from './extraction-evidence';
import { newId, nowIso, parseJson } from '../util/ids';
import { badRequest, notFound, zodIssues } from '../util/errors';
import {
  parseExportInfo, reprocessRequest, type DocumentCoverage, type ExtractionEvidence, type ReprocessRequestInput, type ReprocessResult, type ResumeDecision, type SegmentEstimate,
} from '../../shared/schemas/segments';

export { captureEvidence, storedEvidence, writeLegacyCoverage };

/** The filings target of a reading request (not a document filing: the Filing page and its counts never see it). */
export const REPROCESS_TARGET = 'extraction';
export const REPROCESS_ACTION = 'reprocess';

type Doc = typeof schema.documents.$inferSelect;

function liveDoc(documentId: string): Doc | null {
  return db().select().from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get() ?? null;
}

function hasPageText(documentId: string): boolean {
  return (db().get<{ n: number }>(sql`select count(*) as n from document_pages where document_id = ${documentId} and length(trim(text)) > 0`)?.n ?? 0) > 0;
}

const TEXT_IN_PROGRESS = ['pending', 'extracting', 'ocr_running'];

/** The ceiling in dollars (0 = always ask). */
export function autoResumeCeiling(): number {
  const n = Number(getSetting('ai.autoResumeCeilingUsd'));
  return Number.isFinite(n) && n >= 0 ? n : 15;
}

function underCeiling(usd: number): boolean {
  const c = autoResumeCeiling();
  return c > 0 && usd <= c;
}

/**
 * The estimate for reading `scope` of a document now, from its actual segments (the estimateExtraction formula):
 * characters / 4 plus 1,500 tokens a call, output a quarter of the input, priced at the model's rate.
 */
export function estimateRemaining(documentId: string, scope: 'missing' | 'failed' | 'whole' = 'missing', deep = false): SegmentEstimate {
  if (!liveDoc(documentId)) throw notFound('document not found');
  return estimateSegments(documentId, scope, deep);
}

/** Pages and parts left to read (missing scope), for the resume decision. */
function leftToRead(documentId: string, deep: boolean): SegmentEstimate {
  return estimateSegments(documentId, 'missing', deep, { automatic: true });
}

function writeResume(documentId: string, d: ResumeDecision): ResumeDecision {
  return writeResumeDecision(documentId, d);
}

/** The extraction jobs of a document still queued or running. */
function activeJobs(documentId: string): JobRow[] {
  return db()
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, documentId), inArray(schema.jobs.type, ['extract_facts', 'resume_extraction']), inArray(schema.jobs.status, ['queued', 'running'])))
    .all();
}

/** The lab check's own re-read of a few pages (payload reason `labcheck`): it never stands for another reading. */
function isLabCheckJob(j: JobRow): boolean {
  return parseJson<Record<string, unknown>>(j.payloadJson, {}).reason === 'labcheck';
}

/**
 * An extraction job of the document queued or running, other than the lab check's own re-read (2026-10-09 review: a
 * reading asked for while that re-read waited was folded into it and never read).
 */
function activeJob(documentId: string): JobRow | null {
  return activeJobs(documentId).find((j) => !isLabCheckJob(j)) ?? null;
}

/** Page ranges as a set of pages (for "does this reading cover those pages"). */
function pageSet(ranges: ReadonlyArray<readonly [number, number]> | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const [a, b] of ranges ?? []) for (let p = a; p <= b && out.size < 100_000; p++) out.add(p);
  return out;
}

/** What a reading request reads: its scope and, for scope pages, its pages. */
interface ReadingAsk {
  scope: string;
  pages?: ReadonlyArray<readonly [number, number]> | null;
}

/**
 * True when reading `by` reads everything `ask` asks for (2026-10-09 review): every page again covers anything; "the
 * rest" covers the rest and the parts that failed; given pages cover only requests for pages among them.
 */
export function readingCovers(by: ReadingAsk, ask: ReadingAsk): boolean {
  if (by.scope === 'whole') return true;
  const a = ask.scope === 'failed' || ask.scope === 'whole' || ask.scope === 'pages' ? ask.scope : 'missing';
  if (by.scope === 'missing') return a === 'missing' || a === 'failed';
  if (by.scope === 'failed') return a === 'failed';
  if (by.scope === 'pages') {
    if (a !== 'pages') return false;
    const have = pageSet(by.pages);
    const want = pageSet(ask.pages);
    return want.size > 0 && [...want].every((p) => have.has(p));
  }
  return false;
}

/**
 * True when answering with reading `by` answers a waiting request `ask` (2026-10-09 review): a request to read given
 * pages again is answered only by a reading of those pages (or of every page); any other request (the rest, the failed
 * parts, every page: the "carry on?" question of the document) by any reading that is not of given pages, as before.
 */
export function answersRequest(by: ReadingAsk, ask: ReadingAsk): boolean {
  if (ask.scope === 'pages') return readingCovers(by, ask);
  return by.scope !== 'pages';
}

/**
 * A queued or running reading of the document (not the lab check's own re-read) that already reads what is asked: a
 * second press never queues the same reading twice. A reading that does not cover the request is not reused: the new
 * job runs after it (one reading at a time).
 */
function coveringJob(documentId: string, ask: ReadingAsk & { deep?: boolean }): JobRow | null {
  for (const j of activeJobs(documentId)) {
    if (j.type !== 'extract_facts' || isLabCheckJob(j)) continue;
    const p = parseJson<{ scope?: unknown; pages?: unknown; deep?: unknown }>(j.payloadJson, {});
    if (ask.deep && !p.deep) continue;
    const scope = typeof p.scope === 'string' ? p.scope : 'missing';
    const pages = Array.isArray(p.pages) ? (p.pages as Array<[number, number]>) : null;
    if (readingCovers({ scope, pages }, ask)) return j;
  }
  return null;
}

function queueResume(doc: Doc, opts: { scope: ExtractionScope; pages?: Array<[number, number]>; deep?: boolean; batchId?: string; reason: 'unlock' | 'upload' | 'user' | 'consult'; approved: boolean }): JobRow {
  const existing = activeJob(doc.id);
  if (existing) return existing;
  const prevStatus = doc.extractionStatus === 'queued' || doc.extractionStatus === 'running' ? null : doc.extractionStatus;
  const job = enqueueJob({
    type: 'resume_extraction',
    payload: { documentId: doc.id, scope: opts.scope, ...(opts.pages ? { pages: opts.pages } : {}), deep: Boolean(opts.deep), ...(opts.batchId ? { batchId: opts.batchId } : {}), reason: opts.reason, approved: opts.approved, ...(prevStatus ? { prevStatus } : {}) },
    documentId: doc.id,
    dedupe: true,
  });
  if (job.status === 'queued') {
    db().update(schema.documents).set({ extractionStatus: 'queued', updatedAt: nowIso() }).where(and(eq(schema.documents.id, doc.id), inArray(schema.documents.extractionStatus, ['none', 'done', 'failed', 'partial']))).run();
  }
  return job;
}

/**
 * After an unlock or an upload: carry on alone when what is left costs at most the ceiling, else ask once. Returns the
 * decision written to `coverage.resume`, or null when nothing is left, AI is off, the document is gone or a reading is
 * already queued or running. `declined` stays until the user asks again; an `ask` is not asked twice.
 */
export function maybeAutoResume(documentId: string, reason: 'unlock' | 'upload' | 'user'): ResumeDecision | null {
  const doc = liveDoc(documentId);
  if (!doc || !hasPageText(documentId)) return null;
  if (!aiEnabled() || !getApiKey()) return null;
  if (activeJob(documentId)) return null;
  const prior = readResumeDecision(documentId);
  // The lab check's question (read again the pages with missed lab lines?) is not an answer about the rest.
  if (reason !== 'user' && prior && prior.kind !== 'labcheck' && (prior.decision === 'declined' || prior.decision === 'ask')) return prior;
  const deep = false;
  const est = leftToRead(documentId, deep);
  if (!est.calls) return null;
  const at = nowIso();
  const ceiling = autoResumeCeiling();
  const approved = approvalCovers(prior, est.approxUsd);
  if (underCeiling(est.approxUsd) || approved) {
    const next: ResumeDecision = approved
      ? { ...prior!, at, pagesLeft: est.pages, segmentsLeft: est.segments }
      : { at, estimateUsd: est.approxUsd, ceilingUsd: ceiling, decision: 'auto', pagesLeft: est.pages, segmentsLeft: est.segments, decidedAt: at, decidedBy: 'auto' };
    // The lab check's question still waiting keeps its place (the rest goes ahead by itself, nothing to ask).
    const decision = labCheckQuestionPending(prior) ? next : writeResume(documentId, next);
    queueResume(doc, { scope: 'missing', reason, approved });
    return decision;
  }
  return writeResume(documentId, { at, estimateUsd: est.approxUsd, ceilingUsd: ceiling, decision: 'ask', pagesLeft: est.pages, segmentsLeft: est.segments, decidedAt: null, decidedBy: null });
}

/**
 * The user's (or the chief of staff's) answer to "carry on reading?": approved queues the rest at once; declined is kept. When the
 * question waiting is the lab check's (read again the pages with lab lines no value holds; 2026-10-09, lab recall), yes
 * queues that re-read in small calls and "Not now" adds the lines from the page (services/lab-check.ts).
 */
export function decideResume(documentId: string, decision: 'approved' | 'declined', opts: { by?: string | null; deep?: boolean } = {}): ResumeDecision {
  const doc = liveDoc(documentId);
  if (!doc) throw notFound('document not found');
  const at = nowIso();
  const prior = readResumeDecision(documentId);
  if (labCheckQuestionPending(prior)) {
    const out = writeResume(documentId, { ...prior!, decision, decidedAt: at, decidedBy: opts.by ?? 'user' });
    answerLabRereadQuestion(documentId, decision, prior!);
    // A request for "the rest" the clinician left waiting while this was the question is answered with it.
    answerWaitingRequests(documentId, decision, at, opts.by ?? 'user', { scope: 'missing' });
    return out;
  }
  const est = leftToRead(documentId, Boolean(opts.deep));
  const out = writeResume(documentId, { at, estimateUsd: est.approxUsd, ceilingUsd: autoResumeCeiling(), decision, pagesLeft: est.pages, segmentsLeft: est.segments, decidedAt: at, decidedBy: opts.by ?? 'user' });
  if (decision === 'approved' && est.calls) queueResume(doc, { scope: 'missing', deep: opts.deep, reason: 'user', approved: true });
  // Requests the clinician left waiting to read the rest of this document are answered with it (a request to read given
  // pages again is its own question and keeps waiting).
  answerWaitingRequests(documentId, decision === 'approved' ? 'approved' : 'declined', at, opts.by ?? 'user', { scope: 'missing' });
  // "Not now" to the rest: a lab check question that waited behind it is settled now (its lines are added from the page).
  if (decision === 'declined' && readLabCheck(documentId)?.reread?.status === 'ask') {
    void labCheckAndFollowUp(documentId, { trigger: 'manual' }).catch(() => undefined);
  }
  return out;
}

/** The status words a waiting request's summary carried before 2026-10-08 ("...; waiting for a yes"). */
const WAITING_WORDS = /;\s*waiting for a yes\s*$/i;

/**
 * The reading requests still waiting for this document that `answer` answers get it (answersRequest; 2026-10-09 review:
 * a waiting request for other pages keeps waiting and is read when approved); a summary written with "; waiting
 * for a yes" (before 2026-10-08) loses those words, so the card never says "waiting" beside "started".
 */
function answerWaitingRequests(documentId: string, status: 'approved' | 'declined', at: string, by: string | null, answer: ReadingAsk): void {
  const rows = db()
    .select({ id: schema.filings.id, summary: schema.filings.summary, detailJson: schema.filings.detailJson })
    .from(schema.filings)
    .where(and(eq(schema.filings.targetType, REPROCESS_TARGET), eq(schema.filings.targetId, documentId), eq(schema.filings.status, 'waiting')))
    .all();
  for (const r of rows) {
    const d = parseJson<{ scope?: unknown; pages?: unknown }>(r.detailJson, {});
    const ask: ReadingAsk = { scope: typeof d.scope === 'string' ? d.scope : 'missing', pages: Array.isArray(d.pages) ? (d.pages as Array<[number, number]>) : null };
    if (!answersRequest(answer, ask)) continue;
    db().update(schema.filings).set({ status, decidedAt: at, decidedBy: by, summary: r.summary.replace(WAITING_WORDS, '') }).where(eq(schema.filings.id, r.id)).run();
  }
}

/** Page ranges merged and sorted ([[2,2],[3,5],[9,9]] -> [[2,5],[9,9]]). */
function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The patient's yes to reading requests waiting under an answer (2026-10-08): each goes ahead with its OWN scope and
 * pages (a request to read pages 88-88 again reads those pages, even on a document read to the end), above the ceiling
 * too (the yes covers the estimate shown). Several requests for one document are read together (2026-10-09 review: only
 * the first was read): every page again when one asks for it; else the rest (or the failed parts) and the union of the
 * asked pages, each read. The waiting rows are answered as approved; a request whose document is gone or cannot be read
 * is reported as skipped.
 */
export function approveReprocessRequests(filingIds: readonly string[], by: string | null): ReprocessResult {
  const ids = [...new Set(filingIds)];
  const out: ReprocessResult = { batchId: newId(), queued: [], askFirst: [], skipped: [], filingIds: [] };
  if (!ids.length) return out;
  const rows = db()
    .select()
    .from(schema.filings)
    .where(and(inArray(schema.filings.id, ids), eq(schema.filings.targetType, REPROCESS_TARGET), eq(schema.filings.status, 'waiting')))
    .all();
  type Ask = { scope: 'missing' | 'failed' | 'whole' | 'pages'; pages?: Array<[number, number]>; deep: boolean; reason?: string; askMessageId?: string };
  const byDoc = new Map<string, Ask[]>();
  for (const f of rows) {
    const documentId = f.documentId ?? f.targetId;
    const d = parseJson<Record<string, unknown>>(f.detailJson, {});
    const scope = d.scope === 'failed' || d.scope === 'whole' || d.scope === 'pages' ? d.scope : 'missing';
    const pages = scope === 'pages' && Array.isArray(d.pages) ? (d.pages as Array<[number, number]>) : undefined;
    if (scope === 'pages' && !pages?.length) {
      out.skipped.push({ documentId, reason: 'the request names no pages' });
      continue;
    }
    const list = byDoc.get(documentId) ?? [];
    list.push({ scope, pages, deep: Boolean(d.deep), reason: typeof d.reason === 'string' ? d.reason : undefined, askMessageId: f.askMessageId ?? undefined });
    byDoc.set(documentId, list);
  }
  for (const [documentId, asks] of byDoc) {
    const deep = asks.some((a) => a.deep);
    const first = asks[0];
    const plan: Array<{ scope: Ask['scope']; pages?: Array<[number, number]> }> = [];
    if (asks.some((a) => a.scope === 'whole')) plan.push({ scope: 'whole' });
    else {
      if (asks.some((a) => a.scope === 'missing')) plan.push({ scope: 'missing' });
      else if (asks.some((a) => a.scope === 'failed')) plan.push({ scope: 'failed' });
      const pages = mergeRanges(asks.flatMap((a) => (a.scope === 'pages' ? (a.pages ?? []) : [])));
      if (pages.length) plan.push({ scope: 'pages', pages });
    }
    for (const step of plan) {
      let r: ReprocessResult;
      try {
        r = requestReprocess(
          { documentIds: [documentId], scope: step.scope, pages: step.pages, deep, reason: first.reason, requestedBy: 'user', askMessageId: first.askMessageId, confirmAboveCeiling: true },
          { by: by ?? 'user' },
        );
      } catch (err) {
        out.skipped.push({ documentId, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      out.queued.push(...r.queued);
      out.askFirst.push(...r.askFirst);
      out.skipped.push(...r.skipped);
      out.filingIds.push(...r.filingIds);
    }
  }
  return out;
}

function scopeWords(scope: string, pages?: Array<[number, number]>): string {
  switch (scope) {
    case 'whole':
      return 'read again in full';
    case 'failed':
      return 'the parts that could not be read, read again';
    case 'pages':
      return `pages ${(pages ?? []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')} read again`;
    default:
      return 'the rest read';
  }
}

/**
 * One request for one or many documents (Documents page, POST /api/documents/reprocess, the clinician's
 * propose_reprocess_many). See the header for who waits and who goes ahead.
 */
export function requestReprocess(req: ReprocessRequestInput, opts: { by?: string | null } = {}): ReprocessResult {
  const parsed = reprocessRequest.safeParse(req);
  if (!parsed.success) throw badRequest(zodIssues(parsed.error));
  const r = parsed.data;
  if (r.scope === 'pages' && !r.pages?.length) throw badRequest('pages: say which pages to read again');
  const batchId = newId();
  const out: ReprocessResult = { batchId, queued: [], askFirst: [], skipped: [], filingIds: [] };
  const by = opts.by ?? (r.requestedBy === 'consult' ? 'clinician' : 'user');
  const now = nowIso();
  const aiOk = aiEnabled() && Boolean(getApiKey());
  for (const documentId of [...new Set(r.documentIds)]) {
    const doc = liveDoc(documentId);
    if (!doc) {
      out.skipped.push({ documentId, reason: 'document not found' });
      continue;
    }
    if (!r.reread && TEXT_IN_PROGRESS.includes(doc.textStatus)) {
      out.skipped.push({ documentId, reason: 'its pages are still being read; ask again when that finishes' });
      continue;
    }
    if (!r.reread && !hasPageText(documentId)) {
      out.skipped.push({ documentId, reason: 'it has no page text yet' });
      continue;
    }
    if (!aiOk) {
      out.skipped.push({ documentId, reason: 'AI is switched off or no API key is stored' });
      continue;
    }
    const scope = r.scope as ExtractionScope;
    let est: SegmentEstimate | null = null;
    try {
      // Pages read again with lab lines missed there are read in small calls naming the lines (the job works the lines out
      // the same way): priced as they run, the lines already held there included (2026-10-09 review).
      const lab = scope === 'pages' && r.pages?.length ? labLinesOnPages(documentId, r.pages) : null;
      est = estimateSegments(documentId, scope, r.deep, { pages: r.pages, ...(lab?.missed.length ? { hint: lab.missed, otherLabRows: lab.total - lab.missed.length } : {}) });
    } catch {
      est = null;
    }
    // The lab check's question waiting on a document with nothing left to read: reading "the rest" of it means reading
    // again the pages with lab lines no value holds (Home's Continue reading, a clinician's request; 2026-10-09).
    const prior = scope === 'missing' ? readResumeDecision(documentId) : null;
    const labAsk = labCheckQuestionPending(prior) && (!est || est.calls === 0);
    const usd = labAsk ? prior!.estimateUsd : (est?.approxUsd ?? 0);
    const what = labAsk ? `${scopeWords('pages', prior!.pages ?? [])} for the lab lines no value holds` : scopeWords(scope, r.pages);
    const unasked = r.requestedBy === 'consult';
    // A press on a document whose one question is the lab check's is the yes to it (the cost was shown with it).
    const wait = unasked || (!labAsk && !r.confirmAboveCeiling && !underCeiling(usd) && usd > 0);
    const filingId = newId();
    const detail = { batchId, scope, pages: r.pages ?? null, deep: r.deep, reread: r.reread, reason: r.reason ?? null, estimateUsd: est || labAsk ? usd : null, requestedBy: r.requestedBy, jobId: null as string | null, ...(labAsk ? { labcheck: true } : {}) };
    if (wait) {
      out.askFirst.push({ documentId, estimateUsd: usd });
      if (!unasked) writeResume(documentId, { at: now, estimateUsd: usd, ceilingUsd: autoResumeCeiling(), decision: 'ask', pagesLeft: est?.pages ?? 0, segmentsLeft: est?.segments ?? 0, decidedAt: null, decidedBy: null });
      db().insert(schema.filings).values({
        id: filingId, documentId, targetType: REPROCESS_TARGET, targetId: documentId, action: REPROCESS_ACTION, status: 'waiting', source: r.requestedBy,
        // What is asked, never its status (the card shows the status from `status`, so it never reads "waiting" and
        // "started" at once).
        summary: `Asked to have "${doc.title}" ${what} (about $${usd.toFixed(2)})`.slice(0, 500),
        detailJson: JSON.stringify(detail), askMessageId: r.askMessageId ?? null, createdAt: now,
      }).run();
      out.filingIds.push(filingId);
      continue;
    }
    if (labAsk) {
      writeResume(documentId, { ...prior!, decision: 'approved', decidedAt: now, decidedBy: by });
      const a = answerLabRereadQuestion(documentId, 'approved', prior!);
      if (!a.jobId) {
        out.skipped.push({ documentId, reason: 'no lab line is missing there any more' });
        continue;
      }
      detail.jobId = a.jobId;
      db().insert(schema.filings).values({
        id: filingId, documentId, targetType: REPROCESS_TARGET, targetId: documentId, action: REPROCESS_ACTION, status: 'approved', source: r.requestedBy,
        summary: `"${doc.title}": ${what} (about $${usd.toFixed(2)})`.slice(0, 500),
        detailJson: JSON.stringify(detail), askMessageId: r.askMessageId ?? null, createdAt: now, decidedAt: now, decidedBy: by,
      }).run();
      out.filingIds.push(filingId);
      out.queued.push({ documentId, jobId: a.jobId, scope: 'pages', estimateUsd: usd });
      answerWaitingRequests(documentId, 'approved', now, by, { scope: 'missing' });
      continue;
    }
    if (r.reread) {
      // The page text (and OCR) is read again first; the extraction waits for it (extraction.ts waitForText).
      db().update(schema.documents).set({ textStatus: 'pending', textError: null, updatedAt: now }).where(eq(schema.documents.id, documentId)).run();
      enqueueJob({ type: 'reingest_document', payload: { documentId, forceOcr: false, autoExtract: false }, documentId, dedupe: true });
    }
    const prevStatus = doc.extractionStatus === 'queued' || doc.extractionStatus === 'running' ? undefined : doc.extractionStatus;
    // A reading already queued or running that reads what is asked is reused (a second press queues nothing); any other
    // (the lab check's own re-read, a reading of other pages) is not: this one runs after it (2026-10-09 review).
    const job =
      coveringJob(documentId, { scope, pages: r.pages, deep: r.deep }) ??
      enqueueJob({
        type: 'extract_facts',
        payload: { documentId, deep: r.deep, scope, ...(scope === 'pages' ? { pages: r.pages } : {}), batchId, reason: r.requestedBy === 'consult' ? 'consult' : 'user', prevStatus },
        documentId,
      });
    if (job.status === 'queued') db().update(schema.documents).set({ extractionStatus: 'queued', updatedAt: now }).where(and(eq(schema.documents.id, documentId), inArray(schema.documents.extractionStatus, ['none', 'done', 'failed', 'partial']))).run();
    detail.jobId = job.id;
    db().insert(schema.filings).values({
      id: filingId, documentId, targetType: REPROCESS_TARGET, targetId: documentId, action: REPROCESS_ACTION, status: 'approved', source: r.requestedBy,
      summary: `"${doc.title}": ${scopeWords(scope, r.pages)}${est ? ` (about $${usd.toFixed(2)})` : ''}`.slice(0, 500),
      detailJson: JSON.stringify(detail), askMessageId: r.askMessageId ?? null, createdAt: now, decidedAt: now, decidedBy: by,
    }).run();
    out.filingIds.push(filingId);
    out.queued.push({ documentId, jobId: job.id, scope, estimateUsd: est ? usd : null });
    // Requests that waited for this document and this reading covers are answered by it.
    answerWaitingRequests(documentId, 'approved', now, by, { scope, pages: r.pages ?? null });
    if (scope === 'missing') writeResume(documentId, { at: now, estimateUsd: usd, ceilingUsd: autoResumeCeiling(), decision: 'approved', pagesLeft: est?.pages ?? 0, segmentsLeft: est?.segments ?? 0, decidedAt: now, decidedBy: by });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Segmentation job (registered for `segment_document`) and the after-unlock sequence
// ---------------------------------------------------------------------------

/**
 * `segment_document`: the segments service cuts the document; then, the first time a document read before segments
 * existed is cut, what that reading proved read is kept as read (adoptLegacySegments), the coverage is written, and a
 * finished document with parts the reading never saw (pages whose scanned text was added since) reads `partial`.
 */
export async function segmentDocumentAndAdoptJob(ctx: JobContext<SegmentDocumentPayload>): Promise<SegmentationResult & { adopted: number }> {
  const out = await segmentDocumentJob(ctx);
  const documentId = ctx.payload.documentId;
  let adopted = 0;
  try {
    adopted = adoptLegacySegments(documentId);
    if (listSegments(documentId).length) {
      writeCoverage(documentId);
      const doc = liveDoc(documentId);
      if (doc?.extractionStatus === 'done' && hasUnreadModelSegments(documentId)) {
        db().update(schema.documents).set({ extractionStatus: 'partial', updatedAt: nowIso() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.extractionStatus, 'done'))).run();
        // Cut at an unlock: the pages the earlier reading never saw (scanned text added since) carry on by themselves,
        // under the ceiling, as every other stopped reading after an unlock.
        if (ctx.payload.reason === 'unlock') maybeAutoResume(documentId, 'unlock');
      } else if (ctx.payload.reason === 'unlock' && doc && unreadExportToReadOnce(doc)) {
        // An export never read, recognised by this cut (its structure is known only once it is cut): read once by
        // itself, under the ceiling (else Claude asks once), as the other readings after an unlock (V2).
        maybeAutoResume(documentId, 'unlock');
      }
    }
  } catch (err) {
    console.warn(`[extraction] after segmenting ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...out, adopted };
}

/** True for a document waiting in Check before filing (its reading is the user's call there). */
function waitingInInbox(meta: Record<string, unknown>): boolean {
  const s = (meta.inbox as { status?: unknown } | undefined)?.status;
  return s === 'new' || s === 'triaged' || s === 'needs_manual';
}

/** An institution's export, recognised by its structure (metadata_json.export, or an Epic cut). */
function isExportMeta(meta: Record<string, unknown>): boolean {
  if (parseExportInfo(meta)) return true;
  return (meta.segmentation as { layout?: unknown } | undefined)?.layout === 'epic';
}

/**
 * An export never asked to be read (`none`), not waiting in Check before filing, and never decided on (no "carry on?"
 * answer or automatic decision kept in coverage.resume): after an unlock it is read once by itself, under the ceiling,
 * else Claude asks once (the lead's decision on V2, 2026-10-07 final verification: the 798-page summary). Once means
 * once: a reading the user cancelled, or a decision kept, is never queued again by an unlock. Any other document with
 * status `none` is not read by itself.
 */
export function unreadExportToReadOnce(doc: Pick<Doc, 'id' | 'extractionStatus' | 'metadataJson' | 'deletedAt'>): boolean {
  if (doc.deletedAt || doc.extractionStatus !== 'none') return false;
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  if (waitingInInbox(meta) || !isExportMeta(meta)) return false;
  return readResumeDecision(doc.id) === null;
}

/**
 * Documents a reading should carry on for after an unlock: live, with page text, not waiting in Check before filing,
 * not being read now, whose reading stopped part-way (`partial`, `failed`, or left `queued` / `running` with no job),
 * or that were finished and have parts never read (scanned text added since). A document never asked to be read
 * (`none`) is not read by itself, except an export read once (unreadExportToReadOnce; an export not cut yet is
 * recognised by its cut at the unlock, segmentDocumentAndAdoptJob).
 */
export function autoResumeCandidates(): string[] {
  const rows = db().all<{ id: string; status: string; meta: string; deletedAt: string | null }>(sql`
    select d.id, d.extraction_status as status, d.metadata_json as meta, d.deleted_at as deletedAt from documents d
    where d.deleted_at is null and d.extraction_status in ('partial', 'failed', 'queued', 'running', 'done', 'none')
      and exists (select 1 from document_pages p where p.document_id = d.id and length(trim(p.text)) > 0)
      and not exists (select 1 from jobs j where j.document_id = d.id and j.type in ('extract_facts', 'resume_extraction') and j.status in ('queued', 'running'))
    order by d.created_at`);
  const out: string[] = [];
  for (const r of rows) {
    if (r.status === 'none') {
      if (unreadExportToReadOnce({ id: r.id, extractionStatus: r.status, metadataJson: r.meta, deletedAt: r.deletedAt })) out.push(r.id);
      continue;
    }
    if (waitingInInbox(parseJson<Record<string, unknown>>(r.meta, {}))) continue;
    if (r.status === 'done' && !hasUnreadModelSegments(r.id)) continue;
    out.push(r.id);
  }
  return out;
}

/** Documents with pages and no live segments, or segments from an older segmenter (cut at the next unlock). */
export function documentsToSegment(): string[] {
  return db()
    .all<{ id: string }>(sql`
      select d.id from documents d
      where d.deleted_at is null
        and d.text_status not in ('pending', 'extracting', 'ocr_running')
        and exists (select 1 from document_pages p where p.document_id = d.id)
        and not exists (select 1 from document_segments s where s.document_id = d.id and s.superseded_at is null)
        and not exists (select 1 from jobs j where j.document_id = d.id and j.type = 'segment_document' and j.status in ('queued', 'running'))
      order by d.created_at`)
    .map((r) => r.id);
}

export interface AfterUnlockIngestResult {
  legacyCoverage: number;
  segmentationQueued: number;
  resumed: Array<{ documentId: string; decision: ResumeDecision['decision'] }>;
  hooks: unknown;
}

/**
 * Steps 4-7 of the after-unlock sequence (src/server/index.ts runs it a little after each unlock): legacy coverage
 * for documents with none; segmentation queued for every document with pages and no segments (behind uploads); the
 * communications side's after-unlock hook; then, one at a time in the one-slot lane, the automatic resume of every
 * document whose reading stopped part-way, under the ceiling, else asked once. Best effort; never throws.
 */
export async function ingestAfterUnlock(isUnlocked: () => boolean = () => true): Promise<AfterUnlockIngestResult> {
  const out: AfterUnlockIngestResult = { legacyCoverage: 0, segmentationQueued: 0, resumed: [], hooks: null };
  try {
    out.legacyCoverage = backfillLegacyCoverage();
  } catch (err) {
    console.warn(`[extraction] coverage backfill: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isUnlocked()) return out;
  let candidates: string[] = [];
  try {
    candidates = autoResumeCandidates();
  } catch (err) {
    console.warn(`[extraction] resume candidates: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A document left queued or running with no job: its status first says what it holds.
  for (const id of candidates) {
    try {
      const doc = liveDoc(id);
      if (doc && (doc.extractionStatus === 'queued' || doc.extractionStatus === 'running')) {
        const st = settledExtractionStatus(id);
        db().update(schema.documents).set({ extractionStatus: st === 'none' ? 'failed' : st, updatedAt: nowIso() }).where(and(eq(schema.documents.id, id), inArray(schema.documents.extractionStatus, ['queued', 'running']))).run();
      }
    } catch (err) {
      console.warn(`[extraction] status of ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Segmentation for the rest (the documents being resumed are cut by their own reading).
  const resumeSet = new Set(candidates);
  try {
    for (const id of documentsToSegment()) {
      if (resumeSet.has(id)) continue;
      enqueueJob({ type: 'segment_document', payload: { documentId: id, reason: 'unlock' }, documentId: id, dedupe: true, priority: -5 });
      out.segmentationQueued++;
    }
  } catch (err) {
    console.warn(`[extraction] segmentation after unlock: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isUnlocked()) return out;
  try {
    out.hooks = await afterUnlock();
  } catch (err) {
    console.warn(`[extraction] afterUnlock hook: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const id of candidates) {
    if (!isUnlocked()) break;
    try {
      const d = maybeAutoResume(id, 'unlock');
      if (d) out.resumed.push({ documentId: id, decision: d.decision });
    } catch (err) {
      console.warn(`[extraction] resume of ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Evidence for the diagnostics endpoint: the live rows now, and what was kept before the first repair. */
export function extractionDiagnostics(documentId: string): { live: ExtractionEvidence; captured: ExtractionEvidence | null } {
  if (!liveDoc(documentId)) throw notFound('document not found');
  return { live: captureEvidence(documentId, 'diagnostics'), captured: storedEvidence(documentId) };
}

/** Which of these ids are live documents (the banner's poll leaves out a document deleted meanwhile). */
export function liveDocumentIds(ids: readonly string[]): Set<string> {
  if (!ids.length) return new Set();
  return new Set(db().select({ id: schema.documents.id }).from(schema.documents).where(and(inArray(schema.documents.id, [...ids]), isNull(schema.documents.deletedAt))).all().map((r) => r.id));
}

/** The coverage as it stands, read-only: from the segments (worked out now), else the stored one, else the legacy one worked out now. */
export function currentCoverage(documentId: string): DocumentCoverage | null {
  if (!liveDoc(documentId)) return null;
  if (listSegments(documentId).length) return coverageSummary(documentId);
  const stored = readCoverage(documentId);
  if (stored) return stored;
  return computeLegacyCoverageFor(documentId, liveDoc(documentId)?.pageCount ?? 0);
}
