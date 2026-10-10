/**
 * Typed client for /api/labs. Query keys all start with 'labs' so one
 * invalidation refreshes the list, the analyte table, series and detail.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, listOrEmpty } from './client';
import type { ChartSpec } from '@shared/chart';
import type { TrustInfo } from '@shared/reconcile';
import type { AnalyteMatch } from '@shared/analytes';
import { formatRange, hydrateReadingView, rangeFromNumbers, type LabReadingView, type ReadingRole } from '@shared/labvalues';
import type { VerdictBasis } from './facts';
import type { LabSplitFrom } from '../features/labs/parts';
import type { ComputedView } from '@shared/labcompute';

export type { LabSplitFrom, LabReadingView, ReadingRole, AnalyteMatch };

/**
 * An open finding of the lab checks that names a value (server labs.ts LabIssue): rule 10, one document gives two
 * values for one test on one day like a typing error; rule 12, a summary's limit or judgement differs from the lab
 * report's. Shown on the value with its pages and "Open in Findings".
 */
export interface LabIssue {
  findingId: string;
  ruleId: 'lab_same_source_conflict' | 'lab_claim_differs' | 'lab_computed_differs';
  title: string;
  detail: string | null;
  status: string;
}

export interface LabEntry {
  /**
   * lab_results id, or `fact:<factId>` for an extracted result not imported yet; for one part of a line that held
   * several tests, `<row or fact id>#<index>` (open, edit and delete use labResultId / factId, never this id).
   */
  id: string;
  source: 'row' | 'fact';
  labResultId: string | null;
  factId: string | null;
  analyte: string;
  analyteKey: string;
  specimen: string;
  /** The measurement only (reading.measurement): null for a limit ("<3"), words, a value printed as a range, or blank. */
  valueNum: number | null;
  /** The value as shown (reading.valueShown): as printed, or your own words. */
  valueText: string | null;
  /** The unit as shown (an exactly repeated unit shown once). */
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  /** The value's own range as shown (reading.rangeShown). */
  refText: string | null;
  /** The flag printed with the value, else the one worked out from its own range (flagDerived); null for a summary's own flag (its claim, kept in reading). */
  flag: string | null;
  flagDerived: boolean;
  /** The reading's date: collected, else a date of unknown kind, else resulted (reading.dateKind says which). */
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  /**
   * The value as read (src/shared/labvalues.ts compactReading): what every screen shows and judges. Always sent by the
   * server since 2026-10; an older payload has none and is read from the fields above (features/labs/reading.ts readingOf).
   */
  reading?: LabReadingView | null;
  /** Open findings of the lab checks naming this value (rule 10 and rule 12), newest first. */
  labIssues?: LabIssue[];
  labName: string | null;
  institutionId: string | null;
  institutionName: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  quote: string | null;
  factStatus: string | null;
  /** With factStatus 'confirmed': checked against the original record, or only a summary. Null otherwise. */
  factBasis: VerdictBasis | null;
  factStatement: string | null;
  /** Imported from (or cited by) a fact that was later deleted in the Facts ledger. */
  factDeleted: boolean;
  /** The automatic trust level of the detail behind the value (verified, accurate, ...); null for a value typed by hand. */
  trust: TrustInfo | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** This entry is one part of a line that held several tests: the line as written, which part, how many. */
  splitFrom?: LabSplitFrom | null;
  /** A line that names several tests the app could not split: shown whole, labelled, read in the document. */
  combined?: boolean;
  /**
   * A value the patient computed from printed values (2026-10-09, src/shared/labcompute.ts): its formula, inputs, pages and
   * pairing, the inputs that changed since, and the lab's own printed value of the same index beside it.
   */
  computed?: ComputedView;
}

/**
 * Row class for a lab value: a value that disagrees with a clinical record
 * gets a red marker (features/reconcile/reconcile.css); a value set aside
 * (replaced, marked wrong, deleted) is dimmed, and keeps its red marker when
 * it was wrong. Nothing waits for a check, so nothing is yellow.
 */
