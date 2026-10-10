/**
 * The lab check's row finder (2026-10-08: a lab reading was missed and could not be
 * added back, and very long documents may miss more). Pure and deterministic, no AI, no database: one stored page in, the lab result rows printed on it
 * out, each read with the shared parser (src/shared/labvalues.ts: parseLabValue, parseRefRange, parseUnit, parseFlag)
 * and named with the audited analyte table (src/shared/analytes.ts: normalizeAnalyte, exact keys only).
 *
 * Precision matters more than recall: a row is reported only when it is plainly a lab result line.
 * - Tables: a header row that names a test column ("Component", "Test") and a value column ("Value", "Result") starts
 *   a table; its columns are read from the header's own positions (the page's line boxes, as the reading-order text is
 *   rebuilt: src/server/ingest/reflow.ts). A result row starts on a line with a cell under the test column and a cell
 *   under the value column (a name and a value printed in one box are split at the column edge); the lines under it
 *   that only continue its cells (a wrapped name, a range and its unit printed under the range) belong to it. A
 *   paragraph across the columns (a comment), another table's header (the specimen table, "Narrative") or the next
 *   result's title closes the row or the table.
 * - Plain rows outside tables ("Sodium 140 135 - 145 mmol/L H"): only for a name the analyte table knows, a value that
 *   is a number or a limit, and a printed reference range the parser reads.
 * Never a lab row: a header, a reference table (a range with no value), a medication dose (no range, no known test), a
 * vital sign or an ECG interval (by name), a date, "See Note", "Specimen", a value in words that is not a result word.
 *
 * Each row carries what the page prints around it: the result's title, its collected / resulted dates (by their own
 * labels only: Collected, Collection Time, Drawn, Specimen collected / Resulted, Result date, Reported, Final, Verified;
 * a date printed in the title without a label is a date of unknown kind), its performing lab, and quotes that verify on
 * the page (stream order first, so a citation keeps offsets; the reading-order line otherwise).
 */
import { pageReading, type RowPart, type VisualRow } from '../ingest/reflow';
import { isFlagToken, isUnitToken, matchCopy, parseFlag, parseLabValue, parseRefRange, type ParsedValue } from '../../shared/labvalues';
import { BLOOD_SAMPLE, CSF_TOKEN, defaultSpecimenFor, isKnownKey, nameKeyOf, normalizeAnalyte } from '../../shared/analytes';
import { normalizeKey } from '../../shared/text';

/** Bump when the row finder changes in a way that changes which rows are found (the check runs again at unlock). */
export const LAB_ROWS_VERSION = 2;

export type LabRowLayout = 'table' | 'plain';

/** One lab result row as printed on a page. */
export interface FoundLabRow {
  page: number;
  layout: LabRowLayout;
  /** The row as printed: its cells left to right, each cell's wrapped lines joined with a space, cells with " | ". */
  text: string;
  /** The test name as printed (wrapped lines joined). */
  analyte: string;
  /** The value as printed. */
  value: string;
  /** The value's unit as printed (a unit column, the value's own, else the unit printed in the range cell). */
  unit: string | null;
  /** The reference range as printed (its cell), null when none is printed. */
  range: string | null;
  /** The flag as printed: '' when the row has a flag column left blank or no flag beside the value; null when unknown. */
  flag: string | null;
  /** Keys the row may be filed under (the name read alone, on its panel's sample, on its default sample). */
  keys: string[];
  /** The value's identity (labValueIdentity) is computed by the caller from `parsed`. */
  parsed: ParsedValue;
  /** The sample the result's title names alone (CSF, urine), else null. */
  specimenHint: 'csf' | 'urine' | null;
  /** Dates printed for the result, as printed, each only under its own label (unknown: a title's date with no label). */
  dates: { collected: string | null; resulted: string | null; received: string | null; unknown: string | null };
  /** The performing laboratory as printed, when the page prints one for this result. */
  lab: string | null;
  /** The result's title line as printed (e.g. "CBC [123] (Abnormal)"), when on this page. */
  title: string | null;
  /** Quotes of the row to cite, best first: cells joined by spaces (stream order), then the reading-order line(s). */
  quotes: string[];
  /** Index of the row's first visual line on the page (stable while the page's boxes are unchanged). */
  line: number;
  /** The row carries on a table from the page before (its title, dates and lab are printed there). */
  continued?: boolean;
  /**
   * Where the row's title and dates came from when the page does not print them above it: 'table' (the result the page
   * before left open goes on) or 'title' (the result's title was printed at the bottom of the page before).
   */
  carriedFrom?: 'table' | 'title';
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

type ColKind = 'name' | 'value' | 'range' | 'unit' | 'flag' | 'lab' | 'date' | 'time' | 'method' | 'other';

const HEADER_WORDS: Array<[RegExp, ColKind]> = [
  [/^(?:component|components|test|tests|test name|analyte|lab test|name|test description)$/i, 'name'],
  [/^(?:value|values|result|results|your value|result value|your result)$/i, 'value'],
  [/^(?:range|ref range|ref\. range|reference range|normal range|standard range|reference interval|ref interval|reference values?|normal values?|ref)$/i, 'range'],
  [/^(?:units?)$/i, 'unit'],
  [/^(?:flag|flags|abnormal flag|abn flag|abn|abnormal)$/i, 'flag'],
  [/^(?:lab|performed at|at|performing lab|performing organization|resulting lab)$/i, 'lab'],
  [/^(?:date|collected|collection date|result date|date collected|date resulted)$/i, 'date'],
  [/^(?:time|analysis time)$/i, 'time'],
  [/^(?:test method|method)$/i, 'method'],
  [/^(?:pathologist signature|comment|comments|status|performed at pathologist signature)$/i, 'other'],
];

function headerKind(text: string): ColKind | null {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const [re, kind] of HEADER_WORDS) if (re.test(t)) return kind;
  return null;
}

