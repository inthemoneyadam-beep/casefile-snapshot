/**
 * /api/patient-check — the wrong-patient guard (2026-10-09, services/patient-check.ts): the documents held back as
 * "May be someone else's record", the user's two answers, "Add this record number to my list", checking every document
 * again after Patient details change, and "Hold them back" for what a sweep left. Every body is validated with zod;
 * viewers are refused every POST by the auth layer like everywhere else.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { currentUser } from '../auth';
import { parseOrThrow } from '../util/errors';
import { addRecordNumber, holdUnheld, listHeld, markMine, markNotMine, patientCheckSummary, sweepDocuments } from '../services/patient-check';

const documentId = z.string().trim().min(1).max(64);
const empty = z.object({}).strict();
const recordNumberBody = z.object({ number: z.string().trim().min(3).max(40), system: z.string().trim().max(120).default('') }).strict();

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function actor(c: Parameters<typeof currentUser>[0]): { name: string } | null {
  const u = currentUser(c);
  return u ? { name: u.name } : null;
}

export const patientCheckRoutes = new Hono()
  .get('/', (c) => c.json({ summary: patientCheckSummary(), items: listHeld() }))
  .post('/scan', async (c) => {
    parseOrThrow(empty, await jsonBody(c));
    return c.json(sweepDocuments({ by: 'details' }) ?? { checked: 0, held: 0, unheld: 0, missing: [] });
  })
  .post('/hold-unheld', async (c) => {
    parseOrThrow(empty, await jsonBody(c));
    return c.json(holdUnheld(actor(c)));
  })
  .post('/record-numbers', async (c) => {
    const body = parseOrThrow(recordNumberBody, await jsonBody(c));
    return c.json({ items: addRecordNumber(body.number, body.system, actor(c)) });
  })
  .post('/:id/mine', async (c) => {
    const id = parseOrThrow(documentId, c.req.param('id'), 'id');
    parseOrThrow(empty, await jsonBody(c));
    return c.json(await markMine(id, actor(c)));
  })
  .post('/:id/not-mine', async (c) => {
    const id = parseOrThrow(documentId, c.req.param('id'), 'id');
    parseOrThrow(empty, await jsonBody(c));
    return c.json(markNotMine(id, actor(c)));
  });