export function labRowClass(e: { factStatus: string | null; factDeleted?: boolean; trust?: TrustInfo | null }): string | undefined {
  return [e.trust?.trust === 'inaccurate' ? 'inaccurate-row' : '', isSetAside(e) ? 'dim' : ''].filter(Boolean).join(' ') || undefined;
}

/** Set aside by the user's verdict (fact disputed, superseded or deleted): listed, tagged and dimmed, kept out of trends. */
export function isSetAside(e: { factStatus: string | null; factDeleted?: boolean }): boolean {
  return e.factStatus === 'disputed' || e.factStatus === 'superseded' || Boolean(e.factDeleted);
}

export type LabSeriesRow = LabEntry & { value: string; ref: string | null; href: string | null };

/** A range printed with the values of one test, as printed, with the lab that printed it (rule 8: ranges belong to their lab). */
export interface AnalyteRange {
  /** As shown: the text as printed, or "upper limit 50" from a stored number. */
  shown: string;
  /** The lab that printed it; null when no lab is named. */
  lab: string | null;
  /** The unit of the values printed with it. */
  unit: string | null;
  /** printed (a lab report), unclassified (a document not sorted yet), typed (entered by hand), claimed (a summary's own range). */
  role: ReadingRole;
  /** How many values were printed with it. */
  count: number;
  /** For a claimed range: the document that states it. */
  documentTitle: string | null;
  /** A unit printed inside the range itself ("0.15-0.45 g/L"); null when it prints none (then it is in the values' unit). */
  rangeUnit?: string | null;
  /** The range is read as numbers (bounds); false for words ("Negative") or a range kept as printed ("see comment"). */
  asNumbers?: boolean;
}

export interface AnalyteSummary {
  analyteKey: string;
  analyte: string;
  specimen: string;
  count: number;
  /** The unit when every value has one and the same unit; null when the units differ or a value printed none (rule 5). */
  unit: string | null;
  /** Every unit as printed, most frequent first; '' stands for "no unit printed". */
  units?: string[];
  /** The last value as shown (as printed): from a lab report first, a summary's only when the test has nothing else. */
  lastValue: string;
  /** Its measurement; null for a limit or words. */
  lastValueNum: number | null;
  lastUnit?: string | null;
  lastDate: string | null;
  lastDatePrecision: string;
  lastFlag: string | null;
  /** The last flag was worked out from the value's own range, not printed. */
  lastFlagDerived: boolean;
  /** Who gives the last value (a summary only when nothing else exists). */
  lastRole?: ReadingRole;
  /** "from <document> (a summary)" when the last value comes from a document that restates results; null otherwise. */
  lastNote?: string | null;
  /** The test is a line naming several tests that could not be split (when the server says so). */
  combined?: boolean;
  firstDate: string | null;
  everInRange: boolean;
  outOfRangeCount: number;
  /** Every range printed with the values, each with its lab and unit: lab reports first, a summary's own ranges last. */
  ranges?: AnalyteRange[];
  /** The test's one printed range: set only when every value that printed a range printed the same one; null otherwise. */
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  unverifiedCount: number;
  factOnlyCount: number;
  documentCount: number;
}

export interface SpecimenCount {
  specimen: string;
  count: number;
}

export interface LabsListParams {
  analyteKey?: string;
  analyte?: string;
  specimen?: string;
  from?: string;
  to?: string;
  flag?: string;
  q?: string;
  includeDisputed?: boolean;
}

export interface SeriesParams {
  analyteKey: string;
  specimen?: string;
  from?: string;
  to?: string;
  overlay?: boolean;
}

