/**
 * The conversation: user turns and assistant answers. A running answer shows
 * a live status line with a timer, the reasoning summary as it streams, the
 * streamed text, tool calls and charts; a finished one shows the stored
 * answer with citation chips, warnings, a footer and actions. A user turn
 * lists the documents attached to it, each linking to Documents.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { Markdown, citationTitle } from './Markdown';
import { ProposedMoves, friendlyReason } from '../filing/Filing';
import { AskBatchActions } from '../documents/AskBatchActions';
import { AskWebSources } from '../care-team/AskWebSources';
import { fmtElapsed, fmtTokens, fmtUsd, startStream, useLive, type LiveMessage } from './live';
import { isAskMeta, type AskAttachment, type AskCitationRef, type AskMessageFull, type AskMeta, type AskMode, type AskUserMeta } from '@shared/ask';
import { STARTERS, liveNoteWords, modeWords, toolWords } from './words';
import { MODEL_LABELS, type ConsultPreset } from '@shared/constants';
import type { AnswerTaskSource } from '../../api/ask';

export interface ThreadProps {
  messages: AskMessageFull[];
  presets: ConsultPreset[];
  compact?: boolean;
  /** Viewers: no Retry (there is no composer to fill); Make task stays. */
  readOnly?: boolean;
  /** Fill the composer with the question again (and the documents attached to it). */
  onRetry: (question: string, presetKey: string, attachments?: AskAttachment[]) => void;
  onTask: (messageId: string, source: AnswerTaskSource) => void;
  onCitation: (c: AskCitationRef) => void;
  onLink: (href: string) => void;
  onFinished?: (messageId: string) => void;
  /** Fill the composer with a suggested first question (shown while the conversation is empty). */
  onStarter?: (text: string, mode: AskMode) => void;
}

function useElapsed(startedAt: string | number | null | undefined, running: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!startedAt) return '';
  const t0 = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime();
  return fmtElapsed(Date.now() - t0);
}

/** One printed line per citation: `[n] title p.N · quote found on the page · “quote”`. */
function printSourceLine(c: AskCitationRef): string {
  const head = citationTitle(c).split('\n')[0];
  const q = c.quote.length > 300 ? `${c.quote.slice(0, 299)}…` : c.quote;
  return `[${c.n}] ${head} · “${q}”`;
}

function shortModel(model: string): string {
  const label = MODEL_LABELS[model];
  return label ? label.replace(/\s*\(.*\)$/, '') : model;
}

/** "45 seconds", "3 minutes": how long an answer took, in plain words. */
function plainDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const min = Math.round(s / 60);
  return `${min} minute${min === 1 ? '' : 's'}`;
}

function plainCost(usd: number | undefined | null): string {
  if (!usd || usd < 0.01) return 'cost less than a cent';
  return `cost about $${usd.toFixed(2)}`;
}

