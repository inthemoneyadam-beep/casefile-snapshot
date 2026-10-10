/**
 * Alias suggestions and the user's merge of people (2026-10-07, the people directory from messages).
 *
 * FROZEN SIGNATURES (WP0). Owner: WP-C. Rules:
 * - suggestions are computed on read and NEVER merged automatically;
 * - placeholder and system users ("Mychart, Generic", "Historical Provider, MD") are never suggested; a clinic is only
 *   compared with clinics and institutions, a person only with people;
 * - a merge is the user's act, recorded in `filings` (target_type 'person', action 'merge', status 'approved', source
 *   'user') with everything Undo needs: every re-pointed row (table, column, id, the id it pointed at), the
 *   participant links set aside because the communication already had the kept person, the kept person's aliases
 *   before; the merged person is soft-deleted and its names join the kept person's aliases;
 * - Undo puts every row back that still points at the kept person, brings the merged people back and takes the added
 *   aliases off again (status 'undone');
 * - a declined suggestion is a filings row (action 'merge_suggestion', status 'declined', target the suggestion id) and
 *   is not offered again for the same people.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { badRequest, conflict, notFound, zodIssues } from '../util/errors';
import { newId, nowIso, parseJson } from '../util/ids';
import { removeEntityIndex } from './search';
import { reindexCommunication } from './communications';
import { indexPerson, isPlaceholderName, normaliseAliases } from './people';
import { mergePeopleInput, personNameKey, sha256Hex, type MergePeopleInput, type MergeResult, type MergeSuggestion } from '../../shared/schemas/segments';

/** Every column that points at a person, re-pointed by a merge (and put back by Undo). */
const PERSON_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'communication_participants', column: 'person_id' },
  { table: 'communications', column: 'follow_up_owner_person_id' },
  { table: 'facts', column: 'person_id' },
  { table: 'documents', column: 'author_person_id' },
  { table: 'documents', column: 'institution_id' },
  { table: 'encounters', column: 'clinician_id' },
  { table: 'encounters', column: 'institution_id' },
  { table: 'medications', column: 'prescriber_id' },
  { table: 'tasks', column: 'owner_person_id' },
  { table: 'people', column: 'institution_id' },
  { table: 'records_inventory', column: 'institution_id' },
  { table: 'lab_results', column: 'institution_id' },
  { table: 'imaging_studies', column: 'institution_id' },
];

const DECLINE_ACTION = 'merge_suggestion';

type PersonRow = typeof schema.people.$inferSelect;

interface Candidate {
  row: PersonRow;
  key: string;
  tokens: string[];
  aliasKeys: Set<string>;
  group: 'person' | 'place';
  weight: number;
}

function groupOf(kind: string): 'person' | 'place' {
  return kind === 'clinic' || kind === 'institution' ? 'place' : 'person';
}

/** Edit distance (Levenshtein), stopping early past `max`. */
function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let best = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      best = Math.min(best, prev[j]);
    }
    if (best > max) return max + 1;
  }
  return prev[b.length];
}

/** Similar given names: equal, one an initial of the other, or close spellings of the same start ("Robyn", "Robin"). */
function givenNamesClose(a: string, b: string): 'same' | 'initial' | 'close' | null {
  if (!a || !b) return null;
  if (a === b) return 'same';
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return 'initial';
  if (a.length >= 4 && b.length >= 4 && a[0] === b[0] && editDistance(a, b, 2) <= 2) return 'close';
  return null;
}

function stableId(ids: string[]): string {
  return `ms_${sha256Hex([...ids].sort().join('|')).slice(0, 24)}`;
}

function declinedIds(): Set<string> {
  return new Set(
    db()
      .select({ targetId: schema.filings.targetId })
      .from(schema.filings)
      .where(and(eq(schema.filings.targetType, 'person'), eq(schema.filings.action, DECLINE_ACTION), eq(schema.filings.status, 'declined')))
      .all()
      .map((r) => r.targetId),
  );
}

/** How much a person is used (communications, facts, documents): the one kept is the most used. */
function weights(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  for (const r of db().all<{ id: string; n: number }>(sql`
    select p.id as id,
      (select count(*) from communication_participants cp where cp.person_id = p.id)
      + (select count(*) from facts f where f.person_id = p.id and f.deleted_at is null)
      + (select count(*) from documents d where (d.author_person_id = p.id or d.institution_id = p.id) and d.deleted_at is null) as n
    from people p where p.deleted_at is null`))
    out.set(r.id, Number(r.n));
  return out;
}

