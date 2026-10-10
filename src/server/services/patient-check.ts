/**
 * The wrong-patient guard (2026-10-09): someone with the same surname and date of birth, such as a twin, can
 * have records sent in the patient's place, and one wrong upload would poison the lab series. The lead's corrections
 * C1-C7 are folded in.
 *
 * When it runs (no AI unless said):
 * - every new upload, before anything is filed from it: at the end of its segmentation, before its messages, held
 *   records and people are filed (ingest-hooks.ts afterSegmentation), and again before its sorting and reading are
 *   queued (ingest/pipeline.ts): the reading waits for the check;
 * - Claude's sorting step reads the patient printed on the first pages as a second opinion (ingest/triage.ts); a
 *   conflict found with a verified quote holds the document back then, before it is filed, and stops a reading that
 *   already started (its details are hidden, never deleted);
 * - once at the next unlock (and whenever Patient details change) over every document already in the case
 *   (setting migration.patientCheckV1 holds the details it last ran with); when that would hold back more than 3
 *   documents and most of those naming a patient, nothing is held by itself (Patient details are probably wrong) and
 *   Home says so, with "Hold them back".
 *
 * Holding back = the ordinary soft delete (documents.ts deleteDocument) with metadata_json.patientCheck.state
 * 'quarantined': its details are hidden everywhere a deleted document's are (labs, details, timeline, medications,
 * findings, search, the clinician, packets, the lab check, the cross-reference rules), kept in the database. "It's mine"
 * is the ordinary restore (the same soft-delete stamp brings back exactly those details) and carries on what the upload
 * was doing (sorting, reading); it is remembered: never held again for the same pages. "Not my record" moves it to the
 * trash with the reason "wrong patient" and an audit entry; Restore brings it back held, never trusted; purge is the
 * normal path from the trash.
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { getSetting, setSetting } from './settings';
import { deleteDocument, getDocument, listDocuments, onDocumentDeletedOrRestored, requestExtraction, restoreDocument, type DocumentDetail } from './documents';
import { AUTOMATIC, READ_STATUSES, autoFileAfterClassification, autoFileAfterExtraction, listFilings, rejectFiling } from './filing';
import { runLabChecks } from './lab-rules';
import { enqueueRulesAfterIngest, type JobHandler } from '../jobs/queue';
import { writeAudit } from './audit';
import { conflict, notFound } from '../util/errors';
import { nowIso, parseJson } from '../util/ids';
import { pageReading } from '../ingest/reflow';
import { locateCitation } from '../ai/citations';
import { aiEnabled, getApiKey } from '../ai/client';
import { pageTextLookupFor } from './facts';
import { heldState, patientCheckOfRow, QUARANTINED_SQL, quarantinedCount, writePatientCheck } from './patient-check-state';
import type { UploadConfirmation } from '../../shared/schemas/segments';
import {
  HELD_WORDS,
  PATIENT_CHECK_VERSION,
  WRONG_PATIENT_REASON,
  checkWords,
  heldWords,
  identitySignature,
  judgeDocument,
  judgePage,
  myIdentity,
  numberKey,
  type DocumentVerdict,
  type FoundField,
  type IdentitySettings,
  type PageLines,
  type PatientCheck,
  type PatientCheckTrigger,
  type RecordNumber,
  type SortingOpinion,
} from '../../shared/patient-identity';

type DocRow = typeof schema.documents.$inferSelect;

/** Jobs that store a document's pages: never stopped by the guard they call. */
export const STORING_JOBS = ['ingest_document', 'reingest_document', 'segment_document'] as const;
/** At most this many conflicting pages are kept on a document. */
const MAX_PAGES_KEPT = 5000;
/** The sweep holds nothing by itself when it would hold more than this many documents and most of those naming a patient. */
const SWEEP_VALVE_MIN = 3;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Patient details from Settings, as the check reads them. */
export function identitySettings(): IdentitySettings {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const nums = getSetting('patient.recordNumbers');
  return {
    name: String(getSetting('patient.name') ?? ''),
    dob: String(getSetting('patient.dob') ?? ''),
    otherFirstNames: list(getSetting('patient.otherFirstNames')),
    confusedWith: list(getSetting('patient.confusedWith')),
    recordNumbers: Array.isArray(nums) ? nums.filter((n): n is RecordNumber => Boolean(n) && typeof n.number === 'string').map((n) => ({ number: n.number, system: typeof n.system === 'string' ? n.system : '' })) : [],
  };
}

function aiUsable(): boolean {
  try {
    return aiEnabled() && Boolean(getApiKey());
  } catch {
    return false;
  }
}