function UserMessage({ m, presets }: { m: AskMessageFull; presets: ConsultPreset[] }) {
  const meta = m.meta as AskUserMeta;
  const preset = presets.find((p) => p.key === meta.preset);
  return (
    <div className="msg">
      <div className="msg-role">
        You · {preset?.label ?? meta.preset ?? 'consult'}
        {meta.mode && meta.mode !== 'question' ? ` · ${modeWords(meta.mode)}` : ''}
        {meta.scope?.documentIds?.length ? ` · ${meta.scope.documentIds.length} selected document${meta.scope.documentIds.length === 1 ? '' : 's'}` : ''}
        {meta.scope?.from || meta.scope?.to ? ` · ${meta.scope.from ?? '…'} to ${meta.scope.to ?? '…'}` : ''}
      </div>
      <div className="msg-user">{m.content}</div>
      {meta.attachments?.length ? (
        <div className="ask-attached">
          <span>Attached</span>
          {meta.attachments.map((a) => (
            <Link
              key={a.documentId}
              to="/documents"
              search={{ id: a.documentId }}
              className={a.official ? 'official' : undefined}
              title={a.official ? `${a.title}: marked as the official record (clinical record) when this was asked` : a.title}
            >
              {a.title}
              {a.official ? ' (official record)' : ''}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface AssistantProps {
  m: AskMessageFull;
  question: string | null;
  /** The documents attached to that question. */
  attachments?: AskAttachment[];
  presets: ConsultPreset[];
  compact?: boolean;
  readOnly?: boolean;
  onRetry: ThreadProps['onRetry'];
  onTask: ThreadProps['onTask'];
  onCitation: ThreadProps['onCitation'];
  onLink: ThreadProps['onLink'];
  onFinished?: ThreadProps['onFinished'];
}

function AssistantMessage({ m, question, attachments, presets, compact, readOnly, onRetry, onTask, onCitation, onLink, onFinished }: AssistantProps) {
  const toast = useToast();
  const stored = m.meta as AskMeta;
  const live: LiveMessage | undefined = useLive(m.id);
  const serverRunning = stored.status === 'running';
  // Follow a running answer, including after a reload.
  useEffect(() => {
    if (serverRunning && !live) startStream(m.id);
  }, [serverRunning, live, m.id]);
  const finishedRef = useRef(false);
  useEffect(() => {
    if (live?.finished && !finishedRef.current) {
      finishedRef.current = true;
      onFinished?.(m.id);
    }
  }, [live?.finished, m.id, onFinished]);

  const running = serverRunning && !(live?.finished);
  const settled = live?.finished && live.message ? live.message : null;
  const meta: AskMeta = settled && isAskMeta(settled.meta) ? settled.meta : stored;
  const text = running ? (live?.text ?? '') : settled ? settled.content : m.content;
  const thinking = running ? (live?.thinking ?? '') : meta.thinkingSummary || live?.thinking || '';
  const charts = running ? (live?.charts ?? []) : meta.charts ?? [];
  const tools = running ? (live?.tools ?? []) : meta.toolCalls.map((t) => ({ name: t.name, summary: t.summary, error: t.error }));
  const elapsed = useElapsed(meta.startedAt, running);
  const preset = presets.find((p) => p.key === meta.preset);
  const presetIndex = presets.findIndex((p) => p.key === meta.preset);
  const next = presetIndex >= 0 && presetIndex < presets.length - 1 ? presets[presetIndex + 1] : null;
  const citations = useMemo(() => meta.citations ?? [], [meta.citations]);
  const unverified = citations.filter((c) => (c.kind === 'page' || (c.kind === 'fact' && c.documentId)) && !c.verified).length;
  const unlinked = citations.filter((c) => c.kind === 'ledger').length;
  const statusTone = meta.status === 'error' ? 'bad' : meta.status === 'cancelled' ? 'ash' : meta.status === 'refused' ? 'warn' : 'ok';
  // A stream failure matters only while the stored answer is still running (or when it
  // carried the final message); once the refetched answer has settled, its own state wins.
  const errorText = serverRunning || settled ? (live?.error ?? meta.error) : meta.error;

  return (
    <div className="msg">
      <div className="msg-role">
        Clinician · {preset?.label ?? meta.presetLabel ?? meta.preset}
        {meta.mode && meta.mode !== 'question' ? ` · ${modeWords(meta.mode)}` : ''}
      </div>
      {running ? (
        <div className="msg-status" role="status" title={live?.note ?? undefined}>
          {liveNoteWords(live?.note)} · <span className="mono">{elapsed}</span>
          {tools.length ? ` · ${tools.length} lookup${tools.length === 1 ? '' : 's'}` : ''}
        </div>
      ) : null}
      {thinking ? (
        <details className="msg-thinking" open={meta.preset === 'master' || running}>
          <summary>Reasoning summary{running ? ' (streaming)' : ''}</summary>
          {thinking}
        </details>
      ) : null}
      {tools.length ? (
        <details className="ask-tools" open={running}>
          <summary>
            What the clinician looked up ({tools.length})
          </summary>
          <ul>
            {tools.map((t, i) => (
              <li key={i} className={t.error ? 'bad' : undefined} title={t.summary}>
                {toolWords(t.name, t.summary)}
                {t.error ? ' (did not work)' : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {!running && meta.workingNotes ? (
        <details className="msg-working">
          <summary>Working notes</summary>
          <div className="msg-working-body">{meta.workingNotes}</div>
        </details>
      ) : null}
      {text ? (
        <div className="msg-answer">
          <Markdown text={text} citations={running ? [] : citations} charts={charts} onCitation={onCitation} onLink={onLink} compact={compact} />
        </div>
      ) : running || meta.status !== 'done' ? null : (
        <div className="muted small">The answer came back empty.</div>
      )}
      {!running && meta.proposals?.length ? <ProposedMoves ids={meta.proposals} /> : null}
      {!running && (meta.webSources?.length || meta.webSearches?.length || meta.careProposals?.length) ? <AskWebSources meta={meta} /> : null}
      {!running && (meta.proposals?.length || meta.labValues?.length) ? <AskBatchActions ids={meta.proposals ?? []} labValues={meta.labValues} /> : null}
      {!running && citations.length ? (
        // On paper the chips cannot be hovered or opened, so the sources print under the answer.
        <div className="print-only ask-sources">
          <div className="ask-sources-head">Sources</div>
          {citations.map((c) => (
            <div key={c.n}>{printSourceLine(c)}</div>
          ))}
        </div>
      ) : null}
      {!running && meta.status !== 'done' && meta.status !== 'refused' ? (
        <div className={`notice ${statusTone === 'bad' ? 'bad' : 'warn'} small`} title={meta.status === 'cancelled' ? undefined : (errorText ?? undefined)}>
          {meta.status === 'cancelled' ? 'Stopped before the answer was complete.' : errorText ? `The answer did not work: ${friendlyReason(errorText).replace(/\.$/, '')}.` : 'The answer did not work.'}
        </div>
      ) : null}
      {!running ? (
        <div className="row wrap small">
          {meta.status === 'refused' ? <Tag tone="warn">not in the case file</Tag> : null}
          {meta.uncited ? (
            <Tag tone="warn" title="The answer points to no source; check every statement yourself before relying on it.">
              no citations
            </Tag>
          ) : null}
          {unverified ? (
            <Tag tone="warn" title="Claude quoted these passages, but the words were not found in the stored page text. Open the page and read it before relying on them.">
              {unverified} quote{unverified === 1 ? '' : 's'} not found on the page
            </Tag>
          ) : null}
          {unlinked ? (
            <Tag tone="warn" title="These citations point at a line in the case summary with no detail, communication or page behind it; they cannot be opened or checked.">
              {unlinked} citation{unlinked === 1 ? '' : 's'} without a source link
            </Tag>
          ) : null}
          {meta.droppedCitations ? (
            <Tag tone="warn" title="The answer cited sources that are not on file; those statements are marked [source not found] and carry no citation.">
              {meta.droppedCitations} source{meta.droppedCitations === 1 ? '' : 's'} not found
            </Tag>
          ) : null}
        </div>
      ) : null}
      {!running ? (
        // One plain line; the model, effort, context and token numbers stay available on hover.
        <div
          className="msg-foot"
          title={[
            `${shortModel(meta.model)} · effort ${meta.effort} · context mode ${meta.contextMode}`,
            `${meta.turns} turn${meta.turns === 1 ? '' : 's'} · ${meta.toolCalls.length} tool call${meta.toolCalls.length === 1 ? '' : 's'}`,
            `${fmtTokens(meta.usage.inputTokens + meta.usage.cacheReadTokens + meta.usage.cacheWriteTokens)} tokens in / ${fmtTokens(meta.usage.outputTokens)} out${meta.usage.cacheReadTokens ? ` (${fmtTokens(meta.usage.cacheReadTokens)} cached)` : ''} · ${fmtUsd(meta.estimatedUsd)}`,
            meta.contextStats
              ? `ctx: ledger ${fmtTokens(meta.contextStats.ledgerTokens)} + ${meta.contextStats.pages} p. ≈ ${fmtTokens(meta.contextStats.countedTokens ?? meta.contextStats.totalTokensApprox)} tokens in the request`
              : null,
            meta.durationMs != null ? `took ${fmtElapsed(meta.durationMs)}` : null,
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <span>
            {[
              preset?.label ?? meta.preset,
              plainCost(meta.estimatedUsd),
              meta.contextStats
                ? meta.contextStats.pages
                  ? `read ${meta.contextStats.pages} page${meta.contextStats.pages === 1 ? '' : 's'}${meta.contextStats.ledgerTokens > 0 ? ' and the case summary' : ''}`
                  : meta.contextStats.ledgerTokens > 0
                    ? 'read the case summary'
                    : null
                : null,
              meta.durationMs != null ? `took ${plainDuration(meta.durationMs)}` : elapsed ? `took ${elapsed}` : null,
              `${citations.length} citation${citations.length === 1 ? '' : 's'}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      ) : null}
      {!running ? (
        <div className="row wrap">
          {text ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                title="Copy the answer's text"
                onClick={() => {
                  void navigator.clipboard?.writeText(text).then(
                    () => toast('Answer copied', 'ok'),
                    () => toast('Could not copy', 'bad'),
                  );
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" title="Put this answer on the To-do list, with its sources" onClick={() => onTask(m.id, { sessionId: m.sessionId, question: question ?? '', content: text, citations })}>
                Make a to-do
              </Button>
            </>
          ) : null}
          {question && !readOnly ? (
            <Button size="sm" variant="ghost" onClick={() => onRetry(question, (next ?? preset ?? presets[presets.length - 1]).key, attachments)}>
              {next ? `Retry with ${next.label}` : 'Retry'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Thread({ messages, presets, compact, readOnly, onRetry, onTask, onCitation, onLink, onFinished, onStarter }: ThreadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Stick to the bottom while content streams, unless the user scrolled up.
  const liveVersionText = messages.map((m) => m.id).join(',');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      atBottom.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [liveVersionText]);

  return (
    <div className={compact ? 'dock-thread' : 'consult-thread'} ref={ref}>
      {messages.length === 0 ? (
        readOnly ? (
          <p className="ask-empty-thread">No conversation open. Pick one in the list to read its answers; every statement cites a page you can open.</p>
        ) : (
          <div className="ask-empty-thread">
            <p>Type your question below and press Ask. Every statement in the answer cites the page it comes from; Depth sets how long the clinician looks.</p>
            {onStarter ? (
              <>
                <p className="ask-starters-head">Or start with one of these (it fills the box; nothing is sent until you press Ask):</p>
                <ul className="ask-starters">
                  {STARTERS.map((s) => (
                    <li key={s.label}>
                      <button type="button" className="btn sm" onClick={() => onStarter(s.text, s.mode)}>
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )
      ) : null}
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} m={m} presets={presets} />
        ) : (
          <AssistantMessage
            key={m.id}
            m={m}
            question={i > 0 && messages[i - 1].role === 'user' ? messages[i - 1].content : null}
            attachments={i > 0 && messages[i - 1].role === 'user' ? (messages[i - 1].meta as AskUserMeta).attachments : undefined}
            presets={presets}
            compact={compact}
            readOnly={readOnly}
            onRetry={onRetry}
            onTask={onTask}
            onCitation={onCitation}
            onLink={onLink}
            onFinished={onFinished}
          />
        ),
      )}
    </div>
  );
}
