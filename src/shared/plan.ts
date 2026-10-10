/**
 * The Plan page (2026-10-09): the current plan, read from a PDF dropped onto the page and shown as a framework or
 * as a checklist (several tabs).
 *
 * A plan document is stored like any upload (its original encrypted in the file store), then read by Claude into the
 * `plans` row and its `plan_items` (migration 0006): sections, goals, steps, checks, criteria, decision points with
 * their branches, contacts and medications named in the plan, each with who, when (a partial date and the plan's own
 * words), the condition that starts it and its citations (page and quote, verified against the page text, flagged
 * never dropped). Shared by the server and the browser: the words, the model's output shape, the reading's state, the
 * progress line and the rule that says which items of an earlier plan look the same as one in the new plan.
 */
import { z } from 'zod';
import { normalizeKey } from './text';

/** Bumped whenever the reading prompt or the output shape changes in a way that alters a plan's items. */
export const PLAN_SCHEMA_VERSION = 1;

export const PLAN_STATUSES = ['current', 'superseded', 'draft'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_ITEM_KINDS = ['section', 'goal', 'step', 'check', 'criterion', 'decision', 'contact', 'medication', 'other'] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

export const PLAN_ITEM_STATUSES = ['open', 'done', 'skipped', 'not_applicable'] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

/** The kinds the checklist holds when the reading did not say (the model marks each item actionable or not). */
export const ACTIONABLE_KINDS: ReadonlySet<string> = new Set(['step', 'check']);

/** The fields of an item a person may change; the plan's own wording of each is kept beside it ("As written: ..."). */
export const PLAN_USER_FIELDS = ['title', 'owner', 'due'] as const;
export type PlanUserField = (typeof PLAN_USER_FIELDS)[number];

// ---------------------------------------------------------------------------
// Words (the app's voice: short and plain; the stored codes never reach the screen)
// ---------------------------------------------------------------------------

export const PLAN_KIND_WORDS: Record<PlanItemKind, string> = {
  section: 'Section',
  goal: 'Goal',
  step: 'Step',
  check: 'Check',
  criterion: 'Criterion',
  decision: 'Decision',
  contact: 'Contact',
  medication: 'Medication',
  other: 'Other',
};

export const PLAN_ITEM_STATUS_WORDS: Record<PlanItemStatus, string> = { open: 'to do', done: 'done', skipped: 'skipped', not_applicable: "doesn't apply" };

export const PLAN_STATUS_WORDS: Record<PlanStatus, string> = { current: 'current', superseded: 'replaced', draft: 'new' };

export function planKindWords(kind: string | null | undefined): string {
  return (kind && PLAN_KIND_WORDS[kind as PlanItemKind]) || 'Other';
}
export function planItemStatusWords(status: string | null | undefined): string {
  return (status && PLAN_ITEM_STATUS_WORDS[status as PlanItemStatus]) || (status ?? '').replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// What the model returns (structured output). A flat list in outline order, each item naming its parent by `ref`:
// the API compiles the schema into a grammar (no recursion) and caps nullable fields at 16 per request (8 here).
// ---------------------------------------------------------------------------

export const planCitationOutput = z.object({
  page: z.number().int().describe('1-based page number from the === PAGE n === marker the passage sits under'),
  quote: z.string().describe('Verbatim passage copied from that page, 5 to 300 characters, exactly as it appears'),
});

export const planItemOutput = z.object({
  ref: z.string().describe('A short id for this item, unique in this answer ("1", "1.2", "1.2.3"), so children can name it'),
  parent_ref: z.string().nullable().describe('The ref of the section, goal or decision this item sits under, or null at the top'),
  kind: z.enum(PLAN_ITEM_KINDS).describe('section, goal, step, check, criterion, decision, contact, medication or other'),
  title: z.string().describe("The item in the plan's own words, shortened to one line when long"),
  detail: z.string().nullable().describe("More of the plan's own words about it (doses, how, why), or null"),
  owner: z.string().nullable().describe('Who does it, exactly as the plan says ("the patient", "neurology", "the chief of staff"), or null'),
  timing: z.string().nullable().describe('When, in the plan\'s own words ("within 48 hours of a flare", "every Monday", "by 2/15"), or null'),
  date: z.string().nullable().describe('A calendar date the plan gives for it (any format, as written), or null; never worked out from words like "in 2 weeks"'),
  condition: z.string().nullable().describe('The condition that starts it or the branch it belongs to, as written ("if fever above 38.5", "if no better by day 3"), or null'),
  actionable: z.boolean().describe('true when it is something someone does or checks off (a step, a check, a call to make); false for headings, goals, background and reference items'),
  citations: z.array(planCitationOutput).describe('1 to 3 passages that show this item, each with its page and a verbatim quote'),
});
export type PlanItemOutput = z.infer<typeof planItemOutput>;

export const planReadOutput = z.object({
  title: z.string().describe('The plan\'s own title, or a short plain name for it ("Flare plan", "Care plan after discharge")'),
  summary: z.string().nullable().describe('One or two plain sentences: what the plan is for and who wrote it, or null'),
  plan_date: z.string().nullable().describe('The date the plan was written or issued, exactly as written, or null'),
  items: z.array(planItemOutput).describe('Every section, goal, step, check, criterion, decision point and branch, contact and medication, in the order of the plan'),
});
export type PlanReadOutput = z.infer<typeof planReadOutput>;

// ---------------------------------------------------------------------------
// Stored shapes (plans.framework_json, plan_items.citations_json and detail_json)
// ---------------------------------------------------------------------------

/** Where the reading of a plan stands. */
export const PLAN_READING_STATES = ['waiting', 'reading', 'done', 'failed', 'ask', 'held', 'no_text', 'ai_off'] as const;
export type PlanReadingState = (typeof PLAN_READING_STATES)[number];

export interface PlanReading {
  state: PlanReadingState;
  /** When the state last changed. */
  at: string;
  /** Who started it ("The user"), when a person did. */
  by?: string | null;
  jobId?: string | null;
  pages?: number;
  chars?: number;
  calls?: number;
  estimateUsd?: number;
  /** The per-document limit it was compared with. */
  ceilingUsd?: number;
  /** What the calls cost (from the AI log). */
  costUsd?: number;
  model?: string;
  callIds?: string[];
  /** Plain words: why it stopped or failed. */
  error?: string | null;
  items?: number;
  citations?: number;
  /** Citations whose quote was not found on its page (kept, flagged). */
  unverified?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface PlanFramework {
  reading?: PlanReading;
  /** The title as the plan gave it, kept when a person renamed the plan. */
  asWrittenTitle?: string | null;
  /** The plan this one replaced, and what was done about its finished items. */
  carryOver?: { fromPlanId: string; appliedAt?: string; appliedBy?: string | null; applied?: number; dismissedAt?: string };
  supersededBy?: string | null;
  supersededAt?: string | null;
  /** A short history of status changes (made current, replaced, removed, read again). */
  history?: Array<{ at: string; by?: string | null; what: string }>;
}

export interface PlanCitation {
  page: number;
  quote: string;
  /** Found on its page (numbers and all). */
  verified: boolean;
  /** exact | normalized | fuzzy | mismatch | none */
  matchKind: string;
  /** Offsets into the stored page text, when found there. */
  start?: number | null;
  end?: number | null;
}

export interface PlanItemDetailJson {
  /** The reading's own id for the item. */
  ref?: string;
  actionable?: boolean;
  /** The plan's wording of each field a person changed. */
  asWritten?: { title?: string; owner?: string | null; due?: { iso: string | null; precision: string; text: string | null } };
  userFields?: PlanUserField[];
  /** Marked from the plan this one replaced ("Mark them"), with the earlier item. */
  carriedFrom?: { planId: string; itemId: string; at: string; by?: string | null };
  /** Who set each status, newest last (kept short). */
  statusHistory?: Array<{ status: string; at: string; by?: string | null }>;
}

export function isActionable(kind: string, detail: Pick<PlanItemDetailJson, 'actionable'> | null | undefined): boolean {
  if (kind === 'section') return false;
  if (typeof detail?.actionable === 'boolean') return detail.actionable;
  return ACTIONABLE_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// The progress line ("12 of 30 done · 2 skipped · 1 doesn't apply · 15 to do")
// ---------------------------------------------------------------------------

export interface PlanProgress {
  total: number;
  open: number;
  done: number;
  skipped: number;
  notApplicable: number;
}

export function planProgress(items: ReadonlyArray<{ status: string; actionable: boolean }>): PlanProgress {
  const p: PlanProgress = { total: 0, open: 0, done: 0, skipped: 0, notApplicable: 0 };
  for (const it of items) {
    if (!it.actionable) continue;
    p.total++;
    if (it.status === 'done') p.done++;
    else if (it.status === 'skipped') p.skipped++;
    else if (it.status === 'not_applicable') p.notApplicable++;
    else p.open++;
  }
  return p;
}

export function progressWords(p: PlanProgress): string {
  if (!p.total) return 'Nothing to check off';
  const parts = [`${p.done} of ${p.total} done`];
  if (p.skipped) parts.push(`${p.skipped} skipped`);
  if (p.notApplicable) parts.push(`${p.notApplicable} doesn't apply`);
  if (p.open && (p.skipped || p.notApplicable || p.done)) parts.push(`${p.open} to do`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// "Looks the same" (a new plan's items against the finished items of the plan it replaced)
// ---------------------------------------------------------------------------

/** Words that do not tell two plan items apart. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'at', 'with', 'by', 'if', 'is', 'be', 'your', 'my', 'it', 'as', 'any', 'all', 'from', 'then']);

export function planWords(title: string | null | undefined): string[] {
  return normalizeKey(title)
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w));
}

/** How alike two item titles are: 1 for the same words (order, case and small words aside), else word overlap (Jaccard). */
export function titleLikeness(a: string | null | undefined, b: string | null | undefined): number {
  const wa = planWords(a);
  const wb = planWords(b);
  if (!wa.length || !wb.length) return 0;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / (sa.size + sb.size - shared);
}

/** Two items "look the same" at or above this likeness; numbers must also agree ("Day 3" is not "Day 5"). */
export const LOOKS_SAME_AT = 0.75;

function numbersOf(s: string | null | undefined): string {
  return ((s ?? '').match(/\d+(?:\.\d+)?/g) ?? []).join(' ');
}

export function looksTheSame(a: string | null | undefined, b: string | null | undefined): boolean {
  if (numbersOf(a) !== numbersOf(b)) return false;
  return titleLikeness(a, b) >= LOOKS_SAME_AT;
}

export interface CarryCandidate {
  id: string;
  title: string;
  status: string;
}

/**
 * For each open item of the new plan, the finished item (done, skipped, doesn't apply) of the earlier plan that looks
 * the same, best match first; each earlier item answers at most one new item. Nothing is marked here.
 */
export function carryOverMatches(next: ReadonlyArray<CarryCandidate>, earlier: ReadonlyArray<CarryCandidate>): Array<{ itemId: string; fromItemId: string; likeness: number }> {
  const finished = earlier.filter((e) => e.status !== 'open');
  const pairs: Array<{ itemId: string; fromItemId: string; likeness: number }> = [];
  for (const n of next) {
    if (n.status !== 'open') continue;
    for (const e of finished) {
      if (!looksTheSame(n.title, e.title)) continue;
      pairs.push({ itemId: n.id, fromItemId: e.id, likeness: titleLikeness(n.title, e.title) });
    }
  }
  pairs.sort((x, y) => y.likeness - x.likeness);
  const usedNew = new Set<string>();
  const usedOld = new Set<string>();
  const out: typeof pairs = [];
  for (const p of pairs) {
    if (usedNew.has(p.itemId) || usedOld.has(p.fromItemId)) continue;
    usedNew.add(p.itemId);
    usedOld.add(p.fromItemId);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reading in words (one line on the page while a plan is not read yet)
// ---------------------------------------------------------------------------

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '$0.00';
  return n < 0.01 && n > 0 ? 'under $0.01' : `$${n.toFixed(2)}`;
}

export function readingWords(r: PlanReading | null | undefined): string {
  if (!r) return 'Not read yet.';
  switch (r.state) {
    case 'waiting':
      return 'Storing the pages. Claude reads the plan next.';
    case 'reading':
      return `Claude is reading the plan${r.calls && r.calls > 1 ? ` (${r.calls} parts)` : ''}${r.estimateUsd != null ? `, about ${usd(r.estimateUsd)}` : ''}.`;
    case 'done':
      return `Read${r.costUsd != null ? ` for ${usd(r.costUsd)}` : ''}${r.unverified ? `. ${r.unverified} quote${r.unverified === 1 ? ' was' : 's were'} not found on the page and ${r.unverified === 1 ? 'is' : 'are'} marked` : ''}.`;
    case 'failed':
      return `Could not read the plan${r.error ? `: ${r.error}` : '.'}`;
    case 'ask':
      return `Reading it would cost about ${usd(r.estimateUsd)}, more than your limit of ${usd(r.ceilingUsd)} per document.`;
    case 'held':
      return "The plan's document is held back: it may be someone else's record. Answer it on the document first.";
    case 'no_text':
      return 'No text could be read from this file, so there is nothing to read into a plan.';
    case 'ai_off':
      return r.error ?? 'Claude is switched off or has no key, so the plan was not read.';
    default:
      return '';
  }
}
