/**
 * Classification: every uploaded document is classified once its pages
 * exist (source tier, author role, a proposed title, date, category, summary
 * and key points); inbox items additionally get the filing proposal. The
 * pass reads the first pages, hands the model the directory of known people,
 * the encounters near any date the text mentions, and the records we are
 * still waiting for, and stores the structured proposal under
 * `documents.metadata_json.triage` plus the classification part of the brief
 * in `documents.brief_json`.
 *
 * What is applied automatically is deliberately small (see
 * `applyClassification` in src/server/services/documents.ts): the title when
 * it still comes from the file name, the tier and author role when unknown,
 * the date and category when empty. Links to people and records remain a
 * filing decision (src/server/services/inbox.ts).
 *
 * The model call is injectable (`opts.call`) so the whole pass is testable
 * without the API. When AI is off or no key is stored an item still waiting
 * in the inbox is marked `needs_manual`; a plain upload, and a filed or
 * skipped item, is left as it is. The job finishes normally in both cases
 * instead of failing.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { enqueueJob, shouldGiveUp, type JobContext } from '../jobs/queue';
import { AiDisabledError, AiRefusedError, NoApiKeyError, callStructured } from '../ai/client';
import type { ChunkPage } from '../ai/prompts/extraction';
import { TRIAGE_SYSTEM_PROMPT, buildTriageUserMessage, type TriageDirectoryEntry, type TriageEncounterEntry, type TriageInventoryEntry } from '../ai/prompts/triage';
import { livePersonIds, readInbox, writeInbox } from '../services/inbox';
import { applyClassification, type ClassificationApplied } from '../services/documents';
import { locateCitation } from '../ai/citations';
import { pageTextLookupFor } from '../services/facts';
import { getSetting } from '../services/settings';
import { READ_STATUSES, autoFileAfterClassification, autoFileAfterExtraction } from '../services/filing';
import { checkSortingOpinion } from '../services/patient-check';
import { documentDateSource, type DateSource } from './detect';
import { nowIso, parseJson } from '../util/ids';
import { daysBetween, parsePartialDate } from '../../shared/dates';
import { INBOX_ACTIVE_STATUSES, triageOutput, type InboxMeta, type TriageMeta, type TriageOutput } from '../../shared/schemas/inbox';

export const TRIAGE_MAX_PAGES = 8;
export const TRIAGE_MAX_CHARS = 24_000;
export const ENCOUNTER_WINDOW_DAYS = 90;
const DIRECTORY_LIMIT = 400;
const INVENTORY_LIMIT = 100;
const ENCOUNTER_LIMIT = 30;

type DocumentRow = typeof schema.documents.$inferSelect;

export interface TriageContext {
  document: DocumentRow;
  pages: ChunkPage[];
  totalPages: number;
  chars: number;
  /** Day-precision ISO dates found in the pages, plus the document date: first when it was recorded (text, file header, model, user), last when it is only a guess from the file name. */
  dates: string[];
  /** Where the document date came from (null when there is none or it is unknown). */
  dateSource: DateSource | null;
  directory: TriageDirectoryEntry[];
  encounters: TriageEncounterEntry[];
  inventory: TriageInventoryEntry[];
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/gi,
];

/** Every day-precision date written in the text, deduplicated, in order of first appearance. */
export function findDatesInText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of DATE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const p = parsePartialDate(m[0]);
      if (p.iso && p.precision === 'day' && !seen.has(p.iso)) {
        seen.add(p.iso);
        out.push(p.iso);
      }
    }
  }
  return out;
}

/** The first `maxPages` pages, cut to about `maxChars` characters in total. */
export function selectTriagePages(pages: ChunkPage[], maxPages = TRIAGE_MAX_PAGES, maxChars = TRIAGE_MAX_CHARS): ChunkPage[] {
  const out: ChunkPage[] = [];
  let used = 0;
  for (const p of pages.slice(0, maxPages)) {
    const room = maxChars - used;
    if (room <= 0) break;
    if (p.text.length <= room) {
      out.push(p);
      used += p.text.length;
    } else {
      if (room >= 200) out.push({ pageNumber: p.pageNumber, text: `${p.text.slice(0, room)}\n[... cut for length ...]` });
      break;
    }
  }
  return out;
}

