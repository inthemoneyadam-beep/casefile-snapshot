/**
 * /ai-log — the AI usage log: every request sent to Claude (or blocked before it left), what it was for, how much
 * was sent and came back, what it cost, and the documents it carried. Nothing leaves this computer without a row
 * here. List left, the chosen request right (?id=); Purpose:, Result: and Find narrow the list. Model ids, call ids
 * and document ids never show as such: models by name, documents by their titles (ids in hover text).
 */
import { useCallback, useMemo, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { aiKeys, useAiCalls, type AiCall } from '../api/ai';
import { useDocuments } from '../api/documents';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { Button } from '../ui/Button';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { DateTimeText } from '../ui/DateText';
import { DetailHeader, DetailPane } from '../ui/DetailPane';
import { Select } from '../ui/Field';
import { EmptyState, Loading, PageHeader, Section } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { Tag } from '../ui/StatusTag';
import { FilterGroup, SearchField, Toolbar } from '../ui/Toolbar';
import { ToolbarKeys } from '../ui/Toolbar';
import { modelWords } from '../features/settings/words';
import { STOP_WORDS, errorWords, purposeWords, resultWords, summaryWords } from '../features/ai-log/words';
import '../features/ai-log/ai-log.css';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  purpose: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/ai-log')({ component: AiLogPage, validateSearch: searchSchema });

function docIds(row: AiCall): string[] {
  try {
    const v = JSON.parse(row.documentIdsJson);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const n = (v: number) => v.toLocaleString();
const usd = (v: number) => (v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function AiLogPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const setSearch = useCallback((patch: Partial<Search>, replace = false) => void navigate({ search: (prev: Search) => ({ ...prev, ...patch }), replace }), [navigate]);

  const calls = useAiCalls();
  const documents = useDocuments({});
  const docTitle = useMemo(() => new Map((documents.data?.items ?? []).map((d) => [d.id, d.title])), [documents.data]);
  const all = useMemo(() => calls.data?.items ?? [], [calls.data]);
  const purposes = useMemo(() => [...new Set(all.map((c) => c.purpose))].sort(), [all]);
  const statuses = useMemo(() => [...new Set(all.map((c) => c.status))].sort(), [all]);
  const rows = useMemo(() => all.filter((c) => (!search.purpose || c.purpose === search.purpose) && (!search.status || c.status === search.status)), [all, search.purpose, search.status]);
  const [filter, setFilter] = useState('');

  const sum = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.sent += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
          acc.back += r.outputTokens;
          acc.usd += r.estimatedUsd;
          return acc;
        },
        { sent: 0, back: 0, usd: 0 },
      ),
    [rows],
  );

  const selected = useMemo(() => (search.id ? (all.find((c) => c.id === search.id) ?? null) : null), [all, search.id]);

  const columns = useMemo<ColumnDef<AiCall, unknown>[]>(
    () => [
      { id: 'time', header: 'When', accessorKey: 'createdAt', cell: (c) => <DateTimeText iso={c.row.original.createdAt} />, meta: { width: 140, shrink: false } },
      {
        id: 'purpose',
        header: 'What for',
        accessorFn: (r) => `${purposeWords(r.purpose)} ${summaryWords(r.purpose, r.requestSummary) ?? ''}`,
        cell: (c) => (
          <span>
            {purposeWords(c.row.original.purpose)}
            {summaryWords(c.row.original.purpose, c.row.original.requestSummary) ? <span className="muted"> · {summaryWords(c.row.original.purpose, c.row.original.requestSummary)}</span> : null}
          </span>
        ),
        meta: { grow: true, minWidth: 180 },
      },
      {
        id: 'status',
        header: 'Result',
        accessorFn: (r) => resultWords(r.status).label,
        cell: (c) => {
          const w = resultWords(c.row.original.status);
          return (
            <Tag tone={w.tone} title={w.title}>
              {w.label}
            </Tag>
          );
        },
        meta: { width: 90, shrink: false },
      },
      { id: 'sent', header: 'Sent', accessorFn: (r) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, cell: (c) => n(c.getValue() as number), meta: { className: 'num', width: 70 } },
      { id: 'back', header: 'Back', accessorKey: 'outputTokens', cell: (c) => n(c.row.original.outputTokens), meta: { className: 'num', width: 64 } },
      { id: 'usd', header: 'Cost (est.)', accessorKey: 'estimatedUsd', cell: (c) => usd(c.row.original.estimatedUsd), meta: { className: 'num', width: 84 } },
    ],
    [],
  );

  const open = useCallback(
    (row: AiCall | null) => {
      const first = row ? docIds(row)[0] : null;
      if (first) void navigate({ to: '/documents/$id', params: { id: first } });
    },
    [navigate],
  );

  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: aiKeys.calls }), [qc]);
  const clearFilters = useCallback(() => {
    setFilter('');
    setSearch({ purpose: undefined, status: undefined });
  }, [setSearch]);
  const anyFilter = Boolean(search.purpose || search.status || filter);

  useBindings([{ keys: 'r', description: 'Refresh the AI usage log', group: 'Page', run: refresh }], [refresh]);
  useRegisterCommands(
    [
      { id: 'ai-log.refresh', title: 'AI usage log: refresh', group: 'Page', shortcut: 'r', run: refresh },
      { id: 'ai-log.clear', title: 'AI usage log: clear filters', group: 'Page', when: () => anyFilter, run: clearFilters },
    ],
    [refresh, clearFilters, anyFilter],
  );

  const totals = calls.data?.totals;

  const left = calls.isPending ? (
    <Loading>Loading the log…</Loading>
  ) : calls.isError ? (
    <Loading>Could not load the AI usage log.</Loading>
  ) : (
    <DataTable
      columns={columns}
      data={rows}
      rowId={(r) => r.id}
      selectedId={search.id ?? null}
      onSelect={(r) => setSearch({ id: r?.id }, true)}
      onOpen={open}
      initialSort={[{ id: 'time', desc: true }]}
      globalFilter={filter}
      emptyText={anyFilter ? 'No request matches these filters.' : 'No requests yet.'}
      tableId="ai-log.calls"
      footer={
        <span>
          Shown: <span className="mono">{n(sum.sent)}</span> tokens sent, <span className="mono">{n(sum.back)}</span> back, about <span className="mono">{usd(sum.usd)}</span>
        </span>
      }
      autoFocus
    />
  );

  const ids = selected ? docIds(selected) : [];
  const ew = selected?.error ? errorWords(selected.error) : null;
  const right = selected ? (
    <DetailPane label="Request">
      <DetailHeader
        eyebrow={
          <>
            <Tag tone={resultWords(selected.status).tone} title={resultWords(selected.status).title}>
              {resultWords(selected.status).label}
            </Tag>
            <span>{purposeWords(selected.purpose)}</span>
          </>
        }
        title={summaryWords(selected.purpose, selected.requestSummary) ?? purposeWords(selected.purpose)}
        titleHint={`Request ${selected.id}`}
        status={[<DateTimeText key="t" iso={selected.createdAt} />, selected.durationMs ? <span key="d" className="mono">{secs(selected.durationMs)}</span> : null, <span key="u">about <span className="mono">{usd(selected.estimatedUsd)}</span></span>]}
        actions={ids.length ? { primary: { label: ids.length === 1 ? 'Open the document' : 'Open the first document', onClick: () => open(selected), title: 'The document this request carried (Enter)' } } : undefined}
        facts={[
          { label: 'Model', value: modelWords(selected.model) || null, title: selected.model },
          { label: 'Tokens sent', value: n(selected.inputTokens), mono: true },
          { label: 'Tokens back', value: n(selected.outputTokens), mono: true },
          selected.cacheReadTokens ? { label: 'Reused from before', value: n(selected.cacheReadTokens), mono: true, title: 'Tokens read from the cache, which cost less' } : null,
          selected.cacheWriteTokens ? { label: 'Kept for reuse', value: n(selected.cacheWriteTokens), mono: true, title: 'Tokens written to the cache' } : null,
          selected.stopReason ? { label: 'How it ended', value: STOP_WORDS[selected.stopReason] ?? selected.stopReason } : null,
        ]}
      />
      {selected.error ? (
        <div className="notice bad">
          {ew ? <strong>{ew} </strong> : null}
          <span className="ai-log-error">{selected.error}</span>
        </div>
      ) : null}
      <Section title="Documents sent" count={ids.length}>
        {ids.length ? (
          <ul className="ai-log-docs">
            {ids.map((id) => (
              <li key={id}>
                <Link to="/documents/$id" params={{ id }} title={`Document ${id}`}>
                  {docTitle.get(id) ?? 'A document no longer in the list'}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No documents were sent with this request.</p>
        )}
      </Section>
    </DetailPane>
  ) : all.length ? (
    <EmptyState title="Pick a request">See what it was for, what it cost, any error, and the documents it carried. Move with j and k; Enter opens its first document.</EmptyState>
  ) : null;

  const nothingYet = calls.isSuccess && !all.length;

  return (
    <div className="page">
      <PageHeader
        title="AI usage log"
        meta={
          totals && totals.calls ? (
            <span>
              <span className="mono">{n(totals.calls)}</span> {totals.calls === 1 ? 'request' : 'requests'} in all · <span className="mono">{n(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}</span> tokens sent · <span className="mono">{n(totals.outputTokens)}</span> back · about{' '}
              <span className="mono">{usd(totals.estimatedUsd)}</span>
            </span>
          ) : null
        }
        intro="Every request sent to Claude, or stopped before it left this computer: what it was for, what it cost, and the documents it carried."
        actions={{ secondary: [{ label: 'Refresh', onClick: refresh, shortcut: 'r', title: 'The log also refreshes by itself every 10 seconds' }] }}
      />
      <Toolbar label="Filters">
        <FilterGroup label="Purpose">
          <Select options={purposes.map((p) => ({ value: p, label: purposeWords(p) }))} placeholder="Everything" value={search.purpose ?? ''} onChange={(e) => setSearch({ purpose: e.target.value || undefined })} aria-label="Purpose" />
        </FilterGroup>
        <FilterGroup label="Result">
          <Select options={statuses.map((st) => ({ value: st, label: resultWords(st).label }))} placeholder="Any" value={search.status ?? ''} onChange={(e) => setSearch({ status: e.target.value || undefined })} aria-label="Result" />
        </FilterGroup>
        <SearchField label="Find" placeholder="What it was for, or a document" value={filter} onChange={setFilter} width={240} />
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['enter', 'open the document'],
            ['esc', 'clear'],
            ['r', 'refresh'],
            ['/', 'find'],
          ]}
        >
          {anyFilter ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      <div className="page-body flush">
        {nothingYet ? (
          <EmptyState
            title="No requests yet"
            action={
              <Button variant="primary" onClick={() => void navigate({ to: '/settings' })}>
                Open Settings, AI
              </Button>
            }
          >
            Claude is contacted only when you start something that needs it: reading a document, asking the clinician, checking across the records. Each request will be listed here with what it cost. To try the connection, use Test the connection in Settings.
          </EmptyState>
        ) : (
          <SplitView storageKey="ai-log" defaultLeft={60} minLeft={460} minRight={400} left={left} right={right} />
        )}
      </div>
    </div>
  );
}
