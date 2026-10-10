/**
 * People: clinicians, clinics, institutions, advocates, family. Observed
 * response latency is computed from communications, never stored. Every
 * write keeps `entities_fts` in sync so the palette finds people by name,
 * role, specialty, institution, notes, or alias.
 */
import { and, eq, inArray, isNull, or, sql, getTableColumns, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { db, schema } from '../db';
import { indexEntity, removeEntityIndex } from './search';
import { optEnum, optText, parseInput, reindexCommunication, visibleWithRecordSql } from './communications';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { daysBetween } from '../../shared/dates';
import { COMM_CHANNELS, PERSON_KINDS } from '../../shared/enums';
import { personNameKey } from '../../shared/schemas/segments';

/** Communications of a deleted record (read out of it) do not count for a person. */
const VISIBLE_C = sql.raw(visibleWithRecordSql('c'));

// ---------------------------------------------------------------------------
// Input schemas (parseInput / optText / optEnum live in ./communications so
// the import graph stays one-directional: people -> communications)
// ---------------------------------------------------------------------------

/** Field schemas without defaults; the create schema adds them, the patch schema must not. */
const personFields = {
  name: z.string().trim().min(1, 'name is required').max(300),
  kind: z.enum(PERSON_KINDS),
  role: optText(300),
  specialty: optText(300),
  institutionId: optText(64),
  phone: optText(100),
  fax: optText(100),
  email: optText(300),
  portal: optText(300),
  address: optText(1000),
  preferredChannel: optEnum(COMM_CHANNELS),
  notes: optText(20000),
  aliases: z
    .array(z.string().max(300))
    .max(50)
    .optional()
    .transform((a) => (a === undefined ? undefined : normaliseAliases(a))),
};

export const personInput = z.object({ ...personFields, kind: personFields.kind.default('clinician') });
/**
 * Built from the undefaulted fields: zod 4 keeps a `.default()` under
 * `.partial()`, which would turn PATCH { notes } on an institution into a clinician.
 */
export const personPatch = z.object(personFields).partial();
/** What callers pass in (raw, before transforms). The services parse it themselves. */
export type PersonInput = z.input<typeof personInput>;
export type PersonPatch = z.input<typeof personPatch>;

export function normaliseAliases(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const s = raw.trim();
    if (!s) continue;
    const k = nameKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Case-insensitive, whitespace-collapsed key for matching names and aliases. */
export function nameKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PersonRow = typeof schema.people.$inferSelect;

export interface PersonListRow extends PersonRow {
  aliases: string[];
  institutionName: string | null;
  communicationCount: number;
  lastContactAt: string | null;
  /** Median whole days from an outbound communication to the next inbound one; null with fewer than 2 pairs. */
  medianResponseDays: number | null;
}

export interface PersonFilters {
  q?: string | null;
  kind?: string | null;
  institutionId?: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const inst = alias(schema.people, 'inst');

function baseSelect(d = db()) {
  const p = schema.people;
  return d
    .select({
      ...getTableColumns(p),
      institutionName: inst.name,
      communicationCount: sql<number>`(select count(*) from communication_participants cp join communications c on c.id = cp.communication_id and c.deleted_at is null and ${VISIBLE_C} where cp.person_id = ${p.id})`,
      lastContactAt: sql<string | null>`(select max(c.occurred_at) from communication_participants cp join communications c on c.id = cp.communication_id and c.deleted_at is null and ${VISIBLE_C} where cp.person_id = ${p.id})`,
    })
    .from(p)
    .leftJoin(inst, and(eq(inst.id, p.institutionId), isNull(inst.deletedAt)));
}

function decorate(row: Omit<PersonListRow, 'aliases' | 'medianResponseDays'>, medians: Map<string, number | null>): PersonListRow {
  return {
    ...row,
    communicationCount: Number(row.communicationCount ?? 0),
    aliases: parseJson<string[]>(row.aliasesJson, []),
    medianResponseDays: medians.get(row.id) ?? null,
  };
}

export function listPeople(filters: PersonFilters = {}): PersonListRow[] {
  const p = schema.people;
  const conds: SQL[] = [isNull(p.deletedAt)];
  if (filters.kind && (PERSON_KINDS as readonly string[]).includes(filters.kind)) conds.push(eq(p.kind, filters.kind));
  if (filters.institutionId) conds.push(eq(p.institutionId, filters.institutionId));
  const q = filters.q?.trim();
  if (q) {
    const pat = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conds.push(
      or(
        sql`${p.name} like ${pat} escape '\\'`,
        sql`${p.role} like ${pat} escape '\\'`,
        sql`${p.specialty} like ${pat} escape '\\'`,
        sql`${inst.name} like ${pat} escape '\\'`,
        sql`${p.aliasesJson} like ${pat} escape '\\'`,
        sql`${p.notes} like ${pat} escape '\\'`,
      )!,
    );
  }
  const rows = baseSelect()
    .where(and(...conds))
    .orderBy(sql`${p.name} collate nocase`)
    .all();
  const medians = responseMedians();
  return rows.map((r) => decorate(r, medians));
}

export function getPerson(id: string): PersonListRow {
  const row = baseSelect()
    .where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt)))
    .get();
  if (!row) throw notFound('person not found');
  return decorate(row, responseMedians(id));
}

