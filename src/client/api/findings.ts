/**
 * Typed client for /api/findings: cross-reference runs and the findings they
 * produce. Query keys start with 'findings' so one invalidation refreshes
 * the list, the detail, the counts and the runs together.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Finding {
  id: string;
  category: string;
  title: string;
  whyItMatters: string;
  detail: string | null;
  severity: string;
  status: string;
  verdictNote: string | null;
  verdictAt: string | null;
  origin: string;
  ruleId: string | null;
  fingerprint: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FindingListItem extends Finding {
  evidenceCount: number;
  runStartedAt: string | null;
}

export interface EvidenceRef {
  kind: 'record' | 'medication' | 'medication_event' | 'symptom' | 'encounter' | 'task';
  id: string;
}

export interface EvidenceItem {
  id: string;
  sortOrder: number;
  note: string | null;
  factId: string | null;
  citationId: string | null;
  documentId: string | null;
  communicationId: string | null;
  labResultId: string | null;
  ref: EvidenceRef | null;
  fact: { id: string; statement: string; type: string; status: string; date: string | null; datePrecision: string; dateText: string | null; sourceDocumentId: string | null; documentTitle: string | null } | null;
  citation: { id: string; documentId: string; pageNumber: number; quote: string; verified: boolean; matchKind: string | null; documentTitle: string | null } | null;
  communication: { id: string; subject: string; occurredAt: string | null; occurredAtPrecision: string; direction: string; channel: string; followUpPromised: string | null; followUpDue: string | null; followUpDoneAt: string | null } | null;
  /**
   * A lab row named as evidence: its current value, unit, range and flag, and (2026-10) the text as printed: valueRaw,
   * refRaw, flagRaw ('' or '-' is "no flag printed"; null when not recorded) and the resulted date.
   */
  lab: {
    id: string;
    analyte: string;
    valueNum: number | null;
    valueText: string | null;
    unit: string | null;
    flag: string | null;
    specimen: string;
    collectedAt: string | null;
    collectedAtPrecision: string;
    documentId: string | null;
    refText?: string | null;
    valueRaw?: string | null;
    flagRaw?: string | null;
    refRaw?: string | null;
    resultedAt?: string | null;
    /** The value is the user's own (changed by hand): only then is the printed text said beside it. */
    valueEdited?: boolean;
  } | null;
  document: { id: string; title: string; documentDate: string | null; documentDatePrecision: string; category: string } | null;
  record: { id: string; title: string; status: string; recordType: string } | null;
  medication: { id: string; name: string; status: string } | null;
  medicationEvent: { id: string; medicationId: string; medicationName: string; kind: string; date: string | null } | null;
  symptom: { id: string; name: string } | null;
  encounter: { id: string; title: string; status: string; occurredAt: string | null } | null;
  task: { id: string; title: string; status: string } | null;
}

export interface FindingDetail extends Finding {
  evidence: EvidenceItem[];
  run: { id: string; startedAt: string; finishedAt: string | null; model: string | null; deep: boolean; status: string } | null;
  tasks: Array<{ id: string; title: string; status: string; dueAt: string | null }>;
}

export interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
  durationMs: number;
}

export interface Run {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  model: string | null;
  deep: boolean;
  status: string;
  findingsCount: number;
  rulesCount: number;
  error: string | null;
  usage: RunUsage;
  /**
   * trigger and rule are set on a pass of one rule: the patient-precedence pass after an extraction, and the lab checks
   * (rule 'lab_checks') after an extraction, at every unlock ('unlock') or by hand ('manual').
   */
  scope: { documentIds?: string[]; from?: string; to?: string; trigger?: string; rule?: string };
  rulesOnly: boolean;
  aiCallIds: string[];
  /** What the AI pass returned and kept, and why the rest was dropped; null before the pass finishes or on a rules-only run. */
  aiStats: AiRunStats | null;
}

export interface AiRunStats {
  returned: number;
  kept: number;
  droppedNoEvidence: number;
  droppedWording: number;
  droppedIds: number;
}

/** A run of one rule only (the precedence pass after an extraction), not the cross-reference rules. */
export function isPartialRun(r: Pick<Run, 'scope'>): boolean {
  return Boolean(r.scope.rule);
}

export interface RunDetail extends Run {
  findings: Array<Pick<Finding, 'id' | 'title' | 'category' | 'severity' | 'status' | 'origin' | 'ruleId'>>;
  job: { id: string; status: string; progress: number; progressText: string | null; error: string | null } | null;
}

