/**
 * The question composer, top to bottom in the order you use it:
 *
 *   the question box
 *   the attached documents (when any)
 *   [Attach documents] or drop files here ……… [ ] Show Claude's reasoning  [Ask]
 *   Kind of answer: Question · Find in the records · Draft a message · Visit briefing   (To: / Visit: when it needs one)
 *   Look at: Everything · Chosen documents · Dates                                     (the date boxes when Dates)
 *   Depth: [slider] Quick · Standard · Deep · Master clinician
 *          About $0.02 · reads the case summary · takes a minute or two
 *
 * Every group is labelled. On the page the choices are segmented controls; in
 * the narrow dock they are selects, and the dock (which has no page header)
 * keeps an "Answer settings" link under the depth. The cost line is plain
 * words; the model, effort, context and token numbers stay in its hover text.
 * Owners and editors may attach documents (the button, or files dropped on the
 * composer); the question waits until Claude has read them.
 */
import { useEffect, useId, useRef, useState, type DragEvent, type RefObject } from 'react';
import { hasFiles } from '../../app/dom';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { FilterGroup, Segmented } from '../../ui/Toolbar';
import { useContextPreview } from '../../api/ask';
import { DocumentPickerDialog, EncounterSelect, PersonSelect } from './Pickers';
import { AttachmentChips, attachmentsWaiting, useAttachFiles, type AttachmentDraft, type UpdateAttachments } from './Attachments';
import { fmtTokens, fmtUsd } from './live';
import { MODE_TITLES, MODE_WORDS, depthStepWords, modePlaceholder, sendWords } from './words';
import { ASK_MAX_ATTACHMENTS, ASK_MODES, type AskMode, type AskScope } from '@shared/ask';
import { MODEL_LABELS, type ConsultPreset } from '@shared/constants';
import { WebSearchSwitch, useAskWebCap, webSearchCostWords } from '../care-team/AskWebSources';

export interface ComposerState {
  text: string;
  presetKey: string;
  mode: AskMode;
  scope: AskScope;
  personId: string | null;
  encounterId: string | null;
  /** Documents attached to the question being written. */
  attachments: AttachmentDraft[];
  /** "Search the web" for this question (off by default, and off again after each question). */
  webSearch?: boolean;
}

export const emptyComposer = (presetKey: string): ComposerState => ({ text: '', presetKey, mode: 'question', scope: {}, personId: null, encounterId: null, attachments: [], webSearch: false });

