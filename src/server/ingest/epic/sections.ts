/**
 * Epic section headings and what each holds. A heading is a whitelisted line printed alone at the section margin
 * (x ≈ 17 pt), optionally followed by " (group i of n)" and " (continued)". Font alone is not enough: lab panel titles
 * inside notes and SBAR letters are printed in the same bold, so only these names count. Centred words under a banner
 * (Facesheet, Therapy Plan, Care Plan) and the Code/Rapid Response Timeline block also open sections. Pure.
 */
import type { SegmentKind } from '../../../shared/enums';

/** Top-level sections of an encounter (findings and the pdf reader's whitelist). */
const ENCOUNTER_SECTIONS: Array<[RegExp, SegmentKind]> = [
  [/^Other Orders$/, 'orders'],
  [/^Media \(Encounter and Order\)$/, 'media'],
  [/^Visit Information$/, 'visit_info'],
  [/^Reason for Visit$/, 'visit_info'],
  [/^Vitals \(Encounter\)$/, 'vitals'],
  [/^Vitals$/, 'vitals'],
  [/^All Encounter Notes$/, 'note'],
  [/^Patient Care Timeline$/, 'other'],
  [/^Flowsheets - All$/, 'flowsheets'],
  [/^Medication List$/, 'medication_list'],
  [/^Labs$/, 'lab_results'],
  [/^Messages$/, 'messages'],
  [/^Medication Administrations$/, 'mar'],
  [/^Imaging$/, 'imaging'],
  [/^Therapy Plan$/, 'therapy_plan'],
  [/^Letters$/, 'letter'],
  [/^Questionnaires$/, 'questionnaire'],
  [/^Patient Instructions$/, 'instructions'],
  [/^Discharge Instructions$/, 'instructions'],
  [/^Patient Education$/, 'education'],
  [/^Procedures$/, 'procedures'],
  [/^Care Plans?$/, 'care_plan'],
  [/^Case \d+$/, 'procedures'],
  [/^Anesthesia on .+$/, 'procedures'],
  [/^Operative & Procedure Notes$/, 'procedures'],
  [/^Infection Status as of .+$/, 'history'],
  [/^Certification of Transfer\/EMTALA$/, 'other'],
  [/^Appointment Requests$/, 'orders'],
  // Another system's layout, not yet seen in a real file: parsed and marked unverified.
  [/^Patient[- ]Entered Data$/, 'patient_entered'],
];

/** The patient-level block (the export's first pages, banner "Patient"). */
const PATIENT_SECTIONS: Array<[RegExp, SegmentKind]> = [
  [/^Demographics$/, 'patient_summary'],
  [/^Patient Demographics$/, 'patient_summary'],
  [/^Care Team(?: as of .+)?$/, 'patient_summary'],
  [/^Problem List$/, 'history'],
  [/^Allergies$/, 'history'],
  [/^Immunizations$/, 'history'],
  [/^Current Medications$/, 'medication_list'],
  [/^History(?: as of .+)?$/, 'history'],
  [/^Care Plans?$/, 'care_plan'],
];

/** Centred words that open a section (the encounter's first page, the timeline block). */
const CENTRED_SECTIONS: Array<[RegExp, SegmentKind]> = [
  [/^Facesheet$/, 'facesheet'],
  [/^Therapy Plan$/, 'therapy_plan'],
  [/^Care Plan$/, 'care_plan'],
  [/^Code\/Rapid Response Timeline$/, 'other'],
];

/** The section margin, in points (a heading's left edge). */
export const SECTION_X: readonly [number, number] = [14, 20];
/** Centred headings start right of this. */
const CENTRED_MIN_X = 60;

/** A heading split into its name and its suffixes. */
export interface SectionHeading {
  /** The name without " (group i of n)" and " (continued)". */
  name: string;
  continued: boolean;
  group: string | null;
  kind: SegmentKind;
  /** As printed. */
  text: string;
}