export interface LabInput {
  analyte: string;
  /** The value as written ("62", "<3", "Negative", "1:160"): the text decides, a limit never stores a number. */
  value?: string | null;
  valueNum?: number | null;
  unit?: string | null;
  refLow?: number | null;
  refHigh?: number | null;
  /** The normal range as printed ("15-45", "<50", "Negative"); its bounds are read from it when no numbers are sent. */
  refText?: string | null;
  flag?: string | null;
  /** The flag as printed: '' none printed, "H", "HH", "*"...; null not recorded. Wins over `flag`. */
  flagRaw?: string | null;
  specimen?: string;
  collectedAt?: string | null;
  collectedAtText?: string | null;
  /** When the result came back (Resulted, Reported), kept apart from the collected date. */
  resultedAt?: string | null;
  resultedAtText?: string | null;
  labName?: string | null;
  institutionId?: string | null;
  documentId?: string | null;
  factId?: string | null;
  notes?: string | null;
  citation?: { documentId: string; pageNumber: number; quote: string } | null;
  statement?: string | null;
}

export interface PersonLite {
  id: string;
  name: string;
  kind: string;
}

export interface DocumentLite {
  id: string;
  title: string;
  kind: string;
  category: string;
  documentDate: string | null;
  documentDatePrecision: string;
}

/** Display value: the value as read (as printed, or your own words: "<3", "Negative", "0.80"), else the text, else the number. */
export function displayValue(e: { valueNum: number | null; valueText: string | null; reading?: LabReadingView | null }): string {
  if (e.reading && e.reading.valueShown.trim()) return e.reading.valueShown.trim();
  if (e.valueText && e.valueText.trim()) return e.valueText.trim();
  if (e.valueNum != null) return Number.isInteger(e.valueNum) ? String(e.valueNum) : String(Number(e.valueNum.toFixed(4)));
  return '';
}

/**
 * The value's own range as shown: the reading's (as printed: "<50" stays "<50"), else the text, else from the numbers
 * alone ("15–45", "upper limit 50", "lower limit 5": rule 3, never "≤ 50" made from a number whose sign is not on
 * record, never a "-50").
 */
export function displayRef(e: { refLow: number | null; refHigh: number | null; refText: string | null; reading?: LabReadingView | null }): string | null {
  if (e.reading) return e.reading.rangeShown?.trim() || null;
  if (e.refText && e.refText.trim()) return e.refText.trim();
  return formatRange(rangeFromNumbers(e.refLow ?? null, e.refHigh ?? null));
}

// ---------------------------------------------------------------------------
// Organised views: by specimen > panel > analyte, and by document
// (GET /api/labs/organised, GET /api/labs/by-document)
// ---------------------------------------------------------------------------

export type PanelSpecimen = 'csf' | 'serum' | 'urine' | 'other';

/** One dated result inside an analyte's series, with its provenance. */
export interface OrganisedPoint {
  id: string;
  source: 'row' | 'fact';
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  value: string;
  valueNum: number | null;
  unit: string | null;
  ref: string | null;
  flag: string | null;
  flagDerived: boolean;
  documentId: string | null;
  documentTitle: string | null;
  page: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  factId: string | null;
  factStatus: string | null;
  factBasis: VerdictBasis | null;
  factDeleted: boolean;
  /** The automatic trust level of the detail behind the value; null for a value typed by hand. */
  trust: TrustInfo | null;
  /** One part of a line that held several tests (see LabEntry.splitFrom). */
  splitFrom?: LabSplitFrom | null;
  /** A line naming several tests that could not be split. */
  combined?: boolean;
  labResultId?: string | null;
  /** The value as read (LabEntry.reading). */
  reading?: LabReadingView | null;
  /** Open findings of the lab checks naming this value (LabEntry.labIssues). */
  labIssues?: LabIssue[];
}

export interface OrganisedAnalyte extends AnalyteSummary {
  panel: string;
  /** Report position inside the panel (-1 for analytes the panel does not name). */
  position: number;
  series: OrganisedPoint[];
}

export interface OrganisedPanel {
  panel: string;
  order: number;
  count: number;
  analytes: OrganisedAnalyte[];
}

export interface OrganisedSpecimen {
  specimen: PanelSpecimen;
  label: string;
  count: number;
  panels: OrganisedPanel[];
}

export interface OrganisedLabs {
  specimens: OrganisedSpecimen[];
  specimenCounts: SpecimenCount[];
  total: number;
}

export interface DocumentPanel {
  panel: string;
  order: number;
  count: number;
  rows: LabSeriesRow[];
}

