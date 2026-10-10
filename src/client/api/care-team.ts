/**
 * Care team API (server: routes/care-team.ts). Query keys start with 'care-team'. Writes also refresh People and places
 * (a candidate makes or links a row there), the To-do list and Calls and messages.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Communication } from './communications';
import type { Task } from './tasks';
import type { AccessType, Backing, CallTime, CandidateDetailJson, CareRole, CareStatus, CareStep, FindCriteria, FlareTest, FlareVerdict, FlareVerdictKey, HomeStateLicense, PartialDateValue, PhoneCheck, QueryCheck, SearchRun, SourcedField, SourcesByField, Verification, WebSearchEstimate } from '@shared/care-team';
import type { SearchScope } from '@shared/web-domains';

export interface Candidate {
  id: string;
  personId: string | null;
  personName: string | null;
  name: string;
  practice: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  website: string | null;
  licensedStates: string[];
  role: CareRole | null;
  status: CareStatus;
  statusOrder: number;
  review: 'accepted' | 'proposed' | 'rejected';
  notes: string | null;
  flareTest: FlareTest;
  sources: SourcesByField;
  detail: CandidateDetailJson;
  backing: Record<SourcedField, Backing>;
  notBacked: number;
  flareAnswered: number;
  flareBacked: number;
  // Request 6 (optional so older answers still read):
  step?: CareStep | null;
  stepOrder?: number;
  accessType?: AccessType;
  quotedCost?: string | null;
  licensedInHomeState?: HomeStateLicense;
  earliestVisit?: PartialDateValue | null;
  flareVerdict?: FlareVerdict | null;
  callBookedFor?: CallTime | null;
  verification?: Partial<Record<SourcedField, Verification>>;
  unverified?: number;
  webFacts?: number;
  verifiedByPhone?: boolean;
  phoneChecks?: PhoneCheck[];
  calls: number;
  lastContactAt: string | null;
  openTasks: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateDetail extends Candidate {
  communications: Communication[];
  tasks: Task[];
  run: SearchRun | null;
}

export interface CandidateCounts {
  all: number;
  proposed: number;
  shortlisted: number;
  chosen: number;
  rejected: number;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
}

export type CareView = 'all' | 'proposed' | 'shortlisted' | 'rejected';

export interface CareFilters {
  view?: CareView;
  role?: CareRole;
  status?: CareStatus;
  q?: string;
  /** Only the candidates linked to this People and places row. */
  personId?: string;
  /** 1 to 4, or "none" (request 6). */
  step?: CareStep | 'none';
}

export type SourceInput = { kind: 'web'; url: string; readAt?: string | null; title?: string | null } | { kind: 'phone'; who: string; when: string; communicationId?: string | null };

export interface CandidateInput {
  name: string;
  practice?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  website?: string | null;
  licensedStates?: string | string[] | null;
  role?: CareRole | null;
  status?: CareStatus;
  notes?: string | null;
  personId?: string | null;
  source?: SourceInput | null;
  sourceFields?: SourcedField[] | null;
  // Request 6
  step?: CareStep | null;
  accessType?: AccessType | null;
  quotedCost?: string | null;
  licensedInHomeState?: HomeStateLicense | null;
  /** A partial date as typed ("2027-02-15", "Feb 2027"). */
  earliestVisit?: string | null;
  /** With status Call booked: when, as typed. */
  callBookedFor?: string | null;
}

export interface VerdictInput {
  verdict: FlareVerdictKey;
  reason: string | null;
  decidedBy?: string | null;
  decidedOn?: string | null;
}

/** Home, "Coming up" (request 6). */
export interface CareComingUp {
  tasks: Array<{ id: string; title: string; dueAt: string | null; candidateId: string; candidateName: string; overdue: boolean }>;
  nextCall: { candidateId: string; candidateName: string; at: CallTime; words: string } | null;
}

export interface PersonMatch {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  phone: string | null;
}

export interface FindCheck {
  queries: QueryCheck[];
  criteria: Array<{ field: keyof FindCriteria; check: QueryCheck }>;
  maxSearches: number;
  cap: number;
  estimate: WebSearchEstimate;
  model: string;
  words: string;
  ok: boolean;
  scope?: SearchScope;
  domains?: string[];
  domainsLeftOut?: string[];
  scopeWords?: string;
}

export interface FindBody {
  criteria: FindCriteria;
  queries: string[];
  maxSearches?: number | null;
}

export const careKeys = {
  all: ['care-team'] as const,
  list: (f: CareFilters) => ['care-team', 'list', f] as const,
  one: (id: string) => ['care-team', 'one', id] as const,
  runs: ['care-team', 'runs'] as const,
  matches: (name: string) => ['care-team', 'matches', name] as const,
};

export function useCandidates(filters: CareFilters) {
  return useQuery({
    queryKey: careKeys.list(filters),
    queryFn: () => api.get<{ items: Candidate[]; total: number; counts: CandidateCounts }>(`/api/care-team${api.qs({ ...filters })}`),
    placeholderData: keepPreviousData,
  });
}

