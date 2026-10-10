/**
 * The one-time re-read of every lab value (the user's lab rules, 2026-10; design §4 as amended by A1, B3, I1, I4).
 *
 * Migration 0004 added 21 nullable columns to lab_results. This fills them for the rows already on file, once, after
 * the next unlock: the text as printed (`value_raw`, `unit_raw`, `ref_raw`, `flag_raw`: provenance, written only where
 * still empty) and the parsed projection of the reading the Labs page now shows (services/lab-reading.ts
 * projectReading). Nothing else is written:
 * - never a legacy column (value_num, value_text, unit, ref_*, flag, collected_at*), never `updated_at` (a moved
 *   updated_at would make every row read as "changed by hand", labs.ts labRowEditedFrom), never `resulted_at*`
 *   (unknown for old rows: their date stays of unknown kind, nothing is inferred);
 * - never a fact, a citation or a full-text table (lab facts are read on the fly; no indexed column changes);
 * - soft-deleted rows are filled too (an Undo shows them right) but never brought back, and counted apart.
 *
 * Raw text (amendment B3): a row made from a fact takes every raw field from that fact (its first reading by the model,
 * `_aiOriginal`, when the fact was corrected on Details), never from the row's own columns, which the user may have
 * edited; a row typed by hand or imported from a CSV takes them from the row. A part row (one test of a line of several)
 * never takes the whole line's text. A row whose fact is gone keeps them empty.
 *
 * What changed is counted against the frozen pre-2026-10 reading (services/lab-legacy.ts) and kept as a report in the
 * setting `migration.labParseV1` (the Labs page's "Values re-read" dialog), one audit row (counts only, no values) and
 * the server console. `labParseBackfill({ dryRun: true })` computes the same report and writes nothing.
 *
 * Safety: the columns are checked first (a missing one is an error in the report, never a thrown error, amendment A1);
 * every write, the rows it reads and the setting are one transaction (amendment I4): on any error it rolls back, the
 * failure is kept under `migration.labParseV1.lastError` with one audit row ("failed, will retry"), and the next unlock
 * tries again. It never throws.
 */
import { asc, desc, inArray } from 'drizzle-orm';
import { db, raw, schema } from '../db';
import { nowIso, parseJson, normalizeKey } from '../util/ids';
import { writeAudit } from './audit';
import { deleteSetting, setSetting } from './settings';
import type { SettingKey, Settings } from '../../shared/constants';
import { fullReadingOf, labDocumentMeta, labRowEditedFrom, loadLabReadings, loadWholeLabEntries } from './labs';
import {
  LAB_PARSE_ERROR_SETTING,
  LAB_PARSE_RULES,
  LAB_PARSE_SETTING,
  labParseColumnsPresent,
  projectReading,
  readLabParseReport,
  readParseJson,
  readingForRow,
  rowRawSource,
  type CiteLite,
  type FactLite,
  type LabParseReport,
  type LabParseRule,
  type LabReadingRecord,
  type LabRow,
} from './lab-reading';
import { LAB_PARSE_VERSION, numbersEqual, rangeText, type LabReading } from '../../shared/labvalues';
import { SPECIMEN_LABELS, analyteLabel, normalizeAnalyte } from '../../shared/analytes';
import { labCheckDrafts } from './lab-rules';
import { legacyFactView, legacyRowView, type LegacyView } from './lab-legacy';

/** The audit action of the re-read (Settings > Users > audit log). */
export const LAB_PARSE_AUDIT_ACTION = 'labs re-read';

export type LabParseBackfillResult = LabParseReport & { ran: boolean };

type FactRow = typeof schema.facts.$inferSelect;
type Attrs = Record<string, unknown>;

function emptyReport(dryRun: boolean): LabParseReport {
  const byRule = Object.fromEntries(LAB_PARSE_RULES.map((k) => [k, 0])) as Record<LabParseRule, number>;
  return { version: LAB_PARSE_VERSION, ranAt: nowIso(), dryRun, rows: { total: 0, live: 0, deleted: 0, filled: 0, readingChanged: 0 }, facts: { total: 0, readingChanged: 0 }, byRule, examples: [], reconcile: null };
}