function personExists(id: string): boolean {
  return Boolean(
    db()
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt)))
      .get(),
  );
}

/**
 * Median response days per person. For every outbound communication the
 * person took part in, the next inbound one with the same person (by date)
 * forms a pair; the median of the whole-day gaps is the latency. Only
 * day-precision dates take part; fewer than two pairs yields null.
 */
export function responseMedians(onlyPersonId?: string): Map<string, number | null> {
  const d = db();
  const rows = d.all<{ personId: string; occurredAt: string; direction: string }>(sql`
    select cp.person_id as personId, c.occurred_at as occurredAt, c.direction as direction
    from communication_participants cp
    join communications c on c.id = cp.communication_id
    where c.deleted_at is null and ${VISIBLE_C} and c.occurred_at is not null and length(c.occurred_at) >= 10
      and c.occurred_at_precision = 'day'
      ${onlyPersonId ? sql`and cp.person_id = ${onlyPersonId}` : sql``}
    order by cp.person_id, c.occurred_at, c.created_at
  `);
  const byPerson = new Map<string, Array<{ at: string; dir: string }>>();
  for (const r of rows) {
    if (!byPerson.has(r.personId)) byPerson.set(r.personId, []);
    byPerson.get(r.personId)!.push({ at: r.occurredAt.slice(0, 10), dir: r.direction });
  }
  const out = new Map<string, number | null>();
  for (const [pid, list] of byPerson) {
    out.set(pid, medianResponse(list));
  }
  return out;
}

export function medianResponse(list: Array<{ at: string; dir: string }>): number | null {
  const gaps: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].dir !== 'outbound') continue;
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].dir === 'inbound') {
        const gap = daysBetween(list[i].at, list[j].at);
        if (gap >= 0) gaps.push(gap);
        break;
      }
    }
  }
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function institutionNameOf(id: string | null): string | null {
  if (!id) return null;
  return (
    db()
      .select({ name: schema.people.name })
      .from(schema.people)
      .where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt)))
      .get()?.name ?? null
  );
}

export function indexPerson(row: PersonRow): void {
  const aliases = parseJson<string[]>(row.aliasesJson, []);
  const body = [row.role, row.specialty, institutionNameOf(row.institutionId), row.notes, ...aliases].filter(Boolean).join(' · ');
  indexEntity('person', row.id, row.name, body);
}

function assertInstitution(id: string | null | undefined, selfId?: string): void {
  if (!id) return;
  if (selfId && id === selfId) throw badRequest('a person cannot be their own institution');
  if (!personExists(id)) throw badRequest('institutionId does not refer to an existing person');
}

