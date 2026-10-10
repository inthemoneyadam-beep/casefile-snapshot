/**
 * Persistent job queue backed by the `jobs` table, with an in-process worker.
 * Lanes bound concurrency: ingest (OCR, text extraction, segmentation, the
 * rules after ingestion), ai (classification, the cross-reference pass),
 * ai_long (reading documents for their details: hours for a large export, one
 * document at a time, so classification of a new upload never waits behind
 * it), export (PDF). Jobs survive restarts: anything left `running` is
 * re-queued when the worker starts. The worker only polls while the database
 * is open.
 *
 * Generations. A lock stops the worker (aborting what runs) and an unlock
 * starts it again, re-queueing every `running` row. A run that began before
 * that no longer owns its row: its last writes (progress, the final status)
 * are skipped, so a lock and unlock during one long job (an export) leaves
 * the job queued for the new worker instead of ending it `cancelled`. A run
 * stopped that way did not fail: its attempt is given back when it is
 * re-queued (up to MAX_INTERRUPTIONS times, so a job that crashes the process
 * cannot loop for ever).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, isDbOpen, schema } from '../db';
import { newId, nowIso, parseJson } from '../util/ids';
import type { JobType } from '../../shared/enums';
import { config } from '../config';
import { log, safeReason } from '../util/log';

const secondsSince = (t0: number) => Math.round((Date.now() - t0) / 1000);

export type JobRow = typeof schema.jobs.$inferSelect;

/**
 * Thrown by a handler that stops on purpose (its document was deleted while it
 * ran): the job ends `cancelled` at once, never retried.
 */
export class JobCancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

/**
 * Errors that no retry can fix: the job fails at once. A refusal ("refused: ...", AiRefusedError's message) is one; a
 * refused connection (ECONNREFUSED, "connection refused") is not: it is a network error like any other and is retried.
 */
export const GIVE_UP = /no handler|AiDisabled|NoApiKey|(?<![a-z])refused:|\brefusal\b|no page text/i;

/** True when a handler's error must not be retried (GIVE_UP, or an error that says so with `noRetry`). */
export function shouldGiveUp(err: unknown, message: string): boolean {
  if (err && typeof err === 'object' && (err as { noRetry?: unknown }).noRetry === true) return true;
  return GIVE_UP.test(message);
}

export interface JobContext<P = Record<string, unknown>> {
  job: JobRow;
  payload: P;
  signal: AbortSignal;
  setProgress(progress: number, text?: string): void;
  /**
   * False once a lock, a restart or a stop of the worker took the job from this run (its row is re-queued for the next
   * worker): the handler must not write its own end state then. Missing (tests, scripts) reads as true.
   */
  stillOwned?(): boolean;
}

export type JobHandler<P = Record<string, unknown>> = (ctx: JobContext<P>) => Promise<unknown>;

export const LANE_LIMITS: Readonly<Record<string, number>> = { ingest: 2, ai: 2, ai_long: 1, export: 1 };
/** How often a job may be stopped by a lock or restart without the stop counting as one of its attempts. */
export const MAX_INTERRUPTIONS = 5;
const handlers = new Map<string, JobHandler<never>>();
const running = new Map<string, AbortController>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;
/** Bumped by every stop and start of the worker; a run only writes its job row while the generation it began in is current. */
let generation = 0;

export function registerJobHandler<P>(type: JobType, handler: JobHandler<P>): void {
  handlers.set(type, handler as JobHandler<never>);
}

export function laneFor(type: JobType): string {
  switch (type) {
    case 'extract_facts':
    case 'resume_extraction':
    case 'read_notes':
      return 'ai_long';
    case 'crossref':
    case 'triage_document':
    // 2026-10-09: a plan reading waits for its upload's pages (ingest lane), so it must never hold an ingest slot.
    case 'read_plan':
    case 'self_check':
      return 'ai';
    case 'export_packet':
      return 'export';
    default:
      // ingest_document, reingest_document, segment_document, rules_after_ingest
      return 'ingest';
  }
}

