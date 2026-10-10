/**
 * Ask the case: sessions, questions, and the background generation that
 * answers them. A question inserts a user message and a pending assistant
 * message, then runs the agentic loop in the background (never awaited by
 * the request): assemble the context, call the model with tools, run every
 * tool_use in parallel, loop until the model stops, map the final content to
 * numbered citations, persist. A registry keeps the live text/thinking so
 * the SSE stream can replay and follow; partial text is persisted every few
 * seconds so a closed browser never loses an answer.
 *
 * `callText` and `countTokens` are injectable (GenerateDeps) so the loop is
 * tested without the API.
 */
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { callText as realCallText, countTokens as realCountTokens, estimateUsd, AiRefusedError, type TextCallResult } from '../ai/client';
import {
  answerTokensOf,
  charsPerTokenFor,
  firstTurnLimit,
  fitToolResults,
  historyLimit,
  NO_ROOM_NOTE,
  presetKindOf,
  promptLimit,
  promptTokensOf,
  promptTooLong,
  tooLongWords,
  turnsToDrop,
  withinWindow,
  type PresetKind,
} from './ask-budget';
import { locateQuote } from '../ai/citations';
import { ASK_SYSTEM_PROMPT, buildQuestionText } from '../ai/prompts/ask';
import {
  CONTEXT_RESERVE_TOKENS,
  TOKEN_RE,
  caseTimeZone,
  composeMessages,
  contextPreview,
  estimateTokens,
  localDayOf,
  localTimeOf,
  moveCacheBreakpoint,
  pageText,
  pagesFor,
  parseTokens,
  prepareContext,
  tokC,
  tokD,
  tokF,
  type Assembled,
  type LedgerSection,
  type PreparedContext,
  type PriorTurn,
  type SelectedPage,
} from './ask-context';
import { ASK_TOOLS, runTool } from './ask-tools';
import { CARE_TOOL_NAMES, careTeamAskTools, newCareToolContext, runCareTeamTool, type CareToolContext } from './care-team-ask';
import { webSearchCaps } from './web-search';
import { visualPageText } from '../ingest/reflow';
import { getSetting } from './settings';
import { indexEntity } from './search';
import { onLockChange, touch } from '../auth';
import { badRequest, conflict, notFound, parseOrThrow } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { DEFAULT_CONSULT_PRESETS, LONG_TEXT_MAX, type ConsultPreset } from '../../shared/constants';
import type { ChartSpec } from '../../shared/chart';
import type {
  AskAttachment,
  AskCitationRef,
  AskCitationRow,
  AskEvent,
  AskLabValue,
  AskMessageFull,
  AskMeta,
  AskMode,
  AskScope,
  AskSession,
  AskSessionDetail,
  AskSessionListItem,
  AskStatus,
  AskUsage,
  AskUserMeta,
  ContextPreview,
  DocIndexEntry,
  PageRef,
  SendMessageBody,
} from '../../shared/ask';
import { ASK_MAX_ATTACHMENTS, answerTaskDetail, answerTaskTitle, citationSourceLine } from '../../shared/ask';

// ---------------------------------------------------------------------------
// Presets and validation
// ---------------------------------------------------------------------------

const presetSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  hint: z.string().max(300).default(''),
  model: z.string().trim().min(1).max(64),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  contextMode: z.enum(['retrieval', 'ledger', 'everything']),
  maxContextTokens: z.number().int().min(10_000).max(2_000_000),
});

export function listPresets(): ConsultPreset[] {
  const parsed = z.array(presetSchema).safeParse(getSetting('ask.presets'));
  return parsed.success && parsed.data.length ? parsed.data : DEFAULT_CONSULT_PRESETS;
}

export function resolvePreset(opts: { preset?: string | null; model?: string | null; effort?: ConsultPreset['effort'] | null; contextMode?: ConsultPreset['contextMode'] | null } = {}): ConsultPreset {
  const presets = listPresets();
  const key = opts.preset || getSetting('ask.defaultPreset') || presets[0].key;
  const base = presets.find((p) => p.key === key) ?? presets.find((p) => p.key === 'standard') ?? presets[0];
  return { ...base, model: opts.model || base.model, effort: opts.effort || base.effort, contextMode: opts.contextMode || base.contextMode };
}

export const scopeSchema = z.object({
  documentIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  from: z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
  to: z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
});

export const sendBodySchema = z.object({
  content: z.string().trim().min(1).max(LONG_TEXT_MAX),
  preset: z.string().max(40).optional(),
  model: z.string().trim().min(1).max(64).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  contextMode: z.enum(['retrieval', 'ledger', 'everything']).optional(),
  scope: scopeSchema.optional(),
  mode: z.enum(['question', 'search', 'draft', 'briefing']).optional(),
  encounterId: z.string().max(64).nullable().optional(),
  personId: z.string().max(64).nullable().optional(),
  /** Documents to read first for this question; each must be a live document (checked in askMessage). */
  attachedDocumentIds: z.array(z.string().trim().min(1).max(64)).max(ASK_MAX_ATTACHMENTS, `attach at most ${ASK_MAX_ATTACHMENTS} documents to one question`).optional(),
  /** "Search the web" for this question (off by default; the Care team, 2026-10-09). */
  webSearch: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const DEFAULT_TITLE = 'New session';

type MessageRow = typeof schema.askMessages.$inferSelect;

function metaOf(row: MessageRow): AskMessageFull['meta'] {
  const m = parseJson<unknown>(row.retrievalJson, null);
  if (m && typeof m === 'object' && !Array.isArray(m)) return m as AskMessageFull['meta'];
  return { preset: 'standard', mode: 'question' };
}

function sessionRow(id: string): AskSession {
  const s = db().select().from(schema.askSessions).where(eq(schema.askSessions.id, id)).get();
  if (!s) throw notFound('session not found');
  return s;
}

export function listSessions(): AskSessionListItem[] {
  const d = db();
  const sessions = d.select().from(schema.askSessions).orderBy(sql`${schema.askSessions.updatedAt} desc`).all();
  // Counted in SQL: only the newest message of each session has its meta read
  // (for the preset), so a long history is never parsed to list sessions.
  const rows = d.all<{ session_id: string; n: number; last: string | null; preset: unknown }>(sql`
    select m.session_id, count(*) as n, max(m.created_at) as last,
      (select case when json_valid(m2.retrieval_json) then json_extract(m2.retrieval_json, '$.preset') end
         from ask_messages m2 where m2.session_id = m.session_id
         order by m2.created_at desc, m2.rowid desc limit 1) as preset
    from ask_messages m group by m.session_id`);
  const agg = new Map(rows.map((r) => [r.session_id, { n: Number(r.n), last: r.last, preset: typeof r.preset === 'string' ? r.preset : null }]));
  return sessions.map((s) => {
    const a = agg.get(s.id);
    return { ...s, messageCount: a?.n ?? 0, lastAt: a?.last ?? null, lastPreset: a?.preset ?? null };
  });
}

export function createSession(title?: string | null): AskSession {
  const id = newId();
  const now = nowIso();
  db().insert(schema.askSessions).values({ id, title: title?.trim() || DEFAULT_TITLE, createdAt: now, updatedAt: now }).run();
  return sessionRow(id);
}

export function renameSession(id: string, title: string): AskSession {
  sessionRow(id);
  const t = title.trim();
  if (!t) throw badRequest('title is required');
  db().update(schema.askSessions).set({ title: t.slice(0, 200), updatedAt: nowIso() }).where(eq(schema.askSessions.id, id)).run();
  return sessionRow(id);
}

/** Hard delete: the session, its messages and their citations. These are conversations, not records. */
export function deleteSession(id: string): void {
  sessionRow(id);
  for (const r of running.values()) if (r.sessionId === id) r.controller.abort();
  const d = db();
  const ids = d.select({ id: schema.askMessages.id }).from(schema.askMessages).where(eq(schema.askMessages.sessionId, id)).all().map((r) => r.id);
  if (ids.length) d.delete(schema.citations).where(inArray(schema.citations.askMessageId, ids)).run();
  d.delete(schema.askMessages).where(eq(schema.askMessages.sessionId, id)).run();
  d.delete(schema.askSessions).where(eq(schema.askSessions.id, id)).run();
}

function messageRows(sessionId: string): MessageRow[] {
  return db()
    .select()
    .from(schema.askMessages)
    .where(eq(schema.askMessages.sessionId, sessionId))
    .orderBy(asc(schema.askMessages.createdAt), sql`case ${schema.askMessages.role} when 'user' then 0 else 1 end`)
    .all();
}

function citationsFor(messageIds: string[]): Map<string, AskCitationRow[]> {
  const out = new Map<string, AskCitationRow[]>();
  if (!messageIds.length) return out;
  const rows = db().select().from(schema.citations).where(inArray(schema.citations.askMessageId, messageIds)).orderBy(asc(schema.citations.createdAt)).all();
  for (const r of rows) {
    if (!r.askMessageId) continue;
    if (!out.has(r.askMessageId)) out.set(r.askMessageId, []);
    out.get(r.askMessageId)!.push({ id: r.id, askMessageId: r.askMessageId, documentId: r.documentId, pageNumber: r.pageNumber, quote: r.quote, charStart: r.charStart, charEnd: r.charEnd, verified: Boolean(r.verified), matchKind: r.matchKind });
  }
  return out;
}

/** A message left `running` by a server restart is marked as interrupted. */
function repairInterrupted(row: MessageRow): MessageRow {
  if (row.role !== 'assistant' || running.has(row.id)) return row;
  const meta = metaOf(row) as AskMeta;
  if (meta.status !== 'running') return row;
  const fixed: AskMeta = { ...meta, status: 'error', error: 'Interrupted: the server stopped while this answer was being generated.', interrupted: true, finishedAt: nowIso() };
  // The partial text was saved with the model's raw provenance tokens; resolve them as a finished answer would.
  const content = settlePartialAnswer(row.id, [{ text: row.content }], meta.docIndex ?? [], [], fixed);
  const retrievalJson = JSON.stringify(fixed);
  db().update(schema.askMessages).set({ content, retrievalJson }).where(eq(schema.askMessages.id, row.id)).run();
  return { ...row, content, retrievalJson };
}

export function getMessageFull(messageId: string): AskMessageFull {
  const row = db().select().from(schema.askMessages).where(eq(schema.askMessages.id, messageId)).get();
  if (!row) throw notFound('message not found');
  const fixed = repairInterrupted(row);
  return { ...fixed, citations: citationsFor([messageId]).get(messageId) ?? [], meta: metaOf(fixed) };
}

export function getSession(id: string): AskSessionDetail {
  const session = sessionRow(id);
  const rows = messageRows(id).map(repairInterrupted);
  const cites = citationsFor(rows.map((r) => r.id));
  return { session, messages: withCurrentAttachmentTitles(rows.map((r) => ({ ...r, citations: cites.get(r.id) ?? [], meta: metaOf(r) }))) };
}

/**
 * Attachments are shown under their document's current title (Claude may
 * have renamed the file after the question was sent); the stored meta is
 * not changed. A document deleted since keeps the title it had.
 */
function withCurrentAttachmentTitles(messages: AskMessageFull[]): AskMessageFull[] {
  const ids = new Set<string>();
  for (const m of messages) if (m.role === 'user') for (const a of (m.meta as AskUserMeta).attachments ?? []) ids.add(a.documentId);
  if (!ids.size) return messages;
  const titles = new Map(
    db()
      .select({ id: schema.documents.id, title: schema.documents.title })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, [...ids]), isNull(schema.documents.deletedAt)))
      .all()
      .map((r) => [r.id, r.title]),
  );
  return messages.map((m) => {
    const atts = m.role === 'user' ? (m.meta as AskUserMeta).attachments : undefined;
    if (!atts?.length) return m;
    return { ...m, meta: { ...m.meta, attachments: atts.map((a) => ({ ...a, title: titles.get(a.documentId) ?? a.title })) } as AskMessageFull['meta'] };
  });
}