export function createPerson(raw: PersonInput): PersonListRow {
  const input = parseInput(personInput, raw);
  assertInstitution(input.institutionId);
  const d = db();
  const id = newId();
  const now = nowIso();
  d.insert(schema.people)
    .values({
      id,
      name: input.name,
      kind: input.kind,
      role: input.role ?? null,
      specialty: input.specialty ?? null,
      institutionId: input.institutionId ?? null,
      phone: input.phone ?? null,
      fax: input.fax ?? null,
      email: input.email ?? null,
      portal: input.portal ?? null,
      address: input.address ?? null,
      preferredChannel: input.preferredChannel ?? null,
      notes: input.notes ?? null,
      aliasesJson: JSON.stringify(input.aliases ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const row = d.select().from(schema.people).where(eq(schema.people.id, id)).get()!;
  indexPerson(row);
  return getPerson(id);
}

export function updatePerson(id: string, raw: PersonPatch): PersonListRow {
  const patch = parseInput(personPatch, raw);
  const d = db();
  const existing = d
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt)))
    .get();
  if (!existing) throw notFound('person not found');
  if (patch.institutionId !== undefined) assertInstitution(patch.institutionId, id);
  const set: Partial<typeof schema.people.$inferInsert> = { updatedAt: nowIso() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  for (const k of ['role', 'specialty', 'institutionId', 'phone', 'fax', 'email', 'portal', 'address', 'preferredChannel', 'notes'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  if (patch.aliases !== undefined) set.aliasesJson = JSON.stringify(patch.aliases);
  d.update(schema.people).set(set).where(eq(schema.people.id, id)).run();
  const row = d.select().from(schema.people).where(eq(schema.people.id, id)).get()!;
  indexPerson(row);
  if (patch.name !== undefined && patch.name !== existing.name) reindexDependents(id);
  return getPerson(id);
}

/** A rename changes the index body of people in this institution and of communications with this person. */
function reindexDependents(personId: string): void {
  const d = db();
  const members = d
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.institutionId, personId), isNull(schema.people.deletedAt)))
    .all();
  for (const m of members) indexPerson(m);
  const commIds = d.all<{ id: string }>(sql`
    select distinct c.id from communications c join communication_participants cp on cp.communication_id = c.id
    where cp.person_id = ${personId} and c.deleted_at is null
  `);
  for (const { id } of commIds) reindexCommunication(id);
}

export function deletePerson(id: string): void {
  const d = db();
  const r = d
    .update(schema.people)
    .set({ deletedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(schema.people.id, id), isNull(schema.people.deletedAt)))
    .run();
  if (r.changes === 0) throw notFound('person not found');
  removeEntityIndex('person', id);
}

// ---------------------------------------------------------------------------
// Activity: everything touching one person
// ---------------------------------------------------------------------------

export interface TopicLedgerRow {
  topic: string;
  count: number;
  last: string | null;
  openFollowUps: number;
}

export function personTopics(personId: string): TopicLedgerRow[] {
  return db().all<TopicLedgerRow>(sql`
    select t.topic as topic, count(distinct c.id) as count, max(c.occurred_at) as last,
      count(distinct case when c.follow_up_promised is not null and c.follow_up_done_at is null then c.id end) as openFollowUps
    from communication_topics t
    join communications c on c.id = t.communication_id and c.deleted_at is null and ${VISIBLE_C}
    join communication_participants cp on cp.communication_id = c.id and cp.person_id = ${personId}
    group by t.topic
    order by count desc, last desc, t.topic
  `);
}

export function personDocuments(personId: string): Array<typeof schema.documents.$inferSelect> {
  const doc = schema.documents;
  return db()
    .select()
    .from(doc)
    .where(and(isNull(doc.deletedAt), or(eq(doc.authorPersonId, personId), eq(doc.institutionId, personId))))
    .orderBy(sql`(${doc.documentDate} is null) asc, ${doc.documentDate} desc, ${doc.createdAt} desc`)
    .all();
}

export function personFacts(personId: string): Array<typeof schema.facts.$inferSelect & { documentTitle: string | null }> {
  const f = schema.facts;
  const doc = schema.documents;
  return db()
    .select({ ...getTableColumns(f), documentTitle: doc.title })
    .from(f)
    .leftJoin(doc, eq(doc.id, f.sourceDocumentId))
    .where(and(isNull(f.deletedAt), eq(f.personId, personId), or(isNull(f.sourceDocumentId), isNull(doc.deletedAt))))
    .orderBy(sql`(${f.date} is null) asc, ${f.date} desc, ${f.createdAt} desc`)
    .all();
}

