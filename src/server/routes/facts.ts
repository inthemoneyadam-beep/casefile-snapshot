/**
 * /api/facts — the ledger of cited statements, their verdicts, merge
 * proposals, and extraction requests. Specific paths are registered before
 * `/:id` so Hono does not treat them as ids.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ASSERTED_BY, FACT_ORIGINS, FACT_STATUSES, FACT_TYPES, MERGE_STATUSES, OBJECTIVITIES } from '../../shared/enums';
import { badRequest, notFound, zodIssues } from '../util/errors';
import {
  acceptMerge,
  createManualFact,
  enqueueExtraction,
  factStats,
  getCitation,
  getFact,
  listFacts,
  listMerges,
  patientStatementsFor,
  rejectMerge,
  setOverride,
  setVerdict,
  softDeleteFact,
  supersedeFact,
  updateFact,
  VERDICT_BASES,
} from '../services/facts';
import { TRUSTS } from '../../shared/reconcile';
import { runPatientPrecedence } from '../services/precedence';
import { estimateExtraction } from '../ai/extraction';
import { LONG_TEXT_MAX } from '../../shared/constants';

const listQuery = z.object({
  type: z.enum(FACT_TYPES).optional(),
  status: z.enum(FACT_STATUSES).optional(),
  documentId: z.string().min(1).optional(),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  origin: z.enum(FACT_ORIGINS).optional(),
  assertedBy: z.enum(ASSERTED_BY).optional(),
  objectivity: z.enum(OBJECTIVITIES).optional(),
  overridden: z.enum(['1', 'true']).optional(),
  trust: z.enum(TRUSTS).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['date', '-date', 'created', '-created', 'confidence', '-confidence', 'type']).optional(),
});

const citationInput = z.object({ documentId: z.string().min(1), pageNumber: z.number().int().min(1), quote: z.string().min(1).max(2000) });

const createBody = z.object({
  type: z.enum(FACT_TYPES),
  statement: z.string().min(1).max(LONG_TEXT_MAX),
  dateText: z.string().max(200).nullable().optional(),
  dateEndText: z.string().max(200).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  citation: citationInput.nullable().optional(),
  personId: z.string().nullable().optional(),
  note: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  objectivity: z.enum(OBJECTIVITIES).nullable().optional(),
  assertedBy: z.enum(ASSERTED_BY).nullable().optional(),
});

const patchBody = z.object({
  statement: z.string().min(1).max(LONG_TEXT_MAX).optional(),
  dateText: z.string().max(200).nullable().optional(),
  dateEndText: z.string().max(200).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  personId: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  objectivity: z.enum(OBJECTIVITIES).nullable().optional(),
  assertedBy: z.enum(ASSERTED_BY).nullable().optional(),
});

/**
 * basis: how a confirmed fact was checked (against the original record, or only a summary), 'correction' (the
 * patient's word corrects the clinical record; needs status confirmed and a note giving the reason), or 'unsure'
 * with unverified. A basis that does not go with the status is ignored (a correction without its reason is refused).
 */
const verdictBody = z
  .object({
    status: z.enum(['confirmed', 'disputed', 'unverified']),
    note: z.string().max(LONG_TEXT_MAX).nullable().optional(),
    basis: z.enum(VERDICT_BASES).nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.basis === 'correction' && b.status === 'confirmed' && b.note !== undefined && !(b.note ?? '').trim()) ctx.addIssue({ code: 'custom', path: ['note'], message: 'a correction needs a reason' });
  });
const supersedeBody = z.object({ byFactId: z.string().min(1) });
/** `{ byFactId: null }` clears; `{ byFactId }` sets; `{ statement, dateText? }` creates the patient statement and sets it in one step. */
const overrideBody = z.object({
  byFactId: z.string().min(1).nullable().optional(),
  reason: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  statement: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  dateText: z.string().max(200).nullable().optional(),
});
const precedenceBody = z.object({ documentId: z.string().min(1).optional() }).partial();
const acceptBody = z.object({ keep: z.enum(['a', 'b']) });
const extractBody = z.object({ documentIds: z.array(z.string().min(1)).max(500).optional(), allWithoutFacts: z.boolean().optional(), deep: z.boolean().optional() });

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

/** Strip empty query values so optional enums do not fail on "". */
function query(c: { req: { query: () => Record<string, string> } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') out[k] = v;
  return out;
}

export const factsRoutes = new Hono()
  .get('/', (c) => {
    const q = listQuery.safeParse(query(c));
    if (!q.success) throw badRequest(q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return c.json(listFacts(q.data));
  })
  .get('/stats', (c) => c.json(factStats()))
  .get('/merges', (c) => {
    const status = c.req.query('status') || undefined;
    if (status && !(MERGE_STATUSES as readonly string[]).includes(status)) throw badRequest('status must be pending, accepted, or rejected');
    return c.json({ items: listMerges(status) });
  })
  .post('/merges/:id/accept', async (c) => {
    const b = await body(c, acceptBody);
    return c.json(acceptMerge(c.req.param('id'), b.keep));
  })
  .post('/merges/:id/reject', (c) => c.json(rejectMerge(c.req.param('id'))))
  .get('/citations/:citationId', (c) => {
    const row = getCitation(c.req.param('citationId'));
    if (!row) throw notFound('citation not found');
    return c.json(row);
  })
  .get('/extract/estimate', (c) => {
    const documentId = c.req.query('documentId');
    if (!documentId) throw badRequest('documentId is required');
    const deep = c.req.query('deep') === '1' || c.req.query('deep') === 'true';
    return c.json(estimateExtraction(documentId, deep));
  })
  .post('/extract', async (c) => {
    const b = await body(c, extractBody);
    if (!b.documentIds?.length && !b.allWithoutFacts) throw badRequest('documentIds or allWithoutFacts is required');
    return c.json(enqueueExtraction(b));
  })
  .post('/', async (c) => {
    const b = await body(c, createBody);
    return c.json(createManualFact(b), 201);
  })
  .post('/precedence/run', async (c) => {
    const b = await body(c, precedenceBody);
    return c.json(runPatientPrecedence({ documentId: b.documentId, trigger: 'manual' }));
  })
  .get('/:id/override/candidates', (c) => c.json({ items: patientStatementsFor(c.req.param('id')) }))
  .post('/:id/override', async (c) => {
    const b = await body(c, overrideBody);
    if (b.byFactId === undefined && !b.statement) throw badRequest('byFactId (or null to clear) or statement is required');
    return c.json(setOverride(c.req.param('id'), b));
  })
  .get('/:id', (c) => {
    const f = getFact(c.req.param('id'));
    if (!f) throw notFound('fact not found');
    return c.json(f);
  })
  .patch('/:id', async (c) => {
    const b = await body(c, patchBody);
    return c.json(updateFact(c.req.param('id'), b));
  })
  .post('/:id/verdict', async (c) => {
    const b = await body(c, verdictBody);
    return c.json(setVerdict(c.req.param('id'), b.status, b.note, b.basis));
  })
  .post('/:id/supersede', async (c) => {
    const b = await body(c, supersedeBody);
    return c.json(supersedeFact(c.req.param('id'), b.byFactId));
  })
  .delete('/:id', (c) => {
    if (!softDeleteFact(c.req.param('id'))) throw notFound('fact not found');
    return c.json({ ok: true });
  });