// ---------------------------------------------------------------------------
// Registry of running generations
// ---------------------------------------------------------------------------

interface Running {
  messageId: string;
  sessionId: string;
  status: AskStatus;
  note?: string;
  thinking: string;
  text: string;
  /** Tool and chart events, replayed to late subscribers. */
  events: AskEvent[];
  listeners: Set<(ev: AskEvent) => void>;
  controller: AbortController;
  startedAt: number;
  finished: Promise<void>;
  resolveFinished: () => void;
  final?: AskEvent;
}

const running = new Map<string, Running>();

export function runningInSession(sessionId: string): string | null {
  for (const r of running.values()) if (r.sessionId === sessionId) return r.messageId;
  return null;
}

function emit(run: Running, ev: AskEvent): void {
  if (ev.type === 'status') {
    run.status = ev.status as AskStatus;
    run.note = ev.note;
  } else if (ev.type === 'tool' || ev.type === 'chart') {
    run.events.push(ev);
  }
  for (const l of run.listeners) {
    try {
      l(ev);
    } catch {
      // a broken listener must not stop generation
    }
  }
}

/**
 * Follow one message. Finished messages get `done`/`error` at once; running
 * ones get the buffered status, thinking, text, tool and chart events first,
 * then live deltas. Returns an unsubscribe function.
 */
export function subscribe(messageId: string, listener: (ev: AskEvent) => void): () => void {
  const run = running.get(messageId);
  if (run) {
    listener({ type: 'status', status: run.status, note: run.note });
    if (run.thinking) listener({ type: 'thinking', delta: run.thinking });
    if (run.text) listener({ type: 'text', delta: run.text });
    for (const ev of run.events) listener(ev);
    if (run.final) {
      listener(run.final);
      return () => undefined;
    }
    run.listeners.add(listener);
    return () => void run.listeners.delete(listener);
  }
  const message = getMessageFull(messageId);
  const meta = message.meta as AskMeta;
  if (meta.status === 'error') listener({ type: 'error', error: meta.error ?? 'failed', message });
  else listener({ type: 'done', message });
  return () => undefined;
}

export function cancelMessage(messageId: string): AskMessageFull {
  const run = running.get(messageId);
  if (run) {
    run.controller.abort();
    return getMessageFull(messageId);
  }
  const m = getMessageFull(messageId);
  if ((m.meta as AskMeta).status === 'running') throw conflict('this message is not being generated by this server instance');
  return m;
}

/** Resolves when the message's generation has finished (tests, shutdown). */
export function waitForMessage(messageId: string): Promise<void> {
  return running.get(messageId)?.finished ?? Promise.resolve();
}

try {
  onLockChange((unlocked) => {
    if (!unlocked) for (const r of running.values()) r.controller.abort();
  });
} catch {
  // not available (tests without the auth module state)
}

// ---------------------------------------------------------------------------
// Question text (user turn) and prior turns
// ---------------------------------------------------------------------------

function personFor(id: string | null | undefined) {
  if (!id) return null;
  const p = db().select().from(schema.people).where(eq(schema.people.id, id)).get();
  if (!p) return null;
  const inst = p.institutionId ? db().select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, p.institutionId)).get() : null;
  return { name: p.name, role: p.role, specialty: p.specialty, institutionName: inst?.name ?? null, preferredChannel: p.preferredChannel };
}

function encounterFor(id: string | null | undefined) {
  if (!id) return null;
  const e = db().select().from(schema.encounters).where(eq(schema.encounters.id, id)).get();
  if (!e) return null;
  const name = (pid: string | null) => (pid ? db().select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, pid)).get()?.name ?? null : null);
  const questions = parseJson<unknown[]>(e.questionsJson, []).map((q) => (typeof q === 'string' ? q : q && typeof q === 'object' && 'text' in q ? String((q as { text: unknown }).text) : '')).filter(Boolean);
  return { title: e.title, date: e.occurredAt ?? e.occurredAtText, clinicianName: name(e.clinicianId), institutionName: name(e.institutionId), questions, prepNotes: e.prepNotes };
}

function scopeTitles(scope: AskScope | undefined): string[] {
  const ids = scope?.documentIds ?? [];
  if (!ids.length) return [];
  return db().select({ title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.id, ids)).all().map((r) => r.title);
}

/**
 * The user turn: mode lines and the question, then (when documents are
 * attached) one line per attachment saying which of its pages sit in this
 * turn, and how to weigh them. `includedPages` are the pages the turn carries
 * (for a replayed turn, the ones it carried then), so the lines always match
 * what the model can actually read.
 */
export function formatQuestion(content: string, meta: AskUserMeta, askedAt: string, includedPages: PageRef[] = []): string {
  // `askedAt` is the question's time stamp (or a plain day): the model reads it as the case's local day and time, never
  // UTC (2026-10-08: a reading made in the evening read as "tomorrow").
  const text = buildQuestionText({
    question: content,
    mode: meta.mode ?? 'question',
    today: localDayOf(askedAt),
    now: localTimeOf(askedAt) || null,
    timeZone: caseTimeZone(),
    person: meta.mode === 'draft' ? personFor(meta.personId) : null,
    encounter: meta.mode === 'briefing' ? encounterFor(meta.encounterId) : null,
    scope: meta.scope ?? null,
    scopeDocumentTitles: scopeTitles(meta.scope),
  });
  const block = meta.attachments?.length ? attachmentBlock(meta.attachments, includedPages) : '';
  return block ? `${text}\n\n${block}` : text;
}

