/**
 * Thread + composer for one session, shared by the /ask page and the dock.
 * Owns the composer state, sending, stopping, prefill consumption and the
 * preset editor dialog. Exposes an imperative handle so the page can wire
 * its key bindings (send, stop, depth, focus, new session).
 *
 * Viewers may not POST under /api/ask, so for them the composer, Send, Stop
 * and the preset editor are replaced by one read-only line; Make task stays
 * and files the task through /api/tasks, which viewers may write.
 *
 * Documents attached to a question (owners and editors) are uploaded like
 * any file; the question is held until Claude has read each one, then sent
 * with their ids, and the chips clear.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, useFailToast } from '../../api/client';
import { useUpdateSettings } from '../../api/hooks';
import { useMe } from '../../api/users';
import { aiKeys } from '../../api/ai';
import { askKeys, useAskMutations, useAskSession, usePresets, type AnswerTaskSource } from '../../api/ask';
import { useToast } from '../../ui/Toast';
import { Thread } from './Thread';
import { Composer, emptyComposer, type ComposerState } from './Composer';
import { attachedDocumentIds, attachmentsWaiting, draftForDocument, type UpdateAttachments } from './Attachments';
import { PresetEditor } from './PresetEditor';
import { forgetLive, getLive, startStream, takePrefill, usePrefillVersion, writeStoredSession } from './live';
import type { AskAttachment, AskCitationRef, AskMeta, AskMode } from '@shared/ask';

export interface ConsultPanelHandle {
  send: () => void;
  stop: () => void;
  focusComposer: () => void;
  moveSlider: (delta: number) => void;
  newSession: () => void;
  openPresets: () => void;
  isRunning: () => boolean;
  /** Put a question in the box (and its kind of answer), ready to send; nothing is sent. */
  fill: (text: string, mode?: AskMode) => void;
}

export interface ConsultPanelProps {
  sessionId: string | null;
  onSessionChange: (id: string | null) => void;
  /** Applied when it changes (dock('open', { presetKey })). */
  presetKey?: string | null;
  /** Initial mode from the URL. */
  mode?: AskMode | null;
  compact?: boolean;
}

