/**
 * Automatic filing: what Claude filed (settled at once, each with Undo), the
 * counts of what needs the user, and the decisions. Every decision refreshes
 * the whole cache, because one filing can touch a document, a communication,
 * an encounter, a record and the menu counts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Filing {
  id: string;
  documentId: string | null;
  documentTitle: string | null;
  /** document | communication | encounter | record | medication | intolerance */
  targetType: string;
  targetId: string;
  /** classified | created | linked | move */
  action: string;
  /** pending | confirmed | rejected | undone | proposed | approved | declined */
  status: string;
  /** auto | consult | user */
  source: string;
  summary: string;
  detail: Record<string, unknown>;
  askMessageId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** 'automatic' when automatic filing settled it (Undo applies); else who confirmed or decided it. */
  decidedBy: string | null;
  /** What it created was deleted since, on its own page. */
  targetGone: boolean;
  /** Undo applies: settled automatically (or pending from before quiet checks), not the type or the held row. */
  undoable: boolean;
}

export interface PendingCounts {
  /** Documents not sorted yet, or with a move the clinician suggested. */
  documents: number;
  /** Placements still pending from before quiet checks (0 once the one-time cleanup ran). */
  communications: number;
  encounters: number;
  records: number;
  medications: number;
  /** Always 0: lab values, scans and other details no longer wait for a check. */
  labs: number;
  imaging: number;
  facts: number;
  /** Check before filing: uploads waiting there, and documents held back as "May be someone else's record". */
  inbox: number;
  /** Documents held back as "May be someone else's record" (also in inbox). */
  patient?: number;
  /** New things Claude noticed. */
  findings: number;
  /** Open move proposals from the clinician. */
  moves: number;
  /** Documents with an open move proposal. */
  documentsWaiting: number;
  /** Documents Claude named but never filed (a filing that failed; Home offers to file them). */
  unfiled: number;
  /** Documents Claude never sorted (classification never ran or failed). */
  unsorted: number;
  /** Reconciliation: disagreements that need a source (yellow). */
  needsSource: number;
  /** Reconciliation: details marked inaccurate (red, informational, not in the total). */
  inaccurate: number;
  /** needsSource + documents + inbox + findings. */
  total: number;
}

export const filingKeys = {
  all: ['filing'] as const,
  counts: ['filing', 'counts'] as const,
  list: (p: Record<string, string | number | undefined>) => ['filing', 'list', p] as const,
};

export function usePendingCounts() {
  return useQuery({ queryKey: filingKeys.counts, queryFn: () => api.get<PendingCounts>('/api/filing/counts'), refetchInterval: 8000 });
}

export function useFilings(p: { status?: string; targetType?: string; targetId?: string; documentId?: string; askMessageId?: string; ids?: string; limit?: number }, enabled = true) {
  return useQuery({
    queryKey: filingKeys.list(p),
    queryFn: () => api.get<{ items: Filing[]; total: number }>(`/api/filing${api.qs(p)}`),
    enabled,
    refetchInterval: 8000,
  });
}

export interface UnsortedDocument {
  id: string;
  title: string;
  /** Why the last try did not work, when one was made. */
  reason: string | null;
  failedAt: string | null;
  /** Claude is sorting it now (a classification is queued or running). */
  sorting: boolean;
}

/** Documents Claude has not sorted yet. */
export function useUnsorted() {
  return useQuery({ queryKey: ['filing', 'unsorted'] as const, queryFn: () => api.get<{ items: UnsortedDocument[]; total: number }>('/api/filing/unsorted'), refetchInterval: 8000 });
}

/**
 * Documents that need the user, keyed by document id: documents Claude has
 * not sorted yet (with an empty list) and documents with a move the clinician
 * suggested (with that proposal). Any key here is a yellow row on Documents.
 * What Claude filed is settled and never waits.
 */
export function useWaitingByDocument(): Map<string, Filing[]> {
  const proposed = useFilings({ status: 'proposed', limit: 5000 });
  const unsorted = useUnsorted();
  const map = new Map<string, Filing[]>();
  for (const u of unsorted.data?.items ?? []) map.set(u.id, []);
  for (const f of proposed.data?.items ?? []) {
    if (!f.documentId) continue;
    const list = map.get(f.documentId) ?? [];
    list.push(f);
    map.set(f.documentId, list);
  }
  return map;
}

function useRefreshAll() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries();
}

export function useFilingDecision() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'reject' | 'approve' | 'decline' }) => api.post<unknown>(`/api/filing/${id}/${decision}`),
    onSettled: refresh,
  });
}

export function useRefile() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (p: { documentId: string; toCategory: string }) => api.post<unknown>('/api/filing/refile', p),
    onSettled: refresh,
  });
}

export function useFileBacklog() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: () => api.post<{ documents: number; created: number; queued: number; aiOff: boolean }>('/api/filing/backlog'),
    onSettled: refresh,
  });
}

/** File one document Claude named but never filed (no AI call; it files what the naming found). */
export function useFileDocument() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (documentId: string) => api.post<{ created: number; error: string | null; needsSorting: boolean }>(`/api/filing/file/${encodeURIComponent(documentId)}`),
    onSettled: refresh,
  });
}

/** Ask Claude to sort one document now (it is named and filed when that ends). */
export function useSortDocument() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (documentId: string) => api.post<{ queued: boolean }>(`/api/filing/sort/${encodeURIComponent(documentId)}`),
    onSettled: refresh,
  });
}

/** What "Sort them now" did, in plain words. */
export function backlogMessage(r: { created: number; queued: number; aiOff: boolean }): string {
  if (r.aiOff) return 'Claude is switched off or the API key is not working (Settings), so nothing could be sorted.';
  const parts: string[] = [];
  if (r.queued) parts.push(`Claude is sorting ${r.queued} document${r.queued === 1 ? '' : 's'} now; ${r.queued === 1 ? 'it is' : 'they are'} named and filed when done`);
  if (r.created) parts.push(`${r.created} placement${r.created === 1 ? '' : 's'} filed (each can be undone on its document)`);
  return parts.length ? `${parts.join('. ')}.` : 'Nothing needed sorting.';
}

/** Plain names for document types, used wherever the user sees one. */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  clinical_note: 'Visit or clinic note',
  lab_report: 'Lab report',
  imaging_report: 'Scan or imaging report',
  portal_message: 'Portal message',
  call_transcript: 'Phone call record',
  summary: 'Summary',
  dossier: 'Case dossier',
  letter: 'Letter',
  discharge_summary: 'Hospital discharge summary',
  operative_report: 'Procedure or surgery report',
  pathology: 'Pathology report',
  other: 'Other',
};

export function documentTypeLabel(category: string | null | undefined): string {
  if (!category) return 'Not sorted yet';
  return DOCUMENT_TYPE_LABELS[category] ?? category.replace(/_/g, ' ');
}