/** Lines that end a table: another table's header, the next result's title, the result's own trailers. */
const TERMINATOR =
  /^(?:specimen \(source\)|specimen information|testing performed by|anatomical location|narrative|authorizing provider|result type|result status|performing organization|components?$|lab status|resulting lab|ordering provider|filed by|electronically signed|acknowledged by|impression|interpretation:|collection information|order information|reviewed by|result history)/i;
/** A result's title line: "CBC (Final result) [123]", "CBC [123] (Abnormal) | Resulted: ...", "X - Final result (date)". */
const TITLE_LINE = /\[\d{5,}\]|\s-\s(?:final|preliminary|edited|corrected|amended|in process)\s+result\b|\bresulted:/i;
/**
 * A title line for the context of a result (its title, dates and lab): a line that only says "Resulted: <date>" is a
 * label of the result, not its title (a plain report prints "Specimen collected:" above it; 2026-10-09).
 */
function isTitleRow(text: string): boolean {
  return TITLE_LINE.test(text) && !/^resulted\s*:/i.test(text.trim());
}

/** Names that are never a lab result here: vital signs, ECG intervals, scores, a specimen's own fields. */
const NOT_LAB_NAME =
  /^(?:blood pressure|bp|systolic|diastolic|pulse|heart rate|hr|resp|respirations?|respiratory rate|rr|temp|temperature|spo2|sp ?o2|o2 sat|oxygen saturation|weight|wt|height|ht|bmi|body mass index|head circumference|pain|pain score|qtc?|qtc interval|qt interval|qrs|qrs duration|pr|pr interval|p axis|r axis|t axis|ventricular rate|atrial rate|p r interval|extra tube|specimen|source|volume|collection method|laterality|number of cells|cells counted|tube|tube used)\b/i;

/** A result in words (or a titre, "2+"): only these are read as a value in words. */
const RESULT_WORDS =
  /^(?:neg(?:ative)?|pos(?:itive)?|non[- ]?reactive|reactive|not detected|detected|none detected|undetectable|absent|present|normal|abnormal|clear|cloudy|hazy|turbid|bloody|colou?rless|yellow|straw|amber|pink|red|xanthochromic|trace|few|many|rare|occasional|moderate|large|small|none|none seen|not seen|no growth|equivocal|indeterminate|borderline|inconclusive|low|high|(?:\d\+)|(?:1:\d+)|(?:<\s*1:\d+))(?:\s*\((?:a|h|l|abnormal|high|low)\))?$/i;

/** Labels of dates (rule 7): collected, resulted, received. */
const COLLECTED_LABEL = /\b(?:specimen collected|collected(?: by)?|collection (?:date(?:\/time)?|time)|drawn|obtained)\s*:/i;
const RESULTED_LABEL = /\b(?:resulted|result date|reported|verified)\s*:/i;
const RECEIVED_LABEL = /\breceived(?: time)?\s*:/i;
/** A printed date, with a time when one follows ("01/02/19 1504", "03/14/2019 8:41 AM", "2019-03-14 08:41"). */
const DATE_TIME = /\b(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?|\s+\d{4}(?!\d))?|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)/;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** The value read for a lab row: numbers, limits, a value printed as a range, result words; null for anything else. */
function readValue(text: string): ParsedValue | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;
  if (DATE_TIME.test(t) && /^\d{1,4}[/-]/.test(t)) return null;
  const v = parseLabValue(t);
  if (v.kind === 'number' || v.kind === 'censored' || v.kind === 'range') return v;
  if (v.kind === 'text' && RESULT_WORDS.test(t)) return v;
  return null;
}

/** A plausible test name: letters, at most 80 characters, not a header word, not a date or a number. */
function plausibleName(name: string): boolean {
  const n = name.replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 80) return false;
  if (!/[A-Za-z]{2}/.test(n)) return false;
  // A label ("Deficient Range:", "Comment:") is not a test.
  if (/:$/.test(n)) return false;
  if (headerKind(n)) return false;
  if (NOT_LAB_NAME.test(n.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())) return false;
  if (/^(?:comment|note|see|performed|interpretive|reference|this test|result|resulted|status|page)\b/i.test(n)) return false;
  return true;
}

/** The sample a result's title names alone: CSF (or a lumbar puncture) without a blood sample, or urine. */
function specimenOfTitle(title: string | null): 'csf' | 'urine' | null {
  if (!title) return null;
  const k = nameKeyOf(title);
  const csf = CSF_TOKEN.test(k) || /(?:^| )(?:lumbar puncture|spinal tap)(?: |$)/.test(k);
  const blood = BLOOD_SAMPLE.test(k) || /(?:^| )(?:serum|plasma)(?: |$)/.test(k);
  if (csf && !blood) return 'csf';
  if (/(?:^| )(?:urine|urinalysis|ua)(?: |$)/.test(k) && !csf && !blood) return 'urine';
  return null;
}

