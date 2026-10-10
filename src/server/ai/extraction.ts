/**
 * Fact extraction. The job reads a document's SEGMENTS (src/server/services/segments.ts: an encounter's note, its
 * messages, its lab results, or a block of pages when the layout is unknown), packs consecutive segments of one route
 * into calls of at most about 60,000 characters and `ai.maxPagesPerChunk` pages, calls the model and hands each
 * structured output to `applyExtractionOutput`, a plain function over the database (citation verification, dedup,
 * merge proposals, insertion, indexing) that is tested without the model.
 *
 * Resumable passes (2026-10-07, large exports; findings D.1.1-2, D.3 WP-B). A pass is one `extraction_runs` row. Each
 * call writes its facts, the retirement of the facts it replaces and its segments' status in ONE transaction, so a
 * lock, a restart, a dropped connection or a refusal costs at most that one call:
 * - a failed call marks its segments `failed` with the reason in plain words and the pass carries on (the document
 *   ends `partial`, never "N details found" over a gap); the queue retries the job once, and the retry continues the
 *   same pass, reading only what is still missing (the pass's id is kept in the job's payload);
 * - a lock or restart leaves the call's segments `running`; the unlock repair sets them back to `pending` (the stopped
 *   attempt is not counted) and the re-queued job continues the pass from the first unfinished segment;
 * - a segment already read at the current schema version with the same text is not read again unless the pass is
 *   asked to read everything (`scope: whole`): resuming a complete document makes no call.
 * A document is `done` only when every page is accounted for (read, parsed, skipped with a reason, or with nothing to
 * read); otherwise `partial` (or `failed` when the pass read nothing). `afterExtraction` runs after `partial` too.
 *
 * Re-run semantics, per segment. Reading a segment replaces the earlier unverified AI facts read from it (its
 * `_segment` link), and earlier facts with no live segment link (read before segments existed, or from a segment a
 * re-segmentation superseded) whose cited pages all lie in the pages read. Never replaced: confirmed, disputed and
 * manual facts, facts superseded by a merge or a reading the user chose (only the clinical-record pass's own set-asides
 * are replaced); unverified facts the user has edited, annotated (verdict note) or set an override on by hand; and
 * facts another ledger links to by id (lab rows, medications, intolerances, medication events, imaging studies,
 * records inventory, tasks, finding evidence, supersession, manual overrides; not the clinical-record pass's own
 * links, see linkedFactIds). A new fact that repeats one of those kept facts is dropped; a repeat of a fact read from
 * another segment adds its citations there; a new fact that only shares its dedupKey (a ruled-out diagnosis next to a
 * possible one, an opposing statement) is inserted so the contradiction surfaces. See `sameFact` in services/dedup.ts.
 *
 * Document fields (title, date, category) come from the first call of a pass that reads the document's first segment;
 * for an institutional export (an Epic chart print) only from its facesheet or patient summary, never from whatever
 * part happens to come first.
 *
 * A document deleted while its extraction runs stops it: the document is re-read before each call and before each
 * call's output is applied, and once it is gone nothing more is written; the run ends `cancelled` and the job is not
 * retried (JobCancelledError).
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { JobCancelledError, enqueueRulesAfterIngest, type JobContext } from '../jobs/queue';
import { documentDateSource, mayReplaceDocumentDate, type DateSource } from '../ingest/detect';
import { AiDisabledError, AiRefusedError, NoApiKeyError, callStructured, modelFor } from './client';
import { locateQuote } from './citations';
import {
  EXTRACTION_SYSTEM_PROMPT, buildExtractionUserMessage, buildPartsUserMessage, mustIncludeBlock, type ChunkPage, type PartInput,
} from './prompts/extraction';
import { getSetting } from '../services/settings';
import { indexEntity, removeFactIndex } from '../services/search';
import { closePendingMergesFor, dedupKey, proposeMergesFor, sameFact, type ComparableFact } from '../services/dedup';
import { insertFact, insertVerifiedCitation, loadPeopleIndex, publicAttributes, releaseOverridesBy, resolvePersonId, toMergeCandidate, type PageTextLookup } from '../services/facts';
import { rebuildDocumentBrief } from '../services/documents';
import { autoFileAfterExtraction } from '../services/filing';
import { runPatientPrecedence } from '../services/precedence';
import { runLabChecks } from '../services/lab-rules';
import { passSetAsideIds, reconcileQuietly } from '../services/reconcile';
import { hasUserWork, linkedFactIds } from '../services/fact-holds';
import { isMessagingActText } from '../../shared/messaging-acts';
import {
  ensureSegmented, getSegment, listSegments, markSegments, pageTextFormsLookup, parseSegmentContent, patchCoverageMeta, replaceSegments, segmentPageTexts,
  updateSegment, writeCoverage, type SegmentPageText, type SegmentRow,
} from '../services/segments';
import { afterPass, type PassEndInfo } from '../services/ingest-hooks';
import { coveragePagesOf, legacyReadInfo, writeLegacyCoverage, type LegacyReadInfo } from '../services/extraction-evidence';
import { labCheckAndFollowUp, labHintFor } from '../services/lab-check';
import { newId, nowIso, parseJson } from '../util/ids';
import { parsePartialDate } from '../../shared/dates';
import { EXTRACTION_SCHEMA_VERSION, MODEL_PRICES } from '../../shared/constants';
import {
  clampConfidence, coerceAssertedBy, coerceObjectivity, extractionOutput, extractionOutputLenient, validateAttributes, pairsToObject,
  type ExtractionOutput,
} from '../../shared/schemas/facts';
import {
  extractionStatusFor, formatPageRanges, normalizeForHash, pageIdentityHash, pagesToRanges, parseCoverage, parseExportInfo, parseSegmentDetail, resumeDecision, routeOf,
  segmentHashOf, segmentResultVersion, SEGMENTER_VERSION,
  type DocumentCoverage, type FactSegmentRef, type ResumeDecision, type SegmentDraftInput, type SegmentEstimate, type SegmentFailureKind,
} from '../../shared/schemas/segments';
import { SEGMENT_ATTRIBUTE_KEY } from '../../shared/trust';
import type { MessageVoice, SegmentRoute } from '../../shared/enums';
import { liveDocumentRow } from '../services/document-rows';
import { log } from '../util/log';

export const MAX_CHUNK_CHARS = 60_000;
const TOKEN_CHARS = 4;
const CHUNK_OVERHEAD_TOKENS = 1500;
/**
 * Calls that hold lab result tables (2026-10-09, lab recall): the first reading of a 600-page summary, in calls of up to
 * 24 pages and 60,000 characters, dropped most of its result rows. A lab results part, a part the lab check found
 * many lab lines in, and every call of a reading that names lines to report are read at most 6 pages and about 15,000
 * characters at a time.
 */
export const LAB_CALL_MAX_PAGES = 6;
export const LAB_CALL_MAX_CHARS = 15_000;
/** At most this many named lab lines in one call (a page that prints more is read alone): the hint and the answer fit. */
export const HINT_ROWS_PER_CALL = 60;
/** A part the lab check found at least this many lab lines in is packed like a lab results part. */
export const DENSE_LAB_ROWS = 8;
/** Output tokens a named lab line is expected to cost (one lab_result fact with its attributes and citation). */
export const LAB_ROW_OUTPUT_TOKENS = 300;
/** The most lab lines one reading names (the hint is split over its calls). */
const MAX_HINT_ROWS = 5000;
/**
 * Failed calls in a row after which a segment is no longer retried by an automatic pass (a user's request still reads
 * it). `document_segments.attempts` counts failures in a row: a successful read sets it back to 0.
 */
export const MAX_SEGMENT_ATTEMPTS = 3;
/** Calls failing in a row for a passing reason (network, rate limit) before the pass stops and leaves the rest pending. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** How long a pass waits for the document's text to finish being read (OCR, a re-read) before it starts anyway. */
const WAIT_FOR_TEXT_MS = 60 * 60_000;
const TEXT_IN_PROGRESS = ['pending', 'extracting', 'ocr_running'];

// ---------------------------------------------------------------------------
// Chunking and estimates
// ---------------------------------------------------------------------------

