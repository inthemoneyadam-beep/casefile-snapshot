/**
 * /api/users — people with access. Reads are open to every role except the
 * audit log (owner only); writes are owner only. requireUnlocked already
 * enforces that; the checks here are defence in depth so the routes stay
 * safe if they are ever mounted differently.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { config } from '../config';
import { hasKeyringEntry } from '../crypto/keyring';
import { createUserWithPassphrase, currentUser, filesFolder, removeUser, resetUserPassphrase, updateUser } from '../auth';
import { auditPage, auditQuery } from '../services/audit';
import { getUser, listUsers, ROLES, type SessionUser } from '../services/users';
import { badRequest, HttpError, zodIssues } from '../util/errors';

function actor(c: Context): SessionUser {
  const u = currentUser(c);
  if (!u) throw new HttpError(401, 'no session');
  return u;
}

function requireOwner(c: Context): SessionUser {
  const u = actor(c);
  if (u.role !== 'owner') throw new HttpError(403, 'owner');
  return u;
}

async function body<T>(c: Context, schemaDef: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => undefined);
  const parsed = schemaDef.safeParse(raw);
  if (!parsed.success) throw badRequest(zodIssues(parsed.error));
  return parsed.data;
}

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES).default('viewer'),
  passphrase: z.string().min(8, 'passphrase must be at least 8 characters').max(1024),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
});
const passBody = z.object({ passphrase: z.string().min(8, 'passphrase must be at least 8 characters').max(1024) });

function withFlags(row: ReturnType<typeof listUsers>[number], me: SessionUser | null) {
  return { ...row, hasPassphrase: hasKeyringEntry(config.dataDir, row.id), isMe: me?.id === row.id };
}

function rethrow(err: unknown): never {
  if (err instanceof HttpError) throw err;
  throw badRequest(err instanceof Error ? err.message : String(err));
}

export const usersRoutes = new Hono()
  .get('/', (c) => {
    const me = currentUser(c);
    const items = listUsers().map((r) => withFlags(r, me));
    return c.json({ items, total: items.length });
  })
  .get('/me', (c) => {
    const me = actor(c);
    return c.json({ ...me, filesFolder: filesFolder() });
  })
  .get('/audit', (c) => {
    requireOwner(c);
    const q = auditQuery.safeParse(c.req.query());
    if (!q.success) throw badRequest(zodIssues(q.error, 'query'));
    // { items (newest first), total (every matching row), nextBefore (cursor for older rows, or null) }
    return c.json(auditPage(q.data));
  })
  .post('/', async (c) => {
    const me = requireOwner(c);
    const b = await body(c, createBody);
    try {
      const row = createUserWithPassphrase(b, me);
      return c.json(withFlags(row, me), 201);
    } catch (err) {
      rethrow(err);
    }
  })
  .get('/:id', (c) => c.json(withFlags(getUser(c.req.param('id')), currentUser(c))))
  .patch('/:id', async (c) => {
    const me = requireOwner(c);
    const b = await body(c, patchBody);
    try {
      return c.json(withFlags(updateUser(c.req.param('id'), b, me), me));
    } catch (err) {
      rethrow(err);
    }
  })
  // Owner reset only (no current passphrase needed). A person changes their
  // own passphrase with POST /api/auth/change-passphrase { current, next }.
  .post('/:id/passphrase', async (c) => {
    const me = requireOwner(c);
    const b = await body(c, passBody);
    try {
      resetUserPassphrase(c.req.param('id'), b.passphrase, me);
      return c.json({ ok: true });
    } catch (err) {
      rethrow(err);
    }
  })
  .delete('/:id', (c) => {
    const me = requireOwner(c);
    try {
      const row = removeUser(c.req.param('id'), me);
      return c.json({ ok: true, removed: { id: row.id, name: row.name, role: row.role } });
    } catch (err) {
      rethrow(err);
    }
  });
