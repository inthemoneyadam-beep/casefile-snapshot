/**
 * Make a packet, in plain words: what each choice puts in the packet, the packet's state, and the timeline kinds, in
 * the words the rest of the app uses (never the stored codes: "superseded", "fact", "encounter", "done").
 */
import { TIMELINE_KIND_LABELS, type TimelineKind } from '@shared/timeline';
import type { Scope } from './builderState';

/** The timeline's kinds of entries as the menu names them: the shared words, the same as the Timeline page and the packet (the stored kinds stay in the packet's settings). */
export const TIMELINE_KIND_WORDS: Record<TimelineKind, string> = TIMELINE_KIND_LABELS;

export function timelineKindWords(k: string): string {
  return TIMELINE_KIND_WORDS[k as TimelineKind] ?? k.replace(/_/g, ' ');
}

/** The details-from-documents choice: what it puts in, and a sentence for the hover. */
export const FACT_SCOPE_WORDS: Record<Scope, { label: string; title: string }> = {
  confirmed: { label: 'Only the details you have checked', title: 'Details you marked accurate or corrected yourself' },
  all: { label: 'Every detail except replaced ones', title: 'Everything Claude pulled out of the documents, except details a clinical record or a newer reading replaced' },
  none: { label: 'Leave out', title: 'No details section in the packet' },
  chosen: { label: 'Only the details chosen in the earlier packet', title: 'The same details as the packet this one was reused from' },
};

/** The What Claude noticed choice. */
export const FINDING_SCOPE_WORDS: Record<Scope, { label: string; title: string }> = {
  confirmed: { label: 'Only the ones that need follow-up', title: 'Notices you answered with "Yes, needs follow-up"' },
  all: { label: "All except the ones you said don't matter", title: 'Every notice, except those you answered with "Doesn\'t matter"' },
  none: { label: 'Leave out', title: 'No What Claude noticed section in the packet' },
  chosen: { label: 'Only the ones chosen in the earlier packet', title: 'The same notices as the packet this one was reused from' },
};

/** A stored scope (an id list counts as "chosen") in words, for a packet's summary. */
export function scopeWords(v: unknown, words: Record<Scope, { label: string }>): string {
  if (v === 'all' || v === 'confirmed' || v === 'none') return words[v].label;
  if (Array.isArray(v)) return v.length ? `${v.length} chosen in an earlier packet` : words.none.label;
  return words.none.label;
}

/** Where a packet stands. */
export const PACKET_STATUS_WORDS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  queued: { label: 'waiting', tone: 'neutral' },
  running: { label: 'being made', tone: 'info' },
  done: { label: 'ready', tone: 'ok' },
  failed: { label: 'failed', tone: 'bad' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

export function packetStatusWords(status: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' } {
  return PACKET_STATUS_WORDS[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' };
}

/** How an original was added at the end of the packet. */
export const APPENDED_HOW_WORDS: Record<string, string> = {
  pdf: 'the original PDF',
  image: 'the picture, one page each',
  text: 'its text',
  failed: 'could not be added',
};

/** The PDF maker the server found ("msedge.exe" path or "chrome"), named for a person. */
export function browserWords(browser: string | null | undefined): string | null {
  if (!browser) return null;
  return /msedge|edge/i.test(browser) ? 'Microsoft Edge' : /chrom/i.test(browser) ? 'Google Chrome' : 'a web browser';
}

export function fmtBytes(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export { plural } from '../../app/text';
