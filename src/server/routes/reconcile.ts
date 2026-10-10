/**
 * /api/reconcile — the Reconciliation page: counts (polled), events by state
 * (needs a source, settled, not backed yet), every inaccurate detail, and the
 * user's answers (this is the official record, the record is wrong or, on a
 * clinical record, this one is right; not the same event or both happened;
 * it's actually right; back to automatic; run the full pass).
 * Business logic is in services/reconcile.ts. Viewers are refused every POST
 * by the auth layer (services/users.ts authorize).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { currentUser } from '../auth';
import { badRequest, notFound, zodIssues } from '../util/errors';
import { RECONCILE_STATES } from '../../shared/reconcile';
import {
  correctRecord,
  getReconcileEvent,
  keepMention,
  listInaccurate,
  listReconcileEvents,
  markOfficial,
  reconcileAll,
  reconcileCounts,
  resetMention,
  separateMention,
} from '../services/reconcile';
import { LONG_TEXT_MAX } from '../../shared/constants';

function who(c: Context): string | null {
  return currentUser(c)?.name ?? null;
}

const id = z.string().trim().min(1).max(120);
const officialBody = z.object({ documentId: id }).strict();
// The reason may be left out only for a clinical record ("This one is right"); the service refuses it (400) otherwise.
const correctBody = z.object({ factId: id, reason: z.string().trim().max(LONG_TEXT_MAX).optional() }).strict();
const factBody = z.object({ factId: id }).strict();
const runBody = z.object({}).strict();

const paging = {
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};
const eventsQuery = z.object({ state: z.enum(RECONCILE_STATES).default('needs_source'), ...paging });
const inaccurateQuery = z.object(paging);

async function body<T>(c: Context, schemaDef: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schemaDef.safeParse(raw ?? {});
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

/** Query values with empty strings dropped, so optional fields do not fail on "". */
function query<T>(c: Context, schemaDef: z.ZodType<T>): T {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') raw[k] = v;
  const r = schemaDef.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

export const reconcileRoutes = new Hono()
  .get('/counts', (c) => c.json(reconcileCounts()))
  .get('/events', (c) => {
    const q = query(c, eventsQuery);
    return c.json(listReconcileEvents(q.state, q));
  })
  .get('/events/:key', (c) => {
    const ev = getReconcileEvent(c.req.param('key'));
    if (!ev) throw notFound('event not found');
    return c.json(ev);
  })
  .get('/inaccurate', (c) => c.json(listInaccurate(query(c, inaccurateQuery))))
  .post('/official', async (c) => {
    const b = await body(c, officialBody);
    return c.json(markOfficial(b.documentId, who(c)));
  })
  .post('/correct', async (c) => {
    const b = await body(c, correctBody);
    return c.json(correctRecord(b.factId, b.reason, who(c)));
  })
  .post('/separate', async (c) => {
    const b = await body(c, factBody);
    return c.json(separateMention(b.factId, who(c)));
  })
  .post('/keep', async (c) => {
    const b = await body(c, factBody);
    return c.json(keepMention(b.factId, who(c)));
  })
  .post('/reset', async (c) => {
    const b = await body(c, factBody);
    return c.json(resetMention(b.factId, who(c)));
  })
  .post('/run', async (c) => {
    await body(c, runBody);
    reconcileAll({ trigger: 'manual' });
    return c.json(reconcileCounts());
  });
