/**
 * Casefile database schema (SQLite via SQLCipher). One file, all phases.
 *
 * Conventions
 * - ids are UUID strings generated in application code (crypto.randomUUID()).
 * - timestamps are ISO-8601 strings; `created_at`/`updated_at` are full
 *   datetimes, clinical dates are partial (see src/shared/dates.ts) and carry a
 *   `*_precision` and `*_text` sibling.
 * - JSON columns end in `_json` and are stored as text.
 * - Enumerations come from src/shared/enums.ts and are enforced in zod at the
 *   API boundary, not with CHECK constraints, so a schema bump never needs a
 *   table rebuild.
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const aiCalls = sqliteTable('ai_calls', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull().default(now()),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  jobId: text('job_id'),
  documentIdsJson: text('document_ids_json').notNull().default('[]'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  estimatedUsd: real('estimated_usd').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  status: text('status').notNull().default('ok'), // ok | error | refused | blocked
  error: text('error'),
  requestSummary: text('request_summary'),
  stopReason: text('stop_reason'),
}, (t) => [index('ai_calls_created_idx').on(t.createdAt), index('ai_calls_purpose_idx').on(t.purpose)]);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  lane: text('lane').notNull().default('ingest'), // ingest | ai | export
  payloadJson: text('payload_json').notNull().default('{}'),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(2),
  progress: real('progress').notNull().default(0),
  progressText: text('progress_text'),
  error: text('error'),
  resultJson: text('result_json'),
  documentId: text('document_id'),
  createdAt: text('created_at').notNull().default(now()),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
}, (t) => [index('jobs_status_idx').on(t.status, t.lane, t.priority), index('jobs_document_idx').on(t.documentId)]);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  kind: text('kind').notNull(), // DocumentKind
  category: text('category').notNull().default('other'), // DocumentCategory
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  institutionId: text('institution_id'),
  authorPersonId: text('author_person_id'),
  documentDate: text('document_date'),
  documentDatePrecision: text('document_date_precision').notNull().default('unknown'),
  documentDateText: text('document_date_text'),
  pageCount: integer('page_count').notNull().default(0),
  textStatus: text('text_status').notNull().default('pending'),
  textError: text('text_error'),
  ocrApplied: integer('ocr_applied', { mode: 'boolean' }).notNull().default(false),
  extractionStatus: text('extraction_status').notNull().default('none'),
  extractionSchemaVersion: integer('extraction_schema_version'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  tagsJson: text('tags_json').notNull().default('[]'),
  notes: text('notes'),
  /** primary | patient | compilation | external | unknown (see docs/API-CONTRACTS-3.md, Slice Q). */
  sourceTier: text('source_tier').notNull().default('unknown'),
  authorRole: text('author_role'),
  /** filename | ai | user: who set the title; the model never overwrites a user title. */
  titleSource: text('title_source').notNull().default('filename'),
  briefJson: text('brief_json'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [
  index('documents_date_idx').on(t.documentDate),
  index('documents_category_idx').on(t.category),
  index('documents_sha_idx').on(t.sha256),
]);

export const documentPages = sqliteTable('document_pages', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  pageNumber: integer('page_number').notNull(),
  text: text('text').notNull().default(''),
  ocr: integer('ocr', { mode: 'boolean' }).notNull().default(false),
  confidence: real('confidence'),
  width: real('width'),
  height: real('height'),
  charCount: integer('char_count').notNull().default(0),
  /** JSON array of OCR/text word boxes [{t,x0,y0,x1,y1}] when available. */
  boxesJson: text('boxes_json'),
}, (t) => [uniqueIndex('document_pages_doc_page_idx').on(t.documentId, t.pageNumber)]);

export const extractionRuns = sqliteTable('extraction_runs', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  model: text('model').notNull(),
  deep: integer('deep', { mode: 'boolean' }).notNull().default(false),
  status: text('status').notNull().default('running'), // running | done | failed
  startedAt: text('started_at').notNull().default(now()),
  finishedAt: text('finished_at'),
  factsCount: integer('facts_count').notNull().default(0),
  mergesProposed: integer('merges_proposed').notNull().default(0),
  chunks: integer('chunks').notNull().default(0),
  aiCallIdsJson: text('ai_call_ids_json').notNull().default('[]'),
  error: text('error'),
}, (t) => [index('extraction_runs_doc_idx').on(t.documentId)]);

