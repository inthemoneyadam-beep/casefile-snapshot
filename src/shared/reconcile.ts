/**
 * Quiet checks and reconciliation: the shapes the server (services/reconcile.ts,
 * routes/reconcile.ts) returns and the client renders. No detail waits for
 * approval by default; each one carries an automatic trust level:
 *
 * - verified: it comes from a clinical record (a live document of source tier 'primary');
 * - accurate: a mention elsewhere (a call, a summary, notes, a letter) that matches a
 *   verified detail (same thing, same date, same value), or the user said it is right;
 * - unbacked: nothing to compare it with yet (quiet, no action needed); or a record is there but the value could
 *   not be compared with it (another unit that does not convert, other words, a lab that names no sample on a day
 *   with several, a scan impression not worded nearly identically: scan wording is never judged, the reason quotes
 *   the report's words, 'Not compared: the scan report says "...". Read both.'; a clinic note's or another clinical
 *   record's scan worded otherwise than the scan report of its day reads so too, and is no record for others to
 *   match), or it names no subject or date:
 *   then its reason starts "Not compared:" and, when a record is there, says what the record gives (recordFactId
 *   names it);
 * - inaccurate: it contradicts a verified detail (a different value, or a date near the
 *   record's that differs), or the user said it is wrong;
 * - conflict: part of an event whose mentions disagree and no clinical record settles it
 *   ("needs a source"); or values a record of their day gives in another unit (or other words) that disagree with
 *   each other ("These documents give different values, and the lab report gives it in another unit: ...", the
 *   record named in recordFactId);
 * - replaced: a newer reading or a merged duplicate stands in for it.
 */

export const TRUSTS = ['verified', 'accurate', 'unbacked', 'inaccurate', 'conflict', 'replaced'] as const;
export type Trust = (typeof TRUSTS)[number];

export interface TrustInfo {
  trust: Trust;
  /** The user set it with an override (Accurate, Incorrect, Unsure, Inferred, It's actually right) or a correction. */
  byUser: boolean;
  /** The verified detail (or the patient's correction) this one was compared with. */
  recordFactId?: string | null;
  /**
   * The detail `recordFactId` names stands on the user's own word: their correction ("The record is wrong"), a
   * clinical record they chose with "This one is right", or (for a correction) their later correction. What undoes it
   * is that answer ("Undo my correction" / "Undo my choice"), never "The record is wrong". False with no record.
   */
  recordByUser?: boolean;
  recordDocumentId?: string | null;
  recordDocumentTitle?: string | null;
  /** Plain words of what the record says ("62 mg/dL on 2024-03-18", "2024-03-18"). */
  recordValue?: string | null;
  recordDate?: string | null;
  /** Plain one-line why, e.g. "The lab report says CSF protein 62 mg/dL on 2024-03-18." */
  reason?: string | null;
  /** The Reconciliation event this detail belongs to, when it is listed there. */
  eventKey?: string | null;
  /**
   * The user's correction (The record is wrong / This one is right on a detail that is not a clinical record) outranks
   * no record although a clinical record of that day is there: the record agrees, or gives the value in another unit or
   * other words (6.2 mmol/L chosen beside the lab report's 112 mg/dL). It is the value the user chose as the right one
   * ("You said this value is right: <reason>", accurate, byUser), not a correction of the record: say "your choice",
   * never "your correction of the record". Sent only when true.
   */
  chosenValue?: boolean;
  /**
   * "Not the same event" (POST /separate) would change something for this detail: a mention compared with a
   * record on another day (or grouped with mentions of other days), or a clinical record in an event whose
   * records disagree ("Both happened", same-day readings included). False on the record's own day, for a
   * detail already marked, and where nothing would change.
   */
  canSeparate?: boolean;
}

export interface Mention {
  factId: string;
  documentId: string | null;
  documentTitle: string | null;
  documentTier: string | null;
  page: number | null;
  citationId: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  /** Plain value or date as stated ("62 mg/dL on 2024-03-18", "2024-03-21"). */
  says: string;
  statement: string;
  trust: TrustInfo;
}