/** Keys the row may be filed under: the name alone, on its panel's sample, on its default sample (all exact). */
export function rowKeys(analyte: string, specimenHint: string | null): string[] {
  const out = new Set<string>();
  for (const s of [null, specimenHint, defaultSpecimenFor(analyte)]) {
    const k = normalizeAnalyte(analyte, s);
    if (k) out.add(k);
  }
  return [...out];
}

/** True when the analyte table knows one of the row's keys. */
function knownName(keys: readonly string[]): boolean {
  return keys.some((k) => isKnownKey(k));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface Column {
  kind: ColKind;
  x0: number;
  /** The header's words as printed ("Date", "Collected"): which date a date column holds. */
  label?: string;
}

/** A header row of a lab table: its columns left to right, or null. */
function readHeader(row: VisualRow): Column[] | null {
  if (row.parts.length < 2) return null;
  const cols: Column[] = [];
  for (const p of row.parts) {
    const kind = headerKind(p.t);
    if (!kind) return null;
    cols.push({ kind, x0: p.x0, label: p.t.replace(/\s+/g, ' ').trim() });
  }
  if (cols[0].kind !== 'name') return null;
  const vi = cols.findIndex((c) => c.kind === 'value');
  if (vi < 1 || vi > 2) return null;
  // Another sign of a results table beside the value: a range, unit, flag, lab or date column.
  if (!cols.some((c) => c.kind === 'range' || c.kind === 'unit' || c.kind === 'flag' || c.kind === 'lab' || c.kind === 'date' || c.kind === 'time')) return null;
  return cols;
}

const COL_SLACK = 4;

/** The column a part starts in (its left edge within the column's span), or -1 left of the table. */
function columnAt(cols: readonly Column[], x: number): number {
  if (x < cols[0].x0 - 12) return -1;
  let idx = 0;
  for (let i = 0; i < cols.length; i++) if (x >= cols[i].x0 - COL_SLACK) idx = i;
  return idx;
}

interface Cell {
  col: number;
  text: string;
}

/**
 * A part split at the column edges it crosses ("Immunoglobulin G Index 0.55" printed in one box across the test and the
 * value columns). The split falls on the space nearest to each edge (the box's width shared out by characters); null
 * when the part crosses a column with no space to split at (a paragraph across the table).
 */
function splitPart(cols: readonly Column[], part: RowPart, first: number): Cell[] | null {
  const text = part.t.replace(/\s+$/, '');
  let last = first;
  for (let i = first + 1; i < cols.length; i++) if (part.x1 > cols[i].x0 + 2) last = i;
  if (last === first) return [{ col: first, text: text.trim() }];
  // A paragraph: it runs over more than two columns, or is long words.
  if (last - first > 1) return null;
  const w = (part.x1 - part.x0) / Math.max(1, text.length);
  const edge = cols[last].x0;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== ' ') continue;
    const x = part.x0 + (i + 1) * w;
    const d = Math.abs(x - edge);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best < 0 || bestDist > 40) return null;
  const a = text.slice(0, best).trim();
  const b = text.slice(best + 1).trim();
  if (!a || !b) return null;
  return [
    { col: first, text: a },
    { col: last, text: b },
  ];
}

/** A line's cells, or null when a part runs across the table like a paragraph. */
function cellsOf(cols: readonly Column[], row: VisualRow): Cell[] | null {
  const out: Cell[] = [];
  for (const p of row.parts) {
    const t = p.t.trim();
    if (!t) continue;
    const c = columnAt(cols, p.x0);
    if (c < 0) return null;
    const pieces = splitPart(cols, p, c);
    if (!pieces) return null;
    out.push(...pieces);
  }
  return out;
}

interface Building {
  cells: Map<number, string[]>;
  lines: VisualRow[];
  lastY: number;
  /** The columns the row's last line printed in. */
  lastCols: Set<number>;
}

function addCells(b: Building, cells: readonly Cell[]): void {
  for (const c of cells) {
    const list = b.cells.get(c.col) ?? [];
    list.push(c.text);
    b.cells.set(c.col, list);
  }
}

interface TableBlock {
  headerIndex: number;
  cols: Column[];
  rows: Building[];
  endIndex: number;
  /** The table runs to the bottom of the page (only the page's footer after it): it may go on on the next page. */
  open: boolean;
  /** The last line that belonged to a result row (lines after it, up to the next title, are the result's trailer). */
  lastRow: number;
  /**
   * What closed it: the next result's title, a trailer of the result (the specimen table, "Testing Performed By", the
   * next result's order lines), another table's header, or anything else (a comment, a paragraph); null when open.
   */
  closedBy: 'title' | 'terminator' | 'header' | 'other' | null;
}

/** The running footer of a printed page ("Printed on 10/7/26 12:30 AM | Page 76", "Page 3 of 9"). */
const PAGE_FOOTER = /^(?:printed on\b|page \d+(?: of \d+)?$)/i;

