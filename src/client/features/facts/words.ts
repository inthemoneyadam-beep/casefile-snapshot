/**
 * Details from documents, in the words a patient uses (2026-10 UI overhaul): the kind of detail, its fields, whose
 * words it is, and the filters. The stored values (fact types, attribute keys, voice codes) never reach the screen.
 *
 * Plain TypeScript (no components, no DOM) so tests can import it directly.
 */
import { MED_STATUS_WORDS } from '../medications/words';

/** The kind of detail (stored `type`). */
export const FACT_TYPE_WORDS: Record<string, string> = {
  lab_result: 'Lab result',
  diagnosis: 'Diagnosis',
  medication: 'Medication',
  procedure: 'Procedure',
  symptom: 'Symptom',
  clinician_statement: "A clinician's view",
  imaging_result: 'Scan result',
  vital: 'Vital sign',
  allergy_intolerance: 'Allergy or intolerance',
  recommendation: 'Recommendation',
  referral: 'Referral',
  record_reference: 'Mention of a record',
  follow_up: 'Follow-up',
  event: 'Event',
};

export function factTypeWords(type: string | null | undefined): string {
  if (!type) return 'Detail';
  return FACT_TYPE_WORDS[type] ?? type.replace(/_/g, ' ');
}

/** Your answer (stored `status`), for the Your answer filter. */
export const ANSWER_FILTER_WORDS: Record<string, string> = {
  unverified: 'No answer, or not sure',
  confirmed: 'Accurate, or only in a summary',
  disputed: 'Wrong (set aside)',
  superseded: 'Replaced by a newer one',
};

/** Whose words it is (stored `assertedBy`). */
export const VOICE_WORDS: Record<string, string> = {
  patient: "Your own words",
  clinician: 'A clinician',
  compiler: "A summary's writer",
  unknown: 'Not known',
};

/** What kind of statement (effective objectivity). */
export const OBJECTIVITY_WORDS: Record<string, string> = {
  objective: 'A measurement or a recorded event',
  subjective: 'An opinion or assessment',
};

/** Where a detail came from (stored `origin`). */
export const ORIGIN_FILTER_WORDS: Record<string, string> = { ai: 'Read by Claude', manual: 'Added by hand', import: 'Imported', parsed: 'Read off the page by the app' };

/** A detail's fields (stored attribute keys) as labels, sentence case. */
export const ATTRIBUTE_WORDS: Record<string, string> = {
  analyte: 'Test',
  value: 'Value',
  value_num: 'Value (as a number)',
  unit: 'Unit',
  ref_low: 'Range, low end',
  ref_high: 'Range, high end',
  ref_text: 'Normal range as printed',
  flag: 'Flag (its meaning)',
  flag_raw: 'Flag as printed',
  specimen: 'Sample',
  lab_name: 'Lab',
  collected_date: 'Collected',
  resulted_date: 'Resulted',
  received_date: 'Received',
  sample_label: 'Sample label',
  interpretation: "The document's own judgement",
  limit_used: 'Limit it judged by',
  name: 'Name',
  dose: 'Dose',
  route: 'Route',
  frequency: 'How often',
  start_date: 'Started',
  stop_date: 'Stopped',
  status: 'Status',
  indication: 'For',
  effect: 'Effect',
  reason_stopped: 'Why it was stopped',
  prescriber: 'Prescribed by',
  certainty: 'How certain',
  stated_by: 'Said by',
  icd_code: 'Diagnosis code',
  performed_by: 'Done by',
  location: 'Where',
  result_summary: 'Result',
  severity: 'Severity',
  course: 'Course',
  onset_date: 'Began',
  institution: 'Institution',
  about: 'About',
  stance: 'Stance',
  modality: 'Kind of scan',
  body_part: 'Body part',
  contrast: 'Contrast',
  impression: 'Impression',
  finding: 'Finding',
  comparison: 'Compared with',
  substance: 'Substance',
  kind: 'Kind',
  reaction: 'Reaction',
  recommended_by: 'Recommended by',
  action: 'What was recommended',
  target: 'What it concerns',
  acted_on: 'Was it done',
  to: 'To',
  specialty: 'Specialty',
  from: 'From',
  reason: 'Reason',
  record_type: 'Kind of record',
  description: 'Description',
  record_date: 'Record date',
  present_in_this_document: 'The record itself is in this document',
  what: 'What',
  who: 'Who',
  due: 'Due',
  detail: 'Detail',
};

