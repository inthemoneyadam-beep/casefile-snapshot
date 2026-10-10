/**
 * /api/notes — My notes (2026-10-09): the notes and what they say (services/notes.ts), the mass import and the reading
 * of the notes (services/notes-import.ts), the medication timeline (stage 1, services/med-timeline.ts) and Records vs
 * my notes (stage 2, services/notes.ts).
 *
 * Every input is checked with zod. Viewers read only (the auth layer refuses their POSTs); owners and editors do
 * everything here, except importing a folder by its path: that reads files on this computer, so it is the owner's,
 * and only when the app runs on this computer (refused plainly when hosted).
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { currentUser } from '../auth';
import { config } from '../config';
import { badRequest, zodIssues } from '../util/errors';
import { LONG_TEXT_MAX } from '../../shared/constants';
import { NOTES_ANSWERS, RECORDS_ANSWERS } from '../../shared/notes';
import { batchNoteIds, importNotes, importStatus, planNotesReading, readNotesFolder, startNotesReading, unreadNoteIds } from '../services/notes-import';
import type { NoteSourceFile } from '../services/notes-formats';
import { answerNotesItem, listNoteDocs, listNoteDrugs, listNoteEntries, listNotesItems, noteDetail, noteDrug, notesCounts, undoNotesItem } from '../services/notes';
import { answerRecords, drugTimeline, listDrugs, undoTimelineAnswer } from '../services/med-timeline';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const id = z.string().trim().min(1).max(200);
const listQuery = z.object({ view: z.enum(['notes', 'meds', 'symptoms', 'events']).default('notes'), q: z.string().trim().max(200).optional() });
const reconcileQuery = z.object({ list: z.enum(['answer', 'waiting', 'answered']).default('answer'), q: z.string().trim().max(200).optional() });
const timelineQuery = z.object({ only: z.enum(['open', 'all']).default('all'), q: z.string().trim().max(200).optional() });
const notesAnswerBody = z.object({ key: id, answer: z.enum(NOTES_ANSWERS), reason: z.string().trim().max(LONG_TEXT_MAX).optional() }).strict();
const keyBody = z.object({ key: id }).strict();
const recordsAnswerBody = z.object({ disagreementKey: id, answer: z.enum(RECORDS_ANSWERS), pointId: z.string().trim().max(200).nullable().optional() }).strict();
const undoBody = z.object({ answerId: id }).strict();
const folderBody = z.object({ path: z.string().trim().min(1).max(1000), recursive: z.boolean().optional() }).strict();
/** What to read: one import, the notes named, or every note not read yet. Exactly one of them. */
const readBody = z
  .object({ batch: id.optional(), documentIds: z.array(id).min(1).max(5000).optional(), scope: z.literal('unread').optional() })
  .strict()
  .refine((b) => [b.batch, b.documentIds, b.scope].filter((x) => x !== undefined).length === 1, { message: 'say what to read: batch, documentIds or scope "unread"' });
const estimateQuery = z
  .object({ batch: id.optional(), scope: z.literal('unread').optional(), ids: z.string().trim().min(1).max(200 * 70).optional() })
  .refine((b) => [b.batch, b.scope, b.ids].filter(Boolean).length === 1, { message: 'give batch, ids or scope "unread"' });
/** Times of the files sent, in their order (the browser's lastModified, ms): the date of a note that has no other. */
const timesField = z.array(z.number().finite().nonnegative().nullable()).max(10_000);

function who(c: Context): string | null {
  return currentUser(c)?.name ?? null;
}

function parse<T>(schemaDef: z.ZodType<T>, input: unknown): T {
  const r = schemaDef.safeParse(input);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

async function json<T>(c: Context, schemaDef: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}));
  return parse(schemaDef, raw ?? {});
}

function query<T>(c: Context, schemaDef: z.ZodType<T>): T {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') raw[k] = v;
  return parse(schemaDef, raw);
}

function idsFor(b: { batch?: string; documentIds?: string[]; scope?: 'unread' }): string[] {
  if (b.batch) return batchNoteIds(b.batch);
  if (b.scope === 'unread') return unreadNoteIds();
  return b.documentIds ?? [];
}

