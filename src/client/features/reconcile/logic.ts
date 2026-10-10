/**
 * The rules of the Reconciliation page and of the Override in plain functions
 * (no React, no DOM), so the test project can check them: the trust sentence,
 * which answers a detail's Override offers (and the Details page keys that do
 * the same), which answers an inaccurate detail offers on the Inaccurate tab
 * (and its keys), which tab an event belongs on, whether it offers Upload the
 * record (never where a record is already here), which documents are offered
 * as the official record and in what order, what to do when two clinical
 * records disagree, and what a record just added did to its event.
 *
 * Three fields of the contract (src/shared/reconcile.ts) are optional there:
 * `ReconcileEvent.recordsDisagree`, `TrustInfo.canSeparate` and
 * `TrustInfo.recordByUser`. While one is missing (an older server, a fixture)
 * the safe answer is used.
 */
import type { InaccurateItem, Mention, ReconcileEvent, ReconcileState, TrustInfo } from '@shared/reconcile';

/* ------------------------------------------------------------------ */
/* The trust sentence.                                                 */
/* ------------------------------------------------------------------ */

/** "You were not sure about this one." -> "you were not sure about this one." */
function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function endDot(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** "Not compared: the lab report gives 112 mg/dL on 2024-03-18 (another unit or other words)." -> its two parts. */
const NOT_COMPARED = /^(Not compared(?: automatically)?)\s*:\s*([\s\S]*)$/i;

/**
 * A value the app did not compare with the clinical record of its day, because the record gives it in another unit
 * that does not convert or in other words (the server's "Not compared: <the record> gives <value> ..." reason).
 * Neither accurate nor inaccurate: what the record says is shown so the user can look for themselves. The general
 * "Not compared automatically: only lab results ... are compared" (a diagnosis, a medication) is not this.
 */
export function isNotCompared(t: TrustInfo | null | undefined): boolean {
  if (!t || t.trust !== 'unbacked' || t.byUser) return false;
  const reason = t.reason?.trim() ?? '';
  // A record named with no reason is the same case said without words: never "a record will check it".
  return /^Not compared\s*:/i.test(reason) || (!reason && Boolean(t.recordFactId || t.recordDocumentId));
}

/**
 * Not compared although a clinical record is there (the reason says what the record gives; recordFactId names it):
 * the case worth a visible line and a count. One that names no test or gives no date ("Not compared: it gives no
 * date ...") has no record to look at; its tag and its Override say why.
 */
export function notComparedWithRecord(t: TrustInfo | null | undefined): boolean {
  return Boolean(t && isNotCompared(t) && (t.recordFactId || t.recordDocumentId));
}

/** The server's words for documents that disagree with each other while the record gives the value in another unit. */
const OTHER_UNIT_CONFLICT = /^These documents give different values\b|\bgives? it in (?:another unit|other words)\b/i;

/**
 * A mention in a disagreement while a clinical record of that day is here but could not settle it (two summaries
 * give 6.2 and 8.0 mmol/L, the lab report gives 112 mg/dL): the server names the record, or its words say so.
 * Not two clinical records that disagree (those name no record).
 */
export function conflictWithRecord(t: TrustInfo | null | undefined): boolean {
  return Boolean(t && t.trust === 'conflict' && !t.byUser && (t.recordFactId || t.recordDocumentId || OTHER_UNIT_CONFLICT.test(t.reason ?? '')));
}

/** A mention that names a record that is here but was not compared with it (or could not settle it): its line says why, with the record to open. */
export function namesUncomparedRecord(t: TrustInfo | null | undefined): boolean {
  return notComparedWithRecord(t) || conflictWithRecord(t);
}

/**
 * Not backed, while it names a clinical record that is here, whoever answered it: the app's "Not compared" (another
 * unit, only the month...), or the user's own Not sure or Only in a summary on such a value (the server still names
 * the record). A record is here either way: never "Adding the clinical record will check it", never Upload the record.
 */
export function unbackedWithRecord(t: TrustInfo | null | undefined): boolean {
  return Boolean(t && t.trust === 'unbacked' && (t.recordFactId || t.recordDocumentId));
}

/**
 * The user's own answer (Not sure, Only in a summary) on a value that names a record that is here. Not "Not the same
 * event": that one is another occasion, so the record of this day is not its record (the server names none there).
 */
export function answeredWithRecord(t: TrustInfo | null | undefined): boolean {
  return Boolean(t && t.byUser && unbackedWithRecord(t) && !/^You said this is another occasion/.test(t.reason ?? ''));
}

/** "Lab report title gives 94 mg/dL on 2024-03-18." (what the record named in this trust gives), or that it is here. */
function recordGivesWords(t: TrustInfo): string {
  const title = t.recordDocumentTitle?.trim() || 'The clinical record';
  return t.recordValue?.trim() ? `${title} gives ${endDot(t.recordValue.trim())}` : `${title} is here.`;
}

/**
 * A value the user chose as the right one with This one is right, where a clinical record of that day gives it in
 * another unit (or other words) and stays as it is: their choice between values, not a correction of the record.
 * The server's `trust.chosenValue` (round 4), or its words "You said this value is right".
 */
export function isChosenValue(t: TrustInfo | null | undefined): boolean {
  if (!t) return false;
  return t.chosenValue === true || /^You said this value is right\b/.test(t.reason ?? '');
}

/**
 * The words a "Not compared" reason quotes from the record (a scan report's impression: 'Not compared: the scan
 * report says "Diffuse pachymeningeal enhancement…". Read both.'), without the quotation marks; null when it quotes
 * nothing. Only a fallback: the scan's page reads the report's whole impression from the record itself.
 */
export function quotedRecordWords(t: TrustInfo | null | undefined): string | null {
  if (!t || !isNotCompared(t)) return null;
  const m = /["“]([^"”]+)["”]/.exec(t.reason ?? '') ?? /^["“]([^"”]+)["”]/.exec(t.recordValue?.trim() ?? '');
  const words = m?.[1]?.trim();
  return words ? words : null;
}

/** A scan's own words in its detail's attributes: the impression, else the finding. */
export function impressionOf(attrs: Record<string, unknown> | null | undefined): string | null {
  for (const k of ['impression', 'finding', 'findings']) {
    const v = attrs?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The plain words of a trust level as a sentence: the label, then the why. */
export function trustSentence(t: TrustInfo): { label: string; rest: string } {
  const record = t.recordDocumentTitle?.trim() || 'a clinical record';
  switch (t.trust) {
    case 'verified':
      return { label: 'Verified', rest: `from ${record}.` };
    case 'accurate':
      if (!t.byUser) return { label: 'Accurate', rest: `matches ${record}.` };
      return { label: 'Accurate', rest: t.reason ? lowerFirst(endDot(t.reason)) : 'you said so.' };
    case 'unbacked': {
      // "Not compared" is said as it is (with what the record says), never as "not backed yet, a record will check
      // it": the record may already be here, in another unit or other words. The server's reason whenever it gives
      // one; the promise that a record will check it only where nothing else is said.
      const nc = !t.byUser && t.reason ? NOT_COMPARED.exec(t.reason.trim()) : null;
      if (nc) return { label: nc[1].charAt(0).toUpperCase() + nc[1].slice(1).toLowerCase(), rest: nc[2].trim() ? endDot(nc[2]) : '' };
      if (!t.reason && isNotCompared(t)) return { label: 'Not compared', rest: `${t.recordDocumentTitle?.trim() || 'A clinical record'} is here, but this was not compared with it.` };
      // The user's own answer on a value whose record is here: their answer, then what the record gives (no promise).
      if (answeredWithRecord(t)) return { label: 'Your answer', rest: `${t.reason ? lowerFirst(endDot(t.reason)) : 'you answered this one.'} ${recordGivesWords(t)}` };
      return { label: 'Not backed by a record yet', rest: t.reason ? lowerFirst(endDot(t.reason)) : 'nothing to compare it with. Adding the clinical record will check it.' };
    }
    case 'inaccurate':
      return { label: 'Inaccurate', rest: t.reason ? endDot(t.reason) : `it disagrees with ${record}.` };
    case 'conflict':
      return { label: 'Needs a source', rest: t.reason ? lowerFirst(endDot(t.reason)) : 'your documents disagree and no clinical record settles it yet.' };
    case 'replaced':
    default:
      return { label: 'Replaced', rest: t.reason ? lowerFirst(endDot(t.reason)) : 'a newer reading or a merged duplicate is used instead.' };
  }
}

/* ------------------------------------------------------------------ */
/* The user's own word behind the record.                              */
/* ------------------------------------------------------------------ */

/** The server's words when the record a detail is compared with stands on the user's own word. */
const USER_RECORD_WORDS = /(^|[.:]\s+)(Your (later )?correction says|The value you chose says|Your choice says|You said (?!this record\b|this value\b).+? is right|You said the record is wrong)/;

/**
 * The record this detail is compared with stands on the user's own word: their correction (The record is wrong), a
 * clinical record they chose with This one is right, or their later correction. The server says so in
 * `trust.recordByUser`; without it (an older server) the reason's words tell ("Your correction says ...", "You
 * said X is right", "You said the record is wrong: ..."). Only meaningful when the record is another detail.
 */
export function recordByUser(t: TrustInfo): boolean {
  return t.recordByUser === true || USER_RECORD_WORDS.test(t.reason ?? '');
}

/**
 * What outranks a detail on the user's word: their choice of another clinical record, their correction of the record,
 * (on a detail that is itself a correction) a later correction, or their choice of another value (This one is right
 * where the record of that day gives it in another unit; the record is not changed).
 */
export type UndoKind = 'choice' | 'correction' | 'later' | 'value';

export const UNDO_WORDS: Record<UndoKind, { label: string; title: string; done: string; why: string }> = {
  choice: {
    label: 'Undo my choice',
    title: 'Take back your choice of the other record: the records are compared again.',
    done: 'Your choice is undone; the records are compared again.',
    why: 'You chose another clinical record as the right one. To compare them again, use Undo my choice under Your answer.',
  },
  correction: {
    label: 'Undo my correction',
    title: 'Take back your correction: the record is used again.',
    done: 'Your correction is undone; the record is used again.',
    why: 'Your correction says otherwise. To use the record again, use Undo my correction under Your answer.',
  },
  later: {
    label: 'Undo my later correction',
    title: 'Take back your later correction: this one is used again.',
    done: 'Your later correction is undone; this one is used again.',
    why: 'Your later correction says otherwise. To use this one again, use Undo my later correction under Your answer.',
  },
  value: {
    label: 'Undo my choice',
    title: 'Take back your choice of the other value: these values are compared again (the record is not changed).',
    done: 'Your choice is undone; these values are compared again.',
    why: 'You chose another value as the right one. To compare them again, use Undo my choice under Your answer.',
  },
};

/** Which Undo takes back the user's word that the record stands on: their correction, their choice of a value, or their choice of a clinical record. */
function undoKindOf(t: TrustInfo): UndoKind {
  const reason = t.reason ?? '';
  if (/(^|[.:]\s+)(The value you chose says|Your choice says)/.test(reason)) return 'value';
  return /(^|[.:]\s+)(You said the record is wrong|Your (later )?correction says)/.test(reason) ? 'correction' : 'choice';
}

/* ------------------------------------------------------------------ */
/* The Override of one detail (TrustOverride) and the Details keys.    */
/* ------------------------------------------------------------------ */

/** The toast after It's accurate, from the trust the server answered with. */
export function keepWords(answered: TrustInfo | null | undefined): string {
  return answered?.trust === 'conflict'
    ? 'Marked accurate. It disagrees with the record, so it is listed under Needs a source for you to settle.'
    : 'Marked accurate. It is kept whatever the other documents say.';
}

export type OverrideAnswer = 'accurate' | 'summary' | 'unsure' | 'wrong';

/** Which of the user's answers the detail carries now, if any. */
export function currentAnswer(status: string | null | undefined, basis: string | null | undefined): OverrideAnswer | 'correction' | null {
  if (status === 'confirmed') return basis === 'summary' ? 'summary' : basis === 'correction' ? 'correction' : 'accurate';
  if (status === 'disputed') return 'wrong';
  if (status === 'unverified' && basis === 'unsure') return 'unsure';
  return null;
}

export interface OverrideInput {
  factId: string | null | undefined;
  trust: TrustInfo;
  status: string | null | undefined;
  basis?: string | null;
  reconciled: boolean;
  separated: boolean;
  /** The detail's document tier; undefined while unknown (the caller does not have it), null without a document. */
  documentTier: string | null | undefined;
}

export interface OverrideOffers {
  /** It's accurate. */
  accurate: boolean;
  /** It's accurate waits for the detail's document tier (read once the Override is open): shown, not usable yet. */
  accurateWaiting: boolean;
  /** Only in a summary (where the page offers it). */
  summary: boolean;
  /** Not the same event. */
  separate: boolean;
  /** The record is wrong (with a reason). */
  recordWrong: boolean;
  /** Back to automatic. */
  reset: boolean;
  /** Undo the user's own answer that the record stands on (Back to automatic on trust.recordFactId); null when none. */
  undo: UndoKind | null;
}

function overrideState(p: OverrideInput) {
  const t = p.trust;
  const current = currentAnswer(p.status, p.basis);
  const recordIsOther = Boolean(t.recordFactId && t.recordFactId !== p.factId);
  // The record it is compared with is the user's own word (their correction, a record they chose).
  const userRecord = recordIsOther && recordByUser(t);
  const outranked = p.reconciled && t.trust === 'inaccurate' && t.byUser && p.status !== 'disputed' && recordIsOther;
  const automaticWrong = p.reconciled && t.trust === 'inaccurate' && !t.byUser;
  const restated = automaticWrong && p.documentTier === 'primary';
  const tierUnknown = automaticWrong && p.documentTier === undefined;
  // The detail is the user's correction (or the record they chose): already their strongest word. It's accurate (or
  // Only in a summary) would quietly turn it into a plain answer and drop the correction; Back to automatic first.
  const ownCorrection = current === 'correction';
  return { t, current, recordIsOther, userRecord, outranked, automaticWrong, restated, tierUnknown, ownCorrection };
}

/**
 * Which answers the Override offers (Not sure and It's wrong always show). The same rules as the Inaccurate tab
 * (inaccurateActions below) and the server (reconcile.ts keepMention):
 * - outranked: inaccurate on the user's word (not marked wrong by them) against another detail, i.e. their choice
 *   of another clinical record or their correction says this is wrong. The server refuses It's accurate there
 *   (409) and Back to automatic on this detail changes nothing, so neither shows unless the detail itself carries
 *   an answer to forget; "Undo my choice" (or correction) resets the detail that outranks it.
 * - compared with the user's own word: a detail that disagrees with the user's correction (or with the record they
 *   chose) offers no "The record is wrong" (that record is their own word; it would only stack a second
 *   correction) but the matching Undo.
 * - restated: a clinical record (documentTier 'primary') that is inaccurate automatically restates the subject's
 *   own report differently. It's accurate would only turn it into two records that disagree; The record is wrong
 *   and Not the same event are the answers.
 * - the user's own correction: no It's accurate and no Only in a summary (they would drop the correction quietly).
 */
export function overrideOffers(p: OverrideInput): OverrideOffers {
  const s = overrideState(p);
  const t = s.t;
  // Where the documents disagree, the choice is made on the Reconciliation page (This one is right), not here.
  const accurate = t.trust !== 'conflict' && !s.outranked && !s.restated && !s.ownCorrection;
  return {
    accurate,
    accurateWaiting: accurate && s.tierUnknown,
    summary: !s.outranked && !s.ownCorrection,
    separate: p.reconciled && t.canSeparate === true && !t.byUser && !p.separated,
    recordWrong: s.automaticWrong && s.recordIsOther && !s.userRecord,
    reset: s.outranked ? s.current !== null || p.separated : t.byUser || s.current !== null || p.separated,
    undo: s.outranked ? (s.ownCorrection ? 'later' : undoKindOf(t)) : p.reconciled && t.trust === 'inaccurate' && s.userRecord ? undoKindOf(t) : null,
  };
}

/** What a Details page key (c accurate, f only in a summary) does on the selected detail. */
export type KeyPlan = { do: 'keep' } | { do: 'verdict' } | { do: 'explain'; words: string };

/**
 * The detail is a clinical record the user chose as the right one (This one is right): its answer is stored as a
 * correction, but it is a choice between records, not a correction of one. Its document's tier says so, or (where
 * the tier is not known) the server's words "You said this record is right".
 */
function chosenRecord(p: Pick<OverrideInput, 'documentTier'> & { trust: TrustInfo }): boolean {
  return p.documentTier === 'primary' || /^You said this record is right/.test(p.trust.reason ?? '');
}

/** The Details page's words for c or f on the user's own correction, or on the clinical record they chose. */
export const OWN_ANSWER_WORDS = {
  choice: 'Not changed. This is the clinical record you chose as the right one; it is already used for this event.',
  value: 'Not changed. This is the value you chose as the right one; it is already used for this event.',
  correction: 'Not changed. This is your correction, already used for this event. To change it, put it back to automatic first (u).',
} as const;

/**
 * The Details page's c and f keys follow the Override: c on a lab value, scan, vital, procedure or event is the
 * Override's It's accurate (POST /keep, which the server refuses where the user's own word outranks the detail),
 * and where the Override does not offer the answer the key says why and which button to use instead, never a
 * silent answer the page then ignores. A detail without a trust, of another type, or replaced, as before (the
 * facts verdict).
 */
export function overrideKeyPlan(answer: 'accurate' | 'summary', p: Omit<OverrideInput, 'trust'> & { trust: TrustInfo | null | undefined }): KeyPlan {
  const t = p.trust;
  if (!t || !p.reconciled || t.trust === 'replaced') return { do: 'verdict' };
  const input = { ...p, trust: t };
  const offers = overrideOffers(input);
  if (answer === 'accurate' ? offers.accurate && !offers.accurateWaiting : offers.summary) return { do: answer === 'accurate' ? 'keep' : 'verdict' };
  const s = overrideState(input);
  const name = answer === 'accurate' ? "It's accurate" : 'Only in a summary';
  if (offers.undo) return { do: 'explain', words: `Not changed. ${UNDO_WORDS[offers.undo].why}` };
  // A record the user chose: no "put it back to automatic first" (that only reopens the disagreement, where c is
  // refused again); a correction of theirs: Back to automatic is the way to change it.
  if (s.ownCorrection) return { do: 'explain', words: chosenRecord(input) ? OWN_ANSWER_WORDS.choice : isChosenValue(t) ? OWN_ANSWER_WORDS.value : OWN_ANSWER_WORDS.correction };
  if (t.trust === 'conflict') return { do: 'explain', words: 'Not changed. Your documents disagree about this: settle it on the Reconciliation page (add the record, or This one is right).' };
  if (s.restated) return { do: 'explain', words: `Not changed. This clinical record differs from the report, and ${name} would only make two records disagree. If this one is right, use The record is wrong under Your answer${offers.separate ? '; if both happened, Not the same event' : ''}.` };
  return { do: 'explain', words: 'One moment: this detail is still being read.' };
}

/** The Details page's u key (back to automatic) on a detail whose own Back to automatic would change nothing: the Undo to use instead, or null to go ahead. */
export function resetKeyWords(p: OverrideInput): string | null {
  const offers = overrideOffers(p);
  return offers.undo && !offers.reset ? `Nothing of yours to put back on this one. ${UNDO_WORDS[offers.undo].why}` : null;
}

/** The event tabs of the page. */
export type EventTab = 'needs' | 'settled' | 'unbacked';
export const STATE_TAB: Record<ReconcileState, EventTab> = { needs_source: 'needs', settled: 'settled', unbacked: 'unbacked' };

/** The tab an event is listed on, from its state (GET /api/reconcile/events/:key). */
export function tabForState(state: ReconcileState): EventTab {
  return STATE_TAB[state] ?? 'needs';
}

/** The date an event key ends with (type|subject...|date, sometimes |n after it), for sorting. */
export function eventDate(key: string): string {
  const parts = key.split('|');
  for (let i = parts.length - 1; i >= 0; i--) if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(parts[i])) return parts[i];
  return '';
}

/** Two clinical records disagree about this event (the server says so; false until it does). */
export function recordsDisagree(event: ReconcileEvent): boolean {
  return event.recordsDisagree === true;
}

/**
 * Some of the event's mentions were not compared with a record that is here. Why differs from one to the next
 * (another unit, other words, only the month, no sample named, a scan worded differently), so the event never names
 * one cause: each mention's own line says why and what the record gives.
 */
export function hasNotCompared(event: ReconcileEvent): boolean {
  return event.groups.some((g) => g.mentions.some((m) => notComparedWithRecord(m.trust)));
}

/** Every mention of the event was not compared with a record that is here. */
function allNotCompared(event: ReconcileEvent): boolean {
  const ms = event.groups.flatMap((g) => g.mentions);
  return ms.length > 0 && ms.every((m) => notComparedWithRecord(m.trust));
}

/**
 * A clinical record for this event is already in the case: it settles the event, or a mention names the record it
 * could not be compared with (whoever answered that mention: the app's "not compared", or the user's Not sure or
 * Only in a summary on it). Uploading "the record" would only add a second copy of it.
 */
export function eventHasRecord(event: ReconcileEvent): boolean {
  return Boolean(event.record) || event.groups.some((g) => g.mentions.some((m) => namesUncomparedRecord(m.trust) || unbackedWithRecord(m.trust)));
}

/** "the lab report" / "gives" / "112 mg/dL on 2024-03-18" from the server's "...and the lab report gives it in another unit: 112 mg/dL on 2024-03-18." */
const RECORD_GIVES = /\band (the [^:,]+?) (gives?) it in (?:another unit|other words)[^:]*:\s*(.+?)\.?\s*$/i;

/** What the record that could not settle the event gives: its words and its value(s), from the server's reason or the record it names. */
function recordGives(event: ReconcileEvent): { record: string; verb: string; value: string } | null {
  const ms = event.groups.flatMap((g) => g.mentions);
  for (const t of [...ms.filter((m) => conflictWithRecord(m.trust)).map((m) => m.trust.reason ?? ''), event.reason ?? '']) {
    const g = RECORD_GIVES.exec(t.trim());
    if (g && g[3].trim()) return { record: g[1], verb: g[2].toLowerCase(), value: g[3].trim() };
  }
  for (const m of ms) {
    const t = m.trust;
    if ((conflictWithRecord(t) || unbackedWithRecord(t)) && t.recordValue?.trim()) return { record: t.recordDocumentTitle?.trim() || 'the clinical record', verb: 'gives', value: t.recordValue.trim().replace(/\.$/, '') };
  }
  return null;
}

/** The plain advice where documents disagree and a clinical record is here but could not settle them (it gives the value in another unit). */
export interface RecordHereAdvice {
  /** The event's sentence. */
  sentence: string;
  /** The line under the mentions. */
  footer: string;
  /** This one is right's tooltip. */
  rightTitle: string;
  /** It's wrong's tooltip. */
  wrongTitle: string;
}

/**
 * Documents disagree about a value while the clinical record of that day is here but could not settle them (it gives
 * the value in another unit or other words; two summaries give 6.2 and 8.0 mmol/L, the lab report 112 mg/dL): one
 * piece of advice, the same in the sentence, the line under the mentions and the buttons' tooltips. It's wrong on
 * the value that does not match the record, This one is right on the one that does. Null for any other event.
 */
export function recordHereAdvice(event: ReconcileEvent): RecordHereAdvice | null {
  if (event.state !== 'needs_source' || recordsDisagree(event) || !eventHasRecord(event)) return null;
  const g = recordGives(event);
  const it = g?.verb === 'give' ? 'them' : 'it';
  const rec = g ? g.record : 'the record';
  const gives = g ? `${g.record.charAt(0).toUpperCase()}${g.record.slice(1)} ${g.verb} ${g.value}.` : 'What the record gives is shown under each value.';
  const recAndValue = g ? `${rec} (${g.value})` : 'the record (shown under each value)';
  return {
    sentence: `Your documents disagree about this. A clinical record is here, but it could not settle this automatically. ${gives} Mark the value that does not match ${it} as wrong (It's wrong), or use This one is right on the one that does.`,
    footer: `It's wrong keeps a value on file but sets it aside; This one is right (a reason is needed) makes a value the one used for this event. Either way, ${rec} stays as it is.`,
    rightTitle: `Use this on the value that matches ${recAndValue}: it becomes the value used for this event, and the record is not changed. A reason is required.`,
    wrongTitle: `Use this on a value that does not match ${recAndValue}: it stays on file but is set aside, and the clinician will not rely on it.`,
  };
}

/**
 * Upload the record and Use a document already here (and their keys u and p): only where the event has no record
 * yet, or where two clinical records disagree (a third record may settle it). Never on a settled event, and never
 * where a record is already here and the mentions simply could not be compared with it.
 */
export function offersRecordActions(event: ReconcileEvent): boolean {
  if (event.state === 'settled') return false;
  if (event.state === 'needs_source' && recordsDisagree(event)) return true;
  return !eventHasRecord(event);
}

/** The tag beside a group of mentions that were not compared with the record (no cause: it differs per mention). */
export const NOT_COMPARED_TAG = { label: 'not compared', title: 'Not compared with the record automatically. Why, and what the record says, is shown under each.' } as const;

/**
 * The plain sentence under an event's title. "Adding the clinical record will check them" only where no record
 * is there. Mentions the app could not compare with a record that is already here are said to be not compared,
 * without naming a cause (each mention's line gives its own, with what the record says).
 */
/** The sentence of an event that needs a source when nothing more specific applies (the Needs a source tab says the same). */
export const NEEDS_SENTENCE = 'Your documents disagree about this, and no clinical record settles it yet. Add the record (the lab report, procedure note or scan report) and every mention is compared with it at once.';
/** The first sentence of a settled event (the Settled tab says the same). */
export const SETTLED_SENTENCE = 'A clinical record settles this. Mentions that match it are accurate; any that differ are listed under Inaccurate.';
/** The sentence of an event with nothing to compare with (the Not backed yet tab says the same). */
export const UNBACKED_SENTENCE = 'Nothing to compare these with yet. Adding the clinical record will check them.';

export function eventSentence(event: ReconcileEvent): string {
  if (event.state === 'needs_source' && recordsDisagree(event)) return 'Two clinical records disagree about this, so the app cannot tell which one is right.';
  const notCompared = hasNotCompared(event);
  if (event.state === 'needs_source') {
    // A record is here but could not settle it: one piece of advice (recordHereAdvice), the same as the buttons'.
    const advice = recordHereAdvice(event);
    return advice ? advice.sentence : NEEDS_SENTENCE;
  }
  const one = event.groups.reduce((n, g) => n + g.mentions.filter((m) => notComparedWithRecord(m.trust)).length, 0) === 1;
  const why = one ? 'why, and what the record says, is shown under it.' : 'why, and what the record says, is shown under each.';
  if (event.state === 'settled') {
    const base = SETTLED_SENTENCE;
    if (!notCompared) return base;
    return `${base} ${one ? 'One could not be compared with it automatically, so it is marked not compared:' : 'Some could not be compared with it automatically, so they are marked not compared:'} ${why}`;
  }
  // The user answered (Not sure, Only in a summary) values whose record is here: no promise, no upload; their
  // answer stands and what the record gives is shown under each (the server still names the record).
  const ms = event.groups.flatMap((g) => g.mentions);
  const answered = ms.filter((m) => !notComparedWithRecord(m.trust) && answeredWithRecord(m.trust)).length;
  if (answered) {
    const withRecord = ms.filter((m) => notComparedWithRecord(m.trust) || answeredWithRecord(m.trust)).length;
    const rest = ms.length - withRecord;
    const head = rest === 0 ? (ms.length === 1 ? 'this was' : 'these were') : withRecord === 1 ? 'one of these was' : 'some of these were';
    return `A clinical record is here, but ${head} not compared with it automatically. ${answered === 1 ? 'Your answer stands' : 'Your answers stand'}, and what the record gives is shown under ${withRecord === 1 ? 'it' : 'each'}.${rest ? ' The others have nothing to compare them with.' : ''}`;
  }
  if (!notCompared) return eventHasRecord(event) ? `A clinical record is here, but ${ms.length === 1 ? 'this was' : 'these were'} not compared with it automatically.` : UNBACKED_SENTENCE;
  if (allNotCompared(event)) return `A clinical record is here, but ${one ? 'this could not be compared with it automatically, so it is' : 'these could not be compared with it automatically, so they are'} marked not compared: ${why}`;
  return `A clinical record is here, but ${one ? 'one of these could not be compared with it automatically, so it is' : 'some of these could not be compared with it automatically, so they are'} marked not compared: ${why} The others have nothing to compare them with.`;
}

/**
 * The event's sentence in its pane, without what the tab's own line under the toolbar already says (one explanation
 * per tab): null for the plain cases (the tab said it), the rest for a settled event (the not compared part) and the
 * whole of anything more specific (records disagree, a record here that could not settle it, your answers).
 */
export function paneSentence(event: ReconcileEvent): string | null {
  const s = eventSentence(event);
  if (s === NEEDS_SENTENCE || s === UNBACKED_SENTENCE || s === SETTLED_SENTENCE) return null;
  if (s.startsWith(`${SETTLED_SENTENCE} `)) return s.slice(SETTLED_SENTENCE.length + 1);
  return s;
}

/**
 * A group on a settled event that gives another value than the event's record and yet is checked accurate: its
 * mentions match another clinical record of the same day (two lab reports can each give a reading of that day; they
 * are kept as two readings, never one overruling the other). The record they match, by name, so the group's heading
 * can say why its green checks are right; null for any other group.
 */
export function otherReadingRecord(event: ReconcileEvent, group: ReconcileEvent['groups'][number]): { title: string } | null {
  const record = event.record;
  if (event.state !== 'settled' || !record || !group.mentions.length) return null;
  if (group.says.trim() === record.says.trim()) return null;
  if (!group.mentions.every((m) => m.trust.trust === 'verified' || m.trust.trust === 'accurate')) return null;
  const ids = new Set(group.mentions.map((m) => m.trust.recordFactId).filter((id): id is string => Boolean(id)));
  if (!ids.size || ids.has(record.factId)) return null;
  const own = group.mentions.find((m) => m.trust.trust === 'verified' && m.documentTier === 'primary') ?? group.mentions.find((m) => m.trust.trust === 'verified');
  const title = own?.documentTitle ?? group.mentions.find((m) => m.trust.recordDocumentTitle)?.trust.recordDocumentTitle ?? 'another clinical record';
  return { title };
}

/** The tag of an event in its detail pane. */
export function eventTag(event: ReconcileEvent): { tone: 'warn' | 'ok' | 'neutral'; label: string } {
  if (event.state === 'needs_source') return { tone: 'warn', label: recordsDisagree(event) ? 'records disagree' : 'needs a source' };
  if (event.state === 'settled') return { tone: 'ok', label: 'settled' };
  // Every mention names a record that is here (not compared, or answered by the user): nothing is waiting for a record.
  const ms = event.groups.flatMap((g) => g.mentions);
  const allWithRecord = ms.length > 0 && ms.every((m) => notComparedWithRecord(m.trust) || answeredWithRecord(m.trust));
  return { tone: 'neutral', label: allNotCompared(event) || allWithRecord ? 'not compared' : 'not backed yet' };
}

/* ------------------------------------------------------------------ */
/* One inaccurate detail: which answers it offers.                     */
/* ------------------------------------------------------------------ */

/**
 * The record this detail is compared with stands on the user's own word: their correction (a secondhand detail
 * they said is right), or the clinical record they chose with This one is right. The server's
 * `trust.recordByUser` (or its words) when the item carries its trust, else the record's own check.
 */
export function recordIsCorrection(item: Pick<InaccurateItem, 'record'> & { trust?: TrustInfo }): boolean {
  const rec = item.record;
  if (!rec) return false;
  if (item.trust && item.trust.recordFactId === rec.factId && recordByUser(item.trust)) return true;
  if (!rec.trust.byUser) return false;
  return rec.trust.trust === 'accurate' || recordIsChosen(item);
}

/** The record this detail is compared with is a clinical record the user chose as the right one (This one is right). */
export function recordIsChosen(item: Pick<InaccurateItem, 'record'>): boolean {
  const rec = item.record;
  return Boolean(rec && rec.trust.byUser && rec.documentTier === 'primary' && rec.trust.trust === 'verified');
}

/**
 * "Not the same event" only where it changes something: an automatic
 * disagreement (not one the user marked), on a secondhand detail whose date
 * differs from the record's date, or on a clinical record that restates the
 * report differently where the server says it can stand on its own. On the
 * same day it would do nothing visible, so it is not offered there; nor where
 * the server says it cannot split this one off (trust.canSeparate === false).
 */
export function canSeparateItem(item: Pick<InaccurateItem, 'trust' | 'documentTier' | 'date' | 'record'>): boolean {
  const t = item.trust;
  if (t.canSeparate === false || t.byUser) return false;
  // A clinic note's value differing from the lab report's (a restatement): "Both happened" keeps it as its own
  // reading, even the same day, where the server says that changes something.
  if (item.documentTier === 'primary') return t.canSeparate === true;
  const rec = item.record;
  if (!rec?.date || !item.date) return false;
  return rec.date !== item.date;
}

export interface InaccurateActions {
  /** It's actually right (a). */
  keep: boolean;
  /** Not the same event (x). */
  separate: boolean;
  /** The record is wrong, with a reason (w). */
  wrong: boolean;
  /** Back to automatic: forget the user's own answer on this detail. */
  reset: boolean;
  /** Undo my correction: the record this detail is compared with is the user's correction. */
  undoCorrection: boolean;
}

/** The user marked this detail wrong (the server's words: "You marked this wrong."). */
function markedWrong(t: TrustInfo): boolean {
  return /^You marked this wrong/.test(t.reason ?? '');
}

/** The server's words on a detail that is itself the user's correction (or chosen record) and a later correction outranks. */
const LATER_WORDS = /^Your later correction says/;

/**
 * The detail is itself the user's correction, outranked by their later correction ("Your later correction says
 * otherwise"), inaccurate on the user's word (not marked wrong by them) against a record that is their own word:
 * a secondhand detail they corrected with, or a clinical record they chose with This one is right (its answer is
 * a correction too; the server's words say so, since the tab does not carry the detail's answer).
 */
export function isOutrankedCorrection(item: Pick<InaccurateItem, 'trust' | 'documentTier' | 'record'>): boolean {
  const t = item.trust;
  if (t.trust !== 'inaccurate' || !t.byUser || markedWrong(t) || !recordIsCorrection(item)) return false;
  return item.documentTier !== 'primary' || LATER_WORDS.test(t.reason ?? '');
}

/**
 * The answers one inaccurate detail offers; the page's keys use the same
 * rules, so a key never does what no button shows.
 *
 * - A clinical record outranked by the user's own correction: only "Undo my
 *   correction" puts it back (the server refuses "It's actually right" there,
 *   and Back to automatic on the record would change nothing).
 * - An older correction outranked by the user's later correction: "Undo my
 *   later correction", or Back to automatic (it forgets this correction); not
 *   It's actually right (the server refuses it there).
 * - A clinical record the user marked wrong: It's actually right, or Back to
 *   automatic.
 * - A secondhand detail the user marked wrong: the same two.
 * - The record is wrong: only against a real clinical record, on a detail
 *   with a full date, when the user has not answered it already.
 * - A clinical record that restates the report differently (a clinic note
 *   against the lab report): The record is wrong (this one is right) or Not
 *   the same event (both are real); not It's actually right, which would only
 *   turn it into two records that disagree and ask again.
 */
export function inaccurateActions(item: Pick<InaccurateItem, 'trust' | 'documentTier' | 'date' | 'datePrecision' | 'record'>): InaccurateActions {
  const t = item.trust;
  const rec = item.record;
  const correction = recordIsCorrection(item);
  const primary = item.documentTier === 'primary';
  // Outranked by the user's own word: a clinical record their correction (or choice) says is wrong, or an older
  // correction of theirs that a later one outranks. Not a detail they marked wrong themselves.
  const later = isOutrankedCorrection(item);
  const outranked = t.byUser && correction && !markedWrong(t) && (primary || later);
  const restated = primary && !t.byUser;
  return {
    keep: !outranked && !restated,
    separate: canSeparateItem(item),
    wrong: Boolean(rec && rec.documentTier === 'primary' && !correction) && !t.byUser && item.datePrecision === 'day',
    // An older correction (or a record the user chose, a later correction outranks) carries an answer of its own to
    // forget, as the Override offers; a record outranked by the user's word does not.
    reset: t.byUser && (!outranked || later),
    undoCorrection: correction,
  };
}

/**
 * Back to automatic on the Inaccurate tab, on a detail a later correction outranks: the words for what it takes back
 * (this correction, or the user's choice of this clinical record). Null where it is the plain Back to automatic.
 */
export function laterResetWords(item: Pick<InaccurateItem, 'trust' | 'documentTier' | 'record'>): { done: string; title: string } | null {
  if (!isOutrankedCorrection(item)) return null;
  return item.documentTier === 'primary'
    ? { done: 'Your choice of this record is taken back; it is compared with the records again.', title: 'Take back your choice of this record: it is compared with the records (and your later correction) again.' }
    : { done: 'Your correction here is taken back; it is compared with the records again.', title: 'Take back this correction: it is compared with the records (and your later correction) again.' };
}

/** Which Undo the Inaccurate tab offers (with inaccurateActions().undoCorrection): the user's choice, correction, or later correction. */
export function inaccurateUndo(item: Pick<InaccurateItem, 'trust' | 'documentTier' | 'record'>): UndoKind | null {
  if (!recordIsCorrection(item)) return null;
  if (isOutrankedCorrection(item)) return 'later';
  if (recordIsChosen(item)) return 'choice';
  const rec = item.record;
  // The record is a value the user chose (This one is right while the record of that day gives it in another unit).
  if (isChosenValue(rec?.trust)) return 'value';
  // The record is the user's correction (a secondhand detail they said is right), or the server's word says which.
  if (rec && rec.trust.byUser && rec.trust.trust === 'accurate') return 'correction';
  return undoKindOf(item.trust);
}

/**
 * The Inaccurate tab's words for what this detail is compared with, and its why: a value the user chose reads
 * "<its document> says (your choice)", and the server's "Your correction says ..." about it reads "The value you
 * chose says ..." (their choice between values, never a correction of the record, which stays as it is).
 */
export function inaccurateRecordWords(item: Pick<InaccurateItem, 'trust' | 'documentTier' | 'record'>): { label: string | null; why: string | null } {
  const rec = item.record;
  const why = item.trust.reason ?? null;
  if (!rec) return { label: null, why };
  if (isOutrankedCorrection(item)) return { label: 'Your later correction says', why };
  if (isChosenValue(rec.trust)) return { label: `${rec.documentTitle ?? 'The value you chose'} says (your choice)`, why: why ? why.replace(/^Your correction says\b/, 'The value you chose says') : why };
  const chosen = recordIsChosen(item);
  if (recordIsCorrection(item) && !chosen) return { label: 'Your correction says', why };
  return { label: `${rec.documentTitle ?? 'The record'} says${chosen ? ' (your choice)' : ''}`, why };
}

/* ------------------------------------------------------------------ */
/* Two clinical records disagree.                                      */
/* ------------------------------------------------------------------ */

/** Every mention in the event that comes from a clinical record (source tier primary). */
export function recordMentions(event: ReconcileEvent): Mention[] {
  const out: Mention[] = [];
  if (event.record && event.record.documentTier === 'primary') out.push(event.record);
  for (const g of event.groups) for (const m of g.mentions) if (m.documentTier === 'primary' && !out.some((x) => x.factId === m.factId)) out.push(m);
  return out;
}

/**
 * "Both happened" marks one record as another occasion (POST /separate). It
 * is offered only where that splits the event. When the server says so per
 * record (trust.canSeparate, which also allows two readings the same day),
 * its word is used; until then, only a record on another day than a second
 * record qualifies. The latest such record is the one marked; null when none
 * qualifies.
 */
export function bothHappenedTarget(event: ReconcileEvent): Mention | null {
  const recs = recordMentions(event).filter((m) => m.date);
  const told = recs.some((m) => typeof m.trust.canSeparate === 'boolean');
  const candidates = told
    ? recs.filter((m) => m.trust.canSeparate === true)
    : recs.filter((m) => !m.trust.byUser && recs.some((o) => o.factId !== m.factId && o.date !== m.date));
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.factId.localeCompare(a.factId))[0];
}

/* ------------------------------------------------------------------ */
/* Use a document already here as the official record.                 */
/* ------------------------------------------------------------------ */

/** The document fields the chooser needs (GET /api/documents returns them all). */
export interface DocChoice {
  id: string;
  title: string;
  sourceTier?: string | null;
  category?: string | null;
  documentDate?: string | null;
  documentDatePrecision?: string | null;
}

/** Document types that are usually an official record (a lab report, a clinic note, a scan report...). */
export const RECORD_CATEGORIES: ReadonlySet<string> = new Set(['lab_report', 'imaging_report', 'operative_report', 'pathology', 'discharge_summary', 'clinical_note']);

/** A partial date as one day, for distances: a month counts as its 15th, a year as 1 July. */
function midDay(iso: string): string {
  if (/^\d{4}$/.test(iso)) return `${iso}-07-01`;
  if (/^\d{4}-\d{2}$/.test(iso)) return `${iso}-15`;
  return iso.slice(0, 10);
}

function dayDistance(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const da = Date.parse(`${midDay(a)}T00:00:00Z`);
  const db = Date.parse(`${midDay(b)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.POSITIVE_INFINITY;
  return Math.abs(da - db) / 86_400_000;
}

/**
 * The documents offered as the official record for an event, in three lists:
 *   likely     record-type documents (lab report, procedure note, clinic note,
 *              scan report...): first those that mention the event (a procedure
 *              note not yet marked as a record is the likeliest of all), then
 *              the rest, closest to the event's date first;
 *   other      every other document not mentioned in the event, the same order;
 *   mentioned  the event's own secondhand documents (calls, summaries,
 *              letters), last: they are what disagree, so they are rarely the
 *              record.
 * Clinical records already marked (source tier primary) are left out. The
 * search matches the title and the type.
 */
export function recordChoices<T extends DocChoice>(docs: readonly T[], event: ReconcileEvent, q: string, limit = 300): { likely: T[]; other: T[]; mentioned: T[] } {
  const needle = q.trim().toLowerCase();
  const inEvent = new Set<string>();
  for (const g of event.groups) for (const m of g.mentions) if (m.documentId) inEvent.add(m.documentId);
  if (event.record?.documentId) inEvent.add(event.record.documentId);
  const when = eventDate(event.key);
  const pool = docs.filter((d) => d.sourceTier !== 'primary' && (!needle || `${d.title}\n${(d.category ?? '').replace(/_/g, ' ')}`.toLowerCase().includes(needle)));
  const order = (a: T, b: T) => dayDistance(a.documentDate, when) - dayDistance(b.documentDate, when) || a.title.localeCompare(b.title);
  const isRecordType = (d: T) => RECORD_CATEGORIES.has(d.category ?? '');
  const likely = pool.filter(isRecordType).sort((a, b) => Number(inEvent.has(b.id)) - Number(inEvent.has(a.id)) || order(a, b));
  const other = pool.filter((d) => !inEvent.has(d.id) && !isRecordType(d)).sort(order);
  const mentioned = pool.filter((d) => inEvent.has(d.id) && !isRecordType(d)).sort(order);
  return { likely: likely.slice(0, limit), other: other.slice(0, limit), mentioned };
}

/** The sentence shown before a document is made the official record. */
export function officialWarning(title: string): string {
  return `Every detail in ${title} will be treated as a clinical record (the truth). Use this only for an official record such as a lab report, a clinic note or a scan report.`;
}

/* ------------------------------------------------------------------ */
/* A record just uploaded for an event.                                */
/* ------------------------------------------------------------------ */

export type UploadOutcome = 'reading' | 'failed' | 'checking' | 'settled' | 'disagree' | 'unsettled';

/**
 * What a record uploaded for an event did, once it is read: the event
 * re-read by its key, or (when the key moved, since a settled event takes the
 * record's date) the trust of one of its mentions.
 *   settled    the event is settled, or the mention now compares with this record
 *   disagree   the event still needs a source because two clinical records disagree
 *   unsettled  the event still needs a source (or the mention is still in dispute,
 *              or compares with another record or nothing): say so plainly, never "checked"
 *   checking   read, the answer is still loading
 */
export function uploadOutcome(p: {
  ready: boolean;
  failed: boolean;
  documentId: string;
  /** The event re-read by its key: undefined while loading, null when the key is not listed any more. */
  event: ReconcileEvent | null | undefined;
  /** The trust of one of the event's mentions, read when the key is not listed any more: undefined while loading. */
  mentionTrust?: TrustInfo | null;
}): UploadOutcome {
  if (p.failed) return 'failed';
  if (!p.ready) return 'reading';
  if (p.event === undefined) return 'checking';
  if (p.event) {
    if (p.event.state === 'settled') return 'settled';
    return p.event.state === 'needs_source' && recordsDisagree(p.event) ? 'disagree' : 'unsettled';
  }
  const t = p.mentionTrust;
  if (t === undefined) return 'checking';
  if (t && (t.trust === 'accurate' || t.trust === 'inaccurate') && !t.byUser && t.recordDocumentId === p.documentId) return 'settled';
  return 'unsettled';
}

/** The words for an upload outcome (the document's title is the link beside it). */
export const UPLOAD_WORDS: Record<Exclude<UploadOutcome, 'reading'>, string> = {
  failed: 'It could not be read. Open it to see why, or try another file.',
  checking: 'Read. Looking at what it did to this event…',
  settled: 'Read. It settles this event: mentions that match it are accurate, and any that differ are listed under Inaccurate.',
  disagree: 'The record is read, and it disagrees with another clinical record. Open the event to choose which one is right.',
  unsettled: 'The record is read, but it did not settle this. It may name the test differently or give another date. Open it to check, or use This one is right.',
};