/** Pages read per query while looking for the first pages with text. */
const PAGE_BATCH = 16;

/**
 * The first `want` pages with text (a JS trim, so a page of only whitespace has none), in order, and the page count.
 * Read in batches until enough are found: an export of 2,000 pages is not loaded to use its first 8 (sweep 2026-10-07).
 */
function loadPages(documentId: string, want = TRIAGE_MAX_PAGES): { pages: ChunkPage[]; total: number } {
  const total = db().select({ n: sql<number>`count(*)` }).from(schema.documentPages).where(eq(schema.documentPages.documentId, documentId)).get()?.n ?? 0;
  const pages: ChunkPage[] = [];
  for (let offset = 0; offset < total && pages.length < want; offset += PAGE_BATCH) {
    const rows = db()
      .select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text })
      .from(schema.documentPages)
      .where(eq(schema.documentPages.documentId, documentId))
      .orderBy(asc(schema.documentPages.pageNumber))
      .limit(PAGE_BATCH)
      .offset(offset)
      .all();
    for (const p of rows) if (p.text.trim().length > 0) pages.push(p);
  }
  return { pages, total };
}

function loadDirectory(): TriageDirectoryEntry[] {
  return db()
    .select({ id: schema.people.id, name: schema.people.name, kind: schema.people.kind })
    .from(schema.people)
    .where(isNull(schema.people.deletedAt))
    .orderBy(asc(schema.people.kind), asc(schema.people.name))
    .limit(DIRECTORY_LIMIT)
    .all();
}

function loadEncountersNear(dates: string[]): TriageEncounterEntry[] {
  if (!dates.length) return [];
  const rows = db()
    .select({
      id: schema.encounters.id,
      occurredAt: schema.encounters.occurredAt,
      title: schema.encounters.title,
      status: schema.encounters.status,
      clinicianId: schema.encounters.clinicianId,
    })
    .from(schema.encounters)
    .where(isNull(schema.encounters.deletedAt))
    .all();
  const near = rows.filter((e) => {
    if (!e.occurredAt) return false;
    const day = e.occurredAt.length >= 10 ? e.occurredAt.slice(0, 10) : null;
    if (!day) return false;
    return dates.some((d) => Math.abs(daysBetween(d, day)) <= ENCOUNTER_WINDOW_DAYS);
  });
  const clinicianIds = [...new Set(near.map((e) => e.clinicianId).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (clinicianIds.length) {
    for (const p of db().select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(inArray(schema.people.id, clinicianIds)).all()) names.set(p.id, p.name);
  }
  return near
    .sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''))
    .slice(0, ENCOUNTER_LIMIT)
    .map((e) => ({ id: e.id, date: e.occurredAt, title: e.title, clinician: e.clinicianId ? (names.get(e.clinicianId) ?? null) : null, status: e.status }));
}

function loadOpenInventory(): TriageInventoryEntry[] {
  const inst = schema.people;
  return db()
    .select({
      id: schema.recordsInventory.id,
      title: schema.recordsInventory.title,
      recordType: schema.recordsInventory.recordType,
      status: schema.recordsInventory.status,
      date: schema.recordsInventory.recordDate,
      institution: inst.name,
    })
    .from(schema.recordsInventory)
    .leftJoin(inst, eq(inst.id, schema.recordsInventory.institutionId))
    .where(and(isNull(schema.recordsInventory.deletedAt), inArray(schema.recordsInventory.status, ['expected', 'requested'])))
    .orderBy(asc(schema.recordsInventory.recordDate))
    .limit(INVENTORY_LIMIT)
    .all();
}

