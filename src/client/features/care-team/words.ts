/**
 * The Care team page in plain words (routes/care-team.tsx). Roles and statuses are the patient's own words
 * (shared/care-team.ts); everything else is short and plain.
 */
import type { TagTone } from '../../ui/StatusTag';
import { CARE_ROLE_WORDS, CARE_STATUS_WORDS, readCareRole, type CareStatus, type PhoneCheck, type SourcedField } from '@shared/care-team';

export const PAGE_INTRO = 'Who could look after a flare, in the order you are working: step 1 Local doctor, 2 Flare plan, 3 Lead specialist, 4 Expert. Where each one stands, how they did on the flare test. Every fact has a source.';

export const VIEWS = ['all', 'step', 'role', 'status', 'proposed', 'shortlisted', 'searches'] as const;
export type CareViewKey = (typeof VIEWS)[number];
export const VIEW_WORDS: Record<CareViewKey, string> = {
  all: 'All',
  step: 'By step',
  role: 'By role',
  status: 'By status',
  proposed: 'Waiting for your yes',
  shortlisted: 'Shortlisted',
  searches: 'Web searches',
};
export const VIEW_TITLES: Record<CareViewKey, string> = {
  all: 'Everyone on the list, by step, then status',
  step: 'Grouped by step: the order you are working',
  role: 'Grouped by role',
  status: 'Grouped by status',
  proposed: 'Found on the web. Nothing is added until you say yes.',
  shortlisted: 'Your shortlist',
  searches: 'Every web search made, with its exact words',
};
/** The one line under the toolbar: what the list holds. */
export const VIEW_LINES: Record<CareViewKey, string> = {
  all: 'Everyone on your list, in the order you are working: by step (1 Local doctor first), then status.',
  step: 'Everyone on your list, grouped by step: 1 Local doctor, 2 Flare plan, 3 Lead specialist, 4 Expert.',
  role: 'Everyone on your list, grouped by role.',
  status: 'Everyone on your list, grouped by status.',
  proposed: 'Found on the web. Nothing is added until you say yes. A no is kept, so they are never suggested again.',
  shortlisted: 'Your shortlist.',
  searches: 'Every web search made: the words sent, the ones refused (never sent), and the cost.',
};

/** A role in words; the old keys (before 2026-10-09) read as the new ones. */
export function roleWords(r: string | null | undefined): string {
  const k = readCareRole(r);
  return k ? CARE_ROLE_WORDS[k] : 'No role yet';
}
export function statusWords(s: string | null | undefined): string {
  return s && s in CARE_STATUS_WORDS ? CARE_STATUS_WORDS[s as CareStatus] : 'Found';
}

export const STATUS_TONE: Record<CareStatus, TagTone> = {
  found: 'neutral',
  contacted: 'neutral',
  call_booked: 'info',
  answered_flare_test: 'info',
  shortlisted: 'accent',
  declined: 'ash',
  chosen: 'ok',
};

/** "Testville, OH" */
export function placeWords(c: { city: string | null; state: string | null }): string {
  return [c.city, c.state].filter(Boolean).join(', ');
}

/** "3 of 8" or "not asked yet". */
export function flareWords(answered: number, backed: number, total: number): string {
  if (!answered) return 'not asked yet';
  return `${answered} of ${total}${answered > backed ? `, ${answered - backed} not backed yet` : ''}`;
}

export const KEY_HINTS: Array<[string, string]> = [
  ['j/k', 'move'],
  ['enter', 'edit'],
  ['n', 'add'],
  ['f', 'flare test'],
  ['d', 'pass or fail'],
  ['b', 'add a source'],
  ['p', 'verified by phone'],
  ['s', 'status'],
  ['c', 'log a call'],
  ['t', 'to-do'],
  ['/', 'find'],
];
export const PROPOSAL_KEY_HINTS: Array<[string, string]> = [
  ['j/k', 'move'],
  ['y', 'yes, add'],
  ['x', 'no'],
  ['w', 'find more'],
  ['/', 'find'],
];

/** "flare test passed" etc. for a verdict tag. */
export const VERDICT_TONE: Record<string, TagTone> = { pass: 'ok', fail: 'bad', not_decided: 'neutral' };

/**
 * Undo after "Verified by phone" was unticked: each tick taken back is ticked again with its own caller, day and facts,
 * oldest first (review 2026-10-09: several ticks were put back as one, under the last caller's name and day).
 */
export function undoTicks(checks: readonly PhoneCheck[]): Array<{ who: string; when: string; fields: SourcedField[] }> {
  return [...checks].sort((a, b) => a.at.localeCompare(b.at)).map((k) => ({ who: k.who, when: k.whenIso ?? k.when, fields: [...k.fields] }));
}