/** GET /api/people/merge-suggestions (optionally for one person). */
export function mergeSuggestions(opts: { personId?: string | null } = {}): MergeSuggestion[] {
  const rows = db().select().from(schema.people).where(isNull(schema.people.deletedAt)).all();
  const w = weights(rows.map((r) => r.id));
  const people: Candidate[] = rows
    .filter((r) => r.kind !== 'patient' && r.kind !== 'chief_of_staff' && !isPlaceholderName(r.name))
    .map((r) => {
      const key = personNameKey(r.name);
      return { row: r, key, tokens: key.split(' ').filter(Boolean), aliasKeys: new Set(parseJson<string[]>(r.aliasesJson, []).map((a) => personNameKey(a)).filter(Boolean)), group: groupOf(r.kind), weight: w.get(r.id) ?? 0 };
    })
    .filter((c) => c.key);
  const declined = declinedIds();
  const out: MergeSuggestion[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i];
      const b = people[j];
      if (a.group !== b.group) continue;
      if (opts.personId && a.row.id !== opts.personId && b.row.id !== opts.personId) continue;
      const verdict = compare(a, b);
      if (!verdict) continue;
      const id = stableId([a.row.id, b.row.id]);
      if (declined.has(id)) continue;
      const [keep, other] = a.weight > b.weight || (a.weight === b.weight && a.row.name.length >= b.row.name.length) ? [a, b] : [b, a];
      out.push({
        id,
        keep: { personId: keep.row.id, name: keep.row.name, kind: keep.row.kind },
        others: [{ personId: other.row.id, name: other.row.name, kind: other.row.kind }],
        reason: verdict.reason,
        evidence: [
          { kind: verdict.kind, text: `${keep.row.name}${keep.row.role ? `, ${keep.row.role}` : ''}`.slice(0, 300), documentId: null, page: null },
          { kind: verdict.kind, text: `${other.row.name}${other.row.role ? `, ${other.row.role}` : ''}`.slice(0, 300), documentId: null, page: null },
        ],
        strength: verdict.strength,
      });
    }
  }
  return out.sort((x, y) => (x.strength === y.strength ? x.keep.name.localeCompare(y.keep.name) : x.strength === 'strong' ? -1 : 1));
}

function compare(a: Candidate, b: Candidate): { strength: 'strong' | 'possible'; reason: string; kind: 'alias' | 'name_form' } | null {
  if (a.key === b.key) return { strength: 'strong', reason: 'The same name, written the same way once titles and roles are set aside.', kind: 'name_form' };
  if (a.aliasKeys.has(b.key) || b.aliasKeys.has(a.key) || [...a.aliasKeys].some((k) => b.aliasKeys.has(k))) {
    return { strength: 'strong', reason: 'One is listed as another name of the other.', kind: 'alias' };
  }
  if (a.group === 'place') return null;
  const aLast = a.tokens[a.tokens.length - 1];
  const bLast = b.tokens[b.tokens.length - 1];
  if (a.tokens.length >= 2 && b.tokens.length >= 2) {
    if (aLast !== bLast || aLast.length < 2) return null;
    const g = givenNamesClose(a.tokens[0], b.tokens[0]);
    if (g === 'same') return { strength: 'strong', reason: 'Same surname and first name; only middle names or initials differ.', kind: 'name_form' };
    if (g === 'initial') return { strength: 'possible', reason: 'Same surname, and one first name is the other\'s initial.', kind: 'name_form' };
    if (g === 'close') return { strength: 'possible', reason: 'Same surname and first names spelled nearly alike.', kind: 'name_form' };
    return null;
  }
  // One name alone ("Robyn", "Dr. Example"): its word is the other's surname, or a first name spelled nearly alike.
  const single = a.tokens.length === 1 ? a : b;
  const full = single === a ? b : a;
  if (full.tokens.length < 2 || single.tokens[0].length < 3) return null;
  const word = single.tokens[0];
  if (word === full.tokens[full.tokens.length - 1]) return { strength: 'possible', reason: 'One is written by surname only, and the surname is the same.', kind: 'name_form' };
  const g = givenNamesClose(word, full.tokens[0]);
  if (g === 'same' || g === 'close') return { strength: 'possible', reason: 'One is written by first name only, spelled the same or nearly alike (as a name is often heard on a call).', kind: 'name_form' };
  return null;
}

interface Repointed {
  table: string;
  column: string;
  id: string;
  from: string;
}

interface MergeDetail {
  keepId: string;
  mergeIds: string[];
  repointed: Repointed[];
  removedLinks: Array<{ id: string; communicationId: string; personId: string; role: string }>;
  aliasesBefore: string[];
  aliasesAdded: string[];
  suggestionId: string | null;
  reason: string | null;
}

