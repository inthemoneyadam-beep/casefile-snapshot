/**
 * Extraction evidence and repair (2026-10-07, large exports; findings A.5 and D.5 steps 2-4).
 *
 * Before anything repairs a stopped reading, the rows that prove why it stopped are copied, read-only, into
 * `metadata_json.coverage.legacy` (an ExtractionEvidence) with an `audit_log` row of counts: the document's status
 * fields, its extraction runs and jobs, its model calls (what came back, what did not and why, by page range) and the
 * pages its live details cite. Only then does the repair run: runs left `running` by a lock or restart become
 * `interrupted`, segments left `running` go back to `pending` (the stopped attempt is not counted), and a document left
 * `running` with no job to finish it gets a status that says what it holds.
 *
 * "Legacy" coverage is what a document read before segments existed can prove: only the pages of model calls that came
 * back ok AND whose reading was kept (or every page with text when a run finished, which then meant every page with text
 * was read), never more. See `legacyReadInfo` (2026-10-07 final verification, V1: a retry rolled back proves nothing).
 *
 * Dependency-light on purpose (db, schema, the shared shapes and the audit writer only): auth.ts calls it while it
 * unlocks, before the job worker starts, and must not import the services that import auth.ts.
 * Never logs record text: counts, ids and page numbers only.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nowIso, parseJson } from '../util/ids';
import { writeAudit } from './audit';
import {
  computeLegacyCoverage, extractionEvidence, mergeCoverageMeta, pagesToRanges, parseCoverage,
  type CoveragePageInput, type DocumentCoverage, type ExtractionEvidence, type PageRange,
} from '../../shared/schemas/segments';

/** The "p.a-b" a model call's request summary ends with (extraction calls: "extract <title> p.49-72"). */
const SUMMARY_PAGES = /\bp\.(\d+)-(\d+)\s*$/;

export function pageRangeOfSummary(summary: string | null | undefined): PageRange | null {
  const m = SUMMARY_PAGES.exec(summary ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return null;
  return [a, b];
}

/** Ranges merged and sorted ([[1, 24], [25, 48]] -> [[1, 48]]). */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): PageRange[] {
  const pages: number[] = [];
  for (const [a, b] of ranges) for (let p = a; p <= b; p++) pages.push(p);
  return pagesToRanges(pages);
}

interface CallRow {
  id: string;
  createdAt: string;
  status: string;
  stopReason: string | null;
  durationMs: number;
  outputTokens: number;
  requestSummary: string | null;
  error: string | null;
  jobId: string | null;
}

/** A document's extraction calls, newest first. */
function extractionCalls(documentId: string): CallRow[] {
  return db().all<CallRow>(sql`
    select a.id, a.created_at as createdAt, a.status, a.stop_reason as stopReason, a.duration_ms as durationMs,
           a.output_tokens as outputTokens, a.request_summary as requestSummary, a.error, a.job_id as jobId
    from ai_calls a
    where a.purpose = 'extract_facts' and json_valid(a.document_ids_json)
      and exists (select 1 from json_each(a.document_ids_json) j where j.value = ${documentId})
    order by a.created_at desc`);
}

/** Pages as the coverage sees them (no text loaded). */
export function coveragePagesOf(documentId: string): CoveragePageInput[] {
  const P = schema.documentPages;
  return db()
    .select({ pageNumber: P.pageNumber, ocr: P.ocr, hasText: sql<number>`length(trim(${P.text}, char(32, 9, 10, 13))) > 0` })
    .from(P)
    .where(eq(P.documentId, documentId))
    .orderBy(P.pageNumber)
    .all()
    .map((p) => ({ pageNumber: p.pageNumber, ocr: Boolean(p.ocr), hasText: Boolean(p.hasText) }));
}

/** Pages cited by the document's live details. */
export function citedPagesOf(documentId: string): number[] {
  return db()
    .all<{ p: number }>(sql`select distinct c.page_number as p from citations c join facts f on f.id = c.fact_id
                             where c.document_id = ${documentId} and f.deleted_at is null and f.source_document_id = ${documentId}
                             order by 1`)
    .map((r) => r.p);
}