// ---------------------------------------------------------------------------
// Attached documents
// ---------------------------------------------------------------------------

/** At most this many pages of attached documents go into one question. */
export const ATTACHMENT_MAX_PAGES = 60;
/** Attached pages may use at least this many tokens even when the case summary fills the preset's budget. */
export const ATTACHMENT_MIN_TOKENS = 40_000;

/** Whitespace as SQLite's trim(x, char(32, 9, 10, 13)) sees it, so the page counts here and in SQL agree. */
const hasPageText = (t: string | null | undefined): boolean => Boolean(t && t.replace(/[ \t\r\n]+/g, '').length);
const TEXT_PAGE_SQL = sql`length(trim(${schema.documentPages.text}, char(32, 9, 10, 13))) > 0`;

/**
 * The attachments of a question: each id must be a live (not deleted)
 * document. Duplicates collapse to the first; the order is kept. `official`
 * is the document's source tier at this moment.
 */
export function resolveAttachments(ids: string[] | undefined): AskAttachment[] {
  const unique = [...new Set((ids ?? []).map((s) => s.trim()).filter(Boolean))];
  if (!unique.length) return [];
  const rows = db()
    .select({ id: schema.documents.id, title: schema.documents.title, sourceTier: schema.documents.sourceTier })
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, unique), isNull(schema.documents.deletedAt)))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) {
    throw badRequest(`attachedDocumentIds: ${missing.length === 1 ? `document ${missing[0]} is` : `documents ${missing.join(', ')} are`} not in the case (deleted, or never added); remove ${missing.length === 1 ? 'it' : 'them'} from the question and send again`);
  }
  return unique.map((id) => {
    const r = byId.get(id)!;
    return { documentId: id, title: r.title, official: r.sourceTier === 'primary' };
  });
}

/** Every page with text of each attached document (live ones only), in page order; one list per attachment. */
export function attachmentPageLists(attachments: AskAttachment[]): SelectedPage[][] {
  if (!attachments.length) return [];
  const refs = db()
    .select({ documentId: schema.documentPages.documentId, pageNumber: schema.documentPages.pageNumber })
    .from(schema.documentPages)
    .where(inArray(schema.documentPages.documentId, attachments.map((a) => a.documentId)))
    .orderBy(asc(schema.documentPages.pageNumber))
    .all();
  const pages = pagesFor(refs).filter((p) => hasPageText(p.text));
  return attachments.map((a) => pages.filter((p) => p.documentId === a.documentId).sort((x, y) => x.pageNumber - y.pageNumber));
}

/**
 * The attached pages to send, within `maxPages` and `budgetTokens`: shared
 * fairly (one page of each document in turn) and each document read from its
 * first page on, so a long attachment cannot crowd out a short one. Returned
 * in attachment order, then page order.
 */
export function pickAttachmentPages(lists: SelectedPage[][], budgetTokens = Number.POSITIVE_INFINITY, maxPages = ATTACHMENT_MAX_PAGES): SelectedPage[] {
  const taken = lists.map(() => 0);
  const done = lists.map(() => false);
  let used = 0;
  let n = 0;
  for (let round = 0; n < maxPages; round++) {
    let progressed = false;
    for (let i = 0; i < lists.length && n < maxPages; i++) {
      if (done[i]) continue;
      const page = lists[i][round];
      // A document stops at its first page that does not fit, so what is sent is always its opening pages.
      if (!page || used + page.tokens > budgetTokens) {
        done[i] = true;
        continue;
      }
      used += page.tokens;
      taken[i]++;
      n++;
      progressed = true;
    }
    if (!progressed) break;
  }
  return lists.flatMap((list, i) => list.slice(0, taken[i]));
}

/**
 * The pages a question reads: its attached pages first, then the retrieved
 * pages not already among them, within `budgetTokens`. The token trimming
 * keeps pages from the front, so attachments are the last to be dropped.
 */
export function withAttachedPages(attached: SelectedPage[], retrieved: SelectedPage[], budgetTokens = Number.POSITIVE_INFINITY): SelectedPage[] {
  const key = (p: SelectedPage) => `${p.documentId}:${p.pageNumber}`;
  const seen = new Set(attached.map(key));
  let used = attached.reduce((n, p) => n + p.tokens, 0);
  const out = attached.slice();
  for (const p of retrieved) {
    if (seen.has(key(p)) || used + p.tokens > budgetTokens) continue;
    seen.add(key(p));
    used += p.tokens;
    out.push(p);
  }
  return out;
}

