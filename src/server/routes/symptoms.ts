/**
 * /api/symptoms — definitions, the day log, chart series and CSV import.
 * Specific paths (`definitions/reorder`, `series`, `summary`, `import`) are
 * registered before any `/:id` so Hono never treats them as ids. The
 * service refuses any day later than the server's tomorrow (one day of slack
 * for a client ahead of the server's time zone): the log records days that
 * happened.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { badRequest, notFound, zodIssues } from '../util/errors';
import { todayIso } from '../../shared/dates';
import {
  addDays,
  buildSeries,
  createDefinition,
  deactivateDefinition,
  getDay,
  getDays,
  getDefinition,
  importCsv,
  listDefinitions,
  reorderDefinitions,
  symptomSummary,
  updateDefinition,
  upsertDay,
} from '../services/symptoms';

const DAY = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const entriesQuery = z.object({ from: DAY.optional(), to: DAY.optional() });
const seriesQuery = z.object({
  from: DAY.optional(),
  to: DAY.optional(),
  symptomIds: z.string().optional(),
  bucket: z.enum(['day', 'week']).optional(),
});
const reorderBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
const importBody = z.object({ csv: z.string().min(1) });

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function parse<T>(s: z.ZodType<T>, input: unknown): T {
  const r = s.safeParse(input);
  if (!r.success) throw badRequest(zodIssues(r.error));
  return r.data;
}

/** Strip empty query values so optional enums do not fail on "". */
function query(c: { req: { query: () => Record<string, string> } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') out[k] = v;
  return out;
}

export const symptomsRoutes = new Hono()
  // Definitions ------------------------------------------------------------
  .get('/definitions', (c) => {
    const inactive = c.req.query('includeInactive');
    return c.json({ items: listDefinitions({ includeInactive: inactive === '1' || inactive === 'true' }) });
  })
  .post('/definitions/reorder', async (c) => {
    const b = parse(reorderBody, await body(c));
    return c.json({ items: reorderDefinitions(b.ids) });
  })
  .post('/definitions', async (c) => {
    const row = createDefinition(await body(c) as never);
    return c.json(row, row.reactivated ? 200 : 201);
  })
  .get('/definitions/:id', (c) => {
    const row = getDefinition(c.req.param('id'));
    if (!row) throw notFound('symptom definition not found');
    return c.json(row);
  })
  .patch('/definitions/:id', async (c) => c.json(updateDefinition(c.req.param('id'), await body(c) as never)))
  .delete('/definitions/:id', (c) => c.json(deactivateDefinition(c.req.param('id'))))

  // Days -------------------------------------------------------------------
  .get('/entries', (c) => {
    const q = parse(entriesQuery, query(c));
    const to = q.to ?? todayIso();
    const from = q.from ?? addDays(to, -29);
    return c.json({ from, to, days: getDays(from, to) });
  })
  .get('/day/:date', (c) => c.json(getDay(c.req.param('date'))))
  .put('/day/:date', async (c) => c.json(upsertDay(c.req.param('date'), await body(c) as never)))

  // Series and summary -----------------------------------------------------
  .get('/series', (c) => {
    const q = parse(seriesQuery, query(c));
    const ids = q.symptomIds
      ? q.symptomIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    return c.json(buildSeries({ from: q.from ?? null, to: q.to ?? null, symptomIds: ids, bucket: q.bucket ?? null }));
  })
  .get('/summary', (c) => c.json(symptomSummary()))

  // Import -----------------------------------------------------------------
  .post('/import', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let csv: string | null = null;
    if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(ct)) {
      const form = await c.req.parseBody({ all: true });
      for (const key of ['file', 'files', 'files[]', 'csv']) {
        const v = form[key];
        const list = Array.isArray(v) ? v : v !== undefined ? [v] : [];
        for (const item of list) {
          if (typeof item === 'string') csv = item;
          else if (item) csv = Buffer.from(await item.arrayBuffer()).toString('utf8');
          if (csv) break;
        }
        if (csv) break;
      }
    } else if (/text\/csv|text\/plain/i.test(ct)) {
      csv = await c.req.text();
    } else {
      csv = parse(importBody, await body(c)).csv;
    }
    if (!csv || !csv.trim()) throw badRequest('send the CSV as a "file" form field, as text/csv, or as JSON { csv }');
    // ?dryRun=1 reports what the import would do, including every value it
    // would overwrite, and writes nothing.
    const dry = c.req.query('dryRun');
    return c.json(importCsv(csv, { dryRun: dry === '1' || dry === 'true' }));
  });
