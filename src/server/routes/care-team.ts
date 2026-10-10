/**
 * /api/care-team: the Care team page (2026-10-09). Business logic in services/care-team.ts (candidates, sources, the
 * Flare test, status, proposals) and services/web-search.ts (Find candidates). Every body is checked with zod there.
 * Owners and editors do everything here (the role policy); viewers read, and log calls and to-dos through
 * /api/communications and /api/tasks as everywhere else. Static paths come before /:id.
 */
import { Hono, type Context } from 'hono';
import { currentUser } from '../auth';
import {
  acceptProposal,
  addFlareSource,
  addSource,
  candidateCounts,
  careComingUp,
  createCandidate,
  deleteCandidate,
  getCandidate,
  linkPerson,
  listCandidates,
  personMatches,
  rejectProposal,
  removeSource,
  setFlareAnswer,
  setFlareVerdict,
  setStatus,
  unverifyByPhone,
  updateCandidate,
  verifyByPhone,
} from '../services/care-team';
import { checkFind, searchRuns, startFindCandidates, stopSearchRun, webSearchCaps } from '../services/web-search';
import { badRequest } from '../util/errors';

async function body(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => undefined);
  if (b === undefined || b === null || typeof b !== 'object') throw badRequest('expected a JSON object body');
  return b;
}

async function optionalBody(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? b : {};
}

export const careTeamRoutes = new Hono()
  .get('/', (c) => {
    const items = listCandidates(c.req.query());
    return c.json({ items, total: items.length, counts: candidateCounts() });
  })
  .get('/counts', (c) => c.json(candidateCounts()))
  // Home, "Coming up" (request 6): open follow-ups linked to a candidate and the next booked flare-test call.
  .get('/coming-up', (c) => c.json(careComingUp()))
  .get('/person-matches', (c) => {
    const name = (c.req.query('name') ?? '').trim();
    if (name.length > 300) throw badRequest('name: at most 300 characters');
    return c.json({ items: name ? personMatches(name) : [] });
  })
  // Web search: the check and the cost first, then the run (kept with its queries).
  .get('/search/runs', (c) => c.json({ items: searchRuns(), caps: webSearchCaps() }))
  .post('/search/check', async (c) => c.json(checkFind(await body(c))))
  .post('/search', async (c) => c.json(startFindCandidates(await body(c), currentUser(c)?.name ?? null), 202))
  .post('/search/runs/:runId/stop', (c) => c.json({ ok: stopSearchRun(c.req.param('runId')) }))
  .post('/', async (c) => c.json(createCandidate(await body(c), currentUser(c)), 201))
  .get('/:id', (c) => c.json(getCandidate(c.req.param('id'))))
  .patch('/:id', async (c) => c.json(updateCandidate(c.req.param('id'), await body(c), currentUser(c))))
  .delete('/:id', (c) => {
    deleteCandidate(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/:id/status', async (c) => c.json(setStatus(c.req.param('id'), await body(c), currentUser(c))))
  .post('/:id/sources', async (c) => c.json(addSource(c.req.param('id'), await body(c), currentUser(c))))
  .delete('/:id/sources/:sourceId', (c) => c.json(removeSource(c.req.param('id'), c.req.param('sourceId'))))
  // The Flare test: typed by a person, here and nowhere else.
  .put('/:id/flare-test/:item', async (c) => c.json(setFlareAnswer(c.req.param('id'), c.req.param('item'), await body(c), currentUser(c))))
  .post('/:id/flare-test/:item/sources', async (c) => c.json(addFlareSource(c.req.param('id'), c.req.param('item'), await body(c), currentUser(c))))
  // The verdict on the whole flare test (request 6): typed by a person, here and nowhere else.
  .post('/:id/flare-verdict', async (c) => c.json(setFlareVerdict(c.req.param('id'), await body(c), currentUser(c))))
  // "Verified by phone" (request 6): tick with who called and when; untick takes its phone sources off (Undo ticks again).
  .post('/:id/phone-check', async (c) => c.json(verifyByPhone(c.req.param('id'), await body(c), currentUser(c))))
  .delete('/:id/phone-check', (c) => c.json(unverifyByPhone(c.req.param('id'), currentUser(c))))
  .post('/:id/accept', async (c) => c.json(acceptProposal(c.req.param('id'), await optionalBody(c), currentUser(c))))
  .post('/:id/reject', (c) => c.json(rejectProposal(c.req.param('id'), currentUser(c))))
  .post('/:id/person', async (c) => c.json(linkPerson(c.req.param('id'), await optionalBody(c))));