export interface DocumentSpecimen {
  specimen: PanelSpecimen;
  label: string;
  count: number;
  panels: DocumentPanel[];
}

export interface DocumentLabs {
  /** null for results entered by hand with no source document. */
  documentId: string | null;
  title: string;
  /** The document's own date; null when it has none (shown "not dated"; a result's date never stands in for it). */
  date: string | null;
  datePrecision: string;
  /** primary | patient | compilation | external | unknown, or null without a document. */
  tier: string | null;
  category: string | null;
  institutionName: string | null;
  count: number;
  specimens: DocumentSpecimen[];
}

export const labKeys = {
  all: ['labs'] as const,
  list: (p: LabsListParams) => ['labs', 'list', p] as const,
  analytes: (p: LabsListParams) => ['labs', 'analytes', p] as const,
  organised: (p: LabsListParams) => ['labs', 'organised', p] as const,
  byDocument: (p: LabsListParams) => ['labs', 'by-document', p] as const,
  series: (p: SeriesParams) => ['labs', 'series', p] as const,
  one: (id: string) => ['labs', 'one', id] as const,
  reparse: ['labs', 'reparse-report'] as const,
};

/**
 * The list endpoints (/api/labs, /organised, /by-document) send each value's reading without its empty keys (null,
 * false, an empty list; server routes/labs.ts slimJson): every reading in the payload gets them back here, so every
 * screen reads the full view exactly as the server built it. Changes the parsed payload in place and returns it.
 */
export function withReadings<T>(data: T): T {
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const y of x) walk(y);
      return;
    }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v !== 'object') continue;
      if (k === 'reading' && !Array.isArray(v) && 'valueShown' in v && 'identity' in v) o[k] = hydrateReadingView(v as Partial<LabReadingView>);
      else walk(v);
    }
  };
  walk(data);
  return data;
}

function qs(p: Record<string, string | number | boolean | null | undefined>): string {
  return api.qs(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : undefined) : v])));
}