function strKeep(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** The fact's text as printed: its first reading by the model when it was corrected on Details, else its attributes. */
function printedAttrs(a: Attrs): Attrs {
  const o = a._userEdited ? a._aiOriginal : null;
  const at = o && typeof o === 'object' ? (o as { attributes?: unknown }).attributes : null;
  return at && typeof at === 'object' ? (at as Attrs) : a;
}

/** One test of the fact's line, not the line itself (the same reading as lab-reading.ts uses: the row's name is not the fact's). */
function isPartOf(row: Pick<LabRow, 'analyte' | 'specimen'>, a: Attrs): boolean {
  const name = typeof a.analyte === 'string' ? a.analyte : '';
  if (normalizeKey(row.analyte) === normalizeKey(name)) return false;
  return normalizeAnalyte(row.analyte, row.specimen) !== normalizeAnalyte(name, row.specimen);
}

interface RawText {
  valueRaw: string | null;
  unitRaw: string | null;
  refRaw: string | null;
  flagRaw: string | null;
  rawSource: string;
}

/**
 * The text as printed for a row (amendment B3): from its fact for a fact row, from the row for a typed or CSV row. A
 * row the Labs form made with a citation (rowRawSource: its manual detail carries LAB_FORM_NOTE) is typed: its text is
 * the user's own, never "printed". A row "Add all" copied from another manual detail is a fact row.
 */
function rawTextOf(row: LabRow, fact: FactRow | null): RawText {
  const source = rowRawSource(row, fact);
  if (source === 'typed' || source === 'csv') return { valueRaw: row.valueText, unitRaw: row.unit, refRaw: row.refText, flagRaw: row.flag, rawSource: source };
  if (!row.factId || !fact) return { valueRaw: null, unitRaw: null, refRaw: null, flagRaw: null, rawSource: row.factId ? 'row' : source };
  const a = parseJson<Attrs>(fact.attributesJson, {});
  if (isPartOf(row, a)) return { valueRaw: null, unitRaw: null, refRaw: null, flagRaw: null, rawSource: 'fact' };
  const p = printedAttrs(a);
  return { valueRaw: strKeep(p.value), unitRaw: strKeep(p.unit), refRaw: strKeep(p.ref_text), flagRaw: strKeep(p.flag_raw) ?? strKeep(p.flag), rawSource: 'fact' };
}

/** What collected_at holds for an old row: a date typed on the form ("Date taken", with or without a citation) is collected; any other is of unknown kind. */
function dateKindOf(row: LabRow, source: string): 'collected' | 'unknown' | null {
  if (!row.collectedAt && !(row.collectedAtText ?? '').trim()) return null;
  return source === 'typed' ? 'collected' : 'unknown';
}

/** The first citation of each fact, verified first (as the Labs page picks it). */
function firstCitations(factIds: string[]): Map<string, CiteLite> {
  const out = new Map<string, CiteLite>();
  const ids = [...new Set(factIds.filter(Boolean))];
  const c = schema.citations;
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db()
      .select({ id: c.id, factId: c.factId, documentId: c.documentId, pageNumber: c.pageNumber, verified: c.verified, quote: c.quote })
      .from(c)
      .where(inArray(c.factId, ids.slice(i, i + 400)))
      .orderBy(desc(c.verified), asc(c.pageNumber), asc(c.createdAt))
      .all();
    for (const r of rows) if (r.factId && !out.has(r.factId)) out.set(r.factId, { id: r.id, documentId: r.documentId, pageNumber: r.pageNumber, verified: Boolean(r.verified), quote: r.quote });
  }
  return out;
}

