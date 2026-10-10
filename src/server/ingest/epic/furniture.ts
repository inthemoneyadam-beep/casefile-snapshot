/**
 * Page furniture: what repeats on every page and is not the page's own content. Epic chart prints carry a running
 * header (the printing facility at the left, the patient's name and MRN line at the right), an encounter context line
 * ("Visit date: ..." or "Adm: ..., D/C: ..."; on a plan block it is the PRINT date, never the encounter's), the
 * encounter banner ("MM/DD/YYYY - <type>[ in <department>][ (continued)]", wrapped titles joined) and the footer
 * ("Printed on <stamp>" and "Page N", which can sit anywhere in the stored stream). Other layouts: the header and
 * footer are learned as the top and bottom lines identical (digits aside) on at least 80% of pages.
 *
 * Furniture is classified per PART of a visual row (a header part shares its row with the context line). It is removed
 * only for comparison (page identity, blank pages) and for the text the model is given; the stored text is never
 * changed. Pure.
 */
import { normalizeKey } from '../../../shared/text';
import type { VisualRow } from '../reflow';

export type FurnitureKind = 'header' | 'footer' | 'context' | 'banner' | 'continued';

/** "Printed on 7/17/30 1:05 AM" (the print stamp of the whole export). */
export const RE_PRINTED = /^Printed on (\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}\s*[AP]M)$/i;
/** "Page 48" / "Page 48 of 1840". */
export const RE_PAGE_NO = /^Page (\d+)(?: of \d+)?$/i;
/** The patient line of the running header. */
export const RE_MRN = /^MRN:\s*[\w-]+,\s*DOB:\s*\d{1,2}\/\d{1,2}\/\d{4},\s*(?:Legal\s+)?Sex:\s*\S+$/i;
/** The encounter context line: "Visit date: 7/15/2030", "Adm: 6/9/2030, D/C: 6/12/2030", with "—" placeholders. */
export const RE_CONTEXT = /^(?:Visit date:\s*(?:\d{1,2}\/\d{1,2}\/\d{4}|[—–-])|Adm:\s*(?:\d{1,2}\/\d{1,2}\/\d{4}|[—–-]),\s*D\/C:\s*(?:\d{1,2}\/\d{1,2}\/\d{4}|[—–-]))$/;
/** An encounter banner as printed (after wrapped lines are joined). */
export const RE_BANNER = /^(\d{2}\/\d{2}\/\d{4}) - (.+)$/;
/** The patient-level block's banner. */
export const RE_PATIENT_BANNER = /^Patient(?: \(continued\))?$/;
/** Words printed centred under the banner of an encounter's first page (the start signature). */
export const START_WORDS = ['Facesheet', 'Therapy Plan', 'Care Plan'] as const;
/** Centred words that are never part of a wrapped banner title. */
const SUB_BANNER_WORDS = new Set(['Facesheet', 'Therapy Plan', 'Care Plan', 'Code/Rapid Response Timeline', 'Learning Assessment']);

/** Banner rows are centred on the page: their middle within this many points of the banner centre. */
const BANNER_CENTRE_TOLERANCE = 8;
/** A letter-size page's middle, used until the document's own banners say otherwise. */
const DEFAULT_BANNER_CENTRE = 306;
/** A wrapped banner title's next line follows within this many points. */
const BANNER_WRAP_GAP = 14;
/** A learned header or footer appears on at least this share of pages. */
const LEARN_SHARE = 0.8;

export interface FurnitureModel {
  /** Epic chart print markers found (footer stamp and MRN line on most pages, or Epic's outline). */
  epic: boolean;
  /** Normalised texts learned as running header / footer parts. */
  header: Set<string>;
  footer: Set<string>;
  /** "Printed on 7/17/30 1:05 AM" as printed (the most common stamp), and its day. */
  printedText: string | null;
  /** The printing facility (the first part of the first header row) as printed. */
  institutionText: string | null;
  /** The patient's name as the running header prints it ("Last, First Middle"). */
  patientName: string | null;
  /** The horizontal middle of the encounter banners (they are centred), in points. */
  bannerCentre?: number;
}

/** Digits masked, case and spacing folded: how a repeated line is recognised. */
export function furnitureKey(t: string): string {
  return normalizeKey(t.replace(/\d+/g, '#')).replace(/\s+/g, ' ');
}

