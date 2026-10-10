/**
 * The segmenter (findings D.1.2): a document cut into passages that are read, parsed or skipped on their own.
 *
 * 1. Encounters: the PDF's top-level bookmarks first; else Epic's printed banners (a banner without "(continued)" at
 *    the top of a page followed by the start words Facesheet / Therapy Plan / Care Plan; a mid-page sub-banner before
 *    "Code/Rapid Response Timeline" is not a new encounter); else the whole document.
 * 2. Epic layout: each encounter cut at its section headings (sections.ts), the facesheet's repeated PATIENT /
 *    GUARANTOR / COVERAGE part apart from its ENCOUNTER part, and a section over the size budget cut at its items (a
 *    message, a note, an order, a media item), never inside a message, note, letter or questionnaire. Any other
 *    layout: blocks of pages (at most `maxPagesPerBlock` pages or `maxBlockChars` characters), never worse than before.
 * 3. Every page is accounted for: a page that holds only furniture and a heading is `blank`; an image-free page whose
 *    text repeats an earlier page is a `duplicate` naming its twin (a page carrying an image is never skipped); an
 *    image page whose scan gave no words is `no_text`; one whose OCR failed is `failed`. A section printed empty ("No
 *    documentation.") is skipped as `blank`, a repeat of an earlier passage of the same kind as `duplicate` (never a
 *    message, note, letter or questionnaire), and a facesheet's demographics and insurance that repeat an earlier
 *    one as `boilerplate`, each naming its twin.
 *
 * Pure: the segments service feeds it the stored pages, the page scan and the OCR results, and writes the drafts.
 */
import { parsePartialDate } from '../../../shared/dates';
import type { SegmentKind, SegmentRoute, SegmentSkipReason, SegmentStatus } from '../../../shared/enums';
import {
  encounterKeyOf, SEGMENT_ROUTE_BY_KIND, SEGMENTER_VERSION,
  type SegmentDetail, type SegmentDraftInput, type SegmentPageInfo,
} from '../../../shared/schemas/segments';
import type { PdfOutlineNode } from '../pdf';
import type { VisualRow } from '../reflow';
import { classifyRows, learnFurniture, parseBanner, RE_PATIENT_BANNER, START_WORDS, type FurnitureModel, type RowClass } from './furniture';
import { contentLines, identityHash, lineSetSimilarity, mayBeTwin, passageHash } from './hash';
import { linesChars, pageLines, type SegLine } from './lines';
import { outlineEncounters } from './outline';
import { isEmptyLine, isTimelinePatientLine, ITEM_X, kindForSectionName, NEVER_CUT_KINDS, NEVER_SKIP_KINDS, sameSectionName, sectionHeading, stripSuffixes } from './sections';

/** Target size of an Epic passage, in characters (the engine packs several into one call of about 60,000). */
export const SEGMENT_TARGET_CHARS = 30_000;
/** A page-block segment's character budget (the old chunk budget). */
export const BLOCK_MAX_CHARS = 60_000;
/** A facesheet's repeated part is boilerplate when this similar (line sets) to an earlier one. */
export const FACESHEET_TWIN_SIMILARITY = 0.9;

export interface SegmenterPage {
  page: number;
  rows: VisualRow[];
  source: 'boxes' | 'text';
  /** The stored text (stream order), used as is by layouts read in stored order. */
  storedText: string;
  /** OCR text appended to the page, if any. */
  ocr: string | null;
  imageDigests: string[];
  /** Share of the page covered by images, 0-1. */
  imageCoverage: number;
  /** Top of the image region (points), when the page has images. */
  imageTop: number | null;
  /** What OCR did on this page (this run or an earlier one); null when it never ran. */
  ocrInfo: SegmentPageInfo['ocr'] | null;
  /** Failed OCR attempts in a row on this scan. */
  ocrTries?: number;
}

export interface SegmenterInput {
  pages: SegmenterPage[];
  pageCount: number;
  outline: readonly PdfOutlineNode[];
  /** The PDF says Epic made it (creator), or another hint. */
  epicHint?: boolean;
  /** Page-block fallback: pages per block (ai.maxPagesPerChunk). */
  maxPagesPerBlock: number;
  maxBlockChars?: number;
  targetChars?: number;
}