export function useLabs(p: LabsListParams, enabled = true) {
  return useQuery({
    queryKey: labKeys.list(p),
    queryFn: () => api.get<{ items: LabEntry[]; total: number }>(`/api/labs${qs(p as Record<string, string | undefined>)}`).then(withReadings),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useAnalytes(p: LabsListParams) {
  return useQuery({
    queryKey: labKeys.analytes(p),
    queryFn: () => api.get<{ items: AnalyteSummary[]; specimens: SpecimenCount[] }>(`/api/labs/analytes${qs(p as Record<string, string | undefined>)}`),
    placeholderData: (prev) => prev,
  });
}

/** The ledger stacked by specimen, panel and analyte, every analyte with its dated series. */
export function useOrganisedLabs(p: LabsListParams, enabled = true) {
  return useQuery({
    queryKey: labKeys.organised(p),
    queryFn: () => api.get<OrganisedLabs>(`/api/labs/organised${qs(p as Record<string, string | undefined>)}`).then(withReadings),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Everything pulled from one report, stacked under its document header with panel sub-headers. */
export function useLabsByDocument(p: LabsListParams, enabled = true) {
  return useQuery({
    queryKey: labKeys.byDocument(p),
    queryFn: () => api.get<{ documents: DocumentLabs[]; total: number }>(`/api/labs/by-document${qs(p as Record<string, string | undefined>)}`).then(withReadings),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/**
 * One test's values and its chart. `wordOnly`: every result is in words (Negative, Clear, Not detected), so the server
 * sends no chart (null) and the page lists the results instead. Older servers send neither field: the page then reads
 * the chart and rows itself (features/labs/words.ts trendShape).
 */
export interface LabSeriesResponse {
  rows: LabSeriesRow[];
  chart: ChartSpec | null;
  wordOnly?: boolean;
  /** Which test on file the name asked for (rule 9): exact, or no rows with the similar tests on file named. */
  match?: AnalyteMatch;
}

export function useLabSeries(p: SeriesParams, enabled = true) {
  return useQuery({
    queryKey: labKeys.series(p),
    queryFn: () => api.get<LabSeriesResponse>(`/api/labs/series${qs({ analyteKey: p.analyteKey, specimen: p.specimen, from: p.from, to: p.to, overlay: p.overlay })}`),
    enabled: enabled && Boolean(p.analyteKey),
    placeholderData: (prev) => prev,
  });
}

export function useLab(id: string | null | undefined) {
  return useQuery({
    queryKey: labKeys.one(id ?? ''),
    queryFn: () => api.get<LabEntry>(`/api/labs/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

// ---------------------------------------------------------------------------
// The one-time re-read of lab values as printed (2026-10): GET /api/labs/reparse-report
// ---------------------------------------------------------------------------

/** The counters of the re-read (server lab-reading.ts LAB_PARSE_RULES); one value can count under several. */
export type LabParseRule =
  | 'limitNotMeasurement'
  | 'wordsNotNumber'
  | 'quoteShowsSymbol'
  | 'rangeShownAsPrinted'
  | 'rangeNumbersIgnored'
  | 'rangeUnparsed'
  | 'flagChanged'
  | 'flagNowClaim'
  | 'flagWarnings'
  | 'unitCollapsed'
  | 'regrouped'
  | 'dateKindUnknown'
  | 'sameSourceConflicts'
  | 'claimDifferences';

/** The re-read's report (server lab-reading.ts LabParseReport), as stored in the encrypted database. */
export interface LabParseReport {
  version: number;
  ranAt: string;
  dryRun: boolean;
  rows: { total: number; live: number; deleted: number; filled: number; readingChanged: number };
  facts: { total: number; readingChanged: number };
  byRule: Partial<Record<LabParseRule, number>>;
  /** Up to 20 examples, for this dialog only. */
  examples: Array<{ entryId: string; test: string; rule: string; before: string; after: string }>;
  /** The first check against the clinical records after the re-read: details put back, set aside, no longer compared. */
  reconcile?: { undone: number; setAside: number; notCompared: number } | null;
  error?: string;
}

export interface LabParseReportResponse {
  /** Null before the re-read has run on this database. */
  report: LabParseReport | null;
  /** The last failure, if any (it tries again at the next unlock). */
  error: { at: string; error: string } | null;
}

export function getReparseReport(): Promise<LabParseReportResponse> {
  return api.get<LabParseReportResponse>('/api/labs/reparse-report');
}

/** The re-read's report, loaded when the "Values re-read" dialog opens. */
export function useReparseReport(enabled = true) {
  return useQuery({ queryKey: labKeys.reparse, queryFn: getReparseReport, enabled, staleTime: 10_000 });
}

export function useLabDocuments() {
  return useQuery({ queryKey: ['documents', 'lite-for-ledgers'], queryFn: () => listOrEmpty<DocumentLite>('/api/documents?sort=title', { requireId: true }), staleTime: 30_000, retry: false });
}

export function useLabInstitutions() {
  return useQuery({
    queryKey: ['people', 'institutions-for-ledgers'],
    queryFn: async () => {
      const [a, b] = await Promise.all([listOrEmpty<PersonLite>('/api/people?kind=institution', { requireId: true }), listOrEmpty<PersonLite>('/api/people?kind=clinic', { requireId: true })]);
      const seen = new Set<string>();
      return [...a, ...b].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((x, y) => x.name.localeCompare(y.name));
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLabMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: labKeys.all });
    void qc.invalidateQueries({ queryKey: ['facts'] });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
  };
  const create = useMutation({ mutationFn: (input: LabInput) => api.post<LabEntry>('/api/labs', input), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<LabInput> }) => api.patch<LabEntry>(`/api/labs/${encodeURIComponent(id)}`, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/labs/${encodeURIComponent(id)}`), onSuccess: refresh });
  const fromFacts = useMutation({
    mutationFn: (input: { factIds?: string[] } = {}) => api.post<{ created: number; skipped: number; items: LabEntry[] }>('/api/labs/from-facts', input),
    onSuccess: refresh,
  });
  return { create, update, remove, fromFacts };
}