/** One ok extraction call of a reading before segments: its pages, the run it belongs to, and whether it proves them read. */
export interface LegacyCall {
  id: string;
  at: string;
  range: PageRange;
  /** The run the call belongs to, or null when no single run can be found for it. */
  runId: string | null;
  /** Its pages count as read (see legacyReadInfo). */
  proved: boolean;
}

/** What a reading before segments can prove was read (see the header). */
export interface LegacyReadInfo {
  /** Pages proved read. */
  readRanges: PageRange[];
  /** When the last proof was written (the last proving call or finished run), or null. */
  lastReadAt: string | null;
  /** A run finished, so every page with text was read at that time. */
  finishedRun: boolean;
  /** The latest run, for the coverage's runId. */
  latestRunId: string | null;
  /** The latest run whose calls (or end) prove pages read: the run parts adopted as read are credited to. */
  readRunId: string | null;
  /** Every ok call with a page range, newest first, matched to its run. */
  calls: LegacyCall[];
}

interface LegacyRunRow {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  aiCallIdsJson: string;
}

/**
 * The run each call belongs to (call id -> run id, or null when in doubt): the run whose `ai_call_ids_json` lists it;
 * else the one run whose time window holds it (from its start to its end, or to the next run's start when that is
 * earlier: a run a lock left running, or one the unlock repair closed later, never claims a later run's calls); else,
 * among several windows (or none), the one run whose listed calls share the call's job. Anything else: null.
 */
export function runsOfCalls(runs: readonly LegacyRunRow[], calls: ReadonlyArray<{ id: string; createdAt: string; jobId: string | null }>): Map<string, string | null> {
  const listed = new Map<string, string>();
  for (const r of runs) {
    for (const id of parseJson<unknown[]>(r.aiCallIdsJson, [])) if (typeof id === 'string' && !listed.has(id)) listed.set(id, r.id);
  }
  const byStart = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const windows = byStart.map((r) => {
    const next = byStart.find((x) => x.startedAt > r.startedAt)?.startedAt ?? null;
    const ends = [r.finishedAt, next].filter((x): x is string => Boolean(x)).sort();
    return { id: r.id, from: r.startedAt, to: ends[0] ?? null };
  });
  const jobOfCall = new Map(calls.map((c) => [c.id, c.jobId]));
  const jobsOfRun = new Map<string, Set<string>>();
  for (const [callId, runId] of listed) {
    const job = jobOfCall.get(callId);
    if (!job) continue;
    const set = jobsOfRun.get(runId) ?? new Set<string>();
    set.add(job);
    jobsOfRun.set(runId, set);
  }
  const out = new Map<string, string | null>();
  for (const c of calls) {
    const l = listed.get(c.id);
    if (l) {
      out.set(c.id, l);
      continue;
    }
    let cand = windows.filter((w) => c.createdAt >= w.from && (w.to === null || c.createdAt <= w.to)).map((w) => w.id);
    if (cand.length !== 1 && c.jobId) {
      const pool = cand.length ? cand : runs.map((r) => r.id);
      const byJob = pool.filter((id) => jobsOfRun.get(id)?.has(c.jobId!));
      if (byJob.length === 1) cand = byJob;
    }
    out.set(c.id, cand.length === 1 ? cand[0] : null);
  }
  return out;
}

/** Pages cited by the live details the model read, per run (run id -> pages). */
function citedPagesByRun(documentId: string, deleted = false): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const rows = db().all<{ runId: string; p: number }>(sql`
    select f.extraction_run_id as runId, c.page_number as p
    from facts f join citations c on c.fact_id = f.id
    where f.source_document_id = ${documentId} and c.document_id = ${documentId}
      and ${deleted ? sql`f.deleted_at is not null` : sql`f.deleted_at is null`} and f.origin = 'ai' and f.extraction_run_id is not null
    group by 1, 2`);
  for (const r of rows) {
    const set = out.get(r.runId) ?? new Set<number>();
    set.add(Number(r.p));
    out.set(r.runId, set);
  }
  return out;
}

