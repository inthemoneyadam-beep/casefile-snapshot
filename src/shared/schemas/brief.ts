/**
 * The document brief: a clean clinical summary sheet built from a document's
 * classification and its extracted facts (no model call). The server builds
 * it (src/server/services/documents.ts, `buildDocumentBrief`), caches it in
 * `documents.brief_json`, and the client renders it
 * (src/client/features/documents/DocumentBrief.tsx). Every row links back to
 * its page and citation, and carries its trust level (attached on every read,
 * since it depends on other documents). Details the reconciliation set aside
 * (a copy of a clinical record, or one that contradicts it) stay in their
 * document's brief with that trust; other replaced details do not.
 */
import type { ChartSpec } from '../chart';
import type { TrustInfo } from '../reconcile';
import type { FlagState, RangeStatus, ReadingRole, ValueKind } from '../labvalues';

export type BriefSpecimen = 'csf' | 'serum' | 'urine' | 'other';

export interface BriefKeyPoint {
  text: string;
  page: number | null;
  quote: string | null;
  /** True when the quote was found verbatim on that page; null when there was nothing to check. */
  verified: boolean | null;
  citationId?: string | null;
}

/** Provenance shared by every ledger row of the brief. */
export interface BriefRowBase {
  factId: string;
  citationId: string | null;
  page: number | null;
  status: string;
  /** The user's check beside the status: 'original' | 'summary' (with confirmed), 'unsure' (with unverified). Absent in briefs built before it existed. */
  verdictBasis?: string | null;
  objectivity: string;
  assertedBy: string;
  overriddenByFactId: string | null;
  date: string | null;
  datePrecision: string;
  statement: string;
  /**
   * The automatic trust level (src/shared/reconcile.ts): verified, accurate, unbacked, inaccurate, conflict or
   * replaced, with the record it was compared with and a plain reason. Computed when the brief is read, never cached.
   */
  trust: TrustInfo;
}

export interface BriefLabRow extends BriefRowBase {
  analyte: string;
  analyteKey: string;
  /** The value as printed (or the user's own words): "<3", "Negative", "0.80" (src/shared/labvalues.ts valueShown). */
  value: string;
  unit: string | null;
  /** The value's own range as printed ("<50", "15-45 mg/dL"), "upper limit 50" from a stored number; null when none. */
  ref: string | null;
  /** The flag printed with it (H, L, N, A, C), else worked out from its own range ("H~"); a summary's own flag as printed. */
  flag: string | null;
  /** true = outside its own printed range, false = inside, null = cannot tell (no range, words, or a summary's claim). */
  outOfRange: boolean | null;
  /** 2026-10 (BRIEF_LABS_VERSION 3): number, censored (a limit, "<3"), text, range, empty. */
  valueKind?: ValueKind;
  /** The flag exactly as printed: '' none printed, '-' a dash, "HH"; null not recorded. */
  flagRaw?: string | null;
  flagState?: FlagState;
  /** The flag worked out from the value and the range printed with it; null when it cannot be said. */
  flagComputed?: 'H' | 'L' | 'N' | null;
  rangeStatus?: RangeStatus;
  /** Who gives the range and the flag: printed (a lab report), unclassified (not sorted yet), typed, claimed (this document's claim). */
  rangeRole?: ReadingRole;
  /** The checks made on the value, in plain words. */
  warnings?: string[];
  /** The laboratory that performed the test, as printed. */
  lab?: string | null;
  /**
   * One test read out of a line that holds several ("OP 17; protein 52"): `<factId>#<index>`, unique in the brief (key
   * rows by `partId ?? factId`); null or absent for a line read whole. factId still names the line's detail.
   */
  partId?: string | null;
  /** With partId: the line as written ("CSF opening pressure / protein: OP 17; protein 52"). */
  splitFrom?: string | null;
}

export interface BriefLabGroup {
  specimen: BriefSpecimen;
  panel: string;
  date: string | null;
  datePrecision: string;
  rows: BriefLabRow[];
}

