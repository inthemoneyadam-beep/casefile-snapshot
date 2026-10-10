import { Hono, type Context } from 'hono';
import { acceptSuggestion, createPerson, deletePerson, getPerson, listPeople, personDocuments, personFacts, personSuggestions, personTopics, updatePerson } from '../services/people';
import { listCommunications } from '../services/communications';
import { declineMergeSuggestion, mergePeople, mergeSuggestions, undoMerge } from '../services/people-merge';
import { currentUser } from '../auth';
import { badRequest, zodIssues } from '../util/errors';
import { mergePeopleInput } from '../../shared/schemas/segments';
import { z } from 'zod';

function who(c: Context): string | null {
  return currentUser(c)?.name ?? null;
}

const idParam = z.string().trim().min(1).max(80);

/** JSON body or 400; the services validate the shape with zod. */
async function body(c: Context): Promise<never> {
  const b = await c.req.json().catch(() => undefined);
  if (b === undefined || b === null || typeof b !== 'object') throw badRequest('expected a JSON object body');
  return b as never;
}

export const peopleRoutes = new Hono()
  .get('/', (c) => {
    const items = listPeople({ q: c.req.query('q'), kind: c.req.query('kind'), institutionId: c.req.query('institutionId') });
    return c.json({ items, total: items.length });
  })
  // Static paths before /:id so Hono does not treat them as ids.
  .get('/suggestions', (c) => {
    const items = personSuggestions();
    return c.json({ items, total: items.length });
  })
  .post('/suggestions/accept', async (c) => c.json(acceptSuggestion(await body(c)), 201))
  // People who may be one person (computed on read; never merged automatically) and the user's merge with Undo.
  .get('/merge-suggestions', (c) => {
    const personId = c.req.query('personId');
    const p = personId === undefined ? null : idParam.safeParse(personId);
    if (p && !p.success) throw badRequest('personId: not an id');
    const items = mergeSuggestions({ personId: p ? p.data : null });
    return c.json({ items, total: items.length });
  })
  .post('/merge', async (c) => {
    const b = mergePeopleInput.safeParse(await body(c));
    if (!b.success) throw badRequest(zodIssues(b.error));
    return c.json(mergePeople(b.data, { by: who(c) }), 201);
  })
  .post('/merge/:filingId/undo', (c) => {
    const id = idParam.safeParse(c.req.param('filingId'));
    if (!id.success) throw badRequest('filingId: not an id');
    return c.json(undoMerge(id.data, { by: who(c) }));
  })
  .post('/merge-suggestions/:id/decline', (c) => {
    const id = idParam.safeParse(c.req.param('id'));
    if (!id.success) throw badRequest('id: not a suggestion id');
    declineMergeSuggestion(id.data, { by: who(c) });
    return c.json({ ok: true });
  })
  .post('/', async (c) => c.json(createPerson(await body(c)), 201))
  .get('/:id', (c) => c.json(getPerson(c.req.param('id'))))
  .get('/:id/activity', (c) => {
    const id = c.req.param('id');
    getPerson(id); // 404 when missing
    return c.json({
      communications: listCommunications({ personId: id }),
      topics: personTopics(id),
      documents: personDocuments(id),
      facts: personFacts(id),
    });
  })
  .patch('/:id', async (c) => c.json(updatePerson(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deletePerson(c.req.param('id'));
    return c.json({ ok: true });
  });
