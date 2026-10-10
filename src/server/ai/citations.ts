/**
 * Citation verification. The model returns a page number and a verbatim
 * quote; this module finds that quote in the stored page text and returns the
 * character offsets, so the viewer can highlight the passage and the ledger
 * can say whether the provenance was actually checked.
 *
 * Three passes, cheapest first:
 *   exact       plain indexOf
 *   normalized  whitespace collapsed, curly quotes and dashes folded, case
 *               folded, with an index map back to the original offsets
 *   fuzzy       a window of about the quote's length slides over the page and
 *               is scored with bigram Dice similarity; the best window with
 *               similarity >= FUZZY_THRESHOLD is accepted and its boundaries
 *               refined
 *
 * Numbers must agree. One changed digit barely moves a bigram score, so a
 * quote whose value differs from the page ("82" quoted as "62", "3" as "30",
 * "4.2" as "7.2", "82" as "28") is never a match: every pass compares the
 * ordered numbers of the quote with those of the passage (widened to whole
 * numbers at its edges). By default such a passage is not returned at all;
 * callers that want to show where the nearby passage is ask for
 * `allowNumericMismatch` and get it flagged `numericMismatch`, which
 * `isVerifiedMatch` never counts as verified.
 * Nothing here touches the database.
 */

export type MatchKind = 'exact' | 'normalized' | 'fuzzy';

export interface QuoteMatch {
  start: number;
  end: number;
  kind: MatchKind;
  /** The passage was found but its numbers differ from the quote's: never verified. */
  numericMismatch?: boolean;
}

export interface LocateOptions {
  /** Return the nearby passage even when its numbers differ (flagged `numericMismatch`). Default false: such a passage is not a match. */
  allowNumericMismatch?: boolean;
}

export interface PageMatch extends QuoteMatch {
  page: number;
}

export const FUZZY_THRESHOLD = 0.78;
const FUZZY_MIN_LENGTH = 6;
const FUZZY_WINDOW_SLACK = 0.15;

// ---------------------------------------------------------------------------
// Normalisation with an offset map
// ---------------------------------------------------------------------------

