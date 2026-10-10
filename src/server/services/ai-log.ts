/** The AI log (GET /api/ai/calls): the newest calls first, with the token and cost totals. */
import { desc, sql } from 'drizzle-orm';
import { db, schema } from '../db';

export type AiCallRow = typeof schema.aiCalls.$inferSelect;

export interface AiCallTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
}

export interface AiCallList {
  items: AiCallRow[];
  totals: AiCallTotals;
}

/**
 * `limit` rows, newest first. With `documentId`, only the calls that read that document (its id is in the call's
 * `document_ids_json`), and the totals cover those calls; without it the totals cover every call.
 */
export function listAiCalls(opts: { limit: number; documentId?: string }): AiCallList {
  const where = opts.documentId
    ? sql`json_valid(${schema.aiCalls.documentIdsJson}) and exists (select 1 from json_each(${schema.aiCalls.documentIdsJson}) j where j.value = ${opts.documentId})`
    : undefined;
  const items = db().select().from(schema.aiCalls).where(where).orderBy(desc(schema.aiCalls.createdAt)).limit(opts.limit).all();
  const totals = db()
    .select({
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(input_tokens),0)`,
      outputTokens: sql<number>`coalesce(sum(output_tokens),0)`,
      cacheReadTokens: sql<number>`coalesce(sum(cache_read_tokens),0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(cache_write_tokens),0)`,
      estimatedUsd: sql<number>`coalesce(sum(estimated_usd),0)`,
    })
    .from(schema.aiCalls)
    .where(where)
    .get()!;
  return { items, totals };
}
