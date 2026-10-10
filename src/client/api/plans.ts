/**
 * Plan API (2026-10-09): types mirror services/plans.ts (PlanListItem, PlanDetail, PlanItemView, PlanOriginal). Query
 * keys start with 'plans'. A plan still being read is polled until its reading settles.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanCitation, PlanItemDetailJson, PlanProgress, PlanReading, PlanStatus, PlanUserField } from '@shared/plan';
import { api } from './client';
import type { Task } from './tasks';

export interface PlanSummary {
  id: string;
  title: string;
  status: PlanStatus;
  documentId: string | null;
  documentTitle: string | null;
  planDate: string | null;
  planDatePrecision: string;
  planDateText: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  reading: PlanReading | null;
  progress: PlanProgress;
  progressWords: string;
  itemCount: number;
  supersededAt: string | null;
  supersededBy: string | null;
}

export interface PlanItem {
  id: string;
  planId: string;
  parentId: string | null;
  seq: number;
  order: string;
  depth: number;
  kind: string;
  kindWords: string;
  title: string;
  detail: string | null;
  owner: string | null;
  due: string | null;
  duePrecision: string;
  dueText: string | null;
  condition: string | null;
  status: string;
  statusWords: string;
  doneAt: string | null;
  doneBy: string | null;
  note: string | null;
  actionable: boolean;
  citations: PlanCitation[];
  asWritten: PlanItemDetailJson['asWritten'] | null;
  userFields: PlanUserField[];
  task: { id: string; title: string; status: string; dueAt: string | null } | null;
  carriedFrom: { planId: string; itemId: string; at: string; by?: string | null; title: string | null; status: string | null; note: string | null } | null;
  looksLike: { itemId: string; title: string; status: string; doneAt: string | null; doneBy: string | null; note: string | null } | null;
  parentTitle: string | null;
  sectionTitle: string | null;
  childIds: string[];
  updatedAt: string;
}

export interface PlanDetail extends PlanSummary {
  asWrittenTitle: string | null;
  items: PlanItem[];
  carryOver: { fromPlanId: string; fromTitle: string | null; matches: number; appliedAt: string | null; applied: number | null; dismissedAt: string | null } | null;
  history: Array<{ at: string; by?: string | null; what: string }>;
  document: { id: string; title: string; kind: string; mime: string; pageCount: number; documentDate: string | null; documentDatePrecision: string; sourceTier: string } | null;
}

export interface PlanPassage {
  key: string;
  itemId: string;
  itemTitle: string;
  kindWords: string;
  page: number;
  quote: string;
  verified: boolean;
  matchKind: string;
  start: number | null;
  end: number | null;
}

export interface PlanOriginal {
  documentId: string;
  title: string;
  mime: string;
  kind: string;
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
  passages: PlanPassage[];
  pagesLeftOut: number;
}

export interface PlanEstimate {
  pages: number;
  chars: number;
  calls: number;
  estimateUsd: number;
  ceilingUsd: number;
  aboveCeiling: boolean;
  model: string;
}

export interface AddedPlan {
  plan: PlanDetail;
  duplicate: boolean;
  existing: boolean;
}

export interface ItemPatch {
  title?: string;
  owner?: string | null;
  due?: string | null;
  note?: string | null;
}

export interface TodoInput {
  title?: string;
  detail?: string | null;
  owner?: string;
  dueAt?: string | null;
  priority?: string;
}

export const planKeys = {
  all: ['plans'] as const,
  list: ['plans', 'list'] as const,
  one: (id: string) => ['plans', 'one', id] as const,
  original: (id: string) => ['plans', 'original', id] as const,
};

/** A reading that has not settled yet: the page asks again every 2 seconds. */
export function readingBusy(r: PlanReading | null | undefined): boolean {
  return r?.state === 'waiting' || r?.state === 'reading';
}

export function usePlans() {
  return useQuery({
    queryKey: planKeys.list,
    queryFn: () => api.get<{ items: PlanSummary[]; currentId: string | null }>('/api/plans'),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((p) => readingBusy(p.reading)) ? 2000 : false),
  });
}