export const RECONCILE_TYPES = ['lab_result', 'imaging_result', 'vital', 'procedure', 'event'] as const;
export type ReconcileType = (typeof RECONCILE_TYPES)[number];

export const RECONCILE_STATES = ['needs_source', 'settled', 'unbacked'] as const;
export type ReconcileState = (typeof RECONCILE_STATES)[number];

export interface ReconcileEvent {
  /** Deterministic: type|subject|date (the record's date, else the earliest mention's). */
  key: string;
  type: ReconcileType;
  /** Plain label, e.g. "Lumbar puncture", "CSF protein". */
  subject: string;
  /** "on 2024-03-18", "around 2024-03-18", "in Mar 2024". */
  dateLabel: string;
  state: ReconcileState;
  /** The verified detail (or the patient's correction) that settles the event; null while it needs a source. */
  record: Mention | null;
  /** Every other mention, grouped by what it says, largest group first. */
  groups: Array<{ says: string; mentions: Mention[] }>;
  /** All details in the event, the record included. */
  mentionCount: number;
  documentCount: number;
  /**
   * Two (or more) clinical records disagree about this event (state needs_source, record null): the records
   * are listed in `groups` as mentions (documentTier 'primary'). Settled with "This one is right" on one record
   * (POST /correct, reason optional for a clinical record) or "Both happened" (POST /separate on one record).
   * Always sent by the server (optional here only so older fixtures still type-check).
   */
  recordsDisagree?: boolean;
  /**
   * Plain why it needs a source: "Two clinical records disagree", "The documents disagree", or (values a record gives
   * in another unit, which disagree with each other; record null, each mention's trust names the record) "These
   * documents give different values, and the lab report gives it in another unit: 112 mg/dL on 2024-03-18." (ending
   * with what the record gives, so it is told apart from the record's own settled event of that day); null otherwise.
   * Always sent.
   */
  reason?: string | null;
}

export interface ReconcileCounts {
  /** Events whose mentions disagree and no clinical record settles them. */
  needsSource: number;
  /** Details that contradict a verified one (or that the user marked wrong). */
  inaccurate: number;
  /** Events a clinical record (or the patient's correction) settles, with at least one other mention. */
  settled: number;
  /** Events with nothing to compare them with yet. */
  unbacked: number;
}

export type InaccurateItem = Mention & { record: Mention | null; event: { key: string; subject: string; dateLabel: string } };

/**
 * How far apart (in days) a mention may be from a verified detail and still be read as the same event:
 * a lab within 3 days; a procedure, scan or event within 7. A vital is only compared on its own day
 * (blood pressure, pulse and weight are measured at every visit).
 */
export const NEAR_DAYS: Record<ReconcileType, number> = { lab_result: 3, imaging_result: 7, procedure: 7, event: 7, vital: 0 };

/**
 * Treatments given again and again (infusions, IVIG, plasma exchange, dialysis, injections, therapy sessions,
 * chemotherapy, transfusions): like a vital, a procedure or event with such a name is compared on its own day
 * only (a session two days off is another session, not a wrong date).
 */
const REPEATED_TREATMENT = /(infusion|ivig|\biv ?ig\b|\biv immun|intravenous immun|plasmapheresis|\bplex\b|\btpe\b|plasma exchange|dialysis|injection|therapy session|physical therapy|physiotherapy|chemotherapy|\bchemo\b|transfusion)/;

export function isRepeatedTreatment(name: string | null | undefined): boolean {
  return REPEATED_TREATMENT.test((name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

/** Plain words for each trust level. */
export const TRUST_LABELS: Record<Trust, string> = {
  verified: 'Verified',
  accurate: 'Accurate',
  unbacked: 'Not backed yet',
  inaccurate: 'Inaccurate',
  conflict: 'Needs a source',
  replaced: 'Replaced',
};

/** Plain words for each event state (the Reconciliation tabs). */
export const STATE_LABELS: Record<ReconcileState, string> = {
  needs_source: 'Needs a source',
  settled: 'Settled',
  unbacked: 'Not backed yet',
};
