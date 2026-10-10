/**
 * What the patient does with what the clinician started or proposed under an answer (2026-10-08, lab check):
 *
 * - Reading requests the clinician proposed: "Read it" approves each request with its OWN scope and pages
 *   (services/reprocess.ts approveReprocessRequests); before, the thread re-posted them as "the pages not read yet",
 *   which on a document read to the end read nothing, so an approved page re-read made no call. "Not now" declines
 *   them: a request for the pages not read yet answers the document's "carry on?" as before (kept until asked again);
 *   any other request is declined on its own row only.
 * - Lab values the clinician proposed from a page: approve (the app adds it, with Undo) or decline
 *   (services/lab-check.ts).
 * - A lab value added at the patient's request or by an approval: Undo takes it back (soft delete of the value the app
 *   made; never one the patient worked on).
 *
 * Every step is the patient's own: viewers cannot POST under /api/ask. Errors are HttpErrors with plain words.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { badRequest, notFound } from '../util/errors';
import { nowIso, parseJson } from '../util/ids';
import { approveReprocessRequests, decideResume, REPROCESS_ACTION, REPROCESS_TARGET } from './reprocess';
import { approveLabValueProposal, declineLabValueProposal, undoLabValueFromPage } from './lab-check';
import type { ReprocessResult } from '../../shared/schemas/segments';

/** The filings target and action of a lab value proposed from a page (services/lab-check.ts). */
export const LAB_VALUE_TARGET = 'lab_value';

function readingRequests(filingIds: string[]) {
  const ids = [...new Set(filingIds)];
  if (!ids.length) throw badRequest('filingIds: give at least one reading request');
  const rows = db()
    .select()
    .from(schema.filings)
    .where(and(inArray(schema.filings.id, ids), eq(schema.filings.targetType, REPROCESS_TARGET), eq(schema.filings.action, REPROCESS_ACTION)))
    .all();
  if (!rows.length) throw notFound('no such reading request');
  return rows;
}

/** "Read it" / "Read them": each waiting request goes ahead with its own scope and pages. */
export function approveReadingProposals(filingIds: string[], by: string | null): ReprocessResult {
  const waiting = readingRequests(filingIds).filter((r) => r.status === 'waiting');
  if (!waiting.length) return { batchId: '', queued: [], askFirst: [], skipped: [], filingIds: [] };
  return approveReprocessRequests(waiting.map((r) => r.id), by);
}

/** "Not now": the requests stay unread; a request for the rest of a document answers its "carry on?" (kept until asked again). */
export function declineReadingProposals(filingIds: string[], by: string | null): { declined: number } {
  const waiting = readingRequests(filingIds).filter((r) => r.status === 'waiting');
  const at = nowIso();
  let declined = 0;
  for (const r of waiting) {
    const scope = parseJson<{ scope?: unknown }>(r.detailJson, {}).scope;
    if ((scope === undefined || scope === 'missing') && r.documentId) {
      decideResume(r.documentId, 'declined', { by });
      declined++;
      continue;
    }
    declined += db()
      .update(schema.filings)
      .set({ status: 'declined', decidedAt: at, decidedBy: by ?? 'user' })
      .where(and(eq(schema.filings.id, r.id), eq(schema.filings.status, 'waiting')))
      .run().changes;
  }
  return { declined };
}

function labValueProposal(filingId: string) {
  const row = db().select().from(schema.filings).where(and(eq(schema.filings.id, filingId), eq(schema.filings.targetType, LAB_VALUE_TARGET))).get();
  if (!row) throw notFound('no such lab value proposal');
  return row;
}

/** "Add it": the app adds the value from the page (its own parser, a verified citation), with Undo. */
export function approveLabValue(filingId: string, by: string | null) {
  labValueProposal(filingId);
  return approveLabValueProposal(filingId, by);
}

/** "Not now": nothing is added. */
export function declineLabValue(filingId: string, by: string | null) {
  labValueProposal(filingId);
  return declineLabValueProposal(filingId, by);
}

/** Undo: the value the app added from the page is taken back (soft delete); one the patient worked on stays (409). */
export function undoLabValue(factId: string, by: string | null) {
  return undoLabValueFromPage(factId, by);
}

/**
 * Where the lab values added under answers stand now: live, taken back (deleted since), replaced by a newer reading, or
 * gone (no such value). The
 * thread's card reads it so a value undone or deleted on the Labs page reads "taken back" after a reload.
 */
export function labValueStates(factIds: string[]): Array<{ factId: string; state: 'live' | 'taken_back' | 'replaced' | 'gone' }> {
  const ids = [...new Set(factIds)].slice(0, 200);
  if (!ids.length) return [];
  const rows = db().select({ id: schema.facts.id, deletedAt: schema.facts.deletedAt, status: schema.facts.status }).from(schema.facts).where(inArray(schema.facts.id, ids)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    return { factId: id, state: !r ? 'gone' : r.deletedAt ? 'taken_back' : r.status === 'superseded' ? 'replaced' : 'live' };
  });
}
