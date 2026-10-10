/**
 * Inbox triage: the structured proposal the model returns for a freshly
 * dropped document ("where does this belong?"), the inbox lifecycle stored
 * in `documents.metadata_json.inbox`, and the filing request. Shared by the
 * server (validation, structured output) and the client (types, defaults).
 */
import { z } from 'zod';
import { AUTHOR_ROLES, DOCUMENT_CATEGORIES, SOURCE_TIERS } from '../enums';

export const INBOX_STATUSES = ['new', 'triaged', 'needs_manual', 'filed', 'skipped'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** Statuses that keep a document in the Inbox list. */
export const INBOX_ACTIVE_STATUSES: readonly InboxStatus[] = ['new', 'triaged', 'needs_manual'];

export const TRIAGE_ACTIONS = ['extract_facts', 'create_inventory_row', 'link_encounter', 'create_person', 'mark_record_received', 'create_communication'] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

/** One side of "match an existing entry or name a new one". Exactly one is set, or neither. */
const matchOrNew = z.object({
  match_id: z.string().nullable().describe('The id of the matching entry from the directory, or null'),
  new_name: z.string().nullable().describe('The name as written when nothing in the directory matches, or null'),
});

/** One of the key points of a document, each anchored to a page and a verbatim passage. */
export const triageKeyPoint = z.object({
  text: z.string().describe('One short sentence stating the point in plain words'),
  page: z.number().int().describe('1-based page number from the === PAGE n === marker the passage sits under'),
  quote: z.string().describe('Verbatim passage copied from that page, 5 to 200 characters, exactly as it appears'),
});
export type TriageKeyPoint = z.infer<typeof triageKeyPoint>;

/**
 * The classification the model returns for every uploaded document (and for
 * inbox triage). The structured-output grammar caps schemas at 24 optional
 * and 16 nullable or union-typed parameters; this one has 0 optional and 6
 * nullable fields (tests/document-intelligence.test.ts counts them).
 */
export const triageOutput = z.object({
  title: z.string().describe('A short, specific title: institution or author, document type, date, e.g. "Lakeside Neurology consult note, Dr A. Example, 2024-03-11"'),
  category: z.enum(DOCUMENT_CATEGORIES),
  document_date: z.string().nullable().describe('The date the document was written, signed or issued, exactly as written, or null'),
  institution: matchOrNew,
  author: matchOrNew,
  source_tier: z
    .enum(SOURCE_TIERS)
    .default('unknown')
    .describe(
      'primary = an actual clinical or hospital document (letterhead, MRN, visit dates, signatures, lab-system or radiology formatting); patient = written by the patient or their chief of staff (first-person voice, annotations, symptom notes, call notes from the patient side); compilation = a summary, dossier, timeline or analysis assembled from other records, including AI-generated analyses; external = letters from insurers, employers, advocates, schools; unknown when none fits',
    ),
  author_role: z.enum(AUTHOR_ROLES).default('other').describe('Who wrote it: clinician, patient, chief_of_staff, ai_summary (a model-written analysis), advocate, or other'),
  summary: z.string().describe('Two or three plain sentences: what this document is, who wrote it, for what purpose'),
  key_points: z.array(triageKeyPoint).default([]).describe('3 to 7 key points, most important first, each with the page and a verbatim quote that supports it'),
  people_mentioned: z.array(z.string()).describe('Clinician and institution names as written in the document'),
  contains: z.object({
    labs: z.boolean(),
    imaging: z.boolean(),
    medications: z.boolean(),
    plan_or_recommendations: z.boolean(),
    portal_thread: z.boolean(),
    transcript: z.boolean(),
  }),
  suggested_links: z.object({
    encounter_id: z.string().nullable().describe('An encounter id from the list this document belongs to, or null'),
    inventory_row_ids: z.array(z.string()).describe('Ids of expected or requested records this document fulfils'),
    person_ids: z.array(z.string()).describe('Ids of directory entries that took part in or are the subject of this document'),
  }),
  suggested_actions: z.array(z.enum(TRIAGE_ACTIONS)),
  why: z.string().describe('One or two sentences on how the proposal was reached, naming the passages that decided it'),
  confidence: z.number().describe('0 to 1: how sure the classification is'),
  // The wrong-patient guard's second opinion (2026-10-09, services/patient-check.ts). Plain strings and page 0 when not
  // printed (no nullable or optional field is added: the grammar limits above stay as they were); the default keeps
  // older proposals parsing.
  patient: z
    .object({
      name: z.string().describe("The patient's name exactly as printed in a patient field or header, or an empty string"),
      date_of_birth: z.string().describe("The patient's date of birth exactly as printed, or an empty string"),
      record_number: z.string().describe("The patient's medical record number (MRN) exactly as printed, or an empty string"),
      page: z.number().int().describe('The page those are printed on, from the === PAGE n === marker, or 0'),
      quote: z.string().describe('A verbatim passage from that page holding them, 5 to 200 characters, or an empty string'),
    })
    .default({ name: '', date_of_birth: '', record_number: '', page: 0, quote: '' })
    .describe('The patient this document is about, as printed on it; never a clinician, guarantor, emergency contact, subscriber or family member'),
});
/** The input shape: the three slice-Q fields carry defaults so older proposals (and fixtures) still parse; the model-facing JSON schema lists them as required. */
export type TriageOutput = z.input<typeof triageOutput>;

/** What is stored under metadata_json.triage: the proposal plus provenance of the call. */
export interface TriageMeta extends TriageOutput {
  model: string;
  callId: string | null;
  at: string;
  pagesUsed: number;
  charsUsed: number;
  /** Ids the model returned that were not in the lists it was given; dropped, never applied. */
  dropped: string[];
  /** Stored with `verified`: whether the quote was found on the page it names (page ±1). Unverified points are kept and flagged. */
  key_points?: Array<TriageKeyPoint & { verified?: boolean }>;
}

export interface FilingRecord {
  at: string;
  fields: Record<string, unknown>;
  actions: TriageAction[];
  createdPersonIds: string[];
  encounterId: string | null;
  receivedInventoryRowIds: string[];
  inventoryRowId: string | null;
  communicationId: string | null;
  extractionQueued: boolean;
  warnings: string[];
  /**
   * The classification the filing started from (metadata_json.triage is
   * refreshed by a later Re-title or re-ingest; this keeps which call the
   * user filed from). Null when it was filed by hand without a proposal.
   */
  proposal?: { at: string; model: string; callId: string | null; title: string } | null;
}

export interface InboxMeta {
  status: InboxStatus;
  receivedAt: string;
  triagedAt?: string | null;
  filedAt?: string | null;
  skippedAt?: string | null;
  /** Why triage could not run (AI off, no key, no text, model error). */
  error?: string | null;
  filing?: FilingRecord | null;
}

export const fileInboxInput = z
  .object({
    overrides: z
      .object({
        title: z.string().trim().max(500).optional(),
        category: z.enum(DOCUMENT_CATEGORIES).optional(),
        documentDateText: z.string().trim().max(120).nullable().optional(),
        institutionId: z.string().trim().max(64).nullable().optional(),
        authorPersonId: z.string().trim().max(64).nullable().optional(),
        newInstitutionName: z.string().trim().max(300).nullable().optional(),
        newAuthorName: z.string().trim().max(300).nullable().optional(),
        /** The user's correction of the tier the classification applied. */
        sourceTier: z.enum(SOURCE_TIERS).optional(),
      })
      .strict()
      .optional(),
    actions: z.array(z.enum(TRIAGE_ACTIONS)).max(20).optional(),
    encounterId: z.string().trim().max(64).nullable().optional(),
    inventoryRowIds: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  })
  .strict();
export type FileInboxInput = z.infer<typeof fileInboxInput>;
