/**
 * /symptoms — the symptom diary. Three views under "View:":
 *   Diary                 the day's scores (0 = none, 10 = the worst; 0–9 set the focused row, = / - nudge it,
 *                         j / k move rows, Enter or Tab walks into the notes) under a 14-day strip, with the day's
 *                         sleep, energy and notes on the right
 *   Chart                 the scores over time from the server's series, with the medications as rows under it,
 *                         labelled Range, Dates and Show controls and the symptoms to draw
 *   Symptoms you track    the symptoms, their order, and what 0 and 10 mean for each
 * Every selection and filter lives in the URL. Nothing is drawn empty: with no symptom, or nothing logged, the page
 * says what it is for and offers the one next step as a button. A viewer may log days but sees no add, reorder,
 * retire or import controls (the server refuses those writes for the viewer role anyway).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { todayIso } from '@shared/dates';
import { useFailToast } from '../api/client';
import { useDays, useDefinitions, useSeries, useSymptomMutations, useSymptomSummary, type DayInput, type SymptomDefinition } from '../api/symptoms';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings, isEditable } from '../app/shortcuts';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { Button } from '../ui/Button';
import { Confirm } from '../ui/Dialog';
import { useToast } from '../ui/Toast';
import { FilterGroup, Segmented, Toolbar } from '../ui/Toolbar';
import { ToolbarKeys } from '../ui/Toolbar';
import { QuickEntryGrid } from '../features/symptoms/QuickEntryGrid';
import { DayStrip } from '../features/symptoms/DayStrip';
import { DayDetail } from '../features/symptoms/DayDetail';
import { SymptomCharts } from '../features/symptoms/SymptomCharts';
import { DefinitionsTable, DefinitionDetail, NewDefinitionDialog } from '../features/symptoms/DefinitionsView';
import { ImportDialog } from '../features/symptoms/ImportDialog';
import { DAY_RE, RANGES, addDays, daysEndingAt, type RangeDays } from '../features/symptoms/dates';
import '../features/symptoms/symptoms.css';

const searchSchema = z.object({
  view: z.enum(['log', 'chart', 'setup']).optional().catch(undefined),
  date: z.string().regex(DAY_RE).optional().catch(undefined),
  from: z.string().regex(DAY_RE).optional().catch(undefined),
  to: z.string().regex(DAY_RE).optional().catch(undefined),
  range: z.coerce
    .number()
    .refine((n) => (RANGES as readonly number[]).includes(n))
    .optional()
    .catch(undefined),
  bucket: z.enum(['day', 'week']).optional().catch(undefined),
  /** Comma-separated definition ids; absent = every active symptom. */
  symptoms: z.string().optional().catch(undefined),
  /** Selected definition in the Symptoms you track view. */
  id: z.string().optional().catch(undefined),
});
export type SymptomsSearch = z.infer<typeof searchSchema>;
type View = 'log' | 'chart' | 'setup';

export const Route = createFileRoute('/symptoms')({
  validateSearch: (s: Record<string, unknown>): SymptomsSearch => searchSchema.parse(s),
  component: SymptomsPage,
});

const STRIP_DAYS = 14;
const INTRO = 'Score how each symptom was today, from 0 (none) to 10 (the worst), with your sleep and energy, and see the scores over time beside your medications.';
const VIEW_WORDS: Record<View, string> = { log: 'Diary', chart: 'Chart', setup: 'Symptoms you track' };
const VIEW_TITLES: Record<View, string> = {
  log: 'Score one day: each symptom, sleep, energy and notes',
  chart: 'The scores over time, with your medications as rows under the chart',
  setup: 'Which symptoms you score, their order, and what 0 and 10 mean',
};
const RANGE_WORDS: Record<RangeDays, string> = { 30: '30 days', 90: '90 days', 180: '6 months', 365: '1 year' };

