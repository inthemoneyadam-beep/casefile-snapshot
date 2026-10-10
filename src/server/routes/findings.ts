/**
 * /api/findings — cross-reference runs and the findings they produce.
 * `POST /run` runs the deterministic rules in the request (fast, no API) and,
 * unless `rulesOnly`, queues the AI pass as a job; it starts with the
 * clinical-record pass (services/reconcile.ts), which `POST /reconcile` also
 * runs on its own and answers with its counts. Specific paths come before
 * `/:id`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { FINDING_CATEGORIES, FINDING_SEVERITIES, FINDING_STATUSES, TASK_OWNERS, TASK_PRIORITIES } from '../../shared/enums';
import { badRequest, zodIssues } from '../util/errors';
import { enqueueJob } from '../jobs/queue';
import { createRun, findingCounts, findingToTask, finishRun, getFinding, getRun, listFindings, listRuns, runRulesForRun, setFindingVerdict } from '../services/findings';
import { CROSSREF_RULES } from '../services/crossref-rules';
import { reconcileAll, reconcileQuietly } from '../services/reconcile';
import { LONG_TEXT_MAX } from '../../shared/constants';

const scopeBody = z.object({
  documentIds: z.array(z.string().min(1)).max(500).optional(),
  from: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'from must be YYYY, YYYY-MM or YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'to must be YYYY, YYYY-MM or YYYY-MM-DD').optional(),
});

const runBody = z.object({ deep: z.boolean().optional(), rulesOnly: z.boolean().optional(), scope: scopeBody.optional() });

/** POST /reconcile takes no options: the clinical-record pass always reads the whole ledger. */
const reconcileBody = z.object({}).strict();

const listQuery = z.object({
  category: z.enum(FINDING_CATEGORIES).optional(),
  status: z.string().optional(),
  severity: z.string().optional(),
  q: z.string().optional(),
  origin: z.enum(['rule', 'ai']).optional(),
  runId: z.string().optional(),
  ruleId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});

const verdictBody = z.object({ status: z.enum(FINDING_STATUSES), note: z.string().max(LONG_TEXT_MAX).nullable().optional() });

const toTaskBody = z.object({
  title: z.string().max(500).nullable().optional(),
  detail: z.string().max(LONG_TEXT_MAX).nullable().optional(),
  owner: z.enum(TASK_OWNERS).nullable().optional(),
  ownerPersonId: z.string().nullable().optional(),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dueAt must be YYYY-MM-DD').nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).nullable().optional(),
});

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

/** Strip empty query values so optional enums do not fail on "". */
function query(c: { req: { query: () => Record<string, string> } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') out[k] = v;
  return out;
}

function validateSeverity(s: string | undefined): void {
  if (!s) return;
  for (const part of s.split(',')) if (part && !(FINDING_SEVERITIES as readonly string[]).includes(part.trim())) throw badRequest(`severity must be one of ${FINDING_SEVERITIES.join(', ')}`);
}

function validateStatus(s: string | undefined): void {
  if (!s) return;
  for (const part of s.split(',')) if (part && !(FINDING_STATUSES as readonly string[]).includes(part.trim())) throw badRequest(`status must be one of ${FINDING_STATUSES.join(', ')}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Close a run that cannot finish so it never stays `running`; the original error is what the caller sees. */
function failRun(runId: string, message: string): void {
  try {
    finishRun(runId, { status: 'failed', error: message });
  } catch {
    // Recording the failure must not mask the error that caused it.
  }
}

export const findingsRoutes = new Hono()
  .get('/', (c) => {
    const q = listQuery.safeParse(query(c));
    if (!q.success) throw badRequest(q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    validateSeverity(q.data.severity);
    validateStatus(q.data.status);
    return c.json({ ...listFindings(q.data), counts: findingCounts() });
  })
  .get('/counts', (c) => c.json(findingCounts()))
  .get('/rules', (c) => c.json({ items: CROSSREF_RULES.map((r) => ({ id: r.id, category: r.category, description: r.description })) }))
  .get('/runs', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({ items: listRuns(Number.isFinite(limit) ? limit : 50) });
  })
  .get('/runs/:id', (c) => c.json(getRun(c.req.param('id'))))
  .post('/run', async (c) => {
    const b = await body(c, runBody);
    const run = createRun({ deep: b.deep, rulesOnly: b.rulesOnly, scope: b.scope });
    // Check again starts with a full clinical-record pass (its disagreements land in this run); it never fails the run.
    const reconciled = reconcileQuietly({ runId: run.id, trigger: 'manual' });
    let rules: ReturnType<typeof runRulesForRun>;
    try {
      rules = runRulesForRun(run.id);
    } catch (err) {
      failRun(run.id, `The rules stopped with an error: ${messageOf(err)}`);
      throw err;
    }
    if (b.rulesOnly) {
      finishRun(run.id, { status: 'done' });
      return c.json({ run: getRun(run.id), rules, reconciled, jobId: null }, 201);
    }
    let job: ReturnType<typeof enqueueJob>;
    try {
      job = enqueueJob({ type: 'crossref', payload: { runId: run.id } });
    } catch (err) {
      failRun(run.id, `The rules ran; the AI pass could not be queued: ${messageOf(err)}`);
      throw err;
    }
    return c.json({ run: getRun(run.id), rules, reconciled, jobId: job.id }, 201);
  })
  .post('/reconcile', async (c) => {
    await body(c, reconcileBody);
    return c.json(reconcileAll({ trigger: 'manual' }));
  })
  .get('/:id', (c) => c.json(getFinding(c.req.param('id'))))
  .post('/:id/verdict', async (c) => {
    const b = await body(c, verdictBody);
    return c.json(setFindingVerdict(c.req.param('id'), b.status, b.note));
  })
  .post('/:id/to-task', async (c) => {
    const b = await body(c, toTaskBody);
    const t = findingToTask(c.req.param('id'), b);
    return c.json(t, t.existing ? 200 : 201);
  });