/**
 * What a reading made before segments existed proves was read (2026-10-07 final verification, V1). An ok extraction
 * call counts ONLY when its run finished (`done`: every page with text was then read) or when its run still holds live
 * details the model read citing a page of the call's range. The old engine's failed retry rolled its details back but
 * kept its ok calls (listed in its run by failRun): such calls prove nothing, so "pp.1-48 kept, a retry read pp.1-96 and
 * was rolled back" is pp.1-48. A run that did not finish and has deleted details on a call's pages was rolled back
 * there, so that call proves nothing even when one of its details survived (confirmed or linked before the rollback;
 * re-check R1). Calls are matched to runs by runsOfCalls. When in doubt a page is NOT read: re-reading costs about
 * $0.05 per 24 pages; a page wrongly taken as read is never read.
 */
export function legacyReadInfo(documentId: string, pages: CoveragePageInput[] = coveragePagesOf(documentId)): LegacyReadInfo {
  const runs: LegacyRunRow[] = db()
    .select({ id: schema.extractionRuns.id, status: schema.extractionRuns.status, startedAt: schema.extractionRuns.startedAt, finishedAt: schema.extractionRuns.finishedAt, aiCallIdsJson: schema.extractionRuns.aiCallIdsJson })
    .from(schema.extractionRuns)
    .where(eq(schema.extractionRuns.documentId, documentId))
    .orderBy(desc(schema.extractionRuns.startedAt))
    .all();
  const status = new Map(runs.map((r) => [r.id, r.status]));
  const done = runs.filter((r) => r.status === 'done');
  const okCalls = extractionCalls(documentId).filter((c) => c.status === 'ok');
  const runOf = runsOfCalls(runs, okCalls);
  const cited = citedPagesByRun(documentId);
  const rolledBack = citedPagesByRun(documentId, true);
  const ranges: PageRange[] = [];
  const calls: LegacyCall[] = [];
  let lastReadAt: string | null = null;
  const provingRuns = new Set<string>();
  for (const c of okCalls) {
    const range = pageRangeOfSummary(c.requestSummary);
    if (!range) continue;
    const runId = runOf.get(c.id) ?? null;
    let proved = false;
    if (runId) {
      if (status.get(runId) === 'done') proved = true;
      else {
        const pagesOfRun = cited.get(runId);
        const gone = rolledBack.get(runId);
        let rolled = false;
        if (gone) for (let p = range[0]; p <= range[1] && !rolled; p++) if (gone.has(p)) rolled = true;
        if (pagesOfRun && !rolled) for (let p = range[0]; p <= range[1] && !proved; p++) if (pagesOfRun.has(p)) proved = true;
      }
    }
    calls.push({ id: c.id, at: c.createdAt, range, runId, proved });
    if (!proved) continue;
    ranges.push(range);
    provingRuns.add(runId!);
    if (!lastReadAt || c.createdAt > lastReadAt) lastReadAt = c.createdAt;
  }
  if (done.length) {
    for (const p of pages) if (p.hasText) ranges.push([p.pageNumber, p.pageNumber]);
    const fin = done.map((r) => r.finishedAt ?? r.startedAt).sort().pop() ?? null;
    if (fin && (!lastReadAt || fin > lastReadAt)) lastReadAt = fin;
    for (const r of done) provingRuns.add(r.id);
  }
  const readRunId = runs.find((r) => provingRuns.has(r.id))?.id ?? null;
  return { readRanges: mergeRanges(ranges), lastReadAt, finishedRun: done.length > 0, latestRunId: runs[0]?.id ?? null, readRunId, calls };
}

// ---------------------------------------------------------------------------
// Evidence (A.5)
// ---------------------------------------------------------------------------

const STORED_NOT_OK = 100;
const STORED_RUNS_AND_JOBS = 50;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * The evidence of a document's extraction as it stands, read-only. `reason` says whether it is the snapshot kept
 * before a repair or a live read for the diagnostics page. Throws when there is no such document.
 */