/** "1–3, 5, 7–8" */
function pageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}–${sorted[i]}`);
  }
  return parts.join(', ');
}

/** The lines added after the question for its attachments (see formatQuestion). */
function attachmentBlock(attachments: AskAttachment[], includedPages: PageRef[]): string {
  const ids = attachments.map((a) => a.documentId);
  const d = db();
  const live = new Map(
    d
      .select({ id: schema.documents.id, title: schema.documents.title })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, ids), isNull(schema.documents.deletedAt)))
      .all()
      .map((r) => [r.id, r.title]),
  );
  const textPages = new Map(
    d
      .select({ documentId: schema.documentPages.documentId, n: sql<number>`count(*)` })
      .from(schema.documentPages)
      .where(and(inArray(schema.documentPages.documentId, ids), TEXT_PAGE_SQL))
      .groupBy(schema.documentPages.documentId)
      .all()
      .map((r) => [r.documentId, Number(r.n)]),
  );
  const included = new Map<string, number[]>();
  for (const p of includedPages) {
    if (!ids.includes(p.documentId)) continue;
    if (!included.has(p.documentId)) included.set(p.documentId, []);
    included.get(p.documentId)!.push(p.pageNumber);
  }
  const lines = attachments.map((a) => {
    const title = live.get(a.documentId);
    const head = `- ${(title ?? a.title).replace(/\s+/g, ' ').trim()}${title ? ` ${tokD(a.documentId)}` : ''}${a.official ? ' (official record)' : ''}`;
    if (title === undefined) return `${head}: no longer in the case file, so it is not included.`;
    const total = textPages.get(a.documentId) ?? 0;
    const pages = [...new Set(included.get(a.documentId) ?? [])];
    if (!total) return `${head}: its text was not available (it may still be waiting to be read, for example as a scan), so it is not included. Do not guess what it says; if it matters, say that it could not be read yet.`;
    if (!pages.length) return `${head}: too long to include in this question (${total} pages with text); read it with get_document_pages.`;
    if (pages.length >= total) return `${head}: ${total === 1 ? 'its one page is' : `all ${total} pages are`} included above.`;
    return `${head}: pages ${pageRanges(pages)} of its ${total} pages with text are included above; read the rest with get_document_pages if they matter.`;
  });
  const official = attachments.some((a) => a.official);
  return [
    'The patient attached these documents to this question:',
    ...lines,
    'Read them first. Where they bear on the question, rely on them, cite them, and say which statements elsewhere in the case they confirm or contradict.',
    official
      ? 'An attachment marked official record is a clinical record: for measurements and recorded events it settles disagreements with summaries and notes.'
      : 'None of them is marked as the official record, so weigh each like any other document of its kind.',
  ].join('\n');
}

/** Earlier (user, assistant) pairs of a session that produced an answer, as replayable turns. */
export function loadPriorTurns(sessionId: string, beforeUserMessageId: string): PriorTurn[] {
  const rows = messageRows(sessionId);
  const out: PriorTurn[] = [];
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    if (u.id === beforeUserMessageId) break;
    if (u.role !== 'user') continue;
    const a = rows[i + 1];
    if (!a || a.role !== 'assistant') continue;
    const am = metaOf(a) as AskMeta;
    if (!a.content.trim() || !['done', 'refused', 'cancelled'].includes(am.status)) continue;
    const um = metaOf(u) as AskUserMeta;
    out.push({ userText: formatQuestion(u.content, um, u.createdAt, am.includedPages ?? []), assistantText: markersToTokens(a.content, am.citations ?? []), includedPages: am.includedPages ?? [] });
  }
  return out;
}

/**
 * A stored answer with its `[n]` markers turned back into the provenance
 * tokens they stand for, for replaying the turn to the model: a sentence the
 * model repeats then keeps its real source, and the model never sees (or
 * learns to write) bare numbers whose meaning belongs to an older answer.
 * Ledger-only references have no token and are dropped; a number with no
 * citation behind it is shown as plain "(n)".
 */
export function markersToTokens(content: string, citations: AskCitationRef[]): string {
  const byN = new Map(citations.map((c) => [c.n, c]));
  return content.replace(/(\s*)\[(\d+)\](?!\()/g, (_m, ws: string, num: string) => {
    const c = byN.get(Number(num));
    if (!c) return `${ws}(${num})`;
    if (c.kind === 'fact' && c.factId) return `${ws}${tokF(c.factId)}`;
    if (c.kind === 'communication' && c.communicationId) return `${ws}${tokC(c.communicationId)}`;
    if (c.kind === 'page' && c.documentId) return `${ws}${tokD(c.documentId, c.pageNumber ?? null)}`;
    return ws.replace(/[^\n]/g, '');
  });
}

// ---------------------------------------------------------------------------
// Citation mapping (pure; tested with synthetic content)
// ---------------------------------------------------------------------------

export interface FactInfo {
  statement: string;
  cite: { documentId: string; pageNumber: number; quote: string; verified: boolean } | null;
}

export interface MapLookups {
  pageText: (documentId: string, pageNumber: number) => string | undefined;
  /** The page in reading order (a chart print's page rebuilt from its line boxes), when it has one. */
  readingOrderText?: (documentId: string, pageNumber: number) => string | null | undefined;
  factInfo: (factId: string) => FactInfo | null;
  /** pageNumber: where a message read out of a record is printed (its first cited page); never page 1 of an export by default. */
  communication: (id: string) => { subject: string; documentId: string | null; pageNumber?: number | null } | null;
  documentTitle: (documentId: string) => string | undefined;
}

export interface NewCitationRow {
  refIndex: number;
  documentId: string;
  pageNumber: number;
  quote: string;
  charStart: number | null;
  charEnd: number | null;
  verified: boolean;
  matchKind: string;
}

export interface MappedAnswer {
  text: string;
  citations: AskCitationRef[];
  rows: NewCitationRow[];
  /** Inline tokens whose fact, communication or document could not be found (each left a visible SOURCE_NOT_FOUND marker). */
  dropped: number;
}

/** Shown where the model cited a token that resolves to nothing on file, so the statement is visibly unsourced. */
export const SOURCE_NOT_FOUND = '[source not found]';

interface CitationLike {
  type?: string;
  document_index?: number;
  cited_text?: string;
  start_char_index?: number;
  end_char_index?: number;
}

export interface TextBlockLike {
  text: string;
  citations?: CitationLike[] | null;
}

interface TokenRef {
  kind: 'F' | 'C' | 'D';
  id: string;
  page: number | null;
}

/** The token that provenances a cited span: the F/C/D token on the same line (F first), else the nearest within 300 chars. */
export function nearestToken(text: string, start: number, end: number): TokenRef | null {
  const tokens = parseTokens(text);
  if (!tokens.length) return null;
  const lineStart = text.lastIndexOf('\n', Math.max(0, start)) + 1;
  let lineEnd = text.indexOf('\n', Math.max(end - 1, start, 0));
  if (lineEnd < 0) lineEnd = text.length;
  const onLine = tokens.filter((t) => t.start >= lineStart && t.end <= lineEnd + 1);
  const pick = (list: typeof tokens): TokenRef | null => {
    if (!list.length) return null;
    const pri = (k: string) => (k === 'F' ? 0 : k === 'C' ? 1 : 2);
    const best = list.slice().sort((a, b) => pri(a.kind) - pri(b.kind) || Math.abs(a.start - end) - Math.abs(b.start - end))[0];
    return { kind: best.kind, id: best.id, page: best.page };
  };
  const same = pick(onLine);
  if (same) return same;
  return pick(tokens.filter((t) => t.start >= start - 300 && t.start <= end + 300));
}

function clipQuote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 1500 ? t.slice(0, 1500) : t;
}

export function mapAnswer(blocks: TextBlockLike[], docIndex: DocIndexEntry[], ledger: LedgerSection[], lookups: MapLookups): MappedAnswer {
  const refs: AskCitationRef[] = [];
  const rows: NewCitationRow[] = [];
  const byKey = new Map<string, number>();
  const byIndex = new Map(docIndex.map((e) => [e.index, e]));
  const sections = new Map(ledger.map((s) => [s.key, s]));

  const addRef = (key: string, make: () => { ref: Omit<AskCitationRef, 'n'>; row?: Omit<NewCitationRow, 'refIndex'> }): number => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const n = refs.length + 1;
    const made = make();
    refs.push({ n, ...made.ref });
    if (made.row) rows.push({ refIndex: n - 1, ...made.row });
    byKey.set(key, n);
    return n;
  };

  const pageRef = (documentId: string, pageNumber: number, quote: string): number => {
    const q = clipQuote(quote) || (lookups.documentTitle(documentId) ?? 'document');
    const text = lookups.pageText(documentId, pageNumber);
    let loc = text && clipQuote(quote) ? locateQuote(text, clipQuote(quote)) : null;
    let offsets = true;
    if (!loc && clipQuote(quote) && lookups.readingOrderText) {
      // A quote read in reading order (get_document_pages on a chart print) is verified there, with no offsets.
      const visual = lookups.readingOrderText(documentId, pageNumber);
      loc = visual ? locateQuote(visual, clipQuote(quote)) : null;
      offsets = false;
    }
    return addRef(`p:${documentId}:${pageNumber}:${q.toLowerCase()}`, () => ({
      ref: { kind: 'page', documentId, documentTitle: lookups.documentTitle(documentId), pageNumber, quote: q, verified: Boolean(loc) },
      row: { documentId, pageNumber, quote: q, charStart: offsets ? (loc?.start ?? null) : null, charEnd: offsets ? (loc?.end ?? null) : null, verified: Boolean(loc), matchKind: loc?.kind ?? 'none' },
    }));
  };
  const factRef = (factId: string, fallbackQuote: string): number | null => {
    const info = lookups.factInfo(factId);
    if (!info) return null;
    return addRef(`f:${factId}`, () => {
      if (info.cite) {
        const text = lookups.pageText(info.cite.documentId, info.cite.pageNumber);
        const loc = text ? locateQuote(text, info.cite.quote) : null;
        return {
          ref: { kind: 'fact', factId, documentId: info.cite.documentId, documentTitle: lookups.documentTitle(info.cite.documentId), pageNumber: info.cite.pageNumber, quote: clipQuote(info.cite.quote), verified: Boolean(loc) },
          row: { documentId: info.cite.documentId, pageNumber: info.cite.pageNumber, quote: clipQuote(info.cite.quote), charStart: loc?.start ?? null, charEnd: loc?.end ?? null, verified: Boolean(loc), matchKind: loc?.kind ?? 'none' },
        };
      }
      return { ref: { kind: 'fact', factId, quote: clipQuote(info.statement || fallbackQuote), verified: false } };
    });
  };
  const commRef = (id: string, fallbackQuote: string): number | null => {
    const c = lookups.communication(id);
    if (!c) return null;
    return addRef(`c:${id}`, () => ({ ref: { kind: 'communication', communicationId: id, quote: clipQuote(fallbackQuote) || c.subject, documentId: c.documentId ?? undefined, pageNumber: c.documentId ? (c.pageNumber ?? 1) : undefined, verified: false } }));
  };
  const tokenRef = (t: TokenRef, fallbackQuote: string): number | null => {
    if (t.kind === 'F') return factRef(t.id, fallbackQuote);
    if (t.kind === 'C') return commRef(t.id, fallbackQuote);
    if (!lookups.documentTitle(t.id)) return null;
    return pageRef(t.id, t.page ?? 1, fallbackQuote);
  };
  const ledgerRef = (quote: string): number => addRef(`l:${clipQuote(quote).toLowerCase()}`, () => ({ ref: { kind: 'ledger', quote: clipQuote(quote), verified: false } }));

  // Inline tokens the model copied from tool results or the ledger become markers in reading order.
  // A token that resolves to nothing (mistyped or invented) leaves a visible marker and is counted.
  let dropped = 0;
  const convertInline = (text: string): string =>
    text.replace(/\s*⟦([FCD]):([0-9a-zA-Z_-]+)(?:\s+p\.(\d+))?⟧/g, (_m, kind: string, id: string, page: string | undefined) => {
      const n = tokenRef({ kind: kind as TokenRef['kind'], id, page: page ? Number(page) : null }, '');
      if (n == null) {
        dropped++;
        return ` ${SOURCE_NOT_FOUND}`;
      }
      return ` [${n}]`;
    });

  let out = '';
  for (const b of blocks) {
    // Bracketed numbers the model wrote itself (copied from an earlier answer, or its own
    // reference list) are not citation markers: they become "(n)" so only real markers render as chips.
    let text = convertInline(neutraliseMarkers(b.text ?? ''));
    const ns: number[] = [];
    for (const c of b.citations ?? []) {
      if (typeof c.document_index !== 'number') continue;
      const entry = byIndex.get(c.document_index);
      if (!entry) continue;
      const cited = c.cited_text ?? '';
      let n: number | null = null;
      if (entry.kind === 'page' && entry.documentId) {
        n = pageRef(entry.documentId, entry.pageNumber ?? 1, cited);
      } else if (entry.kind === 'ledger' && entry.key) {
        const section = sections.get(entry.key);
        const tok = section && typeof c.start_char_index === 'number' ? nearestToken(section.text, c.start_char_index, c.end_char_index ?? c.start_char_index) : null;
        n = tok ? tokenRef(tok, cited) : null;
        if (n == null) n = ledgerRef(cited || `Ledger — ${section?.title ?? entry.key}`);
      }
      if (n != null && !ns.includes(n)) ns.push(n);
    }
    if (ns.length) {
      const m = text.match(/\s*$/);
      const trail = m ? m[0] : '';
      const body = text.slice(0, text.length - trail.length);
      text = `${body}${body.endsWith(' ') ? '' : ' '}${ns.map((n) => `[${n}]`).join('')}${trail}`;
    }
    out += text;
  }

  // Collapse repeated markers for the same target, e.g. "[1] [1]".
  out = out.replace(/(\[(\d+)\])(?:\s*\[\2\])+/g, '$1');
  out = out.replace(/[ \t]+\n/g, '\n');
  return { text: out, citations: refs, rows, dropped };
}

/** "[n]" written by the model (not a link "[n](…)", not "[chart:N]") becomes "(n)". */
export function neutraliseMarkers(text: string): string {
  return text.replace(/\[(\d+)\](?!\()/g, '($1)');
}

/** Raw provenance tokens removed (with the space before each), for text that cannot be mapped. */
export function stripTokens(text: string): string {
  return text.replace(new RegExp(`\\s*${TOKEN_RE.source}`, 'g'), '');
}

/**
 * A finished answer from its per-turn text blocks: the answer is the last turn
 * that wrote text; what the earlier turns wrote (narration before their tool
 * calls) becomes plain working notes, provenance tokens removed.
 */
export function splitTurns(turns: TextBlockLike[][]): { answer: TextBlockLike[]; workingNotes: string } {
  if (!turns.length) return { answer: [], workingNotes: '' };
  const last = turns[turns.length - 1];
  const answer = last.map((b, i) => (i === 0 ? { ...b, text: b.text.replace(/^\s+/, '') } : b));
  const workingNotes = turns
    .slice(0, -1)
    .map((t) => stripTokens(t.map((b) => b.text).join('')).trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 20_000);
  return { answer, workingNotes };
}

export function detectRefusal(text: string): boolean {
  return /^\s*(\*\*|#+\s*)?Not in the case file\./i.test(text);
}

function dbLookups(): MapLookups {
  const d = db();
  const titleCache = new Map<string, string | undefined>();
  return {
    pageText,
    readingOrderText: (documentId, pageNumber) => {
      const p = d.select({ text: schema.documentPages.text, boxesJson: schema.documentPages.boxesJson }).from(schema.documentPages).where(and(eq(schema.documentPages.documentId, documentId), eq(schema.documentPages.pageNumber, pageNumber))).get();
      return p ? visualPageText(p) : null;
    },
    factInfo: (factId) => {
      const f = d.select({ statement: schema.facts.statement }).from(schema.facts).where(eq(schema.facts.id, factId)).get();
      if (!f) return null;
      const c = d
        .select()
        .from(schema.citations)
        .where(eq(schema.citations.factId, factId))
        .orderBy(sql`${schema.citations.verified} desc`, asc(schema.citations.pageNumber), asc(schema.citations.createdAt))
        .limit(1)
        .get();
      return { statement: f.statement, cite: c ? { documentId: c.documentId, pageNumber: c.pageNumber, quote: c.quote, verified: Boolean(c.verified) } : null };
    },
    communication: (id) => {
      const c = d.select({ subject: schema.communications.subject, documentId: schema.communications.documentId }).from(schema.communications).where(eq(schema.communications.id, id)).get();
      if (!c) return null;
      // A message read out of an export points at its own printed page (its first citation in that document).
      const cite = c.documentId
        ? d.select({ pageNumber: schema.citations.pageNumber }).from(schema.citations).where(and(eq(schema.citations.communicationId, id), eq(schema.citations.documentId, c.documentId))).orderBy(asc(schema.citations.pageNumber)).limit(1).get()
        : undefined;
      return { ...c, pageNumber: cite?.pageNumber ?? null };
    },
    documentTitle: (id) => {
      if (!titleCache.has(id)) titleCache.set(id, d.select({ title: schema.documents.title }).from(schema.documents).where(and(eq(schema.documents.id, id), sql`${schema.documents.deletedAt} is null`)).get()?.title);
      return titleCache.get(id);
    },
  };
}

/** Write the citation rows of a mapped answer for one message and link each reference to its row. */
function storeCitationRows(messageId: string, mapped: MappedAnswer): void {
  const createdAt = nowIso();
  db().transaction((tx) => {
    for (const row of mapped.rows) {
      const id = newId();
      tx.insert(schema.citations)
        .values({ id, askMessageId: messageId, documentId: row.documentId, pageNumber: row.pageNumber, quote: row.quote, charStart: row.charStart, charEnd: row.charEnd, verified: row.verified, matchKind: row.matchKind, createdAt })
        .run();
      mapped.citations[row.refIndex].citationId = id;
    }
  });
}

/**
 * The text of an answer that stopped early (cancelled, failed, interrupted by
 * a restart) with its inline provenance tokens resolved to numbered citations
 * exactly as a finished answer's are: rows written, meta.citations and the
 * warning flags set on `meta`. When mapping is impossible (the case locked
 * meanwhile) the raw tokens are stripped instead so they are never shown.
 */
function settlePartialAnswer(messageId: string, blocks: TextBlockLike[], docIndex: DocIndexEntry[], ledger: LedgerSection[], meta: AskMeta): string {
  const raw = blocks.map((b) => b.text).join('');
  if (!raw.trim()) return raw;
  try {
    const mapped = mapAnswer(blocks, docIndex, ledger, dbLookups());
    storeCitationRows(messageId, mapped);
    meta.citations = mapped.citations;
    meta.droppedCitations = mapped.dropped || undefined;
    meta.uncited = mapped.citations.length === 0 ? true : undefined;
    return mapped.text;
  } catch {
    return stripTokens(raw);
  }
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export interface GenerateDeps {
  callText?: typeof realCallText;
  /** Pass null to skip the pre-flight token count. */
  countTokens?: typeof realCountTokens | null;
  persistEveryMs?: number;
  heartbeatMs?: number;
  now?: () => string;
}

const zeroUsage = (): AskUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function isMaster(preset: ConsultPreset): boolean {
  return presetKindOf(preset) === 'master';
}

function isDeepOrMaster(preset: ConsultPreset): boolean {
  return presetKindOf(preset) !== 'other';
}

const pageKey = (pg: { documentId: string; pageNumber: number }): string => `${pg.documentId}:${pg.pageNumber}`;

/** An earlier turn's estimated size as it is re-sent: its question, its answer and its pages. */
function priorTurnTokens(t: PreparedContext['priorTurns'][number]): number {
  return estimateTokens(t.userText) + estimateTokens(t.assistantText) + t.pages.reduce((n, pg) => n + pg.tokens, 0);
}

export function askMessage(sessionId: string, raw: unknown, deps: GenerateDeps = {}): { userMessageId: string; assistantMessageId: string } {
  const body = parseOrThrow(sendBodySchema, raw) as SendMessageBody & { content: string };
  const session = sessionRow(sessionId);
  if (runningInSession(sessionId)) throw conflict('a question in this session is still being answered; wait for it or stop it first');
  const preset = resolvePreset({ preset: body.preset, model: body.model, effort: body.effort, contextMode: body.contextMode });
  const mode: AskMode = body.mode ?? 'question';
  const scope = body.scope && (body.scope.documentIds?.length || body.scope.from || body.scope.to) ? body.scope : undefined;
  const attachments = resolveAttachments(body.attachedDocumentIds);
  const d = db();
  const now = new Date();
  const userMessageId = newId();
  const assistantMessageId = newId();
  const userMeta: AskUserMeta = {
    preset: preset.key,
    mode,
    scope,
    encounterId: body.encounterId ?? null,
    personId: body.personId ?? null,
    model: preset.model,
    effort: preset.effort,
    contextMode: preset.contextMode,
    ...(attachments.length ? { attachments } : {}),
    ...(body.webSearch ? { webSearch: true } : {}),
  };
  const startedAt = new Date(now.getTime() + 1).toISOString();
  const meta: AskMeta = {
    preset: preset.key,
    presetLabel: preset.label,
    model: preset.model,
    effort: preset.effort,
    contextMode: preset.contextMode,
    mode,
    status: 'running',
    startedAt,
    usage: zeroUsage(),
    estimatedUsd: 0,
    thinkingSummary: '',
    turns: 0,
    toolCalls: [],
    charts: [],
    contextStats: { ledgerTokens: 0, pages: 0, pageTokens: 0, facts: 0, totalTokensApprox: 0 },
    citations: [],
    scope,
    encounterId: body.encounterId ?? null,
    personId: body.personId ?? null,
    ...(body.webSearch ? { webSearch: true } : {}),
  };
  d.insert(schema.askMessages).values({ id: userMessageId, sessionId, role: 'user', content: body.content, refused: false, retrievalJson: JSON.stringify(userMeta), createdAt: now.toISOString() }).run();
  d.insert(schema.askMessages).values({ id: assistantMessageId, sessionId, role: 'assistant', content: '', refused: false, retrievalJson: JSON.stringify(meta), createdAt: startedAt }).run();
  const set: Partial<typeof schema.askSessions.$inferInsert> = { updatedAt: nowIso() };
  if (session.title === DEFAULT_TITLE) set.title = body.content.replace(/\s+/g, ' ').trim().slice(0, 80);
  d.update(schema.askSessions).set(set).where(eq(schema.askSessions.id, sessionId)).run();

  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });
  const run: Running = { messageId: assistantMessageId, sessionId, status: 'running', note: 'queued', thinking: '', text: '', events: [], listeners: new Set(), controller: new AbortController(), startedAt: Date.now(), finished, resolveFinished };
  running.set(assistantMessageId, run);
  void generate(run, { sessionId, assistantMessageId, userMessageId, question: body.content, askedAt: now.toISOString(), userMeta, preset, meta }, deps).finally(() => {
    running.delete(assistantMessageId);
    run.resolveFinished();
  });
  return { userMessageId, assistantMessageId };
}

interface GenerateParams {
  sessionId: string;
  assistantMessageId: string;
  userMessageId: string;
  question: string;
  /** When the question was asked (the user message's time stamp); the model reads it as local time. */
  askedAt?: string;
  userMeta: AskUserMeta;
  preset: ConsultPreset;
  meta: AskMeta;
}

async function generate(run: Running, p: GenerateParams, deps: GenerateDeps): Promise<void> {
  const callText = deps.callText ?? realCallText;
  const countTokens = deps.countTokens === undefined ? realCountTokens : deps.countTokens;
  const { preset, meta } = p;
  const t0 = Date.now();
  const signal = run.controller.signal;

  const persist = (): void => {
    try {
      db().update(schema.askMessages).set({ content: run.text, retrievalJson: JSON.stringify(meta) }).where(eq(schema.askMessages.id, p.assistantMessageId)).run();
    } catch {
      // locked mid-answer; the registry still has the text
    }
  };
  const keepAlive = (): void => {
    try {
      touch();
    } catch {
      // ignore
    }
  };
  const finishWith = (status: AskStatus, extra: Partial<AskMeta> = {}): void => {
    meta.status = status;
    meta.finishedAt = (deps.now ?? nowIso)();
    meta.durationMs = Date.now() - t0;
    Object.assign(meta, extra);
  };

  let assembled: Assembled | null = null;
  // How many earlier turns of the conversation the request carries (a refusal for length then says so).
  let sentEarlierTurns = 0;
  // Text blocks of the completed model turns (with their citations), and how much of
  // run.text they cover: an answer that stops early is mapped from these plus the
  // streamed text of the turn in flight.
  const textBlocks: TextBlockLike[] = [];
  // The same blocks kept per model turn (turns that wrote text only): a finished answer
  // is the last of them; the earlier ones (narration before tool calls) are working notes.
  const textTurns: TextBlockLike[][] = [];
  let committedLen = 0;
  /** Set once the final content (markers, not tokens) has replaced run.text. */
  let mappedText: string | null = null;
  const persistTimer = setInterval(() => {
    persist();
    keepAlive();
  }, deps.persistEveryMs ?? 5000);
  const heartbeat = setInterval(() => {
    if (run.listeners.size) emit(run, { type: 'status', status: 'running', note: run.note });
  }, deps.heartbeatMs ?? 15_000);

  try {
    emit(run, { type: 'status', status: 'running', note: 'assembling the case' });
    const priorTurns = loadPriorTurns(p.sessionId, p.userMessageId);
    const askedAt = p.askedAt ?? nowIso();
    const attachments = p.userMeta.attachments ?? [];
    // Attached documents: every page of each (within the caps) goes in front of the retrieved pages.
    const attachmentLists = attachmentPageLists(attachments);
    let attachedPages = pickAttachmentPages(attachmentLists);
    let priorAttachedPages: SelectedPage[] = [];
    const questionText = formatQuestion(p.question, p.userMeta, askedAt, attachedPages);
    const presetKind: PresetKind = presetKindOf(preset);
    const master = presetKind === 'master';
    const maxTokens = answerTokensOf(preset);
    // The first turn leaves room for the answer and for looking things up (ask-budget): every later turn re-sends it.
    // A conversation's earlier turns may take it up to the history limit before the oldest give way.
    const turnLimit = firstTurnLimit(preset, presetKind, maxTokens);
    const oldTurnsLimit = historyLimit(preset, maxTokens);
    // The case summary and pages are chosen within the first turn's limit (withinWindow). In a long conversation the
    // oldest earlier turns give way when, by the estimate, the first turn would pass the history limit with no new
    // page; the retrieval then chooses again, so pages they carried can come back for this question.
    const prepare = (prior: PriorTurn[]): PreparedContext =>
      prepareContext({ questionText, retrievalQuery: p.question, preset: withinWindow(preset), scope: p.userMeta.scope, priorTurns: prior });
    let prep = prepare(priorTurns);
    const dropTurns = turnsToDrop(prep.priorTurns.map(priorTurnTokens), prep.ledgerTokens + estimateTokens(questionText) + 2500, oldTurnsLimit);
    if (dropTurns) prep = prepare(priorTurns.slice(dropTurns));
    let pages = prep.candidatePages;
    if (attachments.length) {
      // The retrieval chose its pages without the attachments; both now share the page budget the retrieval had
      // (the preset's, held to the first turn's limit). Attachments were asked for by name, so they keep a floor even
      // when the case summary fills that budget (as far as the first turn's limit allows); retrieved pages then only
      // fill what is left of the budget.
      const priorTokens = prep.priorTurns.reduce((n, t) => n + priorTurnTokens(t), 0);
      const fixed = CONTEXT_RESERVE_TOKENS + prep.ledgerTokens + priorTokens + estimateTokens(questionText);
      const pageBudget = Math.max(0, prep.preset.maxContextTokens - fixed);
      const windowRoom = Math.max(0, turnLimit - fixed);
      // Pages an earlier turn of this conversation already carries (a follow-up or a Retry with the same attachment)
      // are not sent twice; the question still lists them as included.
      const seen = (pg: SelectedPage) => prep.alreadyIncluded.has(pageKey(pg));
      const freshLists = attachmentLists.map((l) => l.filter((pg) => !seen(pg)));
      priorAttachedPages = attachmentLists.flat().filter(seen);
      attachedPages = pickAttachmentPages(freshLists, Math.min(windowRoom, Math.max(pageBudget, ATTACHMENT_MIN_TOKENS)));
      pages = withAttachedPages(attachedPages, prep.candidatePages, pageBudget);
    }
    // Earlier turns left out after a measurement (shrinkFirstTurn): the first `priorFrom`, oldest first.
    let priorFrom = 0;
    // The question lists which attached pages the turn carries, so it is rebuilt whenever the pages change.
    const compose = (pg: SelectedPage[]): Assembled => {
      const kept: PreparedContext = { ...prep, priorTurns: prep.priorTurns.slice(priorFrom) };
      sentEarlierTurns = kept.priorTurns.length;
      if (!attachments.length) return composeMessages(kept, pg);
      const carried = new Set(kept.priorTurns.flatMap((t) => t.pages.map(pageKey)));
      return composeMessages({ ...kept, questionText: formatQuestion(p.question, p.userMeta, askedAt, [...priorAttachedPages.filter((x) => carried.has(pageKey(x))), ...pg]) }, pg);
    };
    // The first turn, measured at `measured` tokens, made smaller: new pages give way from the end (retrieved pages
    // first, the attached ones in front last), by their estimated sizes scaled to the measurement, until it fits the
    // first turn's limit; then the oldest earlier turns until it fits the history limit. False when nothing could go.
    const shrinkFirstTurn = (measured: number, estimated: number): boolean => {
      const scale = measured / Math.max(1, estimated);
      let over = (measured - turnLimit) / scale;
      let keep = pages.length;
      while (keep > 0 && over > 0) over -= pages[--keep].tokens;
      over -= (oldTurnsLimit - turnLimit) / scale;
      let from = priorFrom;
      while (from < prep.priorTurns.length && over > 0) over -= priorTurnTokens(prep.priorTurns[from++]);
      if (keep === pages.length && from === priorFrom) return false;
      pages = pages.slice(0, keep);
      priorFrom = from;
      assembled = compose(pages);
      return true;
    };
    assembled = compose(pages);
    if (countTokens && isDeepOrMaster(preset)) {
      for (let round = 0; round < 3; round++) {
        if (signal.aborted) break;
        emit(run, { type: 'status', status: 'running', note: `counting tokens (${assembled.pages.length} pages)` });
        let counted: number;
        try {
          counted = await countTokens({ model: preset.model, system: ASK_SYSTEM_PROMPT, messages: assembled.messages });
        } catch {
          break;
        }
        assembled.stats.countedTokens = counted;
        // A smaller first turn is counted again in the next round, never shown with the larger one's count.
        if (counted <= turnLimit || !shrinkFirstTurn(counted, assembled.stats.totalTokensApprox)) break;
      }
    }
    meta.docIndex = assembled.docIndex;
    meta.includedPages = assembled.pages.map((pg) => ({ documentId: pg.documentId, pageNumber: pg.pageNumber }));
    meta.ledgerIncluded = assembled.ledgerIncluded;
    meta.contextStats = assembled.stats;
    persist();
    const attachedIds = new Set(attachments.map((a) => a.documentId));
    const attachedCount = attachedIds.size ? assembled.pages.filter((pg) => attachedIds.has(pg.documentId)).length : 0;
    emit(run, { type: 'status', status: 'running', note: `reading ${assembled.pages.length} page${assembled.pages.length === 1 ? '' : 's'}${attachedCount ? ` (${attachedCount} attached)` : ''} and a ${Math.round(assembled.stats.ledgerTokens / 1000)}k-token ledger` });

    const messages: Anthropic.MessageParam[] = assembled.messages.slice();
    const charts: ChartSpec[] = [];
    const proposals: string[] = [];
    // The patient's message goes with the tools: a bulk action runs as his request only when the words it quotes are in it.
    const labValues: AskLabValue[] = [];
    const toolCtx = { charts, proposals, labValues, askMessageId: p.assistantMessageId, question: p.question, unsolicited: 0, onChart: (chart: ChartSpec, n: number) => emit(run, { type: 'chart', chart, n }) };
    // The Care team's tools: get_care_team always; search_the_web and propose_care_candidate only with "Search the web" on.
    const careCtx: CareToolContext = newCareToolContext({ askMessageId: p.assistantMessageId, by: null, webSearch: Boolean(p.userMeta.webSearch), webLimit: webSearchCaps().ask, signal });
    const careMeta = (): void => {
      meta.webSources = careCtx.webSources.length ? careCtx.webSources.slice() : undefined;
      meta.webSearches = careCtx.webSearches.length ? careCtx.webSearches.slice() : undefined;
      meta.careProposals = careCtx.careProposals.length ? careCtx.careProposals.slice() : undefined;
    };
    const maxTurns = master ? 40 : 16;
    const timeoutMs = isDeepOrMaster(preset) ? 60 * 60 * 1000 : 15 * 60 * 1000;
    const showThinking = Boolean(getSetting('ask.showThinking'));
    const callIds: string[] = [];
    const usage = zeroUsage();
    let cutOff = false;
    let exhausted = false;
    // The block carrying the tool loop's moving cache breakpoint (the newest tool_result).
    let movingBreakpoint: Anthropic.ToolResultBlockParam | null = null;
    // The window across the tool loop (ask-budget). Once no useful room is left the model is told to answer from what
    // it has read (lastLookup); tools stay on ('auto'), because changing tool_choice re-writes the conversation's whole
    // cache (about 900k tokens on a full Master answer), and only a model that calls a tool anyway is asked again with
    // 'none'. A refusal for length is recovered once on the first turn and once on a later one. roomRanOut: the answer
    // had to stop reading for lack of room; windowFull: the window itself stopped the answer.
    let toolChoice: 'auto' | 'none' = 'auto';
    let lastLookup = false;
    let retriedFirst = false;
    let retriedLater = false;
    let roomRanOut = false;
    let windowFull = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (signal.aborted) throw new Error('cancelled');
      meta.turns = turn;
      if (turn > 1 && run.text && !/\n\n$/.test(run.text)) {
        const sep = run.text.endsWith('\n') ? '\n' : '\n\n';
        run.text += sep;
        emit(run, { type: 'text', delta: sep });
      }
      emit(run, { type: 'status', status: 'running', note: turn === 1 ? 'thinking' : lastLookup ? `writing the answer (turn ${turn})` : `thinking (turn ${turn})` });
      let res: TextCallResult;
      try {
        res = await callText({
          purpose: 'ask',
          model: preset.model,
          effort: preset.effort,
          system: ASK_SYSTEM_PROMPT,
          messages,
          tools: [...ASK_TOOLS, ...careTeamAskTools(careCtx.webSearch)],
          toolChoice,
          maxTokens,
          showThinking,
          timeoutMs,
          signal,
          documentIds: assembled.documentIds,
          requestSummary: `${p.question.replace(/\s+/g, ' ').slice(0, 120)} · ${preset.label} · turn ${turn}`,
          onDelta: (t) => {
            run.text += t;
            emit(run, { type: 'text', delta: t });
          },
          onThinking: (t) => {
            run.thinking += t;
            emit(run, { type: 'thinking', delta: t });
          },
        });
      } catch (err) {
        // The API refused the request for its length even so (an estimate fell short): recovered once on the first
        // turn and once on a later one, so a long answer is not lost to a second shortfall.
        const tl = promptTooLong(err);
        if (!tl || signal.aborted) throw err;
        if (turn === 1) {
          // The first turn: fewer pages (then fewer earlier turns), by how far over it was.
          if (retriedFirst || !shrinkFirstTurn(tl.tokens, assembled.stats.totalTokensApprox)) throw err;
          retriedFirst = true;
          messages.splice(0, messages.length, ...assembled.messages);
          meta.docIndex = assembled.docIndex;
          meta.includedPages = assembled.pages.map((pg) => ({ documentId: pg.documentId, pageNumber: pg.pageNumber }));
          meta.ledgerIncluded = assembled.ledgerIncluded;
          meta.contextStats = assembled.stats;
          emit(run, { type: 'status', status: 'running', note: `too long for the model; trying again with ${assembled.pages.length} pages` });
        } else {
          // A later turn: the newest tool results give way to a note, and this turn answers from what was read (the
          // moving cache breakpoint stays on the newest result).
          if (retriedLater) throw err;
          retriedLater = true;
          const last = messages[messages.length - 1];
          if (last?.role === 'user' && Array.isArray(last.content)) {
            last.content = last.content.map((b) => {
              if (b.type !== 'tool_result') return b;
              const noted: Anthropic.ToolResultBlockParam = { ...b, content: NO_ROOM_NOTE };
              if (b === movingBreakpoint) movingBreakpoint = noted;
              return noted;
            });
          }
          lastLookup = true;
          roomRanOut = true;
          emit(run, { type: 'status', status: 'running', note: 'the model has read as much as it can hold; writing the answer' });
        }
        turn -= 1;
        continue;
      }
      callIds.push(res.callId);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens;
      usage.cacheWriteTokens += res.usage.cacheWriteTokens;
      meta.usage = { ...usage };
      meta.estimatedUsd = estimateUsd(preset.model, usage) + careCtx.webUsd;
      if (res.thinkingSummary) meta.thinkingSummary += (meta.thinkingSummary ? '\n\n' : '') + res.thinkingSummary;
      const turnBlocks: TextBlockLike[] = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => ({ text: b.text, citations: (b.citations ?? null) as CitationLike[] | null }));
      if (turnBlocks.length && textBlocks.length) {
        const prev = textBlocks[textBlocks.length - 1].text;
        if (!/\n\n$/.test(prev)) textBlocks.push({ text: prev.endsWith('\n') ? '\n' : '\n\n' });
      }
      textBlocks.push(...turnBlocks);
      if (turnBlocks.some((b) => b.text.trim())) textTurns.push(turnBlocks);
      committedLen = run.text.length;

      if (res.stopReason === 'tool_use' && lastLookup && toolChoice === 'auto') {
        // Told it had read all the window holds, the model asked for more anyway: its calls are not run, and the same
        // prompt is asked again with tools off, so the prompt stays where it was (what it wrote is a working note).
        toolChoice = 'none';
        emit(run, { type: 'status', status: 'running', note: 'the model has read as much as it can hold; writing the answer' });
        turn -= 1;
        continue;
      }
      if (res.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: res.content as unknown as Anthropic.ContentBlockParam[] });
        const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        emit(run, { type: 'status', status: 'running', note: uses.length === 1 ? `calling ${uses[0].name}` : `calling ${uses.map((u) => u.name).join(', ')}` });
        const results = await Promise.all(
          uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
            const ts = Date.now();
            const out = CARE_TOOL_NAMES.has(u.name) ? await runCareTeamTool(u.name, u.input, careCtx) : await runTool(u.name, u.input, toolCtx);
            const ms = Date.now() - ts;
            meta.toolCalls.push({ name: u.name, input: u.input, summary: out.summary, ms, error: out.isError || undefined });
            emit(run, { type: 'tool', name: u.name, summary: out.summary, error: out.isError || undefined });
            return { type: 'tool_result', tool_use_id: u.id, content: out.text, is_error: out.isError };
          }),
        );
        meta.charts = charts.slice();
        meta.proposals = proposals.length ? proposals.slice() : undefined;
        meta.labValues = labValues.length ? labValues.slice() : undefined;
        careMeta();
        meta.estimatedUsd = estimateUsd(preset.model, usage) + careCtx.webUsd;
        // The next turn re-sends everything so far plus these results: from the exact size of this turn's prompt, its
        // output and the results counted conservatively (large ones by the API, at their real density), results that
        // would not fit are cut (saying so to the model), and with no useful room left the model is told to answer
        // from what it has read (ask-budget).
        const room = promptLimit(preset.model, maxTokens) - (promptTokensOf(res.usage) + res.usage.outputTokens + 500);
        const texts = results.map((r) => ({ id: r.tool_use_id, text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? ''), isError: r.is_error }));
        const count = countTokens ? (text: string) => countTokens({ model: preset.model, system: 'Count.', messages: [{ role: 'user', content: text }] }) : null;
        const fit = fitToolResults(texts, room, await charsPerTokenFor(texts, room, preset.model, count));
        if (fit.cut || fit.last) {
          fit.results.forEach((f, i) => {
            results[i] = { ...results[i], content: f.text };
          });
        }
        if (fit.last) {
          lastLookup = true;
          roomRanOut = true;
          emit(run, { type: 'status', status: 'running', note: fit.full ? 'the model has read as much as it can hold; writing the answer' : fit.cut ? `cut ${fit.cut} lookup result${fit.cut === 1 ? '' : 's'} to fit; writing the answer` : 'the model has read as much as it can hold; writing the answer' });
        }
        // Cache up to these results (the previous
        // moving breakpoint comes off, so the request never holds more than four).
        movingBreakpoint = moveCacheBreakpoint(messages, movingBreakpoint, results[results.length - 1]);
        messages.push({ role: 'user', content: results });
        persist();
        if (turn === maxTurns) exhausted = true;
        continue;
      }
      if (res.stopReason === 'max_tokens') cutOff = true;
      // The prompt and the answer together reached the window (the API stops the answer there, it does not refuse).
      if (res.stopReason === 'model_context_window_exceeded') windowFull = true;
      break;
    }

    const notes: TextBlockLike[] = [];
    if (exhausted) notes.push({ text: `\n\n(Stopped after ${maxTurns} tool turns; the answer above may be incomplete.)` });
    if (roomRanOut) notes.push({ text: '\n\n(The material for this question filled what the model can read at once, so it stopped looking things up and answered from what it had read. Ask about the rest separately.)' });
    if (cutOff) notes.push({ text: '\n\n(The answer reached the output limit and was cut off.)' });
    if (windowFull) notes.push({ text: '\n\n(The answer reached the most the model can hold at once and was cut off.)' });
    for (const n of notes) {
      run.text += n.text;
      textBlocks.push(n);
      committedLen = run.text.length;
    }

    emit(run, { type: 'status', status: 'running', note: 'resolving citations' });
    // The answer is the last turn that wrote text (the final turn, or the last tool turn when
    // the turns ran out); what earlier turns wrote before their tool calls is kept apart.
    const { answer, workingNotes } = splitTurns(textTurns);
    const mapped = mapAnswer([...answer, ...notes], assembled.docIndex, assembled.ledger, dbLookups());
    const d = db();
    storeCitationRows(p.assistantMessageId, mapped);
    mappedText = mapped.text;
    // A refusal ("Not in the case file.") opens the answer turn.
    const refused = detectRefusal(answer.map((b) => b.text).join('')) || detectRefusal(mapped.text);
    meta.workingNotes = workingNotes || undefined;
    meta.citations = mapped.citations;
    meta.droppedCitations = mapped.dropped || undefined;
    meta.charts = charts.slice();
    meta.proposals = proposals.length ? proposals.slice() : undefined;
    meta.labValues = labValues.length ? labValues.slice() : undefined;
    careMeta();
    meta.uncited = !refused && mapped.citations.length === 0 ? true : undefined;
    finishWith(refused ? 'refused' : 'done');
    run.text = mapped.text;
    d.update(schema.askMessages)
      .set({ content: mapped.text, refused, retrievalJson: JSON.stringify(meta), aiCallId: callIds[callIds.length - 1] ?? null })
      .where(eq(schema.askMessages.id, p.assistantMessageId))
      .run();
    d.update(schema.askSessions).set({ updatedAt: nowIso() }).where(eq(schema.askSessions.id, p.sessionId)).run();
    const message = getMessageFull(p.assistantMessageId);
    run.final = { type: 'done', message };
    emit(run, run.final);
  } catch (err) {
    const aborted = signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    if (aborted) {
      finishWith('cancelled');
      if (run.text && !/\n$/.test(run.text)) run.text += '\n';
    } else if (err instanceof AiRefusedError) {
      finishWith('error', { error: `The model declined this request${err.category ? ` (${err.category})` : ''}${err.explanation ? `: ${err.explanation}` : '.'}` });
    } else {
      const tl = promptTooLong(err);
      finishWith('error', { error: tl ? tooLongWords(tl, sentEarlierTurns > 0) : message.slice(0, 2000) });
    }
    if (assembled) {
      meta.docIndex = assembled.docIndex;
      meta.includedPages = assembled.pages.map((pg) => ({ documentId: pg.documentId, pageNumber: pg.pageNumber }));
      meta.contextStats = assembled.stats;
    }
    // The partial answer keeps its provenance: the completed turns' blocks (with their
    // document citations) plus the streamed text of the turn in flight, mapped like a
    // finished answer. Text already mapped by the success path is kept as it is.
    if (mappedText != null) {
      run.text = mappedText;
    } else {
      const blocks: TextBlockLike[] = [...textBlocks, { text: run.text.slice(committedLen) }];
      run.text = settlePartialAnswer(p.assistantMessageId, blocks, assembled?.docIndex ?? [], assembled?.ledger ?? [], meta);
    }
    try {
      db().update(schema.askMessages).set({ content: run.text, retrievalJson: JSON.stringify(meta) }).where(eq(schema.askMessages.id, p.assistantMessageId)).run();
      const full = getMessageFull(p.assistantMessageId);
      run.final = meta.status === 'error' ? { type: 'error', error: meta.error ?? message, message: full } : { type: 'done', message: full };
    } catch {
      run.final = meta.status === 'error' ? { type: 'error', error: meta.error ?? message } : { type: 'error', error: 'cancelled while the case was locked' };
    }
    emit(run, run.final);
  } finally {
    clearInterval(persistTimer);
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Preview and tasks
// ---------------------------------------------------------------------------

export function previewContext(opts: { preset?: string; q?: string; documentIds?: string[]; from?: string; to?: string }): ContextPreview {
  const preset = resolvePreset({ preset: opts.preset });
  const scope: AskScope | undefined = opts.documentIds?.length || opts.from || opts.to ? { documentIds: opts.documentIds, from: opts.from, to: opts.to } : undefined;
  return contextPreview(withinWindow(preset), opts.q ?? '', scope);
}

export { citationSourceLine };

export function messageToTask(messageId: string, title?: string | null): typeof schema.tasks.$inferSelect {
  const m = getMessageFull(messageId);
  const d = db();
  const rows = messageRows(m.sessionId);
  const idx = rows.findIndex((r) => r.id === messageId);
  const question = idx > 0 && rows[idx - 1].role === 'user' ? rows[idx - 1].content : rows.find((r) => r.role === 'user')?.content ?? '';
  // Composed by the shared helpers, which the client also uses to file the same task through /tasks.
  const t = answerTaskTitle(question, title);
  const detail = answerTaskDetail(m.content, (m.meta as AskMeta).citations ?? [], m.sessionId, dbLookups().documentTitle);
  const id = newId();
  const now = nowIso();
  d.insert(schema.tasks).values({ id, title: t, detail, owner: 'me', status: 'open', priority: 'normal', sourceType: 'manual', sourceId: messageId, createdAt: now, updatedAt: now }).run();
  const row = d.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
  indexEntity('task', id, t, detail);
  return row;
}
