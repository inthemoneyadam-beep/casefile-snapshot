/**
 * /api/records — the records inventory and its gaps. Business logic is in
 * services/records.ts; this file only parses requests and shapes responses.
 */
import { Hono } from 'hono';
import {
  createFromDocument,
  createRecord,
  deleteRecord,
  getRecord,
  inferGaps,
  listQuery,
  listRecords,
  markDenied,
  markNotHeld,
  materializeGap,
  receiveRecord,
  recordCounts,
  requestRecord,
  updateRecord,
} from '../services/records';
import { parseOrThrow } from '../util/errors';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

export const recordsRoutes = new Hono()
  .get('/', (c) => {
    const q = parseOrThrow(listQuery, c.req.query());
    const items = listRecords(q);
    return c.json({ items, total: items.length });
  })
  .get('/counts', (c) => c.json(recordCounts()))
  .get('/gaps', (c) => {
    const items = inferGaps();
    return c.json({ items, total: items.length });
  })
  .post('/gaps/materialize', async (c) => c.json(materializeGap(await body(c)), 201))
  .post('/from-document', async (c) => {
    const row = createFromDocument(await body(c));
    return c.json(row, row.existing ? 200 : 201);
  })
  .post('/', async (c) => c.json(createRecord(await body(c)), 201))
  .get('/:id', (c) => c.json(getRecord(c.req.param('id'))))
  .patch('/:id', async (c) => c.json(updateRecord(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteRecord(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/:id/request', async (c) => c.json(requestRecord(c.req.param('id'), await body(c))))
  .post('/:id/receive', async (c) => c.json(receiveRecord(c.req.param('id'), await body(c))))
  .post('/:id/not-held', async (c) => c.json(markNotHeld(c.req.param('id'), await body(c))))
  .post('/:id/denied', async (c) => c.json(markDenied(c.req.param('id'), await body(c))));
