/**
 * /api/medications — medications, their events, intolerances and hard stops,
 * proposals from facts, the chart timeline and the emergency card payload.
 * Business logic and validation live in services/medications.ts; specific
 * paths are registered before `/:id` so Hono does not read them as ids.
 */
import { Hono } from 'hono';
import {
  acceptFromFacts,
  addEvent,
  createIntolerance,
  createMedication,
  deleteEvent,
  deleteIntolerance,
  deleteMedication,
  emergencyCard,
  getIntolerance,
  getMedication,
  getMedicationTimeline,
  listEvents,
  listHardStops,
  listIntolerances,
  listMedications,
  listQuery,
  proposeFromFacts,
  updateIntolerance,
  updateMedication,
} from '../services/medications';
import { parseInput } from '../services/communications';

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function flag(v: string | undefined): boolean | undefined {
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

export const medicationsRoutes = new Hono()
  .get('/', (c) => {
    const q = parseInput(listQuery, c.req.query());
    const items = listMedications(q);
    return c.json({ items, total: items.length });
  })
  .get('/timeline', (c) => {
    const statuses = c.req.query('status')?.split(',').map((s) => s.trim()).filter(Boolean);
    return c.json(getMedicationTimeline({ from: c.req.query('from') || null, to: c.req.query('to') || null, statuses: statuses?.length ? statuses : null }));
  })
  .get('/hard-stops', (c) => {
    const items = listHardStops();
    return c.json({ items, total: items.length });
  })
  .get('/emergency-card', (c) => c.json(emergencyCard()))
  // Intolerances ------------------------------------------------------------
  .get('/intolerances', (c) => {
    const items = listIntolerances({ active: flag(c.req.query('active')), hardStop: flag(c.req.query('hardStop')) });
    return c.json({ items, total: items.length });
  })
  .post('/intolerances', async (c) => c.json(createIntolerance(await body(c)), 201))
  .get('/intolerances/:id', (c) => c.json(getIntolerance(c.req.param('id'))))
  .patch('/intolerances/:id', async (c) => c.json(updateIntolerance(c.req.param('id'), await body(c))))
  .delete('/intolerances/:id', (c) => {
    deleteIntolerance(c.req.param('id'));
    return c.json({ ok: true });
  })
  // Proposals from facts ------------------------------------------------------
  .get('/from-facts', (c) => {
    const items = proposeFromFacts();
    return c.json({ items, total: items.length });
  })
  .post('/from-facts', (c) => {
    const items = proposeFromFacts();
    return c.json({ items, total: items.length });
  })
  .post('/from-facts/accept', async (c) => {
    const r = acceptFromFacts(await body(c));
    return c.json(r, r.existing ? 200 : 201);
  })
  // Events --------------------------------------------------------------------
  .delete('/events/:eventId', (c) => c.json({ ok: true, ...deleteEvent(c.req.param('eventId')) }))
  // Medications ---------------------------------------------------------------
  .post('/', async (c) => c.json(createMedication(await body(c)), 201))
  .get('/:id', (c) => c.json(getMedication(c.req.param('id'))))
  .patch('/:id', async (c) => c.json(updateMedication(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteMedication(c.req.param('id'));
    return c.json({ ok: true });
  })
  .get('/:id/events', (c) => {
    getMedication(c.req.param('id'));
    const items = listEvents(c.req.param('id'));
    return c.json({ items, total: items.length });
  })
  .post('/:id/events', async (c) => c.json(addEvent(c.req.param('id'), await body(c)), 201));
