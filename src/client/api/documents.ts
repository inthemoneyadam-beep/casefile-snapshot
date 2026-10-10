/**
 * Documents API: types mirrored from the server rows and TanStack Query hooks.
 */
import { useMutation, useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { JobRow } from './hooks';
import type { DocumentCategory, DocumentKind, ExtractionStatus, TextStatus } from '@shared/enums';
import type { TrustInfo } from '@shared/reconcile';
import { PAGE_BUCKET, pageBuckets, type PageRange } from '../features/documents/pages';
import { beginUpload, uploadFailed, uploadSent } from '../features/inbox/uploads';
import type { DocumentCoverage, OutlineEntry, ReprocessRequestInput, ReprocessResult, ResumeDecision, SegmentEstimate, UploadConfirmation, UploadRecord } from '@shared/schemas/segments';
import type { PatientCheck } from '@shared/patient-identity';

export type { DocumentCoverage, OutlineEntry, ReprocessResult, ResumeDecision, SegmentEstimate, UploadConfirmation, UploadRecord };

export interface Document {
  id: string;
  title: string;
  filename: string;
  mime: string;
  kind: DocumentKind | string;
  category: DocumentCategory | string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  institutionId: string | null;
  authorPersonId: string | null;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  pageCount: number;
  textStatus: TextStatus | string;
  textError: string | null;
  ocrApplied: boolean;
  extractionStatus: ExtractionStatus | string;
  extractionSchemaVersion: number | null;
  metadataJson: string;
  tagsJson: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * The older document this one looks like a copy of (server: services/duplicates.ts), while that one is live; null
 * when there is none or the user chose Keep both. `similarity` is the share of the wording the two have in common.
 */
export interface LikelyCopy {
  documentId: string;
  title: string;
  similarity: number;
  at: string | null;
}

export interface DocumentListItem extends Document {
  factsCount: number;
  unverifiedCount: number;
  institutionName: string | null;
  likelyCopyOf?: LikelyCopy | null;
}

/** "97% the same wording": rounded down, so only wording that is all the same reads 100%. */
export function copyWording(similarity: number): string {
  return `${Math.max(0, Math.min(100, Math.floor(similarity * 100)))}% the same wording`;
}

export interface PageSummary {
  pageNumber: number;
  charCount: number;
  ocr: boolean;
  confidence: number | null;
}

export interface ExtractionRun {
  id: string;
  documentId: string;
  schemaVersion: number;
  model: string;
  deep: boolean;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  factsCount: number;
  mergesProposed: number;
  chunks: number;
  error: string | null;
}

/** Where the document date came from; null when there is no date or it is unknown. */
export type DateSource = 'filename' | 'text' | 'dicom' | 'ai' | 'user';

export interface DocumentDetail extends DocumentListItem {
  pages: PageSummary[];
  runs: ExtractionRun[];
  jobs: JobRow[];
  dateSource?: DateSource | null;
}

/** A page as GET /api/documents/:id/pages returns it (the word boxes stay on the server). */
export interface DocumentPage {
  id: string;
  documentId: string;
  pageNumber: number;
  text: string;
  ocr: boolean;
  confidence: number | null;
  width: number | null;
  height: number | null;
  charCount: number;
}

/** The window of pages served; `truncated` when the request was wider than the server's limit. */
export interface PageWindow {
  items: DocumentPage[];
  from: number;
  to: number;
  truncated: boolean;
}

/** A soft-deleted document in the trash. */
export interface DeletedDocument {
  id: string;
  title: string;
  filename: string;
  kind: string;
  category: string;
  pageCount: number;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  deletedAt: string;
  createdAt: string;
  /** Facts deleted with the document; a restore brings exactly these back with their verdicts. */
  factsCount: number;
  /** A live document holds the same file, so a restore is refused until it is deleted. */
  duplicateOf: { id: string; title: string } | null;
  /** Set aside with "Set this copy aside" (not restored since): the title of the document it looked like a copy of. */
  setAsideAsCopyOf?: string | null;
  /** With setAsideAsCopyOf: how many of its details carry the user's answers or notes. */
  setAsideCheckedDetails?: number | null;
  /** Deleted with "Not my record" (wrong patient): Restore brings it back as "May be someone else's record". */
  wrongPatient?: boolean;
}

export interface UploadedDocument extends Document {
  duplicate?: boolean;
  jobId?: string | null;
}

/** Shape of GET /api/facts/citations/:id (slice B). */
export interface CitationDetail {
  id: string;
  factId: string | null;
  documentId: string;
  pageNumber: number;
  quote: string;
  charStart: number | null;
  charEnd: number | null;
  verified: boolean;
  matchKind: string | null;
  pageText?: string;
  documentTitle?: string;
}

/** Row of GET /api/facts (slice B); optional fields tolerate the stub. */
export interface FactRow {
  /** The user's check beside the status: 'original' | 'summary' | 'correction' (with confirmed), 'unsure' (with unverified). */
  verdictBasis?: 'original' | 'summary' | 'unsure' | 'correction' | null;
  /** The automatic trust level GET /api/facts attaches (verified, accurate, not backed yet, inaccurate...). */
  trust?: TrustInfo | null;
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  status: string;
  confidence: number;
  sourceDocumentId?: string | null;
  citationCount?: number;
  verifiedCitationCount?: number;
  pageNumber?: number | null;
}

export interface ExtractEstimate {
  chunks: number;
  approxInputTokens: number;
  model: string;
  approxUsd: number;
}

export interface DocumentFilters {
  q?: string;
  category?: string;
  kind?: string;
  textStatus?: string;
  extractionStatus?: string;
  institutionId?: string;
  /** Only the likely copies ('1'). */
  copies?: '1';
  /** Documents held back as "May be someone else's record": include them (the Documents page) or list only them. */
  patient?: 'include' | 'only';
}

export const ACTIVE_TEXT = new Set(['pending', 'extracting', 'ocr_running']);
export const ACTIVE_EXTRACTION = new Set(['queued', 'running']);

export function isBusy(d: Pick<Document, 'textStatus' | 'extractionStatus'>): boolean {
  return ACTIVE_TEXT.has(d.textStatus) || ACTIVE_EXTRACTION.has(d.extractionStatus);
}

export function useDocuments(filters: DocumentFilters) {
  return useQuery({
    queryKey: ['documents', filters],
    queryFn: () => api.get<{ items: DocumentListItem[] }>(`/api/documents${api.qs({ ...filters })}`),
    refetchInterval: (q) => (q.state.data?.items.some(isBusy) ? 2500 : false),
  });
}

export function useDocument(id: string | null | undefined) {
  return useQuery({
    queryKey: ['document', id],
    queryFn: () => api.get<DocumentDetail>(`/api/documents/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      return isBusy(d) || d.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 2000 : false;
    },
  });
}

export { PAGE_BUCKET, pageBuckets, type PageRange };

/** One query per bucket of `pageBuckets(ranges)` (fixed 50-page buckets), in the same order. */
export function useDocumentPageRanges(id: string, ranges: PageRange[]) {
  return useQueries({
    queries: pageBuckets(ranges).map((r) => ({
      queryKey: ['document', id, 'pages', r.from, r.to],
      queryFn: () => api.get<PageWindow>(`/api/documents/${id}/pages${api.qs({ from: r.from, to: r.to })}`),
      staleTime: 60_000,
    })),
  });
}

export function useCitation(citationId: string | undefined) {
  return useQuery({
    queryKey: ['citation', citationId],
    queryFn: () => api.get<CitationDetail>(`/api/facts/citations/${citationId}`),
    enabled: Boolean(citationId),
    retry: false,
    staleTime: 60_000,
  });
}

export function useDocumentFacts(documentId: string | undefined) {
  return useQuery({
    queryKey: ['facts', { documentId }],
    queryFn: async () => {
      const r = await api.get<{ items?: FactRow[] }>(`/api/facts${api.qs({ documentId, limit: 500 })}`);
      return { items: Array.isArray(r.items) ? r.items : [] };
    },
    enabled: Boolean(documentId),
    staleTime: 10_000,
  });
}

export interface FactDetail extends FactRow {
  citations?: Array<{ id: string; pageNumber: number; verified: boolean; quote: string }>;
}

export async function fetchFactDetail(id: string): Promise<FactDetail | null> {
  try {
    return await api.get<FactDetail>(`/api/facts/${id}`);
  } catch {
    return null;
  }
}

/** Slice B may not have this yet; a 404 becomes null rather than an error. */
export function useExtractEstimate(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['extract-estimate', documentId],
    queryFn: async () => {
      try {
        return await api.get<ExtractEstimate>(`/api/facts/extract/estimate${api.qs({ documentId })}`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 501)) return null;
        throw err;
      }
    },
    enabled: Boolean(documentId) && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export interface PersonLite {
  id: string;
  name: string;
  kind: string;
}

export function useInstitutions() {
  return useQuery({
    queryKey: ['people', { kind: 'institution' }],
    queryFn: async () => {
      const r = await api.get<{ items?: PersonLite[] }>('/api/people?kind=institution');
      return { items: Array.isArray(r.items) ? r.items : [] };
    },
    staleTime: 60_000,
  });
}

export function useUploadDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { files: File[]; category?: string; autoExtract?: boolean }) => {
      const fd = new FormData();
      for (const f of input.files) fd.append('files', f, f.name);
      if (input.category) fd.append('category', input.category);
      fd.append('autoExtract', input.autoExtract === false ? '0' : '1');
      // The "adding" banner follows every upload until the whole document is read and analysed (features/inbox/uploads.ts).
      const batch = beginUpload(input.files);
      try {
        const r = await api.post<{ items: UploadedDocument[] }>('/api/documents', fd);
        uploadSent(batch, r.items);
        return r;
      } catch (err) {
        uploadFailed(batch, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export interface DocumentPatch {
  title?: string;
  category?: string;
  documentDateText?: string | null;
  documentDate?: string | null;
  institutionId?: string | null;
  authorPersonId?: string | null;
  tags?: string[];
  notes?: string | null;
}

export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DocumentPatch }) => api.patch<DocumentDetail>(`/api/documents/${id}`, patch),
    onSuccess: (data) => {
      qc.setQueryData(['document', data.id], data);
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true; factsDeleted: number }>(`/api/documents/${id}`),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: ['document', id] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['documents-trash'] });
      void qc.invalidateQueries({ queryKey: ['facts'] });
    },
  });
}

/** Keep both: the document is not a copy of the one it looked like; that pair is never flagged again. */
export function useKeepBothCopies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DocumentDetail>(`/api/documents/${id}/not-a-copy`, {}),
    onSuccess: (data) => {
      qc.setQueryData(['document', data.id], data);
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export interface SetAsideCopyResult {
  ok: true;
  factsDeleted: number;
  /** What Claude had filed only from the copy, taken back. */
  takenBack: number;
  /** Filed items left standing: keptWorkedOn + keptAllergies + keptShared. */
  kept: number;
  /** Filed items the user has worked on, left alone. */
  keptWorkedOn?: number;
  /** Allergies filed from the copy: they always stay. */
  keptAllergies?: number;
  /** What another document (the original or another) also has, and a call or appointment only the copy made (now on the original), left alone. */
  keptShared?: number;
  /** Details on the copy carrying the user's answers or notes: they go to Deleted documents with it; Restore brings them back. */
  checkedDetails?: number;
  /** Details of the original the user had merged into the copy's details: shown again on the original. */
  unmerged?: number;
  /** What filing the original again placed (only when something was taken back). */
  refiled?: number;
  /** The same, in its own words ("Added a medication: ibuprofen"). */
  refiledItems?: string[];
}

/** The most items a toast names; the rest are counted. */
const REFILED_NAMED_MAX = 3;

/**
 * What Set this copy aside did, in a few plain words (a toast is short-lived: what matters most comes first).
 * Allergies and what the original also has stay without a word: nothing changed there.
 */
export function setAsideWords(r: Pick<SetAsideCopyResult, 'takenBack' | 'keptWorkedOn' | 'checkedDetails' | 'unmerged' | 'refiledItems'>): string {
  const checked = r.checkedDetails ?? 0;
  const parts = [checked ? 'Set aside in Deleted documents.' : 'Set aside in Deleted documents, where Restore brings it back.'];
  if (checked) parts.push(`${checked} detail${checked === 1 ? '' : 's'} you checked or noted went with it; Restore brings ${checked === 1 ? 'it' : 'them'} back.`);
  const unmerged = r.unmerged ?? 0;
  if (unmerged) parts.push(`${unmerged} detail${unmerged === 1 ? '' : 's'} you had merged into the copy ${unmerged === 1 ? 'is' : 'are'} back on the original.`);
  if (r.takenBack) parts.push(`Took back ${r.takenBack} thing${r.takenBack === 1 ? '' : 's'} filed only from it.`);
  const refiled = (r.refiledItems ?? []).map((s) => s.trim().replace(/[.\s]+$/u, '')).filter(Boolean);
  if (refiled.length) {
    const named = refiled.slice(0, REFILED_NAMED_MAX).join('; ');
    const more = refiled.length - REFILED_NAMED_MAX;
    parts.push(`Filed again from the original: ${named}${more > 0 ? `; and ${more} more` : ''}.`);
  }
  const workedOn = r.keptWorkedOn ?? 0;
  if (workedOn) parts.push(`${workedOn} you worked on ${workedOn === 1 ? 'stays' : 'stay'}.`);
  return parts.join(' ');
}

/** The Deleted documents line for a copy set aside (and not restored since). */
export function setAsideTrashWords(copyOf: string, checkedDetails: number): string {
  const checked = checkedDetails > 0 ? ` ${checkedDetails} of its details carr${checkedDetails === 1 ? 'ies' : 'y'} your answers or notes.` : '';
  return `Set aside as a copy of "${copyOf}".${checked} Restoring brings ${checkedDetails > 0 ? 'them' : 'it'} back and files it again.`;
}

/**
 * Set this copy aside: the original's details the user merged into the copy's are shown again, what Claude filed only
 * from it is taken back (allergies, what the original also has, and a call or appointment only the copy made stay),
 * then the ordinary soft delete (Restore brings it back), and, if something was taken back, the original is filed again.
 */
export function useSetAsideCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SetAsideCopyResult>(`/api/documents/${id}/set-aside-copy`, {}),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: ['document', id] });
      // The original was filed again (and a records row may now hold it): its page and the lists it files into change.
      void qc.invalidateQueries({ queryKey: ['document'] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['documents-trash'] });
      void qc.invalidateQueries({ queryKey: ['facts'] });
      void qc.invalidateQueries({ queryKey: ['filing'] });
      void qc.invalidateQueries({ queryKey: ['records'] });
      void qc.invalidateQueries({ queryKey: ['medications'] });
      void qc.invalidateQueries({ queryKey: ['communications'] });
      void qc.invalidateQueries({ queryKey: ['encounters'] });
    },
  });
}

/** The trash: soft-deleted documents, most recently deleted first. */
export function useDeletedDocuments(enabled = true) {
  return useQuery({
    queryKey: ['documents-trash'],
    queryFn: () => api.get<{ items: DeletedDocument[] }>('/api/documents/trash'),
    enabled,
  });
}

/** Undo a soft delete: the document and the facts deleted with it come back with their verdicts. */
export function useRestoreDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true; factsRestored: number; document: DocumentDetail }>(`/api/documents/${id}/restore`),
    onSuccess: (r) => {
      qc.setQueryData(['document', r.document.id], r.document);
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['documents-trash'] });
      void qc.invalidateQueries({ queryKey: ['facts'] });
      // A copy that was set aside is filed again when it comes back.
      void qc.invalidateQueries({ queryKey: ['filing'] });
    },
  });
}

export function useReingestDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, forceOcr }: { id: string; forceOcr?: boolean }) => api.post<{ job: JobRow }>(`/api/documents/${id}/reingest`, { forceOcr: Boolean(forceOcr) }),
    onSuccess: (_d, { id }) => {
      void qc.invalidateQueries({ queryKey: ['document', id] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useExtractDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deep }: { id: string; deep?: boolean }) => api.post<{ job: JobRow }>(`/api/documents/${id}/extract`, { deep: Boolean(deep) }),
    onSuccess: (_d, { id }) => {
      void qc.invalidateQueries({ queryKey: ['document', id] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useJobAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'retry' }) => api.post<{ ok: boolean }>(`/api/jobs/${id}/${action}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['document'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function fileUrl(id: string, download = false): string {
  return `/api/documents/${id}/file${download ? '?download=1' : ''}`;
}

export function pageImageUrl(id: string, page: number, scale = 1.5): string {
  return `/api/documents/${id}/page/${page}/image?scale=${scale}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function parseTags(tagsJson: string): string[] {
  try {
    const v = JSON.parse(tagsJson);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Large documents (2026-10-07): how much was read, the outline, the upload confirmation, reading the rest
// ---------------------------------------------------------------------------

/** GET /api/documents/:id/coverage. */
export interface CoverageResponse {
  coverage: DocumentCoverage | null;
  upload: UploadRecord | null;
  confirmation: UploadConfirmation;
  /** What reading the rest would cost (null when nothing is left). */
  estimate: SegmentEstimate | null;
  /** The wrong-patient guard's record (2026-10-09), or null when the document was never checked. */
  patient?: PatientCheck | null;
}

/**
 * Stages after which the banner and the pane stop polling. `read` is a document read before coverage was recorded (the
 * server says `analysing` while a reading is queued or running), so it is settled too (2026-10-07 review, rev-comms #7).
 */
export const SETTLED_STAGES = new Set(['complete', 'partial', 'failed', 'not_requested', 'waiting_for_you', 'read']);

/** A route an older server does not have reads as null, never as an error. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501 || err.status === 405)) return null;
    throw err;
  }
}

export function useDocumentCoverage(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['document', id, 'coverage'],
    queryFn: () => orNull(api.get<CoverageResponse>(`/api/documents/${id}/coverage`)),
    enabled: Boolean(id) && enabled,
    retry: false,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      return SETTLED_STAGES.has(d.confirmation.stage) && d.coverage?.state !== 'running' ? false : 4000;
    },
  });
}

export function useDocumentOutline(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['document', id, 'outline'],
    queryFn: async () => (await orNull(api.get<{ entries: OutlineEntry[] }>(`/api/documents/${id}/outline`)))?.entries ?? [],
    enabled: Boolean(id) && enabled,
    retry: false,
    staleTime: 15_000,
  });
}

/** The banner's poll: what each upload has become (at most 50 ids). Polls until every one is settled. */
export function useUploadConfirmations(ids: string[]) {
  const key = ids.slice(0, 50).join(',');
  return useQuery({
    queryKey: ['documents', 'confirmations', key],
    queryFn: async () => (await orNull(api.get<{ items: UploadConfirmation[] }>(`/api/documents/confirmations${api.qs({ ids: key })}`)))?.items ?? [],
    enabled: key.length > 0,
    retry: false,
    refetchInterval: (q) => {
      const items = q.state.data;
      if (!items) return 2500;
      const settled = ids.every((id) => {
        const c = items.find((x) => x.documentId === id);
        return !c || SETTLED_STAGES.has(c.stage);
      });
      return settled ? false : 2500;
    },
  });
}

function useReadingRefresh() {
  const qc = useQueryClient();
  return (ids: string[]) => {
    for (const id of ids) void qc.invalidateQueries({ queryKey: ['document', id] });
    void qc.invalidateQueries({ queryKey: ['documents'] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    void qc.invalidateQueries({ queryKey: ['filing'] });
  };
}

/** Continue reading: the pages not read yet (or the parts that failed, or every page again). `confirm` says yes above the limit. */
export function useResumeReading() {
  const refresh = useReadingRefresh();
  return useMutation({
    mutationFn: ({ id, confirm, deep, scope }: { id: string; confirm?: boolean; deep?: boolean; scope?: 'missing' | 'failed' | 'whole' }) =>
      api.post<ReprocessResult>(`/api/documents/${id}/resume`, { confirm: Boolean(confirm), deep: Boolean(deep), ...(scope ? { scope } : {}) }),
    onSettled: (_d, _e, v) => refresh([v.id]),
  });
}

/** "Not now": Claude does not carry on reading this document until asked again. */
export function useDeclineResume() {
  const refresh = useReadingRefresh();
  return useMutation({
    mutationFn: (id: string) => api.post<ResumeDecision>(`/api/documents/${id}/resume/decline`, {}),
    onSettled: (_d, _e, id) => refresh([id]),
  });
}

/** Yes to the question waiting on the document (the lab check's re-read of pages with missed lab lines, at its cost). */
export function useApproveResume() {
  const refresh = useReadingRefresh();
  return useMutation({
    mutationFn: (id: string) => api.post<ResumeDecision>(`/api/documents/${id}/resume/approve`, {}),
    onSettled: (_d, _e, id) => refresh([id]),
  });
}

/** Read many documents (again) at once. */
export function useReprocessDocuments() {
  const refresh = useReadingRefresh();
  return useMutation({
    mutationFn: (req: ReprocessRequestInput) => api.post<ReprocessResult>('/api/documents/reprocess', req),
    onSettled: (_d, _e, v) => refresh(v.documentIds),
  });
}

/** What a reading request did, in a few words for a toast. */
export function reprocessWords(r: ReprocessResult): string {
  const parts: string[] = [];
  if (r.queued.length) parts.push(`Claude is reading ${r.queued.length === 1 ? 'it' : `${r.queued.length} documents`}`);
  if (r.askFirst.length) parts.push(`${r.askFirst.length === 1 ? 'one waits' : `${r.askFirst.length} wait`} for your go-ahead (above your limit)`);
  if (r.skipped.length) parts.push(`${r.skipped.length} not started: ${r.skipped[0].reason}`);
  return parts.length ? `${parts.join('; ')}.` : 'Nothing to read.';
}
