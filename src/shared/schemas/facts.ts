/**
 * The fact schema. This is what the model must return (structured output)
 * and what the server validates before anything touches the database.
 *
 * The API compiles structured-output schemas into a grammar and caps them at
 * 24 optional and 16 nullable/union-typed parameters per request, so the
 * model-facing shape keeps attributes as an array of { key, value } string
 * pairs (no optional or union fields). The server turns the pairs into the
 * typed attribute object for the fact's type (`validateAttributes`), which is
 * where numbers, booleans, enums and required fields are enforced.
 *
 * Bump EXTRACTION_SCHEMA_VERSION in src/shared/constants.ts whenever the
 * shape or the prompt changes in a way that would alter extracted facts.
 */
import { z } from 'zod';
import { FACT_TYPES } from '../enums';
import { parseFlag, parseLabValue, type ParsedValue } from '../labvalues';

const dateField = z.string().nullable().describe('Date as written in the source, or null. Any format; the server normalises it.');

// ---------------------------------------------------------------------------
// Typed attribute schemas (server-side validation, manual edits, tests)
// ---------------------------------------------------------------------------
/**
 * A lab value as printed (the user's rules, 2026-10): the value, unit, range and flag exactly as printed beside the
 * normalised fields; the collected, resulted and received dates apart; a summary's own judgement words and limit kept
 * as its claim. The keys after lab_name were added in 2026-10 (EXTRACTION_SCHEMA_VERSION 3) and are stored only when
 * they have a value (LAB_KEYS_STORED_WHEN_SET).
 */
export const labAttributes = z.object({
  analyte: z.string().describe('Test name as written, e.g. "CSF protein", "IgG index", "WBC"'),
  value: z.string().describe('Value exactly as printed, keeping any <, >, ≤, ≥ sign and words'),
  value_num: z.number().nullable().describe('Only when the value is a plain number; empty for "<3", ">1700", "1:160", "2+", words'),
  unit: z.string().nullable().describe('Unit exactly as printed'),
  ref_low: z.number().nullable(),
  ref_high: z.number().nullable(),
  ref_text: z.string().nullable().describe('Reference range exactly as printed'),
  flag: z.enum(['H', 'L', 'N', 'A', 'C']).nullable().describe('H high, L low, N normal, A abnormal, C critical: only the meaning of a printed flag'),
  flag_raw: z.string().nullable().describe('The flag exactly as printed beside the value ("H", "HH", "*", "-"); "" when none is printed'),
  specimen: z.enum(['serum', 'plasma', 'whole_blood', 'csf', 'urine', 'other']).nullable(),
  lab_name: z.string().nullable().describe('The laboratory that performed the test, as printed'),
  collected_date: z.string().nullable().describe('Collection date exactly as printed (Collected, Drawn, Obtained), if printed'),
  resulted_date: z.string().nullable().describe('Result or report date exactly as printed (Resulted, Reported, Final, Verified), if printed'),
  received_date: z.string().nullable().describe('Date the laboratory received the sample, exactly as printed; never the reading\'s date'),
  sample_label: z.string().nullable().describe('A label printed with the value that tells two samples apart (tube 1, tube 4, a time, "repeat"), as written'),
  interpretation: z.string().nullable().describe('Words the document uses to judge the value ("normal", "elevated"), as written'),
  limit_used: z.string().nullable().describe('A limit the text says it judged by ("age-adjusted limit 0.8"), as written'),
});

/**
 * Lab attribute keys added in 2026-10: stored only when they have a value, so a fact saved before then and saved again
 * unchanged stays unchanged. flag_raw '' (no flag printed) is a value and is stored; a missing flag_raw is "not recorded".
 */
export const LAB_KEYS_STORED_WHEN_SET: readonly string[] = ['flag_raw', 'collected_date', 'resulted_date', 'received_date', 'sample_label', 'interpretation', 'limit_used'];

