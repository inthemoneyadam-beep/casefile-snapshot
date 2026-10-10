/**
 * The Records checklist page's words: its purpose, the Show: choices and the one
 * line under the toolbar that says what each list holds, and the answers.
 */
import type { Transition } from '../../api/records';

export const RECORDS_VIEWS = ['all', 'gaps', 'requested', 'held'] as const;
export type RecordsView = (typeof RECORDS_VIEWS)[number];

export const RECORDS_VIEW_WORDS: Record<RecordsView, string> = { all: 'All', gaps: 'Missing', requested: 'Asked for', held: 'Have' };

/** What each list holds, in one sentence under the toolbar (and on hover over its choice). */
export const RECORDS_VIEW_INTRO: Record<RecordsView, string> = {
  all: 'Every record on the checklist: the ones you have, the ones you asked for, and the ones you still need.',
  gaps: 'Records your documents mention, or that are on the checklist, which you do not have yet. Add one to the checklist, or mark it asked for when you request it.',
  requested: 'Records you have asked for and are waiting on.',
  held: 'Records you have a copy of.',
};

export const RECORDS_INTRO = 'Which records exist for the case, which you have, which you have asked for, and which your documents mention but you do not have yet.';

/** "Marked asked for: …" */
export const TRANSITION_WORDS: Record<Transition, string> = { request: 'asked for', receive: 'received', 'not-held': 'they have none', denied: 'they refused' };

/** The confirm's title and button for the two answers that unlink a copy. */
export const TRANSITION_TITLE: Record<'not-held' | 'denied', string> = { 'not-held': 'Mark that they have none', denied: 'Mark that they refused' };
