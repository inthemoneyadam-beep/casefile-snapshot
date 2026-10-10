/**
 * Ask-the-case types shared by the API and the client: the per-answer meta
 * stored in `ask_messages.retrieval_json`, the citation references the
 * answer text points at with `[n]` markers, and the SSE event shapes.
 */
import type { ChartSpec } from './chart';
import type { Effort } from './constants';
import type { AskWebSearchNote, AskWebSource } from './care-team';

export type AskMode = 'question' | 'search' | 'draft' | 'briefing';
export const ASK_MODES: AskMode[] = ['question', 'search', 'draft', 'briefing'];
export const ASK_MODE_LABELS: Record<AskMode, string> = {
  question: 'Question',
  search: 'Directory search',
  draft: 'Draft message',
  briefing: 'Pre-visit briefing',
};

export type AskStatus = 'running' | 'done' | 'error' | 'cancelled' | 'refused';
export type ContextMode = 'retrieval' | 'ledger' | 'everything';

export interface AskScope {
  documentIds?: string[];
  from?: string;
  to?: string;
}

/** One numbered citation `[n]` in an answer. */
export interface AskCitationRef {
  n: number;
  /** page = a cited page document; fact = a ledger fact (resolved to its first verified citation when it has one); communication = a ledger contact; ledger = a cited ledger line with no linkable token nearby. */
  kind: 'page' | 'fact' | 'communication' | 'ledger';
  documentId?: string;
  documentTitle?: string;
  pageNumber?: number;
  quote: string;
  factId?: string;
  communicationId?: string;
  /** The `citations` row written for this reference (page and fact kinds with a document). */
  citationId?: string;
  verified?: boolean;
}

/** Where each document block sat in the request, so `document_index` resolves. */
export interface DocIndexEntry {
  index: number;
  kind: 'ledger' | 'page';
  key?: string;
  documentId?: string;
  pageNumber?: number;
}

export interface AskToolCall {
  name: string;
  input: unknown;
  summary: string;
  ms: number;
  error?: boolean;
}

export interface AskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AskContextStats {
  ledgerTokens: number;
  pages: number;
  pageTokens: number;
  facts: number;
  totalTokensApprox: number;
  countedTokens?: number;
}

export interface PageRef {
  documentId: string;
  pageNumber: number;
}

/** Meta of an assistant message (ask_messages.retrieval_json). */
export interface AskMeta {
  preset: string;
  presetLabel?: string;
  model: string;
  effort: Effort | string;
  contextMode: ContextMode | string;
  mode: AskMode;
  status: AskStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number;
  usage: AskUsage;
  estimatedUsd: number;
  thinkingSummary: string;
  turns: number;
  toolCalls: AskToolCall[];
  charts: ChartSpec[];
  /** Filing ids of document moves the consult proposed in this answer (approved or declined in the thread). */
  proposals?: string[];
  /** Lab values the clinician added to the lab table at the patient's request in this answer (each with Undo). */
  labValues?: AskLabValue[];
  /** "Search the web" was on for this question (the Care team, 2026-10-09; off by default). */
  webSearch?: boolean;
  /** Outside sources from the web ([web N] in the answer): listed apart, never citations of the record. */
  webSources?: AskWebSource[];
  /** The web searches of this answer: the queries sent, the ones refused (never sent), the searches made. */
  webSearches?: AskWebSearchNote[];
  /** Care team candidates proposed from the web in this answer (waiting for a yes on the Care team page). */
  careProposals?: string[];
  contextStats: AskContextStats;
  citations: AskCitationRef[];
  uncited?: boolean;
  /** Provenance tokens in the answer that resolved to nothing on file (each shown as "[source not found]"). */
  droppedCitations?: number;
  error?: string;
  docIndex?: DocIndexEntry[];
  includedPages?: PageRef[];
  ledgerIncluded?: boolean;
  scope?: AskScope;
  encounterId?: string | null;
  personId?: string | null;
  /** Set when the generation was interrupted by a server restart. */
  interrupted?: boolean;
  /**
   * What the model wrote in turns before the answer turn (narration before its
   * tool calls), as plain text without citations. The answer itself is only
   * the last turn that wrote text. Unset on stopped or failed answers, which
   * keep all their text.
   */
  workingNotes?: string;
}

/**
 * A lab value the clinician put into the lab table, from a page, because the patient asked for it in his message
 * (2026-10-08, lab check: "Can you add it to the table?"). Proposals he did not ask for are filings rows instead
 * (target 'lab_value'), approved in the thread.
 */
export interface AskLabValue {
  factId: string;
  documentId: string;
  page: number;
  /** One plain sentence: what was added, or why nothing new was added. */
  words: string;
  /** added: a new value; cited_existing: a value already on file now also cites this page; already_on_file: nothing changed. */
  outcome: 'added' | 'cited_existing' | 'already_on_file';
  /** Undo applies (a new value was made). */
  undoable: boolean;
}

/** At most this many documents may be attached to one question. */
export const ASK_MAX_ATTACHMENTS = 10;

/**
 * A document the patient attached to one question. Its pages go in front of
 * everything else the question reads; `official` records that its source
 * tier was 'primary' (a clinical record) when the question was sent, which
 * tells the clinician it settles disagreements over measurements and events.
 */