export function enqueueJob(opts: {
  type: JobType;
  payload?: Record<string, unknown>;
  priority?: number;
  documentId?: string | null;
  dedupe?: boolean;
}): JobRow {
  const d = db();
  if (opts.dedupe && opts.documentId) {
    const existing = d
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, opts.type), eq(schema.jobs.documentId, opts.documentId), inArray(schema.jobs.status, ['queued', 'running'])))
      .get();
    if (existing) return existing;
  }
  const row: typeof schema.jobs.$inferInsert = {
    id: newId(),
    type: opts.type,
    lane: laneFor(opts.type),
    payloadJson: JSON.stringify(opts.payload ?? {}),
    status: 'queued',
    priority: opts.priority ?? 0,
    documentId: opts.documentId ?? null,
    createdAt: nowIso(),
  };
  d.insert(schema.jobs).values(row).run();
  const inserted = d.select().from(schema.jobs).where(eq(schema.jobs.id, row.id)).get()!;
  queueMicrotask(() => void tick());
  return inserted;
}

/**
 * One `rules_after_ingest` job at a time (debounced): while one is queued (not yet started), later passes add their
 * documents to its payload instead of queueing another. It runs in the ingest lane, behind uploads (low priority).
 */
export function enqueueRulesAfterIngest(documentIds: string[], trigger: 'ingestion' | 'unlock' | 'reprocess'): JobRow {
  const d = db();
  const queued = d
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'rules_after_ingest'), eq(schema.jobs.status, 'queued')))
    .orderBy(asc(schema.jobs.createdAt))
    .get();
  if (queued) {
    const p = parseJson<{ documentIds?: unknown; trigger?: unknown }>(queued.payloadJson, {});
    const before = Array.isArray(p.documentIds) ? p.documentIds.filter((x): x is string => typeof x === 'string') : [];
    const ids = [...new Set([...before, ...documentIds])].slice(-500);
    d.update(schema.jobs).set({ payloadJson: JSON.stringify({ ...p, documentIds: ids, trigger: typeof p.trigger === 'string' ? p.trigger : trigger }) }).where(eq(schema.jobs.id, queued.id)).run();
    return d.select().from(schema.jobs).where(eq(schema.jobs.id, queued.id)).get()!;
  }
  return enqueueJob({ type: 'rules_after_ingest', payload: { documentIds: [...new Set(documentIds)], trigger }, priority: -5 });
}

/** The extraction status a document goes back to when its queued extraction is cancelled (handlers may refine it). */
type DocumentStatusReset = (documentId: string, payload: Record<string, unknown>) => void;
let resetOnCancel: DocumentStatusReset | null = null;

/**
 * Registered by the extraction engine (jobs/handlers.ts): how a document left `queued` by a cancelled job gets its
 * status back. Kept as a hook so this module imports nothing from the engine.
 */
export function onExtractionJobCancelled(fn: DocumentStatusReset | null): void {
  resetOnCancel = fn;
}

const EXTRACTION_JOB_TYPES = new Set(['extract_facts', 'resume_extraction']);

/** The fallback reset: back to what the payload says it was, else `none` (no live facts) or `partial`. */
function defaultReset(documentId: string, payload: Record<string, unknown>): void {
  const d = db();
  const doc = d.select({ status: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc || doc.status !== 'queued') return;
  const prev = typeof payload.prevStatus === 'string' && payload.prevStatus !== 'queued' && payload.prevStatus !== 'running' ? payload.prevStatus : null;
  let next = prev;
  if (!next) {
    const n = d.get<{ n: number }>(sql`select count(*) as n from facts where source_document_id = ${documentId} and deleted_at is null`)?.n ?? 0;
    next = n > 0 ? 'partial' : 'none';
  }
  d.update(schema.documents).set({ extractionStatus: next, updatedAt: nowIso() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.extractionStatus, 'queued'))).run();
}

/**
 * Cancel a job. A running one is aborted (its handler ends it); a queued one is cancelled here, and a document its
 * extraction left `queued` gets its status back (it no longer reads "pulling out the details" for good), unless another
 * extraction of the same document is still queued or running.
 */
