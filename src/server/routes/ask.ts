/**
 * /api/ask — consult sessions, questions, the SSE answer stream, cancel,
 * context preview and answer-to-task. The stream is registered for GET and
 * POST; the client follows answers with GET, which every role may call (a
 * viewer may not POST here), and POST stays for older clients.
 */
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { currentUser } from '../auth';
import { badRequest, zodIssues } from '../util/errors';
import { approveLabValue, approveReadingProposals, declineLabValue, declineReadingProposals, labValueStates, undoLabValue } from '../services/ask-actions';
import {
  askMessage,
  cancelMessage,
  createSession,
  deleteSession,
  getSession,
  listPresets,
  listSessions,
  messageToTask,
  previewContext,
  renameSession,
  subscribe,
} from '../services/ask';
import type { AskEvent } from '../../shared/ask';
import { LONG_TEXT_MAX } from '../../shared/constants';

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

const titleBody = z.object({ title: z.string().trim().min(1).max(200) });
const filingIdsBody = z.object({ filingIds: z.array(z.string().trim().min(1).max(80)).min(1).max(100) });
const idParam = z.string().trim().min(1).max(80);
const idsQuery = z.object({ ids: z.string().max(20_000).transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(idParam).max(200)) });

function who(c: Context): string | null {
  return currentUser(c)?.name ?? null;
}

function param(c: Context, name: string): string {
  const r = idParam.safeParse(c.req.param(name));
  if (!r.success) throw badRequest(zodIssues(r.error, name));
  return r.data;
}

const createBody = z.object({ title: z.string().trim().max(200).optional() });
const taskBody = z.object({ title: z.string().trim().max(300).optional() });
const previewQuery = z.object({
  preset: z.string().max(40).optional(),
  q: z.string().max(LONG_TEXT_MAX).optional(),
  documentIds: z.string().max(40_000).optional(),
  from: z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
  to: z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
});

function query(c: { req: { query: () => Record<string, string> } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') out[k] = v;
  return out;
}

function streamMessage(c: Context) {
  const id = c.req.param('id') ?? '';
  return streamSSE(c, async (stream) => {
    let unsubscribe: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      const queue: AskEvent[] = [];
      let writing = false;
      let closed = false;
      const pump = async () => {
        if (writing) return;
        writing = true;
        while (queue.length && !closed) {
          const ev = queue.shift()!;
          try {
            await stream.writeSSE({ data: JSON.stringify(ev) });
          } catch {
            closed = true;
          }
          if (ev.type === 'done' || ev.type === 'error') closed = true;
        }
        writing = false;
        if (closed) resolve();
      };
      try {
        unsubscribe = subscribe(id, (ev) => {
          queue.push(ev);
          void pump();
        });
      } catch (err) {
        queue.push({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        void pump();
      }
      stream.onAbort(() => {
        closed = true;
        resolve();
      });
    });
    await finished;
    unsubscribe();
  });
}

export const askRoutes = new Hono()
  .get('/presets', (c) => c.json({ items: listPresets() }))
  .get('/sessions', (c) => c.json({ items: listSessions() }))
  .post('/sessions', async (c) => {
    const b = await body(c, createBody);
    return c.json(createSession(b.title), 201);
  })
  .get('/sessions/:id', (c) => c.json(getSession(c.req.param('id'))))
  .patch('/sessions/:id', async (c) => {
    const b = await body(c, titleBody);
    return c.json(renameSession(c.req.param('id'), b.title));
  })
  .delete('/sessions/:id', (c) => {
    deleteSession(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/sessions/:id/messages', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    return c.json(askMessage(c.req.param('id'), raw), 202);
  })
  .get('/messages/:id/stream', streamMessage)
  .post('/messages/:id/stream', streamMessage)
  .post('/messages/:id/cancel', (c) => c.json(cancelMessage(c.req.param('id'))))
  .post('/messages/:id/to-task', async (c) => {
    const b = await body(c, taskBody);
    return c.json(messageToTask(c.req.param('id'), b.title), 201);
  })
  // What the patient does with what the clinician started or proposed under an answer (2026-10-08, lab check).
  .post('/proposals/reading/approve', async (c) => {
    const b = await body(c, filingIdsBody);
    return c.json(approveReadingProposals(b.filingIds, who(c)));
  })
  .post('/proposals/reading/decline', async (c) => {
    const b = await body(c, filingIdsBody);
    return c.json(declineReadingProposals(b.filingIds, who(c)));
  })
  .post('/proposals/lab-value/:id/approve', (c) => c.json(approveLabValue(param(c, 'id'), who(c))))
  .post('/proposals/lab-value/:id/decline', (c) => c.json(declineLabValue(param(c, 'id'), who(c))))
  .post('/lab-values/:factId/undo', (c) => c.json(undoLabValue(param(c, 'factId'), who(c))))
  .get('/lab-values', (c) => {
    const q = idsQuery.safeParse(query(c));
    if (!q.success) throw badRequest(zodIssues(q.error, 'ids'));
    return c.json({ items: labValueStates(q.data.ids) });
  })
  .get('/context-preview', (c) => {
    const q = previewQuery.safeParse(query(c));
    if (!q.success) throw badRequest(q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const documentIds = q.data.documentIds ? q.data.documentIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return c.json(previewContext({ preset: q.data.preset, q: q.data.q, documentIds, from: q.data.from, to: q.data.to }));
  });
