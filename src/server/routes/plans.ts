/**
 * /api/plans — the Plan page (2026-10-09): a plan document read into a framework, a checklist, a timeline and the
 * original with its cited passages marked. Business logic is in services/plans.ts; this file parses requests (every
 * body and parameter with zod) and shapes responses. Static paths come before /:id. Viewers read; owners and editors
 * do everything (the role policy in services/users.ts refuses a viewer's write to /plans).
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { currentUser } from '../auth';
import { badRequest, parseOrThrow } from '../util/errors';
import type { UploadFile } from '../services/documents';
import {
  addPlanFromDocument,
  addPlanFromUpload,
  applyCarryOver,
  dismissCarryOver,
  estimateDocumentAsPlan,
  estimateReading,
  getItem,
  getPlan,
  listPlans,
  makeCurrent,
  makeTodo,
  planOriginal,
  removePlan,
  renamePlan,
  requestReading,
  restorePlan,
  setItemStatus,
  updateItem,
} from '../services/plans';

const MAX_PLAN_BYTES = 500 * 1024 * 1024;
const idParam = z.string().trim().min(1, 'an id is required').max(64);

/** JSON body or {} (the services validate the shape with zod). */
async function body(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => undefined);
  if (b === undefined) return {};
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw badRequest('expected a JSON object body');
  return b;
}

const by = (c: Context): string | null => currentUser(c)?.name ?? null;
const id = (c: Context, name = 'id'): string => parseOrThrow(idParam, c.req.param(name), name);

export const plansRoutes = new Hono()
  .get('/', (c) => c.json(listPlans()))
  .post(
    '/',
    bodyLimit({ maxSize: MAX_PLAN_BYTES, onError: (c) => c.json({ error: 'the plan file is too large (500 MB limit)' }, 413) }),
    async (c) => {
      const form = await c.req.parseBody({ all: true });
      const files: UploadFile[] = [];
      for (const key of ['file', 'files', 'files[]']) {
        const v = form[key];
        const list = Array.isArray(v) ? v : v !== undefined ? [v] : [];
        for (const item of list) {
          if (typeof item === 'string' || !item) continue;
          files.push({ name: item.name, mime: item.type || null, buffer: Buffer.from(await item.arrayBuffer()) });
        }
      }
      if (!files.length) throw badRequest('send the plan file in the "file" field');
      return c.json(addPlanFromUpload(files, { by: by(c) }), 201);
    },
  )
  .post('/from-document', async (c) => c.json(addPlanFromDocument(await body(c), { by: by(c) }), 201))
  .get('/document-estimate/:id', (c) => c.json(estimateDocumentAsPlan(id(c))))
  .get('/items/:id', (c) => c.json(getItem(id(c))))
  .patch('/items/:id', async (c) => c.json(updateItem(id(c), await body(c))))
  .post('/items/:id/status', async (c) => c.json(setItemStatus(id(c), await body(c), { by: by(c) })))
  .post('/items/:id/todo', async (c) => c.json(makeTodo(id(c), await body(c)), 201))
  .get('/:id', (c) => c.json(getPlan(id(c))))
  .patch('/:id', async (c) => c.json(renamePlan(id(c), await body(c), { by: by(c) })))
  .delete('/:id', (c) => c.json(removePlan(id(c), { by: by(c) })))
  .post('/:id/restore', (c) => c.json(restorePlan(id(c), { by: by(c) })))
  .post('/:id/current', (c) => c.json(makeCurrent(id(c), { by: by(c) })))
  .get('/:id/estimate', (c) => c.json(estimateReading(id(c))))
  .post('/:id/read', async (c) => c.json(requestReading(id(c), await body(c), { by: by(c) }), 202))
  .get('/:id/original', (c) => c.json(planOriginal(id(c))))
  .post('/:id/carry-over', async (c) => c.json(applyCarryOver(id(c), await body(c), { by: by(c) })))
  .post('/:id/carry-over/dismiss', (c) => c.json(dismissCarryOver(id(c), { by: by(c) })));