/** The day box: a date typed as YYYY-MM-DD, taken on Enter or on leaving the box (a future day shows today). */
function DayBox({ date, today, onDate }: { date: string; today: string; onDate: (d: string) => void }) {
  const [draft, setDraft] = useState(date);
  useEffect(() => setDraft(date), [date]);
  function commit() {
    const v = draft.trim();
    if (DAY_RE.test(v) && !Number.isNaN(Date.parse(v))) onDate(v > today ? today : v);
    else setDraft(date);
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      className="sym-date"
      data-day-box=""
      aria-label="Day, as YYYY-MM-DD"
      placeholder="YYYY-MM-DD"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setDraft(date);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function SymptomsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const today = todayIso();
  const me = useMe();
  // Viewers may log days (PUT /symptoms/day) but not define, reorder, retire
  // or import; their write controls are hidden rather than refused later.
  const canEdit = !me.isViewer;
  const view: View = search.view ?? 'log';
  // The diary records days that happened: a future ?date= (typed, or stepped
  // past today) shows today instead, so no key can score a future day.
  const date = search.date && search.date <= today ? search.date : today;
  const range = (search.range ?? 90) as RangeDays;
  const bucket = search.bucket ?? (range >= 180 ? 'week' : 'day');
  const chartTo = search.to ?? today;
  const chartFrom = search.from ?? addDays(chartTo, -(range - 1));

  // --- Data ------------------------------------------------------------------
  const defs = useDefinitions(true);
  const allDefs = useMemo(() => defs.data?.items ?? [], [defs.data]);
  const activeDefs = useMemo(() => allDefs.filter((d) => d.active), [allDefs]);
  const stripDates = useMemo(() => daysEndingAt(date, STRIP_DAYS), [date]);
  const days = useDays(stripDates[0], date, view === 'log');
  const dayRows = useMemo(() => days.data?.days ?? [], [days.data]);
  const dayRow = dayRows.find((d) => d.date === date);
  const summary = useSymptomSummary();
  const seriesParams = useMemo(() => ({ from: chartFrom, to: chartTo, bucket, symptomIds: search.symptoms }), [chartFrom, chartTo, bucket, search.symptoms]);
  const series = useSeries(seriesParams, view === 'chart');
  const m = useSymptomMutations();

  const chartIds = useMemo(() => {
    const picked = search.symptoms ? search.symptoms.split(',').filter(Boolean) : null;
    return new Set(picked && picked.length ? picked : activeDefs.map((d) => d.id));
  }, [search.symptoms, activeDefs]);
  const chartToggles = useMemo(() => {
    const extra = allDefs.filter((d) => !d.active && chartIds.has(d.id));
    return [...activeDefs, ...extra];
  }, [allDefs, activeDefs, chartIds]);

  // --- Local state -------------------------------------------------------------
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused = (focusedId && activeDefs.some((d) => d.id === focusedId) ? focusedId : activeDefs[0]?.id) ?? null;
  const gridRef = useRef<HTMLDivElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [focusName, setFocusName] = useState(0);
  const dialogOpen = newOpen || importOpen || retireOpen;
  const selectedDef: SymptomDefinition | null = view === 'setup' && search.id ? (allDefs.find((d) => d.id === search.id) ?? null) : null;
  const busy = m.createDefinition.isPending || m.updateDefinition.isPending || m.deactivateDefinition.isPending || m.reorderDefinitions.isPending;

  // --- Actions -----------------------------------------------------------------
  const setSearch = useCallback(
    (patch: Partial<SymptomsSearch>, replace = true) => {
      void navigate({ search: (prev: SymptomsSearch) => ({ ...prev, ...patch }), replace });
    },
    [navigate],
  );
  function setView(v: View) {
    setSearch({ view: v === 'log' ? undefined : v, id: undefined }, false);
  }
  function goDate(target: string) {
    const d = target > today ? today : target;
    setSearch({ date: d === today ? undefined : d, view: undefined });
    // Put the keyboard back on the grid after a click on the strip or a day
    // button, unless the user is typing the date by hand.
    const a = document.activeElement;
    if (!(a instanceof HTMLInputElement && a.hasAttribute('data-day-box'))) gridRef.current?.focus();
  }
  function saveDay(input: DayInput, d: string = date) {
    m.upsertDay.mutate({ date: d, input }, { onError: fail });
  }
  function moveRow(delta: number) {
    const ids = activeDefs.map((d) => d.id);
    if (!ids.length) return;
    const i = focused ? ids.indexOf(focused) : -1;
    const next = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + delta));
    setFocusedId(ids[next]);
  }
  function setScore(id: string, score: number) {
    if (score < 0 || score > 10) return;
    saveDay({ scores: { [id]: score } });
  }
  function nudge(delta: number) {
    if (!focused) return;
    const cur = dayRow?.scores[focused]?.score;
    const next = cur == null ? (delta > 0 ? 1 : 0) : cur + delta;
    if (next < 0 || next > 10) return;
    setScore(focused, next);
  }
  function step(n: number) {
    if (view === 'log') {
      const d = addDays(date, n);
      if (d <= today) goDate(d);
    } else if (view === 'chart') setSearch({ from: addDays(chartFrom, n * range), to: addDays(chartTo, n * range) });
  }
  function setRange(n: RangeDays) {
    setSearch({ range: n === 90 ? undefined : n, from: undefined, to: undefined, bucket: undefined });
  }
  /** From the palette: chart the last n days, from any view. */
  function chartRange(n: RangeDays) {
    setSearch({ view: 'chart', id: undefined, range: n === 90 ? undefined : n, from: undefined, to: undefined, bucket: undefined }, false);
  }
  function setBucket(b: 'day' | 'week') {
    if (b !== bucket) setSearch({ bucket: b });
  }
  function toggleBucket() {
    setSearch({ bucket: bucket === 'day' ? 'week' : 'day' });
  }
  function toggleSymptom(id: string) {
    const cur = new Set(chartIds);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    const allActive = activeDefs.every((d) => cur.has(d.id)) && cur.size === activeDefs.length;
    setSearch({ symptoms: allActive || cur.size === 0 ? undefined : [...cur].join(',') });
  }
  function moveDefinition(delta: -1 | 1) {
    if (!selectedDef || !canEdit) return;
    const ids = [...allDefs].sort((a, b) => a.sortOrder - b.sortOrder).map((d) => d.id);
    const i = ids.indexOf(selectedDef.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    m.reorderDefinitions.mutate(ids, { onError: fail });
  }
  function toggleActive() {
    if (!selectedDef || !canEdit) return;
    if (selectedDef.active) setRetireOpen(true);
    else m.updateDefinition.mutate({ id: selectedDef.id, patch: { active: true } }, { onSuccess: () => toast('Tracked again', 'ok'), onError: fail });
  }
  function chartOne(id: string) {
    setSearch({ view: 'chart', id: undefined, symptoms: id }, false);
  }

  // Latest state for bindings and listeners registered once.
  const latest = useRef({ view, date, focused, dialogOpen, selectedDef, today, dayRow, canEdit });
  latest.current = { view, date, focused, dialogOpen, selectedDef, today, dayRow, canEdit };
  const actions = useRef({ goDate, moveRow, setScore, nudge, step, setRange, chartRange, toggleBucket, setView, moveDefinition, toggleActive });
  actions.current = { goDate, moveRow, setScore, nudge, step, setRange, chartRange, toggleBucket, setView, moveDefinition, toggleActive };
  // Predicates shared by the key bindings and the palette, so a command is
  // listed exactly when its key does something.
  const is = useRef({
    setup: () => latest.current.view === 'setup',
    /** `]` / next: the chart window, or the diary up to today (never a future day). */
    canStepNext: () => latest.current.view === 'chart' || (latest.current.view === 'log' && latest.current.date < latest.current.today),
    editSelected: () => latest.current.view === 'setup' && latest.current.canEdit && Boolean(latest.current.selectedDef),
  }).current;

  useBindings(
    [
      { keys: 't', description: 'Diary: today', group: 'Page', when: () => latest.current.view === 'log' && !latest.current.dialogOpen, run: () => actions.current.goDate(latest.current.today) },
      { keys: '[', description: 'Previous day (diary) or earlier window (chart)', group: 'Page', when: () => latest.current.view !== 'setup' && !latest.current.dialogOpen, run: () => actions.current.step(-1) },
      { keys: ']', description: 'Next day, up to today (diary) or later window (chart)', group: 'Page', when: () => is.canStepNext() && !latest.current.dialogOpen, run: () => actions.current.step(1) },
      { keys: 'j', description: 'Next symptom row', group: 'Lists', when: () => latest.current.view === 'log' && !latest.current.dialogOpen, run: () => actions.current.moveRow(1) },
      { keys: 'k', description: 'Previous symptom row', group: 'Lists', when: () => latest.current.view === 'log' && !latest.current.dialogOpen, run: () => actions.current.moveRow(-1) },
      { keys: 'i', description: 'Import the symptom diary from a spreadsheet (CSV)', group: 'Page', when: () => latest.current.canEdit && !latest.current.dialogOpen, run: () => setImportOpen(true) },
      { keys: 'v l', description: 'Symptom diary: the diary', group: 'Page', run: () => actions.current.setView('log') },
      { keys: 'v c', description: 'Symptom diary: the chart', group: 'Page', run: () => actions.current.setView('chart') },
      { keys: 'v s', description: 'Symptom diary: symptoms you track', group: 'Page', run: () => actions.current.setView('setup') },
      { keys: 'b', description: 'Chart: switch between daily scores and weekly averages', group: 'Page', when: () => latest.current.view === 'chart' && !latest.current.dialogOpen, run: () => actions.current.toggleBucket() },
      {
        keys: 'r',
        description: 'Chart: next range (30 days, 90 days, 6 months, 1 year)',
        group: 'Page',
        when: () => latest.current.view === 'chart' && !latest.current.dialogOpen,
        run: () => {
          const i = RANGES.indexOf(range);
          actions.current.setRange(RANGES[(i + 1) % RANGES.length]);
        },
      },
      { keys: 'n', description: 'Add a symptom to track', group: 'Page', when: () => latest.current.canEdit && !latest.current.dialogOpen, run: () => setNewOpen(true) },
      { keys: 'e', description: 'Edit the selected symptom', group: 'Page', when: () => is.editSelected() && !latest.current.dialogOpen, run: () => setFocusName((n) => n + 1) },
      { keys: 'Delete', description: 'Retire the selected symptom (asks first)', group: 'Page', when: () => is.editSelected() && Boolean(latest.current.selectedDef?.active) && !latest.current.dialogOpen, run: () => setRetireOpen(true) },
      { keys: 'alt+k', description: 'Move the selected symptom up', group: 'Page', when: () => is.editSelected() && !latest.current.dialogOpen, run: () => actions.current.moveDefinition(-1) },
      { keys: 'alt+j', description: 'Move the selected symptom down', group: 'Page', when: () => is.editSelected() && !latest.current.dialogOpen, run: () => actions.current.moveDefinition(1) },
    ],
    [range],
  );

  // Digits, = and - score the focused row; Enter opens its note. These are
  // handled on a scoped listener (like the timeline's Enter/Esc) because the
  // global registry keys one binding per key and Enter must stay free for
  // buttons and dialogs. Nothing fires while typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = latest.current;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (s.view !== 'log' || s.dialogOpen || !s.focused) return;
      const t = e.target as HTMLElement | null;
      if (isEditable(t) || t?.closest('button, a, select, dialog, [role="dialog"]') || document.querySelector('dialog[open]')) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        actions.current.setScore(s.focused, Number(e.key));
        actions.current.moveRow(1);
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        actions.current.nudge(1);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        actions.current.nudge(-1);
      } else if (e.key === 'Enter') {
        const input = document.querySelector<HTMLInputElement>(`input[data-note-for="${CSS.escape(s.focused)}"]`);
        if (input && !input.disabled) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Land the keyboard on the grid when the diary opens.
  useEffect(() => {
    if (view === 'log') gridRef.current?.focus();
  }, [view]);

  // Every command is listed only while it does something, and shows its key
  // only in the view where that key is bound (the list re-registers when the
  // view changes). Commands that work from any view switch to the right one.
  useRegisterCommands(
    [
      { id: 'symptoms.today', title: 'Symptom diary: today', group: 'Page', shortcut: view === 'log' ? 't' : undefined, keywords: 'daily log score', run: () => actions.current.goDate(latest.current.today) },
      { id: 'symptoms.log', title: 'Symptom diary: the diary', group: 'Page', shortcut: 'v l', keywords: 'log', when: () => latest.current.view !== 'log', run: () => actions.current.setView('log') },
      { id: 'symptoms.chart', title: 'Symptom diary: the chart', group: 'Page', shortcut: 'v c', keywords: 'trend graph sleep', when: () => latest.current.view !== 'chart', run: () => actions.current.setView('chart') },
      { id: 'symptoms.setup', title: 'Symptom diary: symptoms you track', group: 'Page', shortcut: 'v s', keywords: 'setup definitions choose', when: () => latest.current.view !== 'setup', run: () => actions.current.setView('setup') },
      { id: 'symptoms.new', title: 'Symptom diary: add a symptom to track', group: 'Page', keywords: 'new definition', shortcut: 'n', when: () => latest.current.canEdit, run: () => setNewOpen(true) },
      { id: 'symptoms.import', title: 'Symptom diary: import from a spreadsheet (CSV)', group: 'Page', shortcut: 'i', keywords: 'upload spreadsheet csv', when: () => latest.current.canEdit, run: () => setImportOpen(true) },
      { id: 'symptoms.prev', title: view === 'chart' ? 'Symptom diary: earlier window' : 'Symptom diary: previous day', group: 'Page', shortcut: '[', when: () => !is.setup(), run: () => actions.current.step(-1) },
      { id: 'symptoms.next', title: view === 'chart' ? 'Symptom diary: later window' : 'Symptom diary: next day', group: 'Page', shortcut: ']', when: is.canStepNext, run: () => actions.current.step(1) },
      ...RANGES.map((n) => ({ id: `symptoms.range.${n}`, title: `Symptom diary: chart the last ${RANGE_WORDS[n]}`, group: 'Page', run: () => actions.current.chartRange(n) })),
      { id: 'symptoms.bucket', title: 'Symptom diary: switch between daily scores and weekly averages', group: 'Page', keywords: 'buckets', shortcut: 'b', when: () => latest.current.view === 'chart', run: () => actions.current.toggleBucket() },
      // Symptoms you track: the selected symptom.
      { id: 'symptoms.def.edit', title: 'Symptom diary: edit the selected symptom', group: 'Page', shortcut: 'e', when: is.editSelected, run: () => setFocusName((n) => n + 1) },
      { id: 'symptoms.def.retire', title: 'Symptom diary: retire the selected symptom', group: 'Page', shortcut: 'Delete', when: () => is.editSelected() && Boolean(latest.current.selectedDef?.active), run: () => setRetireOpen(true) },
      { id: 'symptoms.def.reactivate', title: 'Symptom diary: track the selected symptom again', group: 'Page', when: () => is.editSelected() && latest.current.selectedDef?.active === false, run: () => actions.current.toggleActive() },
      { id: 'symptoms.def.up', title: 'Symptom diary: move the selected symptom up', group: 'Page', shortcut: 'alt+k', when: is.editSelected, run: () => actions.current.moveDefinition(-1) },
      { id: 'symptoms.def.down', title: 'Symptom diary: move the selected symptom down', group: 'Page', shortcut: 'alt+j', when: is.editSelected, run: () => actions.current.moveDefinition(1) },
      {
        id: 'symptoms.def.chart',
        title: 'Symptom diary: chart the selected symptom',
        group: 'Page',
        keywords: 'trend graph',
        when: () => is.setup() && Boolean(latest.current.selectedDef),
        run: () => {
          const d = latest.current.selectedDef;
          if (d) chartOne(d.id);
        },
      },
    ],
    [view],
  );

  // --- Render --------------------------------------------------------------------
  const s = summary.data;
  const meta = s ? (
    <span>
      <span className="mono">{s.active}</span> symptom{s.active === 1 ? '' : 's'} tracked · <span className="mono">{s.daysLogged}</span> day{s.daysLogged === 1 ? '' : 's'} logged
      {s.lastDate ? (
        <>
          {' '}
          · last <span className="mono">{s.lastDate}</span>
        </>
      ) : null}
      {s.loggedToday ? ' · today logged' : ' · today not logged yet'}
    </span>
  ) : null;

  const noSymptoms = defs.isSuccess && activeDefs.length === 0;
  const addButtons = (primaryWords: string) =>
    canEdit ? (
      <div className="sym-empty-actions">
        <Button variant="primary" shortcut="n" onClick={() => setNewOpen(true)}>
          {primaryWords}
        </Button>
        <Button shortcut="i" onClick={() => setImportOpen(true)}>
          Import from a spreadsheet
        </Button>
      </div>
    ) : null;
  const chooseFirst = (
    <EmptyState title="Choose the symptoms you track" action={addButtons('Add a symptom to track')}>
      {canEdit
        ? 'Add the few symptoms you want to follow, such as joint pain, dizziness or nausea. Each day you score each one from 0 (none) to 10 (the worst); the chart then shows them over time beside your medications.'
        : 'No symptoms have been chosen yet. Someone with full access adds them; you can still write down sleep, energy and notes on the right.'}
    </EmptyState>
  );

  const logLeft = (
    <>
      {days.isError ? <Loading>Could not load the diary: {days.error instanceof Error ? days.error.message : 'error'}</Loading> : null}
      {defs.isPending ? <Loading>Loading your symptoms…</Loading> : activeDefs.length ? <DayStrip dates={stripDates} days={dayRows} definitions={activeDefs} selected={date} today={today} onSelect={goDate} /> : null}
      {defs.isPending ? null : <QuickEntryGrid definitions={activeDefs} day={dayRow} focusedId={focused} onFocus={setFocusedId} onScore={setScore} onNote={(id, note) => saveDay({ scores: { [id]: { note: note || null } } })} gridRef={gridRef} empty={chooseFirst} />}
    </>
  );
  const logRight = <DayDetail date={date} today={today} day={dayRow} recent={dayRows} definitions={activeDefs} saving={m.upsertDay.isPending} onSave={(input) => saveDay(input)} onSelectDate={goDate} />;

  const setupLeft = defs.isPending ? (
    <Loading>Loading your symptoms…</Loading>
  ) : allDefs.length ? (
    <DefinitionsTable
      items={allDefs}
      selectedId={search.id ?? null}
      onSelect={(d) => setSearch({ id: d?.id })}
      onOpen={(d) => {
        setSearch({ id: d.id });
        setFocusName((n) => n + 1);
      }}
    />
  ) : (
    chooseFirst
  );
  const setupRight = selectedDef ? (
    <DefinitionDetail
      def={selectedDef}
      busy={busy}
      focusName={focusName}
      onSave={(patch) => m.updateDefinition.mutate({ id: selectedDef.id, patch }, { onSuccess: () => toast('Saved', 'ok'), onError: fail })}
      onToggleActive={toggleActive}
      onMove={moveDefinition}
      onChart={() => chartOne(selectedDef.id)}
      readOnly={!canEdit}
    />
  ) : allDefs.length ? (
    <EmptyState title="Pick a symptom">
      {canEdit ? 'Rename it, say what 0 and 10 mean for you, move it up or down the diary, or retire it. Move with j and k; Enter edits the name.' : 'Read what 0 and 10 mean for it. Move with j and k.'}
    </EmptyState>
  ) : (
    <EmptyState title="What the scores mean">Every symptom is scored from 0 (none) to 10 (the worst). Saying what 0 and 10 mean for each keeps your scores comparable over months.</EmptyState>
  );

  const chartEmpty = (
    <EmptyState
      title={search.symptoms ? 'None of the symptoms chosen were scored in this window' : `Nothing written down between ${chartFrom} and ${chartTo}`}
      action={
        noSymptoms ? (
          addButtons('Add a symptom to track')
        ) : (
          <div className="sym-empty-actions">
            <Button variant="primary" onClick={() => setView('log')} shortcut="v l">
              Open the diary
            </Button>
            {canEdit ? (
              <Button shortcut="i" onClick={() => setImportOpen(true)}>
                Import from a spreadsheet
              </Button>
            ) : null}
            {RANGES.indexOf(range) < RANGES.length - 1 && !search.from ? (
              <Button variant="ghost" onClick={() => setRange(RANGES[RANGES.indexOf(range) + 1])}>
                Show {RANGE_WORDS[RANGES[RANGES.indexOf(range) + 1]]}
              </Button>
            ) : null}
          </div>
        )
      }
    >
      {noSymptoms
        ? 'Choose the symptoms you track first; each day you score them from 0 (none) to 10 (the worst), and they show here over time beside your medications.'
        : 'Score your symptoms in the diary, or import a spreadsheet of earlier days; the scores show here over time beside your medications.'}
    </EmptyState>
  );
  const toggles =
    chartToggles.length > 1 ? (
      <FilterGroup label="Symptoms shown" className="sym-toggles">
        {chartToggles.map((d) => (
          <button key={d.id} type="button" className="btn sm sym-toggle" onClick={() => toggleSymptom(d.id)} aria-pressed={chartIds.has(d.id)} title={d.active ? (d.description ?? `Show or hide ${d.name}`) : `${d.name} (retired)`}>
            {d.name}
          </button>
        ))}
      </FilterGroup>
    ) : null;

  const keys =
    view === 'log'
      ? ([
          ['j/k', 'symptom'],
          ['0-9', 'score'],
          ['=/-', 'up or down'],
          ['enter', 'note'],
          ['[/]', 'day'],
          ['t', 'today'],
          ['v c', 'chart'],
        ] as const)
      : view === 'chart'
        ? ([
            ['[/]', 'window'],
            ['r', 'range'],
            ['b', 'daily or weekly'],
            ['v l', 'diary'],
          ] as const)
        : ([['j/k', 'move'], canEdit ? (['enter', 'edit the name'] as const) : null, canEdit ? (['alt+j/alt+k', 'move it'] as const) : null, canEdit ? (['n', 'add'] as const) : null, ['v l', 'diary'] as const] as const);

  return (
    <div className="page">
      <PageHeader
        title="Symptom diary"
        meta={meta}
        intro={INTRO}
        actions={
          canEdit
            ? {
                primary: { label: 'Add a symptom to track', onClick: () => setNewOpen(true), shortcut: 'n', title: 'A symptom you score each day from 0 (none) to 10 (the worst)' },
                secondary: [{ label: 'Import from a spreadsheet', onClick: () => setImportOpen(true), shortcut: 'i', title: 'Earlier days from a CSV file: a date column, one column per symptom, and sleep, energy or notes if you have them' }],
              }
            : undefined
        }
      />
      <Toolbar label="View and filters">
        <Segmented label="View" value={view} onChange={setView} options={(['log', 'chart', 'setup'] as const).map((v) => ({ value: v, label: VIEW_WORDS[v], title: VIEW_TITLES[v], count: v === 'setup' && allDefs.length ? activeDefs.length : undefined }))} />
        {view === 'log' ? (
          <FilterGroup label="Day">
            <Button size="sm" onClick={() => step(-1)} shortcut="[" title="The day before">
              Previous
            </Button>
            <DayBox date={date} today={today} onDate={goDate} />
            <Button size="sm" onClick={() => step(1)} shortcut="]" disabled={date >= today} title="The day after (up to today)">
              Next
            </Button>
            <Button size="sm" variant="ghost" onClick={() => goDate(today)} shortcut="t" disabled={date === today}>
              Today
            </Button>
          </FilterGroup>
        ) : view === 'chart' ? (
          <>
            <Segmented
              label="Range"
              value={search.from ? '' : String(range)}
              onChange={(v) => setRange(Number(v) as RangeDays)}
              options={RANGES.map((n) => ({ value: String(n), label: RANGE_WORDS[n], title: `The last ${RANGE_WORDS[n]} up to today` }))}
            />
            <Segmented
              label="Show"
              value={bucket}
              onChange={setBucket}
              options={[
                { value: 'day', label: 'Daily', title: 'One point per day scored' },
                { value: 'week', label: 'Weekly average', title: 'One point per week: the average of its scores' },
              ]}
            />
            <FilterGroup label="Dates">
              <Button size="sm" variant="ghost" onClick={() => step(-1)} shortcut="[" title="The same length of time, earlier">
                Earlier
              </Button>
              <span className="mono sym-window">
                {chartFrom} to {chartTo}
              </span>
              <Button size="sm" variant="ghost" onClick={() => step(1)} shortcut="]" title="The same length of time, later">
                Later
              </Button>
            </FilterGroup>
          </>
        ) : null}
        <ToolbarKeys items={keys} />
      </Toolbar>

      {view === 'chart' ? (
        <div className="page-body sym-chart-body">
          <SymptomCharts
            data={series.data}
            loading={series.isPending}
            error={series.isError ? (series.error instanceof Error ? series.error.message : 'error') : null}
            onOpenPoint={(x) => goDate(x.slice(0, 10))}
            empty={chartEmpty}
            toggles={toggles}
          />
        </div>
      ) : (
        <div className="page-body flush">
          {view === 'log' ? <SplitView storageKey="symptoms-log" defaultLeft={60} minLeft={520} left={logLeft} right={logRight} /> : <SplitView storageKey="symptoms-setup" defaultLeft={60} minLeft={440} left={setupLeft} right={setupRight} />}
        </div>
      )}

      <NewDefinitionDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setFormError(null);
        }}
        busy={m.createDefinition.isPending}
        error={formError}
        onCreate={(input) =>
          m.createDefinition.mutate(input, {
            onSuccess: (d) => {
              setNewOpen(false);
              setFormError(null);
              toast(d.reactivated ? `Tracking "${d.name}" again` : `Added "${d.name}"`, 'ok');
              if (latest.current.view === 'setup') setSearch({ id: d.id });
              else setFocusedId(d.id);
            },
            onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
          })
        }
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        run={(csv, dryRun) => m.importCsv.mutateAsync({ csv, dryRun })}
        onImported={(r) => {
          const notes = [r.overwritten.length ? `${r.overwritten.length} value${r.overwritten.length === 1 ? '' : 's'} replaced` : '', r.skipped.length ? `${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} skipped` : ''].filter(Boolean);
          toast(`${r.imported} day${r.imported === 1 ? '' : 's'} imported${notes.length ? `, ${notes.join(', ')}` : ''}`, notes.length ? 'info' : 'ok');
        }}
      />
      <Confirm
        open={retireOpen}
        onClose={() => setRetireOpen(false)}
        title={`Retire "${selectedDef?.name ?? ''}"?`}
        body={<span className="muted">It leaves the diary and the 14-day strip. Every score stays in the history and on the timeline, and you can track it again here, or by adding a symptom with the same name.</span>}
        confirmLabel="Retire"
        danger
        onConfirm={() => {
          const d = latest.current.selectedDef;
          if (!d || !latest.current.canEdit) return;
          m.deactivateDefinition.mutate(d.id, { onSuccess: () => toast(`Retired "${d.name}"`, 'ok'), onError: fail });
        }}
      />
    </div>
  );
}
