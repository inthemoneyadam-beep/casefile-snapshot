/**
 * Audit log: who did what, when. Rows are written for every login, every
 * write by a non-owner, every settings change, every export and every purge
 * (see requireUnlocked in src/server/auth.ts) plus user management. Writing
 * never throws: an audit failure must not block the action it describes.
 * Values are never recorded, only keys, paths and short summaries.
 */
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { newId, nowIso } from '../util/ids';

export const AUDIT_ACTIONS = ['login', 'lock', 'setup', 'create', 'update', 'delete', 'purge', 'export', 'settings', 'passphrase', 'user', 'ai'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditRow = typeof schema.auditLog.$inferSelect;

export interface AuditInput {
  userId?: string | null;
  userName?: string | null;
  action: AuditAction | string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
}

export function writeAudit(input: AuditInput): AuditRow | null {
  try {
    const row: typeof schema.auditLog.$inferInsert = {
      id: newId(),
      at: nowIso(),
      userId: input.userId ?? null,
      userName: input.userName ?? null,
      action: String(input.action).slice(0, 60),
      entityType: input.entityType ? String(input.entityType).slice(0, 80) : null,
      entityId: input.entityId ? String(input.entityId).slice(0, 200) : null,
      summary: input.summary ? String(input.summary).slice(0, 500) : null,
    };
    db().insert(schema.auditLog).values(row).run();
    return row as AuditRow;
  } catch (err) {
    console.error('[audit] could not write audit row', err instanceof Error ? err.message : err);
    return null;
  }
}

/** `userId=-` selects rows with no user (system rows). `before` is the `nextBefore` of the previous page. */
export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  userId: z.string().trim().max(64).optional(),
  action: z.string().trim().max(60).optional(),
  q: z.string().trim().max(200).optional(),
  before: z.string().max(300).optional(),
});

export interface AuditFilter {
  userId?: string | null;
  action?: string | null;
  /** Case-insensitive substring over who, action, entity and summary. */
  q?: string | null;
}

export interface AuditPage {
  items: AuditRow[];
  /** Rows matching the filter, across every page. */
  total: number;
  /** Cursor for the next (older) page, or null when this page is the last. */
  nextBefore: string | null;
}

/** LIKE pattern for a substring, with `!` escaping the wildcards. */
function likeEscaped(s: string): string {
  return `%${s.replace(/[!%_]/g, (m) => `!${m}`)}%`;
}

function filterWhere(f: AuditFilter): SQL[] {
  const t = schema.auditLog;
  const parts: SQL[] = [];
  if (f.userId === '-') parts.push(isNull(t.userId));
  else if (f.userId) parts.push(eq(t.userId, f.userId));
  if (f.action) parts.push(eq(t.action, f.action));
  const q = (f.q ?? '').trim();
  if (q) {
    const pat = likeEscaped(q);
    const cols = [t.userName, t.action, t.entityType, t.entityId, t.summary];
    parts.push(or(...cols.map((col) => sql`${col} LIKE ${pat} ESCAPE '!'`))!);
  }
  return parts;
}

/** `<at>|<id>` of the last row on a page; rows strictly older come next. */
function parseBefore(before: string | null | undefined): { at: string; id: string } | null {
  if (!before) return null;
  const i = before.lastIndexOf('|');
  if (i <= 0 || i === before.length - 1) return null;
  return { at: before.slice(0, i), id: before.slice(i + 1) };
}

/** Up to limit + 1 rows, newest first, so the caller knows whether an older page exists. */
function selectRows(opts: AuditFilter & { limit?: number; before?: string | null }): { rows: AuditRow[]; n: number } {
  const t = schema.auditLog;
  const n = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100) || 100));
  const parts = filterWhere(opts);
  const cursor = parseBefore(opts.before);
  const pageParts = cursor ? [...parts, or(lt(t.at, cursor.at), and(eq(t.at, cursor.at), lt(t.id, cursor.id)))!] : parts;
  const rows = db()
    .select()
    .from(t)
    .where(pageParts.length ? and(...pageParts) : undefined)
    .orderBy(desc(t.at), desc(t.id))
    .limit(n + 1)
    .all();
  return { rows, n };
}

/** Newest first, filtered, one page at a time. */
export function auditPage(opts: AuditFilter & { limit?: number; before?: string | null } = {}): AuditPage {
  const { rows, n } = selectRows(opts);
  const items = rows.slice(0, n);
  const last = items[items.length - 1];
  return { items, total: countAudit(opts), nextBefore: rows.length > n && last ? `${last.at}|${last.id}` : null };
}

export function listAudit(limit = 100, filter: AuditFilter & { before?: string | null } = {}): AuditRow[] {
  const { rows, n } = selectRows({ ...filter, limit });
  return rows.slice(0, n);
}

export function countAudit(filter: AuditFilter = {}): number {
  const parts = filterWhere(filter);
  const row = db()
    .select({ n: sql<number>`count(*)` })
    .from(schema.auditLog)
    .where(parts.length ? and(...parts) : undefined)
    .get();
  return Number(row?.n ?? 0);
}
