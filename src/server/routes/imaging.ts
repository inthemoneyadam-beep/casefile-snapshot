/**
 * /api/imaging — imaging studies: list with modality counts, detail with
 * DICOM documents and compare candidates, CRUD, import from facts, and a
 * word-level comparison of two reports.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { badRequest, zodIssues } from '../util/errors';
import { compareImaging, createImaging, deleteImaging, filterImaging, getImaging, imagingByDocument, importFromFacts, loadImagingEntries, modalityCounts, organiseImaging, updateImaging, type ImagingEntry, type ModalityCount } from '../services/imaging';

const listQuery = z.object({
  modality: z.string().optional(),
  bodyPart: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  includeDisputed: z.string().optional(),
});

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

/**
 * The filtered studies and the modality counts, from one load of the ledger.
 * Modality counts ignore the modality filter so the chips show what each would add.
 */
function listed(raw: Record<string, string>): { items: ImagingEntry[]; modalities: ModalityCount[] } {
  const q = parse(listQuery, raw);
  const includeDisputed = q.includeDisputed === undefined ? true : q.includeDisputed === '1' || q.includeDisputed === 'true';
  const all = loadImagingEntries();
  const items = filterImaging(all, { ...q, includeDisputed });
  const modalities = modalityCounts(q.modality ? filterImaging(all, { ...q, modality: undefined, includeDisputed }) : items);
  return { items, modalities };
}

export const imagingRoutes = new Hono()
  .get('/', (c) => {
    const { items, modalities } = listed(query(c));
    return c.json({ items, total: items.length, modalities });
  })
  // Grouped by modality and body part: serial studies chronologically under one header, each with its predecessor.
  .get('/organised', (c) => {
    const { items, modalities } = listed(query(c));
    return c.json({ groups: organiseImaging(items), total: items.length, modalities });
  })
  // Stacked under the report each study came from.
  .get('/by-document', (c) => {
    const { items, modalities } = listed(query(c));
    return c.json({ documents: imagingByDocument(items), total: items.length, modalities });
  })
  .post('/from-facts', async (c) => c.json(importFromFacts(await body(c))))
  .post('/', async (c) => c.json(createImaging(await body(c)), 201))
  .get('/:id/compare', (c) => {
    const withId = c.req.query('withId');
    if (!withId) throw badRequest('withId is required');
    return c.json(compareImaging(c.req.param('id'), withId));
  })
  .get('/:id', (c) => c.json(getImaging(c.req.param('id'))))
  .patch('/:id', async (c) => c.json(updateImaging(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteImaging(c.req.param('id'));
    return c.json({ ok: true });
  });