function factsById(ids: string[]): Map<string, FactRow> {
  const out = new Map<string, FactRow>();
  const want = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < want.length; i += 400) {
    for (const f of db().select().from(schema.facts).where(inArray(schema.facts.id, want.slice(i, i + 400))).all()) out.set(f.id, f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counting what reads differently (old view: services/lab-legacy.ts; new view: the reading)
// ---------------------------------------------------------------------------

/** The flag the Labs page marks a value with now (labs.ts entryFlag): printed, else worked out ("H~"); a document's claim none. */
function newFlag(r: LabReading): string | null {
  if (r.role === 'claimed') return null;
  if (r.flag.state === 'flag' && r.flag.printed) return r.flag.printed;
  return r.computed.flag ? `${r.computed.flag}~` : null;
}

function flagWords(f: string | null): string {
  if (!f) return 'no flag';
  return f.endsWith('~') ? `${f.slice(0, -1)} worked out from its range` : `flag ${f}`;
}

function sameNumber(a: number | null, b: number | null): boolean {
  return a == null || b == null ? a == null && b == null : numbersEqual(a, b);
}

const hasWarning = (r: LabReading, ...codes: string[]) => r.warnings.some((w) => codes.includes(w.code));

interface Counted {
  changed: boolean;
  rules: Array<{ rule: LabParseRule; before: string; after: string }>;
}

/** A test and its sample in words, never the internal keys ("hs-CRP (serum)", "CSF albumin (CSF)"). */
function listedWords(key: string, specimen: string): string {
  return `${analyteLabel(key)} (${SPECIMEN_LABELS[specimen] ?? specimen.replace(/_/g, ' ')})`;
}

/** "112, above 98-108 with no flag printed": the value against its own range, in a few words (the dialog's "now ..."). */
function flagCheckWords(r: LabReading): string {
  const dir = r.computed.flag === 'H' ? 'above' : r.computed.flag === 'L' ? 'below' : 'inside';
  const range = r.rangeShown ?? r.computed.against ?? 'its range';
  const flag = r.flag.state === 'flag' ? `marked ${(r.flag.raw ?? '').trim() || r.flag.printed}` : r.flag.state === 'no_flag_printed' ? 'with no flag printed' : r.flag.state === 'not_understood' ? `marked "${(r.flag.raw ?? '').trim()}"` : 'with no flag recorded';
  return `${r.valueShown}, ${dir} ${range}, ${flag}`;
}

/** One value, the old view against the new: which rule counters it falls under and whether it reads differently. */
function compareViews(rec: LabReadingRecord, old: LegacyView): Counted {
  const r = rec.reading;
  const rules: Counted['rules'] = [];
  // Short phrases for the dialog's "was <before>; now <after>" (never a whole warning sentence).
  const add = (rule: LabParseRule, before: string, after: string) => rules.push({ rule, before, after });
  const oldMeasured = old.measurement != null;
  if (oldMeasured && r.value.kind === 'censored') add('limitNotMeasurement', `drawn as ${old.measurement}`, `"${r.valueShown}", a limit, not a measurement`);
  if (oldMeasured && (r.value.kind === 'text' || r.value.kind === 'empty')) add('wordsNotNumber', `drawn as ${old.measurement}`, `"${r.valueShown}", words, not drawn`);
  if (hasWarning(r, 'value_read_without_symbol') && r.valueFrom === 'quote') add('quoteShowsSymbol', `"${old.shown}"`, `"${r.valueShown}", as the page prints it`);
  // A range kept as printed and not read as numbers is counted once, under rangeUnparsed (never twice).
  if ((old.range ?? '') !== (r.rangeShown ?? '') && r.range.status !== 'unparsed') add('rangeShownAsPrinted', `range ${old.range ?? 'none'}`, `range ${r.rangeShown ?? 'none printed'}`);
  if (hasWarning(r, 'range_numbers_differ')) add('rangeNumbersIgnored', `range ${old.range ?? 'none'}`, `range "${rangeText(r.range) ?? r.rangeShown ?? ''}" as printed`);
  if (r.range.status === 'unparsed') add('rangeUnparsed', `range ${old.range ?? 'none'}`, `range ${r.rangeShown ?? ''}${r.range.reason ? `: ${r.range.reason}` : ''}`);
  const nf = newFlag(r);
  if ((old.flag ?? null) !== nf) {
    // A summary's own flag (or one worked out for its value) was marked like a lab's: it is now that document's claim.
    if (r.role === 'claimed') add('flagNowClaim', flagWords(old.flag), r.flag.state === 'flag' ? `"${(r.flag.raw ?? '').trim()}", this document's own claim, never marked red` : `not marked: a summary's values are not judged`);
    else add('flagChanged', flagWords(old.flag), flagWords(nf));
  }
  if (hasWarning(r, 'flag_missing_out_of_range', 'flag_disagrees')) add('flagWarnings', flagWords(old.flag), flagCheckWords(r));
  if (hasWarning(r, 'unit_repeated')) add('unitCollapsed', `unit ${(r.unit.raw ?? '').trim()}`, `unit ${r.unit.unit ?? ''}`);
  if (old.key !== rec.analyteKey || old.specimen !== rec.specimen) add('regrouped', `listed under ${listedWords(old.key, old.specimen)}`, `listed under ${listedWords(rec.analyteKey, rec.specimen)}`);
  const date = r.dates.reading?.iso ?? null;
  if (r.dates.reading && r.dates.readingKind === 'unknown') add('dateKindUnknown', `dated ${old.date ?? 'none'}`, `dated ${date ?? 'none'}, kind not printed`);
  const componentDiffers = !sameNumber(old.measurement, r.measurement) || old.shown.trim() !== r.valueShown.trim() || (old.range ?? '') !== (r.rangeShown ?? '') || (old.flag ?? null) !== nf || old.key !== rec.analyteKey || old.specimen !== rec.specimen || (old.date ?? null) !== date;
  // A new warning shown with the value (a limit read from the page, a range or unit read otherwise, a flag check) is a change the user sees.
  const shownDiffers = rules.some((x) => x.rule !== 'dateKindUnknown' && x.rule !== 'regrouped');
  return { changed: componentDiffers || shownDiffers, rules };
}

// ---------------------------------------------------------------------------
// The audit line (counts only, never a value; at most 500 characters)
// ---------------------------------------------------------------------------

const RULE_WORDS: Array<[LabParseRule, (n: number) => string]> = [
  ['limitNotMeasurement', (n) => `${n} limit${n === 1 ? '' : 's'} such as "<3" no longer used as measurements`],
  ['wordsNotNumber', (n) => `${n} result${n === 1 ? '' : 's'} in words no longer drawn as numbers`],
  ['quoteShowsSymbol', (n) => `${n} value${n === 1 ? '' : 's'} now following the sign printed on the page`],
  ['rangeShownAsPrinted', (n) => `${n} range${n === 1 ? '' : 's'} now shown as printed, or as "upper/lower limit" where only a number was on record`],
  ['rangeNumbersIgnored', (n) => `${n} range${n === 1 ? '' : 's'} read from the printed text, not stored numbers`],
  ['rangeUnparsed', (n) => `${n} range${n === 1 ? '' : 's'} kept as printed, not read as numbers`],
  ['flagChanged', (n) => `${n} flag${n === 1 ? '' : 's'} now marked as printed by the report or worked out from the range`],
  ['flagNowClaim', (n) => `${n} flag${n === 1 ? '' : 's'} of summaries now that document's own claim, never marked red`],
  ['flagWarnings', (n) => `${n} value${n === 1 ? '' : 's'} outside the range printed with ${n === 1 ? 'it' : 'them'} with no flag printed, or with a flag that disagrees`],
  ['unitCollapsed', (n) => `${n} unit${n === 1 ? '' : 's'} printed twice shown once`],
  ['regrouped', (n) => `${n} value${n === 1 ? '' : 's'} listed under ${n === 1 ? 'its' : 'their'} own test`],
  ['sameSourceConflicts', (n) => `${n} pair${n === 1 ? '' : 's'} of values in one document that differ like a typing error, see Findings`],
  ['claimDifferences', (n) => `${n} summary judgement${n === 1 ? '' : 's'} or limit${n === 1 ? '' : 's'} that differ from the lab report, see Findings`],
];

/** The audit row's summary: how many values, how many read differently, the non-zero counters; counts only. */
export function labParseAuditSummary(report: LabParseReport): string {
  const total = report.rows.live + report.facts.total;
  const changed = report.rows.readingChanged + report.facts.readingChanged;
  const tail = ' Nothing you entered was overwritten; nothing was deleted.';
  const head = `Lab values re-read from the text as printed: ${total} value${total === 1 ? '' : 's'}, ${changed} read differently`;
  const parts = RULE_WORDS.filter(([k]) => report.byRule[k] > 0).map(([k, w]) => w(report.byRule[k]));
  for (let n = parts.length; n >= 0; n--) {
    const s = `${head}${n ? ` (${parts.slice(0, n).join('; ')}${n < parts.length ? '; and more' : ''})` : ''}.${tail}`;
    if (s.length <= 500) return s;
  }
  return `${head}.${tail}`.slice(0, 500);
}

// ---------------------------------------------------------------------------
// The re-read
// ---------------------------------------------------------------------------

const UPDATE_SQL = `UPDATE lab_results SET
  value_raw = coalesce(value_raw, ?), unit_raw = coalesce(unit_raw, ?), ref_raw = coalesce(ref_raw, ?),
  flag_raw = coalesce(flag_raw, ?), raw_source = coalesce(raw_source, ?),
  value_kind = ?, value_comparator = ?, value_parsed = ?, unit_parsed = ?, ref_status = ?,
  ref_parsed_low = ?, ref_low_comparator = ?, ref_parsed_high = ?, ref_high_comparator = ?,
  flag_computed = ?, date_kind = coalesce(date_kind, ?), parse_version = ?, parse_json = ?
WHERE id = ?`;

/** Read every value, count the changes, and (unless a dry run) write the columns. Runs inside the caller's transaction. */
function reread(report: LabParseReport, write: boolean, failAfter: number | undefined): void {
  const rows = db().select().from(schema.labResults).all();
  report.rows.total = rows.length;
  report.rows.live = rows.filter((r) => !r.deletedAt).length;
  report.rows.deleted = rows.length - report.rows.live;

  // The live values as the Labs page reads them (the one loader of the lab checks), and the checks over them (rule 12
  // also over a summary's claims the reconciliation set aside; they are not values of their own and are not counted).
  const all = loadLabReadings({ withPassSetAsideClaims: true });
  const records = all.filter((r) => !r.passSetAside);
  const checks = labCheckDrafts(all);
  report.byRule.sameSourceConflicts = checks.conflicts.length;
  report.byRule.claimDifferences = checks.claims.length;
  const conflictsOf = new Map<string, unknown[]>();
  for (const c of checks.conflicts) {
    for (const [mine, other] of [
      [c.a, c.b],
      [c.b, c.a],
    ] as const) {
      if (!mine.labResultId) continue;
      const list = conflictsOf.get(mine.labResultId) ?? [];
      list.push({ kind: c.kind, otherId: other.labResultId ?? (other.factId ? `fact:${other.factId}` : other.id), otherValue: other.reading.valueShown, page: mine.pageNumber, otherPage: other.pageNumber });
      conflictsOf.set(mine.labResultId, list);
    }
  }

  // Each row's reading: the Labs page's own for a row it lists; read the same way for one it does not (deleted, on a
  // deleted document).
  const entryOf = new Map<string, LabReading>();
  const editedOf = new Map<string, string | null>();
  for (const e of loadWholeLabEntries()) {
    if (e.source !== 'row' || !e.labResultId) continue;
    const r = fullReadingOf(e);
    if (r) entryOf.set(e.labResultId, r);
    editedOf.set(e.labResultId, e.editedFrom);
  }
  const facts = factsById([...rows.map((r) => r.factId ?? ''), ...records.map((r) => r.factId ?? '')]);
  const cites = firstCitations(rows.map((r) => r.factId ?? ''));
  const docs = labDocumentMeta([...rows.map((r) => r.documentId), ...[...cites.values()].map((c) => c.documentId)]);
  const stmt = write ? raw().prepare(UPDATE_SQL) : null;
  let written = 0;
  for (const row of rows) {
    // A row a 2026-10 writer already projected (hand entry, Add all, CSV, the seed) keeps its columns and parse_json.
    if (row.parseVersion === LAB_PARSE_VERSION) continue;
    const fact = row.factId ? (facts.get(row.factId) ?? null) : null;
    let reading = entryOf.get(row.id) ?? null;
    let editedFrom = editedOf.get(row.id) ?? null;
    if (!reading) {
      const live = fact && !fact.deletedAt ? fact : null;
      editedFrom = live ? labRowEditedFrom(row, live) : null;
      const cite = live ? cites.get(live.id) : undefined;
      const documentId = row.documentId ?? cite?.documentId ?? null;
      const samePage = Boolean(cite && cite.documentId === documentId);
      const meta = documentId ? docs.get(documentId) : undefined;
      const lite: FactLite | null = live ? { id: live.id, attributesJson: live.attributesJson, date: live.date, datePrecision: live.datePrecision, dateText: live.dateText, status: live.status, sourceDocumentId: live.sourceDocumentId, origin: live.origin, verdictNote: live.verdictNote } : null;
      reading = readingForRow(row, { fact: lite, editedFrom, cite: samePage ? cite! : null, documentTier: meta?.tier ?? null, documentDate: meta?.date ?? null, hasDocument: Boolean(documentId) });
    }
    const rawText = rawTextOf(row, fact);
    const userFields = readParseJson(row.parseJson)?.userFields;
    const byUser = Boolean(editedFrom) || rawText.rawSource === 'typed' || Boolean(userFields?.length);
    const cols = projectReading(reading, {
      rawSource: rawText.rawSource,
      parsedFrom: byUser ? 'user' : 'raw',
      rawFrom: rawText.rawSource === 'fact' && fact ? { factId: fact.id, citationId: cites.get(fact.id)?.id ?? null } : null,
      dateKind: dateKindOf(row, rawText.rawSource),
      previous: row.parseJson,
      conflicts: conflictsOf.get(row.id),
    });
    report.rows.filled++;
    if (!stmt) continue;
    if (failAfter != null && written >= failAfter) throw new Error(`stopped after ${failAfter} rows (test)`);
    stmt.run(
      rawText.valueRaw,
      rawText.unitRaw,
      rawText.refRaw,
      rawText.flagRaw,
      rawText.rawSource,
      cols.valueKind ?? null,
      cols.valueComparator ?? null,
      cols.valueParsed ?? null,
      cols.unitParsed ?? null,
      cols.refStatus ?? null,
      cols.refParsedLow ?? null,
      cols.refLowComparator ?? null,
      cols.refParsedHigh ?? null,
      cols.refHighComparator ?? null,
      cols.flagComputed ?? null,
      dateKindOf(row, rawText.rawSource),
      LAB_PARSE_VERSION,
      cols.parseJson ?? null,
      row.id,
    );
    written++;
  }

  // What reads differently, value by value (live values only; a line of several tests is one value here).
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const examples = new Map<LabParseRule, LabParseReport['examples']>();
  for (const rec of records) {
    const isRow = rec.source === 'row' && rec.labResultId;
    const row = isRow ? rowById.get(rec.labResultId!) : undefined;
    const fact = !isRow && rec.factId ? facts.get(rec.factId) : undefined;
    if (isRow && !row) continue;
    if (!isRow && !fact) continue;
    const old = row ? legacyRowView(row) : legacyFactView(fact!);
    const counted = compareViews(rec, old);
    if (isRow) report.rows.readingChanged += counted.changed ? 1 : 0;
    else {
      report.facts.total++;
      report.facts.readingChanged += counted.changed ? 1 : 0;
    }
    for (const x of counted.rules) {
      report.byRule[x.rule]++;
      if (x.rule === 'dateKindUnknown') continue;
      const list = examples.get(x.rule) ?? [];
      // The test, its date and its document, so two values of one test on one day are told apart.
      const test = `${rec.analyte}${rec.reading.dates.reading?.iso ? ` on ${rec.reading.dates.reading.iso}` : ''}${rec.documentTitle ? `, ${rec.documentTitle}` : ''}`;
      if (list.length < 20) list.push({ entryId: rec.id, test, rule: x.rule, before: x.before, after: x.after });
      examples.set(x.rule, list);
    }
  }
  // Up to 20 examples, taking turns across the rules so the dialog shows each kind of change.
  const lists = [...examples.values()];
  for (let i = 0; report.examples.length < 20 && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && report.examples.length < 20) report.examples.push(l[i]);
  }
}

/** Keep a failure visible (amendment I4): the last error under its own setting, one audit row without values. */
function recordFailure(message: string): void {
  try {
    setSetting(LAB_PARSE_ERROR_SETTING as SettingKey, { at: nowIso(), error: message.slice(0, 500) } as unknown as Settings[SettingKey]);
  } catch {
    // the setting itself could not be written: the console line below still says it
  }
  writeAudit({ action: LAB_PARSE_AUDIT_ACTION, entityType: 'lab_results', summary: 'Lab values re-read from the text as printed: failed; it will try again at the next unlock. Nothing was changed.' });
}

/**
 * The one-time re-read (see the file header). Returns its report and whether it ran: a real run that already happened
 * at this parse version returns the stored report with `ran: false`. Never throws.
 */
export function labParseBackfill(opts: { dryRun?: boolean; failAfter?: number } = {}): LabParseBackfillResult {
  const dryRun = Boolean(opts.dryRun);
  const report = emptyReport(dryRun);
  try {
    const cols = labParseColumnsPresent();
    if (!cols.ok) {
      report.error = `the lab value columns of migration 0004 are missing (${cols.missing.join(', ')})`;
      if (!dryRun) recordFailure(report.error);
      console.warn(`[labs] values re-read: ${report.error}`);
      return { ...report, ran: false };
    }
    if (!dryRun) {
      const done = readLabParseReport();
      if (done && done.version === LAB_PARSE_VERSION) return { ...done, ran: false };
    }
    db().transaction(() => {
      reread(report, !dryRun, opts.failAfter);
      if (!dryRun) {
        setSetting(LAB_PARSE_SETTING as SettingKey, report as unknown as Settings[SettingKey]);
        deleteSetting(LAB_PARSE_ERROR_SETTING as SettingKey);
      }
    });
  } catch (err) {
    // Rolled back: no column, no setting was kept.
    const message = err instanceof Error ? err.message : String(err);
    if (!dryRun) recordFailure(message);
    console.warn(`[labs] values re-read failed (it runs again on the next unlock): ${message}`);
    const failed = emptyReport(dryRun);
    return { ...failed, error: message, ran: false };
  }
  if (!dryRun) {
    const summary = labParseAuditSummary(report);
    writeAudit({ action: LAB_PARSE_AUDIT_ACTION, entityType: 'lab_results', summary });
    console.log(`[labs] ${summary}`);
  }
  return { ...report, ran: true };
}

/**
 * The first reconciliation after the re-read (amendment I1): what it put back, set aside, and no longer compared (a
 * value that gives only a limit against a lab report's measurement inside it; reconcile.ts notCompared) is added to the
 * re-read's report once (the next passes change nothing there), with one audit row (counts only).
 * Returns whether it was recorded. Never throws.
 */
export function recordReconcileAfterReread(r: { undone: number; copies: number; conflicts: number; notCompared?: number } | null | undefined): boolean {
  if (!r) return false;
  try {
    const report = readLabParseReport();
    if (!report || report.dryRun || report.version !== LAB_PARSE_VERSION || report.reconcile) return false;
    const reconcile = { undone: r.undone, setAside: r.copies + r.conflicts, notCompared: r.notCompared ?? 0 };
    setSetting(LAB_PARSE_SETTING as SettingKey, { ...report, reconcile } as unknown as Settings[SettingKey]);
    writeAudit({
      action: LAB_PARSE_AUDIT_ACTION,
      entityType: 'facts',
      summary: `After the lab values were re-read, the first reconciliation put back ${reconcile.undone} value${reconcile.undone === 1 ? '' : 's'}, set aside ${reconcile.setAside} as copies of or different from a lab report, and no longer compared ${reconcile.notCompared} that give only a limit against a lab report's measurement inside it.`,
    });
    return true;
  } catch (err) {
    console.warn(`[labs] could not record the reconciliation after the re-read: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
