/**
 * What Claude noticed, in the words a patient uses (2026-10 UI overhaul). The stored values (category, severity,
 * status, rule ids) never reach the screen: every list, filter, tag and pane takes its words from here, and the answer
 * words are the buttons' own, under the question "Is this right?" ("Yes, needs follow-up", "Yes, done", "Doesn't
 * matter", "Incorrect"; the user's wording, 2026-10-08), as in the Guide (How CaseFile works).
 *
 * Plain TypeScript (no components, no DOM) so tests can import it directly.
 */
import { RULE_LABELS } from '../../api/findings';
import type { TagTone } from '../../ui/StatusTag';

/** The kind of finding (stored `category`). */
export const CATEGORY_WORDS: Record<string, string> = {
  discrepancy: 'Disagreement',
  missing_record: 'Missing record',
  trend: 'Trend',
  overlooked: 'Overlooked',
  correlation: 'Pattern in time',
  contradicts_itself: 'Contradicts itself',
  flag_mismatch: "Flag doesn't match the value",
};

/** What each kind means, in a sentence (hover text on the filter and the tag). */
export const CATEGORY_TITLES: Record<string, string> = {
  discrepancy: 'Two records give different dates, doses or results for the same thing',
  missing_record: 'A record that should exist is not in the case',
  trend: 'Values that move in one direction, or never come back into range',
  overlooked: 'A recommendation, referral or result nobody followed up',
  correlation: 'Two things that happen close together in time',
  contradicts_itself: 'One document says two things that cannot both be true',
  flag_mismatch: 'A lab flag says high or low where the value and its own range say otherwise',
};

export function categoryWords(category: string | null | undefined): string {
  if (!category) return 'Other';
  return CATEGORY_WORDS[category] ?? category.replace(/_/g, ' ');
}

/** How serious (stored `severity`): tag words and tone, most serious first. */
export const SEVERITY_WORDS: Record<string, { label: string; tone: TagTone; title: string }> = {
  high: { label: 'high', tone: 'bad', title: 'Worth raising with a doctor soon' },
  medium: { label: 'medium', tone: 'warn', title: 'Worth a look' },
  low: { label: 'low', tone: 'neutral', title: 'Small, but worth knowing' },
  info: { label: 'for information', tone: 'ash', title: 'For your information only' },
};
export const SEVERITY_ORDER = ['high', 'medium', 'low', 'info'] as const;

export function severityWords(severity: string): { label: string; tone: TagTone; title: string } {
  return SEVERITY_WORDS[severity] ?? { label: severity.replace(/_/g, ' '), tone: 'neutral', title: '' };
}

/** Your answer (stored `status`): the same words as the answer buttons. */
export const ANSWER_WORDS: Record<string, { label: string; tone: TagTone; filter: string; sentence: string }> = {
  new: { label: 'new', tone: 'warn', filter: 'New', sentence: 'No answer from you yet' },
  confirmed: { label: 'needs follow-up', tone: 'ok', filter: 'Needs follow-up', sentence: 'You said it is right and needs follow-up; it stays open' },
  resolved: { label: 'done', tone: 'neutral', filter: 'Done', sentence: 'You said it is right and done; it is closed and kept on file' },
  dismissed: { label: "doesn't matter", tone: 'ash', filter: "Doesn't matter", sentence: "You said it doesn't matter; it is closed and kept on file" },
  disputed: { label: 'incorrect', tone: 'bad', filter: 'Incorrect', sentence: 'You said it is incorrect; it is kept on file' },
};
export const ANSWER_ORDER = ['new', 'confirmed', 'resolved', 'dismissed', 'disputed'] as const;

export function answerWords(status: string): { label: string; tone: TagTone; filter: string; sentence: string } {
  return ANSWER_WORDS[status] ?? { label: status, tone: 'neutral', filter: status, sentence: status };
}

/** The answer buttons, in the order they show, with their keys and what each does. */
export const ANSWERS = [
  { status: 'confirmed', label: 'Yes, needs follow-up', key: 'c', title: 'It is right and something still needs doing (raise it with a doctor, get a record, have a summary corrected): it stays open, and the clinician sees it as live.' },
  { status: 'resolved', label: 'Yes, done', key: 'r', title: 'It is right and it is handled now: it closes, stays on file as a real issue, and still goes into packets you make.' },
  { status: 'dismissed', label: "Doesn't matter", key: 'x', title: 'True or not, it does not matter for your case: it closes, stays on file, and is left out of packets you make.' },
  { status: 'disputed', label: 'Incorrect', key: 'd', title: 'Claude got this wrong: there is nothing there. It closes and stays on file.' },
] as const;

/** Who found it: one of the built-in checks (by name), or Claude reading across the case. */
export function foundByWords(f: { origin: string; ruleId: string | null }): string {
  // Checked against itself (2026-10-09): Claude read that one document; the app compared its flags (no AI).
  if (f.ruleId === 'self_contradiction') return 'Claude, reading this one document against itself';
  if (f.ruleId === 'flag_mismatch') return 'The app, comparing each lab flag with its own value and range';
  if (f.origin === 'ai') return "Claude's reading of the whole case";
  if (!f.ruleId) return 'The built-in checks';
  const rule = RULE_LABELS[f.ruleId] ?? f.ruleId.replace(/_/g, ' ');
  return `The built-in checks (${rule})`;
}

/** A count with its noun, in agreement ("1 record", "2 records"). */
export function countWords(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
