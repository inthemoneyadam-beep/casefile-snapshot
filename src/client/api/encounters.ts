/**
 * Encounters API: types mirror the server's EncounterListItem, EncounterDetail
 * and EncounterPrep (docs/API-CONTRACTS-2.md, Slice J). Query keys start
 * with 'encounters'.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Communication } from './communications';
import type { Gap } from './records';
import type { PlanHardStop, PlanMedication, Task } from './tasks';

export interface EncounterQuestion {
  text: string;
  asked: boolean;
  answer: string | null;
}

export interface Encounter {
  id: string;
  title: string;
  kind: string;
  status: string; // upcoming | completed | cancelled
  occurredAt: string | null;
  occurredAtPrecision: string;
  occurredAtText: string | null;
  timeText: string | null;
  clinicianId: string | null;
  institutionId: string | null;
  location: string | null;
  prepNotes: string | null;
  questionsJson: string;
  outcomes: string | null;
  documentIdsJson: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  clinicianName: string | null;
  clinicianSpecialty: string | null;
  institutionName: string | null;
  questions: EncounterQuestion[];
  documentIds: string[];
  questionCount: number;
  askedCount: number;
  documentCount: number;
  communicationCount: number;
}

export interface EncounterDocument {
  id: string;
  title: string;
  category: string;
  documentDate: string | null;
  documentDatePrecision: string;
}

export interface EncounterDetail extends Encounter {
  documents: EncounterDocument[];
  communications: Communication[];
  tasks: Task[];
}

export interface PrepFact {
  id: string;
  type: string;
  statement: string;
  date: string | null;
  datePrecision: string;
  status: string;
  sourceDocumentId: string | null;
  documentTitle: string | null;
}

export interface PrepClinician {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  specialty: string | null;
  institutionId: string | null;
  phone: string | null;
  email: string | null;
  portal: string | null;
  preferredChannel: string | null;
  institutionName: string | null;
}

export interface EncounterPrep {
  encounter: EncounterDetail;
  clinician: PrepClinician | null;
  lastContacts: Communication[];
  openFollowUps: Communication[];
  recentFacts: PrepFact[];
  recentSince: string;
  activeMedications: PlanMedication[];
  hardStops: PlanHardStop[];
  openTasksForOwner: Task[];
  encounterTasks: Task[];
  gaps: Gap[];
  briefingPrompt: string;
}

export interface EncounterInput {
  title: string;
  kind?: string;
  status?: string;
  occurredAtText?: string | null;
  timeText?: string | null;
  clinicianId?: string | null;
  institutionId?: string | null;
  location?: string | null;
  prepNotes?: string | null;
  questions?: Array<string | EncounterQuestion>;
  outcomes?: string | null;
  documentIds?: string[];
}

export interface EncounterFilters {
  status?: string;
  from?: string;
  to?: string;
  clinicianId?: string;
  institutionId?: string;
  q?: string;
}

export const encounterKeys = {
  all: ['encounters'] as const,
  list: (f: EncounterFilters) => ['encounters', 'list', f] as const,
  one: (id: string) => ['encounters', 'one', id] as const,
  prep: (id: string) => ['encounters', 'prep', id] as const,
};

export function useEncounters(filters: EncounterFilters = {}) {
  return useQuery({
    queryKey: encounterKeys.list(filters),
    queryFn: () => api.get<{ items: Encounter[]; total: number }>(`/api/encounters${api.qs({ ...filters })}`),
    placeholderData: keepPreviousData,
  });
}

export function useEncounter(id: string | null | undefined) {
  return useQuery({
    queryKey: encounterKeys.one(id ?? ''),
    queryFn: () => api.get<EncounterDetail>(`/api/encounters/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useEncounterPrep(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: encounterKeys.prep(id ?? ''),
    queryFn: () => api.get<EncounterPrep>(`/api/encounters/${encodeURIComponent(id!)}/prep`),
    enabled: Boolean(id) && enabled,
    staleTime: 15_000,
  });
}

export function fetchEncounterPrep(id: string): Promise<EncounterPrep> {
  return api.get<EncounterPrep>(`/api/encounters/${encodeURIComponent(id)}/prep`);
}

export function useEncounterMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: encounterKeys.all });
    void qc.invalidateQueries({ queryKey: ['today'] });
    void qc.invalidateQueries({ queryKey: ['tasks', 'daily-plan'] });
  };
  const create = useMutation({ mutationFn: (input: EncounterInput) => api.post<EncounterDetail>('/api/encounters', input), onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<EncounterInput> }) => api.patch<EncounterDetail>(`/api/encounters/${encodeURIComponent(id)}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/encounters/${encodeURIComponent(id)}`), onSuccess: refresh });
  const complete = useMutation({
    mutationFn: ({ id, outcomes }: { id: string; outcomes?: string | null }) => api.post<EncounterDetail>(`/api/encounters/${encodeURIComponent(id)}/complete`, outcomes === undefined ? {} : { outcomes }),
    onSuccess: refresh,
  });
  return { create, update, remove, complete };
}