/** The health system a document comes from, when the document or its sorting says (for record numbers, C1). */
export function documentSystem(doc: Pick<DocRow, 'metadataJson' | 'institutionId'>): string | null {
  const meta = parseJson<Record<string, unknown>>(doc.metadataJson, {});
  const exp = meta.export as { institutionText?: unknown } | undefined;
  if (typeof exp?.institutionText === 'string' && exp.institutionText.trim()) return exp.institutionText.trim();
  const furn = (meta.segmentation as { furniture?: { institutionText?: unknown } } | undefined)?.furniture;
  if (typeof furn?.institutionText === 'string' && furn.institutionText.trim()) return furn.institutionText.trim();
  if (doc.institutionId) {
    const p = db().select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, doc.institutionId)).get();
    if (p?.name) return p.name;
  }
  const triage = meta.triage as { institution?: { new_name?: unknown; match_id?: unknown } } | undefined;
  if (typeof triage?.institution?.new_name === 'string' && triage.institution.new_name.trim()) return triage.institution.new_name.trim();
  if (typeof triage?.institution?.match_id === 'string') {
    const p = db().select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, triage.institution.match_id)).get();
    if (p?.name) return p.name;
  }
  return null;
}

const PAGE_BATCH = 100;

/** The document's pages in reading order, one batch at a time (rows rebuilt from line boxes where there are any). */
export function* pageLinesOf(documentId: string): Generator<PageLines> {
  const P = schema.documentPages;
  for (let offset = 0; ; offset += PAGE_BATCH) {
    const rows = db().select({ page: P.pageNumber, text: P.text, boxesJson: P.boxesJson }).from(P).where(eq(P.documentId, documentId)).orderBy(asc(P.pageNumber)).limit(PAGE_BATCH).offset(offset).all();
    if (!rows.length) return;
    for (const r of rows) {
      // OCR word boxes carry a confidence ("c"): their text is already in reading order, and they are large.
      const ocrBoxes = !r.boxesJson || /"c"\s*:/.test(r.boxesJson.slice(0, 400));
      if (ocrBoxes) {
        yield { page: r.page, lines: (r.text ?? '').split('\n') };
        continue;
      }
      const reading = pageReading({ text: r.text ?? '', boxesJson: r.boxesJson });
      yield { page: r.page, lines: [...reading.rows.map((x) => x.text), ...(reading.ocr ? reading.ocr.split('\n') : [])] };
    }
    if (rows.length < PAGE_BATCH) return;
  }
}

function emptyCheck(at: string, by: PatientCheckTrigger, details: string): PatientCheck {
  return { v: PATIENT_CHECK_VERSION, at, by, details, result: 'unconfirmed', why: 'no_identity', pagesScanned: 0, conflictPages: [], conflicts: [], confirmedPages: [], newNumbers: [], system: null, sorting: null, state: 'clear', quarantine: null, decision: null };
}

export interface DecideContext {
  at: string;
  by: PatientCheckTrigger;
  details: string;
  system: string | null;
  /** Hold back on a new conflict (false: the sweep's valve; the conflict is kept as `unheld`). */
  hold: boolean;
  resume: { sort: boolean; read: boolean };
}

/**
 * What a fresh scan makes of a document's check (pure). A held document stays held until the user answers; "It's mine"
 * is remembered: held again only when a conflicting page appears that he has not answered for.
 */
export function decide(prev: PatientCheck | null, verdict: DocumentVerdict, ctx: DecideContext): { check: PatientCheck; hold: boolean } {
  const base: PatientCheck = {
    v: PATIENT_CHECK_VERSION,
    at: ctx.at,
    by: ctx.by,
    details: ctx.details,
    result: verdict.result,
    why: verdict.why,
    pagesScanned: verdict.pagesScanned,
    conflictPages: verdict.conflictPages.slice(0, MAX_PAGES_KEPT),
    conflicts: verdict.conflicts,
    confirmedPages: verdict.confirmedPages,
    newNumbers: verdict.newNumbers,
    system: ctx.system,
    sorting: prev?.sorting ?? null,
    state: prev?.state ?? 'clear',
    quarantine: prev?.quarantine ?? null,
    decision: prev?.decision ?? null,
  };
  // Claude's sorting found the patient's own name, word for word on the page: that confirms what the labels could not.
  if (base.result === 'unconfirmed' && base.why !== 'no_details' && base.sorting?.verified && base.sorting.confirms) {
    base.result = 'confirmed';
    base.why = null;
  }
  const holdNow = (pages: number[]): { check: PatientCheck; hold: boolean } => ({
    check: { ...base, state: 'quarantined', decision: null, quarantine: { at: ctx.at, by: ctx.by, pages: pages.slice(0, MAX_PAGES_KEPT), resume: ctx.resume } },
    hold: true,
  });
  switch (base.state) {
    case 'not_mine':
      return { check: base, hold: false };
    case 'quarantined':
      return { check: base, hold: false };
    case 'mine': {
      const answered = new Set(base.decision?.pages ?? []);
      const fresh = verdict.conflictPages.filter((p) => !answered.has(p));
      if (fresh.length && ctx.hold) return holdNow(verdict.conflictPages);
      return { check: fresh.length ? { ...base, unheld: true } : base, hold: false };
    }
    default: {
      if (verdict.result !== 'conflict') return { check: { ...base, state: 'clear' }, hold: false };
      // Left by a sweep (most of the case named someone else): only "Hold them back", new pages or new details hold it.
      const known = new Set(prev?.conflictPages ?? []);
      const leftBefore = Boolean(prev?.unheld) && prev?.details === ctx.details && verdict.conflictPages.every((p) => known.has(p));
      if (ctx.hold && !leftBefore) return holdNow(verdict.conflictPages);
      return { check: { ...base, state: 'clear', unheld: true }, hold: false };
    }
  }
}