export const medicationAttributes = z.object({
  name: z.string(),
  dose: z.string().nullable(),
  unit: z.string().nullable(),
  route: z.string().nullable(),
  frequency: z.string().nullable(),
  start_date: dateField,
  stop_date: dateField,
  status: z.enum(['active', 'stopped', 'prn', 'planned', 'unknown']).nullable(),
  indication: z.string().nullable(),
  effect: z.string().nullable().describe('Stated effect or response, e.g. "no benefit", "marked improvement"'),
  reason_stopped: z.string().nullable(),
  prescriber: z.string().nullable(),
});

export const diagnosisAttributes = z.object({
  name: z.string(),
  certainty: z.enum(['confirmed', 'probable', 'possible', 'ruled_out', 'considered', 'unknown']).nullable(),
  stated_by: z.string().nullable().describe('Clinician or institution asserting it, if named'),
  icd_code: z.string().nullable(),
});

export const procedureAttributes = z.object({
  name: z.string(),
  performed_by: z.string().nullable(),
  location: z.string().nullable(),
  result_summary: z.string().nullable(),
});

export const symptomAttributes = z.object({
  name: z.string(),
  severity: z.string().nullable(),
  course: z.enum(['new', 'improving', 'worsening', 'stable', 'resolved', 'unknown']).nullable(),
  onset_date: dateField,
});

export const clinicianStatementAttributes = z.object({
  stated_by: z.string().nullable(),
  institution: z.string().nullable(),
  about: z.string().nullable().describe('Subject of the statement: a treatment, a diagnosis, a plan'),
  stance: z.enum(['supports', 'opposes', 'uncertain', 'neutral']).nullable(),
});

export const imagingAttributes = z.object({
  modality: z.string().describe('MRI, CT, PET, PET-CT, SPECT, XR, US, EEG, EMG, NCS, other'),
  body_part: z.string().nullable(),
  contrast: z.string().nullable(),
  impression: z.string().nullable(),
  finding: z.string().nullable(),
  institution: z.string().nullable(),
  comparison: z.string().nullable().describe('Prior study it was compared against, if stated'),
});

export const vitalAttributes = z.object({
  name: z.string(),
  value: z.string(),
  value_num: z.number().nullable(),
  unit: z.string().nullable(),
});

export const intoleranceAttributes = z.object({
  substance: z.string(),
  kind: z.enum(['allergy', 'intolerance', 'hard_stop', 'caution']).nullable(),
  reaction: z.string().nullable(),
  severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening', 'unknown']).nullable(),
});

export const recommendationAttributes = z.object({
  recommended_by: z.string().nullable(),
  action: z.string().describe('What was recommended'),
  target: z.string().nullable().describe('Test, drug, referral, or behaviour it concerns'),
  acted_on: z.enum(['yes', 'no', 'unknown']).nullable().describe('Only if the same document states whether it happened'),
});

export const referralAttributes = z.object({
  to: z.string(),
  specialty: z.string().nullable(),
  from: z.string().nullable(),
  reason: z.string().nullable(),
  status: z.enum(['proposed', 'placed', 'scheduled', 'completed', 'declined', 'unknown']).nullable(),
});

export const recordReferenceAttributes = z.object({
  record_type: z.enum([
    'clinical_note', 'lab', 'imaging_report', 'imaging_images', 'dicom', 'pathology',
    'operative_report', 'discharge_summary', 'portal_thread', 'billing', 'genetic', 'other',
  ]),
  description: z.string().describe('What record is referenced, e.g. "FDG-PET brain, outside hospital"'),
  institution: z.string().nullable(),
  record_date: dateField,
  present_in_this_document: z.boolean().describe('True only if the referenced record itself (its full report or results) is reproduced in this document'),
});

export const followUpAttributes = z.object({
  what: z.string(),
  who: z.string().nullable().describe('Who promised or owns it'),
  due: dateField,
  status: z.enum(['promised', 'scheduled', 'done', 'missed', 'unknown']).nullable(),
});

export const eventAttributes = z.object({
  name: z.string(),
  detail: z.string().nullable(),
});