export function stripSuffixes(text: string): { name: string; continued: boolean; group: string | null } {
  let t = text.replace(/\s+/g, ' ').trim();
  let continued = false;
  if (/ \(continued\)$/.test(t)) {
    continued = true;
    t = t.replace(/ \(continued\)$/, '');
  }
  const g = / \((group \d+ of \d+)\)$/.exec(t);
  if (g) t = t.slice(0, g.index);
  // "History (continued) as of 7/14/2030": the patient block puts the date after the suffix.
  const h = /^(History) \(continued\)( as of .+)$/.exec(t);
  if (h) {
    continued = true;
    t = `${h[1]}${h[2]}`;
  }
  return { name: t, continued, group: g ? g[1] : null };
}

/**
 * The section a line opens, or null. `x0` is the line's left edge (null for lines without positions: then any line
 * that is exactly a heading counts). `patientBlock` switches to the patient-level names.
 */
export function sectionHeading(line: { text: string; x0: number | null; parts: number }, opts: { patientBlock?: boolean } = {}): SectionHeading | null {
  if (line.parts !== 1) return null;
  const { name, continued, group } = stripSuffixes(line.text);
  if (!name) return null;
  const atMargin = line.x0 === null || (line.x0 >= SECTION_X[0] && line.x0 <= SECTION_X[1]);
  const centred = line.x0 === null || line.x0 >= CENTRED_MIN_X;
  if (atMargin) {
    const list = opts.patientBlock ? PATIENT_SECTIONS : ENCOUNTER_SECTIONS;
    for (const [re, kind] of list) if (re.test(name)) return { name, continued, group, kind, text: line.text };
  }
  if (centred && !opts.patientBlock) {
    for (const [re, kind] of CENTRED_SECTIONS) if (re.test(name)) return { name, continued, group, kind, text: line.text };
  }
  return null;
}

/** Lines that say nothing (a section printed empty): a segment of only these is skipped, with its reason. */
const EMPTY_LINES = [
  /^No documentation\.?$/i,
  /^No data selected in time range\.?$/i,
  /^No orders to display\.?$/i,
  /^None\.?$/i,
  /^--\/--$/,
  /^\(continued\)$/,
];

export function isEmptyLine(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return !t || EMPTY_LINES.some((re) => re.test(t));
}

/** "Example, Pat Q (52 y.o. X) | <department>": the timeline block's patient line (printed before the block). */
export function isTimelinePatientLine(text: string): boolean {
  return /\(\d{1,3} y\.o\. [A-Za-z]+\)/.test(text);
}

/** Kinds whose segments are never skipped as a repeat of another (their parse is idempotent; their words matter). */
export const NEVER_SKIP_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(['messages', 'telephone', 'note', 'letter', 'questionnaire', 'appointment_request', 'patient_entered', 'instructions', 'education', 'media']);

/** Kinds whose items are never cut apart (a message, a note, a letter is read whole). */
export const NEVER_CUT_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(['messages', 'telephone', 'note', 'letter', 'questionnaire', 'appointment_request', 'patient_entered']);

/** An item heading (a message subject, a note header, an order, a media item) starts at this indent, in points. */
export const ITEM_X: readonly [number, number] = [30.5, 36];

/** The kind of a section from its name alone (a bookmark title): the whitelists, wherever it is printed. */
export function kindForSectionName(title: string, opts: { patientBlock?: boolean } = {}): SegmentKind {
  const { name } = stripSuffixes(title);
  const lists = opts.patientBlock ? [PATIENT_SECTIONS, CENTRED_SECTIONS, ENCOUNTER_SECTIONS] : [ENCOUNTER_SECTIONS, CENTRED_SECTIONS];
  for (const list of lists) for (const [re, kind] of list) if (re.test(name)) return kind;
  return 'other';
}

/** A printed heading and a bookmark title name the same section (suffixes, spacing and case aside). */
export function sameSectionName(printed: string, title: string): boolean {
  const a = stripSuffixes(printed).name.toLowerCase();
  const b = stripSuffixes(title).name.toLowerCase();
  return Boolean(a) && a === b;
}
