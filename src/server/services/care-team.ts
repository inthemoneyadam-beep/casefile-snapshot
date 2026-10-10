/**
 * The Care team (2026-10-09, the user's request 4; lead's corrections): candidates for the team that would look after a
 * flare. One care_candidates row each (frozen migration 0006). A candidate is linked to a People and places row
 * (person_id: made when the candidate is added, or an existing one chosen with a yes), so calls and messages reach it
 * through communication_participants and to-dos through tasks.source_type 'care_candidate'.
 *
 * - Every fact on a candidate needs a source (sources_json, per field): a web link with the day it was read, or "told
 *   us by phone" with who and when. A source records the value it backed; a value changed after its source was recorded
 *   is "Not backed yet" again until a source is given (shared/care-team.ts fieldBacking).
 * - The Flare test (flare_test_json) is typed by a person only: setFlareAnswer is called from routes/care-team.ts and
 *   nowhere else (guarded by tests/careteam-guards.test.ts); no AI path and no web proposal ever fills it. Each answer
 *   has its own sources.
 * - Status changes are kept in detail_json.statusHistory with who and when.
 * - Web proposals (review 'proposed') wait for a yes: yes = accepted, status Found; no = rejected, never proposed again
 *   (sameCandidate: name plus practice or website). Soft delete everywhere (deleted_at).
 * - Request 6 (all in detail_json, migration 0006 being frozen): the step (sorted in code: step, then status order),
 *   access type, quoted cost, licensed in the home state, earliest visit (facts, with their sources in sources_json), the flare
 *   test verdict (setFlareVerdict: typed by a person, from routes/care-team.ts only), "Call booked for" (a booked call
 *   needs a time), "Verified by phone" ticks (phone sources beside the web ones; untick takes them off), Home's coming-up
 *   items and the packet's Care team summary.
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { badRequest, conflict, notFound, parseOrThrow } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { getSetting, setSetting } from './settings';
import { createPerson } from './people';
import { listCommunications, visibleWithRecordSql, type CommWithParticipants } from './communications';
import { listTasks, type TaskListItem } from './tasks';
import type { SessionUser } from './users';
import { parsePartialDate, todayIso } from '../../shared/dates';
import { LONG_TEXT_MAX } from '../../shared/constants';
import {
  ACCESS_TYPES,
  CARE_REVIEWS,
  CARE_ROLE_WORDS,
  CARE_STATUSES,
  CARE_STATUS_WORDS,
  CARE_STEPS,
  DETAIL_FIELDS,
  FIELD_WORDS,
  FLARE_ANSWER_KEYS,
  FLARE_ITEM_KEYS,
  FLARE_TEST_ITEMS,
  FLARE_VERDICTS,
  FLARE_VERDICT_WORDS,
  HOME_STATE_LICENSE,
  SOURCED_FIELDS,
  VERDICT_REASON_MAX,
  callSortKey,
  callWords,
  careRoleKeys,
  careRoleSchema,
  careSourceSchema,
  careStatusOrder,
  candidateNameKey,
  fieldBacking,
  fieldValueText,
  fieldVerification,
  fieldWords,
  flareBacking,
  isUpcomingCall,
  normalizeWebsite,
  readAccessType,
  readCallTime,
  readCareRole,
  readHomeStateLicense,
  readPartialDateValue,
  readStep,
  sameCandidate,
  sourceLine,
  splitStates,
  stepOrder,
  stepWords,
  verdictProblem,
  type AccessType,
  type Backing,
  type CallTime,
  type CandidateDetailJson,
  type CareRole,
  type CareSource,
  type CareStatus,
  type CareStep,
  type FlareAnswer,
  type FlareItemKey,
  type FlareTest,
  type FlareVerdict,
  type HomeStateLicense,
  type PartialDateValue,
  type PhoneCheck,
  type ProposalOrigin,
  type SearchRun,
  type SourcedField,
  type SourcesByField,
  type StatusChange,
  type Verification,
} from '../../shared/care-team';

export type CandidateRow = typeof schema.careCandidates.$inferSelect;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v && v.trim() ? v.replace(/\s+/g, ' ').trim() : null));

/** A web link: http(s), or a bare domain read as https. */
export function readUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const websiteField = z
  .string()
  .max(2000)
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (!v || !v.trim()) return null;
    const u = readUrl(v);
    if (!u) {
      ctx.addIssue({ code: 'custom', message: 'not a web address (e.g. example.org or https://example.org/team)' });
      return z.NEVER;
    }
    return u;
  });

const statesField = z
  .union([z.array(z.string().max(60)).max(60), z.string().max(600)])
  .nullish()
  .transform((v) => (v === undefined ? undefined : v === null ? [] : (Array.isArray(v) ? v.flatMap((s) => splitStates(s)) : splitStates(v)).slice(0, 60)));

/** A source as typed: a web link and the day it was read (today when blank), or who told us by phone and when. */
export const sourceInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('web'),
    url: z.string().trim().min(1, 'the link is required').max(2000),
    readAt: z.string().trim().max(64).nullish(),
    title: z.string().trim().max(400).nullish(),
  }),
  z.object({
    kind: z.literal('phone'),
    who: z.string().trim().min(1, 'say who told you').max(200),
    when: z.string().trim().min(1, 'say when').max(64),
    communicationId: z.string().trim().max(64).nullish(),
  }),
]);
export type SourceInput = z.input<typeof sourceInput>;

/** Step 1 to 4 (request 6), or null for none; "2" reads as 2. */
const stepField = z
  .union([z.number(), z.string().max(4)])
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const s = readStep(v);
    if (!s) {
      ctx.addIssue({ code: 'custom', message: `the step is one of ${CARE_STEPS.join(', ')}` });
      return z.NEVER;
    }
    return s;
  });

/** "Earliest visit" as typed: a partial date (value, precision, the text as typed); null clears it. */
const partialDateField = z
  .string()
  .max(64)
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const d = readPartialDateValue(v);
    if (d && !d.value) {
      ctx.addIssue({ code: 'custom', message: `could not read "${v}" as a date; type it as 2027-02-15, Feb 2027 or 2026` });
      return z.NEVER;
    }
    return d;
  });

/** "Call booked for": a date and time as typed (partial allowed: a day, a month). */
const callTimeField = z
  .string()
  .max(80)
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined || v === null || !v.trim()) return v === undefined ? undefined : null;
    const t = readCallTime(v);
    if (!t) {
      ctx.addIssue({ code: 'custom', message: `could not read "${v}" as a date and time; type it as 2026-10-14 3:30 pm` });
      return z.NEVER;
    }
    return t;
  });

const candidateFields = {
  name: z.string().trim().min(1, 'the name is required').max(300),
  practice: optText(300),
  city: optText(120),
  state: optText(60),
  phone: optText(60),
  website: websiteField,
  licensedStates: statesField,
  role: careRoleSchema.nullish(),
  status: z.enum(CARE_STATUSES),
  notes: optText(LONG_TEXT_MAX),
  // Request 6. Ours: the step. Facts about them (each needs a source): access type, quoted cost, home-state licence, earliest visit.
  step: stepField,
  accessType: z.enum(ACCESS_TYPES).nullish(),
  quotedCost: optText(300),
  licensedInHomeState: z.enum(HOME_STATE_LICENSE).nullish(),
  earliestVisit: partialDateField,
};

export const candidateInput = z.object({
  ...candidateFields,
  status: candidateFields.status.default('found'),
  /** Link to this People and places row (the yes to a match); without it a new one is made. */
  personId: z.string().trim().max(64).nullish(),
  /** A source for the facts typed now (every filled field it covers). */
  source: sourceInput.nullish(),
  sourceFields: z.array(z.enum(SOURCED_FIELDS)).max(SOURCED_FIELDS.length).nullish(),
  /** With status Call booked: when (request 6). */
  callBookedFor: callTimeField,
});
export const candidatePatch = z
  .object({
    ...candidateFields,
    source: sourceInput.nullish(),
    sourceFields: z.array(z.enum(SOURCED_FIELDS)).max(SOURCED_FIELDS.length).nullish(),
    callBookedFor: callTimeField,
  })
  .partial();