const QUOTE_LIKE = /[‘’‚‛′´`]/;
const DQUOTE_LIKE = /[“”„‟″«»]/;
const DASH_LIKE = /[‐‑‒–—―−­]/;
const SPACE_LIKE = /[\s  -​  　﻿]/;

function foldChar(ch: string): string {
  if (SPACE_LIKE.test(ch)) return ' ';
  if (QUOTE_LIKE.test(ch)) return "'";
  if (DQUOTE_LIKE.test(ch)) return '"';
  if (DASH_LIKE.test(ch)) return '-';
  if (ch === '…') return '...';
  return ch.toLowerCase();
}

export interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalised char i */
  map: number[];
}

/**
 * Lower-case, fold quotes and dashes, collapse whitespace runs to one space,
 * trim, and remember where every surviving character came from.
 */
export function normalizeWithMap(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpaceAt = -1;
  for (let i = 0; i < input.length; i++) {
    const folded = foldChar(input[i]);
    if (folded === ' ') {
      if (out.length && pendingSpaceAt < 0) pendingSpaceAt = i;
      continue;
    }
    if (pendingSpaceAt >= 0) {
      out.push(' ');
      map.push(pendingSpaceAt);
      pendingSpaceAt = -1;
    }
    for (const c of folded) {
      out.push(c);
      map.push(i);
    }
  }
  return { text: out.join(''), map };
}

export function normalizeText(input: string): string {
  return normalizeWithMap(input).text;
}

// ---------------------------------------------------------------------------
// Bigram Dice similarity
// ---------------------------------------------------------------------------

function bigramCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams (multiset). 1 = identical, 0 = nothing shared. */
export function bigramDice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const ca = bigramCounts(a);
  const cb = bigramCounts(b);
  let inter = 0;
  for (const [k, n] of ca) {
    const m = cb.get(k);
    if (m) inter += Math.min(n, m);
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/** Dice between two already-normalised strings, for fuzzy statement comparison. */
export function textSimilarity(a: string, b: string): number {
  return bigramDice(normalizeText(a), normalizeText(b));
}

// ---------------------------------------------------------------------------
// Numbers: a quote and its passage must state the same values
// ---------------------------------------------------------------------------

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isSep(ch: string | undefined): boolean {
  return ch === '.' || ch === ',';
}

/**
 * The ordered numbers in a text: "CSF protein 73 mg/dL (ref 15-45)" -> 73, 15, 45.
 * ',' is folded to '.' and leading zeros are dropped, the same on both sides.
 */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, '.').replace(/^0+(?=\d)/, ''));
}

/** True when both texts carry the same numbers in the same order (order matters: 82/28 differ). */
export function numbersAgree(a: string, b: string): boolean {
  const x = numbersIn(a);
  const y = numbersIn(b);
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

/** Widen [start, end) so it never cuts a number in half ("3" inside "30", "4" inside "4.2"). */
function widenToWholeNumbers(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  for (;;) {
    if (s > 0 && isDigit(text[s]) && isDigit(text[s - 1])) s--;
    else if (s > 1 && isDigit(text[s]) && isSep(text[s - 1]) && isDigit(text[s - 2])) s -= 2;
    else if (s > 0 && isSep(text[s]) && isDigit(text[s - 1]) && isDigit(text[s + 1])) s--;
    else break;
  }
  for (;;) {
    if (e < text.length && isDigit(text[e - 1]) && isDigit(text[e])) e++;
    else if (e + 1 < text.length && isDigit(text[e - 1]) && isSep(text[e]) && isDigit(text[e + 1])) e += 2;
    else if (e < text.length && isSep(text[e - 1]) && isDigit(text[e - 2]) && isDigit(text[e])) e++;
    else break;
  }
  return [s, e];
}

/** Do the whole numbers of text[start, end) equal the quote's numbers? */
function spanNumbersAgree(text: string, start: number, end: number, quoteNumbers: string[]): boolean {
  const [s, e] = widenToWholeNumbers(text, start, end);
  const got = numbersIn(text.slice(s, e));
  return got.length === quoteNumbers.length && got.every((n, i) => n === quoteNumbers[i]);
}

// ---------------------------------------------------------------------------
// Fuzzy window search
// ---------------------------------------------------------------------------

interface Window {
  start: number;
  len: number;
  score: number;
}

/**
 * Slide a window of length `len` over `page` keeping a rolling intersection
 * count against the quote's bigram multiset. O(page) per length.
 */
function bestWindowOfLength(page: string, quoteCounts: Map<string, number>, quoteBigrams: number, len: number): Window | null {
  if (len < 2 || page.length < len) return null;
  const wc = new Map<string, number>();
  let inter = 0;
  const windowBigrams = len - 1;
  const denom = windowBigrams + quoteBigrams;
  const add = (b: string) => {
    const cur = wc.get(b) ?? 0;
    if (cur < (quoteCounts.get(b) ?? 0)) inter++;
    wc.set(b, cur + 1);
  };
  const remove = (b: string) => {
    const cur = wc.get(b) ?? 0;
    if (cur <= (quoteCounts.get(b) ?? 0)) inter--;
    wc.set(b, cur - 1);
  };
  for (let i = 0; i < windowBigrams; i++) add(page.slice(i, i + 2));
  let best: Window = { start: 0, len, score: (2 * inter) / denom };
  for (let s = 1; s + len <= page.length; s++) {
    remove(page.slice(s - 1, s + 1));
    add(page.slice(s + len - 2, s + len));
    const score = (2 * inter) / denom;
    if (score > best.score) best = { start: s, len, score };
  }
  return best;
}

function refineWindow(page: string, quote: string, w: Window): Window {
  let best = w;
  const reach = Math.max(3, Math.min(12, Math.round(quote.length * 0.1)));
  for (let ds = -reach; ds <= reach; ds++) {
    const start = w.start + ds;
    if (start < 0) continue;
    for (let de = -reach; de <= reach; de++) {
      const end = w.start + w.len + de;
      if (end > page.length || end - start < 2) continue;
      const score = bigramDice(page.slice(start, end), quote);
      if (score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && isWordBounded(page, start, end) && !isWordBounded(page, best.start, best.start + best.len))) {
        best = { start, len: end - start, score };
      }
    }
  }
  // Trim surrounding spaces without changing the score meaningfully.
  let start = best.start;
  let end = best.start + best.len;
  while (start < end && page[start] === ' ') start++;
  while (end > start && page[end - 1] === ' ') end--;
  return { start, len: end - start, score: best.score };
}

function isWordBounded(page: string, start: number, end: number): boolean {
  const before = start === 0 || /[^\p{L}\p{N}]/u.test(page[start - 1]);
  const after = end >= page.length || /[^\p{L}\p{N}]/u.test(page[end]);
  return before && after;
}

function fuzzyLocate(page: string, quote: string): Window | null {
  if (quote.length < FUZZY_MIN_LENGTH || page.length < 2) return null;
  const qc = bigramCounts(quote);
  const qb = quote.length - 1;
  const lens = new Set<number>();
  for (const f of [1, 0.95, 1.05, 0.9, 1.1, 0.85, 1.15]) {
    const l = Math.round(quote.length * f);
    if (l >= 2 && l <= page.length) lens.add(l);
  }
  if (!lens.size && page.length >= 2) lens.add(page.length);
  let best: Window | null = null;
  for (const len of lens) {
    const w = bestWindowOfLength(page, qc, qb, len);
    if (w && (!best || w.score > best.score)) best = w;
  }
  if (!best || best.score < FUZZY_THRESHOLD - 0.1) return null;
  const refined = refineWindow(page, quote, best);
  return refined.score >= FUZZY_THRESHOLD ? refined : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every occurrence of `needle` in `hay` (bounded; pages are small). */
function* occurrences(hay: string, needle: string, limit = 200): Generator<number> {
  let from = 0;
  for (let n = 0; n < limit; n++) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return;
    yield i;
    from = i + 1;
  }
}

/**
 * Find `quote` in `pageText`. Returns original-text offsets [start, end) and
 * how the match was made, or null when nothing acceptable was found. A
 * passage whose numbers differ from the quote's is not a match; with
 * `allowNumericMismatch` the nearest such passage is returned flagged
 * `numericMismatch` (never verified, see `isVerifiedMatch`).
 */
export function locateQuote(pageText: string, quote: string, opts: LocateOptions = {}): QuoteMatch | null {
  if (!pageText || !quote) return null;
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const quoteNumbers = numbersIn(trimmed);
  let near: QuoteMatch | null = null;

  for (const i of occurrences(pageText, trimmed)) {
    if (spanNumbersAgree(pageText, i, i + trimmed.length, quoteNumbers)) return { start: i, end: i + trimmed.length, kind: 'exact' };
    near ??= { start: i, end: i + trimmed.length, kind: 'exact', numericMismatch: true };
  }

  const np = normalizeWithMap(pageText);
  const nq = normalizeText(trimmed);
  if (!nq || !np.text) return opts.allowNumericMismatch ? near : null;

  for (const idx of occurrences(np.text, nq)) {
    const m: QuoteMatch = { start: np.map[idx], end: np.map[idx + nq.length - 1] + 1, kind: 'normalized' };
    if (spanNumbersAgree(np.text, idx, idx + nq.length, quoteNumbers)) return m;
    near ??= { ...m, numericMismatch: true };
  }

  const w = fuzzyLocate(np.text, nq);
  if (w && w.len > 0) {
    const m: QuoteMatch = { start: np.map[w.start], end: np.map[w.start + w.len - 1] + 1, kind: 'fuzzy' };
    if (spanNumbersAgree(np.text, w.start, w.start + w.len, quoteNumbers)) return m;
    near ??= { ...m, numericMismatch: true };
  }
  return opts.allowNumericMismatch ? near : null;
}

/** A located passage counts as verified provenance only when its numbers agree with the quote. */
export function isVerifiedMatch(m: QuoteMatch | null | undefined): boolean {
  return Boolean(m) && !m!.numericMismatch;
}

/** What a citation row stores as match_kind: exact | normalized | fuzzy | mismatch (passage found, numbers differ) | none. */
export function storedMatchKind(m: QuoteMatch | null | undefined): string {
  if (!m) return 'none';
  return m.numericMismatch ? 'mismatch' : m.kind;
}

/**
 * Check the stated page first, then the page before and the page after
 * (OCR and pseudo-pagination both shift text across boundaries). Returns the
 * page where the quote was actually found. A true match on a neighbouring
 * page wins over a numeric mismatch on the stated page; the mismatch is only
 * returned with `allowNumericMismatch`.
 */
export function locateCitation(pageText: (pageNumber: number) => string | undefined, statedPage: number, quote: string, opts: LocateOptions = {}): PageMatch | null {
  const order = [statedPage, statedPage - 1, statedPage + 1];
  let near: PageMatch | null = null;
  for (const p of order) {
    if (p < 1) continue;
    const text = pageText(p);
    if (text == null) continue;
    const m = locateQuote(text, quote, { allowNumericMismatch: true });
    if (!m) continue;
    if (!m.numericMismatch) return { ...m, page: p };
    near ??= { ...m, page: p };
  }
  return opts.allowNumericMismatch ? near : null;
}