export function captureEvidence(documentId: string, reason: ExtractionEvidence['reason']): ExtractionEvidence {
  const d = db();
  const doc = d.select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc) throw new Error(`document ${documentId} not found`);
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const inbox = meta.inbox && typeof meta.inbox === 'object' ? (meta.inbox as Record<string, unknown>) : null;
  const filing = inbox?.filing && typeof inbox.filing === 'object' ? (inbox.filing as Record<string, unknown>) : null;
  const classErr = meta.classificationError;

  const runs = d
    .select()
    .from(schema.extractionRuns)
    .where(eq(schema.extractionRuns.documentId, documentId))
    .orderBy(desc(schema.extractionRuns.startedAt))
    .limit(STORED_RUNS_AND_JOBS)
    .all()
    .map((r) => ({
      id: r.id,
      status: r.status,
      model: r.model,
      deep: Boolean(r.deep),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      chunks: r.chunks,
      factsCount: r.factsCount,
      okCalls: parseJson<unknown[]>(r.aiCallIdsJson, []).length,
      error: r.error ?? null,
    }));
  const jobs = d
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.documentId, documentId))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(STORED_RUNS_AND_JOBS)
    .all()
    .map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      progressText: j.progressText ?? null,
      error: j.error ?? null,
      createdAt: j.createdAt,
      startedAt: j.startedAt ?? null,
      finishedAt: j.finishedAt ?? null,
    }));
  const calls = extractionCalls(documentId);
  const ok = calls.filter((c) => c.status === 'ok');
  const okRanges = mergeRanges(ok.map((c) => pageRangeOfSummary(c.requestSummary)).filter((r): r is PageRange => r !== null));
  const notOk = calls
    .filter((c) => c.status !== 'ok')
    .slice(0, STORED_NOT_OK)
    .map((c) => {
      const r = pageRangeOfSummary(c.requestSummary);
      return {
        id: c.id,
        at: c.createdAt,
        status: c.status,
        stopReason: c.stopReason ?? null,
        durationMs: Math.max(0, Math.round(c.durationMs ?? 0)),
        outputTokens: Math.max(0, Math.round(c.outputTokens ?? 0)),
        pages: r ? `${r[0]}-${r[1]}` : null,
        error: c.error ? c.error.slice(0, 500) : null,
      };
    });
  const facts = d
    .all<{ runId: string | null; live: number; count: number; firstPage: number | null; lastPage: number | null }>(sql`
      select f.extraction_run_id as runId, (f.deleted_at is null) as live, count(distinct f.id) as count,
             min(c.page_number) as firstPage, max(c.page_number) as lastPage
      from facts f left join citations c on c.fact_id = f.id
      where f.source_document_id = ${documentId} and f.origin = 'ai'
      group by 1, 2 order by 1`)
    .map((r) => ({ runId: r.runId ?? null, live: Boolean(r.live), count: Number(r.count), firstPage: r.firstPage ?? null, lastPage: r.lastPage ?? null }));
  const pages = d.get<{ empty: number | null; ocr: number | null; thin: number | null }>(sql`
    select sum(char_count = 0) as empty, sum(ocr) as ocr, sum(char_count < 800 and ocr = 0) as thin
    from document_pages where document_id = ${documentId}`);
  const since = runs.length ? runs[runs.length - 1].startedAt : null;
  const locks = since
    ? d
        .select({ at: schema.auditLog.at, summary: schema.auditLog.summary })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, 'lock'), sql`${schema.auditLog.at} >= ${since}`))
        .orderBy(desc(schema.auditLog.at))
        .limit(20)
        .all()
        .map((l) => ({ at: l.at, summary: l.summary ?? null }))
    : [];

  return extractionEvidence.parse({
    v: 1,
    capturedAt: nowIso(),
    reason,
    document: {
      extractionStatus: doc.extractionStatus,
      textStatus: doc.textStatus,
      textError: doc.textError ?? null,
      pageCount: doc.pageCount,
      category: doc.category,
      sourceTier: doc.sourceTier,
      inboxStatus: str(inbox?.status),
      filedActions: Array.isArray(filing?.actions) ? (filing!.actions as unknown[]).filter((a): a is string => typeof a === 'string') : null,
      classificationError: typeof classErr === 'string' ? classErr.slice(0, 500) : classErr && typeof classErr === 'object' ? str((classErr as Record<string, unknown>).message)?.slice(0, 500) ?? 'recorded' : null,
      importMeta: meta.import ?? null,
      ingest: meta.ingest ?? null,
    },
    runs,
    jobs,
    calls: { ok: ok.length, okRanges, notOk },
    facts,
    pages: { empty: Number(pages?.empty ?? 0), ocr: Number(pages?.ocr ?? 0), thin: Number(pages?.thin ?? 0) },
    citedRanges: pagesToRanges(citedPagesOf(documentId)),
    locks,
  });
}

