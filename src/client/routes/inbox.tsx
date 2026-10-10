/**
 * /inbox — Check before filing (was "Unsorted uploads"): "I have a document and I want to see where it goes before it
 * is filed." Add it here (files added anywhere else go straight to Documents), Claude suggests where it belongs, one
 * key files it. Split view: the uploads on the left, the suggestion and the form on the right. Selection and the view
 * live in the URL. The page's name is features/inbox/words.ts INBOX_NAME (the menu entry is in app/nav.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useFailToast } from '../api/client';
import { useSettings } from '../api/hooks';
import {
  canFileItem,
  canSkipItem,
  isReading,
  isWaiting,
  useEncountersLite,
  useInbox,
  useInboxCount,
  useInboxItem,
  useInboxMutations,
  usePasteToInbox,
  useUploadToInbox,
  type FileInboxInput,
  type InboxItem,
  type InboxUpload,
} from '../api/inbox';
import { usePeople } from '../api/people';
import { useRecords } from '../api/records';
import { useRegisterCommands } from '../app/commands';
import { isEditable, useBindings } from '../app/shortcuts';
import { dialogOpen as anyDialogOpen } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { UPLOAD_ACCEPT } from '../features/filing/Filing';
import { documentTypeLabel } from '../api/filing';
import { InboxDetail } from '../features/inbox/InboxDetail';
import { InboxDropZone } from '../features/inbox/InboxDropZone';
import { PasteDialog } from '../features/inbox/PasteDialog';
import { InboxStatusTag, inboxStatusLabel } from '../features/inbox/status';
import { pickUploadToShow, summariseUpload } from '../features/inbox/GlobalDropZone';
import { INBOX_NAME, filedParts } from '../features/inbox/words';
import { ToolbarKeys } from '../ui/Toolbar';
import { isActivatableTarget } from '../features/search/keys';
import '../features/inbox/inbox.css';
import { usePatientCheck, type HeldItem } from '../api/patient-check';
import { HeldPanel } from '../features/patient-check/HeldPanel';
import { HELD_EXPLAIN, HELD_WORDS, MINE_LABEL, NOT_MINE_LABEL, PATIENT_KEYS, heldCountWords } from '../features/patient-check/words';

/** 'patient': the documents held back as "May be someone else's record" (2026-10-09), from any upload. */
const VIEWS = ['active', 'filed', 'skipped', 'all', 'patient'] as const;
type View = (typeof VIEWS)[number];

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
});
export type InboxSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/inbox')({
  validateSearch: (s: Record<string, unknown>): InboxSearch => searchSchema.parse(s),
  component: InboxPage,
});

/** What each list holds, in one line under the toolbar. */
const VIEW_WORDS: Record<View, { lead: string; text: string }> = {
  active: { lead: 'Waiting.', text: 'Check where Claude suggests each one goes, change anything, then File it. Skip leaves it in Documents as it is; nothing is ever deleted.' },
  filed: { lead: 'Filed.', text: 'Uploads filed from here. Ask Claude again brings one back to check it again.' },
  skipped: { lead: 'Skipped.', text: 'Uploads left in Documents as they were. Ask Claude again brings one back here.' },
  all: { lead: 'All.', text: 'Everything added here, waiting, filed or skipped.' },
  patient: { lead: `${HELD_WORDS}.`, text: `The pages name someone else. ${HELD_EXPLAIN}` },
};

