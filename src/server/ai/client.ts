/**
 * The only place that talks to the Anthropic API. Every call is written to
 * `ai_calls` before and after, with purpose, model, token counts, and an
 * estimated cost, so the AI log in the UI is complete. Nothing here runs
 * unless `ai.enabled` is true and a key exists.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { getSetting } from '../services/settings';
import { newId, nowIso } from '../util/ids';
import { MODEL_PRICES, type Effort } from '../../shared/constants';
import { log } from '../util/log';

export class AiDisabledError extends Error {
  constructor() {
    super('AiDisabled: AI calls are switched off in Settings');
    this.name = 'AiDisabledError';
  }
}
export class NoApiKeyError extends Error {
  constructor() {
    super('NoApiKey: no Anthropic API key is configured (Settings or ANTHROPIC_API_KEY)');
    this.name = 'NoApiKeyError';
  }
}
export class AiRefusedError extends Error {
  constructor(public category: string | null, public explanation: string | null) {
    super(`refused: the model declined this request${category ? ` (${category})` : ''}`);
    this.name = 'AiRefusedError';
  }
}

export function getApiKey(): string | null {
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  if (env) return env;
  const s = getSetting('ai.apiKey')?.trim();
  return s || null;
}

export function aiEnabled(): boolean {
  return Boolean(getSetting('ai.enabled'));
}

export function modelFor(deep: boolean): string {
  return deep ? getSetting('ai.models.deep') : getSetting('ai.models.standard');
}

let cachedClient: { key: string; client: Anthropic } | null = null;
function client(): Anthropic {
  if (!aiEnabled()) throw new AiDisabledError();
  const key = getApiKey();
  if (!key) throw new NoApiKeyError();
  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = { key, client: new Anthropic({ apiKey: key, maxRetries: 3, timeout: 15 * 60 * 1000 }) };
  }
  return cachedClient.client;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function estimateUsd(model: string, u: Usage): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000;
}

function usageOf(msg: Anthropic.Message): Usage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

interface CallBase {
  purpose: string;
  model?: string;
  deep?: boolean;
  /** Plain string, or pre-built system blocks (lets callers place cache breakpoints). */
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  documentIds?: string[];
  jobId?: string | null;
  maxTokens?: number;
  requestSummary?: string;
  signal?: AbortSignal;
  effort?: Effort;
  /** Per-call HTTP timeout in ms (master-clinician calls can run for a long time). */
  timeoutMs?: number;
}

/**
 * System prompt as cacheable blocks. The TTL is 1h so that callers may place
 * 1h breakpoints later in `messages` (the API rejects a 1h block after a 5m one).
 */
