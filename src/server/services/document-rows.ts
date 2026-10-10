/**
 * A document row by id while it is live (not soft-deleted). A leaf module (db and schema only), so the services that
 * need it do not import documents.ts (sweep 2026-10-07, DUP-3: four identical copies).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';

export type LiveDocumentRow = typeof schema.documents.$inferSelect;

/** The document as it is now, or null once it is soft-deleted (or gone). */
export function liveDocumentRow(id: string): LiveDocumentRow | null {
  return db().select().from(schema.documents).where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt))).get() ?? null;
}
