/**
 * The wrong-patient guard (2026-10-09; server: routes/patient-check.ts): the documents held back as "May be someone
 * else's record", the user's two answers, "Add this record number to my list", and checking every document again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { DocumentDetail } from './documents';
import { patientCheckOf, type PatientCheck, type RecordNumber } from '@shared/patient-identity';

export type { PatientCheck };

export interface HeldItem {
  id: string;
  title: string;
  filename: string;
  category: string;
  pageCount: number;
  documentDate: string | null;
  documentDatePrecision: string;
  documentDateText: string | null;
  createdAt: string;
  heldAt: string | null;
  /** "p.212-219 look like someone else's: another first name." */
  words: string;
  check: PatientCheck;
}

export interface PatientCheckSummary {
  held: number;
  /** Found by a check of the whole case, not held because they were most of it (Patient details may be wrong). */
  unheld: number;
  missing: Array<'name' | 'dob'>;
}

export interface MineResult {
  ok: true;
  document: DocumentDetail;
  carriedOn: 'sorting' | 'reading' | null;
  newNumbers: Array<{ number: string; page: number }>;
  system: string | null;
}

export interface SweepResult {
  checked: number;
  held: number;
  unheld: number;
  missing: Array<'name' | 'dob'>;
}

export const patientKeys = { all: ['patient-check'] as const };

export function usePatientCheck() {
  return useQuery({
    queryKey: patientKeys.all,
    queryFn: () => api.get<{ summary: PatientCheckSummary; items: HeldItem[] }>('/api/patient-check'),
    refetchInterval: 30_000,
  });
}

/** The guard's record on a document row (from its metadata), or null. */
export function checkOfDocument(d: { metadataJson?: string | null } | null | undefined): PatientCheck | null {
  return d ? patientCheckOf(d.metadataJson) : null;
}

/** True while the document is held back as "May be someone else's record". */
export function isHeldDocument(d: { metadataJson?: string | null; deletedAt?: string | null } | null | undefined): boolean {
  return Boolean(d?.deletedAt) && checkOfDocument(d)?.state === 'quarantined';
}

function useRefreshAfterAnswer() {
  const qc = useQueryClient();
  return (id: string) => {
    void qc.invalidateQueries({ queryKey: patientKeys.all });
    void qc.invalidateQueries({ queryKey: ['document', id] });
    void qc.invalidateQueries({ queryKey: ['documents'] });
    void qc.invalidateQueries({ queryKey: ['documents-trash'] });
    void qc.invalidateQueries({ queryKey: ['filing'] });
    void qc.invalidateQueries({ queryKey: ['facts'] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    // What Claude had filed from it is taken back (or filed again after It's mine).
    void qc.invalidateQueries({ queryKey: ['medications'] });
    void qc.invalidateQueries({ queryKey: ['encounters'] });
    void qc.invalidateQueries({ queryKey: ['communications'] });
  };
}

/** "It's mine": it comes back with its details, is trusted from now on, and what the upload was doing carries on. */
export function useMarkMine() {
  const refresh = useRefreshAfterAnswer();
  return useMutation({
    mutationFn: (id: string) => api.post<MineResult>(`/api/patient-check/${id}/mine`, {}),
    onSettled: (_d, _e, id) => refresh(id),
  });
}

/** "Not my record": to Deleted documents with the reason "wrong patient"; Restore brings it back held. */
export function useMarkNotMine() {
  const refresh = useRefreshAfterAnswer();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true; kept: number }>(`/api/patient-check/${id}/not-mine`, {}),
    onSuccess: (_d, id) => qc.removeQueries({ queryKey: ['document', id] }),
    onSettled: (_d, _e, id) => refresh(id),
  });
}

/** "Add this record number to my list" (Patient details). */
export function useAddRecordNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordNumber) => api.post<{ items: RecordNumber[] }>('/api/patient-check/record-numbers', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

/** Check every document against Patient details now (after they change). */
export function useCheckAgain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SweepResult>('/api/patient-check/scan', {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: patientKeys.all });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['filing'] });
    },
  });
}

/** Hold back what a check of the whole case left (they were most of it). */
export function useHoldUnheld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ held: number }>('/api/patient-check/hold-unheld', {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: patientKeys.all });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['filing'] });
    },
  });
}
