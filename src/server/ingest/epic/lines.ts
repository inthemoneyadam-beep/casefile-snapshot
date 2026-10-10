/**
 * The lines the segmenter and the parsers walk: every visual row of a page that is not furniture, with its page and its
 * row index (for `detail.startLine` / `endLine`), its parts and their positions. Rows of a page without line boxes
 * have no position (x0 null): the parsers then fall back to the text alone. Pure.
 */
import { joinParts, type RowPart, type VisualRow } from '../reflow';
import type { RowClass } from './furniture';

export interface PageInput {
  page: number;
  rows: VisualRow[];
  classes: RowClass[];
  source: 'boxes' | 'text';
}

export interface SegLine {
  page: number;
  /** Index of the row on its page (furniture rows counted). */
  rowIndex: number;
  /** The non-furniture parts joined (reflow.joinParts). */
  text: string;
  parts: RowPart[];
  /** Left edge in points; null when the page has no line boxes. */
  x0: number | null;
  y: number;
  y1: number;
}

/** A page's non-furniture rows as lines, in reading order. */
export function pageLines(p: PageInput): SegLine[] {
  const out: SegLine[] = [];
  p.rows.forEach((row, i) => {
    const c = p.classes[i];
    if (c?.furniture) return;
    const parts = c ? row.parts.filter((_, k) => c.parts[k] === null) : row.parts;
    if (!parts.length) return;
    const text = parts.length === row.parts.length ? row.text : joinParts(parts);
    if (!text.trim()) return;
    out.push({ page: p.page, rowIndex: row.index, text, parts, x0: p.source === 'boxes' ? parts[0].x0 : null, y: row.y, y1: row.y1 });
  });
  return out;
}

/** Characters of the lines (what the model would read). */
export function linesChars(lines: readonly SegLine[]): number {
  let n = 0;
  for (const l of lines) n += l.text.length + 1;
  return n;
}
