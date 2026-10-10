/**
 * Communications API: types mirror the server's CommWithParticipants and the
 * matrix cell (docs/API-CONTRACTS.md, Slice C). Query keys start with
 * 'communications'.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { parseCommunicationDetails, type CommunicationDetails, type MessageView, type ThreadListItem, type ThreadView } from '@shared/schemas/segments';

export type { CommunicationDetails, MessageView, ThreadListItem, ThreadView };

export interface Participant {
  personId: string;
  name: string;
  kind: string;
  role: string; // from | to | cc | present
}

export interface Communication {
  id: string;
  occurredAt: string | null;
  occurredAtPrecision: string;
  occurredAtText: string | null;
  direction: string;
  channel: string;
  subject: string;
  summary: string | null;
  outcome: string | null;
  followUpPromised: string | null;
  followUpDue: string | null;
  followUpDoneAt: string | null;
  followUpOwnerPersonId: string | null;
  documentId: string | null;
  encounterId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  participants: Participant[];
  topics: string[];
  documentTitle: string | null;
  encounterTitle: string | null;
  followUpOwnerName: string | null;
  overdue: boolean;
  /** Read out of a record (2026-10-07): the message as printed, verbatim; null on rows logged by hand. */
  body?: string | null;
  /** The conversation it belongs to (messages read out of records). */
  threadKey?: string | null;
  /** HH:MM when the record prints a time. */
  occurredTime?: string | null;
  /** CommunicationDetails as JSON ('{}' on rows logged by hand). */
  detailsJson?: string | null;
}

/** The details of a communication (kind, whose words, pages, read receipts, copies), never throwing. */
export function detailsOf(c: Pick<Communication, 'detailsJson'> | null | undefined): CommunicationDetails {
  return parseCommunicationDetails(c?.detailsJson ?? null);
}

/**
 * True when the row was read word for word out of a record (a chart print's messages, notes and letters), as the
 * server's threads say (`fromRecords`). Rows you logged, imported, or that Claude logged from a document you filed
 * (a call transcript) are not.
 */
export function isFromRecords(c: Pick<Communication, 'detailsJson'> | null | undefined): boolean {
  return detailsOf(c).origin === 'extracted';
}

export interface CommunicationInput {
  occurredAtText?: string | null;
  direction: string;
  channel: string;
  subject: string;
  summary?: string | null;
  outcome?: string | null;
  followUpPromised?: string | null;
  followUpDueText?: string | null;
  followUpOwnerPersonId?: string | null;
  documentId?: string | null;
  encounterId?: string | null;
  participants: Array<{ personId: string; role: string }>;
  topics: string[];
}

export interface MatrixCell {
  personId: string;
  name: string;
  topic: string; // '' when the communication had no topic
  count: number;
  lastAt: string | null;
  openFollowUps: number;
}

/** Per-person rollup over distinct communications (a multi-topic one counts once). */
export interface MatrixPersonTotal {
  personId: string;
  name: string;
  count: number;
  lastAt: string | null;
  openFollowUps: number;
}

/** Per-topic rollup over distinct communications (a multi-participant one counts once). */
export interface MatrixTopicTotal {
  topic: string; // '' when the communication had no topic
  count: number;
}

export interface MatrixData {
  items: MatrixCell[];
  people: MatrixPersonTotal[];
  topics: MatrixTopicTotal[];
}

export interface CommunicationFilters {
  personId?: string;
  topic?: string;
  channel?: string;
  direction?: string;
  q?: string;
  openFollowUps?: boolean;
  documentId?: string;
}

export const communicationKeys = {
  all: ['communications'] as const,
  list: (f: CommunicationFilters) => ['communications', 'list', f] as const,
  one: (id: string) => ['communications', 'one', id] as const,
  matrix: ['communications', 'matrix'] as const,
  followUps: (includeDone: boolean) => ['communications', 'follow-ups', includeDone] as const,
  topics: ['communications', 'topics'] as const,
  threads: (f: ThreadFilters) => ['communications', 'threads', f] as const,
  thread: (key: string) => ['communications', 'thread', key] as const,
  message: (id: string) => ['communications', 'message', id] as const,
};