export const factAttributesByType = {
  lab_result: labAttributes,
  medication: medicationAttributes,
  diagnosis: diagnosisAttributes,
  procedure: procedureAttributes,
  symptom: symptomAttributes,
  clinician_statement: clinicianStatementAttributes,
  imaging_result: imagingAttributes,
  vital: vitalAttributes,
  allergy_intolerance: intoleranceAttributes,
  recommendation: recommendationAttributes,
  referral: referralAttributes,
  record_reference: recordReferenceAttributes,
  follow_up: followUpAttributes,
  event: eventAttributes,
} as const;

// ---------------------------------------------------------------------------
// Model-facing shape: attributes as string pairs
// ---------------------------------------------------------------------------
export const attributePair = z.object({
  key: z.string().describe('Attribute key for the fact type (see the attribute key guide)'),
  value: z.string().describe('Value as text. Numbers as digits, booleans as true/false, unknown as an empty string'),
});
export const attributePairs = z.array(attributePair);
export type AttributePair = z.infer<typeof attributePair>;

export const extractedCitation = z.object({
  page: z.number().int().describe('1-based page number from the === PAGE n === marker the passage sits under'),
  quote: z.string().describe('Verbatim passage copied from that page, 5 to 300 characters, exactly as it appears including typos'),
});

/** Allowed values for `objectivity` and `asserted_by` as text, so the model-facing schema stays free of unions. */
export const OBJECTIVITY_VALUES = ['objective', 'subjective'] as const;
export const ASSERTED_BY_VALUES = ['patient', 'clinician', 'compiler', 'unknown'] as const;

/**
 * One extracted fact as the model returns it.
 *
 * Lenient on purpose (2026-10-07, large exports): the API enforces only the shape, not `maxItems` or number bounds
 * (the SDK moves them into the description and the zod check after the call used to fail the WHOLE call). So the
 * citation count has no upper bound here (every citation is verified and flagged, never dropped; the prompt asks for
 * one to four) and the confidence is clamped to 0-1 when it is stored (`clampConfidence`), never a failed call.
 */
export const extractedFact = z.object({
  type: z.enum(FACT_TYPES),
  statement: z.string().describe('One self-contained sentence stating the fact, with the value, unit, and date when present'),
  date: dateField,
  date_end: dateField,
  confidence: z.number().describe('From 0 to 1: how sure you are the statement is what the document says, not whether it is medically true'),
  attributes: attributePairs.describe('Only the keys that apply to `type`, from the attribute key guide'),
  citations: z.array(extractedCitation).min(1).describe('One to four citations; more only when the same fact is printed on more pages'),
  people_mentioned: z.array(z.string()).describe('Clinician or institution names this fact involves, as written'),
  // Both carry a default so older fixtures parse; the model-facing JSON schema still lists them as required (a default never makes a property optional there).
  objectivity: z
    .string()
    .default('')
    .describe(
      'Exactly "objective" or "subjective". objective = something measured or recorded as an event: lab values, vitals, imaging measurements and findings as read, doses prescribed, procedures performed, dates, referrals placed. subjective = an assessment or opinion: treatment effect or tolerance ("improved", "no benefit"), symptom severity narratives, diagnostic impressions and their certainty, claims that a record is or is not missing, the rationale behind a recommendation. Empty string when unsure.',
    ),
  asserted_by: z
    .string()
    .default('')
    .describe(
      'Exactly "patient", "clinician", "compiler" or "unknown": whose voice asserts the fact. patient = first-person voice or an annotation written by the patient ("I never tolerated codeine", "this is wrong, it was 2019"); clinician = a clinician or institution recording it, including "patient reports ..."; compiler = a summary, dossier or AI analysis restating other records. Empty string when unsure.',
    ),
});

const documentFields = {
  document_title: z.string().describe('A short, specific title for the whole document: what it is, about what, from whom or which institution, and the date as written. Never a file name'),
  document_summary: z.string().describe('Two or three sentences on what this chunk is: document type, author, institution, date, purpose'),
  document_date: dateField.describe('The date the document was written or signed, if stated'),
  document_category: z.enum([
    'clinical_note', 'lab_report', 'imaging_report', 'portal_message', 'call_transcript',
    'summary', 'dossier', 'letter', 'discharge_summary', 'operative_report', 'pathology', 'other',
  ]).nullable(),
  institution: z.string().nullable(),
  author: z.string().nullable(),
};

