/**
 * The Search page's words: what each kind of result is called (a group in the
 * list, a choice under "Show:", the small line above a result's title), the
 * hit's title without the page number the server appends, and which kinds of
 * result the "Show:" control offers (only those with results; the rest under
 * "Other types"). Plain TypeScript (no React, no DOM) so tests can import it.
 */

export const TYPE_ORDER = ['document', 'page', 'fact', 'person', 'communication', 'record', 'encounter', 'medication', 'intolerance', 'lab', 'imaging', 'task', 'finding'] as const;
export type HitType = (typeof TYPE_ORDER)[number];

/** A group in the list and a choice under "Show:". */
export const TYPE_LABELS: Record<HitType, string> = {
  document: 'Documents',
  page: 'Pages',
  fact: 'Details',
  person: 'People and places',
  communication: 'Calls and messages',
  record: 'Records',
  encounter: 'Appointments',
  medication: 'Medications',
  intolerance: 'Allergies and intolerances',
  lab: 'Lab results',
  imaging: 'Scans',
  task: 'To-dos',
  finding: 'What Claude noticed',
};

/** One result of that kind: the small line above its title in the reading pane. */
export const TYPE_ONE: Record<HitType, string> = {
  document: 'Document',
  page: 'Page of a document',
  fact: 'Detail from a document',
  person: 'Person or place',
  communication: 'Call or message',
  record: 'Record on the checklist',
  encounter: 'Appointment',
  medication: 'Medication',
  intolerance: 'Allergy or intolerance',
  lab: 'Lab result',
  imaging: 'Scan',
  task: 'To-do',
  finding: 'Something Claude noticed',
};

/** Where Open takes you, in words ("Open in Medications"). */
export const OPEN_WORDS: Record<HitType, string> = {
  document: 'Open the document',
  page: 'Open the page',
  fact: 'Open in Details from documents',
  person: 'Open in People and places',
  communication: 'Open in Calls and messages',
  record: 'Open in the Records checklist',
  encounter: 'Open in Appointments',
  medication: 'Open in Medications',
  intolerance: 'Open in Medications',
  lab: 'Open in Lab results',
  imaging: 'Open in Scans and imaging',
  task: 'Open in the To-do list',
  finding: 'Open in What Claude noticed',
};

const KNOWN = new Set<string>(TYPE_ORDER);

export function isHitType(t: string): t is HitType {
  return KNOWN.has(t);
}

/** The `types` search param ("page,fact") as known types, in the order given. */
export function parseTypes(s: string | undefined): HitType[] {
  return (s ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(isHitType);
}

/**
 * A page hit's title without the " · p.3" the server appends (the page number is shown once, on its own). Other
 * titles are returned as they are.
 */
export function hitTitle(h: { type: string; title: string; pageNumber?: number }): string {
  if (h.type !== 'page' || !h.pageNumber) return h.title;
  const suffix = ` · p.${h.pageNumber}`;
  return h.title.endsWith(suffix) ? h.title.slice(0, -suffix.length) : h.title;
}

/**
 * A detail's stored status (the server sends it as the hit's snippet) in the app's words, for a detail whose check
 * could not be looked up: "accepted", "incorrect", "replaced"; a detail nobody answered is automatic and says nothing.
 * Never the raw "confirmed" / "unverified".
 */
export function factStatusWords(status: string | undefined | null): string | null {
  switch (status) {
    case 'confirmed':
      return 'accurate';
    case 'disputed':
      return 'incorrect';
    case 'superseded':
      return 'replaced';
    default:
      return null;
  }
}

export interface ShowChoices {
  /** Shown as choices beside "All". */
  shown: HitType[];
  /** Kinds with results that did not fit: under "Other types". */
  other: HitType[];
}

/**
 * Which kinds of result "Show:" offers: only kinds with results (a chosen kind always, even at 0), in the list's
 * order; at most `max` of them beside "All", the rest under "Other types" (a chosen kind from there joins the row).
 */
export function showChoices(count: (t: HitType) => number, chosen: readonly HitType[], max = 4): ShowChoices {
  const withResults = TYPE_ORDER.filter((t) => count(t) > 0 || chosen.includes(t));
  if (withResults.length <= max + 1) return { shown: withResults, other: [] };
  const byCount = [...withResults].sort((a, b) => count(b) - count(a) || TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const top = new Set<HitType>(byCount.slice(0, max));
  for (const t of chosen) top.add(t);
  return { shown: withResults.filter((t) => top.has(t)), other: withResults.filter((t) => !top.has(t)) };
}

/** How many times the query's words (queryTokens: lower case, at least two characters) appear in `text`, as marked. */
export function matchCount(text: string, tokens: readonly string[]): number {
  if (!text || !tokens.length) return 0;
  const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return text.match(re)?.length ?? 0;
}

/** "21 results", "1 result", "200+ results". */
export function resultCount(n: number, capped = false): string {
  return `${n}${capped ? '+' : ''} result${n === 1 && !capped ? '' : 's'}`;
}
