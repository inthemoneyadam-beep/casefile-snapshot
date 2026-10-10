/**
 * /tasks — To-do list: what is due, who owes it, and where it came from.
 *
 * Header: Add a to-do (the one primary); under More, Print today's plan,
 * Export to my calendar, and Add to-dos from promised follow-ups or missing
 * records. Toolbar: Show (To do · Done · All), Find, Due and, under More
 * filters, Who and From, each labelled. Split view: the list left, the chosen
 * one right; with nothing at all the page is one empty state with the same
 * offers. Selection and every filter live in the URL. Keys: n new, e edit,
 * x done/reopen, z snooze 7 days, o open where it came from, Delete.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { TASK_OWNERS, TASK_SOURCE_TYPES } from '@shared/enums';
import { dateSortKey, todayIso } from '@shared/dates';
import { ApiError, useFailToast } from '../api/client';
import { downloadCalendar, useTask, useTaskCounts, useTaskMutations, useTasks, type Task, type TaskFilters, type TaskInput } from '../api/tasks';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { moveToNextRow } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { Tag } from '../ui/StatusTag';
import { DateText } from '../ui/DateText';
import { Confirm } from '../ui/Dialog';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { TaskDetail } from '../features/tasks/TaskDetail';
import { TaskDialog } from '../features/tasks/TaskDialog';
import { OWNER_WORDS, PRIORITY_ORDER, PRIORITY_TONE, SOURCE_LONG, SOURCE_WORDS, sourceWords, taskOwnerWords, taskStatusWords } from '../features/tasks/words';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/tasks/tasks.css';

const VIEWS = ['open', 'done', 'all'] as const;
type View = (typeof VIEWS)[number];
const VIEW_WORDS: Record<View, string> = { open: 'To do', done: 'Done', all: 'All' };
const DUE_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due this week' },
];
const INTRO = 'Things to do, call about or chase up, with who owes each one and when it is due.';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
  owner: z.enum(TASK_OWNERS).optional().catch(undefined),
  due: z.enum(['overdue', 'today', 'week']).optional().catch(undefined),
  sourceType: z.enum(TASK_SOURCE_TYPES).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});
export type TasksSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/tasks')({
  validateSearch: (s: Record<string, unknown>): TasksSearch => searchSchema.parse(s),
  component: TasksPage,
});

function statusFor(view: View): string | undefined {
  return view === 'open' ? 'active' : view === 'done' ? 'closed' : undefined;
}

function TasksPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const view: View = search.view ?? 'open';
  const selectedId = search.id ?? null;

  const filters = useMemo<TaskFilters>(() => ({ status: statusFor(view), owner: search.owner, due: search.due, sourceType: search.sourceType, q: search.q }), [view, search.owner, search.due, search.sourceType, search.q]);
  const list = useTasks(filters);
  const counts = useTaskCounts();
  const detail = useTask(selectedId);
  const m = useTaskMutations();

  const items = list.data?.items ?? [];
  const selected = detail.data ?? items.find((t) => t.id === selectedId) ?? null;

  const [newOpen, setNewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [moreFilters, setMoreFilters] = useState(Boolean(search.owner || search.sourceType));
  useEffect(() => {
    if (search.owner || search.sourceType) setMoreFilters(true);
  }, [search.owner, search.sourceType]);
  const dialogOpen = newOpen || editOpen || deleteOpen;
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.done.isPending || m.reopen.isPending || m.snooze.isPending || m.fromFollowUps.isPending || m.fromGaps.isPending;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  const tableRef = useRef<HTMLDivElement>(null);

  function setSearch(patch: Partial<TasksSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function setView(v: View) {
    setSearch({ view: v === 'open' ? undefined : v, id: undefined }, false);
  }

  const latest = useRef({ selected, dialogOpen, busy, view });
  latest.current = { selected, dialogOpen, busy, view };

  function toggleDone() {
    const t = latest.current.selected;
    if (!t || latest.current.busy) return;
    const open = t.status === 'open' || t.status === 'in_progress';
    (open ? m.done : m.reopen).mutate(t.id, {
      onSuccess: () => {
        toast(open ? 'Done' : 'Reopened', 'ok');
        if (open && latest.current.view === 'open') moveToNextRow(tableRef.current);
      },
      onError: fail,
    });
  }
  function snooze(days: number) {
    const t = latest.current.selected;
    if (!t || latest.current.busy) return;
    m.snooze.mutate({ id: t.id, days }, { onSuccess: (r) => toast(`Snoozed: now due ${r.dueAt}`, 'ok'), onError: fail });
  }
  function openSource() {
    const t = latest.current.selected;
    if (!t?.sourceHref) {
      toast('This to-do did not come from anything that can be opened.');
      return;
    }
    // sourceHref is a page held as a string, so the router cannot type it: the cast stays.
    void navigate({ to: t.sourceHref as never });
  }
  function exportCalendar() {
    downloadCalendar('/api/tasks/ics?status=active', 'casefile-tasks.ics');
    toast('Saved a calendar file of the open to-dos (casefile-tasks.ics); open it to add them to your calendar.', 'ok');
  }
  function fromFollowUps() {
    m.fromFollowUps.mutate(undefined, {
      onSuccess: (r) => toast(r.created.length ? `${r.created.length} to-do${r.created.length === 1 ? '' : 's'} added from promised follow-ups${r.existing ? `, ${r.existing} already had one` : ''}` : r.existing ? `Every open follow-up already has a to-do (${r.existing})` : 'No open follow-ups to add', r.created.length ? 'ok' : 'info'),
      onError: fail,
    });
  }
  function fromGaps() {
    m.fromGaps.mutate(undefined, {
      onSuccess: (r) => toast(r.created.length ? `${r.created.length} to-do${r.created.length === 1 ? '' : 's'} added from missing records${r.existing ? `, ${r.existing} already had one` : ''}` : r.existing ? `Every missing record already has a to-do (${r.existing})` : 'No missing records to add', r.created.length ? 'ok' : 'info'),
      onError: fail,
    });
  }
  function openDailyPlan() {
    void navigate({ to: '/print/daily-plan', search: { date: todayIso() } });
  }

  const hasSelection = () => Boolean(latest.current.selected) && !latest.current.dialogOpen;
  useBindings(
    [
      { keys: 'n', description: 'Add a to-do', group: 'Tasks', when: () => !latest.current.dialogOpen, run: () => setNewOpen(true) },
      { keys: 'e', description: 'Edit selected to-do', group: 'Tasks', when: hasSelection, run: () => setEditOpen(true) },
      { keys: 'x', description: 'Mark selected to-do done (or reopen it)', group: 'Tasks', when: hasSelection, run: toggleDone },
      { keys: 'z', description: 'Snooze selected to-do 7 days', group: 'Tasks', when: hasSelection, run: () => snooze(7) },
      { keys: 'o', description: 'Open where the selected to-do came from', group: 'Tasks', when: () => hasSelection() && Boolean(latest.current.selected?.sourceHref), run: openSource },
      { keys: 'Delete', description: 'Delete selected to-do (asks first)', group: 'Tasks', when: hasSelection, run: () => setDeleteOpen(true) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'tasks.new', title: 'Add a to-do', group: 'To-do list', keywords: 'add todo reminder new task', shortcut: 'n', run: () => setNewOpen(true) },
      { id: 'tasks.toggle-done', title: 'Mark the selected to-do done (or reopen it)', group: 'To-do list', keywords: 'complete finish reopen task', shortcut: 'x', when: () => Boolean(latest.current.selected), run: toggleDone },
      { id: 'tasks.snooze', title: 'Snooze the selected to-do 7 days', group: 'To-do list', keywords: 'postpone later defer task', shortcut: 'z', when: () => Boolean(latest.current.selected), run: () => snooze(7) },
      { id: 'tasks.edit', title: 'Edit the selected to-do', group: 'To-do list', keywords: 'change update task', shortcut: 'e', when: () => Boolean(latest.current.selected), run: () => setEditOpen(true) },
      { id: 'tasks.open-source', title: 'Open where the selected to-do came from', group: 'To-do list', keywords: 'origin passage promise source task', shortcut: 'o', when: () => Boolean(latest.current.selected?.sourceHref), run: openSource },
      { id: 'tasks.delete', title: 'Delete the selected to-do', group: 'To-do list', keywords: 'remove task', shortcut: 'Delete', when: () => Boolean(latest.current.selected), run: () => setDeleteOpen(true) },
      { id: 'tasks.export-ics', title: 'Export the open to-dos to my calendar', group: 'To-do list', keywords: 'ical calendar download outlook export ics tasks', run: exportCalendar },
      { id: 'tasks.from-follow-ups', title: 'Add to-dos from promised follow-ups', group: 'To-do list', keywords: 'communications promise chase create tasks', run: fromFollowUps },
      { id: 'tasks.from-gaps', title: 'Add to-dos from missing records', group: 'To-do list', keywords: 'records missing request gaps create tasks', run: fromGaps },
      { id: 'tasks.daily-plan', title: "Print today's plan", group: 'To-do list', keywords: 'print today plan sheet daily', run: openDailyPlan },
      { id: 'tasks.overdue', title: 'Show overdue to-dos', group: 'To-do list', keywords: 'tasks', run: () => setSearch({ view: undefined, due: 'overdue', id: undefined }, false) },
      { id: 'tasks.done', title: 'Show finished to-dos', group: 'To-do list', keywords: 'tasks done', run: () => setView('done') },
    ],
    [],
  );

  // Fits the list pane at 1280 (about 615px): Due, To-do (takes the room; a tag before it says overdue, or where it
  // stands on All), Who, Priority (only high and urgent are marked), From. The reminder is in the detail.
  const columns = useMemo<ColumnDef<Task, unknown>[]>(
    () => [
      {
        id: 'due',
        header: 'Due',
        accessorFn: (r) => (r.dueAt ? dateSortKey(r.dueAt) : undefined),
        sortUndefined: 'last',
        cell: ({ row }) => (row.original.dueAt ? <DateText iso={row.original.dueAt} /> : <span className="faint">No date</span>),
        meta: { width: 96, shrink: false },
      },
      {
        id: 'title',
        header: 'To-do',
        accessorKey: 'title',
        cell: ({ row }) => {
          const r = row.original;
          const open = r.status === 'open' || r.status === 'in_progress';
          return (
            <span className="tk-title-cell">
              {r.overdue && open ? <Tag tone="bad">overdue</Tag> : null}
              {r.status === 'in_progress' ? <Tag tone="info">in progress</Tag> : null}
              {!open && view !== 'done' ? <Tag tone={r.status === 'done' ? 'ok' : 'ash'}>{taskStatusWords(r.status)}</Tag> : null}
              {r.status === 'cancelled' && view === 'done' ? <Tag tone="ash">cancelled</Tag> : null}
              {r.title}
            </span>
          );
        },
        meta: { grow: true, minWidth: 220 },
      },
      { id: 'owner', header: 'Who', accessorFn: (r) => taskOwnerWords(r, true), cell: ({ row, getValue }) => <span title={taskOwnerWords(row.original)}>{String(getValue())}</span>, meta: { width: 96, maxWidth: 170, wrap: true } },
      {
        id: 'priority',
        header: 'Priority',
        accessorFn: (r) => PRIORITY_ORDER[r.priority] ?? 9,
        // Only urgent and high are marked; low says so quietly; normal is left blank.
        cell: ({ row }) => (row.original.priority === 'urgent' || row.original.priority === 'high' ? <Tag tone={PRIORITY_TONE[row.original.priority]}>{row.original.priority}</Tag> : row.original.priority === 'low' ? <span className="muted">low</span> : null),
        meta: { width: 72 },
      },
      {
        id: 'source',
        header: 'From',
        accessorFn: (r) => (r.sourceType === 'manual' ? '' : `${sourceWords(r.sourceType)} ${r.sourceTitle ?? ''}`),
        cell: ({ row }) => {
          const r = row.original;
          if (r.sourceType === 'manual') return null;
          return (
            <span className="muted" title={`${SOURCE_LONG[r.sourceType] ?? sourceWords(r.sourceType)}${r.sourceTitle ? `: ${r.sourceTitle}` : ''}`}>
              {sourceWords(r.sourceType)}
            </span>
          );
        },
        meta: { width: 96, maxWidth: 140 },
      },
    ],
    [view],
  );

  const c = counts.data;
  const viewCounts: Record<View, number | undefined> = { open: c?.active, all: c?.all, done: c?.closed };
  const anyFilter = Boolean(search.owner || search.due || search.sourceType || search.q);
  const nothingYet = Boolean(c) && c!.all === 0 && !anyFilter;
  const moreOn = [search.owner, search.sourceType].filter(Boolean).length;
  const clearFilters = () => {
    setQLocal('');
    setSearch({ owner: undefined, due: undefined, sourceType: undefined, q: undefined, id: undefined });
  };

  const left = list.isPending ? (
    <Loading>Loading the to-do list…</Loading>
  ) : list.isError ? (
    <Loading>Could not load the to-do list: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
  ) : (
    <div ref={tableRef} style={{ display: 'contents' }}>
      <DataTable
        columns={columns}
        data={items}
        rowId={(r) => r.id}
        selectedId={selectedId}
        onSelect={(r) => select(r?.id ?? null)}
        onOpen={(r) => {
          // sourceHref is a page held as a string, so the router cannot type it: the cast stays.
          if (r.sourceHref) void navigate({ to: r.sourceHref as never });
          else setEditOpen(true);
        }}
        initialSort={[{ id: 'due', desc: false }]}
        rowClassName={(r) => (r.status === 'done' || r.status === 'cancelled' ? 'dim' : undefined)}
        tableId="tasks.list"
        emptyText={anyFilter ? 'No to-dos match. Clear filters (in the toolbar) shows them all.' : view === 'open' ? 'Nothing left to do.' : view === 'done' ? 'Nothing done yet.' : 'No to-dos yet.'}
        footer={c ? <span>{c.overdue} overdue · {c.today} due today · {c.week} due this week</span> : null}
        autoFocus
      />
    </div>
  );

  const right = !selectedId ? (
    items.length ? (
      <EmptyState title="Pick a to-do">See who owes it, when it is due and where it came from; mark it done or snooze it. Move with j and k; Enter opens where it came from.</EmptyState>
    ) : view === 'open' && !anyFilter ? (
      <EmptyState
        title="Nothing left to do"
        action={
          <Button variant="accent" onClick={() => setNewOpen(true)} shortcut="n">
            Add a to-do
          </Button>
        }
      >
        Everything on the list is done.
      </EmptyState>
    ) : null
  ) : detail.isPending && !selected ? (
    <Loading>Loading the to-do…</Loading>
  ) : !selected ? (
    <EmptyState title="This to-do is not here any more">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted or never existed. ' : ''}Pick another one from the list.</EmptyState>
  ) : (
    <TaskDetail
      task={selected}
      busy={busy}
      onToggleDone={toggleDone}
      onSnooze={snooze}
      onEdit={() => setEditOpen(true)}
      onOpenSource={openSource}
      onDelete={() => setDeleteOpen(true)}
      onCalendar={() => downloadCalendar(`/api/tasks/${encodeURIComponent(selected.id)}/ics`, `casefile-task.ics`)}
    />
  );

  return (
    <div className="page">
      <PageHeader
        title="To-do list"
        meta={c && !nothingYet ? <span className="mono">{c.active} to do · {c.overdue} overdue · {c.closed} done</span> : null}
        intro={INTRO}
        actions={{
          primary: { label: 'Add a to-do', onClick: () => setNewOpen(true), shortcut: 'n', title: 'Something to do, call about or chase up' },
          more: [
            { label: "Print today's plan", onClick: openDailyPlan, title: "One page for today: appointments, medications, what is due and who owes what" },
            { label: 'Export to my calendar', onClick: exportCalendar, title: 'Saves a calendar file of the open to-dos with a due date, to open in your calendar app' },
            'separator',
            { heading: 'Add to-dos from' },
            { label: 'Promised follow-ups', text: 'Promised follow-ups', onClick: fromFollowUps, disabled: m.fromFollowUps.isPending, title: 'One to-do for each follow-up promised on a call or message that has none yet' },
            { label: 'Missing records', text: 'Missing records', onClick: fromGaps, disabled: m.fromGaps.isPending, title: 'One to-do for each record still missing on the Records checklist that has none yet' },
          ],
        }}
      />
      {nothingYet ? null : (
        <Toolbar label="Views and filters">
          <Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: VIEW_WORDS[v], count: viewCounts[v], title: v === 'open' ? 'Still to do, soonest due first' : v === 'done' ? 'Done or cancelled' : 'Everything' }))} />
          <SearchField label="Find" placeholder="To-do or its detail" value={qLocal} onChange={setQLocal} width={200} />
          <FilterGroup label="Due">
            <Select aria-label="Due" value={search.due ?? ''} options={DUE_OPTIONS} placeholder="Any time" onChange={(e) => setSearch({ due: (e.target.value || undefined) as TasksSearch['due'], id: undefined })} />
          </FilterGroup>
          <Button size="sm" variant="ghost" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
            {moreFilters ? 'Fewer filters' : `More filters${moreOn ? ` (${moreOn} on)` : ''}`}
          </Button>
          {moreFilters ? (
            <>
              <FilterGroup label="Who">
                <Select aria-label="Who owes it" value={search.owner ?? ''} options={TASK_OWNERS.map((o) => ({ value: o, label: OWNER_WORDS[o] ?? o }))} placeholder="Anyone" onChange={(e) => setSearch({ owner: (e.target.value || undefined) as TasksSearch['owner'], id: undefined })} />
              </FilterGroup>
              <FilterGroup label="From">
                <Select aria-label="Where it came from" value={search.sourceType ?? ''} options={TASK_SOURCE_TYPES.map((s) => ({ value: s, label: SOURCE_WORDS[s] ?? s }))} placeholder="Anywhere" onChange={(e) => setSearch({ sourceType: (e.target.value || undefined) as TasksSearch['sourceType'], id: undefined })} />
              </FilterGroup>
            </>
          ) : null}
          <ToolbarKeys
            items={[
              ['j/k', 'move'],
              ['enter', 'where it came from'],
              ['n', 'add'],
              ['x', 'done'],
              ['z', 'snooze a week'],
              ['e', 'edit'],
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
      )}
      <div className="page-body flush">
        {nothingYet ? (
          <EmptyState
            title="Nothing on the to-do list yet"
            action={
              <div className="row wrap">
                <Button variant="primary" onClick={() => setNewOpen(true)} shortcut="n">
                  Add a to-do
                </Button>
                <Button onClick={fromFollowUps} disabled={m.fromFollowUps.isPending} title="One to-do for each follow-up promised on a call or message">
                  Add from promised follow-ups
                </Button>
                <Button onClick={fromGaps} disabled={m.fromGaps.isPending} title="One to-do for each record still missing on the Records checklist">
                  Add from missing records
                </Button>
              </div>
            }
          >
            Keep each thing to do, call about or chase up here, with who owes it and when it is due. To-dos can also come from promised follow-ups, missing records and appointments.
          </EmptyState>
        ) : (
          <SplitView storageKey="tasks" defaultLeft={58} minLeft={440} minRight={420} left={left} right={right} />
        )}
      </div>

      <TaskDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setFormError(null);
        }}
        busy={m.create.isPending}
        error={formError}
        onCreate={(input: TaskInput) =>
          m.create.mutate(input, {
            onSuccess: (t) => {
              setNewOpen(false);
              setFormError(null);
              toast('To-do added', 'ok');
              setSearch({ id: t.id });
            },
            onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
          })
        }
        onUpdate={() => undefined}
      />
      <TaskDialog
        open={editOpen && Boolean(selected)}
        onClose={() => {
          setEditOpen(false);
          setFormError(null);
        }}
        task={selected}
        busy={m.update.isPending}
        error={formError}
        onCreate={() => undefined}
        onUpdate={(id, patch) =>
          m.update.mutate(
            { id, patch },
            {
              onSuccess: () => {
                setEditOpen(false);
                setFormError(null);
                toast('Saved', 'ok');
              },
              onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
            },
          )
        }
      />
      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this to-do?"
        body={<span className="muted">{selected?.title ?? ''}. It is hidden, not erased.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const t = latest.current.selected;
          if (!t) return;
          m.remove.mutate(t.id, {
            onSuccess: () => {
              toast('To-do deleted', 'ok');
              select(null);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}
