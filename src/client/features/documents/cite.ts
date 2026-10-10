/**
 * Checking a stored citation span against the page text the viewer has
 * loaded. Citation offsets are computed once, against the page text of the
 * time; a re-ingest (OCR, a new extractor) replaces that text, so the viewer
 * trusts stored offsets only while they still hold the quote.
 */

/** Lower-case, fold quotes and dashes, collapse whitespace (as the server's citation matcher does). */
export function foldText(s: string): string {
  return s
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Dice coefficient over character bigrams (multiset): 1 identical, 0 nothing shared. */
export function bigramDice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < a.length; i++) {
    const k = a.slice(i, i + 2);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i + 1 < b.length; i++) {
    const k = b.slice(i, i + 2);
    const n = counts.get(k) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(k, n - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Below the server's fuzzy threshold (0.78) to allow for the simpler folding here. */
const SPAN_SIMILARITY = 0.72;

/**
 * Whether text[start, end) still holds the quote: the same words after
 * folding, or close enough for a fuzzy match (OCR noise). Offsets computed
 * against older text fail this and must not be shown as the verified passage.
 */
export function spanHoldsQuote(text: string, start: number, end: number, quote: string): boolean {
  if (!(end > start) || start < 0 || end > text.length) return false;
  const span = foldText(text.slice(start, end));
  const q = foldText(quote);
  if (!span || !q) return false;
  if (span === q || span.includes(q) || (q.includes(span) && span.length >= q.length * 0.8)) return true;
  return bigramDice(span, q) >= SPAN_SIMILARITY;
}

// ---------------------------------------------------------------------------
// Finding and marking passages in the viewer's page text (moved from routes/documents_.$id.tsx, sweep 2026-10-07).
// Free of React like the rest of this file: the route turns the pieces into <mark>s.
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find a quote in page text: exact, then whitespace-insensitive, then case-insensitive. */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  let i = text.indexOf(q);
  if (i >= 0) return { start: i, end: i + q.length };
  const tokens = q.split(/\s+/).filter(Boolean).map(escapeRe);
  if (!tokens.length) return null;
  const re = new RegExp(tokens.join('\\s+'), 'i');
  const m = re.exec(text);
  if (m) return { start: m.index, end: m.index + m[0].length };
  i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i >= 0) return { start: i, end: i + q.length };
  return null;
}

/** Every place the search words appear (case-insensitive, not overlapping, at most `limit`); nothing under 2 letters. */
export function findAll(text: string, q: string, limit = 300): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return out;
  const hay = text.toLowerCase();
  let i = 0;
  while (out.length < limit) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    out.push({ start: j, end: j + needle.length });
    i = j + needle.length;
  }
  return out;
}

/** A piece of page text: plain, or marked (`strong` for the cited passage, plain for a search hit; `key` for React). */
export type TextPiece = string | { key: number; text: string; strong: boolean };

interface Span {
  start: number;
  end: number;
  strong: boolean;
}

/**
 * The page text cut into plain and marked pieces, or null when nothing is marked: the cited passage (clamped to the
 * text), and every search hit outside it; a hit that overlaps an earlier mark is skipped.
 */
export function highlightPieces(text: string, cite: { start: number; end: number } | null, q: string | undefined): TextPiece[] | null {
  const spans: Span[] = [];
  if (cite && cite.end > cite.start) spans.push({ start: Math.max(0, cite.start), end: Math.min(text.length, cite.end), strong: true });
  if (q) for (const m of findAll(text, q)) if (!cite || m.end <= cite.start || m.start >= cite.end) spans.push({ ...m, strong: false });
  if (!spans.length) return null;
  spans.sort((a, b) => a.start - b.start);
  const out: TextPiece[] = [];
  let pos = 0;
  spans.forEach((s, idx) => {
    if (s.start < pos) return;
    if (s.start > pos) out.push(text.slice(pos, s.start));
    out.push({ key: idx, text: text.slice(s.start, s.end), strong: s.strong });
    pos = s.end;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** A run of pages, first to last (the shape of features/documents/pages.ts PageRange). */
interface PageSpan {
  from: number;
  to: number;
}

/** The page runs to load: each kept within 1..max, empty ones dropped, sorted, and touching or overlapping runs merged. */
export function normaliseRanges(ranges: readonly PageSpan[], max: number): PageSpan[] {
  const sorted = ranges
    .map((r) => ({ from: Math.max(1, r.from), to: Math.min(max || r.to, r.to) }))
    .filter((r) => r.to >= r.from)
    .sort((a, b) => a.from - b.from);
  const out: PageSpan[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}
