/**
 * Typed client for /api/facts. Query keys all start with 'facts' so one
 * invalidation refreshes lists, detail, stats and merges together.
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { TrustInfo } from '@shared/reconcile';

/**
 * What a confirmed fact was checked against: the original record, or only a
 * summary (agreed as what the summary says; the original is asked for on the
 * Records checklist), or 'correction': the patient's own word corrects the
 * clinical record (the note gives the reason). Null for every other status
 * and for facts confirmed before the choice existed.
 */
/** Beside the status: confirmed against the 'original' record, a 'summary' only (inferred) or as a 'correction'; 'unsure' with unverified. */
export type VerdictBasis = 'original' | 'summary' | 'unsure' | 'correction';
export type FactVerdictStatus = 'confirmed' | 'disputed' | 'unverified';

export interface Fact {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  dateEnd: string | null;
  attributesJson: string;
  confidence: number;
  status: string;
  supersededById: string | null;
  verdictNote: string | null;
  verdictAt: string | null;
  /** Only set while status is 'confirmed'; see VerdictBasis. */
  verdictBasis: VerdictBasis | null;
  origin: string;
  sourceDocumentId: string | null;
  extractionRunId: string | null;
  dedupKey: string | null;
  subjectKey: string | null;
  personId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FactListItem extends Fact {
  documentTitle: string | null;
  citationCount: number;
  verifiedCitationCount: number;
  /** The automatic trust level (services/reconcile.ts): verified, accurate, unbacked, inaccurate, conflict or replaced. */
  trust?: TrustInfo;
}

export interface Citation {
  id: string;
  factId: string | null;
  documentId: string;
  pageNumber: number;
  quote: string;
  charStart: number | null;
  charEnd: number | null;
  verified: boolean;
  matchKind: string | null;
  createdAt: string;
}

export interface FactMerge {
  id: string;
  factIdA: string;
  factIdB: string;
  reason: string;
  similarity: number;
  status: string;
  decidedAt: string | null;
  createdAt: string;
}

export type FactWithDoc = Fact & { documentTitle: string | null };
export interface MergeWithFacts extends FactMerge {
  a: FactWithDoc;
  b: FactWithDoc;
}

export interface ExtractionRunLite {
  id: string;
  model: string;
  deep: boolean;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  schemaVersion: number;
}

export interface FactDetail extends Fact {
  citations: Citation[];
  document: { id: string; title: string } | null;
  merges: MergeWithFacts[];
  supersededBy: Fact | null;
  supersedes: Fact[];
  run: ExtractionRunLite | null;
  /** The automatic trust level (services/reconcile.ts). */
  trust?: TrustInfo;
}

export interface FactStats {
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  pendingMerges: number;
}

export interface FactsListParams {
  type?: string;
  status?: string;
  documentId?: string;
  q?: string;
  origin?: string;
  subject?: string;
  from?: string;
  to?: string;
  /** verified | accurate | unbacked | inaccurate | conflict | replaced */
  trust?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface NewFactInput {
  type: string;
  statement: string;
  dateText?: string | null;
  dateEndText?: string | null;
  attributes?: Record<string, unknown>;
  citation?: { documentId: string; pageNumber: number; quote: string } | null;
  note?: string | null;
}

export interface FactPatchInput {
  statement?: string;
  dateText?: string | null;
  dateEndText?: string | null;
  attributes?: Record<string, unknown>;
  personId?: string | null;
}

export interface DocumentLite {
  id: string;
  title: string;
  extractionStatus?: string;
  factsCount?: number;
  /** primary | patient | compilation | external | unknown */
  sourceTier?: string | null;
  /** The document type (lab_report, clinical_note, summary...) and its date, as GET /api/documents returns them. */
  category?: string | null;
  documentDate?: string | null;
  documentDatePrecision?: string | null;
}

export interface ExtractRequestResult {
  jobs: Array<{ id: string; documentId: string | null; status: string }>;
  skipped: string[];
  /** documentId -> why it was not queued (no page text yet, text still being extracted, not found). */
  skippedReasons?: Record<string, string>;
}

export const factKeys = {
  all: ['facts'] as const,
  list: (p: FactsListParams) => ['facts', 'list', p] as const,
  detail: (id: string) => ['facts', 'detail', id] as const,
  stats: ['facts', 'stats'] as const,
  merges: (status: string) => ['facts', 'merges', status] as const,
};

export function parseAttributes(f: Pick<Fact, 'attributesJson'>): Record<string, unknown> {
  try {
    const v = JSON.parse(f.attributesJson || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function useFactsList(p: FactsListParams, opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: factKeys.list(p),
    queryFn: () => api.get<{ items: FactListItem[]; total: number }>(`/api/facts${api.qs(p as Record<string, string | number | undefined>)}`),
    refetchInterval: opts.refetchInterval ?? false,
    placeholderData: (prev) => prev,
  });
}

/**
 * The facts list in pages of `pageSize` (the server caps a request at 5000),
 * so the whole ledger stays reachable: `fetchNextPage` loads the next window
 * in the server's order. Rows that move between windows while facts are
 * being written are de-duplicated by `flattenFactPages`.
 */
export function useFactsPages(p: FactsListParams, opts: { pageSize?: number; refetchInterval?: number | false } = {}) {
  const pageSize = opts.pageSize ?? 5000;
  return useInfiniteQuery({
    queryKey: [...factKeys.list(p), 'pages', pageSize] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<{ items: FactListItem[]; total: number }>(`/api/facts${api.qs({ ...(p as Record<string, string | number | undefined>), limit: pageSize, offset: pageParam })}`),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, pg) => n + pg.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    refetchInterval: opts.refetchInterval ?? false,
    placeholderData: keepPreviousData,
  });
}

export function flattenFactPages(pages: Array<{ items: FactListItem[] }> | undefined): FactListItem[] {
  const seen = new Set<string>();
  const out: FactListItem[] = [];
  for (const pg of pages ?? []) {
    for (const f of pg.items) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

export function useFact(id: string | null | undefined) {
  return useQuery({
    queryKey: factKeys.detail(id ?? ''),
    queryFn: () => api.get<FactDetail>(`/api/facts/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useFactStats() {
  return useQuery({ queryKey: factKeys.stats, queryFn: () => api.get<FactStats>('/api/facts/stats'), staleTime: 10_000 });
}

export function useMerges(status = 'pending') {
  return useQuery({
    queryKey: factKeys.merges(status),
    queryFn: () => api.get<{ items: MergeWithFacts[] }>(`/api/facts/merges${api.qs({ status })}`),
    placeholderData: (prev) => prev,
  });
}

/** Documents for the filter select. Tolerates the endpoint not existing yet. */
export function useDocumentsLite() {
  return useQuery({
    queryKey: ['documents', 'lite'],
    queryFn: async () => {
      try {
        const r = await api.get<{ items?: DocumentLite[] }>('/api/documents?sort=title');
        return Array.isArray(r?.items) ? r.items.filter((d) => d && typeof d.id === 'string') : [];
      } catch {
        return [] as DocumentLite[];
      }
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useFactMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: factKeys.all });
    void qc.invalidateQueries({ queryKey: ['today'] });
  };
  const verdict = useMutation({
    // basis only means something with 'confirmed'; the server clears it for any other status.
    // Left out (undefined) it is not sent at all.
    mutationFn: ({ id, status, note, basis }: { id: string; status: FactVerdictStatus; note?: string | null; basis?: VerdictBasis | null }) =>
      api.post<FactDetail>(`/api/facts/${encodeURIComponent(id)}/verdict`, { status, note, basis: status === 'confirmed' ? basis : status === 'unverified' && basis === 'unsure' ? 'unsure' : null }),
    onSuccess: (_d, v) => {
      refresh();
      // A verdict changes how lab values and scan results are tagged, and "only from a summary" adds a Records checklist row.
      void qc.invalidateQueries({ queryKey: ['labs'] });
      void qc.invalidateQueries({ queryKey: ['imaging'] });
      // It also changes trust: the Reconciliation page and the document summaries.
      void qc.invalidateQueries({ queryKey: ['reconcile'] });
      void qc.invalidateQueries({ queryKey: ['document'] });
      if (v.basis === 'summary') void qc.invalidateQueries({ queryKey: ['records'] });
    },
  });
  const supersede = useMutation({
    mutationFn: ({ id, byFactId }: { id: string; byFactId: string }) => api.post<FactDetail>(`/api/facts/${encodeURIComponent(id)}/supersede`, { byFactId }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/facts/${encodeURIComponent(id)}`),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FactPatchInput }) => api.patch<FactDetail>(`/api/facts/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const create = useMutation({
    mutationFn: (input: NewFactInput) => api.post<FactDetail>('/api/facts', input),
    onSuccess: refresh,
  });
  const acceptMerge = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: 'a' | 'b' }) => api.post<MergeWithFacts>(`/api/facts/merges/${encodeURIComponent(id)}/accept`, { keep }),
    onSuccess: refresh,
  });
  const rejectMerge = useMutation({
    mutationFn: (id: string) => api.post<MergeWithFacts>(`/api/facts/merges/${encodeURIComponent(id)}/reject`),
    onSuccess: refresh,
  });
  const extract = useMutation({
    mutationFn: (input: { documentIds?: string[]; allWithoutFacts?: boolean; deep?: boolean }) => api.post<ExtractRequestResult>('/api/facts/extract', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
  return { verdict, supersede, remove, update, create, acceptMerge, rejectMerge, extract };
}