/** An analyte reported on more than one date in this document. */
export interface BriefLabTrend {
  analyteKey: string;
  analyte: string;
  specimen: BriefSpecimen;
  chart: ChartSpec;
}

export interface BriefMedication extends BriefRowBase {
  name: string;
  dose: string | null;
  medStatus: string | null;
  effect: string | null;
}

export interface BriefDiagnosis extends BriefRowBase {
  name: string;
  certainty: string | null;
  statedBy: string | null;
}

export interface BriefImaging extends BriefRowBase {
  modality: string;
  bodyPart: string | null;
  impression: string | null;
}

export interface BriefProcedure extends BriefRowBase {
  name: string;
  performedBy: string | null;
  result: string | null;
}

export interface BriefSymptom extends BriefRowBase {
  name: string;
  severity: string | null;
  course: string | null;
}

export interface BriefRecommendation extends BriefRowBase {
  action: string;
  recommendedBy: string | null;
  target: string | null;
  actedOn: string | null;
}

export interface BriefFollowUp extends BriefRowBase {
  what: string;
  who: string | null;
  due: string | null;
  followUpStatus: string | null;
}

export interface BriefReferral extends BriefRowBase {
  to: string;
  specialty: string | null;
  referralStatus: string | null;
}

export interface BriefRecordReference extends BriefRowBase {
  description: string;
  recordType: string;
  presentHere: boolean;
}

export interface BriefStatement extends BriefRowBase {
  statedBy: string | null;
  about: string | null;
  stance: string | null;
}

export interface BriefEvent extends BriefRowBase {
  name: string;
  detail: string | null;
}

export interface BriefIntolerance extends BriefRowBase {
  substance: string;
  kind: string | null;
  reaction: string | null;
}

export interface DocumentBrief {
  documentId: string;
  builtAt: string;
  /** Count and latest update of the document's live facts when the brief was built; a different signature means the ledgers are stale. */
  factsSignature: string;
  summary: string | null;
  /**
   * Which model call wrote the summary: the classification, or (when there is
   * none) the fact extraction's document summary; null without a summary.
   * Optional because briefs cached before it existed lack it (they are rebuilt on read).
   */
  summarySource?: 'classification' | 'extraction' | null;
  /** The model that wrote the summary, when recorded. */
  summaryModel?: string | null;
  keyPoints: BriefKeyPoint[];
  tier: string;
  authorRole: string | null;
  titleSource: string;
  date: string | null;
  datePrecision: string;
  institution: string | null;
  author: string | null;
  people: Array<{ name: string; personId: string | null }>;
  labs: BriefLabGroup[];
  /** Charts of the numbers only: a test whose results here are all words has none (its rows list them). */
  labTrends: BriefLabTrend[];
  /**
   * How the lab rows were read (services/documents.ts BRIEF_LABS_VERSION): a brief cached by an older reading (absent)
   * is rebuilt on read.
   */
  labsVersion?: number;
  /** The tests of several-test lines that were set aside when the brief was built (labs.ts labPartChecks keys): a change rebuilds it. */
  labSetAside?: string[];
  medications: BriefMedication[];
  diagnoses: BriefDiagnosis[];
  imaging: BriefImaging[];
  procedures: BriefProcedure[];
  symptoms: BriefSymptom[];
  recommendations: BriefRecommendation[];
  followUps: BriefFollowUp[];
  referrals: BriefReferral[];
  recordReferences: BriefRecordReference[];
  statements: BriefStatement[];
  events: BriefEvent[];
  intolerances: BriefIntolerance[];
  /** unverified counts details still pending (not those answered "unsure", which are counted in unsure). */
  counts: { facts: number; verified: number; unverified: number; unsure?: number; disputed: number; overridden: number; patientAsserted: number };
  /** Provenance of the classification call, when one has run. */
  classification: { model: string; at: string; pagesUsed: number; confidence: number; why: string } | null;
}
