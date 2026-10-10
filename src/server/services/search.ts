/**
 * Full-text index helpers over the FTS5 tables created in src/server/db.
 * Services call these when they write pages, facts, or entities, so the
 * command palette and Ask-the-case retrieval see everything.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';

export type EntityType = 'document' | 'person' | 'communication' | 'record' | 'task' | 'finding' | 'encounter' | 'medication' | 'lab' | 'imaging' | 'intolerance';

export interface SearchHit {
  type: EntityType | 'fact' | 'page';
  id: string;
  title: string;
  snippet?: string;
  date?: string | null;
  href: string;
  documentId?: string;
  pageNumber?: number;
  rank: number;
}

/** Turn free text into a safe FTS5 MATCH expression: every token must appear, prefix-matched. */
export function ftsQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

export function indexPage(pageId: string, documentId: string, pageNumber: number, text: string): void {
  const d = db();
  d.run(sql`delete from pages_fts where page_id = ${pageId}`);
  if (text.trim()) d.run(sql`insert into pages_fts(page_id, document_id, page_number, text) values (${pageId}, ${documentId}, ${pageNumber}, ${text})`);
}

export function removeDocumentPagesIndex(documentId: string): void {
  db().run(sql`delete from pages_fts where document_id = ${documentId}`);
}

export function indexFact(factId: string, statement: string, subject: string | null): void {
  const d = db();
  d.run(sql`delete from facts_fts where fact_id = ${factId}`);
  d.run(sql`insert into facts_fts(fact_id, statement, subject) values (${factId}, ${statement}, ${subject ?? ''})`);
}

export function removeFactIndex(factId: string): void {
  db().run(sql`delete from facts_fts where fact_id = ${factId}`);
}

export function indexEntity(type: EntityType, id: string, title: string, body: string | null | undefined): void {
  const d = db();
  d.run(sql`delete from entities_fts where entity_type = ${type} and entity_id = ${id}`);
  d.run(sql`insert into entities_fts(entity_type, entity_id, title, body) values (${type}, ${id}, ${title}, ${body ?? ''})`);
}

export function removeEntityIndex(type: EntityType, id: string): void {
  db().run(sql`delete from entities_fts where entity_type = ${type} and entity_id = ${id}`);
}

export function hrefFor(type: SearchHit['type'], id: string, extra?: { documentId?: string; pageNumber?: number }): string {
  switch (type) {
    case 'document':
      return `/documents/${id}`;
    case 'page':
      return `/documents/${extra?.documentId ?? id}?page=${extra?.pageNumber ?? 1}`;
    case 'fact':
      return `/facts?id=${id}`;
    case 'person':
      return `/people?id=${id}`;
    case 'communication':
      return `/communications?id=${id}`;
    case 'record':
      return `/records?id=${id}`;
    case 'task':
      return `/tasks?id=${id}`;
    case 'finding':
      return `/findings?id=${id}`;
    case 'encounter':
      return `/encounters?id=${id}`;
    case 'medication':
      return `/medications?id=${id}`;
    case 'lab':
      return `/labs?id=${id}`;
    case 'imaging':
      return `/imaging?id=${id}`;
    case 'intolerance':
      return `/medications?view=intolerances&id=${id}`;
  }
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to these hit types (entity types, 'fact', 'page'). */
  types?: Array<SearchHit['type']>;
  /** When true, every matching page is returned (not collapsed per document). */
  allPages?: boolean;
}

/** SQL on entities_fts: the hit's row is not on a deleted document (lab, imaging), nor a message read out of one. */
const ON_LIVE_DOCUMENT = sql.raw(`not (
  (entity_type = 'lab' and exists (select 1 from lab_results lx join documents dx on dx.id = lx.document_id where lx.id = entity_id and dx.deleted_at is not null))
  or (entity_type = 'imaging' and exists (select 1 from imaging_studies ix join documents dx on dx.id = ix.document_id where ix.id = entity_id and dx.deleted_at is not null))
  or (entity_type = 'communication' and exists (select 1 from communications cx join documents dx on dx.id = cx.document_id where cx.id = entity_id and dx.deleted_at is not null
    and json_valid(cx.details_json) and json_extract(cx.details_json, '$.origin') = 'extracted'))
)`);