function systemBlocks(system: CallBase['system']): Anthropic.TextBlockParam[] {
  if (typeof system === 'string') return [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  return system;
}

/** Per-request options; the SDK rejects `timeout: undefined`, so only set keys that have values. */
function requestOptions(c: { signal?: AbortSignal; timeoutMs?: number }): { signal?: AbortSignal; timeout?: number } {
  const o: { signal?: AbortSignal; timeout?: number } = {};
  if (c.signal) o.signal = c.signal;
  if (typeof c.timeoutMs === 'number' && Number.isFinite(c.timeoutMs)) o.timeout = Math.round(c.timeoutMs);
  return o;
}

/** The purpose of each call in flight, for its log line when it ends (purposes are fixed words, never content). */
const purposes = new Map<string, string>();

/** The HTTP status of an API error, when it has one. */
function httpStatusOf(err: unknown): number | undefined {
  const s = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
}

function startLog(c: CallBase, model: string): string {
  const id = newId();
  purposes.set(id, c.purpose);
  db().insert(schema.aiCalls).values({
    id,
    createdAt: nowIso(),
    purpose: c.purpose,
    model,
    jobId: c.jobId ?? null,
    documentIdsJson: JSON.stringify(c.documentIds ?? []),
    status: 'running',
    requestSummary: c.requestSummary ?? null,
  }).run();
  return id;
}

function finishLog(id: string, model: string, patch: { usage?: Usage; status: string; error?: string; durationMs: number; stopReason?: string | null; httpStatus?: number; extraUsd?: number; requestSummary?: string }): void {
  const u = patch.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const purpose = purposes.get(id) ?? 'unknown';
  purposes.delete(id);
  // One line per call: status, model, purpose, HTTP status, duration, token counts. Never the prompt, the answer or
  // the error text (an API error can echo the request).
  const line = `${purpose} ${model} ${patch.status}${patch.httpStatus ? ` (HTTP ${patch.httpStatus})` : ''}${patch.stopReason && patch.status !== 'ok' ? `, stop ${patch.stopReason}` : ''} after ${patch.durationMs} ms; ${u.inputTokens} in, ${u.outputTokens} out`;
  if (patch.status === 'ok') log.debug('ai', line);
  else if (patch.status === 'cancelled') log.info('ai', line);
  else log.warn('ai', line);
  try {
    db().update(schema.aiCalls).set({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      estimatedUsd: estimateUsd(model, u) + (patch.extraUsd ?? 0),
      durationMs: patch.durationMs,
      status: patch.status,
      error: patch.error?.slice(0, 2000) ?? null,
      stopReason: patch.stopReason ?? null,
      ...(patch.requestSummary !== undefined ? { requestSummary: patch.requestSummary } : {}),
    }).where(eq(schema.aiCalls.id, id)).run();
  } catch {
    // locked mid-call; nothing to do
  }
}

function blocked(c: CallBase, err: Error): never {
  const model = c.model ?? safeModel(c.deep ?? false);
  const id = startLog(c, model);
  finishLog(id, model, { status: 'blocked', error: err.message, durationMs: 0 });
  throw err;
}

function safeModel(deep: boolean): string {
  try {
    return modelFor(deep);
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Calls in flight (read by the idle lock in auth.ts, which imports this
// module; nothing here may import auth.ts back)
// ---------------------------------------------------------------------------

let inFlight = 0;
let lastFinishedAt = 0;

/** Model calls (callStructured, callText) that have started and not yet returned or thrown. */
export function aiCallsInFlight(): number {
  return inFlight;
}

/**
 * When the count last fell back to zero (epoch ms; 0 before any call). The
 * idle lock counts from here as well as from the last human activity, so the
 * moments between a consult's tool turns are not idle time.
 */
export function lastAiCallFinishedAt(): number {
  return lastFinishedAt;
}

/**
 * Counts `run` as an AI call in flight until it settles, whichever way it
 * ends (result, refusal, error, abort, a stream cut off). callStructured and
 * callText go through it; exported for tests.
 */
export async function trackAiCall<T>(run: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await run();
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) lastFinishedAt = Date.now();
  }
}

/**
 * Thrown (wrapped) when a stream broke before its final message: the connection dropped, the laptop slept, or an
 * error event arrived mid-stream. The SDK retries only before a stream starts, so callStructured retries such a call
 * once, whole (a new ai_calls row; the broken one is logged as an error).
 */
export class StreamBrokenError extends Error {
  constructor(public cause: unknown) {
    super(`stream broke before the answer was complete: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StreamBrokenError';
  }
}

/**
 * Whether an error thrown while waiting for a stream's final message is a broken stream worth one whole-call retry: not
 * an abort (a lock, a cancel), and not an HTTP status the SDK already answered with its own retries (a 400, a 401, a
 * 429 after three tries). A mid-stream error event (overloaded) carries no status; nor does a dropped connection.
 */
export function isBrokenStream(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return false;
  const abortCls = (Anthropic as unknown as { APIUserAbortError?: unknown }).APIUserAbortError;
  if (typeof abortCls === 'function' && err instanceof (abortCls as new (...a: never[]) => Error)) return false;
  // An HTTP status the SDK already answered (with its own retries): a 400 for a bad request, a 429 after three tries.
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return false;
  if (/^\d{3}\s/.test(err.message)) return false;
  return true;
}

/** How many times a broken stream is retried, whole (findings D.3 WP-B: once). */
export const BROKEN_STREAM_RETRIES = 1;

/**
 * Structured call: the model must return JSON matching `schema`. A stream that breaks before its final message is
 * retried once, whole.
 */
export function callStructured<T>(c: CallBase & { schema: ZodType<T> }): Promise<{ data: T; callId: string; usage: Usage; model: string }> {
  return trackAiCall(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await structuredCall(c);
      } catch (err) {
        if (err instanceof StreamBrokenError && attempt < BROKEN_STREAM_RETRIES && !c.signal?.aborted) {
          console.warn(`[ai] ${c.purpose}: ${err.message}; asking once more`);
          continue;
        }
        throw err instanceof StreamBrokenError ? err.cause instanceof Error ? err.cause : err : err;
      }
    }
  });
}

async function structuredCall<T>(c: CallBase & { schema: ZodType<T> }): Promise<{ data: T; callId: string; usage: Usage; model: string }> {
  let cl: Anthropic;
  try {
    cl = client();
  } catch (err) {
    blocked(c, err as Error);
  }
  const model = c.model ?? modelFor(c.deep ?? false);
  const callId = startLog(c, model);
  const t0 = Date.now();
  // Set once finishLog has recorded the outcome, so the catch below never
  // second-guesses it from an error message (an API 400 about the output
  // schema must still be logged as that error).
  let logged = false;
  try {
    // Reasoning tokens count against max_tokens on current models, so a small
    // ceiling starves the JSON. Floor it: callers may ask for more, never less.
    const maxTokens = Math.max(c.maxTokens ?? 32000, 16000);
    // Always stream: non-streaming requests are cut off after about ten minutes
    // (a deep Fable pass timed out twice that way); the stream keeps the
    // connection alive and the format helper parses the final JSON.
    const format = zodOutputFormat(c.schema);
    const stream = cl.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system: systemBlocks(c.system),
        messages: c.messages,
        output_config: { format, effort: c.effort ?? getSetting('ai.effort') },
      },
      requestOptions(c),
    );
    let final: Anthropic.Message;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      if (!isBrokenStream(err, c.signal)) throw err;
      finishLog(callId, model, { status: 'error', error: `stream broke: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - t0, httpStatus: httpStatusOf(err) });
      logged = true;
      throw new StreamBrokenError(err);
    }
    const parsedOutput = (() => {
      if (final.stop_reason !== 'end_turn' && final.stop_reason !== 'stop_sequence') return null;
      const text = final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      try {
        return format.parse(text) as T;
      } catch {
        return null;
      }
    })();
    const res = { ...final, parsed_output: parsedOutput };
    const usage = usageOf(final);
    if (res.stop_reason === 'refusal') {
      const sd = res.stop_details as { category?: string | null; explanation?: string | null } | null;
      finishLog(callId, model, { usage, status: 'refused', durationMs: Date.now() - t0, stopReason: res.stop_reason, error: sd?.explanation ?? undefined });
      logged = true;
      throw new AiRefusedError(sd?.category ?? null, sd?.explanation ?? null);
    }
    if (res.stop_reason === 'max_tokens') {
      // Diagnostics without content: how much JSON came back and how many facts it had begun.
      const raw = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      const thinkingChars = res.content.filter((b) => b.type === 'thinking').reduce((n, b) => n + ((b as { thinking?: string }).thinking?.length ?? 0), 0);
      const began = (raw.match(/"statement"\s*:/g) ?? []).length;
      const detail = `max_tokens reached (${maxTokens}); output ${raw.length} chars of JSON with ${began} facts begun, thinking ${thinkingChars} chars (reasoning tokens are billed as output and may be hidden)`;
      finishLog(callId, model, { usage, status: 'error', durationMs: Date.now() - t0, stopReason: res.stop_reason, error: detail });
      logged = true;
      throw new Error(`${detail}; reduce chunk size or raise the output limit`);
    }
    if (!res.parsed_output) {
      finishLog(callId, model, { usage, status: 'error', durationMs: Date.now() - t0, stopReason: res.stop_reason, error: 'output did not match schema' });
      logged = true;
      throw new Error('model output did not match the schema');
    }
    finishLog(callId, model, { usage, status: 'ok', durationMs: Date.now() - t0, stopReason: res.stop_reason });
    logged = true;
    return { data: res.parsed_output as T, callId, usage, model };
  } catch (err) {
    if (!logged) {
      finishLog(callId, model, { status: c.signal?.aborted ? 'cancelled' : 'error', error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0, httpStatus: httpStatusOf(err) });
    }
    throw err;
  }
}

