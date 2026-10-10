/**
 * Encounters: visits, telehealth, procedures, admissions, tests. Each carries
 * prep notes, a questions checklist (`questions_json`: { text, asked, answer }),
 * outcomes, and the documents that came out of it. The prep payload gathers
 * everything worth re-reading before the visit (last contacts with the
 * clinician, open follow-ups, recent facts, medications, hard stops, tasks,
 * record gaps) and a deterministic briefing prompt for the consult dock.
 */
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { indexEntity, removeEntityIndex } from './search';
import { listCommunications, listFollowUps, type CommWithParticipants } from './communications';
import { inferGaps, type Gap } from './records';
import { listTasks, optText, parseInput, type PlanHardStop, type PlanMedication, type TaskListItem } from './tasks';
import { buildCalendar, parseTimeText, type IcsEvent } from './ics';
import { badRequest, notFound } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { formatPartialDate, parsePartialDate, todayIso, type DatePrecision } from '../../shared/dates';
import { ENCOUNTER_KINDS, ENCOUNTER_STATUSES } from '../../shared/enums';
import { LONG_TEXT_MAX } from '../../shared/constants';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface EncounterQuestion {
  text: string;
  asked: boolean;
  answer: string | null;
}

const questionInput = z.object({
  text: z.string().trim().min(1).max(LONG_TEXT_MAX),
  asked: z.boolean().default(false),
  answer: optText(4000),
});

/** Questions arrive as objects or, from older data and quick entry, as plain strings. */
export const questionsInput = z
  .array(z.union([z.string().max(LONG_TEXT_MAX), questionInput]))
  .max(200)
  .transform((list) => normaliseQuestions(list));

export function normaliseQuestions(list: unknown): EncounterQuestion[] {
  if (!Array.isArray(list)) return [];
  const out: EncounterQuestion[] = [];
  for (const q of list) {
    if (typeof q === 'string') {
      const text = q.trim();
      if (text) out.push({ text, asked: false, answer: null });
    } else if (q && typeof q === 'object') {
      const o = q as { text?: unknown; asked?: unknown; answer?: unknown };
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      if (!text) continue;
      const answer = typeof o.answer === 'string' && o.answer.trim() ? o.answer.trim() : null;
      out.push({ text, asked: Boolean(o.asked), answer });
    }
  }
  return out;
}

const encounterFields = {
  title: z.string().trim().min(1, 'title is required').max(500),
  kind: z.enum(ENCOUNTER_KINDS),
  status: z.enum(ENCOUNTER_STATUSES),
  occurredAt: optText(32),
  occurredAtText: optText(200),
  timeText: optText(32),
  clinicianId: optText(64),
  institutionId: optText(64),
  location: optText(500),
  prepNotes: optText(20000),
  questions: questionsInput,
  outcomes: optText(20000),
  documentIds: z.array(z.string().trim().min(1)).max(200),
};

export const encounterInput = z.object({
  ...encounterFields,
  kind: encounterFields.kind.default('visit'),
  status: encounterFields.status.default('upcoming'),
  questions: encounterFields.questions.default([]),
  documentIds: encounterFields.documentIds.default([]),
});
export const encounterPatch = z.object(encounterFields).partial();
export type EncounterInput = z.input<typeof encounterInput>;
export type EncounterPatch = z.input<typeof encounterPatch>;

export const completeInput = z.object({ outcomes: optText(20000) });

