/**
 * Records inventory API: types mirroring the server rows, query hooks, and
 * mutations that invalidate the right caches.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, listOrEmpty } from './client';
import type { DatePrecision } from '@shared/dates';

export interface RecordRow {
  id: string;
  title: string;
  recordType: string;
  institutionId: string | null;
  institutionName: string | null;
  system: string | null;
  format: string;
  held: boolean;
  heldForm: string | null;
  documentId: string | null;
  documentTitle: string | null;
  status: string;
  recordDate: string | null;
  recordDatePrecision: DatePrecision | string;
  recordDateText: string | null;
  requestedAt: string | null;
  receivedAt: string | null;
  expectedBy: string | null;
  sourceFactId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface GapCitation {
  citationId: string;
  documentId: string;
  documentTitle: string | null;
  pageNumber: number;
  quote: string;
  verified: boolean;
}

export interface Gap {
  kind: 'inventory' | 'inferred';
  id: string;
  title: string;
  recordType: string;
  institution: string | null;
  institutionId: string | null;
  date: string | null;
  datePrecision: DatePrecision | string;
  dateText: string | null;
  status: string;
  sourceFactId: string | null;
  factStatement: string | null;
  factStatus: string | null;
  sourceDocumentId: string | null;
  sourceDocumentTitle: string | null;
  citation?: GapCitation;
  matchedRecordId: string | null;
  likelyHeldDocumentId: string | null;
  likelyHeldDocumentTitle: string | null;
  /** The likely-held document's own date; a date match is only claimed when the gap and the document both have one. */
  likelyHeldDocumentDate?: string | null;
}

export interface RecordInput {
  title: string;
  recordType: string;
  institutionId: string | null;
  system: string | null;
  format: string;
  held: boolean;
  heldForm: string | null;
  documentId: string | null;
  status: string;
  recordDate?: string | null;
  recordDateText: string | null;
  requestedAt: string | null;
  receivedAt: string | null;
  expectedBy: string | null;
  notes: string | null;
}

export interface PersonLite {
  id: string;
  name: string;
  kind: string;
}

export interface DocumentLite {
  id: string;
  title: string;
  kind: string;
  category: string;
  documentDate: string | null;
  documentDatePrecision: string;
}

export const recordKeys = {
  all: ['records'] as const,
  list: ['records', 'list'] as const,
  gaps: ['records', 'gaps'] as const,
  one: (id: string) => ['records', 'one', id] as const,
};

export function useRecords() {
  return useQuery({ queryKey: recordKeys.list, queryFn: () => api.get<{ items: RecordRow[] }>('/api/records'), staleTime: 10_000 });
}

export function useGaps() {
  return useQuery({ queryKey: recordKeys.gaps, queryFn: () => api.get<{ items: Gap[] }>('/api/records/gaps'), staleTime: 10_000 });
}

export function useRecord(id: string | null | undefined) {
  return useQuery({ queryKey: recordKeys.one(id ?? ''), queryFn: () => api.get<RecordRow>(`/api/records/${id}`), enabled: Boolean(id), staleTime: 10_000 });
}

export function useInstitutions() {
  return useQuery({
    queryKey: ['people', 'institutions-for-records'],
    queryFn: async () => {
      const [a, b] = await Promise.all([listOrEmpty<PersonLite>('/api/people?kind=institution'), listOrEmpty<PersonLite>('/api/people?kind=clinic')]);
      const seen = new Set<string>();
      return [...a, ...b].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((x, y) => x.name.localeCompare(y.name));
    },
    staleTime: 60_000,
  });
}

export function useDocumentsLite() {
  return useQuery({
    queryKey: ['documents', 'lite-for-records'],
    queryFn: () => listOrEmpty<DocumentLite>('/api/documents'),
    staleTime: 30_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: recordKeys.all });
    void qc.invalidateQueries({ queryKey: ['today'] });
    void qc.invalidateQueries({ queryKey: ['system', 'info'] });
  };
}

export function useCreateRecord() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (body: Partial<RecordInput>) => api.post<RecordRow>('/api/records', body), onSuccess: inv });
}

export function useUpdateRecord() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<RecordInput> }) => api.patch<RecordRow>(`/api/records/${id}`, body), onSuccess: inv });
}

export function useDeleteRecord() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/records/${id}`), onSuccess: inv });
}

export type Transition = 'request' | 'receive' | 'not-held' | 'denied';

export function useTransition() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind, body }: { id: string; kind: Transition; body?: { requestedAt?: string | null; receivedAt?: string | null; documentId?: string | null; note?: string | null } }) =>
      api.post<RecordRow>(`/api/records/${id}/${kind}`, body ?? {}),
    onSuccess: inv,
  });
}

export function useMaterialize() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (factId: string) => api.post<RecordRow>('/api/records/gaps/materialize', { factId }), onSuccess: inv });
}

export interface FromDocumentPayload {
  documentId: string;
  recordType?: string;
  /** The record_reference fact (inferred gap) this document answers; stored on the row so the gap resolves. */
  sourceFactId?: string;
}

/**
 * `existing`: a live row already linked the document. `factLinked`: the
 * returned row now answers `sourceFactId` (false when that row already answers
 * a different reference).
 */
export type FromDocumentResult = RecordRow & { existing: boolean; factLinked?: boolean };

export function useFromDocument() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ documentId, recordType, sourceFactId }: FromDocumentPayload) => api.post<FromDocumentResult>('/api/records/from-document', { documentId, recordType, sourceFactId }),
    onSuccess: inv,
  });
}
