/**
 * Wording for the "likely held" suggestion. The server's guess is a heuristic
 * (record type family, a date within 14 days, a modality keyword on the title
 * or first page), so every place that shows it says what it matched on, and
 * only claims a date match when both sides actually had a date.
 */
import type { Gap } from '../../api/records';

type LikelyFields = Pick<Gap, 'date' | 'likelyHeldDocumentDate'>;

/** What the suggestion matched on, as a short clause. */
export function likelyBasis(gap: LikelyFields): string {
  if (!gap.date) return 'same record type and the study named in its title; the reference gives no date to compare';
  // "the kind of scan or test", never "modality": the guess also matches clinic notes and letters by their kind.
  if (!gap.likelyHeldDocumentDate) return 'same record type and the kind of scan or test; the document has no date to compare';
  return 'same record type, an agreeing date and the kind of scan or test';
}

/** The line appended to a row's notes when a suggested document is linked as its received copy. */
export function suggestedLinkNote(gap: LikelyFields, documentTitle: string | null): string {
  return `Received copy linked from the "likely held" suggestion${documentTitle ? ` (${documentTitle})` : ''}: matched on ${likelyBasis(gap)}.`;
}
