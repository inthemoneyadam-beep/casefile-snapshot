/**
 * Checked against itself (2026-10-09; server: routes/self-check.ts): a document's lab flags against their own values
 * and ranges, and Claude reading its parts for contradictions within themselves. The record, the estimate shown
 * before anything is sent, "Check it against itself" for one document or many, the answer to the question asked above
 * the limit, and the counts per facility.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SelfCheckRecord } from '@shared/selfcheck';

export interface SelfCheckFindingItem {
  id: string;
  title: string;
  category: string;
  status: string;
  severity: string;
  count: number;
}

export interface FacilityCounts {
  institutionId: string | null;
  name: string | null;
  documents: number;
  flags: number;
  contradictions: number;
  open: number;
  words: string;
}

export interface DocumentSelfCheck {
  documentId: string;
  record: SelfCheckRecord | null;
  newUpload: boolean;
  facility: { id: string | null; name: string | null };
  counts: { flags: number; contradictions: number };
  findings: SelfCheckFindingItem[];
  words: string | null;
  facilityTotals: FacilityCounts | null;
}

export interface DocumentEstimate {
  documentId: string;
  title: string;
  checked: boolean;
  eligible: number;
  parts: number;
  calls: number;
  estimateUsd: number;
  flagsToCheck: number;
  blocked: string | null;
}

export interface EstimateResponse {
  items: DocumentEstimate[];
  missing: string[];
  totalUsd: number;
  calls: number;
}

export interface QueueResult {
  documentId: string;
  outcome: 'queued' | 'asked' | 'nothing' | 'off' | 'declined';
  jobId: string | null;
  estimateUsd: number;
  calls: number;
  flags?: { checked: number; mismatched: number; findingId: string | null };
}

export const selfCheckKeys = {
  all: ['self-check'] as const,
  document: (id: string) => ['self-check', 'document', id] as const,
  estimate: (ids: string, force: boolean) => ['self-check', 'estimate', ids, force] as const,
  facilities: (institutionId: string | null) => ['self-check', 'facilities', institutionId ?? ''] as const,
};

/** While Claude is reading the document for contradictions, the record is asked for again every few seconds. */
function busy(d: DocumentSelfCheck | undefined): boolean {
  const s = d?.record?.contradictions?.state;
  return s === 'queued' || s === 'running';
}

export function useDocumentSelfCheck(documentId: string | null | undefined) {
  return useQuery({
    queryKey: selfCheckKeys.document(documentId ?? ''),
    queryFn: () => api.get<DocumentSelfCheck>(`/api/self-check/documents/${encodeURIComponent(documentId!)}`),
    enabled: Boolean(documentId),
    refetchInterval: (q) => (busy(q.state.data) ? 4000 : false),
  });
}

/** What checking costs, before anything is sent. */
export function useSelfCheckEstimate(ids: readonly string[], opts: { force?: boolean; enabled?: boolean } = {}) {
  const key = ids.join(',');
  return useQuery({
    queryKey: selfCheckKeys.estimate(key, Boolean(opts.force)),
    queryFn: () => api.get<EstimateResponse>(`/api/self-check/estimate${api.qs({ ids: key, force: opts.force ? '1' : undefined })}`),
    enabled: (opts.enabled ?? true) && ids.length > 0,
  });
}

export function useFacilitySelfCheck(institutionId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: selfCheckKeys.facilities(institutionId ?? null),
    queryFn: () => api.get<{ items: FacilityCounts[] }>(`/api/self-check/facilities${api.qs({ institutionId: institutionId ?? undefined })}`),
    enabled: enabled && Boolean(institutionId),
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: selfCheckKeys.all });
    void qc.invalidateQueries({ queryKey: ['findings'] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
  };
}

/** "Check it against itself": the flags now; the contradictions by Claude at the cost shown. */
export function useRunSelfCheck() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: string; force?: boolean }) => api.post<QueueResult>(`/api/self-check/documents/${encodeURIComponent(v.id)}/run`, v.force ? { force: true } : {}),
    onSuccess: refresh,
  });
}

/** The same for many documents at once (from Documents). */
export function useRunSelfCheckMany() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { documentIds: string[]; force?: boolean }) => api.post<{ batchId: string; items: QueueResult[]; missing: string[] }>('/api/self-check/run', v.force ? v : { documentIds: v.documentIds }),
    onSuccess: refresh,
  });
}

/** The answer to the question asked above the limit. */
export function useAnswerSelfCheck() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: string; answer: 'yes' | 'not_now' }) => api.post<QueueResult>(`/api/self-check/documents/${encodeURIComponent(v.id)}/answer`, { answer: v.answer }),
    onSuccess: refresh,
  });
}
