/**
 * /api/labs/computed — computed lab values (2026-10-09): the formulas, the printed values each input can take, a
 * preview, computing one (the user's own action), the ranges the patient types, and his answer to the clinician's proposal to
 * compute one. Mounted by routes/labs.ts before `/:id`. Business logic: services/lab-compute.ts.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { currentUser } from '../auth';
import { badRequest, zodIssues } from '../util/errors';
import { approveComputeProposal, createComputedValue, declineComputeProposal, listCandidates, listComputeTests, listFormulas, listTypedRanges, previewCompute, setTypedRange } from '../services/lab-compute';

function who(c: Context): { by: string | null; userId: string | null } {
  const u = currentUser(c);
  return { by: u?.name ?? null, userId: u?.id ?? null };
}

async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

/** Strip empty query values so optional filters do not trip on "". */
function query(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') out[k] = v;
  return out;
}

const idParam = z.string().trim().min(1).max(80);
// Hono hands the path parameter over decoded already (a second decode would throw on a "%").
const keyParam = z.string().trim().min(1).max(200);

function param<T>(s: z.ZodType<T>, raw: string | undefined, name: string): T {
  const r = s.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error, name));
  return r.data;
}

export const labComputedRoutes = new Hono()
  .get('/formulas', (c) => c.json({ items: listFormulas() }))
  // The printed values one input can take (D1, D3): ?formula=albumin_index&slot=csf_albumin (the general formula: &analyteKey=&specimen=).
  .get('/candidates', (c) => c.json(listCandidates(query(c))))
  // The tests the general formula can take values from.
  .get('/tests', (c) => c.json(listComputeTests()))
  .post('/preview', async (c) => c.json(previewCompute(await body(c), who(c).by)))
  .post('/', async (c) => {
    const w = who(c);
    return c.json(createComputedValue(await body(c), { by: w.by, userId: w.userId, via: 'labs' }), 201);
  })
  .get('/ranges', (c) => c.json({ items: listTypedRanges() }))
  .put('/ranges/:key', async (c) => {
    const w = who(c);
    return c.json({ items: setTypedRange(param(keyParam, c.req.param('key'), 'key'), await body(c), w) });
  })
  .delete('/ranges/:key', (c) => {
    const w = who(c);
    return c.json({ items: setTypedRange(param(keyParam, c.req.param('key'), 'key'), null, w) });
  })
  // The clinician's proposal: "Yes, compute it" / "Not now" (D8: always the user's own yes).
  .post('/proposals/:id/approve', (c) => {
    const w = who(c);
    return c.json(approveComputeProposal(param(idParam, c.req.param('id'), 'id'), w));
  })
  .post('/proposals/:id/decline', (c) => c.json(declineComputeProposal(param(idParam, c.req.param('id'), 'id'), { by: who(c).by })));
