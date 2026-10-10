/**
 * /reconcile — Reconciliation: the one place that needs you.
 *
 * Every lab value, scan, vital sign, procedure and event is compared with the
 * clinical records automatically (services/reconcile.ts). Four lists, chosen
 * under Show:, each with one plain line under the toolbar saying what it holds:
 *   needs       events whose documents disagree with no clinical record to
 *               settle them: upload the record (or use one already here) and
 *               every mention is settled at once
 *   inaccurate  every bit of information that disagrees with a record, in red,
 *               beside what the record says, with the answers that apply
 *   settled     events a record settles, naming the documents that differ
 *   unbacked    events with nothing to compare with yet (information only)
 * Split view: the list left, the selected item right. The tab, the search,
 * the page and the selection live in the URL.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { dateSortKey } from '@shared/dates';
import type { InaccurateItem, ReconcileEvent, ReconcileState } from '@shared/reconcile';
import { fetchReconcileEvent, useInaccurate, useReconcileCounts, useReconcileEvent, useReconcileEvents, useReconcileMutations } from '../api/reconcile';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { dialogOpen } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { Tag } from '../ui/StatusTag';
import { useToast } from '../ui/Toast';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { EventDetail, InaccurateDetail, TYPE_WORDS, UploadProgress, mentionShort, mentionWords, type UploadedRecord } from '../features/reconcile/ReconcileViews';
import { eventDate, inaccurateActions, offersRecordActions, recordsDisagree, tabForState } from '../features/reconcile/logic';
import { ToolbarKeys } from '../ui/Toolbar';
import { MedsTab, NotesStage, StageSwitch } from '../features/notes/ReconcileStages';
import { useNotesCounts } from '../api/notes';
import '../features/reconcile/reconcile.css';

const TABS = ['needs', 'inaccurate', 'settled', 'unbacked'] as const;
type Tab = (typeof TABS)[number];
const TAB_STATE: Record<Exclude<Tab, 'inaccurate'>, ReconcileState> = { needs: 'needs_source', settled: 'settled', unbacked: 'unbacked' };
/** The same words as the check tags and the Guide (How CaseFile works). */
const TAB_WORDS: Record<Tab, string> = { needs: 'Needs a source', inaccurate: 'Inaccurate', settled: 'Settled', unbacked: 'Not backed yet' };
const TAB_KEYS: Record<Tab, string> = { needs: 'v n', inaccurate: 'v i', settled: 'v s', unbacked: 'v u' };
/** What each list holds, in one sentence under the toolbar. */
const TAB_INTRO: Record<Tab, string> = {
  needs: 'Your documents disagree about these, and no clinical record settles them yet. Add the record (the lab report, procedure note or scan report) and every mention is compared with it at once.',
  inaccurate: 'Each of these details disagrees with a clinical record. The record’s value is the one used and the document stays as written; nothing is needed unless you know the record is wrong.',
  settled: 'A clinical record (or your own answer) decides each of these. Mentions that match it are accurate; any that differ are listed under Inaccurate. Open one to see which documents agree and which differ.',
  unbacked: 'No clinical record mentions these yet, so nothing could be compared. Nothing is needed; adding the record will check them.',
};
const PAGE_SIZE = 50;

const searchSchema = z.object({
  /** Records vs records (default) or Records vs my notes (My notes, 2026-10-09: features/notes/ReconcileStages.tsx). */
  stage: z.enum(['records', 'notes']).optional().catch(undefined),
  /** 'meds': the medication timeline under Records vs records. */
  tab: z.enum([...TABS, 'meds']).optional().catch(undefined),
  /** Records vs my notes: to answer (default), waiting on the records, answered. */
  list: z.enum(['answer', 'waiting', 'answered']).optional().catch(undefined),
  /** The selected event key (event tabs) or detail id (inaccurate). */
  id: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type ReconcileSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/reconcile')({
  validateSearch: (s: Record<string, unknown>): ReconcileSearch => searchSchema.parse(s),
  component: ReconcilePage,
});

const INTRO = 'Every lab value, scan, procedure and event is checked against your clinical records automatically. Only what may need you is listed here.';

/**
 * An event's date in the list: the date in the mono, with a qualifier other than "on" ("around", "in") as a small
 * word before it, so the column stays narrow ("on 2024-03-18" is just the date). The whole label on hover.
 */
