/**
 * The wrong-patient guard's state on a document (2026-10-09), in a leaf module (db, schema and shared code only) so the
 * documents service, the purge and the job pipeline can read it without importing the guard itself.
 *
 * A document held back as "May be someone else's record" is soft-deleted (deleted_at set, its details soft-deleted with
 * the same stamp, its pages out of search) with `metadata_json.patientCheck.state = 'quarantined'`. Every query that
 * hides a deleted document's details already hides a held one's: that IS the central filter (CLAUDE.md, the lead's C6),
 * so no page needs a filter of its own. Only the few places that list deleted documents tell the two apart: the trash
 * leaves held documents out, the Documents page and Check before filing show them, and purge refuses them.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nowIso, parseJson } from '../util/ids';
import { readPatientCheck, type PatientCheck } from '../../shared/patient-identity';

/** SQL: the document is held back as "May be someone else's record" (deleted until the user decides). */
export const QUARANTINED_SQL = sql`(${schema.documents.deletedAt} is not null and instr(${schema.documents.metadataJson}, '"patientCheck"') > 0 and json_valid(${schema.documents.metadataJson}) and json_extract(${schema.documents.metadataJson}, '$.patientCheck.state') = 'quarantined')`;

/** SQL: not held back (a live document, or one in the trash). */
export const NOT_QUARANTINED_SQL = sql`not ${QUARANTINED_SQL}`;

type Row = Pick<typeof schema.documents.$inferSelect, 'deletedAt' | 'metadataJson'>;

/** The guard's record on a document row, or null. */
export function patientCheckOfRow(row: Pick<Row, 'metadataJson'>): PatientCheck | null {
  if (!row.metadataJson || !row.metadataJson.includes('"patientCheck"')) return null;
  return readPatientCheck(parseJson<Record<string, unknown>>(row.metadataJson, {}));
}

/** 'quarantined' while held back, 'not_mine' once the user said "Not my record" (in the trash), else null. */
export function heldState(row: Row): 'quarantined' | 'not_mine' | null {
  if (!row.deletedAt) return null;
  const c = patientCheckOfRow(row);
  return c?.state === 'quarantined' ? 'quarantined' : c?.state === 'not_mine' ? 'not_mine' : null;
}

/** Of these ids, the ones held back. */
export function quarantinedIds(ids: readonly string[]): Set<string> {
  if (!ids.length) return new Set();
  return new Set(
    db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, [...ids]), QUARANTINED_SQL))
      .all()
      .map((r) => r.id),
  );
}

/** How many documents are held back. */
export function quarantinedCount(): number {
  return Number(db().select({ n: sql<number>`count(*)` }).from(schema.documents).where(QUARANTINED_SQL).get()?.n ?? 0);
}

/**
 * Writes `metadata_json.patientCheck` (and, with `extra`, other top-level keys; undefined removes one), merging into the
 * row as it is now in one transaction.
 */
export function writePatientCheck(id: string, check: PatientCheck, extra: Record<string, unknown> = {}): void {
  db().transaction((tx) => {
    const row = tx.select({ metadataJson: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, id)).get();
    if (!row) return;
    const meta = parseJson<Record<string, unknown>>(row.metadataJson, {});
    meta.patientCheck = check;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete meta[k];
      else meta[k] = v;
    }
    tx.update(schema.documents).set({ metadataJson: JSON.stringify(meta), updatedAt: nowIso() }).where(eq(schema.documents.id, id)).run();
  });
}

/**
 * "Not my record" restored from the trash (Restore, Undo): back as "May be someone else's record", still hidden,
 * never trusted (the lead's C7). The soft-delete stamp is kept, so "It's mine" later brings back exactly the details
 * that went with it. Returns false when the document is not a "Not my record" one.
 */
export function requarantine(id: string): boolean {
  const row = db().select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!row || heldState(row) !== 'not_mine') return false;
  const c = patientCheckOfRow(row)!;
  const at = nowIso();
  writePatientCheck(
    id,
    { ...c, state: 'quarantined', decision: null, quarantine: { at, by: 'user', pages: c.conflictPages.slice(0, 5000), resume: c.quarantine?.resume ?? { sort: false, read: false } } },
    { deleteReason: undefined },
  );
  return true;
}
