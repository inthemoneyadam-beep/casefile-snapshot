/**
 * /api/labs — the labs ledger: merged results, the analyte table, dated
 * series with a ChartSpec, CRUD, and import from extracted facts. Specific
 * paths are registered before `/:id`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { badRequest, zodIssues } from '../util/errors';
import { createLab, deleteLab, getLab, importFromFacts, labSeriesView, labsByDocument, listAnalytes, listLabs, organiseLabs, updateLab } from '../services/labs';
import { readLabParseError, readLabParseReport } from '../services/lab-reading';
import { slimReadingView, type LabReadingView } from '../../shared/labvalues';
import { labComputedRoutes } from './lab-computed';

const listQuery = z.object({
  analyteKey: z.string().optional(),
  analyte: z.string().optional(),
  specimen: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  flag: z.string().optional(),
  q: z.string().optional(),
  includeDisputed: z.string().optional(),
});

const seriesQuery = z.object({
  analyteKey: z.string().optional(),
  analyte: z.string().optional(),
  specimen: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  overlay: z.string().optional(),
  title: z.string().optional(),
});

/** Strip empty query values so optional filters do not trip on "". */
function query(c: { req: { query: () => Record<string, string> } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== '') out[k] = v;
  return out;
}

function parse<T>(s: z.ZodType<T>, raw: unknown): T {
  const r = s.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error, 'query'));
  return r.data;
}

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/**
 * A list payload (every value with its reading) sent with each reading's empty keys left out (null, false, an empty
 * list: slimReadingView); the client puts them back (src/client/api/labs.ts withReadings). A reading is about forty
 * mostly-empty keys, repeated for every value in the list (2026-10 review, payload size). Nothing else changes.
 */
function slimJson(c: { body: (data: string, status: 200, headers: Record<string, string>) => Response }, data: unknown): Response {
  const body = JSON.stringify(data, (key, value: unknown) =>
    key === 'reading' && value && typeof value === 'object' && !Array.isArray(value) && 'valueShown' in value && 'identity' in value ? slimReadingView(value as LabReadingView) : value,
  );
  return c.body(body, 200, { 'content-type': 'application/json; charset=UTF-8' });
}

export const labsRoutes = new Hono()
  .get('/', (c) => {
    const q = parse(listQuery, query(c));
    const items = listLabs({ ...q, includeDisputed: q.includeDisputed === undefined ? true : truthy(q.includeDisputed) });
    return slimJson(c, { items, total: items.length });
  })
  .get('/analytes', (c) => {
    const q = parse(listQuery, query(c));
    return c.json(listAnalytes({ ...q, includeDisputed: truthy(q.includeDisputed) }));
  })
  // Stacked by specimen, panel and analyte (CSF studies together, CBC together), each analyte with its series.
  .get('/organised', (c) => {
    const q = parse(listQuery, query(c));
    return slimJson(c, organiseLabs({ ...q, includeDisputed: truthy(q.includeDisputed) }));
  })
  // Everything pulled from one report, stacked under a document header with panel sub-headers.
  .get('/by-document', (c) => {
    const q = parse(listQuery, query(c));
    return slimJson(c, labsByDocument({ ...q, includeDisputed: q.includeDisputed === undefined ? true : truthy(q.includeDisputed) }));
  })
  .get('/series', (c) => {
    const q = parse(seriesQuery, query(c));
    const analyte = (q.analyte ?? q.analyteKey ?? '').trim();
    if (!analyte) throw badRequest('analyteKey or analyte is required');
    // One read: every result (words included), the chart of the measurements (null when none can be drawn), wordOnly
    // (every result is words or limits: the page lists them, no chart), and match: which test on file the name asked
    // for (rule 9: exact, or no rows and the similar tests on file named).
    const { rows, chart, wordOnly, match } = labSeriesView({ analyte, specimen: q.specimen, from: q.from, to: q.to, overlayMedications: truthy(q.overlay), title: q.title });
    return c.json({ rows, chart, wordOnly, match });
  })
  // The one-time re-read of lab values as printed (2026-10): its report (null before it has run on this database) and
  // its last failure, if any. Labs > More > "Values re-read".
  .get('/reparse-report', (c) => c.json({ report: readLabParseReport(), error: readLabParseError() }))
  .post('/from-facts', async (c) => c.json(importFromFacts(await body(c))))
  // Computed values (2026-10-09): formulas, inputs, preview, compute, typed ranges, the clinician's proposals.
  .route('/computed', labComputedRoutes)
  .post('/', async (c) => c.json(createLab(await body(c)), 201))
  .get('/:id', (c) => c.json(getLab(c.req.param('id'))))
  .patch('/:id', async (c) => c.json(updateLab(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteLab(c.req.param('id'));
    return c.json({ ok: true });
  });
