/**
 * /encounters — Appointments: visits, video or phone visits, procedures,
 * hospital stays and tests, with the questions to ask and a prep sheet before,
 * and what was decided and the documents that came out of each one after.
 *
 * Header: Add an appointment (the one primary), Export to my calendar. Toolbar:
 * Show (Coming up · Past), Find, Clinician, each labelled. Split view: the
 * list left, the chosen one right. While nothing is chosen the right pane says
 * what to do; on Past it also lists the visit documents not added yet, each
 * with "Add it" (the form starts filled in from the document). With nothing at
 * all the page is one empty state with the same offer. Keys: n new, e edit,
 * c mark done, b prepare (the clinician panel on the Deep preset, prefilled
 * through the `casefile:ask-prefill` event), t to-do, Delete, v v switch.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { dateSortKey, todayIso } from '@shared/dates';
import { ApiError, useFailToast } from '../api/client';
import { fetchEncounterPrep, useEncounter, useEncounterMutations, useEncounterPrep, useEncounters, type Encounter, type EncounterInput, type EncounterQuestion } from '../api/encounters';
import { downloadCalendar, useTaskMutations, type TaskInput } from '../api/tasks';
import { useDocumentsLite } from '../api/records';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { dock } from '../app/dock';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { PREFILL_EVENT as ASK_PREFILL_EVENT } from '../features/ask/live';
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
import { usePeople } from '../api/people';
import { EncounterDetail } from '../features/encounters/EncounterDetail';
import { EncounterDialog } from '../features/encounters/EncounterDialog';
import { VisitDocuments } from '../features/encounters/VisitDocuments';
import { datePassed, encounterKindWords, encounterPresetFromDocument, questionWords, unlinkedVisitDocuments, type EncounterPreset, type VisitDocLike } from '../features/encounters/words';
import { TaskDialog } from '../features/tasks/TaskDialog';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/encounters/encounters.css';
import '../features/tasks/tasks.css';

const VIEWS = ['upcoming', 'past'] as const;
type View = (typeof VIEWS)[number];
const VIEW_WORDS: Record<View, string> = { upcoming: 'Coming up', past: 'Past' };
const INTRO = 'Your visits, procedures, tests and hospital stays: what to bring and ask before, and what was decided after.';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
  clinicianId: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});
export type EncountersSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/encounters')({
  validateSearch: (s: Record<string, unknown>): EncountersSearch => searchSchema.parse(s),
  component: EncountersPage,
});

/** Upcoming = status upcoming (whatever the date, so an overdue visit is not lost); completed and cancelled are past. */
function isUpcoming(e: Encounter, today: string): boolean {
  if (e.status === 'upcoming') return true;
  return e.status !== 'cancelled' && e.status !== 'completed' && Boolean(e.occurredAt && e.occurredAt >= today);
}

function EncountersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const view: View = search.view ?? 'upcoming';
  const selectedId = search.id ?? null;
  const today = todayIso();

  const list = useEncounters(search.clinicianId ? { clinicianId: search.clinicianId } : {});
  const everything = useEncounters({});
  const detail = useEncounter(selectedId);
  const prep = useEncounterPrep(selectedId, Boolean(detail.data));
  const people = usePeople();
  const documents = useDocumentsLite();
  const m = useEncounterMutations();
  const tm = useTaskMutations();

  const all = useMemo(() => list.data?.items ?? [], [list.data]);
  const upcoming = useMemo(() => all.filter((e) => isUpcoming(e, today)), [all, today]);
  const past = useMemo(() => all.filter((e) => !isUpcoming(e, today)), [all, today]);
  const items = view === 'upcoming' ? upcoming : past;
  const selected = detail.data ?? null;
  const total = everything.data?.items.length ?? 0;
  const unlinked = useMemo(() => (everything.isSuccess ? unlinkedVisitDocuments(documents.data ?? [], everything.data?.items ?? []) : []), [documents.data, everything.data, everything.isSuccess]);

  const [newOpen, setNewOpen] = useState(false);
  const [preset, setPreset] = useState<EncounterPreset | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const dialogOpen = newOpen || editOpen || deleteOpen || completeOpen || taskOpen;
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.complete.isPending || tm.create.isPending;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  function setSearch(patch: Partial<EncountersSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function setView(v: View) {
    setSearch({ view: v === 'upcoming' ? undefined : v, id: undefined }, false);
  }
  function addNew() {
    setPreset(null);
    setNewOpen(true);
  }
  function addFrom(d: VisitDocLike) {
    setPreset(encounterPresetFromDocument(d, today));
    setNewOpen(true);
  }

  const latest = useRef({ selected, dialogOpen, busy, prep: prep.data ?? null, view });
  latest.current = { selected, dialogOpen, busy, prep: prep.data ?? null, view };

  /** Open the consult dock on the Deep preset and hand it the briefing request for this encounter. */
  async function briefing() {
    const e = latest.current.selected;
    if (!e) return;
    try {
      const p = latest.current.prep?.encounter.id === e.id ? latest.current.prep : await fetchEncounterPrep(e.id);
      dock('open', { presetKey: 'deep' });
      const detailPayload = { text: p.briefingPrompt, mode: 'briefing' as const, encounterId: e.id };
      // Let the Shell mount the dock before the composer is asked to prefill.
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(ASK_PREFILL_EVENT, { detail: detailPayload })), 80);
      toast('Sent to the clinician panel to prepare for this visit', 'ok');
    } catch (err) {
      fail(err);
    }
  }
  function saveQuestions(questions: EncounterQuestion[]) {
    const e = latest.current.selected;
    if (!e) return;
    m.update.mutate({ id: e.id, patch: { questions } }, { onError: fail });
  }
  function saveOutcomes(outcomes: string | null) {
    const e = latest.current.selected;
    if (!e) return;
    m.update.mutate({ id: e.id, patch: { outcomes } }, { onSuccess: () => toast('Saved', 'ok'), onError: fail });
  }
  function exportCalendar() {
    downloadCalendar('/api/encounters/ics?status=upcoming', 'casefile-encounters.ics');
    toast('Saved a calendar file of the appointments coming up (casefile-encounters.ics); open it to add them to your calendar.', 'ok');
  }

  const hasSelection = () => Boolean(latest.current.selected) && !latest.current.dialogOpen;
  useBindings(
    [
      { keys: 'n', description: 'Add an appointment', group: 'Lists', when: () => !latest.current.dialogOpen, run: addNew },
      { keys: 'e', description: 'Edit selected appointment', group: 'Lists', when: hasSelection, run: () => setEditOpen(true) },
      { keys: 'c', description: 'Mark selected appointment done (write what was decided)', group: 'Lists', when: () => hasSelection() && latest.current.selected?.status === 'upcoming', run: () => setCompleteOpen(true) },
      { keys: 'b', description: 'Prepare for this visit with the clinician', group: 'Lists', when: hasSelection, run: () => void briefing() },
      { keys: 't', description: 'Add a to-do from this appointment', group: 'Lists', when: hasSelection, run: () => setTaskOpen(true) },
      { keys: 'Delete', description: 'Delete selected appointment (asks first)', group: 'Lists', when: hasSelection, run: () => setDeleteOpen(true) },
      { keys: 'v v', description: 'Switch between coming up and past', group: 'Lists', when: () => !latest.current.dialogOpen, run: () => setView(latest.current.view === 'upcoming' ? 'past' : 'upcoming') },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'encounters.new', title: 'Add an appointment', group: 'Appointments', keywords: 'visit appointment add new encounter', shortcut: 'n', run: addNew },
      { id: 'encounters.briefing', title: 'Prepare for the selected appointment with the clinician', group: 'Appointments', keywords: 'ask consult prepare briefing pre-visit encounter', shortcut: 'b', when: () => Boolean(latest.current.selected), run: () => void briefing() },
      { id: 'encounters.edit', title: 'Edit the selected appointment', group: 'Appointments', keywords: 'change update encounter', shortcut: 'e', when: () => Boolean(latest.current.selected), run: () => setEditOpen(true) },
      { id: 'encounters.complete', title: 'Mark the selected appointment done (write what was decided)', group: 'Appointments', keywords: 'done finish outcome complete encounter', shortcut: 'c', when: () => latest.current.selected?.status === 'upcoming', run: () => setCompleteOpen(true) },
      { id: 'encounters.new-task', title: 'Add a to-do from the selected appointment', group: 'Appointments', keywords: 'todo reminder add task encounter', shortcut: 't', when: () => Boolean(latest.current.selected), run: () => setTaskOpen(true) },
      { id: 'encounters.delete', title: 'Delete the selected appointment', group: 'Appointments', keywords: 'remove encounter', shortcut: 'Delete', when: () => Boolean(latest.current.selected), run: () => setDeleteOpen(true) },
      { id: 'encounters.export-ics', title: 'Export the appointments coming up to my calendar', group: 'Appointments', keywords: 'ical calendar download export ics encounter', run: exportCalendar },
      { id: 'encounters.past', title: 'Show past appointments', group: 'Appointments', keywords: 'encounter', shortcut: 'v v', run: () => setView('past') },
      { id: 'encounters.upcoming', title: 'Show appointments coming up', group: 'Appointments', keywords: 'upcoming encounter', shortcut: 'v v', run: () => setView('upcoming') },
    ],
    [],
  );

  // Fits the list pane at 1280 (about 600px): When (the time under the date), Appointment (takes the room, a tag
  // before it when its date has passed or it was cancelled), Type, With, and Questions (coming up) or Documents (past).
  const columns = useMemo<ColumnDef<Encounter, unknown>[]>(
    () => [
      {
        id: 'date',
        header: 'When',
        accessorFn: (r) => (r.occurredAt ? dateSortKey(r.occurredAt) : undefined),
        sortUndefined: 'last',
        cell: ({ row }) => (
          <span className="en-when">
            {row.original.occurredAt || row.original.occurredAtText ? <DateText iso={row.original.occurredAt} precision={row.original.occurredAtPrecision} text={row.original.occurredAtText} /> : <span className="faint">No date</span>}
            {row.original.timeText ? <span className="en-time">{row.original.timeText}</span> : null}
          </span>
        ),
        meta: { width: 96, shrink: false },
      },
      {
        id: 'title',
        header: 'Appointment',
        accessorKey: 'title',
        cell: ({ row }) => {
          const e = row.original;
          return (
            <span className="en-title-cell">
              {datePassed(e, today) ? (
                <Tag tone="warn" title="Its date has gone by: mark it done or cancelled">
                  date passed
                </Tag>
              ) : e.status === 'cancelled' ? (
                <Tag tone="ash">cancelled</Tag>
              ) : null}
              {e.title}
            </span>
          );
        },
        meta: { grow: true, minWidth: 200 },
      },
      { id: 'kind', header: 'Type', accessorFn: (r) => encounterKindWords(r.kind), cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 84, maxWidth: 110, wrap: true } },
      { id: 'clinician', header: 'With', accessorFn: (r) => r.clinicianName ?? r.institutionName ?? '', cell: ({ getValue }) => (String(getValue()) ? <span>{String(getValue())}</span> : <span className="faint">Nobody named</span>), meta: { width: 110, maxWidth: 170, wrap: true } },
      ...(view === 'upcoming'
        ? [
            {
              id: 'questions',
              header: 'Questions',
              accessorFn: (r: Encounter) => r.questionCount - r.askedCount,
              cell: ({ row }: { row: { original: Encounter } }) => (row.original.questionCount ? <span>{questionWords(row.original.askedCount, row.original.questionCount)}</span> : <span className="faint">None yet</span>),
              meta: { width: 84, maxWidth: 120 },
            } as ColumnDef<Encounter, unknown>,
          ]
        : [
            {
              id: 'docs',
              header: 'Documents',
              accessorFn: (r: Encounter) => r.documentCount,
              cell: ({ getValue }: { getValue: () => unknown }) => <span className={Number(getValue()) ? 'mono' : 'mono faint'}>{String(getValue())}</span>,
              meta: { width: 84, className: 'num' },
            } as ColumnDef<Encounter, unknown>,
          ]),
    ],
    [view, today],
  );

  const clinicianOptions = (people.data?.items ?? []).filter((p) => p.kind === 'clinician').map((p) => ({ value: p.id, label: p.name }));
  const anyFilter = Boolean(search.clinicianId || search.q);
  const nothingYet = everything.isSuccess && total === 0;
  const clearFilters = () => {
    setQLocal('');
    setSearch({ clinicianId: undefined, q: undefined, id: undefined });
  };

  const left = list.isPending ? (
    <Loading>Loading the appointments…</Loading>
  ) : list.isError ? (
    <Loading>Could not load the appointments: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
  ) : (
    <DataTable
      // One table per view, so the view's own initial sort applies however it is reached (tab, command, or URL).
      key={view}
      columns={columns}
      data={items}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={(r) => select(r?.id ?? null)}
      onOpen={() => setEditOpen(true)}
      initialSort={[{ id: 'date', desc: view === 'past' }]}
      globalFilter={search.q ?? ''}
      rowClassName={(r) => (r.status === 'cancelled' ? 'dim' : undefined)}
      tableId={`encounters.${view}`}
      emptyText={anyFilter ? 'Nothing matches. Clear filters (in the toolbar) shows them all.' : view === 'upcoming' ? 'Nothing coming up.' : 'No past appointments yet.'}
      autoFocus
    />
  );

  const idle = (
    <div className="en-idle">
      {items.length ? (
        <EmptyState title="Pick an appointment">
          {view === 'upcoming' ? 'See the questions to ask and what to bring, and prepare for it with the clinician. Move with j and k; Enter edits it.' : 'See what was decided, the answers you got and the documents from it. Move with j and k; Enter edits it.'}
        </EmptyState>
      ) : view === 'upcoming' ? (
        <EmptyState
          title="Nothing coming up"
          action={
            <Button variant="accent" onClick={addNew} shortcut="n">
              Add an appointment
            </Button>
          }
        >
          Add the next visit, test or procedure to keep the questions to ask and get a prep sheet for it.
        </EmptyState>
      ) : null}
      {view === 'past' ? <VisitDocuments docs={unlinked} onAdd={addFrom} /> : null}
    </div>
  );

  const right = !selectedId ? (
    idle
  ) : detail.isPending ? (
    <Loading>Loading the appointment…</Loading>
  ) : !selected ? (
    <EmptyState title="This appointment is not here any more">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted or never existed. ' : ''}Pick another one from the list.</EmptyState>
  ) : (
    <EncounterDetail
      encounter={selected}
      prep={prep.data?.encounter.id === selected.id ? prep.data : null}
      prepLoading={prep.isPending}
      busy={busy}
      onEdit={() => setEditOpen(true)}
      onComplete={() => setCompleteOpen(true)}
      onBriefing={() => void briefing()}
      onDelete={() => setDeleteOpen(true)}
      onCalendar={() => downloadCalendar(`/api/encounters/${encodeURIComponent(selected.id)}/ics`, 'casefile-encounter.ics')}
      onNewTask={() => setTaskOpen(true)}
      onSaveQuestions={saveQuestions}
      onSaveOutcomes={saveOutcomes}
    />
  );

  // Stable identity across re-renders (prep arriving, refetches, a pending create) so the open task dialog keeps what was typed.
  const presetId = selected?.id ?? null;
  const presetDue = selected?.occurredAt && selected.occurredAtPrecision === 'day' ? selected.occurredAt : null;
  const taskPreset = useMemo<Partial<TaskInput> | null>(() => (presetId ? { title: '', sourceType: 'encounter', sourceId: presetId, dueAt: presetDue, ownerPersonId: null } : null), [presetId, presetDue]);

  return (
    <div className="page">
      <PageHeader
        title="Appointments"
        meta={list.isPending || nothingYet ? null : <span className="mono">{upcoming.length} coming up · {past.length} past</span>}
        intro={INTRO}
        actions={{
          primary: { label: 'Add an appointment', onClick: addNew, shortcut: 'n', title: 'A visit, video or phone visit, procedure, test or hospital stay, coming up or already past' },
          more: [{ label: 'Export to my calendar', onClick: exportCalendar, title: 'Saves a calendar file of every appointment coming up, to open in your calendar app', hidden: !upcoming.length }],
        }}
      />
      {nothingYet ? null : (
        <Toolbar label="Views and filters">
          <Segmented
            label="Show"
            value={view}
            onChange={setView}
            options={VIEWS.map((v) => ({ value: v, label: VIEW_WORDS[v], count: v === 'upcoming' ? upcoming.length : past.length, title: v === 'upcoming' ? 'Appointments not marked done yet, soonest first' : 'Appointments done or cancelled, newest first' }))}
          />
          <SearchField label="Find" placeholder="Title, clinician, place or notes" value={qLocal} onChange={setQLocal} width={230} />
          {clinicianOptions.length ? (
            <FilterGroup label="Clinician">
              <Select aria-label="Clinician" value={search.clinicianId ?? ''} options={clinicianOptions} placeholder="Anyone" onChange={(e) => setSearch({ clinicianId: e.target.value || undefined, id: undefined })} />
            </FilterGroup>
          ) : null}
          <ToolbarKeys
            items={[
              ['j/k', 'move'],
              ['enter', 'edit'],
              ['n', 'add'],
              ['b', 'prepare'],
              ['c', 'mark done'],
              ['t', 'to-do'],
              ['v v', 'coming up or past'],
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
          <div className="en-empty">
            <EmptyState
              title="No appointments yet"
              action={
                <Button variant="primary" onClick={addNew} shortcut="n">
                  Add an appointment
                </Button>
              }
            >
              Add the next visit to keep the questions to ask and get a prep sheet for it, and past visits to keep what was decided with the documents from them.
            </EmptyState>
            <div className="en-empty-docs">
              <VisitDocuments docs={unlinked} onAdd={addFrom} limit={20} />
            </div>
          </div>
        ) : (
          <SplitView storageKey="encounters" defaultLeft={58} minLeft={440} minRight={440} left={left} right={right} />
        )}
      </div>

      <EncounterDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setPreset(null);
          setFormError(null);
        }}
        preset={preset}
        busy={m.create.isPending}
        error={formError}
        onCreate={(input: EncounterInput) =>
          m.create.mutate(input, {
            onSuccess: (e) => {
              setNewOpen(false);
              setPreset(null);
              setFormError(null);
              toast('Appointment added', 'ok');
              setSearch({ view: isUpcoming(e, today) ? undefined : 'past', id: e.id });
            },
            onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
          })
        }
        onUpdate={() => undefined}
      />
      <EncounterDialog
        open={editOpen && Boolean(selected)}
        onClose={() => {
          setEditOpen(false);
          setFormError(null);
        }}
        encounter={selected}
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
      <CompleteDialog
        open={completeOpen && Boolean(selected)}
        initial={selected?.outcomes ?? ''}
        busy={m.complete.isPending}
        onClose={() => setCompleteOpen(false)}
        onConfirm={(outcomes) => {
          const e = latest.current.selected;
          if (!e) return;
          m.complete.mutate(
            { id: e.id, outcomes },
            {
              onSuccess: () => {
                setCompleteOpen(false);
                toast('Appointment marked done', 'ok');
                if (view === 'upcoming') setSearch({ view: 'past', id: e.id }, false);
              },
              onError: fail,
            },
          );
        }}
      />
      <TaskDialog
        open={taskOpen && Boolean(selected)}
        onClose={() => setTaskOpen(false)}
        preset={taskPreset}
        busy={tm.create.isPending}
        onCreate={(input) =>
          tm.create.mutate(input, {
            onSuccess: () => {
              setTaskOpen(false);
              toast('To-do added from this appointment', 'ok');
            },
            onError: fail,
          })
        }
        onUpdate={() => undefined}
      />
      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this appointment?"
        body={<span className="muted">{selected?.title ?? ''}. It is hidden, not erased; its documents and calls stay.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const e = latest.current.selected;
          if (!e) return;
          m.remove.mutate(e.id, {
            onSuccess: () => {
              toast('Appointment deleted', 'ok');
              select(null);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}

function CompleteDialog({ open, initial, busy, onClose, onConfirm }: { open: boolean; initial: string; busy: boolean; onClose: () => void; onConfirm: (outcomes: string | null) => void }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
  }, [open, initial]);
  return (
    <Confirm
      open={open}
      onClose={onClose}
      title="Mark this appointment done"
      confirmLabel="Mark done"
      onConfirm={() => onConfirm(text.trim() || null)}
      body={
        <div className="stack" onKeyDown={(e) => e.stopPropagation()}>
          <label className="small" htmlFor="en-complete-outcomes">
            What was decided, prescribed, ordered or promised (you can add it later too).
          </label>
          <textarea id="en-complete-outcomes" rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} style={{ width: '100%' }} autoFocus />
        </div>
      }
    />
  );
}
