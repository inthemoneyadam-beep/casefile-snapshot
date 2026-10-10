/**
 * Typed client for /api/medications (docs/API-CONTRACTS-2.md, Slice G).
 * Query keys all start with 'medications' so one invalidation refreshes the
 * ledger, detail, intolerances, hard stops, timeline, proposals and the card.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { MedicationSettled } from '@shared/notes';

export interface SourceFactCitation {
  citationId: string;
  documentId: string;
  pageNumber: number;
  quote: string;
  verified: boolean;
}

/** The fact a row or event was accepted from, with its first (verified first) citation. */
export interface SourceFactRef {
  id: string;
  type: string;
  statement: string;
  status: string;
  /** The user's basis for their answer (accurate, inferred, unsure, correction), when they gave one. */
  verdictBasis?: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
  deleted: boolean;
  citation: SourceFactCitation | null;
}

export interface Medication {
  id: string;
  name: string;
  genericName: string | null;
  drugClass: string | null;
  dose: string | null;
  unit: string | null;
  route: string | null;
  frequency: string | null;
  status: string;
  startDate: string | null;
  startDatePrecision: string;
  startDateText: string | null;
  stopDate: string | null;
  stopDatePrecision: string;
  stopDateText: string | null;
  prescriberId: string | null;
  indication: string | null;
  reasonStopped: string | null;
  effect: string | null;
  notes: string | null;
  sourceFactId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MedicationRow extends Medication {
  prescriberName: string | null;
  eventCount: number;
  lastEventAt: string | null;
  /** Status of the fact the row was accepted from; null when entered by hand or the fact was deleted. */
  sourceFactStatus: string | null;
  sourceFactBasis?: string | null;
  /**
   * False when the start date is not a recorded start (only the date of the document that mentioned the
   * medication is known). Absent from an older server: the start then counts as recorded.
   */
  startRecorded?: boolean;
  /** The first date a document mentioned the medication, when the start is not recorded. */
  firstSeen?: string | null;
  firstSeenPrecision?: string | null;
  /**
   * The settled timeline of the drug (My notes, 2026-10-09), once the user answered on it in Reconciliation: the start and
   * stop with who said them ("per my notes", or the record). The row's own dates are unchanged.
   */
  settled?: MedicationSettled | null;
}

/**
 * The date the Start column shows and sorts by: the recorded start, or, when the start is not recorded, the
 * first date a document mentioned the medication (shown faint as "seen <date>").
 */
export function startShown(r: Pick<MedicationRow, 'startDate' | 'startDatePrecision' | 'startRecorded' | 'firstSeen' | 'firstSeenPrecision'>): {
  iso: string | null;
  precision: string;
  recorded: boolean;
} {
  if (r.startRecorded === false) {
    if (r.firstSeen) return { iso: r.firstSeen, precision: r.firstSeenPrecision ?? 'day', recorded: false };
    return { iso: r.startDate, precision: r.startDatePrecision, recorded: false };
  }
  return { iso: r.startDate, precision: r.startDatePrecision, recorded: true };
}

export interface MedicationEvent {
  id: string;
  medicationId: string;
  kind: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  detail: string | null;
  dose: string | null;
  sourceFactId: string | null;
  createdAt: string;
  sourceFact: SourceFactRef | null;
}

export interface MedicationDetail extends MedicationRow {
  events: MedicationEvent[];
  sourceFact: SourceFactRef | null;
}

export interface Intolerance {
  id: string;
  substance: string;
  kind: string;
  reaction: string | null;
  severity: string;
  hardStop: boolean;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  notes: string | null;
  sourceFactId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sourceFact: SourceFactRef | null;
}

export interface MedicationInput {
  name: string;
  genericName?: string | null;
  drugClass?: string | null;
  dose?: string | null;
  unit?: string | null;
  route?: string | null;
  frequency?: string | null;
  status?: string;
  startDateText?: string | null;
  stopDateText?: string | null;
  prescriberId?: string | null;
  indication?: string | null;
  reasonStopped?: string | null;
  effect?: string | null;
  notes?: string | null;
  sourceFactId?: string | null;
}
export type MedicationPatch = Partial<MedicationInput> & { startDate?: string | null; stopDate?: string | null };

export interface EventInput {
  kind: string;
  dateText?: string | null;
  detail?: string | null;
  dose?: string | null;
  sourceFactId?: string | null;
}

export interface IntoleranceInput {
  substance: string;
  kind?: string;
  reaction?: string | null;
  severity?: string;
  hardStop?: boolean;
  dateText?: string | null;
  notes?: string | null;
  sourceFactId?: string | null;
  active?: boolean;
}
export type IntolerancePatch = Partial<IntoleranceInput> & { date?: string | null };

export interface MedicationTimelineEvent {
  id: string;
  kind: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  detail: string | null;
  dose: string | null;
  sourceFactId: string | null;
}

export interface MedicationTimelineItem {
  medicationId: string;
  name: string;
  status: string;
  start: string | null;
  startPrecision: string;
  startText: string | null;
  stop: string | null;
  stopPrecision: string;
  stopText: string | null;
  prescriberName: string | null;
  events: MedicationTimelineEvent[];
  /** As on MedicationRow: false when `start` is only the date a document mentioned it. Absent from an older server. */
  startRecorded?: boolean;
  firstSeen?: string | null;
  firstSeenPrecision?: string | null;
  /** Set when start and stop are the settled timeline's (with who said them), not the row's own. */
  settled?: MedicationSettled | null;
}

export interface MedicationProposal {
  factId: string;
  kind: 'medication' | 'intolerance';
  statement: string;
  factStatus: string;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
  citation: SourceFactCitation | null;
  proposed: Record<string, unknown>;
  prescriberText: string | null;
  existing: { id: string; name: string } | null;
  /**
   * Medications only: the name is not one drug (a list heading, or two drugs in one line). Automatic filing never
   * makes it; Add from documents labels it, to add with an edited name. Null or absent otherwise (absent from an
   * older server).
   */
  notMedication?: NotMedicationReason | null;
}

export type NotMedicationReason = 'list heading' | 'two medications in one';

/** The small plain label Add from documents shows on a proposal whose name is not one drug. */
export const NOT_MEDICATION_LABEL: Record<NotMedicationReason, string> = {
  'list heading': 'a list heading, not a medication',
  'two medications in one': 'two medications in one line: edit the name to add one',
};

/** The label for a proposal, or null when its name reads as one drug (or the server sent a reason this client does not know). */
export function notMedicationLabel(p: Pick<MedicationProposal, 'kind' | 'notMedication'>): string | null {
  if (p.kind !== 'medication' || !p.notMedication) return null;
  return NOT_MEDICATION_LABEL[p.notMedication] ?? null;
}

export interface AcceptInput {
  factId: string;
  medicationId?: string | null;
  eventKind?: string;
  overrides?: Record<string, unknown>;
}

export type AcceptResult =
  | { kind: 'medication'; existing: boolean; medication: MedicationDetail }
  | { kind: 'intolerance'; existing: boolean; intolerance: Intolerance }
  | { kind: 'event'; existing: boolean; medication: MedicationDetail; event: MedicationEvent };

export interface EmergencyCardDiagnosis {
  id: string;
  statement: string;
  name: string | null;
  certainty: string | null;
  statedBy: string | null;
  date: string | null;
  datePrecision: string;
  dateText: string | null;
  documentId: string | null;
  documentTitle: string | null;
}

export interface EmergencyCardContact {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionName: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  portal: string | null;
}

export interface EmergencyCard {
  patient: { name: string; dob: string; bloodType: string; emergencyContacts: string; emergencyContactLines: string[]; summary: string };
  hardStops: Intolerance[];
  intolerances: Intolerance[];
  activeMedications: MedicationRow[];
  diagnoses: EmergencyCardDiagnosis[];
  keyContacts: EmergencyCardContact[];
  generatedAt: string;
}

export interface MedicationsListParams {
  status?: string;
  q?: string;
}

export const medKeys = {
  all: ['medications'] as const,
  list: (p: MedicationsListParams) => ['medications', 'list', p] as const,
  detail: (id: string) => ['medications', 'detail', id] as const,
  intolerances: ['medications', 'intolerances'] as const,
  hardStops: ['medications', 'hard-stops'] as const,
  timeline: ['medications', 'timeline'] as const,
  proposals: ['medications', 'proposals'] as const,
  card: ['medications', 'emergency-card'] as const,
};

export function useMedications(p: MedicationsListParams = {}) {
  return useQuery({
    queryKey: medKeys.list(p),
    queryFn: () => api.get<{ items: MedicationRow[]; total: number }>(`/api/medications${api.qs(p as Record<string, string | undefined>)}`),
    placeholderData: (prev) => prev,
  });
}

export function useMedication(id: string | null | undefined) {
  return useQuery({
    queryKey: medKeys.detail(id ?? ''),
    queryFn: () => api.get<MedicationDetail>(`/api/medications/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useIntolerances() {
  return useQuery({
    queryKey: medKeys.intolerances,
    queryFn: () => api.get<{ items: Intolerance[]; total: number }>('/api/medications/intolerances'),
    placeholderData: (prev) => prev,
  });
}

export function useMedicationTimeline(enabled = true) {
  return useQuery({ queryKey: medKeys.timeline, queryFn: () => api.get<{ items: MedicationTimelineItem[] }>('/api/medications/timeline'), enabled });
}

export function useProposals(enabled: boolean) {
  return useQuery({
    queryKey: medKeys.proposals,
    queryFn: () => api.post<{ items: MedicationProposal[]; total: number }>('/api/medications/from-facts'),
    enabled,
    staleTime: 0,
  });
}

export function useEmergencyCard() {
  return useQuery({ queryKey: medKeys.card, queryFn: () => api.get<EmergencyCard>('/api/medications/emergency-card'), staleTime: 0 });
}

export function useMedicationMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: medKeys.all });
    void qc.invalidateQueries({ queryKey: ['today'] });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
  };
  const create = useMutation({ mutationFn: (input: MedicationInput) => api.post<MedicationDetail>('/api/medications', input), onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MedicationPatch }) => api.patch<MedicationDetail>(`/api/medications/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/medications/${encodeURIComponent(id)}`), onSuccess: refresh });
  const addEvent = useMutation({
    mutationFn: ({ medicationId, input }: { medicationId: string; input: EventInput }) => api.post<MedicationEvent>(`/api/medications/${encodeURIComponent(medicationId)}/events`, input),
    onSuccess: refresh,
  });
  const removeEvent = useMutation({ mutationFn: (eventId: string) => api.delete<{ ok: boolean; medicationId: string }>(`/api/medications/events/${encodeURIComponent(eventId)}`), onSuccess: refresh });
  const createIntolerance = useMutation({ mutationFn: (input: IntoleranceInput) => api.post<Intolerance>('/api/medications/intolerances', input), onSuccess: refresh });
  const updateIntolerance = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: IntolerancePatch }) => api.patch<Intolerance>(`/api/medications/intolerances/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const removeIntolerance = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/medications/intolerances/${encodeURIComponent(id)}`), onSuccess: refresh });
  const accept = useMutation({
    mutationFn: (input: AcceptInput) => api.post<AcceptResult>('/api/medications/from-facts/accept', input),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['facts'] });
    },
  });
  return { create, update, remove, addEvent, removeEvent, createIntolerance, updateIntolerance, removeIntolerance, accept };
}

/** Statuses the Current view and the emergency card show. */
export const CURRENT_STATUSES: readonly string[] = ['active', 'prn', 'planned'];

export function isCurrent(status: string): boolean {
  return CURRENT_STATUSES.includes(status);
}
