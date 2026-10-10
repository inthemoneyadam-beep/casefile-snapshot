import { Hono } from 'hono';
import { z } from 'zod';
import { searchAll, type SearchHit } from '../services/search';
import { badRequest, zodIssues } from '../util/errors';

/**
 * The clamp to 1..500 first, as before (0, an empty value and negatives read 1; Infinity reads 500), then a whole
 * number: a non-number, or a fraction the clamp leaves, failed in SQLite with a 500 (sweep BUG-S2).
 */
const limitQuery = z.object({
  limit: z.preprocess((v) => (typeof v === 'string' ? Math.min(Math.max(1, Number(v)), 500) : v), z.number().int()).optional(),
});

export const searchRoutes = new Hono().get('/', (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const typesRaw = (c.req.query('types') ?? '').trim();
  const types = typesRaw ? (typesRaw.split(',').map((t) => t.trim()).filter(Boolean) as Array<SearchHit['type']>) : undefined;
  const allPages = c.req.query('allPages') === '1';
  if (q.length < 2) return c.json({ items: [] });
  const parsed = limitQuery.safeParse({ limit: c.req.query('limit') });
  if (!parsed.success) throw badRequest(zodIssues(parsed.error, 'query'));
  return c.json({ items: searchAll(q, { limit: parsed.data.limit ?? 25, types, allPages }) });
});
