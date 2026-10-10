/**
 * Where a lab value came from, said so that the part that tells two reports apart is never the part that is cut:
 * the document's date first (in the mono), then its name without that date repeated ("Lab report, 2024-09-17"
 * becomes "2024-09-17 · Lab report"), then the page. The date is the one in the name when the name ends with one,
 * else the document's own date. In a test's readings (one row per reading, its date in its own column) the date is
 * left out when it is the reading's own (sourceDateDiffers).
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */

/** A date at the end of a document's name: ", 2024-09-17", " 2025-01", " (2024-03-18)". Never a bare year ("My notes, March 2024" keeps its name). */
const TRAILING_DATE = /[\s,;:–-]*\(?(\d{4}-\d{2}(?:-\d{2})?)\)?\s*$/;

export interface SourceWords {
  /** The document's date (YYYY, YYYY-MM or YYYY-MM-DD), or null when neither the name nor the document has one. */
  date: string | null;
  /** The document's name, without the date when the name ended with it. */
  name: string;
}

/**
 * The date and the name of the document a value came from. `documentDate` is the document's own date (used when the
 * name carries none); a name that is only a date keeps it as its name.
 */
export function sourceWords(title: string | null | undefined, documentDate?: string | null): SourceWords {
  const full = (title ?? '').trim();
  const m = TRAILING_DATE.exec(full);
  if (m && m.index > 0) {
    const name = full.slice(0, m.index).trim();
    if (name) return { date: m[1], name };
  }
  const own = (documentDate ?? '').trim();
  return { date: own ? own.slice(0, 10) : null, name: full || 'Document' };
}

/**
 * Is the document's date worth saying beside a reading? In a test's readings the row's Date already gives the
 * reading's date, so the document's date is said only when it differs ("Neurology clinic note", dated 2024-03-20,
 * for a reading of 2024-03-18). A coarser form of the reading's date ("2024-03" beside 2024-03-18) adds nothing.
 * `rowDate` is the reading's date as stored at its precision ("2024-03-18", "2024-03", "2024").
 */
export function sourceDateDiffers(documentDate: string | null | undefined, rowDate: string | null | undefined): boolean {
  const doc = (documentDate ?? '').trim().slice(0, 10);
  if (!doc) return false;
  const row = (rowDate ?? '').trim().slice(0, 10);
  if (!row) return true;
  return !(doc === row || (doc.length < row.length && row.startsWith(`${doc}-`)));
}

/** The same in one line of words, for a hover or a sort: "2024-09-17 · Lab report, p.1". */
export function sourceLine(title: string | null | undefined, documentDate: string | null | undefined, page: number | null | undefined): string {
  const w = sourceWords(title, documentDate);
  return `${w.date ? `${w.date} · ` : ''}${w.name}${page ? `, p.${page}` : ''}`;
}