export const listQuery = z.object({
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  clinicianId: z.string().optional(),
  institutionId: z.string().optional(),
  q: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EncounterRow = typeof schema.encounters.$inferSelect;
type EncounterInsert = typeof schema.encounters.$inferInsert;

export interface EncounterListItem extends EncounterRow {
  clinicianName: string | null;
  clinicianSpecialty: string | null;
  institutionName: string | null;
  questions: EncounterQuestion[];
  documentIds: string[];
  questionCount: number;
  askedCount: number;
  documentCount: number;
  communicationCount: number;
}

export interface EncounterDocument {
  id: string;
  title: string;
  category: string;
  documentDate: string | null;
  documentDatePrecision: string;
}

export interface EncounterDetail extends EncounterListItem {
  documents: EncounterDocument[];
  communications: CommWithParticipants[];
  tasks: TaskListItem[];
}

export interface PrepFact {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  status: string;
  sourceDocumentId: string | null;
  documentTitle: string | null;
}

export interface EncounterPrep {
  encounter: EncounterDetail;
  clinician: (typeof schema.people.$inferSelect & { institutionName: string | null }) | null;
  lastContacts: CommWithParticipants[];
  openFollowUps: CommWithParticipants[];
  /** Facts dated since the last completed encounter with this clinician (or the last 90 days). */
  recentFacts: PrepFact[];
  recentSince: string;
  activeMedications: PlanMedication[];
  hardStops: PlanHardStop[];
  /** Tasks this clinician owes. */
  openTasksForOwner: TaskListItem[];
  /** Tasks that came out of this encounter. */
  encounterTasks: TaskListItem[];
  gaps: Gap[];
  briefingPrompt: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const selectColumns = {
  id: schema.encounters.id,
  title: schema.encounters.title,
  kind: schema.encounters.kind,
  status: schema.encounters.status,
  occurredAt: schema.encounters.occurredAt,
  occurredAtPrecision: schema.encounters.occurredAtPrecision,
  occurredAtText: schema.encounters.occurredAtText,
  timeText: schema.encounters.timeText,
  clinicianId: schema.encounters.clinicianId,
  institutionId: schema.encounters.institutionId,
  location: schema.encounters.location,
  prepNotes: schema.encounters.prepNotes,
  questionsJson: schema.encounters.questionsJson,
  outcomes: schema.encounters.outcomes,
  documentIdsJson: schema.encounters.documentIdsJson,
  createdAt: schema.encounters.createdAt,
  updatedAt: schema.encounters.updatedAt,
  deletedAt: schema.encounters.deletedAt,
  clinicianName: sql<string | null>`(select p.name from people p where p.id = encounters.clinician_id and p.deleted_at is null)`,
  clinicianSpecialty: sql<string | null>`(select p.specialty from people p where p.id = encounters.clinician_id and p.deleted_at is null)`,
  institutionName: sql<string | null>`(select i.name from people i where i.id = encounters.institution_id and i.deleted_at is null)`,
  communicationCount: sql<number>`(select count(*) from communications c where c.encounter_id = encounters.id and c.deleted_at is null)`.mapWith(Number),
};

type RawRow = Omit<EncounterListItem, 'questions' | 'documentIds' | 'questionCount' | 'askedCount' | 'documentCount'>;

/** Every document id stored on the row, including links to documents soft-deleted since. */
function storedDocumentIds(json: string): string[] {
  const raw = parseJson<unknown>(json, []);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** The ids among `ids` that name a document that exists and is not soft-deleted. One query, one bound parameter. */
function liveDocumentIds(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const list = JSON.stringify([...new Set(ids)]);
  return new Set(db().all<{ id: string }>(sql`select d.id from documents d where d.deleted_at is null and d.id in (select value from json_each(${list}))`).map((r) => r.id));
}

/**
 * `documentIds` / `documentCount` list live documents only, so they agree with
 * `documents`. Links to a soft-deleted document stay in the stored JSON (it is
 * hidden, not erased) but are not shown, counted, or sent back by the client.
 */
function decorate(r: RawRow, live: Set<string>): EncounterListItem {
  const questions = normaliseQuestions(parseJson<unknown>(r.questionsJson, []));
  const ids = storedDocumentIds(r.documentIdsJson).filter((id) => live.has(id));
  return {
    ...r,
    clinicianName: r.clinicianName ?? null,
    clinicianSpecialty: r.clinicianSpecialty ?? null,
    institutionName: r.institutionName ?? null,
    communicationCount: Number(r.communicationCount ?? 0),
    questions,
    documentIds: ids,
    questionCount: questions.length,
    askedCount: questions.filter((q) => q.asked).length,
    documentCount: ids.length,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listEncounters(raw: unknown = {}): EncounterListItem[] {
  const f = parseInput(listQuery, raw ?? {});
  const e = schema.encounters;
  const conds: SQL[] = [isNull(e.deletedAt)];
  const statuses = (f.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => (ENCOUNTER_STATUSES as readonly string[]).includes(s));
  if (statuses.length) conds.push(inArray(e.status, statuses));
  if (f.clinicianId) conds.push(eq(e.clinicianId, f.clinicianId));
  if (f.institutionId) conds.push(eq(e.institutionId, f.institutionId));
  // Partial dates ('2026-11', '2026') overlap a window when they agree at the
  // shorter of the two precisions (the communications predicate): November
  // 2026 is inside from=2026-11-15, and a day in November is inside to=2026-11.
  // Undated encounters stay excluded once a bound is given.
  if (f.from) conds.push(sql`substr(${e.occurredAt}, 1, length(${f.from})) >= substr(${f.from}, 1, length(${e.occurredAt}))`);
  if (f.to) conds.push(sql`substr(${e.occurredAt}, 1, length(${f.to})) <= substr(${f.to}, 1, length(${e.occurredAt}))`);
  const q = f.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conds.push(sql`(${e.title} like ${like} escape '\\' or ${e.location} like ${like} escape '\\' or ${e.prepNotes} like ${like} escape '\\' or ${e.outcomes} like ${like} escape '\\')`);
  }
  const rows = db()
    .select(selectColumns)
    .from(e)
    .where(and(...conds))
    .orderBy(sql`(${e.occurredAt} is null) asc`, asc(e.occurredAt), asc(e.timeText), asc(e.createdAt))
    .all();
  const live = liveDocumentIds(rows.flatMap((r) => storedDocumentIds(r.documentIdsJson)));
  return rows.map((r) => decorate(r, live));
}

function getRow(id: string): EncounterListItem {
  const row = db()
    .select(selectColumns)
    .from(schema.encounters)
    .where(and(eq(schema.encounters.id, id), isNull(schema.encounters.deletedAt)))
    .get();
  if (!row) throw notFound('encounter not found');
  return decorate(row, liveDocumentIds(storedDocumentIds(row.documentIdsJson)));
}

function documentsFor(ids: string[]): EncounterDocument[] {
  if (!ids.length) return [];
  const rows = db()
    .select({ id: schema.documents.id, title: schema.documents.title, category: schema.documents.category, documentDate: schema.documents.documentDate, documentDatePrecision: schema.documents.documentDatePrecision })
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, ids), isNull(schema.documents.deletedAt)))
    .all();
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter((x): x is EncounterDocument => Boolean(x));
}

export function getEncounter(id: string): EncounterDetail {
  const row = getRow(id);
  return {
    ...row,
    documents: documentsFor(row.documentIds),
    communications: listCommunications({ encounterId: id }),
    tasks: listTasks({ sourceType: 'encounter', sourceId: id }),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function assertPerson(id: string | null | undefined, field: string): void {
  if (!id) return;
  const ok = db().select({ id: schema.people.id }).from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get();
  if (!ok) throw badRequest(`${field}: unknown person id ${id}`);
}

function assertDocuments(ids: string[]): void {
  if (!ids.length) return;
  const found = new Set(
    db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, ids), isNull(schema.documents.deletedAt)))
      .all()
      .map((r) => r.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw badRequest(`documentIds: unknown document id ${missing.join(', ')}`);
}

function resolveDate(iso: string | null | undefined, text: string | null | undefined): { iso: string | null; precision: DatePrecision; text: string | null } {
  if (iso) {
    const p = parsePartialDate(iso);
    if (p.iso) return { iso: p.iso, precision: p.precision, text: text ?? null };
  }
  const p = parsePartialDate(text);
  return { iso: p.iso, precision: p.precision, text: p.text };
}

function institutionOfPerson(personId: string | null | undefined): string | null {
  if (!personId) return null;
  return db().select({ institutionId: schema.people.institutionId }).from(schema.people).where(eq(schema.people.id, personId)).get()?.institutionId ?? null;
}

/** The search entry: the visit, plus its prep notes, outcomes and every question with the answer written under it. */
function indexEncounter(row: EncounterListItem): void {
  const body = [row.kind, row.status, row.clinicianName, row.institutionName, row.location, row.prepNotes, row.outcomes, ...row.questions.map((q) => [q.text, q.answer].filter(Boolean).join(' '))].filter(Boolean).join(' · ');
  indexEntity('encounter', row.id, row.title, body);
}

/**
 * Rewrite the search entry of every live encounter (one transaction). Entries
 * written before answers were indexed only gain them on the next save; this
 * brings them all up to date at once. Returns the count.
 */
export function reindexEncountersSearch(): number {
  const rows = listEncounters();
  db().transaction(() => {
    for (const r of rows) indexEncounter(r);
  });
  return rows.length;
}

export function createEncounter(raw: unknown): EncounterDetail {
  const input = parseInput(encounterInput, raw);
  assertPerson(input.clinicianId, 'clinicianId');
  assertPerson(input.institutionId, 'institutionId');
  assertDocuments(input.documentIds);
  const when = resolveDate(input.occurredAt, input.occurredAtText);
  const now = nowIso();
  const row: EncounterInsert = {
    id: newId(),
    title: input.title,
    kind: input.kind,
    status: input.status,
    occurredAt: when.iso,
    occurredAtPrecision: when.precision,
    occurredAtText: when.text,
    timeText: input.timeText ?? null,
    clinicianId: input.clinicianId ?? null,
    // A clinician's institution is the default venue.
    institutionId: input.institutionId ?? institutionOfPerson(input.clinicianId),
    location: input.location ?? null,
    prepNotes: input.prepNotes ?? null,
    questionsJson: JSON.stringify(input.questions),
    outcomes: input.outcomes ?? null,
    documentIdsJson: JSON.stringify([...new Set(input.documentIds)]),
    createdAt: now,
    updatedAt: now,
  };
  db().insert(schema.encounters).values(row).run();
  const saved = getRow(row.id);
  indexEncounter(saved);
  return getEncounter(row.id);
}

export function updateEncounter(id: string, raw: unknown): EncounterDetail {
  const current = getRow(id);
  const patch = parseInput(encounterPatch, raw);
  // Only newly chosen people and documents must exist. A clinician, institution or document soft-deleted
  // since it was linked stays referenced, so the encounter can still be edited (the dialog sends the ids back).
  if (patch.clinicianId !== undefined && patch.clinicianId !== current.clinicianId) assertPerson(patch.clinicianId, 'clinicianId');
  if (patch.institutionId !== undefined && patch.institutionId !== current.institutionId) assertPerson(patch.institutionId, 'institutionId');
  let documentIdsJson: string | undefined;
  if (patch.documentIds !== undefined) {
    const stored = storedDocumentIds(current.documentIdsJson);
    const already = new Set(stored);
    assertDocuments([...new Set(patch.documentIds.filter((x) => !already.has(x)))]);
    // Links to soft-deleted documents are invisible to the client, so it cannot have meant to drop them: keep them, hidden.
    const live = liveDocumentIds([...stored, ...patch.documentIds]);
    const hidden = stored.filter((x) => !live.has(x));
    documentIdsJson = JSON.stringify([...new Set([...patch.documentIds.filter((x) => live.has(x)), ...hidden])]);
  }
  const set: Partial<EncounterInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.occurredAt !== undefined || patch.occurredAtText !== undefined) {
    // Each field is taken as sent: occurredAtText null (or '') clears the date rather than falling back to the stored text.
    const when = resolveDate(patch.occurredAt, patch.occurredAtText ?? null);
    set.occurredAt = when.iso;
    set.occurredAtPrecision = when.precision;
    set.occurredAtText = when.text;
  }
  if (patch.timeText !== undefined) set.timeText = patch.timeText;
  if (patch.clinicianId !== undefined) set.clinicianId = patch.clinicianId;
  if (patch.institutionId !== undefined) set.institutionId = patch.institutionId;
  if (patch.location !== undefined) set.location = patch.location;
  if (patch.prepNotes !== undefined) set.prepNotes = patch.prepNotes;
  if (patch.questions !== undefined) set.questionsJson = JSON.stringify(patch.questions);
  if (patch.outcomes !== undefined) set.outcomes = patch.outcomes;
  if (documentIdsJson !== undefined) set.documentIdsJson = documentIdsJson;
  db().update(schema.encounters).set(set).where(eq(schema.encounters.id, id)).run();
  const saved = getRow(id);
  indexEncounter(saved);
  return getEncounter(id);
}

export function deleteEncounter(id: string): void {
  const r = db()
    .update(schema.encounters)
    .set({ deletedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(schema.encounters.id, id), isNull(schema.encounters.deletedAt)))
    .run();
  if (r.changes === 0) throw notFound('encounter not found');
  removeEntityIndex('encounter', id);
}

/** Mark completed and record what came of it. Outcomes are kept when the body omits them. */
export function completeEncounter(id: string, raw: unknown = {}): EncounterDetail {
  getRow(id);
  const input = parseInput(completeInput, raw ?? {});
  const set: Partial<EncounterInsert> = { status: 'completed', updatedAt: nowIso() };
  if (input.outcomes !== undefined) set.outcomes = input.outcomes;
  db().update(schema.encounters).set(set).where(eq(schema.encounters.id, id)).run();
  const saved = getRow(id);
  indexEncounter(saved);
  return getEncounter(id);
}

// ---------------------------------------------------------------------------
// Prep
// ---------------------------------------------------------------------------

function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The day the "recent" window starts: the last completed encounter with this clinician before this one, else 90 days back. */
function recentSince(enc: EncounterListItem): string {
  const anchor = enc.occurredAt && enc.occurredAt.length === 10 ? enc.occurredAt : todayIso();
  if (enc.clinicianId) {
    const prev = db().get<{ d: string }>(sql`
      select occurred_at as d from encounters
      where deleted_at is null and status = 'completed' and clinician_id = ${enc.clinicianId} and id != ${enc.id}
        and occurred_at is not null and occurred_at < ${anchor}
      order by occurred_at desc limit 1`);
    if (prev?.d) return prev.d.slice(0, 10);
  }
  return plusDays(anchor, -90);
}

function recentFacts(since: string, limit = 40): PrepFact[] {
  return db().all<PrepFact>(sql`
    select f.id, f.type, f.statement, f.date, f.date_precision as datePrecision, f.status, f.source_document_id as sourceDocumentId, d.title as documentTitle
    from facts f left join documents d on d.id = f.source_document_id
    where f.deleted_at is null and f.status not in ('superseded', 'disputed')
      and (f.source_document_id is null or (d.id is not null and d.deleted_at is null))
      and f.date is not null and f.date >= ${since}
    order by f.date desc, f.created_at desc limit ${limit}`);
}

function clinicianRow(id: string | null): EncounterPrep['clinician'] {
  if (!id) return null;
  const p = db().select().from(schema.people).where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt))).get();
  if (!p) return null;
  const inst = p.institutionId ? db().select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, p.institutionId)).get() : null;
  return { ...p, institutionName: inst?.name ?? null };
}

