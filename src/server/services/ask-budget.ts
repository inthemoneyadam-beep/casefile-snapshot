/**
 * Keeping every Ask request inside the model's context window, across the whole tool loop.
 *
 * The first turn is assembled to a budget (ask-context, the counted rounds in ask.ts); every later turn re-sends all
 * of it plus each turn's answer and tool results. Without a check, a question that makes the clinician read a lot
 * ("review all documents") grows past the window and the API refuses it ("prompt is too long: 1096988 tokens >
 * 1000000 maximum"). So:
 *   - the first turn leaves headroom for looking things up (TOOL_HEADROOM), below the window less the answer's own
 *     output budget;
 *   - earlier turns of a conversation are re-sent with every new question, and the oldest give way once the first
 *     turn would leave less than the smallest preset's room for lookups (historyLimit, turnsToDrop);
 *   - before each later turn, the next prompt is projected from the exact size of the previous one (the API's usage)
 *     plus that turn's output plus the new tool results, counted conservatively (large batches by the API, at their
 *     real density: charsPerTokenFor); results that do not fit are cut, saying so to the model, and when no useful
 *     room is left the model is told to answer from what it has (a model that calls a tool anyway is asked again with
 *     tools off, in ask.ts);
 *   - a refusal for length that still happens is read (promptTooLong) and recovered once on the first turn and once
 *     on a later one, never shown as raw JSON.
 * Plain TypeScript (no DB), so tests drive it directly.
 */
import { MODEL_CONTEXT_TOKENS, type ConsultPreset } from '../../shared/constants';

/** Kept free below the window for what estimates miss (tool definitions, block overhead). */
export const PROMPT_SAFETY_TOKENS = 8_000;
/** Tool results are counted at this many characters per token: fewer than the page estimate's 3.6, so never short. */
export const TOOL_RESULT_CHARS_PER_TOKEN = 3;
/**
 * Results that could not be counted by the API are fitted at this density: lines that carry ids (⟦F:<uuid>⟧,
 * ⟦D:<uuid> p.N⟧) take about 2.1 to 2.6 characters per token.
 */
export const DENSE_CHARS_PER_TOKEN = 2.2;
/** Below this much room, another lookup would be too small to be useful: the model answers from what it has. */
export const MIN_TOOL_ROOM_TOKENS = 12_000;
/**
 * Room the first turn leaves for the tool loop, by how much the preset is expected to look up; never more than a
 * quarter of the prompt limit, so a small window still carries pages (Master on a 200k window: 32k, not 150k).
 */
export const TOOL_HEADROOM: Record<'master' | 'deep' | 'other', number> = { master: 150_000, deep: 100_000, other: 40_000 };

export type PresetKind = 'master' | 'deep' | 'other';

/** Master: the master preset or maximum effort; deep: the deep preset or the whole case; else other (as ask.ts reads them). */
export function presetKindOf(preset: Pick<ConsultPreset, 'key' | 'effort' | 'contextMode'>): PresetKind {
  if (preset.key === 'master' || preset.effort === 'max') return 'master';
  if (preset.key === 'deep' || preset.contextMode === 'everything') return 'deep';
  return 'other';
}

/** The output budget of one Ask turn (max_tokens). */
export function answerTokensOf(preset: Pick<ConsultPreset, 'key' | 'effort' | 'contextMode'>): number {
  return presetKindOf(preset) === 'master' ? 64_000 : 32_000;
}

/**
 * The preset with its case budget held to what the first turn may hold, so the case summary and the pages are chosen
 * to fit the window with room for the answer and the lookups (a preset saved with 850 000 tokens for a 1 000 000-token
 * window would otherwise leave none).
 */
export function withinWindow<P extends ConsultPreset>(preset: P): P {
  const limit = firstTurnLimit(preset, presetKindOf(preset), answerTokensOf(preset));
  return preset.maxContextTokens <= limit ? preset : { ...preset, maxContextTokens: limit };
}

export function windowOf(model: string): number {
  return MODEL_CONTEXT_TOKENS[model] ?? 200_000;
}

/** The most a prompt may hold for this model when the answer may use `maxTokens`. */
export function promptLimit(model: string, maxTokens: number): number {
  return Math.max(0, windowOf(model) - maxTokens - PROMPT_SAFETY_TOKENS);
}

