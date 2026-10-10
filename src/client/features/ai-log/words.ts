/**
 * The AI usage log in plain words (routes/ai-log.tsx): a request's result, what it was for, the server's one-line
 * summary without its shorthand, why the answer ended, and a known failure said plainly.
 */
import type { TagTone } from '../../ui/StatusTag';

/** A request's result, in words, with its tone. */
export const RESULT_WORDS: Record<string, { label: string; tone: TagTone; title: string }> = {
  ok: { label: 'answered', tone: 'ok', title: 'Claude answered' },
  error: { label: 'failed', tone: 'bad', title: 'The request failed; the reason is in the detail' },
  refused: { label: 'refused', tone: 'warn', title: 'Claude declined to answer' },
  blocked: { label: 'not sent', tone: 'ash', title: 'Stopped before it left this computer (Claude switched off, or no API key)' },
  running: { label: 'running', tone: 'info', title: 'Waiting for the answer' },
};
export function resultWords(status: string): { label: string; tone: TagTone; title: string } {
  return RESULT_WORDS[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral', title: '' };
}

/** What a request was for, in words. */
export const PURPOSE_WORDS: Record<string, string> = {
  ask: 'Ask the clinician',
  classify_document: 'Sorting a document',
  extract_facts: 'Reading a document',
  crossref: 'Checking across the records',
  test: 'Connection test',
  retitle_document: 'Naming a document',
  read_plan: 'Reading a plan',
  self_check: 'Checking a document against itself',
  web_search: 'Web search',
};
export function purposeWords(p: string): string {
  return PURPOSE_WORDS[p] ?? p.charAt(0).toUpperCase() + p.slice(1).replace(/_/g, ' ');
}

/**
 * The server's one-line summary of a request, in words: "extract Lab report p.1-4" -> "Lab report, pages 1 to 4";
 * "classify: Lab report" -> "Lab report"; "cross-reference pass (deep, 12 sections)" -> "12 sections, deep";
 * nothing when it only repeats what the request was for ("connection test").
 */
export function summaryWords(purpose: string, summary: string | null | undefined): string | null {
  let s = (summary ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase() === purposeWords(purpose).toLowerCase()) return null;
  const pages = /\s+p\.(\d+)-(\d+)$/.exec(s);
  if (/^extract\s+/i.test(s)) s = s.replace(/^extract\s+/i, '');
  if (pages) s = s.slice(0, s.length - pages[0].length) + (pages[1] === pages[2] ? `, page ${pages[1]}` : `, pages ${pages[1]} to ${pages[2]}`);
  s = s.replace(/^classify:\s*/i, '');
  const xref = /^cross-reference pass \((deep|standard), (\d+) sections\)$/.exec(s);
  if (xref) s = `${xref[2]} sections of the records${xref[1] === 'deep' ? ', deep' : ''}`;
  return s || null;
}

/** Why the answer ended, in words. */
export const STOP_WORDS: Record<string, string> = { end_turn: 'Finished', max_tokens: 'Ran out of room for the answer', refusal: 'Refused', tool_use: 'Asked to look something up', stop_sequence: 'Finished', pause_turn: 'Paused' };

/** A failure in words when it is a known one; the full text stays below it. */
export function errorWords(error: string): string | null {
  if (/web search is not enabled/i.test(error)) return 'Web search is switched off for this Anthropic account. An admin turns it on in the Anthropic Console.';
  if (/NoApiKey|no anthropic api key/i.test(error)) return 'No API key was set, so nothing was sent.';
  if (/switched off|AiDisabled|ai\.enabled/i.test(error)) return 'Claude was switched off in Settings, so nothing was sent.';
  if (/401|authentication|invalid api key|x-api-key/i.test(error)) return 'The API key was not accepted.';
  if (/429|rate limit|overloaded|529/i.test(error)) return 'Claude was busy.';
  if (/credit|billing|402/i.test(error)) return 'The Anthropic account was out of credit.';
  if (/max_tokens/i.test(error)) return 'Claude ran out of room for its answer.';
  return null;
}
