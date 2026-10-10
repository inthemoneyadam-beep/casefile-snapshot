/**
 * Page-level text updates (2026-10-07). OCR of a scanned image under a printed header APPENDS its text to the page
 * (reflow.ts OCR_LABEL); the text layer before it is kept byte for byte, so offsets into it stay true. Only the pages
 * that changed are touched: their rows are updated in place (never deleted and rewritten), their full-text entries
 * replaced, and only the citations on them (and the page either side, where a citation may have been placed) are
 * checked again: verified, moved or flagged, never dropped.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { indexPage } from '../services/search';
import { isVerifiedMatch, locateCitation, locateQuote, storedMatchKind, type PageMatch } from '../ai/citations';
import { visualPageText } from './reflow';

/**
 * Re-check citations into this document against the page text: offsets, page, verified flag and match kind follow
 * the text (a re-ingest with OCR, or a new pseudo-pagination, moves or changes it). A quote that can no longer be found
 * is kept, marked unverified with no offsets; no citation is ever dropped. A fact citation whose passage is still there
 * but with different numbers keeps its offsets as an unverified `mismatch`, as when it was first stored. Fact and
 * finding citations may move to the page before or after (as when they were first verified); a consult citation stays
 * on the page its answer names, and one the consult could not verify when it answered stays unverified (its quote may
 * be a stand-in such as the document title). With `onlyPages`, only citations on those pages are checked. With
 * `readingOrder` (the page rebuilt from its line boxes), a fact or message citation whose quote is not in the stored
 * (stream-order) text but is, numbers and all, in the reading-order text stays verified with no offsets, as when the
 * extraction engine stored it (facts.ts insertVerifiedCitation). Returns how many rows changed.
 */
export function reverifyDocumentCitations(documentId: string, pageText: (pageNumber: number) => string | undefined, onlyPages?: ReadonlySet<number>, readingOrder?: (pageNumber: number) => string | null | undefined): number {
  const d = db();
  const C = schema.citations;
  const rows = onlyPages
    ? onlyPages.size
      ? d.select().from(C).where(and(eq(C.documentId, documentId), inArray(C.pageNumber, [...onlyPages]))).all()
      : []
    : d.select().from(C).where(eq(C.documentId, documentId)).all();
  let changed = 0;
  for (const c of rows) {
    let found: PageMatch | null;
    if (c.askMessageId) {
      if (!c.verified && c.charStart == null) continue;
      const text = pageText(c.pageNumber);
      const m = text != null ? locateQuote(text, c.quote) : null;
      found = m ? { ...m, page: c.pageNumber } : null;
    } else {
      // A fact citation keeps the nearby passage whose numbers differ from the quote, as when it was stored
      // (insertVerifiedCitation): offsets kept, matchKind 'mismatch', never verified. Finding citations stay strict.
      found = locateCitation(pageText, c.pageNumber, c.quote, c.factId ? { allowNumericMismatch: true } : {});
    }
    let offsets = true;
    if (!isVerifiedMatch(found) && readingOrder && !c.askMessageId && (c.factId || c.communicationId)) {
      const m = locateCitation((k) => readingOrder(k) ?? undefined, c.pageNumber, c.quote);
      if (m && isVerifiedMatch(m)) {
        found = m;
        offsets = false;
      }
    }
    const next = {
      pageNumber: found?.page ?? c.pageNumber,
      charStart: offsets ? (found?.start ?? null) : null,
      charEnd: offsets ? (found?.end ?? null) : null,
      verified: isVerifiedMatch(found),
      matchKind: storedMatchKind(found),
    };
    if (next.pageNumber === c.pageNumber && next.charStart === c.charStart && next.charEnd === c.charEnd && next.verified === Boolean(c.verified) && next.matchKind === c.matchKind) continue;
    d.update(C).set(next).where(eq(C.id, c.id)).run();
    changed++;
  }
  return changed;
}

export interface PageTextUpdate {
  pageNumber: number;
  /** The page's whole new text (the old text layer kept at its start). */
  text: string;
  /** Mark the page as read (partly) by OCR. */
  ocr?: boolean;
  confidence?: number | null;
}

/**
 * Updates the text of some pages in place, in one transaction: the row (text, character count, OCR flag and
 * confidence; the line boxes are the text layer's and stay), its full-text entry, and the citations on it and on the
 * pages either side. Returns how many pages changed.
 */
export function updatePageTexts(documentId: string, updates: readonly PageTextUpdate[]): number {
  if (!updates.length) return 0;
  const P = schema.documentPages;
  let n = 0;
  db().transaction((tx) => {
    const touched = new Set<number>();
    for (const u of updates) {
      const row = tx.select({ id: P.id, text: P.text }).from(P).where(and(eq(P.documentId, documentId), eq(P.pageNumber, u.pageNumber))).get();
      if (!row || row.text === u.text) continue;
      tx.update(P)
        .set({ text: u.text, charCount: u.text.length, ...(u.ocr !== undefined ? { ocr: u.ocr } : {}), ...(u.confidence !== undefined ? { confidence: u.confidence } : {}) })
        .where(eq(P.id, row.id))
        .run();
      indexPage(row.id, documentId, u.pageNumber, u.text);
      touched.add(u.pageNumber);
      n++;
    }
    if (!touched.size) return;
    const window = new Set<number>();
    for (const p of touched) for (const q of [p - 1, p, p + 1]) if (q >= 1) window.add(q);
    const near = tx.select({ pageNumber: P.pageNumber, text: P.text, boxesJson: P.boxesJson }).from(P).where(and(eq(P.documentId, documentId), inArray(P.pageNumber, [...window, ...[...window].flatMap((q) => [q - 1, q + 1])]))).all();
    const texts = new Map(near.map((r) => [r.pageNumber, r.text]));
    const visual = new Map(near.map((r) => [r.pageNumber, r] as const));
    reverifyDocumentCitations(documentId, (k) => texts.get(k), window, (k) => {
      const r = visual.get(k);
      return r ? visualPageText(r) : null;
    });
  });
  return n;
}
