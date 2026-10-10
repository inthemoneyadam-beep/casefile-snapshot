/**
 * The Timeline in plain words: the kinds of thing on it in the words the rest of
 * the app uses (never "fact", "contact", "encounter"), their sub-kinds, what a
 * status means, and where Open takes you. The stored kinds stay as they are.
 *
 * The kinds' words are the shared ones (src/shared/timeline.ts TIMELINE_KIND_LABELS / TIMELINE_KIND_ONE), so the
 * Timeline, Make a packet and the packet itself say the same.
 */
import { TIMELINE_KIND_LABELS, TIMELINE_KIND_ONE, isTimelineKind, type TimelineKind } from '@shared/timeline';
import { documentTypeLabel } from '../../api/filing';
import { sampleWords } from '../labs/tags';
import { modalityWord } from '../imaging/words';

/** The kinds, plural, for the Show: filter and the counts: the names the sidebar and pages use. */
export const KIND_WORDS: Record<TimelineKind, string> = TIMELINE_KIND_LABELS;

/** One of a kind, for a row and a pane's eyebrow. */
export const KIND_ONE: Record<TimelineKind, string> = TIMELINE_KIND_ONE;

export function kindWords(k: string, count = 2): string {
  if (!isTimelineKind(k)) return k.replace(/_/g, ' ');
  return count === 1 ? KIND_ONE[k] : KIND_WORDS[k];
}

/** "21 documents", "1 detail", in lower case, for a period's summary line. */
export function kindCount(k: string, n: number): string {
  return `${n} ${kindWords(k, n).toLowerCase()}`;
}

const FACT_TYPE_WORDS: Record<string, string> = {
  lab_result: 'Lab result',
  diagnosis: 'Diagnosis',
  medication: 'Medication',
  procedure: 'Procedure',
  symptom: 'Symptom',
  clinician_statement: "A clinician's statement",
  imaging_result: 'Scan result',
  vital: 'Vital sign',
  allergy_intolerance: 'Allergy or intolerance',
  recommendation: 'Recommendation',
  referral: 'Referral',
  record_reference: 'A record mentioned',
  follow_up: 'Follow-up',
  event: 'Event',
};
const MED_EVENT_WORDS: Record<string, string> = { start: 'Started', stop: 'Stopped', dose_change: 'Dose changed', hold: 'Paused', resume: 'Restarted', reaction: 'Reaction', note: 'Note' };
/** The Calls and messages page's words for a direction (features/people/shared.ts DIRECTION_WORDS), in lower case after the channel. */
const DIRECTION_WORDS: Record<string, string> = { inbound: 'incoming', outbound: 'outgoing', internal: 'within your team', bidirectional: 'both ways', third_party: 'care team to someone else' };
const CHANNEL_WORDS: Record<string, string> = { portal: 'Portal message', call: 'Phone call', email: 'Email', visit: 'In person', fax: 'Fax', letter: 'Letter', text: 'Text message', video: 'Video call', other: 'Other' };

const cap = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The sub-kind in words ("Lab result", "Lab report", "Phone call, from them", "Dose changed"); null when there is none. */
export function subKindWords(kind: string, subKind: string | null | undefined): string | null {
  const s = (subKind ?? '').trim();
  if (!s) return null;
  switch (kind) {
    case 'fact':
      return FACT_TYPE_WORDS[s] ?? cap(s);
    case 'document':
      return documentTypeLabel(s);
    case 'medication_event':
      return MED_EVENT_WORDS[s] ?? cap(s);
    case 'lab':
      return sampleWords(s) || null;
    case 'imaging':
      return modalityWord(s);
    case 'communication': {
      const [dir, ...rest] = s.split(' ');
      const channel = rest.join(' ');
      return channel ? `${CHANNEL_WORDS[channel] ?? cap(channel)}, ${DIRECTION_WORDS[dir] ?? dir.replace(/_/g, ' ')}` : cap(s);
    }
    case 'task':
      return `${cap(s)} priority`;
    default:
      return cap(s);
  }
}

/**
 * A row's title without the date it repeats at its end ("CSF protein 52 on 2022-04-05." beside the date column reads
 * "CSF protein 52"). Only a trailing " on <the item's own date>" goes, with its full stop; the pane shows the whole.
 */
export function trimTrailingDate(title: string, date: string | null | undefined): string {
  const d = (date ?? '').trim();
  if (!d) return title;
  const esc = d.replace(/[-]/g, '\\-');
  const re = new RegExp(`\\s+(?:on|in|dated)\\s+${esc}\\.?\\s*$`, 'i');
  const out = title.replace(re, '');
  return out.trim() ? out : title;
}

/** Where Open takes you, by kind. */
export const OPEN_WORDS: Record<TimelineKind, string> = {
  document: 'Open the document',
  fact: 'Open in Details from documents',
  communication: 'Open in Calls and messages',
  encounter: 'Open in Appointments',
  medication_event: 'Open in Medications',
  lab: 'Open in Lab results',
  imaging: 'Open in Scans and imaging',
  symptom: 'Open in the Symptom diary',
  daily: 'Open in the Symptom diary',
  task: 'Open in the To-do list',
  finding: 'Open in What Claude noticed',
};

export function openWords(kind: string): string {
  return isTimelineKind(kind) ? OPEN_WORDS[kind] : 'Open';
}

/** A document's reading state in words, for its pane ("Read", "Could not be read"). */
export const READING_WORDS: Record<string, string> = {
  pending: 'Waiting to be read',
  extracting: 'Being read',
  extracted: 'Read',
  ocr_needed: 'Needs reading as a scan',
  ocr_running: 'Being read as a scan',
  ocr_done: 'Read as a scan',
  failed: 'Could not be read',
};

/** The page's one sentence of purpose. */
export const TIMELINE_INTRO = 'Everything in the case that has a date, in date order: documents, the details read from them, medication changes, appointments, calls, lab values and scans.';

/** A document's "detail" is its notes, else its file name: a bare file name ("lab.txt") is no note. */
export function isFileName(s: string | null | undefined): boolean {
  return /^[^\s/\\]+\.[a-z0-9]{2,5}$/i.test((s ?? '').trim());
}

export { lowerFirst } from '../../app/text';

/** What a row shows after its title: where it came from, or a short note; never a document's bare file name. */
export function rowDetail(item: { kind: string; detail?: string | null }): string | null {
  if (!item.detail) return null;
  if (item.kind === 'document' && isFileName(item.detail)) return null;
  return item.detail;
}
