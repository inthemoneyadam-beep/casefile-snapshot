/**
 * Past checks: every time the records were checked across each other, what it found and (for Claude's checks) what it
 * cost. The list says what ran, when, how it went and what it found; the pane adds the cost in words and keeps the
 * technical figures (the model, tokens, what the AI pass dropped) under a closed "Technical details".
 */
import { useMemo } from 'react';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { Tag, type TagTone } from '../../ui/StatusTag';
import { DateTimeText, KeepDatesWhole } from '../../ui/DateText';
import { Section } from '../../ui/PageHeader';
import { DetailHeader, DetailPane, KeyFacts } from '../../ui/DetailPane';
import { Loading } from '../../ui/PageHeader';
import { MODEL_LABELS } from '@shared/constants';
import { RULE_LABELS, type Run, type RunDetail } from '../../api/findings';
import { AnswerTag, SeverityTag } from './FindingDetail';
import { countWords } from './words';

/** The one rule a partial run ran (the precedence pass after an extraction, the lab checks), in words. */
function partialRuleLabel(rule: string): string {
  if (rule === 'patient_precedence') return 'precedence';
  return RULE_LABELS[rule] ?? rule.replace(/_/g, ' ');
}

/** What started a run of one rule, in words: after an extraction, after unlocking (the lab checks), or by hand. */
export function triggerWords(trigger: string | null | undefined): string {
  if (trigger === 'extraction') return 'after an extraction';
  if (trigger === 'unlock') return 'after unlocking';
  return 'run by hand';
}

/** What ran, in a few words: the built-in checks, Claude's check (deep or not), or one check only. */
export function runKind(r: Pick<Run, 'rulesOnly' | 'deep' | 'model' | 'scope'>): string {
  if (r.scope.rule) return `${partialRuleLabel(r.scope.rule)} only`;
  if (r.rulesOnly) return 'built-in checks';
  return r.deep ? "Claude's deep check" : "Claude's check";
}