function readTable(rows: readonly VisualRow[], headerIndex: number, cols: Column[]): TableBlock {
  const nameCol = cols.findIndex((c) => c.kind === 'name');
  const valueCol = cols.findIndex((c) => c.kind === 'value');
  const out: Building[] = [];
  let cur: Building | null = null;
  const finish = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  let i = headerIndex + 1;
  let open = true;
  let closedBy: TableBlock['closedBy'] = null;
  /** The last line that belonged to a result row: the table is open only when nothing but the footer follows it. */
  let lastRowLine = headerIndex;
  for (; i < rows.length; i++) {
    const row = rows[i];
    const text = row.text.trim();
    if (PAGE_FOOTER.test(text)) break;
    if (readHeader(row) || TERMINATOR.test(text) || TITLE_LINE.test(text)) {
      open = false;
      closedBy = TITLE_LINE.test(text) ? 'title' : readHeader(row) ? 'header' : 'terminator';
      break;
    }
    const cells = cellsOf(cols, row);
    if (!cells) {
      finish();
      continue;
    }
    const hasName = cells.some((c) => c.col === nameCol);
    const hasValue = cells.some((c) => c.col === valueCol);
    if (hasName && hasValue) {
      finish();
      cur = { cells: new Map(), lines: [row], lastY: row.y, lastCols: new Set(cells.map((c) => c.col)) };
      addCells(cur, cells);
      lastRowLine = i;
      continue;
    }
    const b: Building | null = cur;
    // A comment or a note under a row is never part of it ("Comment:", "Note: ...").
    const remark = cells.some((c) => c.col === nameCol && (/^(?:comments?|notes?|footnotes?|reference|interpretation|method)\b/i.test(c.text) || /:$/.test(c.text)));
    // A name continues only right under the name's last line (a test with no value printed below it is not this row).
    const nameBreak = hasName && !(b?.lastCols.has(nameCol) ?? false);
    if (b && !remark && !nameBreak && row.y - b.lastY <= 16) {
      // A line that only continues the row's cells (a wrapped name, a range's second line, a unit, a time).
      addCells(b, cells);
      b.lines.push(row);
      b.lastY = row.y;
      b.lastCols = new Set(cells.map((c) => c.col));
      lastRowLine = i;
      continue;
    }
    finish();
  }
  finish();
  // Open: the rows run to the bottom of the page (a comment, a paragraph, anything but the footer after them closes it).
  if (open) for (let k = lastRowLine + 1; k < rows.length; k++) if (rows[k].text.trim() && !PAGE_FOOTER.test(rows[k].text.trim())) open = false;
  if (!open && !closedBy) closedBy = 'other';
  return { headerIndex, cols, rows: out, endIndex: i, open, closedBy, lastRow: lastRowLine };
}

// ---------------------------------------------------------------------------
// The result's context: title, dates, lab
// ---------------------------------------------------------------------------

export interface BlockContext {
  title: string | null;
  collected: string | null;
  resulted: string | null;
  received: string | null;
  unknown: string | null;
  lab: string | null;
}

function dateAfter(text: string, label: RegExp): string | null {
  const m = label.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const d = DATE_TIME.exec(rest);
  return d ? d[1].replace(/\s+/g, ' ').trim() : null;
}

/** What the lines above a table (up to the result's title) and the trailer below it (the specimen table) print. */
function blockContext(rows: readonly VisualRow[], table: TableBlock, floor: number): BlockContext {
  const ctx: BlockContext = { title: null, collected: null, resulted: null, received: null, unknown: null, lab: null };
  for (let i = table.headerIndex - 1; i >= floor; i--) {
    const row = rows[i];
    for (const p of row.parts) {
      const t = p.t.replace(/\s+/g, ' ').trim();
      if (!ctx.resulted) ctx.resulted = dateAfter(t, RESULTED_LABEL);
      if (!ctx.collected) ctx.collected = dateAfter(t, COLLECTED_LABEL);
      if (!ctx.received) ctx.received = dateAfter(t, RECEIVED_LABEL);
      const lab = /^resulting lab:\s*([^|]+?)\s*$/i.exec(t);
      if (lab && !ctx.lab) ctx.lab = lab[1].trim();
    }
    if (isTitleRow(row.text)) {
      ctx.title = row.parts[0]?.t.replace(/\s+/g, ' ').trim() ?? row.text;
      // "X - Final result (03/14/2019 8:41 AM EST)": a date with no label, of unknown kind.
      const m = /\s-\s(?:final|preliminary|edited|corrected|amended)\s+result\s*\(([^)]*)\)/i.exec(row.text);
      if (m) {
        const d = DATE_TIME.exec(m[1]);
        if (d) ctx.unknown = d[1].replace(/\s+/g, ' ').trim();
      }
      break;
    }
  }
  // Below the table, before the next title (never the next result's own lines): the specimen table's "Collection Time" /
  // "Received Time" cells, labelled dates printed under the table ("Collected by: ... 01/02/19 1504"), and
  // "Performed By: <lab>". Only what the lines above the table did not print.
  for (let i = Math.min(table.lastRow + 1, table.endIndex); i < rows.length; i++) {
    const row = rows[i];
    if (TITLE_LINE.test(row.text) || (i > table.endIndex && readHeader(row))) break;
    if (PAGE_FOOTER.test(row.text.trim())) continue;
    const perf = /^performed by:\s*(.+)$/i.exec(row.text.trim());
    if (perf && !ctx.lab) ctx.lab = perf[1].replace(/\s*\|.*$/, '').trim();
    for (const p of row.parts) {
      const t = p.t.replace(/\s+/g, ' ').trim();
      if (!ctx.collected) ctx.collected = dateAfter(t, COLLECTED_LABEL);
      if (!ctx.resulted) ctx.resulted = dateAfter(t, RESULTED_LABEL);
      if (!ctx.received) ctx.received = dateAfter(t, RECEIVED_LABEL);
    }
    for (const p of row.parts) {
      const label = p.t.replace(/\s+/g, ' ').trim();
      const kind = /^collection time$/i.test(label) ? 'collected' : /^received time$/i.test(label) ? 'received' : null;
      if (!kind || ctx[kind]) continue;
      const next = rows[i + 1];
      const under = next?.parts.find((q) => Math.abs(q.x0 - p.x0) <= 8);
      const d = under ? DATE_TIME.exec(under.t) : null;
      if (d) ctx[kind] = d[1].replace(/\s+/g, ' ').trim();
    }
  }
  return ctx;
}

