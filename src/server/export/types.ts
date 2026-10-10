/**
 * Packet export: the configuration a packet is built from and the data model
 * the HTML renderer consumes. Pure types and zod; no database access here so
 * the renderer can be unit-tested with hand-made data.
 */
import { z } from 'zod';
import { TIMELINE_KINDS, type TimelineItem } from '../../shared/timeline';
import type { ChartSpec } from '../../shared/chart';
import type { CareSummary } from '../services/care-team';

const idList = (max: number) => z.array(z.string().trim().min(1).max(64)).max(max);

export const packetConfig = z.object({
  title: z.string().trim().min(1).max(300),
  recipient: z.string().trim().max(300).nullable().optional(),
  purpose: z.string().trim().max(4000).nullable().optional(),
  /** Documents to index and append, in the order given. */
  documentIds: idList(500).default([]),
  /** 'confirmed' = confirmed facts; 'all' = every live fact except superseded; ids = exactly these; undefined/'none' = no facts section. */
  factIds: z.union([idList(5000), z.literal('confirmed'), z.literal('all'), z.literal('none')]).optional(),
  /** Restrict the facts section to facts whose source document is in the packet. */
  factsFromPacketDocumentsOnly: z.boolean().default(false),
  findingIds: z.union([idList(2000), z.literal('confirmed'), z.literal('all'), z.literal('none')]).optional(),
  timeline: z
    .object({
      from: z.string().trim().max(10).nullable().optional(),
      to: z.string().trim().max(10).nullable().optional(),
      kinds: z.array(z.enum(TIMELINE_KINDS)).max(TIMELINE_KINDS.length).nullable().optional(),
    })
    .nullable()
    .optional(),
  includeEmergencyCard: z.boolean().default(true),
  includeRecordsIndex: z.boolean().default(true),
  includeMedications: z.boolean().default(true),
  /** Analyte keys (lab_results.analyte_key / normalised fact analyte) to tabulate and chart. */
  includeLabs: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  coverSummary: z.string().max(20000).nullable().optional(),
  /** The Care team summary page (2026-10-09, request 6): candidates by step, for reading before deciding. Off unless chosen. */
  includeCareTeam: z.boolean().default(false),
});
export type PacketConfig = z.infer<typeof packetConfig>;
export type PacketConfigInput = z.input<typeof packetConfig>;

/** A pointer into the packet: document number + page, with the quote that backs it. */
export interface PacketRef {
  /** Document number inside this packet, or null when the document is not included. */
  docN: number | null;
  documentId: string;
  documentTitle: string | null;
  pageNumber: number | null;
  quote: string | null;
  /** The quote was found verbatim (or near-verbatim) in the stored page text. */
  verified: boolean | null;
  citationId: string | null;
}

export type AppendixKind = 'pdf' | 'image' | 'text';

export interface PacketDocument {
  n: number;
  id: string;
  title: string;
  filename: string;
  kind: string;
  mime: string;
  category: string;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  institutionName: string | null;
  authorName: string | null;
  pageCount: number;
  sizeBytes: number;
  storageKey: string;
  notes: string | null;
  /** How the original goes into the packet: appended as PDF pages, as images, or as a text section. */
  appendix: AppendixKind;
  /** Page text for text-kind documents (rendered inside the HTML). */
  pages: Array<{ pageNumber: number; text: string }>;
  /** Pages the original will occupy once appended (pdf/image), when known. */
  appendixPages: number | null;
  /** First packet page of the appended original, once the HTML part has been paginated. */
  packetPage: number | null;
}

/**
 * The patient's own statement that takes precedence over a subjective fact
 * (facts.overridden_by_fact_id). The packet prints the record as recorded and
 * adds this as a separate "Patient's notes on this" line beneath it.
 */
export interface PacketPatientNote {
  factId: string;
  statement: string;
  reason: string | null;
  refs: PacketRef[];
}

