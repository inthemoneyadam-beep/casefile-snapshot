/**
 * Automatic filing. After a document is classified, and again after its facts
 * are extracted, Claude files it where it belongs: the document's own type,
 * a held row in the records inventory, a draft communication for a call or
 * portal message, an encounter for a primary visit note, and medications or
 * intolerances from its facts (only from clinical records and the patient's
 * own notes). Every placement is recorded in `filings` as settled at once
 * (status `confirmed`, decided by `automatic`): nothing waits for a check.
 * Undo takes one back (a soft delete or an unlink, status `rejected`, never
 * made again) until the user works on the item; the document itself is never
 * touched. An item the user deleted on its own page or took off with Undo is
 * never made again, from any document (a medication or allergy by its name, a
 * records row by the row).
 *
 * Lab and imaging values are not copied anywhere: their sections read the
 * extracted facts directly, and how far each can be trusted comes from the
 * reconciliation pass (services/reconcile.ts), not from a check here.
 *
 * The consult may propose moving a document to another type; a proposal is a
 * filing with status `proposed` that changes nothing until the user approves.
 *
 * Documents still waiting in the Inbox are left to the Inbox's own filing.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { quarantinedCount } from './patient-check-state';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { badRequest, conflict, notFound } from '../util/errors';
import { parsePartialDate } from '../../shared/dates';
import { DOCUMENT_CATEGORIES } from '../../shared/enums';
import type { SettingKey } from '../../shared/constants';
import { readInbox, readTriage, linkEncounter, existingCommunicationFor, MODEL_SUMMARY_PREFIX } from './inbox';
import { createCommunication, deleteCommunication, refreshMessageTiers } from './communications';
import { createEncounter, deleteEncounter } from './encounters';
import { createFromDocument, deleteRecord, receiveRecord, updateRecord } from './records';
import {
  CURRENT_STATUSES,
  acceptFromFacts,
  deleteMedication,
  deleteIntolerance,
  deleteEvent,
  factItemKey,
  factItemName,
  isListHeadingName,
  notMedicationReason,
  proposeFromFacts,
  restoreIntolerance,
  sameMedicationName,
  statedStartFills,
  type MedicationProposal,
} from './medications';
import { setVerdict } from './facts';
import { isReconciledType, reconcileCounts, reconcileQuietly } from './reconcile';
import { updateDocument, onSourceTierChange, CLASSIFY_PENDING_PRIORITY } from './documents';
import { getSetting, setSetting } from './settings';
import { enqueueJob } from '../jobs/queue';
import { classificationAvailable } from '../ingest/triage';
import { INBOX_ACTIVE_STATUSES } from '../../shared/schemas/inbox';
import { factTier } from '../../shared/trust';
import { bodyHashOf, normalizeForHash, parseCommunicationDetails, parseContainedIn, parseExportInfo, type CommunicationDetails } from '../../shared/schemas/segments';
import { liveDocumentRow } from './document-rows';

export const FILING_TARGETS = ['document', 'communication', 'encounter', 'record', 'medication', 'intolerance'] as const;
export type FilingTarget = (typeof FILING_TARGETS)[number];
/** Sections whose "pending" is the fact status, not a filing row. */
export const FACT_SECTIONS = { labs: 'lab_result', imaging: 'imaging_result' } as const;

/** Topic on communications filed automatically, so their origin is visible and filterable. */
export const AUTO_FILED_TOPIC = 'filed automatically';

/** decidedBy on a placement settled by automatic filing itself (Undo stays available on these). */
export const AUTOMATIC = 'automatic';

/** decidedBy on the medications and allergies the one-time cleanup took back (they came only from summaries). */
export const SUMMARY_MEDICATIONS_TAKEN_BACK = 'summaries no longer add medications';

/** decidedBy on a placement whose target the user deleted on its own page: the deletion is the user's answer. */
export const REMOVED_ELSEWHERE = 'removed elsewhere';

/** Source tiers whose medications and allergies are added to the lists automatically: clinical records and the patient's own notes. */
export const MEDICATION_TIERS: readonly string[] = ['primary', 'patient'];

/**
 * Whether a detail files a medication or allergy automatically, by its passage's tier inside its document's tier: a
 * clinical record's own passages and the patient's own notes do. The patient's words quoted inside a clinical record
 * (his portal message asking for a drug, a question he wrote) do not: a request or a mention is not the record of a
 * medication, and the record's own orders and lists say what was given (2026-10-07 review, rev-comms #3; findings C.5).
 * "Add from documents" still offers them.
 */
export function filesMedicationsAt(documentTier: string | null | undefined, passageTier: string | null | undefined): boolean {
  const t = passageTier ?? documentTier ?? 'unknown';
  if (!MEDICATION_TIERS.includes(t)) return false;
  return !(t === 'patient' && documentTier !== 'patient');
}

/** Extraction statuses whose details are filed: a finished reading, or one that stopped part-way (2026-10-07: partial). */
export const READ_STATUSES: ReadonlySet<string> = new Set(['done', 'partial']);

