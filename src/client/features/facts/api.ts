/**
 * Facts client for slice Q: the voice fields every fact row carries since
 * migration 0001 (assertedBy, objectivity, the patient-precedence override)
 * and the override endpoints. Kept next to the feature so the shared facts
 * API module (slice B) stays untouched.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { factKeys, type Fact, type FactDetail, type FactListItem, type FactWithDoc } from '../../api/facts';

export interface FactVoiceFields {
  /** patient | clinician | compiler | unknown */
  assertedBy: string;
  /** objective | subjective | unknown (stored) */
  objectivity: string;
  overriddenByFactId: string | null;
  overrideReason: string | null;
}

export type FactRowX = FactListItem & FactVoiceFields & { documentTier: string | null };
export type FactDetailX = FactDetail &
  FactVoiceFields & {
    document: { id: string; title: string; sourceTier?: string } | null;
    overriddenBy: (FactWithDoc & Partial<FactVoiceFields>) | null;
    overrides: Array<FactWithDoc & Partial<FactVoiceFields>>;
    effectiveObjectivity: 'objective' | 'subjective';
  };


export function asRowX(f: FactListItem): FactRowX {
  const x = f as Partial<FactVoiceFields> & FactListItem & { documentTier?: string | null };
  return { ...f, assertedBy: x.assertedBy ?? 'unknown', objectivity: x.objectivity ?? 'unknown', overriddenByFactId: x.overriddenByFactId ?? null, overrideReason: x.overrideReason ?? null, documentTier: x.documentTier ?? null };
}

export function asDetailX(f: FactDetail): FactDetailX {
  const x = f as Partial<FactDetailX> & FactDetail;
  return {
    ...f,
    assertedBy: x.assertedBy ?? 'unknown',
    objectivity: x.objectivity ?? 'unknown',
    overriddenByFactId: x.overriddenByFactId ?? null,
    overrideReason: x.overrideReason ?? null,
    overriddenBy: x.overriddenBy ?? null,
    overrides: x.overrides ?? [],
    effectiveObjectivity: x.effectiveObjectivity ?? 'subjective',
  };
}

export type FactLite = Fact & Partial<FactVoiceFields>;

/** The patient statements on the same subject as this fact (the picker's list). */
export function useOverrideCandidates(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['facts', 'override-candidates', id ?? ''],
    queryFn: () => api.get<{ items: Array<FactWithDoc & Partial<FactVoiceFields>> }>(`/api/facts/${encodeURIComponent(id!)}/override/candidates`),
    enabled: Boolean(id) && enabled,
    staleTime: 5_000,
  });
}

export function useOverrideMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: factKeys.all });
    void qc.invalidateQueries({ queryKey: ['document'] });
    void qc.invalidateQueries({ queryKey: ['findings'] });
  };
  const set = useMutation({
    mutationFn: ({ id, byFactId, reason }: { id: string; byFactId: string; reason?: string | null }) => api.post<FactDetailX>(`/api/facts/${encodeURIComponent(id)}/override`, { byFactId, reason: reason ?? null }),
    onSuccess: refresh,
  });
  const clear = useMutation({
    mutationFn: (id: string) => api.post<FactDetailX>(`/api/facts/${encodeURIComponent(id)}/override`, { byFactId: null }),
    onSuccess: refresh,
  });
  const newStatement = useMutation({
    mutationFn: ({ id, statement, dateText, reason }: { id: string; statement: string; dateText?: string | null; reason?: string | null }) =>
      api.post<FactDetailX>(`/api/facts/${encodeURIComponent(id)}/override`, { statement, dateText: dateText ?? null, reason: reason ?? null }),
    onSuccess: refresh,
  });
  const runPrecedence = useMutation({
    mutationFn: (documentId?: string) => api.post<{ runId: string; decisions: unknown[]; overridden: number; findings: { created: number; updated: number; unchanged: number } }>('/api/facts/precedence/run', documentId ? { documentId } : {}),
    onSuccess: refresh,
  });
  return { set, clear, newStatement, runPrecedence };
}
