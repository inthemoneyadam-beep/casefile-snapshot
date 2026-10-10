import { Hono } from 'hono';
import { z } from 'zod';
import { testConnection } from '../ai/client';
import { listAiCalls } from '../services/ai-log';
import { badRequest, zodIssues } from '../util/errors';

const MAX_LIMIT = 1000;

const callsQuery = z.object({
  /**
   * Clamped to 1,000 first, as before (Infinity and 1000.5 read 1,000; an empty value reads 0), then a whole number of
   * 0 or more: a negative or non-number limit listed every call, and a fraction failed in SQLite (sweep BUG-S1).
   */
  limit: z.preprocess((v) => (typeof v === 'string' ? Math.min(Number(v), MAX_LIMIT) : v), z.number().int().min(0)).optional(),
  /** Only the calls that read this document; the totals then cover those calls. */
  documentId: z.string().trim().min(1).max(64).optional(),
});

export const aiRoutes = new Hono()
  .get('/calls', (c) => {
    const raw = c.req.query();
    const q = callsQuery.safeParse({ limit: raw.limit, documentId: raw.documentId === '' ? undefined : raw.documentId });
    if (!q.success) throw badRequest(zodIssues(q.error, 'query'));
    return c.json(listAiCalls({ limit: q.data.limit ?? 200, documentId: q.data.documentId }));
  })
  .post('/test', async (c) => c.json(await testConnection()));
