/**
 * The clinician's tools for the Care team (2026-10-09), kept apart from ask-tools.ts so the core tool list stays as it
 * is: ask.ts adds them to every answer (get_care_team, read-only) and, only when the patient switched "Search the web"
 * on for that question, search_the_web and propose_care_candidate.
 *
 * search_the_web never carries case content: services/web-search.ts checks every query and runs a separate call holding
 * only the checked queries. Its results come back as outside sources ([web N]), never citations of the record. A
 * candidate proposed from them waits for the patient's yes on the Care team page (at most five per answer); the Flare
 * test is never touched.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { careTeamText, createProposals, type ProposedCandidate } from './care-team';
import { askWebSearch, askWebInput } from './web-search';
import { zodIssues } from '../util/errors';
import { ACCESS_TYPES, CARE_ROLES, HOME_STATE_LICENSE, SOURCED_FIELDS, careRoleSchema, fieldValueText, type AskWebSearchNote, type AskWebSource, type CareRole, type SourcedField } from '../../shared/care-team';

type JsonSchema = Record<string, unknown>;
const nstr = (description: string): JsonSchema => ({ type: ['string', 'null'], description });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

function tool(name: string, description: string, properties: Record<string, JsonSchema>): Anthropic.Tool {
  return { name, description, input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}

/** Always offered: who is on the care team, read-only. */
export const CARE_TEAM_TOOLS: Anthropic.Tool[] = [
  tool(
    'get_care_team',
    'The care team the patient is building, in the order he is working (step 1 Local doctor, 2 Flare plan, 3 Lead specialist, 4 Expert): each candidate with their step, role (Strategist, Lead specialist, Local doctor, Vendor), status (Found, Contacted, Call booked with its time, Answered the flare test, Shortlisted, Declined, Chosen), practice, place, phone, website, states licensed in, access type, quoted cost, licensed in the home state, earliest visit, the answers to the fixed Flare test (first hour, who places the treatment order, where it is given, weekends, message response time, monitoring commitment, home-state license, cost and what is included) with its Pass or Fail verdict and reason, and the source of every fact (a web page with the day it was read, or a phone call: who said it and when; "[not backed yet]" when no source holds it, "[unverified]" when a web search found it and nobody checked it by phone). Typed by the patient or his team: these are not records of the case and carry no provenance tokens. Read-only.',
    {
      q: nstr('Words to narrow the list (a name, practice or city), or null for everyone'),
      includeProposals: { type: ['boolean', 'null'], description: 'Also list candidates found on the web that wait for the patient\'s yes; null or false for the list only' },
    },
  ),
];

/** Only when "Search the web" is on for the question. */
export const WEB_TOOLS: Anthropic.Tool[] = [
  tool(
    'search_the_web',
    'Search the web (outside sources, not the case file). Use only when the question needs something that lives on the web, such as clinicians, clinics or services by place, specialty or licence. Queries may hold condition terms, roles and places only: NEVER the patient\'s name, date of birth, record numbers, or any words taken from his records or documents. The app checks every query and refuses one that breaks this (it is never sent); the rest are searched in a separate request that sees nothing of the case. A few searches per answer at most. Returns numbered sources [web N] with their links and what they say.',
    {
      queries: { type: 'array', items: { type: 'string' }, description: 'One to five short search queries, e.g. "rheumatologist Columbus Ohio"' },
      why: nstr('One sentence: what you are looking for'),
    },
  ),
  tool(
    'propose_care_candidate',
    'Propose someone found by search_the_web in this answer for the patient\'s Care team. Nothing is added: the proposal waits for his yes on the Care team page. Give only what a web source states, and for each field the [web N] number of the source that states it. Never answer the Flare test or give its verdict, the step or a booked call: those are typed by the patient and his team. A candidate already on his list, waiting, or turned down before is skipped. At most five per answer.',
    {
      name: { type: 'string', description: 'The person\'s or service\'s name as the source prints it' },
      practice: nstr('Practice or organisation, or null'),
      city: nstr('City, or null'),
      state: nstr('State (two-letter code), or null'),
      phone: nstr('Phone as printed, or null'),
      website: nstr('Website link, or null'),
      licensedStates: { type: ['array', 'null'], items: { type: 'string' }, description: 'States the source says they are licensed in, or null' },
      role: { anyOf: [{ type: 'string', enum: [...CARE_ROLES] }, { type: 'null' }], description: 'strategist, lead_specialist, local_doctor, vendor, or null' },
      accessType: { anyOf: [{ type: 'string', enum: [...ACCESS_TYPES] }, { type: 'null' }], description: 'How patients get access, only as a source states it: cash_pay_priority, formal_arrangement, insurance, or null' },
      quotedCost: nstr('A price the source prints, as printed, or null'),
      licensedInHomeState: { anyOf: [{ type: 'string', enum: [...HOME_STATE_LICENSE] }, { type: 'null' }], description: 'yes or no only when a source (a licence lookup) states it, else null' },
      why: nstr('One sentence the patient will read: why they may fit'),
      sources: { type: 'array', description: 'For each field given, the [web N] number of the source that states it', items: obj({ field: { type: 'string', enum: [...SOURCED_FIELDS] }, web: { type: 'integer', description: 'N of [web N]' } }) },
    },
  ),
];

