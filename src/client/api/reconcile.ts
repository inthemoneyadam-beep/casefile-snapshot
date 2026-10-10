/**
 * Typed client for /api/reconcile (services/reconcile.ts): the counts (polled),
 * events by state, every inaccurate detail, and the user's answers. Query keys
 * all start with 'reconcile'. An answer changes what other pages show (lab and
 * scan rows, details, document summaries, the menu), so every query is
 * refreshed after one.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { InaccurateItem, ReconcileCounts, ReconcileEvent, ReconcileState, ReconcileType, TrustInfo } from '@shared/reconcile';

export type { InaccurateItem, Mention, ReconcileCounts, ReconcileEvent, ReconcileState, Trust, TrustInfo } from '@shared/reconcile';
export { RECONCILE_TYPES, STATE_LABELS, TRUST_LABELS } from '@shared/reconcile';

export interface ReconcilePageParams {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MentionAnswer {
  factId: string;
  trust: TrustInfo;
  counts: ReconcileCounts;
}

export const reconcileKeys = {
  all: ['reconcile'] as const,
  counts: ['reconcile', 'counts'] as const,
  events: (state: ReconcileState, p: ReconcilePageParams) => ['reconcile', 'events', state, p] as const,
  event: (key: string) => ['reconcile', 'event', key] as const,
  inaccurate: (p: ReconcilePageParams) => ['reconcile', 'inaccurate', p] as const,
};

/** Lab results, scans, vital signs, procedures and events are compared with the clinical records; other details are not. */
export function isReconciledType(type: string | null | undefined): boolean {
  return type === 'lab_result' || type === 'imaging_result' || type === 'vital' || type === 'procedure' || type === 'event';
}
export type { ReconcileType };

/** Counts for the tabs and the menu. Cheap on the server (one query when nothing changed), so it is polled. */
export function useReconcileCounts(opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: reconcileKeys.counts,
    queryFn: () => api.get<ReconcileCounts>('/api/reconcile/counts'),
    refetchInterval: opts.refetchInterval ?? 10_000,
    staleTime: 2_000,
  });
}

export function useReconcileEvents(state: ReconcileState, p: ReconcilePageParams, enabled = true) {
  return useQuery({
    queryKey: reconcileKeys.events(state, p),
    queryFn: () => api.get<{ items: ReconcileEvent[]; total: number }>(`/api/reconcile/events${api.qs({ state, q: p.q, limit: p.limit, offset: p.offset })}`),
    enabled,
    // The previous page stays while the next one loads, but never another tab's list.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === state ? prev : undefined),
  });
}

/** One event by its key (a deep link to an event that is not on the page shown). */
export function useReconcileEvent(key: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: reconcileKeys.event(key ?? ''),
    queryFn: () => api.get<ReconcileEvent>(`/api/reconcile/events/${encodeURIComponent(key!)}`),
    enabled: enabled && Boolean(key),
    retry: false,
  });
}

/** One event by its key, read now; null when the key is not listed any more (settled under another date, or gone). */
export async function readReconcileEvent(key: string): Promise<ReconcileEvent | null> {
  try {
    return await api.get<ReconcileEvent>(`/api/reconcile/events/${encodeURIComponent(key)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** One event by its key, with null (not an error) when the key is not listed any more. Refreshed with every other reconcile query. */
export function useReconcileEventOrNull(key: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: [...reconcileKeys.event(key ?? ''), 'or-null'] as const,
    queryFn: () => readReconcileEvent(key!),
    enabled: enabled && Boolean(key),
    retry: false,
  });
}

/** Read one event now (through the cache), for "See the whole event": its state picks the tab. */
export function fetchReconcileEvent(qc: QueryClient, key: string): Promise<ReconcileEvent | null> {
  return qc.fetchQuery({ queryKey: [...reconcileKeys.event(key), 'or-null'] as const, queryFn: () => readReconcileEvent(key), staleTime: 0, retry: false });
}

export function useInaccurate(p: ReconcilePageParams, enabled = true) {
  return useQuery({
    queryKey: reconcileKeys.inaccurate(p),
    queryFn: () => api.get<{ items: InaccurateItem[]; total: number }>(`/api/reconcile/inaccurate${api.qs({ q: p.q, limit: p.limit, offset: p.offset })}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * The user's answers. Each refreshes everything, since trust shows on lab and
 * scan rows, details, document summaries and the menu.
 */
export function useReconcileMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries();
  const official = useMutation({ mutationFn: (documentId: string) => api.post<{ documentId: string; changed: boolean; counts: ReconcileCounts }>('/api/reconcile/official', { documentId }), onSuccess: refresh });
  const correct = useMutation({ mutationFn: ({ factId, reason }: { factId: string; reason: string }) => api.post<MentionAnswer>('/api/reconcile/correct', { factId, reason }), onSuccess: refresh });
  const separate = useMutation({ mutationFn: (factId: string) => api.post<MentionAnswer>('/api/reconcile/separate', { factId }), onSuccess: refresh });
  const keep = useMutation({ mutationFn: (factId: string) => api.post<MentionAnswer>('/api/reconcile/keep', { factId }), onSuccess: refresh });
  const reset = useMutation({ mutationFn: (factId: string) => api.post<MentionAnswer>('/api/reconcile/reset', { factId }), onSuccess: refresh });
  const run = useMutation({ mutationFn: () => api.post<ReconcileCounts>('/api/reconcile/run', {}), onSuccess: refresh });
  const busy = official.isPending || correct.isPending || separate.isPending || keep.isPending || reset.isPending || run.isPending;
  return { official, correct, separate, keep, reset, run, busy };
}