/** What the document was going to do next, from its row (the pipeline passes its own plan instead). */
function resumeOf(row: DocRow): { sort: boolean; read: boolean } {
  const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
  const reading = db()
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, row.id), inArray(schema.jobs.type, ['extract_facts', 'resume_extraction']), inArray(schema.jobs.status, ['queued', 'running'])))
    .get();
  return { sort: !meta.triage, read: Boolean(reading) || ['queued', 'running'].includes(row.extractionStatus) };
}

/** decided_by of the placements the guard took back (status `undone`: filing may make them again after "It's mine"). */
export const TAKEN_BACK_BY = "held back as someone else's record";

/**
 * What Claude placed from the document (medications, visits, calls), taken back as "Set this copy aside" does (status
 * `undone`), when the document is held back or said not to be the user's (review 2026-10-09: another person's medication stayed on
 * the list and the emergency card). What the user confirmed himself stays, and so do items he worked on since (the app's
 * one-click rule) and every allergy (the rule: a missing allergy can hurt, an extra one cannot): counted as `kept`, and
 * the held document says so. Never throws.
 */
function takeBackPlacements(documentId: string): { filingIds: string[]; kept: number } {
  const out = { filingIds: [] as string[], kept: 0 };
  try {
    for (const f of listFilings({ documentId })) {
      const claudes = f.status === 'pending' || (f.status === 'confirmed' && f.decidedBy === AUTOMATIC);
      if (!claudes || f.targetType === 'document') continue;
      if (f.targetType === 'intolerance') {
        if (!f.targetGone) out.kept++;
        continue;
      }
      if (!f.undoable) {
        if (f.workedOn && !f.targetGone) out.kept++;
        continue;
      }
      try {
        rejectFiling(f.id, TAKEN_BACK_BY, { status: 'undone', guardWork: true });
        out.filingIds.push(f.id);
      } catch {
        out.kept++;
      }
    }
  } catch (err) {
    console.warn(`[patient-check] taking back what was filed from ${documentId}: ${messageOf(err)}`);
  }
  return out;
}

/** The findings rules and the lab checks again, after details were hidden or came back (no AI; never throws). */
function recheckFindings(ids: string[]): void {
  try {
    enqueueRulesAfterIngest(ids, 'reprocess');
  } catch (err) {
    console.warn(`[patient-check] findings rules: ${messageOf(err)}`);
  }
  try {
    runLabChecks({ trigger: 'manual' });
  } catch (err) {
    console.warn(`[patient-check] lab checks: ${messageOf(err)}`);
  }
}

/**
 * Holds a live document back: the check is written first, then the ordinary soft delete, then what Claude filed from it
 * is taken back, then the audit row. True when it had details or placements (the findings are checked again here, or
 * once for all by the caller with `recheck: false`).
 */
function holdBack(row: DocRow, check: PatientCheck, keepRunningTypes: readonly string[], opts: { recheck?: boolean } = {}): boolean {
  writePatientCheck(row.id, check);
  let factsDeleted = 0;
  try {
    factsDeleted = deleteDocument(row.id, { keepRunningTypes }).factsDeleted;
  } catch (err) {
    // Deleted meanwhile (by the user): it is an ordinary deleted document, not a held one.
    console.warn(`[patient-check] could not hold back ${row.id}: ${messageOf(err)}`);
    writePatientCheck(row.id, { ...check, state: 'clear', quarantine: null });
    return false;
  }
  const taken = takeBackPlacements(row.id);
  if (taken.filingIds.length || taken.kept) writePatientCheck(row.id, { ...check, takenBack: taken });
  const n = check.quarantine?.pages.length ?? 0;
  const back = taken.filingIds.length ? `; ${taken.filingIds.length} placement${taken.filingIds.length === 1 ? '' : 's'} taken back` : '';
  writeAudit({ action: 'quarantine', entityType: 'document', entityId: row.id, summary: `${HELD_WORDS}: ${n} page${n === 1 ? '' : 's'} (${check.quarantine?.by ?? check.by})${back}` });
  const changed = factsDeleted > 0 || taken.filingIds.length > 0;
  if (changed && opts.recheck !== false) recheckFindings([row.id]);
  return changed;
}