// ---------------------------------------------------------------------------
// Suggestions: names the extractor mentioned that are not people yet
// ---------------------------------------------------------------------------

/** Where a suggested name was seen: the extracted fact and its document. */
export interface SuggestionSource {
  factId: string;
  type: string;
  statement: string;
  documentId: string | null;
  documentTitle: string | null;
}

export interface PersonSuggestion {
  name: string;
  count: number;
  factIds: string[];
  factTypes: string[];
  /** The facts behind `factIds`, so the user can see what named this person before adding them. */
  sources: SuggestionSource[];
}

/** Every name/alias of every live person, as match keys. */
export function knownNameKeys(): Set<string> {
  const keys = new Set<string>();
  const rows = db()
    .select({ name: schema.people.name, aliasesJson: schema.people.aliasesJson })
    .from(schema.people)
    .where(isNull(schema.people.deletedAt))
    .all();
  for (const r of rows) {
    keys.add(nameKey(r.name));
    for (const a of parseJson<string[]>(r.aliasesJson, [])) keys.add(nameKey(a));
  }
  return keys;
}

export function personSuggestions(): PersonSuggestion[] {
  const known = knownNameKeys();
  // Also known: every name and alias by its person key ("Example, Pat" and "Pat Example" are one name).
  const knownPerson = new Set(peopleByNameKey().byKey.keys());
  const rows = db().all<{ id: string; type: string; name: string; statement: string; documentId: string | null; documentTitle: string | null }>(sql`
    select f.id as id, f.type as type, j.value as name, f.statement as statement,
      f.source_document_id as documentId, d.title as documentTitle
    from facts f, json_each(f.attributes_json, '$._people') j
    left join documents d on d.id = f.source_document_id and d.deleted_at is null
    where f.deleted_at is null and json_valid(f.attributes_json)
      and json_type(f.attributes_json, '$._people') = 'array'
      and j.type = 'text'
  `);
  const sourceOf = new Map<string, SuggestionSource>();
  const agg = new Map<string, { names: Map<string, number>; count: number; factIds: Set<string>; types: Set<string> }>();
  for (const r of rows) {
    const raw = String(r.name ?? '').trim();
    if (raw.length < 2 || isPlaceholderName(raw)) continue;
    const key = nameKey(raw);
    if (known.has(key) || knownPerson.has(personNameKey(raw))) continue;
    let a = agg.get(key);
    if (!a) {
      a = { names: new Map(), count: 0, factIds: new Set(), types: new Set() };
      agg.set(key, a);
    }
    a.count++;
    a.names.set(raw, (a.names.get(raw) ?? 0) + 1);
    a.factIds.add(r.id);
    a.types.add(r.type);
    if (!sourceOf.has(r.id)) sourceOf.set(r.id, { factId: r.id, type: r.type, statement: r.statement, documentId: r.documentTitle ? r.documentId : null, documentTitle: r.documentTitle });
  }
  const items: PersonSuggestion[] = [];
  for (const a of agg.values()) {
    const name = [...a.names.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    const factIds = [...a.factIds].slice(0, 8);
    items.push({ name, count: a.count, factIds, factTypes: [...a.types].sort(), sources: factIds.map((id) => sourceOf.get(id)!) });
  }
  // Names read out of records (messages, calls, letters) printed without a role: suggestions, never created.
  const seen = new Set(items.map((i) => personNameKey(i.name)));
  for (const s of recordNameSuggestions(knownPerson)) {
    const k = personNameKey(s.name);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(s);
  }
  items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return items;
}

// ---------------------------------------------------------------------------
// Names read out of records (2026-10-07, the people directory from messages)
// ---------------------------------------------------------------------------
//
// Epic prints people as "Last, First Middle" ("Example, Pat Quinn"), "First M. Last, CRED" ("A. Example, MD"),
// "Dr. Last", or a pool "P <pool name> (supporting <clinician>)". It also prints system users and placeholders
// ("Mychart, Generic", "Care, Preventive", "Historical Provider, MD") that are nobody. The rules:
// - a placeholder or system user never becomes a person and is never suggested;
// - a pool is a clinic (kind `clinic`), named as printed without the leading "P ";
// - a name printed with a credential ("RN", "MD") is a member of the care team: matched to an existing person (by
//   personNameKey over names and aliases) or created, with the credential as its role when the role is empty;
// - any other new name is only a suggestion (People page), never created and never merged automatically.

const CREDENTIALS = ['MD', 'M.D.', 'DO', 'RN', 'BSN', 'MSN', 'LPN', 'MA', 'CMA', 'RMA', 'PA-C', 'PA', 'NP', 'FNP', 'APRN', 'DNP', 'PharmD', 'RPh', 'LMSW', 'LCSW', 'PT', 'DPT', 'OT', 'OTR/L', 'CNA', 'CRNA', 'PhD'];
const CREDENTIAL_RE = new RegExp(`,\\s*(${CREDENTIALS.map((c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})\\.?\\s*$`, 'i');

/** Names Epic prints for system users and placeholders: never a person (findings: ing_pdf 7.11). */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bbackground\b/i,
  /\bgeneric\b/i,
  /^\s*mychart\b/i,
  /\bmychart administrators?\b/i,
  /\bunassigned\b/i,
  /\bhistorical provider\b/i,
  /\bdefault\b/i,
  /\bdeclined\b/i,
  /^\s*care,\s*preventive\b/i,
  /^\s*cadence,\s*user\b/i,
  /^\s*lab,\s*background\b/i,
  /\binterface\b/i,
  /\bresolve at\b/i,
  /^\s*(?:user|system|auto|automatic|unknown|none|n\/a)\s*$/i,
  /^\s*example,\s*user\s*$/i,
];