export function buildTriageContext(documentId: string): TriageContext {
  const document = db()
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
    .get();
  if (!document) throw new Error(`document ${documentId} not found`);
  const { pages: all, total } = loadPages(documentId);
  const pages = selectTriagePages(all);
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  const dates = findDatesInText(pages.map((p) => p.text).join('\n'));
  const dateSource = documentDateSource(document);
  if (document.documentDate && document.documentDate.length === 10 && !dates.includes(document.documentDate)) {
    // A date read from the file name is often the download or scan date: it follows what the pages say instead of leading.
    if (dateSource === 'filename') dates.push(document.documentDate);
    else dates.unshift(document.documentDate);
  }
  return { document, pages, totalPages: total, chars, dates, dateSource, directory: loadDirectory(), encounters: loadEncountersNear(dates), inventory: loadOpenInventory() };
}

export function buildTriageMessages(ctx: TriageContext): { system: string; user: string } {
  return {
    system: TRIAGE_SYSTEM_PROMPT,
    user: buildTriageUserMessage({
      title: ctx.document.title,
      filename: ctx.document.filename,
      kind: ctx.document.kind,
      totalPages: ctx.totalPages,
      documentDateText: ctx.document.documentDateText ?? ctx.document.documentDate,
      documentDateSource: ctx.dateSource,
      titleSource: ctx.document.titleSource,
      directory: ctx.directory,
      encounters: ctx.encounters,
      inventory: ctx.inventory,
      pages: ctx.pages,
    }),
  };
}

// ---------------------------------------------------------------------------
// The model call (injectable)
// ---------------------------------------------------------------------------

export interface TriageCallRequest {
  system: string;
  user: string;
  documentId: string;
  title: string;
  jobId?: string | null;
  signal?: AbortSignal;
}

export type TriageCaller = (req: TriageCallRequest) => Promise<{ data: TriageOutput; model: string; callId: string | null }>;

export const defaultTriageCaller: TriageCaller = async (req) => {
  const r = await callStructured({
    purpose: 'classify_document',
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    schema: triageOutput,
    documentIds: [req.documentId],
    jobId: req.jobId ?? null,
    maxTokens: 6000,
    effort: 'low',
    requestSummary: `classify: ${req.title.slice(0, 100)}`,
    signal: req.signal,
  });
  return { data: r.data, model: r.model, callId: r.callId };
};

// ---------------------------------------------------------------------------
// Sanitising the proposal
// ---------------------------------------------------------------------------

function cleanMatch(m: { match_id: string | null; new_name: string | null }, valid: Set<string>, dropped: string[]): { match_id: string | null; new_name: string | null } {
  let matchId = m.match_id && m.match_id.trim() ? m.match_id.trim() : null;
  if (matchId && !valid.has(matchId)) {
    dropped.push(matchId);
    matchId = null;
  }
  const newName = m.new_name && m.new_name.trim() ? m.new_name.trim() : null;
  return { match_id: matchId, new_name: matchId ? null : newName };
}

/**
 * Keep only ids that were in the lists the model was given, clamp the
 * confidence, dedupe names. Dropped ids are recorded, never silently lost.
 */
