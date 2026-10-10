/**
 * What holds a fact the model read (2026-10-07; moved out of ai/extraction.ts so the extraction engine and the
 * messaging-act clean-up in services/messages-import.ts apply the same test, review rev-engine F3):
 * - the user's own work on it (`hasUserWork`): an edit, a verdict note, an override decided by hand, an "unsure"
 *   answer, or "Not the same event" in Reconciliation;
 * - a link from another ledger by its id (`linkedFactIds`).
 * Neither is ever replaced, retired or set aside by an automatic pass.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { CLINICAL_RECORD_REASON, CLINICAL_RECORD_RULE, passSetAsideSql } from './reconcile';
import { AUTO_CLEARED_PREFIX } from './findings';

/**
 * Ids, among this document's live unverified AI facts (and copies the
 * clinical-record pass set aside, which a re-run also replaces), that
 * something else points at: a ledger row (lab result, medication, intolerance, medication
 * event, imaging study, records-inventory row, task, evidence of a live
 * finding), another fact superseded by it, or an override the user set by
 * hand. Retiring them would orphan those links and let "from facts" import
 * the re-extracted copy a second time.
 *
 * Two links do not hold a fact: a copy the clinical-record pass set aside as
 * replaced by it, and the evidence of that pass's own finding while it is open
 * or cleared automatically and carries no note of the user's. Both are
 * re-pointed to the re-extracted facts by the pass after the run
 * (services/reconcile.ts); holding the old fact would keep a misread value of
 * the clinical record alive beside its correction. A finding the user wrote a
 * note on does hold its facts (the pass cannot clear a finding with a user
 * note, so a new fact would leave two open findings for one disagreement).
 */
export function linkedFactIds(documentId: string): Set<string> {
  const rows = db().all<{ id: string }>(sql`
    with cand as (
      select id from facts
      where source_document_id = ${documentId} and deleted_at is null and origin = 'ai'
        and (status = 'unverified' or ${passSetAsideSql(sql.raw('facts.id'))})
    )
    select id from cand where
         id in (select fact_id from lab_results where deleted_at is null and fact_id is not null)
      or id in (select source_fact_id from medications where deleted_at is null and source_fact_id is not null)
      or id in (select source_fact_id from intolerances where deleted_at is null and source_fact_id is not null)
      or id in (select source_fact_id from medication_events where deleted_at is null and source_fact_id is not null)
      or id in (select fact_id from imaging_studies where deleted_at is null and fact_id is not null)
      or id in (select source_fact_id from records_inventory where deleted_at is null and source_fact_id is not null)
      or id in (select source_id from tasks where deleted_at is null and source_type = 'fact' and source_id is not null)
      or id in (select fe.fact_id from finding_evidence fe join findings fi on fi.id = fe.finding_id where fi.deleted_at is null and fe.fact_id is not null
                and not (fi.rule_id = ${CLINICAL_RECORD_RULE}
                         and ((fi.status = 'new' and (fi.verdict_note is null or trim(fi.verdict_note) = '' or fi.verdict_note like ${`${AUTO_CLEARED_PREFIX}%`}))
                              or (fi.status = 'resolved' and fi.verdict_note like ${`${AUTO_CLEARED_PREFIX}%`}))))
      or id in (select s.superseded_by_id from facts s where s.deleted_at is null and s.superseded_by_id is not null
                and not exists (select 1 from fact_merges m where m.reason = ${CLINICAL_RECORD_REASON} and m.status = 'accepted'
                                and m.fact_id_a = s.superseded_by_id and m.fact_id_b = s.id))
      or id in (select overridden_by_fact_id from facts where deleted_at is null and overridden_by_fact_id is not null
                and json_valid(attributes_json) and json_extract(attributes_json, '$._overrideManual') = 1)
  `);
  return new Set(rows.map((r) => r.id));
}

/**
 * The user has put work into this fact: an edit, a verdict note, an override decided by hand on it, an "unsure"
 * answer, "Not the same event" (Reconciliation's `_reconcileSeparate`), or an answer on the medication timeline or on
 * his notes against the records (My notes, 2026-10-09: `_timeline`, `_notesAnswer`).
 */
export function hasUserWork(row: { verdictNote: string | null; verdictBasis?: string | null }, attrs: Record<string, unknown>): boolean {
  return (
    Boolean(row.verdictNote && row.verdictNote.trim()) ||
    row.verdictBasis === 'unsure' ||
    attrs._userEdited === true ||
    attrs._overrideManual === true ||
    attrs._reconcileSeparate === true ||
    Boolean(attrs._timeline && typeof attrs._timeline === 'object' && Object.keys(attrs._timeline as object).length) ||
    Boolean(attrs._notesAnswer && typeof attrs._notesAnswer === 'object')
  );
}