function gapsFor(enc: EncounterListItem, clinicianInstitutionId: string | null): Gap[] {
  const all = inferGaps();
  const instId = enc.institutionId ?? clinicianInstitutionId;
  const instName = (enc.institutionName ?? '').trim().toLowerCase();
  if (!instId && !instName) return all.slice(0, 25);
  const mine = all.filter((g) => (instId && g.institutionId === instId) || (instName && (g.institution ?? '').trim().toLowerCase() === instName));
  return (mine.length ? mine : all).slice(0, 25);
}

function dateLine(enc: EncounterListItem): string {
  const d = enc.occurredAt ? formatPartialDate(enc.occurredAt, enc.occurredAtPrecision as DatePrecision) : 'a date not yet set';
  return enc.timeText ? `${d} at ${enc.timeText}` : d;
}

/** The text pasted into the consult composer. Deterministic; the consult reads the case itself. */
export function briefingPrompt(p: Omit<EncounterPrep, 'briefingPrompt'>): string {
  const e = p.encounter;
  const who = e.clinicianName ? `${e.clinicianName}${e.clinicianSpecialty ? ` (${e.clinicianSpecialty})` : ''}` : 'the clinician';
  const where = e.institutionName ? ` at ${e.institutionName}` : '';
  const lines: string[] = [
    `Prepare a pre-visit briefing for my ${e.kind.replace(/_/g, ' ')} with ${who}${where} on ${dateLine(e)}: "${e.title}".`,
    'Cover: the purpose of the visit; what has changed since my last contact with this clinician; open questions to raise; current medications and hard stops; records to bring or request.',
  ];
  if (e.prepNotes) lines.push(`My prep notes: ${e.prepNotes}`);
  const open = e.questions.filter((q) => !q.asked);
  if (open.length) lines.push(`Questions I already plan to ask: ${open.map((q, i) => `${i + 1}. ${q.text}`).join(' ')}`);
  // With no clinician the contacts and follow-ups come from the institution, so name it rather than "this clinician".
  const institutionOnly = !e.clinicianId && e.institutionName ? e.institutionName : null;
  if (p.lastContacts.length) {
    const c = p.lastContacts[0];
    lines.push(`Last contact with ${institutionOnly ?? 'this clinician'}: ${c.occurredAt ?? 'undated'} (${c.channel}, "${c.subject}").`);
  }
  if (p.openFollowUps.length) lines.push(`Open follow-ups ${institutionOnly ?? 'they'} promised: ${p.openFollowUps.map((f) => `${f.followUpPromised ?? f.subject}${f.followUpDue ? ` (due ${f.followUpDue})` : ''}`).join('; ')}.`);
  if (p.openTasksForOwner.length) lines.push(`Tasks they owe me: ${p.openTasksForOwner.map((t) => t.title).join('; ')}.`);
  if (p.gaps.length) lines.push(`Records I am missing that may concern them: ${p.gaps.slice(0, 8).map((g) => g.title).join('; ')}.`);
  if (p.hardStops.length) lines.push(`Hard stops to state: ${p.hardStops.map((h) => h.substance).join(', ')}.`);
  lines.push(`Changes since ${p.recentSince}: ${p.recentFacts.length} dated facts in the ledger; please read them and cite each one you use.`);
  return lines.join('\n');
}