/** The evidence kept before the first repair (`metadata_json.coverage.legacy`), or null. */
export function storedEvidence(documentId: string): ExtractionEvidence | null {
  const doc = db().select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc) return null;
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const cov = meta.coverage && typeof meta.coverage === 'object' ? (meta.coverage as Record<string, unknown>) : null;
  if (!cov?.legacy) return null;
  const r = extractionEvidence.safeParse(cov.legacy);
  return r.success ? r.data : null;
}

/** Patch keys of `metadata_json.coverage` (never the whole object), in one synchronous read-modify-write. */
function patchCoverage(documentId: string, patch: Partial<DocumentCoverage>): void {
  db().transaction((tx) => {
    const cur = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!cur) return;
    const meta = mergeCoverageMeta(parseJson<Record<string, unknown>>(cur.metadataJson, {}), patch);
    tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  });
}

/** Documents whose reading is unfinished or failed, as far as the rows say. */
export function documentsWithUnfinishedExtraction(): string[] {
  return db()
    .all<{ id: string }>(sql`
      select d.id from documents d
      where d.deleted_at is null
        and (d.extraction_status in ('queued', 'running', 'failed', 'partial')
             or exists (select 1 from extraction_runs r where r.document_id = d.id and r.status in ('running', 'failed', 'interrupted', 'partial', 'cancelled')))
      order by d.created_at`)
    .map((r) => r.id);
}

/**
 * Step 2 of the after-unlock sequence: for every document with an unfinished or failed reading that has no evidence
 * kept yet, keep it (`coverage.legacy`) and write an audit row with counts. Never throws; returns how many were kept.
 */
