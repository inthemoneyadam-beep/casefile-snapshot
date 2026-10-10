/**
 * /medications — your medications (Current / All), allergies and drugs that must never be given, and a History
 * chart. The Never give banner sits under the page header on every view whenever an active one exists (the data
 * calls it a hard stop; the screen says "never give"). Selection, view, search and status live in the URL so the
 * palette and search can deep-link.
 *
 * The page follows docs/DESIGN.md: one primary action (Add a medication; Add an allergy on the Allergies view), the
 * emergency card as the secondary, the rest under More; a labelled View switch and a search that says what it
 * searches; one line under the toolbar saying what the list holds; the detail pane in its fixed order.
 * Keys: n new medication, i new allergy, e edit, a add an event, h mark or unmark never give, p emergency card,
 * Delete delete, v v next view, j/k/Enter/Esc in every list.
 */
import { useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { MED_STATUSES } from '@shared/enums';
import { dateSortKey } from '@shared/dates';
import { ApiError, useFailToast } from '../api/client';
import { usePeople } from '../api/people';
import {
  isCurrent,
  startShown,
  useIntolerances,
  useMedication,
  useMedicationMutations,
  useMedicationTimeline,
  useMedications,
  useProposals,
  type AcceptInput,
  type Intolerance,
  type MedicationRow,
  type SourceFactCitation,
} from '../api/medications';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { dialogOpen } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { DateText } from '../ui/DateText';
import { Confirm } from '../ui/Dialog';
import { useToast } from '../ui/Toast';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { ToolbarKeys } from '../ui/Toolbar';
import { HardStopBanner } from '../features/medications/HardStopBanner';
import { MedicationDetail } from '../features/medications/MedicationDetail';
import { IntoleranceDetail } from '../features/medications/IntoleranceDetail';
import { AddEventDialog, MedicationFormDialog, IntoleranceFormDialog, ProposalsDialog } from '../features/medications/MedicationDialogs';
import { MedicationGantt } from '../features/medications/MedicationGantt';
import { MedStatus, NeverGiveTag, SeverityTag } from '../features/medications/MedTags';
import { MED_STATUS_OPTIONS, doseWords, eventWords, intoleranceKindWords, optionalMedColumns, plural, type OptionalMedColumn } from '../features/medications/words';
import '../features/medications/medications.css';

const VIEWS = ['current', 'all', 'intolerances', 'history'] as const;
type View = (typeof VIEWS)[number];

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  status: z.enum(MED_STATUSES).optional().catch(undefined),
});
export type MedicationsSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/medications')({
  validateSearch: (s: Record<string, unknown>): MedicationsSearch => searchSchema.parse(s),
  component: MedicationsPage,
});

const INTRO = 'The medications you take and have taken, and the allergies and drugs you must never be given. Each one links back to the page it came from.';

/** What each list holds, in one line under the toolbar. */
const VIEW_INTRO: Record<View, string> = {
  current: 'What you take now, take as needed, or are about to start. Stopped ones are under All.',
  all: 'Every medication on file, past and present.',
  intolerances: 'Allergies, intolerances and drugs that must never be given. One marked never give shows on every medications screen, the Home page and the printed emergency card.',
  history: 'Each medication as a bar from its start to its stop, with a mark for each event. A dashed bar: the start was never written down, so it runs from the first document that mentions it.',
};

function sortableDate(iso: string | null): string | undefined {
  return iso ? dateSortKey(iso) : undefined;
}

/**
 * The list's columns: the name takes the room; how often, how taken, stopped, prescriber and what it is for show only
 * when a row in the list has one (the detail pane shows every field that has a value).
 */
