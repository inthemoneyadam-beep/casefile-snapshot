/**
 * People with access to the case: the `users` table (name, role, disabled,
 * last login) and the role policy that requireUnlocked enforces.
 *
 * Roles
 * - owner: everything.
 * - editor: everything except what affects security: users management, LAN
 *   access and other security settings, other people's passphrases, purge,
 *   the AI key.
 * - viewer: read-only, plus adding or updating communications, tasks and
 *   symptom day entries (the chief of staff handles logistics).
 *
 * The keyring (passphrases) is handled in src/server/crypto/keyring.ts and
 * composed with these rows in src/server/auth.ts and routes/users.ts. A user
 * is "active" when the row is not disabled and a keyring entry exists.
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, nowIso } from '../util/ids';

export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type UserRow = typeof schema.users.$inferSelect;

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
}

export const userInput = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  role: z.enum(ROLES).default('viewer'),
});
export const userPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
});

export function asRole(s: string | null | undefined): Role {
  return s === 'owner' || s === 'editor' || s === 'viewer' ? s : 'viewer';
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

let cache: Map<string, UserRow> | null = null;

export function clearUsersCache(): void {
  cache = null;
}

function loadCache(): Map<string, UserRow> {
  if (cache) return cache;
  const rows = db().select().from(schema.users).all();
  cache = new Map(rows.map((r) => [r.id, r]));
  return cache;
}

/** Cached lookup for the per-request role check. */
export function getUserCached(id: string): UserRow | null {
  return loadCache().get(id) ?? null;
}

export function listUsers(): UserRow[] {
  return db().select().from(schema.users).orderBy(asc(schema.users.createdAt), asc(schema.users.name)).all();
}

export function getUser(id: string): UserRow {
  const row = db().select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!row) throw notFound('user not found');
  return row;
}

export function countOwners(opts: { enabledOnly?: boolean } = {}): number {
  return listUsers().filter((u) => u.role === 'owner' && (!opts.enabledOnly || !u.disabled)).length;
}

export function createUserRow(input: { id?: string; name: string; role: Role }): UserRow {
  const parsed = userInput.parse({ name: input.name, role: input.role });
  const d = db();
  const id = input.id ?? newId();
  if (d.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id)).get()) throw conflict('user already exists');
  d.insert(schema.users).values({ id, name: parsed.name, role: parsed.role, disabled: false, createdAt: nowIso(), lastLoginAt: null }).run();
  clearUsersCache();
  return getUser(id);
}

/**
 * Make sure the unlocking keyring entry has a row. A legacy keyring (or a
 * database restored from before the users table existed) gets an owner row
 * when no owner exists yet, otherwise a viewer row the owner can promote.
 */
export function ensureUserRow(id: string, name: string): UserRow {
  const existing = db().select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (existing) return existing;
  const role: Role = countOwners() === 0 ? 'owner' : 'viewer';
  return createUserRow({ id, name: name.trim() || (role === 'owner' ? 'Owner' : 'User'), role });
}

export function updateUserRow(id: string, raw: z.input<typeof userPatch>): UserRow {
  const patch = userPatch.parse(raw);
  const row = getUser(id);
  const set: Partial<typeof schema.users.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.role !== undefined && patch.role !== row.role) {
    if (row.role === 'owner' && countOwners({ enabledOnly: true }) <= 1 && !row.disabled) throw badRequest('the last owner cannot change role; make someone else owner first');
    set.role = patch.role;
  }
  if (patch.disabled !== undefined && patch.disabled !== row.disabled) {
    if (patch.disabled && row.role === 'owner' && countOwners({ enabledOnly: true }) <= 1) throw badRequest('the last owner cannot be disabled');
    set.disabled = patch.disabled;
  }
  if (Object.keys(set).length) db().update(schema.users).set(set).where(eq(schema.users.id, id)).run();
  clearUsersCache();
  return getUser(id);
}

