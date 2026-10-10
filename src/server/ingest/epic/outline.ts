/**
 * PDF bookmarks as encounter boundaries. Epic chart prints carry an outline: the top level is "Patient" plus one node
 * per encounter or plan block whose title is the banner as printed and whose page is the encounter's first page (every
 * encounter starts at the top of a page); depth 1 are the sections, depth 2 the notes, orders and media items. Node i
 * covers pages from its page to the next node's page - 1. Pure.
 */
import type { PdfOutlineNode } from '../pdf';

export interface OutlineEncounter {
  title: string;
  /** First page (1-based). */
  page: number;
  /** Last page (inclusive): the next encounter's first page - 1, or the document's last page. */
  endPage: number;
  /** Depth-1 bookmarks under it (sections), in order, with their pages. */
  children: Array<{ title: string; page: number | null }>;
}

/**
 * The top-level bookmarks that point at pages, in page order, one per start page (the first title wins when two
 * point at the same page), each with its page range. Pages before the first one are not covered here.
 */
export function outlineEncounters(nodes: readonly PdfOutlineNode[], pageCount: number): OutlineEncounter[] {
  const tops: Array<{ title: string; page: number; children: Array<{ title: string; page: number | null }> }> = [];
  let current: (typeof tops)[number] | null = null;
  for (const n of nodes) {
    if (n.depth === 0) {
      current = null;
      if (n.page === null || n.page < 1 || n.page > pageCount) continue;
      if (tops.some((t) => t.page === n.page)) continue;
      current = { title: n.title, page: n.page, children: [] };
      tops.push(current);
    } else if (n.depth === 1 && current) {
      current.children.push({ title: n.title, page: n.page });
    }
  }
  tops.sort((a, b) => a.page - b.page);
  return tops.map((t, i) => ({ ...t, endPage: i + 1 < tops.length ? tops[i + 1].page - 1 : pageCount }));
}

/** How many top-level bookmarks the outline has (pointing at a page or not). */
export function topLevelCount(nodes: readonly PdfOutlineNode[]): number {
  return nodes.filter((n) => n.depth === 0).length;
}
