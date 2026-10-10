/**
 * Facts: the atomic, cited statements the ledger is made of. This service
 * owns reads, manual creation, edits, verdicts, supersession, soft delete,
 * merge decisions, and the citation insert used by both manual facts and the
 * extraction pipeline. The user's verdict outranks the model: nothing here
 * changes `status`, `verdictNote`, `verdictBasis`, or edited fields of a
 * confirmed/disputed fact except an explicit user action. `verdictBasis`
 * (original | summary) is written by setVerdict alone and is null whenever
 * the status is not confirmed.
 *
 * A change to a measurement (lab, imaging, vital, procedure) that decides what
 * the clinical record says re-runs the clinical-record pass afterwards
 * (services/reconcile.ts), which only ever sets aside or restores secondhand
 * facts still pending; it never fails the change that started it. A verdict,
 * supersede or merge by hand on a fact the pass set aside takes its link back
 * (the fact is the user's from then on). Duplicate proposals that involve a
 * fact the pass set aside are hidden (not closed) while it is set aside.
 *
 * The full-text entry of a fact is its statement with the user's note on it,
 * so a note is found by search; it is rewritten whenever either changes.
 */
import { and, asc, desc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { enqueueJob } from '../jobs/queue';
import { indexFact, removeFactIndex, ftsQuery } from './search';
import { createRecord, resolveInstitutionId } from './records';
import { closePendingMergesFor, dedupKey, proposeMergesFor, subjectKey, type MergeCandidateFact } from './dedup';
import { isReconciledType, isSecondhandInReconcile, passSetAsideIds, passSetAsideSql, reconciledIdsWithTrust, reconciledPairSql, reconcileQuietly, RECONCILED_TYPES, takeBackClinicalLink, trustFor, trustForRows } from './reconcile';
import { isVerifiedMatch, locateCitation, storedMatchKind } from '../ai/citations';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { parsePartialDate } from '../../shared/dates';
import { defaultObjectivity, effectiveObjectivity, validateAttributes } from '../../shared/schemas/facts';
import { ASSERTED_BY, OBJECTIVITIES, RECORD_TYPES, type FactStatus } from '../../shared/enums';
import type { TrustInfo } from '../../shared/reconcile';

export type FactRow = typeof schema.facts.$inferSelect;
export type CitationRow = typeof schema.citations.$inferSelect;
export type MergeRow = typeof schema.factMerges.$inferSelect;
export type ExtractionRunRow = typeof schema.extractionRuns.$inferSelect;

export type FactListItem = FactRow & { documentTitle: string | null; documentTier: string | null; citationCount: number; verifiedCitationCount: number; trust: TrustInfo };
export type FactWithDoc = FactRow & { documentTitle: string | null };
export type MergeWithFacts = MergeRow & { a: FactWithDoc; b: FactWithDoc };
export interface FactDetail extends FactRow {
  citations: CitationRow[];
  document: { id: string; title: string; sourceTier: string } | null;
  merges: MergeWithFacts[];
  supersededBy: FactRow | null;
  supersedes: FactRow[];
  run: Pick<ExtractionRunRow, 'id' | 'model' | 'deep' | 'startedAt' | 'finishedAt' | 'status' | 'schemaVersion'> | null;
  /** The patient statement that takes precedence over this one (consult layer), when set. */
  overriddenBy: FactWithDoc | null;
  /** Facts this (patient) statement takes precedence over. */
  overrides: FactWithDoc[];
  /** objective | subjective, after the per-type default is applied to rows stored as 'unknown'. */
  effectiveObjectivity: 'objective' | 'subjective';
  /** The automatic trust level (services/reconcile.ts). */
  trust: TrustInfo;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListFactsParams {
  type?: string;
  status?: string;
  documentId?: string;
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  origin?: string;
  /** patient | clinician | compiler | unknown */
  assertedBy?: string;
  /** objective | subjective (stored value; older rows stored as unknown match neither) */
  objectivity?: string;
  /** '1' = only facts a patient statement takes precedence over */
  overridden?: string;
  /** verified | accurate | unbacked | inaccurate | conflict | replaced (services/reconcile.ts) */
  trust?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

/** Facts whose source document still exists (manual facts have no document). */
function liveFactConditions(): SQL[] {
  return [isNull(schema.facts.deletedAt), or(isNull(schema.documents.id), isNull(schema.documents.deletedAt))!];
}

function orderFor(sort: string | undefined): SQL[] {
  const f = schema.facts;
  switch (sort) {
    case 'date':
      return [sql`(${f.date} is null) asc`, asc(f.date), asc(f.createdAt)];
    case 'created':
      return [asc(f.createdAt)];
    case '-created':
      return [desc(f.createdAt)];
    case 'confidence':
      return [asc(f.confidence)];
    case '-confidence':
      return [desc(f.confidence)];
    case 'type':
      return [asc(f.type), sql`(${f.date} is null) asc`, desc(f.date)];
    case '-date':
    default:
      return [sql`(${f.date} is null) asc`, desc(f.date), desc(f.createdAt)];
  }
}

export function listFacts(p: ListFactsParams): { items: FactListItem[]; total: number } {
  const d = db();
  const f = schema.facts;
  const conds: SQL[] = liveFactConditions();
  if (p.type) conds.push(eq(f.type, p.type));
  if (p.status) conds.push(eq(f.status, p.status));
  if (p.documentId) conds.push(eq(f.sourceDocumentId, p.documentId));
  if (p.origin) conds.push(eq(f.origin, p.origin));
  if (p.subject) conds.push(eq(f.subjectKey, p.subject));
  if (p.assertedBy) conds.push(eq(f.assertedBy, p.assertedBy));
  if (p.objectivity) conds.push(eq(f.objectivity, p.objectivity));
  if (p.overridden === '1' || p.overridden === 'true') {
    // Only records a live, undisputed patient statement takes precedence over.
    conds.push(sql`${f.overriddenByFactId} in (select o.id from facts o where o.deleted_at is null and o.status not in ('disputed','superseded'))`);
  }
  // Partial dates overlap a range at their own precision: "2024-03" is inside
  // from=2024-03-01, "2024" inside from=2024-06-01 and to=2024-03-31.
  if (p.from) conds.push(sql`${f.date} >= substr(${p.from}, 1, length(${f.date}))`);
  if (p.to) conds.push(sql`substr(${f.date}, 1, length(${p.to})) <= ${p.to}`);
  if (p.trust) conds.push(trustCondition(p.trust));
  if (p.q && p.q.trim()) {
    const q = p.q.trim();
    const match = ftsQuery(q);
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const likeCond = sql`${f.statement} like ${pattern} escape '\\'`;
    conds.push(match ? or(sql`${f.id} in (select fact_id from facts_fts where facts_fts match ${match})`, likeCond)! : likeCond);
  }
  const where = and(...conds);
  const limit = Math.max(1, Math.min(p.limit ?? 1000, 5000));
  const offset = Math.max(0, p.offset ?? 0);
  const items = d
    .select({
      ...getTableColumns(f),
      documentTitle: schema.documents.title,
      documentTier: schema.documents.sourceTier,
      citationCount: sql<number>`(select count(*) from citations c where c.fact_id = ${f.id})`.mapWith(Number),
      verifiedCitationCount: sql<number>`(select count(*) from citations c where c.fact_id = ${f.id} and c.verified = 1)`.mapWith(Number),
    })
    .from(f)
    .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
    .where(where)
    .orderBy(...orderFor(p.sort))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    d
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(f)
      .leftJoin(schema.documents, eq(schema.documents.id, f.sourceDocumentId))
      .where(where)
      .get()?.n ?? 0;
  const trust = trustForRows(items);
  return { items: items.map((x) => ({ ...x, trust: trust.get(x.id)! })), total };
}

/**
 * SQL for the facts list's trust filter. A reconciled detail (lab, scan, vital, procedure, event, of a live
 * document) takes its trust from the reconciliation (the ids are passed as one JSON array); any other detail's
 * trust follows from its status, the user's check and its document's tier (services/reconcile.ts plainTrust).
 */
function trustCondition(trust: string): SQL {
  const f = schema.facts;
  const types = sql.join(
    RECONCILED_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const reconciled = sql`(${f.type} in (${types}) and ${schema.documents.id} is not null)`;
  const ids = JSON.stringify(reconciledIdsWithTrust(trust));
  const tier = sql`coalesce(${schema.documents.sourceTier}, '')`;
  // "Not sure" outranks the tier (plainTrust): a clinical record's detail the user is not sure of is not verified
  // but not backed yet, as its tag says.
  const unsure = sql`(${f.status} = 'unverified' and coalesce(${f.verdictBasis}, '') = 'unsure')`;
  let plain: SQL;
  switch (trust) {
    case 'replaced':
      plain = sql`${f.status} = 'superseded'`;
      break;
    case 'inaccurate':
      plain = sql`${f.status} = 'disputed'`;
      break;
    case 'verified':
      plain = sql`${f.status} in ('unverified', 'confirmed') and ${tier} = 'primary' and not ${unsure}`;
      break;
    case 'accurate':
      plain = sql`${f.status} = 'confirmed' and ${tier} <> 'primary' and coalesce(${f.verdictBasis}, '') <> 'summary'`;
      break;
    case 'unbacked':
      plain = sql`(${unsure} or (${tier} <> 'primary' and ((${f.status} = 'confirmed' and ${f.verdictBasis} = 'summary') or ${f.status} = 'unverified')))`;
      break;
    default:
      plain = sql`0`;
  }
  return sql`((${reconciled} and ${f.id} in (select value from json_each(${ids}))) or (not ${reconciled} and ${plain}))`;
}

export function factStats(): { byStatus: Record<string, number>; byType: Record<string, number>; pendingMerges: number } {
  const d = db();
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const r of d.all<{ k: string; n: number }>(sql`
    select case when f.status = 'unverified' and f.verdict_basis = 'unsure' then 'unsure' else f.status end as k, count(*) as n
    from facts f left join documents d on d.id = f.source_document_id
    where f.deleted_at is null and (d.id is null or d.deleted_at is null) group by k`)) byStatus[r.k] = r.n; // unverified = pending only; unsure apart
  for (const r of d.all<{ k: string; n: number }>(sql`
    select f.type as k, count(*) as n from facts f left join documents d on d.id = f.source_document_id
    where f.deleted_at is null and (d.id is null or d.deleted_at is null) group by f.type`)) byType[r.k] = r.n;
  // Proposals that involve a fact the clinical-record pass set aside wait, hidden, until the link is undone; pairs of
  // measurements, procedures or events are grouped on Reconciliation instead.
  const pendingMerges =
    d.get<{ n: number }>(
      sql`select count(*) as n from fact_merges pm where pm.status = 'pending' and not ${passSetAsideSql(sql.raw('pm.fact_id_a'))} and not ${passSetAsideSql(sql.raw('pm.fact_id_b'))} and not ${reconciledPairSql(sql.raw('pm.fact_id_a'), sql.raw('pm.fact_id_b'))}`,
    )?.n ?? 0;
  return { byStatus, byType, pendingMerges };
}

export function getFactRow(id: string): FactRow | null {
  return db().select().from(schema.facts).where(and(eq(schema.facts.id, id), isNull(schema.facts.deletedAt))).get() ?? null;
}

function factsWithDocs(ids: string[]): Map<string, FactWithDoc> {
  const out = new Map<string, FactWithDoc>();
  if (!ids.length) return out;
  const rows = db()
    .select({ ...getTableColumns(schema.facts), documentTitle: schema.documents.title })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(inArray(schema.facts.id, ids))
    .all();
  for (const r of rows) out.set(r.id, r);
  return out;
}

export function getFact(id: string): FactDetail | null {
  const d = db();
  const f = getFactRow(id);
  if (!f) return null;
  const citations = d.select().from(schema.citations).where(eq(schema.citations.factId, id)).orderBy(asc(schema.citations.pageNumber), asc(schema.citations.createdAt)).all();
  const doc = f.sourceDocumentId ? d.select({ id: schema.documents.id, title: schema.documents.title, sourceTier: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, f.sourceDocumentId)).get() ?? null : null;
  const mergeRows = d
    .select()
    .from(schema.factMerges)
    .where(or(eq(schema.factMerges.factIdA, id), eq(schema.factMerges.factIdB, id)))
    .orderBy(desc(schema.factMerges.createdAt))
    .all();
  const need = new Set<string>();
  for (const m of mergeRows) {
    need.add(m.factIdA);
    need.add(m.factIdB);
  }
  const lookup = factsWithDocs([...need]);
  const hidden = passSetAsideIds([...need]);
  const merges: MergeWithFacts[] = [];
  for (const m of mergeRows) {
    const a = lookup.get(m.factIdA);
    const b = lookup.get(m.factIdB);
    // A proposal involving a fact the clinical-record pass set aside waits, hidden, as under Possible duplicates.
    if (m.status === 'pending' && (hidden.has(m.factIdA) || hidden.has(m.factIdB))) continue;
    if (a && b) merges.push({ ...m, a, b });
  }
  const supersededBy = f.supersededById ? getFactRow(f.supersededById) : null;
  const supersedes = d.select().from(schema.facts).where(and(eq(schema.facts.supersededById, id), isNull(schema.facts.deletedAt))).all();
  const run = f.extractionRunId
    ? d
        .select({
          id: schema.extractionRuns.id,
          model: schema.extractionRuns.model,
          deep: schema.extractionRuns.deep,
          startedAt: schema.extractionRuns.startedAt,
          finishedAt: schema.extractionRuns.finishedAt,
          status: schema.extractionRuns.status,
          schemaVersion: schema.extractionRuns.schemaVersion,
        })
        .from(schema.extractionRuns)
        .where(eq(schema.extractionRuns.id, f.extractionRunId))
        .get() ?? null
    : null;
  const overridesRows = d.select({ id: schema.facts.id }).from(schema.facts).where(and(eq(schema.facts.overriddenByFactId, id), isNull(schema.facts.deletedAt))).all();
  const related = factsWithDocs([...(f.overriddenByFactId ? [f.overriddenByFactId] : []), ...overridesRows.map((r) => r.id)]);
  // A statement that is deleted, disputed or superseded takes precedence over nothing, even if a stale pointer survives.
  const byRow = f.overriddenByFactId ? (related.get(f.overriddenByFactId) ?? null) : null;
  const overriddenBy = byRow && !byRow.deletedAt && byRow.status !== 'disputed' && byRow.status !== 'superseded' ? byRow : null;
  const overrides = overridesRows.map((r) => related.get(r.id)).filter((x): x is FactWithDoc => Boolean(x));
  return { ...f, citations, document: doc, merges, supersededBy, supersedes, run, overriddenBy, overrides, effectiveObjectivity: objectivityOf(f), trust: trustFor([id]).get(id)! };
}

/** objective | subjective for a stored row (rows stored as 'unknown' take the default for their type). */
export function objectivityOf(f: Pick<FactRow, 'type' | 'objectivity' | 'attributesJson'>): 'objective' | 'subjective' {
  return effectiveObjectivity({ type: f.type, objectivity: f.objectivity, attributes: parseJson<Record<string, unknown>>(f.attributesJson, {}) });
}

export function getCitation(citationId: string): (CitationRow & { pageText: string; documentTitle: string; factId: string | null }) | null {
  const d = db();
  const c = d.select().from(schema.citations).where(eq(schema.citations.id, citationId)).get();
  if (!c) return null;
  const doc = d.select({ title: schema.documents.title }).from(schema.documents).where(eq(schema.documents.id, c.documentId)).get();
  const page = d
    .select({ text: schema.documentPages.text })
    .from(schema.documentPages)
    .where(and(eq(schema.documentPages.documentId, c.documentId), eq(schema.documentPages.pageNumber, c.pageNumber)))
    .get();
  return { ...c, pageText: page?.text ?? '', documentTitle: doc?.title ?? '', factId: c.factId };
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export type PageTextLookup = (pageNumber: number) => string | undefined;

/** Lazily loads a document's pages on first use. */
export function pageTextLookupFor(documentId: string): PageTextLookup {
  let cache: Map<number, string> | null = null;
  return (n) => {
    if (!cache) {
      cache = new Map();
      for (const p of db().select({ pageNumber: schema.documentPages.pageNumber, text: schema.documentPages.text }).from(schema.documentPages).where(eq(schema.documentPages.documentId, documentId)).all()) {
        cache.set(p.pageNumber, p.text);
      }
    }
    return cache.get(n);
  };
}

export interface NewCitation {
  documentId: string;
  pageNumber: number;
  quote: string;
}

/** The page a citation that could not be located is filed under: the stated page, kept inside the document (1..last page). */
function statedPageWithin(documentId: string, pageNumber: number): number {
  let page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
  if (page < 1) page = 1;
  const last = db().get<{ n: number | null }>(sql`select max(page_number) as n from document_pages where document_id = ${documentId}`)?.n ?? null;
  if (last != null && last >= 1 && page > last) page = last;
  return page;
}

/**
 * Verify a quote against the page text (stated page, then page±1) and insert
 * the citation. Unverifiable quotes are stored with verified=false and
 * matchKind 'none'; nothing is dropped. A passage that is found but states a
 * different number than the quote ("82" quoted as "62") keeps its offsets so
 * the viewer can show where it is, but is stored verified=false with
 * matchKind 'mismatch'.
 *
 * `alternates` (2026-10-07, large exports): other forms of the same pages,
 * such as the reading-order text rebuilt from a page's boxes that the model
 * was given. A quote not verified in the stored text but found, numbers and
 * all, in one of them is verified too; its offsets are left empty because
 * they would not point into the stored text the viewer highlights.
 */
export function insertVerifiedCitation(factId: string, c: NewCitation, lookup: PageTextLookup, alternates?: readonly PageTextLookup[]): CitationRow {
  let found = locateCitation(lookup, c.pageNumber, c.quote, { allowNumericMismatch: true });
  let offsets = true;
  if (!isVerifiedMatch(found) && alternates?.length) {
    for (const alt of alternates) {
      const m = locateCitation(alt, c.pageNumber, c.quote);
      if (m && isVerifiedMatch(m)) {
        found = m;
        offsets = false;
        break;
      }
    }
  }
  const row: typeof schema.citations.$inferInsert = {
    id: newId(),
    factId,
    documentId: c.documentId,
    pageNumber: found?.page ?? statedPageWithin(c.documentId, c.pageNumber),
    quote: c.quote,
    charStart: offsets ? found?.start ?? null : null,
    charEnd: offsets ? found?.end ?? null : null,
    verified: isVerifiedMatch(found),
    matchKind: storedMatchKind(found),
    createdAt: nowIso(),
  };
  db().insert(schema.citations).values(row).run();
  return db().select().from(schema.citations).where(eq(schema.citations.id, row.id)).get()!;
}

/** Copy the citations of one fact onto another, skipping identical passages. */
export function copyCitations(fromFactId: string, toFactId: string): number {
  const d = db();
  const existing = d.select().from(schema.citations).where(eq(schema.citations.factId, toFactId)).all();
  const seen = new Set(existing.map((c) => `${c.documentId}:${c.pageNumber}:${c.quote}`));
  let n = 0;
  for (const c of d.select().from(schema.citations).where(eq(schema.citations.factId, fromFactId)).all()) {
    const key = `${c.documentId}:${c.pageNumber}:${c.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    d.insert(schema.citations).values({ ...c, id: newId(), factId: toFactId, createdAt: nowIso() }).run();
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// People resolution (clinician who stated it)
// ---------------------------------------------------------------------------

const SPEAKER_KEYS: Record<string, string[]> = {
  diagnosis: ['stated_by'],
  clinician_statement: ['stated_by'],
  recommendation: ['recommended_by'],
  medication: ['prescriber'],
  procedure: ['performed_by'],
  referral: ['from'],
  follow_up: ['who'],
};

export type PeopleIndex = Map<string, string>;

export function loadPeopleIndex(): PeopleIndex {
  const idx: PeopleIndex = new Map();
  const rows = db().select({ id: schema.people.id, name: schema.people.name, aliasesJson: schema.people.aliasesJson }).from(schema.people).where(isNull(schema.people.deletedAt)).all();
  for (const r of rows) {
    const names = [r.name, ...parseJson<string[]>(r.aliasesJson, [])];
    for (const n of names) {
      const k = normalizeKey(n);
      if (k && !idx.has(k)) idx.set(k, r.id);
    }
  }
  return idx;
}

export function resolvePersonId(type: string, attributes: Record<string, unknown>, peopleMentioned: string[], idx: PeopleIndex): string | null {
  if (!idx.size) return null;
  for (const key of SPEAKER_KEYS[type] ?? []) {
    const v = attributes[key];
    if (typeof v === 'string' && v.trim()) {
      const id = idx.get(normalizeKey(v));
      if (id) return id;
    }
  }
  const hits = new Set<string>();
  for (const n of peopleMentioned) {
    const id = idx.get(normalizeKey(n));
    if (id) hits.add(id);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

// ---------------------------------------------------------------------------
// Insert (shared by extraction and manual creation)
// ---------------------------------------------------------------------------

export interface InsertFactInput {
  type: string;
  statement: string;
  dateText?: string | null;
  dateEndText?: string | null;
  attributes: Record<string, unknown>;
  confidence?: number;
  status?: FactStatus;
  /** parsed: a lab value the app read off the page itself (services/lab-check.ts). */
  origin: 'ai' | 'manual' | 'import' | 'parsed';
  sourceDocumentId?: string | null;
  extractionRunId?: string | null;
  personId?: string | null;
  verdictNote?: string | null;
  /** objective | subjective; defaults by type (src/shared/schemas/facts.ts defaultObjectivity). */
  objectivity?: string | null;
  /** patient | clinician | compiler | unknown; defaults to unknown. */
  assertedBy?: string | null;
}

function checkObjectivity(v: string | null | undefined, type: string, attributes: Record<string, unknown>): string {
  if (!v || v === 'unknown') return defaultObjectivity(type, attributes);
  if (!(OBJECTIVITIES as readonly string[]).includes(v)) throw badRequest(`objectivity must be one of ${OBJECTIVITIES.join(', ')}`);
  return v;
}

function checkAssertedBy(v: string | null | undefined): string {
  if (!v) return 'unknown';
  if (!(ASSERTED_BY as readonly string[]).includes(v)) throw badRequest(`assertedBy must be one of ${ASSERTED_BY.join(', ')}`);
  return v;
}

/** The text a fact is found by in search: its statement, and the user's note on it. */
export function factSearchText(statement: string, note: string | null | undefined): string {
  const n = (note ?? '').trim();
  return n ? `${statement}\n${n}` : statement;
}

/** Re-index every live detail that carries a note, so notes written before they were searchable are found. */
export function reindexFactNotesSearch(): number {
  const rows = db()
    .select({ id: schema.facts.id, statement: schema.facts.statement, subjectKey: schema.facts.subjectKey, verdictNote: schema.facts.verdictNote })
    .from(schema.facts)
    .where(and(isNull(schema.facts.deletedAt), sql`coalesce(trim(${schema.facts.verdictNote}), '') <> ''`))
    .all();
  db().transaction(() => {
    for (const r of rows) reindexFact(r);
  });
  return rows.length;
}

/** (Re)write a fact's full-text entry: statement and note. */
function reindexFact(f: Pick<FactRow, 'id' | 'statement' | 'subjectKey' | 'verdictNote'>): void {
  indexFact(f.id, factSearchText(f.statement, f.verdictNote), f.subjectKey);
}

export function insertFact(input: InsertFactInput): FactRow {
  const d = db();
  const date = parsePartialDate(input.dateText ?? null);
  const dateEnd = parsePartialDate(input.dateEndText ?? null);
  const keyable = { type: input.type, attributes: input.attributes, date: date.iso };
  const now = nowIso();
  const row: typeof schema.facts.$inferInsert = {
    objectivity: checkObjectivity(input.objectivity, input.type, input.attributes),
    assertedBy: checkAssertedBy(input.assertedBy),
    id: newId(),
    type: input.type,
    statement: input.statement.trim(),
    date: date.iso,
    datePrecision: date.precision,
    dateText: date.text,
    dateEnd: dateEnd.iso,
    attributesJson: JSON.stringify(input.attributes),
    confidence: input.confidence ?? (input.origin === 'manual' ? 1 : 0.5),
    status: input.status ?? (input.origin === 'manual' ? 'confirmed' : 'unverified'),
    verdictAt: (input.status ?? (input.origin === 'manual' ? 'confirmed' : 'unverified')) === 'unverified' ? null : now,
    verdictNote: input.verdictNote ?? null,
    origin: input.origin,
    sourceDocumentId: input.sourceDocumentId ?? null,
    extractionRunId: input.extractionRunId ?? null,
    dedupKey: dedupKey(keyable),
    subjectKey: subjectKey(keyable),
    personId: input.personId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  d.insert(schema.facts).values(row).run();
  const inserted = d.select().from(schema.facts).where(eq(schema.facts.id, row.id)).get()!;
  reindexFact(inserted);
  return inserted;
}

export function toMergeCandidate(f: FactRow): MergeCandidateFact {
  return { id: f.id, statement: f.statement, date: f.date, dedupKey: f.dedupKey, subjectKey: f.subjectKey, sourceDocumentId: f.sourceDocumentId, extractionRunId: f.extractionRunId };
}

// ---------------------------------------------------------------------------
// Manual facts and edits
// ---------------------------------------------------------------------------

export interface ManualFactInput {
  type: string;
  statement: string;
  dateText?: string | null;
  dateEndText?: string | null;
  attributes?: Record<string, unknown>;
  citation?: NewCitation | null;
  personId?: string | null;
  note?: string | null;
  objectivity?: string | null;
  assertedBy?: string | null;
}

/** Strip private keys, validate against the type's schema, put private keys back. */
function cleanAttributes(type: string, attributes: Record<string, unknown> | undefined, strict: boolean): Record<string, unknown> {
  const input = attributes ?? {};
  const priv: Record<string, unknown> = {};
  const pub: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) (k.startsWith('_') ? priv : pub)[k] = v;
  if (!Object.keys(pub).length && !strict) return { ...priv };
  const r = validateAttributes(type, pub);
  if (!r.ok) throw badRequest(`attributes: ${r.error}`);
  delete priv._attributeError;
  return { ...r.value, ...priv };
}

export function createManualFact(input: ManualFactInput): FactDetail {
  if (!input.statement.trim()) throw badRequest('statement is required');
  const attributes = cleanAttributes(input.type, input.attributes, false);
  if (input.citation) {
    const doc = db().select({ id: schema.documents.id }).from(schema.documents).where(and(eq(schema.documents.id, input.citation.documentId), isNull(schema.documents.deletedAt))).get();
    if (!doc) throw badRequest('citation.documentId does not exist');
  }
  const fact = insertFact({
    type: input.type,
    statement: input.statement,
    dateText: input.dateText,
    dateEndText: input.dateEndText,
    attributes,
    origin: 'manual',
    status: 'confirmed',
    confidence: 1,
    sourceDocumentId: input.citation?.documentId ?? null,
    personId: input.personId ?? null,
    verdictNote: input.note ?? null,
    objectivity: input.objectivity,
    assertedBy: input.assertedBy,
  });
  if (input.citation) insertVerifiedCitation(fact.id, input.citation, pageTextLookupFor(input.citation.documentId));
  proposeMergesFor(toMergeCandidate(fact));
  return getFact(fact.id)!;
}

export interface FactPatch {
  statement?: string;
  dateText?: string | null;
  dateEndText?: string | null;
  attributes?: Record<string, unknown>;
  personId?: string | null;
  confidence?: number;
  objectivity?: string | null;
  assertedBy?: string | null;
}

/** Clinical attributes only (private `_` bookkeeping keys dropped). */
export function publicAttributes(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_')));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Does this pending update change what the fact says (not just its confidence)? An unchanged save is not an edit. */
function editChangesContent(f: FactRow, set: Partial<typeof schema.facts.$inferInsert>): boolean {
  if (set.statement !== undefined && set.statement !== f.statement) return true;
  if (set.date !== undefined && (set.date ?? null) !== (f.date ?? null)) return true;
  if (set.dateText !== undefined && (set.dateText ?? null) !== (f.dateText ?? null)) return true;
  if (set.dateEnd !== undefined && (set.dateEnd ?? null) !== (f.dateEnd ?? null)) return true;
  if (set.personId !== undefined && (set.personId ?? null) !== (f.personId ?? null)) return true;
  if (set.objectivity !== undefined && set.objectivity !== objectivityOf(f)) return true;
  if (set.assertedBy !== undefined && set.assertedBy !== f.assertedBy) return true;
  if (set.attributesJson !== undefined) {
    const before = publicAttributes(parseJson<Record<string, unknown>>(f.attributesJson, {}));
    const after = publicAttributes(parseJson<Record<string, unknown>>(set.attributesJson, {}));
    if (stableJson(before) !== stableJson(after)) return true;
  }
  return false;
}

export function updateFact(id: string, patch: FactPatch): FactDetail {
  const d = db();
  const f = getFactRow(id);
  if (!f) throw notFound('fact not found');
  const set: Partial<typeof schema.facts.$inferInsert> = { updatedAt: nowIso() };
  if (patch.statement !== undefined) {
    if (!patch.statement.trim()) throw badRequest('statement cannot be empty');
    set.statement = patch.statement.trim();
  }
  if (patch.dateText !== undefined) {
    const pd = parsePartialDate(patch.dateText);
    set.date = pd.iso;
    set.datePrecision = pd.precision;
    set.dateText = pd.text;
  }
  if (patch.dateEndText !== undefined) set.dateEnd = parsePartialDate(patch.dateEndText).iso;
  let attributes = parseJson<Record<string, unknown>>(f.attributesJson, {});
  if (patch.attributes !== undefined) {
    const priv = Object.fromEntries(Object.entries(attributes).filter(([k]) => k.startsWith('_')));
    attributes = cleanAttributes(f.type, { ...priv, ...patch.attributes }, true);
    set.attributesJson = JSON.stringify(attributes);
  }
  if (patch.personId !== undefined) set.personId = patch.personId;
  if (patch.confidence !== undefined) set.confidence = patch.confidence;
  if (patch.objectivity !== undefined) set.objectivity = checkObjectivity(patch.objectivity, f.type, attributes);
  if (patch.assertedBy !== undefined) set.assertedBy = checkAssertedBy(patch.assertedBy);
  // An edit to a model-extracted fact is the user's work, whatever its status:
  // mark it so a re-extraction keeps it (retirement skips `_userEdited`), and
  // remember the model's original wording once, so the re-extracted copy of
  // that same statement is recognised and dropped instead of coming back
  // beside the correction. Origin stays 'ai' (provenance is unchanged).
  if (f.origin === 'ai' && editChangesContent(f, set)) {
    const before = parseJson<Record<string, unknown>>(f.attributesJson, {});
    const original = before._aiOriginal ?? { statement: f.statement, date: f.date, attributes: publicAttributes(before) };
    attributes = { ...attributes, _userEdited: true, _aiOriginal: original };
    set.attributesJson = JSON.stringify(attributes);
  }
  if (patch.attributes !== undefined || patch.dateText !== undefined) {
    const keyable = { type: f.type, attributes, date: set.date !== undefined ? set.date : f.date };
    set.dedupKey = dedupKey(keyable);
    set.subjectKey = subjectKey(keyable);
  }
  d.update(schema.facts).set(set).where(eq(schema.facts.id, id)).run();
  const after = getFactRow(id)!;
  reindexFact(after);
  // A measurement's value, subject or date decides what it matches in the clinical record (services/reconcile.ts).
  if (isReconciledType(f.type)) reconcileQuietly({ trigger: 'verdict' });
  return getFact(id)!;
}

// ---------------------------------------------------------------------------
// Verdicts, supersession, delete
// ---------------------------------------------------------------------------

/**
 * A patient statement that is deleted, disputed or superseded no longer takes
 * precedence over anything: clear every override pointing at it, at once
 * (manual ones too, as the precedence pass's own cleanup does). Nothing is
 * re-applied here; when a dispute is reverted the next precedence pass decides.
 */
export function releaseOverridesBy(ids: string[], now: string = nowIso()): number {
  const want = [...new Set(ids.filter(Boolean))];
  let released = 0;
  for (let i = 0; i < want.length; i += 500) {
    const r = db()
      .update(schema.facts)
      .set({ overriddenByFactId: null, overrideReason: null, updatedAt: now })
      .where(and(inArray(schema.facts.overriddenByFactId, want.slice(i, i + 500)), isNull(schema.facts.deletedAt)))
      .run();
    released += r.changes;
  }
  return released;
}

/**
 * What the user's check said, beside the status: confirmed against the 'original' record, confirmed 'summary' only
 * (inferred, secondhand), 'unsure' (looked, could not tell; the fact stays unverified but is no longer pending), or
 * confirmed as a 'correction' (the patient's own word corrects a clinical inaccuracy: this detail is the truth for
 * its event and outranks the clinical record there; the note holds the reason; services/reconcile.ts correctRecord).
 */
export type VerdictBasis = 'original' | 'summary' | 'unsure' | 'correction';
export const VERDICT_BASES = ['original', 'summary', 'unsure', 'correction'] as const satisfies readonly VerdictBasis[];

/** The kind of original record that would back a fact of this type (records checklist). */
export function recordTypeForFact(type: string): (typeof RECORD_TYPES)[number] {
  switch (type) {
    case 'imaging_result':
      return 'imaging_report';
    case 'lab_result':
      return 'lab';
    case 'procedure':
      return 'operative_report';
    default:
      return 'other';
  }
}

function clipText(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * "Only from a summary": the user agrees the summary says this, but no
 * original record has been seen. Put the original on the records checklist
 * (status expected, remembering the fact), once: a live row that already
 * answers this fact is left as it is. Never removed when the verdict changes
 * later; the user may already have asked for the record.
 */
export function requestOriginalFor(f: FactRow): boolean {
  const d = db();
  const existing = d
    .select({ id: schema.recordsInventory.id })
    .from(schema.recordsInventory)
    .where(and(eq(schema.recordsInventory.sourceFactId, f.id), isNull(schema.recordsInventory.deletedAt)))
    .get();
  if (existing) return false;
  const docTitle = f.sourceDocumentId ? (d.select({ title: schema.documents.title }).from(schema.documents).where(eq(schema.documents.id, f.sourceDocumentId)).get()?.title ?? null) : null;
  const attrs = parseJson<Record<string, unknown>>(f.attributesJson, {});
  const placeRaw = [attrs.institution, attrs.lab_name, attrs.location].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const place = placeRaw?.trim() ?? null;
  const institutionId = place ? resolveInstitutionId(place) : null;
  const notes = [
    `Added because this value was only found in a summary${docTitle ? ` ("${clipText(docTitle, 200)}")` : ''}; the original record has not been seen.`,
    place && !institutionId ? `Institution as written: ${clipText(place, 200)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const dateText = f.dateText ?? f.date ?? null;
  createRecord({
    title: `Original record: ${clipText(f.statement, 140)}`,
    recordType: recordTypeForFact(f.type),
    status: 'expected',
    held: false,
    format: 'unknown',
    institutionId,
    ...(f.date ? { recordDate: f.date } : {}),
    ...(dateText ? { recordDateText: dateText } : {}),
    sourceFactId: f.id,
    notes,
  });
  return true;
}

export interface SetVerdictOptions {
  /**
   * false: do not run the clinical-record pass after this verdict. For bulk loops (Confirm all), which run it
   * once after the loop instead of once per fact.
   */
  reconcile?: boolean;
}

export function setVerdict(id: string, status: 'confirmed' | 'disputed' | 'unverified', note?: string | null, basis?: VerdictBasis | null, opts: SetVerdictOptions = {}): FactDetail {
  const f = getFactRow(id);
  if (!f) throw notFound('fact not found');
  if (basis != null && !(VERDICT_BASES as readonly string[]).includes(basis)) throw badRequest(`basis must be one of ${VERDICT_BASES.join(', ')}`);
  const now = nowIso();
  // A confirmed fact may say what it was checked against (original, summary) or that it corrects the record; an
  // unverified one may say the user was unsure. A basis that does not go with the status is ignored.
  const verdictBasis = status === 'confirmed' ? (basis === 'original' || basis === 'summary' || basis === 'correction' ? basis : null) : status === 'unverified' && basis === 'unsure' ? 'unsure' : null;
  // A correction stands on its reason: the note given now, or the one already there.
  if (verdictBasis === 'correction' && !((note !== undefined ? note : f.verdictNote) ?? '').trim()) throw badRequest('a correction needs a reason (the note)');
  // "Unsure" is a decision the user made, so it has a time; plain unverified (pending) has none.
  const set: Partial<typeof schema.facts.$inferInsert> = { status, verdictBasis, updatedAt: now, verdictAt: status === 'unverified' && verdictBasis !== 'unsure' ? null : now };
  if (note !== undefined) set.verdictNote = note && note.trim() ? note.trim() : null;
  if (f.status === 'superseded') set.supersededById = null;
  db().transaction(() => {
    db().update(schema.facts).set(set).where(eq(schema.facts.id, id)).run();
    // Set aside by the clinical-record pass and now decided by the user: the link is taken back, so the pass treats
    // the fact as the user's from now on (and never reads a later supersede by hand as its own).
    if (f.status === 'superseded') takeBackClinicalLink(id, now);
    // The note is part of the search entry.
    if (note !== undefined) reindexFact({ ...f, verdictNote: set.verdictNote ?? null });
    // A statement the user disputes stops taking precedence now, not on the next pass.
    if (status === 'disputed') releaseOverridesBy([id], now);
    // Confirmed only against a summary: ask for the original record.
    // Only when the answer changes to "inferred": saving a note again must not bring back a row the user deleted.
    if (verdictBasis === 'summary' && !(f.status === 'confirmed' && f.verdictBasis === 'summary')) requestOriginalFor({ ...f, ...set } as FactRow);
  });
  // A clinical-record measurement marked incorrect (or no longer incorrect) stops (or starts again) settling its
  // mentions; a mention the pass knows becomes the user's; a correction (made or taken back) outranks the record.
  // Confirm all on the record's own values changes none of these, so it does not re-run the pass (trust is read
  // fresh anyway). A bulk loop runs the pass once at its end.
  const correctionChanged = (verdictBasis === 'correction') !== (f.status === 'confirmed' && f.verdictBasis === 'correction');
  // "Not sure" on a clinical record's value (or taken back) stops (or starts again) it settling its mentions.
  const unsureChanged =
    (verdictBasis === 'unsure') !== (f.status === 'unverified' && f.verdictBasis === 'unsure') &&
    Boolean(f.sourceDocumentId) &&
    db().select({ t: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, f.sourceDocumentId!)).get()?.t === 'primary';
  if (opts.reconcile !== false && isReconciledType(f.type) && (status === 'disputed' || f.status === 'disputed' || f.status === 'superseded' || correctionChanged || unsureChanged || isSecondhandInReconcile(id))) {
    reconcileQuietly({ trigger: 'verdict' });
  }
  return getFact(id)!;
}

export function supersedeFact(id: string, byFactId: string): FactDetail {
  if (id === byFactId) throw badRequest('a fact cannot supersede itself');
  const f = getFactRow(id);
  if (!f) throw notFound('fact not found');
  const by = getFactRow(byFactId);
  if (!by) throw badRequest('byFactId does not exist');
  if (by.supersededById === id) throw conflict('that fact is already superseded by this one');
  const now = nowIso();
  db().transaction(() => {
    db().update(schema.facts).set({ status: 'superseded', supersededById: byFactId, verdictBasis: null, verdictAt: now, updatedAt: now }).where(eq(schema.facts.id, id)).run();
    // Replaced by hand: the user's decision, never the clinical-record pass's (its link, if any, is taken back).
    takeBackClinicalLink(id, now);
    releaseOverridesBy([id], now);
    closePendingMergesFor(id);
  });
  // A replaced clinical-record measurement no longer sets its copies aside: they meet what is left.
  if (isReconciledType(f.type)) reconcileQuietly({ trigger: 'verdict' });
  return getFact(id)!;
}

/**
 * The user's delete (the Delete action on a detail). The detail remembers it was the user's (`_deletedBy: 'user'`), so
 * the lab check never adds back a value the user deleted (an automatic re-read's retirement leaves no such mark).
 */
export function softDeleteFact(id: string): boolean {
  const f = getFactRow(id);
  if (!f) return false;
  const now = nowIso();
  const attrs = { ...parseJson<Record<string, unknown>>(f.attributesJson, {}), _deletedBy: 'user' };
  db().transaction(() => {
    db().update(schema.facts).set({ deletedAt: now, updatedAt: now, attributesJson: JSON.stringify(attrs) }).where(eq(schema.facts.id, id)).run();
    // A deleted patient statement no longer takes precedence over anything.
    releaseOverridesBy([id], now);
    removeFactIndex(id);
    closePendingMergesFor(id);
  });
  if (isReconciledType(f.type)) reconcileQuietly({ trigger: 'verdict' });
  return true;
}

// ---------------------------------------------------------------------------
// Patient precedence by hand: set or clear which patient statement outranks
// a clinician's or compiler's subjective assessment (consult layer only; the
// record itself is never hidden). The user's decision is remembered in
// attributes._overrideManual so the automatic rule never undoes it.
// ---------------------------------------------------------------------------

export const OBJECTIVE_REFUSAL = 'Objective facts (measured values and recorded events) are ground truth and cannot be overridden; a lab value stays a lab value. Dispute it instead if the record is wrong.';

function setManualFlag(f: FactRow, manual: boolean): string {
  const attrs = parseJson<Record<string, unknown>>(f.attributesJson, {});
  if (manual) attrs._overrideManual = true;
  else delete attrs._overrideManual;
  return JSON.stringify(attrs);
}

export interface OverrideInput {
  /** The patient statement that takes precedence; null clears the override. */
  byFactId?: string | null;
  reason?: string | null;
  /** Instead of byFactId: type a new patient statement (manual, confirmed, subjective, asserted by the patient) and apply it in one step. */
  statement?: string | null;
  dateText?: string | null;
}

/** Create the "New statement" fact: same type and subject as the target so the two sit together, in the patient's voice. */
export function createPatientStatementFor(target: FactRow, statement: string, dateText?: string | null): FactRow {
  const text = statement.trim();
  if (!text) throw badRequest('statement is required');
  const src = parseJson<Record<string, unknown>>(target.attributesJson, {});
  const attributes: Record<string, unknown> = {};
  // Carry the subject-bearing attributes only, so the subject key matches and nothing else is asserted on the patient's behalf.
  for (const key of ['name', 'analyte', 'substance', 'modality', 'body_part', 'record_type', 'description', 'what', 'action', 'to', 'about']) {
    if (typeof src[key] === 'string' && (src[key] as string).trim()) attributes[key] = src[key];
  }
  const cleaned = validateAttributes(target.type, attributes);
  return insertFact({
    type: target.type,
    statement: text,
    dateText: dateText ?? null,
    attributes: cleaned.ok ? cleaned.value : attributes,
    origin: 'manual',
    status: 'confirmed',
    confidence: 1,
    objectivity: 'subjective',
    assertedBy: 'patient',
    verdictNote: 'Patient statement entered to take precedence over a recorded assessment.',
  });
}

/**
 * Whether a fact speaks in the patient's voice, the way the precedence rule
 * reads it: asserted by the patient, entered by hand (the picker's own
 * criterion), or stored without a voice in a patient-tier document.
 */
function inPatientVoice(f: FactRow): boolean {
  if (f.assertedBy === 'patient' || f.origin === 'manual') return true;
  if ((f.assertedBy ?? 'unknown') !== 'unknown' || !f.sourceDocumentId) return false;
  const tier = db().select({ tier: schema.documents.sourceTier }).from(schema.documents).where(eq(schema.documents.id, f.sourceDocumentId)).get()?.tier;
  return tier === 'patient';
}

export function setOverride(id: string, input: OverrideInput): FactDetail {
  const f = getFactRow(id);
  if (!f) throw notFound('fact not found');
  const now = nowIso();
  const clearing = input.byFactId === null && !input.statement;
  if (clearing) {
    db().update(schema.facts).set({ overriddenByFactId: null, overrideReason: null, attributesJson: setManualFlag(f, true), updatedAt: now }).where(eq(schema.facts.id, id)).run();
    return getFact(id)!;
  }
  if (objectivityOf(f) === 'objective') throw conflict(OBJECTIVE_REFUSAL);
  let by: FactRow | null = null;
  if (input.statement && input.statement.trim()) by = createPatientStatementFor(f, input.statement, input.dateText);
  else if (input.byFactId) by = getFactRow(input.byFactId);
  if (!by) throw badRequest('byFactId does not exist (or pass statement to add a new patient statement)');
  if (by.id === id) throw badRequest('a fact cannot take precedence over itself');
  if (by.overriddenByFactId === id) throw conflict('that statement is itself overridden by this fact; clear that first');
  if (by.status === 'disputed' || by.status === 'superseded') throw conflict(`a ${by.status} statement cannot take precedence`);
  // The picker offers patient statements only; the endpoint holds to the same line.
  if (objectivityOf(by) === 'objective') throw badRequest('an objective fact (a measured value or a recorded event) is not a statement of the patient\'s view and cannot take precedence; pick or type a patient statement');
  if (!inPatientVoice(by)) throw badRequest('only a statement in the patient\'s own voice (asserted by the patient, entered by hand, or from a patient-tier document) can take precedence');
  const reason = (input.reason ?? '').trim() || `Set by hand: the patient's statement of ${by.date ?? 'an unknown date'} takes precedence.`;
  db().update(schema.facts).set({ overriddenByFactId: by.id, overrideReason: reason.slice(0, 500), attributesJson: setManualFlag(f, true), updatedAt: now }).where(eq(schema.facts.id, id)).run();
  return getFact(id)!;
}

/**
 * Patient statements that share the target's subject (the picker's list),
 * newest first. A clinician statement's subject is "who said it about what",
 * so its candidates are matched on the "about" part alone; the statement
 * currently taking precedence is always listed.
 */
export function patientStatementsFor(id: string): FactWithDoc[] {
  const f = getFactRow(id);
  if (!f) throw notFound('fact not found');
  const conds: SQL[] = [isNull(schema.facts.deletedAt), sql`${schema.facts.id} != ${id}`, inArray(schema.facts.status, ['confirmed', 'unverified'])];
  const subjectConds: SQL[] = [];
  if (f.subjectKey) {
    if (f.type === 'clinician_statement') {
      const about = f.subjectKey.split('|').slice(2).join('|');
      if (about) subjectConds.push(sql`${schema.facts.subjectKey} like ${`%|${about}`}`);
      else subjectConds.push(eq(schema.facts.subjectKey, f.subjectKey));
    } else subjectConds.push(eq(schema.facts.subjectKey, f.subjectKey));
  }
  if (f.overriddenByFactId) subjectConds.push(eq(schema.facts.id, f.overriddenByFactId));
  if (subjectConds.length) conds.push(or(...subjectConds)!);
  conds.push(or(eq(schema.facts.assertedBy, 'patient'), eq(schema.facts.origin, 'manual'))!);
  const rows = db()
    .select({ ...getTableColumns(schema.facts), documentTitle: schema.documents.title })
    .from(schema.facts)
    .leftJoin(schema.documents, eq(schema.documents.id, schema.facts.sourceDocumentId))
    .where(and(...conds))
    .orderBy(desc(schema.facts.date), desc(schema.facts.createdAt))
    .limit(200)
    .all();
  return rows;
}

// ---------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------

export function listMerges(status?: string): MergeWithFacts[] {
  const d = db();
  const rows = status
    ? d.select().from(schema.factMerges).where(eq(schema.factMerges.status, status)).orderBy(desc(schema.factMerges.similarity), desc(schema.factMerges.createdAt)).all()
    : d.select().from(schema.factMerges).orderBy(desc(schema.factMerges.createdAt)).all();
  const ids = new Set<string>();
  for (const m of rows) {
    ids.add(m.factIdA);
    ids.add(m.factIdB);
  }
  const lookup = factsWithDocs([...ids]);
  // A proposal involving a fact the clinical-record pass set aside waits, hidden: undoing the link brings it back.
  const hidden = passSetAsideIds([...ids]);
  const out: MergeWithFacts[] = [];
  for (const m of rows) {
    const a = lookup.get(m.factIdA);
    const b = lookup.get(m.factIdB);
    if (!a || !b) continue;
    if (m.status === 'pending' && (a.deletedAt || b.deletedAt)) continue;
    if (m.status === 'pending' && (hidden.has(m.factIdA) || hidden.has(m.factIdB))) continue;
    // Two measurements, procedures or events: Reconciliation groups them (one event, every mention), so the pair is
    // not asked about here; a pair already decided stays in the history.
    if (m.status === 'pending' && isReconciledType(a.type) && isReconciledType(b.type)) continue;
    out.push({ ...m, a, b });
  }
  return out;
}

export function getMerge(id: string): MergeWithFacts | null {
  const m = db().select().from(schema.factMerges).where(eq(schema.factMerges.id, id)).get();
  if (!m) return null;
  const lookup = factsWithDocs([m.factIdA, m.factIdB]);
  const a = lookup.get(m.factIdA);
  const b = lookup.get(m.factIdB);
  if (!a || !b) return null;
  return { ...m, a, b };
}

export function acceptMerge(id: string, keep: 'a' | 'b'): MergeWithFacts {
  const m = getMerge(id);
  if (!m) throw notFound('merge not found');
  if (m.status !== 'pending') throw conflict(`merge already ${m.status}`);
  const keeper = keep === 'a' ? m.a : m.b;
  const loser = keep === 'a' ? m.b : m.a;
  if (loser.deletedAt || keeper.deletedAt) throw conflict('one of the facts has been deleted');
  const now = nowIso();
  db().transaction(() => {
    db().update(schema.facts).set({ status: 'superseded', supersededById: keeper.id, verdictBasis: null, verdictAt: now, updatedAt: now }).where(eq(schema.facts.id, loser.id)).run();
    // Merged by hand: the user's decision, never the clinical-record pass's (its link, if any, is taken back).
    takeBackClinicalLink(loser.id, now);
    // The retired duplicate stops taking precedence; the next precedence pass may hand it to the keeper.
    releaseOverridesBy([loser.id], now);
    copyCitations(loser.id, keeper.id);
    db().update(schema.factMerges).set({ status: 'accepted', decidedAt: now }).where(eq(schema.factMerges.id, id)).run();
    closePendingMergesFor(loser.id);
  });
  if (isReconciledType(loser.type)) reconcileQuietly({ trigger: 'verdict' });
  return getMerge(id)!;
}

export function rejectMerge(id: string): MergeWithFacts {
  const m = getMerge(id);
  if (!m) throw notFound('merge not found');
  if (m.status !== 'pending') throw conflict(`merge already ${m.status}`);
  db().update(schema.factMerges).set({ status: 'rejected', decidedAt: nowIso() }).where(eq(schema.factMerges.id, id)).run();
  return getMerge(id)!;
}

// ---------------------------------------------------------------------------
// Extraction requests
// ---------------------------------------------------------------------------

/**
 * Documents with page text whose details are not all pulled out: no live facts, or read only in part (`partial`, or a
 * `failed` reading that left some details: since 2026-10-07 a document read part-way is never mistaken for a finished
 * one). The "extract everything new" set; a part-read document continues where it stopped (scope missing).
 */
export function documentsWithoutFacts(): string[] {
  return db()
    .all<{ id: string }>(
      sql`select d.id from documents d
          where d.deleted_at is null
            and exists (select 1 from document_pages p where p.document_id = d.id and length(trim(p.text)) > 0)
            and (d.extraction_status in ('partial', 'failed')
                 or not exists (select 1 from facts f where f.source_document_id = d.id and f.deleted_at is null))
            and d.extraction_status not in ('queued','running')
            and d.text_status not in ('pending','extracting','ocr_running')
          order by d.created_at asc`,
    )
    .map((r) => r.id);
}

/** Text extraction still writing pages: an extraction queued now would read a partial document or none. */
const TEXT_IN_PROGRESS = ['pending', 'extracting', 'ocr_running'];

/** What an extraction request reads when it does not say: a finished document again in whole, anything else what is missing. */
function scopeFor(status: string | null | undefined): 'missing' | 'whole' {
  return status === 'done' ? 'whole' : 'missing';
}

export function enqueueExtraction(opts: { documentIds?: string[]; allWithoutFacts?: boolean; deep?: boolean; scope?: 'missing' | 'failed' | 'whole' }): {
  jobs: Array<{ id: string; documentId: string | null; status: string }>;
  skipped: string[];
  /** documentId -> why it was not queued (not found, no page text yet, text still being extracted). */
  skippedReasons: Record<string, string>;
} {
  const d = db();
  const ids = new Set<string>(opts.documentIds ?? []);
  // The bulk "without details" action carries on where a reading stopped; it never re-reads a finished part.
  const bulk = new Set<string>();
  if (opts.allWithoutFacts) for (const id of documentsWithoutFacts()) {
    if (!ids.has(id)) bulk.add(id);
    ids.add(id);
  }
  const jobs: Array<{ id: string; documentId: string | null; status: string }> = [];
  const skipped: string[] = [];
  const skippedReasons: Record<string, string> = {};
  const skip = (id: string, reason: string) => {
    skipped.push(id);
    skippedReasons[id] = reason;
  };
  for (const documentId of ids) {
    const doc = d.select({ id: schema.documents.id, textStatus: schema.documents.textStatus, extractionStatus: schema.documents.extractionStatus }).from(schema.documents).where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt))).get();
    if (!doc) {
      skip(documentId, 'document not found');
      continue;
    }
    // Same line as POST /api/documents/:id/extract: no job (and no failed run) for a document that has no text to read yet.
    if (TEXT_IN_PROGRESS.includes(doc.textStatus)) {
      skip(documentId, 'text extraction is still running; try again when it finishes');
      continue;
    }
    const hasText = d.get<{ n: number }>(sql`select count(*) as n from document_pages where document_id = ${documentId} and length(trim(text)) > 0`)?.n ?? 0;
    if (!hasText) {
      skip(documentId, 'the document has no page text yet; wait for ingestion or OCR, or re-ingest it');
      continue;
    }
    const scope = opts.scope ?? (bulk.has(documentId) ? 'missing' : scopeFor(doc.extractionStatus));
    const job = enqueueJob({ type: 'extract_facts', payload: { documentId, deep: Boolean(opts.deep), scope, reason: 'user', prevStatus: doc.extractionStatus }, documentId, dedupe: true });
    if (job.status === 'queued') d.update(schema.documents).set({ extractionStatus: 'queued', updatedAt: nowIso() }).where(eq(schema.documents.id, documentId)).run();
    jobs.push({ id: job.id, documentId: job.documentId, status: job.status });
  }
  return { jobs, skipped, skippedReasons };
}
