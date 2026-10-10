import { Hono, type Context } from 'hono';
import {
  communicationMatrix,
  communicationMatrixTotals,
  createCommunication,
  deleteCommunication,
  getCommunication,
  listCommunications,
  listFollowUps,
  listTopics,
  markFollowUpDone,
  reopenFollowUp,
  updateCommunication,
} from '../services/communications';
import { badRequest, zodIssues } from '../util/errors';
import { z } from 'zod';
import { getMessage, getThread, listThreads, summarizeThread } from '../services/threads';

/** true/false/1/0 or nothing. */
const boolish = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? null : v === '1' || v === 'true'));

const threadsQuery = z.object({
  personId: z.string().trim().max(80).optional(),
  documentId: z.string().trim().max(80).optional(),
  fromRecords: boolish,
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});

const threadKeyParam = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, 'not a thread key');

/** JSON body or 400; the services validate the shape with zod. */
async function body(c: Context): Promise<never> {
  const b = await c.req.json().catch(() => undefined);
  if (b === undefined || b === null || typeof b !== 'object') throw badRequest('expected a JSON object body');
  return b as never;
}

export const communicationsRoutes = new Hono()
  .get('/', (c) => {
    const q = c.req.query.bind(c.req);
    const items = listCommunications({
      personId: q('personId'),
      channel: q('channel'),
      direction: q('direction'),
      topic: q('topic'),
      from: q('from'),
      to: q('to'),
      documentId: q('documentId'),
      encounterId: q('encounterId'),
      threadKey: q('threadKey'),
      fromRecords: q('fromRecords') === '1' || q('fromRecords') === 'true' ? true : q('fromRecords') === '0' || q('fromRecords') === 'false' ? false : null,
      openFollowUps: q('openFollowUps') === '1' || q('openFollowUps') === 'true',
      q: q('q'),
      limit: q('limit') ? Number(q('limit')) : undefined,
    });
    return c.json({ items, total: items.length });
  })
  // Static paths before /:id.
  .get('/matrix', (c) => {
    const items = communicationMatrix();
    // people/topics: distinct-communication rollups (summing cells double counts).
    const { people, topics } = communicationMatrixTotals();
    return c.json({ items, people, topics, total: items.length });
  })
  .get('/follow-ups', (c) => {
    const items = listFollowUps({ includeDone: c.req.query('includeDone') === '1', personId: c.req.query('personId') });
    return c.json({ items, total: items.length });
  })
  .get('/topics', (c) => c.json({ items: listTopics() }))
  // Threads: messages read out of records grouped by thread (rows logged by hand are threads of their own).
  .get('/threads', (c) => {
    const q = threadsQuery.safeParse(c.req.query());
    if (!q.success) throw badRequest(zodIssues(q.error, 'query'));
    const items = listThreads(q.data);
    return c.json({ items, total: items.length });
  })
  .get('/threads/:key', (c) => {
    const k = threadKeyParam.safeParse(c.req.param('key'));
    if (!k.success) throw badRequest('not a thread key');
    return c.json(getThread(k.data));
  })
  // The model's short summary of a thread, on request (labelled "Model summary"; never the user's summary).
  .post('/threads/:key/summary', async (c) => {
    const k = threadKeyParam.safeParse(c.req.param('key'));
    if (!k.success) throw badRequest('not a thread key');
    const b = (await c.req.json().catch(() => ({}))) as unknown;
    const opts = z.object({ deep: z.boolean().optional() }).safeParse(b ?? {});
    if (!opts.success) throw badRequest('deep: true or false');
    return c.json(await summarizeThread(k.data, { deep: opts.data.deep }));
  })
  .get('/:id/message', (c) => c.json(getMessage(c.req.param('id'))))
  .post('/', async (c) => c.json(createCommunication(await body(c)), 201))
  .get('/:id', (c) => c.json(getCommunication(c.req.param('id'))))
  .patch('/:id', async (c) => c.json(updateCommunication(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteCommunication(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/:id/follow-up/done', (c) => c.json(markFollowUpDone(c.req.param('id'))))
  .post('/:id/follow-up/reopen', (c) => c.json(reopenFollowUp(c.req.param('id'))));