/** What the model must return (sent as the structured-output schema). */
export const extractionOutput = z.object({ ...documentFields, facts: z.array(extractedFact) });

/**
 * Server-side parser that also accepts typed attribute objects (manual input,
 * fixtures) and tolerates the two voice fields being absent (older fixtures;
 * the server coerces them per fact type and document tier). Never sent to the API.
 */
export const extractedFactLenient = extractedFact.extend({
  attributes: z.union([attributePairs, z.record(z.string(), z.unknown())]),
  objectivity: z.string().optional().default(''),
  asserted_by: z.string().optional().default(''),
});
export const extractionOutputLenient = z.object({ ...documentFields, document_title: z.string().nullable().optional(), facts: z.array(extractedFactLenient) });

/** A model confidence kept inside 0-1 (NaN or a missing value reads 0.5). The output check no longer refuses it. */
export function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export type ExtractedFact = z.input<typeof extractedFactLenient>;
export type ExtractedCitation = z.infer<typeof extractedCitation>;
export type ExtractionOutput = z.input<typeof extractionOutputLenient>;
export type ExtractionOutputModel = z.infer<typeof extractionOutput>;

// ---------------------------------------------------------------------------
// Objectivity and voice: defaults by type, coercion of what the model said
// ---------------------------------------------------------------------------

export type ObjectivityValue = (typeof OBJECTIVITY_VALUES)[number];
export type AssertedByValue = (typeof ASSERTED_BY_VALUES)[number];

function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * What a fact type is when the model did not say: measurements and recorded
 * events are objective; assessments, impressions, effects and claims are
 * subjective. A medication fact is objective (a dose on record) unless it
 * carries a stated effect; a record reference is objective only when the
 * record itself is reproduced in the document.
 */
export function defaultObjectivity(type: string, attributes?: Record<string, unknown> | null): ObjectivityValue {
  switch (type) {
    case 'lab_result':
    case 'vital':
    case 'procedure':
    case 'event':
    case 'referral':
    case 'imaging_result':
      return 'objective';
    case 'medication':
      return hasText(attributes?.effect) ? 'subjective' : 'objective';
    case 'record_reference':
      return attributes?.present_in_this_document === true ? 'objective' : 'subjective';
    default:
      // clinician_statement, symptom, recommendation, follow_up, diagnosis, allergy_intolerance
      return 'subjective';
  }
}

/** The model's text, or the default for the type when it is not one of the two values. */
export function coerceObjectivity(raw: unknown, type: string, attributes?: Record<string, unknown> | null): ObjectivityValue {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (t === 'objective' || t === 'subjective') return t;
  return defaultObjectivity(type, attributes);
}

/** Stored value when it is decisive, else the default for the type (older rows carry 'unknown'). */
export function effectiveObjectivity(f: { type: string; objectivity?: string | null; attributes?: Record<string, unknown> | null }): ObjectivityValue {
  return coerceObjectivity(f.objectivity, f.type, f.attributes);
}

/** Voice by document tier when the model did not say: a patient document speaks for the patient, a primary document for the institution, a compilation for its compiler. */
export function defaultAssertedBy(tier: string | null | undefined): AssertedByValue {
  switch (tier) {
    case 'patient':
      return 'patient';
    case 'primary':
      return 'clinician';
    case 'compilation':
      return 'compiler';
    default:
      return 'unknown';
  }
}