/**
 * A document cut into passages that are read, skipped or parsed on their own (migration 0005, 2026-10-07): an encounter,
 * a section of one, or a block of pages when the layout is unknown. Coverage, checkpoints, resume, routing and recorded
 * skips hang off these rows; `documents.metadata_json.coverage` is only their summary. Derived data: a re-segmentation
 * retires old rows with `superseded_at` and never deletes them. Shapes: src/shared/schemas/segments.ts.
 */
export const documentSegments = sqliteTable('document_segments', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  /** Order within the document, from 0, in page order. */
  seq: integer('seq').notNull(),
  /** First and last page, 1-based and inclusive (the page_number of document_pages). */
  pageStart: integer('page_start').notNull(),
  pageEnd: integer('page_end').notNull(),
  /** SegmentKind (src/shared/enums.ts SEGMENT_KINDS). */
  kind: text('kind').notNull().default('other'),
  /** The encounter banner (or section heading) as printed, wrapped lines joined. */
  headerText: text('header_text'),
  /** The encounter's date as a partial date (never the print date of a plan block). */
  encounterDate: text('encounter_date'),
  encounterDatePrecision: text('encounter_date_precision').notNull().default('unknown'),
  encounterDateText: text('encounter_date_text'),
  /** As printed: "Patient Message", "ED", "Telephone", ... */
  encounterType: text('encounter_type'),
  department: text('department'),
  /** "Encounter #" only when the export prints it (in a large Epic chart print only some encounters print it). */
  encounterNumber: text('encounter_number'),
  /** Per-segment tier when the passage's author differs from the document's (null = the document's tier). */
  sourceTier: text('source_tier'),
  /** Hash of the normalised text plus image digests (src/shared/schemas/segments.ts). */
  textHash: text('text_hash'),
  duplicateOfSegmentId: text('duplicate_of_segment_id'),
  /** SegmentStatus: pending | running | done | skipped | failed | no_text | parsed */
  status: text('status').notNull().default('pending'),
  /** SegmentSkipReason when status is skipped or no_text. */
  skipReason: text('skip_reason'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  /** The extraction pass that last read it. */
  extractionRunId: text('extraction_run_id'),
  /** EXTRACTION_SCHEMA_VERSION * 1000 + SEGMENTER_VERSION of the result it holds (segmentSchemaVersion). */
  schemaVersion: integer('schema_version'),
  factsCount: integer('facts_count').notNull().default(0),
  messagesCount: integer('messages_count').notNull().default(0),
  /** The encounters row made or linked from it. */
  encounterId: text('encounter_id'),
  /** The records_inventory row that says "held here". */
  recordId: text('record_id'),
  /** SegmentDetail: per-page hashes and image digests, OCR, route reason, ai call ids, signature, copyOf. */
  detailJson: text('detail_json').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  supersededAt: text('superseded_at'),
}, (t) => [
  index('document_segments_doc_idx').on(t.documentId, t.seq),
  index('document_segments_status_idx').on(t.documentId, t.status),
  index('document_segments_hash_idx').on(t.textHash),
]);

