/**
 * /labs — Lab results. Three views in one split screen, chosen under View:
 *   By test (panels, default)  sample > panel > test under headers (CSF studies together, a blood count as a blood
 *                              count); the selected test's trend, readings and key facts on the right
 *   By document                everything pulled from one report stacked under that document's header
 *   All values                 every value flat and sortable
 * Sample: narrows to one sample (only samples that have values are offered). Find, Range and Dates narrow further.
 * Selection and every filter live in the URL.
 *
 * Red means one thing on this page: a value outside the range printed with it (features/labs/range.ts), whether or
 * not the report flagged it, or flagged by the report; a value that disagrees with a clinical record carries the red
 * "inaccurate" check and a red marker on its row, and is listed under Reconciliation. A value is never judged by its
 * test's range or another lab's (2026-10, rule 8); a summary's own flag is its claim, never red.
 *
 * "Add a computed value" (c, and the command palette; 2026-10-09) works out a value the patient follows from values printed on lab
 * reports (the albumin index, the IgG index, A divided by B times k): features/labs/ComputeDialog.tsx. A computed value
 * is never red and opens in its own pane (features/labs/ComputedDetail.tsx); c on a computed value opens it again with
 * the same inputs.
 *
 * More > "Values re-read" (and the command palette) shows the one-time re-read of every value from the text as printed
 * (features/labs/ReparseReport.tsx).
 *
 * A line that held several tests ("CSF opening pressure / protein: OP 17; protein 52") arrives as one entry per test,
 * ids `<row or fact id>#<index>`, each with the line under it (features/labs/parts.ts). Selection, keys and links use
 * the part id; Edit, Delete and Copy into my lab list act on the original row or fact, and Edit opens only on the
 * whole line as stored. An older link to the original id selects the line's first part.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import '../features/reconcile/reconcile.css';
import { labRowClass } from '../api/labs';
import { TRUST_ORDER } from '../ui/StatusTag';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { dateSortKey } from '@shared/dates';
import { ApiError, useFailToast } from '../api/client';
import { displayValue, useAnalytes, useLab, useLabDocuments, useLabInstitutions, useLabMutations, useLabs, useLabsByDocument, useOrganisedLabs, type AnalyteSummary, type DocumentLabs, type LabEntry } from '../api/labs';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { dialogOpen } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { DateText } from '../ui/DateText';
import { Confirm } from '../ui/Dialog';
import { useToast } from '../ui/Toast';
import { DateRange, FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { AnalyteDetail, SourceCell } from '../features/labs/AnalyteDetail';
import { LabDetail } from '../features/labs/LabDetail';
import { LabFormDialog } from '../features/labs/LabFormDialog';
import { LabPanels, analyteRowId } from '../features/labs/LabPanels';
import { LabsByDocument } from '../features/labs/LabsByDocument';
import { Breakable, LineNote, RangeTag, SourceTag, SpecimenTag, hasLineNote, sampleWords } from '../features/labs/tags';
import { editTarget, isPart, pickSelected, resolveSelection, rowActionId, splitFromOf } from '../features/labs/parts';
import { sourceLine } from '../features/labs/source';
import { passesRange, rangeMark } from '../features/labs/range';
import { rangeUnitSuffix, readingOf } from '../features/labs/reading';
import { ReparseReport } from '../features/labs/ReparseReport';
import { defaultLabsView, labsSearchSchema, type LabsSearch, type LabsView } from '../features/labs/search';
import { ToolbarKeys } from '../ui/Toolbar';
import { ComputeDialog } from '../features/labs/ComputeDialog';
import { ComputedDetail } from '../features/labs/ComputedDetail';
import { useComputeMutations, type ComputeRequest } from '../features/labs/computed-api';
import '../features/labs/labs.css';

type View = LabsView;

/** The list's first share of the width (before any drag): a little more on a smaller screen, so the test names and the readings both fit. */
function labsListShare(view: View): number {
  const narrow = typeof window !== 'undefined' && window.innerWidth < 1400;
  return view === 'panels' ? (narrow ? 58 : 54) : narrow ? 62 : 60;
}
const SAMPLE_ORDER = ['csf', 'serum', 'plasma', 'whole_blood', 'urine', 'other'];

/**
 * The Range filter, in words. Judged here by the rule of the red marks (features/labs/range.ts): each value by its
 * printed flag or the range printed with it; a summary's own flag is never counted.
 */
const RANGE_OPTIONS = [
  { value: 'out', label: 'Outside its range' },
  { value: 'in', label: 'Within its range' },
  { value: 'H', label: 'High' },
  { value: 'L', label: 'Low' },
  { value: 'A', label: 'Abnormal' },
  { value: 'C', label: 'Critical, or flagged C' },
];

export const Route = createFileRoute('/labs')({
  // `id` takes any entry id, a part of a line included (`<row or fact id>#<index>`).
  validateSearch: (s: Record<string, unknown>): LabsSearch => labsSearchSchema.parse(s),
  component: LabsPage,
});

function LabsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const selectedId = search.id ?? null;
  // A timeline or search link carries a bare result id: show it in the results view.
  const view: View = search.view ?? defaultLabsView(selectedId);
  const specimen = search.specimen ?? '';
  const overlay = search.overlay === '1';

  const analyteParams = useMemo(() => ({ specimen: specimen || undefined, from: search.from, to: search.to, q: search.q, analyteKey: search.analyteKey }), [specimen, search.from, search.to, search.q, search.analyteKey]);
  // The Range filter is applied here, by the normal-range rule, so the list shows exactly the values marked red.
  const listParams = analyteParams;
  // The analyte table always loads: it drives the Sample choices and the header counts.
  const analytes = useAnalytes(analyteParams);
  // Every test's names and printed ranges, whatever the filters (said in By test and the test's pane; never used to
  // judge a value, which is judged by its own range only).
  const allAnalytes = useAnalytes({});
  const organised = useOrganisedLabs(analyteParams, view === 'panels');
  const byDoc = useLabsByDocument(listParams, view === 'documents');
  const list = useLabs(listParams, view === 'results');
  const detail = useLab(view !== 'panels' ? selectedId : null);
  const documents = useLabDocuments();
  const institutions = useLabInstitutions();
  const m = useLabMutations();

  const analyteItems = analytes.data?.items ?? [];
  const specimens = analytes.data?.specimens ?? [];
  // The unfiltered summaries' range fields (every range as printed, each with its lab), for By test's Normal range and
  // the test's pane: a Find narrows a test to the values it matched, but the ranges its readings print stay listed.
  const rangeSources = useMemo(
    () => new Map((allAnalytes.data?.items ?? []).map((a) => [analyteRowId(a), { refLow: a.refLow, refHigh: a.refHigh, refText: a.refText, unit: a.unit, ranges: a.ranges, units: a.units }] as const)),
    [allAnalytes.data],
  );
  // One name per test in every view (By test's), whatever each report calls it; a value's detail shows its own wording.
  const names = useMemo(() => new Map((allAnalytes.data?.items ?? []).map((a) => [analyteRowId(a), a.analyte] as const)), [allAnalytes.data]);
  const nameOf = (e: { analyteKey: string; specimen: string; analyte: string }) => names.get(analyteRowId(e)) ?? e.analyte;
  // Each document's own date, for All values' From (a name that does not end with its date still shows one).
  const docDates = useMemo(() => new Map((documents.data ?? []).map((d) => [d.id, d.documentDate] as const)), [documents.data]);
  // A value's mark: its printed flag, else its own range (never the test's).
  const markOf = (e: LabEntry) => rangeMark(e);

  const organisedSpecimens = organised.data?.specimens ?? [];
  const organisedAnalytes = useMemo(() => organisedSpecimens.flatMap((s) => s.panels.flatMap((p) => p.analytes)), [organisedSpecimens]);
  const docGroups = useMemo<DocumentLabs[]>(() => {
    const all = byDoc.data?.documents ?? [];
    if (!search.flag) return all;
    return all
      .map((d) => ({
        ...d,
        specimens: d.specimens
          .map((s) => ({ ...s, panels: s.panels.map((p) => ({ ...p, rows: p.rows.filter((r) => passesRange(search.flag, rangeMark(r), r)) })).filter((p) => p.rows.length) }))
          .filter((s) => s.panels.length),
      }))
      .filter((d) => d.specimens.length);
  }, [byDoc.data, search.flag]);
  const docRows = useMemo(() => docGroups.flatMap((d) => d.specimens.flatMap((s) => s.panels.flatMap((p) => p.rows))), [docGroups]);
  const resultItems = useMemo(() => (list.data?.items ?? []).filter((r) => passesRange(search.flag, rangeMark(r), r)), [list.data, search.flag]);

  const selectedParts = view === 'panels' && selectedId && selectedId.includes('::') ? { analyteKey: selectedId.split('::')[0], specimen: selectedId.split('::')[1] ?? '' } : null;
  const selectedAnalyte: AnalyteSummary | null = selectedParts ? (organisedAnalytes.find((a) => analyteRowId(a) === selectedId) ?? analyteItems.find((a) => analyteRowId(a) === selectedId) ?? null) : null;
  // The entry the URL names: the listed one (a part of a line by its own id, or an older link's original id resolving to
  // the line's first part), else the one fetched by id (a link outside the current filters). A fetch that answers with
  // another entry (a part asked by its line's id) never stands in for the selection.
  const rowItems: LabEntry[] = view === 'results' ? resultItems : view === 'documents' ? docRows : [];
  const listedEntry = view === 'panels' ? null : resolveSelection(rowItems, selectedId);
  const selectedEntry: LabEntry | null = view === 'panels' ? null : pickSelected(rowItems, selectedId, detail.data);
  // Edit on a part opens the whole line as stored, never the part (saving a part would write one test over the line).
  const lineId = selectedEntry && isPart(selectedEntry) ? rowActionId(selectedEntry) : null;
  const lineQuery = useLab(lineId);
  const editEntry: LabEntry | null = editTarget(selectedEntry, lineId ? lineQuery.data : null);
  const wholeLine = Boolean(lineId && editEntry);

  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reparseOpen, setReparseOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [computeOpen, setComputeOpen] = useState(false);
  const [computeInitial, setComputeInitial] = useState<ComputeRequest | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);
  const computeM = useComputeMutations();
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.fromFacts.isPending;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  function setSearch(patch: Partial<LabsSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  // An older link (timeline, search, a finding) names a line's original id, or a part's id is gone after its line was
  // edited: select what it resolved to (the line's first part, or the line), so the list highlights it and j/k move on.
  useEffect(() => {
    if (view === 'panels' || !selectedId || !listedEntry || listedEntry.id === selectedId) return;
    select(listedEntry.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedId, listedEntry?.id]);
  function setView(v: View) {
    setSearch({ view: v, id: undefined }, false);
  }
  function setSpecimen(s: string) {
    setSearch({ specimen: s || undefined, id: undefined });
  }
  function clearFilters() {
    setSearch({ q: undefined, flag: undefined, from: undefined, to: undefined, analyteKey: undefined, specimen: undefined, id: undefined });
  }
  function openSource(e: { documentId: string | null; pageNumber: number | null; citationId: string | null }) {
    if (!e.documentId) {
      toast('This value has no source document.');
      return;
    }
    void navigate({ to: '/documents/$id', params: { id: e.documentId }, search: { page: e.pageNumber ?? undefined, cite: e.citationId ?? undefined } });
  }
  function showTrend(e: LabEntry) {
    setSearch({ view: 'panels', id: analyteRowId(e), analyteKey: undefined, flag: undefined }, false);
  }
  function showResults(a: { analyteKey: string; specimen: string }) {
    setSearch({ view: 'results', id: undefined, analyteKey: a.analyteKey, specimen: a.specimen }, false);
  }
  function showOutOfRange() {
    setSearch({ view: 'results', flag: 'out', id: undefined }, false);
  }
  /** panels -> documents -> results -> panels (`v v`); a selected result keeps its row across documents and results, and becomes its trend in panels. */
  function cycleView() {
    const { view: v, selectedEntry: e } = latest.current;
    if (v === 'panels') setView('documents');
    else if (v === 'documents') setSearch({ view: 'results', analyteKey: undefined }, false);
    else if (e) showTrend(e);
    else setView('panels');
  }
  /** "Add a computed value"; on a computed value, the same formula and inputs again (nothing changes until Save). */
  function openCompute(entry?: LabEntry | null) {
    const rec = entry?.computed?.record;
    // Each input as listed now (a value Claude read is a row once copied into the lab list).
    const now = entry?.computed?.inputIds ?? {};
    setComputeInitial(
      rec
        ? {
            formula: rec.formula.id,
            inputs: Object.fromEntries(rec.inputs.map((i) => [i.slot, now[i.slot] ?? i.entryId])),
            ...(rec.formula.id === 'ratio' ? { k: rec.formula.k, unit: rec.formula.unit, name: rec.formula.name, decimals: rec.formula.decimals } : {}),
          }
        : null,
    );
    setComputeError(null);
    setComputeOpen(true);
  }
  function importFromFacts(factIds?: string[]) {
    m.fromFacts.mutate(factIds ? { factIds } : {}, {
      onSuccess: (r) => {
        toast(r.created ? `Copied ${r.created} value${r.created === 1 ? '' : 's'} into your lab list${r.skipped ? `; ${r.skipped} skipped` : ''}` : 'Nothing new to copy: every value Claude read is in your lab list already', r.created ? 'ok' : 'info');
        if (factIds && r.items[0]) select(r.items[0].id);
      },
      onError: fail,
    });
  }
  // Only samples that have values are offered (and the one chosen, should a filter empty it).
  const sampleChoices = SAMPLE_ORDER.filter((s) => specimens.some((x) => x.specimen === s && x.count > 0) || s === specimen);
  function cycleSpecimen() {
    const order = ['', ...latest.current.sampleChoices];
    const i = order.indexOf(latest.current.specimen);
    setSpecimen(order[(i + 1) % order.length]);
  }

  // Chart points dispatch this so the detail component stays navigation-free.
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const t = (ev as CustomEvent<{ id: string; page?: number }>).detail;
      if (t?.id) void navigate({ to: '/documents/$id', params: { id: t.id }, search: { page: t.page } });
    };
    window.addEventListener('casefile:labs-open', onOpen);
    return () => window.removeEventListener('casefile:labs-open', onOpen);
  }, [navigate]);

  const latest = useRef({ view, selectedEntry, selectedAnalyte, selectedParts, specimen, overlay, busy, editEntry, sampleChoices });
  latest.current = { view, selectedEntry, selectedAnalyte, selectedParts, specimen, overlay, busy, editEntry, sampleChoices };
  const rowViews = () => latest.current.view !== 'panels';
  // Edit needs the entry the form would save over: the row itself, or for a part the whole line once it is loaded.
  // A computed value is never edited by hand (delete it and compute it again).
  const canEdit = () => rowViews() && latest.current.selectedEntry?.source === 'row' && !latest.current.selectedEntry.computed && latest.current.editEntry?.source === 'row' && !dialogOpen();
  const canDelete = () => rowViews() && latest.current.selectedEntry?.source === 'row' && !dialogOpen();
  const isVirtual = () => rowViews() && latest.current.selectedEntry?.source === 'fact' && !dialogOpen();

  useBindings(
    [
      { keys: 'n', description: 'Add a lab value', group: 'Lists', run: () => !dialogOpen() && setNewOpen(true) },
      { keys: 'c', description: 'Add a computed value (albumin index, IgG index); on a computed value, compute it again', group: 'Lists', run: () => !dialogOpen() && openCompute(rowViews() ? latest.current.selectedEntry : null) },
      { keys: 'e', description: 'Edit the selected value', group: 'Lists', when: canEdit, run: () => setEditOpen(true) },
      { keys: 'f', description: "Copy every value Claude read into your lab list (so you can edit them)", group: 'Lists', run: () => !dialogOpen() && !latest.current.busy && importFromFacts() },
      { keys: 'i', description: 'Copy the selected value Claude read into your lab list', group: 'Lists', when: isVirtual, run: () => latest.current.selectedEntry?.factId && importFromFacts([latest.current.selectedEntry.factId]) },
      { keys: 's', description: 'Next sample: all, then each sample that has values', group: 'Lists', run: () => !dialogOpen() && cycleSpecimen() },
      // View keys are `v` chords: a bare `v` here would swallow the global `v t` / `v b` / `v r` appearance chords.
      { keys: 'v v', description: 'Next view: by test, by document, all values', group: 'Lists', run: () => !dialogOpen() && cycleView() },
      { keys: 'v p', description: 'View by test (sample, panel, test)', group: 'Lists', run: () => !dialogOpen() && setView('panels') },
      { keys: 'v d', description: 'View by document (values from each report)', group: 'Lists', run: () => !dialogOpen() && setView('documents') },
      { keys: 'v l', description: 'View all values (one flat list)', group: 'Lists', run: () => !dialogOpen() && setView('results') },
      { keys: 'm', description: 'Show or hide medication courses under the trend', group: 'Lists', when: () => latest.current.view === 'panels' && !dialogOpen(), run: () => setSearch({ overlay: latest.current.overlay ? undefined : '1' }) },
      { keys: 't', description: 'Show the trend of the selected value', group: 'Lists', when: () => rowViews() && Boolean(latest.current.selectedEntry) && !dialogOpen(), run: () => latest.current.selectedEntry && showTrend(latest.current.selectedEntry) },
      { keys: 'o', description: 'Open the page the selected value came from', group: 'Lists', when: () => rowViews() && Boolean(latest.current.selectedEntry?.documentId) && !dialogOpen(), run: () => latest.current.selectedEntry && openSource(latest.current.selectedEntry) },
      { keys: 'Delete', description: 'Delete the selected value (asks first)', group: 'Lists', when: canDelete, run: () => setDeleteOpen(true) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'labs.new', title: 'Lab results: add a lab value', group: 'Labs', keywords: 'add lab value new result', shortcut: 'n', run: () => setNewOpen(true) },
      { id: 'labs.compute', title: 'Lab results: add a computed value (albumin index, IgG index, A divided by B)', group: 'Labs', keywords: 'compute computed albumin index igg index ratio formula csf serum qalb', shortcut: 'c', run: () => openCompute(null) },
      {
        id: 'labs.compute-again',
        title: 'Lab results: compute the selected value again',
        group: 'Labs',
        keywords: 'compute again computed input changed albumin index',
        when: () => rowViews() && Boolean(latest.current.selectedEntry?.computed),
        run: () => openCompute(latest.current.selectedEntry),
      },
      { id: 'labs.from-facts', title: "Lab results: copy Claude's values into my lab list", group: 'Labs', keywords: 'import facts lab extracted results add to list', shortcut: 'f', run: () => importFromFacts() },
      { id: 'labs.csf', title: 'Lab results: show the CSF (spinal fluid) tests', group: 'Labs', keywords: 'csf spinal fluid lumbar puncture', run: () => setSearch({ specimen: 'csf', id: undefined, view: 'panels' }, false) },
      { id: 'labs.serum', title: 'Lab results: show the blood (serum) tests', group: 'Labs', keywords: 'serum blood', run: () => setSearch({ specimen: 'serum', id: undefined }, false) },
      { id: 'labs.panels', title: 'Lab results: view by test', group: 'Labs', keywords: 'analytes grouped stacked headers panels', run: () => setView('panels') },
      { id: 'labs.documents', title: 'Lab results: view by document', group: 'Labs', keywords: 'by document report stacked', run: () => setView('documents') },
      { id: 'labs.results', title: 'Lab results: view all values', group: 'Labs', keywords: 'flat list results', run: () => setView('results') },
      { id: 'labs.out-of-range', title: 'Lab results: show values outside the normal range', group: 'Labs', keywords: 'abnormal high low flag out of range red', run: showOutOfRange },
      { id: 'labs.overlay', title: 'Lab results: show or hide medications under the trend', group: 'Labs', shortcut: 'm', run: () => setSearch({ overlay: latest.current.overlay ? undefined : '1' }) },
      {
        id: 'labs.trend',
        title: 'Lab results: show the trend of the selected value',
        group: 'Labs',
        shortcut: 't',
        when: () => rowViews() && Boolean(latest.current.selectedEntry),
        run: () => {
          if (latest.current.selectedEntry) showTrend(latest.current.selectedEntry);
        },
      },
      {
        id: 'labs.source',
        title: 'Lab results: open the page the selected value came from',
        group: 'Labs',
        shortcut: 'o',
        when: () => rowViews() && Boolean(latest.current.selectedEntry?.documentId),
        run: () => {
          if (latest.current.selectedEntry) openSource(latest.current.selectedEntry);
        },
      },
      { id: 'labs.edit', title: 'Lab results: edit the selected value', group: 'Labs', shortcut: 'e', when: () => rowViews() && latest.current.selectedEntry?.source === 'row' && latest.current.editEntry?.source === 'row', run: () => setEditOpen(true) },
      { id: 'labs.reparse-report', title: 'Lab results: values re-read report', group: 'Labs', keywords: 'values re-read reread report printed limits ranges flags what changed 2026', run: () => setReparseOpen(true) },
    ],
    [],
  );

  // All values. Widths that fit the pane at 1280px (657px): Date 96, Value 124 (wraps), Check from 88 (its tag);
  // Value sorts by its measurement (a limit or words by their text, after the numbers);
  // Test and From share the rest (both grow). From leads with the document's date, the part that tells two reports
  // apart ("2024-09-17 · Lab report, p.1"), and wraps to two lines before anything ends with "…".
  const resultColumns = useMemo<ColumnDef<LabEntry, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (r) => (r.date ? dateSortKey(r.date) : undefined), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />, meta: { width: 96, shrink: false } },
      {
        id: 'analyte',
        header: 'Test',
        accessorKey: 'analyte',
        // The name wraps to two lines before it ends with "…"; a note about its line ("one line, several tests", "from
        // one line") sits on a line of its own under it, so the two-line limit never hides it.
        cell: ({ row }) => (
          <>
            <div className="dt-clamp">
              <Breakable text={names.get(analyteRowId(row.original)) ?? row.original.analyte} />
            </div>
            {hasLineNote(row.original) ? (
              <div className="labs-linenote-row">
                <LineNote entry={row.original} />
              </div>
            ) : null}
          </>
        ),
        // Grows up to 240px; the room beyond goes to From, whose document names are the longer words. 'wrap': the
        // cell lays out its own two-line name (above), so the table does not clamp the note away with it.
        meta: { grow: true, minWidth: 130, maxWidth: 240, className: 'wrap' },
      },
      ...(specimen || sampleChoices.length <= 1 ? [] : [{ id: 'specimen', header: 'Sample', accessorKey: 'specimen', cell: ({ getValue }: { getValue: () => unknown }) => <SpecimenTag specimen={String(getValue())} />, meta: { width: 72 } } as ColumnDef<LabEntry, unknown>]),
      {
        id: 'value',
        header: 'Value',
        accessorFn: (r) => readingOf(r).measurement ?? displayValue(r),
        cell: ({ row }) => {
          const r = row.original;
          const v = readingOf(r);
          const mark = rangeMark(r);
          // The value's own range is in the hover and the value's detail (By test lists the test's ranges).
          const ref = v.rangeShown;
          const unit = rangeUnitSuffix(v, ref);
          return (
            <span className="labs-value" title={ref ? `${v.role === 'claimed' ? 'Range this document gives' : 'Range printed with it'}: ${ref}${unit}${v.lab ? ` (${v.lab})` : ''}` : 'No range printed with this value'}>
              {displayValue(r) ? <Breakable text={displayValue(r)} /> : '—'}
              {r.unit ? <span className="labs-unit"> {r.unit}</span> : null}
              {mark ? (
                <>
                  {' '}
                  <RangeTag mark={mark} />
                </>
              ) : null}
            </span>
          );
        },
        // Its content width ("94 mg/dL high" on one line) where there is room; in a narrow pane it gives way down to
        // 124px and the mark wraps under the value.
        meta: { width: 124, maxWidth: 148, wrap: true },
      },
      {
        id: 'source',
        header: 'From',
        accessorFn: (r) => sourceLine(r.documentTitle, r.documentId ? (docDates.get(r.documentId) ?? null) : null, r.pageNumber),
        cell: ({ row }) => <SourceCell row={row.original} documentDate={row.original.documentId ? (docDates.get(row.original.documentId) ?? null) : null} />,
        meta: { grow: true, minWidth: 180 },
      },
      // What needs a look sorts first: inaccurate, then needs a source, not backed yet, accurate, verified.
      {
        id: 'status',
        header: 'Check',
        accessorFn: (r) => (r.trust ? TRUST_ORDER[r.trust.trust] : 9),
        cell: ({ row }) => <SourceTag source={row.original.source} trust={row.original.trust} factStatus={row.original.factStatus} factBasis={row.original.factBasis} factDeleted={row.original.factDeleted} notes={row.original.notes} computed={row.original.computed} />,
        meta: { width: 88, shrink: false },
      },
    ],
    [specimen, names, sampleChoices.length, docDates],
  );

  const totalResults = specimens.reduce((n, s) => n + s.count, 0);
  const anyFilter = Boolean(search.q || search.flag || search.from || search.to || search.analyteKey || specimen);
  const nothingYet = totalResults === 0 && !anyFilter && !analytes.isPending;
  const analyteName = search.analyteKey ? (analyteItems.find((a) => a.analyteKey === search.analyteKey)?.analyte ?? allAnalytes.data?.items.find((a) => a.analyteKey === search.analyteKey)?.analyte ?? 'one test') : null;
  const filteredEmpty = 'Nothing matches these filters. Clear filters (in the toolbar) shows every value again.';
  const firstRun = (
    <EmptyState
      title="No lab results yet"
      action={
        <Button variant="primary" onClick={() => setNewOpen(true)} shortcut="n">
          Add a lab value
        </Button>
      }
    >
      Lab values appear here by themselves once Claude reads them from your documents (lab reports, clinic notes, letters). You can also type one in.
    </EmptyState>
  );
  const rowsFooter = (items: LabEntry[]) => {
    const out = items.filter((r) => markOf(r)).length;
    const wrong = items.filter((r) => r.trust?.trust === 'inaccurate').length;
    return (
      <span>
        {out} outside the range printed with {out === 1 ? 'it' : 'them'}
        {wrong ? ` · ${wrong} disagree${wrong === 1 ? 's' : ''} with a clinical record` : ''}
      </span>
    );
  };

  const left = nothingYet ? (
    firstRun
  ) : view === 'panels' ? (
    organised.isPending ? (
      <Loading>Loading the tests…</Loading>
    ) : organised.isError ? (
      <Loading>Could not load the tests: {organised.error instanceof Error ? organised.error.message : 'error'}</Loading>
    ) : (
      <LabPanels
        key="panels"
        specimens={organisedSpecimens}
        selectedId={selectedId}
        onSelect={(a) => select(a ? analyteRowId(a) : null)}
        onOpen={(a) => showResults(a)}
        emptyText={filteredEmpty}
        footer={<span>Readings count each measurement once, even when several documents repeat it.</span>}
        ranges={rangeSources}
      />
    )
  ) : view === 'documents' ? (
    byDoc.isPending ? (
      <Loading>Loading the documents…</Loading>
    ) : byDoc.isError ? (
      <Loading>Could not load the documents: {byDoc.error instanceof Error ? byDoc.error.message : 'error'}</Loading>
    ) : (
      <LabsByDocument key="documents" documents={docGroups} selectedId={selectedId} onSelect={(r) => select(r?.id ?? null)} onOpen={(r) => openSource(r)} emptyText={filteredEmpty} footer={rowsFooter(docRows)} names={names} />
    )
  ) : list.isPending ? (
    <Loading>Loading the values…</Loading>
  ) : list.isError ? (
    <Loading>Could not load the values: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
  ) : (
    <DataTable
      columns={resultColumns}
      data={resultItems}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={(r) => select(r?.id ?? null)}
      onOpen={(r) => openSource(r)}
      initialSort={[{ id: 'date', desc: true }]}
      rowClassName={labRowClass}
      emptyText={filteredEmpty}
      footer={rowsFooter(resultItems)}
      tableId="labs.values"
      autoFocus
    />
  );

  const right = nothingYet ? null : view === 'panels' ? (
    selectedParts ? (
      <AnalyteDetail
        key={selectedId}
        analyteKey={selectedParts.analyteKey}
        specimen={selectedParts.specimen}
        summary={selectedAnalyte}
        range={selectedId ? (rangeSources.get(selectedId) ?? null) : null}
        from={search.from}
        to={search.to}
        overlay={overlay}
        busy={busy}
        onToggleOverlay={() => setSearch({ overlay: overlay ? undefined : '1' })}
        onNewResult={() => setNewOpen(true)}
        onShowResults={() => showResults(selectedParts)}
        onImportAll={() => importFromFacts()}
      />
    ) : organisedAnalytes.length ? (
      <EmptyState title="Pick a test">
        Its trend over time, each reading and where it came from show here. Move with j and k (or the arrow keys); Enter lists every value of the test.
      </EmptyState>
    ) : null
  ) : !selectedId ? (
    (view === 'documents' ? docRows : resultItems).length ? (
      <EmptyState title="Pick a value">See where it came from, how it was checked against your clinical records, and its trend. Enter opens its page.</EmptyState>
    ) : null
  ) : detail.isPending && !selectedEntry ? (
    <Loading />
  ) : !selectedEntry ? (
    <EmptyState title="This value is not available">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted, or its line was edited. ' : ''}Pick another value on the left.</EmptyState>
  ) : selectedEntry.computed ? (
    <ComputedDetail
      entry={selectedEntry}
      name={nameOf(selectedEntry)}
      busy={busy}
      onShowTrend={() => showTrend(selectedEntry)}
      onComputeAgain={() => openCompute(selectedEntry)}
      onDelete={() => setDeleteOpen(true)}
    />
  ) : (
    <LabDetail
      entry={selectedEntry}
      busy={busy}
      lineEditable={wholeLine}
      name={nameOf(selectedEntry)}
      onEdit={() => setEditOpen(true)}
      onDelete={() => setDeleteOpen(true)}
      onImport={() => selectedEntry.factId && importFromFacts([selectedEntry.factId])}
      onShowTrend={() => showTrend(selectedEntry)}
      onOpenSource={() => openSource(selectedEntry)}
    />
  );

  // Memoised on its parts so the new-result dialog sees a stable prefill (it also only resets on open).
  const presetAnalyte = selectedAnalyte?.analyte ?? selectedEntry?.analyte;
  const presetSpecimen = selectedAnalyte?.specimen ?? selectedEntry?.specimen ?? (specimen || undefined);
  const presetUnit = selectedAnalyte ? selectedAnalyte.unit : selectedEntry ? selectedEntry.unit : undefined;
  const preset = useMemo(
    () => (presetAnalyte !== undefined ? { analyte: presetAnalyte, specimen: presetSpecimen, unit: presetUnit } : presetSpecimen ? { specimen: presetSpecimen } : null),
    [presetAnalyte, presetSpecimen, presetUnit],
  );
  const testCount = analyteItems.length;
  const outOfRangeOn = view === 'results' && search.flag === 'out';

  return (
    <div className="page">
      <PageHeader
        title="Lab results"
        meta={
          analytes.data && totalResults ? (
            <span className="mono">
              {testCount} test{testCount === 1 ? '' : 's'} · {totalResults} value{totalResults === 1 ? '' : 's'}
            </span>
          ) : null
        }
        intro="Every lab value from your documents, as printed, grouped by test. A value outside the range printed with it is marked red; one that disagrees with a clinical record is listed under Reconciliation."
        actions={{
          primary: { label: 'Add a lab value', onClick: () => setNewOpen(true), shortcut: 'n', title: 'Type in a value from a report, with its date and normal range' },
          // A toggle: pressed while the list shows only the values outside the range; pressing it again shows them all.
          secondary: [
            { label: 'Add a computed value', onClick: () => openCompute(null), shortcut: 'c', title: 'Work out a value from values printed on lab reports: the albumin index, the IgG index, or A divided by B' },
            nothingYet
              ? null
              : outOfRangeOn
                ? { label: 'Showing values outside the range', onClick: () => setSearch({ flag: undefined, id: undefined }), pressed: true, title: 'Only the values outside their normal range are listed. Click to list every value again.' }
                : { label: 'Show values outside the range', onClick: showOutOfRange, pressed: false, title: 'Every value outside its normal range, newest first, in the All values view' },
          ],
          more: [
            { label: "Copy Claude's values into my lab list", onClick: () => importFromFacts(), shortcut: 'f', disabled: m.fromFacts.isPending, title: 'Values Claude read from your documents are already listed here. Copying them into your own lab list lets you edit them; nothing else changes.' },
            { label: 'Show the CSF (spinal fluid) tests', onClick: () => setSearch({ specimen: 'csf', id: undefined, view: 'panels' }, false), hidden: !specimens.some((s) => s.specimen === 'csf' && s.count > 0) },
            'separator',
            { label: 'Values re-read', onClick: () => setReparseOpen(true), title: 'What changed when every lab value was read again from the text as printed (limits, ranges, flags, dates, units)' },
          ],
        }}
      />
      <Toolbar label="View and filters">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'panels', label: 'By test', count: view === 'panels' ? organisedAnalytes.length || testCount : testCount, title: 'Grouped by sample and panel: spinal fluid together, a blood count as a blood count' },
            { value: 'documents', label: 'By document', count: view === 'documents' && byDoc.data ? docGroups.length : undefined, title: 'Everything pulled from each report, stacked together' },
            { value: 'results', label: 'All values', count: view === 'results' && list.data ? resultItems.length : totalResults, title: 'Every value in one list you can sort' },
          ]}
        />
        {sampleChoices.length > 1 || specimen ? (
          <Segmented
            label="Sample"
            value={specimen}
            onChange={setSpecimen}
            options={[{ value: '', label: 'All', count: totalResults || undefined, title: 'Every sample' }, ...sampleChoices.map((s) => ({ value: s, label: sampleWords(s), count: specimens.find((x) => x.specimen === s)?.count ?? 0 }))]}
          />
        ) : null}
        <SearchField label="Find" placeholder="Test, e.g. protein" value={qLocal} onChange={setQLocal} width={170} />
        {view !== 'panels' ? (
          <FilterGroup label="Range">
            <Select aria-label="Range" value={search.flag ?? ''} options={RANGE_OPTIONS} placeholder="Any" onChange={(e) => setSearch({ flag: e.target.value || undefined, id: undefined })} />
          </FilterGroup>
        ) : null}
        <DateRange from={search.from} to={search.to} onChange={(r) => setSearch({ from: r.from, to: r.to })} placeholder="YYYY-MM" />
        {analyteName ? (
          <FilterGroup label="Test">
            <span className="labs-filter-test">{analyteName}</span>
            <Button size="sm" variant="ghost" onClick={() => setSearch({ analyteKey: undefined, id: undefined })} title="Show the values of every test">
              Show every test
            </Button>
          </FilterGroup>
        ) : null}
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            view !== 'results' ? ['h', 'fold a group'] : null,
            ['enter', view === 'panels' ? 'every value' : 'open the page'],
            ['s', 'sample'],
            ['v v', 'view'],
            ['/', 'find'],
            view === 'panels' ? ['m', 'medications'] : ['t', 'trend'],
            ['n', 'add'],
            ['c', 'compute'],
          ]}
        >
          {anyFilter ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      <div className="page-body flush">{nothingYet ? firstRun : <SplitView storageKey={`labs.${view}`} defaultLeft={labsListShare(view)} minLeft={440} minRight={view === 'panels' ? 440 : 400} left={left} right={right} />}</div>

      <LabFormDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setFormError(null);
        }}
        preset={preset}
        documents={documents.data ?? []}
        institutions={institutions.data ?? []}
        busy={m.create.isPending}
        error={formError}
        onCreate={(input) =>
          m.create.mutate(input, {
            onSuccess: (e) => {
              setNewOpen(false);
              setFormError(null);
              toast(e.factId ? 'Lab value added, linked to its page' : 'Lab value added', 'ok');
              setSearch({ view: 'results', id: e.id, analyteKey: undefined, flag: undefined }, false);
            },
            onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
          })
        }
        onUpdate={() => undefined}
      />
      <LabFormDialog
        open={editOpen && Boolean(selectedEntry && selectedEntry.source === 'row' && editEntry && editEntry.source === 'row')}
        onClose={() => {
          setEditOpen(false);
          setFormError(null);
        }}
        entry={editEntry}
        documents={documents.data ?? []}
        institutions={institutions.data ?? []}
        busy={m.update.isPending}
        error={formError}
        onCreate={() => undefined}
        onUpdate={(id, patch) =>
          m.update.mutate(
            // The stored row: a part's line id, never the part id.
            { id: rowActionId(editEntry) ?? id, patch },
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
      <ReparseReport open={reparseOpen} onClose={() => setReparseOpen(false)} />
      <ComputeDialog
        open={computeOpen}
        onClose={() => {
          setComputeOpen(false);
          setComputeError(null);
        }}
        initial={computeInitial}
        busy={computeM.create.isPending}
        error={computeError}
        onSave={(req) =>
          computeM.create.mutate(req, {
            onSuccess: (e) => {
              setComputeOpen(false);
              setComputeError(null);
              toast(`Saved: ${e.analyte} ${e.computed?.record.result.shown ?? ''}, ${e.computed?.record.label ?? 'computed'}`, 'ok');
              setSearch({ view: 'results', id: e.id, analyteKey: undefined, flag: undefined }, false);
            },
            onError: (err) => setComputeError(err instanceof Error ? err.message : String(err)),
          })
        }
      />
      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={selectedEntry?.computed ? 'Delete this computed value?' : selectedEntry && isPart(selectedEntry) ? 'Delete this whole line?' : 'Delete this lab value?'}
        body={
          <span className="muted">
            {selectedEntry?.computed
              ? 'The computed value is hidden, not erased. Its inputs, the values printed on the lab reports, stay as they are.'
              : selectedEntry && isPart(selectedEntry)
              ? `This value came from one line that held several tests (${splitFromOf(selectedEntry)?.text ?? 'see the document'}). Deleting hides that whole line, every test on it; it is not erased. If Claude read the line from a document, that detail stays under Details from documents and its values show here again, read from the document.`
              : 'The value is hidden, not erased. If Claude read it from a document, that detail stays under Details from documents and the value shows here again, read from the document.'}
          </span>
        }
        confirmLabel={selectedEntry && isPart(selectedEntry) ? 'Delete the whole line' : 'Delete'}
        danger
        onConfirm={() => {
          // The stored row: a part's line id, never the part id.
          const id = rowActionId(latest.current.selectedEntry);
          if (!id) return;
          m.remove.mutate(id, {
            onSuccess: () => {
              toast('Lab value deleted', 'ok');
              select(null);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}