export function coerceAssertedBy(raw: unknown, tier?: string | null): AssertedByValue {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (t === 'patient' || t === 'clinician' || t === 'compiler') return t;
  if (t === 'chief_of_staff' || t === 'family' || t === 'caregiver') return 'patient';
  if (t === 'ai' || t === 'ai_summary' || t === 'summary' || t === 'dossier') return 'compiler';
  if (t === 'doctor' || t === 'physician' || t === 'nurse' || t === 'institution' || t === 'lab' || t === 'radiologist') return 'clinician';
  return defaultAssertedBy(tier);
}
export type LabAttributes = z.infer<typeof labAttributes>;
export type MedicationAttributes = z.infer<typeof medicationAttributes>;
export type RecordReferenceAttributes = z.infer<typeof recordReferenceAttributes>;

/** Pairs -> plain object (last key wins). Objects pass through. */
export function pairsToObject(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const p of raw) {
      if (p && typeof p === 'object' && typeof (p as AttributePair).key === 'string') out[(p as AttributePair).key.trim()] = (p as AttributePair).value;
    }
    return out;
  }
  if (raw && typeof raw === 'object') return { ...(raw as Record<string, unknown>) };
  return {};
}

function unwrap(s: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = s;
  for (let i = 0; i < 6; i++) {
    const def = (cur as unknown as { def?: { type?: string; innerType?: z.ZodTypeAny } }).def;
    if (def && (def.type === 'nullable' || def.type === 'optional' || def.type === 'default') && def.innerType) cur = def.innerType;
    else break;
  }
  return cur;
}

function kindOf(s: z.ZodTypeAny): 'number' | 'boolean' | 'enum' | 'string' {
  const def = (unwrap(s) as unknown as { def?: { type?: string } }).def;
  switch (def?.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enum';
    default:
      return 'string';
  }
}

function enumValues(s: z.ZodTypeAny): string[] {
  const def = (unwrap(s) as unknown as { def?: { entries?: Record<string, string> } }).def;
  return def?.entries ? Object.values(def.entries) : [];
}

function isNullish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '' || t === 'null' || t === 'none' || t === 'n/a' || t === 'unknown_value';
  }
  return false;
}

/** Coerce one raw value (usually text) to the kind the typed schema expects. */
function coerce(kind: ReturnType<typeof kindOf>, v: unknown, allowed: string[]): unknown {
  if (isNullish(v)) return null;
  switch (kind) {
    case 'number': {
      if (typeof v === 'number') return v;
      const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : null;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const t = String(v).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(t)) return true;
      if (['false', 'no', 'n', '0'].includes(t)) return false;
      return null;
    }
    case 'enum': {
      const t = String(v).trim();
      const exact = allowed.find((a) => a === t);
      if (exact) return exact;
      const ci = allowed.find((a) => a.toLowerCase() === t.toLowerCase().replace(/[\s-]+/g, '_'));
      return ci ?? t; // let the schema report the bad value
    }
    default:
      return typeof v === 'string' ? v : String(v);
  }
}

// ---------------------------------------------------------------------------
// Lab values as printed (2026-10): what the extraction and every edit store
// ---------------------------------------------------------------------------

/**
 * Lab keys whose text is kept as given: '' and words ("None", "N/A") are printed answers or a blank flag column, not
 * "missing". Only the literal "null" and "unknown_value" mean missing (amendment F1).
 */
const KEEP_TEXT_KEYS: Record<string, ReadonlySet<string>> = { lab_result: new Set(['value', 'flag_raw']) };

function keepText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : String(v);
  const t = s.trim().toLowerCase();
  return t === 'null' || t === 'unknown_value' ? null : s;
}

const FLAG_LETTERS = ['H', 'L', 'N', 'A', 'C'] as const;
type FlagLetter = (typeof FLAG_LETTERS)[number];

function flagLetter(v: string): FlagLetter | null {
  const t = v.trim().toUpperCase();
  return (FLAG_LETTERS as readonly string[]).includes(t) ? (t as FlagLetter) : null;
}

/** A blank or a dash: "no flag printed". */
function isBlankFlag(v: string): boolean {
  return /^[\s\-–—]*$/.test(v);
}

/** One text of a lab attribute as given (numbers as their text), or null when nothing is there. */
function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

