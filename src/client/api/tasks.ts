/**
 * Tasks API: types mirror the server's TaskListItem and DailyPlan
 * (docs/API-CONTRACTS-2.md, Slice J). Query keys start with 'tasks'.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Task {
  id: string;
  title: string;
  detail: string | null;
  owner: string; // me | chief_of_staff | advocate | person
  ownerPersonId: string | null;
  dueAt: string | null; // YYYY-MM-DD (or a partial YYYY-MM / YYYY)
  remindAt: string | null; // YYYY-MM-DD or YYYY-MM-DDTHH:MM
  status: string; // open | in_progress | done | cancelled
  priority: string; // low | normal | high | urgent
  sourceType: string;
  sourceId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  ownerName: string | null;
  sourceTitle: string | null;
  sourceHref: string | null;
  overdue: boolean;
}

export interface TaskInput {
  title: string;
  detail?: string | null;
  owner?: string;
  ownerPersonId?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  status?: string;
  priority?: string;
  sourceType?: string;
  sourceId?: string | null;
}

export interface TaskFilters {
  status?: string; // comma list, or active | closed
  owner?: string;
  ownerPersonId?: string;
  due?: 'overdue' | 'today' | 'week' | 'all';
  sourceType?: string;
  sourceId?: string;
  q?: string;
}

export interface TaskCounts {
  active: number;
  closed: number;
  all: number;
  overdue: number;
  today: number;
  week: number;
}

export interface GeneratedTasks {
  created: Task[];
  existing: number;
  total: number;
}

export interface PlanEncounter {
  id: string;
  title: string;
  kind: string;
  status: string;
  occurredAt: string | null;
  occurredAtPrecision: string;
  timeText: string | null;
  location: string | null;
  clinicianName: string | null;
  institutionName: string | null;
  prepNotes: string | null;
  questions: string[];
}

export interface PlanMedication {
  id: string;
  name: string;
  dose: string | null;
  unit: string | null;
  route: string | null;
  frequency: string | null;
  status: string;
  indication: string | null;
  prescriberName: string | null;
}

export interface PlanHardStop {
  id: string;
  substance: string;
  kind: string;
  reaction: string | null;
  severity: string;
}

export interface PlanFollowUp {
  id: string;
  subject: string;
  followUpPromised: string | null;
  followUpDue: string | null;
  withWhom: string;
  overdue: boolean;
}

export interface PlanSymptom {
  id: string;
  name: string;
  logged: boolean;
  score: number | null;
}

export interface DailyPlan {
  date: string;
  tasksDue: Task[];
  overdue: Task[];
  tasksSoon: Task[];
  encounters: PlanEncounter[];
  encountersSoon: PlanEncounter[];
  followUpsDue: PlanFollowUp[];
  medicationsActive: PlanMedication[];
  hardStops: PlanHardStop[];
  symptomsToLog: PlanSymptom[];
  notes: string | null;
  patientName: string | null;
  generatedAt: string;
}

export const OWNER_LABELS: Record<string, string> = { me: 'me', chief_of_staff: 'chief of staff', advocate: 'advocate', person: 'person' };

export function ownerLabel(t: Pick<Task, 'owner' | 'ownerName'>): string {
  if (t.owner === 'person') return t.ownerName ?? 'person';
  return t.ownerName ? `${OWNER_LABELS[t.owner] ?? t.owner} · ${t.ownerName}` : (OWNER_LABELS[t.owner] ?? t.owner);
}

export const taskKeys = {
  all: ['tasks'] as const,
  list: (f: TaskFilters) => ['tasks', 'list', f] as const,
  one: (id: string) => ['tasks', 'one', id] as const,
  counts: ['tasks', 'counts'] as const,
  plan: (date: string | undefined) => ['tasks', 'daily-plan', date ?? 'today'] as const,
};

export function useTasks(filters: TaskFilters = {}) {
  return useQuery({
    queryKey: taskKeys.list(filters),
    queryFn: () => api.get<{ items: Task[]; total: number }>(`/api/tasks${api.qs({ ...filters })}`),
    placeholderData: keepPreviousData,
  });
}

export function useTask(id: string | null | undefined) {
  return useQuery({
    queryKey: taskKeys.one(id ?? ''),
    queryFn: () => api.get<Task>(`/api/tasks/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useTaskCounts() {
  return useQuery({ queryKey: taskKeys.counts, queryFn: () => api.get<TaskCounts>('/api/tasks/counts'), staleTime: 10_000 });
}

export function useDailyPlan(date: string | undefined) {
  return useQuery({
    queryKey: taskKeys.plan(date),
    queryFn: () => api.get<DailyPlan>(`/api/tasks/daily-plan${api.qs({ date })}`),
    placeholderData: keepPreviousData,
  });
}

/** Start a download of an .ics file served with content-disposition: attachment. */
export function downloadCalendar(path: string, filename: string): void {
  const a = document.createElement('a');
  a.href = path;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useTaskMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: taskKeys.all });
    void qc.invalidateQueries({ queryKey: ['encounters'] });
    void qc.invalidateQueries({ queryKey: ['today'] });
    void qc.invalidateQueries({ queryKey: ['system', 'info'] });
  };
  const create = useMutation({ mutationFn: (input: TaskInput) => api.post<Task>('/api/tasks', input), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<TaskInput> }) => api.patch<Task>(`/api/tasks/${encodeURIComponent(id)}`, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}`), onSuccess: refresh });
  const done = useMutation({ mutationFn: (id: string) => api.post<Task>(`/api/tasks/${encodeURIComponent(id)}/done`), onSuccess: refresh });
  const reopen = useMutation({ mutationFn: (id: string) => api.post<Task>(`/api/tasks/${encodeURIComponent(id)}/reopen`), onSuccess: refresh });
  const snooze = useMutation({ mutationFn: ({ id, days }: { id: string; days: number }) => api.post<Task>(`/api/tasks/${encodeURIComponent(id)}/snooze`, { days }), onSuccess: refresh });
  const fromFollowUps = useMutation({ mutationFn: () => api.post<GeneratedTasks>('/api/tasks/from-follow-ups'), onSuccess: refresh });
  const fromGaps = useMutation({ mutationFn: () => api.post<GeneratedTasks>('/api/tasks/from-gaps'), onSuccess: refresh });
  return { create, update, remove, done, reopen, snooze, fromFollowUps, fromGaps };
}
