/**
 * Typed client for /api/imaging. Query keys all start with 'imaging'.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { TrustInfo } from '@shared/reconcile';
import type { VerdictBasis } from './facts';

export interface ImagingEntry {
  /** imaging_studies id, or `fact:<factId>` for an extracted study not imported yet. */
  id: string;
  source: 'row' | 'fact';
  studyId: string | null;
  factId: string | null;
  modality: string;
  bodyPart: string | null;
  title: string;
  performedAt: string | null;
  performedAtPrecision: string;
  performedAtText: string | null;
  institutionId: string | null;
  institutionName: string | null;
  impression: string | null;
  findings: string | null;
  contrast: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationId: string | null;
  citationVerified: boolean | null;
  quote: string | null;
  factStatus: string | null;
  /** With factStatus 'confirmed': checked against the original record, or only a summary. Null otherwise. */
  factBasis: VerdictBasis | null;
  factStatement: string | null;
  /** Imported from a fact that was later deleted in the Facts ledger. */
  factDeleted: boolean;
  /** The automatic trust level of the detail behind the scan (verified, accurate, ...); null for a scan typed by hand. */
  trust: TrustInfo | null;
  hasImages: boolean;
  dicomDocumentIds: string[];
  dicomCount: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImagingDocumentLite {
  id: string;
  title: string;
  kind: string;
  documentDate: string | null;
}

export interface CompareCandidate {
  id: string;
  title: string;
  modality: string;
  performedAt: string | null;
  performedAtPrecision: string;
}

export interface ImagingDetail extends ImagingEntry {
  dicomDocuments: ImagingDocumentLite[];
  compareCandidates: CompareCandidate[];
}

export interface DiffSegment {
  kind: 'same' | 'add' | 'del';
  text: string;
}

export interface DiffStats {
  same: number;
  added: number;
  removed: number;
}

export interface ImagingComparison {
  a: ImagingEntry;
  b: ImagingEntry;
  older: 'a' | 'b';
  impression: DiffSegment[];
  findings: DiffSegment[];
  stats: { impression: DiffStats; findings: DiffStats };
}

export interface ModalityCount {
  modality: string;
  count: number;
}

export interface ImagingListParams {
  modality?: string;
  bodyPart?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface ImagingInput {
  title?: string | null;
  modality?: string;
  bodyPart?: string | null;
  performedAt?: string | null;
  performedAtText?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  impression?: string | null;
  findings?: string | null;
  contrast?: string | null;
  documentId?: string | null;
  factId?: string | null;
  hasImages?: boolean;
  dicomDocumentIds?: string[];
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Organised views: by modality and body part (serial studies together), and
// by document (GET /api/imaging/organised, GET /api/imaging/by-document)
// ---------------------------------------------------------------------------

export interface SerialStudy extends ImagingEntry {
  bodyPartKey: string;
  bodyPartLabel: string;
  /** Position in the series under this header, 1 = earliest; 0 for a study set aside as superseded or whose fact was deleted. */
  serial: number;
  /** The previous study of the same modality and body part, for "compare with previous". */
  previousId: string | null;
  nextId: string | null;
}

export interface ImagingGroup {
  key: string;
  modality: string;
  bodyPartKey: string;
  bodyPart: string;
  count: number;
  /** Chronological, earliest first. */
  studies: SerialStudy[];
}

export interface DocumentImaging {
  /** null for studies entered by hand with no report document. */
  documentId: string | null;
  title: string;
  date: string | null;
  datePrecision: string;
  tier: string | null;
  category: string | null;
  count: number;
  /** Chronological, earliest first. */
  studies: ImagingEntry[];
}

export const imagingKeys = {
  all: ['imaging'] as const,
  list: (p: ImagingListParams) => ['imaging', 'list', p] as const,
  organised: (p: ImagingListParams) => ['imaging', 'organised', p] as const,
  byDocument: (p: ImagingListParams) => ['imaging', 'by-document', p] as const,
  one: (id: string) => ['imaging', 'one', id] as const,
  compare: (id: string, withId: string) => ['imaging', 'compare', id, withId] as const,
};

export function useImagingList(p: ImagingListParams, enabled = true) {
  return useQuery({
    queryKey: imagingKeys.list(p),
    queryFn: () => api.get<{ items: ImagingEntry[]; total: number; modalities: ModalityCount[] }>(`/api/imaging${api.qs(p as Record<string, string | undefined>)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Studies grouped by modality and body part, serial studies chronologically under one header. */
export function useImagingOrganised(p: ImagingListParams, enabled = true) {
  return useQuery({
    queryKey: imagingKeys.organised(p),
    queryFn: () => api.get<{ groups: ImagingGroup[]; total: number; modalities: ModalityCount[] }>(`/api/imaging/organised${api.qs(p as Record<string, string | undefined>)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Studies stacked under the report they came from. */
export function useImagingByDocument(p: ImagingListParams, enabled = true) {
  return useQuery({
    queryKey: imagingKeys.byDocument(p),
    queryFn: () => api.get<{ documents: DocumentImaging[]; total: number; modalities: ModalityCount[] }>(`/api/imaging/by-document${api.qs(p as Record<string, string | undefined>)}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useImaging(id: string | null | undefined) {
  return useQuery({
    queryKey: imagingKeys.one(id ?? ''),
    queryFn: () => api.get<ImagingDetail>(`/api/imaging/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useImagingCompare(id: string | null | undefined, withId: string | null | undefined) {
  return useQuery({
    queryKey: imagingKeys.compare(id ?? '', withId ?? ''),
    queryFn: () => api.get<ImagingComparison>(`/api/imaging/${encodeURIComponent(id!)}/compare${api.qs({ withId })}`),
    enabled: Boolean(id && withId && id !== withId),
  });
}

export function useImagingMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: imagingKeys.all });
    void qc.invalidateQueries({ queryKey: ['facts'] });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
  };
  const create = useMutation({ mutationFn: (input: ImagingInput) => api.post<ImagingDetail>('/api/imaging', input), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: ImagingInput }) => api.patch<ImagingDetail>(`/api/imaging/${encodeURIComponent(id)}`, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/imaging/${encodeURIComponent(id)}`), onSuccess: refresh });
  const fromFacts = useMutation({
    mutationFn: (input: { factIds?: string[] } = {}) => api.post<{ created: number; skipped: number; items: ImagingEntry[] }>('/api/imaging/from-facts', input),
    onSuccess: refresh,
  });
  return { create, update, remove, fromFacts };
}
