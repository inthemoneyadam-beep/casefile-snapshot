/**
 * People API: types mirror the server's PersonListRow and the activity payload
 * (docs/API-CONTRACTS.md, Slice C). Query keys all start with 'people' so one
 * invalidation refreshes lists, detail, activity and suggestions.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { Communication } from './communications';
import type { MergePeopleInput, MergeResult, MergeSuggestion } from '@shared/schemas/segments';

export interface Person {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionId: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  portal: string | null;
  address: string | null;
  preferredChannel: string | null;
  notes: string | null;
  aliasesJson: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PersonRow extends Person {
  aliases: string[];
  institutionName: string | null;
  communicationCount: number;
  lastContactAt: string | null;
  /** Median whole days from an outbound contact to the next inbound reply; null with fewer than two pairs. */
  medianResponseDays: number | null;
}

export interface PersonInput {
  name: string;
  kind: string;
  role?: string | null;
  specialty?: string | null;
  institutionId?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  portal?: string | null;
  address?: string | null;
  preferredChannel?: string | null;
  notes?: string | null;
  aliases?: string[];
}

export interface PersonTopic {
  topic: string;
  count: number;
  last: string | null;
  openFollowUps: number;
}

/** Subset of a document row that the person view shows. */
export interface DocumentLite {
  id: string;
  title: string;
  category: string;
  kind: string;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  pageCount: number;
  textStatus: string;
  extractionStatus: string;
  authorPersonId: string | null;
  institutionId: string | null;
}

/** Subset of a fact row that the person view shows. */
export interface FactLite {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  status: string;
  /** The user's check beside the status: 'original' | 'summary' (with confirmed), 'unsure' (with unverified). */
  verdictBasis?: 'original' | 'summary' | 'unsure' | null;
  sourceDocumentId: string | null;
  documentTitle: string | null;
}

export interface PersonActivity {
  communications: Communication[];
  topics: PersonTopic[];
  documents: DocumentLite[];
  facts: FactLite[];
}

/** An extracted fact that named a suggested person, with its source document. */
export interface SuggestionSource {
  factId: string;
  type: string;
  statement: string;
  documentId: string | null;
  documentTitle: string | null;
}

/** A name the extractor mentioned that is not a person yet. Unverified until the user checks its sources. */
export interface PersonSuggestion {
  name: string;
  count: number;
  factIds: string[];
  factTypes: string[];
  /** The facts behind `factIds` (up to 8). */
  sources: SuggestionSource[];
}

export interface PeopleFilters {
  q?: string;
  kind?: string;
  institutionId?: string;
}

export const peopleKeys = {
  all: ['people'] as const,
  list: (f: PeopleFilters) => ['people', 'list', f] as const,
  one: (id: string) => ['people', 'one', id] as const,
  activity: (id: string) => ['people', 'activity', id] as const,
  suggestions: ['people', 'suggestions'] as const,
};

export function usePeople(filters: PeopleFilters = {}) {
  return useQuery({
    queryKey: peopleKeys.list(filters),
    queryFn: () => api.get<{ items: PersonRow[]; total: number }>(`/api/people${api.qs({ ...filters })}`),
    placeholderData: keepPreviousData,
  });
}

export function usePerson(id: string | null | undefined) {
  return useQuery({
    queryKey: peopleKeys.one(id ?? ''),
    queryFn: () => api.get<PersonRow>(`/api/people/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function usePersonActivity(id: string | null | undefined) {
  return useQuery({
    queryKey: peopleKeys.activity(id ?? ''),
    queryFn: () => api.get<PersonActivity>(`/api/people/${encodeURIComponent(id!)}/activity`),
    enabled: Boolean(id),
  });
}

export function usePersonSuggestions(enabled: boolean) {
  return useQuery({
    queryKey: peopleKeys.suggestions,
    queryFn: () => api.get<{ items: PersonSuggestion[]; total: number }>('/api/people/suggestions'),
    enabled,
    staleTime: 0,
  });
}

export function usePeopleMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: peopleKeys.all });
    void qc.invalidateQueries({ queryKey: ['communications'] });
  };
  const create = useMutation({ mutationFn: (input: PersonInput) => api.post<PersonRow>('/api/people', input), onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PersonInput> }) => api.patch<PersonRow>(`/api/people/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/people/${encodeURIComponent(id)}`), onSuccess: refresh });
  const accept = useMutation({
    // factIds: the facts that named the person; the server records them in the new row's notes as its origin.
    mutationFn: (input: { name: string; kind: string; role?: string | null; factIds?: string[] }) => api.post<PersonRow>('/api/people/suggestions/accept', input),
    onSuccess: refresh,
  });
  return { create, update, remove, accept };
}

// ---------------------------------------------------------------------------
// People who may be listed twice (2026-10-07): suggestions computed on read, merged only by the user, with Undo
// ---------------------------------------------------------------------------

export type { MergeResult, MergeSuggestion };

/** A route the server does not have yet reads as null, never as an error. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501 || err.status === 405)) return null;
    throw err;
  }
}

export const mergeKeys = {
  suggestions: (personId?: string | null) => ['people', 'merge-suggestions', personId ?? ''] as const,
};

/** GET /api/people/merge-suggestions (optionally for one person): never merged on their own. */
export function useMergeSuggestions(personId?: string | null, enabled = true) {
  return useQuery({
    queryKey: mergeKeys.suggestions(personId),
    queryFn: async () => (await orNull(api.get<{ items: MergeSuggestion[] }>(`/api/people/merge-suggestions${api.qs({ personId: personId ?? undefined })}`)))?.items ?? [],
    enabled,
    staleTime: 10_000,
  });
}

export function useMergeMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: peopleKeys.all });
    void qc.invalidateQueries({ queryKey: ['communications'] });
    void qc.invalidateQueries({ queryKey: ['filing'] });
    void qc.invalidateQueries({ queryKey: ['facts'] });
  };
  const merge = useMutation({ mutationFn: (input: MergePeopleInput) => api.post<MergeResult>('/api/people/merge', input), onSuccess: refresh });
  const undo = useMutation({ mutationFn: (filingId: string) => api.post<MergeResult>(`/api/people/merge/${encodeURIComponent(filingId)}/undo`), onSuccess: refresh });
  const decline = useMutation({ mutationFn: (suggestionId: string) => api.post<{ ok: true }>(`/api/people/merge-suggestions/${encodeURIComponent(suggestionId)}/decline`), onSuccess: refresh });
  return { merge, undo, decline };
}

/** What a merge did, in words: "Merged 1 into Dr. A. Example: 12 calls and messages, 3 details moved over." */
export function mergeWords(r: MergeResult, keepName: string): string {
  const n = r.mergedIds.length;
  const moved = Object.values(r.repointed).reduce((a, b) => a + b, 0);
  return `Merged ${n === 1 ? 'one entry' : `${n} entries`} into ${keepName}${moved ? `; ${moved} link${moved === 1 ? '' : 's'} moved over` : ''}. Undo puts everything back.`;
}
