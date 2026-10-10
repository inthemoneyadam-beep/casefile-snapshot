/**
 * /imaging — Scans and imaging. Split view: scans left, the selected scan right
 * (features/imaging/ImagingDetail.tsx): what the report found, a word-by-word
 * comparison with any other scan, its check against your clinical records, its
 * image files and where it came from.
 *
 * The header: Add a scan (the one primary); under More, Copy Claude's scans into
 * my scan list and the scan image viewer. The toolbar, each part labelled:
 *   View:   By scan type (default: type, then body part, then the scans in date
 *           order) · By document (scans under the report they came from) · All
 *           scans (flat, sortable)
 *   Type:   All · MRI · CT ... (only when there is more than one kind)
 *   Find:   scan name, body part or report words
 *   Dates:  from and to
 * then Clear filters and the keys. With no scans at all the page says what it is
 * for and offers Add a scan; with nothing selected the right pane says what to do.
 * Selection, filters, the view and the comparison live in the URL.
 */
import { useMemo, useRef, useState } from 'react';
import { TRUST_ORDER } from '../ui/StatusTag';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { dateSortKey } from '@shared/dates';
import { ApiError, useFailToast } from '../api/client';
import { useImaging, useImagingByDocument, useImagingList, useImagingMutations, useImagingOrganised, type ImagingEntry, type SerialStudy } from '../api/imaging';
import { useLabDocuments, useLabInstitutions } from '../api/labs';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { dialogOpen } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { DateText } from '../ui/DateText';
import { Confirm } from '../ui/Dialog';
import { useToast } from '../ui/Toast';
import { DateRange, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { ImagingDetail, StudySourceLink, StudyStatusTag, focusComparePicker, studyRowClass } from '../features/imaging/ImagingDetail';
import { ImagingFormDialog } from '../features/imaging/ImagingFormDialog';
import { ImagingByDocument, ImagingByModality, flattenGroups, serialWordsFor } from '../features/imaging/ImagingGroups';
import { IMAGING_INTRO, modalityWord, scanCountWords } from '../features/imaging/words';
import { sourceLine } from '../features/labs/source';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/imaging/imaging.css';

const VIEWS = ['modality', 'documents', 'list'] as const;
type View = (typeof VIEWS)[number];
const VIEW_WORDS: Record<View, string> = { modality: 'By scan type', documents: 'By document', list: 'All scans' };

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
  modality: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
  compare: z.string().optional().catch(undefined),
});
export type ImagingSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/imaging')({
  validateSearch: (s: Record<string, unknown>): ImagingSearch => searchSchema.parse(s),
  component: ImagingPage,
});

function ImagingPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const selectedId = search.id ?? null;
  const modality = search.modality ?? '';
  const view: View = search.view ?? 'modality';

  const listParams = useMemo(() => ({ modality: modality || undefined, q: search.q, from: search.from, to: search.to }), [modality, search.q, search.from, search.to]);
  // The organised groups always load: they are the default view and tell every view which study precedes the selected one.
  const organised = useImagingOrganised(listParams);
  const byDoc = useImagingByDocument(listParams, view === 'documents');
  const list = useImagingList(listParams, view === 'list');
  const detail = useImaging(selectedId);
  const documents = useLabDocuments();
  const institutions = useLabInstitutions();
  const m = useImagingMutations();
  const docDates = useMemo(() => new Map((documents.data ?? []).map((d) => [d.id, d.documentDate] as const)), [documents.data]);

  const active = view === 'modality' ? organised : view === 'documents' ? byDoc : list;
  const modalities = active.data?.modalities ?? organised.data?.modalities ?? [];
  const serial = useMemo(() => flattenGroups(organised.data?.groups ?? []), [organised.data]);
  const docGroups = byDoc.data?.documents ?? [];
  const docStudies = useMemo(() => docGroups.flatMap((d) => d.studies), [docGroups]);
  const items = list.data?.items ?? [];
  const rows: ImagingEntry[] = view === 'modality' ? serial : view === 'documents' ? docStudies : items;
  const selectedRow = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const selectedSerial: SerialStudy | null = selectedId ? (serial.find((s) => s.id === selectedId) ?? null) : null;
  const previous = selectedSerial?.previousId ? (serial.find((s) => s.id === selectedSerial.previousId) ?? null) : null;
  const study = detail.data ?? null;

  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.fromFacts.isPending;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  function setSearch(patch: Partial<ImagingSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined, compare: undefined });
  }
  function setView(v: View) {
    // Ids are the same in every view, so the selection carries over.
    setSearch({ view: v === 'modality' ? undefined : v }, false);
  }
  function cycleView() {
    const i = VIEWS.indexOf(latest.current.view);
    setView(VIEWS[(i + 1) % VIEWS.length]);
  }
  function clearFilters() {
    setQLocal('');
    setSearch({ q: undefined, from: undefined, to: undefined, modality: undefined, id: undefined });
  }
  function openSource(e: ImagingEntry) {
    if (!e.documentId) {
      toast('This scan has no report on file.');
      return;
    }
    void navigate({ to: '/documents/$id', params: { id: e.documentId }, search: { page: e.pageNumber ?? undefined, cite: e.citationId ?? undefined } });
  }
  function comparePrevious(s: SerialStudy) {
    if (!s.previousId) return;
    setSearch({ id: s.id, compare: s.previousId }, false);
  }
  function importFromFacts(factIds?: string[]) {
    m.fromFacts.mutate(factIds ? { factIds } : {}, {
      onSuccess: (r) => {
        toast(r.created ? `Copied ${r.created} scan${r.created === 1 ? '' : 's'} into your scan list${r.skipped ? `, ${r.skipped} skipped` : ''}` : 'Nothing new to copy: every scan Claude read is already on your scan list', r.created ? 'ok' : 'info');
        if (factIds && r.items[0]) select(r.items[0].id);
      },
      onError: fail,
    });
  }
  function patchDicom(ids: string[]) {
    if (!study || study.source !== 'row') return;
    m.update.mutate({ id: study.id, patch: { dicomDocumentIds: ids } }, { onSuccess: () => toast('Image files updated', 'ok'), onError: fail });
  }
  function openViewer() {
    const doc = latest.current.study?.dicomDocuments.find((d) => d.kind === 'dicom');
    if (doc) void navigate({ to: '/imaging/viewer/$id', params: { id: doc.id } });
    else void navigate({ to: '/imaging/viewer/$id', params: { id: 'latest' }, search: { study: 1 } });
  }

  const latest = useRef({ view, study, selectedRow, selectedSerial, busy });
  latest.current = { view, study, selectedRow, selectedSerial, busy };
  const current = () => latest.current.study ?? latest.current.selectedRow;
  const canEdit = () => current()?.source === 'row' && !dialogOpen();
  const isVirtual = () => current()?.source === 'fact' && !dialogOpen();

  useBindings(
    [
      { keys: 'n', description: 'Add a scan', group: 'Lists', run: () => !dialogOpen() && setNewOpen(true) },
      { keys: 'e', description: 'Edit the selected scan', group: 'Lists', when: canEdit, run: () => setEditOpen(true) },
      { keys: 'f', description: "Copy every scan Claude read into your scan list", group: 'Lists', run: () => !dialogOpen() && !latest.current.busy && importFromFacts() },
      { keys: 'i', description: 'Copy the selected scan Claude read into your scan list', group: 'Lists', when: isVirtual, run: () => current()?.factId && importFromFacts([current()!.factId!]) },
      { keys: 'c', description: 'Compare the selected scan with another', group: 'Lists', when: () => Boolean(current()) && !dialogOpen(), run: focusComparePicker },
      { keys: 'p', description: 'Compare the selected scan with the previous one of its kind', group: 'Lists', when: () => Boolean(latest.current.selectedSerial?.previousId) && !dialogOpen(), run: () => latest.current.selectedSerial && comparePrevious(latest.current.selectedSerial) },
      // View keys are `v` chords: a bare `v` here would swallow the global `v t` / `v b` / `v r` appearance chords.
      { keys: 'v v', description: 'Next view: by scan type, by document, all scans', group: 'Lists', run: () => !dialogOpen() && cycleView() },
      { keys: 'v m', description: 'By scan type (type, body part, scans in date order)', group: 'Lists', run: () => !dialogOpen() && setView('modality') },
      { keys: 'v d', description: 'By document (scans under their report)', group: 'Lists', run: () => !dialogOpen() && setView('documents') },
      { keys: 'v l', description: 'All scans (one list you can sort)', group: 'Lists', run: () => !dialogOpen() && setView('list') },
      { keys: 'o', description: 'Open the report of the selected scan', group: 'Lists', when: () => Boolean(current()?.documentId) && !dialogOpen(), run: () => current() && openSource(current()!) },
      { keys: 'Delete', description: 'Delete the selected scan (asks first)', group: 'Lists', when: canEdit, run: () => setDeleteOpen(true) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'imaging.new', title: 'Scans: add a scan', group: 'Imaging', keywords: 'add mri ct pet new study imaging', shortcut: 'n', run: () => setNewOpen(true) },
      { id: 'imaging.from-facts', title: "Scans: copy Claude's scans into my scan list", group: 'Imaging', keywords: 'import facts imaging extracted studies add from documents', shortcut: 'f', run: () => importFromFacts() },
      { id: 'imaging.mri', title: 'Scans: show only MRI', group: 'Imaging', run: () => setSearch({ modality: 'MRI', id: undefined }, false) },
      { id: 'imaging.all', title: 'Scans: show every type of scan', group: 'Imaging', run: () => setSearch({ modality: undefined }, false) },
      { id: 'imaging.modality', title: 'Scans: by scan type (type, body part, scans in order)', group: 'Imaging', keywords: 'grouped headers serial modality view', shortcut: 'v m', run: () => setView('modality') },
      { id: 'imaging.documents', title: 'Scans: by document (scans under their report)', group: 'Imaging', keywords: 'by document report stacked view', shortcut: 'v d', run: () => setView('documents') },
      { id: 'imaging.list', title: 'Scans: all scans in one list', group: 'Imaging', keywords: 'flat list view', shortcut: 'v l', run: () => setView('list') },
      {
        id: 'imaging.previous',
        title: 'Scans: compare the selected scan with the previous one of its kind',
        group: 'Imaging',
        shortcut: 'p',
        when: () => Boolean(latest.current.selectedSerial?.previousId),
        run: () => {
          if (latest.current.selectedSerial) comparePrevious(latest.current.selectedSerial);
        },
      },
      { id: 'imaging.compare', title: 'Scans: compare the selected scan with another', group: 'Imaging', shortcut: 'c', when: () => Boolean(current()), run: focusComparePicker },
      {
        id: 'imaging.source',
        title: 'Scans: open the report of the selected scan',
        group: 'Imaging',
        shortcut: 'o',
        when: () => Boolean(current()?.documentId),
        run: () => {
          const s = current();
          if (s) openSource(s);
        },
      },
      { id: 'imaging.edit', title: 'Scans: edit the selected scan', group: 'Imaging', shortcut: 'e', when: () => current()?.source === 'row', run: () => setEditOpen(true) },
      { id: 'imaging.viewer', title: "Scans: open the scan image viewer (the selected scan's images, else the newest)", group: 'Imaging', keywords: 'dicom images series viewer', run: openViewer },
    ],
    [],
  );

  // All scans: the scan's name takes the room; the report leads with its date; the type and body part stay short.
  const columns = useMemo<ColumnDef<ImagingEntry, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (r) => (r.performedAt ? dateSortKey(r.performedAt) : undefined), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.performedAt} precision={row.original.performedAtPrecision} text={row.original.performedAtText} />, meta: { width: 96, shrink: false } },
      { id: 'modality', header: 'Type', accessorFn: (r) => modalityWord(r.modality), meta: { width: 80, maxWidth: 110 } },
      { id: 'title', header: 'Scan', accessorKey: 'title', cell: ({ row }) => row.original.title, meta: { grow: true, minWidth: 160 } },
      { id: 'source', header: 'Report', accessorFn: (r) => sourceLine(r.documentTitle, r.documentId ? (docDates.get(r.documentId) ?? null) : null, r.pageNumber), cell: ({ row }) => <StudySourceLink e={row.original} documentDate={row.original.documentId ? (docDates.get(row.original.documentId) ?? null) : null} />, meta: { grow: true, minWidth: 130 } },
      // What needs a look sorts first: inaccurate, then needs a source, not backed yet, accurate, verified.
      { id: 'status', header: 'Check', accessorFn: (r) => (r.trust ? TRUST_ORDER[r.trust.trust] : 9), cell: ({ row }) => <StudyStatusTag source={row.original.source} trust={row.original.trust} factStatus={row.original.factStatus} factBasis={row.original.factBasis} factDeleted={row.original.factDeleted} />, meta: { width: 100, shrink: false } },
    ],
    [docDates],
  );

  const total = (organised.data?.modalities ?? modalities).reduce((n, x) => n + x.count, 0);
  const anyFilter = Boolean(search.q || search.from || search.to || modality);
  const nothingYet = organised.isSuccess && !organised.isPlaceholderData && total === 0 && !anyFilter;
  const emptyText = 'No scans match these filters. Clear filters (in the toolbar) shows every scan again.';
  const inaccurateCount = rows.filter((r) => r.trust?.trust === 'inaccurate').length;
  const footer = inaccurateCount ? (
    <span>
      {inaccurateCount} disagree{inaccurateCount === 1 ? 's' : ''} with a clinical record (marked red; see Reconciliation)
    </span>
  ) : undefined;
  const filtered = Boolean(search.q || search.from || search.to);
  const serialText = !filtered && study ? serialWordsFor(organised.data?.groups ?? [], study.id) : null;

  const firstRun = (
    <EmptyState
      title="No scans yet"
      action={
        <Button variant="primary" onClick={() => setNewOpen(true)} shortcut="n">
          Add a scan
        </Button>
      }
    >
      Scans appear here by themselves once Claude reads a scan report (MRI, CT, PET and others) from your documents, each with what the report found. You can also type one in.
    </EmptyState>
  );

  const left = active.isPending ? (
    <Loading>Loading the scans…</Loading>
  ) : active.isError ? (
    <Loading>Could not load the scans: {active.error instanceof Error ? active.error.message : 'error'}</Loading>
  ) : view === 'modality' ? (
    <ImagingByModality key="modality" groups={organised.data?.groups ?? []} selectedId={selectedId} onSelect={(s) => select(s?.id ?? null)} onOpen={(s) => openSource(s)} emptyText={emptyText} footer={footer} docDates={docDates} />
  ) : view === 'documents' ? (
    <ImagingByDocument key="documents" documents={docGroups} selectedId={selectedId} onSelect={(s) => select(s?.id ?? null)} onOpen={(s) => openSource(s)} emptyText={emptyText} footer={footer} />
  ) : (
    <DataTable columns={columns} data={items} rowId={(r) => r.id} selectedId={selectedId} onSelect={(r) => select(r?.id ?? null)} onOpen={(r) => openSource(r)} initialSort={[{ id: 'date', desc: true }]} rowClassName={studyRowClass} emptyText={emptyText} footer={footer} tableId="imaging.list" autoFocus />
  );

  const right = !selectedId ? (
    rows.length ? (
      <EmptyState title="Pick a scan">
        See what its report found, how it was checked against your clinical records, and what changed since the scan before it. Move with j and k; Enter opens the report.
      </EmptyState>
    ) : active.isPending ? null : (
      <EmptyState title="Nothing to pick">When the list on the left shows scans, pick one to see what its report found and compare it with the others.</EmptyState>
    )
  ) : detail.isPending ? (
    <Loading>Loading the scan…</Loading>
  ) : !study ? (
    <EmptyState title="This scan is not available">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted, or it is no longer listed. ' : ''}Pick another scan on the left.</EmptyState>
  ) : (
    <ImagingDetail
      key={study.id}
      study={study}
      compareWith={search.compare ?? null}
      dicomDocuments={documents.data ?? []}
      previous={previous}
      serial={serialText}
      busy={busy}
      onEdit={() => setEditOpen(true)}
      onDelete={() => setDeleteOpen(true)}
      onImport={() => study.factId && importFromFacts([study.factId])}
      onCompareWith={(id) => setSearch({ compare: id ?? undefined })}
      onLinkDicom={(id) => patchDicom([...study.dicomDocumentIds, id])}
      onUnlinkDicom={(id) => patchDicom(study.dicomDocumentIds.filter((x) => x !== id))}
      onOpenSource={() => openSource(study)}
    />
  );

  const viewCount = (v: View): number | undefined => (v === 'list' ? total || undefined : v === 'documents' && byDoc.data ? docGroups.length || undefined : undefined);

  return (
    <div className="page">
      <PageHeader
        title="Scans and imaging"
        meta={organised.data ? (scanCountWords(organised.data.modalities) ? <span className="mono">{scanCountWords(organised.data.modalities)}</span> : null) : null}
        intro={IMAGING_INTRO}
        actions={{
          primary: { label: 'Add a scan', onClick: () => setNewOpen(true), shortcut: 'n', title: 'Type in a scan from a report: its type, date, what it found' },
          more: [
            { label: "Copy Claude's scans into my scan list", onClick: () => importFromFacts(), shortcut: 'f', disabled: m.fromFacts.isPending, title: 'Scans Claude read from your documents are already listed here. Copying them into your own scan list lets you edit them and attach their image files; nothing else changes.' },
            { label: 'Open the scan image viewer', onClick: openViewer, title: 'The image files (DICOM) from a scan disc or portal, one series at a time' },
          ],
        }}
      />
      {nothingYet ? null : (
        <Toolbar label="View and filters">
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'modality', label: VIEW_WORDS.modality, count: viewCount('modality'), title: 'Each type of scan, then each body part, with the scans in date order' },
              { value: 'documents', label: VIEW_WORDS.documents, count: viewCount('documents'), title: 'Scans under the report they came from' },
              { value: 'list', label: VIEW_WORDS.list, count: viewCount('list'), title: 'Every scan in one list you can sort' },
            ]}
          />
          {modalities.length > 1 || modality ? (
            <Segmented
              label="Type"
              value={modality}
              onChange={(v) => setSearch({ modality: v || undefined, id: undefined })}
              options={[{ value: '', label: 'All', count: modalities.reduce((n, x) => n + x.count, 0) || undefined, title: 'Every type of scan' }, ...modalities.map((x) => ({ value: x.modality, label: modalityWord(x.modality), count: x.count }))]}
            />
          ) : null}
          <SearchField label="Find" placeholder="Scan, body part or report" value={qLocal} onChange={setQLocal} width={200} />
          <DateRange from={search.from} to={search.to} onChange={(r) => setSearch({ from: r.from, to: r.to })} placeholder="YYYY" />
          <ToolbarKeys
            items={[
              ['j/k', 'move'],
              view !== 'list' ? ['h', 'fold a group'] : null,
              ['enter', 'open the report'],
              ['p', 'compare with previous'],
              ['c', 'compare'],
              ['v v', 'view'],
              ['/', 'find'],
              ['n', 'add'],
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
      <div className="page-body flush">{nothingYet ? firstRun : <SplitView storageKey="imaging" defaultLeft={typeof window !== 'undefined' && window.innerWidth < 1400 ? 58 : 56} minLeft={440} minRight={420} left={left} right={right} />}</div>

      <ImagingFormDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setFormError(null);
        }}
        documents={documents.data ?? []}
        institutions={institutions.data ?? []}
        busy={m.create.isPending}
        error={formError}
        onCreate={(input) =>
          m.create.mutate(input, {
            onSuccess: (s) => {
              setNewOpen(false);
              setFormError(null);
              toast('Scan added', 'ok');
              setSearch({ id: s.id, compare: undefined }, false);
            },
            onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
          })
        }
        onUpdate={() => undefined}
      />
      <ImagingFormDialog
        open={editOpen && Boolean(study && study.source === 'row')}
        onClose={() => {
          setEditOpen(false);
          setFormError(null);
        }}
        entry={study}
        documents={documents.data ?? []}
        institutions={institutions.data ?? []}
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
        title="Delete this scan?"
        body={<span className="muted">The scan is hidden, not erased. The report and anything Claude read from it stay where they are.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const id = latest.current.study?.id;
          if (!id) return;
          m.remove.mutate(id, {
            onSuccess: () => {
              toast('Scan deleted', 'ok');
              select(null);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}
