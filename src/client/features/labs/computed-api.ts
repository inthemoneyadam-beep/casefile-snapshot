/**
 * Typed client for /api/labs/computed (2026-10-09): the formulas, the printed values each input can take, the preview,
 * computing a value, the ranges the patient types, and his answer to the clinician's proposal. Query keys start with 'labs'
 * so a computed value refreshes every Labs view.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { LabEntry } from '../../api/labs';
import type { FormulaId, Pairing, PrintedBeside, TypedRange } from '@shared/labcompute';

export interface FormulaView {
  id: FormulaId;
  name: string;
  expression: string;
  decimals: number | null;
  analyte: string | null;
  slots: Array<{ id: string; label: string; takes: string | null; anyTest: boolean }>;
}

export interface CandidateView {
  id: string;
  analyte: string;
  specimen: string;
  valueShown: string;
  unit: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  flagShown: string | null;
  lab: string | null;
  problem: string | null;
  conversion: string | null;
}

export interface ComputeTest {
  analyteKey: string;
  specimen: string;
  analyte: string;
  count: number;
}

export interface ComputeRequest {
  formula: FormulaId;
  inputs: Record<string, string>;
  k?: number | null;
  unit?: string | null;
  name?: string | null;
  decimals?: number | null;
}

export interface PreviewInput {
  slot: string;
  slotLabel: string;
  entryId: string | null;
  analyte: string | null;
  valueShown: string | null;
  unit: string | null;
  conversion: string | null;
  date: string | null;
  dateText: string | null;
  dateKind: 'collected' | 'unknown' | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  citationVerified: boolean | null;
  flagShown: string | null;
  problem: string | null;
}

export interface ComputePreview {
  ok: boolean;
  problems: string[];
  notes: string[];
  formula: { id: FormulaId; name: string; expression: string };
  inputs: PreviewInput[];
  pairing: Pick<Pairing, 'window' | 'timesKnown' | 'gapMinutes' | 'gapDays' | 'words'> | null;
  result: { full: number; shown: string; decimals: number; unit: string | null; analyte: string; analyteKey: string; specimen: string; day: string; dayText: string | null } | null;
  label: string | null;
  printedBeside: PrintedBeside[];
}

export type TypedRangeView = TypedRange & { label: string };

export const computedKeys = {
  formulas: ['labs', 'computed', 'formulas'] as const,
  candidates: (formula: string, slot: string, analyteKey?: string, specimen?: string) => ['labs', 'computed', 'candidates', formula, slot, analyteKey ?? '', specimen ?? ''] as const,
  tests: ['labs', 'computed', 'tests'] as const,
  preview: (r: ComputeRequest | null) => ['labs', 'computed', 'preview', r] as const,
  ranges: ['labs', 'computed', 'ranges'] as const,
};

export function useComputeFormulas(enabled = true) {
  return useQuery({ queryKey: computedKeys.formulas, queryFn: async () => (await api.get<{ items: FormulaView[] }>('/api/labs/computed/formulas')).items, enabled, staleTime: 60 * 60_000 });
}

export function useComputeCandidates(formula: FormulaId | null, slot: string | null, opts: { analyteKey?: string; specimen?: string; enabled?: boolean } = {}) {
  const anyTest = formula === 'ratio';
  return useQuery({
    queryKey: computedKeys.candidates(formula ?? '', slot ?? '', opts.analyteKey, opts.specimen),
    queryFn: async () => (await api.get<{ items: CandidateView[] }>(`/api/labs/computed/candidates${api.qs({ formula, slot, analyteKey: opts.analyteKey, specimen: opts.specimen })}`)).items,
    enabled: (opts.enabled ?? true) && Boolean(formula && slot) && (!anyTest || Boolean(opts.analyteKey)),
  });
}

export function useComputeTests(enabled = true) {
  return useQuery({ queryKey: computedKeys.tests, queryFn: async () => (await api.get<{ items: ComputeTest[] }>('/api/labs/computed/tests')).items, enabled });
}

/** The server's preview of a request (nothing is written); null while the request is not complete enough to ask. */
export function useComputePreview(req: ComputeRequest | null) {
  return useQuery({
    queryKey: computedKeys.preview(req),
    queryFn: () => api.post<ComputePreview>('/api/labs/computed/preview', req),
    enabled: Boolean(req),
    placeholderData: (prev) => prev,
  });
}

export function useTypedRanges() {
  return useQuery({ queryKey: computedKeys.ranges, queryFn: async () => (await api.get<{ items: Record<string, TypedRangeView> }>('/api/labs/computed/ranges')).items, staleTime: 30_000 });
}

export function useComputeMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['labs'] });
    void qc.invalidateQueries({ queryKey: ['findings'] });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
  };
  const create = useMutation({ mutationFn: (req: ComputeRequest) => api.post<LabEntry>('/api/labs/computed', req), onSuccess: refresh });
  const setRange = useMutation({
    mutationFn: ({ analyteKey, low, high }: { analyteKey: string; low: number | null; high: number | null }) => api.put<{ items: Record<string, TypedRangeView> }>(`/api/labs/computed/ranges/${encodeURIComponent(analyteKey)}`, { low, high }),
    onSuccess: refresh,
  });
  const clearRange = useMutation({ mutationFn: (analyteKey: string) => api.delete<{ items: Record<string, TypedRangeView> }>(`/api/labs/computed/ranges/${encodeURIComponent(analyteKey)}`), onSuccess: refresh });
  return { create, setRange, clearRange };
}

/** "Yes, compute it" / "Not now" on the clinician's proposal (always the user's own yes). */
export function useComputeProposalActions() {
  const qc = useQueryClient();
  const refresh = () => {
    for (const key of [['filing'], ['labs'], ['findings']]) void qc.invalidateQueries({ queryKey: key });
  };
  const approve = useMutation({ mutationFn: (filingId: string) => api.post<{ entry: LabEntry }>(`/api/labs/computed/proposals/${encodeURIComponent(filingId)}/approve`, {}), onSettled: refresh });
  const decline = useMutation({ mutationFn: (filingId: string) => api.post<unknown>(`/api/labs/computed/proposals/${encodeURIComponent(filingId)}/decline`, {}), onSettled: refresh });
  return { approve, decline };
}
