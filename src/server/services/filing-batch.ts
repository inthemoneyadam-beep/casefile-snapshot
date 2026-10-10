/**
 * Moving many documents at once (2026-10-07): the clinician's propose_refile_many and the user's batch approval.
 *
 * FROZEN SIGNATURES (WP0). Owner: WP-C, built on filing.ts's single moves (proposeMove / approveMove / declineMove).
 * Rules: every move is a `filings` row (action 'move') sharing `detail.batchId`; `approve: true` (the user asked for
 * exactly these moves in the message) applies at once, otherwise they wait for one "Approve all"; each move can be
 * undone (it is an ordinary approved move); a document already in the asked category is skipped with a reason, so is a
 * document not found; nothing is deleted.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { badRequest, notFound, zodIssues } from '../util/errors';
import { newId, parseJson } from '../util/ids';
import { approveMove, declineMove, proposeMove } from './filing';
import { refileManyRequest, type RefileManyRequestInput, type RefileManyResult } from '../../shared/schemas/segments';

function batchRows(batchId: string, status?: string): Array<typeof schema.filings.$inferSelect> {
  return db()
    .select()
    .from(schema.filings)
    .where(and(eq(schema.filings.action, 'move'), sql`json_extract(${schema.filings.detailJson}, '$.batchId') = ${batchId}`, status ? eq(schema.filings.status, status) : undefined))
    .all();
}

function setBatch(filingId: string, batchId: string): void {
  const row = db().select({ detailJson: schema.filings.detailJson }).from(schema.filings).where(eq(schema.filings.id, filingId)).get();
  if (!row) return;
  const detail = parseJson<Record<string, unknown>>(row.detailJson, {});
  if (detail.batchId === batchId) return;
  db().update(schema.filings).set({ detailJson: JSON.stringify({ ...detail, batchId }) }).where(eq(schema.filings.id, filingId)).run();
}

/** POST /api/filing/moves/batch. */
export function proposeMoves(req: RefileManyRequestInput, opts: { by?: string | null } = {}): RefileManyResult {
  const parsed = refileManyRequest.safeParse(req);
  if (!parsed.success) throw badRequest(zodIssues(parsed.error));
  const { items, source, askMessageId, approve } = parsed.data;
  const batchId = newId();
  const out: RefileManyResult = { batchId, filingIds: [], applied: 0, proposed: 0, skipped: [] };
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.documentId)) {
      out.skipped.push({ documentId: it.documentId, reason: 'listed twice; the first one counts' });
      continue;
    }
    seen.add(it.documentId);
    const doc = db().select({ id: schema.documents.id, category: schema.documents.category, deletedAt: schema.documents.deletedAt }).from(schema.documents).where(eq(schema.documents.id, it.documentId)).get();
    if (!doc || doc.deletedAt) {
      out.skipped.push({ documentId: it.documentId, reason: 'document not found' });
      continue;
    }
    if (doc.category === it.toCategory) {
      out.skipped.push({ documentId: it.documentId, reason: 'already filed as that type' });
      continue;
    }
    try {
      let f = proposeMove({ documentId: it.documentId, toCategory: it.toCategory, reason: it.reason, askMessageId: askMessageId ?? null, source });
      if (f.detail.toCategory !== it.toCategory) {
        // An older open proposal for another type: this request replaces it.
        declineMove(f.id, opts.by ?? null);
        f = proposeMove({ documentId: it.documentId, toCategory: it.toCategory, reason: it.reason, askMessageId: askMessageId ?? null, source });
      }
      setBatch(f.id, batchId);
      out.filingIds.push(f.id);
      if (approve) {
        approveMove(f.id, opts.by ?? null);
        out.applied++;
      } else out.proposed++;
    } catch (err) {
      out.skipped.push({ documentId: it.documentId, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return out;
}

/** POST /api/filing/moves/batch/:batchId/approve. */
export function approveMoveBatch(batchId: string, opts: { by?: string | null } = {}): RefileManyResult {
  const all = batchRows(batchId);
  if (!all.length) throw notFound('no moves with this batch id');
  const out: RefileManyResult = { batchId, filingIds: [], applied: 0, proposed: 0, skipped: [] };
  for (const f of all) {
    out.filingIds.push(f.id);
    if (f.status !== 'proposed') {
      out.skipped.push({ documentId: f.documentId ?? '', reason: `already ${f.status}` });
      continue;
    }
    try {
      approveMove(f.id, opts.by ?? null);
      out.applied++;
    } catch (err) {
      out.skipped.push({ documentId: f.documentId ?? '', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return out;
}

/** POST /api/filing/moves/batch/:batchId/decline. */
export function declineMoveBatch(batchId: string, opts: { by?: string | null } = {}): RefileManyResult {
  const all = batchRows(batchId);
  if (!all.length) throw notFound('no moves with this batch id');
  const out: RefileManyResult = { batchId, filingIds: [], applied: 0, proposed: 0, skipped: [] };
  for (const f of all) {
    out.filingIds.push(f.id);
    if (f.status !== 'proposed') {
      out.skipped.push({ documentId: f.documentId ?? '', reason: `already ${f.status}` });
      continue;
    }
    try {
      declineMove(f.id, opts.by ?? null);
    } catch (err) {
      out.skipped.push({ documentId: f.documentId ?? '', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return out;
}