/** A bound or number the model or the user gave: the number when the text is a plain number (a unit after it is allowed), else the parse. */
function plainNumber(p: ParsedValue): number | null {
  return p.kind === 'number' && p.number != null && !p.flagInValue && !p.ambiguousTail ? p.number : null;
}

/**
 * The lab_result attributes made consistent with the rules before they are coerced and validated:
 * - value_num only when the value is a plain number ("<3" with value_num 3 -> value_num empty; a limit is not a
 *   measurement); kept when no value text is given.
 * - ref_low / ref_high only when plain numbers; "<50" or "635-1741" given as a bound moves into ref_text when ref_text
 *   is empty (never read as a number).
 * - flag (the normalised field) only H, L, N, A or C: "HH" -> H with flag_raw "HH"; "-" -> no flag, flag_raw "-";
 *   anything else the app does not read -> no flag, kept as flag_raw.
 * - from the model only (amendment F2): a flag given where the page shows none (flag_raw '' or '-') is not stored as a
 *   flag: it is kept apart in `_flagConflict` and the reading says so; a printed flag that means something else than
 *   the flag field wins and the field's value goes to `_flagConflict`; a flag field with no flag_raw at all is copied
 *   into flag_raw, recorded as `_flagFrom: 'flag field'`; a printed flag with no flag field fills the field.
 * The user's own entries are never second-guessed: from a user, flag and flag_raw are kept as given (only an unknown
 * flag word moves to flag_raw so the edit is not refused).
 */
function prepareLabAttributes(input: Record<string, unknown>, fromModel: boolean): { input: Record<string, unknown>; extra: Record<string, unknown> } {
  const a: Record<string, unknown> = { ...input };
  const extra: Record<string, unknown> = {};

  // The value and its number.
  const valueText = keepText(a.value);
  const value = parseLabValue(valueText);
  if (a.value_num !== undefined && a.value_num !== null && a.value_num !== '') {
    const n = typeof a.value_num === 'number' ? (Number.isFinite(a.value_num) ? a.value_num : null) : plainNumber(parseLabValue(String(a.value_num)));
    const valueSaysOtherwise = value.kind !== 'number' && value.kind !== 'empty';
    a.value_num = n == null || valueSaysOtherwise ? '' : n;
  }

  // The range: plain numbers stay bounds; anything else is range text.
  const moved: string[] = [];
  for (const key of ['ref_low', 'ref_high'] as const) {
    const v = a[key];
    if (v === undefined || v === null || typeof v === 'number') continue;
    const t = String(v);
    if (!t.trim() || isNullishText(t)) {
      a[key] = '';
      continue;
    }
    const n = plainNumber(parseLabValue(t));
    if (n != null) a[key] = n;
    else {
      if (!moved.includes(t.trim())) moved.push(t.trim());
      a[key] = '';
    }
  }
  const refText = textOf(a.ref_text);
  if (moved.length && (refText == null || isNullishText(refText))) a.ref_text = moved.join('; ');

  // The flag: the normalised field and the flag as printed.
  const flagGiven = textOf(a.flag);
  const flagText = flagGiven != null && !isNullishText(flagGiven) ? flagGiven.trim() : null;
  let flagRaw = keepText(a.flag_raw);
  let flag: FlagLetter | null = null;
  if (flagText != null) {
    const letter = flagLetter(flagText);
    if (letter) flag = letter;
    else {
      const p = parseFlag(flagText);
      flag = p.printed;
      // A flag word in the flag field ("HH", "High", "-", "Pos") is a flag as printed.
      if (!fromModel && (flagRaw == null || !flagRaw.trim())) flagRaw = flagText;
    }
  }
  if (fromModel) {
    const fieldMark = flagText != null && !isBlankFlag(flagText) ? flagText : null;
    if (flagRaw == null) {
      // No flag as printed was given: the flag field is all there is ("H", "HH", or "-" for a dash on the page).
      if (flagText != null) {
        flagRaw = flagText;
        extra._flagFrom = 'flag field';
      }
    } else if (isBlankFlag(flagRaw)) {
      // The page shows no flag (blank or a dash) but the model gave one: the page is followed, the model's flag kept apart.
      if (fieldMark != null) {
        extra._flagConflict = fieldMark;
        flag = null;
      }
    } else {
      const printed = parseFlag(flagRaw);
      if (printed.state === 'flag') {
        if (fieldMark != null && flag !== printed.printed) extra._flagConflict = fieldMark;
        flag = printed.printed;
      }
    }
  }
  a.flag = flag ?? '';
  if (flagRaw != null) a.flag_raw = flagRaw;
  else delete a.flag_raw;
  return { input: a, extra };
}

