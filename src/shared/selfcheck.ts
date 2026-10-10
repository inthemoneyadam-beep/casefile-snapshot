/**
 * Checked against itself (2026-10-09): documents sometimes flag a value low when it is high (or the reverse), or
 * contradict themselves in chart notes; these are caught as each facility's documents arrive.
 * One pure module for the server and the browser: the flag rule (no AI), the kinds of contradiction, the per-document
 * record kept in `documents.metadata_json.selfCheck`, and the words every screen uses.
 *
 * - A flag that doesn't match: a lab value printed by a clinical record (role printed, or unclassified while the
 *   document is not sorted yet) whose printed flag says otherwise than the value against the range printed with it:
 *   marked L but above the range, H but below it, H or L while inside it. HH, LL, H!, L!, CH and CL count as H and L.
 *   Only a measurement (never a limit such as "<3", never words, never a value printed as a range), only a range read
 *   as numbers, only in the same unit (a range printed in another unit is never used), never a document's claim (a
 *   summary, a note of the user's, a letter) and never a computed value (the user's lab rules 2-5 and 8). Nothing is changed:
 *   the value, the range and the flag stay as printed.
 * - A contradiction: two passages of ONE note or ONE document that cannot both be true (left and right, a symptom
 *   denied and present, a drug stopped and continued, two doses, two dates for one event, a normal exam and an abnormal
 *   finding of the same thing, a number in the text and another in a table, the assessment against the history). Both
 *   passages are quoted with their pages. Never a diagnosis, never who is right, never across documents.
 *
 * No DB, no React, no Node imports.
 */
import { numbersEqual, sameUnit, type LabReading } from './labvalues';

/** Bumped when either check changes what it finds: a document is checked once per version (re-read parts again). */
export const SELF_CHECK_VERSION = 1;

/** Finding kinds (stored `category`) and the rules that write them (stored `rule_id`). */
export const FLAG_MISMATCH_CATEGORY = 'flag_mismatch';
export const CONTRADICTION_CATEGORY = 'contradicts_itself';
export const FLAG_MISMATCH_RULE = 'flag_mismatch';
export const CONTRADICTION_RULE = 'self_contradiction';
export const SELF_CHECK_RULE_IDS: readonly string[] = [FLAG_MISMATCH_RULE, CONTRADICTION_RULE];
/** The `rule` of a self-check run in Past checks (crossref_runs.scope_json). */
export const SELF_CHECK_RUN_RULE = 'self_check';

// ---------------------------------------------------------------------------
// The flag rule (no AI)
// ---------------------------------------------------------------------------

export interface FlagMismatch {
  /** What the report printed, read: H or L (critical marks count as H and L). */
  printed: 'H' | 'L';
  /** The flag exactly as printed ("HH", "L", "(H)"). */
  raw: string;
  critical: boolean;
  /** The value against the range printed with it. */
  byRange: 'H' | 'L' | 'N';
  valueShown: string;
  unit: string | null;
  rangeShown: string;
}

/**
 * Whether a reading's printed flag can be compared with its own printed range at all (what "checked" counts): a
 * clinical record's measurement with a printed H or L, and a range printed as numbers in the value's own unit.
 * Review 2026-10-09: never a range built from stored numbers alone (no range text on record: no page shows it, and old
 * readings could turn "<50" into "-50"), and never a range that prints a unit the value does not have ("2-10
 * follicular", "135-145 mg/dL" beside a value with no unit: the same unit cannot be confirmed).
 */
export function flagCheckable(r: LabReading): boolean {
  if (r.role !== 'printed' && r.role !== 'unclassified') return false;
  if (r.value.kind !== 'number' || r.measurement == null) return false;
  if (r.flag.state !== 'flag' || (r.flag.printed !== 'H' && r.flag.printed !== 'L')) return false;
  if (r.range.status !== 'parsed' || r.range.kind === 'text' || r.range.kind == null || r.range.fromNumbersOnly) return false;
  // A range printed in another unit than the value is never used (computeFlag gives no flag then; said again here).
  const rangeUnit = r.range.unitInRange;
  if (rangeUnit && (!r.unit.key || !sameUnit(rangeUnit, r.unit.unit))) return false;
  const byRange = r.computed.flag;
  return byRange === 'H' || byRange === 'L' || byRange === 'N';
}