function WhenCell({ label }: { label: string }) {
  const m = /^(on|around|in|before|after|by)\s+(.+)$/.exec(label.trim());
  if (!m) return <span className="mono">{label}</span>;
  return (
    <span title={label}>
      {m[1] === 'on' ? null : <span className="rc-when-q">{m[1]} </span>}
      <span className="mono">{m[2]}</span>
    </span>
  );
}

/** Medications (the medication timeline), listed after the four lists under Show. */
const MEDS_WORDS = 'Medications';
const MEDS_INTRO = "Each drug's start, stop and doses as every record and every note of yours gives them, where two records disagree.";

/** The two stages (My notes, 2026-10-09): Records vs records keeps the four lists and adds Medications. */
function ReconcilePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const counts = useReconcileCounts();
  const notes = useNotesCounts();
  if (search.stage === 'notes') return <NotesStage search={search} />;
  if (search.tab === 'meds') {
    const c = counts.data;
    const n: Record<Tab, number | undefined> = { needs: c?.needsSource, inaccurate: c?.inaccurate, settled: c?.settled, unbacked: c?.unbacked };
    return (
      <MedsTab
        search={search}
        recordsTabs={[...TABS.map((t) => ({ value: t as string, label: TAB_WORDS[t], count: n[t] ?? undefined, title: TAB_INTRO[t] })), { value: 'meds', label: MEDS_WORDS, count: notes.data?.medsOpen, title: MEDS_INTRO }]}
        onRecordsTab={(t) => void navigate({ search: () => (t === 'needs' ? {} : { tab: t as Tab }) })}
      />
    );
  }
  return <RecordsStage />;
}

