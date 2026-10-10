/**
 * Home, in plain words and plain logic (no React, no DOM, so tests can import
 * it): what waits for you (each line with its one action), what is coming up,
 * the documents added last grouped by the day they were added, and the moving
 * of the keyboard focus through the page's rows.
 */

import { isPastDue, todayIso } from '@shared/dates';

/** One line of "Waiting for you": the words and the one thing to do about it. */
export interface WaitingLine {
  key: 'needsSource' | 'inbox' | 'moves' | 'findings';
  words: string;
  /** The button's words. */
  action: string;
  /** Hover text for the button. */
  title: string;
  to: string;
  search?: Record<string, string>;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The lines that need the user, in order of importance: a disagreement no clinical record settles, uploads waiting
 * for a home, moves the clinician suggested, new things Claude noticed. (Documents not sorted yet and documents named
 * but not filed have their own lines, with a button that does the work.) Lines at 0 are left out.
 */
/** The counts these lines need (the shape of api/filing PendingCounts; not imported, so node tests stay DOM-free). */
export interface WaitingCounts {
  needsSource: number;
  inbox: number;
  moves: number;
  findings: number;
}

export function waitingLines(c: WaitingCounts | null | undefined): WaitingLine[] {
  if (!c) return [];
  const out: WaitingLine[] = [];
  if (c.needsSource > 0)
    out.push({
      key: 'needsSource',
      words: `${c.needsSource} ${plural(c.needsSource, 'disagreement needs', 'disagreements need')} a source: your records disagree and no clinical record settles ${plural(c.needsSource, 'it', 'them')}.`,
      action: plural(c.needsSource, 'Settle it', 'Settle them'),
      title: 'Opens Reconciliation, where you add or pick the clinical record that settles it',
      to: '/reconcile',
    });
  if (c.inbox > 0)
    out.push({
      key: 'inbox',
      words: `${c.inbox} ${plural(c.inbox, 'upload is', 'uploads are')} waiting for you to say where ${plural(c.inbox, 'it belongs', 'they belong')}.`,
      action: 'Review',
      title: 'Opens Check before filing',
      to: '/inbox',
    });
  if (c.moves > 0)
    out.push({
      key: 'moves',
      words: `${c.moves} ${plural(c.moves, 'move', 'moves')} the clinician suggested for where a document is filed.`,
      action: 'Review',
      title: 'Opens Documents, showing the ones with a suggested move',
      to: '/documents',
      search: { show: 'unsorted' },
    });
  if (c.findings > 0)
    out.push({
      key: 'findings',
      words: `${c.findings} new ${plural(c.findings, 'thing', 'things')} Claude noticed across the records.`,
      action: 'Review',
      title: 'Opens What Claude noticed, showing the new ones',
      to: '/findings',
      search: { status: 'new' },
    });
  return out;
}

/** The local calendar day of a timestamp, as YYYY-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Added today", "Added yesterday", "Added on 2026-10-04" (days are YYYY-MM-DD). */
export function addedDayWords(day: string, today: string): string {
  if (day === today) return 'Added today';
  const t = new Date(`${today}T12:00:00`);
  t.setDate(t.getDate() - 1);
  if (day === localDay(t.toISOString())) return 'Added yesterday';
  return `Added on ${day}`;
}

/** Documents in the order they were added, newest first, grouped by the day they were added. */
export function groupByAddedDay<T extends { createdAt: string }>(items: readonly T[], today: string, limit = 6): Array<{ day: string; words: string; items: T[] }> {
  const newest = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  const out: Array<{ day: string; words: string; items: T[] }> = [];
  for (const d of newest) {
    const day = localDay(d.createdAt);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(d);
    else out.push({ day, words: addedDayWords(day, today), items: [d] });
  }
  return out;
}

export interface ComingUpItem {
  id: string;
  date: string | null;
  precision: string;
  what: string;
  who: string;
  kind: string;
  to: string;
  search: Record<string, string>;
  /** Said in a tag when the date is behind today: "overdue" (a to-do or a promised follow-up), "date passed" (an appointment). */
  late: string | null;
}

/** Who owes a to-do, as the To-do list says it (features/tasks/words.ts taskOwnerWords, short): the name when there is one, never the stored code. */
const OWNER_WORDS: Record<string, string> = { me: 'Me', chief_of_staff: 'Chief of staff', advocate: 'Advocate', person: 'Someone else' };
export function ownerWords(owner: string, ownerName?: string | null): string {
  if (owner === 'me') return OWNER_WORDS.me;
  return ownerName || OWNER_WORDS[owner] || owner.replace(/_/g, ' ');
}

/** Appointments, to-dos due and promised follow-ups, soonest first (undated last); late ones say so, as on their own pages. */
export function comingUp(t: {
  upcomingEncounters?: Array<{ id: string; title: string; occurredAt: string | null; occurredAtPrecision: string; clinician: string | null }>;
  tasksDue?: Array<{ id: string; title: string; dueAt: string | null; owner: string; ownerName?: string | null }>;
  followUpsDue?: Array<{ id: string; subject: string; followUpPromised: string | null; followUpDue: string | null; withWhom: string }>;
} | null | undefined, today: string = todayIso()): ComingUpItem[] {
  if (!t) return [];
  const late = (date: string | null, words: string) => (isPastDue(date, today) ? words : null);
  return [
    ...(t.upcomingEncounters ?? []).map((x) => ({ id: `e-${x.id}`, date: x.occurredAt, precision: x.occurredAtPrecision, what: x.title, who: x.clinician ?? '', kind: 'Appointment', to: '/encounters', search: { id: x.id }, late: late(x.occurredAt, 'date passed') })),
    ...(t.tasksDue ?? []).map((x) => ({ id: `t-${x.id}`, date: x.dueAt, precision: 'day', what: x.title, who: ownerWords(x.owner, x.ownerName), kind: 'To-do', to: '/tasks', search: { id: x.id }, late: late(x.dueAt, 'overdue') })),
    ...(t.followUpsDue ?? []).map((x) => ({ id: `f-${x.id}`, date: x.followUpDue, precision: 'day', what: x.followUpPromised ?? x.subject, who: x.withWhom, kind: 'Promised follow-up', to: '/communications', search: { id: x.id }, late: late(x.followUpDue, 'overdue') })),
  ].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}

/** The row to focus after moving `delta` from `current` among `count` rows (-1: none focused yet). */
export function nextRow(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}