/** Half the last printed digit of a measurement ("5.0" -> 0.05, "4" -> 0.5, "3.4E5" -> 5000): how far rounding can hide. */
function roundingHalf(r: LabReading): number {
  const n = Math.abs(r.measurement ?? 0);
  const decimals = r.value.decimals ?? 0;
  if (r.value.scientific && n > 0) return 0.5 * 10 ** (Math.floor(Math.log10(n)) - decimals);
  return 0.5 * 10 ** -decimals;
}

/**
 * An H or L the printed value and range cannot contradict, though the value reads inside (review 2026-10-09):
 * - the flagged side has no number in the range ("<5" marked L, ">40" marked H): the lab may hold a limit it did not
 *   print, so there is nothing printed to compare with;
 * - the value as printed could be rounded across the flagged bound ("5.0" marked H against 3.5-5.0, "4" marked H
 *   against 3.6-4.4): labs flag the unrounded number, so the flag may be right.
 */
function insideButUncheckable(r: LabReading, printed: 'H' | 'L'): boolean {
  const bound = printed === 'H' ? r.range.high : r.range.low;
  if (bound == null || r.measurement == null) return true;
  const half = roundingHalf(r);
  const edge = printed === 'H' ? r.measurement + half : r.measurement - half;
  if (numbersEqual(edge, bound)) return false;
  return printed === 'H' ? edge > bound : edge < bound;
}

/**
 * The flag rule. Null unless the reading is a clinical record's measurement with a printed H or L flag and a range read
 * as numbers in the same unit, and the flag says otherwise than the value against that range.
 */
export function flagMismatchOf(r: LabReading): FlagMismatch | null {
  if (!flagCheckable(r)) return null;
  const byRange = r.computed.flag as 'H' | 'L' | 'N';
  const printed = r.flag.printed as 'H' | 'L';
  if (byRange === printed) return null;
  if (byRange === 'N' && insideButUncheckable(r, printed)) return null;
  return {
    printed,
    raw: (r.flag.raw ?? '').trim() || printed,
    critical: r.flag.critical,
    byRange,
    valueShown: r.valueShown,
    unit: r.unit.unit,
    rangeShown: r.rangeShown ?? r.computed.against ?? '',
  };
}

/** One row in plain words: "Sodium: 141 mmol/L is marked L (low), but it is above the range printed with it (135-140)." */
export function flagMismatchWords(analyte: string, m: FlagMismatch): string {
  const value = `${m.valueShown}${m.unit ? ` ${m.unit}` : ''}`;
  const meaning = m.printed === 'H' ? 'high' : 'low';
  const mark = `${m.raw} (${m.critical ? `critical ${meaning}` : meaning})`;
  const where = m.byRange === 'N' ? 'inside' : m.byRange === 'H' ? 'above' : 'below';
  return `${analyte}: ${value} is marked ${mark}, but it is ${where} the range printed with it (${m.rangeShown}).`;
}

// ---------------------------------------------------------------------------
// Contradictions (Claude)
// ---------------------------------------------------------------------------

export const CONTRADICTION_KINDS = ['side', 'symptom', 'medication', 'dose', 'date', 'exam', 'number', 'assessment', 'other'] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/** Each kind in the app's words (finding detail, the guide, the prompt's list). */
export const CONTRADICTION_KIND_WORDS: Record<ContradictionKind, string> = {
  side: 'Left and right',
  symptom: 'A symptom denied and present',
  medication: 'A drug stopped and continued',
  dose: 'Two doses',
  date: 'Two dates for one event',
  exam: 'A normal exam and an abnormal finding',
  number: 'A number in the text and another in a table',
  assessment: 'The assessment against the history',
  other: 'Two passages that cannot both be true',
};

export function contradictionKindWords(kind: string | null | undefined): string {
  return CONTRADICTION_KIND_WORDS[(kind ?? 'other') as ContradictionKind] ?? CONTRADICTION_KIND_WORDS.other;
}

// ---------------------------------------------------------------------------
// The record on the document (metadata_json.selfCheck; one writer: services/self-check.ts)
// ---------------------------------------------------------------------------

