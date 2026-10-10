/**
 * The care team (2026-10-09, the user's requests 4 and 5): candidates for the team that would look after a flare, the fixed
 * "Flare test" each one is asked, a source on every fact, and web search (off by default) that only proposes.
 * Shared by the server (services/care-team.ts, services/web-search.ts) and the browser (routes/care-team.tsx).
 *
 * Storage is the frozen migration 0006 table care_candidates: role, status and review are text codes; the Flare test
 * answers live in flare_test_json, the sources of each field in sources_json, the status history and a proposal's
 * origin in detail_json. Nothing here touches the database.
 *
 * Request 6 (2026-10-09): roles Strategist, Lead specialist, Local doctor, Vendor (the old keys day_to_day_lead and
 * local_hands read as the new ones everywhere); a step 1 to 4 apart from the role (the list sorts by step, then status);
 * access type, quoted cost, licensed in the home state and earliest visit as facts with sources (Unknown needs none); the
 * flare test's home-state license item is the Licensed in home state fact; a Pass / Fail / Not decided verdict with a one-line
 * reason; "Call booked for"; and "unverified" on any fact only a web search holds, until "Verified by phone". All of
 * it in detail_json (and sources_json), because migration 0006 is frozen.
 */
import { z } from 'zod';
import { normalizeKey } from './text';
import { MODEL_PRICES } from './constants';
import { myIdentity, nameKey, numberKey, parseDob, sameDob, type DayOfBirth, type IdentitySettings } from './patient-identity';
import { dateSortKey, formatPartialDate, parsePartialDate, todayIso, type DatePrecision } from './dates';

// ---------------------------------------------------------------------------
// Roles, statuses, review
// ---------------------------------------------------------------------------

export const CARE_ROLES = ['strategist', 'lead_specialist', 'local_doctor', 'vendor'] as const;
export type CareRole = (typeof CARE_ROLES)[number];
/** The patient's words, exactly (request 6, 2026-10-09: "Day-to-day lead" became "Lead specialist", "Local hands" became "Local doctor"). */
export const CARE_ROLE_WORDS: Record<CareRole, string> = { strategist: 'Strategist', lead_specialist: 'Lead specialist', local_doctor: 'Local doctor', vendor: 'Vendor' };
export const CARE_ROLE_HINTS: Record<CareRole, string> = {
  strategist: 'Sets the overall plan: the specialist who knows the condition.',
  lead_specialist: 'The lead specialist: runs things week to week and answers messages.',
  local_doctor: 'Close by: gives treatment, draws labs, sees you in person.',
  vendor: 'A service: home infusion, pharmacy, nursing, telehealth.',
};
/** The role keys used before request 6, read as the new ones wherever they appear (stored rows, links, old runs). */
export const LEGACY_CARE_ROLES: Readonly<Record<string, CareRole>> = { day_to_day_lead: 'lead_specialist', local_hands: 'local_doctor' };
/** A stored or typed role key as today's key (old keys read as new), or null. */
export function readCareRole(v: unknown): CareRole | null {
  if (typeof v !== 'string') return null;
  const k = LEGACY_CARE_ROLES[v] ?? v;
  return (CARE_ROLES as readonly string[]).includes(k) ? (k as CareRole) : null;
}
/** The stored keys that read as this role (itself and its old key). */
export function careRoleKeys(r: CareRole): string[] {
  return [r, ...Object.entries(LEGACY_CARE_ROLES).filter(([, v]) => v === r).map(([k]) => k)];
}
/** A role in an input: today's keys, and the old keys read as the new ones. */
export const careRoleSchema = z.preprocess((v) => (typeof v === 'string' ? (LEGACY_CARE_ROLES[v] ?? v) : v), z.enum(CARE_ROLES));

// ---------------------------------------------------------------------------
// Steps (request 6): the order the team is being built in. A field of its own, apart from the role.
// ---------------------------------------------------------------------------

export const CARE_STEPS = [1, 2, 3, 4] as const;
export type CareStep = (typeof CARE_STEPS)[number];
/** The patient's words, exactly. */
export const CARE_STEP_WORDS: Record<CareStep, string> = { 1: 'Local doctor', 2: 'Flare plan', 3: 'Lead specialist', 4: 'Expert' };
export function readStep(v: unknown): CareStep | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && (CARE_STEPS as readonly number[]).includes(n) ? (n as CareStep) : null;
}
/** "1 Local doctor"; "No step yet". */
export function stepWords(v: unknown): string {
  const s = readStep(v);
  return s ? `${s} ${CARE_STEP_WORDS[s]}` : 'No step yet';
}
/** Sort order: step 1 first, no step last. */
export function stepOrder(v: unknown): number {
  return readStep(v) ?? CARE_STEPS.length + 1;
}

// ---------------------------------------------------------------------------
// Access, cost, the home-state licence, the earliest visit (request 6): facts about them, each with a source
// ---------------------------------------------------------------------------