export function sanitizeProposal(out: TriageOutput, ctx: Pick<TriageContext, 'directory' | 'encounters' | 'inventory'>): { proposal: TriageOutput; dropped: string[] } {
  const dropped: string[] = [];
  const people = new Set(ctx.directory.map((p) => p.id));
  for (const id of livePersonIds([out.institution.match_id ?? '', out.author.match_id ?? '', ...out.suggested_links.person_ids])) people.add(id);
  const encounters = new Set(ctx.encounters.map((e) => e.id));
  const inventory = new Set(ctx.inventory.map((r) => r.id));
  const keepIds = (ids: string[], valid: Set<string>) => {
    const kept: string[] = [];
    for (const raw of ids) {
      const id = raw.trim();
      if (!id || kept.includes(id)) continue;
      if (valid.has(id)) kept.push(id);
      else dropped.push(id);
    }
    return kept;
  };
  let encounterId = out.suggested_links.encounter_id && out.suggested_links.encounter_id.trim() ? out.suggested_links.encounter_id.trim() : null;
  if (encounterId && !encounters.has(encounterId)) {
    dropped.push(encounterId);
    encounterId = null;
  }
  const seenNames = new Set<string>();
  const peopleMentioned = out.people_mentioned.map((n) => n.trim()).filter((n) => {
    const k = n.toLowerCase();
    if (!n || seenNames.has(k)) return false;
    seenNames.add(k);
    return true;
  });
  const keyPoints = (Array.isArray(out.key_points) ? out.key_points : [])
    .map((k) => ({ text: (k.text ?? '').trim(), page: Number.isInteger(k.page) && k.page >= 1 ? k.page : 1, quote: (k.quote ?? '').trim() }))
    .filter((k) => k.text)
    .slice(0, 7);
  const proposal: TriageOutput = {
    ...out,
    title: out.title.trim() || 'Untitled document',
    document_date: out.document_date && out.document_date.trim() ? out.document_date.trim() : null,
    institution: cleanMatch(out.institution, people, dropped),
    author: cleanMatch(out.author, people, dropped),
    source_tier: out.source_tier ?? 'unknown',
    author_role: out.author_role ?? 'other',
    key_points: keyPoints,
    people_mentioned: peopleMentioned,
    suggested_links: { encounter_id: encounterId, inventory_row_ids: keepIds(out.suggested_links.inventory_row_ids, inventory), person_ids: keepIds(out.suggested_links.person_ids, people) },
    suggested_actions: [...new Set(out.suggested_actions)],
    confidence: Number.isFinite(out.confidence) ? Math.min(1, Math.max(0, out.confidence)) : 0,
  };
  return { proposal, dropped };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface TriageRunResult {
  documentId: string;
  /** triaged = proposal stored; needs_manual = an inbox item AI could not classify; skipped = a plain upload AI could not classify (left as it is). */
  status: 'triaged' | 'needs_manual' | 'skipped';
  reason?: string;
  triage?: TriageMeta;
  applied?: ClassificationApplied;
}

export interface TriageOptions {
  call?: TriageCaller;
  jobId?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: number, text?: string) => void;
  /** Re-title: apply the proposed title whatever the current title source (an explicit user request). */
  titleOnly?: boolean;
}

/**
 * The inbox state as it is now. The row is read fresh: the model call can take
 * a while and the user may have filed or skipped the item in the meantime.
 */
function currentInbox(documentId: string): InboxMeta | null {
  const row = db().select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  return row ? readInbox(row) : null;
}

/** Still waiting in the Inbox (new, triaged, needs_manual)? Filed and skipped items carry the user's verdict. */
function isAwaitingFiling(inbox: InboxMeta | null): boolean {
  return Boolean(inbox && INBOX_ACTIVE_STATUSES.includes(inbox.status));
}

/**
 * Classification could not run. An item still waiting in the Inbox moves to
 * needs_manual with the reason; a plain upload, and a filed or skipped item
 * (re-title, re-ingest), is left as it is.
 */