export interface CheckOptions {
  by: PatientCheckTrigger;
  /** Running jobs of these types are not stopped when the document is held back (the caller's own job). */
  keepRunningTypes?: readonly string[];
  /** What the upload was going to do next (kept so "It's mine" carries on); default: worked out from the document. */
  resume?: { sort: boolean; read: boolean };
  /** False: never hold back here (the sweep decides for itself). */
  hold?: boolean;
}

/** Scan one document (no AI) and hold it back on a new conflict. Never throws; null when there is no such document. */
export function checkDocument(documentId: string, opts: CheckOptions): PatientCheck | null {
  try {
    const row = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row) return null;
    const prev = patientCheckOfRow(row);
    // In the trash (deleted by the user, or "Not my record"): nothing to check.
    if (row.deletedAt && heldState(row) !== 'quarantined') return prev;
    const settings = identitySettings();
    const me = myIdentity(settings);
    const system = documentSystem(row);
    const verdict = judgeDocument(pageLinesOf(documentId), me, system);
    const { check, hold } = decide(prev, verdict, { at: nowIso(), by: opts.by, details: identitySignature(settings), system, hold: opts.hold !== false, resume: opts.resume ?? resumeOf(row) });
    if (hold && !row.deletedAt) holdBack(row, check, opts.keepRunningTypes ?? []);
    else writePatientCheck(documentId, check);
    return check;
  } catch (err) {
    console.warn(`[patient-check] could not check ${documentId}: ${messageOf(err)}`);
    return null;
  }
}

/** True while the document is held back as "May be someone else's record". */
export function isHeld(documentId: string): boolean {
  try {
    const row = db().select({ deletedAt: schema.documents.deletedAt, metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    return Boolean(row) && heldState(row!) === 'quarantined';
  } catch {
    return false;
  }
}

/**
 * The guard at the end of a segmentation (ingest-hooks.ts afterSegmentation), before the messages, held records and
 * people of the document are filed: true when it is held back (the hook then files nothing). Never throws.
 */
export function holdsBeforeDetails(documentId: string): boolean {
  checkDocument(documentId, { by: 'segmentation', keepRunningTypes: STORING_JOBS });
  return isHeld(documentId);
}

/**
 * The guard of a new upload once its pages are stored (ingest/pipeline.ts), before its sorting and reading are queued:
 * checked now unless the segmentation already did since `since`; true when it is held back, with what the upload was
 * going to do kept for "It's mine". Never throws.
 */
export function holdsBeforeReading(documentId: string, opts: { since: string; resume: { sort: boolean; read: boolean } }): boolean {
  try {
    const row = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row) return false;
    const c = patientCheckOfRow(row);
    if (!c || c.at < opts.since) checkDocument(documentId, { by: 'ingest', keepRunningTypes: STORING_JOBS, resume: opts.resume });
    else if (heldState(row) === 'quarantined' && c.quarantine) writePatientCheck(documentId, { ...c, quarantine: { ...c.quarantine, resume: opts.resume } });
    return isHeld(documentId);
  } catch (err) {
    console.warn(`[patient-check] before reading ${documentId}: ${messageOf(err)}`);
    return false;
  }
}

/**
 * Before a sorting or reading job reads a document (jobs/handlers.ts guardedJob; review 2026-10-09): a document never
 * checked against the current Patient details is checked first, and when the details changed (or at the first unlock
 * with the guard, whose sweep otherwise runs 8 s after the job worker starts) the whole case is checked first, once.
 * True when the document is held back: the job then reads nothing. Never throws.
 */
export function heldBeforeJob(documentId: string | null | undefined, jobType: string): boolean {
  if (!documentId) return false;
  try {
    const settings = identitySettings();
    // Without a name and a date of birth nothing can be compared (Home asks for them).
    if (myIdentity(settings).missing.length) return false;
    const details = identitySignature(settings);
    if (getSetting('migration.patientCheckV1') !== details) sweepDocuments({ by: 'unlock' });
    const row = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row) return false;
    if (row.deletedAt) return heldState(row) === 'quarantined';
    const c = patientCheckOfRow(row);
    if (!c || c.details !== details) checkDocument(documentId, { by: 'ingest', keepRunningTypes: [jobType] });
    return isHeld(documentId);
  } catch (err) {
    console.warn(`[patient-check] before ${jobType} of ${documentId}: ${messageOf(err)}`);
    return false;
  }
}

/** A sorting or reading job that first asks heldBeforeJob (registered in jobs/handlers.ts). */
export function guardedJob<P>(handler: JobHandler<P>): JobHandler<P> {
  return async (ctx) => (heldBeforeJob(ctx.job.documentId, ctx.job.type) ? { skipped: "held back: it may be someone else's record" } : handler(ctx));
}

/**
 * A document restored from Deleted documents that was never checked against the current Patient details (deleted
 * before the guard, so the sweep left it): checked now, so its details do not come back unchecked (review 2026-10-09).
 * "It's mine" (still held while it restores) and "Not my record" (comes back held) are left to their own steps.
 */