function medColumns(optional: Set<OptionalMedColumn>, hasStop: boolean): ColumnDef<MedicationRow, unknown>[] {
  const cols: Array<ColumnDef<MedicationRow, unknown> | null> = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      cell: ({ row }) => (
        <span>
          {row.original.name}
          {row.original.genericName && row.original.genericName.toLowerCase() !== row.original.name.toLowerCase() ? <span className="muted"> · {row.original.genericName}</span> : null}
        </span>
      ),
      meta: { grow: true, minWidth: 170 },
    },
    { id: 'dose', header: 'Dose', accessorFn: (r) => doseWords(r), cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { width: 72, maxWidth: 120 } },
    optional.has('frequency') ? { id: 'frequency', header: 'How often', accessorFn: (r) => r.frequency ?? '', meta: { width: 90, maxWidth: 150 } } : null,
    optional.has('route') ? { id: 'route', header: 'How taken', accessorFn: (r) => r.route ?? '', meta: { width: 80, maxWidth: 120 } } : null,
    { id: 'status', header: 'Status', accessorKey: 'status', cell: ({ getValue }) => <MedStatus status={String(getValue())} />, meta: { width: 80, shrink: false } },
    {
      id: 'start',
      header: 'Started',
      // Sorted by the date it reads from: the recorded start, or the first mention when the start was never written down.
      accessorFn: (r) => sortableDate(startShown(r).iso),
      sortUndefined: 'last',
      cell: ({ row }) => {
        // The settled timeline (My notes): the start the user settled in Reconciliation, with who said it.
        const settled = row.original.settled?.start;
        if (settled) return <span title={`Settled in Reconciliation: ${row.original.settled!.words}`}><DateText iso={settled.date} precision={settled.precision} text={settled.dateText} /> <span className="faint xs">{settled.by === 'notes' ? 'my notes' : 'settled'}</span></span>;
        const s = startShown(row.original);
        if (s.recorded) return <DateText iso={row.original.startDate} precision={row.original.startDatePrecision} text={row.original.startDateText} />;
        return (
          <span className="med-unrecorded" title={s.iso ? `The start date was never written down. A document first mentions it on ${s.iso}.` : 'The start date was never written down.'}>
            not recorded
          </span>
        );
      },
      meta: { width: 96, shrink: false },
    },
    hasStop ? {
      id: 'stop',
      header: 'Stopped',
      accessorFn: (r) => sortableDate(r.stopDate),
      sortUndefined: 'last',
      cell: ({ row }) => {
        const settled = row.original.settled?.stop;
        if (settled) return <span title={`Settled in Reconciliation: ${row.original.settled!.words}`}><DateText iso={settled.date} precision={settled.precision} text={settled.dateText} /> <span className="faint xs">{settled.by === 'notes' ? 'my notes' : 'settled'}</span></span>;
        return row.original.stopDate ? <DateText iso={row.original.stopDate} precision={row.original.stopDatePrecision} text={row.original.stopDateText} /> : row.original.status === 'stopped' ? <span className="med-unrecorded">not recorded</span> : null;
      },
      meta: { width: 96, shrink: false },
    } : null,
    optional.has('prescriber') ? { id: 'prescriber', header: 'Prescribed by', accessorFn: (r) => r.prescriberName ?? '', meta: { width: 110, maxWidth: 170 } } : null,
    optional.has('indication') ? { id: 'indication', header: 'What it is for', accessorFn: (r) => r.indication ?? '', meta: { width: 120, maxWidth: 200 } } : null,
  ];
  return cols.filter(Boolean) as ColumnDef<MedicationRow, unknown>[];
}

const intoleranceColumns: ColumnDef<Intolerance, unknown>[] = [
  {
    id: 'substance',
    header: 'Substance',
    accessorKey: 'substance',
    // A drug that must never be given says so beside its name.
    cell: ({ row }) => (
      <span className="med-substance">
        {row.original.substance}
        {row.original.hardStop ? <NeverGiveTag /> : null}
      </span>
    ),
    meta: { grow: true, minWidth: 180 },
  },
  { id: 'kind', header: 'Kind', accessorFn: (r) => intoleranceKindWords(r.kind), meta: { width: 80 } },
  { id: 'severity', header: 'How severe', accessorKey: 'severity', cell: ({ getValue }) => <SeverityTag severity={String(getValue())} />, meta: { width: 100, shrink: false } },
  { id: 'reaction', header: 'What happens', accessorFn: (r) => r.reaction ?? '', meta: { width: 140, maxWidth: 220 } },
  { id: 'date', header: 'When', accessorFn: (r) => sortableDate(r.date), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />, meta: { width: 96, shrink: false } },
];

function MedicationsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const selectedId = search.id ?? null;
  const meds = useMedications();
  // Deep links (`/medications?id=` from the timeline, search or Home) carry no view; a stopped course
  // is only listed on All, so land there rather than on a Current view that does not show the row.
  const view: View = search.view ?? (selectedId && (meds.data?.items ?? []).some((r) => r.id === selectedId && !isCurrent(r.status)) ? 'all' : 'current');

  const intolerances = useIntolerances();
  const detail = useMedication(view !== 'intolerances' ? selectedId : null);
  const timeline = useMedicationTimeline(view === 'history');
  const people = usePeople();
  const m = useMedicationMutations();

  const [medForm, setMedForm] = useState<'new' | 'edit' | null>(null);
  const [intolForm, setIntolForm] = useState<'new' | 'edit' | null>(null);
  const [eventOpen, setEventOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);
  const [hardStopOpen, setHardStopOpen] = useState(false);
  const [proposalsOpen, setProposalsOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const proposals = useProposals(proposalsOpen);

  const allMeds = useMemo(() => meds.data?.items ?? [], [meds.data]);
  const allIntolerances = useMemo(() => intolerances.data?.items ?? [], [intolerances.data]);
  const hardStops = useMemo(() => allIntolerances.filter((i) => i.hardStop && i.active), [allIntolerances]);
  const viewRows = useMemo(() => {
    if (view === 'current') return allMeds.filter((r) => isCurrent(r.status));
    if (search.status) return allMeds.filter((r) => r.status === search.status);
    return allMeds;
  }, [allMeds, view, search.status]);
  const columns = useMemo(() => medColumns(optionalMedColumns(viewRows), viewRows.some((r) => r.stopDate || r.status === 'stopped')), [viewRows]);
  const counts: Record<View, number> = {
    current: allMeds.filter((r) => isCurrent(r.status)).length,
    all: allMeds.length,
    intolerances: allIntolerances.length,
    history: allMeds.length,
  };

  const selectedMed = view !== 'intolerances' && selectedId ? (allMeds.find((r) => r.id === selectedId) ?? null) : null;
  const selectedIntol = view === 'intolerances' && selectedId ? (allIntolerances.find((r) => r.id === selectedId) ?? null) : null;
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.addEvent.isPending || m.removeEvent.isPending || m.createIntolerance.isPending || m.updateIntolerance.isPending || m.removeIntolerance.isPending || m.accept.isPending;

  function setSearch(patch: Partial<MedicationsSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function setView(v: View) {
    setSearch({ view: v === 'current' ? undefined : v, id: undefined, status: v === 'all' ? search.status : undefined }, false);
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function openCitation(c: SourceFactCitation) {
    void navigate({ to: '/documents/$id', params: { id: c.documentId }, search: { page: c.pageNumber, cite: c.citationId } });
  }
  function openCard() {
    void navigate({ to: '/print/emergency-card' });
  }
  /** Enter on a row: the page it came from when there is one, else the editor. */
  function openSelected() {
    const d = latest.current;
    if (d.view === 'intolerances') {
      const c = d.selectedIntol?.sourceFact?.citation;
      if (c) openCitation(c);
      else if (d.selectedIntol) setIntolForm('edit');
      return;
    }
    const c = d.detail?.sourceFact?.citation;
    if (c) openCitation(c);
    else if (d.selectedMed) setMedForm('edit');
  }
  function addEvent() {
    if (latest.current.detail) setEventOpen(true);
    else toast('Pick a medication first.');
  }

  const latest = useRef({ view, selectedMed, selectedIntol, detail: detail.data ?? null });
  latest.current = { view, selectedMed, selectedIntol, detail: detail.data ?? null };

  const hasMed = () => latest.current.view !== 'intolerances' && Boolean(latest.current.selectedMed);
  const hasIntol = () => latest.current.view === 'intolerances' && Boolean(latest.current.selectedIntol);
  const hasSelection = () => hasMed() || hasIntol();

  useBindings(
    [
      { keys: 'n', description: 'Add a medication', group: 'Lists', run: () => !dialogOpen() && setMedForm('new') },
      { keys: 'i', description: 'Add an allergy or a drug that must never be given', group: 'Lists', run: () => !dialogOpen() && setIntolForm('new') },
      { keys: 'e', description: 'Edit the selected medication or allergy', group: 'Lists', when: hasSelection, run: () => !dialogOpen() && (hasIntol() ? setIntolForm('edit') : setMedForm('edit')) },
      // Not 'v' alone: a plain v would shadow the global v t / v b / v r appearance chords whenever a row is selected.
      { keys: 'a', description: 'Add an event to the selected medication', group: 'Lists', when: hasMed, run: () => !dialogOpen() && addEvent() },
      { keys: 'h', description: 'Mark or unmark the selected allergy as never give (asks first)', group: 'Lists', when: hasIntol, run: () => !dialogOpen() && setHardStopOpen(true) },
      { keys: 'p', description: 'Open the emergency card', group: 'Lists', run: () => !dialogOpen() && openCard() },
      { keys: 'Delete', description: 'Delete the selected medication or allergy (asks first)', group: 'Lists', when: hasSelection, run: () => !dialogOpen() && setDeleteOpen(true) },
      { keys: 'v v', description: 'Next view: current, all, allergies, history', group: 'Lists', run: () => !dialogOpen() && setView(VIEWS[(VIEWS.indexOf(latest.current.view) + 1) % VIEWS.length]) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'medications.card', title: 'Open emergency card', group: 'Medications', keywords: 'print never give hard stop allergy', shortcut: 'p', run: openCard },
      { id: 'medications.propose', title: 'Find medications and allergies in your documents', group: 'Medications', keywords: 'facts extract accept allergy intolerance propose add from documents', run: () => setProposalsOpen(true) },
      { id: 'medications.new', title: 'Add a medication', group: 'Medications', keywords: 'new', shortcut: 'n', run: () => setMedForm('new') },
      { id: 'medications.new-intolerance', title: 'Add an allergy or a drug that must never be given', group: 'Medications', keywords: 'new intolerance hard stop never give', shortcut: 'i', run: () => setIntolForm('new') },
      { id: 'medications.event', title: 'Add an event to the selected medication', group: 'Medications', keywords: 'start stop dose change hold resume reaction note', shortcut: 'a', when: hasMed, run: addEvent },
      { id: 'medications.current', title: 'Medications: show current', group: 'Medications', run: () => setView('current') },
      { id: 'medications.all', title: 'Medications: show all', group: 'Medications', run: () => setView('all') },
      { id: 'medications.intolerances', title: 'Medications: show allergies and never give', group: 'Medications', keywords: 'intolerances hard stops', run: () => setView('intolerances') },
      { id: 'medications.history', title: 'Medications: show the history chart', group: 'Medications', keywords: 'gantt timeline', run: () => setView('history') },
    ],
    [],
  );

  // ---- actions ---------------------------------------------------------------
  function submitMedication(input: Parameters<typeof m.create.mutate>[0]) {
    setFormError(null);
    if (medForm === 'edit' && latest.current.selectedMed) {
      m.update.mutate(
        { id: latest.current.selectedMed.id, patch: input },
        {
          onSuccess: () => {
            setMedForm(null);
            toast('Saved', 'ok');
          },
          onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
        },
      );
    } else {
      m.create.mutate(input, {
        onSuccess: (row) => {
          setMedForm(null);
          toast(`Added ${row.name}`, 'ok');
          // Land where the new row is visible: a course that is not current is not on the Current view.
          const v = latest.current.view;
          const target: View = v === 'intolerances' || (v === 'current' && !isCurrent(row.status)) ? 'all' : v;
          setSearch({ view: target === 'current' ? undefined : target, id: row.id }, false);
        },
        onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  function submitIntolerance(input: Parameters<typeof m.createIntolerance.mutate>[0]) {
    setFormError(null);
    if (intolForm === 'edit' && latest.current.selectedIntol) {
      m.updateIntolerance.mutate(
        { id: latest.current.selectedIntol.id, patch: input },
        {
          onSuccess: () => {
            setIntolForm(null);
            toast('Saved', 'ok');
          },
          onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
        },
      );
    } else {
      m.createIntolerance.mutate(input, {
        onSuccess: (row) => {
          setIntolForm(null);
          toast(row.hardStop ? `Added ${row.substance}, marked never give` : `Added ${row.substance}`, 'ok');
          setSearch({ view: 'intolerances', id: row.id }, false);
        },
        onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  function submitEvent(input: Parameters<typeof m.addEvent.mutate>[0]['input']) {
    const med = latest.current.detail;
    if (!med) return;
    setFormError(null);
    m.addEvent.mutate(
      { medicationId: med.id, input },
      {
        onSuccess: () => {
          setEventOpen(false);
          toast(`Event added to ${med.name}: ${eventWords(input.kind)}`, 'ok');
        },
        onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
      },
    );
  }
  function toggleHardStop() {
    const it = latest.current.selectedIntol;
    if (!it) return;
    m.updateIntolerance.mutate(
      { id: it.id, patch: { hardStop: !it.hardStop } },
      { onSuccess: (row) => toast(row.hardStop ? `${row.substance} is now marked never give` : `${row.substance} is no longer marked never give`, 'ok'), onError: fail },
    );
  }
  function toggleActive() {
    const it = latest.current.selectedIntol;
    if (!it) return;
    m.updateIntolerance.mutate({ id: it.id, patch: { active: !it.active } }, { onSuccess: (row) => toast(row.active ? 'It applies again' : 'Marked as no longer applying; it leaves the Never give banner and the card', 'ok'), onError: fail });
  }
  function doDelete() {
    const d = latest.current;
    if (d.view === 'intolerances' && d.selectedIntol) {
      m.removeIntolerance.mutate(d.selectedIntol.id, {
        onSuccess: () => {
          toast('Allergy deleted', 'ok');
          select(null);
        },
        onError: fail,
      });
    } else if (d.selectedMed) {
      m.remove.mutate(d.selectedMed.id, {
        onSuccess: () => {
          toast('Medication deleted', 'ok');
          select(null);
        },
        onError: fail,
      });
    }
  }
  function accept(input: AcceptInput) {
    m.accept.mutate(input, {
      onSuccess: (r) => {
        if (r.kind === 'medication') toast(r.existing ? `Already listed: ${r.medication.name}` : `Added ${r.medication.name} from the document`, 'ok');
        else if (r.kind === 'intolerance') toast(r.existing ? `Already listed: ${r.intolerance.substance}` : `Added ${r.intolerance.substance}${r.intolerance.hardStop ? ', marked never give' : ''}`, 'ok');
        else toast(r.existing ? `Already added to ${r.medication.name}` : `Added to ${r.medication.name} as an event: ${eventWords(r.event.kind)}`, 'ok');
        void proposals.refetch();
      },
      onError: fail,
    });
  }

  // ---- render ----------------------------------------------------------------
  const loading = view === 'intolerances' ? intolerances.isPending : view === 'history' ? timeline.isPending : meds.isPending;
  const loadError = view === 'intolerances' ? intolerances.error : view === 'history' ? timeline.error : meds.error;
  const isAllergies = view === 'intolerances';
  // Nothing on file for this view at all: the page body is the first step (no list, no empty right pane).
  const nothingYet = isAllergies ? intolerances.isSuccess && allIntolerances.length === 0 : meds.isSuccess && allMeds.length === 0;
  const filtered = Boolean(search.q || (view === 'all' && search.status));

  const firstRun = isAllergies ? (
    <EmptyState
      title="No allergies recorded"
      action={
        <div className="med-empty-actions">
          <Button variant="primary" shortcut="i" onClick={() => setIntolForm('new')}>
            Add an allergy
          </Button>
          <Button onClick={() => setProposalsOpen(true)}>Find allergies in your documents</Button>
        </div>
      }
    >
      Allergies, intolerances and any drug you must never be given. One marked never give shows on every medications screen, the Home page and the printed emergency card, so it is seen before anything is given.
    </EmptyState>
  ) : (
    <EmptyState
      title="No medications yet"
      action={
        <div className="med-empty-actions">
          <Button variant="primary" shortcut="n" onClick={() => setMedForm('new')}>
            Add a medication
          </Button>
          <Button onClick={() => setProposalsOpen(true)}>Find medications in your documents</Button>
        </div>
      }
    >
      Add the medications you take and have taken, or let Claude find them in your documents. Each one keeps its doses, starts and stops, and the page it came from.
    </EmptyState>
  );

  const left = loadError ? (
    <Loading>Could not load this list: {loadError.message}</Loading>
  ) : loading ? (
    <Loading>{isAllergies ? 'Loading the allergies…' : view === 'history' ? 'Loading the history…' : 'Loading the medications…'}</Loading>
  ) : isAllergies ? (
    <DataTable<Intolerance>
      columns={intoleranceColumns}
      data={allIntolerances}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={(r) => select(r?.id ?? null)}
      onOpen={() => openSelected()}
      globalFilter={search.q ?? ''}
      rowClassName={(r) => (r.active ? undefined : 'dim')}
      emptyText="Nothing matches this search. Clear filters (in the toolbar) shows every allergy again."
      tableId="medications.allergies"
      autoFocus
      footer={<span>{hardStops.length ? `${plural(hardStops.length, 'drug')} marked never give` : 'None marked never give'}</span>}
    />
  ) : view === 'history' ? (
    <MedicationGantt items={timeline.data?.items ?? []} selectedId={selectedId} onSelect={select} onOpen={() => openSelected()} autoFocus />
  ) : (
    <DataTable<MedicationRow>
      key={columns.map((c) => c.id).join(',')}
      columns={columns}
      data={viewRows}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={(r) => select(r?.id ?? null)}
      onOpen={() => openSelected()}
      globalFilter={search.q ?? ''}
      emptyText={filtered ? 'Nothing matches. Clear filters (in the toolbar) shows every medication again.' : 'Nothing current: every medication on file is stopped or not known. View: All shows them.'}
      tableId={`medications.${view}`}
      autoFocus
      footer={<span>{counts.current} current · {counts.all - counts.current} stopped or not known</span>}
    />
  );

  let right: React.ReactNode;
  if (isAllergies) {
    right = selectedIntol ? (
      <IntoleranceDetail item={selectedIntol} busy={busy} onEdit={() => setIntolForm('edit')} onToggleHardStop={() => setHardStopOpen(true)} onToggleActive={toggleActive} onDelete={() => setDeleteOpen(true)} onOpenCard={openCard} onOpenCitation={openCitation} />
    ) : selectedId && !intolerances.isPending ? (
      <EmptyState title="That allergy is not listed any more">It may have been deleted. Pick one from the list.</EmptyState>
    ) : (
      <EmptyState title="Pick an allergy">See what happens, how severe it is, whether it must never be given and the page it came from. Move with j and k; Enter opens the page it came from.</EmptyState>
    );
  } else if (!selectedId) {
    right = (
      <EmptyState title="Pick a medication">
        See its dose, when it started and stopped, what happened along the way and the page it came from. Move with j and k; Enter opens the page it came from.
      </EmptyState>
    );
  } else if (detail.isPending) {
    right = <Loading />;
  } else if (detail.isError || !detail.data) {
    right = (
      <EmptyState title="This medication is not available">
        {detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted or is missing. ' : ''}Pick another one from the list.
      </EmptyState>
    );
  } else {
    right = (
      <MedicationDetail
        med={detail.data}
        busy={busy}
        onEdit={() => setMedForm('edit')}
        onDelete={() => setDeleteOpen(true)}
        onOpenCard={openCard}
        onAddEvent={addEvent}
        onDeleteEvent={(id) => setDeleteEventId(id)}
        onOpenCitation={openCitation}
      />
    );
  }

  const deleteTarget = isAllergies ? selectedIntol?.substance : selectedMed?.name;
  const addMed = { label: 'Add a medication', onClick: () => setMedForm('new'), shortcut: 'n', title: 'Type in a medication with its dose and dates' };
  const addAllergy = { label: 'Add an allergy', onClick: () => setIntolForm('new'), shortcut: 'i', title: 'An allergy, an intolerance, or a drug that must never be given' };
  const keyHints = [
    ['j/k', 'move'] as const,
    ['enter', 'open the page'] as const,
    ['v v', 'view'] as const,
    isAllergies ? (['i', 'add'] as const) : (['n', 'add'] as const),
    ['e', 'edit'] as const,
    isAllergies ? (['h', 'never give'] as const) : (['a', 'event'] as const),
    ['p', 'card'] as const,
  ];

  return (
    <div className="page">
      <PageHeader
        title="Medications"
        intro={INTRO}
        actions={{
          primary: isAllergies ? addAllergy : addMed,
          secondary: [{ label: 'Emergency card', onClick: openCard, shortcut: 'p', title: 'The printable card with what you take and what must never be given' }],
          more: [
            isAllergies ? addMed : { ...addAllergy, label: 'Add an allergy or a drug never to give' },
            { label: 'Find medications in your documents', onClick: () => setProposalsOpen(true), title: 'Medications and allergies Claude found in your documents that are not on your list yet' },
          ],
        }}
      />
      <HardStopBanner items={hardStops} />
      <Toolbar label="View and search">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'current', label: 'Current', count: counts.current, title: VIEW_INTRO.current },
            { value: 'all', label: 'All', count: counts.all, title: VIEW_INTRO.all },
            { value: 'intolerances', label: 'Allergies and never give', count: counts.intolerances, title: VIEW_INTRO.intolerances },
            { value: 'history', label: 'History chart', title: 'Each medication as a bar from its start to its stop' },
          ]}
        />
        {view === 'all' ? (
          <FilterGroup label="Status">
            <Select aria-label="Status" value={search.status ?? ''} options={MED_STATUS_OPTIONS} placeholder="Any" onChange={(e) => setSearch({ status: (e.target.value || undefined) as MedicationsSearch['status'], id: undefined })} />
          </FilterGroup>
        ) : null}
        {view !== 'history' && !nothingYet ? (
          <SearchField label="Find" placeholder={isAllergies ? 'Substance or reaction, e.g. penicillin' : 'Name or dose, e.g. lisinopril'} value={search.q ?? ''} onChange={(v) => setSearch({ q: v || undefined })} width={isAllergies ? 270 : 230} />
        ) : null}
        <ToolbarKeys items={keyHints}>
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => setSearch({ q: undefined, status: undefined })}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      {nothingYet ? null : <p className="med-list-intro">{VIEW_INTRO[view]}</p>}
      <div className="page-body flush">
        {nothingYet ? firstRun : <SplitView storageKey={view === 'history' ? 'medications.history' : 'medications'} defaultLeft={view === 'history' ? 58 : 60} minLeft={view === 'history' ? 480 : 440} minRight={420} left={left} right={right} />}
      </div>

      <MedicationFormDialog
        open={medForm === 'new' || (medForm === 'edit' && Boolean(detail.data))}
        onClose={() => {
          setMedForm(null);
          setFormError(null);
        }}
        med={medForm === 'edit' ? (detail.data ?? null) : null}
        people={people.data?.items ?? []}
        busy={m.create.isPending || m.update.isPending}
        error={formError}
        onSubmit={submitMedication}
      />
      <IntoleranceFormDialog
        open={intolForm === 'new' || (intolForm === 'edit' && Boolean(selectedIntol))}
        onClose={() => {
          setIntolForm(null);
          setFormError(null);
        }}
        item={intolForm === 'edit' ? selectedIntol : null}
        busy={m.createIntolerance.isPending || m.updateIntolerance.isPending}
        error={formError}
        onSubmit={submitIntolerance}
      />
      <AddEventDialog
        open={eventOpen && Boolean(detail.data)}
        onClose={() => {
          setEventOpen(false);
          setFormError(null);
        }}
        name={detail.data?.name ?? 'this medication'}
        busy={m.addEvent.isPending}
        error={formError}
        onSubmit={submitEvent}
      />
      <ProposalsDialog
        open={proposalsOpen}
        onClose={() => setProposalsOpen(false)}
        items={proposals.data?.items ?? []}
        loading={proposals.isPending}
        medications={allMeds}
        busy={m.accept.isPending}
        onAccept={accept}
        onOpenFact={(p) => {
          setProposalsOpen(false);
          if (p.citation) void navigate({ to: '/documents/$id', params: { id: p.citation.documentId }, search: { page: p.citation.pageNumber, cite: p.citation.citationId } });
          else void navigate({ to: '/facts', search: { id: p.factId } });
        }}
      />
      <Confirm
        open={hardStopOpen}
        onClose={() => setHardStopOpen(false)}
        title={selectedIntol?.hardStop ? `Stop marking ${selectedIntol.substance} as never give?` : `Mark ${selectedIntol?.substance ?? 'this'} as never give?`}
        body={
          <span className="muted">
            {selectedIntol?.hardStop
              ? 'It stays on the list as a caution, but leaves the Never give banner, the Home page and the emergency card.'
              : 'It will show as never give on every medications screen, the Home page and the printed emergency card.'}
          </span>
        }
        confirmLabel={selectedIntol?.hardStop ? 'Stop marking it' : 'Mark as never give'}
        danger={!selectedIntol?.hardStop}
        onConfirm={toggleHardStop}
      />
      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete ${deleteTarget ?? 'this'}?`}
        body={<span className="muted">It is hidden from every list and from search, not erased. Its events and the document details it came from are kept.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={doDelete}
      />
      <Confirm
        open={Boolean(deleteEventId)}
        onClose={() => setDeleteEventId(null)}
        title="Remove this event?"
        body={<span className="muted">It is hidden from the events, the charts and the timeline, not erased. The medication stays; a document detail it came from is offered again under Find medications in your documents.</span>}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const id = deleteEventId;
          if (!id) return;
          m.removeEvent.mutate(id, { onSuccess: () => toast('Event removed', 'ok'), onError: fail });
        }}
      />
    </div>
  );
}
