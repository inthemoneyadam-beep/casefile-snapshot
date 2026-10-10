/**
 * Typed client for /api/ask. Query keys start with 'ask' so one invalidation
 * refreshes the session list and every open thread.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streamGet } from './client';
import { useSettings } from './hooks';
import { DEFAULT_CONSULT_PRESETS, type ConsultPreset } from '@shared/constants';
import { answerTaskDetail, answerTaskTitle } from '@shared/ask';
import type { AskCitationRef, AskEvent, AskMessageFull, AskSession, AskSessionDetail, AskSessionListItem, ContextPreview, SendMessageBody } from '@shared/ask';
import type { ReprocessResult } from '@shared/schemas/segments';

export type { AskAttachment, AskCitationRef, AskEvent, AskLabValue, AskMessageFull, AskMeta, AskMode, AskPrefill, AskScope, AskSession, AskSessionDetail, AskSessionListItem, AskUserMeta, ContextPreview, SendMessageBody } from '@shared/ask';

export const askKeys = {
  all: ['ask'] as const,
  sessions: ['ask', 'sessions'] as const,
  session: (id: string) => ['ask', 'session', id] as const,
  preview: (p: Record<string, string | undefined>) => ['ask', 'preview', p] as const,
};

export function useAskSessions() {
  return useQuery({ queryKey: askKeys.sessions, queryFn: () => api.get<{ items: AskSessionListItem[] }>('/api/ask/sessions'), staleTime: 5_000, placeholderData: keepPreviousData });
}

export function useAskSession(id: string | null | undefined) {
  return useQuery({
    queryKey: askKeys.session(id ?? ''),
    queryFn: () => api.get<AskSessionDetail>(`/api/ask/sessions/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    staleTime: 2_000,
    retry: false,
  });
}

export interface PresetsState {
  presets: ConsultPreset[];
  defaultKey: string;
  showThinking: boolean;
  loaded: boolean;
}

function validPresets(raw: unknown): ConsultPreset[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_CONSULT_PRESETS;
  const ok = raw.filter((p): p is ConsultPreset => p && typeof p === 'object' && typeof (p as ConsultPreset).key === 'string' && typeof (p as ConsultPreset).model === 'string');
  return ok.length ? ok : DEFAULT_CONSULT_PRESETS;
}

/** Presets from settings (ask.presets), with the default key and the show-reasoning flag. */
export function usePresets(): PresetsState {
  const s = useSettings();
  const presets = validPresets(s.data?.['ask.presets']);
  const defaultKey = presets.some((p) => p.key === s.data?.['ask.defaultPreset']) ? (s.data!['ask.defaultPreset'] as string) : presets.some((p) => p.key === 'standard') ? 'standard' : presets[0].key;
  return { presets, defaultKey, showThinking: s.data ? Boolean(s.data['ask.showThinking']) : true, loaded: Boolean(s.data) };
}

/** What the client needs to file an answer as a task itself (see toTask). */
export interface AnswerTaskSource {
  sessionId: string;
  question: string;
  content: string;
  citations: AskCitationRef[];
}