export const ConsultPanel = forwardRef<ConsultPanelHandle, ConsultPanelProps>(function ConsultPanel({ sessionId, onSessionChange, presetKey, mode, compact }, ref) {
  const { presets, defaultKey, showThinking, loaded } = usePresets();
  const me = useMe();
  const readOnly = me.isViewer;
  const session = useAskSession(sessionId);
  const m = useAskMutations();
  const update = useUpdateSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const fail = useFailToast();
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [state, setState] = useState<ComposerState>(() => emptyComposer(presetKey && presetKey !== 'default' ? presetKey : defaultKey));
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const patch = useCallback((p: Partial<ComposerState>) => setState((s) => ({ ...s, ...p })), []);
  const updateAttachments = useCallback<UpdateAttachments>(
    (fn) =>
      setState((s) => {
        const next = fn(s.attachments);
        return next === s.attachments ? s : { ...s, attachments: next };
      }),
    [],
  );

  // Default preset once settings arrive; explicit presetKey wins whenever it changes.
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (loaded && !defaultApplied.current) {
      defaultApplied.current = true;
      if (!presetKey) patch({ presetKey: defaultKey });
    }
  }, [loaded, defaultKey, presetKey, patch]);
  useEffect(() => {
    if (presetKey && presets.some((p) => p.key === presetKey)) patch({ presetKey });
  }, [presetKey, presets, patch]);
  useEffect(() => {
    if (mode) patch({ mode });
  }, [mode, patch]);

  // Prefill from `casefile:ask-prefill` (search page, encounters, commands).
  // The dock takes a prefill at once; the page waits a moment so a dock opened
  // by the same command (e.g. Directory search) gets it first.
  const prefillVersion = usePrefillVersion();
  useEffect(() => {
    let cancelled = false;
    const consume = () => {
      if (cancelled) return;
      const p = takePrefill();
      if (!p) return;
      patch({ text: p.text, mode: p.mode ?? 'question', encounterId: p.encounterId ?? null, personId: p.personId ?? null, ...(p.presetKey && presets.some((x) => x.key === p.presetKey) ? { presetKey: p.presetKey } : {}) });
      if (p.send && p.text.trim()) autoSend.current = p.text.trim();
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    const t = setTimeout(consume, compact ? 0 : 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [prefillVersion, patch, presets, compact]);

  const messages = useMemo(() => session.data?.messages ?? [], [session.data]);
  const runningMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const x = messages[i];
      if (x.role !== 'assistant') continue;
      const meta = x.meta as AskMeta;
      if (meta.status === 'running' && !getLive(x.id)?.finished) return x.id;
    }
    return null;
  }, [messages]);
  const running = Boolean(runningMessage);

  const refreshSession = useCallback(
    (id: string) => {
      void qc.invalidateQueries({ queryKey: askKeys.session(id) });
      void qc.invalidateQueries({ queryKey: askKeys.sessions });
    },
    [qc],
  );

  const onFinished = useCallback(
    async (messageId: string) => {
      if (sessionId) await qc.invalidateQueries({ queryKey: askKeys.session(sessionId) });
      void qc.invalidateQueries({ queryKey: askKeys.sessions });
      void qc.invalidateQueries({ queryKey: aiKeys.calls });
      // Keep the live entry until the refetched message is no longer running.
      setTimeout(() => forgetLive(messageId), 1500);
    },
    [qc, sessionId],
  );

  // A prefill that asked to be sent goes as soon as the composer holds its text (the next render).
  const autoSend = useRef<string | null>(null);
  const send = useCallback(async () => {
    const text = state.text.trim();
    // Attachments still being uploaded or read hold the question back (the Ask button says so).
    if (readOnly || !text || sending || running || attachmentsWaiting(state.attachments)) return;
    const attached = attachedDocumentIds(state.attachments);
    const sentKeys = new Set(state.attachments.map((a) => a.key));
    setSending(true);
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await m.createSession.mutateAsync({});
        sid = s.id;
        writeStoredSession(sid);
        onSessionChange(sid);
      }
      const r = await m.send.mutateAsync({
        sessionId: sid,
        body: {
          content: text,
          preset: state.presetKey,
          mode: state.mode,
          scope: state.scope.documentIds?.length || state.scope.from || state.scope.to ? state.scope : undefined,
          personId: state.mode === 'draft' ? state.personId : undefined,
          encounterId: state.mode === 'briefing' ? state.encounterId : undefined,
          attachedDocumentIds: attached.length ? attached : undefined,
          webSearch: state.webSearch ? true : undefined,
        },
      });
      startStream(r.assistantMessageId);
      // "Search the web" is off again for the next question (off by default).
      patch({ text: '', webSearch: false });
      // The sent attachments go with the question; a file picked while it was sending stays for the next one.
      updateAttachments((xs) => xs.filter((x) => !sentKeys.has(x.key)));
      await qc.invalidateQueries({ queryKey: askKeys.session(sid) });
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, state, sending, running, sessionId, m.createSession, m.send, onSessionChange, patch, updateAttachments, qc]);

  const stop = useCallback(() => {
    if (readOnly || !runningMessage) return;
    m.cancel.mutate(runningMessage, { onError: fail, onSuccess: () => sessionId && refreshSession(sessionId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, runningMessage, m.cancel, sessionId, refreshSession]);

  const moveSlider = useCallback(
    (delta: number) => {
      const i = Math.max(0, presets.findIndex((p) => p.key === state.presetKey));
      const next = presets[Math.max(0, Math.min(presets.length - 1, i + delta))];
      if (next) patch({ presetKey: next.key });
    },
    [presets, state.presetKey, patch],
  );

  const newSession = useCallback(() => {
    writeStoredSession(null);
    onSessionChange(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [onSessionChange]);

  const fill = useCallback(
    (text: string, mode?: AskMode) => {
      patch({ text, ...(mode ? { mode } : {}) });
      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    },
    [patch],
  );

  useEffect(() => {
    if (!autoSend.current || state.text.trim() !== autoSend.current) return;
    autoSend.current = null;
    void send();
  }, [state.text, send]);

  useImperativeHandle(
    ref,
    () => ({
      send: () => void send(),
      stop,
      focusComposer: () => textareaRef.current?.focus(),
      moveSlider,
      newSession,
      openPresets: () => !readOnly && setPresetsOpen(true),
      isRunning: () => running,
      fill,
    }),
    [send, stop, moveSlider, newSession, running, readOnly, fill],
  );

  const onCitation = useCallback(
    (c: AskCitationRef) => {
      if (c.kind === 'communication' && c.communicationId) void navigate({ to: '/communications', search: { id: c.communicationId } });
      else if (c.documentId) void navigate({ to: '/documents/$id', params: { id: c.documentId }, search: { page: c.pageNumber ?? 1, cite: c.citationId, q: c.citationId ? undefined : c.quote.slice(0, 80) } });
      else if (c.factId) void navigate({ to: '/facts', search: { id: c.factId } });
    },
    [navigate],
  );
  const onLink = useCallback(
    (href: string) => {
      try {
        const u = new URL(href, window.location.origin);
        void navigate({ to: u.pathname, search: Object.fromEntries(u.searchParams.entries()) });
      } catch {
        // ignore malformed links
      }
    },
    [navigate],
  );
  const onRetry = useCallback(
    (question: string, key: string, attachments?: AskAttachment[]) => {
      // The retried question carries its attachments again (each is checked before sending).
      patch({ text: question, presetKey: key, ...(attachments?.length ? { attachments: attachments.map((a) => draftForDocument(a.documentId, a.title)) } : {}) });
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [patch],
  );
  const onTask = useCallback(
    (messageId: string, source: AnswerTaskSource) => {
      m.toTask.mutate(
        // A viewer files the same task through /api/tasks (refused under /api/ask).
        { messageId, direct: readOnly ? source : undefined },
        {
          onSuccess: (t) => toast(`To-do added: ${t.title}`, 'ok'),
          onError: fail,
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m.toTask, readOnly],
  );

  const sessionGone = sessionId && session.isError && session.error instanceof ApiError && session.error.status === 404;
  useEffect(() => {
    if (sessionGone) {
      writeStoredSession(null);
      onSessionChange(null);
    }
  }, [sessionGone, onSessionChange]);

  return (
    <div className={`consult${compact ? ' compact' : ''}`}>
      {sessionId && session.isPending ? (
        <div className={compact ? 'dock-thread' : 'consult-thread'}>
          <div className="muted small">Loading conversation…</div>
        </div>
      ) : sessionId && session.isError ? (
        <div className={compact ? 'dock-thread' : 'consult-thread'}>
          <div className="muted small">This conversation is not available.</div>
        </div>
      ) : (
        <Thread messages={messages} presets={presets} compact={compact} readOnly={readOnly} onRetry={onRetry} onTask={onTask} onCitation={onCitation} onLink={onLink} onFinished={onFinished} onStarter={readOnly ? undefined : fill} />
      )}
      {readOnly ? (
        <div className="consult-readonly">
          {running ? 'An answer is being written; it appears here as it streams. ' : ''}
          Read only: viewers can follow conversations and make to-dos from answers. Asking needs an owner or editor.
        </div>
      ) : (
        <>
          <Composer
            state={state}
            onChange={patch}
            onAttachments={updateAttachments}
            canAttach={me.canWrite}
            presets={presets}
            running={running}
            sending={sending}
            onSend={() => void send()}
            onStop={stop}
            showThinking={showThinking}
            onShowThinking={(v) => update.mutate({ 'ask.showThinking': v }, { onError: fail })}
            onOpenPresets={() => setPresetsOpen(true)}
            compact={compact}
            textareaRef={textareaRef}
          />
          <PresetEditor open={presetsOpen} onClose={() => setPresetsOpen(false)} presets={presets} defaultKey={defaultKey} />
        </>
      )}
    </div>
  );
});
