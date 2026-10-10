/**
 * The lab check (2026-10-08): a lab reading had been missed and could not be added back, and very long
 * documents may miss more.
 *
 * 1. The check (no AI). After every reading pass, and once at unlock for documents already read, every page the model
 *    has read (coverage `done`) is read by the app's own row finder (services/lab-check-rows.ts); each lab row found is
 *    compared with the lab details of the document: the same test (exact analyte keys) and the same value
 *    (labValueIdentity), on that page; or a detail whose quote on that page is the row; or the same result printed again
 *    elsewhere in the document (same test, value and printed day); or, on that page, the one detail left with that value
 *    under another name. A row no detail holds is MISSED. A detail the user deleted holds its row too ("deleted by you"):
 *    a value he took out is never put back. The result is `metadata_json.coverage.labCheck` (this module is its only
 *    writer) and per part `document_segments.detail_json.labCheck` (counts).
 * 2. Misses are read again ONCE: the pages with misses only (settled parts too), with a hint naming each row that must
 *    become a lab_result fact, under `ai.autoResumeCeilingUsd` (an extract_facts job, scope pages, reason labcheck).
 *    The check runs again when that reading ends. A row still missed after it (or at once, when Claude is off, no key
 *    is stored, or the estimate is above the ceiling) is ADDED FROM THE PAGE: a lab_result fact with origin `parsed`,
 *    the values exactly as printed (the user's lab rules), the page's printed dates and lab, the document's tier for the
 *    passage (effectiveTier), a verified citation of the row, "Added by the lab check from p.N." in its statement and
 *    `_labCheck` in its attributes. Never a second copy: a detail already holding the same result gets the citation.
 *    2026-10-09 (lab recall: a printed index value was still missing from its test): a document with many lines missed is no
 *    longer left alone. The re-read runs in small calls (at most 6 pages, at most 60 named lines each), priced from those
 *    pages' own characters and the expected output for the lines named; above the limit Claude asks ONCE (the
 *    document's reading question, coverage.resume kind labcheck), never adds by itself while asking. A page whose
 *    lines fail the sanity test (pageSanity: most not found on the page word for word, or a reference or trend table)
 *    is never added from by itself: it is listed with the reason (`heldBack`).
 * 3. The clinician (and the screens) add a value from a page on request: `addLabValueFromPage` (the user asked in his
 *    message) or `proposeLabValueFromPage` + `approveLabValueProposal` (a filings row, one press). `undoLabValueFromPage`
 *    takes one back (and it is never added again).
 * User work is never touched: nothing here edits, retires or re-dates an existing detail; a detail that is confirmed,
 * disputed, edited or noted only ever stands as the holder of its row.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { enqueueJob, enqueueRulesAfterIngest } from '../jobs/queue';
import { aiEnabled, getApiKey } from '../ai/client';
import { isVerifiedMatch, locateQuote } from '../ai/citations';
import { readLabRows, type FoundLabRow, type LabTableCarry } from './lab-check-rows';
import { insertFact, insertVerifiedCitation } from './facts';
import { coverageSummary, listSegments, patchCoverageMeta, readCoverage, updateSegment, type SegmentRow } from './segments';
import { readLabValues } from './labs';
import { getSetting, setSetting } from './settings';
import { reconcileQuietly } from './reconcile';
import { runLabChecks } from './lab-rules';
import { rebuildDocumentBrief } from './documents';
import { liveDocumentRow } from './document-rows';
import { removeFactIndex } from './search';
import { hasUserWork } from './fact-holds';
import { AUTO_CLEARED_PREFIX, clearUnjudgedRuleFindingsOfFact } from './findings';
import { localDayOf } from '../util/localtime';
import { visualPageText } from '../ingest/reflow';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, normalizeKey, nowIso, parseJson } from '../util/ids';
import { log } from '../util/log';
import { defaultSpecimenFor, normalizeAnalyte } from '../../shared/analytes';
import { labValueIdentity, parseFlag, parseLabValue, parseRefRange, parseUnit } from '../../shared/labvalues';
import { parsePartialDate } from '../../shared/dates';
import { coerceAssertedBy, validateAttributes } from '../../shared/schemas/facts';
import { effectiveTier, SEGMENT_ATTRIBUTE_KEY } from '../../shared/trust';
import { parseSegmentDetail, routeOf, type FactSegmentRef } from '../../shared/schemas/segments';
import {
  LAB_CHECK_ATTRIBUTE, LAB_CHECK_ORIGIN, LAB_CHECK_VERSION, labCheckMarkOf, labCheckReport, pagesWords, parseLabCheckReport,
  type LabCheckAdded, type LabCheckMark, type LabCheckReport, type LabCheckRowRef, type LabCheckTrigger,
} from '../../shared/labcheck';
import { LAB_ROWS_VERSION } from './lab-check-rows';
import type { Settings, SettingKey } from '../../shared/constants';

/** The one-time check of every document already read (at unlock): holds the version that ran, so a newer one runs again. */
export const LAB_CHECK_SETTING = 'migration.labCheckV1';
/** The version of the whole check (report shape, row finder and matching). */
export const LAB_CHECK_FULL_VERSION = LAB_CHECK_VERSION * 1000 + LAB_ROWS_VERSION;
/** The filings target of a lab value the clinician proposed to add from a page. */
export const LAB_VALUE_TARGET = 'lab_value';
export const LAB_VALUE_ACTION = 'add_from_page';

const MAX_LISTED = 200;
const MAX_REREAD_KEYS = 5000;
/** Lines a re-read job carries in its payload; more are worked out again when it runs (labHintFor). */
const MAX_PAYLOAD_HINT = 400;

// ---------------------------------------------------------------------------
// Pages, rows, holders
// ---------------------------------------------------------------------------

/** The pages of a document the model has read (coverage state `done`). */
export function readPagesOf(documentId: string): Set<number> {
  const out = new Set<number>();
  const cov = listSegments(documentId).length ? coverageSummary(documentId) : readCoverage(documentId);
  if (!cov) return out;
  for (const [a, b, state] of cov.ranges) if (state === 'done') for (let p = a; p <= b; p++) out.add(p);
  return out;
}

const PAGE_BATCH = 150;

/**
 * The lab rows printed on a document's pages (only `pages` when given), in page order, a table left open at the bottom
 * of a page carried on to the next. Pages are loaded in batches (an export of 1,840 pages is never held at once).
 */
export function documentLabRows(documentId: string, pages?: ReadonlySet<number> | null): FoundLabRow[] {
  const P = schema.documentPages;
  const nums = db()
    .select({ n: P.pageNumber })
    .from(P)
    .where(eq(P.documentId, documentId))
    .orderBy(asc(P.pageNumber))
    .all()
    .map((r) => r.n);
  const out: FoundLabRow[] = [];
  let carry: LabTableCarry | null = null;
  for (let i = 0; i < nums.length; i += PAGE_BATCH) {
    const slice = nums.slice(i, i + PAGE_BATCH);
    // A page is read when it is wanted or the page after it is (a table may carry on from it).
    const want = pages ? slice.filter((n) => pages.has(n) || pages.has(n + 1)) : slice;
    if (!want.length) {
      carry = null;
      continue;
    }
    const rows = db()
      .select({ pageNumber: P.pageNumber, text: P.text, boxesJson: P.boxesJson })
      .from(P)
      .where(and(eq(P.documentId, documentId), inArray(P.pageNumber, want)))
      .orderBy(asc(P.pageNumber))
      .all();
    for (const p of rows) {
      const r = readLabRows({ pageNumber: p.pageNumber, text: p.text, boxesJson: p.boxesJson }, carry);
      carry = r.carry;
      if (!pages || pages.has(p.pageNumber)) out.push(...r.rows);
    }
  }
  return out;
}

/** A lab detail that may hold rows: what it says (every key and value it can be read as), where it is cited, when. */
interface Holder {
  id: string;
  live: boolean;
  /** Deleted by the user (never added back). */
  userDeleted: boolean;
  keys: Set<string>;
  ids: Set<string>;
  units: Set<string>;
  days: Set<string>;
  /** page -> quotes of it cited on that page. */
  quotes: Map<number, string[]>;
  origin: string;
  status: string;
  userWork: boolean;
  createdAt: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** A day (YYYY-MM-DD) a date as printed or stored reads as, or null when it is not a whole day. */
function dayOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const d = parsePartialDate(text);
  return d.iso && d.precision === 'day' ? d.iso.slice(0, 10) : null;
}

/** What a lab detail's attributes can be read as: each test it holds (a line of several is read apart) and its value. */
function readHolderAttrs(a: Record<string, unknown>, h: Pick<Holder, 'keys' | 'ids' | 'units' | 'days'>): void {
  const analyte = str(a.analyte);
  if (!analyte) return;
  const stated = str(a.specimen);
  let parts: ReturnType<typeof readLabValues>;
  try {
    parts = readLabValues({
      analyte,
      specimen: stated ?? defaultSpecimenFor(analyte),
      specimenAssumed: !stated,
      valueText: typeof a.value === 'string' ? a.value : null,
      // The value as written only (the one accessor's rule: a stored number is never read as the value here).
      valueNum: null,
      unit: str(a.unit),
      flag: null,
      refLow: null,
      refHigh: null,
      refText: null,
    });
  } catch {
    return;
  }
  for (const p of parts) {
    if (p.analyteKey) h.keys.add(p.analyteKey);
    const alone = normalizeAnalyte(p.analyte, null);
    if (alone) h.keys.add(alone);
    const vt = p.valueText ?? (p.valueNum != null ? String(p.valueNum) : '');
    const id = labValueIdentity(parseLabValue(vt));
    if (id) h.ids.add(id);
    const uk = parseUnit(p.unit).key;
    if (uk) h.units.add(uk);
  }
  for (const k of ['collected_date', 'resulted_date']) {
    const d = dayOf(str(a[k]));
    if (d) h.days.add(d);
  }
}