export interface EncounterInfo {
  key: string;
  start: number;
  end: number;
  headerText: string | null;
  dateText: string | null;
  date: string | null;
  datePrecision: 'day' | 'month' | 'year' | 'unknown';
  type: string | null;
  department: string | null;
  number: string | null;
  patient: boolean;
  source: 'outline' | 'banner' | 'document';
  outlineTitle: string | null;
  /** The key of the first part when the same encounter is printed in two places. */
  sameAs?: string;
  /** Its depth-1 bookmarks (sections), when the PDF has them. */
  children?: Array<{ title: string; page: number | null }>;
}

export interface SegmenterOutput {
  layout: 'epic' | 'outline' | 'pages';
  furniture: FurnitureModel;
  outlineUsed: boolean;
  encounters: EncounterInfo[];
  drafts: SegmentDraftInput[];
  /** Per page: what the segmenter learned (the same object each segment touching the page carries). */
  pageInfos: Map<number, SegmentPageInfo>;
  /** Pages flagged for OCR by the trigger (image share >= 0.1, or under 40 body characters with an image). */
  classes: Map<number, RowClass[]>;
}

/** The OCR trigger (findings D.1.4): an image covering 10% of the page, or a near-empty body over an image. */
export function needsOcr(p: { imageCoverage: number; imageDigests: readonly string[]; bodyChars: number }): boolean {
  return p.imageCoverage >= 0.1 || (p.bodyChars < 40 && p.imageDigests.length > 0);
}

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

/** Encounter starts read from the printed banners (no bookmarks needed). Exported for tests. */
export function bannerStarts(pages: ReadonlyArray<{ page: number; rows: readonly VisualRow[]; classes: readonly RowClass[] }>): Array<{ page: number; title: string; patient: boolean }> {
  const out: Array<{ page: number; title: string; patient: boolean }> = [];
  for (const p of pages) {
    const i = p.classes.findIndex((c, k) => c.banner && c.bannerText && k < 8);
    if (i < 0) continue;
    const title = p.classes[i].bannerText!;
    if (RE_PATIENT_BANNER.test(title)) {
      if (!/\(continued\)$/.test(title)) out.push({ page: p.page, title, patient: true });
      continue;
    }
    const b = parseBanner(title);
    if (!b || b.continued) continue;
    let j = i + 1;
    while (j < p.rows.length && (p.classes[j].banner || p.classes[j].furniture)) j++;
    const next = p.rows[j];
    if (next && (START_WORDS as readonly string[]).includes(next.text.trim())) out.push({ page: p.page, title, patient: false });
  }
  return out;
}

function encounterFromTitle(title: string | null, start: number, end: number, source: EncounterInfo['source'], outlineTitle: string | null): EncounterInfo {
  const patient = Boolean(title && RE_PATIENT_BANNER.test(title));
  const b = title && !patient ? parseBanner(title) : null;
  const pd = b ? parsePartialDate(b.dateText) : null;
  return {
    key: encounterKeyOf(start),
    start,
    end,
    headerText: title,
    dateText: b?.dateText ?? null,
    date: pd?.iso ?? null,
    datePrecision: pd?.iso ? pd.precision : 'unknown',
    type: b?.type ?? null,
    department: b?.department ?? null,
    number: null,
    patient,
    source,
    outlineTitle,
  };
}

/** "Encounter #" printed in a VISIT INFORMATION table: the most frequent number below such a label. */
function encounterNumber(lines: readonly SegLine[]): string | null {
  const counts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].parts.find((p) => /^Encounter #$/.test(p.t.trim()));
    if (!label) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      if (lines[j].page !== lines[i].page) break;
      const v = lines[j].parts.find((p) => Math.abs(p.x0 - label.x0) <= 8 && /^\d{5,}$/.test(p.t.trim()));
      if (v) {
        counts.set(v.t.trim(), (counts.get(v.t.trim()) ?? 0) + 1);
        break;
      }
    }
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
}

// ---------------------------------------------------------------------------
// Sections and pieces
// ---------------------------------------------------------------------------

interface Piece {
  enc: EncounterInfo;
  kind: SegmentKind;
  section: string | null;
  item: string | null;
  lines: SegLine[];
  source: 'section' | 'item' | 'page_block' | 'outline' | 'banner';
  /** The facesheet's repeated part (demographics, guarantor, coverage). */
  facesheetRest?: boolean;
  /** Pages when the piece has no lines (a blank encounter). */
  pages?: [number, number];
  text: 'visual' | 'stored';
}