export interface TextCallResult {
  text: string;
  /** Full content blocks (text blocks carry `citations` when document blocks had citations enabled). */
  content: Anthropic.ContentBlock[];
  thinkingSummary: string;
  callId: string;
  usage: Usage;
  model: string;
  stopReason: string | null;
  durationMs: number;
}

export type TextCall = CallBase & {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  showThinking?: boolean;
  /** Client tools. When present, tool_choice is auto; the caller runs the loop and checks stopReason === 'tool_use'. */
  tools?: Anthropic.Tool[];
  /** 'none': the tools stay declared (earlier turns used them) but this turn must answer in text. Default 'auto'. */
  toolChoice?: 'auto' | 'none';
};

/**
 * Free-text call, streamed. Returns the full text plus the raw content blocks
 * (for citations) and the thinking summary when `showThinking` is set.
 */
export function callText(c: TextCall): Promise<TextCallResult> {
  return trackAiCall(() => textCall(c));
}

async function textCall(c: TextCall): Promise<TextCallResult> {
  let cl: Anthropic;
  try {
    cl = client();
  } catch (err) {
    blocked(c, err as Error);
  }
  const model = c.model ?? modelFor(c.deep ?? false);
  const callId = startLog(c, model);
  const t0 = Date.now();
  try {
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: c.maxTokens ?? 16000,
      system: systemBlocks(c.system),
      messages: c.messages,
      output_config: { effort: c.effort ?? getSetting('ai.effort') },
    };
    if (c.showThinking) params.thinking = { type: 'adaptive', display: 'summarized' } as Anthropic.MessageStreamParams['thinking'];
    if (c.tools?.length) {
      params.tools = c.tools;
      params.tool_choice = { type: c.toolChoice ?? 'auto' };
    }
    const stream = cl.messages.stream(params, requestOptions(c));
    let thinkingSummary = '';
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') c.onDelta?.(ev.delta.text);
        else if (ev.delta.type === 'thinking_delta') {
          thinkingSummary += ev.delta.thinking;
          c.onThinking?.(ev.delta.thinking);
        }
      }
    });
    const final = await stream.finalMessage();
    const usage = usageOf(final);
    const durationMs = Date.now() - t0;
    if (final.stop_reason === 'refusal') {
      const sd = final.stop_details as { category?: string | null; explanation?: string | null } | null;
      finishLog(callId, model, { usage, status: 'refused', durationMs, stopReason: final.stop_reason, error: sd?.explanation ?? undefined });
      throw new AiRefusedError(sd?.category ?? null, sd?.explanation ?? null);
    }
    const text = final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    finishLog(callId, model, { usage, status: 'ok', durationMs, stopReason: final.stop_reason });
    return { text, content: final.content, thinkingSummary, callId, usage, model, stopReason: final.stop_reason, durationMs };
  } catch (err) {
    if (err instanceof AiRefusedError) throw err;
    finishLog(callId, model, { status: c.signal?.aborted ? 'cancelled' : 'error', error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0, httpStatus: httpStatusOf(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Web search (2026-10-09, the Care team): Anthropic's server-side web search tool, so the app still talks only to
// Anthropic. The caller decides what the call holds: never case content (services/web-search.ts checks every query
// first). One ai_calls row per run (purpose web_search): model, tokens, searches made, dollars with the per-search fee;
// never the queries.
// ---------------------------------------------------------------------------

/** The web search tool version with dynamic filtering (Sonnet 5.5, Opus 5.5): results may come inside code execution. */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';
/** The basic version, with the documented response shape: the default (request 6), and always for Haiku models. */
export const WEB_SEARCH_TOOL_TYPE_BASIC = 'web_search_20250305';
/**
 * The web search tool a call sends (request 6, lead's addition): web_search_20250305 by default (its response shape is
 * documented and tested); web_search_20260209 only when Settings asks for it (ai.webSearch.toolVersion), and never on a
 * Haiku model (review 2026-10-09: refused there). allowed_domains works on both.
 */
export function webSearchToolType(model: string, version: '20250305' | '20260209' = '20250305'): string {
  return version === '20260209' && !/haiku/i.test(model) ? WEB_SEARCH_TOOL_TYPE : WEB_SEARCH_TOOL_TYPE_BASIC;
}
/** Anthropic's price per search ($10 per 1,000). */
export const WEB_SEARCH_FEE_USD = 0.01;
/** A paused server-side loop (stop_reason pause_turn) is resumed at most this many times. */
export const WEB_SEARCH_MAX_CONTINUATIONS = 3;

/** The organisation has web search switched off (an admin turns it on in the Anthropic Console). */
export class WebSearchDisabledError extends Error {
  constructor(detail?: string) {
    super(`Web search is switched off for this Anthropic account. An admin turns it on in the Anthropic Console (the organization's settings, Privacy).${detail ? ` (${detail.slice(0, 200)})` : ''}`);
    this.name = 'WebSearchDisabledError';
  }
}

/** An API error that says web search is not enabled for the organisation. */
export function isWebSearchDisabled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = httpStatusOf(err);
  if (status !== undefined && status !== 400 && status !== 403) return false;
  const m = err.message;
  if (/web[ _-]?search/i.test(m) && /(not enabled|disabled|not available|turned off|not allowed|enable (it|web)|permission|not permitted)/i.test(m)) return true;
  // A 403 permission error on a call whose only tool is web search is the organisation's switch, even when the API's
  // words do not name the tool (review 2026-10-09: the real wording was never seen; an invalid key is a 401).
  return status === 403 && /(permission_error|permission|not enabled|disabled|not allowed|not permitted)/i.test(m);
}

export interface WebResultItem {
  url: string;
  title: string;
  pageAge: string | null;
}
export interface WebCitation {
  url: string;
  title: string | null;
  citedText: string;
}
export interface WebTextBlock {
  text: string;
  citations: WebCitation[];
}
export interface WebSearchContent {
  text: string;
  textBlocks: WebTextBlock[];
  /** Every result link the searches returned, once each, in order. */
  results: WebResultItem[];
  /** The searches the tool made, as it reported them. */
  queriesMade: string[];
  /** Error codes of searches that did not work (max_uses_exceeded, too_many_requests, unavailable...). */
  errors: string[];
}

/** Links printed by code (dynamic filtering): http(s) only, trailing punctuation off. */
const PRINTED_LINK = /https?:\/\/[^\s"'<>()[\]{}\\`]+/g;
/** A web_search call written in code ("web_search(query='...')", 'web_search("...")'). */
const SEARCH_IN_CODE = /web_search\s*\(\s*(?:query\s*=\s*)?(["'])((?:(?!\1).){1,400})\1/g;

/**
 * What a web search answer holds: its text with the web citations, the result links, the searches made. Reads both
 * tool versions (request 6, lead's addition): web_search_20250305 (server_tool_use, web_search_tool_result with url,
 * title, page_age; text with web_search_result_location citations) and web_search_20260209, whose dynamic filtering
 * may run the searches from code and print the results (a code execution result's stdout): links are found in
 * either, once each, and a search called from code counts as a search made.
 */
export function readWebSearchContent(content: ReadonlyArray<unknown>): WebSearchContent {
  const textBlocks: WebTextBlock[] = [];
  const results: WebResultItem[] = [];
  const seen = new Set<string>();
  /** The searches in the order they appear; `code`: written in code (dynamic filtering), not a block of its own. */
  const made: Array<{ q: string; code: boolean }> = [];
  const errors: string[] = [];
  const addResult =(url: string, title: string | null, pageAge: string | null) => {
    const u = url.trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    results.push({ url: u, title: title ?? u, pageAge });
  };
  const cited: WebCitation[] = [];
  for (const raw of content) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : '';
    if (type === 'text' && typeof b.text === 'string') {
      const cites: WebCitation[] = [];
      for (const c of Array.isArray(b.citations) ? (b.citations as Array<Record<string, unknown>>) : []) {
        if (c?.type === 'web_search_result_location' && typeof c.url === 'string') cites.push({ url: c.url, title: typeof c.title === 'string' ? c.title : null, citedText: typeof c.cited_text === 'string' ? c.cited_text : '' });
      }
      cited.push(...cites);
      textBlocks.push({ text: b.text, citations: cites });
    } else if (type === 'server_tool_use' && b.name === 'web_search') {
      // Called by the model, or from code (a `caller` names the code execution): a search made either way.
      const q = (b.input as { query?: unknown } | null)?.query;
      if (typeof q === 'string' && q.trim()) made.push({ q: q.trim(), code: false });
    } else if (type === 'server_tool_use' && typeof b.name === 'string' && /code_execution/.test(b.name)) {
      const input = (b.input ?? {}) as { code?: unknown; command?: unknown };
      const code = [input.code, input.command].filter((x): x is string => typeof x === 'string').join('\n');
      for (const m of code.matchAll(SEARCH_IN_CODE)) if (m[2].trim()) made.push({ q: m[2].trim(), code: true });
    } else if (type === 'web_search_tool_result') {
      const c = b.content as unknown;
      if (Array.isArray(c)) {
        for (const r of c as Array<Record<string, unknown>>) {
          if (r?.type !== 'web_search_result' || typeof r.url !== 'string') continue;
          addResult(r.url, typeof r.title === 'string' ? r.title : null, typeof r.page_age === 'string' ? r.page_age : null);
        }
      } else if (c && typeof c === 'object' && typeof (c as { error_code?: unknown }).error_code === 'string') {
        errors.push((c as { error_code: string }).error_code);
      }
    } else if (type.endsWith('code_execution_tool_result')) {
      // Dynamic filtering: what the code printed. An error here is the code's, not a search's: not counted.
      const c = (b.content ?? {}) as { stdout?: unknown };
      const out = typeof c.stdout === 'string' ? c.stdout : '';
      for (const m of out.matchAll(PRINTED_LINK)) addResult(m[0].replace(/[.,;:!?]+$/, ''), null, null);
    }
  }
  // A page the answer cites is a page it read, whichever way it came.
  for (const c of cited) addResult(c.url, c.title, null);
  // A search written in code counts once: when the response also carries that search's own block (a `caller` naming
  // the code), the block already counted it (review 2026-10-09).
  const blocks = new Set(made.filter((m) => !m.code).map((m) => m.q));
  const queriesMade = made.filter((m) => !m.code || !blocks.has(m.q)).map((m) => m.q);
  return { text: textBlocks.map((t) => t.text).join(''), textBlocks, results, queriesMade, errors };
}

export interface WebSearchCall {
  /** web_search (the AI log's purpose). */
  purpose?: string;
  model?: string;
  /** Instructions for the search only: never anything about the patient. */
  system: string;
  /** The checked queries (and typed criteria) only. */
  userText: string;
  /** The most searches this run may make. */
  maxUses: number;
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
  /** The AI log's summary ("Find candidates", "Ask"): never the queries. "; N searches" is added when it ends. */
  label: string;
  timeoutMs?: number;
  /**
   * The only sites the tool may search (request 6, "Find doctors"): sent as allowed_domains, so the tool enforces it,
   * never the prompt. Plain host names, at most 64 (services/web-search.ts builds it). Null or empty: no list (Open).
   */
  allowedDomains?: readonly string[] | null;
  /** Settings ai.webSearch.toolVersion; 20250305 when not given. */
  toolVersion?: '20250305' | '20260209';
}

export interface WebSearchCallResult extends WebSearchContent {
  callId: string;
  usage: Usage;
  model: string;
  stopReason: string | null;
  /** Searches made (the API's count when it gives one). */
  searches: number;
  /** Tokens plus the per-search fee. */
  usd: number;
  durationMs: number;
  /** The web search tool version sent (web_search_20250305 or web_search_20260209). */
  toolType?: string;
}

/**
 * One web search run: the server-side tool with max_uses, streamed, resumed after a pause_turn (at most
 * WEB_SEARCH_MAX_CONTINUATIONS times, and never past maxUses). Logged as one ai_calls row.
 */
export function callWebSearch(c: WebSearchCall): Promise<WebSearchCallResult> {
  return trackAiCall(() => webSearchCall(c));
}

async function webSearchCall(c: WebSearchCall): Promise<WebSearchCallResult> {
  const base: CallBase = { purpose: c.purpose ?? 'web_search', model: c.model, system: c.system, messages: [], documentIds: [], requestSummary: `${c.label}: up to ${c.maxUses} searches`, signal: c.signal };
  let cl: Anthropic;
  try {
    cl = client();
  } catch (err) {
    blocked(base, err as Error);
  }
  const model = c.model ?? modelFor(false);
  const callId = startLog(base, model);
  const t0 = Date.now();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let searches = 0;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: c.userText }];
  const content: unknown[] = [];
  let stopReason: string | null = null;
  const toolType = webSearchToolType(model, c.toolVersion ?? '20250305');
  const allowed = c.allowedDomains?.length ? [...c.allowedDomains].slice(0, 64) : null;
  /** The code execution container of a paused turn (dynamic filtering): sent back when the turn is resumed. */
  let containerId: string | null = null;
  try {
    for (let round = 0; round <= WEB_SEARCH_MAX_CONTINUATIONS; round++) {
      const left = Math.max(0, c.maxUses - searches);
      if (round > 0 && left === 0) break;
      const params = {
        model,
        max_tokens: c.maxTokens ?? 16000,
        system: systemBlocks(c.system),
        messages,
        tools: [{ type: toolType, name: 'web_search', max_uses: round === 0 ? c.maxUses : left, ...(allowed ? { allowed_domains: allowed } : {}) }],
        output_config: { effort: c.effort ?? 'low' },
        ...(round > 0 && containerId ? { container: containerId } : {}),
      } as unknown as Anthropic.MessageStreamParams;
      const stream = cl.messages.stream(params, requestOptions({ signal: c.signal, timeoutMs: c.timeoutMs }));
      const final = await stream.finalMessage();
      const u = usageOf(final);
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.cacheReadTokens += u.cacheReadTokens;
      usage.cacheWriteTokens += u.cacheWriteTokens;
      const made = readWebSearchContent(final.content).queriesMade.length;
      const counted = (final.usage as { server_tool_use?: { web_search_requests?: number } | null }).server_tool_use?.web_search_requests;
      searches += typeof counted === 'number' ? counted : made;
      content.push(...final.content);
      stopReason = final.stop_reason;
      const container = (final as { container?: { id?: unknown } | null }).container;
      if (container && typeof container.id === 'string' && container.id) containerId = container.id;
      if (final.stop_reason === 'refusal') {
        const sd = final.stop_details as { category?: string | null; explanation?: string | null } | null;
        finishLog(callId, model, { usage, status: 'refused', durationMs: Date.now() - t0, stopReason, error: sd?.explanation ?? undefined, extraUsd: searches * WEB_SEARCH_FEE_USD, requestSummary: `${c.label}: ${searches} search${searches === 1 ? '' : 'es'}` });
        throw new AiRefusedError(sd?.category ?? null, sd?.explanation ?? null);
      }
      if (final.stop_reason !== 'pause_turn') break;
      // Resume where the server stopped: the paused turn goes back as it came (no extra "continue" message), with
      // the container of its code execution when the response named one; max_uses is what is left of the cap.
      messages.splice(1, messages.length - 1, { role: 'assistant', content: content as Anthropic.ContentBlockParam[] });
    }
    const read = readWebSearchContent(content);
    if (!searches) searches = read.queriesMade.length;
    const durationMs = Date.now() - t0;
    const usd = estimateUsd(model, usage) + searches * WEB_SEARCH_FEE_USD;
    finishLog(callId, model, { usage, status: 'ok', durationMs, stopReason, extraUsd: searches * WEB_SEARCH_FEE_USD, requestSummary: `${c.label}: ${searches} search${searches === 1 ? '' : 'es'}` });
    return { ...read, callId, usage, model, stopReason, searches, usd, durationMs, toolType };
  } catch (err) {
    if (err instanceof AiRefusedError) throw err;
    const disabled = isWebSearchDisabled(err);
    finishLog(callId, model, {
      usage,
      status: c.signal?.aborted ? 'cancelled' : 'error',
      error: disabled ? 'web search is not enabled for this organization' : err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
      httpStatus: httpStatusOf(err),
      extraUsd: searches * WEB_SEARCH_FEE_USD,
      requestSummary: `${c.label}: ${searches} search${searches === 1 ? '' : 'es'}`,
    });
    if (disabled) throw new WebSearchDisabledError();
    throw err;
  }
}

/** Count tokens without generating. Not logged (no generation, no cost). */
export async function countTokens(c: { model?: string; deep?: boolean; system: string | Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] }): Promise<number> {
  const cl = client();
  const model = c.model ?? modelFor(c.deep ?? false);
  const r = await cl.messages.countTokens({ model, system: c.system, messages: c.messages });
  return r.input_tokens;
}

/** A tiny round-trip to validate the key from Settings. */
export async function testConnection(model?: string): Promise<{ ok: boolean; model: string; error?: string }> {
  const m = model ?? modelFor(false);
  try {
    const r = await callText({ purpose: 'test', model: m, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Ping' }], maxTokens: 64, effort: 'low', requestSummary: 'connection test' });
    return { ok: /ok/i.test(r.text), model: r.model };
  } catch (err) {
    return { ok: false, model: m, error: err instanceof Error ? err.message : String(err) };
  }
}