export interface ComposerProps {
  state: ComposerState;
  onChange: (patch: Partial<ComposerState>) => void;
  /** Functional update of the attachments (uploads finish after other changes). */
  onAttachments: UpdateAttachments;
  /** Owners and editors: the attach button and the drop area. */
  canAttach: boolean;
  presets: ConsultPreset[];
  running: boolean;
  sending: boolean;
  onSend: () => void;
  onStop: () => void;
  showThinking: boolean;
  onShowThinking: (v: boolean) => void;
  onOpenPresets: () => void;
  compact?: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type ScopeKind = 'all' | 'documents' | 'dates';

/** Roughly how long an answer takes at each effort, in plain words (Master is measured separately). */
const TIME_WORDS: Record<string, string> = { low: 'under a minute', medium: 'about a minute', high: 'a minute or two', xhigh: 'a few minutes', max: 'about 5 to 15 minutes' };

function plainUsd(n: number | undefined | null): string {
  if (!n || n < 0.01) return 'Less than a cent';
  return `About $${n.toFixed(2)}`;
}

/** One plain line: roughly what the answer costs, what Claude reads, how long it takes. */
export function costLine(p: { estimatedUsdInput: number; pages: number; ledgerTokens: number; fitsContext: boolean } | undefined, opts: { master: boolean; time: string; attached: number }): string {
  if (!p) return `Takes ${opts.time}`;
  const summaryIn = p.ledgerTokens > 0;
  const reads = p.pages ? `reads ${p.pages} page${p.pages === 1 ? '' : 's'}${summaryIn ? ' and the case summary' : ''}` : summaryIn ? 'reads the case summary' : 'picks the pages to read once you type a question';
  const attached = opts.attached ? ` · reads the ${opts.attached === 1 ? 'attached document' : `${opts.attached} attached documents`} first` : '';
  return `${opts.master ? 'Several dollars' : plainUsd(p.estimatedUsdInput)} · ${reads}${attached} · takes ${opts.time}${p.fitsContext ? '' : ' · too much to read at once, so some pages will be left out'}`;
}

export function Composer({ state, onChange, onAttachments, canAttach, presets, running, sending, onSend, onStop, showThinking, onShowThinking, onOpenPresets, compact, textareaRef }: ComposerProps) {
  const idx = Math.max(0, presets.findIndex((p) => p.key === state.presetKey));
  const preset = presets[idx] ?? presets[0];
  const depthId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const attachFiles = useAttachFiles(state.attachments, onAttachments);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dropOn, setDropOn] = useState(false);
  const waiting = attachmentsWaiting(state.attachments);
  const full = state.attachments.length >= ASK_MAX_ATTACHMENTS;
  // Files dropped on the composer attach to the question (the app-wide drop zone leaves data-own-drop alone).
  const dropProps = canAttach
    ? {
        'data-own-drop': '',
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropOn(true);
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(false);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDropOn(false);
          attachFiles(Array.from(e.dataTransfer.files));
        },
      }
    : {};
  const chosenDocs = state.scope.documentIds?.length ?? 0;
  const scopeKind: ScopeKind = chosenDocs ? 'documents' : state.scope.from || state.scope.to ? 'dates' : 'all';
  const [datesOpen, setDatesOpen] = useState(scopeKind === 'dates');
  const lookAt: ScopeKind = scopeKind === 'documents' ? 'documents' : datesOpen || scopeKind === 'dates' ? 'dates' : 'all';
  const debouncedText = useDebounced(state.text, 500);
  const preview = useContextPreview({ preset: preset.key, q: debouncedText, documentIds: state.scope.documentIds, from: state.scope.from, to: state.scope.to }, Boolean(preset));
  const p = preview.data;

  const setMode = (mode: AskMode) => onChange({ mode });
  const setLookAt = (v: ScopeKind) => {
    if (v === 'all') {
      onChange({ scope: {} });
      setDatesOpen(false);
    } else if (v === 'documents') setPickerOpen(true);
    else {
      onChange({ scope: { from: state.scope.from, to: state.scope.to } });
      setDatesOpen(true);
    }
  };
  const master = preset.key === 'master';
  const webCap = useAskWebCap();
  const time = master ? 'about 5 to 15 minutes' : (TIME_WORDS[preset.effort] ?? 'a minute or two');
  const plainLine = `${p ? costLine(p, { master, time, attached: state.attachments.length }) : preview.isFetching ? 'Working out the cost…' : preview.isError ? `Cost not known yet · takes ${time}` : `Takes ${time}`}${state.webSearch ? webSearchCostWords(preset.model, webCap) : ''}`;
  // The technical numbers stay available on hover.
  const details = [
    `${MODEL_LABELS[preset.model]?.replace(/\s*\(.*\)$/, '') ?? preset.model} · effort ${preset.effort} · context mode ${preset.contextMode} · max ${fmtTokens(preset.maxContextTokens)} tokens`,
    p
      ? `ledger ${fmtTokens(p.ledgerTokens)} tokens · ${p.pages} page${p.pages === 1 ? '' : 's'} ${fmtTokens(p.pageTokens)} tokens · ≈${fmtTokens(p.totalTokensApprox)} tokens in the request · ${fmtUsd(p.estimatedUsdInput)} input cost (the written answer adds to it)${p.fitsContext ? '' : ` · exceeds the ${fmtTokens(p.contextWindow)} context window; pages will be dropped`}`
      : null,
    master ? 'Master answer measured: 53k tokens at max effort took 8 minutes and about 6 dollars' : null,
    preset.hint,
  ]
    .filter(Boolean)
    .join('\n');

  const send = () => {
    if (!state.text.trim()) {
      textareaRef.current?.focus();
      return;
    }
    onSend();
  };

  const lookAtOptions = [
    { value: 'all' as const, label: 'Everything', title: 'The whole case: every document, detail and record' },
    { value: 'documents' as const, label: chosenDocs ? `Chosen documents (${chosenDocs})` : 'Chosen documents', title: 'Only the documents you choose' },
    { value: 'dates' as const, label: 'Dates', title: 'Only what falls between two dates' },
  ];

  return (
    <div className={`${compact ? 'dock-composer' : 'consult-composer'}${dropOn ? ' drop-on' : ''}`} {...dropProps}>
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        rows={3}
        placeholder={modePlaceholder(state.mode)}
        value={state.text}
        onChange={(e) => onChange({ text: e.target.value })}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!running && !sending) send();
          } else if (e.key === 'Escape') {
            if (running) {
              e.preventDefault();
              onStop();
            } else {
              (e.target as HTMLTextAreaElement).blur();
            }
          }
        }}
        aria-label={`${MODE_WORDS[state.mode]}: ${modePlaceholder(state.mode)}`}
      />
      {canAttach ? <AttachmentChips list={state.attachments} update={onAttachments} /> : null}
      <div className="ask-send-row">
        {canAttach ? (
          <span className="ask-attach-bar">
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={full} title={full ? `A question can carry at most ${ASK_MAX_ATTACHMENTS} documents.` : 'Add files to Documents and attach them to this question'}>
              Attach documents
            </Button>
            <span className="ask-attach-hint">{dropOn ? 'Drop to attach' : state.attachments.length || compact ? '' : 'or drop files here'}</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                attachFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </span>
        ) : null}
        <span className="grow" />
        <WebSearchSwitch on={Boolean(state.webSearch)} onChange={(v) => onChange({ webSearch: v })} compact={compact} />
        <label className="ask-check" title="Show the summary of how Claude reasoned, above each answer">
          <input type="checkbox" checked={showThinking} onChange={(e) => onShowThinking(e.target.checked)} />
          {compact ? 'Show reasoning' : 'Show Claude’s reasoning'}
        </label>
        {running ? (
          <Button variant="danger" onClick={onStop} shortcut="esc" title="Stop the answer being written; what is written so far is kept">
            Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={send} disabled={sending || waiting > 0} shortcut="ctrl+enter" title={state.text.trim() ? 'Send the question (Ctrl+Enter)' : 'Type a question first'}>
            {waiting ? `Waiting for Claude to read the ${waiting === 1 ? 'attachment' : 'attachments'}…` : sending ? 'Sending…' : sendWords(state.mode)}
          </Button>
        )}
      </div>
      <div className="ask-options">
        <span className="ask-option">
          {compact ? (
            <FilterGroup label="Kind of answer">
              <Select value={state.mode} options={ASK_MODES.map((m) => ({ value: m, label: MODE_WORDS[m] }))} onChange={(e) => setMode(e.target.value as AskMode)} aria-label="Kind of answer" />
            </FilterGroup>
          ) : (
            <Segmented label="Kind of answer" value={state.mode} onChange={setMode} options={ASK_MODES.map((m) => ({ value: m, label: MODE_WORDS[m], title: MODE_TITLES[m] }))} />
          )}
          <PersonSelect enabled={state.mode === 'draft'} value={state.personId} onChange={(id) => onChange({ personId: id })} />
          <EncounterSelect enabled={state.mode === 'briefing'} value={state.encounterId} onChange={(id) => onChange({ encounterId: id })} />
        </span>
        <span className="ask-option">
          {compact ? (
            <FilterGroup label="Look at">
              <Select value={lookAt} options={lookAtOptions} onChange={(e) => setLookAt(e.target.value as ScopeKind)} aria-label="Look at" />
            </FilterGroup>
          ) : (
            <Segmented label="Look at" value={lookAt} onChange={setLookAt} options={lookAtOptions} />
          )}
          {lookAt === 'documents' ? (
            <Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)}>
              {chosenDocs ? 'Change' : 'Choose'}
            </Button>
          ) : null}
          {lookAt === 'dates' ? (
            <span className="date-range">
              <input type="text" inputMode="numeric" value={state.scope.from ?? ''} placeholder="YYYY-MM" aria-label="From date (YYYY, YYYY-MM or YYYY-MM-DD)" onChange={(e) => onChange({ scope: { ...state.scope, documentIds: undefined, from: e.target.value.trim() || undefined } })} />
              <span className="date-range-sep">to</span>
              <input type="text" inputMode="numeric" value={state.scope.to ?? ''} placeholder="YYYY-MM" aria-label="To date (YYYY, YYYY-MM or YYYY-MM-DD)" onChange={(e) => onChange({ scope: { ...state.scope, documentIds: undefined, to: e.target.value.trim() || undefined } })} />
            </span>
          ) : null}
        </span>
      </div>
      <div className="filter-group ask-depth" role="group" aria-labelledby={depthId}>
        <span className="filter-label" id={depthId}>
          Depth
        </span>
        <div className="ask-depth-control">
          <input
            type="range"
            min={0}
            max={Math.max(0, presets.length - 1)}
            step={1}
            value={idx}
            aria-label="Depth of the answer"
            aria-valuetext={preset.label}
            onChange={(e) => onChange({ presetKey: presets[Number(e.target.value)]?.key ?? state.presetKey })}
            onKeyDown={(e) => {
              if (e.key === '[' || e.key === ']') {
                e.preventDefault();
                const next = presets[Math.max(0, Math.min(presets.length - 1, idx + (e.key === ']' ? 1 : -1)))];
                if (next) onChange({ presetKey: next.key });
              }
            }}
          />
          <div className="ask-depth-stops">
            {presets.map((pr) => (
              <button key={pr.key} type="button" tabIndex={-1} className={pr.key === preset.key ? 'on' : undefined} aria-pressed={pr.key === preset.key} title={depthStepWords(pr)} onClick={() => onChange({ presetKey: pr.key })}>
                {pr.label}
              </button>
            ))}
          </div>
          <div className="ask-cost" title={details}>
            {plainLine}
            {compact ? (
              <>
                {' · '}
                <button type="button" className="ask-link" onClick={onOpenPresets}>
                  Answer settings
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <DocumentPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} selected={state.scope.documentIds ?? []} 
        onApply={(ids) => {
          onChange({ scope: ids.length ? { documentIds: ids } : {} });
          setDatesOpen(false);
        }}
      />
    </div>
  );
}