export const CARE_TOOL_NAMES = new Set([...CARE_TEAM_TOOLS, ...WEB_TOOLS].map((t) => t.name));

export function careTeamAskTools(webSearch: boolean): Anthropic.Tool[] {
  return webSearch ? [...CARE_TEAM_TOOLS, ...WEB_TOOLS] : [...CARE_TEAM_TOOLS];
}

export interface CareToolContext {
  askMessageId: string | null;
  /** Who asked (a proposal's "by"). */
  by: string | null;
  /** "Search the web" was on for this question. */
  webSearch: boolean;
  /** Searches left in this answer (settings ai.webSearch.maxPerRun.ask). */
  webLeft: number;
  /** Outside sources so far in this answer ([web N] = webSources[N-1]). */
  webSources: AskWebSource[];
  webSearches: AskWebSearchNote[];
  /** Candidates proposed in this answer (care_candidates ids, waiting for a yes). */
  careProposals: string[];
  /** What the web searches of this answer cost (tokens and the per-search fee). */
  webUsd: number;
  /** Web searches of one answer run one after the other (the cap and the [web N] numbers stay exact). */
  webQueue: Promise<unknown>;
  signal?: AbortSignal;
}

export function newCareToolContext(p: { askMessageId: string | null; by: string | null; webSearch: boolean; webLimit: number; signal?: AbortSignal }): CareToolContext {
  return { askMessageId: p.askMessageId, by: p.by, webSearch: p.webSearch, webLeft: p.webSearch ? p.webLimit : 0, webSources: [], webSearches: [], careProposals: [], webUsd: 0, webQueue: Promise.resolve(), signal: p.signal };
}

export const MAX_CARE_PROPOSALS_PER_ANSWER = 5;

const getCareTeamInput = z.object({ q: z.string().trim().max(200).nullish(), includeProposals: z.boolean().nullish() });
const proposeInput = z.object({
  name: z.string().trim().min(1).max(300),
  practice: z.string().max(300).nullish(),
  city: z.string().max(120).nullish(),
  state: z.string().max(60).nullish(),
  phone: z.string().max(60).nullish(),
  website: z.string().max(2000).nullish(),
  licensedStates: z.array(z.string().max(60)).max(60).nullish(),
  role: careRoleSchema.nullish(),
  accessType: z.enum(ACCESS_TYPES).nullish(),
  quotedCost: z.string().max(300).nullish(),
  licensedInHomeState: z.enum(HOME_STATE_LICENSE).nullish(),
  why: z.string().max(1000).nullish(),
  sources: z.array(z.object({ field: z.enum(SOURCED_FIELDS), web: z.number().int() })).max(40),
});

export function careToolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'search_the_web') {
    const n = Array.isArray(i.queries) ? i.queries.length : 0;
    return `search_the_web: ${n} quer${n === 1 ? 'y' : 'ies'}`;
  }
  if (name === 'propose_care_candidate') return `propose_care_candidate: ${typeof i.name === 'string' ? i.name.slice(0, 60) : ''}`;
  if (name === 'get_care_team') return `get_care_team${typeof i.q === 'string' && i.q.trim() ? `: "${i.q.trim()}"` : ''}`;
  return name;
}

export interface CareToolOutcome {
  text: string;
  isError: boolean;
  summary: string;
}