export function cancelJob(id: string): boolean {
  const ctl = running.get(id);
  if (ctl) {
    ctl.abort();
    return true;
  }
  const d = db();
  const row = d.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  const r = d.update(schema.jobs).set({ status: 'cancelled', finishedAt: nowIso() }).where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, 'queued'))).run();
  if (r.changes > 0 && row?.documentId && EXTRACTION_JOB_TYPES.has(row.type)) {
    const other = d
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.documentId, row.documentId), inArray(schema.jobs.type, [...EXTRACTION_JOB_TYPES]), inArray(schema.jobs.status, ['queued', 'running'])))
      .get();
    if (!other) {
      const payload = parseJson<Record<string, unknown>>(row.payloadJson, {});
      try {
        (resetOnCancel ?? defaultReset)(row.documentId, payload);
      } catch (err) {
        console.warn(`[jobs] could not reset the document's status after a cancel: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return r.changes > 0;
}

export function retryJob(id: string): boolean {
  const r = db()
    .update(schema.jobs)
    .set({ status: 'queued', error: null, attempts: 0, progress: 0, progressText: null, startedAt: null, finishedAt: null })
    .where(and(eq(schema.jobs.id, id), inArray(schema.jobs.status, ['failed', 'cancelled'])))
    .run();
  queueMicrotask(() => void tick());
  return r.changes > 0;
}

/**
 * Re-queue what a lock, a restart or a crash left `running`. The stop was not the job's own failure, so its attempt is
 * given back (`attempts - 1`), and the stop is counted in the payload (`_interruptions`); past MAX_INTERRUPTIONS the
 * attempt counts again. Rows in a lane that changed since they were queued move to their lane (an extraction queued
 * in the old shared `ai` lane goes to `ai_long`).
 */
export function requeueInterruptedJobs(): number {
  const d = db();
  const rows = d.select().from(schema.jobs).where(eq(schema.jobs.status, 'running')).all();
  for (const r of rows) {
    const payload = parseJson<Record<string, unknown>>(r.payloadJson, {});
    const stops = (typeof payload._interruptions === 'number' ? payload._interruptions : 0) + 1;
    const giveBack = stops <= MAX_INTERRUPTIONS;
    d.update(schema.jobs)
      .set({
        status: 'queued',
        startedAt: null,
        attempts: giveBack ? Math.max(0, r.attempts - 1) : r.attempts,
        payloadJson: JSON.stringify({ ...payload, _interruptions: stops }),
      })
      .where(eq(schema.jobs.id, r.id))
      .run();
  }
  // Lanes are decided by type: queued rows written before a lane existed follow their type now.
  for (const type of ['extract_facts', 'resume_extraction'] as const) {
    d.update(schema.jobs).set({ lane: laneFor(type) }).where(and(eq(schema.jobs.type, type), eq(schema.jobs.status, 'queued'), sql`${schema.jobs.lane} <> ${laneFor(type)}`)).run();
  }
  return rows.length;
}

export function startJobWorker(): void {
  if (timer) return;
  // Runs still winding down from before this start no longer own their rows (re-queued just below).
  generation++;
  // Re-queue anything interrupted by a previous shutdown.
  try {
    requeueInterruptedJobs();
  } catch {
    // db may not be open yet; tick() guards
  }
  timer = setInterval(() => void tick(), 750);
  void tick();
}

export function stopJobWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  // The aborted runs leave their rows `running`; the next start re-queues them.
  generation++;
  for (const ctl of running.values()) ctl.abort();
}

export function activeJobCount(): number {
  return running.size;
}

async function tick(): Promise<void> {
  if (ticking || !isDbOpen()) return;
  ticking = true;
  try {
    for (const [lane, limit] of Object.entries(LANE_LIMITS)) {
      const inLane = [...running.keys()].filter((id) => laneOf.get(id) === lane).length;
      let slots = limit - inLane;
      while (slots > 0) {
        const next = db()
          .select()
          .from(schema.jobs)
          .where(and(eq(schema.jobs.status, 'queued'), eq(schema.jobs.lane, lane)))
          .orderBy(desc(schema.jobs.priority), asc(schema.jobs.createdAt))
          .limit(1)
          .get();
        if (!next) break;
        void run(next);
        slots--;
      }
    }
  } finally {
    ticking = false;
  }
}

const laneOf = new Map<string, string>();

async function run(job: JobRow): Promise<void> {
  const handler = handlers.get(job.type);
  const ctl = new AbortController();
  const gen = generation;
  // False once a stop or start of the worker happened during this run: the row was (or will be) re-queued and is not ours to write.
  const ownsRow = () => gen === generation && isDbOpen();
  running.set(job.id, ctl);
  laneOf.set(job.id, job.lane);
  const d = db();
  d.update(schema.jobs)
    .set({ status: 'running', startedAt: nowIso(), attempts: job.attempts + 1, error: null })
    .where(eq(schema.jobs.id, job.id))
    .run();
  // The type and the document id only (never a title or a payload).
  const t0 = Date.now();
  const what = `${job.type}${job.documentId ? ` document ${job.documentId}` : ''}`;
  log.info('jobs', `${what} started (attempt ${job.attempts + 1} of ${job.maxAttempts})`);
  let lastProgressWrite = 0;
  const ctx: JobContext = {
    job,
    payload: JSON.parse(job.payloadJson || '{}'),
    signal: ctl.signal,
    stillOwned: ownsRow,
    setProgress(progress, text) {
      if (gen !== generation) return;
      const now = Date.now();
      if (now - lastProgressWrite < 250 && progress < 1) return;
      lastProgressWrite = now;
      try {
        db().update(schema.jobs).set({ progress, progressText: text ?? null }).where(eq(schema.jobs.id, job.id)).run();
      } catch {
        // locked mid-job; the job will be re-queued on next unlock
      }
    },
  };
  try {
    if (!handler) throw new Error(`no handler for job type ${job.type}`);
    const result = await handler(ctx as never);
    if (!ownsRow()) {
      log.info('jobs', `${what} stopped by a lock or restart after ${secondsSince(t0)} s; it carries on at the next unlock`);
      return;
    }
    db().update(schema.jobs)
      .set({ status: ctl.signal.aborted ? 'cancelled' : 'done', progress: 1, finishedAt: nowIso(), resultJson: result === undefined ? null : JSON.stringify(result) })
      .where(eq(schema.jobs.id, job.id))
      .run();
    log.info('jobs', `${what} ${ctl.signal.aborted ? 'cancelled' : 'finished'} in ${secondsSince(t0)} s`);
  } catch (err) {
    if (!ownsRow()) {
      log.info('jobs', `${what} stopped by a lock or restart after ${secondsSince(t0)} s; it carries on at the next unlock`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    const cancelled = ctl.signal.aborted || err instanceof JobCancelledError;
    const giveUp = cancelled || attempts >= job.maxAttempts || shouldGiveUp(err, message);
    db().update(schema.jobs)
      .set({
        status: cancelled ? 'cancelled' : giveUp ? 'failed' : 'queued',
        error: message.slice(0, 2000),
        finishedAt: giveUp ? nowIso() : null,
      })
      .where(eq(schema.jobs.id, job.id))
      .run();
    if (config.hosted) {
      // Hosted: one line without the full message (it can quote the case); the Jobs screen keeps the whole of it.
      if (cancelled) log.info('jobs', `${what} cancelled after ${secondsSince(t0)} s`);
      else log.error('jobs', `${what} failed after ${secondsSince(t0)} s (attempt ${attempts} of ${job.maxAttempts}; ${giveUp ? 'not retried' : 'queued to try again'}): ${safeReason(err)}`);
    } else if (cancelled) console.warn(`[jobs] ${job.type} ${job.id} cancelled: ${message}`);
    else console.error(`[jobs] ${job.type} ${job.id} failed (attempt ${attempts}): ${message}`);
  } finally {
    // A run of the same job started by the next worker generation may hold the slot by now.
    if (running.get(job.id) === ctl) {
      running.delete(job.id);
      laneOf.delete(job.id);
    }
  }
}