export const ACCESS_TYPES = ['cash_pay_priority', 'formal_arrangement', 'insurance', 'unknown'] as const;
export type AccessType = (typeof ACCESS_TYPES)[number];
export const ACCESS_TYPE_WORDS: Record<AccessType, string> = { cash_pay_priority: 'Cash-pay priority', formal_arrangement: 'Formal arrangement', insurance: 'Insurance', unknown: 'Unknown' };
export const HOME_STATE_LICENSE = ['yes', 'no', 'would_get', 'unknown'] as const;
export type HomeStateLicense = (typeof HOME_STATE_LICENSE)[number];
export const HOME_STATE_LICENSE_WORDS: Record<HomeStateLicense, string> = { yes: 'Yes', no: 'No', would_get: 'Would get it', unknown: 'Unknown' };
export function readAccessType(v: unknown): AccessType {
  return typeof v === 'string' && (ACCESS_TYPES as readonly string[]).includes(v) ? (v as AccessType) : 'unknown';
}
export function readHomeStateLicense(v: unknown): HomeStateLicense {
  return typeof v === 'string' && (HOME_STATE_LICENSE as readonly string[]).includes(v) ? (v as HomeStateLicense) : 'unknown';
}

/** A partial date as stored (parsePartialDate): the ISO value at its precision, and the text as typed. */
export interface PartialDateValue {
  value: string | null;
  precision: DatePrecision;
  text: string | null;
}
/** "Call booked for": a partial date and, for a whole day, the time of day when one was typed ("15:30"). */
export interface CallTime extends PartialDateValue {
  time: string | null;
}

/** "3:30 pm", "3pm", "at 15:30", "15.30h" is not read (only H:MM, or H with am/pm). */
const CLOCK_RE = /(?:\bat\s+)?\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?=[\s,.;]|$)|(?:\bat\s+)?\b(\d{1,2}):(\d{2})\b/i;

/** A time of day typed with a call ("3:30 pm" -> "15:30"), or null. */
export function readClock(text: string): string | null {
  const m = text.match(CLOCK_RE);
  if (!m) return null;
  let h: number;
  let min: number;
  if (m[3]) {
    h = Number(m[1]);
    min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12) return null;
    if (m[3].toLowerCase() === 'p' && h !== 12) h += 12;
    if (m[3].toLowerCase() === 'a' && h === 12) h = 0;
  } else {
    h = Number(m[4]);
    min = Number(m[5]);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * "Call booked for", as typed (request 6): "2026-10-14 3:30 pm", "10/14/2026 15:30", "Oct 14 2026 at 3pm", or only a
 * day or a month (partial allowed). The time is kept for a whole day only. Null when no date can be read.
 */
export function readCallTime(text: string | null | undefined): CallTime | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const time = readClock(t.replace(/(\d{4}-\d{1,2}-\d{1,2})T(?=\d)/, '$1 '));
  const day = t.replace(/(\d{4}-\d{1,2}-\d{1,2})T(?=\d)/, '$1 ').replace(CLOCK_RE, ' ').replace(/[\s,]+$/, '').replace(/\s+/g, ' ').trim();
  const p = parsePartialDate(day || t);
  if (!p.iso) return null;
  return { value: p.iso, precision: p.precision, text: t, time: p.precision === 'day' ? time : null };
}

/** Sorts calls: by day, then time (a day without a time after the timed ones that day). */
export function callSortKey(c: Pick<CallTime, 'value' | 'time'>): string {
  return `${dateSortKey(c.value)}T${c.time ?? '99:99'}`;
}

/** Still ahead (or today, for a call with no time): a month or a year counts while it lasts. */
export function isUpcomingCall(c: Pick<CallTime, 'value' | 'precision' | 'time'> | null | undefined, now: Date = new Date()): boolean {
  if (!c?.value) return false;
  const today = todayIso(now);
  if (c.precision === 'year') return c.value.slice(0, 4) >= today.slice(0, 4);
  if (c.precision === 'month') return c.value.slice(0, 7) >= today.slice(0, 7);
  if (c.value.slice(0, 10) !== today) return c.value.slice(0, 10) > today;
  if (!c.time) return true;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return c.time >= hhmm;
}

/** "2026-10-14 15:30", "Feb 2027". */
export function callWords(c: Pick<CallTime, 'value' | 'precision' | 'time' | 'text'> | null | undefined): string {
  if (!c) return '';
  if (!c.value) return c.text ?? '';
  return `${formatPartialDate(c.value, c.precision)}${c.time ? ` ${c.time}` : ''}`;
}

/** In order: the order the list sorts by. */
export const CARE_STATUSES = ['found', 'contacted', 'call_booked', 'answered_flare_test', 'shortlisted', 'declined', 'chosen'] as const;
export type CareStatus = (typeof CARE_STATUSES)[number];
/** The patient's words, exactly. */
export const CARE_STATUS_WORDS: Record<CareStatus, string> = {
  found: 'Found',
  contacted: 'Contacted',
  call_booked: 'Call booked',
  answered_flare_test: 'Answered the flare test',
  shortlisted: 'Shortlisted',
  declined: 'Declined',
  chosen: 'Chosen',
};
export function careStatusOrder(s: string | null | undefined): number {
  const i = (CARE_STATUSES as readonly string[]).indexOf(s ?? '');
  return i < 0 ? CARE_STATUSES.length : i;
}

/** accepted = on the care team list; proposed = found on the web, waiting for a yes; rejected = turned down (never proposed again). */
export const CARE_REVIEWS = ['accepted', 'proposed', 'rejected'] as const;
export type CareReview = (typeof CARE_REVIEWS)[number];