/** Validate and run one Care team tool. Errors become text, never exceptions. */
export async function runCareTeamTool(name: string, input: unknown, ctx: CareToolContext): Promise<CareToolOutcome> {
  const summary = careToolSummary(name, input);
  try {
    if (name === 'get_care_team') {
      const p = getCareTeamInput.safeParse(input ?? {});
      if (!p.success) return { text: `Invalid input for get_care_team: ${zodIssues(p.error, 'input')}`, isError: true, summary };
      return { text: careTeamText({ q: p.data.q ?? null, includeProposals: Boolean(p.data.includeProposals) }), isError: false, summary };
    }
    if (name === 'search_the_web') {
      if (!ctx.webSearch) return { text: 'Web search is off for this question. Answer from the case file; the patient can switch "Search the web" on for a question.', isError: true, summary };
      const p = askWebInput.safeParse(input ?? {});
      if (!p.success) return { text: `Invalid input for search_the_web: ${zodIssues(p.error, 'input')}`, isError: true, summary };
      const job = ctx.webQueue.then(async () => {
        const out = await askWebSearch(p.data, { askMessageId: ctx.askMessageId, by: ctx.by, left: ctx.webLeft, firstN: ctx.webSources.length + 1, signal: ctx.signal });
        // A failed call counts every search it was allowed (it may have searched before it broke): retries never pass the cap.
        ctx.webLeft = Math.max(0, ctx.webLeft - (out.charged ?? out.searches));
        ctx.webSources.push(...out.sources);
        ctx.webUsd += out.run?.usd ?? 0;
        if (out.run || out.searches) ctx.webSearches.push({ runId: out.run?.id ?? null, queries: out.run?.queries ?? [], refused: out.run?.refused ?? [], searches: out.searches });
        return out;
      });
      ctx.webQueue = job.catch(() => undefined);
      const out = await job;
      return { text: out.text, isError: out.isError, summary };
    }
    if (name === 'propose_care_candidate') {
      if (!ctx.webSearch) return { text: 'Web search is off for this question, so nothing can be proposed from the web.', isError: true, summary };
      if (ctx.careProposals.length >= MAX_CARE_PROPOSALS_PER_ANSWER) return { text: `At most ${MAX_CARE_PROPOSALS_PER_ANSWER} candidates can be proposed in one answer.`, isError: true, summary };
      const p = proposeInput.safeParse(input ?? {});
      if (!p.success) return { text: `Invalid input for propose_care_candidate: ${zodIssues(p.error, 'input')}`, isError: true, summary };
      if (!ctx.webSources.length) return { text: 'Search the web first (search_the_web): a proposal needs the web sources that state its details.', isError: true, summary };
      const c = p.data;
      const unknown: number[] = [];
      const sources: ProposedCandidate['sources'] = [];
      for (const s of c.sources) {
        const src = ctx.webSources.find((w) => w.n === s.web);
        if (!src) {
          unknown.push(s.web);
          continue;
        }
        sources.push({ field: s.field as SourcedField, url: src.url, title: src.title, verified: true });
      }
      const r = createProposals(
        [{ name: c.name, practice: c.practice, city: c.city, state: c.state, phone: c.phone, website: c.website, licensedStates: c.licensedStates ?? [], role: (c.role ?? null) as CareRole | null, accessType: c.accessType ?? null, quotedCost: c.quotedCost ?? null, licensedInHomeState: c.licensedInHomeState ?? null, why: c.why, sources }],
        { by: 'ask', runId: ctx.webSearches[ctx.webSearches.length - 1]?.runId ?? null, askMessageId: ctx.askMessageId },
        ctx.by,
      );
      if (!r.created.length) return { text: `${c.name} is already on the patient's Care team list, waiting for his yes, or was turned down before: not proposed again.`, isError: false, summary };
      ctx.careProposals.push(...r.created);
      const unbacked = SOURCED_FIELDS.filter((f) => {
        const v = f === 'earliestVisit' ? '' : fieldValueText(f, f === 'licensedStates' ? (c.licensedStates ?? []) : (c[f] ?? null));
        return v && !sources.some((s) => s.field === f);
      });
      return {
        text: `Proposed ${c.name} for the Care team; it waits for the patient's yes on the Care team page (nothing is added until then).${unknown.length ? ` No source [web ${unknown.join('], [web ')}] in this answer.` : ''}${unbacked.length ? ` Not backed yet (no source given): ${unbacked.join(', ')}.` : ''} Add one line at the end of the answer saying who was proposed.`,
        isError: false,
        summary,
      };
    }
    return { text: `Unknown tool ${name}.`, isError: true, summary };
  } catch (err) {
    return { text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true, summary };
  }
}