export function attributeWords(key: string): string {
  const k = key.replace(/^_/, '');
  if (ATTRIBUTE_WORDS[k]) return ATTRIBUTE_WORDS[k];
  const words = k.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Fields that are data (values, units, ranges, flags, codes): set in the mono. */
const DATA_KEYS = new Set(['value', 'value_num', 'unit', 'ref_low', 'ref_high', 'ref_text', 'flag', 'flag_raw', 'dose', 'icd_code', 'collected_date', 'resulted_date', 'received_date', 'start_date', 'stop_date', 'onset_date', 'record_date', 'due']);
export function isDataAttribute(key: string): boolean {
  return DATA_KEYS.has(key);
}

const ENUM_VALUE_WORDS: Record<string, string> = {
  prn: 'as needed',
  whole_blood: 'whole blood',
  csf: 'CSF',
  hard_stop: 'never give',
  life_threatening: 'life-threatening',
  ruled_out: 'ruled out',
};

/**
 * The fields worth showing, in order, as [label, text, data?]: empty ones are left out (never a row of dashes), a
 * number the app read is left out beside the value as printed, and a range read as numbers beside the range as
 * printed. Booleans read yes / no; stored codes read as words. A medication's status reads as on Medications
 * ("taking", never "active"); `type` is the detail's kind (a diagnosis's "active" stays "active").
 */
export function shownAttributes(attrs: Record<string, unknown>, type?: string | null): Array<{ key: string; label: string; text: string; data: boolean }> {
  const out: Array<{ key: string; label: string; text: string; data: boolean }> = [];
  const has = (k: string) => attrs[k] != null && String(attrs[k]).trim() !== '';
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('_')) continue;
    if (v == null) continue;
    if (k === 'value_num' && has('value')) continue;
    if ((k === 'ref_low' || k === 'ref_high') && has('ref_text')) continue;
    let text: string;
    if (typeof v === 'boolean') text = v ? 'yes' : 'no';
    else if (Array.isArray(v)) text = v.map(String).join(', ');
    else if (typeof v === 'object') continue;
    else text = String(v).trim();
    if (!text) continue;
    if (type === 'medication' && k === 'status' && MED_STATUS_WORDS[text]) text = MED_STATUS_WORDS[text];
    else if (/^[a-z]+(_[a-z]+)+$/.test(text) || ENUM_VALUE_WORDS[text]) text = ENUM_VALUE_WORDS[text] ?? text.replace(/_/g, ' ');
    out.push({ key: k, label: attributeWords(k), text, data: isDataAttribute(k) });
  }
  return out;
}

/**
 * A document named in a list, date first (docs/DESIGN.md: if anything ends with "…" it is the end of the name, never
 * the part that tells two reports apart). A title that ends with its date ("Letter from the outside neurologist,
 * 2024-04-02") gives that date; else the document's own date, when known. `name` is the title without the trailing
 * date.
 */
export function documentLabel(title: string | null | undefined, documentDate?: string | null): { date: string | null; name: string } {
  const t = (title ?? '').trim();
  const m = /^(.*?)[,;·\s-]*\(?(\d{4}-\d{2}(?:-\d{2})?)\)?\s*$/.exec(t);
  if (m && m[1].trim()) return { date: m[2], name: m[1].trim() };
  return { date: documentDate?.trim() || null, name: t };
}

/** How alike two possible duplicates are, in words with the number ("92% alike"). */
export function alikeWords(similarity: number): string {
  return `${Math.round(Math.max(0, Math.min(1, similarity)) * 100)}% alike`;
}

/** Where a duplicate pair stands (stored merge `status`). */
export const MERGE_STATUS_WORDS: Record<string, { label: string; tone: 'warn' | 'ok' | 'ash' }> = {
  pending: { label: 'waiting for you', tone: 'warn' },
  accepted: { label: 'kept one', tone: 'ok' },
  rejected: { label: 'not duplicates', tone: 'ash' },
};
