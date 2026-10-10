/**
 * Typed client for /api/notes (routes/notes.ts): My notes, the import and the reading of notes, the medication timeline
 * (Reconciliation, Records vs records) and Records vs my notes. Query keys start with 'notes'. An answer changes what
 * Medications, Reconciliation, the details and the clinician read, so every query is refreshed after one.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  DrugSummary,
  DrugTimeline,
  NoteDocItem,
  NoteDrugItem,
  NoteEntry,
  NoteImportResult,
  NoteImportStatus,
  NotesAnswer,
  NotesCounts,
  NotesItem,
  NotesReadingEstimate,
  NoteView,
  RecordsAnswer,
} from '@shared/notes';

export type { DrugSummary, DrugTimeline, NoteDocItem, NoteDrugItem, NoteEntry, NoteImportResult, NoteImportStatus, NotesAnswer, NotesCounts, NotesItem, NotesReadingEstimate, NoteView, RecordsAnswer };

export const notesKeys = {
  all: ['notes'] as const,
  list: (view: NoteView, q: string | undefined) => ['notes', 'list', view, q ?? ''] as const,
  doc: (id: string) => ['notes', 'doc', id] as const,
  drug: (key: string) => ['notes', 'drug', key] as const,
  import: (batch: string) => ['notes', 'import', batch] as const,
  estimate: (what: string) => ['notes', 'estimate', what] as const,
  timeline: (only: string, q: string | undefined) => ['notes', 'timeline', only, q ?? ''] as const,
  drugTimeline: (key: string) => ['notes', 'timeline-drug', key] as const,
  reconcile: (list: string, q: string | undefined) => ['notes', 'reconcile', list, q ?? ''] as const,
  counts: ['notes', 'counts'] as const,
};

export function useNoteList<T = NoteDocItem | NoteDrugItem | NoteEntry>(view: NoteView, q?: string) {
  return useQuery({
    queryKey: notesKeys.list(view, q),
    queryFn: () => api.get<{ items: T[] }>(`/api/notes/list${api.qs({ view, q })}`),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === view ? prev : undefined),
  });
}

export function useNoteDoc(id: string | null | undefined) {
  return useQuery({ queryKey: notesKeys.doc(id ?? ''), queryFn: () => api.get<{ note: NoteDocItem; entries: NoteEntry[] }>(`/api/notes/doc/${encodeURIComponent(id!)}`), enabled: Boolean(id), retry: false });
}

export function useNoteDrug(key: string | null | undefined) {
  return useQuery({ queryKey: notesKeys.drug(key ?? ''), queryFn: () => api.get<{ key: string; name: string; entries: NoteEntry[]; timeline: DrugTimeline | null }>(`/api/notes/drug/${encodeURIComponent(key!)}`), enabled: Boolean(key), retry: false });
}

/** An import's progress: polled while its notes' text is being stored or they are being read. */
export function useImportStatus(batch: string | null | undefined) {
  return useQuery({
    queryKey: notesKeys.import(batch ?? ''),
    queryFn: () => api.get<NoteImportStatus>(`/api/notes/imports/${encodeURIComponent(batch!)}`),
    enabled: Boolean(batch),
    refetchInterval: (q) => {
      const d = q.state.data;
      return !d || d.pending > 0 || d.reading > 0 ? 2000 : false;
    },
  });
}

/** What to read: every note not read yet, or these notes. */
export type ReadWhat = { scope: 'unread' } | { documentIds: string[] };

/** What reading them would cost (shown before any reading starts). */
export function useReadingEstimate(what: ReadWhat | null) {
  const qs = !what ? '' : 'scope' in what ? '?scope=unread' : `?ids=${encodeURIComponent(what.documentIds.join(','))}`;
  return useQuery({ queryKey: notesKeys.estimate(qs), queryFn: () => api.get<NotesReadingEstimate>(`/api/notes/read/estimate${qs}`), enabled: Boolean(what), staleTime: 0 });
}

export function useNotesImport() {
  const qc = useQueryClient();
  const files = useMutation({
    mutationFn: (list: File[]) => {
      const fd = new FormData();
      for (const f of list) fd.append('files', f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
      fd.append('times', JSON.stringify(list.map((f) => (Number.isFinite(f.lastModified) ? f.lastModified : null))));
      return api.post<NoteImportResult>('/api/notes/import', fd);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKeys.all }),
  });
  const folder = useMutation({
    mutationFn: (b: { path: string; recursive?: boolean }) => api.post<NoteImportResult & { truncated?: boolean }>('/api/notes/import-folder', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKeys.all }),
  });
  const read = useMutation({
    mutationFn: (b: { batch?: string; documentIds?: string[]; scope?: 'unread' }) => api.post<{ packs: number; alone: number; jobs: number; estimate: NotesReadingEstimate }>('/api/notes/read', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKeys.all }),
  });
  return { files, folder, read };
}

// ---------------------------------------------------------------------------
// Reconciliation: the medication timeline (stage 1) and Records vs my notes (stage 2)
// ---------------------------------------------------------------------------

export function useDrugList(only: 'open' | 'all', q?: string, enabled = true) {
  return useQuery({ queryKey: notesKeys.timeline(only, q), queryFn: () => api.get<{ items: DrugSummary[] }>(`/api/notes/timeline${api.qs({ only, q })}`), enabled, placeholderData: keepPreviousData });
}

export function useDrugTimeline(key: string | null | undefined) {
  return useQuery({ queryKey: notesKeys.drugTimeline(key ?? ''), queryFn: () => api.get<DrugTimeline>(`/api/notes/timeline/${encodeURIComponent(key!)}`), enabled: Boolean(key), retry: false });
}

export function useNotesItems(list: NotesItem['state'], q?: string, enabled = true) {
  return useQuery({ queryKey: notesKeys.reconcile(list, q), queryFn: () => api.get<{ items: NotesItem[]; counts: NotesCounts }>(`/api/notes/reconcile${api.qs({ list, q })}`), enabled, placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === list ? prev : undefined) });
}

/** The counts on the Reconciliation stage switch (polled, like the page's own counts). */
export function useNotesCounts() {
  return useQuery({ queryKey: notesKeys.counts, queryFn: () => api.get<NotesCounts>('/api/notes/reconcile/counts'), refetchInterval: 10_000, staleTime: 2_000 });
}

export interface TimelineAnswerResult {
  answerId: string | null;
  timeline: DrugTimeline;
  words: string;
}

/** Every answer refreshes everything: Medications, Reconciliation, details and the clinician read them. */
export function useTimelineMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries();
  const records = useMutation({ mutationFn: (b: { disagreementKey: string; answer: RecordsAnswer; pointId?: string | null }) => api.post<TimelineAnswerResult>('/api/notes/timeline/answer', b), onSuccess: refresh });
  const undoRecords = useMutation({ mutationFn: (answerId: string) => api.post<{ undone: number; drugKey: string | null }>('/api/notes/timeline/undo', { answerId }), onSuccess: refresh });
  const notes = useMutation({ mutationFn: (b: { key: string; answer: NotesAnswer; reason?: string }) => api.post<{ key: string; words: string; counts: NotesCounts; answerId: string | null }>('/api/notes/reconcile/answer', b), onSuccess: refresh });
  const undoNotes = useMutation({ mutationFn: (key: string) => api.post<{ key: string; words: string; counts: NotesCounts }>('/api/notes/reconcile/undo', { key }), onSuccess: refresh });
  const busy = records.isPending || undoRecords.isPending || notes.isPending || undoNotes.isPending;
  return { records, undoRecords, notes, undoNotes, busy };
}