export const addSourceInput = z.object({
  fields: z.array(z.enum(SOURCED_FIELDS)).min(1, 'choose what it backs').max(SOURCED_FIELDS.length),
  source: sourceInput,
});
export const statusInput = z.object({
  status: z.enum(CARE_STATUSES),
  note: optText(2000),
  /** "Call booked for" (request 6): asked when the status is Call booked; a booked call needs a time. */
  callBookedFor: callTimeField,
});
export const flareInput = z.object({ answer: z.string().max(LONG_TEXT_MAX), source: sourceInput.nullish() });
export const flareSourceInput = z.object({ source: sourceInput });
export const acceptInput = z.object({ personId: z.string().trim().max(64).nullish() });
export const linkPersonInput = z.object({ personId: z.string().trim().max(64).nullish() });
/** The verdict on the whole flare test (request 6): Pass and Fail need a one-line reason. Typed by a person only. */
export const verdictInput = z
  .object({
    verdict: z.enum(FLARE_VERDICTS),
    reason: z.string().max(VERDICT_REASON_MAX * 2).nullish(),
    /** Who decided (the person signed in when blank). */
    decidedBy: z.string().trim().max(200).nullish(),
    /** The day it was decided (today when blank). */
    decidedOn: z.string().trim().max(64).nullish(),
  })
  .superRefine((v, ctx) => {
    const p = verdictProblem(v.verdict, v.reason);
    if (p) ctx.addIssue({ code: 'custom', path: ['reason'], message: p });
  });
/** "Verified by phone" (request 6): who called and when, typed; the facts it covers (every unverified one when absent). */
export const phoneCheckInput = z.object({
  who: z.string().trim().min(1, 'say who called').max(200),
  when: z.string().trim().min(1, 'say when').max(64),
  fields: z.array(z.enum(SOURCED_FIELDS)).max(SOURCED_FIELDS.length).nullish(),
});

