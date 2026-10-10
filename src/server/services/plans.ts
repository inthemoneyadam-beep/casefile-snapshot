/**
 * The Plan page (2026-10-09): a plan document dropped into Plan is stored as a document (the normal upload path, its
 * original encrypted in the file store, marked `metadata_json.plan`), then read by Claude into a framework: the
 * `plans` row and its `plan_items` (migration 0006). Tabs on the page: the framework (an outline), a checklist, a
 * timeline and the original with the cited passages marked.
 *
 * Rules kept here:
 * - One current plan. A new plan becomes current when its reading ends; the plan it replaces is "superseded", kept and
 *   viewable with its checklist. Checklist state never carries over by itself: the new plan lists the items that look
 *   the same as finished ones in the old plan, and one click ("Mark them") marks them, each saying where it came from.
 * - The plan's own text is never changed. A person's edit of an item (title, who, when) is kept beside the plan's
 *   wording (detail_json.asWritten, "As written: ..."); a reading again in place happens only while nobody worked on
 *   the plan, otherwise it reads into a new plan that replaces this one.
 * - Every item's citations (page and quote) are verified against the page text; one not found is kept and flagged,
 *   never dropped.
 * - Reading costs are estimated first. A reading the upload starts runs by itself under the per-document limit
 *   (ai.autoResumeCeilingUsd); above it Claude asks once. "Read it again" is a person's own action after the estimate.
 * - A document held back as "May be someone else's record" is never read and its plan never shown; "It's mine"
 *   carries the reading on.
 */
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { aiEnabled, AiRefusedError, callStructured, estimateUsd as usageUsd, getApiKey, type Usage } from '../ai/client';
import { isVerifiedMatch, locateCitation, storedMatchKind } from '../ai/citations';
import { PLAN_SYSTEM_PROMPT, buildPlanUserMessage } from '../ai/prompts/plan';
import { visualPageText } from '../ingest/reflow';
import { detectKind } from '../ingest/detect';
import { createDocuments, onDocumentDeletedOrRestored, type UploadFile } from './documents';
import { heldBeforeJob } from './patient-check';
import { heldState } from './patient-check-state';
import { getSetting } from './settings';
import { createTask, type TaskListItem } from './tasks';
import { enqueueJob, JobCancelledError, type JobContext } from '../jobs/queue';
import { badRequest, conflict, notFound, parseOrThrow } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { parsePartialDate } from '../../shared/dates';
import { LONG_TEXT_MAX, MODEL_PRICES } from '../../shared/constants';
import { TASK_OWNERS, TASK_PRIORITIES } from '../../shared/enums';
import {
  PLAN_ITEM_STATUSES,
  PLAN_SCHEMA_VERSION,
  carryOverMatches,
  isActionable,
  planKindWords,
  planItemStatusWords,
  planProgress,
  planReadOutput,
  progressWords,
  type PlanCitation,
  type PlanFramework,
  type PlanItemDetailJson,
  type PlanItemOutput,
  type PlanProgress,
  type PlanReadOutput,
  type PlanReading,
  type PlanStatus,
  type PlanUserField,
} from '../../shared/plan';

export type PlanRow = typeof schema.plans.$inferSelect;
export type PlanItemRow = typeof schema.planItems.$inferSelect;
type DocumentRow = typeof schema.documents.$inferSelect;

/** The kinds of file a plan may be: what the reading can see. */
export const PLAN_FILE_KINDS: ReadonlySet<string> = new Set(['pdf', 'docx', 'text', 'image']);
/** One call reads up to this many characters of the plan; a longer plan is read in a few calls, page by page. */
export const PLAN_CALL_CHARS = 60_000;
/** The prompt's own size, in tokens, for the estimate. */
const SYSTEM_TOKENS = 1_400;
/** How long a reading waits for the upload's pages to be stored before it gives up. */
const PAGES_WAIT_MS = 20 * 60 * 1000;
const STATUS_HISTORY_MAX = 20;
const PLAN_HISTORY_MAX = 30;
const CITATIONS_MAX = 6;

const STORING_JOBS = ['ingest_document', 'reingest_document', 'segment_document'];
const READY_TEXT = new Set(['extracted', 'ocr_done', 'failed', 'ocr_needed']);

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function frameworkOf(p: Pick<PlanRow, 'frameworkJson'>): PlanFramework {
  return parseJson<PlanFramework>(p.frameworkJson, {});
}
function itemDetailOf(i: Pick<PlanItemRow, 'detailJson'>): PlanItemDetailJson {
  return parseJson<PlanItemDetailJson>(i.detailJson, {});
}
function citationsOf(i: Pick<PlanItemRow, 'citationsJson'>): PlanCitation[] {
  const list = parseJson<unknown>(i.citationsJson, []);
  return Array.isArray(list) ? (list as PlanCitation[]).filter((c) => c && typeof c.page === 'number' && typeof c.quote === 'string') : [];
}

function documentOf(id: string | null | undefined): DocumentRow | null {
  if (!id) return null;
  return db().select().from(schema.documents).where(eq(schema.documents.id, id)).get() ?? null;
}

/** A plan is shown only while it is not removed and its document is live (a held or deleted document hides it). */
function livePlanOr404(id: string): { plan: PlanRow; doc: DocumentRow | null } {
  const plan = db().select().from(schema.plans).where(and(eq(schema.plans.id, id), isNull(schema.plans.deletedAt))).get();
  if (!plan) throw notFound('plan not found');
  const doc = documentOf(plan.documentId);
  if (plan.documentId && (!doc || doc.deletedAt)) throw notFound('plan not found');
  return { plan, doc };
}

function liveItemOr404(id: string): { item: PlanItemRow; plan: PlanRow; doc: DocumentRow | null } {
  const item = db().select().from(schema.planItems).where(and(eq(schema.planItems.id, id), isNull(schema.planItems.deletedAt))).get();
  if (!item) throw notFound('plan item not found');
  const { plan, doc } = livePlanOr404(item.planId);
  return { item, plan, doc };
}

function pushHistory(f: PlanFramework, what: string, by: string | null | undefined): PlanFramework {
  const history = [...(f.history ?? []), { at: nowIso(), by: by ?? null, what }].slice(-PLAN_HISTORY_MAX);
  return { ...f, history };
}

function writeFramework(planId: string, f: PlanFramework, extra: Partial<typeof schema.plans.$inferInsert> = {}): void {
  db().update(schema.plans).set({ frameworkJson: JSON.stringify(f), updatedAt: nowIso(), ...extra }).where(eq(schema.plans.id, planId)).run();
}

function setReading(planId: string, patch: Partial<PlanReading> & { state: PlanReading['state'] }): PlanReading {
  const plan = db().select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
  if (!plan) throw notFound('plan not found');
  const f = frameworkOf(plan);
  const reading: PlanReading = { ...(f.reading ?? { state: 'waiting', at: nowIso() }), ...patch, at: nowIso() };
  if (patch.state !== 'failed' && patch.state !== 'ai_off' && patch.error === undefined) reading.error = null;
  writeFramework(planId, { ...f, reading });
  return reading;
}

/** True while a reading job for this plan is waiting or running. */
function activeReadingJob(planId: string): string | null {
  const rows = db()
    .select({ id: schema.jobs.id, payloadJson: schema.jobs.payloadJson })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'read_plan'), inArray(schema.jobs.status, ['queued', 'running'])))
    .all();
  return rows.find((r) => parseJson<{ planId?: string }>(r.payloadJson, {}).planId === planId)?.id ?? null;
}

/**
 * The reading as the page shows it: a reading that says it waits or runs while no job does (a job cancelled under
 * Jobs, a crash) has stopped, and says so.
 */
export function effectiveReading(plan: Pick<PlanRow, 'id' | 'frameworkJson'>): PlanReading | null {
  const r = frameworkOf(plan).reading ?? null;
  if (r && (r.state === 'waiting' || r.state === 'reading') && !activeReadingJob(plan.id)) {
    return { ...r, state: 'failed', error: 'the reading stopped before it finished' };
  }
  return r;
}

function aiUsable(): boolean {
  try {
    return aiEnabled() && Boolean(getApiKey());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pages, the estimate and the calls
// ---------------------------------------------------------------------------

interface PlanPage {
  pageNumber: number;
  text: string;
  /** The page rebuilt in reading order from its line boxes, when it has them. */
  reading: string | null;
  charCount: number;
}

function loadPages(documentId: string): PlanPage[] {
  return db()
    .select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text, boxesJson: schema.documentPages.boxesJson, charCount: schema.documentPages.charCount })
    .from(schema.documentPages)
    .where(eq(schema.documentPages.documentId, documentId))
    .orderBy(asc(schema.documentPages.pageNumber))
    .all()
    .map((p) => {
      // The reading order is rebuilt from the line boxes only when something asks for it (a GET re-checks citations).
      let reading: string | null | undefined;
      return {
        pageNumber: p.pageNumber,
        text: p.text,
        charCount: p.charCount,
        get reading(): string | null {
          if (reading === undefined) reading = visualPageText(p);
          return reading;
        },
      };
    });
}