export function usePlan(id: string | null | undefined) {
  return useQuery({
    queryKey: planKeys.one(id ?? ''),
    queryFn: () => api.get<PlanDetail>(`/api/plans/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (readingBusy(q.state.data?.reading) ? 2000 : false),
  });
}

export function usePlanOriginal(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: planKeys.original(id ?? ''),
    queryFn: () => api.get<PlanOriginal>(`/api/plans/${encodeURIComponent(id!)}/original`),
    enabled: Boolean(id) && enabled,
    staleTime: 30_000,
  });
}

export function fetchPlanEstimate(id: string): Promise<PlanEstimate> {
  return api.get<PlanEstimate>(`/api/plans/${encodeURIComponent(id)}/estimate`);
}

/** What reading a document already in the case as the plan would cost (before "Read it as the plan"). */
export function useDocumentPlanEstimate(documentId: string | null | undefined) {
  return useQuery({
    queryKey: ['plans', 'document-estimate', documentId ?? ''],
    queryFn: () => api.get<PlanEstimate & { existingPlanId: string | null }>(`/api/plans/document-estimate/${encodeURIComponent(documentId!)}`),
    enabled: Boolean(documentId),
  });
}

export function fetchPlanItem(id: string): Promise<{ planId: string; item: PlanItem }> {
  return api.get<{ planId: string; item: PlanItem }>(`/api/plans/items/${encodeURIComponent(id)}`);
}

export function usePlanMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: planKeys.all });
  };
  const refreshTasks = () => {
    refresh();
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const enc = encodeURIComponent;
  return {
    upload: useMutation({
      mutationFn: (file: File) => {
        const fd = new FormData();
        fd.append('file', file, file.name);
        return api.post<AddedPlan>('/api/plans', fd);
      },
      onSuccess: () => {
        refresh();
        void qc.invalidateQueries({ queryKey: ['documents'] });
      },
    }),
    fromDocument: useMutation({ mutationFn: (documentId: string) => api.post<AddedPlan>('/api/plans/from-document', { documentId }), onSuccess: refresh }),
    read: useMutation({ mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) => api.post<{ plan: PlanDetail; jobId: string; newPlan: boolean }>(`/api/plans/${enc(id)}/read`, confirm ? { confirm: true } : {}), onSuccess: refresh }),
    rename: useMutation({ mutationFn: ({ id, title }: { id: string; title: string }) => api.patch<PlanDetail>(`/api/plans/${enc(id)}`, { title }), onSuccess: refresh }),
    makeCurrent: useMutation({ mutationFn: (id: string) => api.post<PlanDetail>(`/api/plans/${enc(id)}/current`), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.delete<{ ok: true; nowCurrent: string | null }>(`/api/plans/${enc(id)}`), onSuccess: refresh }),
    restore: useMutation({ mutationFn: (id: string) => api.post<PlanDetail>(`/api/plans/${enc(id)}/restore`), onSuccess: refresh }),
    carryOver: useMutation({ mutationFn: ({ id, itemIds }: { id: string; itemIds?: string[] }) => api.post<{ marked: number; plan: PlanDetail }>(`/api/plans/${enc(id)}/carry-over`, itemIds ? { itemIds } : {}), onSuccess: refresh }),
    dismissCarry: useMutation({ mutationFn: (id: string) => api.post<PlanDetail>(`/api/plans/${enc(id)}/carry-over/dismiss`), onSuccess: refresh }),
    setStatus: useMutation({ mutationFn: ({ id, status, note }: { id: string; status: string; note?: string | null }) => api.post<PlanItem>(`/api/plans/items/${enc(id)}/status`, note !== undefined ? { status, note } : { status }), onSuccess: refresh }),
    updateItem: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: ItemPatch }) => api.patch<PlanItem>(`/api/plans/items/${enc(id)}`, patch), onSuccess: refresh }),
    makeTodo: useMutation({ mutationFn: ({ id, input }: { id: string; input: TodoInput }) => api.post<{ task: Task; item: PlanItem }>(`/api/plans/items/${enc(id)}/todo`, input), onSuccess: refreshTasks }),
  };
}