export interface PacketFact {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  dateEnd: string | null;
  status: string;
  /** Confirmed facts only: 'original' (checked against the original record) or 'summary' (checked only against a summary); null otherwise. */
  verdictBasis?: string | null;
  confidence: number;
  origin: string;
  verdictNote: string | null;
  personName: string | null;
  sourceDocumentId: string | null;
  documentTitle: string | null;
  refs: PacketRef[];
  /** Diagnosis facts: the certainty the source stated (attributes_json.certainty); null otherwise or when not stated. */
  certainty: string | null;
  /** Set when a live patient statement overrides this fact. */
  patientNote: PacketPatientNote | null;
}

export interface PacketEvidence {
  kind: 'fact' | 'document' | 'citation' | 'communication' | 'lab' | 'note';
  label: string;
  detail: string | null;
  status: string | null;
  /** Fact evidence only: the verdict basis of a confirmed fact (original | summary), else null. */
  basis?: string | null;
  refs: PacketRef[];
  /** Fact evidence only: the patient's overriding statement, when there is one. */
  patientNote?: PacketPatientNote | null;
}

export interface PacketFinding {
  id: string;
  category: string;
  title: string;
  whyItMatters: string;
  detail: string | null;
  severity: string;
  status: string;
  verdictNote: string | null;
  origin: string;
  createdAt: string;
  evidence: PacketEvidence[];
}

export interface PacketLabRow {
  id: string;
  /** The value's own date: collected, else of a kind the document does not say, else resulted (rule 7). */
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  /** The value as printed (or the user's own words): "<3", "Negative", "0.80". */
  value: string;
  /** Its measurement: null for a limit ("<3"), words or a value printed as a range (never drawn). */
  valueNum: number | null;
  unit: string | null;
  /** The bounds of its own range when read as numbers; null otherwise. */
  refLow: number | null;
  refHigh: number | null;
  /** Its own range as shown (printed, or "upper limit 50" from a stored number). */
  refText: string | null;
  /** The chart's flag: printed H, L, A or C, or worked out from its own range ("H~"); null for a summary's claim. */
  flag: string | null;
  labName: string | null;
  /** 2026-10: the value as shown (src/shared/labvalues.ts valueShown). */
  valueShown?: string;
  /** The range as printed with the value; null when none. */
  rangeShown?: string | null;
  /** A unit printed inside the range itself ("0.15-0.45 g/L"); null when it prints none (then it is in the value's unit). */
  rangeUnit?: string | null;
  /** The flag column: as printed ("H", "HH (critical)", "none printed"), then "high by its range" when that differs. */
  flagShown?: string;
  /** The laboratory that performed the test, as printed. */
  lab?: string | null;
  /** printed (a lab report), unclassified, typed, or claimed (a summary's or a note's restatement). */
  role?: 'printed' | 'claimed' | 'unclassified' | 'typed' | 'computed';
  /** Its own range's signature (bounds, signs, unit): one signature among the plotted values draws the band. Null for none or a claim. */
  rangeSignature?: string | null;
  /** The unit's key (for equality only). */
  unitKey?: string | null;
  /** number, censored (a limit), text, range, empty. */
  valueKind?: 'number' | 'censored' | 'text' | 'range' | 'empty';
  source: 'lab_result' | 'fact';
  /** Status of the fact behind the row (the linked fact for lab_results rows), or null when there is none. */
  factStatus: string | null;
  /** Verdict basis of that fact when it is confirmed (original | summary), else null. */
  factBasis?: string | null;
  /** The patient's verdict note on that fact (shown under disputed rows). */
  verdictNote: string | null;
  ref: PacketRef | null;
  /** One test read out of a line that holds several (services/labs.ts readLabValues): the line as written. */
  splitFrom?: string | null;
  /**
   * A value computed by the patient from printed values (2026-10-09, src/shared/labcompute.ts): its label ("Computed by you from
   * p.2 and p.3"), each input with its conversion and page, and whether an input changed since. Never red, never judged.
   */
  computed?: { label: string; inputs: string[]; changed: boolean } | null;
}