/** The text the model reads of a page: the reading order when the page has line boxes, else the stored text. */
function readText(p: PlanPage): string {
  return (p.reading ?? p.text).trim();
}

/** Consecutive pages share a call up to PLAN_CALL_CHARS; a page longer than that is a call of its own. */
export function planCalls<T extends { text: string }>(pages: T[], max = PLAN_CALL_CHARS): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const p of pages) {
    const n = p.text.length;
    if (cur.length && chars + n > max) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface PlanEstimate {
  pages: number;
  chars: number;
  calls: number;
  estimateUsd: number;
  ceilingUsd: number;
  aboveCeiling: boolean;
  model: string;
}

/**
 * About what reading a plan costs: per call the prompt and the pages in (3 characters a token), and out the items with
 * their quotes (about a third of the pages again, at least 2,000 tokens) plus medium thinking (2,000 tokens).
 */
export function estimatePlanCost(callChars: number[], model: string): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  let usdTotal = 0;
  for (const chars of callChars) {
    const input = SYSTEM_TOKENS + 400 + chars / 3;
    const output = Math.min(32_000, Math.max(2_000, chars / 3.5) + 2_000);
    usdTotal += (input * p.input + output * p.output) / 1_000_000;
  }
  return Math.round(usdTotal * 10_000) / 10_000;
}

function readingModel(): string {
  return getSetting('ai.models.standard');
}

function ceiling(): number {
  const v = Number(getSetting('ai.autoResumeCeilingUsd'));
  return Number.isFinite(v) && v >= 0 ? v : 50;
}

export function estimateForDocument(documentId: string): PlanEstimate {
  const pages = loadPages(documentId).map((p) => ({ pageNumber: p.pageNumber, text: readText(p) })).filter((p) => p.text.length > 0);
  const calls = planCalls(pages);
  const model = readingModel();
  const estimateUsd = estimatePlanCost(calls.map((c) => c.reduce((n, p) => n + p.text.length, 0)), model);
  const ceilingUsd = ceiling();
  return { pages: pages.length, chars: pages.reduce((n, p) => n + p.text.length, 0), calls: calls.length, estimateUsd, ceilingUsd, aboveCeiling: estimateUsd > ceilingUsd, model };
}

export function estimateReading(planId: string): PlanEstimate {
  const { plan } = livePlanOr404(planId);
  if (!plan.documentId) throw badRequest('this plan has no document to read');
  return estimateForDocument(plan.documentId);
}

export interface PlanCallRequest {
  system: string;
  user: string;
  documentId: string;
  title: string;
  part: number;
  parts: number;
  pages: [number, number];
  jobId?: string | null;
  signal?: AbortSignal;
}
export type PlanCaller = (req: PlanCallRequest) => Promise<{ data: PlanReadOutput; model: string; callId: string | null; usage?: Partial<Usage> | null }>;

export const defaultPlanCaller: PlanCaller = async (req) => {
  const r = await callStructured({
    purpose: 'read_plan',
    model: readingModel(),
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    schema: planReadOutput,
    documentIds: [req.documentId],
    jobId: req.jobId ?? null,
    maxTokens: 32_000,
    // A plan is short and its structure (branches, conditions) needs some reasoning: medium, not low.
    effort: 'medium',
    requestSummary: `read plan: ${req.title.slice(0, 80)} p.${req.pages[0]}-${req.pages[1]}`,
    signal: req.signal,
  });
  return { data: r.data, model: r.model, callId: r.callId, usage: r.usage };
};

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Find each quote on its page (or the page either side); one not found is kept, flagged, never dropped. */
export function verifyPlanCitations(pages: Map<number, PlanPage>, cites: ReadonlyArray<{ page: number; quote: string }>): Array<PlanCitation & { pageChars?: number }> {
  const out: Array<PlanCitation & { pageChars?: number }> = [];
  for (const c of cites) {
    const quote = (c.quote ?? '').trim();
    const page = Number.isInteger(c.page) && c.page > 0 ? c.page : 1;
    if (!quote) continue;
    let found = locateCitation((n) => pages.get(n)?.text, page, quote);
    let offsets = true;
    if (!isVerifiedMatch(found)) {
      const inReading = locateCitation((n) => pages.get(n)?.reading ?? undefined, page, quote);
      if (inReading && isVerifiedMatch(inReading)) {
        found = inReading;
        offsets = false;
      }
    }
    const at = found?.page ?? page;
    out.push({
      page: at,
      quote: quote.slice(0, 1000),
      verified: isVerifiedMatch(found),
      matchKind: storedMatchKind(found),
      start: offsets && found ? found.start : null,
      end: offsets && found ? found.end : null,
      pageChars: pages.get(at)?.charCount,
    });
  }
  return out;
}

/**
 * The citations as they stand now: a citation checked against a page whose text has since changed (an OCR append, a
 * re-ingest) is checked again; the rest are as stored.
 */
function freshCitations(item: Pick<PlanItemRow, 'citationsJson'>, pages: () => Map<number, PlanPage>): PlanCitation[] {
  const stored = citationsOf(item) as Array<PlanCitation & { pageChars?: number }>;
  return stored.map((c) => {
    const page = pages().get(c.page);
    if (page && c.pageChars === page.charCount) return stripChars(c);
    const [again] = verifyPlanCitations(pages(), [{ page: c.page, quote: c.quote }]);
    return again ? stripChars(again) : { ...stripChars(c), verified: false, matchKind: 'none', start: null, end: null };
  });
}

function stripChars(c: PlanCitation & { pageChars?: number }): PlanCitation {
  const { pageChars: _pageChars, ...rest } = c;
  return rest;
}

function pageMap(documentId: string | null | undefined): () => Map<number, PlanPage> {
  let cache: Map<number, PlanPage> | null = null;
  return () => {
    if (!cache) cache = new Map(documentId ? loadPages(documentId).map((p) => [p.pageNumber, p]) : []);
    return cache;
  };
}

// ---------------------------------------------------------------------------
// Turning the model's answer into rows
// ---------------------------------------------------------------------------

export interface DraftItem {
  id: string;
  parentId: string | null;
  seq: number;
  kind: string;
  title: string;
  detail: string | null;
  owner: string | null;
  due: string | null;
  duePrecision: string;
  dueText: string | null;
  condition: string | null;
  citations: Array<PlanCitation & { pageChars?: number }>;
  detailJson: PlanItemDetailJson;
}

const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/**
 * The items of every call, in order, as rows: refs are made unique per call; a parent named that is not an earlier item
 * (unknown, itself, or later) puts the item at the top, so the outline can never loop. Seq counts siblings from 0.
 */