export function captureEvidenceBeforeRepair(): number {
  let kept = 0;
  let ids: string[] = [];
  try {
    ids = documentsWithUnfinishedExtraction();
  } catch (err) {
    console.warn(`[extraction] evidence: could not list documents: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  for (const id of ids) {
    try {
      if (storedEvidence(id)) continue;
      const ev = captureEvidence(id, 'before_repair');
      patchCoverage(id, { legacy: ev });
      writeAudit({
        action: 'ingest_evidence',
        entityType: 'documents',
        entityId: id,
        summary: `reading evidence kept before repair: ${ev.runs.length} runs (${ev.runs.filter((r) => r.status === 'running').length} left running), ${ev.jobs.length} jobs, ${ev.calls.ok} calls ok, ${ev.calls.notOk.length} not ok; status ${ev.document.extractionStatus}`,
      });
      kept++;
    } catch (err) {
      console.warn(`[extraction] evidence for ${id} not kept: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return kept;
}

export interface RepairResult {
  runsInterrupted: number;
  segmentsReset: number;
  documentsSettled: number;
  /** Reading jobs queued before the resumable engine, turned into "carry on, under the ceiling". */
  jobsConverted: number;
}

/**
 * Step 3: the repair, after the evidence. Runs left `running` become `interrupted`; segments left `running` go back to
 * `pending` (their attempt was never counted); a document left `running` with no extraction job queued or running gets
 * `partial` when it holds details, else `failed`. Jobs left running are re-queued by the worker as it starts (their
 * attempt given back). Never throws.
 */
export function repairInterruptedExtraction(): RepairResult {
  const out: RepairResult = { runsInterrupted: 0, segmentsReset: 0, documentsSettled: 0, jobsConverted: 0 };
  const now = nowIso();
  try {
    out.runsInterrupted = db()
      .update(schema.extractionRuns)
      .set({ status: 'interrupted', finishedAt: now, error: 'stopped by a lock or a restart before it finished' })
      .where(eq(schema.extractionRuns.status, 'running'))
      .run().changes;
  } catch (err) {
    console.warn(`[extraction] repair of runs: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    out.segmentsReset = db()
      .update(schema.documentSegments)
      .set({ status: 'pending', updatedAt: now })
      .where(and(eq(schema.documentSegments.status, 'running'), isNull(schema.documentSegments.supersededAt)))
      .run().changes;
  } catch (err) {
    console.warn(`[extraction] repair of segments: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // Readings queued or stopped before the resumable engine existed carry on what is missing, under the user's ceiling
    // (ai.autoResumeCeilingUsd: above it Claude asks once), instead of starting again at page 1.
    const old = db()
      .select({ id: schema.jobs.id, payloadJson: schema.jobs.payloadJson })
      .from(schema.jobs)
      .where(and(inArray(schema.jobs.type, ['extract_facts', 'resume_extraction']), inArray(schema.jobs.status, ['queued', 'running'])))
      .all();
    for (const j of old) {
      const p = parseJson<Record<string, unknown>>(j.payloadJson, {});
      if (p.scope || p.runId) continue;
      db().update(schema.jobs).set({ payloadJson: JSON.stringify({ ...p, scope: 'missing', reason: 'unlock', ceilingCheck: true }) }).where(eq(schema.jobs.id, j.id)).run();
      out.jobsConverted++;
    }
  } catch (err) {
    console.warn(`[extraction] repair of old reading jobs: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const stuck = db()
      .all<{ id: string; facts: number }>(sql`
        select d.id, (select count(*) from facts f where f.source_document_id = d.id and f.deleted_at is null) as facts
        from documents d
        where d.deleted_at is null and d.extraction_status = 'running'
          and not exists (select 1 from jobs j where j.document_id = d.id and j.type in ('extract_facts', 'resume_extraction') and j.status in ('queued', 'running'))`);
    for (const s of stuck) {
      db().update(schema.documents).set({ extractionStatus: s.facts > 0 ? 'partial' : 'failed', updatedAt: now }).where(and(eq(schema.documents.id, s.id), eq(schema.documents.extractionStatus, 'running'))).run();
      out.documentsSettled++;
    }
  } catch (err) {
    console.warn(`[extraction] repair of document statuses: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy coverage (D.5 step 4)
// ---------------------------------------------------------------------------

/**
 * The coverage of a document read before segments existed, written to `metadata_json.coverage` (computed fields only;
 * `legacy`, `resume` and `report` are kept). Nothing is written for a document that has live segments (their coverage
 * is the segments service's) or that is gone; returns what was written, or null.
 */
export function writeLegacyCoverage(documentId: string): DocumentCoverage | null {
  const d = db();
  const doc = d.select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc) return null;
  const segs = d.get<{ n: number }>(sql`select count(*) as n from document_segments where document_id = ${documentId} and superseded_at is null`)?.n ?? 0;
  if (segs > 0) return null;
  const cov = computeLegacyCoverageFor(documentId, doc.pageCount);
  patchCoverage(documentId, cov);
  return cov;
}

/** The legacy coverage worked out now, not written. */
export function computeLegacyCoverageFor(documentId: string, pageCount?: number): DocumentCoverage {
  const pages = coveragePagesOf(documentId);
  const info = legacyReadInfo(documentId, pages);
  const total = Math.max(pageCount ?? 0, pages.length ? pages[pages.length - 1].pageNumber : 0);
  return computeLegacyCoverage({ pagesTotal: total, pages, readRanges: info.readRanges, citedPages: citedPagesOf(documentId), runId: info.latestRunId, at: nowIso() });
}

/** Documents with page rows, no live segments and no valid coverage yet (the backfill's work list). */
export function documentsWithoutCoverage(): string[] {
  const rows = db().all<{ id: string; meta: string }>(sql`
    select d.id, d.metadata_json as meta from documents d
    where d.deleted_at is null
      and exists (select 1 from document_pages p where p.document_id = d.id)
      and not exists (select 1 from document_segments s where s.document_id = d.id and s.superseded_at is null)`);
  return rows.filter((r) => !parseCoverage(parseJson<Record<string, unknown>>(r.meta, {}))).map((r) => r.id);
}

/** Step 4: legacy coverage for every document without any. Never throws; returns how many were written. */
export function backfillLegacyCoverage(): number {
  let n = 0;
  let ids: string[] = [];
  try {
    ids = documentsWithoutCoverage();
  } catch (err) {
    console.warn(`[extraction] coverage backfill: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  for (const id of ids) {
    try {
      if (writeLegacyCoverage(id)) n++;
    } catch (err) {
      console.warn(`[extraction] coverage backfill for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return n;
}
