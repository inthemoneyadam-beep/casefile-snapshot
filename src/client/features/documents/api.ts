/**
 * Document intelligence client (slice Q): the brief, the tier and author
 * fields, and the re-title action. Kept next to the feature so the shared
 * documents API module (slice A) stays untouched; the server returns the
 * extra columns on every document row already.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { JobRow } from '../../api/hooks';
import type { DocumentBrief } from '@shared/schemas/brief';

export type { BriefKeyPoint, BriefLabGroup, BriefLabRow, BriefLabTrend, BriefRowBase, DocumentBrief } from '@shared/schemas/brief';

/** Columns every document row carries since migration 0001 (not yet in the shared Document type). */
export interface DocumentTierFields {
  sourceTier?: string;
  authorRole?: string | null;
  titleSource?: string;
  briefJson?: string | null;
}

export const briefKey = (id: string) => ['document', id, 'brief'] as const;

export function useDocumentBrief(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: briefKey(id ?? ''),
    queryFn: () => api.get<DocumentBrief>(`/api/documents/${encodeURIComponent(id!)}/brief`),
    enabled: Boolean(id) && enabled,
    staleTime: 5_000,
  });
}

export function useRebuildBrief() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DocumentBrief>(`/api/documents/${encodeURIComponent(id)}/brief/rebuild`),
    onSuccess: (data) => qc.setQueryData(briefKey(data.documentId), data),
  });
}

/** Re-run the classification for the title (a model title is replaced; a user title is only offered). */
export function useRetitleDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ job: JobRow }>(`/api/documents/${encodeURIComponent(id)}/retitle`),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['document', id] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export interface ClassifyPendingResult {
  /** Documents a classification was queued for. */
  queued: number;
  /** Unclassified documents already waiting for (or running) a classification. */
  skipped: number;
}

/**
 * Classify every document that never had a classification (uploaded before
 * classification ran for every upload, or while AI was off). Fills only what
 * is still empty; nothing is re-extracted. 409 when AI is off or no key.
 */
export function useClassifyPendingDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ClassifyPendingResult>('/api/documents/classify-pending'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['document'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

/** The toast line for a classify-pending result. */
export function classifyPendingMessage(r: ClassifyPendingResult): string {
  const already = r.skipped ? `${r.skipped} already queued` : '';
  if (!r.queued) return already ? `Nothing new to classify; ${already}` : 'No unclassified documents with page text';
  return `Classification queued for ${r.queued} document${r.queued === 1 ? '' : 's'}${already ? `; ${already}` : ''}`;
}

/** The one-click tier (or author role) override. */
export function useSetDocumentTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sourceTier, authorRole }: { id: string; sourceTier?: string; authorRole?: string | null }) =>
      api.patch<Record<string, unknown>>(`/api/documents/${encodeURIComponent(id)}`, { ...(sourceTier !== undefined ? { sourceTier } : {}), ...(authorRole !== undefined ? { authorRole } : {}) }),
    onSuccess: (_d, { id }) => {
      void qc.invalidateQueries({ queryKey: ['document', id] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['facts'] });
    },
  });
}

/** The model's title proposal stored with the classification, when it differs from the current title. */
export function titleProposalOf(doc: { title: string; metadataJson: string } & DocumentTierFields): string | null {
  try {
    const meta = JSON.parse(doc.metadataJson || '{}') as { triage?: { title?: string } };
    const t = meta.triage?.title?.trim();
    return t && t !== doc.title ? t : null;
  } catch {
    return null;
  }
}