/** A result's title line: its name and the date it prints with no label ("X - Final result (03/14/2019 8:41 AM)"). */
function readTitle(row: VisualRow, ctx: BlockContext): void {
  ctx.title = row.parts[0]?.t.replace(/\s+/g, ' ').trim() ?? row.text;
  const m = /\s-\s(?:final|preliminary|edited|corrected|amended)\s+result\s*\(([^)]*)\)/i.exec(row.text);
  if (m) {
    const d = DATE_TIME.exec(m[1]);
    if (d) ctx.unknown = d[1].replace(/\s+/g, ' ').trim();
  }
}

/** Labelled dates (and "Resulting lab:") in one line, filling only what is still unknown. */
function readLabels(row: VisualRow, ctx: BlockContext, opts: { received: boolean }): void {
  for (const p of row.parts) {
    const t = p.t.replace(/\s+/g, ' ').trim();
    if (!ctx.resulted) ctx.resulted = dateAfter(t, RESULTED_LABEL);
    if (!ctx.collected) ctx.collected = dateAfter(t, COLLECTED_LABEL);
    if (opts.received && !ctx.received) ctx.received = dateAfter(t, RECEIVED_LABEL);
    const lab = /^resulting lab:\s*([^|]+?)\s*$/i.exec(t);
    if (lab && !ctx.lab) ctx.lab = lab[1].trim();
  }
}

/**
 * The result whose title is printed after the last table of a page (at its bottom): its title, the date in it, and the
 * labelled dates and lab printed under it on this page. A table that starts on the next page under no title of its own
 * is this result's (2026-10-09 review: it must never take the dates of the result that ended above the title).
 */
function titleContext(rows: readonly VisualRow[], titleIndex: number): BlockContext {
  const ctx: BlockContext = { title: null, collected: null, resulted: null, received: null, unknown: null, lab: null };
  readTitle(rows[titleIndex], ctx);
  for (let i = titleIndex; i < rows.length; i++) {
    if (PAGE_FOOTER.test(rows[i].text.trim())) continue;
    readLabels(rows[i], ctx, { received: true });
  }
  return ctx;
}

/**
 * What a plain line's result prints above it on its page: the nearest labelled dates and "Resulting lab:" above the
 * line, up to the result's title (included). Never from another page. A "Received:" stamp is not read here (on a plain
 * page it is as often a fax's as the specimen's).
 */