export const listQuery = z.object({
  view: z.enum(['all', 'proposed', 'shortlisted', 'rejected']).optional(),
  role: careRoleSchema.optional(),
  status: z.enum(CARE_STATUSES).optional(),
  /** 1 to 4, or "none" for no step yet. */
  step: z.union([z.coerce.number().int().min(1).max(4), z.literal('none')]).optional(),
  q: z.string().trim().max(200).optional(),
  /** The candidates linked to one People and places row (its page links back to them). */
  personId: z.string().trim().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface CandidateItem {
  id: string;
  personId: string | null;
  personName: string | null;
  name: string;
  practice: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  website: string | null;
  licensedStates: string[];
  role: CareRole | null;
  status: CareStatus;
  statusOrder: number;
  review: (typeof CARE_REVIEWS)[number];
  notes: string | null;
  flareTest: FlareTest;
  sources: SourcesByField;
  detail: CandidateDetailJson;
  /** Each sourced field: backed, not backed yet, or empty. */
  backing: Record<SourcedField, Backing>;
  notBacked: number;
  flareAnswered: number;
  flareBacked: number;
  // Request 6 (kept in detail_json):
  step: CareStep | null;
  stepOrder: number;
  accessType: AccessType;
  quotedCost: string | null;
  licensedInHomeState: HomeStateLicense;
  earliestVisit: PartialDateValue | null;
  flareVerdict: FlareVerdict | null;
  /** When the flare-test call is booked for (kept while the status is Call booked; null otherwise). */
  callBookedFor: CallTime | null;
  /** Each sourced field: "unverified" (a web search found it, no phone call holds it yet), "by_phone", or null. */
  verification: Record<SourcedField, Verification>;
  /** Facts found on the web that no phone call holds yet (the row's "Unverified"). */
  unverified: number;
  /** Facts a web search found (verified or not): "Verified by phone" applies when there is one. */
  webFacts: number;
  /** "Verified by phone" is ticked: every web fact is held by a phone call. */
  verifiedByPhone: boolean;
  /** The tick that can be taken back (its sources were added by "Verified by phone"), newest first. */
  phoneChecks: PhoneCheck[];
  calls: number;
  lastContactAt: string | null;
  openTasks: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateDetail extends CandidateItem {
  communications: CommWithParticipants[];
  tasks: TaskListItem[];
  run: SearchRun | null;
}

type RowWithCounts = CandidateRow & { personName: string | null; calls: number; lastContactAt: string | null; openTasks: number };

const VISIBLE_C = sql.raw(visibleWithRecordSql('c'));

function selectRows(conds: SQL[]): RowWithCounts[] {
  const cc = schema.careCandidates;
  return db()
    .select({
      row: cc,
      // The outer table is named explicitly: drizzle renders a column inside a subquery without its table.
      personName: sql<string | null>`(select p.name from people p where p.id = care_candidates.person_id and p.deleted_at is null)`,
      calls: sql<number>`(select count(*) from communication_participants cp join communications c on c.id = cp.communication_id and c.deleted_at is null and ${VISIBLE_C} where cp.person_id = care_candidates.person_id)`,
      lastContactAt: sql<string | null>`(select max(c.occurred_at) from communication_participants cp join communications c on c.id = cp.communication_id and c.deleted_at is null and ${VISIBLE_C} where cp.person_id = care_candidates.person_id)`,
      openTasks: sql<number>`(select count(*) from tasks t where t.deleted_at is null and t.source_type = 'care_candidate' and t.source_id = care_candidates.id and t.status in ('open','in_progress'))`,
    })
    .from(cc)
    .where(and(...conds))
    .orderBy(asc(cc.createdAt))
    .all()
    .map((r) => ({ ...r.row, personName: r.personName, calls: Number(r.calls ?? 0), lastContactAt: r.lastContactAt, openTasks: Number(r.openTasks ?? 0) }));
}

export function parseSources(json: string | null | undefined): SourcesByField {
  const raw = parseJson<Record<string, unknown>>(json, {});
  const out: SourcesByField = {};
  for (const f of SOURCED_FIELDS) {
    const list = Array.isArray(raw?.[f]) ? (raw[f] as unknown[]) : [];
    const ok = list.map((s) => careSourceSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data as CareSource);
    if (ok.length) out[f] = ok;
  }
  return out;
}

export function parseFlareTest(json: string | null | undefined): FlareTest {
  const raw = parseJson<Record<string, unknown>>(json, {});
  const out: FlareTest = {};
  for (const k of FLARE_ITEM_KEYS) {
    const v = raw?.[k] as Partial<FlareAnswer> | undefined;
    if (!v || typeof v.answer !== 'string') continue;
    const sources = (Array.isArray(v.sources) ? v.sources : []).map((s) => careSourceSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data as CareSource);
    out[k] = { answer: v.answer, sources, answeredAt: typeof v.answeredAt === 'string' ? v.answeredAt : '', answeredBy: typeof v.answeredBy === 'string' ? v.answeredBy : null, history: Array.isArray(v.history) ? v.history : [] };
  }
  return out;
}

function parseDetail(json: string | null | undefined): CandidateDetailJson {
  const d = parseJson<CandidateDetailJson>(json, {});
  return d && typeof d === 'object' ? d : {};
}

type FieldRow = Pick<CandidateRow, 'name' | 'practice' | 'city' | 'state' | 'phone' | 'website' | 'licensedStatesJson'>;

/** A field's value: the row's columns, and for the request 6 fields detail_json (Unknown when not set). */
function fieldValue(r: FieldRow, f: SourcedField, detail: CandidateDetailJson = {}): unknown {
  switch (f) {
    case 'licensedStates':
      return parseJson<string[]>(r.licensedStatesJson, []);
    case 'accessType':
      return readAccessType(detail.accessType);
    case 'licensedInHomeState':
      return readHomeStateLicense(detail.licensedInHomeState);
    case 'quotedCost':
      return detail.quotedCost ?? null;
    case 'earliestVisit':
      return detail.earliestVisit ?? null;
    default:
      return r[f];
  }
}

/** The facts of a row, with their detail (for comparing before and after an edit). */
function factsOf(r: FieldRow & { detailJson?: string | null }, detail?: CandidateDetailJson): (f: SourcedField) => unknown {
  const d = detail ?? parseDetail(r.detailJson);
  return (f) => fieldValue(r, f, d);
}

function toItem(r: RowWithCounts): CandidateItem {
  const sources = parseSources(r.sourcesJson);
  const flareTest = parseFlareTest(r.flareTestJson);
  const detail = parseDetail(r.detailJson);
  const value = factsOf(r, detail);
  const backing = Object.fromEntries(SOURCED_FIELDS.map((f) => [f, fieldBacking(f, value(f), sources[f])])) as Record<SourcedField, Backing>;
  const verification = Object.fromEntries(SOURCED_FIELDS.map((f) => [f, fieldVerification(f, value(f), sources[f])])) as Record<SourcedField, Verification>;
  // The answers typed in words, and the home-state license row, which is the Licensed in home state field (one value).
  const answers = [...FLARE_ANSWER_KEYS.map((k) => flareBacking(flareTest[k])), backing.licensedInHomeState];
  const status = ((CARE_STATUSES as readonly string[]).includes(r.status) ? r.status : 'found') as CareStatus;
  const unverified = Object.values(verification).filter((v) => v === 'unverified').length;
  const webFacts = Object.values(verification).filter(Boolean).length;
  const step = readStep(detail.step);
  return {
    id: r.id,
    personId: r.personId,
    personName: r.personName,
    name: r.name,
    practice: r.practice,
    city: r.city,
    state: r.state,
    phone: r.phone,
    website: r.website,
    licensedStates: parseJson<string[]>(r.licensedStatesJson, []),
    // Old role keys (day_to_day_lead, local_hands) read as the new ones.
    role: readCareRole(r.role),
    status,
    statusOrder: careStatusOrder(status),
    review: (CARE_REVIEWS as readonly string[]).includes(r.review) ? (r.review as CandidateItem['review']) : 'accepted',
    notes: r.notes,
    flareTest,
    sources,
    detail,
    backing,
    notBacked: Object.values(backing).filter((b) => b === 'not_backed').length,
    flareAnswered: answers.filter((b) => b !== 'empty').length,
    flareBacked: answers.filter((b) => b === 'backed').length,
    step,
    stepOrder: stepOrder(step),
    accessType: readAccessType(detail.accessType),
    quotedCost: detail.quotedCost ?? null,
    licensedInHomeState: readHomeStateLicense(detail.licensedInHomeState),
    earliestVisit: detail.earliestVisit ?? null,
    flareVerdict: detail.flareVerdict ?? null,
    callBookedFor: status === 'call_booked' ? (detail.callBookedFor ?? null) : null,
    verification,
    unverified,
    webFacts,
    verifiedByPhone: webFacts > 0 && unverified === 0,
    phoneChecks: (detail.phoneChecks ?? []).filter((c) => !c.removedAt).slice().reverse(),
    calls: r.calls,
    lastContactAt: r.lastContactAt,
    openTasks: r.openTasks,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export interface CandidateCounts {
  all: number;
  proposed: number;
  shortlisted: number;
  chosen: number;
  rejected: number;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
}

export function candidateCounts(): CandidateCounts {
  const rows = db()
    .select({ review: schema.careCandidates.review, status: schema.careCandidates.status, role: schema.careCandidates.role })
    .from(schema.careCandidates)
    .where(isNull(schema.careCandidates.deletedAt))
    .all();
  const accepted = rows.filter((r) => r.review === 'accepted');
  const byRole: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of accepted) {
    const role = readCareRole(r.role) ?? 'none';
    byRole[role] = (byRole[role] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return {
    all: accepted.length,
    proposed: rows.filter((r) => r.review === 'proposed').length,
    shortlisted: byStatus.shortlisted ?? 0,
    chosen: byStatus.chosen ?? 0,
    rejected: rows.filter((r) => r.review === 'rejected').length,
    byRole,
    byStatus,
  };
}

/**
 * The list: All (on the team list), Waiting for your yes (proposed), Shortlisted, Turned down. Sorted in the order the
 * team is being built (request 6): by step (1 Local doctor first, no step last), then status order, then name.
 */
export function listCandidates(raw: unknown = {}): CandidateItem[] {
  const f = parseOrThrow(listQuery, raw ?? {}, 'query');
  const cc = schema.careCandidates;
  const conds: SQL[] = [isNull(cc.deletedAt)];
  const view = f.view ?? 'all';
  if (view === 'proposed') conds.push(eq(cc.review, 'proposed'));
  else if (view === 'rejected') conds.push(eq(cc.review, 'rejected'));
  else conds.push(eq(cc.review, 'accepted'));
  if (view === 'shortlisted') conds.push(eq(cc.status, 'shortlisted'));
  // A role filter also finds rows stored under the role's old key.
  if (f.role) conds.push(inArray(cc.role, careRoleKeys(f.role)));
  if (f.status) conds.push(eq(cc.status, f.status));
  if (f.personId) conds.push(eq(cc.personId, f.personId));
  if (f.q) {
    const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(sql`(lower(${cc.name}) like ${like} escape '\\' or lower(coalesce(${cc.practice}, '')) like ${like} escape '\\' or lower(coalesce(${cc.city}, '')) like ${like} escape '\\' or lower(coalesce(${cc.notes}, '')) like ${like} escape '\\')`);
  }
  // The step lives in detail_json (migration 0006 is frozen): filtered and sorted here.
  const step = f.step;
  return selectRows(conds)
    .map(toItem)
    .filter((c) => step === undefined || (step === 'none' ? c.step === null : c.step === step))
    .sort(byStepThenStatus);
}

/** Request 6: the order the team is being built in: step, then status order, then name. */
export function byStepThenStatus(a: Pick<CandidateItem, 'stepOrder' | 'statusOrder' | 'name'>, b: Pick<CandidateItem, 'stepOrder' | 'statusOrder' | 'name'>): number {
  return a.stepOrder - b.stepOrder || a.statusOrder - b.statusOrder || a.name.localeCompare(b.name);
}

function rowOrThrow(id: string): CandidateRow {
  const r = db().select().from(schema.careCandidates).where(and(eq(schema.careCandidates.id, id), isNull(schema.careCandidates.deletedAt))).get();
  if (!r) throw notFound('candidate not found');
  return r;
}

export function getCandidateItem(id: string): CandidateItem {
  const [r] = selectRows([eq(schema.careCandidates.id, id), isNull(schema.careCandidates.deletedAt)]);
  if (!r) throw notFound('candidate not found');
  return toItem(r);
}

export function getCandidate(id: string): CandidateDetail {
  const item = getCandidateItem(id);
  const runId = item.detail.proposal?.runId ?? null;
  return {
    ...item,
    communications: item.personId ? listCommunications({ personId: item.personId }) : [],
    tasks: listTasks({ sourceType: 'care_candidate', sourceId: id }),
    run: runId ? (listSearchRuns().find((r) => r.id === runId) ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// People and places
// ---------------------------------------------------------------------------

export interface PersonMatch {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  phone: string | null;
}

/** People and places rows with the same name (titles and credentials aside, or an alias): offered, linked only with a yes. */
export function personMatches(name: string): PersonMatch[] {
  const key = candidateNameKey(name);
  if (!key) return [];
  const rows = db().select().from(schema.people).where(isNull(schema.people.deletedAt)).all();
  return rows
    .filter((p) => candidateNameKey(p.name) === key || parseJson<string[]>(p.aliasesJson, []).some((a) => candidateNameKey(a) === key))
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, role: p.role, phone: p.phone }));
}

function assertPerson(id: string): void {
  const p = db().select({ id: schema.people.id }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get();
  if (!p) throw badRequest('personId: not a person in People and places');
}

/** A new People and places row for a candidate (calls, messages and to-dos reach the candidate through it). */
function makePerson(c: Pick<CandidateRow, 'name' | 'role' | 'phone' | 'city' | 'state' | 'practice' | 'website'>): string {
  const r = readCareRole(c.role);
  const role = r ? CARE_ROLE_WORDS[r] : null;
  const p = createPerson({
    name: c.name,
    kind: c.role === 'vendor' ? 'institution' : 'clinician',
    role: role ? `Care team candidate (${role})` : 'Care team candidate',
    phone: c.phone ?? null,
    address: [c.city, c.state].filter(Boolean).join(', ') || null,
    notes: [c.practice ? `Practice: ${c.practice}` : null, c.website ? `Website: ${c.website}` : null, 'Added from the Care team page.'].filter(Boolean).join('\n'),
  });
  return p.id;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A typed source made whole: the link read, the day read (today when blank), the phone call's day; the value it backs. */
export function makeSource(input: z.infer<typeof sourceInput>, value: string, by: string | null): CareSource {
  const addedAt = nowIso();
  if (input.kind === 'web') {
    const url = readUrl(input.url);
    if (!url) throw badRequest('source: the link is not a web address (e.g. https://example.org/team)');
    let readAt = todayIso();
    if (input.readAt && input.readAt.trim()) {
      const p = parsePartialDate(input.readAt);
      if (!p.iso || p.precision !== 'day') throw badRequest(`source: could not read the day it was read ("${input.readAt}"); type it as 2026-10-09`);
      readAt = p.iso;
    }
    return { id: newId(), kind: 'web', url, readAt, title: input.title ?? null, value, origin: 'person', verified: null, runId: null, addedBy: by, addedAt };
  }
  const p = parsePartialDate(input.when);
  if (!p.iso) throw badRequest(`source: could not read when ("${input.when}"); type a day such as 2026-10-09`);
  if (input.communicationId) {
    const c = db().select({ id: schema.communications.id }).from(schema.communications).where(and(eq(schema.communications.id, input.communicationId), isNull(schema.communications.deletedAt))).get();
    if (!c) throw badRequest('source: that call or message is not on file');
  }
  return { id: newId(), kind: 'phone', who: input.who, when: input.when, whenIso: p.iso, value, communicationId: input.communicationId ?? null, addedBy: by, addedAt };
}

function nameOf(user: SessionUser | null | undefined): string | null {
  return user?.name ?? null;
}

const SOURCE_CAP = 20;

function withSource(sources: SourcesByField, field: SourcedField, s: CareSource): SourcesByField {
  const list = [...(sources[field] ?? []), s].slice(-SOURCE_CAP);
  return { ...sources, [field]: list };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function nameKeyTaken(name: string, practice: string | null, website: string | null, exceptId?: string): CandidateRow | null {
  const rows = db().select().from(schema.careCandidates).where(and(isNull(schema.careCandidates.deletedAt), eq(schema.careCandidates.review, 'accepted'))).all();
  return rows.find((r) => r.id !== exceptId && sameCandidate({ name, practice, website }, r)) ?? null;
}

/** The request 6 fields of an input, set on the detail (undefined = unchanged; Unknown clears a choice). */
function withDetailFields(
  detail: CandidateDetailJson,
  p: { step?: CareStep | null; accessType?: AccessType | null; quotedCost?: string | null; licensedInHomeState?: HomeStateLicense | null; earliestVisit?: PartialDateValue | null },
): CandidateDetailJson {
  const next = { ...detail };
  if (p.step !== undefined) next.step = p.step;
  if (p.accessType !== undefined) next.accessType = p.accessType ?? 'unknown';
  if (p.quotedCost !== undefined) next.quotedCost = p.quotedCost;
  if (p.licensedInHomeState !== undefined) next.licensedInHomeState = p.licensedInHomeState ?? 'unknown';
  if (p.earliestVisit !== undefined) next.earliestVisit = p.earliestVisit;
  return next;
}

/**
 * "Call booked for" (request 6): a status of Call booked needs a time. The one given, else (staying at Call booked) the
 * one kept; none at all is refused in words.
 */
function bookedFor(nextStatus: string, given: CallTime | null | undefined, prevStatus: string | null, detail: CandidateDetailJson): CallTime | null | undefined {
  if (nextStatus !== 'call_booked') return undefined;
  const t = given !== undefined ? given : prevStatus === 'call_booked' ? (detail.callBookedFor ?? null) : null;
  if (!t) throw badRequest('a booked call needs a time: say when it is booked for ("Call booked for", e.g. 2026-10-14 3:30 pm)');
  return t;
}

export function createCandidate(raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const input = parseOrThrow(candidateInput, raw);
  const by = nameOf(user);
  const dup = nameKeyTaken(input.name, input.practice ?? null, input.website ?? null);
  if (dup) throw conflict(`${dup.name} is already on the care team list`);
  if (input.personId) assertPerson(input.personId);
  const now = nowIso();
  const values = {
    name: input.name,
    practice: input.practice ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    licensedStatesJson: JSON.stringify(input.licensedStates ?? []),
  };
  const history: StatusChange[] = [{ from: null, to: input.status, at: now, by }];
  let detail: CandidateDetailJson = withDetailFields({ statusHistory: history }, input);
  const booked = bookedFor(input.status, input.callBookedFor, null, detail);
  if (booked) detail = { ...detail, callBookedFor: booked };
  const value = factsOf(values, detail);
  let sources: SourcesByField = {};
  if (input.source) {
    const fields = (input.sourceFields?.length ? input.sourceFields : SOURCED_FIELDS).filter((f) => fieldValueText(f, value(f)));
    for (const f of fields) sources = withSource(sources, f, makeSource(input.source, fieldValueText(f, value(f)), by));
  }
  const id = newId();
  db().transaction(() => {
    const personId = input.personId ?? makePerson({ ...values, role: input.role ?? null });
    db().insert(schema.careCandidates)
      .values({
        id,
        personId,
        ...values,
        role: input.role ?? null,
        status: input.status,
        review: 'accepted',
        notes: input.notes ?? null,
        flareTestJson: '{}',
        sourcesJson: JSON.stringify(sources),
        detailJson: JSON.stringify(detail),
        createdBy: by,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  return getCandidate(id);
}

export function updateCandidate(id: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  const patch = parseOrThrow(candidatePatch, raw);
  // Status belongs to the list: a proposal gets one only through its yes (setStatus says the same).
  if (patch.status !== undefined && patch.status !== row.status && row.review !== 'accepted') throw conflict('say yes to this proposal before changing its status');
  const by = nameOf(user);
  const set: Partial<typeof schema.careCandidates.$inferInsert> = { updatedAt: nowIso() };
  if (patch.name !== undefined) set.name = patch.name;
  for (const k of ['practice', 'city', 'state', 'phone', 'website', 'notes'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.licensedStates !== undefined) set.licensedStatesJson = JSON.stringify(patch.licensedStates);
  if (patch.role !== undefined) set.role = patch.role ?? null;
  if (row.review === 'accepted' && (patch.name !== undefined || patch.practice !== undefined || patch.website !== undefined)) {
    const dup = nameKeyTaken(patch.name ?? row.name, patch.practice !== undefined ? patch.practice : row.practice, patch.website !== undefined ? patch.website : row.website, id);
    if (dup) throw conflict(`${dup.name} is already on the care team list`);
  }
  const before = parseDetail(row.detailJson);
  let detail = withDetailFields(before, patch);
  const next = { ...row, ...set } as CandidateRow;
  const was = factsOf(row, before);
  const now = factsOf(next, detail);
  let sources = parseSources(row.sourcesJson);
  if (patch.source) {
    const changed = SOURCED_FIELDS.filter((f) => fieldValueText(f, now(f)) !== fieldValueText(f, was(f)));
    const fields = (patch.sourceFields?.length ? patch.sourceFields : changed).filter((f) => fieldValueText(f, now(f)));
    for (const f of fields) sources = withSource(sources, f, makeSource(patch.source, fieldValueText(f, now(f)), by));
    set.sourcesJson = JSON.stringify(sources);
  }
  const status = patch.status ?? row.status;
  const booked = patch.status !== undefined || patch.callBookedFor !== undefined ? bookedFor(status, patch.callBookedFor, row.status, detail) : undefined;
  if (booked) detail = { ...detail, callBookedFor: booked };
  if (patch.status !== undefined && patch.status !== row.status) {
    set.status = patch.status;
    detail = { ...detail, statusHistory: [...(detail.statusHistory ?? []), { from: row.status, to: patch.status, at: nowIso(), by, note: null, bookedFor: booked ? callWords(booked) : null }] };
  }
  if (JSON.stringify(detail) !== JSON.stringify(before)) set.detailJson = JSON.stringify(detail);
  db().update(schema.careCandidates).set(set).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

/** A source for one or more facts as they read now. */
export function addSource(id: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  const input = parseOrThrow(addSourceInput, raw);
  const by = nameOf(user);
  const value = factsOf(row);
  const empty = input.fields.filter((f) => !fieldValueText(f, value(f)));
  if (empty.length === input.fields.length) throw badRequest(`nothing to back: ${empty.map((f) => FIELD_WORDS[f]).join(', ')} ${empty.length === 1 ? 'is' : 'are'} empty or Unknown`);
  let sources = parseSources(row.sourcesJson);
  for (const f of input.fields) {
    const text = fieldValueText(f, value(f));
    if (text) sources = withSource(sources, f, makeSource(input.source, text, by));
  }
  db().update(schema.careCandidates).set({ sourcesJson: JSON.stringify(sources), updatedAt: nowIso() }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

/** Take one source off (a mistake); the facts it backed read "Not backed yet" again unless another source holds them. */
export function removeSource(id: string, sourceId: string): CandidateDetail {
  const row = rowOrThrow(id);
  const sources = parseSources(row.sourcesJson);
  let found = false;
  const next: SourcesByField = {};
  for (const f of SOURCED_FIELDS) {
    const list = (sources[f] ?? []).filter((s) => {
      if (s.id === sourceId) found = true;
      return s.id !== sourceId;
    });
    if (list.length) next[f] = list;
  }
  const flare = parseFlareTest(row.flareTestJson);
  for (const k of FLARE_ITEM_KEYS) {
    const a = flare[k];
    if (!a) continue;
    const kept = a.sources.filter((s) => s.id !== sourceId);
    if (kept.length !== a.sources.length) {
      found = true;
      flare[k] = { ...a, sources: kept };
    }
  }
  if (!found) throw notFound('source not found');
  db().update(schema.careCandidates).set({ sourcesJson: JSON.stringify(next), flareTestJson: JSON.stringify(flare), updatedAt: nowIso() }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

export function setStatus(id: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  if (row.review !== 'accepted') throw conflict('say yes to this proposal before changing its status');
  const input = parseOrThrow(statusInput, raw);
  const detail = parseDetail(row.detailJson);
  // Call booked needs a time (request 6); staying at Call booked may change it.
  const booked = bookedFor(input.status, input.callBookedFor, row.status, detail);
  const timeChanged = Boolean(booked) && JSON.stringify(booked) !== JSON.stringify(row.status === 'call_booked' ? detail.callBookedFor : null);
  if (input.status === row.status && !input.note && !timeChanged) return getCandidate(id);
  const note = input.note ?? null;
  const change: StatusChange = { from: row.status, to: input.status, at: nowIso(), by: nameOf(user), note, bookedFor: booked && (timeChanged || input.status !== row.status) ? callWords(booked) : null };
  const next: CandidateDetailJson = { ...detail, ...(booked ? { callBookedFor: booked } : {}), statusHistory: [...(detail.statusHistory ?? []), change] };
  db().update(schema.careCandidates)
    .set({ status: input.status, detailJson: JSON.stringify(next), updatedAt: nowIso() })
    .where(eq(schema.careCandidates.id, id))
    .run();
  return getCandidate(id);
}

/** The home-state license row of the flare test is the Licensed in home state field: it is changed there (one value). */
function refuseFieldItem(item: string): void {
  const def = FLARE_TEST_ITEMS.find((i) => i.key === item);
  if (def?.field) throw badRequest(`"${def.label}" is the ${FIELD_WORDS[def.field]} field: change it there (with its source)`);
}

/**
 * A Flare test answer, typed by a person (the only writer of flare_test_json besides removeSource; called from
 * routes/care-team.ts only). A changed answer keeps the earlier one in its history; its sources stay, but back only the
 * answer they recorded. An empty answer clears the item (history kept).
 */
export function setFlareAnswer(id: string, item: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  if (row.review !== 'accepted') throw conflict('say yes to this proposal before answering its flare test');
  if (!(FLARE_ITEM_KEYS as readonly string[]).includes(item)) throw badRequest(`not a flare test item: ${item}`);
  refuseFieldItem(item);
  const key = item as FlareItemKey;
  const input = parseOrThrow(flareInput, raw);
  const by = nameOf(user);
  const flare = parseFlareTest(row.flareTestJson);
  const prev = flare[key];
  const answer = input.answer.trim();
  const now = nowIso();
  const history = [...(prev?.history ?? []), ...(prev && prev.answer && prev.answer !== answer ? [{ answer: prev.answer, at: prev.answeredAt, by: prev.answeredBy }] : [])].slice(-20);
  let sources = prev?.sources ?? [];
  if (input.source) {
    if (!answer) throw badRequest('type the answer before giving its source');
    sources = [...sources, makeSource(input.source, answer, by)].slice(-SOURCE_CAP);
  }
  flare[key] = { answer, sources, answeredAt: answer === prev?.answer ? prev.answeredAt : now, answeredBy: answer === prev?.answer ? prev.answeredBy : by, history };
  db().update(schema.careCandidates).set({ flareTestJson: JSON.stringify(flare), updatedAt: now }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

/** A source for a Flare test answer as it reads now. */
export function addFlareSource(id: string, item: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  if (!(FLARE_ITEM_KEYS as readonly string[]).includes(item)) throw badRequest(`not a flare test item: ${item}`);
  refuseFieldItem(item);
  const input = parseOrThrow(flareSourceInput, raw);
  const flare = parseFlareTest(row.flareTestJson);
  const a = flare[item as FlareItemKey];
  if (!a || !a.answer.trim()) throw badRequest('this item has no answer yet');
  flare[item as FlareItemKey] = { ...a, sources: [...a.sources, makeSource(input.source, a.answer, nameOf(user))].slice(-SOURCE_CAP) };
  db().update(schema.careCandidates).set({ flareTestJson: JSON.stringify(flare), updatedAt: nowIso() }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

/**
 * The verdict on the whole flare test (request 6): Pass, Fail or Not decided, with a one-line reason (required for Pass
 * and Fail), who decided and when. Typed by a person only: called from routes/care-team.ts and nowhere else (guard
 * test); no AI path and no web proposal sets it. An earlier verdict is kept in its history.
 */
export function setFlareVerdict(id: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  if (row.review !== 'accepted') throw conflict('say yes to this proposal before deciding its flare test');
  const input = parseOrThrow(verdictInput, raw);
  let decidedOn = todayIso();
  if (input.decidedOn) {
    const p = parsePartialDate(input.decidedOn);
    if (!p.iso || p.precision !== 'day') throw badRequest(`decidedOn: could not read "${input.decidedOn}" as a day; type it as 2026-10-09`);
    decidedOn = p.iso;
  }
  const detail = parseDetail(row.detailJson);
  const prev = detail.flareVerdict ?? null;
  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim() || null;
  const verdict: FlareVerdict = {
    verdict: input.verdict,
    reason,
    decidedBy: input.decidedBy || nameOf(user),
    decidedOn,
    recordedBy: nameOf(user),
    recordedAt: nowIso(),
    history: [...(prev?.history ?? []), ...(prev ? [{ verdict: prev.verdict, reason: prev.reason, decidedBy: prev.decidedBy, decidedOn: prev.decidedOn, recordedAt: prev.recordedAt }] : [])].slice(-20),
  };
  db().update(schema.careCandidates).set({ detailJson: JSON.stringify({ ...detail, flareVerdict: verdict }), updatedAt: nowIso() }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

/**
 * "Verified by phone" ticked (request 6): who called and when, typed. A phone source is added beside the web one on each
 * fact it covers (by default every fact a web search found that no phone call holds yet), so "Unverified" goes.
 */
export function verifyByPhone(id: string, raw: unknown, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  if (row.review === 'rejected') throw conflict('this proposal was turned down');
  const input = parseOrThrow(phoneCheckInput, raw);
  const p = parsePartialDate(input.when);
  if (!p.iso) throw badRequest(`when: could not read "${input.when}"; type a day such as 2026-10-09`);
  const by = nameOf(user);
  const sources = parseSources(row.sourcesJson);
  const detail = parseDetail(row.detailJson);
  const value = factsOf(row, detail);
  const unverified = SOURCED_FIELDS.filter((f) => fieldVerification(f, value(f), sources[f]) === 'unverified');
  const fields = (input.fields?.length ? input.fields : unverified).filter((f) => fieldValueText(f, value(f)));
  if (!fields.length) throw badRequest('nothing to verify: no fact found on the web waits for a phone check');
  const checkId = newId();
  const at = nowIso();
  let next = sources;
  for (const f of fields) {
    next = withSource(next, f, { id: newId(), kind: 'phone', who: input.who, when: input.when, whenIso: p.iso, value: fieldValueText(f, value(f)), communicationId: null, checkId, addedBy: by, addedAt: at });
  }
  const check: PhoneCheck = { id: checkId, who: input.who, when: input.when, whenIso: p.iso, fields, by, at };
  db().update(schema.careCandidates)
    .set({ sourcesJson: JSON.stringify(next), detailJson: JSON.stringify({ ...detail, phoneChecks: [...(detail.phoneChecks ?? []), check].slice(-20) }), updatedAt: at })
    .where(eq(schema.careCandidates.id, id))
    .run();
  return getCandidate(id);
}

/**
 * "Verified by phone" unticked: the phone sources its ticks added come off (other sources stay), so the web facts read
 * "Unverified" again. The checks are kept, marked taken back; the answer says what was taken back, for Undo.
 */
export function unverifyByPhone(id: string, user: SessionUser | null = null): CandidateDetail & { undone: PhoneCheck[] } {
  const row = rowOrThrow(id);
  const detail = parseDetail(row.detailJson);
  const active = (detail.phoneChecks ?? []).filter((c) => !c.removedAt);
  if (!active.length) throw badRequest('no "Verified by phone" tick to take back (each phone source can be taken off under Sources)');
  const ids = new Set(active.map((c) => c.id));
  const sources = parseSources(row.sourcesJson);
  const next: SourcesByField = {};
  for (const f of SOURCED_FIELDS) {
    const list = (sources[f] ?? []).filter((s) => !(s.kind === 'phone' && s.checkId && ids.has(s.checkId)));
    if (list.length) next[f] = list;
  }
  const at = nowIso();
  const checks = (detail.phoneChecks ?? []).map((c) => (ids.has(c.id) ? { ...c, removedAt: at, removedBy: nameOf(user) } : c));
  db().update(schema.careCandidates).set({ sourcesJson: JSON.stringify(next), detailJson: JSON.stringify({ ...detail, phoneChecks: checks }), updatedAt: at }).where(eq(schema.careCandidates.id, id)).run();
  return { ...getCandidate(id), undone: active };
}

/** Yes to a web proposal: on the list, status Found, linked to People and places (the chosen row, else a new one). */
export function acceptProposal(id: string, raw: unknown = {}, user: SessionUser | null = null): CandidateDetail {
  const row = rowOrThrow(id);
  if (row.review !== 'proposed') throw conflict(row.review === 'accepted' ? 'already on the care team list' : 'this proposal was turned down');
  const input = parseOrThrow(acceptInput, raw ?? {});
  if (input.personId) assertPerson(input.personId);
  const dup = nameKeyTaken(row.name, row.practice, row.website, id);
  if (dup) throw conflict(`${dup.name} is already on the care team list`);
  const by = nameOf(user);
  const now = nowIso();
  const detail = parseDetail(row.detailJson);
  const next: CandidateDetailJson = {
    ...detail,
    proposal: detail.proposal ? { ...detail.proposal, decidedAt: now, decidedBy: by } : undefined,
    statusHistory: [...(detail.statusHistory ?? []), { from: null, to: 'found', at: now, by, note: 'Yes to a proposal from a web search' }],
  };
  db().transaction(() => {
    const personId = input.personId ?? row.personId ?? makePerson(row);
    db().update(schema.careCandidates).set({ review: 'accepted', status: 'found', personId, detailJson: JSON.stringify(next), updatedAt: now }).where(eq(schema.careCandidates.id, id)).run();
  });
  return getCandidate(id);
}

/** No to a web proposal: kept as turned down, so the same candidate is never proposed again. */
export function rejectProposal(id: string, user: SessionUser | null = null): CandidateItem {
  const row = rowOrThrow(id);
  if (row.review !== 'proposed') throw conflict(row.review === 'accepted' ? 'already on the care team list; delete it instead' : 'already turned down');
  const now = nowIso();
  const detail = parseDetail(row.detailJson);
  const next: CandidateDetailJson = { ...detail, proposal: detail.proposal ? { ...detail.proposal, decidedAt: now, decidedBy: nameOf(user) } : undefined };
  db().update(schema.careCandidates).set({ review: 'rejected', detailJson: JSON.stringify(next), updatedAt: now }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidateItem(id);
}

/** Link to People and places: an existing row (a yes to a match), or a new one. */
export function linkPerson(id: string, raw: unknown = {}): CandidateDetail {
  const row = rowOrThrow(id);
  // Nothing is added without a yes: a proposal gets its People and places row when it is accepted.
  if (row.review !== 'accepted') throw conflict('say yes to this proposal before linking it to People and places');
  const input = parseOrThrow(linkPersonInput, raw ?? {});
  if (input.personId) assertPerson(input.personId);
  const personId = input.personId ?? makePerson(row);
  db().update(schema.careCandidates).set({ personId, updatedAt: nowIso() }).where(eq(schema.careCandidates.id, id)).run();
  return getCandidate(id);
}

/** Soft delete: hidden everywhere, kept on file (its People row, calls and to-dos stay). */
export function deleteCandidate(id: string): void {
  const r = db().update(schema.careCandidates).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(and(eq(schema.careCandidates.id, id), isNull(schema.careCandidates.deletedAt))).run();
  if (r.changes === 0) throw notFound('candidate not found');
}

// ---------------------------------------------------------------------------
// Web proposals (services/web-search.ts makes them; never the Flare test)
// ---------------------------------------------------------------------------


export interface ProposedCandidate {
  name: string;
  practice?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  website?: string | null;
  licensedStates?: string[] | null;
  role?: CareRole | null;
  /** Request 6: what a page states about access, cost and the home-state licence (each with its page, like the rest). */
  accessType?: AccessType | null;
  quotedCost?: string | null;
  licensedInHomeState?: HomeStateLicense | null;
  why?: string | null;
  /** Per field, the web page that states it (url, title, whether it was among the search's results). */
  sources: Array<{ field: SourcedField; url: string; title?: string | null; verified: boolean }>;
}

export interface ProposalResult {
  created: string[];
  duplicates: number;
}

const clip = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Proposals from a web search: rows with review 'proposed' and a web source {url, readAt} on each field they fill.
 * Never the Flare test, its verdict, the step or a booked call. A candidate already on the list, waiting, turned down
 * or deleted is skipped (never proposed again); so is a second copy in the same batch. Every fact a proposal carries
 * reads "Unverified" until someone checks it by phone.
 */
export function createProposals(list: readonly ProposedCandidate[], origin: Omit<ProposalOrigin, 'proposedAt'>, by: string | null): ProposalResult {
  const existing = db().select().from(schema.careCandidates).all();
  const created: string[] = [];
  let duplicates = 0;
  const batch: Array<{ name: string; practice: string | null; website: string | null }> = [];
  const today = todayIso();
  const now = nowIso();
  db().transaction(() => {
    for (const p of list) {
      const name = clip(p.name, 300);
      if (!name) continue;
      const websiteRaw = clip(p.website, 2000);
      const website = websiteRaw ? readUrl(websiteRaw) : null;
      const key = { name, practice: clip(p.practice, 300), website };
      if (existing.some((r) => sameCandidate(key, r)) || batch.some((b) => sameCandidate(key, b))) {
        duplicates++;
        continue;
      }
      batch.push(key);
      const states = (p.licensedStates ?? []).flatMap((s) => splitStates(s)).slice(0, 60);
      const values = { name, practice: key.practice, city: clip(p.city, 120), state: clip(p.state, 60), phone: clip(p.phone, 60), website, licensedStatesJson: JSON.stringify(states) };
      const proposal: ProposalOrigin = { ...origin, why: clip(p.why ?? origin.why, 600), proposedAt: now };
      const detail: CandidateDetailJson = {
        proposal,
        ...(p.accessType && p.accessType !== 'unknown' ? { accessType: readAccessType(p.accessType) } : {}),
        ...(clip(p.quotedCost, 300) ? { quotedCost: clip(p.quotedCost, 300) } : {}),
        ...(p.licensedInHomeState && p.licensedInHomeState !== 'unknown' ? { licensedInHomeState: readHomeStateLicense(p.licensedInHomeState) } : {}),
      };
      const value = factsOf(values, detail);
      let sources: SourcesByField = {};
      for (const s of p.sources) {
        const text = fieldValueText(s.field, value(s.field));
        const url = readUrl(s.url);
        if (!text || !url) continue;
        sources = withSource(sources, s.field, { id: newId(), kind: 'web', url, readAt: today, title: clip(s.title, 400), value: text, origin: 'web_search', verified: s.verified, runId: origin.runId, addedBy: by, addedAt: now });
      }
      const id = newId();
      db().insert(schema.careCandidates)
        .values({ id, personId: null, ...values, role: p.role ?? null, status: 'found', review: 'proposed', notes: null, flareTestJson: '{}', sourcesJson: JSON.stringify(sources), detailJson: JSON.stringify(detail), createdBy: by, createdAt: now, updatedAt: now })
        .run();
      created.push(id);
    }
  });
  return { created, duplicates };
}

/** The own websites of the candidates on the list (accepted, not deleted): "Find doctors" allows them (request 6). */
export function candidateSites(): string[] {
  return db()
    .select({ website: schema.careCandidates.website })
    .from(schema.careCandidates)
    .where(and(isNull(schema.careCandidates.deletedAt), eq(schema.careCandidates.review, 'accepted')))
    .orderBy(asc(schema.careCandidates.createdAt))
    .all()
    .map((r) => r.website)
    .filter((w): w is string => Boolean(w));
}

// ---------------------------------------------------------------------------
// Search runs (settings careTeam.searchRuns: newest first, at most 50)
// ---------------------------------------------------------------------------

export const MAX_RUNS = 50;

export function listSearchRuns(): SearchRun[] {
  const raw = getSetting('careTeam.searchRuns');
  return (Array.isArray(raw) ? raw : []).filter((r): r is SearchRun => Boolean(r && typeof r === 'object' && typeof (r as SearchRun).id === 'string'));
}

export function saveSearchRun(run: SearchRun): void {
  const list = listSearchRuns().filter((r) => r.id !== run.id);
  setSetting('careTeam.searchRuns', [run, ...list].slice(0, MAX_RUNS) as unknown[]);
}

// ---------------------------------------------------------------------------
// Home, "Coming up" (request 6): open follow-ups linked to a candidate, and the next booked flare-test call
// ---------------------------------------------------------------------------

export interface CareComingUp {
  /**
   * The open to-dos linked to a candidate on the list (its name and due date). Not a declined candidate's (review
   * 2026-10-09: a follow-up with someone who said no is not coming up; the to-do itself stays on the To-do list).
   */
  tasks: Array<{ id: string; title: string; dueAt: string | null; candidateId: string; candidateName: string; overdue: boolean }>;
  /** The earliest flare-test call still ahead (status Call booked, with its time), or null. */
  nextCall: { candidateId: string; candidateName: string; at: CallTime; words: string } | null;
}

export function careComingUp(now: Date = new Date()): CareComingUp {
  const today = todayIso(now);
  const tasks = db()
    .all<{ id: string; title: string; dueAt: string | null; candidateId: string; candidateName: string }>(
      sql`select t.id as id, t.title as title, t.due_at as dueAt, c.id as candidateId, c.name as candidateName
        from tasks t join care_candidates c on c.id = t.source_id
        where t.deleted_at is null and t.source_type = 'care_candidate' and t.status in ('open', 'in_progress')
          and c.deleted_at is null and c.review = 'accepted' and c.status <> 'declined'
        order by coalesce(t.due_at, '9999') asc, t.created_at asc limit 30`,
    )
    .map((t) => ({ ...t, overdue: Boolean(t.dueAt && t.dueAt.slice(0, 10) < today) }));
  const calls = selectRows([isNull(schema.careCandidates.deletedAt), eq(schema.careCandidates.review, 'accepted'), eq(schema.careCandidates.status, 'call_booked')])
    .map((r) => ({ id: r.id, name: r.name, at: parseDetail(r.detailJson).callBookedFor ?? null }))
    .filter((c): c is { id: string; name: string; at: CallTime } => Boolean(c.at && isUpcomingCall(c.at, now)))
    .sort((a, b) => callSortKey(a.at).localeCompare(callSortKey(b.at)));
  const first = calls[0];
  return { tasks, nextCall: first ? { candidateId: first.id, candidateName: first.name, at: first.at, words: `Flare-test call with ${first.name}, ${callWords(first.at)}` } : null };
}

// ---------------------------------------------------------------------------
// Make a packet: the Care team summary (request 6), one page for the user to read before deciding
// ---------------------------------------------------------------------------

export interface CareSummaryRow {
  name: string;
  practice: string | null;
  role: string | null;
  status: string;
  declined: boolean;
  verdict: string | null;
  verdictReason: string | null;
  quotedCost: string | null;
  accessType: string;
  licensedInHomeState: string;
  earliestVisit: string | null;
  /** Per shown fact: "unverified" or "not backed yet" (empty when neither). */
  marks: Partial<Record<'name' | 'practice' | 'quotedCost' | 'accessType' | 'licensedInHomeState' | 'earliestVisit', 'unverified' | 'not backed yet'>>;
  unverified: number;
  notBacked: number;
}

export interface CareSummary {
  /** Steps 1 to 4 in order, then "No step yet"; each with its candidates (declined ones last, marked). */
  groups: Array<{ step: CareStep | null; title: string; rows: CareSummaryRow[] }>;
  total: number;
}

/** Accepted candidates only: proposals waiting for a yes and turned-down ones are left out. */
export function careTeamSummary(): CareSummary {
  const items = listCandidates({});
  const mark = (c: CandidateItem, f: SourcedField): 'unverified' | 'not backed yet' | undefined =>
    c.backing[f] === 'not_backed' ? 'not backed yet' : c.verification[f] === 'unverified' ? 'unverified' : undefined;
  const row = (c: CandidateItem): CareSummaryRow => {
    const marks: CareSummaryRow['marks'] = {};
    for (const f of ['name', 'practice', 'quotedCost', 'accessType', 'licensedInHomeState', 'earliestVisit'] as const) {
      const m = mark(c, f);
      if (m) marks[f] = m;
    }
    return {
      name: c.name,
      practice: c.practice,
      role: c.role ? CARE_ROLE_WORDS[c.role] : null,
      status: CARE_STATUS_WORDS[c.status],
      declined: c.status === 'declined',
      verdict: c.flareVerdict ? FLARE_VERDICT_WORDS[c.flareVerdict.verdict] : null,
      verdictReason: c.flareVerdict?.reason ?? null,
      quotedCost: c.quotedCost,
      accessType: fieldWords('accessType', c.accessType),
      licensedInHomeState: fieldWords('licensedInHomeState', c.licensedInHomeState),
      earliestVisit: c.earliestVisit ? fieldWords('earliestVisit', c.earliestVisit) : null,
      marks,
      unverified: c.unverified,
      notBacked: c.notBacked,
    };
  };
  const steps: Array<CareStep | null> = [...CARE_STEPS, null];
  const groups = steps
    .map((step) => {
      const inStep = items.filter((c) => c.step === step);
      // Declined last in each step, marked.
      const ordered = [...inStep.filter((c) => c.status !== 'declined'), ...inStep.filter((c) => c.status === 'declined')];
      return { step, title: stepWords(step), rows: ordered.map(row) };
    })
    .filter((g) => g.rows.length);
  return { groups, total: items.length };
}

// ---------------------------------------------------------------------------
// The clinician's read-only view
// ---------------------------------------------------------------------------

function backedWord(b: Backing, v?: Verification): string {
  return b === 'not_backed' ? ' [not backed yet]' : v === 'unverified' ? ' [unverified: found on the web, not checked by phone]' : '';
}

/**
 * The care team as plain lines for the clinician (get_care_team): who, step, role, status, the Flare test answers and
 * its verdict, and every source. Outside sources and the user's own typing, never the case's records: no provenance tokens.
 */
export function careTeamText(opts: { includeProposals?: boolean; q?: string | null } = {}): string {
  const items = listCandidates({ q: opts.q ?? undefined });
  const proposed = opts.includeProposals ? listCandidates({ view: 'proposed', q: opts.q ?? undefined }) : [];
  if (!items.length && !proposed.length) return 'The care team list is empty: no candidates yet.';
  const lines: string[] = [
    'Care team candidates, in the order the team is being built (step 1 Local doctor, 2 Flare plan, 3 Lead specialist, 4 Expert), typed by the patient or his team, or found on the web and accepted by him. These are not records of the case: sources are web pages (link and the day read) or phone calls (who said it and when). "[not backed yet]" means no source holds the value as it reads now; "[unverified]" means a web search found it and nobody has checked it by phone. The Flare test and its verdict are typed by a person only.',
  ];
  const one = (c: CandidateItem, label: string) => {
    lines.push('');
    lines.push(`${label} ${c.name}${c.practice ? `, ${c.practice}` : ''} | role: ${c.role ? CARE_ROLE_WORDS[c.role] : 'not set'} | status: ${CARE_STATUS_WORDS[c.status]}${c.callBookedFor ? ` (call booked for ${callWords(c.callBookedFor)})` : ''} | step: ${stepWords(c.step)}`);
    const facts: string[] = [];
    const value = factsOf({ ...c, licensedStatesJson: JSON.stringify(c.licensedStates) }, c.detail);
    for (const f of SOURCED_FIELDS) {
      // The name and practice head the entry; they are repeated here only to say "[not backed yet]" or "[unverified]".
      if ((f === 'name' || f === 'practice') && c.backing[f] !== 'not_backed' && c.verification[f] !== 'unverified') continue;
      const text = fieldValueText(f, value(f));
      if (text) facts.push(`${FIELD_WORDS[f].toLowerCase()}: ${fieldWords(f, value(f))}${backedWord(c.backing[f], c.verification[f])}`);
    }
    if (facts.length) lines.push(`  ${facts.join('; ')}`);
    const srcs = SOURCED_FIELDS.flatMap((f) => (c.sources[f] ?? []).map((s) => `${FIELD_WORDS[f].toLowerCase()} from ${sourceLine(s)}${s.kind === 'web' ? ` <${s.url}>` : ''}`));
    if (srcs.length) lines.push(`  sources: ${srcs.join('; ')}`);
    const answered = FLARE_TEST_ITEMS.filter((i) => !i.field && c.flareTest[i.key]?.answer);
    if (answered.length) {
      lines.push(`  Flare test (${c.flareAnswered} of ${FLARE_TEST_ITEMS.length} answered; the home-state license item is the Licensed in home state fact above):`);
      for (const i of answered) {
        const a = c.flareTest[i.key]!;
        lines.push(`    ${i.label}: "${a.answer.replace(/\s+/g, ' ').slice(0, 600)}"${backedWord(flareBacking(a))}${a.sources.length ? ` (${a.sources.map(sourceLine).join('; ')})` : ''}`);
      }
    } else lines.push('  Flare test: not answered yet.');
    if (c.flareVerdict) lines.push(`  Flare test verdict: ${FLARE_VERDICT_WORDS[c.flareVerdict.verdict]}${c.flareVerdict.reason ? ` ("${c.flareVerdict.reason}")` : ''}${c.flareVerdict.decidedBy ? `, decided by ${c.flareVerdict.decidedBy}` : ''}${c.flareVerdict.decidedOn ? ` on ${c.flareVerdict.decidedOn}` : ''}`);
    const hist = c.detail.statusHistory ?? [];
    if (hist.length > 1) lines.push(`  status history: ${hist.map((h) => `${CARE_STATUS_WORDS[h.to as CareStatus] ?? h.to} ${h.at.slice(0, 10)}${h.by ? ` by ${h.by}` : ''}`).join(' → ')}`);
    if (c.calls) lines.push(`  ${c.calls} call${c.calls === 1 ? '' : 's'} or message${c.calls === 1 ? '' : 's'} logged (get_communications with personId ${c.personId})${c.openTasks ? `; ${c.openTasks} open to-do${c.openTasks === 1 ? '' : 's'}` : ''}`);
    if (c.notes) lines.push(`  notes (patient or team): "${c.notes.replace(/\s+/g, ' ').slice(0, 400)}"`);
  };
  for (const c of items) one(c, '-');
  if (proposed.length) {
    lines.push('');
    lines.push('Waiting for the patient\'s yes (found on the web, not on the list yet):');
    for (const c of proposed) one(c, '- (proposal)');
  }
  return lines.join('\n');
}

/** A website as it reads in a list ("example.org/team"). */
export function websiteWords(url: string | null | undefined): string {
  return normalizeWebsite(url);
}