function itemStart(line: SegLine): boolean {
  return line.x0 !== null && line.x0 >= ITEM_X[0] && line.x0 <= ITEM_X[1];
}

const RE_NOTE_HEADER = /^[A-Z][A-Za-z&/ -]+? by .+? at \d{1,2}\/\d{1,2}\/\d{4} \d{4}$/;
const RE_LETTER_HEADER = /^.+? by .*? on \d{1,2}\/\d{1,2}\/\d{4}$/;
const RE_MEDIA_HEADER = /^.+? - (?:Scan|Document|Electronic signature) on \d{1,2}\/\d{1,2}\/\d{4}/i;

/**
 * Where an item of this kind may start: for messages, notes, letters, questionnaires and media items only at their own
 * header (sub-headings at the same indent inside a note never cut it); elsewhere at any line at the item indent.
 */
function itemStartsAt(lines: readonly SegLine[], i: number, kind: SegmentKind): boolean {
  const l = lines[i];
  if (!itemStart(l)) return false;
  const t = l.text.trim();
  const nextContent = () => {
    for (let j = i + 1; j < lines.length; j++) if (!sectionHeading({ text: lines[j].text, x0: lines[j].x0, parts: lines[j].parts.length })) return lines[j];
    return null;
  };
  switch (kind) {
    case 'note':
    case 'telephone':
      return l.parts.length === 1 && RE_NOTE_HEADER.test(t);
    case 'messages':
    case 'appointment_request': {
      const n = nextContent();
      return Boolean(n && n.parts.some((p) => p.t.trim() === 'From') && n.parts.some((p) => p.t.trim() === 'To'));
    }
    case 'letter':
      return l.parts.length === 1 && RE_LETTER_HEADER.test(t);
    case 'questionnaire': {
      const n = nextContent();
      return Boolean(n && n.parts.some((p) => /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M/i.test(p.t.trim())));
    }
    case 'media':
      return RE_MEDIA_HEADER.test(t);
    default:
      return true;
  }
}

/** Cuts lines at item starts into groups within the budget; an item over the budget is cut at pages unless never-cut. */
function splitByItems(lines: SegLine[], kind: SegmentKind, target: number): Array<{ lines: SegLine[]; item: string | null; byItem: boolean }> {
  const items: SegLine[][] = [];
  lines.forEach((l, i) => {
    if (!items.length || (itemStartsAt(lines, i, kind) && items[items.length - 1].length > 0 && !isLeadOnly(items[items.length - 1]))) items.push([l]);
    else items[items.length - 1].push(l);
  });
  const groups: Array<{ lines: SegLine[]; item: string | null; byItem: boolean }> = [];
  let cur: SegLine[] = [];
  let curItem: string | null = null;
  const flush = () => {
    if (cur.length) groups.push({ lines: cur, item: curItem, byItem: true });
    cur = [];
    curItem = null;
  };
  for (const it of items) {
    const size = linesChars(it);
    if (size > target && !NEVER_CUT_KINDS.has(kind)) {
      flush();
      for (const g of splitByPages(it, target)) groups.push({ lines: g, item: itemTitle(it), byItem: true });
      continue;
    }
    if (cur.length && linesChars(cur) + size > target) flush();
    if (!cur.length) curItem = itemTitle(it);
    cur.push(...it);
  }
  flush();
  return groups;
}

/** A group made only of a section heading (it stays with the item after it). */
function isLeadOnly(lines: SegLine[]): boolean {
  return lines.every((l) => sectionHeading({ text: l.text, x0: l.x0, parts: l.parts.length }) !== null);
}

function itemTitle(lines: SegLine[]): string | null {
  const first = lines.find((l) => itemStart(l));
  return first ? first.text.slice(0, 200) : null;
}

