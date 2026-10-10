/**
 * /api/filing — automatic filing: what Claude filed (settled at once), Undo
 * (POST /:id/reject; 409 once the user has worked on the item since it was
 * added), the counts of what needs the user (documents not sorted
 * yet, move proposals, Reconciliation's needs-a-source), file the backlog,
 * and the consult's move proposals. Confirm and confirm all remain for
 * placements still pending from before quiet checks. Business logic is in
 * services/filing.ts.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { currentUser } from '../auth';
import { badRequest, zodIssues } from '../util/errors';
import { DOCUMENT_CATEGORIES } from '../../shared/enums';
import { approveMove, refileDocument, listUnsorted, sortDocument, fileDocument, confirmAll, confirmFiling, declineMove, fileBacklog, listFilings, pendingCounts, pendingTargets, rejectFiling } from '../services/filing';
import { approveMoveBatch, declineMoveBatch, proposeMoves } from '../services/filing-batch';
import { refileManyRequest } from '../../shared/schemas/segments';

function who(c: Context): string | null {
  return currentUser(c)?.name ?? null;
}

const SECTIONS = ['documents', 'communications', 'encounters', 'records', 'medications', 'labs', 'imaging', 'facts', 'all'] as const;
const confirmAllBody = z.object({ section: z.enum(SECTIONS) });
const refileBody = z.object({ documentId: z.string().trim().min(1).max(80), toCategory: z.enum(DOCUMENT_CATEGORIES) });

async function parseBody<T>(c: Context, schemaDef: z.ZodType<T>): Promise<T> {
  const parsed = schemaDef.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest(zodIssues(parsed.error));
  return parsed.data;
}

const batchIdParam = z.string().trim().min(1).max(80);

const listQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'rejected', 'undone', 'proposed', 'approved', 'declined']).optional(),
  targetType: z.string().max(40).optional(),
  targetId: z.string().max(80).optional(),
  documentId: z.string().max(80).optional(),
  askMessageId: z.string().max(80).optional(),
  /** Comma-separated filing ids. */
  ids: z
    .string()
    .max(4000)
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100))),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

export const filingRoutes = new Hono()
  .get('/counts', (c) => c.json(pendingCounts()))
  .get('/', (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) throw badRequest(q.error.issues.map((i) => i.message).join('; '));
    const items = listFilings(q.data);
    return c.json({ items, total: items.length });
  })
  .get('/pending/:targetType', (c) => c.json(pendingTargets(c.req.param('targetType'))))
  .post('/confirm-all', async (c) => {
    const b = await parseBody(c, confirmAllBody);
    return c.json(confirmAll(b.section, who(c)));
  })
  .post('/backlog', (c) => c.json(fileBacklog()))
  .get('/unsorted', (c) => {
    const items = listUnsorted();
    return c.json({ items, total: items.length });
  })
  .post('/sort/:documentId', (c) => c.json(sortDocument(c.req.param('documentId'))))
  .post('/file/:documentId', (c) => c.json(fileDocument(c.req.param('documentId'))))
  .post('/refile', async (c) => {
    const b = await parseBody(c, refileBody);
    return c.json(refileDocument(b, who(c)));
  })
  // Many moves at once (the clinician's propose_refile_many, the user's "Approve all"); before /:id.
  .post('/moves/batch', async (c) => {
    const b = await parseBody(c, refileManyRequest);
    return c.json(proposeMoves(b, { by: who(c) }), 201);
  })
  .post('/moves/batch/:batchId/approve', (c) => {
    const id = batchIdParam.safeParse(c.req.param('batchId'));
    if (!id.success) throw badRequest('batchId: not an id');
    return c.json(approveMoveBatch(id.data, { by: who(c) }));
  })
  .post('/moves/batch/:batchId/decline', (c) => {
    const id = batchIdParam.safeParse(c.req.param('batchId'));
    if (!id.success) throw badRequest('batchId: not an id');
    return c.json(declineMoveBatch(id.data, { by: who(c) }));
  })
  .post('/:id/confirm', (c) => c.json(confirmFiling(c.req.param('id'), who(c))))
  // Undo: refused (409) once the user has worked on the item since it was added (it is changed or deleted on its own page).
  .post('/:id/reject', (c) => c.json(rejectFiling(c.req.param('id'), who(c), { guardWork: true })))
  .post('/:id/approve', (c) => c.json(approveMove(c.req.param('id'), who(c))))
  .post('/:id/decline', (c) => c.json(declineMove(c.req.param('id'), who(c))));
