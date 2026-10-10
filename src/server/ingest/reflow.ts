/**
 * Reading order (findings D.1.3). `document_pages.text` keeps the PDF's stream order (full-text search and existing
 * citations depend on it); Epic draws headings and label rows after the text they head, so a reader of the stored text
 * can give a note to the wrong author. The page is rebuilt here in VISUAL order from its stored line boxes
 * (`boxes_json`): boxes sorted by y then x, boxes within ROW_TOLERANCE points of each other on one row, the parts of a
 * row joined with a space when they touch and with " | " when they are separate cells.
 *
 * OCR text appended to a page (pdf.ts: a scanned image under a printed header) sits after OCR_LABEL at the end of the
 * stored text; it is never mixed into the rows and is returned separately. Pure: no database, no file reads.
 */
import type { PageBox } from './pdf';

/** Boxes whose tops are this close (points) share a row. */
export const ROW_TOLERANCE = 2.5;
/** Parts of a row closer than this (points) are one run of words; further apart they are separate cells. */
export const CELL_GAP = 6;
/** Between separate cells of one row. */
export const CELL_SEPARATOR = ' | ';

/**
 * The line that introduces OCR text appended to a page's text layer. Plain words; never part of the printed page. The
 * text layer before it is unchanged, so citations into it keep their offsets.
 */
export const OCR_LABEL = '[Text read from the scanned image on this page]';

export interface RowPart {
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One visual row of a page: its parts left to right. */
export interface VisualRow {
  /** Index of the row on its page, from 0, in reading order. Stable while the page's boxes are unchanged. */
  index: number;
  /** Top of the row (the smallest y0 of its parts). */
  y: number;
  /** Bottom of the row (the largest y1). */
  y1: number;
  /** Left edge of the row (its first part). */
  x0: number;
  parts: RowPart[];
  /** The parts joined (joinParts). */
  text: string;
}

/** Stored boxes read without throwing; null when there are none. */
export function parseBoxes(json: string | null | undefined): PageBox[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return null;
    const out: PageBox[] = [];
    for (const b of v) {
      if (!b || typeof b !== 'object') continue;
      const o = b as Record<string, unknown>;
      if (typeof o.t !== 'string' || typeof o.x0 !== 'number' || typeof o.y0 !== 'number' || typeof o.x1 !== 'number' || typeof o.y1 !== 'number') continue;
      out.push({ t: o.t, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, ...(typeof o.c === 'number' ? { c: o.c } : {}) });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** OCR word boxes (they carry a confidence): the stored OCR text is already in reading order. */
export function isOcrBoxes(boxes: readonly PageBox[] | null | undefined): boolean {
  return Boolean(boxes?.some((b) => typeof b.c === 'number'));
}

/** The parts of one row as one line: a space between touching parts, CELL_SEPARATOR between cells. */
export function joinParts(parts: readonly RowPart[]): string {
  let out = '';
  let prev: RowPart | null = null;
  for (const p of parts) {
    const t = p.t.trim();
    if (!t) continue;
    if (prev) out += p.x0 - prev.x1 <= CELL_GAP ? ' ' : CELL_SEPARATOR;
    out += t;
    prev = p;
  }
  return out;
}

/** Line boxes -> rows in reading order (top to bottom, left to right). */
export function visualRows(boxes: readonly PageBox[]): VisualRow[] {
  const sorted = boxes
    .filter((b) => b.t && b.t.trim())
    .map((b) => ({ t: b.t, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const groups: RowPart[][] = [];
  let anchor = Number.NEGATIVE_INFINITY;
  for (const b of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(b.y0 - anchor) <= ROW_TOLERANCE) g.push(b);
    else {
      groups.push([b]);
      anchor = b.y0;
    }
  }
  return groups.map((parts, index) => {
    parts.sort((a, b) => a.x0 - b.x0);
    return {
      index,
      y: Math.min(...parts.map((p) => p.y0)),
      y1: Math.max(...parts.map((p) => p.y1)),
      x0: parts[0].x0,
      parts,
      text: joinParts(parts),
    };
  });
}

/** Rows of a page that has no usable line boxes: one row per non-empty line of the text, in its own order. */
export function rowsFromText(text: string): VisualRow[] {
  const out: VisualRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.replace(/\s+$/, '');
    if (!t.trim()) continue;
    const i = out.length;
    out.push({ index: i, y: i * 12, y1: i * 12 + 10, x0: 0, parts: [{ t: t.trim(), x0: 0, y0: i * 12, x1: 1, y1: i * 12 + 10 }], text: t.trim() });
  }
  return out;
}

/** A page's stored text split into its text layer and the OCR text appended after OCR_LABEL (null when none). */
export function splitOcr(stored: string): { layer: string; ocr: string | null } {
  const i = stored.indexOf(OCR_LABEL);
  if (i < 0) return { layer: stored, ocr: null };
  return { layer: stored.slice(0, i).replace(/\s+$/, ''), ocr: stored.slice(i + OCR_LABEL.length).replace(/^\s+/, '').replace(/\s+$/, '') };
}

/** The text layer with OCR text appended under OCR_LABEL; the layer itself is kept byte for byte. */
export function appendOcr(layer: string, ocrText: string): string {
  const t = ocrText.trim();
  if (!t) return layer;
  return layer ? `${layer}\n\n${OCR_LABEL}\n${t}` : `${OCR_LABEL}\n${t}`;
}

/** What one page looks like in reading order. */
export interface PageReading {
  rows: VisualRow[];
  /** boxes: rebuilt from line boxes; text: the stored text's own lines (no boxes, or OCR word boxes). */
  source: 'boxes' | 'text';
  /** OCR text appended to the page, if any. */
  ocr: string | null;
}

/** A stored page in reading order. */
export function pageReading(page: { text: string; boxesJson?: string | null }): PageReading {
  const { layer, ocr } = splitOcr(page.text ?? '');
  const boxes = parseBoxes(page.boxesJson);
  if (boxes && !isOcrBoxes(boxes)) return { rows: visualRows(boxes), source: 'boxes', ocr };
  return { rows: rowsFromText(layer), source: 'text', ocr };
}

/** A page's whole reading-order text: every row, then the OCR text under its label. Null when there are no line boxes. */
export function visualPageText(page: { text: string; boxesJson?: string | null }): string | null {
  const r = pageReading(page);
  if (r.source !== 'boxes') return null;
  const body = r.rows.map((x) => x.text).join('\n');
  return r.ocr ? appendOcr(body, r.ocr) : body;
}
