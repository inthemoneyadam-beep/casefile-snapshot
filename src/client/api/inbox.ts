/**
 * Typed client for /api/inbox. Query keys start with 'inbox' so one
 * invalidation refreshes the list and the count together.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { beginUpload, uploadFailed, uploadSent } from '../features/inbox/uploads';
import type { Document } from './documents';
import type { FileInboxInput, InboxMeta, InboxStatus, TriageMeta } from '@shared/schemas/inbox';

export type { FileInboxInput, InboxMeta, InboxStatus, TriageAction, TriageMeta } from '@shared/schemas/inbox';

export interface InboxItem extends Document {
  institutionName: string | null;
  authorName: string | null;
  /** Null for a document that is not in the Inbox (a plain upload returned as a duplicate of a drop). */
  inbox: InboxMeta | null;
  triage: TriageMeta | null;
  firstPageSnippet: string;
  /** Columns every document row carries (not yet in the shared Document type). */
  sourceTier?: string;
  authorRole?: string | null;
  titleSource?: string;
}

export interface InboxUpload extends InboxItem {
  duplicate: boolean;
  jobId: string | null;
}

export interface InboxCount {
  count: number;
  byStatus: Record<InboxStatus, number>;
}

/** `status` is a comma list of inbox statuses, 'all', or undefined for the active ones. */
export const inboxKeys = {
  all: ['inbox'] as const,
  list: (status: string | undefined) => ['inbox', 'list', status ?? 'active'] as const,
  count: ['inbox', 'count'] as const,
};

/**
 * Text extraction is running. The server refuses to skip or file meanwhile
 * (the pipeline would write the earlier inbox state back when it finishes).
 */
export function isReading(it: Pick<InboxItem, 'textStatus'>): boolean {
  return it.textStatus === 'extracting' || it.textStatus === 'ocr_running';
}

/**
 * Still being read or classified: the list keeps polling while any of these
 * exist. A failed or cancelled extraction never gets classified on its own,
 * so it does not keep the page polling.
 */
export function isWaiting(it: Pick<InboxItem, 'inbox' | 'textStatus' | 'textError'>): boolean {
  if (!it.inbox) return false;
  if (isReading(it)) return true;
  if (it.inbox.status !== 'new') return false;
  return !textGaveUp(it);
}

/** Extraction stopped without text (failed, or cancelled back to pending with a reason): the item is filed by hand. */
export function textGaveUp(it: Pick<InboxItem, 'textStatus' | 'textError'>): boolean {
  return it.textStatus === 'failed' || (it.textStatus === 'pending' && Boolean(it.textError));
}

/** Whether File it (and Enter) may run: an inbox item, not being read, whose text is there or will not come. */
export function canFileItem(it: Pick<InboxItem, 'inbox' | 'textStatus' | 'textError' | 'pageCount'>): boolean {
  if (!it.inbox || isReading(it)) return false;
  return it.inbox.status !== 'new' || Boolean(it.pageCount) || textGaveUp(it);
}

/** Whether Skip (s) may run. */
export function canSkipItem(it: Pick<InboxItem, 'inbox' | 'textStatus'>): boolean {
  return Boolean(it.inbox) && it.inbox?.status !== 'skipped' && !isReading(it);
}

export function useInbox(status: string | undefined) {
  return useQuery({
    queryKey: inboxKeys.list(status),
    queryFn: () => api.get<{ items: InboxItem[] }>(`/api/inbox${api.qs({ status })}`),
    refetchInterval: (q) => (q.state.data?.items.some(isWaiting) ? 2500 : false),
    placeholderData: (prev) => prev,
  });
}

/** One item by id, for a selection that is no longer in the current list (just filed or skipped). */
export function useInboxItem(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['inbox', 'item', id ?? ''],
    queryFn: () => api.get<InboxItem>(`/api/inbox/${encodeURIComponent(id!)}`),
    enabled: Boolean(id) && enabled,
    refetchInterval: (q) => (q.state.data && isWaiting(q.state.data) ? 2500 : false),
    retry: false,
  });
}

export function useInboxCount() {
  return useQuery({ queryKey: inboxKeys.count, queryFn: () => api.get<InboxCount>('/api/inbox/count'), staleTime: 10_000 });
}

export async function uploadFilesToInbox(files: File[]): Promise<{ items: InboxUpload[] }> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  // The "adding" banner follows it until every page is stored and read (features/inbox/uploads.ts).
  const batch = beginUpload(files, 'inbox');
  try {
    const r = await api.post<{ items: InboxUpload[] }>('/api/inbox', fd);
    uploadSent(batch, r.items);
    return r;
  } catch (err) {
    uploadFailed(batch, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function useInboxRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: inboxKeys.all });
    void qc.invalidateQueries({ queryKey: ['documents'] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
  };
}

export function useUploadToInbox() {
  const refresh = useInboxRefresh();
  return useMutation({ mutationFn: (input: { files: File[] }) => uploadFilesToInbox(input.files), onSuccess: refresh });
}

export function usePasteToInbox() {
  const refresh = useInboxRefresh();
  return useMutation({ mutationFn: (input: { text: string; title?: string }) => api.post<{ items: InboxUpload[] }>('/api/inbox', input), onSuccess: refresh });
}

export function useInboxMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: inboxKeys.all });
    void qc.invalidateQueries({ queryKey: ['documents'] });
    void qc.invalidateQueries({ queryKey: ['document'] });
    void qc.invalidateQueries({ queryKey: ['people'] });
    void qc.invalidateQueries({ queryKey: ['records'] });
    void qc.invalidateQueries({ queryKey: ['communications'] });
    void qc.invalidateQueries({ queryKey: ['encounters'] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    void qc.invalidateQueries({ queryKey: ['today'] });
  };
  const file = useMutation({
    mutationFn: ({ id, input }: { id: string; input: FileInboxInput }) => api.post<InboxItem>(`/api/inbox/${encodeURIComponent(id)}/file`, input),
    onSuccess: refresh,
  });
  const retriage = useMutation({
    mutationFn: (id: string) => api.post<{ job: { id: string }; item: InboxItem }>(`/api/inbox/${encodeURIComponent(id)}/retriage`),
    onSuccess: refresh,
  });
  const skip = useMutation({
    mutationFn: (id: string) => api.post<InboxItem>(`/api/inbox/${encodeURIComponent(id)}/skip`),
    onSuccess: refresh,
  });
  return { file, retriage, skip };
}

/** Encounters for the link checkbox; tolerates the stub endpoint (empty list). */
export interface EncounterLite {
  id: string;
  title: string;
  occurredAt: string | null;
  occurredAtPrecision?: string;
  status?: string;
}

export function useEncountersLite() {
  return useQuery({
    // Its own key: Ask's briefing picker (api/ask.ts) holds only the upcoming visits, this one every visit.
    queryKey: ['encounters', 'lite', 'all'],
    queryFn: async () => {
      try {
        const r = await api.get<{ items?: EncounterLite[] }>('/api/encounters');
        return Array.isArray(r?.items) ? r.items.filter((e) => e && typeof e.id === 'string') : [];
      } catch {
        return [] as EncounterLite[];
      }
    },
    staleTime: 30_000,
    retry: false,
  });
}