/** The most the FIRST turn may hold: the prompt limit less the room kept for looking things up. */
export function firstTurnLimit(preset: Pick<ConsultPreset, 'model'>, kind: PresetKind, maxTokens: number): number {
  const limit = promptLimit(preset.model, maxTokens);
  return Math.max(0, limit - Math.min(TOOL_HEADROOM[kind], Math.floor(limit / 4)));
}

/**
 * The most the first turn may hold with the conversation's earlier turns in it: they stay (with their pages, and the
 * cache they already have) until the first turn would leave less than the smallest preset's room for lookups.
 */
export function historyLimit(preset: Pick<ConsultPreset, 'model'>, maxTokens: number): number {
  return firstTurnLimit(preset, 'other', maxTokens);
}

/**
 * How many of the oldest earlier turns give way so that `fixedTokens` (case summary, question, overhead) and the
 * turns left stay within `limit`. `turnTokens` are the earlier turns' sizes, oldest first.
 */
export function turnsToDrop(turnTokens: number[], fixedTokens: number, limit: number): number {
  let total = fixedTokens + turnTokens.reduce((n, t) => n + t, 0);
  let drop = 0;
  while (total > limit && drop < turnTokens.length) total -= turnTokens[drop++];
  return drop;
}

export function toolResultTokens(text: string, charsPerToken = TOOL_RESULT_CHARS_PER_TOKEN): number {
  return Math.ceil(text.length / charsPerToken) + 20;
}