export function draftItems(parts: Array<{ items: PlanItemOutput[] }>, pages: Map<number, PlanPage>): DraftItem[] {
  const out: DraftItem[] = [];
  const idOfRef = new Map<string, string>();
  const nextSeq = new Map<string, number>();
  parts.forEach((part, pi) => {
    for (const it of part.items) {
      const title = clean(it.title, 500) ?? clean(it.detail, 200);
      if (!title) continue;
      const key = `${pi}:${(it.ref ?? '').trim()}`;
      const parentKey = it.parent_ref != null && it.parent_ref.trim() ? `${pi}:${it.parent_ref.trim()}` : null;
      const parentId = parentKey && parentKey !== key ? (idOfRef.get(parentKey) ?? null) : null;
      const id = newId();
      if (it.ref && !idOfRef.has(key)) idOfRef.set(key, id);
      const sibling = parentId ?? '';
      const seq = nextSeq.get(sibling) ?? 0;
      nextSeq.set(sibling, seq + 1);
      const date = parsePartialDate(clean(it.date, 64));
      // The plan's words for when; a printed date not already in them is kept beside them (as written), so a date
      // that does not read as a calendar date ("2/15") is never lost (review 2026-10-09).
      const words = clean(it.timing, 300);
      const timing = words && date.text && !words.toLowerCase().includes(date.text.toLowerCase()) ? `${words} (${date.text})`.slice(0, 300) : words;
      out.push({
        id,
        parentId,
        seq,
        kind: it.kind,
        title,
        detail: clean(it.detail, 4000),
        owner: clean(it.owner, 200),
        due: date.iso,
        duePrecision: date.iso ? date.precision : 'unknown',
        dueText: timing ?? (date.text ? date.text.slice(0, 300) : null),
        condition: clean(it.condition, 500),
        citations: verifyPlanCitations(pages, (it.citations ?? []).slice(0, CITATIONS_MAX)),
        detailJson: { ref: it.ref, actionable: it.kind === 'section' ? false : Boolean(it.actionable) },
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The reading job
// ---------------------------------------------------------------------------

export interface ReadPlanPayload {
  planId?: string;
  /** A person said yes to the estimate (it may be above the per-document limit). */
  confirm?: boolean;
}

export interface ReadPlanResult {
  state: PlanReading['state'] | 'skipped';
  items?: number;
  calls?: number;
  reason?: string;
  /** The plan the reading went into, when it is not the one read (its checklist was worked on meanwhile). */
  planId?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JobCancelledError('stopped'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new JobCancelledError('stopped'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The upload's pages are stored: its text step ended and nothing is storing or cutting it any more. */
export function pagesReady(documentId: string): boolean {
  const doc = documentOf(documentId);
  // Gone, deleted or held back: nothing more will be stored; the reading says why next.
  if (!doc || doc.deletedAt) return true;
  if (!READY_TEXT.has(doc.textStatus)) return false;
  const busy = db()
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, documentId), inArray(schema.jobs.type, STORING_JOBS), inArray(schema.jobs.status, ['queued', 'running'])))
    .get();
  return !busy;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureWords(err: unknown): string {
  if (err instanceof AiRefusedError) return 'Claude declined to read it';
  const m = messageOf(err);
  if (/NoApiKey/i.test(m)) return 'no API key is set (Settings)';
  if (/AiDisabled/i.test(m)) return 'Claude is switched off (Settings)';
  if (/max_tokens/i.test(m)) return 'the plan was too long for one answer';
  if (/did not match the schema/i.test(m)) return "Claude's answer could not be read";
  return m.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Job `read_plan` (lane ai): waits for the upload's pages, checks the patient on them (a held document is never
 * read), prices the reading, asks once above the per-document limit, then reads the plan in one call (a long plan in
 * a few, page by page) and writes its items in one transaction. Failures are said in plain words on the plan and
 * never retried by the queue (a person presses Read it again); a lock or a stop leaves the job to the queue.
 */
export async function readPlanJob(ctx: JobContext<ReadPlanPayload>, opts: { call?: PlanCaller; waitMs?: number; pollMs?: number } = {}): Promise<ReadPlanResult> {
  const planId = ctx.payload.planId;
  if (!planId) throw new Error('read_plan job has no planId');
  const call = opts.call ?? defaultPlanCaller;
  const owned = () => ctx.stillOwned?.() ?? true;
  const plan0 = db().select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
  if (!plan0 || plan0.deletedAt || !plan0.documentId) return { state: 'skipped', reason: 'the plan is not there any more' };
  const documentId = plan0.documentId;

  // 1. The pages.
  const started = Date.now();
  const waitMs = opts.waitMs ?? PAGES_WAIT_MS;
  if (!pagesReady(documentId)) setReading(planId, { state: 'waiting', jobId: ctx.job.id });
  while (!pagesReady(documentId)) {
    if (Date.now() - started > waitMs) {
      setReading(planId, { state: 'failed', error: 'the pages were not stored in time; read it again in a while', jobId: ctx.job.id });
      return { state: 'failed', reason: 'pages not ready' };
    }
    await sleep(opts.pollMs ?? 1000, ctx.signal);
  }

  // 2. The patient on the pages (the wrong-patient guard), after they are stored.
  const doc = documentOf(documentId);
  if (doc?.deletedAt && heldState(doc) === 'quarantined') {
    if (owned()) setReading(planId, { state: 'held', jobId: ctx.job.id });
    return { state: 'held' };
  }
  if (!doc || doc.deletedAt) {
    if (owned()) setReading(planId, { state: 'failed', error: "the plan's document was deleted", jobId: ctx.job.id });
    return { state: 'failed', reason: 'document deleted' };
  }
  if (heldBeforeJob(documentId, 'read_plan')) {
    if (owned()) setReading(planId, { state: 'held', jobId: ctx.job.id });
    return { state: 'held' };
  }

  // 3. The text and the estimate.
  const pages = loadPages(documentId);
  const readable = pages.map((p) => ({ pageNumber: p.pageNumber, text: readText(p) })).filter((p) => p.text.length >= 1);
  const chars = readable.reduce((n, p) => n + p.text.length, 0);
  if (chars < 20) {
    if (owned()) setReading(planId, { state: 'no_text', pages: pages.length, chars, jobId: ctx.job.id });
    return { state: 'no_text' };
  }
  const groups = planCalls(readable);
  const model = readingModel();
  const estimate = estimatePlanCost(groups.map((g) => g.reduce((n, p) => n + p.text.length, 0)), model);
  const ceilingUsd = ceiling();
  const base = { pages: pages.length, chars, calls: groups.length, estimateUsd: estimate, ceilingUsd, model, jobId: ctx.job.id };
  if (!ctx.payload.confirm && estimate > ceilingUsd) {
    setReading(planId, { state: 'ask', ...base });
    return { state: 'ask', calls: groups.length };
  }
  if (!opts.call && !aiUsable()) {
    setReading(planId, { state: 'ai_off', ...base, error: aiEnabled() ? 'there is no API key (Settings), so the plan was not read' : 'Claude is switched off (Settings), so the plan was not read' });
    return { state: 'ai_off' };
  }

  // 4. The calls.
  setReading(planId, { state: 'reading', ...base, startedAt: nowIso() });
  const answers: PlanReadOutput[] = [];
  const callIds: string[] = [];
  let cost = 0;
  let usedModel = model;
  try {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      ctx.setProgress(i / groups.length, groups.length > 1 ? `reading the plan, part ${i + 1} of ${groups.length}` : 'reading the plan');
      const r = await call({
        system: PLAN_SYSTEM_PROMPT,
        user: buildPlanUserMessage({ title: doc.title, pages: g, totalPages: pages.length, part: i + 1, parts: groups.length, documentDateText: doc.documentDateText }),
        documentId,
        title: doc.title,
        part: i + 1,
        parts: groups.length,
        pages: [g[0].pageNumber, g[g.length - 1].pageNumber],
        jobId: ctx.job.id,
        signal: ctx.signal,
      });
      answers.push(r.data);
      if (r.callId) callIds.push(r.callId);
      usedModel = r.model || usedModel;
      if (r.usage) cost += usageUsd(r.model, { inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0, cacheReadTokens: r.usage.cacheReadTokens ?? 0, cacheWriteTokens: r.usage.cacheWriteTokens ?? 0 });
    }
  } catch (err) {
    if (ctx.signal.aborted || !owned()) throw err;
    setReading(planId, { state: 'failed', ...base, callIds, costUsd: cost, error: failureWords(err), finishedAt: nowIso() });
    return { state: 'failed', reason: failureWords(err) };
  }
  if (ctx.signal.aborted || !owned()) throw new JobCancelledError('stopped');

  // 5. One transaction: the items, the plan, and the plan it replaces.
  const pageIndex = new Map(pages.map((p) => [p.pageNumber, p]));
  const drafts = draftItems(answers, pageIndex);
  const written = writeReading(planId, answers, drafts, { ...base, model: usedModel, callIds, costUsd: Math.round(cost * 10_000) / 10_000 });
  ctx.setProgress(1, `${drafts.length} items read`);
  if (!written) return { state: 'skipped', reason: 'the plan or its document was removed while it was read' };
  return { state: 'done', items: drafts.length, calls: groups.length, ...(written !== planId ? { planId: written } : {}) };
}

/**
 * Writes a finished reading; null (nothing written) when the plan or its document went away meanwhile, else the id of
 * the plan written: the plan itself, or a new plan from the same document when someone worked on this one's checklist
 * while it was read again in place (its checklist is never replaced; review 2026-10-09).
 */
function writeReading(readId: string, answers: PlanReadOutput[], drafts: DraftItem[], reading: Partial<PlanReading>): string | null {
  const d = db();
  let ok: string | null = null;
  let planId = readId;
  d.transaction((tx) => {
    let plan = tx.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
    if (!plan || plan.deletedAt) return;
    const doc = plan.documentId ? tx.select().from(schema.documents).where(eq(schema.documents.id, plan.documentId)).get() : null;
    if (plan.documentId && (!doc || doc.deletedAt)) return;
    const now = nowIso();
    if (plan.status !== 'draft' && hasUserWork(planId)) {
      // Someone checked, changed or linked an item while Claude read the plan again: this plan stays as it is (its
      // reading back to done) and the reading becomes a new plan from the same document, which replaces it.
      const by = frameworkOf(plan).reading?.by ?? null;
      const old = frameworkOf(plan);
      const kept = pushHistory({ ...old, reading: { ...(old.reading ?? { at: now }), state: 'done', at: now, error: null } }, 'read again into a new plan: its checklist was worked on while it was read', by);
      tx.update(schema.plans).set({ frameworkJson: JSON.stringify(kept), updatedAt: now }).where(eq(schema.plans.id, planId)).run();
      const freshId = newId();
      const fresh = pushHistory({ reading: { state: 'reading', at: now, by } }, 'added (read again from the same document)', by);
      tx.insert(schema.plans)
        .values({ id: freshId, documentId: plan.documentId, title: plan.title, status: 'draft', frameworkJson: JSON.stringify(fresh), createdBy: by, createdAt: now, updatedAt: now })
        .run();
      if (plan.documentId) markDocumentAsPlan(plan.documentId, freshId);
      planId = freshId;
      plan = tx.select().from(schema.plans).where(eq(schema.plans.id, freshId)).get()!;
    }
    // A reading again in place replaces the items nobody worked on (requestReading reads into a new plan otherwise).
    tx.update(schema.planItems).set({ deletedAt: now, updatedAt: now }).where(and(eq(schema.planItems.planId, planId), isNull(schema.planItems.deletedAt))).run();
    for (const it of drafts) {
      tx.insert(schema.planItems)
        .values({
          id: it.id,
          planId,
          parentId: it.parentId,
          seq: it.seq,
          kind: it.kind,
          title: it.title,
          detail: it.detail,
          owner: it.owner,
          due: it.due,
          duePrecision: it.duePrecision,
          dueText: it.dueText,
          condition: it.condition,
          status: 'open',
          citationsJson: JSON.stringify(it.citations),
          detailJson: JSON.stringify(it.detailJson),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    const first = answers[0];
    const readTitle = clean(first?.title, 300);
    const f = frameworkOf(plan);
    const renamed = f.asWrittenTitle !== undefined && f.asWrittenTitle !== null;
    const date = parsePartialDate(clean(answers.find((a) => clean(a.plan_date, 64))?.plan_date, 64));
    const summary = answers.map((a) => clean(a.summary, 1000)).find(Boolean) ?? null;
    const cites = drafts.reduce((n, it) => n + it.citations.length, 0);
    const unverified = drafts.reduce((n, it) => n + it.citations.filter((c) => !c.verified).length, 0);
    let next: PlanFramework = {
      ...f,
      ...(renamed && readTitle ? { asWrittenTitle: readTitle } : {}),
      reading: { ...(f.reading ?? { state: 'done', at: now }), ...reading, state: 'done', at: now, finishedAt: now, items: drafts.length, citations: cites, unverified, error: null },
    };
    let status = plan.status as PlanStatus;
    if (status === 'draft') {
      status = 'current';
      // One current plan: the one it replaces is kept, superseded, with its checklist.
      const others = tx
        .select()
        .from(schema.plans)
        .where(and(eq(schema.plans.status, 'current'), isNull(schema.plans.deletedAt), sql`${schema.plans.id} <> ${planId}`))
        .orderBy(desc(schema.plans.updatedAt))
        .all();
      const previous = others.find((o) => {
        const od = o.documentId ? tx.select({ deletedAt: schema.documents.deletedAt }).from(schema.documents).where(eq(schema.documents.id, o.documentId)).get() : null;
        return !o.documentId || (od && !od.deletedAt);
      });
      for (const o of others) {
        const of = pushHistory({ ...frameworkOf(o), supersededBy: planId, supersededAt: now }, `replaced by "${readTitle ?? plan.title}"`, reading.by ?? null);
        tx.update(schema.plans).set({ status: 'superseded', frameworkJson: JSON.stringify(of), updatedAt: now }).where(eq(schema.plans.id, o.id)).run();
      }
      if (previous) next = { ...next, carryOver: { fromPlanId: previous.id } };
      next = pushHistory(next, 'read and made the current plan', reading.by ?? null);
    } else {
      next = pushHistory(next, 'read again', reading.by ?? null);
    }
    tx.update(schema.plans)
      .set({
        title: renamed ? plan.title : (readTitle ?? plan.title),
        summary,
        planDate: date.iso,
        planDatePrecision: date.iso ? date.precision : 'unknown',
        planDateText: date.text,
        schemaVersion: PLAN_SCHEMA_VERSION,
        status,
        frameworkJson: JSON.stringify(next),
        updatedAt: now,
      })
      .where(eq(schema.plans.id, planId))
      .run();
    ok = planId;
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Adding a plan
// ---------------------------------------------------------------------------

export interface AddedPlan {
  plan: PlanDetail;
  /** The file was already in the case (no second copy was stored). */
  duplicate: boolean;
  /** The document was already read as a plan: that plan is returned and nothing is read again. */
  existing: boolean;
}

function planKindOk(kind: string): boolean {
  return PLAN_FILE_KINDS.has(kind);
}

const KIND_REFUSAL = 'A plan must be a PDF, a Word file (.docx), a text file or a photo.';

function existingPlanFor(documentId: string): PlanRow | null {
  return db().select().from(schema.plans).where(and(eq(schema.plans.documentId, documentId), isNull(schema.plans.deletedAt))).orderBy(desc(schema.plans.createdAt)).get() ?? null;
}

function markDocumentAsPlan(documentId: string, planId: string): void {
  // json_set so a concurrent writer of another metadata key is never overwritten (one writer per key).
  const value = JSON.stringify({ planId, at: nowIso() });
  db().run(sql`update documents set metadata_json = json_set(case when json_valid(metadata_json) then metadata_json else '{}' end, '$.plan', json(${value})) where id = ${documentId}`);
}

function newPlanRow(doc: DocumentRow, by: string | null): PlanRow {
  const now = nowIso();
  const id = newId();
  const f: PlanFramework = pushHistory({ reading: { state: 'waiting', at: now, by } }, 'added', by);
  db().insert(schema.plans)
    .values({ id, documentId: doc.id, title: doc.title.slice(0, 300), status: 'draft', frameworkJson: JSON.stringify(f), createdBy: by, createdAt: now, updatedAt: now })
    .run();
  markDocumentAsPlan(doc.id, id);
  return db().select().from(schema.plans).where(eq(schema.plans.id, id)).get()!;
}

function queueRead(planId: string, documentId: string, opts: { confirm?: boolean; by?: string | null }): string {
  const active = activeReadingJob(planId);
  if (active) return active;
  const job = enqueueJob({ type: 'read_plan', payload: { planId, ...(opts.confirm ? { confirm: true } : {}) }, documentId });
  setReading(planId, { state: 'waiting', jobId: job.id, by: opts.by ?? null });
  return job.id;
}

/** "Add a plan": one file, stored like any upload (no details pulled out), then read into a plan. */
export function addPlanFromUpload(files: UploadFile[], opts: { by?: string | null } = {}): AddedPlan {
  if (files.length !== 1) throw badRequest('add one plan file at a time');
  const f = files[0];
  if (!f.buffer.length) throw badRequest(`${f.name || 'the file'} is empty`);
  const { kind } = detectKind(f.name, f.mime, f.buffer.subarray(0, 512));
  if (!planKindOk(kind)) throw badRequest(KIND_REFUSAL);
  // Stored like any upload; its details are not pulled out by themselves (the plan reading reads it; "Read for
  // details" stays on the document like on any other).
  const [up] = createDocuments([f], { autoExtract: false });
  const doc = documentOf(up.id)!;
  if (doc.deletedAt) {
    if (heldState(doc) === 'quarantined') throw conflict("This file is held back as maybe someone else's record. Answer it on the document first.");
    throw conflict('This file is in Deleted documents. Restore it there first.');
  }
  const existing = existingPlanFor(doc.id);
  if (existing) return { plan: getPlan(existing.id), duplicate: Boolean(up.duplicate), existing: true };
  const plan = newPlanRow(doc, opts.by ?? null);
  queueRead(plan.id, doc.id, { by: opts.by ?? null });
  return { plan: getPlan(plan.id), duplicate: Boolean(up.duplicate), existing: false };
}

export const fromDocumentBody = z.object({ documentId: z.string().trim().min(1).max(64) }).strict();

/**
 * What reading a document already in the case as the plan would cost, shown in "Use a document already added" before
 * the pick (its pages are stored, so the cost is known first; review 2026-10-09). A held or deleted document is 404.
 */
export function estimateDocumentAsPlan(documentId: string): PlanEstimate & { existingPlanId: string | null } {
  const doc = documentOf(documentId);
  if (!doc || doc.deletedAt) throw notFound('document not found');
  if (!planKindOk(doc.kind)) throw badRequest(KIND_REFUSAL);
  return { ...estimateForDocument(doc.id), existingPlanId: existingPlanFor(doc.id)?.id ?? null };
}

/** "Use a document already added": a live document read into a plan. */
export function addPlanFromDocument(raw: unknown, opts: { by?: string | null } = {}): AddedPlan {
  const { documentId } = parseOrThrow(fromDocumentBody, raw);
  const doc = documentOf(documentId);
  if (!doc || doc.deletedAt) throw notFound('document not found');
  if (!planKindOk(doc.kind)) throw badRequest(KIND_REFUSAL);
  const existing = existingPlanFor(doc.id);
  if (existing) return { plan: getPlan(existing.id), duplicate: false, existing: true };
  const plan = newPlanRow(doc, opts.by ?? null);
  queueRead(plan.id, doc.id, { by: opts.by ?? null });
  return { plan: getPlan(plan.id), duplicate: false, existing: false };
}

/** Somebody worked on this plan: an item checked, edited, noted, marked from the earlier plan or made a to-do. */
function hasUserWork(planId: string): boolean {
  const items = db().select().from(schema.planItems).where(and(eq(schema.planItems.planId, planId), isNull(schema.planItems.deletedAt))).all();
  return items.some((i) => {
    const dj = itemDetailOf(i);
    return i.status !== 'open' || Boolean(i.note) || Boolean(i.taskId) || Boolean(dj.userFields?.length) || Boolean(dj.carriedFrom);
  });
}

export const readBody = z.object({ confirm: z.boolean().optional() }).strict();

/**
 * "Read it" / "Read it again" (a person's own action, after the estimate): in place while nobody worked on the plan;
 * otherwise into a new plan from the same document, which replaces this one when it is read (its checklist kept here).
 */
export function requestReading(planId: string, raw: unknown, opts: { by?: string | null } = {}): { plan: PlanDetail; jobId: string; newPlan: boolean } {
  const body = parseOrThrow(readBody, raw ?? {});
  const { plan, doc } = livePlanOr404(planId);
  if (!doc) throw badRequest('this plan has no document to read');
  if (activeReadingJob(plan.id)) return { plan: getPlan(plan.id), jobId: activeReadingJob(plan.id)!, newPlan: false };
  const r = frameworkOf(plan).reading;
  const read = r?.state === 'done';
  if (read && hasUserWork(plan.id)) {
    const fresh = newPlanRow(doc, opts.by ?? null);
    const jobId = queueRead(fresh.id, doc.id, { confirm: body.confirm, by: opts.by ?? null });
    return { plan: getPlan(fresh.id), jobId, newPlan: true };
  }
  const jobId = queueRead(plan.id, doc.id, { confirm: body.confirm, by: opts.by ?? null });
  return { plan: getPlan(plan.id), jobId, newPlan: false };
}

/**
 * "It's mine" on a held plan document (or a restore from Deleted documents) carries its reading on: a plan not read
 * yet whose reading is not running, because it was held, or because the hold or the delete stopped it while it waited
 * for the pages. The reading checks the patient and the cost again (above the limit it asks).
 */
onDocumentDeletedOrRestored((documentId, event) => {
  if (event !== 'restored') return;
  const plans = db().select().from(schema.plans).where(and(eq(schema.plans.documentId, documentId), isNull(schema.plans.deletedAt))).all();
  for (const p of plans) {
    const state = frameworkOf(p).reading?.state;
    if (state === 'held' || ((state === 'waiting' || state === 'reading') && !activeReadingJob(p.id))) queueRead(p.id, documentId, { by: null });
  }
});

// ---------------------------------------------------------------------------
// Reading plans
// ---------------------------------------------------------------------------

export interface PlanItemView {
  id: string;
  planId: string;
  parentId: string | null;
  seq: number;
  /** The outline position: "0001.0003" sorts in plan order. */
  order: string;
  depth: number;
  kind: string;
  kindWords: string;
  title: string;
  detail: string | null;
  owner: string | null;
  due: string | null;
  duePrecision: string;
  dueText: string | null;
  condition: string | null;
  status: string;
  statusWords: string;
  doneAt: string | null;
  doneBy: string | null;
  note: string | null;
  actionable: boolean;
  citations: PlanCitation[];
  /** The plan's own wording of each field a person changed. */
  asWritten: PlanItemDetailJson['asWritten'] | null;
  userFields: PlanUserField[];
  task: { id: string; title: string; status: string; dueAt: string | null } | null;
  carriedFrom: (NonNullable<PlanItemDetailJson['carriedFrom']> & { title: string | null; status: string | null; note: string | null }) | null;
  /** A finished item of the plan this one replaced that looks the same ("Mark it the same"). */
  looksLike: { itemId: string; title: string; status: string; doneAt: string | null; doneBy: string | null; note: string | null } | null;
  parentTitle: string | null;
  /** The top-level section or goal it sits under. */
  sectionTitle: string | null;
  childIds: string[];
  updatedAt: string;
}

export interface PlanListItem {
  id: string;
  title: string;
  status: PlanStatus;
  documentId: string | null;
  documentTitle: string | null;
  planDate: string | null;
  planDatePrecision: string;
  planDateText: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  reading: PlanReading | null;
  progress: PlanProgress;
  progressWords: string;
  itemCount: number;
  supersededAt: string | null;
  supersededBy: string | null;
}

export interface PlanDetail extends PlanListItem {
  asWrittenTitle: string | null;
  items: PlanItemView[];
  carryOver: { fromPlanId: string; fromTitle: string | null; matches: number; appliedAt: string | null; applied: number | null; dismissedAt: string | null } | null;
  history: NonNullable<PlanFramework['history']>;
  document: { id: string; title: string; kind: string; mime: string; pageCount: number; documentDate: string | null; documentDatePrecision: string; sourceTier: string } | null;
}

function liveItems(planId: string): PlanItemRow[] {
  return db().select().from(schema.planItems).where(and(eq(schema.planItems.planId, planId), isNull(schema.planItems.deletedAt))).orderBy(asc(schema.planItems.seq), asc(schema.planItems.createdAt)).all();
}

const pad = (n: number) => String(n).padStart(4, '0');

/** Outline order and depth from the parents (an item whose parent is gone sits at the top). */
function outline(items: PlanItemRow[]): Map<string, { order: string; depth: number; top: string }> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const memo = new Map<string, { order: string; depth: number; top: string }>();
  const visit = (i: PlanItemRow, guard: Set<string>): { order: string; depth: number; top: string } => {
    const hit = memo.get(i.id);
    if (hit) return hit;
    const parent = i.parentId ? byId.get(i.parentId) : undefined;
    let r: { order: string; depth: number; top: string };
    if (!parent || guard.has(parent.id)) r = { order: pad(i.seq), depth: 0, top: i.id };
    else {
      guard.add(i.id);
      const p = visit(parent, guard);
      r = { order: `${p.order}.${pad(i.seq)}`, depth: p.depth + 1, top: p.top };
    }
    memo.set(i.id, r);
    return r;
  };
  for (const i of items) visit(i, new Set());
  return memo;
}

function taskInfo(ids: string[]): Map<string, { id: string; title: string; status: string; dueAt: string | null }> {
  if (!ids.length) return new Map();
  return new Map(
    db()
      .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status, dueAt: schema.tasks.dueAt })
      .from(schema.tasks)
      .where(and(inArray(schema.tasks.id, ids), isNull(schema.tasks.deletedAt)))
      .all()
      .map((t) => [t.id, t]),
  );
}

function progressOf(items: PlanItemRow[]): PlanProgress {
  return planProgress(items.map((i) => ({ status: i.status, actionable: isActionable(i.kind, itemDetailOf(i)) })));
}

function toListItem(plan: PlanRow, doc: DocumentRow | null, items: PlanItemRow[]): PlanListItem {
  const f = frameworkOf(plan);
  const progress = progressOf(items);
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status as PlanStatus,
    documentId: plan.documentId,
    documentTitle: doc?.title ?? null,
    planDate: plan.planDate,
    planDatePrecision: plan.planDatePrecision,
    planDateText: plan.planDateText,
    summary: plan.summary,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    createdBy: plan.createdBy,
    reading: effectiveReading(plan),
    progress,
    progressWords: progressWords(progress),
    itemCount: items.length,
    supersededAt: f.supersededAt ?? null,
    supersededBy: f.supersededBy ?? null,
  };
}

/** Every plan that is not removed and whose document is live: the current one first, then the newest. */
export function listPlans(): { items: PlanListItem[]; currentId: string | null } {
  const rows = db().select().from(schema.plans).where(isNull(schema.plans.deletedAt)).orderBy(desc(schema.plans.createdAt)).all();
  const docs = new Map(
    rows.length
      ? db()
          .select()
          .from(schema.documents)
          .where(inArray(schema.documents.id, rows.map((r) => r.documentId).filter((x): x is string => Boolean(x))))
          .all()
          .map((d) => [d.id, d])
      : [],
  );
  const live = rows.filter((r) => !r.documentId || (docs.get(r.documentId) && !docs.get(r.documentId)!.deletedAt));
  const items = live.map((p) => toListItem(p, p.documentId ? (docs.get(p.documentId) ?? null) : null, liveItems(p.id)));
  const rank: Record<string, number> = { current: 0, draft: 1, superseded: 2 };
  items.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.createdAt.localeCompare(a.createdAt));
  return { items, currentId: items.find((p) => p.status === 'current')?.id ?? null };
}

export function getPlan(id: string): PlanDetail {
  const { plan, doc } = livePlanOr404(id);
  const rows = liveItems(plan.id);
  const f = frameworkOf(plan);
  const shape = outline(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, PlanItemRow[]>();
  for (const r of rows) if (r.parentId && byId.has(r.parentId)) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const tasks = taskInfo(rows.map((r) => r.taskId).filter((x): x is string => Boolean(x)));
  const pages = pageMap(plan.documentId);

  // The finished items of the plan this one replaced, for "looks the same".
  const fromId = f.carryOver?.fromPlanId ?? null;
  const fromPlan = fromId ? db().select().from(schema.plans).where(and(eq(schema.plans.id, fromId), isNull(schema.plans.deletedAt))).get() : null;
  const earlier = fromPlan ? liveItems(fromPlan.id) : [];
  const earlierById = new Map(earlier.map((e) => [e.id, e]));
  const matches = fromPlan
    ? carryOverMatches(
        rows.filter((r) => isActionable(r.kind, itemDetailOf(r))).map((r) => ({ id: r.id, title: r.title, status: r.status })),
        earlier.filter((e) => isActionable(e.kind, itemDetailOf(e))).map((e) => ({ id: e.id, title: e.title, status: e.status })),
      )
    : [];
  const matchOf = new Map(matches.map((m) => [m.itemId, m.fromItemId]));
  // Earlier items named by "carried from" (shown with their note), possibly of another plan.
  const carriedIds = rows.map((r) => itemDetailOf(r).carriedFrom?.itemId).filter((x): x is string => Boolean(x) && !earlierById.has(x!));
  const carried = carriedIds.length ? db().select().from(schema.planItems).where(inArray(schema.planItems.id, carriedIds)).all() : [];
  const carriedById = new Map([...earlier, ...carried].map((e) => [e.id, e]));

  const items: PlanItemView[] = rows.map((r) => {
    const dj = itemDetailOf(r);
    const s = shape.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    const top = byId.get(s.top);
    const task = r.taskId ? (tasks.get(r.taskId) ?? null) : null;
    const like = matchOf.get(r.id);
    const likeRow = like ? earlierById.get(like) : undefined;
    const cf = dj.carriedFrom;
    const cfRow = cf ? carriedById.get(cf.itemId) : undefined;
    return {
      id: r.id,
      planId: r.planId,
      parentId: parent ? r.parentId : null,
      seq: r.seq,
      order: s.order,
      depth: s.depth,
      kind: r.kind,
      kindWords: planKindWords(r.kind),
      title: r.title,
      detail: r.detail,
      owner: r.owner,
      due: r.due,
      duePrecision: r.duePrecision,
      dueText: r.dueText,
      condition: r.condition,
      status: r.status,
      statusWords: planItemStatusWords(r.status),
      doneAt: r.doneAt,
      doneBy: r.doneBy,
      note: r.note,
      actionable: isActionable(r.kind, dj),
      citations: freshCitations(r, pages),
      asWritten: dj.asWritten ?? null,
      userFields: dj.userFields ?? [],
      task,
      carriedFrom: cf ? { ...cf, title: cfRow?.title ?? null, status: cfRow?.status ?? null, note: cfRow?.note ?? null } : null,
      looksLike: likeRow ? { itemId: likeRow.id, title: likeRow.title, status: likeRow.status, doneAt: likeRow.doneAt, doneBy: likeRow.doneBy, note: likeRow.note } : null,
      parentTitle: parent?.title ?? null,
      sectionTitle: top && top.id !== r.id ? top.title : null,
      childIds: (children.get(r.id) ?? []).map((c) => c.id),
      updatedAt: r.updatedAt,
    };
  });
  items.sort((a, b) => a.order.localeCompare(b.order));
  const list = toListItem(plan, doc, rows);
  return {
    ...list,
    asWrittenTitle: f.asWrittenTitle ?? null,
    items,
    carryOver: f.carryOver
      ? { fromPlanId: f.carryOver.fromPlanId, fromTitle: fromPlan?.title ?? null, matches: matches.length, appliedAt: f.carryOver.appliedAt ?? null, applied: f.carryOver.applied ?? null, dismissedAt: f.carryOver.dismissedAt ?? null }
      : null,
    history: f.history ?? [],
    document: doc ? { id: doc.id, title: doc.title, kind: doc.kind, mime: doc.mime, pageCount: doc.pageCount, documentDate: doc.documentDate, documentDatePrecision: doc.documentDatePrecision, sourceTier: doc.sourceTier } : null,
  };
}

export function getItem(id: string): { planId: string; item: PlanItemView } {
  const { item } = liveItemOr404(id);
  const view = getPlan(item.planId).items.find((i) => i.id === id);
  if (!view) throw notFound('plan item not found');
  return { planId: item.planId, item: view };
}

// ---------------------------------------------------------------------------
// The plan itself: rename, make current, remove, restore
// ---------------------------------------------------------------------------

export const planPatch = z.object({ title: z.string().trim().min(1, 'a plan needs a name').max(300) }).strict();

export function renamePlan(id: string, raw: unknown, opts: { by?: string | null } = {}): PlanDetail {
  const { title } = parseOrThrow(planPatch, raw);
  const { plan } = livePlanOr404(id);
  if (title === plan.title) return getPlan(id);
  const f = frameworkOf(plan);
  // The plan's own title is kept beside the name a person gave it.
  const asWrittenTitle = f.asWrittenTitle ?? plan.title;
  const next = pushHistory({ ...f, asWrittenTitle: title === asWrittenTitle ? null : asWrittenTitle }, `renamed "${title}"`, opts.by);
  if (title === asWrittenTitle) delete next.asWrittenTitle;
  writeFramework(id, next, { title });
  return getPlan(id);
}

/** "Make this the current plan": a plan that was read; the current one is kept, superseded. */
export function makeCurrent(id: string, opts: { by?: string | null } = {}): PlanDetail {
  const { plan } = livePlanOr404(id);
  if (plan.status === 'current') return getPlan(id);
  if (frameworkOf(plan).reading?.state !== 'done') throw conflict('This plan has not been read yet.');
  const now = nowIso();
  db().transaction((tx) => {
    const others = tx.select().from(schema.plans).where(and(eq(schema.plans.status, 'current'), isNull(schema.plans.deletedAt))).all();
    for (const o of others) {
      const of = pushHistory({ ...frameworkOf(o), supersededBy: id, supersededAt: now }, `replaced by "${plan.title}"`, opts.by);
      tx.update(schema.plans).set({ status: 'superseded', frameworkJson: JSON.stringify(of), updatedAt: now }).where(eq(schema.plans.id, o.id)).run();
    }
    const f = pushHistory({ ...frameworkOf(plan), supersededBy: null, supersededAt: null }, 'made the current plan', opts.by);
    tx.update(schema.plans).set({ status: 'current', frameworkJson: JSON.stringify(f), updatedAt: now }).where(eq(schema.plans.id, id)).run();
  });
  return getPlan(id);
}

/**
 * Remove a plan (soft delete: the plan, its items and its document stay). When it was the current plan, the newest
 * plan it replaced that was read becomes current again, and the answer names it.
 */
export function removePlan(id: string, opts: { by?: string | null } = {}): { ok: true; nowCurrent: string | null } {
  const { plan } = livePlanOr404(id);
  const now = nowIso();
  let promoted: string | null = null;
  db().transaction((tx) => {
    tx.update(schema.plans).set({ deletedAt: now, updatedAt: now, frameworkJson: JSON.stringify(pushHistory(frameworkOf(plan), 'removed', opts.by)) }).where(eq(schema.plans.id, id)).run();
    if (plan.status !== 'current') return;
    // The plan this one replaced comes back first; else the one replaced last (a rename or a note on an older plan
    // moves its updatedAt, so that is not the order; review 2026-10-09).
    const replaced = frameworkOf(plan).carryOver?.fromPlanId ?? null;
    const when = (p: PlanRow) => frameworkOf(p).supersededAt ?? p.updatedAt;
    const rest = tx
      .select()
      .from(schema.plans)
      .where(and(eq(schema.plans.status, 'superseded'), isNull(schema.plans.deletedAt)))
      .all()
      .sort((a, b) => Number(b.id === replaced) - Number(a.id === replaced) || (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0));
    const next = rest.find((p) => {
      if (frameworkOf(p).reading?.state !== 'done') return false;
      if (!p.documentId) return true;
      const d = tx.select({ deletedAt: schema.documents.deletedAt }).from(schema.documents).where(eq(schema.documents.id, p.documentId)).get();
      return Boolean(d) && !d!.deletedAt;
    });
    if (!next) return;
    const f = pushHistory({ ...frameworkOf(next), supersededBy: null, supersededAt: null }, 'current again (the newer plan was removed)', opts.by);
    tx.update(schema.plans).set({ status: 'current', frameworkJson: JSON.stringify(f), updatedAt: now }).where(eq(schema.plans.id, next.id)).run();
    promoted = next.id;
  });
  return { ok: true, nowCurrent: promoted };
}

/** Bring back a removed plan: as it was, except that it waits as replaced when another plan is current now. */
export function restorePlan(id: string, opts: { by?: string | null } = {}): PlanDetail {
  const plan = db().select().from(schema.plans).where(eq(schema.plans.id, id)).get();
  if (!plan || !plan.deletedAt) throw notFound('no removed plan with that id');
  const current = db().select({ id: schema.plans.id }).from(schema.plans).where(and(eq(schema.plans.status, 'current'), isNull(schema.plans.deletedAt))).get();
  const status = plan.status === 'current' && current ? 'superseded' : plan.status;
  db().update(schema.plans).set({ deletedAt: null, status, updatedAt: nowIso(), frameworkJson: JSON.stringify(pushHistory(frameworkOf(plan), 'brought back', opts.by)) }).where(eq(schema.plans.id, id)).run();
  return getPlan(id);
}

// ---------------------------------------------------------------------------
// Items: the checklist, edits beside the plan's wording, to-dos
// ---------------------------------------------------------------------------

export const itemStatusBody = z
  .object({
    status: z.enum(PLAN_ITEM_STATUSES),
    note: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  })
  .strict();

function writeItem(id: string, set: Partial<typeof schema.planItems.$inferInsert>): void {
  db().update(schema.planItems).set({ ...set, updatedAt: nowIso() }).where(eq(schema.planItems.id, id)).run();
}

/** Done / skipped / doesn't apply / back to do: by whom and when; a short history is kept. */
export function setItemStatus(id: string, raw: unknown, opts: { by?: string | null } = {}): PlanItemView {
  const body = parseOrThrow(itemStatusBody, raw);
  const { item } = liveItemOr404(id);
  if (item.kind === 'section') throw badRequest('a section is a heading, not something to check off');
  const dj = itemDetailOf(item);
  const at = nowIso();
  const statusHistory = [...(dj.statusHistory ?? []), { status: body.status, at, by: opts.by ?? null }].slice(-STATUS_HISTORY_MAX);
  writeItem(id, {
    status: body.status,
    doneAt: body.status === 'open' ? null : at,
    doneBy: body.status === 'open' ? null : (opts.by ?? null),
    ...(body.note !== undefined ? { note: body.note?.trim() ? body.note : null } : {}),
    detailJson: JSON.stringify({ ...dj, statusHistory }),
  });
  return getItem(id).item;
}

export const itemPatch = z
  .object({
    title: z.string().trim().min(1, 'an item needs words').max(500).optional(),
    owner: z.string().trim().max(200).nullable().optional(),
    /** When, as typed: a date ("2027-02-15", "2/15/2027", "February 2027") or words ("after the MRI"). */
    due: z.string().trim().max(300).nullable().optional(),
    note: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  })
  .strict();

/**
 * A person's edit of an item. The plan's own wording of title, who and when is kept in detail_json.asWritten the first
 * time each changes (shown as "As written: ..."); setting a field back to the plan's wording drops the mark.
 */
export function updateItem(id: string, raw: unknown): PlanItemView {
  const patch = parseOrThrow(itemPatch, raw);
  const { item } = liveItemOr404(id);
  const dj = itemDetailOf(item);
  const asWritten = { ...(dj.asWritten ?? {}) };
  const fields = new Set<PlanUserField>(dj.userFields ?? []);
  const set: Partial<typeof schema.planItems.$inferInsert> = {};

  if (patch.title !== undefined && patch.title !== item.title) {
    if (!fields.has('title')) asWritten.title = item.title;
    set.title = patch.title;
    fields.add('title');
    if (patch.title === asWritten.title) {
      fields.delete('title');
      delete asWritten.title;
    }
  }
  if (patch.owner !== undefined) {
    const owner = patch.owner?.trim() ? patch.owner.trim() : null;
    if (owner !== item.owner) {
      if (!fields.has('owner')) asWritten.owner = item.owner;
      set.owner = owner;
      fields.add('owner');
      if (owner === (asWritten.owner ?? null)) {
        fields.delete('owner');
        delete asWritten.owner;
      }
    }
  }
  if (patch.due !== undefined) {
    const text = patch.due?.trim() ? patch.due.trim() : null;
    const read = parsePartialDate(text);
    const next = { iso: read.iso, precision: read.iso ? read.precision : 'unknown', text };
    if (next.iso !== item.due || next.text !== item.dueText) {
      if (!fields.has('due')) asWritten.due = { iso: item.due, precision: item.duePrecision, text: item.dueText };
      set.due = next.iso;
      set.duePrecision = next.precision;
      set.dueText = next.text;
      fields.add('due');
      const was = asWritten.due;
      if (was && was.iso === next.iso && (was.text ?? null) === next.text) {
        fields.delete('due');
        delete asWritten.due;
      }
    }
  }
  if (patch.note !== undefined) set.note = patch.note?.trim() ? patch.note : null;
  if (!Object.keys(set).length) return getItem(id).item;
  const userFields = [...fields];
  writeItem(id, { ...set, detailJson: JSON.stringify({ ...dj, asWritten: Object.keys(asWritten).length ? asWritten : undefined, userFields: userFields.length ? userFields : undefined }) });
  return getItem(id).item;
}

export const todoBody = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    detail: z.string().max(20_000).nullable().optional(),
    owner: z.enum(TASK_OWNERS).optional(),
    ownerPersonId: z.string().max(64).nullable().optional(),
    dueAt: z.string().max(64).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
  })
  .strict();

/** "Make a to-do" from an item: the to-do names the item (source plan_item) and the item names the to-do. */
export function makeTodo(id: string, raw: unknown): { task: TaskListItem; item: PlanItemView } {
  const body = parseOrThrow(todoBody, raw ?? {});
  const { item, plan } = liveItemOr404(id);
  if (item.taskId) {
    const live = db().select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.id, item.taskId), isNull(schema.tasks.deletedAt))).get();
    if (live) throw conflict('This item already has a to-do.');
  }
  const defaultDetail = [`From your plan: ${plan.title}`, item.condition ? `When it applies: ${item.condition}` : null, item.dueText ? `When: ${item.dueText}` : null].filter(Boolean).join('\n');
  const task = createTask({
    title: body.title ?? item.title,
    detail: body.detail !== undefined ? body.detail : defaultDetail,
    owner: body.owner ?? 'me',
    ownerPersonId: body.ownerPersonId ?? null,
    dueAt: body.dueAt !== undefined ? body.dueAt : item.due && item.duePrecision === 'day' ? item.due : null,
    priority: body.priority ?? 'normal',
    sourceType: 'plan_item',
    sourceId: item.id,
  });
  writeItem(id, { taskId: task.id });
  return { task, item: getItem(id).item };
}

// ---------------------------------------------------------------------------
// Items that look the same as finished ones in the plan this one replaced
// ---------------------------------------------------------------------------

export const carryBody = z.object({ itemIds: z.array(z.string().trim().min(1).max(64)).max(2000).optional() }).strict();

/** "Mark them": each item that looks the same takes the earlier item's answer, saying where it came from. */
export function applyCarryOver(planId: string, raw: unknown, opts: { by?: string | null } = {}): { marked: number; plan: PlanDetail } {
  const body = parseOrThrow(carryBody, raw ?? {});
  const detail = getPlan(planId);
  const want = body.itemIds ? new Set(body.itemIds) : null;
  const plan = db().select().from(schema.plans).where(eq(schema.plans.id, planId)).get()!;
  const f = frameworkOf(plan);
  if (!f.carryOver) throw conflict('This plan did not replace an earlier one.');
  const at = nowIso();
  let marked = 0;
  db().transaction((tx) => {
    for (const it of detail.items) {
      if (!it.looksLike || it.status !== 'open' || (want && !want.has(it.id))) continue;
      const row = tx.select().from(schema.planItems).where(eq(schema.planItems.id, it.id)).get();
      if (!row) continue;
      const dj = itemDetailOf(row);
      const statusHistory = [...(dj.statusHistory ?? []), { status: it.looksLike.status, at, by: opts.by ?? null }].slice(-STATUS_HISTORY_MAX);
      tx.update(schema.planItems)
        .set({
          status: it.looksLike.status,
          doneAt: it.looksLike.doneAt ?? at,
          doneBy: it.looksLike.doneBy ?? opts.by ?? null,
          detailJson: JSON.stringify({ ...dj, statusHistory, carriedFrom: { planId: f.carryOver!.fromPlanId, itemId: it.looksLike.itemId, at, by: opts.by ?? null } }),
          updatedAt: at,
        })
        .where(eq(schema.planItems.id, it.id))
        .run();
      marked++;
    }
    const next = pushHistory({ ...f, carryOver: { ...f.carryOver!, appliedAt: at, appliedBy: opts.by ?? null, applied: (f.carryOver!.applied ?? 0) + marked } }, `marked ${marked} item${marked === 1 ? '' : 's'} from the earlier plan`, opts.by);
    tx.update(schema.plans).set({ frameworkJson: JSON.stringify(next), updatedAt: at }).where(eq(schema.plans.id, planId)).run();
  });
  return { marked, plan: getPlan(planId) };
}

/** "Not now": the offer is put away (each item's pane still offers "Mark it the same"). */
export function dismissCarryOver(planId: string, opts: { by?: string | null } = {}): PlanDetail {
  const { plan } = livePlanOr404(planId);
  const f = frameworkOf(plan);
  if (!f.carryOver) throw conflict('This plan did not replace an earlier one.');
  writeFramework(planId, pushHistory({ ...f, carryOver: { ...f.carryOver, dismissedAt: nowIso() } }, 'put away the offer to mark items from the earlier plan', opts.by));
  return getPlan(planId);
}

// ---------------------------------------------------------------------------
// The original, with the cited passages marked
// ---------------------------------------------------------------------------

export interface PlanPassage {
  /** itemId:index */
  key: string;
  itemId: string;
  itemTitle: string;
  kindWords: string;
  page: number;
  quote: string;
  verified: boolean;
  matchKind: string;
  start: number | null;
  end: number | null;
}

export interface PlanOriginal {
  documentId: string;
  title: string;
  mime: string;
  kind: string;
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
  passages: PlanPassage[];
  /** Pages left out of `pages` (a long plan sends the cited pages and the first ones). */
  pagesLeftOut: number;
}

const ORIGINAL_ALL_PAGES = 60;

export function planOriginal(planId: string): PlanOriginal {
  const detail = getPlan(planId);
  if (!detail.document) throw badRequest('this plan has no document');
  const all = loadPages(detail.document.id);
  const passages: PlanPassage[] = [];
  for (const it of detail.items) {
    it.citations.forEach((c, i) => passages.push({ key: `${it.id}:${i}`, itemId: it.id, itemTitle: it.title, kindWords: it.kindWords, page: c.page, quote: c.quote, verified: c.verified, matchKind: c.matchKind, start: c.start ?? null, end: c.end ?? null }));
  }
  const cited = new Set(passages.map((p) => p.page));
  const pages = all.filter((p) => all.length <= ORIGINAL_ALL_PAGES || cited.has(p.pageNumber) || p.pageNumber <= 3).map((p) => ({ page: p.pageNumber, text: p.text }));
  return { documentId: detail.document.id, title: detail.document.title, mime: detail.document.mime, kind: detail.document.kind, pageCount: detail.document.pageCount || all.length, pages, passages, pagesLeftOut: all.length - pages.length };
}

// ---------------------------------------------------------------------------
// The clinician's read-only view (Ask tool get_current_plan)
// ---------------------------------------------------------------------------

function whenWords(it: Pick<PlanItemView, 'due' | 'duePrecision' | 'dueText'>): string | null {
  const date = it.due ? `${it.due}${it.duePrecision !== 'day' ? ` (${it.duePrecision})` : ''}` : null;
  if (it.dueText && date && it.dueText !== it.due) return `${it.dueText} [${date}]`;
  return it.dueText ?? date;
}

/**
 * The current plan (or the one named) as text for the clinician: one line per item in outline order, with its kind,
 * who, when, the condition, where the patient's checklist stands, his edits beside the plan's wording, and the plan
 * document's page token for every citation. The plan is what was planned, never a record of what happened.
 */
export function planForClinician(planId?: string | null): string {
  const { items: plans, currentId } = listPlans();
  const id = planId?.trim() || currentId;
  if (!id) {
    return plans.length
      ? `No current plan. Plans on file: ${plans.map((p) => `"${p.title}" (${p.status}, id ${p.id})`).join('; ')}.`
      : 'No plan on file. The patient adds one on the Plan page.';
  }
  let p: PlanDetail;
  try {
    p = getPlan(id);
  } catch {
    return `No plan with id ${id}.`;
  }
  const doc = p.document;
  const tok = (page?: number | null) => (doc ? (page ? `⟦D:${doc.id} p.${page}⟧` : `⟦D:${doc.id}⟧`) : '');
  const lines: string[] = [];
  const status = p.status === 'current' ? 'the current plan' : p.status === 'superseded' ? `an earlier plan, replaced${p.supersededAt ? ` on ${p.supersededAt.slice(0, 10)}` : ''}` : 'a new plan, not read yet';
  lines.push(`Plan: "${p.title}" (${status}), read from its plan document "${doc?.title ?? 'unknown'}" ${tok()}${p.planDateText ? `, dated ${p.planDateText}` : ''}.`);
  lines.push('This is the plan as written (what was planned), not a record of what happened. Cite an item by the plan document token after it, as the plan document.');
  if (p.summary) lines.push(`Summary (as read): ${p.summary}`);
  if (p.reading?.state !== 'done') lines.push(`Reading: ${p.reading?.state ?? 'not read'}${p.reading?.error ? ` (${p.reading.error})` : ''}.`);
  lines.push(`Checklist: ${p.progressWords}.`);
  const others = plans.filter((o) => o.id !== p.id);
  if (others.length) lines.push(`Other plans: ${others.map((o) => `"${o.title}" (${o.status}, id ${o.id})`).join('; ')}.`);
  lines.push('');
  for (const it of p.items) {
    const bits: string[] = [`${'  '.repeat(Math.min(it.depth, 8))}- [${it.kindWords.toLowerCase()}] ${it.condition && it.parentId ? `${it.condition}: ` : ''}${it.title}`];
    if (it.condition && !it.parentId) bits.push(`when it applies: ${it.condition}`);
    if (it.owner) bits.push(`who: ${it.owner}`);
    const when = whenWords(it);
    if (when) bits.push(`when: ${when}`);
    if (it.detail) bits.push(`detail: ${it.detail.slice(0, 400)}`);
    if (it.actionable) bits.push(`checklist: ${it.statusWords}${it.doneAt && it.status !== 'open' ? ` ${it.doneAt.slice(0, 10)}${it.doneBy ? ` by ${it.doneBy}` : ''}` : ''}`);
    if (it.note) bits.push(`note (patient or team): "${it.note.slice(0, 300)}"`);
    if (it.userFields.length && it.asWritten) {
      const w = it.asWritten;
      const asWritten = [w.title !== undefined ? `title "${w.title}"` : null, w.owner !== undefined ? `who "${w.owner ?? 'not said'}"` : null, w.due !== undefined ? `when "${w.due?.text ?? w.due?.iso ?? 'not said'}"` : null].filter(Boolean).join(', ');
      bits.push(`changed by the patient; as written in the plan: ${asWritten}`);
    }
    if (it.task) bits.push(`to-do: "${it.task.title}" (${it.task.status})`);
    const cites = it.citations.map((c) => `${tok(c.page)}${c.verified ? '' : ' (quote not found on the page)'}`);
    // An item with no passage still cites the plan document (review 2026-10-09: every line can be cited).
    if (!cites.length && doc) cites.push(`${tok()} (no passage given)`);
    lines.push(`${bits.join(' | ')}${cites.length ? ` ${[...new Set(cites)].join(' ')}` : ''}`);
  }
  if (!p.items.length) lines.push('(no items)');
  return lines.join('\n');
}