export interface FindingCounts {
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
}

export interface FindingsListParams {
  category?: string;
  status?: string;
  severity?: string;
  q?: string;
  origin?: string;
  runId?: string;
  limit?: number;
}

export interface RunInput {
  deep?: boolean;
  rulesOnly?: boolean;
  scope?: { documentIds?: string[]; from?: string; to?: string };
}

export interface RulesSummary {
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  retired: number;
  drafts: number;
}

export interface RunResponse {
  run: RunDetail;
  rules: RulesSummary;
  jobId: string | null;
}

export interface ToTaskInput {
  title?: string | null;
  detail?: string | null;
  owner?: string | null;
  dueAt?: string | null;
  priority?: string | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  owner: string;
  existing: boolean;
}

export const RULE_LABELS: Record<string, string> = {
  date_disagreement: 'date disagreement',
  dose_disagreement: 'dose disagreement',
  effect_disagreement: 'effect disagreement',
  missing_record: 'missing record',
  lab_never_in_range: 'lab never in range',
  lab_trend: 'lab trend',
  recommendation_not_acted: 'recommendation not acted on',
  follow_up_missed: 'follow-up missed',
  referral_not_completed: 'referral not completed',
  result_never_mentioned_again: 'result never mentioned again',
  exposure_symptom_timing: 'exposure and symptom timing',
  // The lab checks (2026-10): rule 10 and rule 12.
  lab_same_source_conflict: 'two values in one document',
  lab_claim_differs: 'a summary differs from the lab report',
  lab_computed_differs: 'the lab printed a different value than computed',
  lab_checks: 'lab checks',
  // Checked against itself (2026-10-09).
  flag_mismatch: "a flag doesn't match its value",
  self_contradiction: 'one document contradicts itself',
  self_check: 'checked against itself',
};

export function sourceLabel(f: Pick<Finding, 'origin' | 'ruleId'>): string {
  if (f.origin === 'ai') return 'AI pass';
  return f.ruleId ? (RULE_LABELS[f.ruleId] ?? f.ruleId.replace(/_/g, ' ')) : 'rule';
}

export const findingKeys = {
  all: ['findings'] as const,
  list: (p: FindingsListParams) => ['findings', 'list', p] as const,
  detail: (id: string) => ['findings', 'detail', id] as const,
  counts: ['findings', 'counts'] as const,
  runs: ['findings', 'runs'] as const,
  run: (id: string) => ['findings', 'run', id] as const,
};

export function useFindingsList(p: FindingsListParams, opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: findingKeys.list(p),
    queryFn: () => api.get<{ items: FindingListItem[]; total: number; counts: FindingCounts }>(`/api/findings${api.qs(p as Record<string, string | number | undefined>)}`),
    refetchInterval: opts.refetchInterval ?? false,
    placeholderData: (prev) => prev,
  });
}

export function fetchFinding(id: string): Promise<FindingDetail> {
  return api.get<FindingDetail>(`/api/findings/${encodeURIComponent(id)}`);
}

export function useFinding(id: string | null | undefined) {
  return useQuery({
    queryKey: findingKeys.detail(id ?? ''),
    queryFn: () => fetchFinding(id!),
    enabled: Boolean(id),
  });
}

export function useRuns(opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: findingKeys.runs,
    queryFn: () => api.get<{ items: Run[] }>('/api/findings/runs?limit=100'),
    refetchInterval: opts.refetchInterval ?? false,
    placeholderData: (prev) => prev,
  });
}

export function useRun(id: string | null | undefined) {
  return useQuery({
    queryKey: findingKeys.run(id ?? ''),
    queryFn: () => api.get<RunDetail>(`/api/findings/runs/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useFindingMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: findingKeys.all });
    void qc.invalidateQueries({ queryKey: ['today'] });
    void qc.invalidateQueries({ queryKey: ['system', 'info'] });
  };
  const verdict = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: string; note?: string | null }) => api.post<FindingDetail>(`/api/findings/${encodeURIComponent(id)}/verdict`, { status, note }),
    onSuccess: refresh,
  });
  const toTask = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ToTaskInput }) => api.post<TaskRow>(`/api/findings/${encodeURIComponent(id)}/to-task`, input),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const run = useMutation({
    mutationFn: (input: RunInput) => api.post<RunResponse>('/api/findings/run', input),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  return { verdict, toTask, run };
}