function isTopBand(row: VisualRow, rows: readonly VisualRow[]): boolean {
  return row.index < 4 && rows.length >= 5;
}

function isBottomBand(row: VisualRow, rows: readonly VisualRow[]): boolean {
  return row.index >= rows.length - 2 && rows.length >= 5;
}

/**
 * Learns the furniture of a document from all its pages (rows in reading order). Conservative: only pages with at
 * least five rows teach anything, a line must recur on 80% of at least three such pages, and a page's only content
 * is never furniture.
 */
export function learnFurniture(pages: ReadonlyArray<readonly VisualRow[]>, opts: { epicHint?: boolean } = {}): FurnitureModel {
  const top = new Map<string, number>();
  const bottom = new Map<string, number>();
  let teaching = 0;
  let printed = 0;
  let mrn = 0;
  const stamps = new Map<string, number>();
  const institutions = new Map<string, number>();
  const names = new Map<string, number>();
  const centres: number[] = [];
  for (const rows of pages) {
    for (const row of rows.slice(0, 6)) if (row.parts.length === 1 && RE_BANNER.test(row.text)) centres.push(rowCentre(row));
    const seenTop = new Set<string>();
    const seenBottom = new Set<string>();
    for (const row of rows) {
      for (const p of row.parts) {
        const t = p.t.trim();
        const pm = RE_PRINTED.exec(t);
        if (pm) {
          printed++;
          stamps.set(t, (stamps.get(t) ?? 0) + 1);
        }
        if (RE_MRN.test(t)) mrn++;
      }
    }
    if (rows.length >= 5) {
      teaching++;
      for (const row of rows) {
        if (isTopBand(row, rows)) for (const p of row.parts) seenTop.add(furnitureKey(p.t));
        if (isBottomBand(row, rows)) for (const p of row.parts) seenBottom.add(furnitureKey(p.t));
      }
      for (const k of seenTop) if (k) top.set(k, (top.get(k) ?? 0) + 1);
      for (const k of seenBottom) if (k) bottom.set(k, (bottom.get(k) ?? 0) + 1);
      const first = rows[0];
      if (first && first.parts.length) {
        institutions.set(first.parts[0].t.trim(), (institutions.get(first.parts[0].t.trim()) ?? 0) + 1);
        if (first.parts.length > 1) names.set(first.parts[first.parts.length - 1].t.trim(), (names.get(first.parts[first.parts.length - 1].t.trim()) ?? 0) + 1);
      }
    }
  }
  const total = pages.length;
  const epic = Boolean(opts.epicHint) || (total > 0 && printed >= Math.max(1, total * 0.8) && mrn >= Math.max(1, total * 0.8));
  const header = new Set<string>();
  const footer = new Set<string>();
  if (teaching >= 3) {
    const need = Math.ceil(teaching * LEARN_SHARE);
    for (const [k, n] of top) if (n >= need) header.add(k);
    for (const [k, n] of bottom) if (n >= need && !header.has(k)) footer.add(k);
  }
  const most = (m: Map<string, number>): string | null => {
    let best: string | null = null;
    let bn = 0;
    for (const [k, n] of m) if (n > bn) [best, bn] = [k, n];
    return best && bn >= Math.max(1, Math.ceil(teaching * LEARN_SHARE)) ? best : null;
  };
  const institutionText = epic ? most(institutions) : null;
  const patientName = epic ? most(names) : null;
  centres.sort((a, b) => a - b);
  return {
    epic,
    header,
    footer,
    printedText: [...stamps].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    institutionText,
    patientName,
    bannerCentre: centres.length ? Math.round(centres[Math.floor(centres.length / 2)] * 10) / 10 : DEFAULT_BANNER_CENTRE,
  };
}

/** The horizontal middle of a row. */
export function rowCentre(row: VisualRow): number {
  const right = Math.max(...row.parts.map((p) => p.x1));
  return (row.x0 + right) / 2;
}