function RecordsStage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = useMe().canWrite;
  const tab: Tab = search.tab && search.tab !== 'meds' ? search.tab : 'needs';
  const notesCounts = useNotesCounts();
  const page = search.page ?? 1;
  const selectedId = search.id ?? null;
  const paging = useMemo(() => ({ q: search.q || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }), [search.q, page]);
  const counts = useReconcileCounts();
  const isEvents = tab !== 'inaccurate';
  const events = useReconcileEvents(isEvents ? TAB_STATE[tab] : 'needs_source', paging, isEvents);
  const inaccurate = useInaccurate(paging, !isEvents);
  const rc = useReconcileMutations();
  const [uploads, setUploads] = useState<UploadedRecord[]>([]);
  const [asking, setAsking] = useState(false);

  const eventItems = isEvents ? (events.data?.items ?? []) : [];
  const inaccurateItems = !isEvents ? (inaccurate.data?.items ?? []) : [];
  const total = (isEvents ? events.data?.total : inaccurate.data?.total) ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listed = isEvents ? eventItems.find((e) => e.key === selectedId) ?? null : null;
  // A link to an event not on this page (from a detail's "See Reconciliation") loads it on its own.
  const single = useReconcileEvent(isEvents && selectedId && events.isSuccess && !events.isPlaceholderData && !listed ? selectedId : null);
  const selectedEvent: ReconcileEvent | null = listed ?? (isEvents ? (single.data ?? null) : null);
  const selectedItem: InaccurateItem | null = !isEvents ? (inaccurateItems.find((i) => i.factId === selectedId) ?? null) : null;

  // The counts are polled; when they move, the lists are fetched again.
  const countsKey = counts.data ? `${counts.data.needsSource}|${counts.data.inaccurate}|${counts.data.settled}|${counts.data.unbacked}` : '';
  const lastCounts = useRef(countsKey);
  useEffect(() => {
    if (lastCounts.current && countsKey && countsKey !== lastCounts.current) {
      void qc.invalidateQueries({ queryKey: ['reconcile', 'events'] });
      void qc.invalidateQueries({ queryKey: ['reconcile', 'event'] });
      void qc.invalidateQueries({ queryKey: ['reconcile', 'inaccurate'] });
    }
    lastCounts.current = countsKey;
  }, [countsKey, qc]);
  useEffect(() => setAsking(false), [selectedId, tab]);

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q, page: undefined, id: undefined }), replace: true }));

  function setSearch(patch: Partial<ReconcileSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function setTab(t: Tab | 'meds') {
    setSearch({ tab: t === 'needs' ? undefined : t, id: undefined, page: undefined }, false);
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function goPage(p: number) {
    const next = Math.min(Math.max(1, p), latest.current.pages);
    if (next !== latest.current.page) setSearch({ page: next === 1 ? undefined : next, id: undefined });
  }
  function openMention(m: { documentId: string | null; page: number | null; citationId: string | null } | null | undefined) {
    if (!m?.documentId) {
      toast('This one has no document page.');
      return;
    }
    void navigate({ to: '/documents/$id', params: { id: m.documentId }, search: { page: m.page ?? undefined, cite: m.citationId ?? undefined } });
  }
  function openEvent(e: ReconcileEvent) {
    openMention(e.record ?? e.groups[0]?.mentions[0] ?? null);
  }
  function runAll() {
    rc.run.mutate(undefined, {
      onSuccess: (c) => toast(`Checked again: ${c.needsSource} need a source, ${c.inaccurate} inaccurate, ${c.settled} settled`, 'ok'),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not check again', 'bad'),
    });
  }
  function addUpload(u: UploadedRecord) {
    setUploads((list) => [u, ...list.filter((x) => x.documentId !== u.documentId)]);
  }
  /** See the whole event: read it now and open the tab its state is listed on (needs a source, settled, not backed yet). */
  function showEvent(key: string) {
    fetchReconcileEvent(qc, key).then(
      (ev) => {
        if (!ev) {
          toast('That event is not listed any more (it may have been settled or changed).');
          return;
        }
        const t = tabForState(ev.state);
        setSearch({ tab: t === 'needs' ? undefined : t, id: ev.key, page: undefined, q: undefined }, false);
      },
      (err) => toast(err instanceof Error ? err.message : 'Could not open the event', 'bad'),
    );
  }

  const latest = useRef({ tab, page, pages, selectedEvent, selectedItem, canWrite, busy: rc.busy });
  latest.current = { tab, page, pages, selectedEvent, selectedItem, canWrite, busy: rc.busy };
  const onInaccurate = () => latest.current.tab === 'inaccurate' && Boolean(latest.current.selectedItem) && latest.current.canWrite && !latest.current.busy && !dialogOpen();
  // A key works only where its button shows (features/reconcile/logic.ts inaccurateActions).
  const can = (a: 'keep' | 'separate' | 'wrong') => () => onInaccurate() && inaccurateActions(latest.current.selectedItem!)[a];
  // u and p only where the event's pane offers Upload the record (never where a record is already here).
  const onSourceEvent = () => {
    const ev = latest.current.selectedEvent;
    return latest.current.tab !== 'inaccurate' && latest.current.tab !== 'settled' && Boolean(ev) && offersRecordActions(ev!) && latest.current.canWrite && !dialogOpen();
  };
  const keep = () => {
    const it = latest.current.selectedItem;
    if (it) rc.keep.mutate(it.factId, { onSuccess: () => toast('Kept as accurate. It is no longer listed here.', 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'That did not work', 'bad') });
  };
  const separate = () => {
    const it = latest.current.selectedItem;
    if (it) rc.separate.mutate(it.factId, { onSuccess: () => toast('Marked as another occasion. It is compared on its own date only from now on.', 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'That did not work', 'bad') });
  };

  useBindings(
    [
      { keys: 'v v', description: 'Next list: needs a source, inaccurate, settled, not backed yet', group: 'Lists', run: () => !dialogOpen() && setTab(TABS[(TABS.indexOf(latest.current.tab) + 1) % TABS.length]) },
      ...TABS.map((t) => ({ keys: TAB_KEYS[t], description: `Show ${TAB_WORDS[t].toLowerCase()}`, group: 'Lists', run: () => !dialogOpen() && setTab(t) })),
      { keys: 'v m', description: 'Show medications (where records disagree on a drug)', group: 'Lists', run: () => !dialogOpen() && setTab('meds') },
      { keys: ']', description: 'Next page of the list', group: 'Lists', when: () => latest.current.page < latest.current.pages && !dialogOpen(), run: () => goPage(latest.current.page + 1) },
      { keys: '[', description: 'Previous page of the list', group: 'Lists', when: () => latest.current.page > 1 && !dialogOpen(), run: () => goPage(latest.current.page - 1) },
      { keys: 'u', description: 'Upload the record for the selected event', group: 'Page', when: onSourceEvent, run: () => document.querySelector<HTMLInputElement>('[data-rc-upload]')?.click() },
      { keys: 'p', description: 'Pick a document already in the case as the record', group: 'Page', when: onSourceEvent, run: () => document.querySelector<HTMLSelectElement>('[data-rc-pick]')?.focus() },
      { keys: 'a', description: "The selected detail is actually right", group: 'Page', when: can('keep'), run: keep },
      { keys: 'x', description: 'The selected detail is about another occasion (not the same event)', group: 'Page', when: can('separate'), run: separate },
      { keys: 'w', description: 'The record is wrong (asks for your reason)', group: 'Page', when: can('wrong'), run: () => setAsking((v) => !v) },
    ],
    [],
  );

  useRegisterCommands(
    [
      ...TABS.map((t) => ({ id: `reconcile.${t}`, title: `Reconciliation: ${TAB_WORDS[t].toLowerCase()}`, group: 'Reconciliation', keywords: 'reconcile discrepancies disagree source record wrong inaccurate', shortcut: TAB_KEYS[t], run: () => setTab(t) })),
      { id: 'reconcile.meds', title: 'Reconciliation: medications (each drug by source)', group: 'Reconciliation', keywords: 'reconcile medication drug timeline start stop dose', shortcut: 'v m', run: () => setTab('meds') },
      { id: 'reconcile.run', title: 'Reconciliation: check everything again', group: 'Reconciliation', keywords: 'reconcile run pass compare records', when: () => latest.current.canWrite, run: runAll },
      { id: 'reconcile.upload', title: 'Reconciliation: upload the record for the selected event', group: 'Reconciliation', shortcut: 'u', when: onSourceEvent, run: () => document.querySelector<HTMLInputElement>('[data-rc-upload]')?.click() },
      { id: 'reconcile.keep', title: "Reconciliation: the selected detail is actually right", group: 'Reconciliation', shortcut: 'a', when: can('keep'), run: keep },
      { id: 'reconcile.separate', title: 'Reconciliation: the selected detail is not the same event', group: 'Reconciliation', shortcut: 'x', when: can('separate'), run: separate },
      { id: 'reconcile.wrong', title: 'Reconciliation: the record is wrong (asks for your reason)', group: 'Reconciliation', shortcut: 'w', when: can('wrong'), run: () => setAsking((v) => !v) },
    ],
    [],
  );

  // Widths that fit the pane at 1280px (619px) with nothing cut or out of view: When ~150, What (takes the room),
  // Kind 90, Mentions ~135; on Settled, "Settled by" (the record's name and date) shares the room with What and wraps
  // to two lines, and the kind follows the subject ("CSF protein · lab value"), so the five facts fit where four did.
  const eventColumns = useMemo<ColumnDef<ReconcileEvent, unknown>[]>(
    () => [
      { id: 'when', header: 'When', accessorFn: (e) => dateSortKey(eventDate(e.key)), cell: ({ row }) => <WhenCell label={row.original.dateLabel} />, meta: { width: 104, maxWidth: 150, shrink: false } },
      {
        id: 'what',
        header: 'What',
        accessorKey: 'subject',
        cell: ({ row }) => {
          const e = row.original;
          // "records disagree" is a short tag before the subject: the clamp cuts the subject, never the tag.
          const disagree = e.state === 'needs_source' && recordsDisagree(e);
          return (
            <span className="rc-subject">
              {disagree ? <Tag tone="warn" title="Two clinical records disagree">records disagree</Tag> : null}
              {e.subject}
              {tab === 'settled' ? <span className="rc-subject-kind"> · {TYPE_WORDS[e.type] ?? e.type}</span> : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: tab === 'settled' ? 140 : 200 },
      },
      ...(tab === 'settled'
        ? [
            {
              id: 'record',
              header: 'Settled by',
              accessorFn: (e: ReconcileEvent) => e.record?.documentTitle ?? '',
              cell: ({ getValue }: { getValue: () => unknown }) => <span className="muted">{String(getValue()) ? <KeepDatesWhole text={String(getValue())} /> : '—'}</span>,
              // Shares the room with What (both grow), so the record's name wraps to two lines and is never cut.
              meta: { grow: true, minWidth: 150 },
            } as ColumnDef<ReconcileEvent, unknown>,
          ]
        : [{ id: 'type', header: 'Kind', accessorFn: (e: ReconcileEvent) => TYPE_WORDS[e.type] ?? e.type, cell: ({ getValue }: { getValue: () => unknown }) => <span className="muted">{String(getValue())}</span>, meta: { width: 90 } } as ColumnDef<ReconcileEvent, unknown>]),
      {
        // One short column ("12 in 4 documents"); the versions and the full words are in the hover and the detail pane.
        id: 'mentions',
        header: 'Mentions',
        accessorFn: (e) => e.mentionCount,
        cell: ({ row }) => {
          const e = row.original;
          const full = mentionWords(e.mentionCount, e.documentCount);
          const versions = tab === 'needs' && e.groups.length ? `\n${e.groups.length} version${e.groups.length === 1 ? '' : 's'}:\n${e.groups.map((g) => `${g.says}: ${g.mentions.length}`).join('\n')}` : '';
          return <span title={`${full}${versions}`}>{mentionShort(e.mentionCount, e.documentCount)}</span>;
        },
        meta: { width: 120, shrink: false },
      },
    ],
    [tab],
  );

  const inaccurateColumns = useMemo<ColumnDef<InaccurateItem, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (r) => (r.date ? dateSortKey(r.date) : undefined), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />, meta: { width: 96 } },
      { id: 'what', header: 'What', accessorFn: (r) => r.event.subject, cell: ({ row }) => row.original.event.subject, meta: { width: 110, maxWidth: 150, wrap: true, shrink: false } },
      // The document that says it: the name the three "Lumbar puncture" rows differ by.
      { id: 'document', header: 'In the document', accessorFn: (r) => r.documentTitle ?? '', cell: ({ row }) => (row.original.documentTitle ? <KeepDatesWhole text={row.original.documentTitle} /> : <span className="muted">entered by hand</span>), meta: { grow: true, minWidth: 160 } },
      { id: 'says', header: 'It says', accessorFn: (r) => r.says, cell: ({ getValue }) => <span className="rc-cell-says wrong">{String(getValue())}</span>, meta: { width: 100, maxWidth: 130, wrap: true, shrink: false } },
      {
        id: 'record',
        // "Record says", not "The record says": the shorter header leaves the document's name the room for two lines.
        header: 'Record says',
        accessorFn: (r) => r.record?.says ?? '',
        cell: ({ row }) => {
          const words = row.original.record?.says ?? (row.original.trust.byUser ? 'you marked it wrong' : '—');
          return <span className="rc-cell-says">{words}</span>;
        },
        meta: { width: 100, maxWidth: 130, wrap: true, shrink: false },
      },
    ],
    [],
  );

  const selectedActs = selectedItem ? inaccurateActions(selectedItem) : null;
  const c = counts.data;
  const tabCount: Record<Tab, number | undefined> = { needs: c?.needsSource, inaccurate: c?.inaccurate, settled: c?.settled, unbacked: c?.unbacked };
  const active = isEvents ? events : inaccurate;
  // A page past the end (its last item was just answered, or the list shrank): go to the last page there is, so the
  // list and its paging come back instead of an empty page.
  useEffect(() => {
    if (active.isSuccess && !active.isPlaceholderData && page > pages) setSearch({ page: pages === 1 ? undefined : pages, id: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, active.isSuccess, active.isPlaceholderData]);
  const filtered = Boolean(search.q);
  const emptyWords: Record<Tab, string> = {
    needs: filtered ? 'Nothing that needs a source matches this search.' : 'Nothing needs a source: no two documents disagree without a clinical record to settle it.',
    inaccurate: filtered ? 'Nothing inaccurate matches this search.' : 'Nothing inaccurate: every detail that can be compared agrees with its clinical record.',
    settled: filtered ? 'No settled event matches this search.' : 'No events settled by a clinical record yet. Upload the record from Needs a source, or set a lab report, procedure note or scan report to "Clinical record" on its page.',
    unbacked: filtered ? 'Nothing matches this search.' : 'Nothing waiting for a record.',
  };
  // The all-clear only when the list is truly empty; an empty page of a non-empty list is on its way to the last page.
  const emptyText = total === 0 ? emptyWords[tab] : 'Loading…';
  // The table counts its rows; with several pages, how many there are in all.
  const footer = pages > 1 ? <span>{total} in all · page {page} of {pages}</span> : undefined;

  const left = active.isPending ? (
    <Loading />
  ) : active.isError ? (
    <Loading>Could not load this list: {active.error instanceof Error ? active.error.message : 'error'}</Loading>
  ) : isEvents ? (
    <DataTable key={tab} columns={eventColumns} data={eventItems} rowId={(e) => e.key} selectedId={selectedId} onSelect={(e) => select(e?.key ?? null)} onOpen={openEvent} initialSort={[{ id: 'when', desc: true }]} emptyText={emptyText} footer={footer} tableId={`reconcile.${tab}`} autoFocus />
  ) : (
    <DataTable key="inaccurate" columns={inaccurateColumns} data={inaccurateItems} rowId={(r) => r.factId} selectedId={selectedId} onSelect={(r) => select(r?.factId ?? null)} onOpen={(r) => openMention(r)} initialSort={[{ id: 'date', desc: true }]} rowClassName={() => 'inaccurate-row'} emptyText={emptyText} footer={footer} tableId="reconcile.inaccurate" autoFocus />
  );

  const right = isEvents ? (
    selectedEvent ? (
      <EventDetail key={selectedEvent.key} event={selectedEvent} onUploaded={addUpload} />
    ) : selectedId && single.isPending ? (
      <Loading />
    ) : selectedId && single.isError ? (
      <EmptyState title="That event is not listed any more">It may have been settled or changed. Pick one from the list.</EmptyState>
    ) : eventItems.length ? (
      <EmptyState title={tab === 'needs' ? 'Pick an event' : 'Pick an event to see its mentions'}>
        {tab === 'needs' ? 'See what each document says, and add the record that settles it. Move with j and k; Enter opens the first page.' : 'See what each document says about it. Move with j and k; Enter opens the record’s page.'}
      </EmptyState>
    ) : null
  ) : selectedItem ? (
    <InaccurateDetail key={selectedItem.factId} item={selectedItem} asking={asking} setAsking={setAsking} onShowEvent={selectedItem.event.key ? () => showEvent(selectedItem.event.key) : undefined} />
  ) : inaccurateItems.length ? (
    <EmptyState title="Pick a detail">See it beside what the clinical record says, and answer if you know better. Move with j and k; Enter opens its page.</EmptyState>
  ) : null;

  return (
    <div className="page">
      <PageHeader
        title="Reconciliation"
        intro={INTRO}
        actions={canWrite ? { more: [{ label: rc.run.isPending ? 'Checking…' : 'Check everything again', onClick: runAll, disabled: rc.run.isPending, title: 'Compare every detail with the clinical records again. This happens by itself after every import and every unlock.' }] } : undefined}
      />
      {uploads.length ? (
        <div className="rc-uploads">
          {uploads.map((u) => (
            <UploadProgress key={u.documentId} u={u} onDismiss={() => setUploads((list) => list.filter((x) => x.documentId !== u.documentId))} />
          ))}
        </div>
      ) : null}
      <Toolbar label="Lists and search">
        <StageSwitch stage="records" />
        <Segmented<Tab | 'meds'>
          label="Show"
          value={tab}
          onChange={setTab}
          options={[...TABS.map((t) => ({ value: t, label: TAB_WORDS[t], count: tabCount[t] ?? undefined, title: TAB_INTRO[t] })), { value: 'meds' as const, label: MEDS_WORDS, count: notesCounts.data?.medsOpen, title: MEDS_INTRO }]}
        />
        <SearchField label="Find" placeholder="Test, event or document" value={qLocal} onChange={setQLocal} width={220} />
        {pages > 1 ? (
          <FilterGroup label="Page">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => goPage(page - 1)}>
              Previous
            </Button>
            <span className="mono small">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => goPage(page + 1)}>
              Next
            </Button>
          </FilterGroup>
        ) : null}
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['enter', 'open the page'],
            ['esc', 'clear'],
            ['v v', 'next list'],
            ['1/2', 'stage'],
            pages > 1 ? ['[/]', 'page'] : null,
            ...(tab === 'inaccurate'
              ? canWrite && selectedActs
                ? [selectedActs.keep ? (['a', 'actually right'] as const) : null, selectedActs.separate ? (['x', 'not the same event'] as const) : null, selectedActs.wrong ? (['w', 'the record is wrong'] as const) : null]
                : []
              : tab !== 'settled' && canWrite && (!selectedEvent || offersRecordActions(selectedEvent))
                ? [['u', 'upload the record'] as const, ['p', 'pick a document'] as const]
                : []),
          ]}
        />
      </Toolbar>
      <p className={`rc-tab-intro${tab === 'inaccurate' && (tabCount.inaccurate ?? 0) > 0 ? ' bad' : tab === 'needs' && (tabCount.needs ?? 0) > 0 ? ' warn' : ''}`}>
        <strong>{TAB_WORDS[tab]}.</strong> {TAB_INTRO[tab]}
      </p>
      <div className="page-body flush">
        <SplitView storageKey="reconcile" defaultLeft={typeof window !== 'undefined' && window.innerWidth < 1400 ? 60 : 56} minLeft={460} minRight={440} left={left} right={right} />
      </div>
    </div>
  );
}