/** The exact size of the prompt a response was given (uncached, cache read and cache write together). */
export function promptTokensOf(u: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export interface ToolResultText {
  id: string;
  text: string;
  isError?: boolean;
}

export interface FitResult {
  results: ToolResultText[];
  /** How many results were shortened. */
  cut: number;
  /** No useful room left: every result is a short notice and the next turn must answer from what was read. */
  full: boolean;
  /** These are the last results: too little room is left for another lookup, so the next turn answers from what was read. */
  last: boolean;
}

export const NO_ROOM_NOTE =
  '[Not included: the conversation has reached the most the model can read at once. Do not call any more tools. Write the answer now from what you have already read, and say plainly which documents or questions you could not get to, so they can be asked about separately.]';

/** Appended to the last result when it is the last lookup the window allows. */
export const LAST_LOOKUP_NOTE =
  '\n\n[This was the last lookup: the conversation has now reached the most the model can read at once. Do not call any more tools. Write the answer now from what you have read, and say plainly which documents or questions you could not get to, so they can be asked about separately.]';

/** A cut always makes these the last results, so the note only says what was left out (LAST_LOOKUP_NOTE follows). */
function cutNote(left: number): string {
  return `\n\n[Cut to fit: ${left.toLocaleString('en-US')} more characters of this result were left out because the conversation has reached the most the model can read at once.]`;
}

/** The results with LAST_LOOKUP_NOTE after the last one. */
function asLast(results: ToolResultText[]): ToolResultText[] {
  return results.map((r, i) => (i === results.length - 1 ? { ...r, text: r.text + LAST_LOOKUP_NOTE } : r));
}

/**
 * The tool results shortened to fit `roomTokens` (the room left in the next prompt), counted at `charsPerToken`
 * (charsPerTokenFor). Small results are kept whole; the room left is shared among the large ones, each cut at a line
 * break where it can be, with a note naming what was left out. With less than MIN_TOOL_ROOM_TOKENS, every result
 * becomes NO_ROOM_NOTE and `full` is set. When what is left after these results is too little for another lookup
 * (always so once a result had to be cut), they are the `last`: the last one says so, and the next turn answers from
 * what was read. The total never exceeds `roomTokens`.
 */
export function fitToolResults(results: ToolResultText[], roomTokens: number, charsPerToken = TOOL_RESULT_CHARS_PER_TOKEN): FitResult {
  const size = (text: string) => toolResultTokens(text, charsPerToken);
  const lastNoteTokens = Math.ceil(LAST_LOOKUP_NOTE.length / charsPerToken);
  const need = results.reduce((n, r) => n + size(r.text), 0);
  if (need <= roomTokens) {
    if (roomTokens - need >= MIN_TOOL_ROOM_TOKENS) return { results, cut: 0, full: false, last: false };
    if (need + lastNoteTokens <= roomTokens) return { results: asLast(results), cut: 0, full: false, last: true };
  }
  if (roomTokens < MIN_TOOL_ROOM_TOKENS) return { results: results.map((r) => ({ ...r, text: NO_ROOM_NOTE })), cut: results.length, full: true, last: true };
  // Keep the smallest whole while each fits an equal share of what is left; the rest share the remainder. The last
  // lookup's note takes its room first.
  const order = results.map((r, i) => ({ i, t: size(r.text) })).sort((a, b) => a.t - b.t);
  let room = roomTokens - lastNoteTokens - 1;
  let left = results.length;
  const whole = new Set<number>();
  for (const o of order) {
    if (o.t <= room / left) {
      whole.add(o.i);
      room -= o.t;
      left -= 1;
    }
  }
  const share = left ? room / left : 0;
  let cut = 0;
  const out = results.map((r, i) => {
    if (whole.has(i)) return r;
    cut += 1;
    // The cut note and the per-result overhead take room too; what is left of the share holds the text.
    const noteChars = cutNote(r.text.length).length;
    const chars = Math.max(0, Math.floor((share - 21) * charsPerToken) - noteChars);
    let head = r.text.slice(0, chars);
    const nl = head.lastIndexOf('\n');
    if (nl > chars * 0.6) head = head.slice(0, nl);
    return { ...r, text: head + cutNote(r.text.length - head.length) };
  });
  return { results: asLast(out), cut, full: false, last: true };
}

/**
 * The characters per token to fit these results at. Results that take at most half the room are counted at
 * TOOL_RESULT_CHARS_PER_TOKEN: even at the densest they still fit, and the next turn's size is exact again. Larger
 * ones are counted by the API (`count`; a sample of each when together they pass half the window), because fact,
 * page and timeline lines carry ids that take more tokens than plain text: the measured rate, never above the
 * default, with 3% to spare. DENSE_CHARS_PER_TOKEN when they cannot be counted.
 */
export async function charsPerTokenFor(results: ToolResultText[], roomTokens: number, model: string, count: ((text: string) => Promise<number>) | null): Promise<number> {
  const need = results.reduce((n, r) => n + toolResultTokens(r.text), 0);
  if (roomTokens < MIN_TOOL_ROOM_TOKENS || need <= roomTokens / 2) return TOOL_RESULT_CHARS_PER_TOKEN;
  const chars = results.reduce((n, r) => n + r.text.length, 0);
  const share = Math.min(1, windowOf(model) / 2 / Math.max(1, chars));
  const sample = results.map((r) => r.text.slice(0, Math.ceil(r.text.length * share))).join('\n\n');
  try {
    const tokens = count ? await count(sample) : 0;
    if (tokens > 0) return Math.min(TOOL_RESULT_CHARS_PER_TOKEN, sample.length / tokens) * 0.97;
  } catch {
    // fitted at the dense rate below
  }
  return DENSE_CHARS_PER_TOKEN;
}

/** "prompt is too long: 1096988 tokens > 1000000 maximum" read from an API error, or null. */
export function promptTooLong(err: unknown): { tokens: number; max: number } | null {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = /prompt is too long:\s*([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*maximum/i.exec(msg);
  if (!m) return null;
  return { tokens: Number(m[1].replace(/,/g, '')), max: Number(m[2].replace(/,/g, '')) };
}

/**
 * What the user reads when a request was still too long after the app's own recovery. `earlierTurns`: the request carried
 * earlier questions and answers of the conversation, so a new conversation is the remedy.
 */
export function tooLongWords(t: { tokens: number; max: number }, earlierTurns = false): string {
  const size = `(${t.tokens.toLocaleString('en-US')} tokens; the most is ${t.max.toLocaleString('en-US')})`;
  return earlierTurns
    ? `This conversation has grown past what the model can read at once ${size}: every new question re-sends the earlier questions and answers. Start a new conversation for this question, or ask about fewer documents at a time.`
    : `This question needed more of the case than the model can read at once ${size}. Ask about fewer documents at a time, or attach the ones that matter most.`;
}