/** Search everything. Pages are collapsed to one hit per document unless allPages. */
export function searchAll(q: string, limitOrOpts: number | SearchOptions = 25): SearchHit[] {
  const opts: SearchOptions = typeof limitOrOpts === 'number' ? { limit: limitOrOpts } : limitOrOpts;
  const limit = Math.min(Math.max(1, opts.limit ?? 25), 500);
  const want = (t: SearchHit['type']) => !opts.types || opts.types.includes(t);
  const match = ftsQuery(q);
  if (!match) return [];
  const d = db();
  const hits: SearchHit[] = [];

  // The type filter belongs in the query: filtering after LIMIT would let
  // hundreds of lab or communication rows crowd out the wanted documents.
  const entityTypes = opts.types?.filter((t): t is EntityType => t !== 'fact' && t !== 'page');
  if (!entityTypes || entityTypes.length) {
    const typeFilter = entityTypes
      ? sql` and entity_type in (${sql.join(
          entityTypes.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql``;
    // A lab row or imaging study on a deleted document, and a message read out of one, are hidden as their pages hide
    // them; a document held back as someone else's record is deleted until the user answers (review 2026-10-09).
    const ents = d.all<{ entity_type: EntityType; entity_id: string; title: string; snippet: string; rank: number }>(sql`
      select entity_type, entity_id, title, snippet(entities_fts, 3, '', '', ' … ', 12) as snippet, bm25(entities_fts, 0, 0, 4.0, 1.0) as rank
      from entities_fts where entities_fts match ${match}${typeFilter} and ${ON_LIVE_DOCUMENT} order by rank limit ${limit}
    `);
    for (const e of ents) {
      hits.push({ type: e.entity_type, id: e.entity_id, title: e.title, snippet: e.snippet || undefined, href: hrefFor(e.entity_type, e.entity_id), rank: e.rank });
    }
  }

  if (want('fact')) {
    const facts = d.all<{ fact_id: string; statement: string; snippet: string; rank: number; date: string | null; status: string }>(sql`
      select f.fact_id, f.statement, snippet(facts_fts, 1, '', '', ' … ', 14) as snippet, bm25(facts_fts, 0, 1.0, 2.0) as rank, fa.date, fa.status
      from facts_fts f join facts fa on fa.id = f.fact_id and fa.deleted_at is null
      where facts_fts match ${match} order by rank limit ${limit}
    `);
    for (const f of facts) hits.push({ type: 'fact', id: f.fact_id, title: f.statement.length > 110 ? `${f.statement.slice(0, 110)}…` : f.statement, snippet: f.status, date: f.date, href: hrefFor('fact', f.fact_id), rank: f.rank });
  }

  if (want('page')) {
    const pages = d.all<{ document_id: string; page_number: number; title: string; snippet: string; rank: number; date: string | null }>(sql`
      select p.document_id, p.page_number, doc.title, snippet(pages_fts, 3, '', '', ' … ', 14) as snippet, bm25(pages_fts) as rank, doc.document_date as date
      from pages_fts p join documents doc on doc.id = p.document_id and doc.deleted_at is null
      where pages_fts match ${match} order by rank limit ${opts.allPages ? limit : limit * 3}
    `);
    const seen = new Set<string>();
    for (const p of pages) {
      if (!opts.allPages) {
        if (seen.has(p.document_id)) continue;
        seen.add(p.document_id);
      }
      hits.push({ type: 'page', id: `${p.document_id}:${p.page_number}`, title: `${p.title} · p.${p.page_number}`, snippet: p.snippet || undefined, date: p.date, href: hrefFor('page', p.document_id, { documentId: p.document_id, pageNumber: p.page_number }), documentId: p.document_id, pageNumber: p.page_number, rank: p.rank });
    }
  }

  hits.sort((a, b) => a.rank - b.rank);
  return hits.slice(0, limit);
}