function contextAbove(rows: readonly VisualRow[], index: number): BlockContext {
  const ctx: BlockContext = { title: null, collected: null, resulted: null, received: null, unknown: null, lab: null };
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (PAGE_FOOTER.test(row.text.trim())) continue;
    readLabels(row, ctx, { received: false });
    if (isTitleRow(row.text)) {
      readTitle(row, ctx);
      break;
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A cell's wrapped lines as printed, joined with a space (quotes are matched against the printed text this way). */
function joinCell(list: readonly string[] | undefined): string {
  return (list ?? []).join(' ').replace(/\s+/g, ' ').trim();
}

/** A cell's wrapped lines for reading: a unit broken after its slash ("mg/" then "dL") is put back together. */
function joinTight(list: readonly string[] | undefined): string {
  return joinCell(list).replace(/\/ (?=[A-Za-zµμ])/g, '/');
}

/** A unit the shared token test does not take because it starts with a power of ten ("10*3/uL", "x10E9/L", "10^6/uL"). */
const POWER_UNIT = /^(?:[x×]\s*)?10\s*(?:\*\*?|\^|[eE])\s*\d{1,2}\s*\/\s*[A-Za-zµμ]+$/;

function isRowUnit(t: string): boolean {
  const s = t.trim();
  return Boolean(s) && (isUnitToken(s) || POWER_UNIT.test(s));
}

/**
 * Range and unit out of a range cell, each as printed ("768 - 1632 mg/dL" -> "768 - 1632" and "mg/dL"; "3.80 - 11.00
 * 10*3/uL" -> "3.80 - 11.00" and "10*3/uL"; "<=12.7 pg/mL"; "Negative"; "ms" -> a unit and no range). A range the
 * parser cannot read is kept whole as printed.
 */
function splitRangeCell(cell: string): { range: string | null; unit: string | null } {
  const t = cell.replace(/\s+/g, ' ').trim();
  if (!t || /^[-–—]+$/.test(t)) return { range: null, unit: null };
  if (isRowUnit(t) && parseRefRange(t).status !== 'parsed') return { range: null, unit: t };
  // The unit printed last in the cell (the result's unit, printed under its range on these reports).
  const tail = /^(.*\S)\s+(\S+)$/.exec(t);
  if (tail && isRowUnit(tail[2])) {
    const head = parseRefRange(tail[1]);
    if (head.status === 'parsed' && head.unitInRange == null) return { range: tail[1], unit: tail[2] };
  }
  const r = parseRefRange(t);
  if (r.status === 'parsed') return { range: t, unit: r.unitInRange };
  return { range: t, unit: null };
}

function tableRow(page: number, table: TableBlock, b: Building, ctx: BlockContext, continued: boolean): FoundLabRow | null {
  const kindAt = (k: ColKind) => table.cols.findIndex((c) => c.kind === k);
  const name = joinCell(b.cells.get(kindAt('name')));
  const valueText = joinTight(b.cells.get(kindAt('value')));
  if (!plausibleName(name)) return null;
  const parsed = readValue(valueText);
  if (!parsed) return null;
  const rangeCol = kindAt('range');
  const unitCol = kindAt('unit');
  const flagCol = kindAt('flag');
  const labCol = kindAt('lab');
  const rangePrinted = rangeCol >= 0 ? joinCell(b.cells.get(rangeCol)) : '';
  const split = splitRangeCell(rangeCol >= 0 ? joinTight(b.cells.get(rangeCol)) : '');
  const unitCell = unitCol >= 0 ? joinTight(b.cells.get(unitCol)) : '';
  const unit = unitCell && isRowUnit(unitCell) ? unitCell : (parsed.unitInValue ?? split.unit);
  const flagCell = flagCol >= 0 ? joinCell(b.cells.get(flagCol)) : null;
  let flag: string | null;
  if (flagCell !== null) flag = flagCell && (isFlagToken(flagCell) || parseFlag(flagCell).state !== 'not_understood') ? flagCell : '';
  else flag = parsed.flagInValue ?? '';
  const labCell = labCol >= 0 ? joinCell(b.cells.get(labCol)) : '';
  // A lab column holding a short code ("XLAB") or a number ("1000000001") names no laboratory; the "Resulting lab:"
  // line does.
  const lab = labCell && !/^[A-Z0-9]{2,6}$/.test(labCell) && !/^[\d\s-]+$/.test(labCell) ? labCell : ctx.lab;
  // A date column: the row's own date ("Component | Value | Date"), of the kind its header names (Collected, Result
  // date), else of unknown kind. A row that prints its own date takes none of the result's (they may be another draw's).
  const dateCol = kindAt('date');
  const dateCell = dateCol >= 0 ? DATE_TIME.exec(joinCell(b.cells.get(dateCol))) : null;
  let dates: FoundLabRow['dates'] = { collected: ctx.collected, resulted: ctx.resulted, received: ctx.received, unknown: ctx.unknown };
  if (dateCell) {
    const label = table.cols[dateCol].label ?? '';
    const d = dateCell[1].replace(/\s+/g, ' ').trim();
    const kind = /collect|drawn/i.test(label) ? 'collected' : /result|report/i.test(label) ? 'resulted' : 'unknown';
    dates = { collected: null, resulted: null, received: null, unknown: null };
    dates[kind] = d;
  }
  const specimenHint = specimenOfTitle(ctx.title);
  const keys = rowKeys(name, specimenHint);
  // A test the analyte table does not know is a lab row only with a printed range the parser reads, or a measurement
  // with its unit (a differential's percentages print no range); a result in words needs its range ("Negative").
  const measured = parsed.kind === 'number' || parsed.kind === 'censored';
  if (!knownName(keys) && !(split.range && parseRefRange(split.range).status === 'parsed') && !(measured && unit)) return null;
  const unitShown = unit && unit !== parsed.unitInValue && !(split.range ?? '').includes(unit) ? unit : null;
  const cells = [name, valueText, ...(split.range ? [split.range] : []), ...(unitShown ? [unitShown] : []), ...(flag ? [flag] : [])];
  const first = b.lines[0];
  // Quoted as printed: the name, the value and the range cell (its unit included) with their line breaks as spaces.
  const quotes = quotesFor([name, joinCell(b.cells.get(kindAt('value'))), rangePrinted || (unitCell ? joinCell(b.cells.get(unitCol)) : '')], first);
  return {
    page,
    layout: 'table',
    text: cells.join(' | '),
    analyte: name,
    value: valueText,
    unit: unit ?? null,
    range: split.range,
    flag,
    keys,
    parsed,
    specimenHint,
    dates,
    lab: lab ?? null,
    title: ctx.title,
    quotes,
    line: first.index,
    ...(continued ? { continued: true } : {}),
  };
}

/** Quotes of a row: its cells joined by spaces (found in the stream-order text), then its first reading-order line. */
function quotesFor(cells: readonly string[], first: VisualRow): string[] {
  const out: string[] = [];
  const spaced = cells.filter((c) => c && c.trim()).join(' ').replace(/\s+/g, ' ').trim();
  if (spaced) out.push(spaced);
  const short = cells.slice(0, 2).filter((c) => c && c.trim()).join(' ').replace(/\s+/g, ' ').trim();
  if (short && short !== spaced) out.push(short);
  const line = first.text.replace(/\s+/g, ' ').trim();
  if (line && !out.includes(line)) out.push(line.slice(0, 300));
  return out;
}

// ---------------------------------------------------------------------------
// Plain rows
// ---------------------------------------------------------------------------

const NUM = String.raw`-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+`;
const SIGN = String.raw`(?:<=|>=|=<|=>|[<>≤≥])`;
const PLAIN_ROW = new RegExp(
  String.raw`^(?<name>[A-Za-z][A-Za-z0-9 ,()'/#%.+-]{1,60}?)\s*[:|]?\s+(?<value>${SIGN}?\s*(?:${NUM}))(?![\d.,])(?:\s*(?<vunit>[A-Za-zµμ%/][^\s|]*(?:\s[A-Za-z][^\s|]*)?))??(?:\s+(?<vflag>H|L|HH|LL|A|C|\(H\)|\(L\)|\*|High|Low))?(?:\s+|\s*\|\s*)(?:\(?\s*(?:ref(?:erence)?(?: range)?:?\s*)?(?<range>(?:${NUM})\s*(?:-|–|to)\s*(?:${NUM})|${SIGN}\s*(?:${NUM}))\s*\)?)(?:\s*(?<runit>[A-Za-zµμ%/][^\s|]*))?(?:\s*[|]?\s*(?<flag>H|L|HH|LL|A|C|\(H\)|\(L\)|\*|High|Low|Abnormal|Normal|N|[-–—]))?\s*$`,
);

function plainRow(page: number, row: VisualRow, ctxOf: () => BlockContext): FoundLabRow | null {
  const line = matchCopy(row.text.replace(/\s*\|\s*/g, ' | '));
  if (line.length > 160) return null;
  const m = PLAIN_ROW.exec(line);
  if (!m?.groups) return null;
  const name = m.groups.name.replace(/[\s:|]+$/, '').trim();
  if (!plausibleName(name)) return null;
  const keys = rowKeys(name, null);
  if (!knownName(keys)) return null;
  const valueText = m.groups.value.replace(/\s+/g, '');
  const parsed = parseLabValue(valueText);
  if (parsed.kind !== 'number' && parsed.kind !== 'censored') return null;
  const range = m.groups.range.trim();
  const r = parseRefRange(range);
  if (r.status !== 'parsed') return null;
  const vunit = m.groups.vunit && isUnitToken(m.groups.vunit) ? m.groups.vunit : null;
  const runit = m.groups.runit && isUnitToken(m.groups.runit) ? m.groups.runit : null;
  if (m.groups.vunit && !vunit) return null;
  if (m.groups.runit && !runit) return null;
  const flag = m.groups.flag ?? m.groups.vflag ?? '';
  const rangeShown = runit ? `${range} ${runit}` : range;
  const cells = [name, valueText + (vunit ? ` ${vunit}` : ''), rangeShown, ...(flag ? [flag] : [])];
  // The labelled dates and lab printed above the line on its page, up to its result's title (2026-10-09 review).
  const ctx = ctxOf();
  return {
    page,
    layout: 'plain',
    text: cells.join(' | '),
    analyte: name,
    value: valueText,
    unit: vunit ?? runit,
    range: rangeShown,
    flag,
    keys,
    parsed,
    specimenHint: null,
    dates: { collected: ctx.collected, resulted: ctx.resulted, received: null, unknown: ctx.unknown },
    lab: ctx.lab,
    title: ctx.title,
    quotes: quotesFor([name, valueText + (vunit ? ` ${vunit}` : ''), rangeShown], row),
    line: row.index,
  };
}

// ---------------------------------------------------------------------------
// A page
// ---------------------------------------------------------------------------

export interface LabRowPage {
  pageNumber: number;
  text: string;
  boxesJson?: string | null;
}

/** A table still open at the bottom of a page: the next page may carry on with it under no header of its own. */
export interface LabTableCarry {
  page: number;
  cols: ReadonlyArray<{ kind: string; x0: number; label?: string }>;
  context: BlockContext;
  /** The rows ran to the bottom of the page: the next page may carry on under no header. */
  open: boolean;
  /**
   * `context` is the result whose title is printed after the last table, at the bottom of the page: a table starting on
   * the next page under no title of its own is that result's.
   */
  fromTitle?: boolean;
  /** The last table's result ended on the page (its trailer or the next result's lines closed it): nothing carries on. */
  ended?: boolean;
}

/** Two headers with the same columns in the same order. */
function sameKinds(a: ReadonlyArray<{ kind: string }>, b: ReadonlyArray<{ kind: string }>): boolean {
  return a.length === b.length && a.every((c, i) => c.kind === b[i].kind);
}

/**
 * The rows at the top of a page that carry on the table left open at the bottom of the page before ("Labs (continued)":
 * the chart print does not repeat the header; its rows may sit a few points left or right of the header's columns).
 * The first line under the running header whose cells fall in the table's columns, shifted by one offset, with a name
 * and a value, starts the rows. Null when the page starts with anything else (a title, a header, a paragraph).
 */
function continuedTable(rows: readonly VisualRow[], carry: LabTableCarry): { start: number; cols: Column[] } | null {
  const base = carry.cols.map((c) => ({ kind: c.kind as ColKind, x0: c.x0, label: c.label }));
  const nameCol = base.findIndex((c) => c.kind === 'name');
  const valueCol = base.findIndex((c) => c.kind === 'value');
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const row = rows[i];
    const text = row.text.trim();
    if (readHeader(row) || TITLE_LINE.test(text) || TERMINATOR.test(text)) return null;
    if (row.parts.length < 2) continue;
    const offset = row.parts[0].x0 - base[nameCol].x0;
    if (Math.abs(offset) > 20) continue;
    const cols = base.map((c) => ({ kind: c.kind, x0: c.x0 + offset, label: c.label }));
    // Every part starts on a column edge (within 3 points), so a running header that happens to fit is never a row.
    if (!row.parts.every((p) => cols.some((c) => Math.abs(c.x0 - p.x0) <= 3))) continue;
    const cells = cellsOf(cols, row);
    if (!cells || !cells.some((c) => c.col === nameCol) || !cells.some((c) => c.col === valueCol)) continue;
    return { start: i, cols };
  }
  return null;
}

/**
 * Every lab result row printed on one page (see the module comment), and the table left open at its bottom (pass it as
 * `carry` to the next page). Deterministic: the same page always gives the same rows in the same order. OCR text
 * appended to a page is not read (its noise would make rows that are not there).
 */
export function readLabRows(page: LabRowPage, carry: LabTableCarry | null = null): { rows: FoundLabRow[]; carry: LabTableCarry | null } {
  const reading = pageReading({ text: page.text ?? '', boxesJson: page.boxesJson ?? null });
  const rows = reading.rows;
  const out: FoundLabRow[] = [];
  const used = new Set<number>();
  let carryOut: LabTableCarry | null = null;
  const fromBefore = carry && carry.page === page.pageNumber - 1 ? carry : null;
  if (reading.source === 'boxes') {
    let floor = 0;
    let last: TableBlock | null = null as TableBlock | null;
    const take = (table: TableBlock, ctx: BlockContext, how: { continued?: boolean; carriedFrom?: 'table' | 'title' }, from: number) => {
      for (let k = from; k < table.endIndex; k++) used.add(k);
      for (const b of table.rows) {
        const r = tableRow(page.pageNumber, table, b, ctx, Boolean(how.continued));
        if (r) out.push(how.carriedFrom ? { ...r, carriedFrom: how.carriedFrom } : r);
      }
      floor = table.endIndex;
      last = table;
      // Closed by the next result's title or by the result's trailer: the result ended on this page.
      carryOut = { page: page.pageNumber, cols: table.cols, context: ctx, open: table.open, ...(table.closedBy === 'title' || table.closedBy === 'terminator' ? { ended: true } : {}) };
    };
    // The table the page before left open, carried on under no header (its result's title and dates are that page's).
    if (fromBefore?.open && !fromBefore.ended && !fromBefore.fromTitle) {
      const cont = continuedTable(rows, fromBefore);
      if (cont) take(readTable(rows, cont.start - 1, cont.cols), fromBefore.context, { continued: true, carriedFrom: 'table' }, cont.start);
    }
    let first = true;
    for (let i = floor; i < rows.length; i++) {
      const cols = readHeader(rows[i]);
      if (!cols) continue;
      const table = readTable(rows, i, cols);
      let ctx = blockContext(rows, table, floor);
      let carriedFrom: 'table' | 'title' | undefined;
      // A table at the top of the page under no title of its own: the result goes on from the page before, whose title,
      // dates and lab are printed there (the page's own, when it prints any, win). Either the result's title was printed
      // at the bottom of that page (its context), or the same result's header is printed again (its table had not
      // ended); never the result that ended there (2026-10-09 review: dates borrowed across a page break).
      if (first && !ctx.title && fromBefore && !rows.slice(0, i).some((r) => isTitleRow(r.text))) {
        const inherit = fromBefore.fromTitle ? fromBefore.context : !fromBefore.ended && sameKinds(cols, fromBefore.cols) ? fromBefore.context : null;
        if (inherit) {
          ctx = { ...inherit, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null)) } as BlockContext;
          carriedFrom = fromBefore.fromTitle ? 'title' : 'table';
        }
      }
      first = false;
      take(table, ctx, { carriedFrom }, i);
      i = table.endIndex - 1;
    }
    // A result's title printed after the last table (at the bottom of the page): its table starts on the next page.
    const after = last ? last.endIndex : 0;
    for (let i = rows.length - 1; i >= after; i--) {
      if (!isTitleRow(rows[i].text)) continue;
      carryOut = { page: page.pageNumber, cols: last ? last.cols : [], context: titleContext(rows, i), open: false, fromTitle: true };
      break;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const r = plainRow(page.pageNumber, rows[i], () => contextAbove(rows, i));
    if (r) out.push(r);
  }
  return { rows: out, carry: carryOut };
}

/** The rows of one page read alone (no table carried over from the page before). */
export function findLabRows(page: LabRowPage): FoundLabRow[] {
  return readLabRows(page).rows;
}

/** A row's identity on its page (page, name key and value identity are added by the caller). */
export function rowNameKey(r: Pick<FoundLabRow, 'analyte'>): string {
  return normalizeKey(r.analyte);
}