// ---------------------------------------------------------------------------
// Facts and provenance
// ---------------------------------------------------------------------------
export const facts = sqliteTable('facts', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // FactType
  statement: text('statement').notNull(),
  date: text('date'),
  datePrecision: text('date_precision').notNull().default('unknown'),
  dateText: text('date_text'),
  dateEnd: text('date_end'),
  attributesJson: text('attributes_json').notNull().default('{}'),
  confidence: real('confidence').notNull().default(0.5),
  status: text('status').notNull().default('unverified'), // FactStatus
  supersededById: text('superseded_by_id'),
  verdictNote: text('verdict_note'),
  verdictAt: text('verdict_at'),
  /** What a confirmed fact was checked against: 'original' (the original record) | 'summary' (only a summary) | null (not said). */
  verdictBasis: text('verdict_basis'),
  origin: text('origin').notNull().default('ai'),
  sourceDocumentId: text('source_document_id'),
  extractionRunId: text('extraction_run_id'),
  dedupKey: text('dedup_key'),
  subjectKey: text('subject_key'), // normalised analyte / drug / diagnosis name for grouping
  personId: text('person_id'), // clinician who stated it, when known
  /** patient | clinician | compiler | unknown */
  assertedBy: text('asserted_by').notNull().default('unknown'),
  /** objective (measured or recorded) | subjective (assessment or opinion) | unknown */
  objectivity: text('objectivity').notNull().default('unknown'),
  /** Set when a patient-asserted subjective fact takes precedence over this one (consult layer only). */
  overriddenByFactId: text('overridden_by_fact_id'),
  overrideReason: text('override_reason'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [
  index('facts_type_idx').on(t.type),
  index('facts_date_idx').on(t.date),
  index('facts_status_idx').on(t.status),
  index('facts_doc_idx').on(t.sourceDocumentId),
  index('facts_dedup_idx').on(t.dedupKey),
  index('facts_subject_idx').on(t.subjectKey),
]);

export const citations = sqliteTable('citations', {
  id: text('id').primaryKey(),
  factId: text('fact_id'),
  findingId: text('finding_id'),
  communicationId: text('communication_id'),
  askMessageId: text('ask_message_id'),
  documentId: text('document_id').notNull(),
  pageNumber: integer('page_number').notNull(),
  quote: text('quote').notNull(),
  charStart: integer('char_start'),
  charEnd: integer('char_end'),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  matchKind: text('match_kind'), // exact | normalized | fuzzy | none
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [
  index('citations_fact_idx').on(t.factId),
  index('citations_finding_idx').on(t.findingId),
  index('citations_doc_page_idx').on(t.documentId, t.pageNumber),
]);

export const factMerges = sqliteTable('fact_merges', {
  id: text('id').primaryKey(),
  factIdA: text('fact_id_a').notNull(),
  factIdB: text('fact_id_b').notNull(),
  reason: text('reason').notNull(),
  similarity: real('similarity').notNull().default(0),
  status: text('status').notNull().default('pending'),
  decidedAt: text('decided_at'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('fact_merges_pair_idx').on(t.factIdA, t.factIdB), index('fact_merges_status_idx').on(t.status)]);

// ---------------------------------------------------------------------------
// People and communications
// ---------------------------------------------------------------------------
export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('clinician'), // PersonKind
  role: text('role'),
  specialty: text('specialty'),
  institutionId: text('institution_id'),
  phone: text('phone'),
  fax: text('fax'),
  email: text('email'),
  portal: text('portal'),
  address: text('address'),
  preferredChannel: text('preferred_channel'),
  notes: text('notes'),
  aliasesJson: text('aliases_json').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('people_kind_idx').on(t.kind), index('people_name_idx').on(t.name)]);

export const communications = sqliteTable('communications', {
  id: text('id').primaryKey(),
  occurredAt: text('occurred_at'),
  occurredAtPrecision: text('occurred_at_precision').notNull().default('day'),
  occurredAtText: text('occurred_at_text'),
  direction: text('direction').notNull().default('outbound'),
  channel: text('channel').notNull().default('portal'),
  subject: text('subject').notNull(),
  summary: text('summary'),
  outcome: text('outcome'),
  followUpPromised: text('follow_up_promised'),
  followUpDue: text('follow_up_due'),
  followUpDoneAt: text('follow_up_done_at'),
  followUpOwnerPersonId: text('follow_up_owner_person_id'),
  documentId: text('document_id'),
  encounterId: text('encounter_id'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
  // Migration 0005 (2026-10-07): messages read out of a document. NULL / '{}' on every row made before it.
  /** The message as written, verbatim, joined across page breaks; never the user's `summary`. */
  body: text('body'),
  /** Groups the messages of one thread (src/shared/schemas/segments.ts threadKeyOf). */
  threadKey: text('thread_key'),
  /** Identity of a message read from a record, for de-duplication across re-reads and copies (externalKeyOf). */
  externalKey: text('external_key'),
  /** HH:MM, 24-hour, when the record prints a time; `occurred_at` stays a day-precision partial date. */
  occurredTime: text('occurred_time'),
  /** CommunicationDetails (src/shared/schemas/segments.ts): kind, voice, pages, read receipts, copies, model summary. */
  detailsJson: text('details_json').notNull().default('{}'),
}, (t) => [
  index('communications_date_idx').on(t.occurredAt),
  index('communications_followup_idx').on(t.followUpDue),
  index('communications_thread_idx').on(t.threadKey),
  index('communications_external_idx').on(t.externalKey),
]);

export const communicationParticipants = sqliteTable('communication_participants', {
  id: text('id').primaryKey(),
  communicationId: text('communication_id').notNull(),
  personId: text('person_id').notNull(),
  role: text('role').notNull().default('to'),
}, (t) => [index('comm_participants_comm_idx').on(t.communicationId), index('comm_participants_person_idx').on(t.personId)]);

export const communicationTopics = sqliteTable('communication_topics', {
  id: text('id').primaryKey(),
  communicationId: text('communication_id').notNull(),
  topic: text('topic').notNull(),
}, (t) => [index('comm_topics_comm_idx').on(t.communicationId), index('comm_topics_topic_idx').on(t.topic)]);

// ---------------------------------------------------------------------------
// Records inventory
// ---------------------------------------------------------------------------
export const recordsInventory = sqliteTable('records_inventory', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  recordType: text('record_type').notNull().default('other'),
  institutionId: text('institution_id'),
  system: text('system'),
  format: text('format').notNull().default('unknown'),
  held: integer('held', { mode: 'boolean' }).notNull().default(false),
  heldForm: text('held_form'),
  documentId: text('document_id'),
  status: text('status').notNull().default('unknown'),
  recordDate: text('record_date'),
  recordDatePrecision: text('record_date_precision').notNull().default('unknown'),
  recordDateText: text('record_date_text'),
  requestedAt: text('requested_at'),
  receivedAt: text('received_at'),
  expectedBy: text('expected_by'),
  sourceFactId: text('source_fact_id'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('records_status_idx').on(t.status), index('records_type_idx').on(t.recordType), index('records_fact_idx').on(t.sourceFactId)]);

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------
export const encounters = sqliteTable('encounters', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('visit'),
  status: text('status').notNull().default('upcoming'),
  occurredAt: text('occurred_at'),
  occurredAtPrecision: text('occurred_at_precision').notNull().default('day'),
  occurredAtText: text('occurred_at_text'),
  timeText: text('time_text'),
  clinicianId: text('clinician_id'),
  institutionId: text('institution_id'),
  location: text('location'),
  prepNotes: text('prep_notes'),
  questionsJson: text('questions_json').notNull().default('[]'),
  outcomes: text('outcomes'),
  documentIdsJson: text('document_ids_json').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('encounters_date_idx').on(t.occurredAt), index('encounters_status_idx').on(t.status)]);

// ---------------------------------------------------------------------------
// Medications and intolerances
// ---------------------------------------------------------------------------
export const medications = sqliteTable('medications', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  genericName: text('generic_name'),
  drugClass: text('drug_class'),
  dose: text('dose'),
  unit: text('unit'),
  route: text('route'),
  frequency: text('frequency'),
  status: text('status').notNull().default('unknown'),
  startDate: text('start_date'),
  startDatePrecision: text('start_date_precision').notNull().default('unknown'),
  startDateText: text('start_date_text'),
  stopDate: text('stop_date'),
  stopDatePrecision: text('stop_date_precision').notNull().default('unknown'),
  stopDateText: text('stop_date_text'),
  prescriberId: text('prescriber_id'),
  indication: text('indication'),
  reasonStopped: text('reason_stopped'),
  effect: text('effect'), // what it did, in the patient's words
  notes: text('notes'),
  sourceFactId: text('source_fact_id'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('medications_status_idx').on(t.status), index('medications_name_idx').on(t.name)]);

export const medicationEvents = sqliteTable('medication_events', {
  id: text('id').primaryKey(),
  medicationId: text('medication_id').notNull(),
  kind: text('kind').notNull(), // MED_EVENT_KINDS
  date: text('date'),
  datePrecision: text('date_precision').notNull().default('day'),
  dateText: text('date_text'),
  detail: text('detail'),
  dose: text('dose'),
  sourceFactId: text('source_fact_id'),
  createdAt: text('created_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('medication_events_med_idx').on(t.medicationId), index('medication_events_date_idx').on(t.date)]);

export const intolerances = sqliteTable('intolerances', {
  id: text('id').primaryKey(),
  substance: text('substance').notNull(),
  kind: text('kind').notNull().default('intolerance'),
  reaction: text('reaction'),
  severity: text('severity').notNull().default('unknown'),
  hardStop: integer('hard_stop', { mode: 'boolean' }).notNull().default(false),
  date: text('date'),
  datePrecision: text('date_precision').notNull().default('unknown'),
  dateText: text('date_text'),
  notes: text('notes'),
  sourceFactId: text('source_fact_id'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('intolerances_hard_idx').on(t.hardStop)]);

// ---------------------------------------------------------------------------
// Symptoms and daily log
// ---------------------------------------------------------------------------
export const symptomDefinitions = sqliteTable('symptom_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now()),
});

export const symptomEntries = sqliteTable('symptom_entries', {
  id: text('id').primaryKey(),
  date: text('date').notNull(), // YYYY-MM-DD
  symptomId: text('symptom_id').notNull(),
  score: integer('score').notNull(), // 0-10
  note: text('note'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('symptom_entries_day_idx').on(t.date, t.symptomId), index('symptom_entries_date_idx').on(t.date)]);

export const dailyLog = sqliteTable('daily_log', {
  id: text('id').primaryKey(),
  date: text('date').notNull().unique(), // YYYY-MM-DD
  sleepHours: real('sleep_hours'),
  sleepQuality: integer('sleep_quality'), // 0-10
  energy: integer('energy'), // 0-10
  notes: text('notes'),
  tagsJson: text('tags_json').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
});

// ---------------------------------------------------------------------------
// Labs and imaging
// ---------------------------------------------------------------------------
export const labResults = sqliteTable('lab_results', {
  id: text('id').primaryKey(),
  analyte: text('analyte').notNull(),
  analyteKey: text('analyte_key').notNull(), // normalised for grouping
  valueNum: real('value_num'),
  valueText: text('value_text'),
  unit: text('unit'),
  refLow: real('ref_low'),
  refHigh: real('ref_high'),
  refText: text('ref_text'),
  flag: text('flag'),
  specimen: text('specimen').notNull().default('serum'),
  collectedAt: text('collected_at'),
  collectedAtPrecision: text('collected_at_precision').notNull().default('unknown'),
  collectedAtText: text('collected_at_text'),
  labName: text('lab_name'),
  institutionId: text('institution_id'),
  documentId: text('document_id'),
  factId: text('fact_id'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
  // Lab values as printed and as read (migration 0004, 2026-10). Additive and nullable. The *_raw columns are written
  // once and never changed (provenance: what was printed); the parsed columns are a projection of
  // src/shared/labvalues.ts (parse_version); readers use src/server/services/lab-reading.ts, never these columns
  // directly (timeline SQL excepted). The text shown is always the current text (value_text, unit, ref_text, flag).
  valueRaw: text('value_raw'),
  unitRaw: text('unit_raw'),
  refRaw: text('ref_raw'),
  flagRaw: text('flag_raw'), // '' blank, '-' dash, letters as printed; NULL not recorded
  rawSource: text('raw_source'), // 'row' | 'fact' | 'typed' | 'csv' | 'number_only'
  valueKind: text('value_kind'), // 'number' | 'censored' | 'text' | 'range' | 'empty'
  valueComparator: text('value_comparator'), // '<' | '<=' | '>' | '>='
  valueParsed: real('value_parsed'), // the number, or the bound of a censored value
  unitParsed: text('unit_parsed'), // printed unit, an exact repeat collapsed
  refStatus: text('ref_status'), // 'parsed' | 'unparsed' | 'none'
  refParsedLow: real('ref_parsed_low'),
  refLowComparator: text('ref_low_comparator'), // '>' | '>='
  refParsedHigh: real('ref_parsed_high'),
  refHighComparator: text('ref_high_comparator'), // '<' | '<='
  flagComputed: text('flag_computed'), // 'H' | 'L' | 'N' from the value and its own range
  resultedAt: text('resulted_at'),
  resultedAtPrecision: text('resulted_at_precision'),
  resultedAtText: text('resulted_at_text'),
  dateKind: text('date_kind'), // what collected_at holds: 'collected' | 'unknown'
  parseVersion: integer('parse_version'),
  parseJson: text('parse_json'), // { v, parsedFrom, rawFrom, warnings, conflicts, userFields }
}, (t) => [index('lab_results_key_idx').on(t.analyteKey, t.specimen), index('lab_results_date_idx').on(t.collectedAt), index('lab_results_fact_idx').on(t.factId)]);

export const imagingStudies = sqliteTable('imaging_studies', {
  id: text('id').primaryKey(),
  modality: text('modality').notNull().default('other'),
  bodyPart: text('body_part'),
  title: text('title').notNull(),
  performedAt: text('performed_at'),
  performedAtPrecision: text('performed_at_precision').notNull().default('unknown'),
  performedAtText: text('performed_at_text'),
  institutionId: text('institution_id'),
  impression: text('impression'),
  findings: text('findings'),
  contrast: text('contrast'),
  documentId: text('document_id'),
  factId: text('fact_id'),
  hasImages: integer('has_images', { mode: 'boolean' }).notNull().default(false),
  dicomDocumentIdsJson: text('dicom_document_ids_json').notNull().default('[]'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('imaging_date_idx').on(t.performedAt), index('imaging_modality_idx').on(t.modality)]);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  detail: text('detail'),
  owner: text('owner').notNull().default('me'),
  ownerPersonId: text('owner_person_id'),
  dueAt: text('due_at'),
  remindAt: text('remind_at'),
  status: text('status').notNull().default('open'),
  priority: text('priority').notNull().default('normal'),
  sourceType: text('source_type').notNull().default('manual'),
  sourceId: text('source_id'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('tasks_status_due_idx').on(t.status, t.dueAt), index('tasks_source_idx').on(t.sourceType, t.sourceId)]);

// ---------------------------------------------------------------------------
// Findings (cross-reference engine)
// ---------------------------------------------------------------------------
export const crossrefRuns = sqliteTable('crossref_runs', {
  id: text('id').primaryKey(),
  startedAt: text('started_at').notNull().default(now()),
  finishedAt: text('finished_at'),
  model: text('model'),
  deep: integer('deep', { mode: 'boolean' }).notNull().default(false),
  scopeJson: text('scope_json').notNull().default('{}'),
  status: text('status').notNull().default('running'),
  findingsCount: integer('findings_count').notNull().default(0),
  rulesCount: integer('rules_count').notNull().default(0),
  aiCallIdsJson: text('ai_call_ids_json').notNull().default('[]'),
  error: text('error'),
});

export const findings = sqliteTable('findings', {
  id: text('id').primaryKey(),
  category: text('category').notNull(), // FindingCategory
  title: text('title').notNull(),
  whyItMatters: text('why_it_matters').notNull(),
  detail: text('detail'),
  severity: text('severity').notNull().default('medium'),
  status: text('status').notNull().default('new'),
  verdictNote: text('verdict_note'),
  verdictAt: text('verdict_at'),
  origin: text('origin').notNull().default('ai'), // ai | rule
  ruleId: text('rule_id'),
  fingerprint: text('fingerprint'), // stable key so re-runs update instead of duplicate
  runId: text('run_id'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('findings_category_idx').on(t.category), index('findings_status_idx').on(t.status), uniqueIndex('findings_fingerprint_idx').on(t.fingerprint)]);

export const findingEvidence = sqliteTable('finding_evidence', {
  id: text('id').primaryKey(),
  findingId: text('finding_id').notNull(),
  factId: text('fact_id'),
  documentId: text('document_id'),
  citationId: text('citation_id'),
  communicationId: text('communication_id'),
  labResultId: text('lab_result_id'),
  note: text('note'),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('finding_evidence_finding_idx').on(t.findingId), index('finding_evidence_fact_idx').on(t.factId)]);

// ---------------------------------------------------------------------------
// Ask the case
// ---------------------------------------------------------------------------
export const askSessions = sqliteTable('ask_sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const askMessages = sqliteTable('ask_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  role: text('role').notNull(), // user | assistant
  content: text('content').notNull(),
  refused: integer('refused', { mode: 'boolean' }).notNull().default(false),
  retrievalJson: text('retrieval_json').notNull().default('[]'),
  aiCallId: text('ai_call_id'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [index('ask_messages_session_idx').on(t.sessionId)]);

// ---------------------------------------------------------------------------
// Export packets
// ---------------------------------------------------------------------------
export const exportPackets = sqliteTable('export_packets', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  configJson: text('config_json').notNull().default('{}'),
  storageKey: text('storage_key'),
  sizeBytes: integer('size_bytes'),
  pageCount: integer('page_count'),
  status: text('status').notNull().default('queued'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(now()),
  finishedAt: text('finished_at'),
});

// ---------------------------------------------------------------------------
// Access: users sharing the same encrypted case (each with their own passphrase)
// ---------------------------------------------------------------------------
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default('viewer'), // owner | editor | viewer
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now()),
  lastLoginAt: text('last_login_at'),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  at: text('at').notNull().default(now()),
  userId: text('user_id'),
  userName: text('user_name'),
  action: text('action').notNull(), // login | create | update | delete | purge | export | settings | ai
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  summary: text('summary'),
}, (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_user_idx').on(t.userId)]);

// ---------------------------------------------------------------------------
// Filing: where Claude placed a document (or something made from it), pending
// the user's confirmation. A row per placement; the target keeps no flag of its
// own, so every section reads "pending" from here.
// ---------------------------------------------------------------------------
export const filings = sqliteTable('filings', {
  id: text('id').primaryKey(),
  documentId: text('document_id'),
  /** document | communication | encounter | lab | imaging | medication | intolerance | record */
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  /** classified | created | linked | move */
  action: text('action').notNull(),
  /** pending | confirmed | rejected | undone (auto filings; undone = reversed by an approved move); proposed | approved | declined (moves) */
  status: text('status').notNull().default('pending'),
  /** auto | consult */
  source: text('source').notNull().default('auto'),
  /** One line the user reads: "Filed as a call with Dr. X on 2026-10-05". */
  summary: text('summary').notNull(),
  detailJson: text('detail_json').notNull().default('{}'),
  askMessageId: text('ask_message_id'),
  createdAt: text('created_at').notNull().default(now()),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
}, (t) => [
  index('filings_status_type_idx').on(t.status, t.targetType),
  index('filings_target_idx').on(t.targetType, t.targetId),
  index('filings_document_idx').on(t.documentId),
]);

// ---------------------------------------------------------------------------
// Care team (2026-10-09, the user's request 4): the people being considered for the care team. Every fact on a
// candidate carries its source (a web link with the date it was read, or "told us by phone" with who and when).
// ---------------------------------------------------------------------------
export const careCandidates = sqliteTable('care_candidates', {
  id: text('id').primaryKey(),
  /** The People and places row, once linked (calls and messages and to-dos reach the candidate through it). */
  personId: text('person_id'),
  name: text('name').notNull(),
  practice: text('practice'),
  city: text('city'),
  state: text('state'),
  phone: text('phone'),
  website: text('website'),
  /** States the candidate is licensed in, as typed ("OH", "Ohio"). */
  licensedStatesJson: text('licensed_states_json').notNull().default('[]'),
  /** strategist | day_to_day_lead | local_hands | vendor */
  role: text('role'),
  /** found | contacted | call_booked | answered_flare_test | shortlisted | declined | chosen */
  status: text('status').notNull().default('found'),
  /** accepted | proposed (a web search found it; waiting for a yes) | rejected (the proposal was turned down) */
  review: text('review').notNull().default('accepted'),
  notes: text('notes'),
  /** The fixed "Flare test": item key -> { answer, sources, answeredAt, answeredBy }. */
  flareTestJson: text('flare_test_json').notNull().default('{}'),
  /** Field name -> the sources that back it: { kind: 'web', url, readAt } | { kind: 'phone', who, when, by }. */
  sourcesJson: text('sources_json').notNull().default('{}'),
  detailJson: text('detail_json').notNull().default('{}'),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [
  index('care_candidates_status_idx').on(t.review, t.status),
  index('care_candidates_person_idx').on(t.personId),
]);

// ---------------------------------------------------------------------------
// Plans (2026-10-09): a plan document dropped into Plan, read into a framework (sections, goals, steps, checks,
// decision points) shown as tabs and a checklist. Every item cites the page it came from.
// ---------------------------------------------------------------------------
export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  /** The plan's own document (its original stays in the file store, like any upload). */
  documentId: text('document_id'),
  title: text('title').notNull(),
  /** current | superseded | draft */
  status: text('status').notNull().default('current'),
  summary: text('summary'),
  /** The plan as read: its structure, dates and wording, with citations (the items below are its rows). */
  frameworkJson: text('framework_json').notNull().default('{}'),
  /** The plan's own date, partial. */
  planDate: text('plan_date'),
  planDatePrecision: text('plan_date_precision').notNull().default('unknown'),
  planDateText: text('plan_date_text'),
  extractionRunId: text('extraction_run_id'),
  schemaVersion: integer('schema_version'),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('plans_status_idx').on(t.status), index('plans_document_idx').on(t.documentId)]);

export const planItems = sqliteTable('plan_items', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull(),
  parentId: text('parent_id'),
  /** Order among its siblings, from 0. */
  seq: integer('seq').notNull().default(0),
  /** section | goal | step | check | criterion | decision | contact | medication | other */
  kind: text('kind').notNull().default('step'),
  title: text('title').notNull(),
  detail: text('detail'),
  /** Who does it, as the plan says ("the patient", "neurology", "the chief of staff"). */
  owner: text('owner'),
  /** When, as a partial date, with the plan's own words ("within 48 hours of a flare"). */
  due: text('due'),
  duePrecision: text('due_precision').notNull().default('unknown'),
  dueText: text('due_text'),
  /** The condition that starts it, as written ("if fever above 38.5"). */
  condition: text('condition'),
  /** open | done | skipped | not_applicable */
  status: text('status').notNull().default('open'),
  doneAt: text('done_at'),
  doneBy: text('done_by'),
  note: text('note'),
  /** A To-do made from this item. */
  taskId: text('task_id'),
  citationsJson: text('citations_json').notNull().default('[]'),
  detailJson: text('detail_json').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
  deletedAt: text('deleted_at'),
}, (t) => [index('plan_items_plan_idx').on(t.planId, t.seq), index('plan_items_task_idx').on(t.taskId)]);

export const schemaTables = {
  users, auditLog, filings, careCandidates, plans, planItems,
  settings, aiCalls, jobs, documents, documentPages, extractionRuns, documentSegments, facts, citations, factMerges,
  people, communications, communicationParticipants, communicationTopics, recordsInventory, encounters,
  medications, medicationEvents, intolerances, symptomDefinitions, symptomEntries, dailyLog, labResults,
  imagingStudies, tasks, crossrefRuns, findings, findingEvidence, askSessions, askMessages, exportPackets,
};