export interface ThreadFilters {
  personId?: string;
  documentId?: string;
  /** true: only threads read out of records; false: only ones logged by hand. */
  fromRecords?: boolean;
  q?: string;
}

/** A route the server does not have yet (the communications side lands it) reads as null, never as an error. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501 || err.status === 405)) return null;
    throw err;
  }
}

/** GET /api/communications/threads: the conversations, newest activity first ([] when the route is not there). */
export function useThreads(filters: ThreadFilters = {}, enabled = true) {
  return useQuery({
    queryKey: communicationKeys.threads(filters),
    queryFn: async () => (await orNull(api.get<{ items: ThreadListItem[] }>(`/api/communications/threads${api.qs({ ...filters, fromRecords: filters.fromRecords === undefined ? undefined : filters.fromRecords ? 1 : 0 })}`)))?.items ?? [],
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** GET /api/communications/threads/:key (null when the route or the thread is not there). */
export function useThread(key: string | null | undefined) {
  return useQuery({
    queryKey: communicationKeys.thread(key ?? ''),
    queryFn: () => orNull(api.get<ThreadView>(`/api/communications/threads/${encodeURIComponent(key!)}`)),
    enabled: Boolean(key),
    retry: false,
  });
}

/** GET /api/communications/:id/message: the message detail (null when the route is not there). */
export function useMessage(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: communicationKeys.message(id ?? ''),
    queryFn: () => orNull(api.get<MessageView>(`/api/communications/${encodeURIComponent(id!)}/message`)),
    enabled: Boolean(id) && enabled,
    retry: false,
  });
}

export function useCommunications(filters: CommunicationFilters = {}) {
  return useQuery({
    queryKey: communicationKeys.list(filters),
    queryFn: () => api.get<{ items: Communication[]; total: number }>(`/api/communications${api.qs({ ...filters, openFollowUps: filters.openFollowUps ? 1 : undefined })}`),
    placeholderData: keepPreviousData,
  });
}

export function useCommunication(id: string | null | undefined) {
  return useQuery({
    queryKey: communicationKeys.one(id ?? ''),
    queryFn: () => api.get<Communication>(`/api/communications/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useMatrix(enabled = true) {
  return useQuery({ queryKey: communicationKeys.matrix, queryFn: () => api.get<MatrixData>('/api/communications/matrix'), enabled });
}

export function useFollowUps(includeDone: boolean, enabled = true) {
  return useQuery({
    queryKey: communicationKeys.followUps(includeDone),
    queryFn: () => api.get<{ items: Communication[] }>(`/api/communications/follow-ups${api.qs({ includeDone: includeDone ? 1 : undefined })}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTopics() {
  return useQuery({ queryKey: communicationKeys.topics, queryFn: () => api.get<{ items: Array<{ topic: string; count: number }> }>('/api/communications/topics'), staleTime: 30_000 });
}

export function useCommunicationMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: communicationKeys.all });
    void qc.invalidateQueries({ queryKey: ['people'] });
    void qc.invalidateQueries({ queryKey: ['today'] });
  };
  const create = useMutation({ mutationFn: (input: CommunicationInput) => api.post<Communication>('/api/communications', input), onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CommunicationInput> }) => api.patch<Communication>(`/api/communications/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/communications/${encodeURIComponent(id)}`), onSuccess: refresh });
  const done = useMutation({ mutationFn: (id: string) => api.post<Communication>(`/api/communications/${encodeURIComponent(id)}/follow-up/done`), onSuccess: refresh });
  const reopen = useMutation({ mutationFn: (id: string) => api.post<Communication>(`/api/communications/${encodeURIComponent(id)}/follow-up/reopen`), onSuccess: refresh });
  return { create, update, remove, done, reopen };
}
