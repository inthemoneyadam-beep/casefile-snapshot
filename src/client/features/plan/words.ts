/**
 * The Plan page in plain words (routes/plan.tsx): the tabs, their keys and one line each, when an item applies, what
 * a person changed beside the plan's wording, and which items each tab lists. Pure (no React), so it can be tested.
 */
import { formatPartialDate } from '@shared/dates';
import type { PlanItem } from '../../api/plans';

export const TABS = ['framework', 'checklist', 'timeline', 'original', 'plans'] as const;
export type PlanTab = (typeof TABS)[number];

export const TAB_WORDS: Record<PlanTab, string> = { framework: 'Framework', checklist: 'Checklist', timeline: 'Timeline', original: 'Original', plans: 'All plans' };
/** v t, v b and v r are the theme keys everywhere, so the timeline is v w ("when"). */
export const TAB_KEYS: Record<PlanTab, string> = { framework: 'v f', checklist: 'v c', timeline: 'v w', original: 'v o', plans: 'v p' };
export const TAB_INTRO: Record<PlanTab, string> = {
  framework: 'The plan as an outline: its sections, goals, steps and decisions with their branches.',
  checklist: 'Everything to do or check, to mark done, skipped or not applying.',
  timeline: 'What has a time: dated items first, then the plan’s own words, then what applies only when something happens.',
  original: 'The plan document itself, with the passages each item came from marked.',
  plans: 'Every plan you added. The newest one read is the current plan; older ones are kept.',
};

export const INTRO = 'Your current plan, read from the document you add: an outline, a checklist and its timing.';
export const DROP_WORDS = 'Drop your plan here: a PDF, a Word file, a text file or a photo.';
export const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp,.gif,application/pdf,image/*,text/plain';

export const CHECK_VIEWS = ['open', 'finished', 'all'] as const;
export type CheckView = (typeof CHECK_VIEWS)[number];
export const CHECK_VIEW_WORDS: Record<CheckView, string> = { open: 'To do', finished: 'Finished', all: 'All' };

/** The status keys: x done, s skipped, a doesn't apply (each again puts it back to do). */
export const STATUS_KEYS: Record<'done' | 'skipped' | 'not_applicable', string> = { done: 'x', skipped: 's', not_applicable: 'a' };
export const STATUS_BUTTON_WORDS: Record<'done' | 'skipped' | 'not_applicable', string> = { done: 'Done', skipped: 'Skipped', not_applicable: "Doesn't apply" };

export function statusTone(status: string): 'ok' | 'ash' | 'neutral' {
  return status === 'done' ? 'ok' : status === 'open' ? 'neutral' : 'ash';
}

/** When, as the plan says it: its words, else the date. */
export function whenWords(it: Pick<PlanItem, 'due' | 'duePrecision' | 'dueText'>): string | null {
  if (it.dueText) return it.dueText;
  return it.due ? formatPartialDate(it.due, it.duePrecision as never) : null;
}

/** A branch of a decision reads "If ...: what to do". */
export function itemLine(it: Pick<PlanItem, 'title' | 'condition' | 'parentId'>, parentKind?: string | null): string {
  if (it.condition && parentKind === 'decision') return `${it.condition.replace(/[:.]\s*$/, '')}: ${it.title}`;
  return it.title;
}

/** Which timeline group an item is in: a date, the plan's own words for when, or "when it applies" (a condition). */
export type TimelineGroup = 'date' | 'words' | 'when';
export function timelineGroup(it: Pick<PlanItem, 'due' | 'dueText' | 'condition'>): TimelineGroup | null {
  if (it.due) return 'date';
  if (it.dueText) return 'words';
  if (it.condition) return 'when';
  return null;
}
export const TIMELINE_GROUP_WORDS: Record<TimelineGroup, string> = { date: 'On a date', words: 'At a time the plan names', when: 'When it applies' };

/** Sort key: dated items by date, then the plan's own timing words in plan order, then the conditional ones. */
export function timelineKey(it: Pick<PlanItem, 'due' | 'dueText' | 'condition' | 'order'>): string {
  const g = timelineGroup(it);
  const rank = g === 'date' ? '0' : g === 'words' ? '1' : '2';
  return `${rank}|${g === 'date' ? it.due : ''}|${it.order}`;
}

/** "As written: ..." lines for the fields a person changed (the plan's own wording is never lost). */
export function asWrittenLines(it: Pick<PlanItem, 'asWritten' | 'userFields'>): string[] {
  const w = it.asWritten;
  if (!w || !it.userFields.length) return [];
  const out: string[] = [];
  if (it.userFields.includes('title') && w.title !== undefined) out.push(`As written: “${w.title}”`);
  if (it.userFields.includes('owner') && w.owner !== undefined) out.push(`Who, as written: ${w.owner ? `“${w.owner}”` : 'not said'}`);
  if (it.userFields.includes('due') && w.due !== undefined) {
    const was = w.due?.text ?? (w.due?.iso ? formatPartialDate(w.due.iso, w.due.precision as never) : null);
    out.push(`When, as written: ${was ? `“${was}”` : 'not said'}`);
  }
  return out;
}

/** Lower-case words of an item for Find. */
export function itemSearchText(it: Pick<PlanItem, 'title' | 'detail' | 'owner' | 'dueText' | 'condition' | 'note' | 'kindWords'>): string {
  return [it.title, it.detail, it.owner, it.dueText, it.condition, it.note, it.kindWords].filter(Boolean).join(' ').toLowerCase();
}

export function matchesFind(it: Parameters<typeof itemSearchText>[0], q: string | undefined): boolean {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = itemSearchText(it);
  return words.every((w) => hay.includes(w));
}

/** The people the plan names as owners, for the Who filter (as written, each once). */
export function ownersOf(items: ReadonlyArray<Pick<PlanItem, 'owner'>>): string[] {
  return [...new Set(items.map((i) => i.owner?.trim()).filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b));
}

export function checkViewHas(view: CheckView, status: string): boolean {
  if (view === 'all') return true;
  return view === 'open' ? status === 'open' : status !== 'open';
}

/** When and by whom an item was marked, beside its status tag: "on 2026-10-08 by Robin". */
export function doneWords(it: Pick<PlanItem, 'status' | 'doneAt' | 'doneBy'>): string | null {
  if (it.status === 'open' || !it.doneAt) return null;
  return `on ${it.doneAt.slice(0, 10)}${it.doneBy ? ` by ${it.doneBy}` : ''}`;
}