function countsOf(list: Repointed[], removed: MergeDetail['removedLinks']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of list) out[r.table] = (out[r.table] ?? 0) + 1;
  if (removed.length) out.communication_participants = (out.communication_participants ?? 0) + removed.length;
  return out;
}

/** POST /api/people/merge. */
export function mergePeople(input: MergePeopleInput, opts: { by?: string | null } = {}): MergeResult {
  const parsed = mergePeopleInput.safeParse(input);
  if (!parsed.success) throw badRequest(zodIssues(parsed.error));
  const { keepId, suggestionId, reason } = parsed.data;
  const mergeIds = [...new Set(parsed.data.mergeIds)].filter((id) => id !== keepId);
  if (!mergeIds.length) throw badRequest('choose at least one other person to merge into the one kept');
  const d = db();
  const keep = d.select().from(schema.people).where(and(eq(schema.people.id, keepId), isNull(schema.people.deletedAt))).get();
  if (!keep) throw notFound('the person to keep was not found');
  const merged = d.select().from(schema.people).where(and(inArray(schema.people.id, mergeIds), isNull(schema.people.deletedAt))).all();
  if (merged.length !== mergeIds.length) throw notFound('a person to merge was not found (deleted or merged already)');
  const now = nowIso();
  const detail: MergeDetail = { keepId, mergeIds, repointed: [], removedLinks: [], aliasesBefore: parseJson<string[]>(keep.aliasesJson, []), aliasesAdded: [], suggestionId: suggestionId ?? null, reason: reason ?? null };
  const filingId = newId();
  const touchedComms = new Set<string>();
  d.transaction(() => {
    // A communication that has both people keeps the kept person's link; the merged one's link is set aside (Undo puts it back).
    const parts = d.select().from(schema.communicationParticipants).where(inArray(schema.communicationParticipants.personId, mergeIds)).all();
    for (const p of parts) {
      touchedComms.add(p.communicationId);
      const hasKeep = d.select({ id: schema.communicationParticipants.id }).from(schema.communicationParticipants).where(and(eq(schema.communicationParticipants.communicationId, p.communicationId), eq(schema.communicationParticipants.personId, keepId))).get();
      if (hasKeep) {
        detail.removedLinks.push({ id: p.id, communicationId: p.communicationId, personId: p.personId, role: p.role });
        d.delete(schema.communicationParticipants).where(eq(schema.communicationParticipants.id, p.id)).run();
      } else {
        detail.repointed.push({ table: 'communication_participants', column: 'person_id', id: p.id, from: p.personId });
        d.update(schema.communicationParticipants).set({ personId: keepId }).where(eq(schema.communicationParticipants.id, p.id)).run();
      }
    }
    for (const { table, column } of PERSON_COLUMNS) {
      if (table === 'communication_participants') continue;
      const ids = d.all<{ id: string; ref: string }>(sql`select id, ${sql.identifier(column)} as ref from ${sql.identifier(table)} where ${sql.identifier(column)} in (${sql.join(mergeIds.map((x) => sql`${x}`), sql`, `)})`);
      for (const r of ids) {
        if (table === 'people' && mergeIds.includes(r.id)) continue; // a merged person's own institution link stays with it
        detail.repointed.push({ table, column, id: r.id, from: r.ref });
        d.run(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${keepId} where id = ${r.id}`);
        if (table === 'communications') touchedComms.add(r.id);
      }
    }
    const names = merged.flatMap((m) => [m.name, ...parseJson<string[]>(m.aliasesJson, [])]);
    const before = detail.aliasesBefore;
    const after = normaliseAliases([...before, ...names].filter((n) => personNameKey(n) !== personNameKey(keep.name)));
    detail.aliasesAdded = after.filter((a) => !before.includes(a));
    d.update(schema.people).set({ aliasesJson: JSON.stringify(after), updatedAt: now }).where(eq(schema.people.id, keepId)).run();
    d.update(schema.people).set({ deletedAt: now, updatedAt: now }).where(inArray(schema.people.id, mergeIds)).run();
    d.insert(schema.filings)
      .values({
        id: filingId,
        documentId: null,
        targetType: 'person',
        targetId: keepId,
        action: 'merge',
        status: 'approved',
        source: 'user',
        summary: `Merged ${merged.map((m) => m.name).join(', ')} into ${keep.name}`.slice(0, 500),
        detailJson: JSON.stringify(detail),
        askMessageId: null,
        createdAt: now,
        decidedAt: now,
        decidedBy: opts.by ?? null,
      })
      .run();
  });
  const kept = d.select().from(schema.people).where(eq(schema.people.id, keepId)).get();
  if (kept) indexPerson(kept);
  for (const id of mergeIds) removeEntityIndex('person', id);
  for (const id of touchedComms) reindexCommunication(id);
  return { filingId, keepId, mergedIds: mergeIds, repointed: countsOf(detail.repointed, detail.removedLinks), undone: false };
}

/** POST /api/people/merge/:filingId/undo: every re-pointed row goes back, the merged people come back. */
export function undoMerge(filingId: string, opts: { by?: string | null } = {}): MergeResult {
  const d = db();
  const row = d.select().from(schema.filings).where(eq(schema.filings.id, filingId)).get();
  if (!row || row.targetType !== 'person' || row.action !== 'merge') throw notFound('merge not found');
  if (row.status !== 'approved') throw conflict(`this merge is already ${row.status}`);
  const detail = parseJson<MergeDetail>(row.detailJson, { keepId: row.targetId, mergeIds: [], repointed: [], removedLinks: [], aliasesBefore: [], aliasesAdded: [], suggestionId: null, reason: null });
  const touchedComms = new Set<string>();
  const now = nowIso();
  d.transaction(() => {
    for (const r of detail.repointed) {
      if (!PERSON_COLUMNS.some((c) => c.table === r.table && c.column === r.column)) continue;
      // Only a row that still points at the kept person goes back (the user may have changed it since).
      d.run(sql`update ${sql.identifier(r.table)} set ${sql.identifier(r.column)} = ${r.from} where id = ${r.id} and ${sql.identifier(r.column)} = ${detail.keepId}`);
      if (r.table === 'communication_participants' || r.table === 'communications') {
        const commId = r.table === 'communications' ? r.id : d.select({ c: schema.communicationParticipants.communicationId }).from(schema.communicationParticipants).where(eq(schema.communicationParticipants.id, r.id)).get()?.c;
        if (commId) touchedComms.add(commId);
      }
    }
    for (const l of detail.removedLinks) {
      const exists = d.select({ id: schema.communicationParticipants.id }).from(schema.communicationParticipants).where(eq(schema.communicationParticipants.id, l.id)).get();
      if (!exists) d.insert(schema.communicationParticipants).values({ id: l.id, communicationId: l.communicationId, personId: l.personId, role: l.role }).run();
      touchedComms.add(l.communicationId);
    }
    const keep = d.select().from(schema.people).where(eq(schema.people.id, detail.keepId)).get();
    if (keep) {
      const added = new Set(detail.aliasesAdded);
      const now2 = parseJson<string[]>(keep.aliasesJson, []).filter((a) => !added.has(a));
      d.update(schema.people).set({ aliasesJson: JSON.stringify(now2), updatedAt: now }).where(eq(schema.people.id, detail.keepId)).run();
    }
    if (detail.mergeIds.length) d.update(schema.people).set({ deletedAt: null, updatedAt: now }).where(inArray(schema.people.id, detail.mergeIds)).run();
    d.update(schema.filings).set({ status: 'undone', decidedAt: now, decidedBy: opts.by ?? null }).where(eq(schema.filings.id, filingId)).run();
  });
  for (const id of [detail.keepId, ...detail.mergeIds]) {
    const p = d.select().from(schema.people).where(eq(schema.people.id, id)).get();
    if (p && !p.deletedAt) indexPerson(p);
  }
  for (const id of touchedComms) reindexCommunication(id);
  return { filingId, keepId: detail.keepId, mergedIds: detail.mergeIds, repointed: countsOf(detail.repointed, detail.removedLinks), undone: true };
}

/** POST /api/people/merge-suggestions/:id/decline: not offered again for the same people. */
export function declineMergeSuggestion(suggestionId: string, opts: { by?: string | null } = {}): void {
  const id = suggestionId.trim();
  if (!/^ms_[0-9a-f]{24}$/.test(id)) throw badRequest('not a merge suggestion id');
  const d = db();
  const exists = d.select({ id: schema.filings.id }).from(schema.filings).where(and(eq(schema.filings.targetType, 'person'), eq(schema.filings.action, DECLINE_ACTION), eq(schema.filings.targetId, id), eq(schema.filings.status, 'declined'))).get();
  if (exists) return;
  const now = nowIso();
  d.insert(schema.filings)
    .values({ id: newId(), documentId: null, targetType: 'person', targetId: id, action: DECLINE_ACTION, status: 'declined', source: 'user', summary: 'Not the same person: suggestion declined', detailJson: '{}', askMessageId: null, createdAt: now, decidedAt: now, decidedBy: opts.by ?? null })
    .run();
}

