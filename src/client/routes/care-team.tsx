/**
 * /care-team — the Care team (2026-10-09, the user's requests 4, 5 and 6): who could look after a flare. One row per
 * candidate: the step (1 Local doctor, 2 Flare plan, 3 Lead specialist, 4 Expert; the list sorts by step, then
 * status), name, practice, place, phone, website, states licensed in, access type, quoted cost, licensed in the home state,
 * earliest visit, role (Strategist, Lead specialist, Local doctor, Vendor) and status (Found, Contacted, Call booked
 * with its time, Answered the flare test, Shortlisted, Declined, Chosen), the fixed Flare test typed by a person with
 * its Pass or Fail, and a source on every fact ("not backed yet" until one holds it; "unverified" while only a web
 * search says it, until "Verified by phone" is ticked).
 *
 * Header: Add a candidate (the one primary); under More, Find candidates on the web (off until used: typed criteria
 * only, every search checked, the cost shown first, results wait for a yes). Views: All, By role, By status, Waiting for
 * your yes, Shortlisted, Web searches (each search with its exact words). Split view; selection and filters in the URL.
 * Keys: n add, e edit, s status, f flare test, d pass or fail, b add a source, p verified by phone, c log a call, t add
 * a to-do, y / x yes or no to a proposal, w find candidates, Delete.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  CARE_ROLES,
  CARE_ROLE_WORDS,
  CARE_STATUSES,
  CARE_STATUS_WORDS,
  CARE_STEPS,
  FLARE_TEST_ITEMS,
  FLARE_VERDICT_WORDS,
  LEGACY_CARE_ROLES,
  NOT_BACKED_TITLE,
  RUN_STATUS_WORDS,
  UNVERIFIED_TITLE,
  UNVERIFIED_WORDS,
  stepOrder,
  stepWords,
  type CareRole,
  type CareStatus,
  type CareStep,
  type PhoneCheck,
  type SearchRun,
} from '@shared/care-team';
import { ApiError, errorMessage, useFailToast } from '../api/client';
import { useMe } from '../api/users';
import { useTaskMutations, type TaskInput } from '../api/tasks';
import { fetchPersonMatches, useCandidate, useCandidates, useCareMutations, useSearchRuns, type Candidate, type CareFilters, type PersonMatch } from '../api/care-team';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { dialogOpen } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { GroupedList, type GroupedListColumn, type GroupedListGroup } from '../ui/GroupedList';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { Tag } from '../ui/StatusTag';
import { DateText, DateTimeText } from '../ui/DateText';
import { Confirm } from '../ui/Dialog';
import { FilterGroup, SearchField, Segmented, Toolbar, ToolbarKeys } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { TaskDialog } from '../features/tasks/TaskDialog';
import { CommunicationDialog } from '../features/communications/CommunicationDialog';
import { CandidateDetail } from '../features/care-team/CandidateDetail';
import { CandidateDialog } from '../features/care-team/CandidateDialog';
import { AcceptDialog, FlareDialog, HomeStateDialog, PhoneCheckDialog, SourceDialog, StatusDialog, VerdictDialog, firstOpenItem } from '../features/care-team/Dialogs';
import { FindDialog } from '../features/care-team/FindDialog';
import { ScopeSwitch } from '../features/care-team/WebSearchSettings';
import { RunDetail } from '../features/care-team/RunDetail';
import { KEY_HINTS, PAGE_INTRO, PROPOSAL_KEY_HINTS, STATUS_TONE, VERDICT_TONE, VIEWS, VIEW_LINES, VIEW_TITLES, VIEW_WORDS, flareWords, placeWords, roleWords, statusWords, undoTicks, type CareViewKey } from '../features/care-team/words';
import '../features/care-team/care-team.css';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
  // Old role keys in a saved link read as the new ones (request 6).
  role: z.preprocess((v) => (typeof v === 'string' ? (LEGACY_CARE_ROLES[v] ?? v) : v), z.enum(CARE_ROLES)).optional().catch(undefined),
  status: z.enum(CARE_STATUSES).optional().catch(undefined),
  step: z.union([z.coerce.number().int().min(1).max(4), z.literal('none')]).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  run: z.string().optional().catch(undefined),
});
export type CareTeamSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/care-team')({
  validateSearch: (s: Record<string, unknown>): CareTeamSearch => searchSchema.parse(s),
  component: CareTeamPage,
});

type DialogKind = 'none' | 'new' | 'edit' | 'status' | 'flare' | 'source' | 'call' | 'task' | 'find' | 'delete' | 'accept' | 'verdict' | 'phone' | 'home_state';

function listFilter(view: CareViewKey): CareFilters['view'] {
  return view === 'proposed' ? 'proposed' : view === 'shortlisted' ? 'shortlisted' : 'all';
}

function CareTeamPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const toast = useToast();
  const fail = useFailToast();
  const me = useMe();
  const canWrite = me.canWrite;
  const view: CareViewKey = search.view ?? 'all';
  const selectedId = search.id ?? null;

  const stepFilter = search.step as CareStep | 'none' | undefined;
  const filters = useMemo<CareFilters>(() => ({ view: listFilter(view), role: search.role, status: search.status, q: search.q, step: stepFilter }), [view, search.role, search.status, search.q, stepFilter]);
  const list = useCandidates(filters);
  const detail = useCandidate(view === 'searches' ? null : selectedId);
  const runs = useSearchRuns();
  const m = useCareMutations();
  const taskM = useTaskMutations();

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const counts = list.data?.counts;
  const selected = view === 'searches' ? null : (detail.data ?? null);
  const selectedRow = items.find((c) => c.id === selectedId) ?? null;
  const runItems = runs.data?.items ?? [];
  const cap = runs.data?.caps.findCandidates ?? 10;
  const running = runItems.find((r) => r.status === 'running' && r.kind === 'find') ?? null;

  const [dialog, setDialog] = useState<DialogKind>('none');
  const [flareItem, setFlareItem] = useState<string>(FLARE_TEST_ITEMS[0].key);
  const [formError, setFormError] = useState<string | null>(null);
  const [matches, setMatches] = useState<PersonMatch[]>([]);
  /** "Verified by phone" just unticked: Undo ticks it again with the same who and when (this page, this candidate). */
  const [undone, setUndone] = useState<{ id: string; checks: PhoneCheck[] } | null>(null);
  const close = () => {
    setDialog('none');
    setFormError(null);
  };

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  function setSearch(patch: Partial<CareTeamSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  const select = (id: string | null) => setSearch({ id: id ?? undefined });
  const setView = (v: CareViewKey) => setSearch({ view: v === 'all' ? undefined : v, id: undefined, run: undefined }, false);

  // A run started here: when it ends, say what it found and show the proposals.
  const watched = useRef<string | null>(null);
  useEffect(() => {
    const id = watched.current;
    if (!id) return;
    const r = runItems.find((x) => x.id === id);
    if (!r || r.status === 'running') return;
    watched.current = null;
    void qc.invalidateQueries({ queryKey: ['care-team'] });
    if (r.status === 'done') {
      toast(r.proposed ? `Found ${r.proposed} candidate${r.proposed === 1 ? '' : 's'}. ${r.proposed === 1 ? 'It waits' : 'They wait'} for your yes.` : `Nothing new found${r.duplicates ? ` (${r.duplicates} already on your list or turned down)` : ''}.`, r.proposed ? 'ok' : 'info');
      if (r.proposed) setSearch({ view: 'proposed', id: undefined }, false);
    } else toast(r.error ?? 'The web search did not finish.', 'bad');
  }, [runItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useRef({ selected, selectedRow, view, canWrite });
  latest.current = { selected, selectedRow, view, canWrite };
  const cur = () => latest.current.selected;
  const busy = m.create.isPending || m.update.isPending || m.status.isPending || m.flare.isPending || m.addSource.isPending || m.accept.isPending || m.reject.isPending || m.remove.isPending || m.link.isPending || m.removeSource.isPending || m.verdict.isPending || m.phoneCheck.isPending || m.phoneUncheck.isPending;

  const onDone = (words: string) => ({
    onSuccess: () => {
      close();
      toast(words, 'ok');
    },
    onError: (err: unknown) => setFormError(errorMessage(err)),
  });

  function openFlare(item?: string) {
    const c = cur();
    if (!c || c.review !== 'accepted') return;
    setFlareItem(item ?? firstOpenItem(c));
    setDialog('flare');
  }
  async function accept() {
    const c = cur();
    if (!c || c.review !== 'proposed' || busy) return;
    try {
      const found = (await fetchPersonMatches(c.name)).items;
      if (found.length) {
        setMatches(found);
        setDialog('accept');
        return;
      }
    } catch {
      // no matches known: a new entry is made
    }
    m.accept.mutate({ id: c.id, personId: null }, { onSuccess: () => toast(`${c.name} is on your list, at Found.`, 'ok'), onError: fail });
  }
  /** "Verified by phone": tick (asks who called and when) or untick (Undo puts it back). */
  function togglePhone() {
    const c = cur();
    if (!c || c.review === 'rejected' || busy) return;
    if (c.verifiedByPhone) {
      if (!c.phoneChecks?.length) return;
      m.phoneUncheck.mutate(c.id, {
        onSuccess: (r) => {
          setUndone({ id: c.id, checks: r.undone });
          toast('Unticked: the facts found on the web read unverified again. Undo is on the candidate.', 'ok');
        },
        onError: fail,
      });
    } else if (c.webFacts) setDialog('phone');
  }
  async function undoUntick() {
    const c = cur();
    if (!c || !undone || undone.id !== c.id || busy) return;
    try {
      // Each tick again with its own caller, day and facts.
      for (const t of undoTicks(undone.checks)) await m.phoneCheck.mutateAsync({ id: c.id, ...t });
      setUndone(null);
      toast('Verified by phone again', 'ok');
    } catch (err) {
      fail(err);
    }
  }
  function reject() {
    const c = cur();
    if (!c || c.review !== 'proposed' || busy) return;
    m.reject.mutate(c.id, { onSuccess: () => toast(`${c.name}: turned down. Never suggested again.`, 'ok'), onError: fail });
  }

  const has = () => Boolean(latest.current.selected) && !dialogOpen();
  const accepted = () => has() && latest.current.selected?.review === 'accepted';
  const proposed = () => has() && latest.current.selected?.review === 'proposed';
  const writer = () => latest.current.canWrite;
  useBindings(
    [
      { keys: 'n', description: 'Add a candidate', group: 'Page', when: () => writer() && !dialogOpen(), run: () => setDialog('new') },
      { keys: 'e', description: 'Edit the selected candidate', group: 'Page', when: () => writer() && has() && latest.current.selected?.review !== 'rejected', run: () => setDialog('edit') },
      { keys: 's', description: 'Change the status of the selected candidate', group: 'Page', when: () => writer() && accepted(), run: () => setDialog('status') },
      { keys: 'f', description: 'Answer the flare test for the selected candidate', group: 'Page', when: () => writer() && accepted(), run: () => openFlare() },
      { keys: 'd', description: 'Flare test: pass or fail, with why (the selected candidate)', group: 'Page', when: () => writer() && accepted(), run: () => setDialog('verdict') },
      { keys: 'p', description: 'Verified by phone: tick or untick (the selected candidate)', group: 'Page', when: () => writer() && has() && latest.current.selected?.review !== 'rejected', run: togglePhone },
      { keys: 'b', description: 'Add a source (a web page or a phone call) to the selected candidate', group: 'Page', when: () => writer() && has() && latest.current.selected?.review !== 'rejected', run: () => setDialog('source') },
      { keys: 'c', description: 'Log a call or message with the selected candidate', group: 'Page', when: () => accepted() && Boolean(latest.current.selected?.personId), run: () => setDialog('call') },
      { keys: 't', description: 'Add a to-do for the selected candidate', group: 'Page', when: accepted, run: () => setDialog('task') },
      { keys: 'y', description: 'Yes: add the selected proposal to the care team', group: 'Page', when: () => writer() && proposed(), run: () => void accept() },
      { keys: 'x', description: 'No: turn the selected proposal down (never suggested again)', group: 'Page', when: () => writer() && proposed(), run: reject },
      { keys: 'w', description: 'Find candidates on the web', group: 'Page', when: () => writer() && !dialogOpen(), run: () => setDialog('find') },
      { keys: 'Delete', description: 'Delete the selected candidate (asks first)', group: 'Page', when: () => writer() && has(), run: () => setDialog('delete') },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'care.new', title: 'Add a candidate to the care team', group: 'Care team', keywords: 'care team doctor clinician add new', shortcut: 'n', when: writer, run: () => setDialog('new') },
      { id: 'care.find', title: 'Find candidates on the web', group: 'Care team', keywords: 'search web internet doctors clinicians care team', shortcut: 'w', when: writer, run: () => setDialog('find') },
      { id: 'care.flare', title: 'Answer the flare test for the selected candidate', group: 'Care team', keywords: 'flare test questions answer', shortcut: 'f', when: () => writer() && latest.current.selected?.review === 'accepted', run: () => openFlare() },
      { id: 'care.status', title: 'Change the status of the selected candidate', group: 'Care team', keywords: 'contacted shortlisted chosen declined call booked', shortcut: 's', when: () => writer() && latest.current.selected?.review === 'accepted', run: () => setDialog('status') },
      { id: 'care.verdict', title: 'Flare test: pass or fail for the selected candidate', group: 'Care team', keywords: 'flare test verdict pass fail decide', shortcut: 'd', when: () => writer() && latest.current.selected?.review === 'accepted', run: () => setDialog('verdict') },
      { id: 'care.phone', title: 'Verified by phone: tick or untick for the selected candidate', group: 'Care team', keywords: 'verified phone unverified web check called', shortcut: 'p', when: () => writer() && Boolean(latest.current.selected) && latest.current.selected?.review !== 'rejected', run: togglePhone },
      { id: 'care.view.step', title: 'Care team: group by step', group: 'Care team', keywords: 'step order local doctor flare plan lead specialist expert', run: () => setView('step') },
      { id: 'care.source', title: 'Add a source to the selected candidate', group: 'Care team', keywords: 'source link phone backed', shortcut: 'b', when: () => writer() && Boolean(latest.current.selected), run: () => setDialog('source') },
      { id: 'care.call', title: 'Log a call with the selected candidate', group: 'Care team', keywords: 'call message phone outreach', shortcut: 'c', when: () => latest.current.selected?.review === 'accepted' && Boolean(latest.current.selected?.personId), run: () => setDialog('call') },
      { id: 'care.task', title: 'Add a to-do for the selected candidate', group: 'Care team', keywords: 'follow up todo task', shortcut: 't', when: () => latest.current.selected?.review === 'accepted', run: () => setDialog('task') },
      { id: 'care.yes', title: 'Yes: add the selected proposal to the care team', group: 'Care team', keywords: 'accept proposal web', shortcut: 'y', when: () => writer() && latest.current.selected?.review === 'proposed', run: () => void accept() },
      { id: 'care.no', title: 'No: turn the selected proposal down', group: 'Care team', keywords: 'reject proposal web', shortcut: 'x', when: () => writer() && latest.current.selected?.review === 'proposed', run: reject },
      { id: 'care.view.proposed', title: 'Care team: show what waits for your yes', group: 'Care team', keywords: 'proposals web', run: () => setView('proposed') },
      { id: 'care.view.shortlisted', title: 'Care team: show the shortlist', group: 'Care team', keywords: 'shortlisted', run: () => setView('shortlisted') },
      { id: 'care.view.searches', title: 'Care team: show the web searches made', group: 'Care team', keywords: 'queries web search log', run: () => setView('searches') },
    ],
    [],
  );

  // ---- columns ------------------------------------------------------------
  const columns = useMemo<ColumnDef<Candidate, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorKey: 'name',
        cell: ({ row }) => {
          const c = row.original;
          return (
            <span className="ct-name-cell">
              {c.name}
              {c.practice ? <span className="muted"> · {c.practice}</span> : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: 220 },
      },
      {
        id: 'step',
        header: 'Step',
        accessorFn: (r) => r.stepOrder ?? stepOrder(r.step),
        cell: ({ row }) => (row.original.step ? stepWords(row.original.step) : <span className="faint">none</span>),
        meta: { width: 150 },
      },
      { id: 'role', header: 'Role', accessorFn: (r) => roleWords(r.role), cell: ({ row }) => (row.original.role ? roleWords(row.original.role) : <span className="faint">none</span>), meta: { width: 130 } },
      ...(view === 'proposed'
        ? ([
            { id: 'where', header: 'Where', accessorFn: (r) => placeWords(r), meta: { width: 120, maxWidth: 180 } },
            { id: 'found', header: 'Found', accessorFn: (r) => r.detail.proposal?.proposedAt ?? r.createdAt, cell: ({ row }) => <DateText iso={(row.original.detail.proposal?.proposedAt ?? row.original.createdAt).slice(0, 10)} />, meta: { width: 96 } },
          ] as ColumnDef<Candidate, unknown>[])
        : ([
            {
              id: 'status',
              header: 'Status',
              accessorFn: (r) => r.statusOrder,
              cell: ({ row }) => <Tag tone={STATUS_TONE[row.original.status]}>{statusWords(row.original.status).toLowerCase()}</Tag>,
              meta: { width: 130 },
            },
            { id: 'where', header: 'Where', accessorFn: (r) => placeWords(r), meta: { width: 110, maxWidth: 160 } },
            {
              id: 'flare',
              header: 'Flare test',
              accessorFn: (r) => r.flareAnswered,
              cell: ({ row }) => {
                const v = row.original.flareVerdict;
                if (v && v.verdict !== 'not_decided') return <Tag tone={VERDICT_TONE[v.verdict]}>{FLARE_VERDICT_WORDS[v.verdict].toLowerCase()}</Tag>;
                return <span className={row.original.flareAnswered ? 'mono' : 'faint'}>{row.original.flareAnswered ? `${row.original.flareAnswered} of ${FLARE_TEST_ITEMS.length}` : 'not asked'}</span>;
              },
              meta: { width: 96 },
            },
          ] as ColumnDef<Candidate, unknown>[])),
      {
        id: 'backed',
        header: 'Sources',
        accessorFn: (r) => r.notBacked * 100 + (r.unverified ?? 0),
        cell: ({ row }) => {
          const c = row.original;
          // "Unverified" in the same tag style as "not backed yet" (request 6): any web fact nobody checked by phone.
          return (
            <span className="ct-row-tags">
              {c.notBacked ? <Tag tone="neutral" title={NOT_BACKED_TITLE}>{`${c.notBacked} not backed`}</Tag> : null}
              {c.unverified ? <Tag tone="neutral" title={UNVERIFIED_TITLE}>{UNVERIFIED_WORDS}</Tag> : null}
              {!c.notBacked && !c.unverified ? <span className="faint">all backed</span> : null}
            </span>
          );
        },
        meta: { width: 170 },
      },
    ],
    [view],
  );

  const groupCols = useMemo<GroupedListColumn<Candidate>[]>(
    () => [
      { id: 'name', header: 'Name', cell: (c) => <span>{c.name}{c.practice ? <span className="muted"> · {c.practice}</span> : null}</span>, grow: true, minWidth: 220 },
      view === 'role' || view === 'step'
        ? { id: 'status', header: 'Status', cell: (c) => <Tag tone={STATUS_TONE[c.status]}>{statusWords(c.status).toLowerCase()}</Tag>, width: 130 }
        : { id: 'role', header: 'Role', cell: (c) => roleWords(c.role), width: 120 },
      { id: 'where', header: 'Where', cell: (c) => placeWords(c), width: 110, maxWidth: 160 },
      { id: 'flare', header: 'Flare test', cell: (c) => flareWords(c.flareAnswered, c.flareBacked, FLARE_TEST_ITEMS.length), width: 120 },
    ],
    [view],
  );

  const groups = useMemo<GroupedListGroup<Candidate>[]>(() => {
    if (view === 'step') {
      const keys: Array<CareStep | null> = [...CARE_STEPS, null];
      return keys.map((k) => ({ key: String(k ?? 'none'), header: stepWords(k), rows: items.filter((c) => (c.step ?? null) === k) })).filter((g) => g.rows.length);
    }
    if (view === 'role') {
      const keys: Array<CareRole | 'none'> = [...CARE_ROLES, 'none'];
      return keys
        .map((k) => ({ key: k, header: k === 'none' ? 'No role yet' : CARE_ROLE_WORDS[k], rows: items.filter((c) => (c.role ?? 'none') === k) }))
        .filter((g) => g.rows.length);
    }
    return CARE_STATUSES.map((s) => ({ key: s, header: CARE_STATUS_WORDS[s], rows: items.filter((c) => c.status === s) })).filter((g) => g.rows.length);
  }, [items, view]);

  const runColumns = useMemo<ColumnDef<SearchRun, unknown>[]>(
    () => [
      { id: 'when', header: 'When', accessorFn: (r) => r.startedAt, cell: ({ row }) => <DateTimeText iso={row.original.startedAt} />, meta: { width: 150 } },
      {
        id: 'what',
        header: 'Search',
        accessorFn: (r) => r.queries.join('; '),
        cell: ({ row }) => (
          <span>
            <span className="muted">{row.original.kind === 'find' ? 'Find candidates: ' : 'Ask: '}</span>
            {row.original.queries.join('; ') || <span className="faint">nothing sent</span>}
          </span>
        ),
        meta: { grow: true, minWidth: 220 },
      },
      { id: 'searches', header: 'Searches', accessorFn: (r) => r.searches, cell: ({ row }) => <span className="mono">{row.original.searches}</span>, meta: { width: 80 } },
      { id: 'found', header: 'Proposed', accessorFn: (r) => r.proposed, cell: ({ row }) => <span className="mono">{row.original.kind === 'find' ? row.original.proposed : ''}</span>, meta: { width: 84 } },
      { id: 'status', header: 'Result', accessorFn: (r) => r.status, cell: ({ row }) => <Tag tone={row.original.status === 'done' ? 'ok' : row.original.status === 'running' ? 'info' : row.original.status === 'failed' ? 'bad' : 'ash'}>{RUN_STATUS_WORDS[row.original.status]}</Tag>, meta: { width: 100 } },
    ],
    [],
  );

  // ---- left ---------------------------------------------------------------
  const anyFilter = Boolean(search.role || search.status || search.q || search.step);
  const nothingYet = Boolean(counts) && counts!.all === 0 && counts!.proposed === 0 && !runItems.length && !anyFilter;
  const viewCounts: Partial<Record<CareViewKey, number>> = counts ? { all: counts.all, proposed: counts.proposed, shortlisted: counts.shortlisted, searches: runItems.length } : {};

  let left: React.ReactNode;
  if (view === 'searches') {
    left = runs.isPending ? (
      <Loading>Loading the web searches…</Loading>
    ) : (
      <DataTable columns={runColumns} data={runItems} rowId={(r) => r.id} selectedId={search.run ?? null} onSelect={(r) => setSearch({ run: r?.id })} initialSort={[{ id: 'when', desc: true }]} tableId="care-team.runs" emptyText="No web searches yet. Find candidates (w) makes one." autoFocus />
    );
  } else if (list.isPending) {
    left = <Loading>Loading the care team…</Loading>;
  } else if (list.isError) {
    left = <Loading>Could not load the care team: {errorMessage(list.error)}</Loading>;
  } else if (view === 'role' || view === 'status' || view === 'step') {
    left = <GroupedList groups={groups} columns={groupCols} rowId={(c) => c.id} selectedId={selectedId} onSelect={(c) => select(c?.id ?? null)} onOpen={() => writer() && setDialog('edit')} storageKey={`care-team.${view}`} rowNoun={['candidate', 'candidates']} emptyText={anyFilter ? 'Nobody matches. Clear filters shows everyone.' : 'Nobody on the list yet.'} autoFocus />;
  } else {
    left = (
      <DataTable
        columns={columns}
        data={items}
        rowId={(c) => c.id}
        selectedId={selectedId}
        onSelect={(c) => select(c?.id ?? null)}
        onOpen={(c) => writer() && c.review !== 'rejected' && setDialog('edit')}
        initialSort={view === 'proposed' ? [{ id: 'found', desc: true }] : [{ id: 'step', desc: false }, { id: 'status', desc: false }]}
        tableId={view === 'proposed' ? 'care-team.proposed' : 'care-team.list'}
        emptyText={anyFilter ? 'Nobody matches. Clear filters shows everyone.' : view === 'proposed' ? 'Nothing waits for your yes.' : view === 'shortlisted' ? 'Nobody shortlisted yet.' : 'Nobody on the list yet.'}
        footer={counts ? <span>{counts.all} on the list · {counts.shortlisted} shortlisted · {counts.chosen} chosen · {counts.proposed} waiting for your yes</span> : null}
        autoFocus
      />
    );
  }

  // ---- right --------------------------------------------------------------
  let right: React.ReactNode;
  if (view === 'searches') {
    const r = runItems.find((x) => x.id === search.run) ?? null;
    right = r ? <RunDetail run={r} onStop={canWrite ? () => m.stop.mutate(r.id, { onError: fail }) : undefined} /> : runItems.length ? <EmptyState title="Pick a search">See the exact words sent, the ones refused, and the cost.</EmptyState> : null;
  } else if (!selectedId) {
    right = items.length ? (
      <EmptyState title="Pick a candidate">See their facts and sources, the flare test, calls and to-dos. Move with j and k.</EmptyState>
    ) : view === 'proposed' && canWrite ? (
      <EmptyState
        title="Nothing waits for your yes"
        action={
          <Button variant="accent" onClick={() => setDialog('find')} shortcut="w">
            Find candidates on the web
          </Button>
        }
      >
        A web search suggests people and services. Nothing is added until you say yes.
      </EmptyState>
    ) : null;
  } else if (detail.isPending && !selected) {
    right = <Loading>Loading the candidate…</Loading>;
  } else if (!selected) {
    right = <EmptyState title="This candidate is not here any more">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted. ' : ''}Pick another one from the list.</EmptyState>;
  } else {
    right = (
      <CandidateDetail
        candidate={selected}
        busy={busy}
        canWrite={canWrite}
        onEdit={() => setDialog('edit')}
        onStatus={() => setDialog('status')}
        onFlare={(item) => openFlare(item)}
        onSource={() => setDialog('source')}
        onRemoveSource={(sourceId) => m.removeSource.mutate({ id: selected.id, sourceId }, { onSuccess: () => toast('Source taken off', 'ok'), onError: fail })}
        onLogCall={() => setDialog('call')}
        onTask={() => setDialog('task')}
        onAccept={() => void accept()}
        onReject={reject}
        onLinkPerson={() => m.link.mutate({ id: selected.id, personId: null }, { onSuccess: () => toast('Added to People and places', 'ok'), onError: fail })}
        onDelete={() => setDialog('delete')}
        onVerdict={() => setDialog('verdict')}
        onHomeState={() => setDialog('home_state')}
        onPhoneCheck={() => setDialog('phone')}
        onPhoneUncheck={togglePhone}
        undone={undone && undone.id === selected.id ? undone.checks : null}
        onUndo={() => void undoUntick()}
      />
    );
  }

  const keyHints = view === 'proposed' ? PROPOSAL_KEY_HINTS : view === 'searches' ? [['j/k', 'move'] as [string, string], ['w', 'find candidates'] as [string, string]] : KEY_HINTS;
  const clearFilters = () => {
    setQLocal('');
    setSearch({ role: undefined, status: undefined, q: undefined, step: undefined, id: undefined });
  };

  return (
    <div className="page">
      <PageHeader
        title="Care team"
        meta={counts && !nothingYet ? <span className="mono">{counts.all} on the list · {counts.shortlisted} shortlisted · {counts.proposed} waiting for your yes</span> : null}
        intro={PAGE_INTRO}
        actions={
          canWrite
            ? {
                primary: { label: 'Add a candidate', onClick: () => setDialog('new'), shortcut: 'n', title: 'A person, clinic or service you found or were told about' },
                more: [
                  { label: 'Find candidates on the web…', onClick: () => setDialog('find'), shortcut: 'w', title: 'Off until you use it. Only what you type is sent; the cost is shown first; results wait for your yes.' },
                  { label: 'Web searches made', onClick: () => setView('searches'), title: 'Every web search, with its exact words' },
                ],
              }
            : undefined
        }
      />
      {nothingYet ? null : (
        <Toolbar label="Views and filters">
          <Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: VIEW_WORDS[v], count: viewCounts[v], title: VIEW_TITLES[v] }))} />
          {view !== 'searches' ? (
            <>
              <SearchField label="Find" placeholder="Name, practice or city" value={qLocal} onChange={setQLocal} width={190} />
              {view !== 'step' ? (
                <FilterGroup label="Step">
                  <Select
                    aria-label="Step"
                    value={search.step === undefined ? '' : String(search.step)}
                    placeholder="Any"
                    options={[...CARE_STEPS.map((n) => ({ value: String(n), label: stepWords(n) })), { value: 'none', label: 'No step yet' }]}
                    onChange={(e) => setSearch({ step: e.target.value ? (e.target.value === 'none' ? 'none' : Number(e.target.value)) : undefined, id: undefined })}
                  />
                </FilterGroup>
              ) : null}
              {view !== 'role' ? (
                <FilterGroup label="Role">
                  <Select aria-label="Role" value={search.role ?? ''} placeholder="Any" options={CARE_ROLES.map((r) => ({ value: r, label: CARE_ROLE_WORDS[r] }))} onChange={(e) => setSearch({ role: (e.target.value || undefined) as CareRole | undefined, id: undefined })} />
                </FilterGroup>
              ) : null}
              {view !== 'status' && view !== 'proposed' && view !== 'shortlisted' ? (
                <FilterGroup label="Status">
                  <Select aria-label="Status" value={search.status ?? ''} placeholder="Any" options={CARE_STATUSES.map((s) => ({ value: s, label: CARE_STATUS_WORDS[s] }))} onChange={(e) => setSearch({ status: (e.target.value || undefined) as CareStatus | undefined, id: undefined })} />
                </FilterGroup>
              ) : null}
            </>
          ) : null}
          {view === 'searches' ? <ScopeSwitch compact /> : null}
          <ToolbarKeys items={keyHints}>
            {anyFilter && view !== 'searches' ? (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </ToolbarKeys>
        </Toolbar>
      )}
      {!nothingYet ? (
        <p className="ct-view-line">
          {running ? (
            <>
              Searching the web… started <DateTimeText iso={running.startedAt} />.{' '}
              {canWrite ? (
                <Button size="sm" variant="ghost" onClick={() => m.stop.mutate(running.id, { onError: fail })}>
                  Stop
                </Button>
              ) : null}
            </>
          ) : (
            VIEW_LINES[view]
          )}
        </p>
      ) : null}
      <div className="page-body flush">
        {nothingYet ? (
          <EmptyState
            title="Nobody on the care team list yet"
            action={
              canWrite ? (
                <div className="row wrap">
                  <Button variant="primary" onClick={() => setDialog('new')} shortcut="n">
                    Add a candidate
                  </Button>
                  <Button onClick={() => setDialog('find')} shortcut="w" title="Only what you type is sent; the cost is shown first; results wait for your yes">
                    Find candidates on the web
                  </Button>
                </div>
              ) : null
            }
          >
            Keep everyone who could look after a flare here: their role, where they stand, how they answered the flare test, and a source for every fact.
          </EmptyState>
        ) : (
          <SplitView storageKey="care-team" defaultLeft={56} minLeft={440} minRight={420} left={left} right={right} />
        )}
      </div>

      <CandidateDialog
        open={dialog === 'new'}
        onClose={close}
        busy={m.create.isPending}
        error={formError}
        onSave={(input) =>
          m.create.mutate(input, {
            onSuccess: (c) => {
              close();
              toast(`${c.name} added, at Found`, 'ok');
              setSearch({ view: view === 'searches' || view === 'proposed' ? undefined : search.view, id: c.id }, false);
            },
            onError: (err) => setFormError(errorMessage(err)),
          })
        }
      />
      <CandidateDialog open={dialog === 'edit' && Boolean(selected)} onClose={close} candidate={selected} busy={m.update.isPending} error={formError} onSave={(patch) => selected && m.update.mutate({ id: selected.id, patch }, onDone('Saved'))} />
      <StatusDialog open={dialog === 'status' && Boolean(selected)} onClose={close} candidate={selected} busy={m.status.isPending} error={formError} onSave={(p) => selected && m.status.mutate({ id: selected.id, ...p }, onDone(`Status: ${statusWords(p.status)}`))} />
      <VerdictDialog open={dialog === 'verdict' && Boolean(selected)} onClose={close} candidate={selected} me={me.user?.name ?? null} busy={m.verdict.isPending} error={formError} onSave={(v) => selected && m.verdict.mutate({ id: selected.id, ...v }, onDone(`Flare test: ${FLARE_VERDICT_WORDS[v.verdict]}`))} />
      <PhoneCheckDialog open={dialog === 'phone' && Boolean(selected)} onClose={close} candidate={selected} busy={m.phoneCheck.isPending} error={formError} onSave={(p) => selected && m.phoneCheck.mutate({ id: selected.id, ...p }, { ...onDone('Verified by phone'), onSuccess: () => (close(), setUndone(null), toast('Verified by phone', 'ok')) })} />
      <HomeStateDialog
        open={dialog === 'home_state' && Boolean(selected)}
        onClose={close}
        candidate={selected}
        busy={m.update.isPending}
        error={formError}
        onSave={(p) => selected && m.update.mutate({ id: selected.id, patch: { licensedInHomeState: p.licensedInHomeState, source: p.source, sourceFields: p.source ? ['licensedInHomeState'] : null } }, onDone('Licensed in home state saved'))}
      />
      <FlareDialog open={dialog === 'flare' && Boolean(selected)} onClose={close} candidate={selected} item={flareItem} busy={m.flare.isPending} error={formError} onSave={(p) => selected && m.flare.mutate({ id: selected.id, ...p }, onDone('Flare test answer saved'))} />
      <SourceDialog open={dialog === 'source' && Boolean(selected)} onClose={close} candidate={selected} busy={m.addSource.isPending} error={formError} onSave={(p) => selected && m.addSource.mutate({ id: selected.id, ...p }, onDone('Source added'))} />
      <AcceptDialog
        open={dialog === 'accept' && Boolean(selected)}
        onClose={close}
        candidate={selected}
        matches={matches}
        busy={m.accept.isPending}
        onAccept={(personId) => selected && m.accept.mutate({ id: selected.id, personId }, { onSuccess: () => (close(), toast(`${selected.name} is on your list, at Found.`, 'ok')), onError: fail })}
      />
      <FindDialog
        open={dialog === 'find'}
        onClose={close}
        cap={cap}
        checking={m.check.isPending}
        sending={m.find.isPending}
        error={formError}
        onCheck={(body) =>
          m.check.mutateAsync(body).catch((err: unknown) => {
            setFormError(errorMessage(err));
            throw err;
          })
        }
        onSend={(body) =>
          m.find.mutate(body, {
            onSuccess: (run) => {
              watched.current = run.id;
              close();
              void qc.invalidateQueries({ queryKey: ['care-team', 'runs'] });
              toast('Searching the web. What it finds will wait for your yes.', 'info');
            },
            onError: (err) => setFormError(errorMessage(err)),
          })
        }
      />
      <CommunicationDialog
        open={dialog === 'call' && Boolean(selected?.personId)}
        onClose={close}
        presetParticipants={selected?.personId ? [{ personId: selected.personId, role: 'to' }] : []}
        preset={selected ? { channel: 'call', direction: 'outbound', subject: `Call with ${selected.name}` } : null}
        onSaved={() => {
          close();
          void qc.invalidateQueries({ queryKey: ['care-team'] });
          if (selected?.status === 'found') toast('Logged. The status is still Found: press s to change it.', 'ok');
        }}
      />
      <TaskDialog
        open={dialog === 'task' && Boolean(selected)}
        onClose={close}
        preset={selected ? ({ title: `Follow up with ${selected.name}`, sourceType: 'care_candidate', sourceId: selected.id, ownerPersonId: selected.personId ?? null } satisfies Partial<TaskInput>) : null}
        busy={taskM.create.isPending}
        error={formError}
        onCreate={(input) =>
          taskM.create.mutate(input, {
            onSuccess: () => {
              close();
              void qc.invalidateQueries({ queryKey: ['care-team'] });
              toast('To-do added', 'ok');
            },
            onError: (err) => setFormError(errorMessage(err)),
          })
        }
        onUpdate={() => undefined}
      />
      <Confirm
        open={dialog === 'delete'}
        onClose={close}
        title="Delete this candidate?"
        body={<span className="muted">{selected?.name ?? selectedRow?.name ?? ''}. It is hidden, not erased. Calls, to-dos and the People and places entry stay.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const c = cur();
          if (!c) return;
          m.remove.mutate(c.id, { onSuccess: () => (toast('Candidate deleted', 'ok'), select(null)), onError: fail });
        }}
      />
    </div>
  );
}