export interface AskAttachment {
  documentId: string;
  title: string;
  official: boolean;
}

/** Meta of a user message (what was asked with which settings). */
export interface AskUserMeta {
  preset: string;
  mode: AskMode;
  scope?: AskScope;
  encounterId?: string | null;
  personId?: string | null;
  model?: string;
  effort?: string;
  contextMode?: string;
  /** Documents attached to this question, in the order they were attached. */
  attachments?: AskAttachment[];
  /** "Search the web" was on for this question. */
  webSearch?: boolean;
}

export interface AskSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AskSessionListItem extends AskSession {
  messageCount: number;
  lastAt: string | null;
  lastPreset: string | null;
}

export interface AskMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | string;
  content: string;
  refused: boolean;
  retrievalJson: string;
  aiCallId: string | null;
  createdAt: string;
}

export interface AskCitationRow {
  id: string;
  askMessageId: string | null;
  documentId: string;
  pageNumber: number;
  quote: string;
  charStart: number | null;
  charEnd: number | null;
  verified: boolean;
  matchKind: string | null;
}

export interface AskMessageFull extends AskMessage {
  citations: AskCitationRow[];
  /** Assistant messages carry a full AskMeta; user messages carry an AskUserMeta (typed loosely here). */
  meta: AskMeta | (AskUserMeta & Partial<AskMeta>);
}

export interface AskSessionDetail {
  session: AskSession;
  messages: AskMessageFull[];
}

export type AskEvent =
  | { type: 'status'; status: AskStatus | string; note?: string }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; summary: string; error?: boolean }
  | { type: 'chart'; chart: ChartSpec; n: number }
  | { type: 'done'; message: AskMessageFull }
  | { type: 'error'; error: string; message?: AskMessageFull };

export interface AskPrefill {
  text: string;
  mode?: AskMode;
  encounterId?: string;
  personId?: string;
  presetKey?: string;
  /** Send it at once (Home's Ask box), instead of waiting in the composer. */
  send?: boolean;
}

export interface ContextPreview {
  preset: string;
  model: string;
  effort: string;
  contextMode: string;
  ledgerTokens: number;
  pages: number;
  pageTokens: number;
  facts: number;
  totalTokensApprox: number;
  estimatedUsdInput: number;
  fitsContext: boolean;
  contextWindow: number;
}

export interface SendMessageBody {
  content: string;
  preset?: string;
  model?: string;
  effort?: Effort;
  contextMode?: ContextMode;
  scope?: AskScope;
  mode?: AskMode;
  encounterId?: string | null;
  personId?: string | null;
  /** Live documents to read first for this question (at most ASK_MAX_ATTACHMENTS). */
  attachedDocumentIds?: string[];
  /** "Search the web" for this question (off by default). */
  webSearch?: boolean;
}

export function isAskMeta(m: AskMessageFull['meta'] | undefined | null): m is AskMeta {
  return Boolean(m && typeof (m as AskMeta).status === 'string' && typeof (m as AskMeta).model === 'string');
}

// ---------------------------------------------------------------------------
// An answer as a task (server: POST /ask/messages/:id/to-task; client: the
// same task through POST /tasks for roles that may only add tasks)
// ---------------------------------------------------------------------------

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** One plain-text line naming what citation [n] points at: `[n] title p.N (verified): “quote”`. */
export function citationSourceLine(c: AskCitationRef, documentTitle: (id: string) => string | undefined = () => undefined): string {
  const quote = oneLine(c.quote, 1500);
  const q = quote.length > 200 ? `${quote.slice(0, 199)}…` : quote;
  if (c.kind === 'communication') return `[${c.n}] communication: “${q}”`;
  const docTitle = c.documentId ? (c.documentTitle ?? documentTitle(c.documentId) ?? 'document') : null;
  const where = docTitle ? `${docTitle}${c.pageNumber ? ` p.${c.pageNumber}` : ''}` : c.kind === 'fact' ? 'case fact with no source page' : 'ledger line with no source link';
  const state = docTitle ? (c.verified ? 'verified' : 'not found on the page') : 'unverified';
  return `[${c.n}] ${where} (${state}): “${q}”`;
}

/** The task title for an answer: the given title, else "Follow up: <question>". */
export function answerTaskTitle(question: string, title?: string | null): string {
  return title?.trim() || `Follow up: ${oneLine(question, 120) || 'consult answer'}`;
}

/**
 * The task detail for an answer. Its [n] markers mean nothing outside the
 * consult, so the task carries the sources they point at and a way back to
 * the answer; the answer text is capped first so those are never cut off.
 */
export function answerTaskDetail(content: string, citations: AskCitationRef[], sessionId: string, documentTitle?: (id: string) => string | undefined): string {
  const body = content.trim().slice(0, 4000);
  const used = new Set([...body.matchAll(/\[(\d+)\](?!\()/g)].map((x) => Number(x[1])));
  const refs = citations.filter((c) => used.has(c.n)).slice(0, 60);
  const parts: string[] = [];
  if (body) parts.push(body);
  if (refs.length) parts.push(`Sources:\n${refs.map((c) => citationSourceLine(c, documentTitle)).join('\n')}`);
  parts.push(`From consult: /ask?session=${sessionId}\n(AI-generated answer; check each statement against its cited source.)`);
  return parts.join('\n\n');
}