/** True for a system user or placeholder name ("Mychart, Generic", "Historical Provider, MD"): never a person. */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const s = (name ?? '').trim();
  if (s.length < 2) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(s));
}

/** A recipient pool as printed: "P Example Nurses (supporting A. Example, MD)" -> { pool: "Example Nurses", supporting: "A. Example, MD" }. */
export function parsePool(text: string | null | undefined): { pool: string; supporting: string | null } | null {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^P\s+(.+?)(?:\s*\(supporting\s+(.+?)\)?)?$/);
  if (!m || !m[1]) return null;
  const pool = m[1].replace(/\s*\($/, '').trim();
  return pool ? { pool, supporting: m[2] ? m[2].replace(/\)\s*$/, '').trim() || null : null } : null;
}

/** The credential printed after a name ("RN" of "Robin Example, RN"), or null. */
export function credentialOf(name: string | null | undefined): string | null {
  const m = (name ?? '').trim().match(CREDENTIAL_RE);
  if (!m) return null;
  const hit = CREDENTIALS.find((c) => c.toLowerCase() === m[1].toLowerCase());
  return hit ?? m[1];
}

/**
 * A name as the directory shows it: credential and "Dr." dropped, "Last, First Middle" turned into "First Middle
 * Last", letters as printed except an ALL-CAPS name, which is put in title case. "Example, Pat Quinn" -> "Pat Quinn
 * Example"; "A. Example, MD" -> "A. Example".
 */
export function displayNameOf(name: string | null | undefined): string {
  let s = (name ?? '').replace(/\s+/g, ' ').trim().replace(/^dr\.?\s+/i, '');
  for (let i = 0; i < 3 && CREDENTIAL_RE.test(s); i++) s = s.replace(CREDENTIAL_RE, '').trim();
  const comma = s.indexOf(',');
  if (comma > 0) s = `${s.slice(comma + 1).trim()} ${s.slice(0, comma).trim()}`.trim();
  if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) s = s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return s;
}