export interface PacketLabSeries {
  analyteKey: string;
  analyte: string;
  specimen: string;
  /** The unit the chart plots (the most common unit among plottable rows). */
  unit: string | null;
  /** Every unit the values were printed in, most frequent first; '' for "no unit printed". */
  units?: string[];
  rows: PacketLabRow[];
  chart: ChartSpec | null;
  /** Inline SVG for the chart, or null when fewer than one numeric point. */
  svg: string | null;
  /** What the chart leaves out or cannot show (other units, disputed values, differing ranges); null when nothing. */
  chartNote: string | null;
}

export interface PacketIntolerance {
  id: string;
  substance: string;
  kind: string;
  reaction: string | null;
  severity: string;
  hardStop: boolean;
  date: string | null;
  datePrecision: string;
  notes: string | null;
}

export interface PacketMedicationEvent {
  id: string;
  kind: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  detail: string | null;
  dose: string | null;
}

export interface PacketMedication {
  id: string;
  name: string;
  genericName: string | null;
  drugClass: string | null;
  dose: string | null;
  unit: string | null;
  route: string | null;
  frequency: string | null;
  status: string;
  startDate: string | null;
  startDatePrecision: string;
  startDateText: string | null;
  stopDate: string | null;
  stopDatePrecision: string;
  stopDateText: string | null;
  prescriberName: string | null;
  indication: string | null;
  reasonStopped: string | null;
  effect: string | null;
  notes: string | null;
  events: PacketMedicationEvent[];
}

export interface PacketContact {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionName: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  portal: string | null;
}

export interface PacketPatient {
  name: string;
  dob: string;
  bloodType: string;
  emergencyContacts: string;
  summary: string;
}

export interface EmergencyCardData {
  patient: PacketPatient;
  hardStops: PacketIntolerance[];
  intolerances: PacketIntolerance[];
  activeMedications: PacketMedication[];
  diagnoses: PacketFact[];
  keyContacts: PacketContact[];
}

export interface PacketInventoryRow {
  id: string;
  title: string;
  recordType: string;
  institutionName: string | null;
  recordDate: string | null;
  recordDatePrecision: string;
  recordDateText: string | null;
  status: string;
  held: boolean;
  heldForm: string | null;
  system: string | null;
  /** Packet document number when the held copy is in this packet. */
  docN: number | null;
  documentTitle: string | null;
  requestedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
}

export interface PacketGap {
  kind: 'inventory' | 'inferred';
  title: string;
  recordType: string;
  institution: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  status: string;
  ref: PacketRef | null;
}

export interface PacketTimeline {
  from: string | null;
  to: string | null;
  kinds: string[] | null;
  items: Array<TimelineItem & { docN: number | null; patientNote?: PacketPatientNote | null }>;
  truncated: boolean;
}

export interface PacketData {
  config: PacketConfig;
  generatedAt: string;
  patient: PacketPatient;
  coverSummary: string | null;
  documents: PacketDocument[];
  /** Facts grouped by type in FACT_TYPES order; empty when the section is off. */
  factGroups: Array<{ type: string; facts: PacketFact[] }>;
  factsIncluded: boolean;
  findings: PacketFinding[];
  findingsIncluded: boolean;
  labs: PacketLabSeries[];
  emergencyCard: EmergencyCardData | null;
  medications: { medications: PacketMedication[]; intolerances: PacketIntolerance[] } | null;
  records: { inventory: PacketInventoryRow[]; gaps: PacketGap[] } | null;
  timeline: PacketTimeline | null;
  /** The Care team summary (request 6), when chosen. */
  careTeam?: CareSummary | null;
}

/** What the export job records next to the config in `export_packets.config_json`. */
export interface PacketResult {
  format: 'pdf' | 'html';
  browser: string | null;
  htmlPages: number | null;
  appended: Array<{ n: number; documentId: string; title: string; pages: number; startPage: number | null; how: AppendixKind | 'failed'; error?: string }>;
  note: string | null;
  durationMs: number;
}

export interface StoredPacketConfig {
  config: PacketConfig;
  result?: PacketResult | null;
  note?: string | null;
}
