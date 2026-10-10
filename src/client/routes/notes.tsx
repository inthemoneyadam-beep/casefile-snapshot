/**
 * /notes — My notes: only your own writing and your chief of staff's (documents of "Your own notes" and what Claude read from
 * them), never a clinical record. Show: All notes (by date), Medications (what your notes say about each drug, with
 * its timeline by source), Symptoms and effects, Events. Every entry shows its quote, the date as written and how it
 * stands against the records (agrees, differs, records disagree first, nothing to compare).
 *
 * Import notes (i): drop many files, a zip or a folder anywhere on this page, or choose them; one estimate for reading
 * them all; nothing is read without your yes. Read the notes not read yet (r) asks the same way.
 * Split view: the list left, the chosen note, drug or entry right. The view, the search and the selection live in
 * the URL.
 */
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { dateSortKey } from '@shared/dates';
import { NOTE_VIEWS, NOTE_VIEW_WORDS, type NoteDocItem, type NoteDrugItem, type NoteEntry, type NoteView } from '@shared/notes';
import { useNoteList, useNotesImport, useReadingEstimate, type ReadWhat } from '../api/notes';
import { useMe } from '../api/users';
import { errorMessage } from '../api/client';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { dialogOpen, hasFiles } from '../app/dom';
import { navItemFor } from '../app/nav';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { DateText } from '../ui/DateText';
import { Tag } from '../ui/StatusTag';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';
import { SearchField, Segmented, Toolbar, ToolbarKeys } from '../ui/Toolbar';
import { ImportDialog } from '../features/notes/ImportDialog';
import { droppedFiles } from '../features/notes/drop';
import { DrugPane, EntryPane, NoteDocPane, StandingTag } from '../features/notes/NoteDetails';
import { READ_TONE, dateFromWords, plural, readWords } from '../features/notes/words';
import '../features/notes/notes.css';

const VIEW_KEYS: Record<NoteView, string> = { notes: 'v a', meds: 'v m', symptoms: 'v s', events: 'v e' };
const VIEW_INTRO: Record<NoteView, string> = {
  notes: 'Every note of yours, newest first, with how much Claude has read of it.',
  meds: 'What your notes say about each drug: started, stopped, dose, what it did. Open one to see its timeline beside your records.',
  symptoms: 'Symptoms, side effects and what a drug did, as your notes say them. On how things felt, your word counts first.',
  events: 'Events, procedures, tests and readings your notes give, set against your clinical records.',
};

const searchSchema = z.object({
  view: z.enum(NOTE_VIEWS).optional().catch(undefined),
  /** Only what differs from the records (and is not answered yet). */
  only: z.enum(['differs']).optional().catch(undefined),
  id: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});
type NotesSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/notes')({
  validateSearch: (s: Record<string, unknown>): NotesSearch => searchSchema.parse(s),
  component: NotesPage,
});

type Row = NoteDocItem | NoteDrugItem | NoteEntry;
const rowKey = (view: NoteView, r: Row): string => (view === 'notes' ? (r as NoteDocItem).id : view === 'meds' ? (r as NoteDrugItem).key : (r as NoteEntry).factId);

function NotesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const me = useMe();
  const view: NoteView = search.view ?? 'notes';
  const list = useNoteList<Row>(view, search.q || undefined);
  const everything = useNoteList<NoteDocItem>('notes');
  const imp = useNotesImport();
  const [importing, setImporting] = useState(false);
  const [dropped, setDropped] = useState<File[] | null>(null);
  const [asking, setAsking] = useState<ReadWhat | null>(null);
  const [over, setOver] = useState(false);
  const unread = useReadingEstimate(asking);

  const differs = (r: Row): boolean => (view === 'notes' ? (r as NoteDocItem).differs > 0 : view === 'meds' ? (r as NoteDrugItem).standing === 'differs' : (r as NoteEntry).standing === 'differs' && !(r as NoteEntry).answer);
  const all = useMemo(() => list.data?.items ?? [], [list.data]);
  const rows = useMemo(() => (search.only === 'differs' ? all.filter(differs) : all), [all, search.only, view]);
  const selectedId = search.id ?? null;
  const selected = rows.find((r) => rowKey(view, r) === selectedId) ?? null;
  const total = everything.data?.items.length ?? 0;
  const notRead = (everything.data?.items ?? []).filter((n) => readWords(n) === 'not read yet').length;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q, id: undefined }), replace: true }));
  function setSearch(patch: Partial<NotesSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function setView(v: NoteView) {
    setSearch({ view: v === 'notes' ? undefined : v, id: undefined }, false);
  }
  function openRow(r: Row) {
    if (view === 'meds') {
      void navigate({ to: '/reconcile', search: { tab: 'meds', id: (r as NoteDrugItem).key } });
      return;
    }
    const docId = view === 'notes' ? (r as NoteDocItem).id : (r as NoteEntry).documentId;
    const e = view === 'notes' ? null : (r as NoteEntry);
    void navigate({ to: '/documents/$id', params: { id: docId }, search: { page: e?.page ?? undefined, cite: e?.citationId ?? undefined } });
  }
  /** Reading starts only from the dialog that shows its cost. */
  function readOne(id: string) {
    setAsking({ documentIds: [id] });
  }
  function readAsked() {
    if (!asking) return;
    imp.read.mutate(asking, {
      onSuccess: (r) => {
        toast(r.jobs ? `Claude is reading ${plural(r.estimate.packedNotes + r.estimate.aloneNotes, 'note')}.` : 'Nothing to read.', 'ok');
        setAsking(null);
      },
      onError: (err) => toast(errorMessage(err), 'bad'),
    });
  }

  const latest = useRef({ view, canWrite: me.canWrite, selectedId, only: search.only });
  latest.current = { view, canWrite: me.canWrite, selectedId, only: search.only };
  const free = () => !dialogOpen();
  const actions = {
    import: () => free() && latest.current.canWrite && setImporting(true),
    read: () => free() && latest.current.canWrite && setAsking({ scope: 'unread' }),
    readSelected: () => {
      const id = latest.current.selectedId;
      if (free() && latest.current.canWrite && latest.current.view === 'notes' && id) readOne(id);
    },
  };

  useBindings(
    [
      { keys: 'v v', description: 'Next view: all notes, medications, symptoms and effects, events', group: 'Lists', run: () => free() && setView(NOTE_VIEWS[(NOTE_VIEWS.indexOf(latest.current.view) + 1) % NOTE_VIEWS.length]) },
      ...NOTE_VIEWS.map((v) => ({ keys: VIEW_KEYS[v], description: `Show ${NOTE_VIEW_WORDS[v].toLowerCase()}`, group: 'Lists', run: () => free() && setView(v) })),
      { keys: 'v f', description: 'Only what differs from the records, or everything', group: 'Lists', run: () => free() && setSearch({ only: latest.current.only ? undefined : 'differs', id: undefined }) },
      { keys: 'i', description: 'Import notes (files, a zip or a folder)', group: 'Page', when: () => latest.current.canWrite, run: actions.import },
      { keys: 'r', description: 'Read the selected note (shows the cost first)', group: 'Page', when: () => latest.current.canWrite && latest.current.view === 'notes' && Boolean(latest.current.selectedId), run: actions.readSelected },
      { keys: 'R', description: 'Read every note not read yet (shows the cost first)', group: 'Page', when: () => latest.current.canWrite, run: actions.read },
    ],
    [],
  );
  useRegisterCommands(
    [
      ...NOTE_VIEWS.map((v) => ({ id: `notes.${v}`, title: `My notes: ${NOTE_VIEW_WORDS[v].toLowerCase()}`, group: 'Page', shortcut: VIEW_KEYS[v], keywords: 'notes journal personal own diary', run: () => setView(v) })),
      { id: 'notes.import', title: 'Import notes (files, a zip or a folder)', group: 'Page', shortcut: 'i', keywords: 'import notes keep evernote takeout journal zip folder', when: () => latest.current.canWrite, run: () => setImporting(true) },
      { id: 'notes.read', title: 'Read every note not read yet (shows the cost first)', group: 'Page', shortcut: 'R', keywords: 'read notes estimate cost', when: () => latest.current.canWrite, run: () => setAsking({ scope: 'unread' }) },
      { id: 'notes.reconcile', title: 'Records vs my notes (Reconciliation)', group: 'Page', keywords: 'reconcile differ notes records', run: () => void navigate({ to: '/reconcile', search: { stage: 'notes' } }) },
    ],
    [],
  );

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => {
    if (view === 'notes') {
      return [
        {
          id: 'date',
          header: 'Date',
          accessorFn: (r) => dateSortKey((r as NoteDocItem).date),
          cell: ({ row }) => {
            const n = row.original as NoteDocItem;
            const from = dateFromWords(n.dateFrom);
            return (
              <span title={from ?? undefined}>
                <DateText iso={n.date} precision={n.precision} text={n.dateText} />
                {from === 'date from the file' ? <span className="faint xs"> file</span> : null}
              </span>
            );
          },
          meta: { width: 104, shrink: false },
        },
        { id: 'title', header: 'Note', accessorFn: (r) => (r as NoteDocItem).title, meta: { grow: true, minWidth: 200 } },
        { id: 'details', header: 'Details', accessorFn: (r) => (r as NoteDocItem).details, cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { className: 'num', width: 72 } },
        {
          id: 'stands',
          header: 'Against the records',
          accessorFn: (r) => (r as NoteDocItem).differs * 1000 + (r as NoteDocItem).agrees,
          cell: ({ row }) => {
            const n = row.original as NoteDocItem;
            const read = readWords(n);
            if (read !== 'read' && read !== 'partly read') return <Tag tone={READ_TONE[read] ?? 'neutral'}>{read}</Tag>;
            if (n.differs) return <Tag tone="bad">{plural(n.differs, 'difference')}</Tag>;
            if (n.agrees) return <Tag tone="ok">{n.agrees} agree</Tag>;
            return <span className="faint">nothing to compare</span>;
          },
          meta: { width: 150, shrink: false },
        },
      ];
    }
    if (view === 'meds') {
      return [
        { id: 'name', header: 'Drug', accessorFn: (r) => (r as NoteDrugItem).name, meta: { grow: true, minWidth: 160 } },
        { id: 'says', header: 'Your notes say', accessorFn: (r) => (r as NoteDrugItem).says, cell: ({ getValue }) => <span className="muted">{String(getValue()) || '—'}</span>, meta: { width: 200, maxWidth: 260, wrap: true } },
        { id: 'entries', header: 'Entries', accessorFn: (r) => (r as NoteDrugItem).entries, cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>, meta: { className: 'num', width: 72 } },
        { id: 'stands', header: 'Against the records', accessorFn: (r) => (r as NoteDrugItem).standing, cell: ({ row }) => <StandingTag entry={{ standing: (row.original as NoteDrugItem).standing, answer: null, standingWhy: null }} />, meta: { width: 150, shrink: false } },
      ];
    }
    return [
      { id: 'date', header: 'Date', accessorFn: (r) => dateSortKey((r as NoteEntry).date ?? (r as NoteEntry).documentDate), cell: ({ row }) => <DateText iso={(row.original as NoteEntry).date} precision={(row.original as NoteEntry).precision} text={(row.original as NoteEntry).dateText} />, meta: { width: 104, shrink: false } },
      {
        id: 'what',
        header: 'What',
        accessorFn: (r) => (r as NoteEntry).statement,
        cell: ({ row }) => {
          const e = row.original as NoteEntry;
          return (
            <span className="nt-cell">
              <span>{e.statement}</span>
              <span className="nt-cell-sub">{e.kind} · {e.documentTitle}</span>
            </span>
          );
        },
        meta: { grow: true, minWidth: 220 },
      },
      { id: 'stands', header: 'Against the records', accessorFn: (r) => (r as NoteEntry).standing, cell: ({ row }) => <StandingTag entry={row.original as NoteEntry} />, meta: { width: 150, shrink: false } },
    ];
  }, [view]);

  const dropProps = me.canWrite
    ? {
        'data-own-drop': '',
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e) || dialogOpen()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e) || dialogOpen()) return;
          e.preventDefault();
          setOver(false);
          // A dropped folder is read file by file (features/notes/drop.ts).
          const files = droppedFiles(e.dataTransfer);
          setImporting(true);
          void files.then((list) => setDropped(list));
        },
      }
    : {};

  const nothingYet = everything.isSuccess && total === 0;
  const left = list.isPending ? (
    <Loading>Loading your notes…</Loading>
  ) : list.isError ? (
    <Loading>Could not load your notes: {errorMessage(list.error)}</Loading>
  ) : (
    <DataTable
      key={view}
      columns={columns}
      data={rows}
      rowId={(r) => rowKey(view, r)}
      selectedId={selectedId}
      onSelect={(r) => setSearch({ id: r ? rowKey(view, r) : undefined })}
      onOpen={openRow}
      initialSort={[{ id: view === 'meds' ? 'stands' : 'date', desc: view !== 'meds' }]}
      rowClassName={(r) => ((view !== 'notes' && (r as NoteEntry).standing === 'differs' && !(r as NoteEntry).answer) || (view === 'meds' && (r as NoteDrugItem).standing === 'differs') ? 'nt-differs-row' : '')}
      tableId={`notes.${view}`}
      autoFocus
      emptyText={search.q ? 'Nothing matches this search.' : search.only ? 'Nothing differs from the records here.' : view === 'notes' ? 'No notes yet.' : 'Nothing of this kind in your notes yet.'}
    />
  );
  const right = selected ? (
    view === 'notes' ? (
      <NoteDocPane id={(selected as NoteDocItem).id} canRead={me.canWrite} onRead={() => readOne((selected as NoteDocItem).id)} />
    ) : view === 'meds' ? (
      <DrugPane drugKey={(selected as NoteDrugItem).key} />
    ) : (
      <EntryPane entry={selected as NoteEntry} />
    )
  ) : rows.length ? (
    <EmptyState title={view === 'notes' ? 'Pick a note' : view === 'meds' ? 'Pick a drug' : 'Pick an entry'}>
      {view === 'meds' ? 'See what your notes say about it and its timeline beside your records. Move with j and k; Enter opens it in Reconciliation.' : 'See what it says, its quote and how it stands against your records. Move with j and k; Enter opens the page.'}
    </EmptyState>
  ) : null;

  const est = unread.data;
  return (
    <div className={`page${over ? ' drop-over' : ''}`} {...dropProps}>
      <PageHeader
        title="My notes"
        meta={everything.isPending || nothingYet ? null : <span className="mono">{plural(total, 'note')}{notRead ? ` · ${notRead} not read yet` : ''}</span>}
        intro={navItemFor('/notes')?.hint}
        actions={
          me.canWrite
            ? {
                primary: { label: 'Import notes', onClick: () => setImporting(true), shortcut: 'i', title: 'Files, a zip or a folder of your own notes' },
                more: [{ label: 'Read every note not read yet', onClick: () => setAsking({ scope: 'unread' }), shortcut: 'R', title: 'Shows what it costs first' }],
              }
            : undefined
        }
      />
      {nothingYet ? null : (
        <Toolbar label="Views and search">
          <Segmented label="Show" value={view} onChange={setView} options={NOTE_VIEWS.map((v) => ({ value: v, label: NOTE_VIEW_WORDS[v], title: VIEW_INTRO[v] }))} />
          <Segmented<'' | 'differs'>
            label="Against the records"
            value={search.only ?? ''}
            onChange={(v) => setSearch({ only: v || undefined, id: undefined })}
            options={[
              { value: '', label: 'All', count: all.length },
              { value: 'differs', label: 'Differs', count: all.filter(differs).length, title: 'Only what your notes give differently from the records (not answered yet)' },
            ]}
          />
          <SearchField label="Find" placeholder="Words in your notes" value={qLocal} onChange={setQLocal} width={220} />
          <ToolbarKeys
            items={[
              ['j/k', 'move'],
              ['enter', view === 'meds' ? 'its timeline' : 'open the page'],
              ['esc', 'clear'],
              ['v v', 'next view'],
              ['v f', 'differs only'],
              me.canWrite ? ['i', 'import'] : null,
              me.canWrite && view === 'notes' ? ['r', 'read it'] : null,
            ]}
          />
        </Toolbar>
      )}
      {nothingYet ? null : <p className="nt-intro">{VIEW_INTRO[view]}</p>}
      <div className="page-body flush">
        {nothingYet ? (
          <EmptyState
            title="No notes yet"
            action={
              me.canWrite ? (
                <Button variant="primary" onClick={() => setImporting(true)} shortcut="i">
                  Import notes
                </Button>
              ) : undefined
            }
          >
            Bring in your own notes and your chief of staff's: drop files, a zip or a folder here (text, Word, PDF, Google Keep, Evernote and more). Each is filed as your own note with its own date. Claude reads them only when you say so, and sets what they say beside your records.
          </EmptyState>
        ) : (
          <SplitView storageKey="notes" defaultLeft={55} minLeft={420} minRight={420} left={left} right={right} />
        )}
      </div>
      <ImportDialog
        open={importing}
        initialFiles={dropped}
        onClose={() => {
          setImporting(false);
          setDropped(null);
        }}
      />
      <Dialog
        open={Boolean(asking)}
        onClose={() => setAsking(null)}
        title={asking && 'documentIds' in asking ? 'Read this note' : 'Read your notes not read yet'}
        width={520}
        footer={
          <div className="row">
            <Button variant="primary" onClick={readAsked} disabled={!est || est.calls === 0 || imp.read.isPending} data-autofocus>
              {imp.read.isPending ? 'Starting…' : asking && 'documentIds' in asking ? 'Read it' : 'Read them'}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Not now
            </Button>
          </div>
        }
      >
        <p className="nt-estimate">{unread.isPending ? 'Working out the cost…' : unread.isError ? errorMessage(unread.error) : est?.words}</p>
      </Dialog>
    </div>
  );
}