/** What a row is matched against by the filter box: what the ledger shows plus the document's own title and people. */
function rowText(r: InboxItem, peopleById: Map<string, { name: string }>): string {
  const t = r.triage;
  const proposedInstitution = t?.institution.match_id ? (peopleById.get(t.institution.match_id)?.name ?? null) : (t?.institution.new_name ?? null);
  return [r.filename, r.title, t?.title, t?.category?.replace(/_/g, ' '), t?.document_date, proposedInstitution, r.institutionName, r.authorName, inboxStatusLabel(r).label]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/** Rows containing every word of the filter (case-insensitive); the whole list when the filter is empty. */
function filterInbox(items: InboxItem[], filter: string, peopleById: Map<string, { name: string }>): InboxItem[] {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((r) => {
    const text = rowText(r, peopleById);
    return words.every((w) => text.includes(w));
  });
}

/** The row after `id` in `list` (or the one before it at the end), to select once `id` leaves the list. */
function neighbourIn(list: readonly InboxItem[], id: string): string | null {
  const idx = list.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  return list[idx + 1]?.id ?? list[idx - 1]?.id ?? null;
}

function filingSummary(r: InboxItem): string {
  const f = r.inbox?.filing;
  const bits = f ? filedParts(f) : [];
  return `Filed "${r.title}"${bits.length ? `: ${bits.join(', ')}` : ''}`;
}

function InboxPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const view: View = search.view ?? 'active';
  const selectedId = search.id ?? null;

  const list = useInbox(view === 'active' || view === 'patient' ? undefined : view);
  const held = usePatientCheck();
  const heldItems = useMemo(() => held.data?.items ?? [], [held.data]);
  const heldView = view === 'patient';
  const count = useInboxCount();
  const people = usePeople();
  const records = useRecords();
  const encounters = useEncountersLite();
  const settings = useSettings();
  const m = useInboxMutations();
  const upload = useUploadToInbox();
  const paste = usePasteToInbox();

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const inList = items.find((i) => i.id === selectedId) ?? null;
  const fallback = useInboxItem(selectedId, !inList && !heldView);
  const current = inList ?? (fallback.data && fallback.data.id === selectedId ? fallback.data : null);
  const aiOff = Boolean(settings.data && (!settings.data['ai.enabled'] || !settings.data['ai.apiKeySet']));

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [filter, setFilter] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  /** The detail form registers its current state here so Enter from the list files what was edited. */
  const builderRef = useRef<(() => FileInboxInput) | null>(null);
  const busy = m.file.isPending || m.retriage.isPending || m.skip.isPending;

  const peopleById = useMemo(() => new Map((people.data?.items ?? []).map((p) => [p.id, p])), [people.data]);
  /** The rows the ledger shows: the list narrowed by the filter box. */
  const shown = useMemo(() => filterInbox(items, filter, peopleById), [items, filter, peopleById]);

  function setSearch(patch: Partial<InboxSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function setView(v: View) {
    setSearch({ view: v === 'active' ? undefined : v, id: undefined }, false);
  }
  // The key bindings, palette commands and the paste listener are registered once (on mount) and keep the
  // functions of the first render, where the list is still empty. Everything they need is read from here.
  const latest = useRef({ current, items: shown, busy, pasteOpen, view });
  latest.current = { current, items: shown, busy, pasteOpen, view };
  /**
   * True while any dialog is open: the paste dialog (from the moment it is asked for) or any other
   * (a confirm, the filing or shared dialogs, the shortcut sheet). Read when a key or paste arrives,
   * so r, s, o and the rest never act on the selected item behind a dialog.
   */
  function dialogOpen(): boolean {
    return latest.current.pasteOpen || anyDialogOpen();
  }
  /** The row to select after `id` is filed or skipped, taken from the list as it is when the key is pressed. */
  function neighbourOf(id: string): string | null {
    return neighbourIn(latest.current.items, id);
  }

  /** Select what a drop or paste added: a new item, else a duplicate that is in the Inbox, else the document. */
  function showUpload(items: InboxUpload[]) {
    const first = pickUploadToShow(items);
    if (!first) return;
    setFilter(''); // a filter typed earlier would hide the new row
    setSearch({ view: undefined, id: first.id });
  }

  function uploadFiles(files: File[]) {
    if (!files.length) return;
    upload.mutate(
      { files },
      {
        // The banner at the top follows the upload until every page is stored and read (or says what is missing).
        onSuccess: (r) => showUpload(r.items),
      },
    );
  }
  function openPaste(text: string) {
    setPasteText(text);
    setPasteError(null);
    setPasteOpen(true);
  }
  function savePaste(text: string, title: string) {
    paste.mutate(
      { text, title: title.trim() || undefined },
      {
        onSuccess: (r) => {
          setPasteOpen(false);
          toast(summariseUpload(r.items), r.items.some((i) => !i.duplicate) ? 'ok' : 'info');
          showUpload(r.items);
        },
        onError: (err) => setPasteError(err instanceof Error ? err.message : String(err)),
      },
    );
  }
  /** Why the selected item cannot be filed or skipped right now, or null when it can. */
  function notActionable(cur: InboxItem, what: 'file' | 'skip'): string | null {
    if (!cur.inbox) return `This document is not waiting in ${INBOX_NAME}. Classify it to bring it here.`;
    if (isReading(cur)) return `The file is still being read; ${what} it when the text is in.`;
    if (what === 'file' && !canFileItem(cur)) return 'The file is still being read; file it when the text is in.';
    if (what === 'skip' && !canSkipItem(cur)) return 'Already skipped.';
    return null;
  }
  function fileSelected(input?: FileInboxInput) {
    const cur = latest.current.current;
    if (!cur || latest.current.busy) return;
    const why = notActionable(cur, 'file');
    if (why) {
      toast(why, 'info');
      return;
    }
    const body = input ?? builderRef.current?.() ?? { actions: cur.triage?.suggested_actions ?? [] };
    const next = neighbourOf(cur.id);
    m.file.mutate(
      { id: cur.id, input: body },
      {
        onSuccess: (r) => {
          toast(filingSummary(r), r.inbox?.filing?.warnings.length ? 'info' : 'ok');
          if (latest.current.view === 'active') select(next);
        },
        onError: fail,
      },
    );
  }
  function retriageSelected() {
    const cur = latest.current.current;
    if (!cur || latest.current.busy) return;
    m.retriage.mutate(cur.id, {
      onSuccess: () => {
        toast('Asked Claude to look at it again', 'ok');
        if (latest.current.view !== 'active' && latest.current.view !== 'all') setSearch({ view: undefined, id: cur.id });
      },
      onError: fail,
    });
  }
  function skipSelected() {
    const cur = latest.current.current;
    if (!cur || latest.current.busy) return;
    const why = notActionable(cur, 'skip');
    if (why) {
      toast(why, 'info');
      return;
    }
    const next = neighbourOf(cur.id);
    m.skip.mutate(cur.id, {
      onSuccess: () => {
        toast('Skipped; it stays in Documents', 'ok');
        if (latest.current.view === 'active') select(next);
      },
      onError: fail,
    });
  }
  function openSelected() {
    const cur = latest.current.current;
    if (cur) void navigate({ to: '/documents/$id', params: { id: cur.id } });
  }

  // Paste anywhere on the page (outside fields): files upload, text opens the paste dialog.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.defaultPrevented || isEditable(e.target) || dialogOpen()) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text.trim()) {
        e.preventDefault();
        openPaste(text);
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasSelection = () => Boolean(latest.current.current) && !dialogOpen();
  useBindings(
    [
      // Plain Enter stands aside while a button, link or tab has focus, so Tab to Skip + Enter skips (it used to file).
      {
        keys: 'enter',
        description: 'File the selected item as proposed (or as edited)',
        group: 'Page',
        when: () => hasSelection() && !isActivatableTarget(document.activeElement),
        run: () => fileSelected(),
      },
      { keys: 'ctrl+enter', description: 'File the selected item from inside a field', group: 'Page', global: true, when: hasSelection, run: () => fileSelected() },
      { keys: 'r', description: 'Ask Claude again about the selected item', group: 'Page', when: hasSelection, run: retriageSelected },
      { keys: 's', description: 'Skip the selected item (stays in Documents)', group: 'Page', when: hasSelection, run: skipSelected },
      { keys: 'o', description: 'Open the selected document', group: 'Page', when: hasSelection, run: openSelected },
      { keys: 'e', description: 'Edit the proposal (focus the title)', group: 'Page', when: hasSelection, run: () => setFocusToken((n) => n + 1) },
      { keys: 'p', description: 'Paste text as a new upload to check', group: 'Page', run: () => !dialogOpen() && openPaste('') },
      { keys: 'n', description: `Pick files to add to ${INBOX_NAME}`, group: 'Page', run: () => !dialogOpen() && fileInput.current?.click() },
      { keys: 'v v', description: 'Next list: waiting, filed, skipped, all', group: 'Lists', run: () => !dialogOpen() && setView(VIEWS[(VIEWS.indexOf(latest.current.view) + 1) % VIEWS.length]) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'inbox.file', title: `${INBOX_NAME}: file the selected upload`, group: INBOX_NAME, keywords: 'inbox unsorted uploads', shortcut: 'enter', when: hasSelection, run: () => fileSelected() },
      { id: 'inbox.retriage', title: `${INBOX_NAME}: ask Claude again about the selected upload`, group: INBOX_NAME, keywords: 'inbox unsorted re-triage retriage', shortcut: 'r', when: hasSelection, run: retriageSelected },
      { id: 'inbox.skip', title: `${INBOX_NAME}: skip the selected upload (it stays in Documents)`, group: INBOX_NAME, keywords: 'inbox unsorted', shortcut: 's', when: hasSelection, run: skipSelected },
      { id: 'inbox.open', title: `${INBOX_NAME}: open the selected document`, group: INBOX_NAME, keywords: 'inbox unsorted', shortcut: 'o', when: hasSelection, run: openSelected },
      { id: 'inbox.edit', title: `${INBOX_NAME}: edit where the selected upload goes`, group: INBOX_NAME, keywords: 'inbox unsorted title', shortcut: 'e', when: hasSelection, run: () => setFocusToken((n) => n + 1) },
      { id: 'inbox.paste', title: `${INBOX_NAME}: paste text as a document`, group: INBOX_NAME, shortcut: 'p', keywords: 'clipboard txt inbox unsorted', run: () => openPaste('') },
      { id: 'inbox.pick', title: `${INBOX_NAME}: add files`, group: INBOX_NAME, shortcut: 'n', keywords: 'upload drop inbox unsorted', run: () => fileInput.current?.click() },
      { id: 'inbox.view.active', title: `${INBOX_NAME}: show what is waiting`, group: INBOX_NAME, keywords: 'inbox unsorted', run: () => setView('active') },
      { id: 'inbox.view.filed', title: `${INBOX_NAME}: show what was filed`, group: INBOX_NAME, keywords: 'inbox unsorted', run: () => setView('filed') },
      { id: 'inbox.view.skipped', title: `${INBOX_NAME}: show what was skipped`, group: INBOX_NAME, keywords: 'inbox unsorted', run: () => setView('skipped') },
      { id: 'inbox.view.patient', title: `${INBOX_NAME}: show what may be someone else's record`, group: INBOX_NAME, keywords: "wrong patient twin held back quarantine someone else's", run: () => setView('patient') },
    ],
    [],
  );

  // Widths that fit the list at 1280 (about 560px): the title takes the room and wraps to two lines, with the file
  // name, the institution and the document's date on a small line under it; Where it stands as a short tag; Type
  // gives way first; Added as a date. (The old Category, Date, Institution and Conf columns are that line and the pane.)
  const columns = useMemo<ColumnDef<InboxItem, unknown>[]>(
    () => [
      {
        id: 'title',
        header: 'Upload',
        accessorFn: (r) => r.triage?.title ?? r.title,
        cell: ({ row }) => {
          const r = row.original;
          const t = r.triage;
          const institution = t?.institution.match_id ? (peopleById.get(t.institution.match_id)?.name ?? null) : t?.institution.new_name ? `${t.institution.new_name} (new)` : r.institutionName;
          const title = t?.title ?? r.title;
          const sub = [r.filename !== title ? r.filename : null, institution, t?.document_date ?? r.documentDateText ?? null].filter(Boolean);
          return (
            <span className="inbox-cell">
              <span className="inbox-clamp">
                <KeepDatesWhole text={title} />
              </span>
              {sub.length ? <span className="inbox-sub">{sub.join(' · ')}</span> : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: 220 },
      },
      { id: 'status', header: 'Where it stands', accessorFn: (r) => inboxStatusLabel(r).label, cell: ({ row }) => <InboxStatusTag item={row.original} />, meta: { width: 124, shrink: false } },
      { id: 'category', header: 'Type', accessorFn: (r) => (r.triage?.category ? documentTypeLabel(r.triage.category) : ''), cell: ({ getValue }) => <span className="muted">{String(getValue()) || 'not known yet'}</span>, meta: { width: 104, maxWidth: 170 } },
      { id: 'received', header: 'Added', accessorKey: 'createdAt', cell: ({ getValue }) => <DateText iso={String(getValue()).slice(0, 10)} />, meta: { width: 100, shrink: false } },
    ],
    [peopleById],
  );

  const waiting = count.data?.count ?? 0;
  const byHand = count.data?.byStatus.needs_manual ?? 0;
  const filed = count.data?.byStatus.filed ?? 0;
  const skipped = count.data?.byStatus.skipped ?? 0;
  const uploading = upload.isPending || paste.isPending;
  const filtering = Boolean(filter.trim());

  const addFiles = { label: uploading ? 'Adding…' : 'Add files', onClick: () => fileInput.current?.click(), disabled: uploading, shortcut: 'n', title: 'Choose files from this computer; each waits here until you file it' };
  const pasteAction = { label: 'Paste text', onClick: () => openPaste(''), shortcut: 'p', title: 'Paste a portal message, an email or a transcript as a document' };

  /** The held-back list: j / k move, Enter goes to the answers, m and w answer (HeldPanel). */
  const heldColumns = useMemo<ColumnDef<HeldItem, unknown>[]>(
    () => [
      {
        id: 'title',
        header: 'Document',
        accessorKey: 'title',
        cell: ({ row }) => (
          <span className="inbox-cell">
            <span className="inbox-clamp">
              <KeepDatesWhole text={row.original.title} />
            </span>
            <span className="inbox-sub">{row.original.words}</span>
          </span>
        ),
        meta: { grow: true, minWidth: 220 },
      },
      { id: 'pages', header: 'Pages', accessorKey: 'pageCount', meta: { width: 70, className: 'num' } },
      { id: 'received', header: 'Added', accessorKey: 'createdAt', cell: ({ getValue }) => <DateText iso={String(getValue()).slice(0, 10)} />, meta: { width: 100, shrink: false } },
    ],
    [],
  );
  const heldLeft = (
    <div className="inbox-list">
      {held.isPending ? (
        <Loading>Loading what is held back…</Loading>
      ) : (
        <DataTable
          columns={heldColumns}
          data={heldItems}
          rowId={(r) => r.id}
          selectedId={selectedId}
          onSelect={(r) => select(r?.id ?? null)}
          onOpen={() => document.querySelector<HTMLElement>('.doc-detail .detail-actions .btn')?.focus()}
          initialSort={[{ id: 'received', desc: true }]}
          emptyText="Nothing is held back."
          tableId="inbox.patient"
          autoFocus
        />
      )}
    </div>
  );
  const heldRight = selectedId ? (
    <HeldPanel id={selectedId} group="Page" onAnswered={(id) => select(neighbourIn(heldItems.map((h) => ({ id: h.id }) as InboxItem), id))} />
  ) : (
    <EmptyState title={heldItems.length ? 'Pick a document' : 'Nothing is held back'}>
      {heldItems.length ? `See whose name is printed on it, then answer: ${MINE_LABEL} (${PATIENT_KEYS.mine}) or ${NOT_MINE_LABEL} (${PATIENT_KEYS.notMine}).` : 'A document whose pages name someone else waits here until you answer.'}
    </EmptyState>
  );

  const left = (
    <div className="inbox-list" ref={tableRef}>
      {items.length || view !== 'active' ? <InboxDropZone busy={uploading} compact onFiles={uploadFiles} onPick={() => fileInput.current?.click()} /> : null}
      {list.isPending ? (
        <Loading>Loading what is waiting…</Loading>
      ) : list.isError ? (
        <Loading>Could not load what is waiting: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
      ) : !items.length && view === 'active' ? (
        <div className="inbox-empty">
          <EmptyState
            title="Nothing waiting"
            action={
              <span className="row">
                <Button variant="primary" onClick={addFiles.onClick} disabled={addFiles.disabled} shortcut="n">
                  {addFiles.label}
                </Button>
                <Button onClick={pasteAction.onClick} shortcut="p">
                  Paste text
                </Button>
              </span>
            }
          >
            Add a file here when you want to see where Claude suggests it goes before it is filed. Files added anywhere else go straight to Documents, where Claude names and files them by itself.
          </EmptyState>
          <InboxDropZone busy={uploading} onFiles={uploadFiles} onPick={() => fileInput.current?.click()} />
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={shown}
          rowId={(r) => r.id}
          selectedId={selectedId}
          onSelect={(r) => select(r?.id ?? null)}
          onOpen={() => fileSelected()}
          initialSort={[{ id: 'received', desc: true }]}
          rowClassName={(r) => (r.inbox?.status === 'filed' || r.inbox?.status === 'skipped' ? 'dim' : undefined)}
          emptyText={filtering && items.length ? `Nothing here matches "${filter.trim()}".` : view === 'filed' ? 'Nothing filed from here yet.' : view === 'skipped' ? 'Nothing skipped.' : 'Nothing here yet.'}
          tableId={`inbox.${view}`}
          autoFocus
          footer={
            filtering || items.some(isWaiting) ? (
              <span>
                {filtering ? `${shown.length} of ${items.length} match` : ''}
                {filtering && items.some(isWaiting) ? ' · ' : ''}
                {items.some(isWaiting) ? 'Reading new uploads…' : ''}
              </span>
            ) : undefined
          }
        />
      )}
    </div>
  );

  const right = !selectedId ? (
    items.length ? (
      <EmptyState title="Pick an upload">
        See where Claude suggests it goes, change anything, then File it (Enter). Move with j and k; Skip leaves it in Documents as it is.
      </EmptyState>
    ) : (
      <EmptyState title="How this works">
        Each file you add here is read, and Claude suggests a title, a type, where it came from and what to link it to. Nothing is filed until you press File it, and nothing is ever deleted: Skip leaves it in Documents as it is.
      </EmptyState>
    )
  ) : !current ? (
    fallback.isPending ? <Loading /> : <EmptyState title="That upload is not available">It may have been deleted. Pick another from the list.</EmptyState>
  ) : (
    <InboxDetail
      key={`${current.id}:${current.triage?.at ?? ''}:${current.inbox?.status ?? 'none'}:${current.sourceTier ?? ''}`}
      item={current}
      people={people.data?.items ?? []}
      records={records.data?.items ?? []}
      encounters={encounters.data ?? []}
      aiOff={aiOff}
      busy={busy}
      focusToken={focusToken}
      builderRef={builderRef}
      onFile={(input) => fileSelected(input)}
      onRetriage={retriageSelected}
      onSkip={skipSelected}
      onOpen={openSelected}
    />
  );

  return (
    <div className="page">
      <PageHeader
        title={INBOX_NAME}
        meta={
          count.data ? (
            <span className="mono">
              {waiting} waiting{byHand ? ` · ${byHand} to file by hand` : ''} · {filed} filed
            </span>
          ) : null
        }
        intro="Uploads you want to look at before they are filed, each with Claude’s suggestion of where it goes. Files added anywhere else go straight to Documents."
        actions={{ primary: addFiles, secondary: [pasteAction] }}
      />
      <Toolbar label="Views and search">
        <Segmented
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'active', label: 'Waiting', count: waiting, title: 'Uploads that are not filed or skipped yet' },
            { value: 'filed', label: 'Filed', count: filed, title: 'Uploads filed from here' },
            { value: 'skipped', label: 'Skipped', count: skipped, title: 'Uploads left in Documents as they were' },
            { value: 'all', label: 'All', title: 'Everything added here' },
            ...(heldItems.length || heldView ? [{ value: 'patient' as const, label: HELD_WORDS, count: heldItems.length || undefined, title: 'Documents whose pages name someone else, from any upload' }] : []),
          ]}
        />
        <SearchField
          label="Find"
          placeholder="File, title or institution"
          value={filter}
          onChange={setFilter}
          width={220}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              if (filter) setFilter('');
              else e.currentTarget.blur();
            } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
              // Into the list, where j / k and Enter work.
              e.preventDefault();
              tableRef.current?.querySelector<HTMLElement>('.table-wrap')?.focus();
            }
          }}
        />
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['enter', 'file it'],
            ['e', 'edit'],
            ['r', 'ask Claude again'],
            ['s', 'skip'],
            ['o', 'open'],
            ['n', 'add files'],
            ['p', 'paste'],
            ['/', 'find'],
            ['v v', 'next list'],
            ...(heldView ? ([[PATIENT_KEYS.mine, MINE_LABEL.toLowerCase()], [PATIENT_KEYS.notMine, NOT_MINE_LABEL.toLowerCase()]] as Array<[string, string]>) : []),
          ]}
        >
          {filtering ? (
            <Button size="sm" variant="ghost" onClick={() => setFilter('')}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          accept={UPLOAD_ACCEPT}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            uploadFiles(files);
          }}
        />
      </Toolbar>
      {heldItems.length && !heldView ? (
        <p className="inbox-list-line warn">
          <strong>{heldCountWords(heldItems.length)}</strong> {HELD_EXPLAIN}{' '}
          <Button size="sm" variant="accent" onClick={() => setView('patient')} title="List them, with It's mine and Not my record">
            Show them
          </Button>
        </p>
      ) : null}
      {aiOff && !heldView ? (
        <p className="inbox-list-line warn">
          <strong>Claude is switched off, or no API key is set.</strong> Uploads get no suggestion: fill in where each one goes and File it by hand. <Link to="/settings">Settings</Link>
        </p>
      ) : (
        <p className="inbox-list-line">
          <strong>{VIEW_WORDS[view].lead}</strong> {VIEW_WORDS[view].text}
        </p>
      )}
      <div className="page-body flush">
        <SplitView storageKey="inbox.list" defaultLeft={55} minLeft={460} minRight={440} left={heldView ? heldLeft : left} right={heldView ? heldRight : right} />
      </div>
      <PasteDialog open={pasteOpen} initialText={pasteText} busy={paste.isPending} error={pasteError} onClose={() => setPasteOpen(false)} onSave={savePaste} />
    </div>
  );
}
