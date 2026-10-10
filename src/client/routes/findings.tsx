/**
 * /findings — What Claude noticed: contradictions, gaps and patterns found by reading the records together. Split
 * view: the findings left, the selected one right with the records behind it. Selection, the view and every filter
 * live in the URL. Answer keys c / r / x / d / u, t makes a to-do, Enter opens the first record behind it. Past checks
 * (view=runs) lists every check with what it found and what it cost.
 *
 * Findings are prompts for a human look, never diagnoses (said once, in the page's intro).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { FINDING_CATEGORIES, FINDING_SEVERITIES, FINDING_STATUSES } from '@shared/enums';
import { ApiError, useFailToast } from '../api/client';
import { useActiveJobs, useSettings } from '../api/hooks';
import { fetchFinding, findingKeys, isPartialRun, useFinding, useFindingMutations, useFindingsList, useRun, useRuns, type FindingDetail as FindingDetailData, type FindingListItem, type Run } from '../api/findings';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { moveToNextRow } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { DateText, DateTimeText, KeepDatesWhole } from '../ui/DateText';
import { useToast } from '../ui/Toast';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { AnswerTag, FindingDetail, SeverityTag, evidenceTarget, type NoteDraft } from '../features/findings/FindingDetail';
import { RunsTable, RunDetailPanel, runKind } from '../features/findings/RunsView';
import { TaskDialog } from '../features/findings/TaskDialog';
import { ANSWER_ORDER, CATEGORY_TITLES, SEVERITY_ORDER, answerWords, categoryWords, countWords, severityWords } from '../features/findings/words';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/findings/findings.css';

const VIEWS = ['all', 'runs'] as const;
type View = (typeof VIEWS)[number];

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  category: z.enum(FINDING_CATEGORIES).optional().catch(undefined),
  status: z.enum(FINDING_STATUSES).optional().catch(undefined),
  severity: z.enum(FINDING_SEVERITIES).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
});
export type FindingsSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/findings')({
  validateSearch: (s: Record<string, unknown>): FindingsSearch => searchSchema.parse(s),
  component: FindingsPage,
});

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const STATUS_RANK: Record<string, number> = { new: 0, confirmed: 1, disputed: 2, resolved: 3, dismissed: 4 };

const INTRO = 'Contradictions, gaps and patterns found by reading your records together, each linked to the records it came from. They are prompts for a human look, never diagnoses.';
/** What each view holds, in one line under the toolbar. */
const VIEW_LINE: Record<View, { lead: string; text: string }> = {
  all: { lead: 'Noticed.', text: 'Answer each one when you have looked: Is this right? Yes, needs follow-up keeps it open; Yes, done or Doesn\'t matter closes it; Incorrect says Claude got it wrong. Nothing in your records changes.' },
  runs: { lead: 'Past checks.', text: 'Every time the records were checked against each other: what ran, what it found and, for Claude’s checks, what it cost.' },
};

function FindingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const canWrite = useMe().canWrite;
  const view: View = search.view ?? 'all';
  const selectedId = search.id ?? null;

  const jobs = useActiveJobs();
  const aiRunning = (jobs.data?.items ?? []).some((j) => j.type === 'crossref');
  const poll = aiRunning ? 2500 : false;
  const listParams = useMemo(() => ({ category: search.category, status: search.status, severity: search.severity, q: search.q, limit: 2000 }), [search.category, search.status, search.severity, search.q]);
  const list = useFindingsList(listParams, { refetchInterval: poll });
  const runs = useRuns({ refetchInterval: poll });
  const settings = useSettings();
  const detail = useFinding(view === 'all' ? selectedId : null);
  const runDetail = useRun(view === 'runs' ? selectedId : null);
  const m = useFindingMutations();
  const qc = useQueryClient();

  const items = list.data?.items ?? [];
  const counts = list.data?.counts;
  const runItems = runs.data?.items ?? [];
  // The precedence pass after each extraction is a run of one rule; the header reports the last real run.
  const lastRun = runItems.find((r) => !isPartialRun(r));
  const everChecked = Boolean(lastRun);

  const [taskOpen, setTaskOpen] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const busy = m.verdict.isPending || m.toTask.isPending || m.run.isPending;
  const aiAvailable = Boolean(settings.data?.['ai.enabled'] && settings.data?.['ai.apiKeySet']);

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q, id: undefined }), replace: true }));

  const tableRef = useRef<HTMLDivElement>(null);

  function setSearch(patch: Partial<FindingsSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function setView(v: View) {
    setSearch({ view: v === 'all' ? undefined : v, id: undefined }, false);
  }
  function openFinding(id: string) {
    setSearch({ view: undefined, id }, false);
  }
  function clearFilters() {
    setQLocal('');
    setSearch({ category: undefined, status: undefined, severity: undefined, q: undefined, id: undefined });
  }

  // Latest state for key bindings and commands registered once.
  const latest = useRef({ view, selectedId, detail: detail.data ?? null, taskOpen, busy, canWrite });
  latest.current = { view, selectedId, detail: detail.data ?? null, taskOpen, busy, canWrite };
  const hasSelection = () => latest.current.view === 'all' && Boolean(latest.current.selectedId) && !latest.current.taskOpen && latest.current.canWrite;

  // The verdict note as typed in the detail pane; a key verdict sends it along when it is unsaved.
  const noteDraft = useRef<NoteDraft | null>(null);
  const onNoteDraft = useCallback((draft: NoteDraft) => {
    noteDraft.current = draft;
  }, []);

  function verdict(status: string, note?: string | null, moveOn = false) {
    const id = latest.current.selectedId;
    if (!id || latest.current.view !== 'all') return;
    if (note === undefined) {
      const typed = noteDraft.current;
      if (typed && typed.findingId === id && typed.dirty) note = typed.note;
    }
    m.verdict.mutate(
      { id, status, note },
      {
        onSuccess: () => {
          if (moveOn) moveToNextRow(tableRef.current);
        },
        onError: fail,
      },
    );
  }
  function runRules(deep: boolean | null) {
    m.run.mutate(deep === null ? { rulesOnly: true } : { deep }, {
      onSuccess: (r) => {
        const s = r.rules;
        const summary = `Checked: ${s.created} new, ${s.updated} updated, ${s.unchanged} unchanged${s.retired ? `, ${s.retired} no longer apply` : ''}`;
        toast(r.jobId ? `${summary}. Claude's ${deep ? 'deep ' : ''}check has started; what it finds shows here.` : summary, 'ok');
      },
      onError: fail,
    });
  }
  /** Enter: the first record behind it. When the detail has not loaded yet (Enter straight after j, or on a deep link) it is fetched first. */
  async function openEvidence(row: Pick<FindingListItem, 'id'>) {
    const loaded = latest.current.detail;
    let d: FindingDetailData;
    if (loaded && loaded.id === row.id) {
      d = loaded;
    } else {
      try {
        d = await qc.fetchQuery({ queryKey: findingKeys.detail(row.id), queryFn: () => fetchFinding(row.id) });
      } catch (err) {
        fail(err);
        return;
      }
    }
    const target = d.evidence.map(evidenceTarget).find((t) => t !== null);
    if (!target) {
      toast('Nothing behind this one can be opened', 'info');
      return;
    }
    // target.to is a page held as a string, so the router cannot type it, its params or its search: the casts stay.
    void navigate({ to: target.to as never, params: (target.params ?? {}) as never, search: (target.search ?? {}) as never });
  }

  useBindings(
    [
      { keys: 'c', description: 'Yes, needs follow-up (the selected finding)', group: 'Findings', when: hasSelection, run: () => verdict('confirmed', undefined, true) },
      { keys: 'r', description: 'Yes, done (the selected finding)', group: 'Findings', when: hasSelection, run: () => verdict('resolved', undefined, true) },
      { keys: 'x', description: "Doesn't matter (the selected finding)", group: 'Findings', when: hasSelection, run: () => verdict('dismissed', undefined, true) },
      { keys: 'd', description: 'Incorrect (the selected finding)', group: 'Findings', when: hasSelection, run: () => verdict('disputed', undefined, true) },
      { keys: 'u', description: 'Undo my answer', group: 'Findings', when: hasSelection, run: () => verdict('new') },
      { keys: 't', description: 'Add the selected finding to the to-do list', group: 'Findings', when: hasSelection, run: () => setTaskOpen(true) },
      { keys: 'v v', description: 'Next view: noticed, past checks', group: 'Lists', run: () => !document.querySelector('dialog[open]') && setView(latest.current.view === 'all' ? 'runs' : 'all') },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'findings.run-rules', title: 'What Claude noticed: run the built-in checks (no AI, no cost)', group: 'Findings', keywords: 'run rules crossref cross-reference check again discrepancies gaps trends', when: () => latest.current.canWrite, run: () => runRules(null) },
      { id: 'findings.run-standard', title: 'What Claude noticed: check with Claude (uses the AI)', group: 'Findings', keywords: 'run crossref cross-reference ai pass model', when: () => latest.current.canWrite, run: () => runRules(false) },
      { id: 'findings.run-deep', title: 'What Claude noticed: deep check with Claude (uses the AI)', group: 'Findings', keywords: 'run crossref cross-reference ai deep pass opus', when: () => latest.current.canWrite, run: () => runRules(true) },
      { id: 'findings.new', title: 'What Claude noticed: show new ones', group: 'Findings', keywords: 'new findings', run: () => setSearch({ view: undefined, status: 'new', id: undefined }, false) },
      { id: 'findings.all', title: 'What Claude noticed: show everything', group: 'Findings', keywords: 'all findings clear filters', run: () => setSearch({ view: undefined, status: undefined, category: undefined, severity: undefined, q: undefined, id: undefined }, false) },
      { id: 'findings.runs', title: 'What Claude noticed: past checks', group: 'Findings', keywords: 'runs cross-reference tokens usage cost', shortcut: 'v v', run: () => setView('runs') },
      { id: 'findings.confirm', title: 'Finding: yes, needs follow-up', group: 'Findings', shortcut: 'c', keywords: 'verdict agree confirm', when: hasSelection, run: () => verdict('confirmed', undefined, true) },
      { id: 'findings.resolve', title: 'Finding: yes, done', group: 'Findings', shortcut: 'r', keywords: 'verdict done handled resolve', when: hasSelection, run: () => verdict('resolved', undefined, true) },
      { id: 'findings.dismiss', title: "Finding: doesn't matter", group: 'Findings', shortcut: 'x', keywords: 'verdict ignore not relevant dismiss', when: hasSelection, run: () => verdict('dismissed', undefined, true) },
      { id: 'findings.dispute', title: 'Finding: incorrect', group: 'Findings', shortcut: 'd', keywords: 'verdict wrong disagree dispute', when: hasSelection, run: () => verdict('disputed', undefined, true) },
      { id: 'findings.reset', title: 'Finding: undo my answer', group: 'Findings', shortcut: 'u', keywords: 'verdict undo reopen', when: hasSelection, run: () => verdict('new') },
      { id: 'findings.task', title: 'Finding: add it to the to-do list', group: 'Findings', shortcut: 't', keywords: 'make task to-do', when: hasSelection, run: () => setTaskOpen(true) },
      { id: 'findings.open', title: 'Finding: open the record behind it', group: 'Findings', shortcut: 'enter', keywords: 'evidence source open', when: () => latest.current.view === 'all' && Boolean(latest.current.selectedId), run: () => {
          const id = latest.current.selectedId;
          if (id) void openEvidence({ id });
        } },
    ],
    [],
  );

  // Widths that fit the list at 1280 (about 570px): How serious and the answer as short tags, Found as a date, the
  // finding takes the rest and wraps to two lines; its kind and how many records are behind it sit on a small line
  // under it (sorting by kind is the Kind filter).
  const columns = useMemo<ColumnDef<FindingListItem, unknown>[]>(
    () => [
      { id: 'severity', header: 'How serious', accessorFn: (r) => SEVERITY_RANK[r.severity] ?? 9, cell: ({ row }) => <SeverityTag severity={row.original.severity} />, meta: { width: 100, shrink: false } },
      {
        id: 'title',
        header: 'Finding',
        accessorKey: 'title',
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="findings-cell">
              <span className="findings-clamp">
                <KeepDatesWhole text={r.title} />
              </span>
              <span className="findings-sub">
                {categoryWords(r.category)} · {countWords(r.evidenceCount, 'record')}
              </span>
            </span>
          );
        },
        meta: { grow: true, minWidth: 220 },
      },
      { id: 'status', header: 'Your answer', accessorFn: (r) => STATUS_RANK[r.status] ?? 9, cell: ({ row }) => <AnswerTag status={row.original.status} />, meta: { width: 108, shrink: false } },
      { id: 'found', header: 'Found', accessorFn: (r) => r.createdAt, cell: ({ row }) => <DateText iso={row.original.createdAt.slice(0, 10)} />, meta: { width: 100, shrink: false } },
    ],
    [],
  );

  const byStatus = counts?.byStatus ?? {};
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const newCount = byStatus.new ?? 0;
  const filtered = Boolean(search.category || search.status || search.severity || search.q);
  const nothingYet = !filtered && total === 0 && list.isSuccess;

  const checkAction = {
    label: m.run.isPending ? 'Checking…' : everChecked ? 'Check again' : 'Run the checks',
    onClick: () => runRules(null),
    disabled: busy,
    title: 'Compare every record with the others using the built-in checks (no AI, no cost)',
  };
  const deepAction = {
    label: 'Deep check with Claude',
    onClick: () => runRules(true),
    disabled: busy || aiRunning,
    title: aiAvailable ? 'The built-in checks first, then Claude reads across the whole case (uses the AI and costs a little)' : 'Needs Claude switched on and an API key in Settings; the built-in checks still run',
  };

  const left =
    view === 'runs' ? (
      <RunsTable items={runItems} selectedId={selectedId} onSelect={(r: Run | null) => select(r?.id ?? null)} onOpen={() => undefined} loading={runs.isPending} />
    ) : list.isPending ? (
      <Loading>Loading what Claude noticed…</Loading>
    ) : list.isError ? (
      <Loading>Could not load what Claude noticed: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
    ) : nothingYet ? (
      <EmptyState
        title={everChecked ? 'Nothing noticed' : 'Not checked yet'}
        action={
          canWrite ? (
            <Button variant="primary" onClick={checkAction.onClick} disabled={checkAction.disabled} title={checkAction.title}>
              {checkAction.label}
            </Button>
          ) : null
        }
      >
        {everChecked
          ? 'The last check found no contradictions, gaps or patterns across your records. Each new document is checked as it is read.'
          : 'The built-in checks compare every record with the others: dates, doses and results that disagree, records that should exist, values that never come back into range. They are free and use no AI.'}
      </EmptyState>
    ) : (
      <div ref={tableRef} style={{ display: 'contents' }}>
        <DataTable
          columns={columns}
          data={items}
          rowId={(r) => r.id}
          selectedId={selectedId}
          onSelect={(r) => select(r?.id ?? null)}
          onOpen={(r) => void openEvidence(r)}
          initialSort={[]}
          rowClassName={(r) => (r.status === 'dismissed' || r.status === 'resolved' ? 'dim' : undefined)}
          emptyText="Nothing matches these filters. Clear filters (in the toolbar) shows everything again."
          tableId="findings.list"
          footer={
            filtered && !aiRunning ? undefined : (
              <span>{filtered ? 'Claude is checking…' : `${newCount} without an answer · ${byStatus.confirmed ?? 0} real · ${(byStatus.resolved ?? 0) + (byStatus.dismissed ?? 0)} closed${aiRunning ? ' · Claude is checking…' : ''}`}</span>
            )
          }
          autoFocus
        />
      </div>
    );

  const right =
    view === 'runs' ? (
      !selectedId ? (
        runItems.length ? (
          <EmptyState title="Pick a check">See what it looked at, what it found and, for Claude’s checks, what it cost. Move with j and k.</EmptyState>
        ) : runs.isPending ? (
          <Loading>Loading the past checks…</Loading>
        ) : (
          // Never a blank pane: with no checks yet, say what one is and offer to run it.
          <EmptyState
            title="No checks yet"
            action={
              canWrite ? (
                <Button variant="primary" onClick={checkAction.onClick} disabled={checkAction.disabled} title={checkAction.title}>
                  {checkAction.label}
                </Button>
              ) : null
            }
          >
            Each check compares every record with the others. Its result, and for Claude’s checks its cost, is listed here.
          </EmptyState>
        )
      ) : runDetail.isPending ? (
        <Loading />
      ) : runDetail.isError || !runDetail.data ? (
        <EmptyState title="That check is not available">Pick another from the list.</EmptyState>
      ) : (
        <RunDetailPanel run={runDetail.data} onOpenFinding={openFinding} onRerun={() => runRules(null)} />
      )
    ) : !selectedId ? (
      items.length ? (
        <EmptyState title="Pick a finding">
          See why it matters and the records behind it, then answer “Is this right?”: Yes, needs follow-up (c), Yes, done (r), Doesn't matter (x) or Incorrect (d). Move with j and k; Enter opens the first record behind it.
        </EmptyState>
      ) : nothingYet ? (
        <EmptyState title="What a finding is">
          Something that only shows when the records are read together: a date or dose two documents give differently, a record that should exist but is not here, a result nobody followed up. Each one links to the records it came from, and you decide whether it matters.
        </EmptyState>
      ) : null
    ) : detail.isPending ? (
      <Loading />
    ) : detail.isError || !detail.data ? (
      <EmptyState title="That finding is not available">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It may have been cleared by a later check. ' : ''}Pick another from the list.</EmptyState>
    ) : (
      <FindingDetail finding={detail.data} busy={busy || !canWrite} onVerdict={(status, note) => verdict(status, note)} onMakeTask={() => setTaskOpen(true)} onOpenEvidence={() => void openEvidence(detail.data!)} onNoteDraft={onNoteDraft} />
    );

  const meta = (
    <span className="findings-meta">
      <span className="mono">
        {total} noticed · {newCount} without an answer
      </span>
      {lastRun ? (
        <span>
          · last checked <DateTimeText iso={lastRun.startedAt} /> ({runKind(lastRun)}
          {lastRun.status === 'failed' ? ', did not finish' : ''})
        </span>
      ) : (
        <span>· not checked yet</span>
      )}
    </span>
  );

  return (
    <div className="page">
      <PageHeader title="What Claude noticed" meta={meta} intro={INTRO} actions={canWrite ? { primary: checkAction, more: [deepAction, { label: 'Check with Claude', onClick: () => runRules(false), disabled: busy || aiRunning, title: aiAvailable ? 'The built-in checks, then Claude reads across the case with the standard model (uses the AI)' : deepAction.title }] } : undefined} />
      <Toolbar label="Views and filters">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'Noticed', count: total, title: 'Everything the checks found, with your answers' },
            { value: 'runs', label: 'Past checks', count: runItems.length, title: 'Each check: when, what it found, what it cost' },
          ]}
        />
        {view === 'all' ? (
          <>
            <SearchField label="Find" placeholder="Finding, e.g. protein" value={qLocal} onChange={setQLocal} width={190} />
            <FilterGroup label="Kind">
              <Select aria-label="Kind" value={search.category ?? ''} options={FINDING_CATEGORIES.map((c) => ({ value: c, label: categoryWords(c) }))} placeholder="Any" title={search.category ? CATEGORY_TITLES[search.category] : undefined} onChange={(e) => setSearch({ category: (e.target.value || undefined) as FindingsSearch['category'], id: undefined })} />
            </FilterGroup>
            <FilterGroup label="Your answer">
              <Select aria-label="Your answer" value={search.status ?? ''} options={ANSWER_ORDER.filter((s) => (FINDING_STATUSES as readonly string[]).includes(s)).map((s) => ({ value: s, label: answerWords(s).filter }))} placeholder="Any" onChange={(e) => setSearch({ status: (e.target.value || undefined) as FindingsSearch['status'], id: undefined })} />
            </FilterGroup>
            {/* How serious sorts by its column; the filter shows only when a link set it, so it can be seen and changed. */}
            {search.severity ? (
              <FilterGroup label="How serious">
                <Select aria-label="How serious" value={search.severity} options={SEVERITY_ORDER.map((s) => ({ value: s, label: severityWords(s).label.replace(/^./, (c) => c.toUpperCase()) }))} placeholder="Any" onChange={(e) => setSearch({ severity: (e.target.value || undefined) as FindingsSearch['severity'], id: undefined })} />
              </FilterGroup>
            ) : null}
          </>
        ) : null}
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            view === 'all' ? ['enter', 'open the record'] : null,
            ['v v', 'view'],
            view === 'all' ? ['/', 'find'] : null,
            ...(view === 'all' && canWrite ? ([['c', 'needs follow-up'], ['r', 'done'], ['x', "doesn't matter"], ['d', 'incorrect'], ['u', 'undo'], ['t', 'to-do']] as const) : []),
          ]}
        >
          {view === 'all' && filtered ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      <p className="findings-list-line">
        <strong>{VIEW_LINE[view].lead}</strong> {VIEW_LINE[view].text}
      </p>
      <div className="page-body flush">
        <SplitView storageKey={`findings.${view}`} defaultLeft={view === 'runs' ? 56 : 54} minLeft={440} minRight={420} left={left} right={right} />
      </div>

      <TaskDialog
        open={taskOpen && Boolean(detail.data)}
        onClose={() => {
          setTaskOpen(false);
          setTaskError(null);
        }}
        finding={detail.data ?? null}
        busy={m.toTask.isPending}
        error={taskError}
        onCreate={(input) => {
          const id = latest.current.selectedId;
          if (!id) return;
          m.toTask.mutate(
            { id, input },
            {
              onSuccess: (t) => {
                setTaskOpen(false);
                setTaskError(null);
                toast(t.existing ? 'It is already on the to-do list' : 'Added to the to-do list', 'ok');
              },
              onError: (err) => setTaskError(err instanceof Error ? err.message : String(err)),
            },
          );
        }}
      />
    </div>
  );
}
