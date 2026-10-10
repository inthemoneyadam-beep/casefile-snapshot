/**
 * The to-do list in plain words: who owes a to-do, where it came from, where
 * it stands. The stored codes (chief_of_staff, in_progress, encounter) never
 * reach the screen. Pure (no React), so it can be tested.
 */
import type { Task } from '../../api/tasks';

/** Who owes it, for the filter and the form. */
export const OWNER_WORDS: Record<string, string> = { me: 'Me', chief_of_staff: 'Chief of staff', advocate: 'Advocate', person: 'Someone else' };

/**
 * Who owes this one, with the person's name when there is one ("Robin (chief of staff)"); `short` gives the name
 * alone for a list column ("Robin"), the role when there is no name.
 */
export function taskOwnerWords(t: Pick<Task, 'owner' | 'ownerName'>, short = false): string {
  if (t.owner === 'person') return t.ownerName ?? 'Someone else';
  const role = OWNER_WORDS[t.owner] ?? t.owner;
  if (t.owner === 'me' || !t.ownerName) return role;
  return short ? t.ownerName : `${t.ownerName} (${role.toLowerCase()})`;
}

/** Where a to-do came from: the short word for the list, and the sentence for the detail. */
export const SOURCE_WORDS: Record<string, string> = {
  fact: 'Detail',
  finding: 'Claude noticed',
  communication: 'Call or message',
  document: 'Document',
  encounter: 'Appointment',
  record: 'Missing record',
  plan_item: 'Plan',
  manual: 'Added by hand',
  care_candidate: 'Care team',
};
export const SOURCE_LONG: Record<string, string> = {
  fact: 'A detail from a document',
  finding: 'Something Claude noticed',
  communication: 'A call or message',
  document: 'A document',
  encounter: 'An appointment',
  record: 'A record still missing',
  plan_item: 'An item of your plan',
  manual: 'Added by hand',
  care_candidate: 'Someone on the Care team',
};
export function sourceWords(type: string | null | undefined): string {
  return (type && SOURCE_WORDS[type]) || (type ?? '').replace(/_/g, ' ');
}

/** Where it stands. */
export const TASK_STATUS_WORDS: Record<string, string> = { open: 'to do', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' };
export function taskStatusWords(s: string | null | undefined): string {
  return (s && TASK_STATUS_WORDS[s]) || (s ?? '').replace(/_/g, ' ');
}
export function isOpenTask(t: Pick<Task, 'status'>): boolean {
  return t.status === 'open' || t.status === 'in_progress';
}

/** Priority: only high and urgent are worth a mark in a list. */
export const PRIORITY_TONE: Record<string, 'neutral' | 'warn' | 'bad' | 'ash'> = { low: 'ash', normal: 'neutral', high: 'warn', urgent: 'bad' };
export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** "due today", "due tomorrow", "due in 3 days", "2 days overdue"; null without a day. */
export function dueWords(dueAt: string | null | undefined, today: string, open: boolean): string | null {
  if (!dueAt || dueAt.length < 10 || today.length < 10) return null;
  const at = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const n = Math.round((at(dueAt) - at(today)) / 86400000);
  if (!open) return null;
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n > 1) return `due in ${n} days`;
  return n === -1 ? '1 day overdue' : `${-n} days overdue`;
}

/** A reminder as written: "2026-10-19 09:00" or "2026-10-19". */
export function reminderWords(remindAt: string | null | undefined): string | null {
  if (!remindAt) return null;
  return remindAt.includes('T') ? `${remindAt.slice(0, 10)} ${remindAt.slice(11, 16)}` : remindAt;
}