export function useCandidate(id: string | null | undefined) {
  return useQuery({
    queryKey: careKeys.one(id ?? ''),
    queryFn: () => api.get<CandidateDetail>(`/api/care-team/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

/** The web searches made, with their queries; polls while one is running. */
export function useSearchRuns() {
  return useQuery({
    queryKey: careKeys.runs,
    queryFn: () => api.get<{ items: SearchRun[]; caps: { ask: number; findCandidates: number } }>('/api/care-team/search/runs'),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'running') ? 2500 : false),
  });
}

/** Home's "Coming up": open care-team follow-ups and the next booked flare-test call. */
export function useCareComingUp() {
  return useQuery({ queryKey: [...careKeys.all, 'coming-up'] as const, queryFn: () => api.get<CareComingUp>('/api/care-team/coming-up'), refetchInterval: 60_000 });
}

/** The counts alone (Make a packet shows how many are on the list). */
export function useCareCounts() {
  return useQuery({ queryKey: [...careKeys.all, 'counts'] as const, queryFn: () => api.get<CandidateCounts>('/api/care-team/counts') });
}

export function usePersonMatches(name: string, enabled: boolean) {
  const n = name.trim();
  return useQuery({
    queryKey: careKeys.matches(n),
    queryFn: () => api.get<{ items: PersonMatch[] }>(`/api/care-team/person-matches${api.qs({ name: n })}`),
    enabled: enabled && n.length >= 3,
    staleTime: 10_000,
  });
}

export function fetchPersonMatches(name: string): Promise<{ items: PersonMatch[] }> {
  return api.get<{ items: PersonMatch[] }>(`/api/care-team/person-matches${api.qs({ name: name.trim() })}`);
}

export function useCareMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: careKeys.all });
    void qc.invalidateQueries({ queryKey: ['people'] });
  };
  const enc = encodeURIComponent;
  const create = useMutation({ mutationFn: (input: CandidateInput) => api.post<CandidateDetail>('/api/care-team', input), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<CandidateInput> }) => api.patch<CandidateDetail>(`/api/care-team/${enc(id)}`, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/care-team/${enc(id)}`), onSuccess: refresh });
  const status = useMutation({ mutationFn: ({ id, status, note, callBookedFor }: { id: string; status: CareStatus; note?: string | null; callBookedFor?: string | null }) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/status`, { status, note, ...(callBookedFor !== undefined ? { callBookedFor } : {}) }), onSuccess: refresh });
  const verdict = useMutation({ mutationFn: ({ id, ...v }: { id: string } & VerdictInput) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/flare-verdict`, v), onSuccess: refresh });
  const phoneCheck = useMutation({ mutationFn: ({ id, who, when, fields }: { id: string; who: string; when: string; fields?: SourcedField[] | null }) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/phone-check`, { who, when, fields: fields ?? null }), onSuccess: refresh });
  const phoneUncheck = useMutation({ mutationFn: (id: string) => api.delete<CandidateDetail & { undone: PhoneCheck[] }>(`/api/care-team/${enc(id)}/phone-check`), onSuccess: refresh });
  const addSource = useMutation({ mutationFn: ({ id, fields, source }: { id: string; fields: SourcedField[]; source: SourceInput }) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/sources`, { fields, source }), onSuccess: refresh });
  const removeSource = useMutation({ mutationFn: ({ id, sourceId }: { id: string; sourceId: string }) => api.delete<CandidateDetail>(`/api/care-team/${enc(id)}/sources/${enc(sourceId)}`), onSuccess: refresh });
  const flare = useMutation({ mutationFn: ({ id, item, answer, source }: { id: string; item: string; answer: string; source?: SourceInput | null }) => api.put<CandidateDetail>(`/api/care-team/${enc(id)}/flare-test/${enc(item)}`, { answer, source }), onSuccess: refresh });
  const flareSource = useMutation({ mutationFn: ({ id, item, source }: { id: string; item: string; source: SourceInput }) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/flare-test/${enc(item)}/sources`, { source }), onSuccess: refresh });
  const accept = useMutation({ mutationFn: ({ id, personId }: { id: string; personId?: string | null }) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/accept`, { personId: personId ?? null }), onSuccess: refresh });
  const reject = useMutation({ mutationFn: (id: string) => api.post<Candidate>(`/api/care-team/${enc(id)}/reject`), onSuccess: refresh });
  const link = useMutation({ mutationFn: ({ id, personId }: { id: string; personId?: string | null }) => api.post<CandidateDetail>(`/api/care-team/${enc(id)}/person`, { personId: personId ?? null }), onSuccess: refresh });
  const check = useMutation({ mutationFn: (body: FindBody) => api.post<FindCheck>('/api/care-team/search/check', body) });
  const find = useMutation({ mutationFn: (body: FindBody) => api.post<SearchRun>('/api/care-team/search', body), onSuccess: refresh });
  const stop = useMutation({ mutationFn: (runId: string) => api.post<{ ok: boolean }>(`/api/care-team/search/runs/${enc(runId)}/stop`), onSuccess: refresh });
  return { create, update, remove, status, verdict, phoneCheck, phoneUncheck, addSource, removeSource, flare, flareSource, accept, reject, link, check, find, stop, refresh };
}
