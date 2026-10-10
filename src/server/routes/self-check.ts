/**
 * /api/self-check — a document checked against itself (2026-10-09, services/self-check.ts): its lab flags against
 * their own values and ranges (no AI) and its parts read by Claude for contradictions within themselves.
 *
 *   GET  /documents/:id             the record, the findings, the counts, the facility's totals
 *   GET  /estimate?ids=a,b&force=1  what checking costs, before anything is sent (one document or many)
 *   POST /documents/:id/run         "Check it against itself" {force?}: the flags now, the contradictions by a job
 *   POST /run                       the same for many documents {documentIds, force?}
 *   POST /documents/:id/answer      the question asked above the limit {answer: yes | not_now}
 *   GET  /facilities                counts per institution; ?institutionId= for one
 *
 * Every input is validated with zod; viewers are refused every POST by the auth layer (they read everything).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { parseOrThrow } from '../util/errors';
import { answerSelfCheck, documentSelfCheck, estimateMany, facilityCounts, requestMany, requestSelfCheck } from '../services/self-check';

const documentId = z.string().trim().min(1).max(64);
const flag = z.enum(['1', '0', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true');
const estimateQuery = z.object({
  ids: z
    .string()
    .trim()
    .min(1, 'ids: name at least one document')
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(documentId).min(1, 'ids: name at least one document').max(500, 'ids: at most 500 documents at once')),
  force: flag,
});
const runBody = z.object({ force: z.boolean().optional() }).strict();
const runManyBody = z.object({ documentIds: z.array(documentId).min(1).max(500), force: z.boolean().optional() }).strict();
const answerBody = z.object({ answer: z.enum(['yes', 'not_now']) }).strict();
const facilitiesQuery = z.object({ institutionId: documentId.optional() }).strict();

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export const selfCheckRoutes = new Hono()
  .get('/documents/:id', (c) => {
    const id = parseOrThrow(documentId, c.req.param('id'), 'id');
    return c.json(documentSelfCheck(id));
  })
  .get('/estimate', (c) => {
    const q = parseOrThrow(estimateQuery, c.req.query(), 'query');
    return c.json(estimateMany(q.ids, { force: q.force }));
  })
  .post('/documents/:id/run', async (c) => {
    const id = parseOrThrow(documentId, c.req.param('id'), 'id');
    const b = parseOrThrow(runBody, await jsonBody(c));
    return c.json(requestSelfCheck(id, { force: b.force }));
  })
  .post('/run', async (c) => {
    const b = parseOrThrow(runManyBody, await jsonBody(c));
    return c.json(requestMany(b.documentIds, { force: b.force }));
  })
  .post('/documents/:id/answer', async (c) => {
    const id = parseOrThrow(documentId, c.req.param('id'), 'id');
    const b = parseOrThrow(answerBody, await jsonBody(c));
    return c.json(answerSelfCheck(id, b.answer));
  })
  .get('/facilities', (c) => {
    const q = parseOrThrow(facilitiesQuery, c.req.query(), 'query');
    return c.json({ items: facilityCounts(q.institutionId) });
  });