/** Group consecutive pages: at most `maxPages` pages or about `maxChars` characters, whichever comes first. */
export function chunkPages<T extends ChunkPage>(pages: T[], maxPages: number, maxChars: number = MAX_CHUNK_CHARS): T[][] {
  const limitPages = Math.max(1, Math.floor(maxPages) || 1);
  const chunks: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const p of pages) {
    const len = p.text.length;
    if (current.length && (current.length >= limitPages || chars + len > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** True when at least one page has text (without loading the pages). */
function hasPageText(documentId: string): boolean {
  return (db().get<{ n: number }>(sql`select count(*) as n from document_pages where document_id = ${documentId} and length(trim(text)) > 0`)?.n ?? 0) > 0;
}

function loadPages(documentId: string): ChunkPage[] {
  return db()
    .select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text })
    .from(schema.documentPages)
    .where(eq(schema.documentPages.documentId, documentId))
    .orderBy(asc(schema.documentPages.pageNumber))
    .all()
    .filter((p) => p.text.trim().length > 0);
}

export interface ExtractionEstimate {
  chunks: number;
  pages: number;
  characters: number;
  approxInputTokens: number;
  approxOutputTokens: number;
  model: string;
  approxUsd: number;
}

/**
 * USD for an estimate's tokens: characters / 4 plus a per-call overhead, output assumed at 25% of input, plus
 * `extraOutputTokens` (the lab lines a reading names: LAB_ROW_OUTPUT_TOKENS each).
 */
export function priceEstimate(characters: number, calls: number, model: string, extraOutputTokens = 0): { approxInputTokens: number; approxOutputTokens: number; approxUsd: number } {
  const approxInputTokens = Math.round(characters / TOKEN_CHARS + CHUNK_OVERHEAD_TOKENS * calls);
  const approxOutputTokens = Math.round(approxInputTokens * 0.25 + Math.max(0, extraOutputTokens));
  const price = MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  const approxUsd = (approxInputTokens * price.input + approxOutputTokens * price.output) / 1_000_000;
  return { approxInputTokens, approxOutputTokens, approxUsd: Math.round(approxUsd * 10000) / 10000 };
}

/** No API call: the whole document read once (the Facts page's estimate). */
export function estimateExtraction(documentId: string, deep = false): ExtractionEstimate {
  const pages = loadPages(documentId);
  const chunks = chunkPages(pages, getSetting('ai.maxPagesPerChunk'));
  const characters = pages.reduce((n, p) => n + p.text.length, 0);
  const model = modelFor(deep);
  return { chunks: chunks.length, pages: pages.length, characters, model, ...priceEstimate(characters, chunks.length, model) };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function beginRun(documentId: string, opts: { model: string; deep: boolean }): string {
  const d = db();
  const id = newId();
  const now = nowIso();
  d.insert(schema.extractionRuns)
    .values({ id, documentId, schemaVersion: EXTRACTION_SCHEMA_VERSION, model: opts.model, deep: opts.deep, status: 'running', startedAt: now })
    .run();
  d.update(schema.documents).set({ extractionStatus: 'running', updatedAt: now }).where(eq(schema.documents.id, documentId)).run();
  return id;
}

export function finishRun(runId: string, documentId: string, totals: { factsCount: number; mergesProposed: number; chunks: number; aiCallIds: string[] }): void {
  const d = db();
  const now = nowIso();
  d.update(schema.extractionRuns)
    .set({ status: 'done', finishedAt: now, factsCount: totals.factsCount, mergesProposed: totals.mergesProposed, chunks: totals.chunks, aiCallIdsJson: JSON.stringify(totals.aiCallIds) })
    .where(eq(schema.extractionRuns.id, runId))
    .run();
  d.update(schema.documents).set({ extractionStatus: 'done', extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION, updatedAt: now }).where(eq(schema.documents.id, documentId)).run();
}

export function failRun(runId: string, documentId: string, message: string, partial?: { factsCount: number; mergesProposed: number; chunks: number; aiCallIds: string[] }): void {
  const d = db();
  const now = nowIso();
  d.update(schema.extractionRuns)
    .set({
      status: 'failed',
      finishedAt: now,
      error: message.slice(0, 2000),
      ...(partial ? { factsCount: partial.factsCount, mergesProposed: partial.mergesProposed, chunks: partial.chunks, aiCallIdsJson: JSON.stringify(partial.aiCallIds) } : {}),
    })
    .where(eq(schema.extractionRuns.id, runId))
    .run();
  d.update(schema.documents).set({ extractionStatus: 'failed', updatedAt: now }).where(eq(schema.documents.id, documentId)).run();
}

/**
 * A run stopped because its document was deleted while it ran: the run is
 * `cancelled` and nothing more is written for the document's facts. The
 * document's extraction status reads `failed` (there is no cancelled status
 * for a document), which is also what a restore would set.
 */
export function cancelRun(runId: string, documentId: string, message: string, partial?: { factsCount: number; mergesProposed: number; chunks: number; aiCallIds: string[] }): void {
  const d = db();
  const now = nowIso();
  d.update(schema.extractionRuns)
    .set({
      status: 'cancelled',
      finishedAt: now,
      error: message.slice(0, 2000),
      ...(partial ? { factsCount: partial.factsCount, mergesProposed: partial.mergesProposed, chunks: partial.chunks, aiCallIdsJson: JSON.stringify(partial.aiCallIds) } : {}),
    })
    .where(eq(schema.extractionRuns.id, runId))
    .run();
  d.update(schema.documents)
    .set({ extractionStatus: 'failed' })
    .where(and(eq(schema.documents.id, documentId), inArray(schema.documents.extractionStatus, ['queued', 'running'])))
    .run();
}

/** Thrown when the document was soft-deleted while its extraction ran. */
export const DOCUMENT_DELETED_MESSAGE = 'cancelled: the document was deleted during extraction';

/** A fact as compared against incoming ones (its id, what it says). */
export interface KeyedFact extends ComparableFact {
  id: string;
}

/** dedupKey -> facts with that key; several may share one (a possible and a ruled-out diagnosis). */
export type FactsByKey = Map<string, KeyedFact[]>;

function addKeyed(map: FactsByKey, f: KeyedFact): void {
  const key = dedupKey(f);
  const list = map.get(key);
  if (list) list.push(f);
  else map.set(key, [f]);
}

export interface RetirementPlan {
  /** Previous unverified AI facts a successful run replaces. */
  retireIds: Set<string>;
  /** Everything that stays, by dedupKey (an edited fact also under its original model wording), for dropping repeats. */
  kept: FactsByKey;
  /** Unverified AI facts kept because the user edited or annotated them. */
  keptUserWork: number;
  /** Unverified AI facts kept because another ledger links to them. */
  keptLinked: number;
}

/** Adds a kept fact under its key, and an edited one also under what the model first said. */
function addKept(map: FactsByKey, r: { id: string; type: string; statement: string; date: string | null }, attrs: Record<string, unknown>): void {
  addKeyed(map, { id: r.id, type: r.type, statement: r.statement, attributes: attrs, date: r.date });
  // An edited fact also stands for what the model first said, so the re-extracted original is recognised as it.
  const orig = attrs._aiOriginal as { statement?: unknown; date?: unknown; attributes?: unknown } | undefined;
  if (orig && typeof orig.statement === 'string') {
    const oa = orig.attributes && typeof orig.attributes === 'object' ? (orig.attributes as Record<string, unknown>) : publicAttributes(attrs);
    addKeyed(map, { id: r.id, type: r.type, statement: orig.statement, attributes: oa, date: typeof orig.date === 'string' ? orig.date : null });
  }
}

/**
 * Decide, without changing anything, which of the document's live facts a
 * re-run would replace and which it keeps. Facts of `exceptRunId` (the run in
 * progress) are neither.
 */
export function planRetirement(documentId: string, exceptRunId?: string): RetirementPlan {
  const rows = db()
    .select({
      id: schema.facts.id,
      type: schema.facts.type,
      statement: schema.facts.statement,
      date: schema.facts.date,
      attributesJson: schema.facts.attributesJson,
      origin: schema.facts.origin,
      status: schema.facts.status,
      verdictNote: schema.facts.verdictNote,
      verdictBasis: schema.facts.verdictBasis,
      extractionRunId: schema.facts.extractionRunId,
    })
    .from(schema.facts)
    .where(and(eq(schema.facts.sourceDocumentId, documentId), isNull(schema.facts.deletedAt)))
    .all()
    .filter((r) => !exceptRunId || r.extractionRunId !== exceptRunId);
  const linked = linkedFactIds(documentId);
  // A copy the clinical-record pass set aside (a misread it found inaccurate, or a repeat of the record) is the
  // model's reading like a pending one: a re-read replaces it, and the pass judges the new reading afresh. Kept, it
  // would stay "inaccurate" beside the new reading in the counts, the brief and the clinician's ledger.
  const setAside = passSetAsideIds(rows.filter((r) => r.status === 'superseded').map((r) => r.id));
  const plan: RetirementPlan = { retireIds: new Set(), kept: new Map(), keptUserWork: 0, keptLinked: 0 };
  for (const r of rows) {
    const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
    if (r.origin === 'ai' && (r.status === 'unverified' || setAside.has(r.id))) {
      const userWork = hasUserWork(r, attrs);
      if (!userWork && !linked.has(r.id)) {
        plan.retireIds.add(r.id);
        continue;
      }
      if (userWork) plan.keptUserWork++;
      else plan.keptLinked++;
    }
    addKept(plan.kept, r, attrs);
  }
  return plan;
}

function retireFacts(ids: string[], now: string): void {
  const d = db();
  for (const id of ids) {
    d.update(schema.facts).set({ deletedAt: now, updatedAt: now }).where(eq(schema.facts.id, id)).run();
    removeFactIndex(id);
    closePendingMergesFor(id);
  }
  // A retired patient statement stops taking precedence at once; the pass after the run re-decides with the new facts.
  if (ids.length) releaseOverridesBy(ids, now);
}

/**
 * Soft-delete the document's previous unverified AI facts that a re-run
 * replaces (see `planRetirement`: user-edited, annotated and linked facts are
 * kept). Called once the run has succeeded, with the run's id so its own new
 * facts are never touched; the plan is re-read at that moment, so a verdict
 * or edit the user made while the run was going is respected.
 */
export function retirePreviousUnverified(documentId: string, opts: { exceptRunId?: string } = {}): { retired: number; retiredIds: string[]; keptUserWork: number; keptLinked: number } {
  const plan = planRetirement(documentId, opts.exceptRunId);
  const ids = [...plan.retireIds];
  retireFacts(ids, nowIso());
  return { retired: ids.length, retiredIds: ids, keptUserWork: plan.keptUserWork, keptLinked: plan.keptLinked };
}

/**
 * Fill document-level fields the ingest step could not know, without
 * overwriting what is already set. The date follows the date-source rules
 * (`mayReplaceDocumentDate`): a missing date or one guessed from the file
 * name gives way to the model's reading and is recorded as `dateSource: 'ai'`;
 * a date from the file header, the user or an earlier model pass stays, and a
 * different reading is only kept as `metadataJson.extraction.dateProposal`.
 * Nothing is written for a soft-deleted document.
 */
export function applyDocumentFields(documentId: string, output: ExtractionOutput, extra: { runId: string; model: string }): void {
  const d = db();
  const doc = d.select().from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get();
  if (!doc) return;
  const set: Partial<typeof schema.documents.$inferInsert> = { updatedAt: nowIso() };
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  let dateApplied = false;
  let dateProposal: string | null = null;
  if (output.document_date) {
    const pd = parsePartialDate(output.document_date);
    if (mayReplaceDocumentDate(doc)) {
      if (pd.iso) {
        set.documentDate = pd.iso;
        set.documentDatePrecision = pd.precision;
        set.documentDateText = pd.text;
        meta.dateSource = 'ai' satisfies DateSource;
        dateApplied = true;
      } else if (!doc.documentDateText) {
        set.documentDateText = output.document_date;
        meta.dateSource = 'ai' satisfies DateSource;
        dateApplied = true;
      }
    } else if (pd.iso && pd.iso !== doc.documentDate) {
      dateProposal = output.document_date;
    }
  }
  if ((!doc.category || doc.category === 'other') && output.document_category && output.document_category !== 'other') {
    set.category = output.document_category;
  }
  // A document still named after its file gets the model's title (the sorting step normally names it first; this
  // covers a sorting that failed or never ran). A title the user or a classification set stays; an item still
  // waiting in Unsorted uploads keeps its name until it is filed there.
  const proposedTitle = typeof output.document_title === 'string' ? output.document_title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const inboxStatus = (meta.inbox as { status?: string } | undefined)?.status;
  const waitingInInbox = inboxStatus === 'new' || inboxStatus === 'triaged' || inboxStatus === 'needs_manual';
  let titleApplied = false;
  if (proposedTitle && doc.titleSource === 'filename' && !waitingInInbox && proposedTitle !== doc.title) {
    set.title = proposedTitle;
    set.titleSource = 'ai';
    titleApplied = true;
  }
  meta.extraction = {
    title: proposedTitle || null,
    titleApplied,
    summary: output.document_summary,
    institution: output.institution,
    author: output.author,
    documentDate: output.document_date,
    dateApplied,
    ...(dateProposal ? { dateProposal } : {}),
    category: output.document_category,
    runId: extra.runId,
    model: extra.model,
    at: nowIso(),
  };
  set.metadataJson = JSON.stringify(meta);
  d.update(schema.documents).set(set).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).run();
  // The new name is searchable at once.
  if (titleApplied) indexEntity('document', documentId, proposedTitle, [doc.filename, doc.notes ?? '', ...parseJson<string[]>(doc.tagsJson, [])].join(' '));
}

// ---------------------------------------------------------------------------
// Apply one structured output
// ---------------------------------------------------------------------------

/** The segment a fact was read from, as the engine assigns it (the `_segment` link and the voice defaults). */
export interface FactSegmentAssignment {
  ref: FactSegmentRef;
  /** The segment's route: messaging acts are dropped from parse_and_extract parts. */
  route: SegmentRoute;
  /** The tier the voice defaults to when the model leaves asserted_by empty (the segment's own tier, else the document's). */
  defaultTier: string | null;
  /**
   * Whose words the fact's quotes are, from the part's parsed messages (2026-10-07 review, rev-comms #3): `patient` when
   * every quote sits in a message the patient sent (his words, whatever the model said); `care_team` when every quote
   * sits in a care-team message (the model's voice is kept, `clinician` when it gave none); null when unknown.
   */
  passageVoice?: 'patient' | 'care_team' | null;
}

export interface ApplyInput {
  documentId: string;
  runId: string;
  output: ExtractionOutput;
  /** The pages of this chunk (or the whole document); page±1 lookups use what is given. */
  pages: ChunkPage[] | Map<number, string>;
  model?: string;
  /** Facts kept from earlier runs (`planRetirement(...).kept`); a new fact that is the same fact as one of them (`sameFact`) is dropped. */
  keptFacts?: FactsByKey;
  /** Facts inserted earlier in this run, by dedupKey; a repeat of one (`sameFact`) attaches its citations there instead of inserting twice. */
  runFactsByKey?: FactsByKey;
  /** Facts this run is about to replace: never paired with new facts in merge proposals. */
  retiringIds?: ReadonlySet<string>;
  /** The document's source tier (primary | patient | compilation | external | unknown); looked up when omitted. Decides the default voice of a fact. */
  sourceTier?: string | null;
  /** Other forms of the same pages (the reading-order text the model saw): a quote found there is verified too, without offsets. */
  alternatePages?: PageTextLookup[];
  /** The segment each fact was read from (segment engine); no `_segment` link when omitted. */
  segmentFor?: (fact: ExtractionOutput['facts'][number]) => FactSegmentAssignment | null;
}

function documentTier(documentId: string): string {
  return db().select({ tier: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, documentId)).get()?.tier ?? 'unknown';
}

export interface ApplyResult {
  factIds: string[];
  inserted: number;
  droppedAsKept: number;
  mergedIntoRun: number;
  mergesProposed: number;
  citations: number;
  verifiedCitations: number;
  /** "Sent a portal message"-style facts dropped from messages and calls (messaging acts are not facts). */
  droppedMessagingActs: number;
  /** Facts inserted per segment id (segment engine only). */
  bySegment: Map<string, string[]>;
  /** Earlier facts a repeat was merged into (its citations added there): read again, so they stay. */
  mergedIds: Set<string>;
}

/**
 * The date a fact is stored at: the model's `date`. A lab result the model gave no date keeps a labelled date of the
 * same reading: its collection date, else its result date (each as printed; the reader tells which kind it is from
 * collected_date / resulted_date). A received date is never used, nor a document's date.
 */
export function factDateText(type: string, date: string | null | undefined, attributes: Record<string, unknown>): string | null {
  if (date != null && date.trim()) return date;
  if (type !== 'lab_result') return date ?? null;
  for (const key of ['collected_date', 'resulted_date']) {
    const v = attributes[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return date ?? null;
}

function lookupFor(pages: ApplyInput['pages']): PageTextLookup {
  if (pages instanceof Map) return (n) => pages.get(n);
  const m = new Map<number, string>();
  for (const p of pages) m.set(p.pageNumber, p.text);
  return (n) => m.get(n);
}

/** Routes whose parts are messages, calls, letters and questionnaires (read by the parsers too). */
const MESSAGE_ROUTES: ReadonlySet<SegmentRoute> = new Set(['parse', 'parse_and_extract']);

/**
 * True for an `event` that only says a message, call, questionnaire or letter happened ("Patient sent a MyChart message
 * to Dr. X", "Nurse returned the patient's call"). Read from messages and calls, those are not facts (the messages
 * themselves are read into Calls & Messages); anything clinical stays ("Nurse returned the call: the MRI is
 * scheduled for 4/12" is a fact). The test is shared with the clean-up of older facts (src/shared/messaging-acts.ts).
 */
export function isMessagingAct(f: { type: string; statement: string; attributes?: unknown }): boolean {
  const attrs = pairsToObject(f.attributes);
  return isMessagingActText(f.type, typeof attrs.name === 'string' ? attrs.name : null, f.statement);
}

/** The voice of a fact read from a message part, from its asserted_by. */
function voiceOf(assertedBy: string): MessageVoice {
  if (assertedBy === 'patient') return 'patient';
  if (assertedBy === 'clinician') return 'clinician';
  return 'unknown';
}

/** Inserts a citation unless the fact already has the same one (a repeat merged into an earlier fact). */
function citeOnce(factId: string, documentId: string, c: { page: number; quote: string }, lookup: PageTextLookup, alternates: PageTextLookup[] | undefined): { inserted: boolean; verified: boolean } {
  const exists = db()
    .select({ id: schema.citations.id })
    .from(schema.citations)
    .where(and(eq(schema.citations.factId, factId), eq(schema.citations.documentId, documentId), eq(schema.citations.pageNumber, c.page), eq(schema.citations.quote, c.quote)))
    .get();
  if (exists) return { inserted: false, verified: false };
  const row = insertVerifiedCitation(factId, { documentId, pageNumber: c.page, quote: c.quote }, lookup, alternates);
  return { inserted: true, verified: Boolean(row.verified) };
}

export function applyExtractionOutput(input: ApplyInput): ApplyResult {
  const parsed = extractionOutputLenient.safeParse(input.output);
  if (!parsed.success) throw new Error(`extraction output did not match the schema: ${parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`);
  const output = parsed.data;
  const lookup = lookupFor(input.pages);
  const keptFacts: FactsByKey = input.keptFacts ?? new Map();
  const runFacts: FactsByKey = input.runFactsByKey ?? new Map();
  const people = loadPeopleIndex();
  const tier = input.sourceTier ?? documentTier(input.documentId);
  const result: ApplyResult = { factIds: [], inserted: 0, droppedAsKept: 0, mergedIntoRun: 0, mergesProposed: 0, citations: 0, verifiedCitations: 0, droppedMessagingActs: 0, bySegment: new Map(), mergedIds: new Set() };

  for (const ef of output.facts) {
    const seg = input.segmentFor?.(ef as ExtractionOutput['facts'][number]) ?? null;
    // Messaging acts are not facts (findings D.1.6): the messages themselves are read into Calls & Messages.
    if (seg && MESSAGE_ROUTES.has(seg.route) && isMessagingAct(ef)) {
      result.droppedMessagingActs++;
      continue;
    }
    // The model's lab flags are read by the page's rules (a flag where the page shows none is kept apart).
    const v = validateAttributes(ef.type, ef.attributes, { from: 'model' });
    const attributes: Record<string, unknown> = v.ok ? { ...v.value } : { ...pairsToObject(ef.attributes), _attributeError: v.error };
    attributes._people = ef.people_mentioned ?? [];
    const objectivity = coerceObjectivity(ef.objectivity, ef.type, attributes);
    // A passage of a document can have its own voice (the patient's message inside a clinical record). A quote found in
    // a message the patient sent is his words, whatever the model said; in a care-team message, the model's voice is
    // kept, a clinician's when it gave none.
    let assertedBy = coerceAssertedBy(ef.asserted_by, seg?.defaultTier ?? tier);
    if (seg?.passageVoice === 'patient') assertedBy = 'patient';
    else if (seg?.passageVoice === 'care_team' && !(typeof ef.asserted_by === 'string' && ef.asserted_by.trim())) assertedBy = 'clinician';
    // A correction in the patient's own voice inside a compilation outranks the compilation's own text.
    if (tier === 'compilation' && assertedBy === 'patient') attributes._patientAnnotation = true;
    if (seg) {
      const ref: FactSegmentRef = { ...seg.ref };
      if (MESSAGE_ROUTES.has(seg.route)) ref.voice = voiceOf(assertedBy);
      attributes[SEGMENT_ATTRIBUTE_KEY] = ref;
    }
    const dateText = factDateText(ef.type, ef.date, attributes);
    const dateIso = parsePartialDate(dateText).iso;
    const incoming: ComparableFact = { type: ef.type, statement: ef.statement, attributes, date: dateIso };
    const key = dedupKey(incoming);

    // A repeat of a fact the re-run keeps (confirmed, disputed, edited, linked...) is dropped;
    // a fact that merely shares its key (a ruled-out vs a possible diagnosis) is not a repeat.
    if ((keptFacts.get(key) ?? []).some((k) => sameFact(k, incoming))) {
      result.droppedAsKept++;
      continue;
    }
    const earlier = (runFacts.get(key) ?? []).find((k) => sameFact(k, incoming));
    if (earlier) {
      // Same fact repeated (across a call boundary, in another part): keep its provenance.
      result.mergedIds.add(earlier.id);
      for (const c of ef.citations) {
        const r = citeOnce(earlier.id, input.documentId, c, lookup, input.alternatePages);
        if (!r.inserted) continue;
        result.citations++;
        if (r.verified) result.verifiedCitations++;
      }
      result.mergedIntoRun++;
      continue;
    }

    const confidence = v.ok ? clampConfidence(ef.confidence) : Math.min(clampConfidence(ef.confidence), 0.4);
    const fact = insertFact({
      type: ef.type,
      statement: ef.statement,
      dateText,
      dateEndText: ef.date_end,
      attributes,
      confidence,
      origin: 'ai',
      status: 'unverified',
      sourceDocumentId: input.documentId,
      extractionRunId: input.runId,
      personId: resolvePersonId(ef.type, attributes, ef.people_mentioned ?? [], people),
      objectivity,
      assertedBy,
    });
    // Every citation is verified and stored (unverifiable ones flagged), however many the model gave.
    for (const c of ef.citations) {
      const row = insertVerifiedCitation(fact.id, { documentId: input.documentId, pageNumber: c.page, quote: c.quote }, lookup, input.alternatePages);
      result.citations++;
      if (row.verified) result.verifiedCitations++;
    }
    addKeyed(runFacts, { id: fact.id, ...incoming });
    result.factIds.push(fact.id);
    result.inserted++;
    if (seg) {
      const list = result.bySegment.get(seg.ref.id) ?? [];
      list.push(fact.id);
      result.bySegment.set(seg.ref.id, list);
    }
    result.mergesProposed += proposeMergesFor(toMergeCandidate(fact), { skipIds: input.retiringIds });
  }
  return result;
}

/**
 * After a run: the patient-precedence rule runs incrementally (overrides and
 * discrepancy findings for subjective contradictions), clinical records
 * reconcile measurements (copies elsewhere set aside, links to retired facts
 * re-pointed), the lab checks look at this document's values (rule 10, two
 * values of one test that differ like a typing error; services/lab-rules.ts)
 * and the document brief is rebuilt from the new facts. None of them may fail
 * the extraction itself. Runs after a partial pass too.
 */
export function afterExtraction(documentId: string): void {
  try {
    runPatientPrecedence({ documentId, trigger: 'extraction' });
  } catch (err) {
    console.warn(`[extraction] patient precedence pass failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  reconcileQuietly({ documentId, trigger: 'extraction' });
  // Rule 10 (2026-10): this document's own values that differ like a typing error, stored as findings. After the
  // reconciliation, so a copy it set aside is no value here. Rule 12 and the full clearing run at unlock.
  try {
    runLabChecks({ documentId, trigger: 'extraction' });
  } catch (err) {
    console.warn(`[extraction] lab checks failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    rebuildDocumentBrief(documentId);
  } catch (err) {
    console.warn(`[extraction] brief rebuild failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Medications and intolerances from the new facts are filed (held in yellow until confirmed). Never throws.
  autoFileAfterExtraction(documentId);
}

// ---------------------------------------------------------------------------
// Segments: scope, targets, packing
// ---------------------------------------------------------------------------

/** missing: what is not read yet (resume); failed: only failed parts; whole: everything again (user work kept); pages: the given ranges. */
export type ExtractionScope = 'missing' | 'failed' | 'whole' | 'pages';
export const EXTRACTION_SCOPES: readonly ExtractionScope[] = ['missing', 'failed', 'whole', 'pages'];

/** The scope a request without one gets: a finished document is read again whole; anything else carries on. */
export function defaultScopeFor(extractionStatus: string | null | undefined): ExtractionScope {
  return extractionStatus === 'done' ? 'whole' : 'missing';
}

/** Routes the model reads. */
const MODEL_ROUTES: ReadonlySet<SegmentRoute> = new Set(['extract', 'parse_and_extract']);

/** Kinds whose call may set the document fields of an export (its own identity pages). */
const IDENTITY_KINDS = new Set(['facesheet', 'patient_summary']);

export interface SegmentWithText {
  segment: SegmentRow;
  pages: SegmentPageText[];
  /**
   * Only these pages of a settled part are read again ("read these pages again", the lab check's re-read): the part
   * stays settled, and only its details whose every cited page is among these pages are replaced (2026-10-08).
   */
  only?: boolean;
}

/** One part of a planned call: a segment, or a slice of a long one. */
export interface CallPart {
  segment: SegmentRow;
  pages: SegmentPageText[];
  /** The first and the last slice of the segment (both for a segment read in one call). */
  first: boolean;
  last: boolean;
  /** Some pages of a settled part read again (see SegmentWithText.only). */
  only?: boolean;
}

export interface PlannedCall {
  route: SegmentRoute;
  parts: CallPart[];
  chars: number;
  pageCount: number;
}

function partChars(pages: readonly SegmentPageText[]): number {
  return pages.reduce((n, p) => n + p.text.length, 0);
}

/**
 * Packs segments (in order) into calls: consecutive segments the model reads (routes extract and parse_and_extract)
 * share a call up to `maxChars` characters and `maxPages` pages; a segment never shares a call it does not fit in
 * whole; a segment longer than one call is read in slices of whole pages (never cut mid-page). Integration,
 * 2026-10-07, on a long chart print:
 * - the page limit counts DISTINCT pages: the sections of one chart-print page (visit information, vitals, orders...)
 *   are separate parts that each hold only their own lines of it, so a shared page is one page of the call;
 * - the two model routes share calls: what a route changes is per part (messaging acts dropped and the voice kept for
 *   a message part), and each fact takes the route of the part it cites (assignPart), so mixing them changes nothing
 *   but the number of calls (about a third as many, where messages, telephone notes and media alternate with
 *   the sections around them). `route` on a call is its first part's.
 * - lab result tables (2026-10-09, lab recall): a call that holds a lab results part, or a part the lab check found many
 *   lab lines in (isLabDense), is held to LAB_CALL_MAX_PAGES pages and LAB_CALL_MAX_CHARS characters; `small` holds
 *   every call to them (a reading that names lab lines to report).
 */
export function planCalls(items: readonly SegmentWithText[], opts: { maxPages: number; maxChars?: number; small?: boolean }): PlannedCall[] {
  const maxPages = Math.max(1, Math.floor(opts.maxPages) || 1);
  const maxChars = opts.maxChars ?? MAX_CHUNK_CHARS;
  const smallPages = Math.min(maxPages, LAB_CALL_MAX_PAGES);
  const smallChars = Math.min(maxChars, LAB_CALL_MAX_CHARS);
  const calls: PlannedCall[] = [];
  let cur: PlannedCall | null = null;
  let curPages = new Set<number>();
  let curSmall = false;
  for (const it of items) {
    if (!it.pages.length) continue;
    const route = routeOf({ kind: it.segment.kind, detail: parseSegmentDetail(it.segment.detailJson) });
    const chars = partChars(it.pages);
    const small = Boolean(opts.small) || isLabDense(it.segment);
    const limPages = small ? smallPages : maxPages;
    const limChars = small ? smallChars : maxChars;
    const fitsOne = chars <= limChars && it.pages.length <= limPages;
    const only = it.only ? { only: true as const } : {};
    if (fitsOne) {
      const added = it.pages.filter((p) => !curPages.has(p.pageNumber)).length;
      // A call that holds lab tables is held to the small limits, whichever part brings them.
      const both: boolean = small || curSmall;
      const capPages = both ? smallPages : maxPages;
      const capChars = both ? smallChars : maxChars;
      if (cur && MODEL_ROUTES.has(cur.route) === MODEL_ROUTES.has(route) && cur.chars + chars <= capChars && curPages.size + added <= capPages) {
        cur.parts.push({ segment: it.segment, pages: it.pages, first: true, last: true, ...only });
        cur.chars += chars;
        for (const p of it.pages) curPages.add(p.pageNumber);
        cur.pageCount = curPages.size;
        curSmall = both;
      } else {
        if (cur) calls.push(cur);
        curPages = new Set(it.pages.map((p) => p.pageNumber));
        cur = { route, parts: [{ segment: it.segment, pages: it.pages, first: true, last: true, ...only }], chars, pageCount: curPages.size };
        curSmall = small;
      }
      continue;
    }
    if (cur) calls.push(cur);
    cur = null;
    curPages = new Set<number>();
    curSmall = false;
    const slices = chunkPages(it.pages, limPages, limChars);
    slices.forEach((slice, i) => {
      calls.push({ route, parts: [{ segment: it.segment, pages: slice, first: i === 0, last: i === slices.length - 1, ...only }], chars: partChars(slice), pageCount: slice.length });
    });
  }
  if (cur) calls.push(cur);
  return calls;
}

/**
 * True for a part that holds lab result tables: a lab results part, or one the lab check found at least DENSE_LAB_ROWS
 * lab lines in (`detail_json.labCheck.rows`, written after each reading). Read from the part's row only, so the
 * estimate and the reading plan the same calls.
 */
export function isLabDense(seg: Pick<SegmentRow, 'kind' | 'detailJson'>): boolean {
  if (seg.kind === 'lab_results') return true;
  const lc = parseJson<Record<string, unknown>>(seg.detailJson, {}).labCheck as { rows?: unknown } | undefined;
  return Number(lc?.rows) >= DENSE_LAB_ROWS;
}

/**
 * The calls of a reading. One that names lab lines to report (the lab check's re-read, "read these pages again" with
 * lines missed there) is read in small calls (LAB_CALL_MAX_PAGES pages, LAB_CALL_MAX_CHARS characters), each naming at
 * most HINT_ROWS_PER_CALL lines (a page that prints more is read alone): the hint and the answer fit (2026-10-09, lab
 * recall). The estimate plans the same calls.
 */
export function planReadingCalls(items: readonly SegmentWithText[], opts: { maxPages: number; hint?: ReadonlyArray<{ page: number }> | null }): PlannedCall[] {
  const hint = opts.hint ?? [];
  if (!hint.length) return planCalls(items, { maxPages: opts.maxPages });
  return splitByHintRows(planCalls(items, { maxPages: opts.maxPages, small: true }), hint, HINT_ROWS_PER_CALL);
}

/** Calls naming more than `maxRows` lines are cut between pages, in page order, so each names at most `maxRows`. */
export function splitByHintRows(calls: readonly PlannedCall[], hint: ReadonlyArray<{ page: number }>, maxRows: number): PlannedCall[] {
  const perPage = new Map<number, number>();
  for (const h of hint) perPage.set(h.page, (perPage.get(h.page) ?? 0) + 1);
  const out: PlannedCall[] = [];
  for (const call of calls) {
    const pages = [...new Set(call.parts.flatMap((pp) => pp.pages.map((pg) => pg.pageNumber)))].sort((a, b) => a - b);
    const total = pages.reduce((n, p) => n + (perPage.get(p) ?? 0), 0);
    if (total <= maxRows || pages.length < 2) {
      out.push(call);
      continue;
    }
    // Groups of pages in order, each naming at most maxRows lines (a page naming more is a group of its own).
    const groups: number[][] = [];
    let group: number[] = [];
    let rows = 0;
    for (const p of pages) {
      const n = perPage.get(p) ?? 0;
      if (group.length && rows + n > maxRows) {
        groups.push(group);
        group = [];
        rows = 0;
      }
      group.push(p);
      rows += n;
    }
    if (group.length) groups.push(group);
    // Each part's pages in the groups, its first and last flags kept on the pieces holding its first and last page here.
    const pieces = groups.map((g) => {
      const inGroup = new Set(g);
      const parts: CallPart[] = [];
      for (const pp of call.parts) {
        const mine = pp.pages.filter((pg) => inGroup.has(pg.pageNumber));
        if (!mine.length) continue;
        parts.push({ ...pp, pages: mine, first: pp.first && mine[0] === pp.pages[0], last: pp.last && mine[mine.length - 1] === pp.pages[pp.pages.length - 1] });
      }
      const piece: PlannedCall = { route: call.route, parts, chars: parts.reduce((n, pp) => n + partChars(pp.pages), 0), pageCount: g.length };
      return piece;
    });
    for (const piece of pieces) if (piece.parts.length) out.push(piece);
  }
  return out;
}

/** The lab lines a planned call names (the hint's lines printed on its pages). */
export function hintRowsOfCall<T extends { page: number }>(call: PlannedCall, hint: readonly T[]): T[] {
  if (!hint.length) return [];
  const pages = new Set(call.parts.flatMap((pp) => pp.pages.map((pg) => pg.pageNumber)));
  return hint.filter((h) => pages.has(h.page));
}

/** The failure of a segment in this pass, from its detail. */
function failureKindOf(seg: SegmentRow): SegmentFailureKind | null {
  return parseSegmentDetail(seg.detailJson).failure?.kind ?? null;
}

/** True for a settled segment read under an older extraction schema (its text unchanged: a changed text is a new row). */
function readUnderOlderSchema(seg: SegmentRow): boolean {
  if (seg.status !== 'done' || seg.schemaVersion == null) return false;
  return Math.floor(seg.schemaVersion / 1000) !== EXTRACTION_SCHEMA_VERSION;
}

function touchesRanges(seg: SegmentRow, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => seg.pageStart <= b && seg.pageEnd >= a);
}

/**
 * The live segments a pass reads, in order. `runId` is the pass being continued (its settled segments are not read
 * again; its failed ones are retried unless refused or tried MAX_SEGMENT_ATTEMPTS times). `automatic` passes (after an
 * unlock, an upload) do not retry a refused segment; a user's request does.
 */
export function selectTargets(
  segments: readonly SegmentRow[],
  scope: ExtractionScope,
  opts: { runId?: string | null; pages?: readonly (readonly [number, number])[]; automatic?: boolean; settledOnly?: boolean } = {},
): SegmentRow[] {
  return segments.filter((s) => {
    if (s.supersededAt) return false;
    const route = routeOf({ kind: s.kind, detail: parseSegmentDetail(s.detailJson) });
    if (!MODEL_ROUTES.has(route)) return false;
    if (s.status === 'skipped' || s.status === 'no_text') return false;
    const inThisRun = Boolean(opts.runId) && s.extractionRunId === opts.runId;
    if (inThisRun && s.status === 'done') return false;
    if (inThisRun && s.status === 'failed' && (failureKindOf(s) === 'refused' || s.attempts >= MAX_SEGMENT_ATTEMPTS)) return false;
    const refused = s.status === 'failed' && failureKindOf(s) === 'refused';
    switch (scope) {
      case 'whole':
        return true;
      case 'failed':
        return s.status === 'failed';
      case 'pages':
        // The lab check's own re-read (settledOnly) reads the asked pages of parts already read, never a part not read
        // yet (one the user answered "Not now" for stays unread; 2026-10-09 review).
        if (opts.settledOnly && s.status !== 'done') return false;
        return touchesRanges(s, opts.pages ?? []);
      case 'missing':
      default:
        if (s.status === 'done') return readUnderOlderSchema(s);
        if (refused && opts.automatic) return false;
        if (s.status === 'failed' && opts.automatic && s.attempts >= MAX_SEGMENT_ATTEMPTS) return false;
        return true;
    }
  });
}

/**
 * Scope `pages` (2026-10-08, "read these pages again" and the lab check's re-read): a settled part is read again on the
 * asked pages only, and stays settled (`only`); a part not read yet is read whole, as before. Pages kept in order; an
 * empty list means the part has nothing on the asked pages to read.
 */
export function narrowToPages<T extends { pageNumber: number }>(seg: Pick<SegmentRow, 'status'>, pages: T[], ranges: readonly (readonly [number, number])[] | undefined): { pages: T[]; only: boolean } {
  if (seg.status !== 'done' || !ranges?.length) return { pages, only: false };
  const asked = pages.filter((p) => ranges.some(([a, b]) => p.pageNumber >= a && p.pageNumber <= b));
  if (asked.length === pages.length) return { pages, only: false };
  return { pages: asked, only: true };
}

/** Pages the model is given for a segment, or null when its text could not be built (never silently empty). */
function textsOf(documentId: string, seg: SegmentRow): SegmentPageText[] | null {
  try {
    return segmentPageTexts(documentId, seg);
  } catch (err) {
    console.warn(`[extraction] text of part ${seg.seq} of ${documentId} could not be built: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The estimate for reading `scope` of a document, from its actual segments (the `estimateExtraction` formula). A
 * document with no segments yet is estimated from its pages: every page with text for `whole`, else the pages a
 * reading before segments did not prove read.
 */
export function estimateSegments(
  documentId: string,
  scope: ExtractionScope = 'missing',
  deep = false,
  opts: {
    pages?: readonly (readonly [number, number])[];
    automatic?: boolean;
    runId?: string | null;
    settledOnly?: boolean;
    /**
     * Lab lines the reading names (2026-10-09, lab recall): planned in the reading's small calls (planReadingCalls), the
     * hint's own characters priced as input and LAB_ROW_OUTPUT_TOKENS of output for each line named.
     */
    hint?: ReadonlyArray<{ page: number; text: string }> | null;
    /**
     * Lab lines already held on the pages a hinted reading reads (2026-10-09 review): the model reports every fact on a
     * page read again (what it does not repeat there is retired), so their output is priced too, LAB_ROW_OUTPUT_TOKENS
     * each.
     */
    otherLabRows?: number;
  } = {},
): SegmentEstimate {
  const model = modelFor(deep);
  const maxPages = Number(getSetting('ai.maxPagesPerChunk')) || 24;
  const hint = opts.hint ?? [];
  /** The input and output a reading's named lines add, over the calls that hold their pages. */
  const hintCost = (callPages: ReadonlyArray<ReadonlySet<number>>): { chars: number; outTokens: number } => {
    if (!hint.length) return { chars: 0, outTokens: 0 };
    let chars = 0;
    let named = 0;
    for (const pages of callPages) {
      const rows = hint.filter((h) => pages.has(h.page));
      if (!rows.length) continue;
      named += rows.length;
      chars += mustIncludeBlock(rows).length;
    }
    return { chars, outTokens: (named + Math.max(0, Math.floor(opts.otherLabRows ?? 0))) * LAB_ROW_OUTPUT_TOKENS };
  };
  // Characters per page as stored (the reading-order text the model is given is the same text, its running header and
  // footer removed): no page is rebuilt for an estimate, so it stays cheap for a 1,840-page export.
  const P = schema.documentPages;
  const chars = new Map(
    db()
      .select({ pageNumber: P.pageNumber, chars: sql<number>`length(${P.text})`, hasText: sql<number>`length(trim(${P.text})) > 0` })
      .from(P)
      .where(eq(P.documentId, documentId))
      .all()
      .filter((r) => Boolean(r.hasText))
      .map((r) => [r.pageNumber, Number(r.chars)] as const),
  );
  /** A stand-in page of the right length (packing reads only `.text.length`). */
  const sized = (p: number): SegmentPageText => ({ pageNumber: p, text: ' '.repeat(chars.get(p) ?? 0), ocr: false });
  const segs = listSegments(documentId);
  if (!segs.length) {
    let pages = [...chars.keys()].sort((a, b) => a - b);
    if (scope === 'pages') pages = pages.filter((p) => (opts.pages ?? []).some(([a, b]) => p >= a && p <= b));
    else if (scope !== 'whole') {
      const read = new Set<number>();
      const info = legacyReadInfo(documentId);
      for (const [a, b] of info.readRanges) for (let p = a; p <= b; p++) read.add(p);
      // Pages two readings both kept details for are read again (once), so the re-read retires both (V5).
      for (const p of doubledLegacyPages(documentId, info)) read.delete(p);
      pages = pages.filter((p) => !read.has(p));
    }
    const chunks = hint.length ? chunkPages(pages.map(sized), Math.min(maxPages, LAB_CALL_MAX_PAGES), LAB_CALL_MAX_CHARS) : chunkPages(pages.map(sized), maxPages);
    const calls = chunks.length;
    const extra = hintCost(chunks.map((c) => new Set(c.map((p) => p.pageNumber))));
    const characters = pages.reduce((n, p) => n + (chars.get(p) ?? 0), 0) + extra.chars;
    const price = priceEstimate(characters, calls, model, extra.outTokens);
    return { segments: 0, calls, pages: pages.length, characters, approxInputTokens: price.approxInputTokens, approxOutputTokens: price.approxOutputTokens, model, approxUsd: price.approxUsd };
  }
  const targets = selectTargets(segs, scope, opts);
  const items: SegmentWithText[] = targets.map((s) => {
    const skip = new Set((parseSegmentDetail(s.detailJson).pages ?? []).filter((pi) => pi.state === 'skipped' || pi.state === 'no_text').map((pi) => pi.page));
    const pageNos: number[] = [];
    for (let p = s.pageStart; p <= s.pageEnd; p++) if (!skip.has(p) && chars.has(p)) pageNos.push(p);
    // A part's own characters when the cut recorded them (its lines of shared pages, plus the scanned text it owns), so a
    // page shared by several parts is not priced once per part (integration, 2026-10-07); else the stored page.
    const own = Number(parseJson<Record<string, unknown>>(s.detailJson, {}).chars);
    const all: SegmentPageText[] =
      Number.isFinite(own) && own >= 0 && pageNos.length
        ? pageNos.map((p) => ({ pageNumber: p, text: ' '.repeat(Math.ceil(own / pageNos.length)), ocr: false }))
        : pageNos.map(sized);
    // Scope pages: a settled part is priced on the asked pages only (it is read on those only).
    const narrowed = scope === 'pages' ? narrowToPages(s, all, opts.pages) : { pages: all, only: false };
    return { segment: s, pages: narrowed.pages, only: narrowed.only };
  });
  const calls = planReadingCalls(items, { maxPages, hint });
  const extra = hintCost(calls.map((c) => new Set(c.parts.flatMap((pp) => pp.pages.map((pg) => pg.pageNumber)))));
  const characters = calls.reduce((n, c) => n + c.chars, 0) + extra.chars;
  const pages = new Set(items.flatMap((i) => i.pages.map((p) => p.pageNumber))).size;
  const price = priceEstimate(characters, calls.length, model, extra.outTokens);
  return { segments: items.filter((i) => i.pages.length).length, calls: calls.length, pages, characters, approxInputTokens: price.approxInputTokens, approxOutputTokens: price.approxOutputTokens, model, approxUsd: price.approxUsd };
}

/**
 * The lab check's re-read of these lines (2026-10-09, lab recall), priced as it runs: the pages printing them, of the
 * parts already read only, in small calls naming the lines (planReadingCalls), from those pages' own characters plus the
 * expected output for the lines named and for `otherLabRows`, the lab lines already held on those pages (reported again
 * when a page is read again; 2026-10-09 review).
 */
export function estimateLabReread(documentId: string, rows: ReadonlyArray<{ page: number; text: string }>, otherLabRows = 0): SegmentEstimate {
  return estimateSegments(documentId, 'pages', false, { pages: pagesToRanges([...new Set(rows.map((r) => r.page))]), settledOnly: true, hint: rows, otherLabRows });
}

// ---------------------------------------------------------------------------
// Segments before the engine: fallback blocks, legacy adoption, status
// ---------------------------------------------------------------------------

/**
 * Blocks of pages written as segments when segmentation itself failed (never worse than reading the pages in order,
 * as before segments existed). Only for a document with no live segment at all.
 */
function fallbackSegments(documentId: string): number {
  const P = schema.documentPages;
  const pages = db().select({ pageNumber: P.pageNumber, text: P.text }).from(P).where(eq(P.documentId, documentId)).orderBy(asc(P.pageNumber)).all();
  const maxPages = Math.max(1, Math.floor(Number(getSetting('ai.maxPagesPerChunk')) || 24));
  const drafts: SegmentDraftInput[] = [];
  for (const block of chunkPages(pages, maxPages)) {
    const infos = block.map((p) => {
      const empty = p.text.trim().length === 0;
      return { page: p.pageNumber, hash: pageIdentityHash(p.text), bodyChars: p.text.length, ...(empty ? { state: 'no_text' as const, skipReason: 'no_text' as const } : {}) };
    });
    const allEmpty = infos.every((i) => i.state === 'no_text');
    drafts.push({
      seq: drafts.length,
      pageStart: block[0].pageNumber,
      pageEnd: block[block.length - 1].pageNumber,
      kind: 'pages',
      textHash: segmentHashOf(infos.map((i) => i.hash)),
      status: allEmpty ? 'no_text' : 'pending',
      skipReason: allEmpty ? 'no_text' : null,
      detail: { segmenter: SEGMENTER_VERSION, route: 'extract', source: 'page_block', routeReason: 'segmentation failed; pages read in order', pages: infos },
    });
  }
  if (!drafts.length) return 0;
  return replaceSegments(documentId, drafts, { reason: 'fallback' }).created;
}

/**
 * Pages of a document read before segments existed that two readings (two runs) both kept pending details for: a
 * lock-killed retry that was never rolled back leaves a second live set beside the first (findings A.1 trigger 2), and
 * same-passage pairs are never compared, so nothing folds them. Such pages are read again once, which retires both sets
 * (their details are pending: no user work, no link) and keeps one reading (2026-10-07 final verification, V5). A page
 * counts when two runs each hold a pending detail citing it, or each have a proving call over it with a pending detail
 * of theirs inside that call's pages (the same detail may be cited on a neighbouring page by the other reading).
 */
export function doubledLegacyPages(documentId: string, info: LegacyReadInfo = legacyReadInfo(documentId)): Set<number> {
  const rows = db().all<{ id: string; runId: string; status: string; attributesJson: string; verdictNote: string | null; verdictBasis: string | null; pagesCsv: string | null }>(sql`
    select f.id, f.extraction_run_id as runId, f.status, f.attributes_json as attributesJson, f.verdict_note as verdictNote,
           f.verdict_basis as verdictBasis, group_concat(distinct c.page_number) as pagesCsv
    from facts f join citations c on c.fact_id = f.id and c.document_id = ${documentId}
    where f.source_document_id = ${documentId} and f.deleted_at is null and f.origin = 'ai' and f.extraction_run_id is not null
    group by f.id`);
  if (!rows.length) return new Set();
  const linked = linkedFactIds(documentId);
  const setAside = passSetAsideIds(rows.filter((r) => r.status === 'superseded').map((r) => r.id));
  /** run id -> pages its pending details cite. */
  const pendingPages = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!(r.status === 'unverified' || setAside.has(r.id)) || linked.has(r.id)) continue;
    if (hasUserWork(r, parseJson<Record<string, unknown>>(r.attributesJson, {}))) continue;
    const set = pendingPages.get(r.runId) ?? new Set<number>();
    for (const p of citedPagesOf(r)) set.add(p);
    pendingPages.set(r.runId, set);
  }
  if (pendingPages.size < 2) return new Set();
  /** run id -> pages it read and kept a pending detail for. */
  const readKept = new Map<string, Set<number>>();
  for (const [runId, pages] of pendingPages) readKept.set(runId, new Set(pages));
  for (const c of info.calls) {
    if (!c.proved || !c.runId) continue;
    const pages = pendingPages.get(c.runId);
    if (!pages) continue;
    let holds = false;
    for (let p = c.range[0]; p <= c.range[1] && !holds; p++) if (pages.has(p)) holds = true;
    if (!holds) continue;
    const set = readKept.get(c.runId)!;
    for (let p = c.range[0]; p <= c.range[1]; p++) set.add(p);
  }
  const count = new Map<number, number>();
  for (const set of readKept.values()) for (const p of set) count.set(p, (count.get(p) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n >= 2).map(([p]) => p));
}

/**
 * The first time a document read before segments existed is cut into segments, a segment whose every page with text
 * was proved read (a model call whose reading was kept, or a run that finished: legacyReadInfo) is marked read (`done`,
 * `detail.adopted`), so resuming reads only what was never read: "pp.1-48 of 1,840" carries on at p.49, a document read
 * in full is not read again. A page whose scanned text was added (OCR) after that reading is not proved read, so its
 * segment is read; nor is a page two readings both kept details for (doubledLegacyPages: read once more, which retires
 * both). Only while the engine has never read a segment of the document. Returns how many segments were adopted.
 */
export function adoptLegacySegments(documentId: string): number {
  const all = listSegments(documentId, { includeSuperseded: true });
  if (!all.length) return 0;
  if (all.some((s) => s.schemaVersion != null || parseSegmentDetail(s.detailJson).adopted)) return 0;
  const pages = coveragePagesOf(documentId);
  const info = legacyReadInfo(documentId, pages);
  if (!info.readRanges.length) return 0;
  const read = new Set<number>();
  for (const [a, b] of info.readRanges) for (let p = a; p <= b; p++) read.add(p);
  for (const p of doubledLegacyPages(documentId, info)) read.delete(p);
  const hasText = new Map(pages.map((p) => [p.pageNumber, p.hasText]));
  const at = nowIso();
  const ids: string[] = [];
  for (const s of all) {
    if (s.supersededAt || s.status !== 'pending') continue;
    const detail = parseSegmentDetail(s.detailJson);
    if (!MODEL_ROUTES.has(routeOf({ kind: s.kind, detail }))) continue;
    let ok = true;
    let any = false;
    for (let p = s.pageStart; p <= s.pageEnd && ok; p++) {
      if (hasText.get(p) === false) continue;
      any = true;
      if (!read.has(p)) ok = false;
    }
    // Scanned text added after the reading was never seen by it.
    for (const pi of detail.pages ?? []) {
      if (pi.ocr && !pi.ocr.error && pi.ocr.chars > 0 && (!info.lastReadAt || pi.ocr.at > info.lastReadAt)) ok = false;
    }
    if (ok && any) ids.push(s.id);
  }
  if (!ids.length) return 0;
  markSegments(ids, { status: 'done', extractionRunId: info.readRunId ?? info.latestRunId, detail: { adopted: { at, from: 'legacy', readAt: info.lastReadAt } } as Record<string, unknown> });
  return ids.length;
}

/** True when a live segment the model reads is not settled (pending, running or failed). */
export function hasUnreadModelSegments(documentId: string): boolean {
  return listSegments(documentId).some((s) => MODEL_ROUTES.has(routeOf({ kind: s.kind, detail: parseSegmentDetail(s.detailJson) })) && !['done', 'skipped', 'no_text'].includes(s.status));
}

/**
 * The status a document's details have, from its coverage (or, with no segments, from what it holds): done when every
 * page is accounted for, partial when some are not, none when nothing was ever read and it holds no details.
 */
export function settledExtractionStatus(documentId: string): 'done' | 'partial' | 'failed' | 'none' {
  const segs = listSegments(documentId);
  const facts = db().get<{ n: number }>(sql`select count(*) as n from facts where source_document_id = ${documentId} and deleted_at is null`)?.n ?? 0;
  if (!segs.length) return facts > 0 ? 'partial' : 'none';
  const cov = writeCoverage(documentId);
  const st = extractionStatusFor(cov);
  if (st === 'done') return 'done';
  if (cov.pagesDone === 0 && facts === 0) return 'none';
  return st;
}

/** Puts a document's status back after a cancelled extraction (registered with the queue's cancel). */
export function resetStatusAfterCancel(documentId: string, payload: Record<string, unknown>): void {
  // The lab check's own re-read cancelled before it began: the report must not say "being read again" for good; its
  // lines are added from the page (2026-10-09 review). After the status below is put back.
  if (payload.reason === 'labcheck') {
    queueMicrotask(() => {
      void labCheckAndFollowUp(documentId, { trigger: 'reread', rereadEnded: { outcome: 'cancelled' } }).catch(() => undefined);
    });
  }
  const doc = db().select({ status: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc || doc.status !== 'queued') return;
  const prev = typeof payload.prevStatus === 'string' && !['queued', 'running'].includes(payload.prevStatus) ? payload.prevStatus : null;
  const next = prev ?? settledExtractionStatus(documentId);
  db().update(schema.documents).set({ extractionStatus: next, updatedAt: nowIso() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.extractionStatus, 'queued'))).run();
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface ExtractFactsPayload {
  documentId: string;
  deep?: boolean;
  /** What to read (default: a finished document whole, anything else what is missing). */
  scope?: ExtractionScope;
  /** For scope `pages`: the page ranges. */
  pages?: Array<[number, number]>;
  /** The reprocess batch this job belongs to (filings `detail.batchId`). */
  batchId?: string;
  /** The pass this job runs (the engine writes it when the pass begins; a re-queued job continues that pass). */
  runId?: string;
  /** Before reading, compare the estimate with `ai.autoResumeCeilingUsd` and ask instead when it is above. */
  ceilingCheck?: boolean;
  /** Who or what asked: after an unlock or an upload (automatic), the user, the clinician, or the lab check's re-read. */
  reason?: 'unlock' | 'upload' | 'user' | 'consult' | 'labcheck';
  /** The document's extraction status when the job was queued (a cancel puts it back). */
  prevStatus?: string;
  /**
   * Lab lines the lab check found on these pages that no detail holds (services/lab-check.ts): each is named to the
   * model as a line that must become its own lab_result fact. A pages reading without it (a user's, or the lab check's
   * re-read of more than 400 lines: 2026-10-09) is given the lines missed on those pages when it runs (labHintFor).
   */
  labHint?: Array<{ page: number; text: string }>;
}

/** The `resume_extraction` job (Continue reading; the after-unlock resume). */
export interface ResumeExtractionPayload {
  documentId: string;
  scope: ExtractionScope;
  pages?: Array<[number, number]>;
  deep?: boolean;
  batchId?: string;
  reason: 'unlock' | 'user' | 'consult' | 'upload';
  runId?: string;
  prevStatus?: string;
  /** The user already said yes to an estimate above the ceiling. */
  approved?: boolean;
}

export type PassOutcome = PassEndInfo['outcome'];

export interface ExtractFactsResult {
  runId: string;
  model: string;
  /** Model calls that came back (split halves count). */
  chunks: number;
  factsCount: number;
  droppedAsKept: number;
  mergesProposed: number;
  citations: number;
  verifiedCitations: number;
  /** Earlier unverified AI facts replaced by the parts read (and leftovers of superseded parts). */
  retired: number;
  /** Earlier unverified AI facts kept because the user edited or annotated them. */
  keptUserWork: number;
  /** Earlier unverified AI facts kept because another ledger (labs, medications, records, tasks, findings...) links to them. */
  keptLinked: number;
  /** done | partial | failed | cancelled, for this pass. */
  outcome?: PassOutcome | 'waiting';
  /** Parts read in this attempt, and how they ended. */
  segments?: { targets: number; done: number; failed: number; settledWithoutCall: number; leftPending: number };
  /** "details from pp.1-48 of 1,840". */
  coverageText?: string;
  droppedMessagingActs?: number;
  /** Set when the pass waits for the user's go-ahead (above the ceiling). */
  resume?: ResumeDecision;
  /** The lab check after the pass: lab lines found, missed, the re-read queued, details added from the page. */
  labCheck?: { rowsFound: number; missed: number; rereadJobId: string | null; added: number };
}

/** The rules run after a pass: after an unlock, after a reading asked for (or the lab check's re-read), after ingestion. */
function rulesTrigger(reason: ExtractFactsPayload['reason']): 'unlock' | 'reprocess' | 'ingestion' {
  if (reason === 'unlock') return 'unlock';
  if (reason === 'user' || reason === 'consult' || reason === 'labcheck') return 'reprocess';
  return 'ingestion';
}

/** An extraction pass that ended with parts unread: thrown so the queue retries the job (continuing the pass) once. */
export class PassIncompleteError extends Error {
  /** True when no retry can help (every failure was a refusal): the queue fails the job at once. */
  noRetry: boolean;
  constructor(message: string, noRetry: boolean) {
    super(message);
    this.name = 'PassIncompleteError';
    this.noRetry = noRetry;
  }
}

/** Why a call failed, in plain words, and whether trying again can help. */
export function classifyFailure(err: unknown): { kind: SegmentFailureKind; message: string; transient: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  const short = raw.replace(/\s+/g, ' ').slice(0, 300);
  if (err instanceof AiRefusedError) return { kind: 'refused', message: 'Claude declined to read this part', transient: false };
  if (/max_tokens/i.test(raw)) return { kind: 'overflow', message: `the answer was longer than the output limit even for one page (${short})`, transient: false };
  if (/did not match the schema|output did not match/i.test(raw)) return { kind: 'schema', message: 'the answer did not have the expected shape', transient: true };
  if (/rate[ _-]?limit|\b429\b|overloaded|\b529\b/i.test(raw)) return { kind: 'rate_limit', message: `the AI service was busy (${short})`, transient: true };
  if (/ECONN|socket|network|fetch failed|terminated|timed? ?out|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|stream broke|premature|connection/i.test(raw)) {
    return { kind: 'network', message: `the connection to the AI service dropped (${short})`, transient: true };
  }
  return { kind: 'other', message: short || 'unknown error', transient: true };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Waits while the document's text is still being read (ingest, OCR, a re-read, a segmentation running elsewhere). */
async function waitForText(documentId: string, signal: AbortSignal): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const doc = db().select({ textStatus: schema.documents.textStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    const busyJob = db()
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.documentId, documentId), inArray(schema.jobs.type, ['ingest_document', 'reingest_document', 'segment_document']), eq(schema.jobs.status, 'running')))
      .get();
    if (!doc || (!TEXT_IN_PROGRESS.includes(doc.textStatus) && !busyJob)) return;
    if (Date.now() - t0 > WAIT_FOR_TEXT_MS) return;
    await sleep(2000, signal);
  }
}

/** Writes the pass's id into the job's payload, so a re-queued job continues it. */
function rememberRun(ctx: JobContext<ExtractFactsPayload>, runId: string, scope: ExtractionScope): void {
  if (ctx.stillOwned && !ctx.stillOwned()) return;
  try {
    const row = db().select({ payloadJson: schema.jobs.payloadJson }).from(schema.jobs).where(eq(schema.jobs.id, ctx.job.id)).get();
    if (!row) return;
    // The scope the pass resolved is kept beside it: a re-queued job never works a default out again from a status the
    // pass itself changed (2026-10-07 review, rev-engine F2).
    db().update(schema.jobs).set({ payloadJson: JSON.stringify({ ...parseJson<Record<string, unknown>>(row.payloadJson, {}), runId, scope }) }).where(eq(schema.jobs.id, ctx.job.id)).run();
  } catch {
    // locked: the pass is found again from its run row
  }
}

/** The pass a job continues: its own run, when it was stopped (or ended with parts unread) and is this model's. */
function continuableRun(runId: string | undefined, documentId: string, model: string): string | null {
  if (!runId) return null;
  const run = db().select().from(schema.extractionRuns).where(and(eq(schema.extractionRuns.id, runId), eq(schema.extractionRuns.documentId, documentId))).get();
  if (!run || run.model !== model) return null;
  return ['running', 'interrupted', 'partial', 'failed'].includes(run.status) ? run.id : null;
}

/**
 * The pass a job ran, when it already ended (done, or cancelled): a lock or a hard stop came after the pass wrote its
 * end, before the job row was closed (while the hooks after the pass ran). The re-queued job reads nothing again
 * (2026-10-07 review, rev-engine F2: it used to start a new pass over the whole document, with no ceiling check).
 */
function endedRun(runId: string | undefined, documentId: string): typeof schema.extractionRuns.$inferSelect | null {
  if (!runId) return null;
  const run = db().select().from(schema.extractionRuns).where(and(eq(schema.extractionRuns.id, runId), eq(schema.extractionRuns.documentId, documentId))).get();
  return run && ['done', 'cancelled'].includes(run.status) ? run : null;
}

function reopenRun(runId: string, documentId: string): void {
  const now = nowIso();
  db().update(schema.extractionRuns).set({ status: 'running', finishedAt: null }).where(eq(schema.extractionRuns.id, runId)).run();
  db().update(schema.documents).set({ extractionStatus: 'running', updatedAt: now }).where(eq(schema.documents.id, documentId)).run();
}

/** "details from pp.1-48 of 1,840" (the coverage in words, for the job's result and its last progress line). */
export function coverageInWords(cov: DocumentCoverage): string {
  const done: Array<[number, number]> = cov.ranges.filter((r) => r[2] === 'done' || r[2] === 'parsed').map((r) => [r[0], r[1]]);
  const merged = pagesToRanges(done.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)));
  const total = cov.pagesTotal.toLocaleString('en-US');
  const withDetails = cov.pagesDone + cov.pagesParsed;
  if (cov.state === 'complete') return withDetails >= cov.pagesTotal ? `details from all ${total} pages` : `every page accounted for; details from ${withDetails.toLocaleString('en-US')} of ${total}`;
  if (!merged.length) return `no details read yet of ${total} pages`;
  return `details from ${formatPageRanges(merged)} of ${total}`;
}

/** The segment a fact of a call was read from: by its first cited page, then by where its quote sits. */
function assignPart(call: PlannedCall, ef: { citations?: Array<{ page: number; quote: string }> }): CallPart {
  const cites = ef.citations ?? [];
  for (const c of cites) {
    const holding = call.parts.filter((p) => p.pages.some((pg) => pg.pageNumber === c.page));
    if (holding.length === 1) return holding[0];
    if (holding.length > 1) {
      const found = holding.find((p) => {
        const text = p.pages.find((pg) => pg.pageNumber === c.page)?.text ?? '';
        return Boolean(locateQuote(text, c.quote));
      });
      return found ?? holding[0];
    }
  }
  const page = cites[0]?.page;
  if (typeof page === 'number') {
    const within = call.parts.find((p) => p.segment.pageStart <= page && p.segment.pageEnd >= page);
    if (within) return within;
    let best = call.parts[0];
    let dist = Infinity;
    for (const p of call.parts) {
      const d = page < p.segment.pageStart ? p.segment.pageStart - page : page - p.segment.pageEnd;
      if (d < dist) {
        dist = d;
        best = p;
      }
    }
    return best;
  }
  return call.parts[0];
}

interface FactRowForPlan {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  attributesJson: string;
  origin: string;
  status: string;
  verdictNote: string | null;
  verdictBasis: string | null;
  minPage: number | null;
  maxPage: number | null;
  cites: number;
  /** The distinct pages of this document the fact cites, comma-separated (null when none). */
  pagesCsv: string | null;
}

function documentFactsForPlan(documentId: string): FactRowForPlan[] {
  return db().all<FactRowForPlan>(sql`
    select f.id, f.type, f.statement, f.date, f.attributes_json as attributesJson, f.origin, f.status,
           f.verdict_note as verdictNote, f.verdict_basis as verdictBasis,
           min(c.page_number) as minPage, max(c.page_number) as maxPage, count(c.id) as cites,
           group_concat(distinct c.page_number) as pagesCsv
    from facts f left join citations c on c.fact_id = f.id and c.document_id = ${documentId}
    where f.source_document_id = ${documentId} and f.deleted_at is null
    group by f.id`);
}

function citedPagesOf(r: Pick<FactRowForPlan, 'pagesCsv'>): number[] {
  return (r.pagesCsv ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
}

/** The `_segment` id written on a fact, or null. */
function segmentIdOfAttrs(attrs: Record<string, unknown>): string | null {
  const seg = attrs[SEGMENT_ATTRIBUTE_KEY] && typeof attrs[SEGMENT_ATTRIBUTE_KEY] === 'object' ? (attrs[SEGMENT_ATTRIBUTE_KEY] as { id?: unknown }) : null;
  return typeof seg?.id === 'string' ? seg.id : null;
}

/** A part marked read from a reading made before segments existed (never read by the engine). */
function isAdoptedPart(s: SegmentRow): boolean {
  return s.status === 'done' && s.schemaVersion == null && Boolean(parseSegmentDetail(s.detailJson).adopted);
}

interface CallPlanForWrite {
  retireIds: Set<string>;
  kept: FactsByKey;
  merge: FactsByKey;
  keptUserWork: number;
  keptLinked: number;
}

/** The pages a part of a call stands for: a whole segment (or its last slice: the earlier slices were read in this pass) its page range, a slice its own pages. */
function partRange(p: CallPart): [number, number] {
  if (p.last) return [p.segment.pageStart, p.segment.pageEnd];
  const nums = p.pages.map((pg) => pg.pageNumber);
  return [Math.min(...nums), Math.max(...nums)];
}

/**
 * Inside a call's transaction: which earlier facts this call replaces (per part, see the header), which stay and drop
 * repeats (kept), and which are merge targets (read from other live segments).
 *
 * 2026-10-07 review (rev-engine F6, F7): a fact of one of this call's parts is replaced only when every page it cites
 * lies in what this call reads. A fact that also stands for other parts (their repeats were merged into it, with their
 * citations) is not retired by re-reading its own part alone: it stays as a merge target, so the other parts' citations
 * and the detail survive, and the re-read's repeat attaches to it (a whole re-read that repeats it nowhere retires it at
 * the end of the pass, retireUnrepeated). A fact with no live part is never retired while a part adopted from the
 * reading before segments (not read again now) touches one of its pages.
 */
function planForCall(documentId: string, call: PlannedCall, readSets: Map<string, Set<string>>): CallPlanForWrite {
  const rows = documentFactsForPlan(documentId);
  const linked = linkedFactIds(documentId);
  const setAside = passSetAsideIds(rows.filter((r) => r.status === 'superseded').map((r) => r.id));
  const live = listSegments(documentId);
  const liveSegIds = new Set(live.map((s) => s.id));
  const callSegIds = new Set(call.parts.map((p) => p.segment.id));
  // Worked out only when a fact with no live part needs it (rare once earlier details are placed, linkUnplacedFacts).
  let adoptedCache: SegmentRow[] | null = null;
  const adoptedElsewhere = () => (adoptedCache ??= live.filter((s) => !callSegIds.has(s.id) && s.schemaVersion == null && s.status === 'done' && isAdoptedPart(s)));
  const covered = new Set<number>();
  for (const p of call.parts) {
    // Some pages of a settled part read again: exactly those pages.
    if (p.only) {
      for (const pg of p.pages) covered.add(pg.pageNumber);
      continue;
    }
    const [lo, hi] = partRange(p);
    for (let pg = lo; pg <= hi; pg++) covered.add(pg);
  }
  const plan: CallPlanForWrite = { retireIds: new Set(), kept: new Map(), merge: new Map(), keptUserWork: 0, keptLinked: 0 };
  for (const r of rows) {
    const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
    const segId = segmentIdOfAttrs(attrs);
    const ownLive = segId !== null && liveSegIds.has(segId);
    const pending = r.origin === 'ai' && (r.status === 'unverified' || setAside.has(r.id));
    const pages = citedPagesOf(r);
    const allCovered = pages.length > 0 && pages.every((pg) => covered.has(pg));
    // Is it one this call replaces (were it free to go)? And, if not, does it stand for other parts too?
    let inScope = false;
    let ownStandsWider = false;
    const own = segId !== null ? call.parts.find((p) => p.segment.id === segId) : undefined;
    if (own && !(readSets.get(own.segment.id)?.has(r.id))) {
      if (own.only) {
        // Some pages of a settled part read again: replaced only when every cited page is among them; one citing other
        // pages too stands for them (a repeat adds its citations there); one with no citation is not on these pages.
        const read = new Set(own.pages.map((pg) => pg.pageNumber));
        if (pages.length > 0 && pages.every((pg) => read.has(pg))) inScope = true;
        else if (pages.length > 0) ownStandsWider = true;
      } else if (own.last) {
        if (allCovered || pages.length === 0) inScope = true;
        else ownStandsWider = true;
      } else {
        const [lo, hi] = partRange(own);
        if (pages.length > 0 && pages.every((pg) => pg >= lo && pg <= hi)) inScope = true;
        else if (pages.some((pg) => pg < own.segment.pageStart || pg > own.segment.pageEnd)) ownStandsWider = true;
      }
    } else if (!ownLive && allCovered) {
      inScope = !adoptedElsewhere().some((s) => pages.some((pg) => pg >= s.pageStart && pg <= s.pageEnd));
    }
    if (pending) {
      const userWork = hasUserWork(r, attrs);
      const isLinked = linked.has(r.id);
      if (inScope && !userWork && !isLinked) {
        plan.retireIds.add(r.id);
        continue;
      }
      if (inScope && userWork) plan.keptUserWork++;
      else if (inScope && isLinked) plan.keptLinked++;
      if (!userWork && !isLinked) {
        // Still free (another segment's reading, or one of this call's that stands for other parts too): a repeat adds
        // its citations there. So does a detail this pass already wrote for one of this call's parts (an earlier slice
        // of it: a result printed again on a page of a later slice is one detail citing each printing; 2026-10-09
        // review, now that lab parts are read 6 pages at a time). One of this call's own segments otherwise (an older
        // detail of a part read again) or one with no live segment is neither kept nor a merge target.
        const readThisPass = Boolean(own && readSets.get(own.segment.id)?.has(r.id));
        if (ownStandsWider || readThisPass || (ownLive && !callSegIds.has(segId!))) addKeyed(plan.merge, { id: r.id, type: r.type, statement: r.statement, attributes: attrs, date: r.date });
        continue;
      }
    }
    addKept(plan.kept, r, attrs);
  }
  return plan;
}

/** The segment's own link written on its facts. */
function segmentRef(seg: SegmentRow): FactSegmentRef {
  const detail = parseSegmentDetail(seg.detailJson);
  const tier = seg.sourceTier && ['primary', 'patient', 'compilation', 'external', 'unknown'].includes(seg.sourceTier) ? (seg.sourceTier as FactSegmentRef['tier']) : null;
  return { id: seg.id, seq: seg.seq, kind: seg.kind, ...(tier ? { tier } : {}), ...(detail.encounterKey ? { encounterKey: detail.encounterKey } : {}) };
}

/** The tier a segment's facts default their voice to: its own, a patient's own kinds, else the document's. */
function defaultTierFor(seg: SegmentRow, docTier: string | null): string | null {
  if (seg.sourceTier) return seg.sourceTier;
  if (seg.kind === 'questionnaire' || seg.kind === 'patient_entered') return 'patient';
  return docTier;
}

/** Part kinds whose parsed messages say whose words a quote is. */
const VOICED_KINDS = new Set(['messages', 'appointment_request', 'questionnaire', 'patient_entered']);

interface VoicedBody {
  voice: MessageVoice;
  body: string;
}

/** The bodies of a part's parsed messages with their voice, normalised (null when the part has none or cannot be read). */
function voicedBodiesOf(documentId: string, seg: SegmentRow): VoicedBody[] | null {
  if (!VOICED_KINDS.has(seg.kind)) return null;
  try {
    const c = parseSegmentContent(documentId, seg.id);
    const out: VoicedBody[] = c.messages.map((m) => ({ voice: m.voice, body: normalizeForHash(m.body) }));
    for (const q of c.questionnaires) out.push({ voice: 'patient', body: normalizeForHash(q.answers.map((a) => `${a.question} ${a.answer ?? ''}`).join(' ')) });
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Whose words a fact's quotes are, from the part's parsed messages: `patient` when every quote is found in a body the
 * patient sent, `care_team` when every quote is found in a care-team body, else null (2026-10-07 review, rev-comms #3).
 */
export function passageVoiceOf(bodies: readonly VoicedBody[] | null, quotes: readonly string[]): 'patient' | 'care_team' | null {
  if (!bodies?.length || !quotes.length) return null;
  let patient = 0;
  let team = 0;
  for (const q of quotes) {
    const nq = normalizeForHash(q).replace(/^["'.,;:\s]+|["'.,;:\s]+$/g, '');
    if (nq.length < 4) return null;
    const holders = bodies.filter((b) => b.body.includes(nq));
    if (!holders.length) return null;
    if (holders.every((b) => b.voice === 'patient')) patient++;
    else if (holders.every((b) => b.voice === 'clinician' || b.voice === 'staff')) team++;
    else return null;
  }
  if (patient === quotes.length) return 'patient';
  if (team === quotes.length) return 'care_team';
  return null;
}

interface PassState {
  documentId: string;
  runId: string;
  model: string;
  deep: boolean;
  totals: ExtractFactsResult;
  aiCallIds: string[];
  readSets: Map<string, Set<string>>;
  /** Earlier facts a repeat read in this attempt was merged into (they were read again). */
  mergedInto: Set<string>;
  /** Segments that failed in this attempt (id -> transient?). */
  failed: Map<string, boolean>;
  done: Set<string>;
  /** Settled parts read again on some pages only (they stay settled). */
  reread: Set<string>;
  settledWithoutCall: number;
  wrote: boolean;
  fieldsApplied: boolean;
}

/**
 * Marks a call's parts failed with the reason; a slice failing fails its whole segment. `attempts` counts failed calls
 * in a row (a successful read sets it back to 0; 2026-10-07 review, rev-engine F8), so an automatic pass gives up on a
 * part only after MAX_SEGMENT_ATTEMPTS failures in a row, however often it was read before.
 */
function markCallFailed(state: PassState, call: PlannedCall, f: { kind: SegmentFailureKind; message: string; transient: boolean }): void {
  const at = nowIso();
  for (const p of call.parts) {
    const seg = p.segment;
    if (p.only) {
      // Some pages of a settled part read again: the part stays settled (what it holds was read); the failure is noted.
      try {
        updateSegment(seg.id, { detail: { rereadFailure: { kind: f.kind, message: f.message.slice(0, 500), at, runId: state.runId } } as Record<string, unknown> });
      } catch {
        // noted in the pass's own failure
      }
      state.failed.set(seg.id, f.transient);
      continue;
    }
    try {
      const cur = getSegment(seg.id);
      updateSegment(seg.id, {
        status: 'failed',
        error: `Could not be read: ${f.message}`.slice(0, 1000),
        attempts: (cur?.attempts ?? seg.attempts) + 1,
        extractionRunId: state.runId,
        detail: { failure: { kind: f.kind, message: f.message.slice(0, 500), at } },
      });
    } catch (err) {
      console.warn(`[extraction] could not record the failure of part ${seg.seq}: ${err instanceof Error ? err.message : String(err)}`);
    }
    state.failed.set(seg.id, f.transient);
  }
}

/** Puts parts left running by this attempt back to pending (a cancel or a stop by the user; the attempt is not counted). */
function releaseRunning(state: PassState, ids: readonly string[]): void {
  try {
    const live = listSegments(state.documentId).filter((s) => ids.includes(s.id) && s.status === 'running');
    if (live.length) markSegments(live.map((s) => s.id), { status: 'pending' });
  } catch {
    // locked: the unlock repair does it
  }
}

/** One call's facts, the facts it replaces and its parts' status, in one transaction. */
function writeCall(state: PassState, call: PlannedCall, res: { data: ExtractionOutput; callId: string; model: string }, ctx: {
  docTier: string | null;
  forms: (page: number) => { stored: string; visual: string | null } | undefined;
}): { inserted: number } {
  let inserted = 0;
  db().transaction(() => {
    const plan = planForCall(state.documentId, call, state.readSets);
    retireFacts([...plan.retireIds], nowIso());
    state.totals.retired += plan.retireIds.size;
    state.totals.keptUserWork += plan.keptUserWork;
    state.totals.keptLinked += plan.keptLinked;
    // Citations are checked against the pages of this call: as stored (search, the viewer's offsets), else in the
    // reading order rebuilt from the page's boxes, else the text the model was given (both verified, no offsets).
    const stored = new Map<number, string>();
    const visual = new Map<number, string>();
    const seen = new Map<number, string>();
    for (const p of call.parts) {
      for (const pg of p.pages) {
        const f = ctx.forms(pg.pageNumber);
        if (f?.stored != null) stored.set(pg.pageNumber, f.stored);
        if (f?.visual) visual.set(pg.pageNumber, f.visual);
        seen.set(pg.pageNumber, seen.has(pg.pageNumber) ? `${seen.get(pg.pageNumber)}\n${pg.text}` : pg.text);
      }
    }
    // The parsed messages of the call's message parts, once per call: whose words each quote is.
    const bodies = new Map<string, VoicedBody[] | null>();
    const bodiesOf = (seg: SegmentRow) => {
      if (!bodies.has(seg.id)) bodies.set(seg.id, voicedBodiesOf(state.documentId, seg));
      return bodies.get(seg.id) ?? null;
    };
    const applied = applyExtractionOutput({
      documentId: state.documentId,
      runId: state.runId,
      output: res.data,
      pages: stored,
      model: res.model,
      keptFacts: plan.kept,
      runFactsByKey: plan.merge,
      retiringIds: plan.retireIds,
      sourceTier: ctx.docTier,
      alternatePages: [(n) => visual.get(n), (n) => seen.get(n)],
      segmentFor: (ef) => {
        const cites = (ef as { citations?: Array<{ page: number; quote: string }> }).citations ?? [];
        const part = assignPart(call, { citations: cites });
        // The part's own route (a call may hold parts of both model routes).
        return {
          ref: segmentRef(part.segment),
          route: routeOf({ kind: part.segment.kind, detail: parseSegmentDetail(part.segment.detailJson) }),
          defaultTier: defaultTierFor(part.segment, ctx.docTier),
          passageVoice: passageVoiceOf(bodiesOf(part.segment), cites.map((c) => c.quote)),
        };
      },
    });
    inserted = applied.inserted;
    state.totals.factsCount += applied.inserted;
    state.totals.droppedAsKept += applied.droppedAsKept;
    state.totals.mergesProposed += applied.mergesProposed;
    state.totals.citations += applied.citations;
    state.totals.verifiedCitations += applied.verifiedCitations;
    state.totals.droppedMessagingActs = (state.totals.droppedMessagingActs ?? 0) + applied.droppedMessagingActs;
    for (const id of applied.mergedIds) state.mergedInto.add(id);
    for (const [segId, ids] of applied.bySegment) {
      const set = state.readSets.get(segId) ?? new Set<string>();
      for (const id of ids) set.add(id);
      state.readSets.set(segId, set);
    }
    // The parts' status: done on a segment's last slice (its facts counted), running until then. A part read is no
    // longer a part that keeps failing: its count of failures in a row goes back to 0.
    const now = nowIso();
    const version = segmentResultVersion();
    for (const p of call.parts) {
      const cur = getSegment(p.segment.id) ?? p.segment;
      const detail = parseSegmentDetail(cur.detailJson);
      const callIds = [...(detail.aiCallIds ?? []), res.callId].slice(-50);
      if (p.only) {
        // Some pages of a settled part read again: it stays settled (its status, schema version and count of failures);
        // the pages read and when are kept, and its count of details is taken again.
        const n = db().get<{ n: number }>(sql`
          select count(*) as n from facts where source_document_id = ${state.documentId} and deleted_at is null
            and json_valid(attributes_json) and json_extract(attributes_json, '$._segment.id') = ${p.segment.id}`)?.n ?? cur.factsCount;
        updateSegment(p.segment.id, {
          extractionRunId: state.runId,
          factsCount: Number(n),
          detail: { aiCallIds: callIds, reread: { at: now, runId: state.runId, pages: pagesToRanges(p.pages.map((pg) => pg.pageNumber)) } } as Record<string, unknown>,
        });
        state.reread.add(p.segment.id);
        continue;
      }
      const factsHere = state.readSets.get(p.segment.id)?.size ?? 0;
      updateSegment(p.segment.id, {
        status: p.last ? 'done' : 'running',
        attempts: 0,
        error: null,
        extractionRunId: state.runId,
        ...(p.last ? { schemaVersion: version, factsCount: factsHere } : {}),
        detail: { aiCallIds: callIds, failure: undefined, ...(p.last ? { readAt: now, readHash: cur.textHash ?? null } : {}) } as Record<string, unknown>,
      });
      if (p.last) {
        state.done.add(p.segment.id);
        state.failed.delete(p.segment.id);
      }
    }
    // The run's counters, so a run stopped by a lock still says what it did.
    state.aiCallIds.push(res.callId);
    state.totals.chunks++;
    const run = db().select({ chunks: schema.extractionRuns.chunks, factsCount: schema.extractionRuns.factsCount, mergesProposed: schema.extractionRuns.mergesProposed, aiCallIdsJson: schema.extractionRuns.aiCallIdsJson }).from(schema.extractionRuns).where(eq(schema.extractionRuns.id, state.runId)).get();
    if (run) {
      db().update(schema.extractionRuns)
        .set({
          chunks: run.chunks + 1,
          factsCount: run.factsCount + applied.inserted,
          mergesProposed: run.mergesProposed + applied.mergesProposed,
          aiCallIdsJson: JSON.stringify([...parseJson<string[]>(run.aiCallIdsJson, []), res.callId]),
        })
        .where(eq(schema.extractionRuns.id, state.runId))
        .run();
    }
  });
  state.wrote = true;
  return { inserted };
}

/**
 * Facts read before segments existed, or from a segment a re-segmentation superseded, whose every cited page now lies
 * in a part the engine has read (not one adopted as read before): their reading was replaced, so they are retired
 * (user work and links kept, as always). Never one with a page an adopted part touches (that part was not read again;
 * 2026-10-07 review, rev-engine F7).
 */
function retireStaleFacts(documentId: string): number {
  const segs = listSegments(documentId);
  const liveIds = new Set(segs.map((s) => s.id));
  const readPages = new Set<number>();
  const adoptedPages = new Set<number>();
  for (const s of segs) {
    if (isAdoptedPart(s)) for (let p = s.pageStart; p <= s.pageEnd; p++) adoptedPages.add(p);
    if (s.status !== 'done' || s.schemaVersion == null) continue;
    for (let p = s.pageStart; p <= s.pageEnd; p++) readPages.add(p);
  }
  if (!readPages.size) return 0;
  const rows = documentFactsForPlan(documentId).filter((r) => r.origin === 'ai' && r.cites > 0);
  const linked = linkedFactIds(documentId);
  const setAside = passSetAsideIds(rows.filter((r) => r.status === 'superseded').map((r) => r.id));
  const ids: string[] = [];
  for (const r of rows) {
    if (!(r.status === 'unverified' || setAside.has(r.id)) || linked.has(r.id)) continue;
    const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
    if (hasUserWork(r, attrs)) continue;
    const segId = segmentIdOfAttrs(attrs);
    if (segId !== null && liveIds.has(segId)) continue;
    const pages = citedPagesOf(r);
    if (pages.length && pages.every((p) => readPages.has(p)) && !pages.some((p) => adoptedPages.has(p))) ids.push(r.id);
  }
  if (ids.length) db().transaction(() => retireFacts(ids, nowIso()));
  return ids.length;
}

/**
 * At the end of a pass: earlier facts of parts read in this attempt that stood for other parts too (kept as merge
 * targets while their own part was read, planForCall) and that nothing read in this attempt repeated, when every part
 * their pages lie in was read in this attempt: the whole reading no longer says them, so they are retired (user work
 * and links kept). Repeated ones stay with their citations (2026-10-07 review, rev-engine F6).
 */
function retireUnrepeated(state: PassState): number {
  if (!state.done.size) return 0;
  const segs = listSegments(state.documentId);
  const doneIds = state.done;
  const readPages = new Set<number>();
  for (const s of segs) if (doneIds.has(s.id)) for (let p = s.pageStart; p <= s.pageEnd; p++) readPages.add(p);
  const insertedNow = new Set<string>();
  for (const set of state.readSets.values()) for (const id of set) insertedNow.add(id);
  const rows = documentFactsForPlan(state.documentId).filter((r) => r.origin === 'ai' && r.cites > 0 && !insertedNow.has(r.id) && !state.mergedInto.has(r.id));
  if (!rows.length) return 0;
  const linked = linkedFactIds(state.documentId);
  const setAside = passSetAsideIds(rows.filter((r) => r.status === 'superseded').map((r) => r.id));
  const ids: string[] = [];
  for (const r of rows) {
    if (!(r.status === 'unverified' || setAside.has(r.id)) || linked.has(r.id)) continue;
    const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
    if (hasUserWork(r, attrs)) continue;
    const segId = segmentIdOfAttrs(attrs);
    if (segId === null || !doneIds.has(segId)) continue;
    const pages = citedPagesOf(r);
    if (pages.length && pages.every((p) => readPages.has(p))) ids.push(r.id);
  }
  if (ids.length) db().transaction(() => retireFacts(ids, nowIso()));
  return ids.length;
}

/**
 * Facts with no live part (read before segments existed, or from a part a re-cut superseded) are linked to the live
 * part they were read from: the part whose own text holds the quote of their first cited page (a part adopted as read
 * before first, so a detail of an adopted region is never mistaken for one of a part read now), else the only part on
 * that page. Linked, such a fact behaves like any other: a merge target for repeats read elsewhere, replaced only when
 * its own part is read again (2026-10-07 review, rev-engine F1: an Epic export prints medication lists, problems and
 * allergies again and again, and a resume after pp.1-48 read before segments must not make second live copies). Only
 * pending facts the model made; the link is written once (idempotent). Returns how many were linked.
 */
export function linkUnplacedFacts(documentId: string): number {
  const live = listSegments(documentId).filter((s) => MODEL_ROUTES.has(routeOf({ kind: s.kind, detail: parseSegmentDetail(s.detailJson) })));
  if (!live.length) return 0;
  const liveIds = new Set(live.map((s) => s.id));
  const rows = documentFactsForPlan(documentId).filter((r) => r.origin === 'ai' && r.cites > 0);
  const setAside = passSetAsideIds(rows.filter((r) => r.status === 'superseded').map((r) => r.id));
  const cand = rows.filter((r) => {
    if (!(r.status === 'unverified' || setAside.has(r.id))) return false;
    const segId = segmentIdOfAttrs(parseJson<Record<string, unknown>>(r.attributesJson, {}));
    return segId === null || !liveIds.has(segId);
  });
  if (!cand.length) return 0;
  const firstCite = new Map<string, { page: number; quote: string }>();
  for (let i = 0; i < cand.length; i += 400) {
    const chunk = cand.slice(i, i + 400).map((r) => r.id);
    const cites = db()
      .select({ factId: schema.citations.factId, page: schema.citations.pageNumber, quote: schema.citations.quote })
      .from(schema.citations)
      .where(and(inArray(schema.citations.factId, chunk), eq(schema.citations.documentId, documentId)))
      .orderBy(asc(schema.citations.pageNumber), asc(schema.citations.createdAt))
      .all();
    for (const c of cites) if (c.factId && !firstCite.has(c.factId)) firstCite.set(c.factId, { page: c.page, quote: c.quote });
  }
  const textCache = new Map<string, Map<number, string>>();
  const textOf = (s: SegmentRow, page: number): string => {
    let m = textCache.get(s.id);
    if (!m) {
      m = new Map();
      try {
        for (const pg of segmentPageTexts(documentId, s)) m.set(pg.pageNumber, m.has(pg.pageNumber) ? `${m.get(pg.pageNumber)}\n${pg.text}` : pg.text);
      } catch {
        // no text for this part: it never holds a quote
      }
      textCache.set(s.id, m);
    }
    return m.get(page) ?? '';
  };
  let n = 0;
  db().transaction(() => {
    for (const r of cand) {
      const c = firstCite.get(r.id);
      if (!c) continue;
      const onPage = live.filter((s) => s.pageStart <= c.page && s.pageEnd >= c.page);
      if (!onPage.length) continue;
      const ordered = [...onPage.filter(isAdoptedPart), ...onPage.filter((s) => !isAdoptedPart(s))];
      let part: SegmentRow | null = ordered.find((s) => Boolean(locateQuote(textOf(s, c.page), c.quote))) ?? null;
      if (!part) part = onPage.length === 1 ? onPage[0] : (onPage.find(isAdoptedPart) ?? null);
      if (!part) continue;
      const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
      const ref: FactSegmentRef = segmentRef(part);
      db().update(schema.facts).set({ attributesJson: JSON.stringify({ ...attrs, [SEGMENT_ATTRIBUTE_KEY]: ref }) }).where(eq(schema.facts.id, r.id)).run();
      n++;
    }
  });
  return n;
}

/** Document fields of an export come only from its own identity pages; of any other document, from its first part. */
function mayApplyFields(call: PlannedCall, isExport: boolean, firstSeq: number | null): boolean {
  if (isExport) return call.parts.some((p) => IDENTITY_KINDS.has(p.segment.kind) && p.first);
  return firstSeq !== null && call.parts.some((p) => p.segment.seq === firstSeq && p.first);
}

/**
 * The resume decision kept in `metadata_json.coverage.resume`, read on its own (the computed coverage beside it may not
 * be written yet, and parseCoverage reads only a whole coverage).
 */
export function readResumeDecision(documentId: string): ResumeDecision | null {
  const meta = parseJson<Record<string, unknown>>(db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get()?.m, {});
  const cov = meta.coverage && typeof meta.coverage === 'object' ? (meta.coverage as Record<string, unknown>) : null;
  if (!cov?.resume) return null;
  const r = resumeDecision.safeParse(cov.resume);
  return r.success ? r.data : null;
}

/** Writes `coverage.resume`, first making sure the coverage it sits in is whole (worked out now when it is missing). */
export function writeResumeDecision(documentId: string, decision: ResumeDecision): ResumeDecision {
  const meta = parseJson<Record<string, unknown>>(db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get()?.m, {});
  if (!parseCoverage(meta)) {
    try {
      if (listSegments(documentId).length) writeCoverage(documentId);
      else writeLegacyCoverage(documentId);
    } catch {
      // the decision is written either way
    }
  }
  patchCoverageMeta(documentId, { resume: decision });
  return decision;
}

/**
 * True when a yes the user gave covers this estimate: the reading he said yes to is not dearer now (a quarter of slack,
 * plus a cent). A yes to $6 does not cover a later $40 reading of new pages.
 */
export function approvalCovers(prior: ResumeDecision | null | undefined, estimateUsd: number): boolean {
  // A yes to reading again the pages with missed lab lines is not a yes to reading the rest.
  return prior?.decision === 'approved' && prior.kind !== 'labcheck' && estimateUsd <= prior.estimateUsd * 1.25 + 0.01;
}

/** True while the lab check's question (read again the pages with missed lab lines?) waits for the user's answer. */
export function labCheckQuestionPending(d: ResumeDecision | null | undefined): boolean {
  return d?.kind === 'labcheck' && d.decision === 'ask';
}

/** The ceiling check of an automatic resume: under the ceiling (or approved) it reads; above it, it asks once. */
function ceilingGate(documentId: string, scope: ExtractionScope, deep: boolean, opts: { pages?: Array<[number, number]>; runId?: string | null }): { go: boolean; decision?: ResumeDecision } {
  const prior = readResumeDecision(documentId);
  const est = estimateSegments(documentId, scope, deep, { pages: opts.pages, automatic: true, runId: opts.runId });
  if (!est.calls) return { go: true };
  if (approvalCovers(prior, est.approxUsd)) return { go: true };
  const ceiling = Number(getSetting('ai.autoResumeCeilingUsd'));
  const at = nowIso();
  if (Number.isFinite(ceiling) && ceiling > 0 && est.approxUsd <= ceiling) {
    const decision: ResumeDecision = { at, estimateUsd: est.approxUsd, ceilingUsd: ceiling, decision: 'auto', pagesLeft: est.pages, segmentsLeft: est.segments, decidedAt: at, decidedBy: 'auto' };
    // The lab check's question still waiting keeps its place (this note only says the rest went ahead by itself).
    if (!labCheckQuestionPending(prior)) writeResumeDecision(documentId, decision);
    return { go: true, decision };
  }
  if (prior?.decision === 'declined' && prior.kind !== 'labcheck') return { go: false, decision: prior };
  const decision: ResumeDecision = { at, estimateUsd: est.approxUsd, ceilingUsd: Number.isFinite(ceiling) ? Math.max(0, ceiling) : 0, decision: 'ask', pagesLeft: est.pages, segmentsLeft: est.segments, decidedAt: null, decidedBy: null };
  writeResumeDecision(documentId, decision);
  return { go: false, decision };
}

/** The `extract_facts` (and `resume_extraction`) job: one pass, resumable. */
export async function extractFactsJob(ctx: JobContext<ExtractFactsPayload>): Promise<ExtractFactsResult> {
  const p = ctx.payload;
  const documentId = p.documentId;
  const deep = Boolean(p.deep);
  if (!documentId) throw new Error('extract_facts: documentId missing');
  const doc0 = liveDocumentRow(documentId);
  if (!doc0) throw new Error('document not found');
  const model = modelFor(deep);
  const automatic = p.reason === 'unlock' || p.reason === 'upload';

  // The pass this job ran already ended (stopped after its end was written): nothing is read again; the steps after the
  // pass (idempotent) run once more, since the stop may have cut them short.
  const ended = endedRun(p.runId, documentId);
  if (ended) {
    const outcome: PassOutcome = ended.status === 'cancelled' ? 'cancelled' : (doc0.extractionStatus === 'partial' ? 'partial' : 'done');
    if (listSegments(documentId).length) {
      try {
        const cov = writeCoverage(documentId, { runId: ended.id });
        await afterPass(documentId, { documentId, runId: ended.id, outcome, segmentIds: [], factsCreated: 0, coverage: cov });
      } catch (err) {
        console.warn(`[extraction] afterPass again for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (ended.status === 'done') {
      try {
        enqueueRulesAfterIngest([documentId], rulesTrigger(p.reason));
      } catch {
        // the next pass or unlock runs them
      }
    }
    ctx.setProgress(1, `${(doc0.title || 'document').replace(/\s+/g, ' ').slice(0, 60)}: already read (this reading had finished)`);
    return { runId: ended.id, model: ended.model, chunks: ended.chunks, factsCount: ended.factsCount, droppedAsKept: 0, mergesProposed: ended.mergesProposed, citations: 0, verifiedCitations: 0, retired: 0, keptUserWork: 0, keptLinked: 0, outcome };
  }

  // Cancelled (not stopped by a lock) before the pass began: the document must not read "queued" for good.
  const releaseIfCancelled = () => {
    if (!ctx.signal.aborted || (ctx.stillOwned && !ctx.stillOwned())) return;
    try {
      resetStatusAfterCancel(documentId, { prevStatus: p.prevStatus });
    } catch {
      // best effort
    }
  };

  try {
    await waitForText(documentId, ctx.signal);
  } catch (err) {
    releaseIfCancelled();
    throw err;
  }
  if (!hasPageText(documentId)) {
    const runId = beginRun(documentId, { model, deep });
    failRun(runId, documentId, 'document has no page text to extract from');
    throw new Error('document has no page text to extract from (run ingestion first)');
  }

  // The segments: cut now if the document has none (or an older segmenter cut it), read what was read before them.
  try {
    await ensureSegmented(documentId, { reason: p.reason === 'unlock' ? 'unlock' : automatic ? 'ingest' : 'reprocess', signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted) {
      releaseIfCancelled();
      throw err;
    }
    console.warn(`[extraction] segmentation of ${documentId} failed (${err instanceof Error ? err.message : String(err)}); reading it in blocks of pages`);
  }
  if (!listSegments(documentId).length) fallbackSegments(documentId);
  try {
    adoptLegacySegments(documentId);
  } catch (err) {
    console.warn(`[extraction] could not adopt the earlier reading of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Details read before segments existed (or from a part a re-cut superseded) are linked to the part they were read
  // from, so a repeat read now merges into them instead of making a second copy (rev-engine F1, F7).
  try {
    linkUnplacedFacts(documentId);
  } catch (err) {
    console.warn(`[extraction] could not place the earlier details of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const scope: ExtractionScope = p.scope && EXTRACTION_SCOPES.includes(p.scope) ? p.scope : defaultScopeFor(doc0.extractionStatus === 'queued' || doc0.extractionStatus === 'running' ? p.prevStatus : doc0.extractionStatus);
  const continuing = continuableRun(p.runId, documentId, model);

  // An automatic resume above the ceiling asks first (once) and reads nothing.
  if (p.ceilingCheck && !continuing) {
    const gate = ceilingGate(documentId, scope, deep, { pages: p.pages });
    if (!gate.go) {
      const status = settledExtractionStatus(documentId);
      db().update(schema.documents).set({ extractionStatus: status === 'done' ? 'done' : status === 'none' ? 'none' : 'partial', updatedAt: nowIso() }).where(eq(schema.documents.id, documentId)).run();
      ctx.setProgress(1, `waiting for your go-ahead (about $${(gate.decision?.estimateUsd ?? 0).toFixed(2)})`);
      return { runId: '', model, chunks: 0, factsCount: 0, droppedAsKept: 0, mergesProposed: 0, citations: 0, verifiedCitations: 0, retired: 0, keptUserWork: 0, keptLinked: 0, outcome: 'waiting', resume: gate.decision };
    }
  }

  const runId = continuing ?? beginRun(documentId, { model, deep });
  if (continuing) reopenRun(runId, documentId);
  rememberRun(ctx, runId, scope);
  // A reading asked for now answers a pending "carry on?" (it would otherwise still show as waiting for a yes). The lab
  // check's own re-read of a few pages is not such a reading.
  if (!automatic && !continuing && p.reason !== 'labcheck') {
    try {
      const prior = readResumeDecision(documentId);
      if (prior && (prior.decision === 'ask' || prior.decision === 'declined')) {
        const at = nowIso();
        writeResumeDecision(documentId, { ...prior, decision: 'approved', decidedAt: at, decidedBy: p.reason === 'consult' ? 'clinician' : 'user' });
      }
    } catch {
      // bookkeeping only
    }
  }

  const state: PassState = {
    documentId,
    runId,
    model,
    deep,
    totals: { runId, model, chunks: 0, factsCount: 0, droppedAsKept: 0, mergesProposed: 0, citations: 0, verifiedCitations: 0, retired: 0, keptUserWork: 0, keptLinked: 0, droppedMessagingActs: 0 },
    aiCallIds: [],
    readSets: new Map(),
    mergedInto: new Set(),
    failed: new Map(),
    done: new Set(),
    reread: new Set(),
    settledWithoutCall: 0,
    wrote: false,
    fieldsApplied: false,
  };

  const live = listSegments(documentId);
  const targets = selectTargets(live, scope, { runId: continuing, pages: p.pages, automatic, settledOnly: p.reason === 'labcheck' });
  // A part with nothing for the model (every page a twin or blank) is settled without a call.
  const withText: SegmentWithText[] = [];
  for (const s of targets) {
    const texts = textsOf(documentId, s);
    // Scope pages: a settled part is read again on the asked pages only (it stays settled); an unread one whole.
    const narrowed = texts && scope === 'pages' ? narrowToPages(s, texts, p.pages) : null;
    const pages = narrowed ? narrowed.pages : texts;
    if (narrowed?.only) {
      if (pages?.length) withText.push({ segment: s, pages, only: true });
      continue;
    }
    if (pages === null) {
      // Never settled silently: the part is failed with the reason and read again later.
      markCallFailed(state, { route: 'extract', parts: [{ segment: s, pages: [], first: true, last: true }], chars: 0, pageCount: 0 }, { kind: 'other', message: 'its text could not be prepared for reading', transient: true });
      continue;
    }
    if (pages.length) withText.push({ segment: s, pages });
    else {
      updateSegment(s.id, { status: 'no_text', skipReason: 'no_text', extractionRunId: runId, error: null });
      state.settledWithoutCall++;
    }
  }
  const maxPages = Number(getSetting('ai.maxPagesPerChunk')) || 24;
  // The lab lines to name in the calls: the lab check's own list, else (a pages reading, or the lab check's re-read of
  // more lines than its job carries) the lines missed on those pages now, worked out again (no AI).
  let hintRows: Array<{ page: number; text: string }> = [];
  try {
    hintRows = (p.labHint?.length ? p.labHint : scope === 'pages' ? labHintFor(documentId, p.pages ?? null) : []).filter((h) => h && Number.isInteger(h.page) && typeof h.text === 'string').slice(0, MAX_HINT_ROWS);
  } catch {
    hintRows = [];
  }
  // A reading that names lines is read in small calls, each naming a bounded number of them (2026-10-09, lab recall).
  const queue = planReadingCalls(withText, { maxPages, hint: hintRows });
  const docMeta = parseJson<Record<string, unknown>>(doc0.metadataJson, {});
  const exportInfo = parseExportInfo(docMeta);
  const isExport = Boolean(exportInfo) || live.some((s) => ['outline', 'banner'].includes(parseSegmentDetail(s.detailJson).source ?? ''));
  const firstSeq = live.length ? Math.min(...live.map((s) => s.seq)) : null;
  let forms: ReturnType<typeof pageTextFormsLookup> | null = null;
  const formsOf = (n: number) => {
    forms ??= pageTextFormsLookup(documentId);
    return forms(n);
  };
  const totalPages = doc0.pageCount || Math.max(0, ...live.map((s) => s.pageEnd));
  const shortTitle = (doc0.title || 'document').replace(/\s+/g, ' ').slice(0, 60);
  let inFlight: string[] = [];
  let consecutive = 0;
  let stopReason: string | null = null;
  let stopError: Error | null = null;
  let callIndex = 0;
  /**
   * Pages of the calls this attempt sent (answered or failed): only the named lines printed there have had their re-read.
   * Lines on pages a stop or a continued pass never reached stay to be read again (2026-10-09, lab recall).
   */
  const attemptedPages = new Set<number>();
  const callsPlanned = queue.length;
  const passStarted = Date.now();
  /** The log's progress line: the document id, part x of y, pages, calls done, what they cost so far, time left (never the title or text). */
  const logProgress = (a: number, b: number) => {
    const done = callIndex;
    let spent = 0;
    try {
      if (state.aiCallIds.length) spent = db().get<{ usd: number }>(sql`select coalesce(sum(estimated_usd), 0) as usd from ai_calls where id in (${sql.join(state.aiCallIds.map((id) => sql`${id}`), sql`, `)})`)?.usd ?? 0;
    } catch {
      // the log line is a courtesy
    }
    const left = done > 0 ? Math.round((((Date.now() - passStarted) / done) * (callsPlanned - done)) / 60_000) : null;
    log.info('reading', `document ${documentId}: part ${Math.min(done + 1, callsPlanned)} of ${callsPlanned}, pages ${a}-${b} of ${totalPages}; ${done} call${done === 1 ? '' : 's'} done, about $${spent.toFixed(2)} so far${left !== null ? `, about ${left} min left` : ''}`);
  };
  /** Calls that came back but were not written (the document was deleted or the pass cancelled meanwhile). */
  const unwritten: string[] = [];
  const exportLabel = exportInfo ? (exportInfo.layout === 'unknown' ? 'record export' : exportInfo.layout) : isExport ? 'chart_print' : null;

  /**
   * Ends the pass: leftovers retired, coverage written, the run's and the document's status (done only when every page
   * is accounted for), afterExtraction (also after partial), afterPass, the rules after ingestion. Returns the outcome
   * and the coverage.
   */
  const finalize = async (cancelled: boolean, message: string | null, leftPending: number): Promise<{ outcome: PassOutcome; cov: DocumentCoverage }> => {
    try {
      state.totals.retired += retireStaleFacts(documentId);
      state.totals.retired += retireUnrepeated(state);
    } catch (err) {
      console.warn(`[extraction] leftover facts of ${documentId} not retired: ${err instanceof Error ? err.message : String(err)}`);
    }
    const cov = writeCoverage(documentId, { runId });
    const runChunks = db().select({ chunks: schema.extractionRuns.chunks }).from(schema.extractionRuns).where(eq(schema.extractionRuns.id, runId)).get()?.chunks ?? 0;
    // Nothing came back in the whole pass, and something failed (a part, or AI off / no key stopping it at once).
    const runFailed = state.done.size === 0 && runChunks === 0 && (state.failed.size > 0 || stopError !== null);
    let docStatus: string = extractionStatusFor(cov, { runFailed });
    if (docStatus === 'failed' && (cancelled || cov.pagesDone > 0)) docStatus = settledExtractionStatus(documentId);
    if (docStatus === 'none' && !cancelled) docStatus = 'failed';
    const outcome: PassOutcome = cancelled ? 'cancelled' : docStatus === 'done' ? 'done' : docStatus === 'failed' ? 'failed' : 'partial';
    const runStatus = cancelled ? 'cancelled' : runFailed ? 'failed' : state.failed.size > 0 || stopReason || leftPending > 0 ? 'partial' : 'done';
    const now = nowIso();
    db().update(schema.extractionRuns)
      .set({ status: runStatus, finishedAt: now, error: message ? message.slice(0, 2000) : null })
      .where(eq(schema.extractionRuns.id, runId))
      .run();
    db().update(schema.documents)
      .set({ extractionStatus: docStatus, ...(docStatus === 'done' ? { extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION } : {}), updatedAt: now })
      .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
      .run();
    if (state.wrote || state.totals.retired) afterExtraction(documentId);
    try {
      await afterPass(documentId, { documentId, runId, outcome, segmentIds: [...new Set([...state.done, ...state.failed.keys(), ...state.reread])], factsCreated: state.totals.factsCount, coverage: cov });
    } catch (err) {
      console.warn(`[extraction] afterPass for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The lab check (no AI): every lab line on the pages read is held by a detail, else read again once (a job), else
    // added from the page. Never fails the pass. Not after a cancel (the rest is read later), except the lab check's own
    // re-read stopped by the user: it is over, so its lines are added from the page (a lock resumes it instead).
    const labRereadStopped = cancelled && p.reason === 'labcheck' && (!ctx.stillOwned || ctx.stillOwned());
    if (!cancelled || labRereadStopped) {
      try {
        const lab = await labCheckAndFollowUp(documentId, {
          trigger: p.reason === 'labcheck' ? 'reread' : 'pass',
          rereadEnded: p.reason === 'labcheck' ? { outcome } : null,
          ownJobId: ctx.job.id,
          hinted: hintRows.filter((h) => attemptedPages.has(h.page)),
        });
        state.totals.labCheck = { rowsFound: lab.report?.rowsFound ?? 0, missed: lab.report?.missed ?? 0, rereadJobId: lab.rereadJobId, added: lab.added };
      } catch (err) {
        console.warn(`[extraction] lab check for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Checked against itself (2026-10-09, services/self-check.ts): a new upload, or a document already checked, has its
    // lab flags compared with their own values and ranges (no AI) and its parts still to read queued for Claude to read
    // for contradictions (under the per-document limit, else it asks once). Never fails the pass.
    if (!cancelled) {
      try {
        (await import('../services/self-check')).afterReadingPass(documentId, { outcome, reason: p.reason ?? null });
      } catch (err) {
        console.warn(`[extraction] check against itself for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (state.wrote || state.totals.retired) {
      try {
        enqueueRulesAfterIngest([documentId], rulesTrigger(p.reason));
      } catch (err) {
        console.warn(`[extraction] rules after ingestion not queued: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { outcome, cov };
  };

  const owned = () => !ctx.stillOwned || ctx.stillOwned();

  try {
    while (queue.length) {
      const call = queue.shift()!;
      if (ctx.signal.aborted) throw new Error('cancelled');
      const current = liveDocumentRow(documentId);
      if (!current) throw new JobCancelledError(DOCUMENT_DELETED_MESSAGE);
      const pagesHere = call.parts.flatMap((pp) => pp.pages.map((pg) => pg.pageNumber));
      const a = Math.min(...pagesHere);
      const b = Math.max(...pagesHere);
      // A settled part read again on some pages stays settled while it is read (a stop leaves it as it was).
      inFlight = call.parts.filter((pp) => !pp.only).map((pp) => pp.segment.id);
      if (inFlight.length) markSegments(inFlight, { status: 'running', extractionRunId: runId });
      ctx.setProgress(callIndex / Math.max(1, callsPlanned), `${shortTitle}: reading pages ${a}-${b} (${Math.min(callIndex + 1, callsPlanned)} of ${callsPlanned})`);
      logProgress(a, b);
      callIndex++;
      for (const pg of pagesHere) attemptedPages.add(pg);
      let res: { data: ExtractionOutput; callId: string; model: string };
      try {
        const parts: PartInput[] = call.parts.map((pp) => {
          const detail = parseSegmentDetail(pp.segment.detailJson);
          const pgs = pp.pages.map((pg) => pg.pageNumber);
          return {
            kind: pp.segment.kind,
            headerText: pp.segment.headerText,
            encounterDateText: pp.segment.encounterDateText,
            encounterType: pp.segment.encounterType,
            department: pp.segment.department,
            section: detail.section ?? null,
            item: detail.item ?? null,
            sourceTier: pp.segment.sourceTier,
            segmentPages: [pp.segment.pageStart, pp.segment.pageEnd],
            continued: pp.first && pp.last && !pp.only ? null : { from: Math.min(...pgs), to: Math.max(...pgs) },
            pages: pp.pages.map((pg) => ({ pageNumber: pg.pageNumber, text: pg.text })),
          };
        });
        // Blocks of pages of an unknown layout read as before parts existed: one run of pages, no part lines.
        const plainPages = call.parts.every((pp) => pp.segment.kind === 'pages' && !pp.segment.headerText);
        // The lab lines the lab check found on these pages that no detail holds: each must become its own fact.
        const mustInclude = hintRowsOfCall(call, hintRows);
        // Result tables in this call: every printed row is its own fact (said in the user message).
        const labTables = mustInclude.length > 0 || call.parts.some((pp) => isLabDense(pp.segment));
        const content = plainPages
          ? buildExtractionUserMessage({
              title: current.title,
              category: current.category,
              totalPages,
              pages: parts.flatMap((pt) => pt.pages).sort((x, y) => x.pageNumber - y.pageNumber),
              documentDateText: current.documentDateText ?? current.documentDate,
              documentDateSource: documentDateSource(current),
              sourceTier: current.sourceTier,
              mustInclude,
              labTables,
            })
          : buildPartsUserMessage({
              title: current.title,
              category: current.category,
              totalPages,
              parts,
              documentDateText: current.documentDateText ?? current.documentDate,
              documentDateSource: documentDateSource(current),
              sourceTier: current.sourceTier,
              exportLayout: exportLabel,
              mustInclude,
              labTables,
            });
        res = await callStructured<ExtractionOutput>({
          purpose: 'extract_facts',
          deep,
          model,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
          schema: extractionOutput,
          maxTokens: 64_000,
          timeoutMs: 30 * 60 * 1000,
          effort: getSetting('ai.extraction.effort'),
          documentIds: [documentId],
          jobId: ctx.job.id,
          signal: ctx.signal,
          requestSummary: `extract ${current.title} p.${a}-${b}`,
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (err instanceof AiDisabledError || err instanceof NoApiKeyError) {
          stopError = err;
          stopReason = err.message;
          break;
        }
        // Output overflowed: split the call (by parts, else by pages) and read each half.
        if (err instanceof Error && /max_tokens/i.test(err.message)) {
          if (call.parts.length > 1) {
            const mid = Math.ceil(call.parts.length / 2);
            const left: PlannedCall = { route: call.route, parts: call.parts.slice(0, mid), chars: 0, pageCount: 0 };
            const right: PlannedCall = { route: call.route, parts: call.parts.slice(mid), chars: 0, pageCount: 0 };
            queue.unshift(left, right);
            continue;
          }
          const only = call.parts[0];
          if (only.pages.length > 1) {
            const mid = Math.ceil(only.pages.length / 2);
            // Some pages of a settled part read again stay exactly those pages in each half (2026-10-09 review: without
            // `only`, the half holding the part's last slice stood for the whole part, and the part's details cited on
            // pages not read again were retired).
            const keep = only.only ? { only: true as const } : {};
            queue.unshift(
              { route: call.route, parts: [{ segment: only.segment, pages: only.pages.slice(0, mid), first: only.first, last: false, ...keep }], chars: 0, pageCount: 0 },
              { route: call.route, parts: [{ segment: only.segment, pages: only.pages.slice(mid), first: false, last: only.last, ...keep }], chars: 0, pageCount: 0 },
            );
            continue;
          }
        }
        const f = classifyFailure(err);
        markCallFailed(state, call, f);
        // The rest of a long segment is not read once a slice of it failed.
        for (let i = queue.length - 1; i >= 0; i--) {
          const q = queue[i];
          q.parts = q.parts.filter((pp) => !state.failed.has(pp.segment.id));
          if (!q.parts.length) queue.splice(i, 1);
        }
        inFlight = [];
        consecutive = f.transient && f.kind !== 'schema' ? consecutive + 1 : 0;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = `stopped after ${consecutive} calls in a row failed (${f.message})`;
          break;
        }
        continue;
      }
      // The call took a while: nothing is written for a run cancelled meanwhile, or for a document deleted meanwhile.
      unwritten.push(res.callId);
      if (ctx.signal.aborted) throw new Error('cancelled');
      const after = liveDocumentRow(documentId);
      if (!after) throw new JobCancelledError(DOCUMENT_DELETED_MESSAGE);
      unwritten.pop();
      consecutive = 0;
      writeCall(state, call, res, { docTier: after.sourceTier, forms: formsOf });
      inFlight = [];
      if (!state.fieldsApplied && !call.parts.some((pp) => pp.only) && mayApplyFields(call, isExport, firstSeq)) {
        state.fieldsApplied = true;
        try {
          applyDocumentFields(documentId, res.data, { runId, model: res.model });
        } catch (err) {
          console.warn(`[extraction] document fields of ${documentId} not applied: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (ctx.signal.aborted) throw new Error('cancelled');
    if (!liveDocumentRow(documentId)) throw new JobCancelledError(DOCUMENT_DELETED_MESSAGE);
    if (inFlight.length) releaseRunning(state, inFlight);
    // A stop leaves the parts it did not reach pending (never marked running).
    const leftPending = queue.reduce((n, q) => n + q.parts.length, 0);
    const failures = [...state.failed.entries()];
    const summary = failures.length
      ? `${failures.length} part${failures.length === 1 ? '' : 's'} could not be read${stopReason ? `; ${stopReason}` : ''}`
      : stopReason;
    const { outcome, cov } = await finalize(false, summary, leftPending);
    state.totals.outcome = outcome;
    state.totals.segments = { targets: targets.length, done: state.done.size, failed: failures.length, settledWithoutCall: state.settledWithoutCall, leftPending };
    state.totals.coverageText = coverageInWords(cov);
    const kept = state.totals.keptUserWork + state.totals.keptLinked;
    ctx.setProgress(1, `${shortTitle}: ${state.totals.coverageText ?? 'read'}; ${state.totals.factsCount} facts, ${state.totals.verifiedCitations}/${state.totals.citations} citations verified${kept ? `; ${kept} earlier fact${kept === 1 ? '' : 's'} kept (edited, noted or linked)` : ''}`);
    if (stopError) throw stopError;
    if (failures.length || stopReason) {
      // The queue retries once; the retry continues this pass and reads only what is still missing.
      const reasons = [...new Set(listSegments(documentId).filter((s) => state.failed.has(s.id)).map((s) => s.error ?? 'could not be read'))].slice(0, 3);
      const noRetry = !stopReason && failures.every(([, transient]) => !transient);
      throw new PassIncompleteError(`${summary}${reasons.length ? ` (${reasons.join('; ')})` : ''}`, noRetry);
    }
    return state.totals;
  } catch (err) {
    if (err instanceof PassIncompleteError || err === stopError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // A lock or restart took the job: write nothing (the unlock repair resets what was in flight; the job is re-queued
    // and continues this pass).
    if (!owned()) throw err instanceof Error ? err : new Error(message);
    const partial = { factsCount: state.totals.factsCount, mergesProposed: state.totals.mergesProposed, chunks: state.totals.chunks, aiCallIds: state.aiCallIds };
    // Deleted while running (the delete also aborts the job): the facts written so far were soft-deleted with the
    // document and come back with it on a restore; nothing else is written and the job is not retried.
    let deleted = err instanceof JobCancelledError;
    if (!deleted) {
      try {
        deleted = !liveDocumentRow(documentId);
      } catch {
        // locked mid-run: the queue re-queues the job on unlock
        throw err instanceof Error ? err : new Error(message);
      }
    }
    try {
      if (inFlight.length) releaseRunning(state, inFlight);
    } catch {
      // best effort
    }
    if (deleted) {
      try {
        // The run says what came back: the calls written, plus one that came back after the delete and was not written.
        const run = db().select({ chunks: schema.extractionRuns.chunks, factsCount: schema.extractionRuns.factsCount, mergesProposed: schema.extractionRuns.mergesProposed, aiCallIdsJson: schema.extractionRuns.aiCallIdsJson }).from(schema.extractionRuns).where(eq(schema.extractionRuns.id, runId)).get();
        cancelRun(runId, documentId, DOCUMENT_DELETED_MESSAGE, run ? { factsCount: run.factsCount, mergesProposed: run.mergesProposed, chunks: run.chunks + unwritten.length, aiCallIds: [...parseJson<string[]>(run.aiCallIdsJson, []), ...unwritten] } : partial);
      } catch {
        // locked
      }
      throw err instanceof JobCancelledError ? err : new JobCancelledError(DOCUMENT_DELETED_MESSAGE);
    }
    if (ctx.signal.aborted || message === 'cancelled') {
      // Cancelled by the user: what was read is kept (each call was written whole); the rest stays to be read.
      try {
        await finalize(true, 'cancelled', 0);
      } catch (e) {
        console.warn(`[extraction] could not close the cancelled pass of ${documentId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      throw err instanceof Error ? err : new Error(message);
    }
    // Anything else (an error writing a call, a bug): the pass ends with what it wrote; the queue may retry.
    try {
      await finalize(false, message, 0);
    } catch (e) {
      console.warn(`[extraction] could not close the pass of ${documentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw err instanceof Error ? err : new Error(message);
  }
}

/** The `resume_extraction` job: Continue reading (scope missing by default), the after-unlock resume. */
export async function resumeExtractionJob(ctx: JobContext<ResumeExtractionPayload>): Promise<ExtractFactsResult> {
  const p = ctx.payload;
  const automatic = p.reason === 'unlock' || p.reason === 'upload';
  return extractFactsJob({
    ...ctx,
    payload: {
      documentId: p.documentId,
      deep: p.deep,
      scope: p.scope ?? 'missing',
      pages: p.pages,
      batchId: p.batchId,
      runId: p.runId,
      reason: p.reason,
      prevStatus: p.prevStatus,
      ceilingCheck: automatic && !p.approved,
    },
  } as JobContext<ExtractFactsPayload>);
}
