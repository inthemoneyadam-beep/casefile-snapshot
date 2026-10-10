/**
 * /api/encounters — visits and procedures, their prep payload, and the
 * iCalendar export. Business logic is in services/encounters.ts.
 */
import { Hono, type Context } from 'hono';
import {
  completeEncounter,
  createEncounter,
  deleteEncounter,
  encounterCalendar,
  encounterPrep,
  encountersCalendar,
  getEncounter,
  listEncounters,
  updateEncounter,
} from '../services/encounters';
import { badRequest } from '../util/errors';

async function body(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => undefined);
  if (b === undefined || b === null || typeof b !== 'object') throw badRequest('expected a JSON object body');
  return b;
}

async function optionalBody(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? b : {};
}

function calendar(c: Context, text: string, filename: string) {
  return c.body(text, 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
}

export const encountersRoutes = new Hono()
  .get('/', (c) => {
    const items = listEncounters(c.req.query());
    return c.json({ items, total: items.length });
  })
  .get('/ics', (c) => calendar(c, encountersCalendar(c.req.query('status')), 'casefile-encounters.ics'))
  .post('/', async (c) => c.json(createEncounter(await body(c)), 201))
  .get('/:id', (c) => c.json(getEncounter(c.req.param('id'))))
  .get('/:id/prep', (c) => c.json(encounterPrep(c.req.param('id'))))
  .get('/:id/ics', (c) => calendar(c, encounterCalendar(c.req.param('id')), `casefile-encounter-${c.req.param('id')}.ics`))
  .patch('/:id', async (c) => c.json(updateEncounter(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteEncounter(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/:id/complete', async (c) => c.json(completeEncounter(c.req.param('id'), await optionalBody(c))));