// ---------------------------------------------------------------------------
// The Flare test: fixed, typed in by a person only (never the model, never a web proposal)
// ---------------------------------------------------------------------------

export const FLARE_ITEM_KEYS = ['first_hour', 'iv_order', 'where_it_runs', 'weekends', 'response_time', 'monitoring', 'home_state_license', 'fees'] as const;
export type FlareItemKey = (typeof FLARE_ITEM_KEYS)[number];
export interface FlareItem {
  key: FlareItemKey;
  label: string;
  question: string;
  /** The row shows and edits this candidate field instead of a typed answer (one value, request 6). */
  field?: 'licensedInHomeState';
}
export const FLARE_TEST_ITEMS: readonly FlareItem[] = [
  { key: 'first_hour', label: 'First hour', question: 'What happens in the first hour of a flare, and who does it?' },
  { key: 'iv_order', label: 'Who places the treatment order', question: 'Who places the order for treatment, and how fast?' },
  { key: 'where_it_runs', label: 'Where it is given', question: 'Where is treatment given: a clinic, the ER, at home?' },
  { key: 'weekends', label: 'Weekends', question: 'What happens on a weekend or a holiday?' },
  { key: 'response_time', label: 'Message response time', question: 'How fast are messages answered?' },
  { key: 'monitoring', label: 'Monitoring commitment', question: 'What monitoring do they commit to: labs, check-ins, how often?' },
  // One value with the candidate's "Licensed in home state" field: the row shows and edits that field.
  { key: 'home_state_license', label: 'Home-state license', question: 'Are they licensed in the home state? (the same answer as "Licensed in home state")', field: 'licensedInHomeState' },
  // Request 6: "Cost and what's included" (one cost item; the key stays "fees" for answers already typed).
  { key: 'fees', label: "Cost and what's included", question: 'What does it cost, and what is included: visits, messages, after hours, the treatment order?' },
];
/** The items answered in words, kept in flare_test_json (the home-state license row is the Licensed in home state field). */
export const FLARE_ANSWER_KEYS: readonly FlareItemKey[] = FLARE_TEST_ITEMS.filter((i) => !i.field).map((i) => i.key);
export function flareItemLabel(key: string): string {
  return FLARE_TEST_ITEMS.find((i) => i.key === key)?.label ?? key;
}

/** The verdict on the whole flare test (request 6): typed by a person only, never by Claude or a web search. */
export const FLARE_VERDICTS = ['pass', 'fail', 'not_decided'] as const;
export type FlareVerdictKey = (typeof FLARE_VERDICTS)[number];
export const FLARE_VERDICT_WORDS: Record<FlareVerdictKey, string> = { pass: 'Pass', fail: 'Fail', not_decided: 'Not decided' };
/** The hint under the verdict, in the lead's words. */
export const FLARE_VERDICT_HINT = "Pass: names the person who places the treatment order and gives a time frame in hours. 'Assess and direct to appropriate care' is a fail.";
export const VERDICT_REASON_MAX = 200;
/** What is wrong with a verdict as typed, in words, or null: Pass and Fail need a one-line reason. */
export function verdictProblem(verdict: string, reason: string | null | undefined): string | null {
  const r = (reason ?? '').trim();
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  if (!r) return `Say why in one line: ${verdict === 'pass' ? 'who places the treatment order, and in how many hours' : 'what they said instead'}.`;
  if (/[\r\n]/.test(r)) return 'Keep the reason to one line.';
  if (r.length > VERDICT_REASON_MAX) return `Keep the reason under ${VERDICT_REASON_MAX} characters.`;
  return null;
}
export interface FlareVerdict {
  verdict: FlareVerdictKey;
  reason: string | null;
  /** Who decided, as typed (the person signed in when left blank). */
  decidedBy: string | null;
  /** The day it was decided (YYYY-MM-DD). */
  decidedOn: string | null;
  recordedBy: string | null;
  recordedAt: string;
  /** Earlier verdicts, newest last. */
  history?: Array<{ verdict: FlareVerdictKey; reason: string | null; decidedBy: string | null; decidedOn: string | null; recordedAt: string }>;
}

// ---------------------------------------------------------------------------
// Fields and their sources
// ---------------------------------------------------------------------------

/** The facts about a candidate that need a source. Role, status and notes are yours, not facts about them. */
export const SOURCED_FIELDS = ['name', 'practice', 'city', 'state', 'phone', 'website', 'licensedStates', 'accessType', 'quotedCost', 'licensedInHomeState', 'earliestVisit'] as const;
export type SourcedField = (typeof SOURCED_FIELDS)[number];
export const FIELD_WORDS: Record<SourcedField, string> = {
  name: 'Name',
  practice: 'Practice',
  city: 'City',
  state: 'State',
  phone: 'Phone',
  website: 'Website',
  licensedStates: 'Licensed in',
  accessType: 'Access type',
  quotedCost: 'Quoted cost',
  licensedInHomeState: 'Licensed in home state',
  earliestVisit: 'Earliest visit',
};
/** The fields kept in detail_json (request 6; migration 0006 is frozen), with their sources in sources_json like the rest. */
export const DETAIL_FIELDS = ['accessType', 'quotedCost', 'licensedInHomeState', 'earliestVisit'] as const satisfies readonly SourcedField[];
export type DetailField = (typeof DETAIL_FIELDS)[number];