export function removeUserRow(id: string): UserRow {
  const row = getUser(id);
  if (row.role === 'owner' && countOwners() <= 1) throw badRequest('the last owner cannot be removed');
  db().delete(schema.users).where(eq(schema.users.id, id)).run();
  clearUsersCache();
  return row;
}

export function touchLogin(id: string): void {
  db().update(schema.users).set({ lastLoginAt: nowIso() }).where(eq(schema.users.id, id)).run();
  clearUsersCache();
}

// ---------------------------------------------------------------------------
// Role policy (pure; unit-tested in tests/users.test.ts)
// ---------------------------------------------------------------------------

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Settings keys only the owner may change. */
export function isSecuritySetting(key: string): boolean {
  return key.startsWith('access.') || key.startsWith('lock.') || key === 'ai.apiKey';
}

/** Path prefixes (after /api) where a viewer may POST, PATCH or PUT. */
const VIEWER_WRITE_PREFIXES = ['/communications', '/tasks', '/symptoms/day'];

export interface AuthorizeInput {
  role: Role;
  method: string;
  /** Request path, with or without the /api prefix. */
  path: string;
  /** Keys of a PATCH /api/settings body, when known. */
  settingsKeys?: string[] | null;
}

export interface AuthorizeResult {
  ok: boolean;
  /** Why not, in one short line. */
  reason?: string;
}

function apiPath(p: string): string {
  const base = p.split('?')[0];
  return base.startsWith('/api/') ? base.slice(4) : base;
}

export function authorize(input: AuthorizeInput): AuthorizeResult {
  const method = input.method.toUpperCase();
  const p = apiPath(input.path);
  const role = input.role;
  if (role === 'owner') return { ok: true };

  // Owner-only reads.
  if (p === '/users/audit') return { ok: false, reason: 'the audit log is owner only' };
  // The backups hold the whole encrypted case: listing and downloading them is the owner's.
  if (p === '/system/backups' || p.startsWith('/system/backups/')) return { ok: false, reason: 'backups are owner only' };

  if (READ_METHODS.has(method)) return { ok: true };

  // POST /users/:id/passphrase is the owner's reset. Everyone changes their
  // own passphrase with POST /api/auth/change-passphrase, which asks for the
  // current one; say so instead of a generic refusal.
  if (/^\/users\/[^/]+\/passphrase$/.test(p)) return { ok: false, reason: 'passphrase resets are owner only; change your own with POST /api/auth/change-passphrase and your current passphrase' };

  if (role === 'editor') {
    if (p === '/users' || p.startsWith('/users/')) return { ok: false, reason: 'people with access are managed by the owner' };
    if (/^\/documents\/[^/]+\/purge$/.test(p)) return { ok: false, reason: 'purging is owner only' };
    if (p === '/settings' && input.settingsKeys) {
      const blocked = input.settingsKeys.filter(isSecuritySetting);
      if (blocked.length) return { ok: false, reason: `owner-only settings: ${blocked.join(', ')}` };
    }
    return { ok: true };
  }

  // viewer
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    if (VIEWER_WRITE_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))) return { ok: true };
  }
  return { ok: false, reason: 'viewers can read everything and add communications, tasks and symptom days' };
}

/** What the generic audit rule records for a non-owner write. */
export function auditActionFor(method: string): 'create' | 'update' | 'delete' | null {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'create';
    case 'PATCH':
    case 'PUT':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return null;
  }
}

/**
 * Entity type and id guessed from an API path: /api/tasks/<id>/done -> tasks,
 * <id>; /api/symptoms/day/2024-05-01 -> symptoms, 2024-05-01. The id is the
 * first segment after the collection that carries a digit (UUIDs and dates do;
 * sub-resource names such as "day" or "follow-up" do not).
 */
export function entityFromPath(p: string): { entityType: string | null; entityId: string | null } {
  const segs = apiPath(p).split('/').filter(Boolean);
  if (!segs.length) return { entityType: null, entityId: null };
  const entityType = segs[0];
  const entityId = segs.slice(1, 4).find((s) => /\d/.test(s)) ?? null;
  return { entityType, entityId };
}