export function useAskMutations() {
  const qc = useQueryClient();
  const refreshSessions = () => void qc.invalidateQueries({ queryKey: askKeys.sessions });
  const createSession = useMutation({ mutationFn: (input: { title?: string } = {}) => api.post<AskSession>('/api/ask/sessions', input), onSuccess: refreshSessions });
  const renameSession = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patch<AskSession>(`/api/ask/sessions/${encodeURIComponent(id)}`, { title }),
    onSuccess: (_s, { id }) => {
      refreshSessions();
      void qc.invalidateQueries({ queryKey: askKeys.session(id) });
    },
  });
  const deleteSession = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/ask/sessions/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: askKeys.session(id) });
      refreshSessions();
    },
  });
  const send = useMutation({
    mutationFn: ({ sessionId, body }: { sessionId: string; body: SendMessageBody }) => api.post<{ userMessageId: string; assistantMessageId: string }>(`/api/ask/sessions/${encodeURIComponent(sessionId)}/messages`, body),
    onSuccess: (_r, { sessionId }) => {
      void qc.invalidateQueries({ queryKey: askKeys.session(sessionId) });
      refreshSessions();
    },
  });
  const cancel = useMutation({ mutationFn: (messageId: string) => api.post<AskMessageFull>(`/api/ask/messages/${encodeURIComponent(messageId)}/cancel`) });
  const toTask = useMutation({
    mutationFn: ({ messageId, title, direct }: { messageId: string; title?: string; direct?: AnswerTaskSource }) =>
      direct
        ? // The same task the to-task route writes, filed through /tasks (a viewer may add tasks but not POST under /ask).
          api.post<{ id: string; title: string }>('/api/tasks', {
            title: answerTaskTitle(direct.question, title),
            detail: answerTaskDetail(direct.content, direct.citations, direct.sessionId),
            owner: 'me',
            sourceType: 'manual',
            sourceId: messageId,
          })
        : api.post<{ id: string; title: string }>(`/api/ask/messages/${encodeURIComponent(messageId)}/to-task`, title ? { title } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
  return { createSession, renameSession, deleteSession, send, cancel, toTask };
}

/**
 * Follow one answer's Server-Sent Events. Uses GET, which every role may
 * call (a viewer may not POST here). Payloads that are not event objects are
 * skipped.
 */
export async function* streamAskMessage(messageId: string, signal?: AbortSignal): AsyncGenerator<AskEvent> {
  for await (const ev of streamGet<AskEvent | string>(`/api/ask/messages/${encodeURIComponent(messageId)}/stream`, signal)) {
    if (ev && typeof ev === 'object' && typeof ev.type === 'string') yield ev;
  }
}

export interface PreviewParams {
  preset: string;
  q: string;
  documentIds?: string[];
  from?: string;
  to?: string;
}

export function useContextPreview(p: PreviewParams, enabled = true) {
  const params = { preset: p.preset, q: p.q.trim() || undefined, documentIds: p.documentIds?.length ? p.documentIds.join(',') : undefined, from: p.from || undefined, to: p.to || undefined };
  return useQuery({
    queryKey: askKeys.preview(params),
    queryFn: () => api.get<ContextPreview>(`/api/ask/context-preview${api.qs(params)}`),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export interface EncounterLite {
  id: string;
  title: string;
  occurredAt?: string | null;
  occurredAtPrecision?: string;
  status?: string;
}

/** Encounters for the briefing picker. Tolerates the stub endpoint ({ items: [] }). */
export function useEncountersLite(enabled = true) {
  return useQuery({
    // Its own key: Inbox's list (api/inbox.ts) holds every visit, this one only the upcoming ones.
    queryKey: ['encounters', 'lite', 'upcoming'],
    queryFn: async () => {
      try {
        const r = await api.get<{ items?: EncounterLite[] }>('/api/encounters?status=upcoming');
        return Array.isArray(r?.items) ? r.items.filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string') : [];
      } catch {
        return [] as EncounterLite[];
      }
    },
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// What the patient does with what the clinician started or proposed under an answer (2026-10-08, lab check)
// ---------------------------------------------------------------------------

/** Where a lab value added under an answer stands now (GET /api/ask/lab-values). */
export interface AskLabValueState {
  factId: string;
  state: 'live' | 'taken_back' | 'replaced' | 'gone';
}

/** The answer of approving a lab value the clinician proposed: the filing as it now stands and what was added. */
export interface LabValueApproval {
  result: { outcome: 'added' | 'cited_existing' | 'already_on_file'; factId: string; words: string; undo: { factId: string } | null };
}

/** After any of these, the thread's cards, the document's coverage, Labs and the job bar read again. */
function useProposalRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const key of [['filing'], ['documents'], ['document'], ['labs'], ['jobs'], ['facts'], ['ask', 'lab-values']]) void qc.invalidateQueries({ queryKey: key });
  };
}

export function useAskProposalActions() {
  const refresh = useProposalRefresh();
  const approveReading = useMutation({
    mutationFn: (filingIds: string[]) => api.post<ReprocessResult>('/api/ask/proposals/reading/approve', { filingIds }),
    onSettled: refresh,
  });
  const declineReading = useMutation({
    mutationFn: (filingIds: string[]) => api.post<{ declined: number }>('/api/ask/proposals/reading/decline', { filingIds }),
    onSettled: refresh,
  });
  const approveLabValue = useMutation({
    mutationFn: (filingId: string) => api.post<LabValueApproval>(`/api/ask/proposals/lab-value/${encodeURIComponent(filingId)}/approve`, {}),
    onSettled: refresh,
  });
  const declineLabValue = useMutation({
    mutationFn: (filingId: string) => api.post<unknown>(`/api/ask/proposals/lab-value/${encodeURIComponent(filingId)}/decline`, {}),
    onSettled: refresh,
  });
  const undoLabValue = useMutation({
    mutationFn: (factId: string) => api.post<{ undone: boolean; words: string }>(`/api/ask/lab-values/${encodeURIComponent(factId)}/undo`, {}),
    onSettled: refresh,
  });
  return { approveReading, declineReading, approveLabValue, declineLabValue, undoLabValue };
}

/** Where these lab values stand now (live, taken back, replaced), for the cards under answers. */
export function useLabValueStates(factIds: string[]) {
  const key = [...new Set(factIds)].sort().join(',');
  return useQuery({
    queryKey: ['ask', 'lab-values', key],
    queryFn: async () => (await api.get<{ items: AskLabValueState[] }>(`/api/ask/lab-values${api.qs({ ids: key })}`)).items,
    enabled: key.length > 0,
    staleTime: 5_000,
    retry: false,
  });
}