export function encounterPrep(id: string): EncounterPrep {
  const encounter = getEncounter(id);
  const clinician = clinicianRow(encounter.clinicianId);
  const contactPerson = encounter.clinicianId ?? encounter.institutionId ?? null;
  const lastContacts = contactPerson ? listCommunications({ personId: contactPerson, limit: 10 }) : [];
  // listFollowUps without a person returns every open promise in the case; with no contact there is nobody to attribute them to.
  const openFollowUps = contactPerson ? listFollowUps({ personId: contactPerson }) : [];
  const since = recentSince(encounter);
  const d = db();
  const activeMedications = d.all<PlanMedication>(sql`
    select m.id, m.name, m.dose, m.unit, m.route, m.frequency, m.status, m.indication, p.name as prescriberName
    from medications m left join people p on p.id = m.prescriber_id
    where m.deleted_at is null and m.status in ('active', 'prn') order by m.status asc, m.name collate nocase`);
  const hardStops = d.all<PlanHardStop>(sql`
    select id, substance, kind, reaction, severity from intolerances
    where deleted_at is null and active = 1 and (hard_stop = 1 or kind = 'hard_stop') order by substance collate nocase`);
  const openTasksForOwner = encounter.clinicianId ? listTasks({ status: 'active', ownerPersonId: encounter.clinicianId }) : [];
  const encounterTasks = encounter.tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const base = {
    encounter,
    clinician,
    lastContacts,
    openFollowUps,
    recentFacts: recentFacts(since),
    recentSince: since,
    activeMedications,
    hardStops,
    openTasksForOwner,
    encounterTasks,
    gaps: gapsFor(encounter, clinician?.institutionId ?? null),
  };
  return { ...base, briefingPrompt: briefingPrompt(base) };
}

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