/** runKind with a capital, for a title or the start of a cell. */
export function runKindTitle(r: Pick<Run, 'rulesOnly' | 'deep' | 'model' | 'scope'>): string {
  const k = runKind(r);
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** How a check went, as a tag in words. */
const RUN_STATUS: Record<string, { label: string; tone: TagTone }> = {
  queued: { label: 'waiting to start', tone: 'neutral' },
  running: { label: 'running', tone: 'info' },
  done: { label: 'finished', tone: 'ok' },
  failed: { label: 'did not work', tone: 'bad' },
  cancelled: { label: 'stopped', tone: 'ash' },
};
export function RunStatusTag({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? { label: status, tone: 'neutral' as TagTone };
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

function scopeText(run: Run): string {
  const parts: string[] = [];
  if (run.scope.rule) parts.push(`${partialRuleLabel(run.scope.rule)} only, ${triggerWords(run.scope.trigger)}`);
  if (run.scope.documentIds?.length) parts.push(countWords(run.scope.documentIds.length, 'document'));
  if (run.scope.from) parts.push(`from ${run.scope.from}`);
  if (run.scope.to) parts.push(`to ${run.scope.to}`);
  if (!run.scope.documentIds?.length && !run.scope.from && !run.scope.to) parts.push('the whole case');
  return parts.join(' · ');
}

function aiStatsText(s: NonNullable<Run['aiStats']>): string {
  const dropped = [s.droppedNoEvidence ? `${s.droppedNoEvidence} without usable evidence` : null, s.droppedWording ? `${s.droppedWording} worded as a diagnosis` : null].filter(Boolean);
  return [`${s.returned} suggested`, `${s.kept} kept`, dropped.length ? `left out ${dropped.join(', ')}` : 'none left out', s.droppedIds ? `${s.droppedIds} unknown references ignored` : null].filter(Boolean).join(' · ');
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtUsd(n: number): string {
  return n ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '$0';
}

export function fmtDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The cost of a check in words: free for the built-in checks, else the estimate. */
export function costWords(r: Pick<Run, 'usage' | 'rulesOnly'>): string {
  if (!r.usage.calls) return r.rulesOnly ? 'free (no AI)' : '$0';
  return fmtUsd(r.usage.estimatedUsd);
}

export function RunsTable({ items, selectedId, onSelect, onOpen, loading }: { items: Run[]; selectedId: string | null; onSelect: (r: Run | null) => void; onOpen: (r: Run) => void; loading: boolean }) {
  const columns = useMemo<ColumnDef<Run, unknown>[]>(
    () => [
      { id: 'started', header: 'When', accessorKey: 'startedAt', cell: ({ row }) => <DateTimeText iso={row.original.startedAt} />, meta: { width: 132, shrink: false } },
      {
        id: 'kind',
        header: 'What ran',
        accessorFn: (r) => runKindTitle(r),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span>
              {runKindTitle(r)}
              {r.scope.rule ? <span className="muted"> {triggerWords(r.scope.trigger)}</span> : null}
              {r.error ? <span className="findings-sub bad"> · {r.error.slice(0, 80)}</span> : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: 150 },
      },
      { id: 'status', header: 'How it went', accessorKey: 'status', cell: ({ getValue }) => <RunStatusTag status={String(getValue())} />, meta: { width: 100 } },
      { id: 'findings', header: 'Found', accessorKey: 'findingsCount', cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { width: 64, className: 'num' } },
      { id: 'usd', header: 'Cost (est.)', accessorFn: (r) => r.usage.estimatedUsd, cell: ({ row }) => <span className={row.original.usage.calls ? 'mono' : 'muted'}>{costWords(row.original)}</span>, meta: { width: 104 } },
    ],
    [],
  );
  if (loading && !items.length) return <Loading>Loading past checks…</Loading>;
  return (
    <DataTable
      columns={columns}
      data={items}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      initialSort={[{ id: 'started', desc: true }]}
      emptyText="No checks yet."
      tableId="findings.runs"
      autoFocus
    />
  );
}

export function RunDetailPanel({ run, onOpenFinding, onRerun }: { run: RunDetail; onOpenFinding: (id: string) => void; onRerun: () => void }) {
  const u = run.usage;
  return (
    <DetailPane label="Past check">
      <DetailHeader
        eyebrow={
          <>
            <RunStatusTag status={run.status} />
            <span>Check of the records</span>
          </>
        }
        title={
          <>
            {runKindTitle(run)}, <DateTimeText iso={run.startedAt} />
          </>
        }
        status={[countWords(run.findingsCount, 'finding'), u.calls ? `cost about ${fmtUsd(u.estimatedUsd)}` : 'no cost (no AI)', run.status === 'running' && run.job?.progressText ? run.job.progressText : null]}
        actions={{ secondary: [{ label: 'Run the built-in checks again', onClick: onRerun, title: 'Compare the records with each other again (no AI, no cost)' }] }}
        facts={[
          { label: 'Started', value: <DateTimeText iso={run.startedAt} /> },
          { label: 'Finished', value: run.finishedAt ? <DateTimeText iso={run.finishedAt} /> : <span className="muted">not yet</span> },
          { label: 'Looked at', value: scopeText(run) },
          u.calls ? { label: 'Cost (est.)', value: fmtUsd(u.estimatedUsd), mono: true } : null,
          u.calls ? { label: 'Time Claude took', value: fmtDuration(u.durationMs), mono: true } : null,
        ]}
      />
      {run.error ? <div className="notice bad small">This check did not finish: {run.error}</div> : null}
      <Section title="What it found" count={run.findings.length}>
        {run.findings.length ? (
          <div className="findings-runlist">
            {run.findings.map((f) => (
              <a
                key={f.id}
                href={`/findings?id=${f.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenFinding(f.id);
                }}
              >
                <span className="findings-runlist-title" title={f.title}>
                  <KeepDatesWhole text={f.title} />
                </span>
                <span>
                  <SeverityTag severity={f.severity} />
                </span>
                <span>
                  <AnswerTag status={f.status} />
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="section-intro">{run.status === 'running' ? 'Still running.' : 'This check found nothing new.'}</p>
        )}
      </Section>
      {u.calls || run.aiStats || run.model ? (
        <details className="findings-tech">
          <summary>Technical details</summary>
          <KeyFacts
            items={[
              { label: 'Model', value: run.model ? (MODEL_LABELS[run.model] ?? run.model) : 'none (built-in checks only)' },
              { label: 'Calls to Claude', value: String(u.calls), mono: true },
              { label: 'Text sent', value: `${fmtTokens(u.inputTokens)} tokens (${fmtTokens(u.cacheReadTokens)} reused)`, mono: true },
              { label: 'Text received', value: `${fmtTokens(u.outputTokens)} tokens`, mono: true },
              run.aiStats ? { label: "Claude's suggestions", value: aiStatsText(run.aiStats), wide: true } : null,
            ]}
          />
        </details>
      ) : null}
    </DetailPane>
  );
}