/** Where the contradiction check of a document stands. */
export const CONTRADICTION_STATES = ['none', 'queued', 'running', 'done', 'ask', 'declined', 'off', 'failed', 'stopped'] as const;
export type ContradictionState = (typeof CONTRADICTION_STATES)[number];

export interface SelfCheckPartRecord {
  version: number;
  /** sha256 of the text Claude was given for the part (a part whose text changed is checked again). */
  hash: string;
  at: string;
  found: number;
  status: 'done' | 'failed';
  error?: string | null;
}

export interface SelfCheckRecord {
  /** Who started it first: a new upload (automatic) or the user. */
  trigger?: 'upload' | 'user';
  flags?: {
    version: number;
    at: string;
    /** Values with a printed H or L flag and a range read as numbers (what could be checked). */
    checked: number;
    /** Values whose flag doesn't match. */
    mismatched: number;
    /** Of those, already named by another finding (not raised twice). */
    alreadyRaised: number;
    findingId: string | null;
  };
  contradictions?: {
    version: number;
    state: ContradictionState;
    at: string;
    /** Parts checked (by segment id, or "pages:a-b" for a document read before parts existed). */
    parts: Record<string, SelfCheckPartRecord>;
    /** Contradictions Claude returned, kept as findings, already on file, set aside (the two passages crossed two notes). */
    found: number;
    raised: number;
    alreadyRaised: number;
    setAside: number;
    /** Passages not found word for word on their page (kept, flagged). */
    unverified: number;
    estimateUsd?: number | null;
    calls?: number | null;
    /** The automatic check asked once above the limit: the user's answer. */
    decision?: 'yes' | 'not_now' | null;
    /** The cost his yes was given to (a yes covers up to a quarter more, as the reading's does). */
    approvedUsd?: number | null;
    decidedAt?: string | null;
    jobId?: string | null;
    error?: string | null;
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** The record from a document's metadata_json (string or parsed), or null. Unknown shapes read as null. */
export function selfCheckOf(metadata: string | Record<string, unknown> | null | undefined): SelfCheckRecord | null {
  let meta: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      meta = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  if (!isObj(meta) || !isObj(meta.selfCheck)) return null;
  return meta.selfCheck as SelfCheckRecord;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "3 flags don't match, 1 contradiction"; "nothing found" when both are 0. */
export function countsWords(c: { flags: number; contradictions: number }): string {
  const bits: string[] = [];
  if (c.flags) bits.push(`${plural(c.flags, 'flag')} ${c.flags === 1 ? "doesn't" : "don't"} match`);
  if (c.contradictions) bits.push(plural(c.contradictions, 'contradiction'));
  return bits.length ? bits.join(', ') : 'nothing found';
}

/** "From Valley Clinic" / "From a place not named". */
export function facilityWords(name: string | null | undefined): string {
  const n = (name ?? '').replace(/\s+/g, ' ').trim();
  return n ? `From ${n}` : 'From a place not named';
}

/** The contradiction check's state in a few words, for the document's panel. */
export function contradictionStateWords(c: SelfCheckRecord['contradictions'] | null | undefined, opts: { dollars?: (usd: number) => string } = {}): string | null {
  if (!c) return null;
  const usd = (n: number | null | undefined) => (typeof n === 'number' ? (opts.dollars ? opts.dollars(n) : `about $${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`) : '');
  switch (c.state) {
    case 'queued':
      return 'Claude will read it for contradictions next.';
    case 'running':
      return 'Claude is reading it for contradictions.';
    case 'ask':
      return `Reading it for contradictions costs ${usd(c.estimateUsd)}, more than your limit: say yes to go ahead.`;
    case 'declined':
      return 'Not read for contradictions (you said not now).';
    case 'off':
      return 'Not read for contradictions: Claude is off or has no key.';
    case 'failed':
      return `Reading it for contradictions failed${c.error ? `: ${c.error}` : ''}.`;
    case 'stopped':
      return 'Reading it for contradictions was stopped part-way.';
    case 'none':
      // Review 2026-10-09: a new upload sorted or marked since as a summary, a letter or your own notes.
      return 'Not read for contradictions by itself: it is not a clinical record now. Check it against itself (More) still works.';
    case 'done':
      return null;
    default:
      return null;
  }
}