export function encounterToEvent(e: EncounterListItem): IcsEvent | null {
  // Only a day-precision date is honest enough for a calendar.
  if (!e.occurredAt || e.occurredAt.length < 10 || e.occurredAtPrecision !== 'day') return null;
  const who = [e.clinicianName, e.institutionName].filter(Boolean).join(', ');
  const description = [
    `${e.kind.replace(/_/g, ' ')}${who ? ` with ${who}` : ''}`,
    e.prepNotes ? `Prep: ${e.prepNotes}` : null,
    e.questions.length ? `Questions: ${e.questions.map((q, i) => `${i + 1}. ${q.text}`).join(' ')}` : null,
    e.outcomes ? `Outcome: ${e.outcomes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    uid: `casefile-encounter-${e.id}@casefile.local`,
    date: e.occurredAt.slice(0, 10),
    time: parseTimeText(e.timeText) ? e.timeText : null,
    durationMinutes: 60,
    summary: who ? `${e.title} — ${who}` : e.title,
    description,
    location: e.location ?? e.institutionName ?? null,
    status: e.status === 'cancelled' ? 'CANCELLED' : e.status === 'upcoming' ? 'CONFIRMED' : 'CONFIRMED',
    categories: ['Casefile', 'Encounter', e.kind],
  };
}

/**
 * Default: upcoming encounters. `status=all` exports every non-cancelled one;
 * a comma list of statuses is honoured. An unknown status is a 400, never
 * "no filter" (which would export cancelled and completed visits too).
 */
export function encountersCalendar(statusRaw?: string | null, now?: Date): string {
  const parts = (statusRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = parts.filter((s) => s !== 'all' && !(ENCOUNTER_STATUSES as readonly string[]).includes(s));
  if (unknown.length) throw badRequest(`status must be upcoming, completed, cancelled or all (got ${unknown.join(', ')})`);
  const statuses = new Set(parts.length ? parts.flatMap((s) => (s === 'all' ? ['upcoming', 'completed'] : [s])) : ['upcoming']);
  const items = listEncounters({ status: [...statuses].join(',') });
  const events = items.map(encounterToEvent).filter((e): e is IcsEvent => Boolean(e));
  return buildCalendar(events, { name: 'Casefile encounters', now });
}

export function encounterCalendar(id: string, now?: Date): string {
  const e = encounterToEvent(getRow(id));
  if (!e) throw badRequest('this encounter has no full date to put on a calendar');
  return buildCalendar([e], { name: 'Casefile encounter', now });
}