function isNullishText(t: string): boolean {
  const s = t.trim().toLowerCase();
  return s === '' || s === 'null' || s === 'none' || s === 'n/a' || s === 'unknown_value';
}

export interface ValidateOptions {
  /**
   * 'model': the extraction's output. The lab flag rules of amendment F2 apply (a flag where the page shows none is
   * kept apart, a missing flag_raw is filled from the flag field), and private `_flagConflict` / `_flagFrom` keys may
   * come back in the value. 'user' (default): an edit, a manual fact, a fixture; flags are kept as given.
   */
  from?: 'model' | 'user';
}

/**
 * Validate (and narrow) attributes against the typed schema for the fact
 * type. Accepts the typed object shape or the model-facing pairs. Keys the
 * typed schema does not know are dropped, missing nullable keys become null,
 * numbers/booleans/enums are coerced from text, and required fields are
 * enforced. Returns the typed value or an error message.
 *
 * lab_result (2026-10): the value and flag_raw keep '' and words ("None", "N/A") as printed; the value, its number,
 * the range and the flag are made consistent first (prepareLabAttributes); the keys added in 2026-10 are left out
 * when empty (LAB_KEYS_STORED_WHEN_SET).
 */
export function validateAttributes(type: string, attributes: unknown, opts: ValidateOptions = {}): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const schema = (factAttributesByType as Record<string, z.ZodObject<z.ZodRawShape>>)[type];
  if (!schema) return { ok: false, error: `unknown fact type ${type}` };
  let input = pairsToObject(attributes);
  let extra: Record<string, unknown> = {};
  if (type === 'lab_result') ({ input, extra } = prepareLabAttributes(input, opts.from === 'model'));
  const keep = KEEP_TEXT_KEYS[type];
  const filled: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    filled[key] = keep?.has(key) ? keepText(input[key]) : coerce(kindOf(field as z.ZodTypeAny), input[key], enumValues(field as z.ZodTypeAny));
  }
  const r = schema.safeParse(filled);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const value = r.data as Record<string, unknown>;
  if (type === 'lab_result') {
    for (const key of LAB_KEYS_STORED_WHEN_SET) if (value[key] === null || value[key] === undefined) delete value[key];
    Object.assign(value, extra);
  }
  return { ok: true, value };
}

/** Typed object -> pairs (for tests and manual entry). */
export function objectToPairs(obj: Record<string, unknown>): AttributePair[] {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ key, value: v === null ? '' : typeof v === 'string' ? v : String(v) }));
}

/**
 * Human-readable list of the attribute keys per fact type, generated from the
 * typed schemas so the prompt can never drift from validation. Required keys
 * are marked with *, enums list their values.
 */
export function attributeKeyGuide(): string {
  const lines: string[] = [];
  for (const [type, schema] of Object.entries(factAttributesByType)) {
    const parts: string[] = [];
    for (const [key, field] of Object.entries((schema as z.ZodObject<z.ZodRawShape>).shape)) {
      const f = field as z.ZodTypeAny;
      const required = !(f as unknown as { def?: { type?: string } }).def || (f as unknown as { def: { type: string } }).def.type !== 'nullable';
      const kind = kindOf(f);
      const extra = kind === 'enum' ? `(${enumValues(f).join('|')})` : kind === 'number' ? '(number)' : kind === 'boolean' ? '(true|false)' : '';
      parts.push(`${key}${required ? '*' : ''}${extra}`);
    }
    lines.push(`- ${type}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}