// A document sorted after its messages were read: their trust tier follows the document's new tier (2026-10-07).
onSourceTierChange((documentId) => {
  try {
    refreshMessageTiers(documentId);
  } catch (err) {
    console.warn(`[filing] message tiers of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// A document marked official (or the patient's own notes) after it was read: its medications are filed now, as they
// would have been had it been sorted that way first (automatic filing on; idempotent; never throws).
onSourceTierChange((documentId, tier) => {
  if (!MEDICATION_TIERS.includes(tier)) return;
  const doc = db().select({ extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (doc && READ_STATUSES.has(doc.extractionStatus)) autoFileAfterExtraction(documentId);
});

type FilingRow = typeof schema.filings.$inferSelect;
type DocumentRow = typeof schema.documents.$inferSelect;

export interface Filing extends Omit<FilingRow, 'detailJson'> {
  detail: Record<string, unknown>;
  documentTitle: string | null;
  /** What it created or linked to (or the history line it added) was deleted since (on its own page, or by Undo on another document): nothing is left to undo. */
  targetGone: boolean;
  /** The user has worked on what it created since (see workedOnSet): it is theirs now, changed or deleted on its own page. */
  workedOn: boolean;
  /** Undo applies: a placement still standing on Claude's word (pending, or settled automatically), not the document's type or its held row, whose item is still there and untouched by the user. */
  undoable: boolean;
}

/** A placement that still stands on Claude's word: pending (from before quiet checks) or settled automatically. */
function onClaudesWord(r: Pick<FilingRow, 'status' | 'decidedBy'>): boolean {
  return r.status === 'pending' || (r.status === 'confirmed' && r.decidedBy === AUTOMATIC);
}

/** The document's type and the row saying the document is held are plain facts: changed on the document, never undone. */
function plainFact(r: Pick<FilingRow, 'targetType' | 'action'>): boolean {
  return (r.targetType === 'document' && r.action === 'classified') || (r.targetType === 'record' && r.action === 'created');
}

/** A placement that points at a row of another section (what it created or linked to), which can be deleted there. */
function pointsAtTarget(r: Pick<FilingRow, 'targetType' | 'action'>): boolean {
  return (r.action === 'created' || r.action === 'linked') && r.targetType !== 'document';
}

const CATEGORY_WORDS: Record<string, string> = {
  clinical_note: 'visit or clinic note',
  lab_report: 'lab report',
  imaging_report: 'scan or imaging report',
  portal_message: 'portal message',
  call_transcript: 'phone call record',
  summary: 'summary',
  dossier: 'case dossier',
  letter: 'letter',
  discharge_summary: 'hospital discharge summary',
  operative_report: 'procedure or surgery report',
  pathology: 'pathology report',
  other: 'other document',
};
const TIER_WORDS: Record<string, string> = { primary: 'from a clinical record', patient: 'your own notes', compilation: 'a summary of other records', external: 'an outside letter', unknown: 'source not decided' };

/** The history line a placement added to a medication ('linked' with `detail.eventId`), or null. */
function lineOf(r: Pick<FilingRow, 'targetType' | 'action' | 'detailJson'>): string | null {
  if (r.targetType !== 'medication' || r.action !== 'linked') return null;
  const eventId = parseJson<{ eventId?: unknown }>(r.detailJson, {}).eventId;
  return typeof eventId === 'string' ? eventId : null;
}

function toFiling(r: FilingRow, titles: Map<string, string>, gone: Set<string>, worked: Set<string>): Filing {
  const { detailJson, ...rest } = r;
  const line = lineOf(r);
  const targetGone = pointsAtTarget(r) && (gone.has(`${r.targetType}:${r.targetId}`) || (line !== null && gone.has(`event:${line}`)));
  const workedOn = worked.has(r.id);
  return {
    ...rest,
    detail: parseJson<Record<string, unknown>>(detailJson, {}),
    documentTitle: r.documentId ? (titles.get(r.documentId) ?? null) : null,
    targetGone,
    workedOn,
    undoable: onClaudesWord(r) && !plainFact(r) && !targetGone && !workedOn,
  };
}

/**
 * Targets of these placements (created or linked ones) that were deleted since, as "type:id", and the history lines
 * placements added that were deleted since (on the Medications page), as "event:id": such a placement has nothing left
 * to undo, so neither Undo nor setting a copy aside takes it back as if it had deleted the line. One query per kind of
 * target, plus one for the lines.
 */
function goneTargets(rows: FilingRow[]): Set<string> {
  const out = new Set<string>();
  const byType = new Map<string, string[]>();
  for (const r of rows) if (pointsAtTarget(r)) (byType.get(r.targetType) ?? byType.set(r.targetType, []).get(r.targetType)!).push(r.targetId);
  for (const [type, ids] of byType) {
    const t = targetTable(type);
    if (!t) continue;
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400);
      const live = new Set(db().select({ id: t.id }).from(t).where(and(inArray(t.id, chunk), isNull(t.deletedAt))).all().map((x) => x.id));
      for (const id of chunk) if (!live.has(id)) out.add(`${type}:${id}`);
    }
  }
  const lines = [...new Set(rows.map(lineOf).filter((x): x is string => x !== null))];
  const e = schema.medicationEvents;
  for (let i = 0; i < lines.length; i += 400) {
    const chunk = lines.slice(i, i + 400);
    const live = new Set(db().select({ id: e.id }).from(e).where(and(inArray(e.id, chunk), isNull(e.deletedAt))).all().map((x) => x.id));
    for (const id of chunk) if (!live.has(id)) out.add(`event:${id}`);
  }
  return out;
}

/**
 * Ids of the 'created' placements among these whose item the user has worked on since Claude made it: the row changed
 * after the placement was made (an edit, a note, another document attached to an appointment), an allergy marked never
 * give, or a medication with a history line of the user's (written by hand, or a detail the user attached with "Add
 * from documents": a live line no filing placed and not from the detail that created it; or any line the user deleted
 * by hand, see medicationsWithUsersLines). Undo is not offered on
 * these, since one click would delete that work; the item is changed or deleted on its own page. One query per kind of
 * target (two for medications).
 *
 * An allergy the V1b repair put back carries the time it did so (`detail.restoredAt`, the same instant it wrote as the
 * row's update time): only a change after that is the user's. The repair's own change is not work, so Undo stays.
 */
function workedOnSince(r: FilingRow): string {
  if (r.targetType !== 'intolerance') return r.createdAt;
  const restoredAt = parseJson<{ restoredAt?: unknown }>(r.detailJson, {}).restoredAt;
  return typeof restoredAt === 'string' && restoredAt > r.createdAt ? restoredAt : r.createdAt;
}

function workedOnSet(rows: FilingRow[]): Set<string> {
  const out = new Set<string>();
  const byType = new Map<string, FilingRow[]>();
  for (const r of rows) if (r.action === 'created' && r.targetType !== 'document' && !plainFact(r)) (byType.get(r.targetType) ?? byType.set(r.targetType, []).get(r.targetType)!).push(r);
  for (const [type, list] of byType) {
    const ids = [...new Set(list.map((r) => r.targetId))];
    const updated = new Map<string, string>();
    const always = new Set<string>();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      if (type === 'intolerance') {
        const t = schema.intolerances;
        for (const x of db().select({ id: t.id, updatedAt: t.updatedAt, hardStop: t.hardStop, kind: t.kind }).from(t).where(inArray(t.id, chunk)).all()) {
          updated.set(x.id, x.updatedAt);
          // A never-give entry is never taken off the list with one click.
          if (x.hardStop || x.kind === 'hard_stop') always.add(x.id);
        }
      } else if (type === 'communication' || type === 'encounter' || type === 'medication') {
        const t = type === 'communication' ? schema.communications : type === 'encounter' ? schema.encounters : schema.medications;
        for (const x of db().select({ id: t.id, updatedAt: t.updatedAt }).from(t).where(inArray(t.id, chunk)).all()) updated.set(x.id, x.updatedAt);
      }
      if (type === 'medication') for (const id of medicationsWithUsersLines(chunk, list)) always.add(id);
    }
    for (const r of list) {
      const at = updated.get(r.targetId);
      if (always.has(r.targetId) || (at !== undefined && at > workedOnSince(r))) out.add(r.id);
    }
  }
  return out;
}

/**
 * Medications among these with a history line of the user's: a live one written by hand or from a detail attached by
 * hand, or any line the user deleted by hand on the Medications page (deleting a line is work on the medication; a
 * line an Undo, the cleanup or setting a copy aside took back, deleted by that placement's own decision, is not).
 */
function medicationsWithUsersLines(medicationIds: string[], created: FilingRow[]): Set<string> {
  const out = new Set<string>();
  if (!medicationIds.length) return out;
  const e = schema.medicationEvents;
  const events = db()
    .select({ id: e.id, medicationId: e.medicationId, sourceFactId: e.sourceFactId, deletedAt: e.deletedAt, medFactId: schema.medications.sourceFactId })
    .from(e)
    .innerJoin(schema.medications, eq(schema.medications.id, e.medicationId))
    .where(inArray(e.medicationId, medicationIds))
    .all();
  if (!events.length) return out;
  // Lines automatic filing placed (each 'linked' placement names its event), and when a placement that took its line
  // back (Undo, a copy set aside) was decided.
  const placed = new Set<string>();
  const takenBackAt = new Map<string, Array<string | null>>();
  for (const f of db()
    .select({ detailJson: schema.filings.detailJson, status: schema.filings.status, decidedBy: schema.filings.decidedBy, decidedAt: schema.filings.decidedAt })
    .from(schema.filings)
    .where(and(eq(schema.filings.targetType, 'medication'), eq(schema.filings.action, 'linked'), inArray(schema.filings.targetId, medicationIds)))
    .all()) {
    const eventId = parseJson<{ eventId?: unknown }>(f.detailJson, {}).eventId;
    if (typeof eventId !== 'string') continue;
    placed.add(eventId);
    if ((f.status === 'rejected' || f.status === 'undone') && f.decidedBy !== REMOVED_ELSEWHERE) (takenBackAt.get(eventId) ?? takenBackAt.set(eventId, []).get(eventId)!).push(f.decidedAt);
  }
  // The detail each medication was made from: its own start and stop lines carry it.
  const creating = new Map<string, Set<string>>();
  for (const r of created) {
    const factId = parseJson<{ factId?: unknown }>(r.detailJson, {}).factId;
    if (typeof factId === 'string') (creating.get(r.targetId) ?? creating.set(r.targetId, new Set()).get(r.targetId)!).add(factId);
  }
  for (const ev of events) {
    if (ev.deletedAt) {
      // Deleted by hand unless a placement's own decision deleted it.
      if (!(takenBackAt.get(ev.id) ?? []).some((at) => deletedAtDecision(ev.deletedAt, at))) out.add(ev.medicationId);
      continue;
    }
    if (!ev.sourceFactId) {
      out.add(ev.medicationId);
      continue;
    }
    if (placed.has(ev.id) || ev.sourceFactId === ev.medFactId || creating.get(ev.medicationId)?.has(ev.sourceFactId)) continue;
    out.add(ev.medicationId);
  }
  return out;
}

function documentTitles(ids: Array<string | null>): Map<string, string> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return new Map();
  return new Map(db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.id, want)).all().map((d) => [d.id, d.title]));
}

/**
 * One filing per (document, target, action), and per fact for medication
 * history lines. A placement the user judged is never proposed again; one an
 * approved move undid may be made again. Every placement is settled at once
 * (decided by `automatic`): nothing waits for a check, and Undo takes it back.
 */
function recordFiling(input: { documentId: string | null; targetType: FilingTarget; targetId: string; action: 'classified' | 'created' | 'linked'; summary: string; detail?: Record<string, unknown> }): FilingRow | null {
  const d = db();
  const factId = typeof input.detail?.factId === 'string' ? input.detail.factId : null;
  const existing = d
    .select()
    .from(schema.filings)
    .where(
      and(
        eq(schema.filings.targetType, input.targetType),
        eq(schema.filings.targetId, input.targetId),
        eq(schema.filings.action, input.action),
        input.documentId ? eq(schema.filings.documentId, input.documentId) : isNull(schema.filings.documentId),
        sql`${schema.filings.status} <> 'undone'`,
        factId ? sql`json_extract(${schema.filings.detailJson}, '$.factId') = ${factId}` : undefined,
      ),
    )
    .get();
  if (existing) return null;
  const now = nowIso();
  const row: FilingRow = {
    id: newId(),
    documentId: input.documentId,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    // Settled at once: recorded for the history and for Undo, never waiting for a check.
    status: 'confirmed',
    source: 'auto',
    summary: input.summary.slice(0, 500),
    detailJson: JSON.stringify(input.detail ?? {}),
    askMessageId: null,
    createdAt: now,
    decidedAt: now,
    decidedBy: AUTOMATIC,
  };
  d.insert(schema.filings).values(row).run();
  return row;
}

/**
 * Whether this document already had a placement of this kind that is still
 * standing or that the user judged. A placement the user rejected is never
 * made again; one undone by an approved move does not count.
 */
function alreadyPlaced(documentId: string, targetType: FilingTarget, action: 'created' | 'linked'): boolean {
  return Boolean(
    db()
      .select({ id: schema.filings.id })
      .from(schema.filings)
      .where(and(eq(schema.filings.documentId, documentId), eq(schema.filings.targetType, targetType), eq(schema.filings.action, action), inArray(schema.filings.status, ['pending', 'confirmed', 'rejected'])))
      .get(),
  );
}

/** A records row this document already marked received (any decision except undone). */
function placedForRow(documentId: string, rowId: string): boolean {
  return Boolean(
    db()
      .select({ id: schema.filings.id })
      .from(schema.filings)
      .where(and(eq(schema.filings.documentId, documentId), eq(schema.filings.targetType, 'record'), eq(schema.filings.targetId, rowId), eq(schema.filings.action, 'linked'), sql`${schema.filings.status} <> 'undone'`))
      .get(),
  );
}

/**
 * A records row the user turned down being received with a document (Undo on a placement from any document, status
 * `rejected`): no document marks it received automatically again (a copy of that document would only repeat the
 * mistake). The user can still mark it received on the Records checklist.
 */
function rowTurnedDown(rowId: string): boolean {
  return Boolean(
    db()
      .select({ id: schema.filings.id })
      .from(schema.filings)
      .where(and(eq(schema.filings.targetType, 'record'), eq(schema.filings.targetId, rowId), eq(schema.filings.action, 'linked'), eq(schema.filings.status, 'rejected')))
      .get(),
  );
}

/**
 * The names (normalizeKey of the name and generic name) of medications, and the substances of allergies, the user
 * removed: deleted on their own page, or taken off with Undo, whichever document (or none) made them. A row deleted by
 * the decision of an `undone` placement on it (the one-time cleanup, an approved move, a copy set aside) was not the
 * user's removal and does not count. Automatic filing never makes such an item again while no live one has the name;
 * the Medications page's "Add from documents" still offers its details.
 */
function removedByUser(): { medications: string[]; intolerances: Set<string> } {
  const takenBack = new Map<string, Array<string | null>>();
  for (const f of db()
    .select({ targetId: schema.filings.targetId, decidedAt: schema.filings.decidedAt })
    .from(schema.filings)
    .where(and(inArray(schema.filings.targetType, ['medication', 'intolerance']), eq(schema.filings.action, 'created'), eq(schema.filings.status, 'undone'), sql`coalesce(${schema.filings.decidedBy}, '') <> ${REMOVED_ELSEWHERE}`))
    .all())
    (takenBack.get(f.targetId) ?? takenBack.set(f.targetId, []).get(f.targetId)!).push(f.decidedAt);
  const byUser = (r: { id: string; deletedAt: string | null }) => !(takenBack.get(r.id) ?? []).some((at) => deletedAtDecision(r.deletedAt, at));
  // Names (and generic names) of the medications the user removed; a new detail is matched to them by sameMedicationName.
  const medications: string[] = [];
  for (const m of db().select({ id: schema.medications.id, name: schema.medications.name, genericName: schema.medications.genericName, deletedAt: schema.medications.deletedAt }).from(schema.medications).where(isNotNull(schema.medications.deletedAt)).all()) {
    if (!byUser(m)) continue;
    for (const n of [m.name, m.genericName]) if (n && normalizeKey(n)) medications.push(n);
  }
  const intolerances = new Set<string>();
  for (const i of db().select({ id: schema.intolerances.id, substance: schema.intolerances.substance, deletedAt: schema.intolerances.deletedAt }).from(schema.intolerances).where(isNotNull(schema.intolerances.deletedAt)).all()) {
    const k = normalizeKey(i.substance);
    if (k && byUser(i)) intolerances.add(k);
  }
  return { medications, intolerances };
}

function encounterHasDocument(encounterId: string, documentId: string): boolean {
  const e = db().select({ documentIdsJson: schema.encounters.documentIdsJson }).from(schema.encounters).where(and(eq(schema.encounters.id, encounterId), isNull(schema.encounters.deletedAt))).get();
  return Boolean(e && parseJson<string[]>(e.documentIdsJson, []).includes(documentId));
}

function autoFilingOn(): boolean {
  try {
    return getSetting('filing.auto') !== false;
  } catch {
    return true;
  }
}

function inInbox(doc: DocumentRow): boolean {
  const inbox = readInbox(doc);
  return Boolean(inbox && INBOX_ACTIVE_STATUSES.includes(inbox.status));
}

/** Filed or skipped by the user in Check before filing (the inbox): the user already decided where it goes. */
function handledInInbox(doc: DocumentRow): boolean {
  const inbox = readInbox(doc);
  return Boolean(inbox && !INBOX_ACTIVE_STATUSES.includes(inbox.status));
}

/**
 * Facts of this document a medication placement was already made for (any decision except undone), and facts with a
 * medication, allergy or history line that was deleted other than by one of that fact's own undone placements: the
 * user deleted it (one added by hand with "Add from documents", or added again by hand after the cleanup took the
 * first back), and deleting it is the user's answer, so filing never makes it again (for example when the document is
 * later marked a clinical record). A fact whose deleted items were all taken back by its undone placements (the
 * one-time cleanup, or an approved move) may be filed again. A history line placement marked undone "removed
 * elsewhere" (its medication was taken back by the cleanup) deleted no line: a line deleted on its own under it was
 * deleted by the user, so it blocks.
 */
function factsAlreadyPlaced(documentId: string): Set<string> {
  const rows = db()
    .select({ detailJson: schema.filings.detailJson, status: schema.filings.status, decidedBy: schema.filings.decidedBy, decidedAt: schema.filings.decidedAt, targetType: schema.filings.targetType, targetId: schema.filings.targetId })
    .from(schema.filings)
    .where(and(eq(schema.filings.documentId, documentId), inArray(schema.filings.targetType, ['medication', 'intolerance'])))
    .all();
  const out = new Set<string>();
  // What each fact's undone placements took back: the item it made ("medication:id", "intolerance:id") and, for a
  // history line, its line ("event:id").
  const undoneTargets = new Map<string, Set<string>>();
  // When each undone line placement was decided: it took its line back only if the line went at that moment.
  const lineDecidedAt = new Map<string, string | null>();
  for (const r of rows) {
    const detail = parseJson<{ factId?: unknown; eventId?: unknown }>(r.detailJson, {});
    if (typeof detail.factId !== 'string') continue;
    if (r.status !== 'undone') {
      out.add(detail.factId);
      continue;
    }
    const s = undoneTargets.get(detail.factId) ?? undoneTargets.set(detail.factId, new Set()).get(detail.factId)!;
    s.add(`${r.targetType}:${r.targetId}`);
    // Undone "removed elsewhere": the cleanup took the medication back through another placement; this one deleted
    // nothing, so it never accounts for its line being deleted (only for the line going with the medication).
    if (typeof detail.eventId === 'string' && r.decidedBy !== REMOVED_ELSEWHERE) {
      s.add(`event:${detail.eventId}`);
      lineDecidedAt.set(detail.eventId, r.decidedAt);
    }
  }
  // Deleted items made from this document's details: medications, allergies, and history lines that were deleted
  // themselves or sit on a deleted medication. One pass over each table (joined to facts by key).
  const deleted = db().all<{ factId: string; kind: 'medication' | 'intolerance' | 'event'; id: string; medicationId: string | null; lineDeleted: number; lineDeletedAt: string | null }>(sql`
    select m.source_fact_id as factId, 'medication' as kind, m.id as id, null as medicationId, 0 as lineDeleted, null as lineDeletedAt
      from medications m join facts f on f.id = m.source_fact_id
      where f.source_document_id = ${documentId} and f.type in ('medication', 'allergy_intolerance') and m.deleted_at is not null
    union all
    select i.source_fact_id, 'intolerance', i.id, null, 0, null
      from intolerances i join facts f on f.id = i.source_fact_id
      where f.source_document_id = ${documentId} and f.type in ('medication', 'allergy_intolerance') and i.deleted_at is not null
    union all
    select me.source_fact_id, 'event', me.id, me.medication_id, case when me.deleted_at is not null then 1 else 0 end, me.deleted_at
      from medication_events me join medications mm on mm.id = me.medication_id join facts f on f.id = me.source_fact_id
      where f.source_document_id = ${documentId} and f.type in ('medication', 'allergy_intolerance') and (me.deleted_at is not null or mm.deleted_at is not null)
  `);
  for (const r of deleted) {
    if (out.has(r.factId)) continue;
    const undone = undoneTargets.get(r.factId);
    // A line still there on a medication its undone placement took back went with that medication; a line deleted
    // on its own is covered only by an undone placement of that very line that deleted it (decided at the moment the
    // line went: one marked undone after the user had deleted the line deleted nothing).
    const takenBackByPlacement =
      r.kind === 'event'
        ? Boolean(undone && ((undone.has(`event:${r.id}`) && (!r.lineDeleted || deletedAtDecision(r.lineDeletedAt, lineDecidedAt.get(r.id) ?? null))) || (!r.lineDeleted && undone.has(`medication:${r.medicationId}`))))
        : Boolean(undone?.has(`${r.kind}:${r.id}`));
    if (!takenBackByPlacement) out.add(r.factId);
  }
  return out;
}

/** The table a placement of this target type points into (null for the document's own type). */
function targetTable(targetType: string) {
  return targetType === 'communication'
    ? schema.communications
    : targetType === 'encounter'
      ? schema.encounters
      : targetType === 'record'
        ? schema.recordsInventory
        : targetType === 'medication'
          ? schema.medications
          : targetType === 'intolerance'
            ? schema.intolerances
            : null;
}

/** Whether a row of this target type is still live (the user may have deleted it elsewhere). */
function targetLive(targetType: string, id: string): boolean {
  const t = targetTable(targetType);
  if (!t) return true;
  return Boolean(db().select({ id: t.id }).from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).get());
}

/**
 * Pending placements whose target is gone (a call, appointment, record or
 * medication the user removed on its own page) stop waiting. Deleting it is
 * the user's answer: the placement is confirmed, decided by "removed
 * elsewhere", so it shows as gone with no Undo and filing never makes it
 * again (recordFiling, alreadyPlaced and factsAlreadyPlaced count it). The
 * one-time cleanup passes `undone` for the history lines of the medications
 * it took back itself, which a later filing may make again.
 */
function settleRemovedTargets(status: 'confirmed' | 'undone' = 'confirmed'): void {
  const now = nowIso();
  const pairs: Array<[string, string]> = [
    ['communication', 'communications'],
    ['encounter', 'encounters'],
    ['record', 'records_inventory'],
    ['medication', 'medications'],
    ['intolerance', 'intolerances'],
  ];
  for (const [type, table] of pairs) {
    db().run(
      sql`update filings set status = ${status}, decided_at = ${now}, decided_by = ${REMOVED_ELSEWHERE} where status = 'pending' and target_type = ${type} and not exists (select 1 from ${sql.identifier(table)} x where x.id = filings.target_id and x.deleted_at is null)`,
    );
  }
}

/** Filings that belong to a live document (or to none). Deleted documents' placements do not wait. */
const ON_LIVE_DOCUMENT = sql`(${schema.filings.documentId} is null or exists (select 1 from documents dd where dd.id = ${schema.filings.documentId} and dd.deleted_at is null))`;

function livePerson(id: string | null | undefined): string | null {
  if (!id) return null;
  return db().select({ id: schema.people.id }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get()?.id ?? null;
}

/** Stands in for a classification when the user chose the type of a document Claude never classified. */
const UNCLASSIFIED = {
  category: '',
  confidence: null as number | null,
  summary: '',
  contains: { labs: false, imaging: false, medications: false, plan_or_recommendations: false, portal_thread: false, transcript: false },
  suggested_links: { encounter_id: null as string | null, inventory_row_ids: [] as string[], person_ids: [] as string[] },
};

const CALL_CATEGORIES = new Set(['call_transcript', 'portal_message']);
const VISIT_CATEGORIES: Record<string, 'visit' | 'admission' | 'procedure'> = { clinical_note: 'visit', discharge_summary: 'admission', operative_report: 'procedure' };

export interface AutoFileResult {
  documentId: string;
  created: Array<{ targetType: FilingTarget; targetId: string; summary: string }>;
  skipped: string | null;
  /** Filing failed (the reason is also kept on the document as metadata.filingError). */
  error?: string;
}

/**
 * File a classified document: its type, a held inventory row, a draft
 * communication for calls and portal messages, an encounter link or a new
 * encounter for a primary visit note, and expected records it fulfils.
 * Idempotent; never throws (filing must not fail a classification job).
 */
export function autoFileAfterClassification(documentId: string, opts: { force?: boolean; userChosen?: boolean } = {}): AutoFileResult {
  const out: AutoFileResult = { documentId, created: [], skipped: null };
  try {
    if (!opts.force && !autoFilingOn()) return { ...out, skipped: 'automatic filing is off' };
    const doc = liveDocumentRow(documentId);
    if (!doc) return { ...out, skipped: 'document not found' };
    if (inInbox(doc)) return { ...out, skipped: 'waiting in the Inbox' };
    if (handledInInbox(doc) && !opts.userChosen) return { ...out, skipped: 'filed by the user in Check before filing' };
    const classified = readTriage(doc);
    // A type the user chose by hand on a document Claude never classified still files the rest (calls, records);
    // there is just no classification to hold for a check.
    if (!classified && !opts.userChosen) return { ...out, skipped: 'not classified yet' };
    const triage = classified ?? UNCLASSIFIED;
    const note = (f: FilingRow | null) => f && out.created.push({ targetType: f.targetType as FilingTarget, targetId: f.targetId, summary: f.summary });
    const category = doc.category;
    const date = doc.documentDate;

    db().transaction(() => {
      // 1. The document's own type (recorded only for a type Claude chose; the user changes it on the document).
      if (classified) note(
        recordFiling({
          documentId,
          targetType: 'document',
          targetId: documentId,
          action: 'classified',
          summary: `Sorted as a ${CATEGORY_WORDS[category] ?? category} (${TIER_WORDS[doc.sourceTier] ?? doc.sourceTier})${date ? `, dated ${date}` : ''}`,
          detail: { category, sourceTier: doc.sourceTier, title: doc.title, confidence: triage.confidence },
        }),
      );

      // 2. The records checklist. First the expected or requested records this document fulfils (each only
      //    once, and only while it is still open, so a row the user corrected is not marked received again, and
      //    never a row the user turned down with Undo for any document); the row's earlier state is kept so Undo
      //    can put it back.
      for (const rowId of [...new Set(triage.suggested_links?.inventory_row_ids ?? [])]) {
        if (placedForRow(documentId, rowId) || rowTurnedDown(rowId)) continue;
        const r = db().select().from(schema.recordsInventory).where(and(eq(schema.recordsInventory.id, rowId), isNull(schema.recordsInventory.deletedAt))).get();
        if (!r || !['expected', 'requested'].includes(r.status)) continue;
        const prior = { status: r.status, held: r.held, heldForm: r.heldForm, documentId: r.documentId, format: r.format, receivedAt: r.receivedAt };
        receiveRecord(rowId, { documentId });
        note(recordFiling({ documentId, targetType: 'record', targetId: rowId, action: 'linked', summary: `Marked "${r.title}" in the records checklist as received with ${doc.title}`, detail: { rowId, prior } }));
      }
      //    Then, unless a row already holds this document, a row saying we hold it. That is simply true, so it has
      //    no Undo.
      const heldNow = db().select({ id: schema.recordsInventory.id }).from(schema.recordsInventory).where(and(eq(schema.recordsInventory.documentId, documentId), isNull(schema.recordsInventory.deletedAt))).get();
      if (!heldNow && !alreadyPlaced(documentId, 'record', 'created')) {
        const row = createFromDocument({ documentId });
        note(recordFiling({ documentId, targetType: 'record', targetId: row.id, action: 'created', summary: `Listed in the records checklist as held: ${doc.title}` }));
      }

      // 3. Calls and portal messages become communications.
      // The classification's "contains a transcript / portal thread" flags count only while the document keeps the
      // type that classification gave it (after an approved move they describe a type the user turned down).
      const sameTypeAsClassified = Boolean(classified) && triage.category === category;
      const isCall = CALL_CATEGORIES.has(category) || (sameTypeAsClassified && (Boolean(triage.contains?.transcript) || Boolean(triage.contains?.portal_thread)));
      // An export (an Epic chart print) holds many messages: they are read one by one into Calls & Messages
      // (messages-import.ts), never logged as one "portal message" (2026-10-07).
      const exportDoc = isExportDocument(doc);
      // A filed copy of a message an export already holds is that message: linked to it, never a second row.
      const copyOf = isCall && !exportDoc && !existingCommunicationFor(documentId) ? recordMessageThisCopies(doc) : null;
      if (copyOf && !alreadyPlaced(documentId, 'communication', 'linked')) {
        note(recordFiling({ documentId, targetType: 'communication', targetId: copyOf.id, action: 'linked', summary: `Linked to the same message in the records: ${copyOf.subject}`.slice(0, 500), detail: { copyOf: copyOf.exportDocumentId } }));
      }
      if (isCall && !exportDoc && !copyOf && !existingCommunicationFor(documentId) && !alreadyPlaced(documentId, 'communication', 'created')) {
        const channel = category === 'portal_message' || (category !== 'call_transcript' && triage.contains?.portal_thread) ? 'portal' : 'call';
        const participants: Array<{ personId: string; role: 'from' | 'present' }> = [];
        const author = livePerson(doc.authorPersonId);
        if (author) participants.push({ personId: author, role: 'from' });
        for (const pid of triage.suggested_links?.person_ids ?? []) {
          if (participants.some((p) => p.personId === pid) || !livePerson(pid)) continue;
          participants.push({ personId: pid, role: 'present' });
        }
        const comm = createCommunication(
          {
            subject: doc.title,
            channel,
            direction: 'bidirectional',
            occurredAtText: doc.documentDateText ?? doc.documentDate ?? null,
            summary: triage.summary?.trim() ? `${MODEL_SUMMARY_PREFIX}${triage.summary.trim()}` : null,
            documentId,
            participants,
            topics: [AUTO_FILED_TOPIC],
          },
          { details: { origin: 'filed' } },
        );
        note(recordFiling({ documentId, targetType: 'communication', targetId: comm.id, action: 'created', summary: `Logged as a ${channel === 'portal' ? 'portal message' : 'call'}${date ? ` on ${date}` : ''}: ${doc.title}` }));
      }

      // 4. Visit notes: link the encounter the classification found, or record a past visit.
      const suggestedEncounter = triage.suggested_links?.encounter_id ?? null;
      if (suggestedEncounter && !alreadyPlaced(documentId, 'encounter', 'linked') && !alreadyPlaced(documentId, 'encounter', 'created') && !encounterHasDocument(suggestedEncounter, documentId)) {
        const warnings: string[] = [];
        const linked = linkEncounter(suggestedEncounter, documentId, warnings);
        if (linked) note(recordFiling({ documentId, targetType: 'encounter', targetId: linked, action: 'linked', summary: `Attached to an existing appointment: ${doc.title}`, detail: { documentId } }));
      } else if (!suggestedEncounter && VISIT_CATEGORIES[category] && doc.sourceTier === 'primary' && date && parsePartialDate(date).precision === 'day' && !isCall && !alreadyPlaced(documentId, 'encounter', 'created') && !alreadyPlaced(documentId, 'encounter', 'linked')) {
        const sameDay = db()
          .select({ id: schema.encounters.id, documentIdsJson: schema.encounters.documentIdsJson })
          .from(schema.encounters)
          .where(and(eq(schema.encounters.occurredAt, date), isNull(schema.encounters.deletedAt)))
          .all();
        const already = sameDay.find((e) => parseJson<string[]>(e.documentIdsJson, []).includes(documentId));
        if (!already) {
          if (sameDay.length === 1) {
            const warnings: string[] = [];
            const linked = linkEncounter(sameDay[0].id, documentId, warnings);
            if (linked) note(recordFiling({ documentId, targetType: 'encounter', targetId: linked, action: 'linked', summary: `Attached to the appointment on ${date}: ${doc.title}`, detail: { documentId } }));
          } else if (!sameDay.length) {
            const enc = createEncounter({
              title: doc.title,
              kind: VISIT_CATEGORIES[category],
              status: 'completed',
              occurredAt: date,
              occurredAtText: doc.documentDateText ?? date,
              clinicianId: livePerson(doc.authorPersonId),
              institutionId: livePerson(doc.institutionId),
              documentIds: [documentId],
            });
            note(recordFiling({ documentId, targetType: 'encounter', targetId: enc.id, action: 'created', summary: `Recorded as a past ${VISIT_CATEGORIES[category]} on ${date}: ${doc.title}` }));
          }
        }
      }
    });
    setFilingError(documentId, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[filing] after classification of ${documentId}: ${message}`);
    out.skipped = message;
    out.error = message;
    setFilingError(documentId, message);
  }
  return out;
}

/** An export recognised by its structure (metadata_json.export, or an Epic segmentation): never one communication. */
function isExportDocument(doc: DocumentRow): boolean {
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  if (parseExportInfo(meta)) return true;
  const seg = meta.segmentation as { layout?: unknown } | undefined;
  return seg?.layout === 'epic';
}

/**
 * The message read out of an export that this small filed document is a copy of (WP-A's copy check wrote
 * `metadata_json.containedIn`): the export's row on those pages whose body appears whole in this document's text.
 * The row gains the filed copy (`details.copies`, kind filed_copy); null when there is none.
 */
function recordMessageThisCopies(doc: DocumentRow): { id: string; subject: string; exportDocumentId: string } | null {
  const entries = parseContainedIn(parseJson<Record<string, unknown>>(doc.metadataJson, {}));
  if (!entries.length) return null;
  const text = normalizeForHash(
    db().select({ text: schema.documentPages.text }).from(schema.documentPages).where(eq(schema.documentPages.documentId, doc.id)).orderBy(schema.documentPages.pageNumber).all().map((p) => p.text).join('\n'),
  );
  for (const e of entries) {
    const rows = db()
      .select()
      .from(schema.communications)
      .where(and(eq(schema.communications.documentId, e.documentId), isNull(schema.communications.deletedAt), sql`json_extract(${schema.communications.detailsJson}, '$.origin') = 'extracted'`))
      .all();
    for (const r of rows) {
      const det = parseCommunicationDetails(r.detailsJson);
      const pages = det.pages;
      if (!pages || pages[1] < e.pages[0] || pages[0] > e.pages[1]) continue;
      const body = normalizeForHash(r.body);
      if (body.length < 80 || !text.includes(body)) continue;
      const copies = [...(det.copies ?? [])];
      if (!copies.some((c) => c.kind === 'filed_copy' && c.documentId === doc.id)) {
        copies.push({ kind: 'filed_copy', documentId: doc.id, pages: doc.pageCount > 0 ? [1, doc.pageCount] : null, communicationId: null, similarity: 1, minutesApart: null, linkedAt: nowIso() });
        const next: CommunicationDetails = { ...det, copies, bodyHash: det.bodyHash ?? bodyHashOf(r.body) };
        db().update(schema.communications).set({ detailsJson: JSON.stringify(next) }).where(eq(schema.communications.id, r.id)).run();
      }
      return { id: r.id, subject: r.subject, exportDocumentId: e.documentId };
    }
  }
  return null;
}

/** decidedBy on the one "portal message" row an export got before its messages were read one by one. */
export const READ_MESSAGE_BY_MESSAGE = 'messages read one by one';

/**
 * An export that automatic filing logged as one call or portal message (before its messages were read out of it):
 * that row is taken back (soft-deleted, the placement `undone`, decided by READ_MESSAGE_BY_MESSAGE) when its messages
 * are now in Calls & Messages one by one and nobody worked on the row since. A row the user changed stays. Never throws.
 */
export function retireWholeDocumentCommunication(documentId: string): number {
  let taken = 0;
  try {
    const doc = liveDocumentRow(documentId);
    if (!doc || !isExportDocument(doc)) return 0;
    const rows = db()
      .select()
      .from(schema.filings)
      .where(and(eq(schema.filings.documentId, documentId), eq(schema.filings.targetType, 'communication'), eq(schema.filings.action, 'created'), inArray(schema.filings.status, ['pending', 'confirmed'])))
      .all()
      .filter(onClaudesWord);
    for (const f of rows) {
      const comm = db().select({ detailsJson: schema.communications.detailsJson, deletedAt: schema.communications.deletedAt }).from(schema.communications).where(eq(schema.communications.id, f.targetId)).get();
      if (!comm || comm.deletedAt || parseCommunicationDetails(comm.detailsJson).origin === 'extracted') continue;
      if (workedOnSet([f]).has(f.id)) continue;
      try {
        rejectFiling(f.id, READ_MESSAGE_BY_MESSAGE, { status: 'undone' });
        taken++;
      } catch {
        // decided meanwhile: left alone
      }
    }
  } catch (err) {
    console.warn(`[filing] whole-document communication of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return taken;
}

/**
 * Expected or requested records-checklist rows that an export holds (one of its encounters, records.ts openRowsHeldIn):
 * marked received with the export, each as an automatic filing with Undo (the row's earlier state is kept so Undo puts
 * it back). A row this document already marked, or one the user turned down for any document, is left alone; so is a
 * document waiting in the Inbox, and everything when automatic filing is off. Returns the rows marked.
 */
export function receiveRowsHeldInExport(documentId: string, items: Array<{ rowId: string; title: string; heldRowId: string; segmentIds: string[]; pages: [number, number] }>): string[] {
  const out: string[] = [];
  if (!autoFilingOn()) return out;
  const doc = liveDocumentRow(documentId);
  if (!doc || inInbox(doc)) return out;
  for (const it of items) {
    try {
      if (placedForRow(documentId, it.rowId) || rowTurnedDown(it.rowId)) continue;
      const r = db().select().from(schema.recordsInventory).where(and(eq(schema.recordsInventory.id, it.rowId), isNull(schema.recordsInventory.deletedAt))).get();
      if (!r || r.held || !['expected', 'requested'].includes(r.status)) continue;
      const prior = { status: r.status, held: r.held, heldForm: r.heldForm, documentId: r.documentId, format: r.format, receivedAt: r.receivedAt };
      db().transaction(() => {
        receiveRecord(it.rowId, { documentId });
        recordFiling({
          documentId,
          targetType: 'record',
          targetId: it.rowId,
          action: 'linked',
          summary: `Marked "${r.title}" in the records checklist as received: held inside ${doc.title}, pp.${it.pages[0]}-${it.pages[1]}`,
          detail: { rowId: it.rowId, prior, heldRowId: it.heldRowId, segmentIds: it.segmentIds.slice(0, 50), pages: it.pages },
        });
      });
      out.push(it.rowId);
    } catch (err) {
      console.warn(`[filing] marking a held record received from ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Keep (or clear) why filing a document failed, so its page can say so instead of staying silent. */
function setFilingError(documentId: string, reason: string | null): void {
  try {
    const row = db().select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row) return;
    const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
    if (reason === null) {
      if (!('filingError' in meta)) return;
      delete meta.filingError;
    } else meta.filingError = { reason: reason.slice(0, 1000), at: nowIso() };
    db().update(schema.documents).set({ metadataJson: JSON.stringify(meta) }).where(eq(schema.documents.id, documentId)).run();
  } catch {
    // Never fail the caller over the note.
  }
}

/**
 * File one document now: what its classification says (or the type the user
 * chose) and the medications in its details. For a document Claude
 * classified but never filed.
 */
export function fileDocument(documentId: string): { created: number; error: string | null; needsSorting: boolean } {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  if (inInbox(doc)) throw conflict('this document is waiting in Check before filing; file it there');
  if (handledInInbox(doc)) throw conflict('this document was filed in Check before filing; change its type on the document if it is wrong');
  if (!readTriage(doc) && !db().select({ id: schema.filings.id }).from(schema.filings).where(and(eq(schema.filings.documentId, documentId), eq(schema.filings.targetType, 'document'), inArray(schema.filings.status, ['approved', 'confirmed']))).get()) {
    return { created: 0, error: null, needsSorting: true };
  }
  const a = autoFileAfterClassification(documentId, { force: true, userChosen: true });
  const b = READ_STATUSES.has(doc.extractionStatus) ? autoFileAfterExtraction(documentId, { force: true }) : { created: [] };
  return { created: a.created.length + b.created.length, error: a.error ?? null, needsSorting: false };
}

/**
 * File what the facts of a document say: medications and intolerances (as
 * the Medications page's "from facts" would), only from a clinical record or
 * the patient's own notes. A summary, an outside letter or a document whose
 * source is not decided yet keeps its medication details as details; the
 * Medications page's "Add from documents" can still add them. Sorting a
 * document later (which sets its source) runs this again. A drug or substance
 * the user removed (deleted, or Undo), whichever document made it, is not
 * made again while none is on the list (see removedByUser); "Add from
 * documents" still offers it. Idempotent; never throws.
 */
export function autoFileAfterExtraction(documentId: string, opts: { force?: boolean } = {}): AutoFileResult {
  const out: AutoFileResult = { documentId, created: [], skipped: null };
  try {
    if (!opts.force && !autoFilingOn()) return { ...out, skipped: 'automatic filing is off' };
    const doc = liveDocumentRow(documentId);
    if (!doc) return { ...out, skipped: 'document not found' };
    if (inInbox(doc)) return { ...out, skipped: 'waiting in the Inbox' };
    if (!MEDICATION_TIERS.includes(doc.sourceTier)) return { ...out, skipped: 'medications are added automatically only from clinical records and your own notes' };
    // A drug or substance already on the list gets a history line (or nothing), never a second entry. A fact
    // already placed from this document (including one the user turned down) is left alone, and so is a drug or
    // substance the user removed (deleted, or Undo) from any document while none is on the list.
    const done = factsAlreadyPlaced(documentId);
    let removed: ReturnType<typeof removedByUser> | null = null;
    const removedNow = () => (removed ??= removedByUser());
    // This document's details only: building the whole case's proposals once per document made Sort them now slow.
    // Trust follows the passage (2026-10-07): a detail read from a passage trusted below the document (an outside letter
    // scanned into a clinical record) is not filed, nor the patient's own words quoted inside a clinical record (a request
    // in his message is not the record of a medication; filesMedicationsAt).
    const passageTier = factTiersOf(documentId, doc.sourceTier);
    const proposals = proposeFromFacts({ documentId }).filter((p) => p.documentId === documentId && !done.has(p.factId) && filesMedicationsAt(doc.sourceTier, passageTier.get(p.factId) ?? doc.sourceTier));
    const madeMeds: Array<{ id: string; name: string }> = [];
    const madeIntolerances = new Set<string>();
    for (const p of proposals) {
      try {
        let row: FilingRow | null = null;
        if (p.kind === 'intolerance') {
          const key = normalizeKey(String(p.proposed.substance ?? p.statement));
          if (p.existing || madeIntolerances.has(key) || removedNow().intolerances.has(key)) continue;
          const r = acceptFromFacts({ factId: p.factId });
          madeIntolerances.add(key);
          if (r.kind === 'intolerance' && !r.existing) row = recordFiling({ documentId, targetType: 'intolerance', targetId: r.intolerance.id, action: 'created', summary: `Added an intolerance: ${r.intolerance.substance}`, detail: { factId: p.factId } });
        } else {
          row = fileMedicationDetail({ documentId, made: madeMeds, removedNow }, p);
        }
        if (row) out.created.push({ targetType: row.targetType as FilingTarget, targetId: row.targetId, summary: row.summary });
      } catch (err) {
        // One fact that does not fit never stops the rest.
        console.warn(`[filing] medication fact ${p.factId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.warn(`[filing] after extraction of ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    out.skipped = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** The tier each fact of a document is trusted at (trust.ts factTier: its passage's, never above the document's). */
function factTiersOf(documentId: string, docTier: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of db()
    .select({ id: schema.facts.id, assertedBy: schema.facts.assertedBy, attributesJson: schema.facts.attributesJson })
    .from(schema.facts)
    .where(and(eq(schema.facts.sourceDocumentId, documentId), isNull(schema.facts.deletedAt), inArray(schema.facts.type, ['medication', 'allergy_intolerance'])))
    .all())
    out.set(f.id, factTier(docTier, f));
  return out;
}

/**
 * Automatic filing of one medication detail of a document (autoFileAfterExtraction, and the second medication-names
 * cleanup moving a repeated entry's details onto the medication kept):
 * - A list heading, or two drugs in one name, is not a medication: never made and never given a history line here
 *   ("Add from documents" lists it, labelled, to add with an edited name).
 * - One drug under two names ("Metformin ER", "Metformin ER (Example Pharma)") is one medication (sameMedicationName): a drug
 *   already on the list, or made from this document a moment ago, gets a history line, never a second entry. `onto`
 *   pins the medication the line goes on. A drug the user removed is not made again (see removedByUser).
 * - On a course already on the list the detail is a plain note: it never stops, restarts or re-dates the medication (a
 *   start or stop is the user's call, made on the medication itself). One exception: a detail that states a start
 *   fills in a start that is not recorded (statedStartFills), as a start line that changes nothing else.
 */
function fileMedicationDetail(
  ctx: { documentId: string; made: Array<{ id: string; name: string }>; removedNow: () => ReturnType<typeof removedByUser> },
  p: MedicationProposal,
  onto?: string,
): FilingRow | null {
  if (p.kind !== 'medication' || p.notMedication) return null;
  const name = String(p.proposed.name ?? p.statement);
  const target = onto ?? p.existing?.id ?? ctx.made.find((m) => sameMedicationName(m.name, name))?.id ?? null;
  if (!target && ctx.removedNow().medications.some((n) => sameMedicationName(n, name))) return null;
  const eventKind = target && statedStartFills(target, p.proposed) ? 'start' : 'note';
  // The start the line may fill in or replace, kept with the placement so Undo can put it back.
  const startOf = (id: string) =>
    db().select({ startDate: schema.medications.startDate, startDatePrecision: schema.medications.startDatePrecision, startDateText: schema.medications.startDateText }).from(schema.medications).where(eq(schema.medications.id, id)).get() ?? null;
  const before = target && eventKind === 'start' ? startOf(target) : null;
  const r = acceptFromFacts(target ? { factId: p.factId, medicationId: target, eventKind } : { factId: p.factId }, { automatic: true });
  if (r.existing) return null;
  if (r.kind === 'event') {
    const after = before ? startOf(r.medication.id) : null;
    const changed = Boolean(before && after && (before.startDate !== after.startDate || before.startDateText !== after.startDateText));
    return recordFiling({
      documentId: ctx.documentId,
      targetType: 'medication',
      targetId: r.medication.id,
      action: 'linked',
      summary: `${eventKind === 'start' ? 'Added the start date to the history of' : 'Added to the history of'} ${r.medication.name}: ${p.statement.slice(0, 120)}`,
      detail: { factId: p.factId, eventId: r.event.id, ...(changed ? { replacedStart: before, setStart: after } : {}) },
    });
  }
  if (r.kind === 'medication') {
    ctx.made.push({ id: r.medication.id, name });
    return recordFiling({ documentId: ctx.documentId, targetType: 'medication', targetId: r.medication.id, action: 'created', summary: `Added a medication: ${r.medication.name}`, detail: { factId: p.factId } });
  }
  return null;
}

/**
 * Sort everything not sorted yet: documents classified before automatic
 * filing existed are filed now; documents Claude never classified (added
 * while AI was off or the key was failing, or whose classification failed)
 * get a classification queued, and are filed when it ends.
 */
export function fileBacklog(): { documents: number; created: number; queued: number; aiOff: boolean } {
  const docs = db().select({ id: schema.documents.id, extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(isNull(schema.documents.deletedAt)).all();
  let created = 0;
  for (const d of docs) {
    created += autoFileAfterClassification(d.id, { force: true }).created.length;
    if (READ_STATUSES.has(d.extractionStatus)) created += autoFileAfterExtraction(d.id, { force: true }).created.length;
  }
  const unsorted = listUnsorted().filter((u) => !u.sorting);
  const aiOff = unsorted.length > 0 && !classificationAvailable();
  let queued = 0;
  // Below new uploads in the AI lane, so a fresh upload is not stuck behind the backlog.
  if (!aiOff) for (const u of unsorted) if (queueSort(u.id, CLASSIFY_PENDING_PRIORITY)) queued++;
  return { documents: docs.length, created, queued, aiOff };
}

/** A failed classification is tried again on its own after this long (a fixed key, a busy API). */
export const AUTO_SORT_RETRY_MS = 6 * 60 * 60 * 1000;
/** After this many failures in a row, automatic sorting stops trying (Sort it now still works; a new key resets it). */
export const AUTO_SORT_MAX_FAILURES = 3;

/** When the API key or the AI switch last changed (settings rows carry their update time). */
function aiSettingsChangedAt(): number {
  const r = db()
    .select({ at: sql<string | null>`max(${schema.settings.updatedAt})` })
    .from(schema.settings)
    .where(inArray(schema.settings.key, ['ai.apiKey', 'ai.enabled']))
    .get();
  return r?.at ? Date.parse(r.at) || 0 : 0;
}

/** The latest cancelled sorting job per document: a cancel the user made is respected for a while. */
function lastCancelledSorts(): Map<string, number> {
  const rows = db()
    .select({ documentId: schema.jobs.documentId, at: sql<string | null>`max(${schema.jobs.finishedAt})` })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'triage_document'), eq(schema.jobs.status, 'cancelled')))
    .groupBy(schema.jobs.documentId)
    .all();
  const out = new Map<string, number>();
  for (const r of rows) if (r.documentId && r.at) out.set(r.documentId, Date.parse(r.at) || 0);
  return out;
}

/**
 * Keep everything sorted without the user asking: documents Claude named but
 * never filed are filed, and documents never sorted get a classification
 * queued (when AI is available), except those whose last try failed
 * recently. Runs after unlock and every few minutes while unlocked; does
 * nothing when automatic filing is off. Never throws.
 */
export function autoSortTick(now = Date.now()): { filed: number; queued: number } {
  const out = { filed: 0, queued: 0 };
  try {
    if (!autoFilingOn()) return out;
    // Named (classified) but never filed: file them; no AI needed.
    const unfiled = db()
      .select({ id: schema.documents.id, extractionStatus: schema.documents.extractionStatus })
      .from(schema.documents)
      .where(
        and(
          isNull(schema.documents.deletedAt),
          sql`json_extract(${schema.documents.metadataJson}, '$.triage') is not null`,
          sql`json_extract(${schema.documents.metadataJson}, '$.inbox') is null`,
          sql`json_extract(${schema.documents.metadataJson}, '$.filingError') is null`,
          sql`not exists (select 1 from filings f where f.document_id = ${schema.documents.id} and f.target_type = 'document' and f.status <> 'undone')`,
        ),
      )
      .all();
    for (const d of unfiled) {
      out.filed += autoFileAfterClassification(d.id).created.length;
      if (READ_STATUSES.has(d.extractionStatus)) out.filed += autoFileAfterExtraction(d.id).created.length;
    }
    if (!classificationAvailable()) return out;
    // Failures and cancels from before the key or the AI switch last changed do not count: a new key gets a fresh try.
    const changedAt = aiSettingsChangedAt();
    const cancelledAt = lastCancelledSorts();
    for (const u of listUnsorted()) {
      if (u.sorting) continue;
      const failed = u.failedAt ? Date.parse(u.failedAt) : 0;
      if (failed > changedAt) {
        if (u.failures >= AUTO_SORT_MAX_FAILURES) continue;
        if (now - failed < AUTO_SORT_RETRY_MS) continue;
      }
      const cancelled = cancelledAt.get(u.id) ?? 0;
      if (cancelled > changedAt && now - cancelled < AUTO_SORT_RETRY_MS) continue;
      if (queueSort(u.id, CLASSIFY_PENDING_PRIORITY)) out.queued++;
    }
  } catch (err) {
    console.warn(`[filing] automatic sorting: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** Queue a classification (which files the document when it ends). False when one is already queued or running. */
function queueSort(documentId: string, priority = 0): boolean {
  const busy = db()
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'triage_document'), eq(schema.jobs.documentId, documentId), inArray(schema.jobs.status, ['queued', 'running'])))
    .get();
  if (busy) return false;
  enqueueJob({ type: 'triage_document', payload: { documentId }, documentId, dedupe: true, priority });
  return true;
}

/** Sort one document now: Claude classifies it and files it (settled at once; Undo takes a placement back). */
export function sortDocument(documentId: string): { queued: boolean } {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  if (inInbox(doc)) throw conflict('this document is waiting in Check before filing; file it there');
  if (!doc.pageCount || !['extracted', 'ocr_done'].includes(doc.textStatus)) throw conflict('the pages have not been read yet; Claude sorts a document once its text is in');
  if (!classificationAvailable()) throw conflict('Claude is switched off or no working API key is stored (Settings)');
  return { queued: queueSort(documentId) };
}

export interface UnsortedDocument {
  id: string;
  title: string;
  /** Why the last classification did not work, when one was tried. */
  reason: string | null;
  failedAt: string | null;
  /** A classification is queued or running for it now. */
  sorting: boolean;
  /** How many classifications in a row have failed (automatic sorting stops retrying after a few). */
  failures: number;
}

/**
 * Documents with readable pages that Claude never classified and nothing was
 * filed for (not in the Inbox, which sorts its own). These wait in yellow as
 * "not sorted yet" (the one kind of filing that still needs the user, with a
 * move the clinician suggested).
 */
export function listUnsorted(): UnsortedDocument[] {
  const d = db();
  const meta = schema.documents.metadataJson;
  const rows = d
    .select({ id: schema.documents.id, title: schema.documents.title, metadataJson: meta })
    .from(schema.documents)
    .where(
      and(
        isNull(schema.documents.deletedAt),
        inArray(schema.documents.textStatus, ['extracted', 'ocr_done']),
        sql`${schema.documents.pageCount} >= 1`,
        sql`(case when json_valid(${meta}) then json_extract(${meta}, '$.triage') end) is null`,
        // Anything that went through Check before filing (the inbox) is sorted there (or by the user).
        sql`(case when json_valid(${meta}) then json_extract(${meta}, '$.inbox') end) is null`,
        // The patient's own notes imported on My notes (2026-10-09) are filed by him at import, never sorted by Claude.
        sql`(case when json_valid(${meta}) then json_extract(${meta}, '$.note.batch') end) is null`,
        // Sorted means classified, or a type the user chose (an approved move or a type set by hand). Medications
        // filed from its details, or a proposal the user declined, do not sort it.
        sql`not exists (select 1 from filings f where f.document_id = ${schema.documents.id} and f.target_type = 'document' and f.status in ('approved', 'confirmed') and (f.action = 'move' or f.source = 'user'))`,
      ),
    )
    .orderBy(desc(schema.documents.createdAt))
    .all();
  if (!rows.length) return [];
  const sorting = new Set(
    d
      .select({ documentId: schema.jobs.documentId })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, 'triage_document'), inArray(schema.jobs.status, ['queued', 'running'])))
      .all()
      .map((j) => j.documentId),
  );
  return rows.map((r) => {
    const err = parseJson<{ classificationError?: { reason?: string; at?: string; count?: number } }>(r.metadataJson, {}).classificationError;
    return { id: r.id, title: r.title, reason: err?.reason ?? null, failedAt: err?.at ?? null, sorting: sorting.has(r.id), failures: err ? Math.max(1, Number(err.count) || 1) : 0 };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function listFilings(opts: { status?: string; targetType?: string; targetId?: string; documentId?: string; askMessageId?: string; ids?: string[]; limit?: number } = {}): Filing[] {
  const f = schema.filings;
  if (opts.status === 'pending' || opts.status === 'proposed') settleRemovedTargets();
  const conds = [];
  if (opts.status) conds.push(eq(f.status, opts.status));
  if (opts.status === 'pending' || opts.status === 'proposed') conds.push(ON_LIVE_DOCUMENT);
  if (opts.ids) conds.push(opts.ids.length ? inArray(f.id, opts.ids) : sql`0`);
  if (opts.targetType) conds.push(eq(f.targetType, opts.targetType));
  if (opts.targetId) conds.push(eq(f.targetId, opts.targetId));
  if (opts.documentId) conds.push(eq(f.documentId, opts.documentId));
  if (opts.askMessageId) conds.push(eq(f.askMessageId, opts.askMessageId));
  const rows = db()
    .select()
    .from(f)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(f.createdAt))
    .limit(Math.min(opts.limit ?? 2000, 5000))
    .all();
  const titles = documentTitles(rows.map((r) => r.documentId));
  const gone = goneTargets(rows);
  const worked = workedOnSet(rows);
  return rows.map((r) => toFiling(r, titles, gone, worked));
}

/** Pending filings for one section, keyed by the target id, for row highlighting. */
export function pendingTargets(targetType: string): Record<string, Filing[]> {
  const out: Record<string, Filing[]> = {};
  for (const f of listFilings({ status: 'pending', targetType })) (out[f.targetId] ??= []).push(f);
  return out;
}

export interface PendingCounts {
  /** Documents that need the user: not sorted yet (see listUnsorted), or with a move the clinician suggested. */
  documents: number;
  /** Placements still pending from before quiet checks (the one-time cleanup settles them; nothing new waits). Not in the total. */
  communications: number;
  encounters: number;
  records: number;
  medications: number;
  /** Always 0: lab values, scan results and other details no longer wait for a check (their trust comes from reconciliation). Kept so older screens still read a number. */
  labs: number;
  imaging: number;
  facts: number;
  /** Check before filing: uploads waiting there, and documents held back as "May be someone else's record" (2026-10-09). */
  inbox: number;
  /** Documents held back as "May be someone else's record" (also in `inbox`). */
  patient: number;
  /** New findings ("things Claude noticed"). */
  findings: number;
  /** Open move proposals (the clinician's), on live documents. */
  moves: number;
  /** Documents with an open move proposal. */
  documentsWaiting: number;
  /** Classified documents (not in the Inbox) whose type was never filed: added before automatic filing existed, or a filing that failed. */
  unfiled: number;
  /** Documents Claude never classified (see listUnsorted): they wait as "not sorted yet". */
  unsorted: number;
  /** Reconciliation: events whose mentions disagree and no clinical record settles them (yellow, needs the user). */
  needsSource: number;
  /** Reconciliation: details that contradict a verified one (informational, shown in red). */
  inaccurate: number;
  /** needsSource + documents + inbox + findings. */
  total: number;
}

function quietReconcileCounts(): { needsSource: number; inaccurate: number } {
  try {
    const r = reconcileCounts();
    return { needsSource: r.needsSource, inaccurate: r.inaccurate };
  } catch (err) {
    // The counts never fail the menu: a broken pass shows nothing rather than an error on every page.
    console.warn(`[filing] reconciliation counts: ${err instanceof Error ? err.message : String(err)}`);
    return { needsSource: 0, inaccurate: 0 };
  }
}

/** What waits for the user (the menu shows these counts in yellow). Nothing Claude filed waits: it is settled, with Undo. */
export function pendingCounts(): PendingCounts {
  const d = db();
  settleRemovedTargets();
  const byType = new Map(
    d
      .select({ t: schema.filings.targetType, n: sql<number>`count(*)` })
      .from(schema.filings)
      .where(and(eq(schema.filings.status, 'pending'), ON_LIVE_DOCUMENT))
      .groupBy(schema.filings.targetType)
      .all()
      .map((r) => [r.t, Number(r.n)]),
  );
  const inbox = d
    .select({ meta: schema.documents.metadataJson })
    .from(schema.documents)
    .where(and(isNull(schema.documents.deletedAt), inArray(sql`json_extract(${schema.documents.metadataJson}, '$.inbox.status')`, [...INBOX_ACTIVE_STATUSES])))
    .all().length;
  const held = quarantinedCount();
  const findings = Number(d.select({ n: sql<number>`count(*)` }).from(schema.findings).where(and(isNull(schema.findings.deletedAt), eq(schema.findings.status, 'new'))).get()?.n ?? 0);
  const moved = d
    .select({ documentId: schema.filings.documentId })
    .from(schema.filings)
    .innerJoin(schema.documents, and(eq(schema.documents.id, schema.filings.documentId), isNull(schema.documents.deletedAt)))
    .where(eq(schema.filings.status, 'proposed'))
    .all();
  const movedIds = new Set(moved.map((r) => r.documentId));
  const unsortedList = listUnsorted();
  // A document not sorted yet that also has a move suggested counts once.
  const documentIds = new Set<string | null>([...movedIds, ...unsortedList.map((u) => u.id)]);
  const unfiled = Number(
    d
      .select({ n: sql<number>`count(*)` })
      .from(schema.documents)
      .where(
        and(
          isNull(schema.documents.deletedAt),
          sql`json_extract(${schema.documents.metadataJson}, '$.triage') is not null`,
          // Filed or skipped in Check before filing (the inbox) is the user's own filing, not a backlog.
          sql`json_extract(${schema.documents.metadataJson}, '$.inbox') is null`,
          // Classified, but the type it was given was never filed (medications filed from its details do not count).
          sql`not exists (select 1 from filings f where f.document_id = ${schema.documents.id} and f.target_type = 'document' and f.status <> 'undone')`,
        ),
      )
      .get()?.n ?? 0,
  );
  const rc = quietReconcileCounts();
  const c: PendingCounts = {
    documents: documentIds.size,
    communications: byType.get('communication') ?? 0,
    encounters: byType.get('encounter') ?? 0,
    records: byType.get('record') ?? 0,
    medications: (byType.get('medication') ?? 0) + (byType.get('intolerance') ?? 0),
    labs: 0,
    imaging: 0,
    facts: 0,
    inbox: inbox + held,
    patient: held,
    findings,
    moves: moved.length,
    documentsWaiting: movedIds.size,
    unfiled,
    unsorted: unsortedList.length,
    needsSource: rc.needsSource,
    inaccurate: rc.inaccurate,
    total: 0,
  };
  // Inaccurate details are information, not a task: they are not in the total.
  c.total = c.needsSource + c.documents + c.inbox + c.findings;
  return c;
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

function getFilingRow(id: string): FilingRow {
  const row = db().select().from(schema.filings).where(eq(schema.filings.id, id)).get();
  if (!row) throw notFound('filing not found');
  return row;
}

function decide(id: string, status: string, by: string | null): void {
  db().update(schema.filings).set({ status, decidedAt: nowIso(), decidedBy: by }).where(eq(schema.filings.id, id)).run();
}

export function confirmFiling(id: string, by: string | null = null): Filing {
  const row = getFilingRow(id);
  if (row.status !== 'pending') throw conflict(`this filing is already ${row.status}`);
  decide(id, 'confirmed', by);
  return listFilings({ documentId: row.documentId ?? undefined }).find((f) => f.id === id)!;
}

/**
 * Undo: take back what the filing created or linked (a soft delete or an
 * unlink). Works on a placement that still stands on Claude's word: one
 * settled automatically, or one still pending from before quiet checks. A
 * placement the user confirmed is the user's word and stays (it can be
 * changed or deleted on its own page). The document's type is changed on the
 * document, and the row saying the document is held is simply true, so
 * neither is undone here. The document itself is never touched. Status
 * `rejected` (the default) means the placement is never made again.
 *
 * `guardWork` (the Undo route) also refuses a placement whose item the user
 * has worked on since (see workedOnSet): one click would delete that work.
 * The one-time cleanup and an approved move do their own checks.
 */
export function rejectFiling(id: string, by: string | null = null, opts: { status?: 'rejected' | 'undone'; guardWork?: boolean } = {}): Filing {
  const row = getFilingRow(id);
  if (!onClaudesWord(row)) {
    throw conflict(
      row.status === 'confirmed' && row.decidedBy === REMOVED_ELSEWHERE
        ? 'this was deleted on its own page; there is nothing to undo'
        : row.status === 'confirmed'
          ? 'you confirmed this filing yourself; change or delete it on its own page'
          : `this filing is already ${row.status}`,
    );
  }
  if (row.status === 'confirmed' && plainFact(row)) {
    throw conflict(row.targetType === 'document' ? 'change the type on the document instead' : 'the records checklist simply lists that this document is here; change the row there if it is wrong');
  }
  if (opts.guardWork && workedOnSet([row]).has(row.id)) throw conflict('you have worked on this since it was added; change or delete it on its own page');
  // A history line deleted on the Medications page: the deletion is the user's, there is nothing to undo (recording an
  // Undo here would read as this placement having deleted the line, and filing could then add it again).
  const line = lineOf(row);
  if (line && targetLive(row.targetType, row.targetId) && goneTargets([row]).has(`event:${line}`)) throw conflict('this line was deleted on its own page; there is nothing to undo');
  const detail = parseJson<Record<string, unknown>>(row.detailJson, {});
  db().transaction(() => {
    // Removed elsewhere already (what it created, or what it linked to): nothing left to undo, the decision is still recorded.
    if (pointsAtTarget(row) && !targetLive(row.targetType, row.targetId)) {
      decide(id, opts.status ?? 'rejected', by);
      return;
    }
    if (row.action === 'created') {
      if (row.targetType === 'communication') deleteCommunication(row.targetId);
      else if (row.targetType === 'encounter') deleteEncounter(row.targetId);
      else if (row.targetType === 'record') deleteRecord(row.targetId);
      else if (row.targetType === 'medication') deleteMedication(row.targetId);
      else if (row.targetType === 'intolerance') deleteIntolerance(row.targetId);
    } else if (row.action === 'linked') {
      if (row.targetType === 'encounter' && row.documentId) {
        const enc = db().select({ documentIdsJson: schema.encounters.documentIdsJson }).from(schema.encounters).where(eq(schema.encounters.id, row.targetId)).get();
        if (enc) {
          const ids = parseJson<string[]>(enc.documentIdsJson, []).filter((x) => x !== row.documentId);
          db().update(schema.encounters).set({ documentIdsJson: JSON.stringify(ids), updatedAt: nowIso() }).where(eq(schema.encounters.id, row.targetId)).run();
        }
      } else if (row.targetType === 'medication' && typeof detail.eventId === 'string') {
        const ev = db().select({ deletedAt: schema.medicationEvents.deletedAt }).from(schema.medicationEvents).where(eq(schema.medicationEvents.id, detail.eventId)).get();
        if (ev && !ev.deletedAt) deleteEvent(detail.eventId);
        // The line filled in (or replaced) the start: put back the start it found, while the medication still has the
        // start this line set (nobody changed it since). updated_at is left alone: this is Claude's own step undone.
        const replaced = detail.replacedStart as { startDate: string | null; startDatePrecision: string; startDateText: string | null } | undefined;
        const set = detail.setStart as { startDate: string | null; startDateText: string | null } | undefined;
        if (replaced && set) {
          const m = schema.medications;
          const now = db().select({ startDate: m.startDate, startDateText: m.startDateText }).from(m).where(eq(m.id, row.targetId)).get();
          if (now && now.startDate === set.startDate && now.startDateText === set.startDateText) {
            db().update(m).set({ startDate: replaced.startDate, startDatePrecision: replaced.startDatePrecision, startDateText: replaced.startDateText }).where(eq(m.id, row.targetId)).run();
          }
        }
      } else if (row.targetType === 'record' && row.documentId) {
        // Put the row back as it was, if it still points at this document (the user may have changed it since).
        const prior = detail.prior as { status?: string; held?: boolean; heldForm?: string | null; documentId?: string | null; format?: string; receivedAt?: string | null } | undefined;
        const r = db().select({ documentId: schema.recordsInventory.documentId, deletedAt: schema.recordsInventory.deletedAt }).from(schema.recordsInventory).where(eq(schema.recordsInventory.id, row.targetId)).get();
        if (prior && r && !r.deletedAt && r.documentId === row.documentId) {
          updateRecord(row.targetId, { status: prior.status, held: prior.held, heldForm: prior.heldForm ?? null, documentId: prior.documentId ?? null, format: prior.format, receivedAt: prior.receivedAt ?? null });
        }
      }
    }
    // 'classified': the document keeps its fields; the user edits them on the document.
    decide(id, opts.status ?? 'rejected', by);
  });
  return listFilings({ documentId: row.documentId ?? undefined }).find((f) => f.id === id)!;
}

/** Confirm every pending filing of one section (or all), or every unverified lab or imaging fact. */
export function confirmAll(section: string, by: string | null = null): { confirmed: number } {
  if (section === 'labs' || section === 'imaging' || section === 'facts') {
    const type = section === 'facts' ? null : FACT_SECTIONS[section];
    const ids = db()
      .select({ id: schema.facts.id })
      .from(schema.facts)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
      // Facts the user marked unsure stay unsure: Confirm all is for what is still pending.
      .where(and(isNull(schema.facts.deletedAt), eq(schema.facts.status, 'unverified'), sql`coalesce(${schema.facts.verdictBasis}, '') <> 'unsure'`, sql`(${schema.facts.sourceDocumentId} is null or ${schema.documents.deletedAt} is null)`, type ? eq(schema.facts.type, type) : undefined))
      .all()
      .map((r) => r.id);
    // No note argument: a note the user wrote on the fact stays. The clinical-record pass runs once after the loop,
    // not once per fact (each pass reads the whole ledger).
    for (const id of ids) setVerdict(id, 'confirmed', undefined, undefined, { reconcile: false });
    if (ids.length && (type === null || isReconciledType(type))) reconcileQuietly({ trigger: 'verdict' });
    return { confirmed: ids.length };
  }
  const types: string[] = section === 'all' ? [...FILING_TARGETS] : section === 'medications' ? ['medication', 'intolerance'] : section === 'documents' ? ['document'] : section === 'communications' ? ['communication'] : section === 'encounters' ? ['encounter'] : section === 'records' ? ['record'] : [];
  if (!types.length) throw badRequest(`unknown section ${section}`);
  const r = db()
    .update(schema.filings)
    .set({ status: 'confirmed', decidedAt: nowIso(), decidedBy: by })
    .where(and(eq(schema.filings.status, 'pending'), inArray(schema.filings.targetType, types)))
    .run();
  return { confirmed: r.changes };
}

// ---------------------------------------------------------------------------
// Who else stands on what a placement made (for setting a likely copy aside)
// ---------------------------------------------------------------------------

/** A placement as listFilings returns it (parsed `detail`) or as stored (`detailJson`). */
export interface PlacementRef {
  documentId: string | null;
  targetType: string;
  targetId: string;
  action: string;
  detail?: Record<string, unknown> | null;
  detailJson?: string | null;
}

/**
 * The other live documents that also stand on what this placement made or changed, so that taking it back would
 * remove something they still say. Sorted ids, never this placement's own document; empty when nothing else stands on
 * it. Read-only. Used when a likely copy is set aside (duplicates.ts): a placement another document stands on is kept.
 * - A medication or allergy it created: another live document's live detail (not marked incorrect, not replaced)
 *   names the same drug (name or generic name) or substance, a live history line on the medication comes from one of
 *   its details, the entry was made from one of its details, or it has a placement creating it still standing. For a
 *   medication the naming detail must be in a clinical record or the patient's own notes (the only documents whose
 *   medications are filed automatically); for an allergy any document counts (a missing allergy can hurt).
 * - A history line it added: another document's placement still standing names that very line, or the line was made
 *   from another document's detail.
 * - A call or message it created: it belongs to another live document, or another document has a placement on it.
 * - An appointment it created: another live document is attached to it.
 * - A records-checklist row it marked received (or listed as held): another live document is the row's document or
 *   has a placement on the row still standing. A document whose classification merely lists the row does not count:
 *   the row is better taken back and that document filed again, so the row points at it rather than at a document
 *   in the trash.
 * - Its link to an existing appointment, or the document's own type: taking it back removes only this document's own
 *   link, so nothing else stands on it (empty).
 */
export function otherDocumentsStandingOn(placement: PlacementRef): string[] {
  const self = placement.documentId;
  const detail = placement.detail ?? parseJson<Record<string, unknown>>(placement.detailJson ?? '{}', {});
  const found = new Set<string>();
  const liveDocs = (ids: Array<string | null | undefined>): string[] => {
    const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== self))];
    if (!want.length) return [];
    return db().select({ id: schema.documents.id }).from(schema.documents).where(and(inArray(schema.documents.id, want), isNull(schema.documents.deletedAt))).all().map((r) => r.id);
  };
  // Other documents' placements on the same target that still stand (not undone, rejected, or removed elsewhere).
  const standingPlacements = (actions: string[]) =>
    db()
      .select({ documentId: schema.filings.documentId, detailJson: schema.filings.detailJson })
      .from(schema.filings)
      .where(
        and(
          eq(schema.filings.targetType, placement.targetType),
          eq(schema.filings.targetId, placement.targetId),
          inArray(schema.filings.action, actions),
          inArray(schema.filings.status, ['pending', 'confirmed']),
          sql`coalesce(${schema.filings.decidedBy}, '') <> ${REMOVED_ELSEWHERE}`,
        ),
      )
      .all();
  // The documents of these details, when the details are live.
  const documentsOfFacts = (factIds: Array<string | null | undefined>): Array<string | null> => {
    const want = [...new Set(factIds.filter((x): x is string => typeof x === 'string'))];
    if (!want.length) return [];
    return db().select({ documentId: schema.facts.sourceDocumentId }).from(schema.facts).where(and(inArray(schema.facts.id, want), isNull(schema.facts.deletedAt))).all().map((r) => r.documentId);
  };
  const { targetType, targetId, action } = placement;

  if (action === 'created' && (targetType === 'medication' || targetType === 'intolerance')) {
    const isMed = targetType === 'medication';
    const row = isMed
      ? db().select({ sourceFactId: schema.medications.sourceFactId, name: schema.medications.name, genericName: schema.medications.genericName }).from(schema.medications).where(eq(schema.medications.id, targetId)).get()
      : db().select({ sourceFactId: schema.intolerances.sourceFactId, name: schema.intolerances.substance, genericName: sql<string | null>`null` }).from(schema.intolerances).where(eq(schema.intolerances.id, targetId)).get();
    if (!row) return [];
    const candidates: Array<string | null | undefined> = [];
    candidates.push(...standingPlacements(['created']).map((r) => r.documentId));
    candidates.push(...documentsOfFacts([row.sourceFactId]));
    if (isMed) {
      const lines = db()
        .select({ sourceFactId: schema.medicationEvents.sourceFactId })
        .from(schema.medicationEvents)
        .where(and(eq(schema.medicationEvents.medicationId, targetId), isNull(schema.medicationEvents.deletedAt)))
        .all();
      candidates.push(...documentsOfFacts(lines.map((l) => l.sourceFactId)));
    }
    // Live details naming the same drug or substance (medications: only from documents that file medications).
    const keys = new Set([normalizeKey(row.name), normalizeKey(row.genericName)].filter(Boolean));
    // Matched as the proposals match: a substance by its normalised name, a drug by sameMedicationName.
    const names = [row.name, row.genericName].filter((n): n is string => Boolean(n));
    const sameItem = (x: { type: string; statement: string; attributesJson: string }) => (isMed ? names.some((n) => sameMedicationName(n, factItemName(x))) : keys.has(factItemKey(x)));
    const f = schema.facts;
    const details = db()
      .select({ documentId: f.sourceDocumentId, type: f.type, statement: f.statement, attributesJson: f.attributesJson, assertedBy: f.assertedBy, tier: schema.documents.sourceTier })
      .from(f)
      .innerJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
      .where(
        and(
          eq(f.type, isMed ? 'medication' : 'allergy_intolerance'),
          isNull(f.deletedAt),
          notInArray(f.status, ['disputed', 'superseded']),
          isNull(schema.documents.deletedAt),
          self ? sql`${f.sourceDocumentId} <> ${self}` : undefined,
          isMed ? inArray(schema.documents.sourceTier, [...MEDICATION_TIERS]) : undefined,
        ),
      )
      .all();
    for (const x of details) if (sameItem(x) && (!isMed || filesMedicationsAt(x.tier, factTier(x.tier, x)))) candidates.push(x.documentId);
    for (const id of liveDocs(candidates)) found.add(id);
  } else if (action === 'linked' && targetType === 'medication') {
    const eventId = typeof detail.eventId === 'string' ? detail.eventId : null;
    if (!eventId) return [];
    const candidates = standingPlacements(['linked'])
      .filter((r) => parseJson<{ eventId?: unknown }>(r.detailJson, {}).eventId === eventId)
      .map((r) => r.documentId);
    const line = db().select({ sourceFactId: schema.medicationEvents.sourceFactId }).from(schema.medicationEvents).where(eq(schema.medicationEvents.id, eventId)).get();
    candidates.push(...documentsOfFacts([line?.sourceFactId]));
    for (const id of liveDocs(candidates)) found.add(id);
  } else if (action === 'created' && targetType === 'communication') {
    const c = db().select({ documentId: schema.communications.documentId }).from(schema.communications).where(eq(schema.communications.id, targetId)).get();
    for (const id of liveDocs([c?.documentId, ...standingPlacements(['created', 'linked']).map((r) => r.documentId)])) found.add(id);
  } else if (action === 'created' && targetType === 'encounter') {
    const e = db().select({ documentIdsJson: schema.encounters.documentIdsJson }).from(schema.encounters).where(eq(schema.encounters.id, targetId)).get();
    for (const id of liveDocs(parseJson<string[]>(e?.documentIdsJson ?? '[]', []))) found.add(id);
  } else if (targetType === 'record' && (action === 'linked' || action === 'created')) {
    const r = db().select({ documentId: schema.recordsInventory.documentId }).from(schema.recordsInventory).where(eq(schema.recordsInventory.id, targetId)).get();
    for (const id of liveDocs([r?.documentId, ...standingPlacements(['created', 'linked']).map((x) => x.documentId)])) found.add(id);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Moves proposed by the consult (nothing changes until the user approves)
// ---------------------------------------------------------------------------

export function proposeMove(input: { documentId: string; toCategory: string; reason: string; askMessageId?: string | null; source?: 'consult' | 'user' }): Filing {
  const doc = liveDocumentRow(input.documentId);
  if (!doc) throw notFound('document not found');
  if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(input.toCategory)) throw badRequest(`unknown document type ${input.toCategory}`);
  if (doc.category === input.toCategory) throw badRequest(`the document is already filed as ${CATEGORY_WORDS[input.toCategory] ?? input.toCategory}`);
  const open = db()
    .select()
    .from(schema.filings)
    .where(and(eq(schema.filings.documentId, input.documentId), eq(schema.filings.action, 'move'), eq(schema.filings.status, 'proposed')))
    .get();
  if (open) return listFilings({ documentId: input.documentId }).find((f) => f.id === open.id)!;
  const row: FilingRow = {
    id: newId(),
    documentId: input.documentId,
    targetType: 'document',
    targetId: input.documentId,
    action: 'move',
    status: 'proposed',
    source: input.source ?? 'consult',
    summary: `Move "${doc.title}" from ${CATEGORY_WORDS[doc.category] ?? doc.category} to ${CATEGORY_WORDS[input.toCategory] ?? input.toCategory}: ${input.reason}`.slice(0, 500),
    detailJson: JSON.stringify({ fromCategory: doc.category, toCategory: input.toCategory, reason: input.reason }),
    askMessageId: input.askMessageId ?? null,
    createdAt: nowIso(),
    decidedAt: null,
    decidedBy: null,
  };
  db().insert(schema.filings).values(row).run();
  return listFilings({ documentId: input.documentId }).find((f) => f.id === row.id)!;
}

function editedSince(targetType: string, id: string, since: string): boolean {
  const t = targetType === 'communication' ? schema.communications : schema.encounters;
  const r = db().select({ updatedAt: t.updatedAt }).from(t).where(eq(t.id, id)).get();
  return Boolean(r && r.updatedAt > since);
}

/** Apply an approved move: set the new type, undo pending automatic filings that no longer fit, file again. */
export function approveMove(id: string, by: string | null = null): { filing: Filing; refiled: AutoFileResult } {
  const row = getFilingRow(id);
  if (row.action !== 'move' || row.status !== 'proposed') throw conflict('this is not an open proposal');
  const detail = parseJson<{ toCategory?: string }>(row.detailJson, {});
  if (!row.documentId || !detail.toCategory) throw badRequest('the proposal is incomplete');
  const documentId = row.documentId;
  db().transaction(() => {
    updateDocument(documentId, { category: detail.toCategory as (typeof DOCUMENT_CATEGORIES)[number] });
    // Automatic placements made for the old type (settled automatically, or still pending from before quiet checks)
    // are undone; ones the user confirmed are the user's and stay.
    const standing = db()
      .select()
      .from(schema.filings)
      .where(and(eq(schema.filings.documentId, documentId), eq(schema.filings.source, 'auto'), inArray(schema.filings.status, ['pending', 'confirmed'])))
      .all()
      .filter(onClaudesWord);
    for (const f of standing) {
      if (f.targetType === 'document' && f.action === 'classified') {
        // The type the classification chose was the wrong one.
        decide(f.id, 'rejected', by);
        continue;
      }
      if (f.targetType === 'communication' || f.targetType === 'encounter') {
        // A call or appointment the user has worked on since Claude made it is theirs now: it stays.
        if (f.action === 'created' && editedSince(f.targetType, f.targetId, f.createdAt)) decide(f.id, 'confirmed', by);
        else rejectFiling(f.id, by, { status: 'undone' });
      }
    }
    // An earlier confirmed type no longer describes the document.
    db()
      .update(schema.filings)
      .set({ status: 'undone', decidedAt: nowIso(), decidedBy: by })
      .where(and(eq(schema.filings.documentId, documentId), eq(schema.filings.targetType, 'document'), eq(schema.filings.action, 'classified'), eq(schema.filings.status, 'confirmed')))
      .run();
    decide(id, 'approved', by);
  });
  const refiled = autoFileAfterClassification(documentId, { force: true, userChosen: true });
  return { filing: listFilings({ documentId }).find((f) => f.id === id)!, refiled };
}

/**
 * The user sets a document's type: recorded as an approved move, then filed
 * again under the new type. Choosing the type it already has (a document
 * Claude never sorted) records the user's choice and files it as it is. One
 * transaction, so a failure leaves no half-made proposal behind.
 */
export function refileDocument(input: { documentId: string; toCategory: string }, by: string | null = null): { filing: Filing; refiled: AutoFileResult } {
  return db().transaction(() => {
    const doc = liveDocumentRow(input.documentId);
    if (!doc) throw notFound('document not found');
    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(input.toCategory)) throw badRequest(`unknown document type ${input.toCategory}`);
    // An open proposal (the clinician's) is settled by the user's choice.
    const open = db().select().from(schema.filings).where(and(eq(schema.filings.documentId, input.documentId), eq(schema.filings.action, 'move'), eq(schema.filings.status, 'proposed'))).get();
    if (open) {
      const to = parseJson<{ toCategory?: string }>(open.detailJson, {}).toCategory;
      if (to === input.toCategory) return approveMove(open.id, by);
      decide(open.id, 'declined', by);
    }
    if (doc.category === input.toCategory) {
      // Same type: the user confirms it. The type Claude chose (if any) stops waiting; the rest is filed.
      db()
        .update(schema.filings)
        .set({ status: 'confirmed', decidedAt: nowIso(), decidedBy: by })
        .where(and(eq(schema.filings.documentId, input.documentId), eq(schema.filings.targetType, 'document'), eq(schema.filings.action, 'classified'), eq(schema.filings.status, 'pending')))
        .run();
      const row: FilingRow = {
        id: newId(),
        documentId: input.documentId,
        targetType: 'document',
        targetId: input.documentId,
        action: 'classified',
        status: 'confirmed',
        source: 'user',
        summary: `Type set by hand: ${CATEGORY_WORDS[doc.category] ?? doc.category}`,
        detailJson: JSON.stringify({ category: doc.category }),
        askMessageId: null,
        createdAt: nowIso(),
        decidedAt: nowIso(),
        decidedBy: by,
      };
      db().insert(schema.filings).values(row).run();
      const refiled = autoFileAfterClassification(input.documentId, { force: true, userChosen: true });
      return { filing: listFilings({ ids: [row.id] })[0], refiled };
    }
    const p = proposeMove({ documentId: input.documentId, toCategory: input.toCategory, reason: 'changed by hand', source: 'user' });
    return approveMove(p.id, by);
  });
}

export function declineMove(id: string, by: string | null = null): Filing {
  const row = getFilingRow(id);
  if (row.action !== 'move' || row.status !== 'proposed') throw conflict('this is not an open proposal');
  decide(id, 'declined', by);
  return listFilings({ documentId: row.documentId ?? undefined }).find((f) => f.id === id)!;
}

// ---------------------------------------------------------------------------
// The one-time cleanup for quiet checks (2026-10-05)
// ---------------------------------------------------------------------------

export interface QuietChecksMigrationResult {
  /** False when it had already run (the setting is on), or when it failed (logged; it runs again on the next unlock). */
  ran: boolean;
  /** Pending automatic placements now settled (decided by `automatic`; Undo stays). */
  settled: number;
  /** Medications and allergies added only from summaries (or outside letters, or a source not decided) and never confirmed: taken back. */
  takenBack: number;
  /** Such entries kept anyway (the user worked on them, a clinical record or the patient's notes also put a line on them, or a never-give allergy): their placement is settled instead. */
  kept: number;
  error?: string;
}

/** A placement the user confirmed by hand ("Looks right" before quiet checks): their word, not Claude's or a cleanup's. */
function confirmedByUser(f: Pick<FilingRow, 'status' | 'decidedBy'>): boolean {
  return f.status === 'confirmed' && f.decidedBy !== null && ![AUTOMATIC, REMOVED_ELSEWHERE, SUMMARY_MEDICATIONS_TAKEN_BACK].includes(f.decidedBy);
}

/**
 * Live history lines on a medication that the user added or confirmed, or that came from a clinical record or the
 * patient's notes. The start or stop line written from the very detail that created the medication
 * (`creatingFactId`) is the automatic placement itself, not backing; a line no filing made from any other detail
 * ("Add from documents") is the user's own work, and so is a line whose placement the user confirmed ("Looks right").
 */
function medicationBackedElsewhere(medicationId: string, documentTiers: Map<string, string>, creatingFactId: string | null): boolean {
  const events = db()
    .select({ id: schema.medicationEvents.id, sourceFactId: schema.medicationEvents.sourceFactId })
    .from(schema.medicationEvents)
    .where(and(eq(schema.medicationEvents.medicationId, medicationId), isNull(schema.medicationEvents.deletedAt)))
    .all();
  if (!events.length) return false;
  const placed = new Map<string, string | null>();
  const usersWord = new Set<string>();
  for (const f of db()
    .select({ documentId: schema.filings.documentId, detailJson: schema.filings.detailJson, status: schema.filings.status, decidedBy: schema.filings.decidedBy })
    .from(schema.filings)
    .where(and(eq(schema.filings.targetType, 'medication'), eq(schema.filings.targetId, medicationId), eq(schema.filings.action, 'linked'), inArray(schema.filings.status, ['pending', 'confirmed'])))
    .all()) {
    const eventId = parseJson<{ eventId?: unknown }>(f.detailJson, {}).eventId;
    if (typeof eventId !== 'string') continue;
    placed.set(eventId, f.documentId);
    if (confirmedByUser(f)) usersWord.add(eventId);
  }
  if (events.some((e) => usersWord.has(e.id))) return true;
  // A line a filing made backs the medication when a clinical record or the patient's notes made it. A line no
  // filing made backs it unless it came from the detail that created the medication (its own start or stop line);
  // with no creating detail known, a line from a detail backs it only when that detail's document is a clinical
  // record or the patient's notes.
  const factIds = [...new Set(events.filter((e) => !placed.has(e.id) && e.sourceFactId).map((e) => e.sourceFactId as string))];
  const factTier = new Map<string, string>();
  if (factIds.length && !creatingFactId) {
    for (const r of db()
      .select({ id: schema.facts.id, documentId: schema.facts.sourceDocumentId })
      .from(schema.facts)
      .where(inArray(schema.facts.id, factIds))
      .all())
      factTier.set(r.id, documentTiers.get(r.documentId ?? '') ?? 'unknown');
  }
  return events.some((e) => {
    if (placed.has(e.id)) return MEDICATION_TIERS.includes(documentTiers.get(placed.get(e.id) ?? '') ?? 'unknown');
    if (!e.sourceFactId) return true;
    if (creatingFactId) return e.sourceFactId !== creatingFactId;
    return MEDICATION_TIERS.includes(factTier.get(e.sourceFactId) ?? 'unknown');
  });
}

/** The repair below runs once; its setting is not listed in DEFAULT_SETTINGS (a shared file), so it reads as unset until written. */
const REPAIR_V1B_SETTING = 'migration.quietChecksV1b';

export interface QuietChecksRepairResult {
  /** False when it had already run (its setting is on), or when it failed (logged; it runs again on the next unlock). */
  ran: boolean;
  /** Allergies and intolerances the first cleanup took back, now on the list again (and on the emergency card). */
  allergiesRestored: number;
  /** Placements whose target the user deleted, marked undone by older code, now standing (confirmed, "removed elsewhere"). */
  removedElsewhere: number;
  /** Medications the first cleanup took back although the user had confirmed one of their history lines. Not restored (an extra medication on the emergency card is not harmless); still offered under "Add from documents". */
  medicationsToReview: number;
  error?: string;
}

/**
 * The target was soft-deleted by the cleanup itself: within a minute of the cleanup deciding its placement (the
 * cleanup deletes and decides in one transaction). Deleted earlier, the user deleted it before; deleted later, the
 * user deleted it after (it had come back some other way): either way it is the user's deletion, not the cleanup's.
 */
function deletedByCleanup(deletedAt: string | null, decidedAt: string | null): boolean {
  return deletedAtDecision(deletedAt, decidedAt);
}

/**
 * Whether a row was soft-deleted by the decision of a placement on it: within a minute of that decision (Undo, the
 * cleanup and setting a copy aside delete and decide in one transaction). Deleted well before or after, someone else
 * deleted it (the user, on its own page).
 */
function deletedAtDecision(deletedAt: string | null, decidedAt: string | null): boolean {
  if (!deletedAt || !decidedAt) return false;
  const del = Date.parse(deletedAt);
  const dec = Date.parse(decidedAt);
  return Number.isFinite(del) && Number.isFinite(dec) && del >= dec - 60_000 && del <= dec + 60_000;
}

/**
 * Run once (guarded by the setting `migration.quietChecksV1b`), first thing in
 * quietChecksMigration, so it also runs where the first cleanup already ran:
 * - Placements whose target the user deleted, which older code marked
 *   `undone` ("removed elsewhere"), are confirmed: the deletion is the user's
 *   answer, so filing never makes the item again. History lines on medications
 *   the cleanup itself took back stay undone.
 * - Allergies and intolerances the first cleanup took back are put back on
 *   the list (a soft delete undone, every field as it was) and their placement
 *   confirmed by `automatic`, with the repair's time in its detail
 *   (`restoredAt`) so Undo stays until the user changes it. Skipped when the
 *   cleanup was not what deleted it (the user deleted it before, or after),
 *   the user has one for the same substance again, any entry for the same
 *   substance or from the same detail was made after the cleanup (even one
 *   since deleted or undone: the user's later word stands), the user pressed
 *   Undo on a placement of that detail, or marked the detail incorrect.
 * Additive and idempotent; one transaction; never throws (a failure is
 * logged, rolls back, leaves the setting off, and the next unlock tries again).
 */
export function quietChecksRepairV1b(): QuietChecksRepairResult {
  const out: QuietChecksRepairResult = { ran: false, allergiesRestored: 0, removedElsewhere: 0, medicationsToReview: 0 };
  try {
    if (getSetting(REPAIR_V1B_SETTING as SettingKey) === true) return out;
    db().transaction(() => {
      // 1. Deleted by the user: the placement stands (before the allergies below change any decided_by).
      out.removedElsewhere = db().run(
        sql`update filings set status = 'confirmed' where status = 'undone' and decided_by = ${REMOVED_ELSEWHERE} and not exists (select 1 from filings g where g.target_id = filings.target_id and g.decided_by = ${SUMMARY_MEDICATIONS_TAKEN_BACK})`,
      ).changes;

      // 2. Allergies the first cleanup took back.
      const takenBack = (targetType: 'intolerance' | 'medication') =>
        db()
          .select()
          .from(schema.filings)
          .where(and(eq(schema.filings.targetType, targetType), eq(schema.filings.action, 'created'), eq(schema.filings.status, 'undone'), eq(schema.filings.decidedBy, SUMMARY_MEDICATIONS_TAKEN_BACK)))
          .orderBy(schema.filings.createdAt)
          .all();
      const liveSubstances = new Set(
        db()
          .select({ substance: schema.intolerances.substance })
          .from(schema.intolerances)
          .where(isNull(schema.intolerances.deletedAt))
          .all()
          .map((r) => normalizeKey(r.substance)),
      );
      const disputed = (factId: string | null) => Boolean(factId && db().select({ id: schema.facts.id }).from(schema.facts).where(and(eq(schema.facts.id, factId), eq(schema.facts.status, 'disputed'))).get());
      // Every allergy row, live or deleted (a short list), to see what the user did about a substance after the cleanup.
      const allRows = db()
        .select({ id: schema.intolerances.id, substance: schema.intolerances.substance, sourceFactId: schema.intolerances.sourceFactId, createdAt: schema.intolerances.createdAt })
        .from(schema.intolerances)
        .all();
      // Details with an Undo on one of their allergy placements (status rejected): the user took it off, never make it again.
      const undoneByUser = new Set<string>();
      for (const r of db()
        .select({ detailJson: schema.filings.detailJson })
        .from(schema.filings)
        .where(and(eq(schema.filings.targetType, 'intolerance'), eq(schema.filings.status, 'rejected')))
        .all()) {
        const factId = parseJson<{ factId?: unknown }>(r.detailJson, {}).factId;
        if (typeof factId === 'string') undoneByUser.add(factId);
      }
      for (const f of takenBack('intolerance')) {
        const i = db().select().from(schema.intolerances).where(eq(schema.intolerances.id, f.targetId)).get();
        // Deleted by the cleanup itself (not by the user before it, nor after it).
        if (!i || !f.decidedAt || !deletedByCleanup(i.deletedAt, f.decidedAt)) continue;
        const key = normalizeKey(i.substance);
        // The user has it on the list again (re-added by hand), or said the detail is wrong: their word stands.
        if (liveSubstances.has(key) || disputed(i.sourceFactId)) continue;
        // After the cleanup the user dealt with this substance or this detail again (added it back by hand, or it was
        // filed again from a clinical record), even if that entry is deleted now (the user deleted it, or pressed
        // Undo): the user's later word stands, the old entry stays off.
        const decidedAt = f.decidedAt;
        const later = allRows.some((x) => x.id !== i.id && x.createdAt >= decidedAt && (normalizeKey(x.substance) === key || (i.sourceFactId !== null && x.sourceFactId === i.sourceFactId)));
        if (later) continue;
        // The user pressed Undo on a placement of this very detail: never made again.
        if (i.sourceFactId && undoneByUser.has(i.sourceFactId)) continue;
        // The repair's own time goes on the row and on its placement: a change after it is the user's work (Undo
        // stays until then; see workedOnSet).
        const at = nowIso();
        if (!restoreIntolerance(i.id, at)) continue;
        liveSubstances.add(key);
        db()
          .update(schema.filings)
          .set({ status: 'confirmed', decidedAt: at, decidedBy: AUTOMATIC, detailJson: JSON.stringify({ ...parseJson<Record<string, unknown>>(f.detailJson, {}), restoredAt: at }) })
          .where(eq(schema.filings.id, f.id))
          .run();
        out.allergiesRestored++;
      }

      // 3. Medications taken back although the user had confirmed one of their history lines (the old rule missed
      //    that): counted for the log only.
      for (const f of takenBack('medication')) {
        const m = db().select({ deletedAt: schema.medications.deletedAt }).from(schema.medications).where(eq(schema.medications.id, f.targetId)).get();
        if (!m || !deletedByCleanup(m.deletedAt, f.decidedAt)) continue;
        const lines = db()
          .select({ status: schema.filings.status, decidedBy: schema.filings.decidedBy })
          .from(schema.filings)
          .where(and(eq(schema.filings.targetType, 'medication'), eq(schema.filings.targetId, f.targetId), eq(schema.filings.action, 'linked')))
          .all();
        if (lines.some(confirmedByUser)) out.medicationsToReview++;
      }
    });
    setSetting(REPAIR_V1B_SETTING as 'migration.quietChecksV1', true);
    out.ran = true;
    if (out.allergiesRestored || out.removedElsewhere || out.medicationsToReview) {
      console.log(
        `[filing] quiet checks repair: ${out.allergiesRestored} allerg${out.allergiesRestored === 1 ? 'y' : 'ies'} the first cleanup took back restored, ${out.removedElsewhere} placement${out.removedElsewhere === 1 ? '' : 's'} of items deleted by hand kept as answered${out.medicationsToReview ? `, ${out.medicationsToReview} medication${out.medicationsToReview === 1 ? '' : 's'} with a history line you confirmed left off the list (offered under Add from documents)` : ''}`,
      );
    }
  } catch (err) {
    Object.assign(out, { ran: false, allergiesRestored: 0, removedElsewhere: 0, medicationsToReview: 0 });
    out.error = err instanceof Error ? err.message : String(err);
    console.warn(`[filing] quiet checks repair failed (it runs again on the next unlock): ${out.error}`);
  }
  return out;
}

/**
 * Run once (guarded by the setting `migration.quietChecksV1`), on unlock,
 * after the repair above (which runs once on its own guard):
 * (b) first, medications Claude added from a document that is not a clinical
 * record or the patient's own notes, still pending, are taken back through
 * Undo (status `undone`, decided by "summaries no longer add medications"; a
 * soft delete; the detail stays and the Medications page can add it again).
 * One the user has edited since, or with a history line the user added or
 * confirmed or from a clinical record or the patient's notes, is kept and its
 * placement settled instead. Every allergy and intolerance is kept (a missing
 * allergy can hurt, an extra one cannot). Then (a) every other pending
 * automatic placement is settled (decided by `automatic`; Undo stays
 * available). Idempotent; never throws: a failure is logged, rolls back,
 * leaves the setting off, and the next unlock tries again.
 */
export function quietChecksMigration(): QuietChecksMigrationResult {
  const out: QuietChecksMigrationResult = { ran: false, settled: 0, takenBack: 0, kept: 0 };
  // Before the guard below, so it also runs where this cleanup already ran. Never throws.
  quietChecksRepairV1b();
  try {
    if (getSetting('migration.quietChecksV1') === true) return out;
    db().transaction(() => {
      // Placements whose target the user deleted elsewhere stop waiting first (confirmed: the deletion is the answer).
      settleRemovedTargets();
      const tiers = new Map(db().select({ id: schema.documents.id, tier: schema.documents.sourceTier }).from(schema.documents).all().map((r) => [r.id, r.tier]));
      const meds = db()
        .select()
        .from(schema.filings)
        .where(and(eq(schema.filings.status, 'pending'), eq(schema.filings.source, 'auto'), eq(schema.filings.action, 'created'), inArray(schema.filings.targetType, ['medication', 'intolerance'])))
        .all();
      for (const f of meds) {
        if (MEDICATION_TIERS.includes(tiers.get(f.documentId ?? '') ?? 'unknown')) continue;
        if (!targetLive(f.targetType, f.targetId)) {
          decide(f.id, 'undone', SUMMARY_MEDICATIONS_TAKEN_BACK);
          out.takenBack++;
          continue;
        }
        let keep = false;
        if (f.targetType === 'medication') {
          const m = db().select({ updatedAt: schema.medications.updatedAt }).from(schema.medications).where(eq(schema.medications.id, f.targetId)).get();
          const creatingFactId = parseJson<{ factId?: unknown }>(f.detailJson, {}).factId;
          keep = Boolean(m && m.updatedAt > f.createdAt) || medicationBackedElsewhere(f.targetId, tiers, typeof creatingFactId === 'string' ? creatingFactId : null);
        } else {
          // Every allergy and intolerance stays (2026-10-05): a missing allergy can hurt, an extra one cannot
          // (the emergency card lists them), and summaries no longer add new ones. Its placement is settled, with Undo.
          keep = true;
        }
        if (keep) {
          decide(f.id, 'confirmed', AUTOMATIC);
          out.kept++;
        } else {
          rejectFiling(f.id, SUMMARY_MEDICATIONS_TAKEN_BACK, { status: 'undone' });
          out.takenBack++;
        }
      }
      // History lines on a medication this cleanup just took back stop waiting too (undone, "removed elsewhere"): the
      // medication was taken back by the cleanup, not deleted by the user, so they may be made again.
      settleRemovedTargets('undone');
      const now = nowIso();
      out.settled = db()
        .update(schema.filings)
        .set({ status: 'confirmed', decidedAt: now, decidedBy: AUTOMATIC })
        .where(and(eq(schema.filings.status, 'pending'), eq(schema.filings.source, 'auto')))
        .run().changes;
    });
    setSetting('migration.quietChecksV1', true);
    out.ran = true;
    if (out.settled || out.takenBack || out.kept) console.log(`[filing] quiet checks: ${out.settled} filing${out.settled === 1 ? '' : 's'} settled, ${out.takenBack} medication or allergy entr${out.takenBack === 1 ? 'y' : 'ies'} from summaries taken back, ${out.kept} kept`);
  } catch (err) {
    // Rolled back: nothing it counted was kept.
    Object.assign(out, { ran: false, settled: 0, takenBack: 0, kept: 0 });
    out.error = err instanceof Error ? err.message : String(err);
    console.warn(`[filing] quiet checks cleanup failed (it runs again on the next unlock): ${out.error}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The one-time cleanup for medication names (2026-10-06)
// ---------------------------------------------------------------------------

/** decidedBy on a medication the one-time cleanup took back: its name is a list heading ("current working list"), not a drug. */
export const NOT_A_MEDICATION_NAME = 'not a medication name';

export interface MedNamesCleanupResult {
  /** False when it had already run (the setting is on), or when it failed (logged; it runs again on the next unlock). */
  ran: boolean;
  /** Medications Claude made from a list heading, taken back through Undo. */
  takenBack: number;
  /** Such entries kept: the user worked on them since, or confirmed them by hand. */
  kept: number;
  error?: string;
}

/**
 * Run once (guarded by the setting `migration.medNamesV1`), on unlock, after the quiet-checks cleanup. Medications
 * automatic filing made (a 'created' placement, source auto, still on Claude's word) whose name is a list heading or
 * section title (isListHeadingName: "current working list", "Medications") are taken back through Undo: status
 * `undone`, decided by "not a medication name", a soft delete; the detail stays and "Add from documents" lists it,
 * labelled. One the user worked on since (see workedOnSet) or confirmed by hand is kept. Nothing else is touched (a
 * name with two drugs in it stays: it names real drugs). One transaction; idempotent; never throws: a failure is
 * logged, rolls back, leaves the setting off, and the next unlock tries again.
 *
 * Then the second step (medNamesCleanupV2, its own setting) runs, also where this one already ran.
 */
export function medNamesCleanupV1(): MedNamesCleanupResult {
  const out = medNamesHeadingsV1();
  // Never throws; guarded by its own setting.
  medNamesCleanupV2();
  return out;
}

function medNamesHeadingsV1(): MedNamesCleanupResult {
  const out: MedNamesCleanupResult = { ran: false, takenBack: 0, kept: 0 };
  try {
    if (getSetting('migration.medNamesV1') === true) return out;
    db().transaction(() => {
      const f = schema.filings;
      const placements = db()
        .select()
        .from(f)
        .where(and(eq(f.targetType, 'medication'), eq(f.action, 'created'), eq(f.source, 'auto')))
        .orderBy(f.createdAt)
        .all();
      // The live medications they made, with the name each has now.
      const names = new Map<string, string>();
      const ids = [...new Set(placements.map((r) => r.targetId))];
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        for (const m of db()
          .select({ id: schema.medications.id, name: schema.medications.name })
          .from(schema.medications)
          .where(and(inArray(schema.medications.id, chunk), isNull(schema.medications.deletedAt)))
          .all())
          names.set(m.id, m.name);
      }
      // One placement per medication: the first still on Claude's word. One the user confirmed by hand keeps it.
      const byTarget = new Map<string, FilingRow[]>();
      for (const r of placements) {
        const name = names.get(r.targetId);
        if (name === undefined || !isListHeadingName(name)) continue;
        (byTarget.get(r.targetId) ?? byTarget.set(r.targetId, []).get(r.targetId)!).push(r);
      }
      const candidates: FilingRow[] = [];
      for (const rows of byTarget.values()) {
        const mine = rows.find(onClaudesWord);
        if (rows.some(confirmedByUser)) out.kept++;
        else if (mine) candidates.push(mine);
      }
      const worked = workedOnSet(candidates);
      for (const r of candidates) {
        if (worked.has(r.id)) {
          out.kept++;
          continue;
        }
        rejectFiling(r.id, NOT_A_MEDICATION_NAME, { status: 'undone' });
        out.takenBack++;
      }
    });
    setSetting('migration.medNamesV1', true);
    out.ran = true;
    console.log(
      `[filing] medication names: ${out.takenBack} list heading${out.takenBack === 1 ? '' : 's'} taken off the medication list${out.kept ? `, ${out.kept} kept (worked on or confirmed by hand)` : ''}`,
    );
  } catch (err) {
    // Rolled back: nothing it counted was kept.
    Object.assign(out, { ran: false, takenBack: 0, kept: 0 });
    out.error = err instanceof Error ? err.message : String(err);
    console.warn(`[filing] medication names cleanup failed (it runs again on the next unlock): ${out.error}`);
  }
  return out;
}

/** decidedBy on a medication the second step took back, followed by the older medication's name: one drug, two entries. */
export const SAME_MEDICATION_AS = 'same medication as';

export interface MedDuplicatesCleanupResult {
  /** False when it had already run (the setting is on), or when it failed (logged; it runs again on the next unlock). */
  ran: boolean;
  /** Medications Claude made a second time under another name of a drug already on the list, taken back through Undo. */
  takenBack: number;
  /** Such entries kept (see medNamesCleanupV2). */
  kept: number;
  /** Their details now history lines on the medication kept. */
  linesMoved: number;
  error?: string;
}

/**
 * Run once (guarded by the setting `migration.medNamesV2`), on unlock, right after the first medication-names step
 * (medNamesCleanupV1 runs it, also where that step already ran). A medication automatic filing made (a 'created'
 * placement, source auto, still on Claude's word) under another name of a drug that was already on the list
 * (sameMedicationName with an older live medication's name or generic name: "Metformin ER (Example Pharma)" beside an older
 * "Metformin ER") is taken back through Undo: status `undone`, decided by "same medication as <older name>", a soft
 * delete (the history lines automatic filing added to it are marked undone with it). The details that stood on it
 * (the one it was made from, and those lines' details) are then filed again onto the older one, as automatic filing
 * would file them now (fileMedicationDetail): history lines, a stated start filling a start that is not recorded,
 * nothing else changed on it.
 *
 * Kept, and counted: one the user worked on (workedOnSet) or confirmed a placement of by hand; one whose course says
 * what the older one's does not (it is current and the older one is not, or it is stopped or has a stop and the older
 * one is not stopped: merging it would take a current drug off the list and the emergency card, or hide a stop); a
 * name that is not one drug; a name matching older medications that are not one drug ("Insulin" beside "Insulin
 * (Lantus)" and "Insulin (Humalog)"); one whose details could not be filed again (a detail deleted, marked incorrect,
 * replaced or not one drug, or its document deleted), or did not all move when filed (each entry is taken back inside
 * its own savepoint, put back exactly as it was when any of its details stays behind). Never the older medication,
 * never an allergy. Oldest first (made time, then insertion order). One transaction; idempotent; never throws: a
 * failure is logged, rolls back, leaves the setting off, and the next unlock tries again.
 */
export function medNamesCleanupV2(): MedDuplicatesCleanupResult {
  const out: MedDuplicatesCleanupResult = { ran: false, takenBack: 0, kept: 0, linesMoved: 0 };
  try {
    if (getSetting('migration.medNamesV2') === true) return out;
    db().transaction(() => {
      const m = schema.medications;
      const live = db()
        .select({ id: m.id, name: m.name, genericName: m.genericName, status: m.status, stopDate: m.stopDate, stopDateText: m.stopDateText, sourceFactId: m.sourceFactId, dose: m.dose, unit: m.unit })
        .from(m)
        .where(isNull(m.deletedAt))
        .orderBy(asc(m.createdAt), sql`rowid`)
        .all();
      if (live.length < 2) return;
      type Med = (typeof live)[number];

      // Every placement on these medications, by medication (what made it, and the lines added to it).
      const f = schema.filings;
      const byMed = new Map<string, FilingRow[]>();
      const ids = live.map((x) => x.id);
      for (let i = 0; i < ids.length; i += 400) {
        for (const r of db().select().from(f).where(and(eq(f.targetType, 'medication'), inArray(f.targetId, ids.slice(i, i + 400)))).orderBy(asc(f.createdAt)).all())
          (byMed.get(r.targetId) ?? byMed.set(r.targetId, []).get(r.targetId)!).push(r);
      }
      // The placement that made each medication automatic filing made, still on Claude's word; none when the user
      // confirmed any placement on it by hand.
      const made = new Map<string, FilingRow>();
      const confirmedByHand = new Set<string>();
      for (const [id, rows] of byMed) {
        const auto = rows.some((r) => r.action === 'created' && r.source === 'auto');
        if (rows.some(confirmedByUser)) {
          if (auto) confirmedByHand.add(id);
          continue;
        }
        const mine = rows.find((r) => r.action === 'created' && r.source === 'auto' && onClaudesWord(r));
        if (mine) made.set(id, mine);
      }
      const worked = workedOnSet([...made.values()]);
      const factOf = (r: FilingRow): string | null => {
        const id = parseJson<{ factId?: unknown }>(r.detailJson, {}).factId;
        return typeof id === 'string' ? id : null;
      };
      // History lines automatic filing added to a medication, still standing (not undone, rejected or deleted by hand).
      const standingLines = (id: string) => (byMed.get(id) ?? []).filter((r) => r.action === 'linked' && (r.status === 'pending' || r.status === 'confirmed') && r.decidedBy !== REMOVED_ELSEWHERE);

      // The details that would move, and whether each can be filed again.
      const wanted = new Set<string>();
      for (const [id, mine] of made) {
        const fid = factOf(mine) ?? live.find((x) => x.id === id)?.sourceFactId ?? null;
        if (fid) wanted.add(fid);
        for (const l of standingLines(id)) {
          const lf = factOf(l);
          if (lf) wanted.add(lf);
        }
      }
      const facts = new Map<string, { type: string; status: string; statement: string; attributesJson: string; documentId: string | null; deleted: boolean }>();
      const wantedIds = [...wanted];
      for (let i = 0; i < wantedIds.length; i += 400) {
        for (const r of db()
          .select({ id: schema.facts.id, type: schema.facts.type, status: schema.facts.status, statement: schema.facts.statement, attributesJson: schema.facts.attributesJson, documentId: schema.facts.sourceDocumentId, deletedAt: schema.facts.deletedAt })
          .from(schema.facts)
          .where(inArray(schema.facts.id, wantedIds.slice(i, i + 400)))
          .all())
          facts.set(r.id, { type: r.type, status: r.status, statement: r.statement, attributesJson: r.attributesJson, documentId: r.documentId, deleted: Boolean(r.deletedAt) });
      }
      const docIds = [...new Set([...facts.values()].map((x) => x.documentId).filter((x): x is string => Boolean(x)))];
      const liveDocs = new Set<string>();
      for (let i = 0; i < docIds.length; i += 400) {
        for (const r of db().select({ id: schema.documents.id }).from(schema.documents).where(and(inArray(schema.documents.id, docIds.slice(i, i + 400)), isNull(schema.documents.deletedAt))).all()) liveDocs.add(r.id);
      }
      const canFileAgain = (x: { documentId: string | null; factId: string | null }): boolean => {
        const fact = x.factId ? facts.get(x.factId) : undefined;
        return Boolean(
          fact &&
            x.documentId &&
            !fact.deleted &&
            fact.type === 'medication' &&
            fact.status !== 'disputed' &&
            fact.status !== 'superseded' &&
            fact.documentId === x.documentId &&
            liveDocs.has(x.documentId) &&
            !notMedicationReason(factItemName(fact)),
        );
      };

      const sameDrug = (older: Med, name: string) => sameMedicationName(older.name, name) || Boolean(older.genericName && sameMedicationName(older.genericName, name));
      const current = (status: string) => (CURRENT_STATUSES as readonly string[]).includes(status);
      const hasStop = (x: Med) => x.status === 'stopped' || Boolean(x.stopDate || x.stopDateText);
      // Two doses that differ (150 mg on the older one, 300 mg on this one): merging would drop the newer dose from the
      // medication list and the emergency card, so both stay.
      const doseOf = (x: Med) => `${(x.dose ?? '').toLowerCase().replace(/\s+/g, '')}${(x.unit ?? '').toLowerCase().replace(/\s+/g, '')}`;
      const doseDiffers = (a: Med, b: Med) => Boolean(doseOf(a) && doseOf(b) && doseOf(a) !== doseOf(b));
      const kept: Med[] = [];
      const plans: Array<{ onto: Med; mine: FilingRow; lines: FilingRow[]; details: Array<{ documentId: string; factId: string }> }> = [];
      for (const med of live) {
        const mine = made.get(med.id);
        const older = mine || confirmedByHand.has(med.id) ? kept.filter((o) => sameDrug(o, med.name)) : [];
        if (!mine || !older.length) {
          // One the user confirmed by hand that repeats an older drug is counted as kept.
          if (older.length) out.kept++;
          kept.push(med);
          continue;
        }
        const onto = older[0];
        const lines = standingLines(med.id);
        const all = [{ documentId: mine.documentId, factId: factOf(mine) ?? med.sourceFactId }, ...lines.map((l) => ({ documentId: l.documentId, factId: factOf(l) }))];
        const ok =
          !worked.has(mine.id) &&
          !notMedicationReason(med.name) &&
          older.every((a) => older.every((b) => a === b || sameDrug(a, b.name) || sameDrug(b, a.name))) &&
          !(current(med.status) && !current(onto.status)) &&
          !(hasStop(med) && onto.status !== 'stopped') &&
          !doseDiffers(med, onto) &&
          // The older name is ambiguous when it also stands for another live drug ("Insulin" beside "Insulin (Lantus)"
          // and "Insulin (Humalog)"): two different drugs are never merged into it.
          !live.some((o) => o.id !== med.id && o.id !== onto.id && sameDrug(onto, o.name) && !sameMedicationName(o.name, med.name)) &&
          all.every(canFileAgain);
        if (!ok) {
          out.kept++;
          kept.push(med);
          continue;
        }
        const details: Array<{ documentId: string; factId: string }> = [];
        for (const x of all) if (!details.some((y) => y.factId === x.factId)) details.push({ documentId: x.documentId!, factId: x.factId! });
        plans.push({ onto, mine, lines, details });
      }

      // Each one on its own (a savepoint): taken back through Undo first (so its details are free to file), then its
      // details filed again onto the one kept. Should any detail not move, that one is put back as it was and kept:
      // nothing it said is ever left only in the trash.
      const none = { medications: [] as string[], intolerances: new Set<string>() };
      class NotAllMoved extends Error {}
      for (const p of plans) {
        let moved = 0;
        try {
          db().transaction(() => {
            const by = `${SAME_MEDICATION_AS} ${p.onto.name}`;
            rejectFiling(p.mine.id, by, { status: 'undone' });
            // Its lines went with it (the medication is deleted): their placements are marked undone too, so their
            // details may be filed again (factsAlreadyPlaced).
            for (const l of p.lines) rejectFiling(l.id, by, { status: 'undone' });
            for (const x of p.details) {
              if (factsAlreadyPlaced(x.documentId).has(x.factId)) continue;
              const proposal = proposeFromFacts({ documentId: x.documentId }).find((q) => q.factId === x.factId);
              if (!proposal) continue;
              if (fileMedicationDetail({ documentId: x.documentId, made: [], removedNow: () => none }, proposal, p.onto.id)) moved++;
            }
            if (moved < p.details.length) throw new NotAllMoved();
          });
          out.takenBack++;
          out.linesMoved += moved;
        } catch (err) {
          if (!(err instanceof NotAllMoved)) throw err;
          out.kept++;
        }
      }
    });
    setSetting('migration.medNamesV2', true);
    out.ran = true;
    console.log(
      `[filing] medication names, second step: ${out.takenBack} medication${out.takenBack === 1 ? '' : 's'} listed a second time under another name taken back, ${out.linesMoved} of their detail${out.linesMoved === 1 ? '' : 's'} now history lines on the one kept${out.kept ? `, ${out.kept} kept (worked on, confirmed by hand, or saying something the older one does not)` : ''}`,
    );
  } catch (err) {
    // Rolled back: nothing it counted was kept.
    Object.assign(out, { ran: false, takenBack: 0, kept: 0, linesMoved: 0 });
    out.error = err instanceof Error ? err.message : String(err);
    console.warn(`[filing] medication names cleanup, second step, failed (it runs again on the next unlock): ${out.error}`);
  }
  return out;
}