export const SOURCE_KINDS = ['web', 'phone'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A web page: its link and the day it was read. `origin` web_search = it came with a proposal from a web search. */
export const webSourceSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('web'),
  url: z.string().trim().min(1).max(2000),
  readAt: z.string().regex(DAY_RE),
  title: z.string().max(400).nullish(),
  /** The value it backed when it was recorded (a changed value is not backed by it). */
  value: z.string().max(2000),
  origin: z.enum(['person', 'web_search']).default('person'),
  /** A web search's link: was it among the results that search returned (flagged, never dropped, when not)? */
  verified: z.boolean().nullish(),
  runId: z.string().max(64).nullish(),
  addedBy: z.string().max(200).nullish(),
  addedAt: z.string().max(40),
});
/** Told us by phone: who said it and when (a day, as typed and read), and who wrote it down. */
export const phoneSourceSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('phone'),
  who: z.string().trim().min(1).max(200),
  when: z.string().trim().min(1).max(64),
  whenIso: z.string().max(10).nullish(),
  value: z.string().max(2000),
  communicationId: z.string().max(64).nullish(),
  /** Added by ticking "Verified by phone" (request 6): unticking takes off the sources of that check. */
  checkId: z.string().max(64).nullish(),
  addedBy: z.string().max(200).nullish(),
  addedAt: z.string().max(40),
});
export const careSourceSchema = z.discriminatedUnion('kind', [webSourceSchema, phoneSourceSchema]);
export type WebSource = z.infer<typeof webSourceSchema>;
export type PhoneSource = z.infer<typeof phoneSourceSchema>;
export type CareSource = z.infer<typeof careSourceSchema>;
export type SourcesByField = Partial<Record<SourcedField, CareSource[]>>;

export interface FlareAnswer {
  answer: string;
  sources: CareSource[];
  answeredAt: string;
  answeredBy: string | null;
  /** Earlier answers, newest last (an answer is never lost when it is changed). */
  history?: Array<{ answer: string; at: string; by: string | null }>;
}
export type FlareTest = Partial<Record<FlareItemKey, FlareAnswer>>;

export interface StatusChange {
  from: string | null;
  to: string;
  at: string;
  by: string | null;
  note?: string | null;
  /** Request 6: the time a flare-test call was booked for, in words, when this change set it. */
  bookedFor?: string | null;
}

/** Where a proposal came from (detail_json.proposal). */
export interface ProposalOrigin {
  by: 'find_candidates' | 'ask';
  runId: string | null;
  askMessageId?: string | null;
  why?: string | null;
  proposedAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

/** One tick of "Verified by phone": who called and when (typed), the facts it covered, and who ticked it. */
export interface PhoneCheck {
  id: string;
  who: string;
  when: string;
  whenIso: string | null;
  fields: SourcedField[];
  by: string | null;
  at: string;
  /** Unticked (its sources taken off): when and by whom. */
  removedAt?: string | null;
  removedBy?: string | null;
}

export interface CandidateDetailJson {
  statusHistory?: StatusChange[];
  proposal?: ProposalOrigin;
  /** Request 6, all here because migration 0006 is frozen. Ours: */
  step?: CareStep | null;
  flareVerdict?: FlareVerdict | null;
  callBookedFor?: CallTime | null;
  phoneChecks?: PhoneCheck[];
  /** Facts about them (each with its sources in sources_json): */
  accessType?: AccessType;
  quotedCost?: string | null;
  licensedInHomeState?: HomeStateLicense;
  earliestVisit?: PartialDateValue | null;
}

// ---------------------------------------------------------------------------
// US states (licences are typed as "OH" or "Ohio"; both are one state)
// ---------------------------------------------------------------------------

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [normalizeKey(name), code]));

/** "Ohio", "ohio", "OH", "Oh." -> "OH"; anything else is kept as typed (trimmed), so nothing is lost. */
export function stateCode(s: string | null | undefined): string {
  const t = (s ?? '').trim().replace(/\.$/, '');
  if (!t) return '';
  if (/^[A-Za-z]{2}$/.test(t) && US_STATES[t.toUpperCase()]) return t.toUpperCase();
  return STATE_BY_NAME.get(normalizeKey(t)) ?? t;
}