/** Every live person keyed by personNameKey of its name and of each alias (the first person wins a shared key). */
export interface PeopleByKey {
  byKey: Map<string, { id: string; name: string; kind: string; role: string | null }>;
  /** Name keys of people the user deleted (and no live person has): an import never makes them again. */
  deletedKeys?: Set<string>;
}

export function peopleByNameKey(): PeopleByKey {
  const byKey = new Map<string, { id: string; name: string; kind: string; role: string | null }>();
  const rows = db()
    .select({ id: schema.people.id, name: schema.people.name, kind: schema.people.kind, role: schema.people.role, aliasesJson: schema.people.aliasesJson, deletedAt: schema.people.deletedAt })
    .from(schema.people)
    .orderBy(schema.people.createdAt)
    .all();
  const deletedKeys = new Set<string>();
  for (const r of rows) {
    for (const n of [r.name, ...parseJson<string[]>(r.aliasesJson, [])]) {
      const k = personNameKey(n);
      if (!k) continue;
      if (r.deletedAt) deletedKeys.add(k);
      else if (!byKey.has(k)) byKey.set(k, { id: r.id, name: r.name, kind: r.kind, role: r.role });
    }
  }
  for (const k of byKey.keys()) deletedKeys.delete(k);
  return { byKey, deletedKeys };
}

/** What resolving a printed name did. */
export interface ResolvedName {
  personId: string | null;
  /** A person was created for it now. */
  created: { personId: string; name: string; kind: string } | null;
  /** Not created: offered as a suggestion (a new name without a credential). */
  suggested: { name: string; kind: string; reason: string; matchPersonId: string | null; matchName: string | null } | null;
  /** A placeholder or system user: nobody. */
  placeholder: boolean;
}

/**
 * Finds (or, for a credentialed name or a pool, creates) the person a printed name stands for. `origin` is a short
 * plain note kept on a created person ("Read from Example chart print p.4."). Never merges: a name close to an existing
 * person (same surname) is created or suggested beside it, and the People page offers the merge.
 */
export function resolvePrintedName(text: string | null | undefined, opts: { idx?: PeopleByKey; kind?: 'clinician' | 'clinic'; origin?: string | null; create?: boolean } = {}): ResolvedName {
  const out: ResolvedName = { personId: null, created: null, suggested: null, placeholder: false };
  const raw = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || isPlaceholderName(raw)) {
    out.placeholder = Boolean(raw);
    return out;
  }
  const idx = opts.idx ?? peopleByNameKey();
  const kind = opts.kind ?? 'clinician';
  const display = kind === 'clinic' ? raw : displayNameOf(raw);
  if (!display || isPlaceholderName(display)) {
    out.placeholder = true;
    return out;
  }
  const key = personNameKey(kind === 'clinic' ? display : raw);
  const hit = idx.byKey.get(key);
  if (hit) {
    out.personId = hit.id;
    const cred = kind === 'clinician' ? credentialOf(raw) : null;
    if (cred && !hit.role) {
      db().update(schema.people).set({ role: cred, updatedAt: nowIso() }).where(and(eq(schema.people.id, hit.id), isNull(schema.people.role))).run();
      hit.role = cred;
      const row = db().select().from(schema.people).where(eq(schema.people.id, hit.id)).get();
      if (row) indexPerson(row);
    }
    return out;
  }
  // A person the user deleted (a pool or a clinician an import made, say) is not made again by a later import, nor
  // offered again as a suggestion (2026-10-07 review, rev-engine F5).
  if (idx.deletedKeys?.has(key) || (display !== raw && idx.deletedKeys?.has(personNameKey(display)))) return out;
  const credential = kind === 'clinician' ? credentialOf(raw) : null;
  if (opts.create !== false && (kind === 'clinic' || credential)) {
    const p = createPerson({
      name: display,
      kind,
      role: kind === 'clinic' ? 'Message pool' : credential,
      aliases: display !== raw ? [raw] : [],
      notes: opts.origin ? `Added from the records (read from a message or note, not checked). ${opts.origin}`.slice(0, 2000) : 'Added from the records (read from a message or note, not checked).',
    });
    idx.byKey.set(key, { id: p.id, name: p.name, kind: p.kind, role: p.role });
    if (display !== raw) idx.byKey.set(personNameKey(display), { id: p.id, name: p.name, kind: p.kind, role: p.role });
    out.personId = p.id;
    out.created = { personId: p.id, name: p.name, kind: p.kind };
    return out;
  }
  // A new name without a credential: a suggestion only. Point at a person with the same surname when there is one.
  const surname = key.split(' ').pop() ?? '';
  let match: { id: string; name: string } | null = null;
  if (surname.length >= 3) {
    for (const [k, p] of idx.byKey) {
      if (k.split(' ').pop() === surname && p.kind === 'clinician') {
        match = { id: p.id, name: p.name };
        break;
      }
    }
  }
  out.suggested = { name: display, kind: 'clinician', reason: match ? 'A new name in the records with the same surname as someone in People.' : 'A new name in the records, printed without a role.', matchPersonId: match?.id ?? null, matchName: match?.name ?? null };
  return out;
}