/** Every lab detail of the document or cited in it, live or deleted, with what it can be read as. */
function loadHolders(documentId: string): Holder[] {
  const rows = db().all<{
    id: string; status: string; origin: string; attributesJson: string; date: string | null; deletedAt: string | null; verdictNote: string | null; verdictBasis: string | null; createdAt: string;
    page: number | null; quote: string | null;
  }>(sql`
    select f.id, f.status, f.origin, f.attributes_json as attributesJson, f.date, f.deleted_at as deletedAt, f.verdict_note as verdictNote,
           f.verdict_basis as verdictBasis, f.created_at as createdAt, c.page_number as page, c.quote
    from facts f left join citations c on c.fact_id = f.id and c.document_id = ${documentId}
    where f.type = 'lab_result' and (f.source_document_id = ${documentId} or c.id is not null)`);
  if (!rows.length) return [];
  // An automatic re-read retires details inside its run; a detail deleted outside every run of the document was the user's.
  const runs = db().all<{ startedAt: string; finishedAt: string | null }>(sql`select started_at as startedAt, finished_at as finishedAt from extraction_runs where document_id = ${documentId}`);
  const inRun = (at: string) => runs.some((r) => at >= r.startedAt && at <= (r.finishedAt ?? '9999') + '￿');
  const byId = new Map<string, Holder>();
  for (const r of rows) {
    let h = byId.get(r.id);
    if (!h) {
      const attrs = parseJson<Record<string, unknown>>(r.attributesJson, {});
      const userDeleted = Boolean(r.deletedAt) && (attrs._deletedBy === 'user' || !inRun(r.deletedAt!));
      h = {
        id: r.id,
        live: !r.deletedAt,
        userDeleted,
        keys: new Set(),
        ids: new Set(),
        units: new Set(),
        days: new Set(),
        quotes: new Map(),
        origin: r.origin,
        status: r.status,
        userWork: hasUserWork(r, attrs),
        createdAt: r.createdAt,
      };
      readHolderAttrs(attrs, h);
      const orig = attrs._aiOriginal as { attributes?: unknown } | undefined;
      if (orig?.attributes && typeof orig.attributes === 'object') readHolderAttrs(orig.attributes as Record<string, unknown>, h);
      const d = dayOf(r.date);
      if (d) h.days.add(d);
      byId.set(r.id, h);
    }
    if (r.page != null) {
      const list = h.quotes.get(r.page) ?? [];
      if (r.quote) list.push(r.quote);
      h.quotes.set(r.page, list);
    }
  }
  // Retired by a reading (not the user's) and not live: they hold nothing.
  return [...byId.values()].filter((h) => h.live || h.userDeleted);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A row's place in the check: page, test (its first key) and value identity. */
export function rowKey(r: Pick<FoundLabRow, 'page' | 'keys' | 'parsed'>): string {
  return `${r.page}|${r.keys[0] ?? ''}|${labValueIdentity(r.parsed)}`;
}

function rowDays(r: FoundLabRow): string[] {
  return [r.dates.collected, r.dates.resulted, r.dates.unknown].map(dayOf).filter((d): d is string => Boolean(d));
}

export type RowFate = { kind: 'held'; holderId: string; how: 'page' | 'quote' | 'printed_again' | 'renamed' } | { kind: 'deleted_by_you'; holderId: string } | { kind: 'missed' };

/** Which detail holds each row (see the module comment), in the rows' order. Pure over its inputs. */
function matchRows(rows: readonly FoundLabRow[], holders: readonly Holder[]): RowFate[] {
  const onPage = new Map<number, Holder[]>();
  for (const h of holders) for (const p of h.quotes.keys()) (onPage.get(p) ?? onPage.set(p, []).get(p)!).push(h);
  const fates: RowFate[] = rows.map(() => ({ kind: 'missed' }));
  const pick = (cands: Holder[]): Holder | null => cands.find((h) => h.live) ?? cands[0] ?? null;
  const settle = (i: number, h: Holder, how: 'page' | 'quote' | 'printed_again' | 'renamed') => {
    fates[i] = h.live ? { kind: 'held', holderId: h.id, how } : { kind: 'deleted_by_you', holderId: h.id };
  };
  const ids = rows.map((r) => labValueIdentity(r.parsed));
  // 1. The same test and value, cited on the row's page.
  rows.forEach((r, i) => {
    const h = pick((onPage.get(r.page) ?? []).filter((x) => x.ids.has(ids[i]) && r.keys.some((k) => x.keys.has(k))));
    if (h) settle(i, h, 'page');
  });
  // 2. A detail whose quote on that page is the row (the model gave the test another name).
  rows.forEach((r, i) => {
    if (fates[i].kind !== 'missed') return;
    const name = normalizeKey(r.analyte);
    if (name.length < 2) return;
    const h = pick((onPage.get(r.page) ?? []).filter((x) => x.ids.has(ids[i]) && (x.quotes.get(r.page) ?? []).some((q) => normalizeKey(q).includes(name))));
    if (h) settle(i, h, 'quote');
  });
  // 3. The same result printed again elsewhere in the document: same test (by key, or by a quote that names it as the
  // row does), value and printed day.
  rows.forEach((r, i) => {
    if (fates[i].kind !== 'missed') return;
    const days = rowDays(r);
    if (!days.length) return;
    const name = normalizeKey(r.analyte);
    const namesIt = (x: Holder) => r.keys.some((k) => x.keys.has(k)) || (name.length >= 2 && [...x.quotes.values()].some((qs) => qs.some((q) => normalizeKey(q).includes(name))));
    const h = pick(holders.filter((x) => x.ids.has(ids[i]) && days.some((d) => x.days.has(d)) && namesIt(x)));
    if (h) settle(i, h, 'printed_again');
  });
  // 4. On that page, the one detail left with that value (and a unit that does not differ), claimed by no other row.
  const claimed = new Set<string>();
  fates.forEach((f) => {
    if (f.kind !== 'missed') claimed.add(f.holderId);
  });
  const left = rows.map((r, i) => (fates[i].kind === 'missed' ? i : -1)).filter((i) => i >= 0);
  const candidatesOf = (i: number): Holder[] => {
    const r = rows[i];
    const uk = parseUnit(r.unit).key;
    return (onPage.get(r.page) ?? []).filter((x) => !claimed.has(x.id) && x.ids.has(ids[i]) && (!uk || !x.units.size || x.units.has(uk)));
  };
  for (const i of left) {
    const cands = candidatesOf(i);
    if (cands.length !== 1) continue;
    const h = cands[0];
    // The holder must not be the only candidate of another row left on the page too (then neither is sure).
    const rivals = left.filter((j) => j !== i && fates[j].kind === 'missed' && rows[j].page === rows[i].page && candidatesOf(j).some((x) => x.id === h.id));
    if (rivals.length) continue;
    settle(i, h, 'renamed');
    claimed.add(h.id);
  }
  return fates;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export function readLabCheck(documentId: string): LabCheckReport | null {
  return readCoverage(documentId)?.labCheck ?? parseLabCheckReport((parseJson<Record<string, unknown>>(db().select({ m: schema.documents.metadataJson }).from(schema.documents).where(eq(schema.documents.id, documentId)).get()?.m, {}).coverage as Record<string, unknown> | undefined)?.labCheck);
}

function writeLabCheck(documentId: string, report: LabCheckReport): LabCheckReport | null {
  const valid = labCheckReport.safeParse(report);
  if (!valid.success) {
    log.warn('labs', `lab check report of document ${documentId} did not validate: ${valid.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    return null;
  }
  patchCoverageMeta(documentId, { labCheck: valid.data });
  return valid.data;
}

export function rowRef(r: FoundLabRow): LabCheckRowRef {
  const cut = (s: string | null, n: number) => (s == null ? null : s.slice(0, n));
  return { page: r.page, text: r.text.slice(0, 400), analyte: r.analyte.slice(0, 200), value: r.value.slice(0, 100), unit: cut(r.unit, 60), range: cut(r.range, 160), flag: cut(r.flag, 40) };
}

/** Per part: rows found, held and missed on the part's pages (counts only; written when they changed). */
function writePartCounts(documentId: string, rows: readonly FoundLabRow[], fates: readonly RowFate[], at: string): void {
  const segs = listSegments(documentId).filter((s) => routeOf({ kind: s.kind, detail: parseSegmentDetail(s.detailJson) }) !== 'skip');
  if (!segs.length) return;
  const counts = new Map<string, { rows: number; matched: number; missed: number }>();
  rows.forEach((r, i) => {
    const seg = partFor(segs, r.page);
    if (!seg) return;
    const c = counts.get(seg.id) ?? { rows: 0, matched: 0, missed: 0 };
    c.rows++;
    if (fates[i].kind === 'missed') c.missed++;
    else c.matched++;
    counts.set(seg.id, c);
  });
  db().transaction(() => {
    for (const s of segs) {
      const prev = (parseSegmentDetail(s.detailJson) as Record<string, unknown>).labCheck as { rows?: number; matched?: number; missed?: number } | undefined;
      const c = counts.get(s.id);
      if (!c && !prev) continue;
      const next = c ?? { rows: 0, matched: 0, missed: 0 };
      if (prev && prev.rows === next.rows && prev.matched === next.matched && prev.missed === next.missed) continue;
      updateSegment(s.id, { detail: { labCheck: { at, ...next } } as Record<string, unknown> });
    }
  });
}

/** The part a page's lab rows belong to: a lab results part touching the page, else the first part the model reads there. */
function partFor(segs: readonly SegmentRow[], page: number): SegmentRow | null {
  const touching = segs.filter((s) => s.pageStart <= page && s.pageEnd >= page);
  return touching.find((s) => s.kind === 'lab_results') ?? touching.find((s) => ['extract', 'parse_and_extract'].includes(routeOf({ kind: s.kind, detail: parseSegmentDetail(s.detailJson) }))) ?? touching[0] ?? null;
}

export interface LabCheckRun {
  report: LabCheckReport;
  rows: FoundLabRow[];
  fates: RowFate[];
}

/**
 * The check (no AI): rows found on the pages read, which detail holds each, the report written. Null when the document
 * is gone or nothing of it has been read. Never throws for a document that cannot be read (logged, null).
 */
export function runLabCheck(documentId: string, opts: { trigger: LabCheckTrigger } = { trigger: 'manual' }): LabCheckRun | null {
  const doc = liveDocumentRow(documentId);
  if (!doc) return null;
  const read = readPagesOf(documentId);
  const prev = readLabCheck(documentId);
  if (!read.size && !prev) return null;
  const rows = read.size ? documentLabRows(documentId, read) : [];
  const holders = rows.length ? loadHolders(documentId) : [];
  const fates = matchRows(rows, holders);
  const at = nowIso();
  const missedRows = rows.filter((_, i) => fates[i].kind === 'missed');
  const deletedByYou = fates.filter((f) => f.kind === 'deleted_by_you').length;
  const sameVersion = prev?.version === LAB_CHECK_FULL_VERSION;
  // A round (misses found, read again, added) starts when misses appear after a check that had none (or a check of an
  // older version); its history stays in the report until the next round starts.
  const newRound = missedRows.length > 0 && (!prev || !sameVersion || prev.missed === 0);
  const keepRound = !newRound && sameVersion && prev;
  const report: LabCheckReport = {
    v: 1,
    version: LAB_CHECK_FULL_VERSION,
    at,
    trigger: opts.trigger,
    pagesChecked: read.size,
    pagesWithRows: new Set(rows.map((r) => r.page)).size,
    rowsFound: rows.length,
    matched: fates.filter((f) => f.kind === 'held').length,
    missed: missedRows.length,
    missedRows: missedRows.slice(0, MAX_LISTED).map(rowRef),
    firstMissed: newRound ? { count: missedRows.length, pages: [...new Set(missedRows.map((r) => r.page))].sort((a, b) => a - b).slice(0, 500), at } : keepRound ? prev!.firstMissed : null,
    reread: keepRound ? prev!.reread : null,
    rereadKeys: prev?.rereadKeys ?? [],
    added: keepRound ? prev!.added : [],
    addedCount: keepRound ? prev!.addedCount : 0,
    deletedByYou,
    notes: [],
    missedPages: [...new Set(missedRows.map((r) => r.page))].sort((a, b) => a - b).slice(0, 2000),
    // Pages held back from adding (sanity test) stay listed while their lines are still missed.
    ...(keepRound && prev!.heldBack?.length ? { heldBack: prev!.heldBack.filter((h) => missedRows.some((r) => r.page === h.page)) } : {}),
  };
  const written = writeLabCheck(documentId, report) ?? report;
  try {
    writePartCounts(documentId, rows, fates, at);
  } catch (err) {
    log.warn('labs', `lab check part counts of document ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { report: written, rows, fates };
}

// ---------------------------------------------------------------------------
// Adding a value from the page
// ---------------------------------------------------------------------------

/** The stored and reading-order texts of one page (null when the page does not exist). */
function pageForms(documentId: string, page: number): { stored: string; visual: string | null } | null {
  const p = db()
    .select({ text: schema.documentPages.text, boxesJson: schema.documentPages.boxesJson })
    .from(schema.documentPages)
    .where(and(eq(schema.documentPages.documentId, documentId), eq(schema.documentPages.pageNumber, page)))
    .get();
  if (!p) return null;
  return { stored: p.text, visual: visualPageText({ text: p.text, boxesJson: p.boxesJson }) };
}

/** The first of the row's quotes that is found on its own page (stream order first: the viewer gets offsets). */
function verifiedQuote(forms: { stored: string; visual: string | null }, quotes: readonly string[]): string | null {
  for (const q of quotes) if (isVerifiedMatch(locateQuote(forms.stored, q))) return q;
  if (forms.visual) for (const q of quotes) if (isVerifiedMatch(locateQuote(forms.visual, q))) return q;
  return null;
}

/** The segment link a value read off a page carries (the part holding the page), as the extraction writes it. */
function segmentRefFor(documentId: string, page: number): { ref: FactSegmentRef; tier: string | null } | null {
  const seg = partFor(listSegments(documentId), page);
  if (!seg) return null;
  const detail = parseSegmentDetail(seg.detailJson);
  const tier = seg.sourceTier && ['primary', 'patient', 'compilation', 'external', 'unknown'].includes(seg.sourceTier) ? (seg.sourceTier as FactSegmentRef['tier']) : null;
  return { ref: { id: seg.id, seq: seg.seq, kind: seg.kind, ...(tier ? { tier } : {}), ...(detail.encounterKey ? { encounterKey: detail.encounterKey } : {}) }, tier: seg.sourceTier ?? null };
}

/** The lab attributes of a row exactly as printed (the user's rules): value, unit, range, flag, dates by their labels, lab. */
export function rowAttributes(r: FoundLabRow): Record<string, unknown> {
  const range = r.range ? parseRefRange(r.range) : null;
  const flag = r.flag != null ? parseFlag(r.flag) : null;
  const specimen = r.specimenHint && !normalizeKey(r.analyte).split(' ').some((w) => ['serum', 'plasma', 'blood', 'csf', 'urine'].includes(w)) ? r.specimenHint : null;
  const raw: Record<string, unknown> = {
    analyte: r.analyte,
    value: r.value,
    value_num: r.parsed.kind === 'number' ? r.parsed.number : null,
    unit: r.unit,
    ref_low: range?.kind === 'interval' ? range.low : null,
    ref_high: range?.kind === 'interval' ? range.high : null,
    ref_text: r.range,
    flag: flag?.state === 'flag' ? flag.printed : null,
    flag_raw: r.flag ?? '',
    specimen,
    lab_name: r.lab,
    collected_date: r.dates.collected,
    resulted_date: r.dates.resulted,
    received_date: r.dates.received,
  };
  const v = validateAttributes('lab_result', raw, { from: 'user' });
  return v.ok ? v.value : raw;
}

function statementFor(r: FoundLabRow, by: 'lab_check' | 'clinician'): string {
  const value = `${r.value}${r.unit && !r.value.includes(r.unit) ? ` ${r.unit}` : ''}`;
  const range = r.range ? ` (reference ${r.range})` : '';
  const flag = r.flag && parseFlag(r.flag).state === 'flag' ? `, flagged ${r.flag}` : '';
  const when = r.dates.collected ? `, collected ${r.dates.collected}` : r.dates.resulted ? `, resulted ${r.dates.resulted}` : r.dates.unknown ? `, ${r.dates.unknown}` : '';
  const who = by === 'clinician' ? `Added by the clinician at your request, from p.${r.page}.` : `Added by the lab check from p.${r.page}.`;
  return `${r.analyte}: ${value}${range}${flag}${when}. ${who}`;
}

export interface AddedRow {
  outcome: 'added' | 'cited_existing' | 'already_on_file';
  factId: string;
  citationId: string | null;
  statement: string;
}

/**
 * True when another ledger points at this detail by its id (a lab row, a finding someone judged or wrote on, a task...).
 * A finding the rules raised by themselves and nobody judged (open with no note of the user's, or cleared by the engine)
 * does not hold it (2026-10-09 review: the rules flag every abnormal value they see, so Undo was refused for exactly the
 * values that matter); Undo clears such findings with the value.
 */
function linkedElsewhere(factId: string): boolean {
  const auto = `${AUTO_CLEARED_PREFIX}%`;
  const r = db().get<{ n: number }>(sql`
    select (select count(*) from lab_results where fact_id = ${factId} and deleted_at is null)
         + (select count(*) from finding_evidence fe join findings fi on fi.id = fe.finding_id where fe.fact_id = ${factId} and fi.deleted_at is null
              and not (fi.origin = 'rule'
                       and ((fi.status = 'new' and (fi.verdict_note is null or trim(fi.verdict_note) = '' or fi.verdict_note like ${auto}))
                            or (fi.status = 'resolved' and fi.verdict_note like ${auto}))))
         + (select count(*) from tasks where source_type = 'fact' and source_id = ${factId} and deleted_at is null)
         + (select count(*) from facts where superseded_by_id = ${factId} and deleted_at is null) as n`);
  return Number(r?.n ?? 0) > 0;
}

/**
 * One row of a page made a lab detail (or cited on the detail that already holds the same result). Never touches a
 * detail with the user's work: such a holder only stands as "already on file". Throws when no quote of the row is found
 * on its page (a citation must verify).
 */
function addRow(
  documentId: string,
  r: FoundLabRow,
  by: 'lab_check' | 'clinician',
  extra: { filingId?: string | null; askMessageId?: string | null } = {},
  /** The document's lab details, loaded once for many rows (kept current here); loaded now when not given. */
  pool: Holder[] | null = null,
): AddedRow {
  const doc = liveDocumentRow(documentId);
  if (!doc) throw notFound('document not found');
  const forms = pageForms(documentId, r.page);
  if (!forms) throw notFound(`p.${r.page} is not a page of this document`);
  const quote = verifiedQuote(forms, r.quotes);
  if (!quote) throw conflict(`the line "${r.text.slice(0, 120)}" could not be found word for word on p.${r.page}`);
  const lookup = (n: number) => (n === r.page ? forms.stored : undefined);
  const alt = (n: number) => (n === r.page ? (forms.visual ?? undefined) : undefined);
  // The detail that already holds this result (the same test, value and day, any page of the document): no copy.
  const id = labValueIdentity(r.parsed);
  const days = rowDays(r);
  const all = pool ?? loadHolders(documentId);
  const holders = all.filter((h) => h.live && h.ids.has(id) && r.keys.some((k) => h.keys.has(k)));
  // Cited on this page already; or the same printed day; or, for a row printed with no date, a value the app added from
  // another undated printing (the reading's own rule: one result printed several times is one detail).
  const same = holders.find((h) => h.quotes.has(r.page) || (days.length > 0 && days.some((d) => h.days.has(d))) || (!days.length && !h.days.size && h.origin === LAB_CHECK_ORIGIN));
  if (same) {
    const fact = db().select({ statement: schema.facts.statement }).from(schema.facts).where(eq(schema.facts.id, same.id)).get();
    const already = (same.quotes.get(r.page) ?? []).length > 0;
    if (already || same.userWork || same.status === 'confirmed' || same.status === 'disputed') return { outcome: 'already_on_file', factId: same.id, citationId: null, statement: fact?.statement ?? '' };
    const c = insertVerifiedCitation(same.id, { documentId, pageNumber: r.page, quote }, lookup, [alt]);
    same.quotes.set(r.page, [...(same.quotes.get(r.page) ?? []), quote]);
    return { outcome: 'cited_existing', factId: same.id, citationId: c.id, statement: fact?.statement ?? '' };
  }
  const seg = segmentRefFor(documentId, r.page);
  const tier = effectiveTier(doc.sourceTier, { segmentTier: seg?.tier ?? null });
  const at = nowIso();
  const mark: LabCheckMark = { by, page: r.page, row: r.text.slice(0, 400), at, ...(extra.filingId ? { filingId: extra.filingId } : {}), ...(extra.askMessageId ? { askMessageId: extra.askMessageId } : {}) };
  const attributes: Record<string, unknown> = { ...rowAttributes(r), _people: [], [LAB_CHECK_ATTRIBUTE]: mark, ...(seg ? { [SEGMENT_ATTRIBUTE_KEY]: seg.ref } : {}) };
  const dateText = r.dates.collected ?? r.dates.resulted ?? r.dates.unknown ?? null;
  const statement = statementFor(r, by);
  let out: AddedRow | null = null;
  db().transaction(() => {
    const fact = insertFact({
      type: 'lab_result',
      statement,
      dateText,
      attributes,
      confidence: 1,
      origin: LAB_CHECK_ORIGIN,
      status: 'unverified',
      sourceDocumentId: documentId,
      extractionRunId: null,
      objectivity: 'objective',
      assertedBy: coerceAssertedBy(null, tier),
    });
    const c = insertVerifiedCitation(fact.id, { documentId, pageNumber: r.page, quote }, lookup, [alt]);
    out = { outcome: 'added', factId: fact.id, citationId: c.id, statement };
    if (pool) {
      const h: Holder = { id: fact.id, live: true, userDeleted: false, keys: new Set(), ids: new Set(), units: new Set(), days: new Set(), quotes: new Map([[r.page, [quote]]]), origin: LAB_CHECK_ORIGIN, status: 'unverified', userWork: false, createdAt: fact.createdAt };
      readHolderAttrs(attributes, h);
      const d = dayOf(fact.date);
      if (d) h.days.add(d);
      pool.push(h);
    }
  });
  return out!;
}

/** The checks a new lab detail needs (as after a reading): reconciliation, the lab rules, the document's brief. Never throws. */
function afterAdded(documentId: string): void {
  try {
    reconcileQuietly({ documentId, trigger: 'extraction' });
  } catch (err) {
    log.warn('labs', `reconciliation after a lab value was added to document ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    runLabChecks({ documentId, trigger: 'extraction' });
  } catch (err) {
    log.warn('labs', `lab rules after a lab value was added to document ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    rebuildDocumentBrief(documentId);
  } catch (err) {
    log.warn('labs', `brief after a lab value was added to document ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The case's rules (findings) see the value added or taken back, as after a reading (one debounced job).
  try {
    enqueueRulesAfterIngest([documentId], 'reprocess');
  } catch {
    // the next reading or unlock runs them
  }
}

/** Records additions in the document's report (the check is then run again by the caller). */
function noteAdded(documentId: string, entries: readonly LabCheckAdded[]): void {
  if (!entries.length) return;
  const prev = readLabCheck(documentId);
  if (!prev) return;
  const made = entries.filter((e) => e.cited === 'new').length;
  writeLabCheck(documentId, { ...prev, added: [...prev.added, ...entries].slice(-MAX_LISTED), addedCount: prev.addedCount + made });
}

// ---------------------------------------------------------------------------
// The sanity test of a page before its lines are added by themselves (2026-10-09, lab recall)
// ---------------------------------------------------------------------------

/** A page whose missed lines are not added from the page by themselves, and why (plain words, no record text). */
export interface HeldBackPage {
  page: number;
  rows: number;
  reason: string;
}

const DATE_TIME = /\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{3,4}\b)?|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;

/** Numbers printed in a row besides its name, value, range, unit, flag, lab and dates (a trend table prints several values). */
export function extraNumbers(r: Pick<FoundLabRow, 'text' | 'analyte' | 'value' | 'range' | 'unit' | 'flag' | 'lab'>): number {
  const nums = (s: string | null | undefined) => (s ?? '').replace(DATE_TIME, ' ').match(NUMBER) ?? [];
  const left = new Map<string, number>();
  for (const n of nums(r.text)) left.set(n, (left.get(n) ?? 0) + 1);
  for (const part of [r.analyte, r.value, r.range, r.unit, r.flag, r.lab]) {
    for (const n of nums(part)) {
      const k = left.get(n) ?? 0;
      if (k > 0) left.set(n, k - 1);
    }
  }
  let extra = 0;
  for (const k of left.values()) extra += k;
  return extra;
}

/** A value printed as a range ("135 - 145"), or the same words as the row's range: a reference table read as results. */
function rangeAsValue(r: Pick<FoundLabRow, 'value' | 'range'>): boolean {
  const v = r.value.replace(/\s+/g, ' ').trim();
  if (/^[<>≤≥]?=?\s*-?\d+(?:\.\d+)?\s*(?:-|–|to)\s*-?\d+(?:\.\d+)?(?:\s|$)/i.test(v)) return true;
  return Boolean(r.range) && normalizeKey(v) === normalizeKey(r.range ?? '') && /\d/.test(v);
}

/**
 * Why the lab lines the app reads off a page should not be added from it by themselves (null: they may). Run over every
 * row the page yields: most of them not found on the page word for word; most values printed as ranges (a table of
 * reference ranges); or most rows a trend (one test three times or more with different values and no date of its own,
 * or a row printing two or more numbers besides its value, range and dates). Pure.
 */
export function pageSanity(rows: readonly FoundLabRow[], forms: { stored: string; visual: string | null } | null): string | null {
  if (!rows.length) return null;
  if (!forms) return 'the page could not be read back';
  const unquoted = rows.filter((r) => !verifiedQuote(forms, r.quotes)).length;
  if (rows.length >= 2 && unquoted * 2 > rows.length) return `${unquoted} of the ${rows.length} lab lines the app reads on this page are not found on it word for word`;
  if (rows.length < 3) return null;
  if (rows.filter(rangeAsValue).length * 5 >= rows.length * 3) return 'the page looks like a table of reference ranges, not of results';
  const groups = new Map<string, FoundLabRow[]>();
  for (const r of rows) {
    const k = r.keys[0] ?? normalizeKey(r.analyte);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const trend = new Set<FoundLabRow>();
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const values = new Set(g.map((r) => labValueIdentity(r.parsed)));
    const dates = new Set(g.map((r) => `${r.dates.collected ?? ''}|${r.dates.resulted ?? ''}|${r.dates.unknown ?? ''}`));
    if (values.size >= 2 && dates.size <= 1) for (const r of g) trend.add(r);
  }
  for (const r of rows) if (extraNumbers(r) >= 2) trend.add(r);
  if (trend.size * 2 > rows.length) return 'the page looks like a trend table (several results of a test side by side), which the app may misread';
  return null;
}

/**
 * The rows still missed after the re-read (or when it cannot run) added from the page. Returns how many details were
 * made and how many rows were cited on an existing one. The check runs again afterwards (the report's counts). With
 * `sanity` (the lab check's own additions), a page whose rows fail pageSanity is held back: nothing is added from it
 * and it is listed with the reason (2026-10-09, lab recall).
 */
export function addMissedRows(documentId: string, rows: readonly FoundLabRow[], opts: { sanity?: boolean } = {}): { made: number; cited: number; failed: number; heldBack: HeldBackPage[] } {
  const out = { made: 0, cited: 0, failed: 0, heldBack: [] as HeldBackPage[] };
  const entries: LabCheckAdded[] = [];
  if (opts.sanity && rows.length) {
    const pages = [...new Set(rows.map((r) => r.page))].sort((a, b) => a - b);
    const all = documentLabRows(documentId, new Set(pages));
    const held = new Set<number>();
    for (const page of pages) {
      const why = pageSanity(all.filter((r) => r.page === page), pageForms(documentId, page));
      if (!why) continue;
      held.add(page);
      out.heldBack.push({ page, rows: rows.filter((r) => r.page === page).length, reason: why.slice(0, 300) });
    }
    if (held.size) {
      // Said once per page (a later check holds the same page back again without a word).
      const before = new Set((readLabCheck(documentId)?.heldBack ?? []).map((h) => h.page));
      const fresh = [...held].filter((p) => !before.has(p));
      if (fresh.length) log.warn('labs', `lab check of document ${documentId}: lines on ${fresh.length} page${fresh.length === 1 ? '' : 's'} not added by themselves (sanity test): ${pagesWords(fresh)}`);
      rows = rows.filter((r) => !held.has(r.page));
    }
  }
  const pool = rows.length ? loadHolders(documentId) : [];
  for (const r of rows) {
    try {
      const a = addRow(documentId, r, 'lab_check', {}, pool);
      if (a.outcome === 'added') out.made++;
      else if (a.outcome === 'cited_existing') out.cited++;
      if (a.outcome !== 'already_on_file') entries.push({ ...rowRef(r), factId: a.factId, by: 'lab_check', at: nowIso(), cited: a.outcome === 'added' ? 'new' : 'existing' });
    } catch (err) {
      out.failed++;
      // Never the row's words in the log (they are the record's): the page and the kind of failure only.
      log.warn('labs', `lab check: a lab line of document ${documentId} p.${r.page} was not added (${err instanceof Error ? err.name : 'error'})`);
    }
  }
  if (entries.length) {
    noteAdded(documentId, entries);
    afterAdded(documentId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// After a reading, at unlock: the check and what follows it
// ---------------------------------------------------------------------------

export interface LabCheckFollowUp {
  report: LabCheckReport | null;
  /** A re-read of the pages with misses was queued (job id). */
  rereadJobId: string | null;
  /** Details made from the page, and rows cited on an existing detail. */
  added: number;
  cited: number;
  /** The re-read queued or asked for: its estimate, its small calls and its pages. */
  reread?: { usd: number; calls: number; pages: number } | null;
  /** Above the limit: Claude asks once (coverage.resume, kind labcheck). */
  asked?: boolean;
}

/** Page ranges of a set of pages ([[12,12],[40,40],[88,89]]). */
function rangesOf(pages: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

/** The ceiling in dollars an automatic reading may spend (0: always ask). */
function ceilingUsd(): number {
  const n = Number(getSetting('ai.autoResumeCeilingUsd'));
  return Number.isFinite(n) && n >= 0 ? n : 15;
}

/** A reading of the document queued or running, other than `exceptJobId` (the pass that is ending now). */
function readingQueued(documentId: string, exceptJobId: string | null = null): boolean {
  return db()
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.documentId, documentId), inArray(schema.jobs.type, ['extract_facts', 'resume_extraction']), inArray(schema.jobs.status, ['queued', 'running'])))
    .all()
    .some((j) => j.id !== exceptJobId);
}

/**
 * The hint rows for a reading of these pages: the lab lines missed on them NOW, worked out again from the pages read and
 * the details on file (no AI; every line, not only the 200 the report lists: 2026-10-09, lab recall).
 */
export function labHintFor(documentId: string, pages: readonly (readonly [number, number])[] | null = null): Array<{ page: number; text: string }> {
  return labLinesOnPages(documentId, pages).missed;
}

/**
 * The lab lines on these pages read (every page read when null): the ones missed now (the hint of a reading of them) and
 * how many lines there are in all (a page read again is reported again in full: the estimate prices them; 2026-10-09
 * review). No AI.
 */
export function labLinesOnPages(documentId: string, pages: readonly (readonly [number, number])[] | null = null): { missed: Array<{ page: number; text: string }>; total: number } {
  const none = { missed: [], total: 0 };
  const read = readPagesOf(documentId);
  if (!read.size) return none;
  const want = new Set<number>();
  if (pages) {
    for (const [a, b] of pages) for (let p = Math.max(1, a); p <= b && want.size < 100_000; p++) if (read.has(p)) want.add(p);
  } else for (const p of read) want.add(p);
  if (!want.size) return none;
  const rows = documentLabRows(documentId, want);
  if (!rows.length) return none;
  const fates = matchRows(rows, loadHolders(documentId));
  return { missed: rows.filter((_, i) => fates[i].kind === 'missed').map((r) => ({ page: r.page, text: r.text })), total: rows.length };
}

/** The lines missed now that never had their one re-read (the check is run first). */
export function freshLabMisses(documentId: string, trigger: LabCheckTrigger = 'manual'): FoundLabRow[] {
  const run = runLabCheck(documentId, { trigger });
  if (!run) return [];
  const done = new Set(run.report.rereadKeys);
  return run.rows.filter((r, i) => run.fates[i].kind === 'missed' && !done.has(rowKey(r)));
}

/** Plain words for a re-read in the log: pages, calls and the estimate (never record text). */
function rereadWords(pages: number, calls: number, usd: number): string {
  return `${pages} page${pages === 1 ? '' : 's'} in ${calls} call${calls === 1 ? '' : 's'}, about $${usd.toFixed(2)}`;
}

/**
 * The lab check's re-read of these lines, queued (one extract_facts job, scope pages, reason labcheck; read in small
 * calls naming the lines). The report says it is queued and the lines have had their one re-read. Returns the job id.
 */
export function queueLabReread(documentId: string, rows: readonly FoundLabRow[], info: { usd: number | null; calls: number | null }): string {
  const ranges = rangesOf(rows.map((r) => r.page));
  // A long list is worked out again when the job runs (labHintFor: the lines missed on those pages then).
  const labHint = rows.length <= MAX_PAYLOAD_HINT ? rows.map((r) => ({ page: r.page, text: r.text })) : undefined;
  const job = enqueueJob({
    type: 'extract_facts',
    payload: { documentId, scope: 'pages', pages: ranges, reason: 'labcheck', ...(labHint ? { labHint } : {}), prevStatus: liveDocumentRow(documentId)?.extractionStatus ?? undefined },
    documentId,
  });
  const report = readLabCheck(documentId);
  if (report) {
    writeLabCheck(documentId, {
      ...report,
      reread: {
        at: nowIso(),
        pages: [...new Set(rows.map((r) => r.page))].sort((a, b) => a - b).slice(0, 500),
        rows: rows.length,
        status: 'queued',
        jobId: job.id,
        reason: null,
        ...(info.usd != null ? { estimateUsd: info.usd } : {}),
        ...(info.calls != null ? { calls: info.calls } : {}),
      },
      rereadKeys: [...new Set([...report.rereadKeys, ...rows.map(rowKey)])].slice(-MAX_REREAD_KEYS),
    });
  }
  return job.id;
}

/**
 * No re-read for these lines (Claude off, no key, or the user said not now): the report says why, they count as read again,
 * and they are added from the page (the sanity test first). The check runs again; pages held back are listed.
 */
export function addWithoutReread(documentId: string, rows: readonly FoundLabRow[], why: string, already: readonly FoundLabRow[] = [], trigger: LabCheckTrigger = 'manual'): { added: number; cited: number; report: LabCheckReport | null } {
  const report = readLabCheck(documentId);
  if (report && rows.length) {
    writeLabCheck(documentId, {
      ...report,
      reread: { at: nowIso(), pages: [...new Set(rows.map((r) => r.page))].sort((a, b) => a - b).slice(0, 500), rows: rows.length, status: 'skipped', jobId: null, reason: why },
      rereadKeys: [...new Set([...report.rereadKeys, ...rows.map(rowKey)])].slice(-MAX_REREAD_KEYS),
    });
  }
  return addAndRecheck(documentId, [...already, ...rows], trigger);
}

/** Adds the rows from the page (sanity test first), runs the check again and keeps the pages held back in the report. */
function addAndRecheck(documentId: string, rows: readonly FoundLabRow[], trigger: LabCheckTrigger): { added: number; cited: number; report: LabCheckReport | null } {
  if (!rows.length) return { added: 0, cited: 0, report: readLabCheck(documentId) };
  const a = addMissedRows(documentId, rows, { sanity: true });
  const run = runLabCheck(documentId, { trigger });
  let report = run?.report ?? readLabCheck(documentId);
  if (report && a.heldBack.length) {
    const still = new Set(report.missedPages ?? report.missedRows.map((m) => m.page));
    const merged = new Map((report.heldBack ?? []).map((h) => [h.page, h] as const));
    for (const h of a.heldBack) if (still.has(h.page)) merged.set(h.page, h);
    report = writeLabCheck(documentId, { ...report, heldBack: [...merged.values()].sort((x, y) => x.page - y.page).slice(0, 500) }) ?? report;
  }
  return { added: a.made, cited: a.cited, report };
}

type RereadGate =
  | { kind: 'go'; usd: number | null; calls: number | null; pages: number }
  | { kind: 'add'; why: string }
  | { kind: 'ask'; usd: number; calls: number; pages: number; segments: number; ceiling: number; why: string }
  | { kind: 'wait'; why: string; usd: number | null; calls: number | null };

/**
 * May the pages with these lines be read again by themselves now? (2026-10-09, lab recall.) No when Claude is off or no
 * key is stored (the lines are added from the page). Yes under `ai.autoResumeCeilingUsd` (and, during the sweep at
 * unlock, within what is left of that limit for all documents together), or when the user already said yes to about this
 * much. Above it Claude asks ONCE through the reading question of the document (coverage.resume, kind labcheck): the
 * card on the document page, Home and the clinician; a question already waiting is not asked again, "Not now" to it (or
 * to reading the rest of the document) adds the lines from the page, and a question about reading the rest goes first.
 * The estimate prices what the re-read sends: the pages of the parts already read, in small calls naming the lines.
 */
async function rereadGate(documentId: string, rows: readonly FoundLabRow[], budget: RereadBudget | null, otherLabRows = 0): Promise<RereadGate> {
  if (!aiEnabled()) return { kind: 'add', why: 'Claude is switched off' };
  if (!getApiKey()) return { kind: 'add', why: 'no AI key is stored' };
  const ex = await import('../ai/extraction');
  const ceiling = ceilingUsd();
  let est: ReturnType<typeof ex.estimateLabReread> | null = null;
  try {
    est = ex.estimateLabReread(documentId, rows.map((r) => ({ page: r.page, text: r.text })), otherLabRows);
  } catch {
    est = null;
  }
  // No estimate: only what one small call reads goes ahead unpriced; more is never read unpriced (2026-10-09 review).
  if (!est && (rows.length > ex.HINT_ROWS_PER_CALL || new Set(rows.map((r) => r.page)).size > ex.LAB_CALL_MAX_PAGES)) {
    return { kind: 'add', why: 'the cost of reading them again could not be worked out' };
  }
  if (est && est.calls === 0) return { kind: 'add', why: 'no part already read holds those pages' };
  const usd = est?.approxUsd ?? 0;
  const pages = est?.pages ?? new Set(rows.map((r) => r.page)).size;
  const prior = ex.readResumeDecision(documentId);
  const yes = prior?.kind === 'labcheck' && prior.decision === 'approved' && usd <= prior.estimateUsd * 1.25 + 0.01;
  const within = ceiling > 0 && usd <= ceiling;
  let why: string;
  if (yes) return { kind: 'go', usd: est ? usd : null, calls: est?.calls ?? null, pages };
  if (within && (!budget || usd <= budget.leftUsd)) {
    if (budget) budget.leftUsd = Math.max(0, budget.leftUsd - usd);
    return { kind: 'go', usd: est ? usd : null, calls: est?.calls ?? null, pages };
  }
  if (within) why = `the automatic re-reads after this unlock reached the $${budget!.limitUsd.toFixed(2)} limit for all documents together`;
  else if (ceiling <= 0) why = 'automatic readings always ask first (limit $0)';
  else why = `reading those pages again would cost about $${usd.toFixed(2)}, above the $${ceiling.toFixed(2)} limit`;
  if (prior?.kind === 'labcheck' && prior.decision === 'ask') return { kind: 'wait', why: 'waiting for your go-ahead', usd: prior.estimateUsd, calls: prior.calls ?? null };
  if (prior?.kind === 'labcheck' && prior.decision === 'declined') return { kind: 'add', why: 'you said not now to reading them again' };
  if (prior && prior.kind !== 'labcheck' && prior.decision === 'declined') return { kind: 'add', why: 'you said not now to reading more of this document' };
  if (prior && prior.kind !== 'labcheck' && prior.decision === 'ask') return { kind: 'wait', why: 'asked once you answer about reading the rest of this document', usd, calls: est?.calls ?? null };
  return { kind: 'ask', usd, calls: est?.calls ?? 0, pages, segments: est?.segments ?? 0, ceiling, why };
}

/**
 * The check after a reading pass (or at unlock), then what follows: misses never read again are read again once (a
 * job of small calls naming them, under the limit; above it Claude asks once); misses already read again, or when no
 * re-read can run (Claude off, no key, "Not now"), are added from the page, a page failing the sanity test held back.
 * A document with many lines missed gets the same (2026-10-09, lab recall: the mass-miss guard that left it alone is
 * gone). `rereadEnded` says the pass that just ended was the lab check's own re-read. Never throws.
 */
export async function labCheckAndFollowUp(
  documentId: string,
  ctx: {
    trigger: LabCheckTrigger;
    rereadEnded?: { outcome: string } | null;
    allowReread?: boolean;
    ownJobId?: string | null;
    /** The lines the pass that just ended was asked to bring in (its hint): they have had their re-read. */
    hinted?: ReadonlyArray<{ page: number; text: string }> | null;
    /**
     * What automatic re-reads may still spend in all, across documents (the check of every document at unlock): a
     * re-read above what is left is asked for once instead.
     */
    budget?: RereadBudget | null;
  },
): Promise<LabCheckFollowUp> {
  const out: LabCheckFollowUp = { report: null, rereadJobId: null, added: 0, cited: 0, reread: null, asked: false };
  try {
    const run = runLabCheck(documentId, { trigger: ctx.trigger });
    if (!run) return out;
    out.report = run.report;
    // The lab check's own re-read ended (this pass), or its job ended without a pass (cancelled, failed at once): the
    // report says so, so it never reads "being read again" for good.
    if (run.report.reread?.status === 'queued') {
      let status: 'done' | 'failed' | null = null;
      let reason: string | null = run.report.reread.reason;
      if (ctx.rereadEnded) {
        status = ctx.rereadEnded.outcome === 'done' || ctx.rereadEnded.outcome === 'partial' ? 'done' : 'failed';
        if (ctx.rereadEnded.outcome === 'cancelled') reason = 'the reading was stopped before it finished';
      } else if (run.report.reread.jobId) {
        const job = db().select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, run.report.reread.jobId)).get();
        if (!job || !['queued', 'running'].includes(job.status)) {
          status = job?.status === 'done' ? 'done' : 'failed';
          if (status === 'failed') reason = job?.status === 'cancelled' ? 'the reading was stopped before it finished' : 'the reading did not finish';
        }
      }
      if (status) out.report = writeLabCheck(documentId, { ...run.report, reread: { ...run.report.reread, status, reason } }) ?? run.report;
    }
    const missed = run.rows.filter((_, i) => run.fates[i].kind === 'missed');
    if (!missed.length) return out;
    // Another reading of the document is waiting: its pass checks again when it ends (nothing is added meanwhile).
    if (readingQueued(documentId, ctx.ownJobId ?? null)) return out;
    let report = out.report!;
    // Lines the ending pass was asked to bring in (a pages reading with the hint) have had their one re-read.
    if (ctx.hinted?.length) {
      const asked = new Set(ctx.hinted.map((h) => `${h.page}|${h.text}`));
      const keys = missed.filter((r) => asked.has(`${r.page}|${r.text}`)).map(rowKey);
      if (keys.length) report = writeLabCheck(documentId, { ...report, rereadKeys: [...new Set([...report.rereadKeys, ...keys])].slice(-MAX_REREAD_KEYS) }) ?? report;
    }
    out.report = report;
    const done = new Set(report.rereadKeys);
    // The lab check's own re-read just ended: every line still missed has had its one re-read, whether or not its key is
    // still remembered (the list keeps the last MAX_REREAD_KEYS; over that, forgotten lines read as fresh and would queue
    // re-read after re-read). A re-read never queues another by itself (2026-10-09 review).
    const fresh = ctx.rereadEnded ? [] : missed.filter((r) => !done.has(rowKey(r)));
    const reread = ctx.rereadEnded ? missed : missed.filter((r) => done.has(rowKey(r)));
    const freshPages = new Set(fresh.map((r) => r.page)).size;
    let toAdd = reread;
    if (fresh.length) {
      // The lab lines already held on those pages are reported again when they are read again: priced too.
      const freshPageSet = new Set(fresh.map((r) => r.page));
      const otherLabRows = run.rows.filter((r) => freshPageSet.has(r.page)).length - fresh.length;
      const gate: RereadGate = ctx.allowReread === false ? { kind: 'add', why: 'not read again now' } : await rereadGate(documentId, fresh, ctx.budget ?? null, otherLabRows);
      const head = `lab check of document ${documentId}: ${missed.length} of ${run.report.rowsFound} lab lines missed`;
      if (gate.kind === 'go') {
        out.rereadJobId = queueLabReread(documentId, fresh, { usd: gate.usd, calls: gate.calls });
        out.reread = { usd: gate.usd ?? 0, calls: gate.calls ?? 0, pages: gate.pages };
        out.report = readLabCheck(documentId) ?? report;
        log.info('labs', `${head}; ${fresh.length} on ${freshPages} pages read again (${rereadWords(gate.pages, gate.calls ?? 0, gate.usd ?? 0)})`);
      } else if (gate.kind === 'ask') {
        const ex = await import('../ai/extraction');
        const at = nowIso();
        ex.writeResumeDecision(documentId, {
          at, estimateUsd: gate.usd, ceilingUsd: gate.ceiling, decision: 'ask', pagesLeft: gate.pages, segmentsLeft: gate.segments, decidedAt: null, decidedBy: null,
          kind: 'labcheck', pages: rangesOf(fresh.map((r) => r.page)).slice(0, 2000), rows: fresh.length, calls: gate.calls,
        });
        out.asked = true;
        out.reread = { usd: gate.usd, calls: gate.calls, pages: gate.pages };
        out.report =
          writeLabCheck(documentId, {
            ...report,
            reread: { at, pages: [...new Set(fresh.map((r) => r.page))].sort((a, b) => a - b).slice(0, 500), rows: fresh.length, status: 'ask', jobId: null, reason: gate.why, estimateUsd: gate.usd, calls: gate.calls },
          }) ?? report;
        log.info('labs', `${head}; reading ${fresh.length} of them again (${rereadWords(gate.pages, gate.calls, gate.usd)}) waits for a yes: ${gate.why}`);
      } else if (gate.kind === 'wait') {
        out.report =
          writeLabCheck(documentId, {
            ...report,
            reread: { at: nowIso(), pages: [...new Set(fresh.map((r) => r.page))].sort((a, b) => a - b).slice(0, 500), rows: fresh.length, status: 'ask', jobId: null, reason: gate.why, ...(gate.usd != null ? { estimateUsd: gate.usd } : {}), ...(gate.calls != null ? { calls: gate.calls } : {}) },
          }) ?? report;
      } else {
        // No re-read: the rows are added from the page now (the sanity test first), and the report says why.
        const a = addWithoutReread(documentId, fresh, gate.why, reread, ctx.trigger);
        out.added = a.added;
        out.cited = a.cited;
        if (a.report) out.report = a.report;
        log.info('labs', `${head}; not read again (${gate.why}): ${a.added} added from the page`);
        return out;
      }
    }
    if (toAdd.length) {
      const a = addAndRecheck(documentId, toAdd, ctx.trigger);
      out.added = a.added;
      out.cited = a.cited;
      if (a.report) {
        // The re-read just queued (or the question just asked) stays in the report written after the additions.
        const keep = out.report?.reread ?? null;
        out.report = keep && a.report.reread?.at !== keep.at ? (writeLabCheck(documentId, { ...a.report, reread: keep }) ?? a.report) : a.report;
      }
    }
  } catch (err) {
    log.warn('labs', `lab check of document ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** What the automatic re-reads of one sweep (every document at unlock) may still spend together, in dollars. */
export interface RereadBudget {
  leftUsd: number;
  limitUsd: number;
}

/**
 * The user's answer to the lab check's question (coverage.resume kind labcheck; reprocess.ts decideResume and the reading
 * requests route here): yes queues the re-read of the lines missed now, in small calls (above the limit: the yes covers
 * it); "Not now" adds them from the page (the sanity test first), and they are not asked about again.
 */
export function answerLabRereadQuestion(documentId: string, decision: 'approved' | 'declined', asked: { estimateUsd?: number | null; calls?: number | null } = {}): { jobId: string | null; added: number } {
  const fresh = freshLabMisses(documentId, 'manual');
  if (!fresh.length) {
    // Nothing is left to read again (the lines are held now): the report no longer says it waits for a go-ahead.
    const r = readLabCheck(documentId);
    if (r?.reread?.status === 'ask') writeLabCheck(documentId, { ...r, reread: { ...r.reread, status: 'skipped', reason: 'no lab line was left to read again' } });
    return { jobId: null, added: 0 };
  }
  if (decision === 'approved') {
    const jobId = queueLabReread(documentId, fresh, { usd: asked.estimateUsd ?? null, calls: asked.calls ?? null });
    log.info('labs', `lab check of document ${documentId}: the patient said yes; ${fresh.length} lab lines read again`);
    return { jobId, added: 0 };
  }
  const a = addWithoutReread(documentId, fresh, 'you said not now to reading them again', [], 'manual');
  return { jobId: null, added: a.added };
}

/**
 * Lab-check re-reads the report says are waiting while their job is no longer queued or running (stopped, cancelled,
 * lost in a restart): settled now, at every unlock (2026-10-09 review: a cancelled re-read read "being read again" for
 * good). labCheckAndFollowUp marks the re-read failed and adds its lines from the page. Never throws.
 */
export async function settleStaleRereads(isUnlocked: () => boolean = () => true): Promise<number> {
  let n = 0;
  try {
    const docs = db().all<{ id: string }>(sql`
      select id from documents where deleted_at is null and json_valid(metadata_json)
        and json_extract(metadata_json, '$.coverage.labCheck.reread.status') = 'queued'`);
    for (const d of docs) {
      if (!isUnlocked()) break;
      const r = readLabCheck(d.id);
      if (r?.reread?.status !== 'queued') continue;
      const job = r.reread.jobId ? db().select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, r.reread.jobId)).get() : null;
      if (job && ['queued', 'running'].includes(job.status)) continue;
      await labCheckAndFollowUp(d.id, { trigger: 'unlock' });
      n++;
    }
  } catch (err) {
    log.warn('labs', `settling the lab check's re-reads: ${err instanceof Error ? err.message : String(err)}`);
  }
  return n;
}

export interface LabCheckSweep {
  documents: number;
  missed: number;
  rereads: number;
  added: number;
  /** Documents where Claude asks first (above the limit). */
  asked: number;
  /** The re-reads queued: pages, small calls and their estimate in all. */
  rereadPages: number;
  rereadCalls: number;
  estimateUsd: number;
  /** What the questions asked would cost. */
  askedUsd: number;
}

/**
 * Once at unlock (setting `migration.labCheckV1` holds the version that ran; version 2002 since 2026-10-09, so a
 * document the old mass-miss guard left alone gets the new treatment): every document already read is checked (no AI
 * here; misses are read again by a queued job of small calls under the limit, else Claude asks once; misses already
 * read again are added from the page). A document being read is skipped (its pass checks it when it ends). Yields
 * between documents. Never throws.
 */
export async function labCheckAfterUnlock(isUnlocked: () => boolean = () => true): Promise<LabCheckSweep | null> {
  // Every unlock: a re-read that ended without its pass (cancelled, lost) is settled, so none reads "being read again".
  await settleStaleRereads(isUnlocked);
  if (!isUnlocked()) return null;
  try {
    const done = getSetting(LAB_CHECK_SETTING as SettingKey) as unknown as { version?: number } | undefined;
    if (done && typeof done === 'object' && done.version === LAB_CHECK_FULL_VERSION) return null;
    const docs = db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(isNull(schema.documents.deletedAt), inArray(schema.documents.extractionStatus, ['done', 'partial'])))
      .orderBy(asc(schema.documents.createdAt))
      .all();
    const out: LabCheckSweep = { documents: 0, missed: 0, rereads: 0, added: 0, asked: 0, rereadPages: 0, rereadCalls: 0, estimateUsd: 0, askedUsd: 0 };
    // The automatic re-reads this sweep queues spend at most the per-document limit IN ALL (2026-10-09 fixer); past it,
    // Claude asks once for the document (2026-10-09, lab recall; before: the lines were added from the page).
    const limit = ceilingUsd();
    const budget: RereadBudget = { leftUsd: limit, limitUsd: limit };
    for (const d of docs) {
      if (!isUnlocked()) return out;
      if (readingQueued(d.id)) continue;
      const r = await labCheckAndFollowUp(d.id, { trigger: 'unlock', budget });
      if (r.report) out.documents++;
      out.missed += r.report?.firstMissed && r.report.trigger === 'unlock' ? r.report.firstMissed.count : 0;
      if (r.rereadJobId) {
        out.rereads++;
        out.rereadPages += r.reread?.pages ?? 0;
        out.rereadCalls += r.reread?.calls ?? 0;
        out.estimateUsd += r.reread?.usd ?? 0;
      }
      if (r.asked) {
        out.asked++;
        out.askedUsd += r.reread?.usd ?? 0;
      }
      out.added += r.added;
      await new Promise((res) => setImmediate(res));
    }
    if (!isUnlocked()) return out;
    setSetting(LAB_CHECK_SETTING as SettingKey, { version: LAB_CHECK_FULL_VERSION, at: nowIso(), ...out } as unknown as Settings[SettingKey]);
    return out;
  } catch (err) {
    log.warn('labs', `lab check after unlock: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The sweep at unlock in one log line (counts and dollars only). */
export function sweepWords(r: LabCheckSweep): string {
  const reread = r.rereads ? ` (${rereadWords(r.rereadPages, r.rereadCalls, r.estimateUsd)})` : '';
  const asked = r.asked ? `, ${r.asked} asked first (about $${r.askedUsd.toFixed(2)})` : '';
  return `${r.documents} documents checked, ${r.missed} lab lines missed, ${r.rereads} re-reads of pages queued${reread}${asked}, ${r.added} values added from the page`;
}

// ---------------------------------------------------------------------------
// On request: the clinician (and the screens)
// ---------------------------------------------------------------------------

export interface AddFromPageInput {
  documentId: string;
  page: number;
  /** The row as printed (cells joined by " | ", or as the page shows it), or a quote of it. One of row/quote. */
  row?: string | null;
  quote?: string | null;
  /** Which test, when the line holds several. */
  analyte?: string | null;
  askMessageId?: string | null;
}

export interface AddFromPageResult {
  outcome: 'added' | 'cited_existing' | 'already_on_file';
  factId: string;
  citationId: string | null;
  statement: string;
  /** One plain sentence for the model and the card. */
  words: string;
  row: LabCheckRowRef;
  collected: string | null;
  resulted: string | null;
  lab: string | null;
  undo: { factId: string } | null;
}

/** The rows of one page, the page before read first so a table it leaves open carries on. */
function rowsOfPage(documentId: string, page: number): FoundLabRow[] {
  const want = new Set([page]);
  return documentLabRows(documentId, want);
}

/**
 * The row a request names on its page: the quote must be on that page (stored or reading-order text), and exactly one
 * test of the rows it covers must be meant (the analyte narrows it). Throws plain refusals.
 */
export function resolveRequestedRow(input: AddFromPageInput): FoundLabRow {
  const doc = liveDocumentRow(input.documentId);
  if (!doc) throw notFound('document not found');
  const page = Math.trunc(Number(input.page));
  if (!Number.isFinite(page) || page < 1) throw badRequest('page: a page number is needed');
  const asked = (input.row ?? input.quote ?? '').replace(/\s+/g, ' ').trim();
  if (asked.length < 3) throw badRequest('row: give the line as printed on the page (or a quote of it)');
  const forms = pageForms(input.documentId, page);
  if (!forms) throw notFound(`p.${page} is not a page of this document`);
  // The words asked for are on that page: as printed (cells may be joined by " | " or by spaces).
  const variants = [asked, asked.replace(/\s*\|\s*/g, ' ')];
  const onPage = variants.some((v) => isVerifiedMatch(locateQuote(forms.stored, v)) || (forms.visual ? isVerifiedMatch(locateQuote(forms.visual, v)) : false));
  if (!onPage) throw conflict(`those words are not on p.${page} of this document; quote the line exactly as the page prints it`);
  const rows = rowsOfPage(input.documentId, page);
  // The rows whose name and value the words hold, the value right after the name (as every lab line prints them).
  const q = ` ${normalizeKey(asked)} `;
  let hits = rows.filter((r) => q.includes(` ${normalizeKey(r.analyte)} ${normalizeKey(r.value)} `));
  if (input.analyte?.trim()) {
    const want = normalizeKey(input.analyte);
    const key = normalizeAnalyte(input.analyte, null);
    hits = hits.filter((r) => normalizeKey(r.analyte) === want || r.keys.includes(key));
  }
  if (!hits.length) throw conflict(`no lab line the app can read on its own is in those words on p.${page} (a line needs a test name, a value and, for a test the app does not know, a printed range); ask for the page to be read again instead`);
  const distinct = new Map<string, FoundLabRow>();
  for (const r of hits) if (!distinct.has(`${r.keys[0]}|${labValueIdentity(r.parsed)}`)) distinct.set(`${r.keys[0]}|${labValueIdentity(r.parsed)}`, r);
  if (distinct.size > 1) {
    throw conflict(`those words hold ${distinct.size} lab lines (${[...distinct.values()].map((r) => `${r.analyte} ${r.value}`).join('; ').slice(0, 300)}); say which test (analyte)`);
  }
  return [...distinct.values()][0];
}

function resultWords(r: FoundLabRow, a: AddedRow, by: 'lab_check' | 'clinician'): string {
  const what = `${r.analyte} ${r.value}${r.unit && !r.value.includes(r.unit) ? ` ${r.unit}` : ''}${r.range ? ` (reference ${r.range})` : ''}`;
  const when = r.dates.collected ? `, collected ${r.dates.collected}` : r.dates.resulted ? `, resulted ${r.dates.resulted}` : r.dates.unknown ? `, dated ${r.dates.unknown} on the page` : ', no date printed with it';
  if (a.outcome === 'added') return `Added ${what} from p.${r.page}${when}${by === 'clinician' ? ', as the patient asked' : ''}. It shows on the Labs page with its quote; Undo takes it back.`;
  if (a.outcome === 'cited_existing') return `${what} was already on file from another page of this document; p.${r.page} is now cited on it too (no second copy).`;
  return `${what} from p.${r.page} is already on file; nothing was added.`;
}

/**
 * The clinician's request, run (the user asked for it in his message, or approved the proposal): the row is found on the
 * page, parsed with the shared parser, and added with its printed dates and lab (see addRow). No AI.
 */
export function addLabValueFromPage(input: AddFromPageInput & { by?: 'clinician' | 'lab_check'; filingId?: string | null }): AddFromPageResult {
  const r = resolveRequestedRow(input);
  const by = input.by ?? 'clinician';
  const a = addRow(input.documentId, r, by, { filingId: input.filingId ?? null, askMessageId: input.askMessageId ?? null });
  if (a.outcome !== 'already_on_file') {
    noteAdded(input.documentId, [{ ...rowRef(r), factId: a.factId, by, at: nowIso(), cited: a.outcome === 'added' ? 'new' : 'existing' }]);
    afterAdded(input.documentId);
  }
  try {
    runLabCheck(input.documentId, { trigger: 'add' });
  } catch {
    // the report catches up at the next check
  }
  return {
    outcome: a.outcome,
    factId: a.factId,
    citationId: a.citationId,
    statement: a.statement,
    words: resultWords(r, a, by),
    row: rowRef(r),
    collected: r.dates.collected,
    resulted: r.dates.resulted,
    lab: r.lab,
    undo: a.outcome === 'added' ? { factId: a.factId } : null,
  };
}

type FilingRow = typeof schema.filings.$inferSelect;

function filingRow(id: string): FilingRow {
  const row = db().select().from(schema.filings).where(eq(schema.filings.id, id)).get();
  if (!row || row.targetType !== LAB_VALUE_TARGET) throw notFound('lab value proposal not found');
  return row;
}

/**
 * The clinician's proposal (not asked for in the user's message): checked exactly as an addition would be, nothing made but
 * a filings row waiting for one press (target `lab_value`, action `add_from_page`, status `waiting`). The summary
 * names what would be added, never a status.
 */
export function proposeLabValueFromPage(input: AddFromPageInput): { filingId: string; words: string; row: LabCheckRowRef } {
  const r = resolveRequestedRow(input);
  const doc = liveDocumentRow(input.documentId)!;
  const id = newId();
  const ref = rowRef(r);
  const summary = `Add ${r.analyte} ${r.value}${r.unit && !r.value.includes(r.unit) ? ` ${r.unit}` : ''} from p.${r.page} of "${doc.title}"`.slice(0, 500);
  db().insert(schema.filings).values({
    id,
    documentId: input.documentId,
    targetType: LAB_VALUE_TARGET,
    targetId: input.documentId,
    action: LAB_VALUE_ACTION,
    status: 'waiting',
    source: 'consult',
    summary,
    detailJson: JSON.stringify({ documentId: input.documentId, page: r.page, row: input.row ?? null, quote: input.quote ?? null, analyte: input.analyte ?? null, parsed: ref, factId: null }),
    askMessageId: input.askMessageId ?? null,
    createdAt: nowIso(),
  }).run();
  return { filingId: id, words: `Proposed to the patient: add ${ref.analyte} ${ref.value} from p.${r.page}. Nothing is added until he presses "Add it to the lab table" under the answer.`, row: ref };
}

/** The user's one press: the proposal is added (as asked), the row records what happened. */
export function approveLabValueProposal(filingId: string, by: string | null): { filing: FilingRow; result: AddFromPageResult } {
  const row = filingRow(filingId);
  if (row.status !== 'waiting') throw conflict(`this proposal is already ${row.status === 'approved' ? 'added' : row.status}`);
  const d = parseJson<Record<string, unknown>>(row.detailJson, {});
  const result = addLabValueFromPage({
    documentId: String(d.documentId ?? row.documentId ?? ''),
    page: Number(d.page),
    row: typeof d.row === 'string' ? d.row : null,
    quote: typeof d.quote === 'string' ? d.quote : null,
    analyte: typeof d.analyte === 'string' ? d.analyte : null,
    askMessageId: row.askMessageId,
    by: 'clinician',
    filingId,
  });
  const now = nowIso();
  const summary = (result.outcome === 'added' ? `Added ${result.row.analyte} ${result.row.value} from p.${result.row.page}` : result.outcome === 'cited_existing' ? `${result.row.analyte} ${result.row.value} was already on file; p.${result.row.page} cited on it` : `${result.row.analyte} ${result.row.value} was already on file`).slice(0, 500);
  db().update(schema.filings).set({ status: 'approved', decidedAt: now, decidedBy: by, summary, detailJson: JSON.stringify({ ...d, factId: result.factId, outcome: result.outcome }) }).where(eq(schema.filings.id, filingId)).run();
  return { filing: filingRow(filingId), result };
}

export function declineLabValueProposal(filingId: string, by: string | null): FilingRow {
  const row = filingRow(filingId);
  if (row.status !== 'waiting') throw conflict(`this proposal is already ${row.status}`);
  db().update(schema.filings).set({ status: 'declined', decidedAt: nowIso(), decidedBy: by }).where(eq(schema.filings.id, filingId)).run();
  return filingRow(filingId);
}

/**
 * Undo: a lab value added from the page is taken back (soft delete, marked as the user's, so the check never adds it
 * again). Only a value the app added (origin parsed) that nobody worked on or linked since; its proposal row reads
 * `undone`.
 */
export function undoLabValueFromPage(factId: string, by: string | null): { undone: boolean; words: string } {
  const f = db().select().from(schema.facts).where(eq(schema.facts.id, factId)).get();
  if (!f || f.type !== 'lab_result') throw notFound('lab value not found');
  if (f.deletedAt) return { undone: false, words: 'This value was already taken back.' };
  const attrs = parseJson<Record<string, unknown>>(f.attributesJson, {});
  const mark = labCheckMarkOf(attrs);
  if (f.origin !== LAB_CHECK_ORIGIN || !mark) throw conflict('only a value the app added from the page can be undone here; change or delete it on its own page');
  if (f.status !== 'unverified' || hasUserWork(f, attrs)) throw conflict('you have worked on this value since it was added; change or delete it on its own page');
  if (linkedElsewhere(factId)) throw conflict('another part of the case points at this value now; delete it on its own page');
  const now = nowIso();
  db().transaction(() => {
    db().update(schema.facts).set({ deletedAt: now, updatedAt: now, attributesJson: JSON.stringify({ ...attrs, _deletedBy: 'user' }) }).where(eq(schema.facts.id, factId)).run();
    removeFactIndex(factId);
    if (mark.filingId) db().update(schema.filings).set({ status: 'undone', decidedAt: now, decidedBy: by }).where(and(eq(schema.filings.id, mark.filingId), eq(schema.filings.targetType, LAB_VALUE_TARGET))).run();
    // What the rules raised about the value by themselves (nobody judged it) goes with it; the next rules run reopens
    // anything still detected.
    clearUnjudgedRuleFindingsOfFact(factId, `the lab value it is about was taken back on ${localDayOf(now)}.`);
  });
  if (f.sourceDocumentId) {
    noteUndone(f.sourceDocumentId, factId);
    afterAdded(f.sourceDocumentId);
    try {
      runLabCheck(f.sourceDocumentId, { trigger: 'add' });
    } catch {
      // the next check catches up
    }
  }
  return { undone: true, words: `Taken back: ${undoneStatement(f.statement)} It will not be added again.` };
}

/** A value's statement without its closing "Added by the lab check from p.18." (or "...the clinician at your request, from p.18."). */
export function undoneStatement(statement: string): string {
  return statement.replace(/\s*Added by the (?:lab check|clinician at your request),? from p\.\s*\d+\.\s*$/, '').trim();
}

/** The report lists a value taken back as such (it no longer counts as added; nothing links to it). */
function noteUndone(documentId: string, factId: string): void {
  const prev = readLabCheck(documentId);
  if (!prev) return;
  let made = 0;
  const added = prev.added.map((a) => {
    if (a.factId !== factId || a.undone) return a;
    if (a.cited === 'new') made++;
    return { ...a, undone: true };
  });
  if (!added.some((a, i) => a !== prev.added[i])) return;
  writeLabCheck(documentId, { ...prev, added, addedCount: Math.max(0, prev.addedCount - made) });
}

/** "3 missed on pp.12, 40, 88" for logs and the clinician (counts and page numbers only). */
export function missedInWords(r: LabCheckReport): string {
  return r.missed ? `${r.missed} missed on ${pagesWords([...new Set(r.missedRows.map((m) => m.page))])}` : 'none missed';
}
