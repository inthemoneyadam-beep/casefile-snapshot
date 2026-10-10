import { Hono } from 'hono';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { cancelJob, retryJob } from '../jobs/queue';
import { badRequest, notFound, zodIssues } from '../util/errors';

const listQuery = z.object({
  active: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** One document's jobs (its readings, segmentation, classification). */
  documentId: z.string().trim().min(1).max(64).optional(),
});

export const jobsRoutes = new Hono()
  .get('/', (c) => {
    const q = listQuery.safeParse(Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== '')));
    if (!q.success) throw badRequest(zodIssues(q.error, 'query'));
    const conds: SQL[] = [];
    if (q.data.active === '1') conds.push(inArray(schema.jobs.status, ['queued', 'running']));
    if (q.data.documentId) conds.push(eq(schema.jobs.documentId, q.data.documentId));
    const rows = db()
      .select()
      .from(schema.jobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.jobs.createdAt))
      .limit(q.data.limit ?? 100)
      .all();
    // The status bar names the document a job works on (integration, 2026-10-07): titles only, never the text.
    const docIds = [...new Set(rows.map((r) => r.documentId).filter((id): id is string => Boolean(id)))];
    const titles = new Map(
      docIds.length
        ? db().select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(inArray(schema.documents.id, docIds)).all().map((d) => [d.id, d.title] as const)
        : [],
    );
    return c.json({ items: rows.map((r) => ({ ...r, documentTitle: r.documentId ? (titles.get(r.documentId) ?? null) : null })) });
  })
  .get('/:id', (c) => {
    const row = db().select().from(schema.jobs).where(eq(schema.jobs.id, c.req.param('id'))).get();
    if (!row) throw notFound('job not found');
    return c.json(row);
  })
  // A cancelled extraction puts its document's status back (jobs/queue.ts cancelJob).
  .post('/:id/cancel', (c) => c.json({ ok: cancelJob(c.req.param('id')) }))
  .post('/:id/retry', (c) => c.json({ ok: retryJob(c.req.param('id')) }));
