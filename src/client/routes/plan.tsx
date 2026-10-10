/**
 * /plan — Plan (2026-10-09): the current plan, read from the document the user adds, shown in tabs.
 *
 * Add a plan (u) or drop a file on the page: it is stored as a document (its original kept), then Claude reads it into
 * a framework (the estimate shows while it reads; above the per-document limit it asks once). Tabs, under Show:
 *   framework  the outline: sections, goals, steps, decisions with their branches (v f)
 *   checklist  every item to do or check: done (x), skipped (s), doesn't apply (a), by whom and when (v c)
 *   timeline   dated items in order, then the plan's own words for when, then "when it applies" (v w)
 *   original   the plan document with the passages each item came from marked (v o)
 *   plans      every plan added: the current one, the ones it replaced, a new one being read (v p)
 * Split view: the list left (j/k, Enter, Esc), the chosen item right. The plan, the tab, the filters and the
 * selection live in the URL (?plan=&tab=&id=), so a to-do made from an item links straight back to it.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { PLAN_ITEM_KINDS, PLAN_KIND_WORDS, PLAN_STATUS_WORDS, planItemStatusWords, readingWords, usd } from '@shared/plan';
import { dateSortKey } from '@shared/dates';
import { ApiError, errorMessage, useFailToast } from '../api/client';
import { fetchPlanEstimate, fetchPlanItem, readingBusy, usePlan, usePlanMutations, usePlanOriginal, usePlans, type PlanEstimate, type PlanItem, type PlanPassage, type PlanSummary } from '../api/plans';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { dialogOpen, hasFiles, moveToNextRow } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Field, Input, Select } from '../ui/Field';
import { Tag } from '../ui/StatusTag';
import { DateText } from '../ui/DateText';
import { Confirm, Dialog } from '../ui/Dialog';
import { FilterGroup, SearchField, Segmented, Toolbar, ToolbarKeys } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { PlanItemPane } from '../features/plan/PlanItemPane';
import { PlanOriginalPane } from '../features/plan/PlanOriginalPane';
import { PlanSummaryPane, planStatusTone } from '../features/plan/PlanSummaryPane';
import { EditItemDialog, FromDocumentDialog, TodoDialog } from '../features/plan/PlanDialogs';
import {
  ACCEPT,
  CHECK_VIEWS,
  CHECK_VIEW_WORDS,
  DROP_WORDS,
  INTRO,
  STATUS_KEYS,
  TABS,
  TAB_INTRO,
  TAB_KEYS,
  TAB_WORDS,
  TIMELINE_GROUP_WORDS,
  checkViewHas,
  itemLine,
  matchesFind,
  ownersOf,
  statusTone,
  timelineGroup,
  timelineKey,
  type CheckView,
  type PlanTab,
} from '../features/plan/words';
import '../features/plan/plan.css';

const searchSchema = z.object({
  /** The plan shown (default: the current one). */
  plan: z.string().optional().catch(undefined),
  tab: z.enum(TABS).optional().catch(undefined),
  /** The selected item (framework, checklist, timeline), passage (original: itemId:index) or plan (all plans). */
  id: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  kind: z.enum(PLAN_ITEM_KINDS).optional().catch(undefined),
  show: z.enum(CHECK_VIEWS).optional().catch(undefined),
  who: z.string().optional().catch(undefined),
});
export type PlanSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/plan')({
  validateSearch: (s: Record<string, unknown>): PlanSearch => searchSchema.parse(s),
  component: PlanPage,
});

const ITEM_TABS: ReadonlySet<PlanTab> = new Set(['framework', 'checklist', 'timeline']);
const STATUS_RANK: Record<string, number> = { open: 0, done: 1, skipped: 2, not_applicable: 3 };
const PLAN_RANK: Record<string, number> = { current: 0, draft: 1, superseded: 2 };

type StatusKey = 'done' | 'skipped' | 'not_applicable';

function PlanPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const canWrite = useMe().canWrite;
  const plans = usePlans();
  const list = plans.data?.items ?? [];
  const planId = search.plan ?? plans.data?.currentId ?? list[0]?.id ?? null;
  const tab: PlanTab = search.tab ?? 'framework';
  const detail = usePlan(planId);
  const plan = detail.data && detail.data.id === planId ? detail.data : null;
  const original = usePlanOriginal(plan?.reading?.state === 'done' ? planId : null, tab === 'original');
  const m = usePlanMutations();
  const selectedId = search.id ?? null;
  const show: CheckView = search.show ?? 'open';

  const fileRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const [fromDocOpen, setFromDocOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [readAsk, setReadAsk] = useState<{ planId: string; estimate: PlanEstimate } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const busy = Object.values(m).some((x) => x.isPending);

  const items = plan?.items ?? [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const parentKind = (it: PlanItem) => (it.parentId ? byId.get(it.parentId)?.kind : undefined);
  const owners = useMemo(() => ownersOf(items), [items]);
  const who = search.who && owners.includes(search.who) ? search.who : undefined;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  const frameworkRows = useMemo(() => items.filter((i) => (!search.kind || i.kind === search.kind) && (!who || i.owner === who) && matchesFind(i, search.q)), [items, search.kind, who, search.q]);
  const checklistRows = useMemo(() => items.filter((i) => i.actionable && checkViewHas(show, i.status) && (!who || i.owner === who) && matchesFind(i, search.q)), [items, show, who, search.q]);
  const timelineRows = useMemo(() => items.filter((i) => timelineGroup(i) !== null && (!who || i.owner === who) && matchesFind(i, search.q)), [items, who, search.q]);
  const passages = useMemo(() => {
    const words = (search.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return (original.data?.passages ?? []).filter((p) => !words.length || words.every((w) => `${p.itemTitle} ${p.quote}`.toLowerCase().includes(w)));
  }, [original.data, search.q]);
  const checklistAll = useMemo(() => items.filter((i) => i.actionable), [items]);

  const selectedItem = ITEM_TABS.has(tab) && selectedId ? (byId.get(selectedId) ?? null) : null;
  const selectedPassage = tab === 'original' ? (passages.find((p) => p.key === selectedId) ?? original.data?.passages.find((p) => p.key === selectedId) ?? null) : null;
  const selectedPlan = tab === 'plans' && selectedId ? (list.find((p) => p.id === selectedId) ?? null) : null;

  // A link that names only an item (a to-do from an earlier plan): find its plan.
  const resolving = useRef<string | null>(null);
  useEffect(() => {
    if (!ITEM_TABS.has(tab) || !selectedId || search.plan || !plan || byId.has(selectedId) || resolving.current === selectedId) return;
    resolving.current = selectedId;
    fetchPlanItem(selectedId).then(
      (r) => r.planId !== plan.id && setSearch({ plan: r.planId }),
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedId, search.plan, plan?.id, byId]);

  function setSearch(patch: Partial<PlanSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function setTab(t: PlanTab) {
    setSearch({ tab: t === 'framework' ? undefined : t, id: undefined, kind: undefined }, false);
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function openPlan(id: string) {
    setSearch({ plan: id, tab: undefined, id: undefined, q: undefined, kind: undefined, who: undefined, show: undefined }, false);
  }
  function showOriginal(itemId: string, index = 0) {
    const it = byId.get(itemId);
    if (!it?.citations.length) {
      toast('Claude gave no passage for this item.');
      return;
    }
    setSearch({ tab: 'original', id: `${itemId}:${Math.min(index, it.citations.length - 1)}`, q: undefined }, false);
  }
  function openItem(itemId: string) {
    setSearch({ tab: undefined, id: itemId, q: undefined, kind: undefined }, false);
  }

  // --- adding a plan ---------------------------------------------------------------------------------------------
  function chooseFile() {
    if (!latest.current.canWrite) return;
    fileRef.current?.click();
  }
  function uploadFile(file: File) {
    m.upload.mutate(file, {
      onSuccess: (r) => {
        toast(r.existing ? `This file is already a plan: ${r.plan.title}` : r.duplicate ? 'The file was already in Documents. Claude is reading it as your plan.' : 'Plan added. Claude is reading it.', 'ok');
        openPlan(r.plan.id);
      },
      onError: fail,
    });
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    if (!latest.current.canWrite) {
      toast('Only the owner or an editor can add a plan.');
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length !== 1) {
      toast(files.length ? 'Drop one plan at a time.' : 'Nothing to add.');
      return;
    }
    uploadFile(files[0]);
  }
  function fromDocument(documentId: string) {
    m.fromDocument.mutate(documentId, {
      onSuccess: (r) => {
        setFromDocOpen(false);
        setFormError(null);
        toast(r.existing ? `That document is already a plan: ${r.plan.title}` : 'Claude is reading it as your plan.', 'ok');
        openPlan(r.plan.id);
      },
      onError: (err) => setFormError(errorMessage(err)),
    });
  }

  // --- reading ---------------------------------------------------------------------------------------------------
  function askReadAgain(id: string | null | undefined) {
    if (!id || !latest.current.canWrite) return;
    fetchPlanEstimate(id).then(
      (estimate) => setReadAsk({ planId: id, estimate }),
      fail,
    );
  }
  function readNow(id: string, confirm: boolean) {
    m.read.mutate(
      { id, confirm },
      {
        onSuccess: (r) => {
          setReadAsk(null);
          toast(r.newPlan ? 'Reading it into a new plan. This one stays as it is until that is read.' : 'Claude is reading the plan.', 'ok');
          if (r.newPlan) openPlan(r.plan.id);
        },
        onError: fail,
      },
    );
  }

  // --- the checklist ---------------------------------------------------------------------------------------------
  function setStatus(s: StatusKey) {
    const it = latest.current.selectedItem;
    if (!it || !it.actionable || latest.current.busy || !latest.current.canWrite) return;
    const next = it.status === s ? 'open' : s;
    m.setStatus.mutate(
      { id: it.id, status: next },
      {
        onSuccess: () => {
          toast(next === 'open' ? 'Back to do' : `Marked ${planItemStatusWords(next)}`, 'ok');
          if (next !== 'open' && latest.current.tab === 'checklist' && latest.current.show === 'open') moveToNextRow(tableRef.current);
        },
        onError: fail,
      },
    );
  }
  function markSame() {
    const it = latest.current.selectedItem;
    const p = latest.current.plan;
    if (!it?.looksLike || !p || !latest.current.canWrite) return;
    m.carryOver.mutate({ id: p.id, itemIds: [it.id] }, { onSuccess: (r) => toast(r.marked ? 'Marked the same as in the earlier plan' : 'Nothing to mark', 'ok'), onError: fail });
  }
  function markAll() {
    const p = latest.current.plan;
    if (!p || !latest.current.canWrite) return;
    m.carryOver.mutate({ id: p.id }, { onSuccess: (r) => toast(`${r.marked} item${r.marked === 1 ? '' : 's'} marked from the earlier plan`, 'ok'), onError: fail });
  }
  function dismissCarry() {
    const p = latest.current.plan;
    if (p) m.dismissCarry.mutate(p.id, { onError: fail });
  }
  function makeCurrent(id: string | null | undefined) {
    if (!id) return;
    m.makeCurrent.mutate(id, { onSuccess: (p) => toast(`${p.title} is the current plan now`, 'ok'), onError: fail });
  }

  const latest = useRef({ tab, selectedItem, selectedPassage, selectedPlan, plan, canWrite, busy, show, planId });
  latest.current = { tab, selectedItem, selectedPassage, selectedPlan, plan, canWrite, busy, show, planId };
  const free = () => !dialogOpen();
  const onItem = () => ITEM_TABS.has(latest.current.tab) && Boolean(latest.current.selectedItem) && free();
  const canAct = () => onItem() && latest.current.canWrite && !latest.current.busy;
  const canCheck = () => canAct() && Boolean(latest.current.selectedItem?.actionable);
  /** r reads the plan chosen on All plans (the row), else the plan shown. */
  const readTarget = () => (latest.current.tab === 'plans' ? (latest.current.selectedPlan?.id ?? latest.current.planId) : latest.current.planId);

  useBindings(
    [
      { keys: 'v v', description: 'Next tab: framework, checklist, timeline, original, all plans', group: 'Lists', when: free, run: () => setTab(TABS[(TABS.indexOf(latest.current.tab) + 1) % TABS.length]) },
      ...TABS.map((t) => ({ keys: TAB_KEYS[t], description: `Show the ${TAB_WORDS[t].toLowerCase()}`, group: 'Lists', when: free, run: () => setTab(t) })),
      { keys: 'u', description: 'Add a plan (choose the file)', group: 'Page', when: () => latest.current.canWrite && free(), run: chooseFile },
      { keys: STATUS_KEYS.done, description: 'Mark the selected item done (again: back to do)', group: 'Page', when: canCheck, run: () => setStatus('done') },
      { keys: STATUS_KEYS.skipped, description: 'Mark the selected item skipped (again: back to do)', group: 'Page', when: canCheck, run: () => setStatus('skipped') },
      { keys: STATUS_KEYS.not_applicable, description: "Mark that the selected item doesn't apply (again: back to do)", group: 'Page', when: canCheck, run: () => setStatus('not_applicable') },
      { keys: 'e', description: 'Change the selected item', group: 'Page', when: canAct, run: () => setEditOpen(true) },
      { keys: 't', description: 'Make a to-do from the selected item', group: 'Page', when: () => canAct() && !latest.current.selectedItem?.task, run: () => setTodoOpen(true) },
      { keys: 'o', description: 'Show the selected item in the original', group: 'Page', when: () => onItem() && Boolean(latest.current.selectedItem?.citations.length), run: () => showOriginal(latest.current.selectedItem!.id) },
      { keys: 'm', description: 'Mark the selected item the same as in the earlier plan', group: 'Page', when: () => canAct() && Boolean(latest.current.selectedItem?.looksLike) && latest.current.selectedItem?.status === 'open', run: markSame },
      { keys: 'r', description: 'Read the plan again (shows the cost first)', group: 'Page', when: () => latest.current.canWrite && Boolean(latest.current.plan) && free(), run: () => askReadAgain(readTarget()) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'plan.add', title: 'Plan: add a plan', group: 'Page', keywords: 'upload pdf care plan flare plan new', shortcut: 'u', when: () => latest.current.canWrite, run: chooseFile },
      { id: 'plan.from-document', title: 'Plan: use a document already added', group: 'Page', keywords: 'plan document existing read', when: () => latest.current.canWrite, run: () => setFromDocOpen(true) },
      ...TABS.map((t) => ({ id: `plan.tab.${t}`, title: `Plan: ${TAB_WORDS[t].toLowerCase()}`, group: 'Page', keywords: 'plan tab view outline checklist timeline original', shortcut: TAB_KEYS[t], run: () => setTab(t) })),
      { id: 'plan.done', title: 'Plan: mark the selected item done', group: 'Page', keywords: 'check off complete', shortcut: STATUS_KEYS.done, when: canCheck, run: () => setStatus('done') },
      { id: 'plan.skipped', title: 'Plan: mark the selected item skipped', group: 'Page', keywords: 'skip', shortcut: STATUS_KEYS.skipped, when: canCheck, run: () => setStatus('skipped') },
      { id: 'plan.na', title: "Plan: the selected item doesn't apply", group: 'Page', keywords: 'not applicable', shortcut: STATUS_KEYS.not_applicable, when: canCheck, run: () => setStatus('not_applicable') },
      { id: 'plan.edit', title: 'Plan: change the selected item', group: 'Page', keywords: 'edit title who when note', shortcut: 'e', when: canAct, run: () => setEditOpen(true) },
      { id: 'plan.todo', title: 'Plan: make a to-do from the selected item', group: 'Page', keywords: 'task todo', shortcut: 't', when: () => canAct() && !latest.current.selectedItem?.task, run: () => setTodoOpen(true) },
      { id: 'plan.original', title: 'Plan: show the selected item in the original', group: 'Page', keywords: 'source page quote', shortcut: 'o', when: () => onItem() && Boolean(latest.current.selectedItem?.citations.length), run: () => showOriginal(latest.current.selectedItem!.id) },
      { id: 'plan.mark-same', title: 'Plan: mark the selected item the same as in the earlier plan', group: 'Page', keywords: 'carry over earlier old plan', shortcut: 'm', when: () => canAct() && Boolean(latest.current.selectedItem?.looksLike), run: markSame },
      { id: 'plan.mark-all', title: 'Plan: mark the items that look the same as finished ones in the earlier plan', group: 'Page', keywords: 'carry over earlier old plan done', when: () => latest.current.canWrite && Boolean(latest.current.plan?.carryOver?.matches), run: markAll },
      { id: 'plan.read', title: 'Plan: read the plan again (shows the cost first)', group: 'Page', keywords: 'reread claude estimate', shortcut: 'r', when: () => latest.current.canWrite && Boolean(latest.current.plan), run: () => askReadAgain(readTarget()) },
      { id: 'plan.current', title: 'Plan: make this the current plan', group: 'Page', keywords: 'current replace', when: () => latest.current.canWrite && Boolean(latest.current.plan) && latest.current.plan?.status !== 'current' && latest.current.plan?.reading?.state === 'done', run: () => makeCurrent(latest.current.planId) },
      { id: 'plan.rename', title: 'Plan: rename the plan', group: 'Page', keywords: 'name title', when: () => latest.current.canWrite && Boolean(latest.current.plan), run: () => setRenameOpen(true) },
      { id: 'plan.remove', title: 'Plan: remove the plan (asks first)', group: 'Page', keywords: 'delete hide', when: () => latest.current.canWrite && Boolean(latest.current.plan), run: () => setRemoveId(latest.current.planId) },
    ],
    [],
  );

  // --- columns ---------------------------------------------------------------------------------------------------
  const statusColumn: ColumnDef<PlanItem, unknown> = {
    id: 'status',
    header: 'Done',
    accessorFn: (r) => (r.actionable ? (STATUS_RANK[r.status] ?? 4) : 9),
    cell: ({ row }) =>
      row.original.actionable ? (
        <Tag tone={statusTone(row.original.status)}>{row.original.statusWords}</Tag>
      ) : null,
    meta: { width: 96, shrink: false },
  };
  const whoColumn: ColumnDef<PlanItem, unknown> = { id: 'who', header: 'Who', accessorFn: (r) => r.owner ?? '', cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 90, maxWidth: 160, wrap: true } };
  const whenColumn: ColumnDef<PlanItem, unknown> = {
    id: 'when',
    header: 'When',
    accessorFn: (r) => (r.due ? dateSortKey(r.due) : (r.dueText ?? '')),
    cell: ({ row }) => (row.original.dueText ? <span>{row.original.dueText}</span> : row.original.due ? <DateText iso={row.original.due} precision={row.original.duePrecision} /> : null),
    meta: { width: 110, maxWidth: 190, wrap: true },
  };

  const frameworkColumns = useMemo<ColumnDef<PlanItem, unknown>[]>(
    () => [
      {
        id: 'order',
        header: 'Outline',
        accessorFn: (r) => r.order,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className={`plan-outline d${Math.min(r.depth, 5)}${r.kind === 'section' ? ' section' : ''}`}>
              {r.kind === 'section' ? null : <span className="plan-kind">{r.kindWords}</span>}
              {itemLine(r, parentKind(r))}
              {r.userFields.length ? <span className="plan-edited">changed</span> : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: 260 },
      },
      whoColumn,
      whenColumn,
      statusColumn,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId],
  );
  const checklistColumns = useMemo<ColumnDef<PlanItem, unknown>[]>(
    () => [
      statusColumn,
      {
        id: 'title',
        header: 'To do',
        accessorFn: (r) => r.order,
        cell: ({ row }) => (
          <span>
            {itemLine(row.original, parentKind(row.original))}
            {row.original.task ? <span className="plan-edited">to-do</span> : null}
          </span>
        ),
        meta: { grow: true, minWidth: 220 },
      },
      whoColumn,
      whenColumn,
      { id: 'under', header: 'Under', accessorFn: (r) => r.sectionTitle ?? '', cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 110, maxWidth: 180, wrap: true } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId],
  );
  const timelineColumns = useMemo<ColumnDef<PlanItem, unknown>[]>(
    () => [
      {
        id: 'when',
        header: 'When',
        accessorFn: (r) => timelineKey(r),
        cell: ({ row }) => {
          const r = row.original;
          const g = timelineGroup(r);
          if (g === 'date') return <DateText iso={r.due} precision={r.duePrecision} text={r.dueText} />;
          if (g === 'words') return <span>{r.dueText}</span>;
          return <span className="muted">{TIMELINE_GROUP_WORDS.when.toLowerCase()}</span>;
        },
        meta: { width: 120, maxWidth: 200, wrap: true },
      },
      { id: 'title', header: 'What', accessorFn: (r) => r.title, cell: ({ row }) => itemLine(row.original, parentKind(row.original)), meta: { grow: true, minWidth: 200 } },
      { id: 'condition', header: 'When it applies', accessorFn: (r) => r.condition ?? '', cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 130, maxWidth: 220, wrap: true } },
      statusColumn,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId],
  );
  const passageColumns = useMemo<ColumnDef<PlanPassage, unknown>[]>(
    () => [
      { id: 'page', header: 'Page', accessorFn: (r) => r.page, cell: ({ row }) => <span className="mono">p.{row.original.page}</span>, meta: { className: 'num', width: 56, shrink: false } },
      {
        id: 'item',
        header: 'Item and passage',
        accessorFn: (r) => r.itemTitle,
        cell: ({ row }) => (
          <span>
            {row.original.itemTitle} <span className="muted">“{row.original.quote}”</span>
          </span>
        ),
        meta: { grow: true, minWidth: 220 },
      },
      {
        id: 'found',
        header: 'On the page',
        accessorFn: (r) => (r.verified ? 0 : 1),
        cell: ({ row }) => (row.original.verified ? <span className="muted">found</span> : <Tag tone="warn">not found</Tag>),
        meta: { width: 96, shrink: false },
      },
    ],
    [],
  );
  const planColumns = useMemo<ColumnDef<PlanSummary, unknown>[]>(
    () => [
      { id: 'title', header: 'Plan', accessorKey: 'title', meta: { grow: true, minWidth: 200 } },
      {
        id: 'status',
        header: 'Where it stands',
        accessorFn: (r) => PLAN_RANK[r.status] ?? 3,
        cell: ({ row }) => (
          <span>
            <Tag tone={planStatusTone(row.original.status)}>{PLAN_STATUS_WORDS[row.original.status] ?? row.original.status}</Tag>
            {readingBusy(row.original.reading) ? <span className="muted"> reading</span> : null}
          </span>
        ),
        meta: { width: 120, shrink: false },
      },
      { id: 'date', header: 'Dated', accessorFn: (r) => (r.planDate ? dateSortKey(r.planDate) : ''), cell: ({ row }) => (row.original.planDate ? <DateText iso={row.original.planDate} precision={row.original.planDatePrecision} text={row.original.planDateText} /> : null), meta: { width: 96 } },
      { id: 'progress', header: 'Checklist', accessorFn: (r) => (r.progress.total ? r.progress.done / r.progress.total : -1), cell: ({ row }) => <span className="muted">{row.original.progress.total ? `${row.original.progress.done} of ${row.original.progress.total} done` : ''}</span>, meta: { width: 110 } },
    ],
    [],
  );

  // --- the line under the toolbar ----------------------------------------------------------------------------------
  const reading = plan?.reading ?? null;
  const currentId = plans.data?.currentId ?? null;
  function planLine() {
    if (!plan) return null;
    if (reading && reading.state !== 'done') {
      const tone = reading.state === 'ask' || reading.state === 'held' || reading.state === 'ai_off' ? 'warn' : reading.state === 'failed' || reading.state === 'no_text' ? 'bad' : '';
      return (
        <div className={`plan-line ${tone}`}>
          <span>{readingWords(reading)}</span>
          {canWrite && reading.state === 'ask' ? (
            <Button size="sm" variant="accent" disabled={busy} onClick={() => readNow(plan.id, true)}>
              Read it ({usd(reading.estimateUsd)})
            </Button>
          ) : null}
          {canWrite && (reading.state === 'failed' || reading.state === 'ai_off') ? (
            <Button size="sm" disabled={busy} onClick={() => askReadAgain(plan.id)} shortcut="r">
              Read it again
            </Button>
          ) : null}
          {reading.state === 'held' && plan.documentId ? (
            <Button size="sm" onClick={() => void navigate({ to: '/documents' })}>
              Open Documents
            </Button>
          ) : null}
        </div>
      );
    }
    if (plan.status === 'superseded') {
      return (
        <div className="plan-line warn">
          <span>
            <strong>Replaced{plan.supersededAt ? ` on ${plan.supersededAt.slice(0, 10)}` : ''}.</strong> This earlier plan is kept with its checklist.
          </span>
          <span className="row">
            {currentId ? (
              <Button size="sm" onClick={() => openPlan(currentId)}>
                Open the current plan
              </Button>
            ) : null}
            {canWrite ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => makeCurrent(plan.id)}>
                Make this the current plan
              </Button>
            ) : null}
          </span>
        </div>
      );
    }
    const co = plan.carryOver;
    if (co && co.matches > 0 && !co.appliedAt && !co.dismissedAt) {
      return (
        <div className="plan-line ok">
          <span>
            <strong>
              {co.matches} item{co.matches === 1 ? ' looks' : 's look'} the same as finished ones in the earlier plan
            </strong>
            {co.fromTitle ? ` (${co.fromTitle})` : ''}. Nothing is marked until you say so.
          </span>
          {canWrite ? (
            <span className="row">
              <Button size="sm" variant="accent" disabled={busy} onClick={markAll}>
                Mark them
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={dismissCarry}>
                Not now
              </Button>
            </span>
          ) : null}
        </div>
      );
    }
    return (
      <p className="plan-line">
        <span>
          <strong>{TAB_WORDS[tab]}.</strong> {tab === 'checklist' ? plan.progressWords : TAB_INTRO[tab]}
        </span>
      </p>
    );
  }

  // --- the list (left) -------------------------------------------------------------------------------------------
  const notRead = Boolean(plan) && reading?.state !== 'done';
  const filtered = Boolean(search.q || search.kind || who || (tab === 'checklist' && show !== 'open'));
  const emptyItems = notRead ? (readingBusy(reading) ? 'Claude is reading the plan…' : 'Nothing read from this plan yet.') : filtered ? 'Nothing matches. Clear filters (in the toolbar) shows them all.' : 'Nothing here.';
  const onOpenItem = (r: PlanItem) => showOriginal(r.id);

  let left: ReactNode;
  if (tab === 'plans') {
    left = <DataTable key="plans" columns={planColumns} data={list} rowId={(r) => r.id} selectedId={selectedId} onSelect={(r) => select(r?.id ?? null)} onOpen={(r) => openPlan(r.id)} initialSort={[{ id: 'status', desc: false }]} emptyText="No plans yet." tableId="plan.plans" autoFocus />;
  } else if (!plan) {
    left = detail.isError ? <EmptyState title="This plan is not here any more">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It was removed, or its document was. ' : ''}Open the current plan from All plans.</EmptyState> : <Loading>Loading the plan…</Loading>;
  } else if (tab === 'original') {
    left = original.isPending && !notRead ? (
      <Loading>Loading the original…</Loading>
    ) : (
      <DataTable key="original" columns={passageColumns} data={passages} rowId={(r) => r.key} selectedId={selectedId} onSelect={(r) => select(r?.key ?? null)} onOpen={(r) => void navigate({ to: '/documents/$id', params: { id: original.data!.documentId }, search: { page: r.page, tab: 'text' } })} initialSort={[{ id: 'page', desc: false }]} emptyText={notRead ? emptyItems : 'No passages.'} tableId="plan.original" autoFocus />
    );
  } else {
    const rows = tab === 'framework' ? frameworkRows : tab === 'checklist' ? checklistRows : timelineRows;
    const columns = tab === 'framework' ? frameworkColumns : tab === 'checklist' ? checklistColumns : timelineColumns;
    const sortId = tab === 'framework' ? 'order' : tab === 'checklist' ? 'title' : 'when';
    left = (
      <div ref={tableRef} style={{ display: 'contents' }}>
        <DataTable
          key={`${tab}-${plan.id}`}
          columns={columns}
          data={rows}
          rowId={(r) => r.id}
          selectedId={selectedId}
          onSelect={(r) => select(r?.id ?? null)}
          onOpen={onOpenItem}
          initialSort={[{ id: sortId, desc: false }]}
          rowClassName={(r) => (r.actionable && r.status !== 'open' ? 'dim' : undefined)}
          emptyText={emptyItems}
          footer={tab === 'checklist' ? <span>{plan.progressWords}</span> : null}
          tableId={`plan.${tab}`}
          autoFocus
        />
      </div>
    );
  }

  // --- the pane (right) ------------------------------------------------------------------------------------------
  let right: ReactNode = null;
  if (tab === 'plans') {
    right = selectedPlan ? (
      <PlanSummaryPane
        key={selectedPlan.id}
        plan={selectedPlan}
        history={selectedPlan.id === plan?.id ? plan.history : undefined}
        canWrite={canWrite}
        busy={busy}
        onOpen={() => openPlan(selectedPlan.id)}
        onMakeCurrent={() => makeCurrent(selectedPlan.id)}
        onReadAgain={() => askReadAgain(selectedPlan.id)}
        onRemove={() => setRemoveId(selectedPlan.id)}
      />
    ) : list.length ? (
      <EmptyState title="Pick a plan">See where it stands and open it. Move with j and k; Enter opens it.</EmptyState>
    ) : null;
  } else if (plan && tab === 'original') {
    right = original.data ? (
      <PlanOriginalPane original={original.data} passage={selectedPassage} onOpenItem={openItem} />
    ) : notRead ? null : original.isError ? (
      <EmptyState title="The original could not be loaded">{errorMessage(original.error)}</EmptyState>
    ) : null;
  } else if (plan) {
    right = selectedItem ? (
      <PlanItemPane
        key={selectedItem.id}
        item={selectedItem}
        byId={byId}
        canWrite={canWrite}
        busy={busy}
        onStatus={setStatus}
        onEdit={() => setEditOpen(true)}
        onTodo={() => setTodoOpen(true)}
        onShowOriginal={(i) => showOriginal(selectedItem.id, i)}
        onSelect={(id) => select(id)}
        onMarkSame={markSame}
      />
    ) : items.length ? (
      <EmptyState title="Pick an item">{tab === 'checklist' ? 'Mark it done, skipped or not applying. ' : ''}Move with j and k; Enter shows where the plan says it.</EmptyState>
    ) : null;
  }

  const counts: Record<PlanTab, number | undefined> = {
    framework: plan ? items.length : undefined,
    checklist: plan ? checklistAll.filter((i) => i.status === 'open').length : undefined,
    timeline: plan ? items.filter((i) => timelineGroup(i) !== null).length : undefined,
    original: original.data ? original.data.passages.length : undefined,
    plans: list.length,
  };
  const nothingYet = plans.isSuccess && list.length === 0;
  const clearFilters = () => {
    setQLocal('');
    setSearch({ q: undefined, kind: undefined, who: undefined, show: undefined, id: undefined });
  };
  const header = (
    <PageHeader
      title="Plan"
      meta={
        plan ? (
          <span>
            {plan.title}
            {plan.status !== 'current' ? <span className="muted"> ({PLAN_STATUS_WORDS[plan.status]})</span> : null}
            {plan.reading?.state === 'done' ? <span className="mono"> · {plan.progressWords}</span> : null}
          </span>
        ) : null
      }
      intro={INTRO}
      actions={
        canWrite
          ? {
              primary: { label: 'Add a plan', onClick: chooseFile, shortcut: 'u', disabled: m.upload.isPending, title: 'A PDF, a Word file, a text file or a photo of the plan. You can also drop it on this page.' },
              more: [
                { label: 'Use a document already added…', onClick: () => setFromDocOpen(true), title: 'Read a document that is already in Documents as the plan' },
                plan ? { label: 'Read it again…', onClick: () => askReadAgain(plan.id), shortcut: 'r', title: 'Shows the cost first. Your checklist is kept.' } : null,
                plan && plan.status !== 'current' && plan.reading?.state === 'done' ? { label: 'Make this the current plan', onClick: () => makeCurrent(plan.id) } : null,
                plan ? { label: 'Rename the plan…', onClick: () => setRenameOpen(true) } : null,
                plan?.documentId ? { label: 'Open the plan document', onClick: () => void navigate({ to: '/documents/$id', params: { id: plan.documentId! } }) } : null,
                plan ? 'separator' : null,
                plan ? { label: 'Remove this plan…', onClick: () => setRemoveId(plan.id), danger: true, title: 'Hidden, not erased. Its document stays in Documents.' } : null,
              ],
            }
          : undefined
      }
    />
  );

  return (
    <div
      className={`page plan-page${dropping ? ' dropping' : ''}`}
      data-own-drop
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {header}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) uploadFile(f);
        }}
      />
      {plans.isPending ? (
        <Loading>Loading your plans…</Loading>
      ) : plans.isError ? (
        <Loading>Could not load your plans: {errorMessage(plans.error)}</Loading>
      ) : nothingYet ? (
        <div className="page-body">
          <EmptyState
            title="No plan yet"
            action={
              canWrite ? (
                <div className="row wrap">
                  <Button variant="primary" onClick={chooseFile} shortcut="u" disabled={m.upload.isPending}>
                    {m.upload.isPending ? 'Adding…' : 'Add a plan'}
                  </Button>
                  <Button onClick={() => setFromDocOpen(true)}>Use a document already added</Button>
                </div>
              ) : null
            }
          >
            {canWrite ? DROP_WORDS : 'The owner or an editor adds the plan.'} Claude reads it into an outline, a checklist and a timeline; the cost shows while it reads.
          </EmptyState>
          {canWrite ? <div className="plan-drop">{DROP_WORDS}</div> : null}
        </div>
      ) : (
        <>
          <Toolbar label="Tabs and filters">
            <Segmented label="Show" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t, label: TAB_WORDS[t], count: counts[t], title: TAB_INTRO[t] }))} />
            {tab !== 'plans' ? <SearchField label="Find" placeholder={tab === 'original' ? 'Item or quote' : 'Words in an item'} value={qLocal} onChange={setQLocal} width={180} /> : null}
            {tab === 'checklist' ? (
              <Segmented label="Items" value={show} onChange={(v) => setSearch({ show: v === 'open' ? undefined : v, id: undefined })} options={CHECK_VIEWS.map((v) => ({ value: v, label: CHECK_VIEW_WORDS[v] }))} />
            ) : null}
            {tab === 'framework' ? (
              <FilterGroup label="Kind">
                <Select aria-label="Kind" value={search.kind ?? ''} placeholder="Any" options={PLAN_ITEM_KINDS.filter((k) => items.some((i) => i.kind === k)).map((k) => ({ value: k, label: PLAN_KIND_WORDS[k] }))} onChange={(e) => setSearch({ kind: (e.target.value || undefined) as PlanSearch['kind'], id: undefined })} />
              </FilterGroup>
            ) : null}
            {ITEM_TABS.has(tab) && owners.length ? (
              <FilterGroup label="Who">
                <Select aria-label="Who" value={who ?? ''} placeholder="Anyone" options={owners} onChange={(e) => setSearch({ who: e.target.value || undefined, id: undefined })} />
              </FilterGroup>
            ) : null}
            <ToolbarKeys
              items={[
                ['j/k', 'move'],
                ['enter', tab === 'plans' ? 'open it' : tab === 'original' ? 'open in Documents' : 'show in the original'],
                ['esc', 'clear'],
                ['v v', 'next tab'],
                canWrite && ITEM_TABS.has(tab) ? ([STATUS_KEYS.done, 'done'] as const) : null,
                canWrite && ITEM_TABS.has(tab) ? ([STATUS_KEYS.skipped, 'skipped'] as const) : null,
                canWrite && ITEM_TABS.has(tab) ? ([STATUS_KEYS.not_applicable, "doesn't apply"] as const) : null,
                canWrite && ITEM_TABS.has(tab) ? (['e', 'change'] as const) : null,
                canWrite && ITEM_TABS.has(tab) ? (['t', 'to-do'] as const) : null,
                canWrite ? (['u', 'add a plan'] as const) : null,
              ]}
            >
              {filtered ? (
                <Button size="sm" variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </ToolbarKeys>
          </Toolbar>
          {tab !== 'plans' ? planLine() : null}
          <div className="page-body flush">
            <SplitView storageKey="plan" defaultLeft={56} minLeft={420} minRight={420} left={left} right={right} />
          </div>
        </>
      )}

      <EditItemDialog
        open={editOpen && Boolean(selectedItem)}
        item={selectedItem}
        busy={m.updateItem.isPending}
        error={formError}
        onClose={() => {
          setEditOpen(false);
          setFormError(null);
        }}
        onSave={(patch) => {
          const it = latest.current.selectedItem;
          if (!it) return;
          if (!Object.keys(patch).length) {
            setEditOpen(false);
            return;
          }
          m.updateItem.mutate(
            { id: it.id, patch },
            {
              onSuccess: () => {
                setEditOpen(false);
                setFormError(null);
                toast('Saved. The plan’s own words are kept beside yours.', 'ok');
              },
              onError: (err) => setFormError(errorMessage(err)),
            },
          );
        }}
      />
      <TodoDialog
        open={todoOpen && Boolean(selectedItem)}
        item={selectedItem}
        planTitle={plan?.title ?? ''}
        busy={m.makeTodo.isPending}
        error={formError}
        onClose={() => {
          setTodoOpen(false);
          setFormError(null);
        }}
        onCreate={(input) => {
          const it = latest.current.selectedItem;
          if (!it) return;
          m.makeTodo.mutate(
            { id: it.id, input },
            {
              onSuccess: () => {
                setTodoOpen(false);
                setFormError(null);
                toast('To-do added, linked to this item', 'ok');
              },
              onError: (err) => setFormError(errorMessage(err)),
            },
          );
        }}
      />
      <FromDocumentDialog
        open={fromDocOpen}
        busy={m.fromDocument.isPending}
        error={formError}
        onClose={() => {
          setFromDocOpen(false);
          setFormError(null);
        }}
        onPick={fromDocument}
      />
      <RenameDialog
        open={renameOpen && Boolean(plan)}
        title={plan?.title ?? ''}
        asWritten={plan?.asWrittenTitle ?? null}
        busy={m.rename.isPending}
        onClose={() => setRenameOpen(false)}
        onSave={(title) => {
          if (!plan) return;
          m.rename.mutate(
            { id: plan.id, title },
            {
              onSuccess: () => {
                setRenameOpen(false);
                toast('Renamed', 'ok');
              },
              onError: fail,
            },
          );
        }}
      />
      <Confirm
        open={Boolean(readAsk)}
        onClose={() => setReadAsk(null)}
        title="Read the plan again?"
        body={
          readAsk ? (
            <span className="muted">
              About {usd(readAsk.estimate.estimateUsd)} ({readAsk.estimate.calls} call{readAsk.estimate.calls === 1 ? '' : 's'} to Claude, {readAsk.estimate.pages} page{readAsk.estimate.pages === 1 ? '' : 's'}). Your checklist is kept: if anything on it was marked or changed, the new reading becomes a new plan and this one is kept.
            </span>
          ) : null
        }
        confirmLabel="Read it"
        onConfirm={() => readAsk && readNow(readAsk.planId, true)}
      />
      <Confirm
        open={Boolean(removeId)}
        onClose={() => setRemoveId(null)}
        title="Remove this plan?"
        body={<span className="muted">{list.find((p) => p.id === removeId)?.title ?? ''}. It is hidden, not erased. Its document stays in Documents.</span>}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const id = removeId;
          if (!id) return;
          m.remove.mutate(id, {
            onSuccess: (r) => {
              toast(r.nowCurrent ? 'Plan removed. The plan before it is current again.' : 'Plan removed. Its document stays in Documents.', 'ok');
              setSearch({ plan: undefined, id: undefined }, false);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}

function RenameDialog({ open, title, asWritten, busy, onClose, onSave }: { open: boolean; title: string; asWritten: string | null; busy: boolean; onClose: () => void; onSave: (title: string) => void }) {
  const [text, setText] = useState(title);
  useEffect(() => {
    if (open) setText(title);
  }, [open, title]);
  const save = () => {
    if (text.trim() && !busy) onSave(text.trim());
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename the plan"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim() || busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      >
        <Field label="Name" hint={asWritten ? `As written: “${asWritten}”` : 'The plan’s own title is kept beside the name you give it.'}>
          <Input data-autofocus value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Dialog>
  );
}