function couldNotClassify(doc: DocumentRow, reason: string): TriageRunResult {
  if (isAwaitingFiling(currentInbox(doc.id))) {
    writeInbox(doc.id, { status: 'needs_manual', error: reason.slice(0, 1000) });
    return { documentId: doc.id, status: 'needs_manual', reason };
  }
  // Outside the Inbox the document shows as "not sorted yet"; keep the reason so the page can say why.
  try {
    const row = db().select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
    if (row) {
      const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
      const prev = meta.classificationError as { count?: number } | undefined;
      meta.classificationError = { reason: reason.slice(0, 1000), at: nowIso(), count: (Number(prev?.count) || (prev ? 1 : 0)) + 1 };
      db().update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, doc.id)).run();
    }
  } catch (err) {
    console.warn(`[triage] could not record the classification error for ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { documentId: doc.id, status: 'skipped', reason };
}

/** Check each key point's quote against the page it names (page±1 like fact citations); nothing is dropped. */
export function verifyKeyPoints(documentId: string, points: TriageOutput['key_points']): Array<{ text: string; page: number; quote: string; verified: boolean }> {
  const lookup = pageTextLookupFor(documentId);
  return (points ?? []).map((k) => {
    const found = k.quote ? locateCitation(lookup, k.page, k.quote) : null;
    return { text: k.text, page: found?.page ?? k.page, quote: k.quote, verified: Boolean(found) };
  });
}

/**
 * Store the proposal: `metadata_json.triage` for the inbox and the detail
 * pane, the classification part of the brief, and the few document fields
 * the classification is allowed to set (see applyClassification).
 *
 * Only an item still waiting in the Inbox moves to `triaged`. A filed or
 * skipped item keeps its status, filing record and dates: a Re-title or a
 * re-ingest of it refreshes the stored classification without bringing it
 * back to the Inbox (explicit re-triage sets `new` before it queues the job).
 */
export function storeClassification(documentId: string, triage: TriageMeta, opts: { titleOnly?: boolean } = {}): ClassificationApplied {
  const doc = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc) throw new Error(`document ${documentId} not found`);
  const inbox = readInbox(doc);
  // Key points are stored with their verification so the brief can mark quotes that are not on the page.
  const stored: TriageMeta = { ...triage, key_points: verifyKeyPoints(documentId, triage.key_points) };
  const awaitingFiling = isAwaitingFiling(inbox);
  if (inbox) {
    writeInbox(documentId, awaitingFiling ? { status: 'triaged', triagedAt: triage.at, error: null } : {}, { triage: stored });
  } else {
    const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
    meta.triage = stored;
    delete meta.classificationError;
    db().update(schema.documents).set({ metadataJson: JSON.stringify(meta), updatedAt: nowIso() }).where(eq(schema.documents.id, documentId)).run();
  }
  // An item still in the inbox keeps its title, date and category for the filing form, and a filed item keeps
  // what the user filed it as; only the tier and author role (not part of filing) are set, unless the user asked for a re-title.
  const keepFields = awaitingFiling || inbox?.status === 'filed';
  return applyClassification(documentId, stored, { titleOnly: opts.titleOnly, tierOnly: keepFields && !opts.titleOnly });
}

export async function triageDocument(documentId: string, opts: TriageOptions = {}): Promise<TriageRunResult> {
  opts.onProgress?.(0.05, 'reading pages');
  const ctx = buildTriageContext(documentId);
  if (!ctx.pages.length || ctx.chars === 0) return couldNotClassify(ctx.document, 'no page text to classify; re-ingest (with OCR) or file it by hand');
  const { system, user } = buildTriageMessages(ctx);
  opts.onProgress?.(0.2, `classifying ${ctx.pages.length} page${ctx.pages.length === 1 ? '' : 's'}`);
  const call = opts.call ?? defaultTriageCaller;
  let result: Awaited<ReturnType<TriageCaller>>;
  try {
    result = await call({ system, user, documentId, title: ctx.document.title, jobId: opts.jobId ?? null, signal: opts.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AiDisabledError || err instanceof NoApiKeyError || err instanceof AiRefusedError) return couldNotClassify(ctx.document, message);
    couldNotClassify(ctx.document, message);
    throw err;
  }
  const { proposal, dropped } = sanitizeProposal(result.data, ctx);
  const triage: TriageMeta = { ...proposal, model: result.model, callId: result.callId, at: nowIso(), pagesUsed: ctx.pages.length, charsUsed: ctx.chars, dropped };
  const applied = storeClassification(documentId, triage, { titleOnly: opts.titleOnly });
  // The wrong-patient guard (2026-10-09): the patient Claude read is a second opinion; a conflict printed on the page
  // holds the document back here, before it is filed (a reading already running is stopped, its details hidden).
  if (checkSortingOpinion(documentId, triage.patient)) return { documentId, status: 'triaged', triage, applied };
  // File it where it belongs (held in yellow until the user confirms). Never fails the classification. A rename
  // files too: filing is idempotent, so an already-filed document gains nothing new, and one that was only named
  // before (a rename on a document never sorted) is filed now instead of being left classified but unfiled.
  {
    autoFileAfterClassification(documentId);
    // Sorted after its details were already pulled out (a backlog, or a retry after a failed classification):
    // the medications and allergies are filed now rather than waiting for an extraction that already ran.
    const ex = db().select({ extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (ex && READ_STATUSES.has(ex.extractionStatus)) autoFileAfterExtraction(documentId);
  }
  opts.onProgress?.(1, applied.title ? `classified as ${triage.source_tier}; titled "${triage.title.slice(0, 60)}"` : `classified as ${triage.source_tier}`);
  return { documentId, status: 'triaged', triage, applied };
}

/** Whether a classification call can be made at all (AI on and a key stored). Never throws. */
export function classificationAvailable(): boolean {
  try {
    return Boolean(getSetting('ai.enabled')) && Boolean(process.env.ANTHROPIC_API_KEY?.trim() || getSetting('ai.apiKey')?.trim());
  } catch {
    return false;
  }
}

/**
 * The fact extraction an upload asked for, queued once its classification has
 * ended (whatever it decided), so the extraction reads the tier it set. Only
 * while the document still shows the extraction as queued: an extraction the
 * user started meanwhile is not run twice. When AI has gone off since the
 * upload, the queued status is put back instead. Never throws.
 */
export function queueExtractionAfterClassification(documentId: string): void {
  try {
    const doc = db().select({ deletedAt: schema.documents.deletedAt, extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!doc || doc.deletedAt || doc.extractionStatus !== 'queued') return;
    if (classificationAvailable()) {
      enqueueJob({ type: 'extract_facts', payload: { documentId, deep: false }, documentId, dedupe: true });
      return;
    }
    const pending = db()
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, 'extract_facts'), eq(schema.jobs.documentId, documentId), inArray(schema.jobs.status, ['queued', 'running'])))
      .get();
    if (!pending) db().update(schema.documents).set({ extractionStatus: 'none', updatedAt: nowIso() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.extractionStatus, 'queued'))).run();
  } catch (err) {
    console.warn(`[triage] could not queue the extraction for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface TriageJobPayload {
  documentId: string;
  /** Re-title: an explicit user request (see TriageOptions.titleOnly). */
  titleOnly?: boolean;
  /** An upload that wants its facts extracted: queue extract_facts when this classification ends. */
  autoExtract?: boolean;
}

/**
 * Job handler for `triage_document` (lane ai). Payload `{ documentId, titleOnly?, autoExtract? }`.
 * `opts.call` injects the model call (tests).
 */
export async function triageDocumentJob(ctx: JobContext<TriageJobPayload>, opts: { call?: TriageCaller } = {}): Promise<TriageRunResult> {
  const { documentId, titleOnly, autoExtract } = ctx.payload;
  if (!documentId) throw new Error('triage job has no documentId');
  let result: TriageRunResult;
  try {
    result = await triageDocument(documentId, { call: opts.call, jobId: ctx.job.id, signal: ctx.signal, titleOnly: Boolean(titleOnly), onProgress: (p, t) => ctx.setProgress(p, t) });
  } catch (err) {
    // A transient failure is retried by the queue and the retry queues the extraction; after the last attempt
    // (or a cancel) it is queued here, so the upload is still extracted, as it would have been without classification.
    // The queue's own rule (a refused connection is retried; a refusal is not).
    const lastAttempt = ctx.signal.aborted || ctx.job.attempts + 1 >= ctx.job.maxAttempts || shouldGiveUp(err, err instanceof Error ? err.message : String(err));
    if (autoExtract && lastAttempt) queueExtractionAfterClassification(documentId);
    throw err;
  }
  if (autoExtract) queueExtractionAfterClassification(documentId);
  return result;
}
