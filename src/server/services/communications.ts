/**
 * Communications: every contact event, who took part (communication_participants),
 * what it was about (communication_topics), and what was promised (follow-up
 * fields). Answers "who has spoken to whom about what, when, and what did they
 * promise" through the matrix and follow-up queries. Keeps `entities_fts` in
 * sync so a subject, summary, topic, or participant name is searchable.
 *
 * This module has no import from ./people; people.ts imports from here.
 */
import { and, eq, inArray, isNull, isNotNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { indexEntity, removeEntityIndex } from './search';
import { badRequest, notFound, parseOrThrow } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { isPastDue, parsePartialDate, todayIso, type DatePrecision } from '../../shared/dates';
import { COMM_CHANNELS, COMM_DIRECTIONS, PARTICIPANT_ROLES } from '../../shared/enums';
import { USER_EDITABLE_COMM_FIELDS, parseCommunicationDetails, type CommunicationDetails } from '../../shared/schemas/segments';
import { isVerifiedMatch, locateCitation, storedMatchKind } from '../ai/citations';
import { messageTier } from '../../shared/trust';

// ---------------------------------------------------------------------------
// Validation helpers (shared with people.ts)
// ---------------------------------------------------------------------------

/** Parse with zod; a failure becomes a 400 listing every issue (util/errors parseOrThrow). */
export function parseInput<T>(schemaDef: z.ZodType<T>, data: unknown): T {
  return parseOrThrow(schemaDef, data);
}

/** Optional free text: '' and whitespace become null; undefined stays undefined (not provided). */
export const optText = (max = 4000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null));

/** Optional enum: '' becomes null; undefined stays undefined. */
export const optEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === '' ? null : v), z.enum(values).nullish());

export const participantInput = z.object({
  personId: z.string().trim().min(1),
  role: z.enum(PARTICIPANT_ROLES).default('to'),
});

/** Field schemas without defaults; the create schema adds them, the patch schema must not. */
const communicationFields = {
  occurredAt: optText(32),
  occurredAtText: optText(200),
  direction: z.enum(COMM_DIRECTIONS),
  channel: z.enum(COMM_CHANNELS),
  subject: z.string().trim().min(1, 'subject is required').max(500),
  summary: optText(20000),
  outcome: optText(20000),
  followUpPromised: optText(2000),
  followUpDue: optText(32),
  followUpDueText: optText(200),
  followUpOwnerPersonId: optText(64),
  documentId: optText(64),
  encounterId: optText(64),
  participants: z.array(participantInput).max(100),
  topics: z.array(z.string().max(120)).max(100),
};

export const communicationInput = z.object({
  ...communicationFields,
  direction: communicationFields.direction.default('outbound'),
  channel: communicationFields.channel.default('portal'),
  participants: communicationFields.participants.default([]),
  topics: communicationFields.topics.default([]),
});
/**
 * Built from the undefaulted fields: zod 4 keeps a `.default()` under
 * `.partial()`, which would turn a one-field PATCH into "no participants, no
 * topics, outbound, portal".
 */
export const communicationPatch = z.object(communicationFields).partial();
/** What callers pass in (raw, before transforms). The services parse it themselves. */
export type CommunicationInput = z.input<typeof communicationInput>;
export type CommunicationPatch = z.input<typeof communicationPatch>;

