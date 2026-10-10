/**
 * Calls and messages already in the documents. A phone call record, a portal
 * message or a letter added on Documents is a call or message that has not
 * been logged yet; the page offers each one with "Log it", which opens the
 * Log a call or message dialog filled in from the document (its date, the
 * channel its type implies, a direction read from its title, its title as the
 * subject, and the document itself as the transcript). Nothing is logged until
 * the user saves. Pure (no React), so it can be tested.
 */

import { titleWithoutDate } from '../people/shared';

/** The document types that hold a call or a message, and the channel each implies. */
export const MESSAGE_CATEGORIES: Record<string, string> = { call_transcript: 'call', portal_message: 'portal', letter: 'letter' };

export interface DocLike {
  id: string;
  title: string;
  category: string;
  documentDate: string | null;
}

/** The fields the dialog starts with for a document (CommunicationDialog `preset`). */
export interface CommPreset {
  occurredAtText: string;
  channel: string;
  direction: string;
  subject: string;
  documentId: string;
}

/** Who wrote to whom, as far as the title says: "... from Dr A" is incoming, "... to the clinic" outgoing. */
export function directionFromTitle(title: string, category: string): string {
  const t = title.toLowerCase();
  if (/\bfrom\b/.test(t)) return 'inbound';
  if (/\b(to|for)\b/.test(t) && category !== 'call_transcript') return 'outbound';
  if (category === 'call_transcript') return 'bidirectional';
  return 'inbound';
}

export function presetFromDocument(d: DocLike): CommPreset {
  return {
    occurredAtText: d.documentDate ?? '',
    channel: MESSAGE_CATEGORIES[d.category] ?? 'other',
    direction: directionFromTitle(d.title, d.category),
    subject: titleWithoutDate(d.title),
    documentId: d.id,
  };
}

/** Documents that hold a call or message and are not the transcript of one already logged, newest first. */
export function unloggedMessageDocuments<D extends DocLike>(docs: readonly D[], logged: ReadonlyArray<{ documentId: string | null }>): D[] {
  const linked = new Set(logged.map((c) => c.documentId).filter(Boolean));
  return docs.filter((d) => d.category in MESSAGE_CATEGORIES && !linked.has(d.id)).sort((a, b) => (b.documentDate ?? '').localeCompare(a.documentDate ?? '') || a.title.localeCompare(b.title));
}