/** A list of states typed with commas, "and" or slashes. */
export function splitStates(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/[,;/]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Values, backing
// ---------------------------------------------------------------------------

export function normalizeWebsite(url: string | null | undefined): string {
  const t = (url ?? '').trim();
  if (!t) return '';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}`;
  } catch {
    return t.toLowerCase();
  }
}

/**
 * The value of a field as one string (what a source records as the value it backed). Access type and Licensed in home state
 * at Unknown are empty: Unknown needs no source.
 */
export function fieldValueText(field: SourcedField, value: unknown): string {
  if (field === 'licensedStates') return (Array.isArray(value) ? value : []).map((s) => String(s).trim()).filter(Boolean).join(', ');
  if (field === 'accessType' || field === 'licensedInHomeState') return typeof value === 'string' && value !== 'unknown' ? value : '';
  if (field === 'earliestVisit') {
    if (value && typeof value === 'object') {
      const v = value as Partial<PartialDateValue>;
      return (v.value ?? v.text ?? '').trim();
    }
  }
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

/** A field's value in words for the screen and the packet ("Cash-pay priority", "Would get it", "Feb 2027"). */
export function fieldWords(field: SourcedField, value: unknown): string {
  switch (field) {
    case 'accessType':
      return ACCESS_TYPE_WORDS[readAccessType(value)];
    case 'licensedInHomeState':
      return HOME_STATE_LICENSE_WORDS[readHomeStateLicense(value)];
    case 'earliestVisit': {
      const v = value as PartialDateValue | null | undefined;
      if (!v || typeof v !== 'object') return '';
      return v.value ? formatPartialDate(v.value, v.precision) : (v.text ?? '');
    }
    default:
      return fieldValueText(field, value);
  }
}

/** A typed partial date as stored: {value, precision, text}; null when blank. Unreadable text is kept as text. */
export function readPartialDateValue(text: string | null | undefined): PartialDateValue | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const p = parsePartialDate(t);
  return { value: p.iso, precision: p.precision, text: t };
}

/** Two values are the same for backing: case, spacing and punctuation do not count; a phone compares its digits, a state its code. */
export function valueKey(field: SourcedField | 'answer', text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  switch (field) {
    case 'phone':
      return t.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    case 'website':
      return normalizeWebsite(t);
    case 'state':
      return stateCode(t).toLowerCase();
    case 'licensedStates':
      return splitStates(t)
        .map((s) => stateCode(s).toLowerCase())
        .sort()
        .join(',');
    default:
      return normalizeKey(t);
  }
}

/** A source backs the value when it recorded that same value (and a web search's link was among its results). */
export function sourceBacks(field: SourcedField | 'answer', s: CareSource, currentText: string): boolean {
  if (s.kind === 'web' && s.origin === 'web_search' && s.verified === false) return false;
  const now = valueKey(field, currentText);
  return now !== '' && valueKey(field, s.value) === now;
}

export type Backing = 'backed' | 'not_backed' | 'empty';

/** backed: a source holds the value as it reads now; not_backed: "Not backed yet"; empty: nothing to back. */
export function fieldBacking(field: SourcedField, value: unknown, sources: readonly CareSource[] | undefined): Backing {
  const text = fieldValueText(field, value);
  if (!text) return 'empty';
  return (sources ?? []).some((s) => sourceBacks(field, s, text)) ? 'backed' : 'not_backed';
}

/**
 * "Unverified" (request 6): a fact a web search found (a web_search source holds its value) that no phone call holds
 * yet; "by_phone" once one does; null for anything else (typed, sourced by a person's own web page, or not backed).
 */
export type Verification = 'unverified' | 'by_phone' | null;
export function fieldVerification(field: SourcedField, value: unknown, sources: readonly CareSource[] | undefined): Verification {
  const text = fieldValueText(field, value);
  if (!text) return null;
  const holding = (sources ?? []).filter((s) => sourceBacks(field, s, text));
  if (!holding.some((s) => s.kind === 'web' && s.origin === 'web_search')) return null;
  return holding.some((s) => s.kind === 'phone') ? 'by_phone' : 'unverified';
}
/** The tag, in the same style as "not backed yet". */
export const UNVERIFIED_WORDS = 'unverified';
export const UNVERIFIED_TITLE = 'Found by a web search. Nobody has checked it by phone yet: tick "Verified by phone" with who called and when.';

export function flareBacking(a: FlareAnswer | undefined): Backing {
  if (!a || !a.answer.trim()) return 'empty';
  return a.sources.some((s) => sourceBacks('answer', s, a.answer)) ? 'backed' : 'not_backed';
}

/** The words of the existing tag. */
export const NOT_BACKED_WORDS = 'not backed yet';
export const NOT_BACKED_TITLE = 'No source yet. Add a web link with the day it was read, or who told you by phone and when.';

/** A source in one short line: "web, read 2026-10-09: example.org" / "by phone: the front desk, 2026-10-08". */
export function sourceLine(s: CareSource): string {
  if (s.kind === 'web') return `web, read ${s.readAt}: ${normalizeWebsite(s.url) || s.url}${s.origin === 'web_search' && s.verified === false ? ' (link not among the search results)' : ''}`;
  return `by phone: ${s.who}, ${s.whenIso ?? s.when}`;
}

// ---------------------------------------------------------------------------
// One candidate, one row: keys for "never proposed again"
// ---------------------------------------------------------------------------

const TITLE_WORDS = new Set([
  'dr', 'doctor', 'md', 'do', 'phd', 'np', 'pa', 'pac', 'rn', 'aprn', 'dnp', 'fnp', 'facp', 'facs', 'faan', 'mph', 'ms', 'mba', 'msn', 'bsn',
  'cnp', 'crnp', 'lpn', 'pharmd', 'rph', 'mr', 'mrs', 'ms', 'mx', 'prof', 'professor', 'jr', 'sr', 'ii', 'iii',
]);
const ORG_WORDS = new Set(['the', 'llc', 'inc', 'pllc', 'pc', 'pa', 'ltd', 'co', 'corp', 'and', 'of']);

/** "Dr. Jane Q. Example, MD" -> "jane q example". */
export function candidateNameKey(name: string | null | undefined): string {
  return normalizeKey(name)
    .split(' ')
    .filter((w) => w && !TITLE_WORDS.has(w))
    .join(' ');
}
export function practiceKey(p: string | null | undefined): string {
  return normalizeKey(p)
    .split(' ')
    .filter((w) => w && !ORG_WORDS.has(w))
    .join(' ');
}

export interface CandidateKeyInput {
  name: string;
  practice?: string | null;
  website?: string | null;
}

/**
 * The same candidate (lead: dedupe by name plus practice or website): the same name and the same practice or the same
 * website; with neither practice nor website on one side, the same name is enough (so a turned-down proposal is never
 * proposed again in a thinner form).
 */
export function sameCandidate(a: CandidateKeyInput, b: CandidateKeyInput): boolean {
  const na = candidateNameKey(a.name);
  if (!na || na !== candidateNameKey(b.name)) return false;
  const pa = practiceKey(a.practice);
  const pb = practiceKey(b.practice);
  // The same site, whichever page of it (review 2026-10-09: "/" and "/team/orla" are one practice's site).
  const wa = normalizeWebsite(a.website).split('/')[0];
  const wb = normalizeWebsite(b.website).split('/')[0];
  if ((!pa && !wa) || (!pb && !wb)) return true;
  return Boolean((pa && pa === pb) || (wa && wa === wb));
}

// ---------------------------------------------------------------------------
// Web search: cost, and the check every query passes before it may leave
// ---------------------------------------------------------------------------

/** Anthropic's price for the web search tool: $10 per 1,000 searches. */
export const WEB_SEARCH_USD_PER_SEARCH = 0.01;
/**
 * Tokens of results one search adds to what the model reads. Each later step of the server-side loop reads the earlier
 * results again, so the estimate counts them again for every later search (an upper bound; the AI log has the real cost).
 */
export const WEB_SEARCH_RESULT_TOKENS = 8_000;

export interface WebSearchEstimate {
  usd: number;
  searchesUsd: number;
  tokensUsd: number;
  searches: number;
}

/** Up to how much a web search call costs: the searches, plus reading their results (counted again at each later step). */
export function estimateWebSearch(p: { model: string; searches: number; baseInputTokens: number; outputTokens: number }): WebSearchEstimate {
  const price = MODEL_PRICES[p.model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  const n = Math.max(0, Math.floor(p.searches));
  const input = p.baseInputTokens * (n + 1) + (WEB_SEARCH_RESULT_TOKENS * n * (n + 1)) / 2;
  const tokensUsd = (input * price.input + p.outputTokens * price.output) / 1_000_000;
  const searchesUsd = n * WEB_SEARCH_USD_PER_SEARCH;
  return { usd: Math.round((tokensUsd + searchesUsd) * 100) / 100, searchesUsd, tokensUsd, searches: n };
}

/** Find candidates: a few thousand tokens of instructions, and an answer of about 6,000 tokens. */
export function estimateFindCandidates(model: string, searches: number): WebSearchEstimate {
  return estimateWebSearch({ model, searches, baseInputTokens: 3_000, outputTokens: 6_000 });
}
/** Ask's web search: a short call per question, and the clinician reading what it found. */
export function estimateAskWebSearch(model: string, searches: number, clinicianModel?: string): WebSearchEstimate {
  const e = estimateWebSearch({ model, searches, baseInputTokens: 1_000, outputTokens: 2_000 });
  const cm = MODEL_PRICES[clinicianModel ?? model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  // The clinician reads about 600 tokens of results per search, again on each of about two later turns.
  const extra = (searches * 600 * 2 * cm.input) / 1_000_000;
  return { ...e, usd: Math.round((e.usd + extra) * 100) / 100, tokensUsd: e.tokensUsd + extra };
}

/** "About $0.42" / "Less than a cent". */
export function usdWords(n: number): string {
  if (!n || n < 0.01) return 'less than a cent';
  return `about $${n.toFixed(2)}`;
}

export const QUERY_MAX_CHARS = 200;
/** How many words in a row, found in the case's pages, make a query "words from your records". */
export const PHRASE_WORDS = 6;

/** What a query may never hold, in words for the screen. */
export const QUERY_REASON_WORDS = {
  empty: 'Empty.',
  too_long: `Longer than ${QUERY_MAX_CHARS} characters.`,
  name: 'Holds a name from Patient details (yours, another name you go by, or someone confused with you).',
  dob: 'Holds your date of birth.',
  record_number: 'Holds one of your record numbers.',
  long_number: 'Holds a long number (6 digits or more). Record numbers, dates of birth and phone numbers never go to the web.',
  record_text: `Holds ${PHRASE_WORDS} or more words in a row that are in your records. Words from documents never go to the web.`,
  no_identity: 'Patient details (Settings) need your name and date of birth first, so they can be kept out of every search.',
  age: 'Holds an age. Your age comes from your date of birth and never goes to the web.',
} as const;
export type QueryReason = keyof typeof QUERY_REASON_WORDS;

export interface QueryIdentity {
  /** Every word of the patient's name, other first names, and the names of people confused with him (letters only, lower case). */
  nameWords: string[];
  dob: DayOfBirth | null;
  /** Record numbers, keyed (letters and digits only, upper case). */
  recordNumbers: string[];
  /**
   * What Patient details lack (review 2026-10-09): with no name or no full date of birth the check cannot keep them
   * out, so the server refuses every query until both are there (fail closed). Absent = nothing known to be missing.
   */
  missing?: Array<'name' | 'dob'>;
}

const NAME_TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'jr', 'sr', 'ii', 'iii', 'iv']);

/** Patient details as the query check reads them. */
export function queryIdentity(s: IdentitySettings): QueryIdentity {
  const words = new Set<string>();
  const add = (text: string) => {
    for (const w of text.split(/[\s,.;:()"“”]+/)) {
      for (const part of [w, ...w.split(/[-'’]/)]) {
        const k = nameKey(part);
        if (k.length >= 2 && !NAME_TITLES.has(k)) words.add(k);
      }
    }
  };
  add(s.name ?? '');
  const ownNameWords = words.size;
  for (const n of s.otherFirstNames ?? []) add(n);
  for (const n of s.confusedWith ?? []) add(n);
  const me = myIdentity(s);
  const dob = parseDob(s.dob ?? '');
  const fullDob = dob && !dob.twoDigitYear ? dob : me.dob;
  const missing: Array<'name' | 'dob'> = [];
  if (!ownNameWords) missing.push('name');
  if (!fullDob) missing.push('dob');
  return {
    nameWords: [...words],
    dob: fullDob,
    recordNumbers: (s.recordNumbers ?? []).map((r) => numberKey(r.number)).filter((k) => k.length >= 3),
    missing,
  };
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function yearOf(t: string): { y: number; two: boolean } {
  return t.length <= 2 ? { y: 1900 + Number(t), two: true } : { y: Number(t), two: false };
}

/** Every date a query could be naming, read every way it could be read (month first and day first). */
export function datesInText(text: string): DayOfBirth[] {
  const out: DayOfBirth[] = [];
  const push = (y: number, m: number, d: number, two: boolean) => {
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.push({ y, m, d, twoDigitYear: two });
  };
  const t = text.toLowerCase();
  // 1975-06-09, 1975/6/9, 1975.06.09
  for (const m of t.matchAll(/(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/g)) push(+m[1], +m[2], +m[3], false);
  // 6/9/1975, 06-09-75, 9.6.1975 (either order)
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)/g)) {
    const { y, two } = yearOf(m[3]);
    push(y, +m[1], +m[2], two);
    push(y, +m[2], +m[1], two);
  }
  // June 9, 1975 / Jun. 9th 1975 / June 9 75
  for (const m of t.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})(?!\d)/g)) {
    const mo = MONTHS[m[1]];
    if (!mo) continue;
    const { y, two } = yearOf(m[3]);
    push(y, mo, +m[2], two);
  }
  // 9 June 1975 / 9th of June, 1975 / 09-Jun-1975
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?[\s-]+([a-z]{3,9})\.?[\s,-]+(\d{4}|\d{2})(?!\d)/g)) {
    const mo = MONTHS[m[2]];
    if (!mo) continue;
    const { y, two } = yearOf(m[3]);
    push(y, mo, +m[1], two);
  }
  // 19750609 (the long-number rule refuses these too, but the reason is clearer)
  for (const m of t.matchAll(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g)) push(+m[1], +m[2], +m[3], false);
  for (const m of t.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)/g)) {
    push(+m[3], +m[1], +m[2], false);
    push(+m[3], +m[2], +m[1], false);
  }
  return out;
}

/** Digits joined across the marks a number is written with: "614-555-0134", "(614) 555 0134", "12.345.678". */
export function longestDigitRun(text: string): number {
  const joined = text.replace(/(?<=\d)[\s\-./()]+(?=[\d(])/g, '').replace(/\(/g, '');
  let best = 0;
  for (const m of joined.matchAll(/\d+/g)) best = Math.max(best, m[0].length);
  return best;
}

/** The words of a query as the full-text index reads them (letters and digits, lower case, accents folded). */
export function queryWords(text: string): string[] {
  return normalizeKey(text).split(' ').filter(Boolean);
}

/** Every run of PHRASE_WORDS words in a row (the phrase check looks each one up in the case's pages). */
export function phraseWindows(text: string, size = PHRASE_WORDS): string[][] {
  const w = queryWords(text);
  const out: string[][] = [];
  for (let i = 0; i + size <= w.length; i++) out.push(w.slice(i, i + size));
  return out;
}

export interface QueryCheck {
  query: string;
  ok: boolean;
  reasons: QueryReason[];
}

/**
 * An age ("44 year old", "44-year-old", "44 yo", "44 y/o", "aged 44", "age: 44", "44 years of age"): derived from his
 * date of birth, so never sent (review 2026-10-09: queries hold condition terms, roles and places only). "10 years
 * experience" and "open 7 days" are not ages.
 */
const AGE_RES = [
  /\b\d{1,3}\s*-?\s*(?:years?|yrs?|y)\s*-?\s*old\b/i,
  /\b\d{1,3}\s*(?:y\/o|yo)\b/i,
  /\bage[ds]?\s*:?\s*\d{1,3}\b/i,
  /\b\d{1,3}\s*(?:years?|yrs?)\s+of\s+age\b/i,
];

/**
 * The check every web query passes (pure; the server adds the phrase lookup in the case's pages through `inRecords`).
 * Refused: a name from Patient details, his date of birth in any common format, one of his record numbers, any long
 * number, or a run of PHRASE_WORDS words found in the records.
 */
export function checkWebQuery(raw: string, id: QueryIdentity, inRecords?: (words: string[]) => boolean): QueryCheck {
  const query = (raw ?? '').replace(/\s+/g, ' ').trim();
  const reasons: QueryReason[] = [];
  if (!query) return { query, ok: false, reasons: ['empty'] };
  if (query.length > QUERY_MAX_CHARS) reasons.push('too_long');
  const names = new Set(id.nameWords);
  if (names.size) {
    const words = query.split(/[^\p{L}'’-]+/u).flatMap((w) => [w, ...w.split(/[-'’]/)]);
    if (words.some((w) => names.has(nameKey(w)))) reasons.push('name');
  }
  if (id.dob && datesInText(query).some((d) => sameDob(d, id.dob!))) reasons.push('dob');
  if (id.recordNumbers.length) {
    const all = numberKey(query);
    const tokens = new Set(query.split(/\s+/).map(numberKey).filter(Boolean));
    if (id.recordNumbers.some((k) => (k.length >= 5 ? all.includes(k) : tokens.has(k)))) reasons.push('record_number');
  }
  if (longestDigitRun(query) >= 6) reasons.push('long_number');
  if (AGE_RES.some((re) => re.test(query))) reasons.push('age');
  if (inRecords && phraseWindows(query).some((w) => inRecords(w))) reasons.push('record_text');
  return { query, ok: reasons.length === 0, reasons };
}

export function queryReasonWords(reasons: readonly QueryReason[]): string {
  return reasons.map((r) => QUERY_REASON_WORDS[r]).join(' ');
}

// ---------------------------------------------------------------------------
// Find candidates: typed criteria, never case content
// ---------------------------------------------------------------------------

export const findCriteriaSchema = z.object({
  /** Condition terms or the need ("type 2 diabetes", "insulin pump training"). */
  condition: z.string().trim().max(160).default(''),
  /** The kind of clinician or service ("neurologist", "home infusion"). */
  kind: z.string().trim().max(120).default(''),
  role: careRoleSchema.nullish(),
  /** A place ("Columbus, Ohio"). */
  place: z.string().trim().max(120).default(''),
  /** The state they must be licensed in ("Ohio"). */
  licensedIn: z.string().trim().max(60).default(''),
});
export type FindCriteria = z.infer<typeof findCriteriaSchema>;

/** The queries the app suggests from the criteria (each is checked before it is sent; you may edit them). */
export function suggestQueries(c: Partial<FindCriteria>, max = 4): string[] {
  const kind = (c.kind ?? '').trim();
  const cond = (c.condition ?? '').trim();
  const place = (c.place ?? '').trim();
  const lic = (c.licensedIn ?? '').trim();
  const out = [
    [kind, cond, place].filter(Boolean).join(' '),
    kind && place ? `${kind} ${place}` : '',
    cond ? `${cond} specialist${place ? ` ${place}` : ''}` : '',
    lic ? `${kind || cond || 'clinician'} licensed in ${lic} telehealth` : '',
  ];
  const seen = new Set<string>();
  return out
    .map((q) => q.replace(/\s+/g, ' ').trim())
    .filter((q) => q && !seen.has(q.toLowerCase()) && (seen.add(q.toLowerCase()), true))
    .slice(0, max);
}

/** A search run, kept on the Care team page with its queries (the AI log keeps only the counts and the cost). */
export interface SearchRun {
  id: string;
  kind: 'find' | 'ask';
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt?: string | null;
  by: string | null;
  criteria?: FindCriteria | null;
  /** The queries sent, each checked first. */
  queries: string[];
  /** Queries refused by the check, with why (never sent). */
  refused: Array<{ query: string; reasons: QueryReason[] }>;
  /** The searches the web tool actually made (as it reported them). */
  queriesMade: string[];
  /** A search the tool made that the check would have refused (it should never happen; shown when it does). */
  flagged?: Array<{ query: string; reasons: QueryReason[] }>;
  maxSearches: number;
  searches: number;
  estimateUsd: number;
  usd: number;
  /** Results (links) it read. */
  results: number;
  proposed: number;
  /** Candidates it found that are already on the list, or were turned down before. */
  duplicates: number;
  error?: string | null;
  askMessageId?: string | null;
  aiCallId?: string | null;
  /** Request 6: the search scope used ("Find doctors" or "Open"; absent on runs made before it). */
  scope?: 'find_doctors' | 'open';
  /** The sites the web tool was allowed (Find doctors; none for Open), and those past the limit of 64, left out. */
  domains?: string[];
  domainsLeftOut?: string[];
  /** The web search tool version used. */
  toolVersion?: string;
}

/** A web page the clinician's web search read, numbered for the answer ("[web 2]"): an outside source, never a citation. */
export interface AskWebSource {
  n: number;
  url: string;
  title: string;
  readAt: string;
  pageAge: string | null;
}

/** One search_the_web call in an answer: what was sent, what was refused (never sent), the searches made. */
export interface AskWebSearchNote {
  runId: string | null;
  queries: string[];
  refused: Array<{ query: string; reasons: QueryReason[] }>;
  searches: number;
}

export const RUN_STATUS_WORDS: Record<SearchRun['status'], string> = { running: 'searching', done: 'done', failed: 'did not work', stopped: 'stopped' };