/** Topics are free tags, lower-case and trimmed, unique per communication. */
export function normaliseTopics(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    for (const part of raw.split(',')) {
      const t = part.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Keep one row per person; the first role given wins. */
function normaliseParticipants(list: Array<{ personId: string; role: string }>): Array<{ personId: string; role: string }> {
  const seen = new Set<string>();
  const out: Array<{ personId: string; role: string }> = [];
  for (const p of list) {
    if (seen.has(p.personId)) continue;
    seen.add(p.personId);
    out.push(p);
  }
  return out;
}

function resolveDate(iso: string | null | undefined, text: string | null | undefined): { iso: string | null; precision: DatePrecision; text: string | null } {
  if (iso) {
    const p = parsePartialDate(iso);
    if (p.iso) return { iso: p.iso, precision: p.precision, text: text ?? null };
  }
  const p = parsePartialDate(text);
  return { iso: p.iso, precision: p.precision, text: p.text };
}

/**
 * The follow-up due date. There is no column for the text as written, so a
 * due date that does not parse is refused (400) rather than silently stored
 * as "no date". Empty or null input still clears it.
 */
function resolveDue(iso: string | null | undefined, text: string | null | undefined): string | null {
  const raw = (text ?? iso ?? '').trim();
  const r = resolveDate(iso, text);
  if (raw && !r.iso) throw badRequest(`followUpDue: could not read a date from "${raw.slice(0, 80)}"; write it as 2025-03-18, 3/18/2025 or March 2025`);
  return r.iso;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommunicationRow = typeof schema.communications.$inferSelect;

export interface CommParticipant {
  personId: string;
  name: string;
  kind: string;
  role: string;
}

export interface CommWithParticipants extends CommunicationRow {
  participants: CommParticipant[];
  topics: string[];
  documentTitle: string | null;
  encounterTitle: string | null;
  followUpOwnerName: string | null;
  /** Open promised follow-up whose due day is before today. */
  overdue: boolean;
}

export interface CommunicationFilters {
  personId?: string | null;
  channel?: string | null;
  direction?: string | null;
  topic?: string | null;
  from?: string | null;
  to?: string | null;
  openFollowUps?: boolean;
  q?: string | null;
  documentId?: string | null;
  encounterId?: string | null;
  /** true: only messages read out of records (origin extracted); false: only rows logged by hand, filed or imported. */
  fromRecords?: boolean | null;
  /** One thread's messages (communications.thread_key). */
  threadKey?: string | null;
  limit?: number;
}

export interface MatrixCell {
  personId: string;
  name: string;
  topic: string;
  count: number;
  lastAt: string | null;
  openFollowUps: number;
}

/** One row per person: distinct communications, so a multi-topic one counts once. */
export interface MatrixPersonTotal {
  personId: string;
  name: string;
  count: number;
  lastAt: string | null;
  openFollowUps: number;
}

/** One entry per topic column: distinct communications, so a multi-participant one counts once. */
export interface MatrixTopicTotal {
  topic: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Has the due period fully passed? Compared at the stored precision: a
 * month-precision due date ('2025-10') is overdue only from November, a
 * year-only one only from the next year. `today` is YYYY-MM-DD. Same rule as
 * tasks (isPastDue in src/shared/dates.ts); kept under this name for callers.
 */
export function isFollowUpOverdue(due: string | null | undefined, today: string): boolean {
  return isPastDue(due, today);
}

function isOverdue(row: CommunicationRow, today: string): boolean {
  return Boolean(row.followUpPromised && !row.followUpDoneAt && isFollowUpOverdue(row.followUpDue, today));
}

/** Attach participants, topics and joined titles to raw rows, in three queries. */
export function hydrate(rows: CommunicationRow[]): CommWithParticipants[] {
  if (!rows.length) return [];
  const d = db();
  const ids = rows.map((r) => r.id);
  const today = todayIso();

  const parts = d
    .select({
      communicationId: schema.communicationParticipants.communicationId,
      personId: schema.communicationParticipants.personId,
      role: schema.communicationParticipants.role,
      name: schema.people.name,
      kind: schema.people.kind,
    })
    .from(schema.communicationParticipants)
    .innerJoin(schema.people, and(eq(schema.people.id, schema.communicationParticipants.personId), isNull(schema.people.deletedAt)))
    .where(inArray(schema.communicationParticipants.communicationId, ids))
    .orderBy(sql`case ${schema.communicationParticipants.role} when 'from' then 0 when 'to' then 1 when 'cc' then 2 else 3 end`, sql`${schema.people.name} collate nocase`)
    .all();
  const topics = d
    .select({ communicationId: schema.communicationTopics.communicationId, topic: schema.communicationTopics.topic })
    .from(schema.communicationTopics)
    .where(inArray(schema.communicationTopics.communicationId, ids))
    .orderBy(schema.communicationTopics.topic)
    .all();

  const docIds = [...new Set(rows.map((r) => r.documentId).filter((x): x is string => Boolean(x)))];
  const encIds = [...new Set(rows.map((r) => r.encounterId).filter((x): x is string => Boolean(x)))];
  const ownerIds = [...new Set(rows.map((r) => r.followUpOwnerPersonId).filter((x): x is string => Boolean(x)))];
  const docTitles = new Map(
    docIds.length ? d.select({ id: schema.documents.id, title: schema.documents.title }).from(schema.documents).where(and(inArray(schema.documents.id, docIds), isNull(schema.documents.deletedAt))).all().map((x) => [x.id, x.title]) : [],
  );
  const encTitles = new Map(
    encIds.length ? d.select({ id: schema.encounters.id, title: schema.encounters.title }).from(schema.encounters).where(and(inArray(schema.encounters.id, encIds), isNull(schema.encounters.deletedAt))).all().map((x) => [x.id, x.title]) : [],
  );
  const ownerNames = new Map(
    ownerIds.length ? d.select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(and(inArray(schema.people.id, ownerIds), isNull(schema.people.deletedAt))).all().map((x) => [x.id, x.name]) : [],
  );

  const partsBy = new Map<string, CommParticipant[]>();
  for (const p of parts) {
    if (!partsBy.has(p.communicationId)) partsBy.set(p.communicationId, []);
    partsBy.get(p.communicationId)!.push({ personId: p.personId, name: p.name, kind: p.kind, role: p.role });
  }
  const topicsBy = new Map<string, string[]>();
  for (const t of topics) {
    if (!topicsBy.has(t.communicationId)) topicsBy.set(t.communicationId, []);
    topicsBy.get(t.communicationId)!.push(t.topic);
  }
  return rows.map((r) => ({
    ...r,
    participants: partsBy.get(r.id) ?? [],
    topics: topicsBy.get(r.id) ?? [],
    documentTitle: r.documentId ? (docTitles.get(r.documentId) ?? null) : null,
    encounterTitle: r.encounterId ? (encTitles.get(r.encounterId) ?? null) : null,
    followUpOwnerName: r.followUpOwnerPersonId ? (ownerNames.get(r.followUpOwnerPersonId) ?? null) : null,
    overdue: isOverdue(r, today),
  }));
}

/** SQL text: the row (table or alias `t`) was read out of a record (details_json.origin = 'extracted'). */
function fromRecordsSql(t: string): string {
  return `(json_valid(${t}.details_json) and json_extract(${t}.details_json, '$.origin') = 'extracted')`;
}

/** SQL text: not a message read out of a record that has since been deleted (its record went, so does it). */
export function visibleWithRecordSql(t: string): string {
  return `not (${fromRecordsSql(t)} and ${t}.document_id is not null and not exists (select 1 from documents dv where dv.id = ${t}.document_id and dv.deleted_at is null))`;
}

/** SQL: the row was read out of a record (details_json.origin = 'extracted'). */
export const FROM_RECORDS = sql.raw(fromRecordsSql('"communications"'));
/** SQL: not a message read out of a record that has since been deleted. */
export const VISIBLE_WITH_RECORD = sql.raw(visibleWithRecordSql('"communications"'));
const VISIBLE_C = sql.raw(visibleWithRecordSql('c'));

export function listCommunications(filters: CommunicationFilters = {}): CommWithParticipants[] {
  const c = schema.communications;
  const conds: SQL[] = [isNull(c.deletedAt)];
  if (filters.personId) conds.push(sql`exists (select 1 from communication_participants cp where cp.communication_id = ${c.id} and cp.person_id = ${filters.personId})`);
  if (filters.topic) {
    const t = filters.topic.trim().toLowerCase();
    if (t === '' || t === '(none)') conds.push(sql`not exists (select 1 from communication_topics t where t.communication_id = ${c.id})`);
    else conds.push(sql`exists (select 1 from communication_topics t where t.communication_id = ${c.id} and t.topic = ${t})`);
  }
  if (filters.channel && (COMM_CHANNELS as readonly string[]).includes(filters.channel)) conds.push(eq(c.channel, filters.channel));
  if (filters.direction && (COMM_DIRECTIONS as readonly string[]).includes(filters.direction)) conds.push(eq(c.direction, filters.direction));
  if (filters.documentId) conds.push(eq(c.documentId, filters.documentId));
  if (filters.encounterId) conds.push(eq(c.encounterId, filters.encounterId));
  if (filters.threadKey) conds.push(eq(c.threadKey, filters.threadKey));
  if (filters.fromRecords === true) conds.push(sql`${FROM_RECORDS}`);
  if (filters.fromRecords === false) conds.push(sql`not ${FROM_RECORDS}`);
  // A message read out of a record goes with its record: once the record is deleted, its messages are not listed.
  conds.push(sql`${VISIBLE_WITH_RECORD}`);
  // Partial dates ('2025-04', '2025') overlap a window when they agree at the
  // shorter of the two precisions: April 2025 is inside 2025-04-01..2025-04-30,
  // and a day in April is inside to='2025-04'. Null dates stay excluded.
  if (filters.from) conds.push(sql`substr(${c.occurredAt}, 1, length(${filters.from})) >= substr(${filters.from}, 1, length(${c.occurredAt}))`);
  if (filters.to) conds.push(sql`substr(${c.occurredAt}, 1, length(${filters.to})) <= substr(${filters.to}, 1, length(${c.occurredAt}))`);
  if (filters.openFollowUps) conds.push(and(isNotNull(c.followUpPromised), isNull(c.followUpDoneAt))!);
  const limit = Math.min(Math.max(Number(filters.limit ?? 2000), 1), 10000);
  // Same-day messages by their printed time (occurred_time), newest first.
  const order = sql`(${c.occurredAt} is null) asc, ${c.occurredAt} desc, coalesce(${c.occurredTime}, '') desc, ${c.createdAt} desc`;
  const d = db();
  const q = filters.q?.trim().toLowerCase();
  if (!q) {
    return hydrate(d.select().from(c).where(and(...conds)).orderBy(order).limit(limit).all());
  }
  // The text filter runs before the limit, so an older match is not cut off
  // by it. Same haystack as before: subject, summary, outcome, promise,
  // topics and live participant names, case-insensitive substring.
  // Spelled out with the table name: in a single-table select drizzle drops the
  // qualifier from ${c.id}, which the subqueries would read as their own `id`.
  const outerId = sql.raw('"communications"."id"');
  const candidates = d
    .select({
      id: c.id,
      subject: c.subject,
      summary: c.summary,
      outcome: c.outcome,
      followUpPromised: c.followUpPromised,
      body: c.body,
      topics: sql<string | null>`(select group_concat(t.topic, ' ') from communication_topics t where t.communication_id = ${outerId})`,
      names: sql<string | null>`(select group_concat(p.name, ' ') from communication_participants cp join people p on p.id = cp.person_id and p.deleted_at is null where cp.communication_id = ${outerId})`,
    })
    .from(c)
    .where(and(...conds))
    .orderBy(order)
    .all();
  const ids = candidates
    .filter((r) => [r.subject, r.summary, r.outcome, r.followUpPromised, r.body, r.topics, r.names].filter(Boolean).join(' ').toLowerCase().includes(q))
    .slice(0, limit)
    .map((r) => r.id);
  if (!ids.length) return [];
  const byId = new Map(d.select().from(c).where(inArray(c.id, ids)).all().map((r) => [r.id, r]));
  return hydrate(ids.map((id) => byId.get(id)).filter((r): r is CommunicationRow => Boolean(r)));
}

export function getCommunication(id: string): CommWithParticipants {
  const row = db()
    .select()
    .from(schema.communications)
    .where(and(eq(schema.communications.id, id), isNull(schema.communications.deletedAt)))
    .get();
  if (!row) throw notFound('communication not found');
  return hydrate([row])[0];
}

/** Person × topic cells. Communications with no topic appear under topic ''. */
export function communicationMatrix(): MatrixCell[] {
  return db()
    .all<MatrixCell>(sql`
    select cp.person_id as personId, p.name as name, coalesce(t.topic, '') as topic,
      count(distinct c.id) as count, max(c.occurred_at) as lastAt,
      count(distinct case when c.follow_up_promised is not null and c.follow_up_done_at is null then c.id end) as openFollowUps
    from communications c
    join communication_participants cp on cp.communication_id = c.id
    join people p on p.id = cp.person_id and p.deleted_at is null
    left join communication_topics t on t.communication_id = c.id
    where c.deleted_at is null and ${VISIBLE_C}
    group by cp.person_id, coalesce(t.topic, '')
    order by p.name collate nocase, count desc, topic
  `)
    .map((r) => ({ ...r, count: Number(r.count), openFollowUps: Number(r.openFollowUps) }));
}

/**
 * Per-person and per-topic rollups for the matrix, counted over distinct
 * communications. Summing cells would count a communication once per topic
 * (person totals) or once per participant (topic totals).
 */
export function communicationMatrixTotals(): { people: MatrixPersonTotal[]; topics: MatrixTopicTotal[] } {
  const d = db();
  const people = d
    .all<MatrixPersonTotal>(sql`
    select cp.person_id as personId, p.name as name,
      count(distinct c.id) as count, max(c.occurred_at) as lastAt,
      count(distinct case when c.follow_up_promised is not null and c.follow_up_done_at is null then c.id end) as openFollowUps
    from communications c
    join communication_participants cp on cp.communication_id = c.id
    join people p on p.id = cp.person_id and p.deleted_at is null
    where c.deleted_at is null and ${VISIBLE_C}
    group by cp.person_id
    order by count desc, p.name collate nocase
  `)
    .map((r) => ({ ...r, count: Number(r.count), openFollowUps: Number(r.openFollowUps) }));
  const topics = d
    .all<MatrixTopicTotal>(sql`
    select coalesce(t.topic, '') as topic, count(distinct c.id) as count
    from communications c
    join communication_participants cp on cp.communication_id = c.id
    join people p on p.id = cp.person_id and p.deleted_at is null
    left join communication_topics t on t.communication_id = c.id
    where c.deleted_at is null and ${VISIBLE_C}
    group by coalesce(t.topic, '')
    order by count desc, topic
  `)
    .map((r) => ({ topic: r.topic, count: Number(r.count) }));
  return { people, topics };
}

/** Open promised follow-ups, soonest due first, undated last. `includeDone` appends completed ones (most recent first). */
export function listFollowUps(opts: { includeDone?: boolean; personId?: string | null } = {}): CommWithParticipants[] {
  const c = schema.communications;
  const conds: SQL[] = [isNull(c.deletedAt), isNotNull(c.followUpPromised), sql`${VISIBLE_WITH_RECORD}`];
  if (!opts.includeDone) conds.push(isNull(c.followUpDoneAt));
  if (opts.personId) conds.push(sql`exists (select 1 from communication_participants cp where cp.communication_id = ${c.id} and cp.person_id = ${opts.personId})`);
  const rows = db()
    .select()
    .from(c)
    .where(and(...conds))
    // A month- or year-precision due date sorts at the end of its period ('2025-03' after '2025-03-31').
    .orderBy(
      sql`(${c.followUpDoneAt} is not null) asc, (${c.followUpDue} is null) asc, case length(${c.followUpDue}) when 4 then ${c.followUpDue} || '-12-31' when 7 then ${c.followUpDue} || '-31' else ${c.followUpDue} end asc, ${c.followUpDoneAt} desc, ${c.occurredAt} desc`,
    )
    .all();
  return hydrate(rows);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function assertPeople(ids: string[], what: string): void {
  if (!ids.length) return;
  const found = new Set(
    db()
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(inArray(schema.people.id, ids), isNull(schema.people.deletedAt)))
      .all()
      .map((r) => r.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw badRequest(`${what}: unknown person id ${missing.join(', ')}`);
}

function assertDocument(id: string | null | undefined): void {
  if (!id) return;
  const ok = db().select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt))).get();
  if (!ok) throw badRequest('documentId does not refer to an existing document');
}

function assertEncounter(id: string | null | undefined): void {
  if (!id) return;
  const ok = db().select({ id: schema.encounters.id }).from(schema.encounters).where(and(eq(schema.encounters.id, id), isNull(schema.encounters.deletedAt))).get();
  if (!ok) throw badRequest('encounterId does not refer to an existing encounter');
}

export function reindexCommunication(id: string): void {
  const row = db()
    .select()
    .from(schema.communications)
    .where(and(eq(schema.communications.id, id), isNull(schema.communications.deletedAt)))
    .get();
  if (!row) {
    removeEntityIndex('communication', id);
    return;
  }
  const [h] = hydrate([row]);
  // The verbatim body of a message read out of a record is searchable too (capped: a long letter stays findable by its start).
  const body = [h.summary, h.outcome, h.followUpPromised, ...h.topics, ...h.participants.map((p) => p.name), h.channel, h.direction, h.body ? h.body.slice(0, 20000) : null].filter(Boolean).join(' · ');
  indexEntity('communication', id, h.subject, body);
}

function writeParticipants(id: string, list: Array<{ personId: string; role: string }>): void {
  const d = db();
  d.delete(schema.communicationParticipants).where(eq(schema.communicationParticipants.communicationId, id)).run();
  for (const p of normaliseParticipants(list)) {
    d.insert(schema.communicationParticipants).values({ id: newId(), communicationId: id, personId: p.personId, role: p.role }).run();
  }
}

function writeTopics(id: string, list: string[]): void {
  const d = db();
  d.delete(schema.communicationTopics).where(eq(schema.communicationTopics.communicationId, id)).run();
  for (const t of normaliseTopics(list)) {
    d.insert(schema.communicationTopics).values({ id: newId(), communicationId: id, topic: t }).run();
  }
}

/**
 * `opts.details` (internal callers only): the row's details_json, e.g. `{ origin: 'filed' }` from automatic filing. A row
 * made by hand gets none (it reads as manual).
 */
export function createCommunication(raw: CommunicationInput, opts: { details?: CommunicationDetails } = {}): CommWithParticipants {
  const input = parseInput(communicationInput, raw);
  const participants = normaliseParticipants(input.participants);
  assertPeople(participants.map((p) => p.personId), 'participants');
  // Due date and owner only exist while something was promised; without a promise they are ignored.
  const promised = Boolean(input.followUpPromised);
  if (promised && input.followUpOwnerPersonId) assertPeople([input.followUpOwnerPersonId], 'followUpOwnerPersonId');
  assertDocument(input.documentId);
  assertEncounter(input.encounterId);
  const when = resolveDate(input.occurredAt, input.occurredAtText);
  const dueIso = promised ? resolveDue(input.followUpDue, input.followUpDueText) : null;
  const d = db();
  const id = newId();
  const now = nowIso();
  // The row, its people, its topics and its search entry are written together (sweep 2026-10-07, PAT-6).
  d.transaction(() => {
    d.insert(schema.communications)
      .values({
        id,
        occurredAt: when.iso,
        occurredAtPrecision: when.precision,
        occurredAtText: when.text,
        direction: input.direction,
        channel: input.channel,
        subject: input.subject,
        summary: input.summary ?? null,
        outcome: input.outcome ?? null,
        followUpPromised: input.followUpPromised ?? null,
        followUpDue: dueIso,
        followUpDoneAt: null,
        followUpOwnerPersonId: promised ? (input.followUpOwnerPersonId ?? null) : null,
        documentId: input.documentId ?? null,
        encounterId: input.encounterId ?? null,
        createdAt: now,
        updatedAt: now,
        ...(opts.details ? { detailsJson: JSON.stringify(opts.details) } : {}),
      })
      .run();
    writeParticipants(id, participants);
    writeTopics(id, input.topics);
    reindexCommunication(id);
  });
  return getCommunication(id);
}

export function updateCommunication(id: string, raw: CommunicationPatch): CommWithParticipants {
  const patch = parseInput(communicationPatch, raw);
  const d = db();
  const existing = d
    .select()
    .from(schema.communications)
    .where(and(eq(schema.communications.id, id), isNull(schema.communications.deletedAt)))
    .get();
  if (!existing) throw notFound('communication not found');
  // The promise this row will have after the patch. Due date and owner are
  // kept only while it exists (same rule as create), so stale due/owner values
  // sent alongside a withdrawn promise are ignored, not re-applied.
  const promise = patch.followUpPromised !== undefined ? patch.followUpPromised : existing.followUpPromised;
  if (patch.participants !== undefined) assertPeople(normaliseParticipants(patch.participants).map((p) => p.personId), 'participants');
  if (promise && patch.followUpOwnerPersonId) assertPeople([patch.followUpOwnerPersonId], 'followUpOwnerPersonId');
  if (patch.documentId !== undefined) assertDocument(patch.documentId);
  if (patch.encounterId !== undefined) assertEncounter(patch.encounterId);
  const touchesDue = patch.followUpDue !== undefined || patch.followUpDueText !== undefined;
  const dueIso = promise && touchesDue ? resolveDue(patch.followUpDue, patch.followUpDueText) : null;

  const set: Partial<typeof schema.communications.$inferInsert> = { updatedAt: nowIso() };
  if (patch.occurredAt !== undefined || patch.occurredAtText !== undefined) {
    // Each field is taken as sent (this branch runs only when one was sent):
    // occurredAtText null or '' clears the date rather than falling back to the stored text.
    const when = resolveDate(patch.occurredAt, patch.occurredAtText ?? null);
    set.occurredAt = when.iso;
    set.occurredAtPrecision = when.precision;
    set.occurredAtText = when.text;
  }
  if (patch.direction !== undefined) set.direction = patch.direction;
  if (patch.channel !== undefined) set.channel = patch.channel;
  if (patch.subject !== undefined) set.subject = patch.subject;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.outcome !== undefined) set.outcome = patch.outcome;
  if (patch.followUpPromised !== undefined) set.followUpPromised = patch.followUpPromised;
  if (!promise) {
    if (patch.followUpPromised !== undefined || touchesDue || patch.followUpOwnerPersonId !== undefined) {
      // No promise (withdrawn now, or never made): the rest of the follow-up block is empty.
      set.followUpDue = null;
      set.followUpDoneAt = null;
      set.followUpOwnerPersonId = null;
    }
  } else {
    if (touchesDue) set.followUpDue = dueIso;
    if (patch.followUpOwnerPersonId !== undefined) set.followUpOwnerPersonId = patch.followUpOwnerPersonId;
  }
  if (patch.documentId !== undefined) set.documentId = patch.documentId;
  if (patch.encounterId !== undefined) set.encounterId = patch.encounterId;
  // The fields the user changed are theirs from now on: a re-read of the record never writes them again.
  const sent = patch as Record<string, unknown>;
  const touched = USER_EDITABLE_COMM_FIELDS.filter((f) => sent[f] !== undefined || (f === 'occurredAt' && sent.occurredAtText !== undefined) || (f === 'followUpDue' && sent.followUpDueText !== undefined));
  if (touched.length) set.detailsJson = JSON.stringify(withUserFields(parseCommunicationDetails(existing.detailsJson), touched));
  d.transaction(() => {
    d.update(schema.communications).set(set).where(eq(schema.communications.id, id)).run();
    if (patch.participants !== undefined) writeParticipants(id, patch.participants);
    if (patch.topics !== undefined) writeTopics(id, patch.topics);
    reindexCommunication(id);
  });
  return getCommunication(id);
}

export function deleteCommunication(id: string): void {
  db().transaction(() => {
    const r = db()
      .update(schema.communications)
      .set({ deletedAt: nowIso(), updatedAt: nowIso() })
      .where(and(eq(schema.communications.id, id), isNull(schema.communications.deletedAt)))
      .run();
    if (r.changes === 0) throw notFound('communication not found');
    removeEntityIndex('communication', id);
  });
}

export function markFollowUpDone(id: string): CommWithParticipants {
  const existing = getCommunication(id);
  if (!existing.followUpPromised) throw badRequest('this communication has no promised follow-up');
  const detailsJson = JSON.stringify(withUserFields(parseCommunicationDetails(existing.detailsJson), ['followUpDone']));
  db().update(schema.communications).set({ followUpDoneAt: nowIso(), updatedAt: nowIso(), detailsJson }).where(eq(schema.communications.id, id)).run();
  return getCommunication(id);
}

export function reopenFollowUp(id: string): CommWithParticipants {
  const existing = getCommunication(id);
  if (!existing.followUpPromised) throw badRequest('this communication has no promised follow-up');
  const detailsJson = JSON.stringify(withUserFields(parseCommunicationDetails(existing.detailsJson), ['followUpDone']));
  db().update(schema.communications).set({ followUpDoneAt: null, updatedAt: nowIso(), detailsJson }).where(eq(schema.communications.id, id)).run();
  return getCommunication(id);
}

/**
 * Details with these fields added to `userFields` (fields the user changed by hand: a re-read of the record never writes
 * them). `followUpDone` is recorded when the user marks a follow-up done or reopens it. Every other key is kept.
 */
export function withUserFields(details: CommunicationDetails, fields: readonly string[]): CommunicationDetails {
  const set = new Set(details.userFields ?? []);
  for (const f of fields) set.add(f);
  return { ...details, userFields: [...set] };
}

/**
 * The trust tier of the messages read out of a document follows the document's tier (a patient's body inside a
 * clinical record is `patient`; a reply keeps the record's tier): worked out again when the document's tier changes
 * (it is often sorted after its messages were read). Only rows read out of records; returns rows changed.
 */
export function refreshMessageTiers(documentId: string): number {
  const d = db();
  const doc = d.select({ tier: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!doc) return 0;
  let n = 0;
  for (const r of d.select({ id: schema.communications.id, detailsJson: schema.communications.detailsJson }).from(schema.communications).where(and(eq(schema.communications.documentId, documentId), isNull(schema.communications.deletedAt))).all()) {
    const det = parseCommunicationDetails(r.detailsJson);
    if (det.origin !== 'extracted' || !det.voice) continue;
    const tier = messageTier(doc.tier, det.voice);
    if (det.tier === tier) continue;
    d.update(schema.communications).set({ detailsJson: JSON.stringify({ ...det, tier }) }).where(eq(schema.communications.id, r.id)).run();
    n++;
  }
  // A row filed on its own that is the same message as one this record prints (its `record_copy`) is trusted as the
  // record prints it too, unless it has a tier of its own (2026-10-07 review, rev-comms #10: it stayed `unknown`).
  const like = `%${documentId}%`;
  for (const r of d
    .select({ id: schema.communications.id, detailsJson: schema.communications.detailsJson })
    .from(schema.communications)
    .where(and(isNull(schema.communications.deletedAt), sql`${schema.communications.detailsJson} like ${like}`, sql`coalesce(${schema.communications.documentId}, '') <> ${documentId}`))
    .all()) {
    const det = parseCommunicationDetails(r.detailsJson);
    if (det.origin === 'extracted' || !det.voice) continue;
    if (!(det.copies ?? []).some((c) => c.kind === 'record_copy' && c.documentId === documentId)) continue;
    if (det.tier && det.tier !== 'unknown') continue;
    const tier = messageTier(doc.tier, det.voice);
    if (det.tier === tier) continue;
    d.update(schema.communications).set({ detailsJson: JSON.stringify({ ...det, tier }) }).where(eq(schema.communications.id, r.id)).run();
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Citations of a communication (messages read out of records)
// ---------------------------------------------------------------------------

export interface NewCommunicationCitation {
  documentId: string;
  pageNumber: number;
  quote: string;
}

/**
 * A citation of a communication (`citations.communication_id`, fact_id NULL): the quote is looked for on its page (and
 * the pages either side) in the stored text, then in the other forms given (the reading-order text rebuilt from the
 * page's line boxes: a message's header rows are printed in columns). Found in another form only: verified, without
 * offsets (they would not point into the stored text). Not found: stored unverified (match kind none), never dropped.
 * A citation already stored for this communication (same document, page and quote) is not stored twice.
 */
export function insertVerifiedCommunicationCitation(
  communicationId: string,
  c: NewCommunicationCitation,
  lookup: (pageNumber: number) => string | undefined,
  alternates: ReadonlyArray<(pageNumber: number) => string | undefined> = [],
): { id: string; verified: boolean; inserted: boolean } {
  const d = db();
  const same = d
    .select({ id: schema.citations.id, verified: schema.citations.verified })
    .from(schema.citations)
    .where(and(eq(schema.citations.communicationId, communicationId), eq(schema.citations.documentId, c.documentId), eq(schema.citations.pageNumber, c.pageNumber), eq(schema.citations.quote, c.quote)))
    .get();
  if (same) return { id: same.id, verified: Boolean(same.verified), inserted: false };
  let found = locateCitation(lookup, c.pageNumber, c.quote, { allowNumericMismatch: true });
  let offsets = true;
  if (!isVerifiedMatch(found)) {
    for (const alt of alternates) {
      const m = locateCitation(alt, c.pageNumber, c.quote);
      if (m && isVerifiedMatch(m)) {
        found = m;
        offsets = false;
        break;
      }
    }
  }
  const id = newId();
  d.insert(schema.citations)
    .values({
      id,
      factId: null,
      communicationId,
      documentId: c.documentId,
      pageNumber: found?.page ?? Math.max(1, Math.trunc(c.pageNumber) || 1),
      quote: c.quote,
      charStart: offsets ? (found?.start ?? null) : null,
      charEnd: offsets ? (found?.end ?? null) : null,
      verified: isVerifiedMatch(found),
      matchKind: storedMatchKind(found),
      createdAt: nowIso(),
    })
    .run();
  return { id, verified: isVerifiedMatch(found), inserted: true };
}

/** Distinct topics in use, most used first (for filter chips and the form). */
export function listTopics(): Array<{ topic: string; count: number }> {
  return db()
    .all<{ topic: string; count: number }>(sql`
    select t.topic as topic, count(distinct c.id) as count
    from communication_topics t join communications c on c.id = t.communication_id and c.deleted_at is null
    group by t.topic order by count desc, t.topic
  `)
    .map((r) => ({ topic: r.topic, count: Number(r.count) }));
}
