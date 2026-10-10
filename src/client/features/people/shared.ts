/**
 * Small helpers shared by the People and Calls and messages pages, and the
 * plain words for their stored codes. The stored values (inbound, portal,
 * chief_of_staff, clinical_note) never reach the screen; these words do.
 */

/** True while a modal dialog is open; page key bindings stay quiet then. */
export { dialogOpen } from '../../app/dom';

/** snake_case enum value -> words (a last resort for a value with no entry in the maps below). */
export function label(s: string | null | undefined): string {
  return (s ?? '').replace(/_/g, ' ');
}

/** "1 call", "2 calls": counts agree in number. */
export { plural } from '../../app/text';

/** How a call or message went, in words: who contacted whom. */
export const DIRECTION_WORDS: Record<string, string> = {
  inbound: 'Incoming',
  outbound: 'Outgoing',
  internal: 'Within your team',
  bidirectional: 'Both ways',
  third_party: 'Care team to someone else',
};
/** The same, as one sentence for hover text and the detail pane. */
export const DIRECTION_HINT: Record<string, string> = {
  inbound: 'They contacted you',
  outbound: 'You contacted them',
  internal: 'Between the people looking after the case',
  bidirectional: 'Back and forth (a call or a thread)',
  third_party: 'The care team contacted someone else about you (a pharmacy, an infusion centre, another clinic)',
};

/** Whose words a message read out of a record is (the voice); the patient is "you". */
export const VOICE_WORDS: Record<string, string> = {
  patient: 'Your own words',
  clinician: 'A clinician',
  staff: 'The care team',
  system: 'An automatic message',
  third_party: 'Someone outside the care team',
  unknown: 'Not known who',
};
export function voiceWords(v: string | null | undefined): string | null {
  return v ? (VOICE_WORDS[v] ?? label(v)) : null;
}

/** What kind of message a record holds. */
export const MESSAGE_KIND_WORDS: Record<string, string> = {
  portal_message: 'Portal message',
  telephone_encounter: 'Telephone note',
  appointment_request: 'Appointment message',
  questionnaire: 'Questionnaire',
  letter: 'Letter',
  patient_entered_data: 'Something you entered',
  email: 'Email',
  call_record: 'Call record',
};
export function messageKindWords(k: string | null | undefined): string | null {
  return k ? (MESSAGE_KIND_WORDS[k] ?? label(k)) : null;
}
export function directionWords(d: string | null | undefined): string {
  return (d && DIRECTION_WORDS[d]) || label(d);
}

/** How it happened. */
export const CHANNEL_WORDS: Record<string, string> = {
  portal: 'Portal message',
  call: 'Phone call',
  email: 'Email',
  visit: 'In person',
  fax: 'Fax',
  letter: 'Letter',
  text: 'Text message',
  video: 'Video call',
  other: 'Other',
};
export function channelWords(c: string | null | undefined): string {
  return (c && CHANNEL_WORDS[c]) || label(c);
}

/** A participant's part in a call or message. */
export const ROLE_WORDS: Record<string, string> = { from: 'from', to: 'to', cc: 'copied', present: 'present' };

/** What kind of person or place. */
export const PERSON_KIND_WORDS: Record<string, string> = {
  clinician: 'Clinician',
  clinic: 'Clinic',
  institution: 'Hospital or institution',
  advocate: 'Advocate',
  family: 'Family',
  chief_of_staff: 'Chief of staff',
  patient: 'Patient',
  other: 'Other',
};
export function personKindWords(k: string | null | undefined): string {
  return (k && PERSON_KIND_WORDS[k]) || label(k);
}

/** The kind of a detail read from a document, in words (as on Details from documents). */
export const FACT_TYPE_WORDS: Record<string, string> = {
  lab_result: 'lab value',
  diagnosis: 'diagnosis',
  medication: 'medication',
  procedure: 'procedure',
  symptom: 'symptom',
  clinician_statement: 'clinician’s statement',
  imaging_result: 'scan result',
  vital: 'vital sign',
  allergy_intolerance: 'allergy',
  recommendation: 'recommendation',
  referral: 'referral',
  record_reference: 'record mentioned',
  follow_up: 'follow-up',
  event: 'event',
};
export function factTypeWords(t: string | null | undefined): string {
  return (t && FACT_TYPE_WORDS[t]) || label(t);
}

/** "3.5 days" (how long a reply usually takes); null when not enough calls to tell. */
export function replyDays(n: number | null | undefined): string | null {
  if (n == null) return null;
  const v = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${v} ${n === 1 ? 'day' : 'days'}`;
}

/** Comma-separated text -> trimmed, non-empty parts. */
export function splitCsv(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** '' -> null for optional form fields. */
export { nz } from '../../app/text';

/** A document's title without the date the app adds at its end ("Call with the pharmacy, 2024-04-03" -> "Call with the pharmacy"). */
export function titleWithoutDate(title: string): string {
  return title.replace(/,\s*(\d{4}(-\d{2}(-\d{2})?)?|[A-Z][a-z]+ \d{4})\s*$/, '').trim() || title;
}

/** A person's role and place in one line: "Neurologist, Lakeside Clinic", "Neurologist", "Lakeside Clinic", or null. */
export function personLine(p: { role: string | null; specialty: string | null; institutionName: string | null }): string | null {
  const what = [p.role, p.specialty].filter(Boolean).join(', ');
  if (what && p.institutionName) return `${what}, ${p.institutionName}`;
  return what || p.institutionName || null;
}
