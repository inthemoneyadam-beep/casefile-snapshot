/**
 * One-time repair (2026-10-07 review, rev-comms #1): dates written as a numeric day followed by a time, the way Epic
 * prints a result or a note ("07/14/30 2215", "7/14/2030 1745", "07/14/2030 22:15"), were read before this fix as a
 * bare year ("2045" from "07/14/30 2045", "2030") or as nothing. The day they name is now read (src/shared/dates.ts).
 *
 * This pass re-reads, once, the stored dates whose text as written is such a stamp and whose stored reading is a year
 * or nothing: only the derived columns (the ISO date and its precision) change, and only to the day the text names.
 * The text as written is never touched; no row is added or removed; nothing else in the row changes. Settled by the
 * setting `migration.stampDatesV1` (a failure leaves it unset, so the next unlock tries again).
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { parsePartialDate } from '../../shared/dates';
import { getSetting, setSetting } from './settings';
import type { SettingKey } from '../../shared/constants';

export const STAMP_DATES_SETTING = 'migration.stampDatesV1';

/** (table, ISO column, precision column, text column) holding a partial date read from its text. */
const TARGETS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['facts', 'date', 'date_precision', 'date_text'],
  ['lab_results', 'collected_at', 'collected_at_precision', 'collected_at_text'],
  ['lab_results', 'resulted_at', 'resulted_at_precision', 'resulted_at_text'],
  ['imaging_studies', 'performed_at', 'performed_at_precision', 'performed_at_text'],
  ['documents', 'document_date', 'document_date_precision', 'document_date_text'],
  ['document_segments', 'encounter_date', 'encounter_date_precision', 'encounter_date_text'],
  ['communications', 'occurred_at', 'occurred_at_precision', 'occurred_at_text'],
  ['encounters', 'occurred_at', 'occurred_at_precision', 'occurred_at_text'],
  ['records_inventory', 'record_date', 'record_date_precision', 'record_date_text'],
  ['medications', 'start_date', 'start_date_precision', 'start_date_text'],
  ['medications', 'stop_date', 'stop_date_precision', 'stop_date_text'],
  ['medication_events', 'date', 'date_precision', 'date_text'],
  ['intolerances', 'date', 'date_precision', 'date_text'],
];

/** A numeric day followed by something that starts with a digit (the time). */
const STAMP_TEXT = /\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})[\sT,]+\d/;

export interface StampDatesResult {
  /** Rows whose date now reads as the day its text names, per "table.column". */
  repaired: Record<string, number>;
  total: number;
}

/**
 * Re-reads the stamp dates once (see the module comment). `force` runs it even when the setting says it ran; `dryRun`
 * counts and writes nothing. Never throws for one table: a table that cannot be read is skipped and logged.
 */
export function repairStampDates(opts: { force?: boolean; dryRun?: boolean } = {}): StampDatesResult | null {
  if (!opts.force && getSetting(STAMP_DATES_SETTING as SettingKey) === true) return null;
  const out: StampDatesResult = { repaired: {}, total: 0 };
  const d = db();
  for (const [table, iso, prec, text] of TARGETS) {
    let rows: Array<{ id: string; iso: string | null; prec: string | null; text: string }>;
    try {
      rows = d.all(sql.raw(
        `select id, ${iso} as iso, ${prec} as prec, ${text} as text from ${table} ` +
          `where ${text} is not null and ${text} like '%/%' and (${prec} is null or ${prec} in ('year', 'unknown'))`,
      ));
    } catch (err) {
      console.warn(`[dates] could not read ${table}.${iso}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let n = 0;
    for (const r of rows) {
      if (!STAMP_TEXT.test(r.text)) continue;
      const pd = parsePartialDate(r.text);
      if (pd.precision !== 'day' || !pd.iso || pd.iso === r.iso) continue;
      n++;
      if (!opts.dryRun) d.run(sql`update ${sql.raw(table)} set ${sql.raw(iso)} = ${pd.iso}, ${sql.raw(prec)} = 'day' where id = ${r.id}`);
    }
    if (n) out.repaired[`${table}.${iso}`] = n;
    out.total += n;
  }
  if (!opts.dryRun) setSetting(STAMP_DATES_SETTING as SettingKey, true as never);
  return out;
}
