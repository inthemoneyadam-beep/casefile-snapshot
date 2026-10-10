/**
 * /api/inbox — drop anything here; the model proposes where it belongs; the
 * user files it. Mounted by the integrator under /api/inbox.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { badRequest, zodIssues } from '../util/errors';
import type { UploadFile } from '../services/documents';
import { createInboxDocuments, fileInboxDocument, getInboxItem, inboxCount, listInbox, retriageInboxDocument, skipInboxDocument, textToUploadFile } from '../services/inbox';
import { INBOX_STATUSES, type InboxStatus } from '../../shared/schemas/inbox';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const textBody = z.object({ text: z.string().min(1).max(5_000_000), title: z.string().trim().max(200).optional() }).strict();
const listQuery = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(5000).optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

/** `?status=` is a comma list of inbox statuses, `all` for every status, or empty for the active ones. */
function statusesFrom(raw: string | undefined): InboxStatus[] | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  if (s === 'all') return [...INBOX_STATUSES];
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = parts.filter((p) => !(INBOX_STATUSES as readonly string[]).includes(p));
  if (bad.length) throw badRequest(`unknown inbox status: ${bad.join(', ')}`);
  return parts as InboxStatus[];
}

export const inboxRoutes = new Hono()
  .post(
    '/',
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: 'upload too large (2 GB limit)' }, 413),
    }),
    async (c) => {
      const type = c.req.header('content-type') ?? '';
      if (type.includes('application/json')) {
        const body = parse(textBody, await c.req.json().catch(() => ({})));
        return c.json({ items: createInboxDocuments([textToUploadFile(body.text, body.title)]) }, 201);
      }
      const body = await c.req.parseBody({ all: true });
      const files: UploadFile[] = [];
      for (const key of ['files', 'files[]', 'file']) {
        const v = body[key];
        const list = Array.isArray(v) ? v : v !== undefined ? [v] : [];
        for (const item of list) {
          if (typeof item === 'string' || !item) continue;
          files.push({ name: item.name, mime: item.type || null, buffer: Buffer.from(await item.arrayBuffer()) });
        }
      }
      const text = typeof body.text === 'string' ? body.text : '';
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
      if (text.trim()) files.push(textToUploadFile(text, title));
      if (!files.length) throw badRequest('send one or more files in the "files" field, or JSON { text }');
      return c.json({ items: createInboxDocuments(files, { title: files.length === 1 ? title : undefined }) }, 201);
    },
  )
  .get('/', (c) => {
    const q = parse(listQuery, Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== '')));
    return c.json({ items: listInbox({ statuses: statusesFrom(q.status), limit: q.limit }) });
  })
  .get('/count', (c) => c.json(inboxCount()))
  .get('/:id', (c) => c.json(getInboxItem(c.req.param('id'))))
  .post('/:id/file', async (c) => c.json(fileInboxDocument(c.req.param('id'), await c.req.json().catch(() => ({})))))
  .post('/:id/retriage', (c) => c.json(retriageInboxDocument(c.req.param('id')), 202))
  .post('/:id/skip', (c) => c.json(skipInboxDocument(c.req.param('id'))));