export const notesRoutes = new Hono()
  // My notes ------------------------------------------------------------------
  .get('/list', (c) => {
    const q = query(c, listQuery);
    if (q.view === 'notes') return c.json({ items: listNoteDocs(q) });
    if (q.view === 'meds') return c.json({ items: listNoteDrugs(q) });
    return c.json({ items: listNoteEntries(q.view, q) });
  })
  .get('/doc/:id', (c) => c.json(noteDetail(parse(id, c.req.param('id')))))
  .get('/drug/:key', (c) => c.json(noteDrug(parse(id, c.req.param('key')))))
  // Import --------------------------------------------------------------------
  .post(
    '/import',
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: 'upload too large (2 GB limit)' }, 413) }),
    async (c) => {
      const body = await c.req.parseBody({ all: true });
      let times: Array<number | null> = [];
      if (typeof body.times === 'string' && body.times.trim()) {
        let raw: unknown;
        try {
          raw = JSON.parse(body.times);
        } catch {
          throw badRequest('times: not a list of numbers');
        }
        times = parse(timesField, raw);
      }
      const files: NoteSourceFile[] = [];
      for (const key of ['files', 'files[]', 'file']) {
        const v = body[key];
        const list = Array.isArray(v) ? v : v !== undefined ? [v] : [];
        for (const item of list) {
          if (typeof item === 'string' || !item) continue;
          // A file chosen with its folder keeps its path inside the folder (webkitRelativePath is sent as its name).
          files.push({ name: item.name, mime: item.type || null, buffer: Buffer.from(await item.arrayBuffer()), lastModified: times[files.length] ?? null });
        }
      }
      if (!files.length) throw badRequest('send one or more files in the "files" field');
      const user = currentUser(c);
      return c.json(await importNotes(files, { by: user?.name ?? null, byId: user?.id ?? null }), 201);
    },
  )
  .post('/import-folder', async (c) => {
    if (config.hosted) {
      return c.json({ error: 'Importing a folder by its path only works when CaseFile runs on your own computer. Drop the files or the folder on the page instead.', code: 'hosted' }, 403);
    }
    const user = currentUser(c);
    if (user && user.role !== 'owner') return c.json({ error: user.role, role: user.role, detail: 'importing a folder from this computer is owner only' }, 403);
    const b = await json(c, folderBody);
    const read = await readNotesFolder(b.path, b.recursive ?? true);
    const result = await importNotes(read.files, { by: user?.name ?? null, byId: user?.id ?? null, skipped: read.skipped });
    return c.json({ ...result, truncated: read.truncated }, 201);
  })
  .get('/imports/:batch', (c) => c.json(importStatus(parse(id, c.req.param('batch')))))
  // Reading -------------------------------------------------------------------
  .get('/read/estimate', (c) => {
    const q = query(c, estimateQuery);
    const ids = q.ids ? q.ids.split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (ids && ids.length > 200) throw badRequest('at most 200 ids');
    return c.json(planNotesReading(ids ?? idsFor(q)).estimate);
  })
  .post('/read', async (c) => {
    const b = await json(c, readBody);
    return c.json(startNotesReading(idsFor(b), who(c)), 202);
  })
  // Stage 1: the medication timeline (Records vs records) ---------------------------
  .get('/timeline', (c) => c.json({ items: listDrugs(query(c, timelineQuery)) }))
  .get('/timeline/:key', (c) => c.json(drugTimeline(parse(id, c.req.param('key')))))
  .post('/timeline/answer', async (c) => {
    const b = await json(c, recordsAnswerBody);
    return c.json(answerRecords({ disagreementKey: b.disagreementKey, answer: b.answer, pointId: b.pointId ?? null }, who(c)));
  })
  .post('/timeline/undo', async (c) => {
    const b = await json(c, undoBody);
    return c.json(undoTimelineAnswer(b.answerId, who(c)));
  })
  // Stage 2: Records vs my notes ----------------------------------------------------
  .get('/reconcile', (c) => {
    const q = query(c, reconcileQuery);
    return c.json(listNotesItems(q.list, q));
  })
  .get('/reconcile/counts', (c) => c.json(notesCounts()))
  .post('/reconcile/answer', async (c) => {
    const b = await json(c, notesAnswerBody);
    return c.json(answerNotesItem(b, who(c)));
  })
  .post('/reconcile/undo', async (c) => {
    const b = await json(c, keyBody);
    return c.json(undoNotesItem(b.key, who(c)));
  });