/** The print stamp's day ("Printed on 7/17/30 1:05 AM" -> 2030-07-17), or null. */
export function printedDay(printedText: string | null): string | null {
  const m = printedText ? RE_PRINTED.exec(printedText) : null;
  if (!m) return null;
  const [mo, d, y] = m[1].split('/').map(Number);
  const year = y < 100 ? 2000 + y : y;
  if (!mo || !d || mo > 12 || d > 31) return null;
  return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** One row's furniture classification: per part (null = the page's own content). */
export interface RowClass {
  parts: Array<FurnitureKind | null>;
  /** Every part is furniture. */
  furniture: boolean;
  /** The row is (part of) an encounter banner; `bannerText` set on its first row with the wrapped title joined. */
  banner: boolean;
  bannerText?: string;
}

function isCentred(row: VisualRow, model: FurnitureModel): boolean {
  return Math.abs(rowCentre(row) - (model.bannerCentre ?? DEFAULT_BANNER_CENTRE)) <= BANNER_CENTRE_TOLERANCE;
}

function isBannerStartRow(row: VisualRow, model: FurnitureModel): boolean {
  return row.parts.length === 1 && RE_BANNER.test(row.text) && isCentred(row, model);
}

/**
 * Classifies every row of a page. Banners are recognised only in an Epic layout (a banner row is a single centred
 * part matching RE_BANNER; a wrapped title continues on the next centred single-part row within BANNER_WRAP_GAP
 * points, and "(continued)" may sit alone on that row). Learned header and footer parts are recognised anywhere in
 * the top four and bottom two rows; Epic's footer and context line anywhere on the page.
 */
export function classifyRows(rows: readonly VisualRow[], model: FurnitureModel): RowClass[] {
  const out: RowClass[] = rows.map((row) => ({ parts: row.parts.map(() => null), furniture: false, banner: false }));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cls = out[i];
    if (cls.banner) continue;
    if (model.epic && isBannerStartRow(row, model)) {
      let text = row.text;
      cls.banner = true;
      cls.parts = row.parts.map(() => 'banner');
      let last = row;
      for (let j = i + 1; j < rows.length; j++) {
        const next = rows[j];
        if (next.parts.length !== 1 || !isCentred(next, model) || next.y - last.y > BANNER_WRAP_GAP) break;
        if (SUB_BANNER_WORDS.has(next.text) || RE_BANNER.test(next.text)) break;
        if (/\(continued\)$/.test(text)) break;
        text = `${text} ${next.text}`;
        out[j].banner = true;
        out[j].parts = ['banner'];
        last = next;
      }
      cls.bannerText = text;
      continue;
    }
    if (model.epic && row.parts.length === 1 && isCentred(row, model) && row.index < 6 && RE_PATIENT_BANNER.test(row.text)) {
      cls.banner = true;
      cls.parts = ['banner'];
      cls.bannerText = row.text;
      continue;
    }
    row.parts.forEach((p, k) => {
      const t = p.t.trim();
      const key = furnitureKey(t);
      if (model.epic && (RE_PRINTED.test(t) || (RE_PAGE_NO.test(t) && i >= rows.length - 3))) cls.parts[k] = 'footer';
      else if (model.epic && RE_CONTEXT.test(t) && i < 6) cls.parts[k] = 'context';
      else if (model.epic && RE_MRN.test(t) && i < 6) cls.parts[k] = 'header';
      else if (t === '(continued)') cls.parts[k] = 'continued';
      else if (isTopBand(row, rows) && model.header.has(key)) cls.parts[k] = 'header';
      else if (isBottomBand(row, rows) && model.footer.has(key)) cls.parts[k] = 'footer';
    });
  }
  for (const c of out) c.furniture = c.parts.length > 0 && c.parts.every((k) => k !== null);
  return out;
}

/** Parses a banner title: date, type, department, and whether it says "(continued)". */
export function parseBanner(text: string): { dateText: string; type: string; department: string | null; continued: boolean } | null {
  const m = RE_BANNER.exec(text.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  let rest = m[2];
  const continued = /\s*\(continued\)$/.test(rest);
  if (continued) rest = rest.replace(/\s*\(continued\)$/, '');
  const at = rest.indexOf(' in ');
  return {
    dateText: m[1],
    type: (at > 0 ? rest.slice(0, at) : rest).trim(),
    department: at > 0 ? rest.slice(at + 4).trim() || null : null,
    continued,
  };
}
