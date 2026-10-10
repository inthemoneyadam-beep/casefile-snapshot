/**
 * Enumerations shared by the database schema, the API, and the UI. Keep the
 * arrays `as const` so both zod and drizzle can consume them.
 */
export const DOCUMENT_KINDS = ['pdf', 'image', 'docx', 'text', 'csv', 'json', 'dicom', 'audio_transcript', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_CATEGORIES = [
  'clinical_note', 'lab_report', 'imaging_report', 'portal_message', 'call_transcript',
  'summary', 'dossier', 'letter', 'discharge_summary', 'operative_report', 'pathology', 'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const TEXT_STATUSES = ['pending', 'extracting', 'extracted', 'ocr_needed', 'ocr_running', 'ocr_done', 'failed'] as const;
export type TextStatus = (typeof TEXT_STATUSES)[number];

/**
 * `partial` (2026-10-07): a pass ended with some pages still unread or failed (a document is `done` only when every
 * page is accounted for: read, OCRed then read, parsed, or skipped with a reason; see src/shared/schemas/segments.ts).
 */
export const EXTRACTION_STATUSES = ['none', 'queued', 'running', 'done', 'partial', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const FACT_TYPES = [
  'lab_result', 'diagnosis', 'medication', 'procedure', 'symptom', 'clinician_statement',
  'imaging_result', 'vital', 'allergy_intolerance', 'recommendation', 'referral',
  'record_reference', 'follow_up', 'event',
] as const;
export type FactType = (typeof FACT_TYPES)[number];

export const FACT_STATUSES = ['unverified', 'confirmed', 'disputed', 'superseded'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** parsed (2026-10-08): a lab value the app read off the page itself (the lab check, or the clinician at the user's request). */
export const FACT_ORIGINS = ['ai', 'manual', 'import', 'parsed'] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];

export const MERGE_STATUSES = ['pending', 'accepted', 'rejected'] as const;

export const PERSON_KINDS = ['clinician', 'clinic', 'institution', 'advocate', 'family', 'chief_of_staff', 'patient', 'other'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

/** `third_party` (2026-10-07): the care team's own call or message to someone else (a pharmacy, an infusion centre). */
export const COMM_DIRECTIONS = ['inbound', 'outbound', 'internal', 'bidirectional', 'third_party'] as const;
export type CommDirection = (typeof COMM_DIRECTIONS)[number];
export const COMM_CHANNELS = ['portal', 'call', 'email', 'visit', 'fax', 'letter', 'text', 'video', 'other'] as const;
export const PARTICIPANT_ROLES = ['from', 'to', 'cc', 'present'] as const;

export const RECORD_TYPES = [
  'clinical_note', 'lab', 'imaging_report', 'imaging_images', 'dicom', 'pathology',
  'operative_report', 'discharge_summary', 'portal_thread', 'billing', 'genetic', 'other',
] as const;
export const RECORD_FORMATS = ['report', 'images', 'dicom', 'raw', 'unknown'] as const;
export const RECORD_STATUSES = ['unknown', 'expected', 'requested', 'received', 'not_held', 'denied'] as const;

export const ENCOUNTER_KINDS = ['visit', 'telehealth', 'procedure', 'admission', 'test', 'infusion', 'other'] as const;
export const ENCOUNTER_STATUSES = ['upcoming', 'completed', 'cancelled'] as const;

export const MED_STATUSES = ['active', 'stopped', 'prn', 'planned', 'unknown'] as const;
export const MED_EVENT_KINDS = ['start', 'stop', 'dose_change', 'hold', 'resume', 'reaction', 'note'] as const;
export const INTOLERANCE_KINDS = ['allergy', 'intolerance', 'hard_stop', 'caution'] as const;
export const INTOLERANCE_SEVERITIES = ['mild', 'moderate', 'severe', 'life_threatening', 'unknown'] as const;

export const SPECIMENS = ['serum', 'plasma', 'whole_blood', 'csf', 'urine', 'other'] as const;
export const LAB_FLAGS = ['H', 'L', 'N', 'A', 'C'] as const; // high, low, normal, abnormal, critical
export const IMAGING_MODALITIES = ['MRI', 'CT', 'PET', 'PET-CT', 'PET-MRI', 'SPECT', 'XR', 'US', 'EEG', 'EMG', 'NCS', 'other'] as const;

export const TASK_OWNERS = ['me', 'chief_of_staff', 'advocate', 'person'] as const;
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
/** plan_item (2026-10-09): "Make a to-do" on an item of the Plan page; the item names the to-do back (plan_items.task_id). */
/** care_candidate (2026-10-09): a follow-up with someone on the Care team (source_id = care_candidates.id). */
export const TASK_SOURCE_TYPES = ['fact', 'finding', 'communication', 'document', 'encounter', 'record', 'manual', 'plan_item', 'care_candidate'] as const;

/** The kinds the cross-reference pass (rules and Claude's reading across the case) may give a finding. */
export const CROSSREF_FINDING_CATEGORIES = ['discrepancy', 'missing_record', 'trend', 'overlooked', 'correlation'] as const;
/**
 * Every kind of finding. 2026-10-09 (checked against itself, shared/selfcheck.ts): `contradicts_itself` (one document
 * says two things that cannot both be true) and `flag_mismatch` (a lab flag that doesn't match its own value and range).
 */
export const FINDING_CATEGORIES = [...CROSSREF_FINDING_CATEGORIES, 'contradicts_itself', 'flag_mismatch'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export const FINDING_STATUSES = ['new', 'confirmed', 'dismissed', 'resolved', 'disputed'] as const;

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
/**
 * 2026-10-07: `segment_document` (pages scanned, OCR where an image carries the content, segments written, messages
 * parsed; no AI), `resume_extraction` (read the segments not yet read, one document at a time), `rules_after_ingest`
 * (the deterministic checks after a document pass: gaps, follow-ups, disagreements; debounced).
 */
export const JOB_TYPES = [
  'ingest_document', 'extract_facts', 'crossref', 'export_packet', 'reingest_document', 'triage_document',
  'segment_document', 'resume_extraction', 'rules_after_ingest',
  // 2026-10-09: read a plan document into the Plan page's framework (services/plans.ts; lane ai).
  'read_plan',
  // 2026-10-09 (My notes): several of the user's short notes read in one call (services/notes-reading.ts).
  'read_notes',
  // 2026-10-09: a document checked against itself (services/self-check.ts: lab flags, then contradictions by Claude).
  'self_check',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const AI_PURPOSES = ['extract_facts', 'crossref', 'ask', 'draft', 'briefing', 'classify_document', 'count_tokens', 'test', 'self_check'] as const;

// ---------------------------------------------------------------------------
// Document intelligence (Phase 4, slice Q): source tiers, authorship, objectivity
// ---------------------------------------------------------------------------
/** Who produced a document. See docs/API-CONTRACTS-3.md, Slice Q. */
export const SOURCE_TIERS = ['primary', 'patient', 'compilation', 'external', 'unknown'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const AUTHOR_ROLES = ['clinician', 'patient', 'chief_of_staff', 'ai_summary', 'advocate', 'other'] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];

/** Who set a document's title; the model never overwrites a user title. */
export const TITLE_SOURCES = ['filename', 'ai', 'user'] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

/** objective = measured or recorded as an event; subjective = an assessment or opinion. */
export const OBJECTIVITIES = ['objective', 'subjective', 'unknown'] as const;
export type Objectivity = (typeof OBJECTIVITIES)[number];

/** Who asserts a fact in the text it came from. */
export const ASSERTED_BY = ['patient', 'clinician', 'compiler', 'unknown'] as const;
export type AssertedBy = (typeof ASSERTED_BY)[number];

// ---------------------------------------------------------------------------
// Large exports and the messages inside them (2026-10-07; migration 0005). TS only: the columns are plain text.
// Shapes and helpers: src/shared/schemas/segments.ts; trust per passage: src/shared/trust.ts.
// ---------------------------------------------------------------------------
/**
 * What a segment of a document holds (`document_segments.kind`). An Epic export is cut by encounter (PDF bookmarks,
 * then the printed banner), then by section, then oversized sections by item; an unknown layout falls back to blocks
 * of pages (`pages`). `education` is inpatient teaching documentation and `instructions` clinician-written patient
 * instructions: both are clinical and never skipped as boilerplate.
 */
export const SEGMENT_KINDS = [
  'patient_summary', 'facesheet', 'visit_info', 'note', 'telephone', 'messages', 'letter', 'questionnaire',
  'appointment_request', 'patient_entered', 'lab_results', 'imaging', 'orders', 'medication_list', 'mar',
  'flowsheets', 'vitals', 'procedures', 'therapy_plan', 'care_plan', 'history', 'instructions', 'education', 'media',
  'boilerplate', 'pages', 'other',
] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * Where a segment stands (`document_segments.status`). Settled: done (read by the model), parsed (read by a parser and
 * needing no model), skipped (with a reason), no_text (nothing to read, with a reason). Not settled: pending, running,
 * failed (with an error; the document stays `partial`).
 */
export const SEGMENT_STATUSES = ['pending', 'running', 'done', 'skipped', 'failed', 'no_text', 'parsed'] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

/**
 * Why a segment or page was not sent to the model. `duplicate`: the same text as another page AND no image (a page
 * carrying an image is never skipped); `boilerplate`: a repeated block (facesheet, "No documentation.") with a pointer to
 * its twin; `blank`: only the running header, footer and a section label; `no_text`: nothing readable even after OCR.
 */
export const SEGMENT_SKIP_REASONS = ['duplicate', 'boilerplate', 'blank', 'no_text'] as const;
export type SegmentSkipReason = (typeof SEGMENT_SKIP_REASONS)[number];

/** How a segment is read: by the model, by a parser (no AI), by both, or not at all (skipped with a reason). */
export const SEGMENT_ROUTES = ['extract', 'parse', 'parse_and_extract', 'skip'] as const;
export type SegmentRoute = (typeof SEGMENT_ROUTES)[number];

/** One page's state in a document's coverage. */
export const PAGE_COVERAGE_STATES = ['done', 'parsed', 'skipped', 'no_text', 'failed', 'running', 'pending'] as const;
export type PageCoverageState = (typeof PAGE_COVERAGE_STATES)[number];

/** What kind of contact a communication read out of a record is (`communications.details_json.kind`). */
export const COMM_MESSAGE_KINDS = [
  'portal_message', 'telephone_encounter', 'appointment_request', 'questionnaire', 'letter', 'patient_entered_data',
  'email', 'call_record',
] as const;
export type CommMessageKind = (typeof COMM_MESSAGE_KINDS)[number];

/** Whose words a message body is. Patient bodies are tier `patient` even inside a clinical record (trust.ts). */
export const MESSAGE_VOICES = ['patient', 'clinician', 'staff', 'system', 'third_party', 'unknown'] as const;
export type MessageVoice = (typeof MESSAGE_VOICES)[number];

/** How a communication came to be (`details_json.origin`; absent on rows made before 0005, which read as manual). */
export const COMM_ORIGINS = ['manual', 'import', 'filed', 'extracted'] as const;
export type CommOrigin = (typeof COMM_ORIGINS)[number];