function checkAfterRestore(documentId: string, event: 'deleted' | 'restored'): void {
  if (event !== 'restored') return;
  const row = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!row || row.deletedAt) return;
  const c = patientCheckOfRow(row);
  if (c?.state === 'quarantined' || c?.state === 'not_mine') return;
  const settings = identitySettings();
  if (myIdentity(settings).missing.length) return;
  if (!c || c.details !== identitySignature(settings)) checkDocument(documentId, { by: 'user' });
}
onDocumentDeletedOrRestored(checkAfterRestore);

/** The patient as Claude's sorting step read it (triageOutput.patient): empty strings and page 0 when not printed. */
export interface SortingPatient {
  name?: string | null;
  date_of_birth?: string | null;
  record_number?: string | null;
  page?: number | null;
  quote?: string | null;
}

/**
 * Claude's sorting step's reading of the patient, a second opinion (C3/C4): kept on the document with its quote and
 * whether the quote is on the page. A conflict with a verified quote holds the document back now (a reading that
 * already started is stopped and its details hidden); returns true when the document is held. Never throws.
 */
export function checkSortingOpinion(documentId: string, patient: SortingPatient | null | undefined, opts: { keepRunningTypes?: readonly string[] } = {}): boolean {
  try {
    // A document never scanned (sorted again from before the guard): the scan of every page comes first.
    const before = db().select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (before && !patientCheckOfRow(before)) checkDocument(documentId, { by: 'sorting', keepRunningTypes: opts.keepRunningTypes ?? ['triage_document'] });
    const row = db().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!row || row.deletedAt) return Boolean(row) && heldState(row!) === 'quarantined';
    const at = nowIso();
    const settings = identitySettings();
    const me = myIdentity(settings);
    const name = (patient?.name ?? '').trim() || null;
    const dob = (patient?.date_of_birth ?? '').trim() || null;
    const mrn = (patient?.record_number ?? '').trim() || null;
    const quote = (patient?.quote ?? '').trim() || null;
    const page = Number.isInteger(patient?.page) && (patient?.page ?? 0) >= 1 ? (patient!.page as number) : null;
    const prev = patientCheckOfRow(row) ?? emptyCheck(at, 'sorting', identitySignature(settings));
    const fields: FoundField[] = [];
    if (name) fields.push({ page: page ?? 1, kind: 'name', value: name.slice(0, 80), source: 'sorting' });
    if (dob) fields.push({ page: page ?? 1, kind: 'dob', value: dob.slice(0, 80), source: 'sorting' });
    if (mrn) fields.push({ page: page ?? 1, kind: 'mrn', value: mrn.slice(0, 40), source: 'sorting' });
    const judged = me.missing.length || !fields.length ? null : judgePage(page ?? 1, fields, me, documentSystem(row));
    // Verified when the quote (else the name itself) is found on the page it names (page ±1), as for every citation.
    const probe = quote ?? name;
    const verified = Boolean(probe && page && locateCitation(pageTextLookupFor(documentId), page, probe));
    const opinion: SortingOpinion = { at, name, dob, mrn, page, quote: quote?.slice(0, 300) ?? null, verified, reasons: judged?.reasons ?? [], confusedWith: judged?.confusedWith ?? null, confirms: Boolean(judged?.confirms) };
    const next: PatientCheck = { ...prev, sorting: opinion };
    if (next.result === 'unconfirmed' && next.why !== 'no_details' && verified && opinion.confirms) {
      next.result = 'confirmed';
      next.why = null;
    }
    // Only a conflict printed on the page holds the document back; the user's "It's mine" stands against the sorting.
    if (opinion.reasons.length && verified && next.state === 'clear') {
      holdBack(row, { ...next, state: 'quarantined', decision: null, quarantine: { at, by: 'sorting', pages: [page!], resume: resumeOf(row) } }, opts.keepRunningTypes ?? ['triage_document']);
      return true;
    }
    writePatientCheck(documentId, next);
    return false;
  } catch (err) {
    console.warn(`[patient-check] the sorting's reading of ${documentId}: ${messageOf(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The user's answers
// ---------------------------------------------------------------------------

export interface MineResult {
  ok: true;
  document: DocumentDetail;
  /** What carried on: the sorting, the reading, or nothing. */
  carriedOn: 'sorting' | 'reading' | null;
  /** Record numbers printed on it from places not on the patient's list: "Add this record number to my list". */
  newNumbers: Array<{ number: string; page: number }>;
  system: string | null;
}

/** "It's mine": the document and its details come back, it is trusted from now on, and what the upload was doing carries on. */
export async function markMine(id: string, actor: { name: string } | null): Promise<MineResult> {
  const row = db().select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!row) throw notFound('document not found');
  const c = patientCheckOfRow(row);
  if (!row.deletedAt && c?.state === 'mine') return { ok: true, document: getDocument(id), carriedOn: null, newNumbers: unknownNumbers(c.newNumbers), system: c.system };
  if (heldState(row) !== 'quarantined' || !c) throw conflict('This document is not held back.');
  const storing = db().select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.documentId, id), inArray(schema.jobs.type, [...STORING_JOBS]), eq(schema.jobs.status, 'running'))).get();
  if (storing) throw conflict('Its pages are still being stored. Try again in a moment.');
  const before = row.extractionStatus;
  restoreDocument(id, { asMine: true });
  const at = nowIso();
  const pages = [...new Set([...c.conflictPages, ...(c.quarantine?.pages ?? []), ...(c.sorting?.reasons.length && c.sorting.page ? [c.sorting.page] : [])])].sort((a, b) => a - b).slice(0, MAX_PAGES_KEPT);
  const { unheld: _unheld, takenBack, ...rest } = c;
  writePatientCheck(id, { ...rest, state: 'mine', quarantine: null, decision: { kind: 'mine', at, by: actor?.name ?? null, pages } }, { deleteReason: undefined });
  writeAudit({ userName: actor?.name ?? null, action: 'mine', entityType: 'document', entityId: id, summary: `It's mine: ${pages.length} page${pages.length === 1 ? '' : 's'} answered for` });
  // What the hold took back is filed again (status `undone` lets filing make it again), then the findings follow.
  if (takenBack?.filingIds.length) refile(id);
  if (takenBack?.filingIds.length || hasLiveFacts(id)) recheckFindings([id]);
  const carriedOn = await carryOn(id, c.quarantine?.resume ?? { sort: false, read: false }, before);
  return { ok: true, document: getDocument(id), carriedOn, newNumbers: unknownNumbers(c.newNumbers), system: c.system };
}

/** Filing again what the hold took back (as a restored copy is filed again; never throws). */
function refile(id: string): void {
  try {
    const row = db().select({ deletedAt: schema.documents.deletedAt, extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(eq(schema.documents.id, id)).get();
    if (!row || row.deletedAt) return;
    autoFileAfterClassification(id);
    if (READ_STATUSES.has(row.extractionStatus)) autoFileAfterExtraction(id);
  } catch (err) {
    console.warn(`[patient-check] filing again after It's mine for ${id}: ${messageOf(err)}`);
  }
}

function hasLiveFacts(id: string): boolean {
  return Boolean(db().select({ id: schema.facts.id }).from(schema.facts).where(and(eq(schema.facts.sourceDocumentId, id), isNull(schema.facts.deletedAt))).get());
}

function unknownNumbers(list: Array<{ number: string; page: number }>): Array<{ number: string; page: number }> {
  const mine = new Set(identitySettings().recordNumbers.map((n) => numberKey(n.number)));
  return list.filter((n) => !mine.has(numberKey(n.number)));
}

/** After "It's mine": what the guard held back (messages, held records, people), then the sorting and reading the upload asked for. */
async function carryOn(id: string, resume: { sort: boolean; read: boolean }, before: string): Promise<'sorting' | 'reading' | null> {
  try {
    const segments = db().select({ id: schema.documentSegments.id }).from(schema.documentSegments).where(and(eq(schema.documentSegments.documentId, id), isNull(schema.documentSegments.supersededAt))).get();
    if (segments) {
      const hooks = await import('./ingest-hooks');
      await hooks.afterSegmentation(id, { documentId: id, reason: 'unlock', segmenterVersion: 0, segments: { created: 0, superseded: 0, kept: 0, total: 0 }, toParse: [], ocrPages: [] });
    }
  } catch (err) {
    console.warn(`[patient-check] messages after It's mine for ${id}: ${messageOf(err)}`);
  }
  if (!aiUsable() || (!resume.sort && !resume.read)) return null;
  const row = db().select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!row || row.deletedAt || row.pageCount < 1) return null;
  // The restore marks a reading it cut short as failed; the reading asked for at upload starts from where it was.
  if (resume.read && row.extractionStatus === 'failed' && ['none', 'queued', 'running'].includes(before)) {
    db().update(schema.documents).set({ extractionStatus: 'none', updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
  }
  const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
  if (resume.sort && !meta.triage) {
    const { continueAfterIngest } = await import('../ingest/pipeline');
    continueAfterIngest(id, { autoExtract: resume.read, thenTriage: true });
    return 'sorting';
  }
  if (resume.read) {
    try {
      requestExtraction(id, { scope: 'missing' });
      return 'reading';
    } catch (err) {
      console.warn(`[patient-check] reading after It's mine for ${id}: ${messageOf(err)}`);
    }
  }
  return null;
}

/** "Not my record": the document goes to the trash with the reason "wrong patient" (soft delete; Restore brings it back held). */
export function markNotMine(id: string, actor: { name: string } | null): { ok: true; kept: number } {
  const row = db().select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!row) throw notFound('document not found');
  const held = heldState(row);
  if (held === 'not_mine') return { ok: true, kept: patientCheckOfRow(row)?.takenBack?.kept ?? 0 };
  if (row.deletedAt && held !== 'quarantined') throw conflict('It is already in Deleted documents.');
  const at = nowIso();
  const c = patientCheckOfRow(row) ?? emptyCheck(at, 'user', identitySignature(identitySettings()));
  let takenBack = c.takenBack;
  if (!row.deletedAt) {
    // A live document said not to be the user's: its details go with it, and what Claude filed from it is taken back.
    const factsDeleted = deleteDocument(id).factsDeleted;
    const taken = takeBackPlacements(id);
    if (taken.filingIds.length || taken.kept) takenBack = taken;
    if (factsDeleted || taken.filingIds.length) recheckFindings([id]);
  }
  const { unheld: _unheld, takenBack: _taken, ...rest } = c;
  writePatientCheck(id, { ...rest, ...(takenBack ? { takenBack } : {}), state: 'not_mine', quarantine: c.quarantine ?? null, decision: { kind: 'not_mine', at, by: actor?.name ?? null, pages: c.conflictPages.slice(0, MAX_PAGES_KEPT) } }, { deleteReason: WRONG_PATIENT_REASON });
  writeAudit({ userName: actor?.name ?? null, action: 'not_mine', entityType: 'document', entityId: id, summary: `Not my record: moved to Deleted documents (reason: ${WRONG_PATIENT_REASON})` });
  return { ok: true, kept: takenBack?.kept ?? 0 };
}

/** "Add this record number to my list" (after "It's mine"). */
export function addRecordNumber(number: string, system: string, actor: { name: string } | null): RecordNumber[] {
  const list = [...identitySettings().recordNumbers];
  const key = numberKey(number);
  if (key.length < 3) throw conflict('That does not look like a record number.');
  if (!list.some((n) => numberKey(n.number) === key && n.system.trim().toLowerCase() === system.trim().toLowerCase())) list.push({ number: number.trim(), system: system.trim() });
  setSetting('patient.recordNumbers', list.slice(0, 50));
  writeAudit({ userName: actor?.name ?? null, action: 'settings', entityType: 'settings', entityId: 'patient.recordNumbers', summary: 'Added a record number to Patient details' });
  return list;
}

// ---------------------------------------------------------------------------
// Every document already in the case
// ---------------------------------------------------------------------------

export interface SweepResult {
  checked: number;
  /** Held back by this sweep. */
  held: number;
  /** Would have been held back, but they were most of the documents naming a patient: left as they are (see Home). */
  unheld: number;
  missing: Array<'name' | 'dob'>;
}

/**
 * Checks every document in the case (live or held). When it would hold back more than SWEEP_VALVE_MIN documents and
 * more than half of those naming a patient, nothing is held by itself: Patient details are more likely wrong than most
 * of the case someone else's. Records the details it ran with (migration.patientCheckV1).
 */
export function sweepDocuments(opts: { by: PatientCheckTrigger; isUnlocked?: () => boolean } = { by: 'unlock' }): SweepResult | null {
  const settings = identitySettings();
  const me = myIdentity(settings);
  const details = identitySignature(settings);
  const rows = db()
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(or(isNull(schema.documents.deletedAt), QUARANTINED_SQL))
    .orderBy(asc(schema.documents.createdAt))
    .all();
  const plans: Array<{ id: string; verdict: DocumentVerdict; system: string | null }> = [];
  let naming = 0;
  let wouldHold = 0;
  for (const { id } of rows) {
    if (opts.isUnlocked && !opts.isUnlocked()) return null;
    const row = db().select().from(schema.documents).where(eq(schema.documents.id, id)).get();
    if (!row) continue;
    const system = documentSystem(row);
    const verdict = judgeDocument(pageLinesOf(id), me, system);
    // Of the documents that could be held now (live), those naming a patient.
    if (verdict.seen && !row.deletedAt) naming++;
    if (!row.deletedAt && decide(patientCheckOfRow(row), verdict, { at: '', by: opts.by, details, system, hold: true, resume: { sort: false, read: false } }).hold) wouldHold++;
    plans.push({ id, verdict, system });
  }
  const valve = wouldHold > SWEEP_VALVE_MIN && wouldHold * 2 > naming;
  let held = 0;
  const changedIds: string[] = [];
  for (const p of plans) {
    if (opts.isUnlocked && !opts.isUnlocked()) return null;
    try {
      const row = db().select().from(schema.documents).where(eq(schema.documents.id, p.id)).get();
      if (!row) continue;
      const { check, hold } = decide(patientCheckOfRow(row), p.verdict, { at: nowIso(), by: opts.by, details, system: p.system, hold: !valve, resume: resumeOf(row) });
      if (hold && !row.deletedAt) {
        if (holdBack(row, check, [], { recheck: false })) changedIds.push(p.id);
        held++;
      } else writePatientCheck(p.id, check);
    } catch (err) {
      console.warn(`[patient-check] sweep, ${p.id}: ${messageOf(err)}`);
    }
  }
  setSetting('migration.patientCheckV1', details);
  if (changedIds.length) recheckFindings(changedIds);
  return { checked: plans.length, held, unheld: valve ? wouldHold : 0, missing: me.missing };
}

/** Once per change of Patient details (and of the check's rules), at unlock. Never throws; null when nothing ran. */
export function patientCheckAfterUnlock(isUnlocked: () => boolean = () => true): SweepResult | null {
  try {
    if (!isUnlocked()) return null;
    const details = identitySignature(identitySettings());
    if (getSetting('migration.patientCheckV1') === details) return null;
    const r = sweepDocuments({ by: 'unlock', isUnlocked });
    if (r && (r.held || r.unheld)) console.log(`[patient-check] after unlock: ${r.checked} documents checked, ${r.held} held back as someone else's, ${r.unheld} left (most documents named someone else)`);
    return r;
  } catch (err) {
    console.warn(`[patient-check] after unlock: ${messageOf(err)}`);
    return null;
  }
}

/** "Hold them back": the documents the sweep left because they were most of the case. */
export function holdUnheld(actor: { name: string } | null): { held: number } {
  const rows = db()
    .select()
    .from(schema.documents)
    .where(and(isNull(schema.documents.deletedAt), sql`instr(${schema.documents.metadataJson}, '"unheld":true') > 0`))
    .all();
  let held = 0;
  const changedIds: string[] = [];
  for (const row of rows) {
    const c = patientCheckOfRow(row);
    if (!c?.unheld || !c.conflictPages.length) continue;
    const { unheld: _u, ...rest } = c;
    if (holdBack(row, { ...rest, state: 'quarantined', decision: null, quarantine: { at: nowIso(), by: 'user', pages: c.conflictPages, resume: resumeOf(row) } }, [], { recheck: false })) changedIds.push(row.id);
    held++;
  }
  if (changedIds.length) recheckFindings(changedIds);
  if (held) writeAudit({ userName: actor?.name ?? null, action: 'quarantine', entityType: 'document', summary: `Held back ${held} document${held === 1 ? '' : 's'} as ${HELD_WORDS}` });
  return { held };
}

// ---------------------------------------------------------------------------
// What the pages show
// ---------------------------------------------------------------------------

export interface HeldItem {
  id: string;
  title: string;
  filename: string;
  category: string;
  pageCount: number;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  createdAt: string;
  heldAt: string | null;
  /** "p.212-219 look like someone else's: another first name." */
  words: string;
  check: PatientCheck;
}

/** The documents held back, newest first. */
export function listHeld(): HeldItem[] {
  return listDocuments({ patient: 'only', sort: '-added', limit: 5000 }).map((d) => {
    const check = patientCheckOfRow(d)!;
    return {
      id: d.id,
      title: d.title,
      filename: d.filename,
      category: d.category,
      pageCount: d.pageCount,
      documentDate: d.documentDate,
      documentDatePrecision: d.documentDatePrecision,
      documentDateText: d.documentDateText,
      createdAt: d.createdAt,
      heldAt: check?.quarantine?.at ?? d.deletedAt,
      words: check ? heldWords(check) : '',
      check,
    };
  });
}

export interface PatientCheckSummary {
  held: number;
  /** Left by the sweep because they were most of the case (Home offers "Hold them back"). */
  unheld: number;
  /** What Patient details still need before anything can be compared. */
  missing: Array<'name' | 'dob'>;
}

export function patientCheckSummary(): PatientCheckSummary {
  const unheld = Number(
    db()
      .select({ n: sql<number>`count(*)` })
      .from(schema.documents)
      .where(and(isNull(schema.documents.deletedAt), sql`instr(${schema.documents.metadataJson}, '"unheld":true') > 0`))
      .get()?.n ?? 0,
  );
  return { held: quarantinedCount(), unheld, missing: myIdentity(identitySettings()).missing };
}

/** The document's check for its page (the upload record), or null. */
export function documentCheck(id: string): PatientCheck | null {
  const row = db().select({ metadataJson: schema.documents.metadataJson, sourceTier: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, id)).get();
  const c = row ? patientCheckOfRow(row) : null;
  // The patient's own notes rarely print a patient's name: never "Patient not confirmed on document" (My notes, 2026-10-09).
  return c && row?.sourceTier === 'patient' ? { ...c, ownNotes: true } : c;
}

/**
 * The upload banner's confirmation with the guard's line (the rule: show "Patient not confirmed on document" on the upload
 * record). A held document settles at once: nothing is read from it, and the line says why.
 */
export function withPatientNote(c: UploadConfirmation): UploadConfirmation {
  const check = documentCheck(c.documentId);
  if (!check) return c;
  if (check.state === 'quarantined') {
    return { ...c, stage: 'not_requested', complete: false, held: true, patientNote: heldWords(check), sentence: `Held back: it may be someone else's record. Nothing was read or filed from it; Check before filing asks you whose it is.` };
  }
  const w = checkWords(check);
  return { ...c, patientNote: w.tone === 'unconfirmed' ? w.text : null };
}