/**
 * New names in communications read out of records (their author, or the clinician a pool supports) that match no
 * person: offered as suggestions with no facts behind them (the message is the source). Placeholders never.
 */
function recordNameSuggestions(knownPerson: Set<string>): PersonSuggestion[] {
  const rows = db().all<{ authorText: string | null; intendedFor: string | null; voice: string | null }>(sql`
    select json_extract(details_json, '$.authorText') as authorText, json_extract(details_json, '$.intendedFor') as intendedFor,
      json_extract(details_json, '$.voice') as voice
    from communications
    where deleted_at is null and json_valid(details_json) and json_extract(details_json, '$.origin') = 'extracted'`);
  const agg = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    for (const n of [r.voice === 'patient' ? null : r.authorText, r.intendedFor]) {
      const raw = (n ?? '').trim();
      if (!raw || isPlaceholderName(raw) || parsePool(raw)) continue;
      const k = personNameKey(raw);
      if (!k || knownPerson.has(k)) continue;
      const a = agg.get(k) ?? { name: displayNameOf(raw), count: 0 };
      a.count++;
      agg.set(k, a);
    }
  }
  return [...agg.values()].map((a) => ({ name: a.name, count: a.count, factIds: [], factTypes: [], sources: [] }));
}

export const suggestionAccept = z.object({
  name: z.string().trim().min(1).max(300),
  kind: z.enum(PERSON_KINDS).default('clinician'),
  role: optText(300),
  specialty: optText(300),
  /** The extracted facts that named this person (from the suggestion), recorded as the row's origin. */
  factIds: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
});

/**
 * Origin note for a person created from extracted mentions: which facts (and
 * documents) named them. Only live facts are cited. Facts are not linked to
 * the person (facts.person_id is left alone), so no verdict is touched.
 */
function suggestionOriginNote(factIds: string[] | undefined): string | null {
  const ids = [...new Set(factIds ?? [])];
  if (!ids.length) return null;
  const rows = db()
    .select({ id: schema.facts.id, documentTitle: schema.documents.title })
    .from(schema.facts)
    .leftJoin(schema.documents, and(eq(schema.documents.id, schema.facts.sourceDocumentId), isNull(schema.documents.deletedAt)))
    .where(and(inArray(schema.facts.id, ids), isNull(schema.facts.deletedAt)))
    .all();
  if (!rows.length) return null;
  const live = ids.filter((id) => rows.some((r) => r.id === id));
  const titles = [...new Set(rows.map((r) => r.documentTitle).filter((t): t is string => Boolean(t)))];
  return `Added from names the extractor found (unverified). Facts: ${live.join(', ')}${titles.length ? `. Documents: ${titles.join('; ')}` : ''}.`;
}

export function acceptSuggestion(raw: z.input<typeof suggestionAccept>): PersonListRow {
  const input = parseInput(suggestionAccept, raw);
  if (knownNameKeys().has(nameKey(input.name))) throw conflict('a person with this name or alias already exists');
  return createPerson({ name: input.name, kind: input.kind, role: input.role, specialty: input.specialty, notes: suggestionOriginNote(input.factIds) });
}