/** Lines cut at page boundaries into groups within the budget (a page is never cut). */
function splitByPages(lines: SegLine[], target: number): SegLine[][] {
  const byPage = new Map<number, SegLine[]>();
  for (const l of lines) {
    const list = byPage.get(l.page) ?? [];
    list.push(l);
    byPage.set(l.page, list);
  }
  const out: SegLine[][] = [];
  let cur: SegLine[] = [];
  for (const [, pl] of [...byPage].sort((a, b) => a[0] - b[0])) {
    if (cur.length && linesChars(cur) + linesChars(pl) > target) {
      out.push(cur);
      cur = [];
    }
    cur.push(...pl);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** An Epic encounter cut into section pieces (then items when over budget). */
function epicPieces(enc: EncounterInfo, lines: SegLine[], target: number): Piece[] {
  if (!lines.length) return [{ enc, kind: 'other', section: null, item: null, lines: [], source: 'section', pages: [enc.start, enc.end], text: 'visual' }];
  type Sec = { name: string | null; kind: SegmentKind; lines: SegLine[] };
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  // With bookmarks, the sections are exactly the encounter's depth-1 bookmarks (a heading printed inside a note, such
  // as "Imaging" in a progress note, is not one). Without them, a heading inside a note that is not signed yet is the
  // note's own.
  const children = (enc.children ?? []).filter((c): c is { title: string; page: number } => c.page !== null);
  let ptr = 0;
  let noteOpen = false;
  for (const l of lines) {
    let h = sectionHeading({ text: l.text, x0: l.x0, parts: l.parts.length }, { patientBlock: enc.patient });
    if (children.length) {
      while (ptr < children.length && children[ptr].page < l.page) ptr++;
      const c = children[ptr];
      if (c && c.page === l.page && l.parts.length === 1 && sameSectionName(l.text, c.title)) {
        const name = stripSuffixes(c.title).name;
        h = { name, continued: false, group: null, kind: kindForSectionName(c.title, { patientBlock: enc.patient }), text: l.text };
        ptr++;
      } else if (h && !(h.continued && cur && cur.name === h.name)) {
        h = null;
      }
    } else if (h && noteOpen && cur?.kind === 'note' && h.name !== 'All Encounter Notes') {
      h = null;
    }
    if (cur?.kind === 'note') {
      if (l.parts.length === 1 && RE_NOTE_HEADER.test(l.text.trim())) noteOpen = true;
      else if (/^Electronically signed by .+ at \d{1,2}\/\d{1,2}\/\d{4}/i.test(l.text.trim())) noteOpen = false;
    }
    if (h) {
      if (h.continued && cur && cur.name === h.name) {
        cur.lines.push(l);
        continue;
      }
      noteOpen = false;
      const sec: Sec = { name: h.name, kind: h.kind, lines: [l] };
      // The timeline block prints the patient line (and its wrap and "--/--") just before its own heading.
      if (h.name === 'Code/Rapid Response Timeline' && cur) {
        const k = cur.lines.findIndex((x, idx) => idx >= cur!.lines.length - 4 && isTimelinePatientLine(x.text));
        if (k >= 0) sec.lines.unshift(...cur.lines.splice(k));
      }
      secs.push(sec);
      cur = sec;
      continue;
    }
    if (!cur) {
      cur = { name: null, kind: enc.patient ? 'patient_summary' : 'visit_info', lines: [] };
      secs.push(cur);
    }
    cur.lines.push(l);
  }
  const pieces: Piece[] = [];
  for (const s of secs.filter((x) => x.lines.length)) {
    if (s.kind === 'facesheet') {
      const k = s.lines.findIndex((l) => l.text.trim() === 'PATIENT');
      if (k > 0) {
        pieces.push({ enc, kind: 'facesheet', section: s.name, item: null, lines: s.lines.slice(0, k), source: 'section', text: 'visual' });
        pieces.push({ enc, kind: 'facesheet', section: s.name, item: 'PATIENT', lines: s.lines.slice(k), source: 'section', facesheetRest: true, text: 'visual' });
        continue;
      }
    }
    if (linesChars(s.lines) <= target) {
      pieces.push({ enc, kind: s.kind, section: s.name, item: null, lines: s.lines, source: 'section', text: 'visual' });
      continue;
    }
    for (const g of splitByItems(s.lines, s.kind, target)) pieces.push({ enc, kind: s.kind, section: s.name, item: g.item, lines: g.lines, source: 'item', text: 'visual' });
  }
  return pieces;
}

/** Blocks of pages for a layout the segmenter does not know (the model reads the stored text, as before). */
function blockPieces(enc: EncounterInfo, pages: readonly SegmenterPage[], maxPages: number, maxChars: number, source: Piece['source']): Piece[] {
  const out: Piece[] = [];
  let block: SegmenterPage[] = [];
  let chars = 0;
  const flush = () => {
    if (!block.length) return;
    out.push({ enc, kind: 'pages', section: null, item: null, lines: [], source, pages: [block[0].page, block[block.length - 1].page], text: 'stored' });
    block = [];
    chars = 0;
  };
  for (const p of pages) {
    if (p.page < enc.start || p.page > enc.end) continue;
    const len = p.storedText.length;
    if (block.length && (block.length >= maxPages || chars + len > maxChars)) flush();
    block.push(p);
    chars += len;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// The segmenter
// ---------------------------------------------------------------------------

export function segmentPages(input: SegmenterInput): SegmenterOutput {
  const target = input.targetChars ?? SEGMENT_TARGET_CHARS;
  const maxChars = input.maxBlockChars ?? BLOCK_MAX_CHARS;
  const pages = [...input.pages].sort((a, b) => a.page - b.page);
  const furniture = learnFurniture(pages.filter((p) => p.source === 'boxes').map((p) => p.rows), { epicHint: input.epicHint });
  const classes = new Map<number, RowClass[]>();
  const linesByPage = new Map<number, SegLine[]>();
  for (const p of pages) {
    const c = classifyRows(p.rows, furniture);
    classes.set(p.page, c);
    linesByPage.set(p.page, pageLines({ page: p.page, rows: p.rows, classes: c, source: p.source }));
  }

  // --- page infos and page-level states --------------------------------------------------------------------------
  const pageInfos = new Map<number, SegmentPageInfo>();
  const twinOf = new Map<string, number>();
  for (const p of pages) {
    const lines = linesByPage.get(p.page) ?? [];
    const content = contentLines(lines);
    const bodyChars = lines.reduce((n, l) => n + l.text.length, 0);
    const hash = identityHash(lines, p.imageDigests, p.ocr);
    const info: SegmentPageInfo = { page: p.page, hash, bodyChars };
    if (p.imageDigests.length) info.imageDigests = [...p.imageDigests];
    if (p.imageCoverage > 0) info.imageCoverage = Math.min(1, Math.max(0, p.imageCoverage));
    if (p.ocrInfo) info.ocr = p.ocrInfo;
    if (p.ocrTries) (info as Record<string, unknown>).ocrTries = p.ocrTries;
    if (p.imageTop !== null && p.imageDigests.length) (info as Record<string, unknown>).imageRow = imageRowOf(p.rows, p.imageTop);
    const hasImage = p.imageDigests.length > 0;
    const ocrFailed = Boolean(p.ocrInfo?.error);
    if (ocrFailed && needsOcr({ imageCoverage: p.imageCoverage, imageDigests: p.imageDigests, bodyChars })) {
      info.state = 'failed';
    } else if (!p.storedText.trim() && !hasImage) {
      info.state = 'no_text';
      info.skipReason = 'no_text';
    } else if (hasImage && !content.length && !p.ocr && p.ocrInfo && !p.ocrInfo.error) {
      info.state = 'no_text';
      info.skipReason = 'no_text';
    } else if (!content.length && !hasImage && !p.ocr && (furniture.epic || furniture.header.size || furniture.footer.size) && lines.length < (p.rows.length || 1)) {
      info.state = 'skipped';
      info.skipReason = 'blank';
    } else if (content.length && mayBeTwin({ imageDigests: p.imageDigests, imageCoverage: p.imageCoverage }) && !p.ocr) {
      const twin = twinOf.get(hash);
      if (twin !== undefined) {
        info.state = 'skipped';
        info.skipReason = 'duplicate';
        info.twinPage = twin;
      } else twinOf.set(hash, p.page);
    }
    pageInfos.set(p.page, info);
  }

  // --- encounters -----------------------------------------------------------------------------------------------
  const pageCount = Math.max(input.pageCount, pages.length ? pages[pages.length - 1].page : 0);
  const fromOutline = outlineEncounters(input.outline, pageCount);
  const outlineEpic = fromOutline.length > 0 && fromOutline.filter((e) => parseBanner(e.title) || RE_PATIENT_BANNER.test(e.title)).length >= Math.max(1, Math.ceil(fromOutline.length * 0.8));
  const epic = furniture.epic || outlineEpic;
  if (epic && !furniture.epic) furniture.epic = true;
  let encounters: EncounterInfo[] = [];
  let outlineUsed = false;
  if (fromOutline.length) {
    outlineUsed = true;
    if (fromOutline[0].page > 1) encounters.push(encounterFromTitle(null, 1, fromOutline[0].page - 1, 'outline', null));
    for (const e of fromOutline) encounters.push({ ...encounterFromTitle(e.title, e.page, e.endPage, 'outline', e.title), children: e.children });
  } else if (epic) {
    const starts = bannerStarts(pages.map((p) => ({ page: p.page, rows: p.rows, classes: classes.get(p.page)! })));
    if (starts.length) {
      if (starts[0].page > 1) encounters.push(encounterFromTitle(null, 1, starts[0].page - 1, 'banner', null));
      starts.forEach((s, i) => encounters.push(encounterFromTitle(s.title, s.page, i + 1 < starts.length ? starts[i + 1].page - 1 : pageCount, 'banner', null)));
    }
  }
  if (!encounters.length && pageCount > 0) encounters = [encounterFromTitle(null, 1, pageCount, 'document', null)];

  // Prefer the banner as printed on the encounter's first page (wrapped lines joined) over the bookmark title.
  for (const enc of encounters) {
    const c = classes.get(enc.start);
    const printed = c?.find((x) => x.banner && x.bannerText)?.bannerText ?? null;
    if (printed && epic && (!enc.headerText || parseBanner(printed) || RE_PATIENT_BANNER.test(printed))) {
      const replaced = encounterFromTitle(printed.replace(/ \(continued\)$/, ''), enc.start, enc.end, enc.source, enc.outlineTitle);
      Object.assign(enc, { ...replaced, key: enc.key });
    }
    if (epic) {
      const lines: SegLine[] = [];
      for (let p = enc.start; p <= enc.end; p++) lines.push(...(linesByPage.get(p) ?? []));
      enc.number = encounterNumber(lines);
    }
  }

  // One encounter printed in two places (the same banner, date, type and department): the later part points at the
  // first (`detail.encounterSameAs`), so its messages join the same threads; each part keeps its own pages.
  const firstByTitle = new Map<string, EncounterInfo>();
  for (const enc of encounters) {
    if (!epic || enc.patient || !enc.headerText || !enc.date) continue;
    const t = enc.headerText.replace(/\s+/g, ' ').trim();
    const first = firstByTitle.get(t);
    if (first) enc.sameAs = first.key;
    else firstByTitle.set(t, enc);
  }

  // --- pieces ------------------------------------------------------------------------------------------------------
  const pieces: Piece[] = [];
  for (const enc of encounters) {
    if (epic) {
      const lines: SegLine[] = [];
      for (let p = enc.start; p <= enc.end; p++) lines.push(...(linesByPage.get(p) ?? []));
      const ps = epicPieces(enc, lines, target);
      // Pages no line touches (blank, or an image only) belong to the piece before them, or the first one.
      pieces.push(...ps);
    } else {
      pieces.push(...blockPieces(enc, pages, Math.max(1, input.maxPagesPerBlock), maxChars, enc.source === 'outline' ? 'outline' : 'page_block'));
    }
  }

  // --- drafts ------------------------------------------------------------------------------------------------------
  const drafts: SegmentDraftInput[] = [];
  const ranges = pieces.map((pc) => pieceRange(pc));
  // Stretch pieces over pages no piece touches, within their encounter (every page is in some segment).
  for (let i = 0; i < pieces.length; i++) {
    const enc = pieces[i].enc;
    const next = i + 1 < pieces.length && pieces[i + 1].enc === enc ? ranges[i + 1] : null;
    if (i === 0 || pieces[i - 1].enc !== enc) ranges[i].pageStart = Math.min(ranges[i].pageStart, enc.start);
    if (next) ranges[i].pageEnd = Math.max(ranges[i].pageEnd, next.pageStart - 1);
    else ranges[i].pageEnd = Math.max(ranges[i].pageEnd, enc.end);
  }
  const seenText = new Map<string, number>();
  const facesheetRests: Array<{ seq: number; lines: string[] }> = [];
  pieces.forEach((pc, i) => {
    const r = ranges[i];
    const seq = drafts.length;
    // A line range only where another piece shares the first or last page.
    const prevSame = i > 0 && ranges[i - 1].pageEnd === r.pageStart && pc.lines.length > 0 && pieces[i - 1].lines.length > 0;
    const nextSame = i + 1 < pieces.length && ranges[i + 1].pageStart === r.pageEnd && pc.lines.length > 0 && pieces[i + 1].lines.length > 0;
    const startLine = prevSame ? pc.lines[0].rowIndex : undefined;
    const endLine = nextSame ? pc.lines[pc.lines.length - 1].rowIndex : undefined;
    const infos: SegmentPageInfo[] = [];
    const pieceHashes: string[] = [];
    let ownsImage = false;
    for (let p = r.pageStart; p <= r.pageEnd; p++) {
      const info = pageInfos.get(p) ?? { page: p };
      infos.push(info);
      const pg = pages.find((x) => x.page === p);
      if (pc.text === 'stored') {
        pieceHashes.push(info.hash ?? '');
        if (pg?.imageDigests.length) ownsImage = true;
        continue;
      }
      const own = pc.lines.filter((l) => l.page === p);
      const imageRow = (info as Record<string, unknown>).imageRow as number | undefined;
      const owner = pg && pg.imageDigests.length ? ownsRow(imageRow ?? Number.MAX_SAFE_INTEGER, p === r.pageStart ? startLine : undefined, p === r.pageEnd ? endLine : undefined) : false;
      if (owner) ownsImage = true;
      pieceHashes.push(identityHash(own, owner ? pg!.imageDigests : [], owner ? pg!.ocr : null));
    }
    const textHash = passageHash(pieceHashes);

    let kind: SegmentKind = pc.kind;
    let route: SegmentRoute | undefined;
    let routeReason: string | undefined;
    if (kind === 'note' && pc.lines.some((l) => /^Telephone Encounter by .+ at \d{1,2}\/\d{1,2}\/\d{4} \d{4}$/.test(l.text))) {
      const headers = pc.lines.filter((l) => /^[A-Z][A-Za-z&/ -]+? by .+? at \d{1,2}\/\d{1,2}\/\d{4} \d{4}$/.test(l.text));
      if (headers.length && headers.every((l) => l.text.startsWith('Telephone Encounter by '))) kind = 'telephone';
      else {
        route = 'parse_and_extract';
        routeReason = 'its telephone notes are also listed in Calls & Messages';
      }
    }
    if (kind === 'media' && pc.lines.some((l) => /^.+? - (?:Scan|Document|Electronic signature) on \d{1,2}\/\d{1,2}\/\d{4}/.test(l.text))) {
      route = 'parse_and_extract';
      routeReason = 'its media items are listed (attachments of messages, scanned call records)';
    }

    // Segment-level skips.
    let status: SegmentStatus = 'pending';
    let skipReason: SegmentSkipReason | null = null;
    let duplicateOfSeq: number | null = null;
    const ownText = pc.lines.map((l) => l.text);
    const content = contentLines(pc.lines);
    const pageStates = infos.map((x) => x.state);
    if (pc.text === 'visual' && pc.lines.length && !ownsImage && !NEVER_SKIP_KINDS.has(kind) && contentLines(pc.lines).every((l) => isEmptyLine(l.text) || (isTimelineBlock(pc) && timelineFurniture(l.text)))) {
      const twin = seenText.get(`empty|${kind}|${textHash}`);
      status = 'skipped';
      skipReason = twin !== undefined ? 'boilerplate' : 'blank';
      duplicateOfSeq = twin ?? null;
      if (twin === undefined) seenText.set(`empty|${kind}|${textHash}`, seq);
      route = 'skip';
      routeReason = 'printed empty';
    } else if (pc.facesheetRest && !ownsImage) {
      const twin = facesheetRests.find((f) => lineSetSimilarity(f.lines, ownText) >= FACESHEET_TWIN_SIMILARITY);
      if (twin) {
        kind = 'boilerplate';
        status = 'skipped';
        skipReason = 'boilerplate';
        duplicateOfSeq = twin.seq;
        route = 'skip';
        routeReason = 'the facesheet repeats an earlier one (demographics, guarantor, coverage)';
      } else facesheetRests.push({ seq, lines: ownText });
    } else if (pc.text === 'visual' && pc.lines.length && !ownsImage && !NEVER_SKIP_KINDS.has(kind) && content.length) {
      const key = `${kind}|${textHash}`;
      const twin = seenText.get(key);
      if (twin !== undefined) {
        status = 'skipped';
        skipReason = 'duplicate';
        duplicateOfSeq = twin;
        route = 'skip';
        routeReason = 'the same text is printed earlier in this document';
      } else seenText.set(key, seq);
    }
    if (status === 'pending' && pageStates.length && pageStates.every((s) => s === 'skipped' || s === 'no_text')) {
      const allNoText = pageStates.every((s) => s === 'no_text');
      status = allNoText ? 'no_text' : 'skipped';
      skipReason = allNoText ? 'no_text' : (infos.find((x) => x.state === 'skipped')?.skipReason ?? 'blank');
      route = 'skip';
      routeReason = 'every page is accounted for without reading';
    }

    const detail: SegmentDetail & Record<string, unknown> = {
      segmenter: SEGMENTER_VERSION,
      route: route ?? SEGMENT_ROUTE_BY_KIND[kind],
      ...(routeReason ? { routeReason } : {}),
      source: pc.source,
      ...(pc.enc.source !== 'document' ? { encounterKey: pc.enc.key, encounterPages: [pc.enc.start, pc.enc.end] as [number, number] } : {}),
      ...(pc.enc.sameAs ? { encounterSameAs: pc.enc.sameAs } : {}),
      section: pc.section,
      item: pc.item,
      ...(pc.enc.outlineTitle ? { outlinePath: [pc.enc.outlineTitle, ...(pc.section ? [pc.section] : [])] } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      pages: infos,
      text: pc.text,
      chars: pc.text === 'visual' ? linesChars(pc.lines) + (ownsImage ? ocrCharsOf(pages, r) : 0) : storedChars(pages, r),
      encounterSource: pc.enc.source,
    };
    drafts.push({
      seq,
      pageStart: r.pageStart,
      pageEnd: r.pageEnd,
      kind,
      headerText: pc.enc.headerText,
      encounterDate: pc.enc.date,
      encounterDatePrecision: pc.enc.datePrecision,
      encounterDateText: pc.enc.dateText,
      encounterType: pc.enc.type,
      department: pc.enc.department,
      encounterNumber: pc.enc.number,
      textHash,
      status,
      skipReason,
      duplicateOfSeq,
      detail,
    });
  });

  return { layout: epic ? 'epic' : outlineUsed ? 'outline' : 'pages', furniture, outlineUsed, encounters, drafts, pageInfos, classes };
}

function pieceRange(pc: Piece): { pageStart: number; pageEnd: number } {
  if (pc.pages) return { pageStart: pc.pages[0], pageEnd: pc.pages[1] };
  return { pageStart: pc.lines[0].page, pageEnd: pc.lines[pc.lines.length - 1].page };
}

/** The row an image starts at (the first row at or below the image's top); rows.length when below every row. */
function imageRowOf(rows: readonly VisualRow[], imageTop: number): number {
  const r = rows.find((x) => x.y >= imageTop - 1);
  return r ? r.index : rows.length;
}

/** Whether a segment's line range on a page includes the image's row. */
export function ownsRow(imageRow: number, startLine: number | undefined, endLine: number | undefined): boolean {
  if (startLine !== undefined && imageRow < startLine) return false;
  if (endLine !== undefined && imageRow > endLine) return false;
  return true;
}

function isTimelineBlock(pc: Piece): boolean {
  return pc.section === 'Code/Rapid Response Timeline' || pc.section === 'Patient Care Timeline';
}

/** The timeline block's own print: the patient line, its wrapped department, "--/--". */
function timelineFurniture(text: string): boolean {
  const t = text.trim();
  return isTimelinePatientLine(t) || /^--\/--$/.test(t) || /,$/.test(t) || isEmptyLine(t) || /^Patient Care Timeline$/.test(t);
}

function ocrCharsOf(pages: readonly SegmenterPage[], r: { pageStart: number; pageEnd: number }): number {
  let n = 0;
  for (const p of pages) if (p.page >= r.pageStart && p.page <= r.pageEnd && p.ocr) n += p.ocr.length;
  return n;
}

function storedChars(pages: readonly SegmenterPage[], r: { pageStart: number; pageEnd: number }): number {
  let n = 0;
  for (const p of pages) if (p.page >= r.pageStart && p.page <= r.pageEnd) n += p.storedText.length;
  return n;
}
