/**
 * /documents — every file added to the case, list left, the chosen document
 * right (features/documents/DocumentDetail.tsx).
 *
 * The header: Add documents (the one primary), Import a folder, and under More
 * the rarer jobs: likely copies, deleted documents. When documents are waiting
 * to be sorted, a plain line under the toolbar says how many, why (usually
 * added while the API key was not working) and offers "Sort them now", never
 * hidden under More. The toolbar: Find (names and words inside), Type, Show
 * (All · Not sorted yet · Likely copies), and More filters (where it came
 * from, reading, file kind), each labelled. A dot marks a document that is not
 * sorted yet (or has a move the clinician suggested); no row is tinted.
 * Selection and every filter live in the URL. ?view=trash is the deleted
 * documents, with Restore.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { Tag } from '../ui/StatusTag';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { Dialog } from '../ui/Dialog';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { DOCUMENT_CATEGORIES, DOCUMENT_KINDS, SOURCE_TIERS, TEXT_STATUSES } from '@shared/enums';
import { dateSortKey } from '@shared/dates';
import {
  copyWording,
  useDeleteDocument,
  useDocuments,
  useExtractDocument,
  useReingestDocument,
  useUploadDocuments,
  type DocumentFilters,
  type DocumentListItem,
  reprocessWords,
  useReprocessDocuments,
} from '../api/documents';
import { useMe } from '../api/users';
import { DocumentDetailPane } from '../features/documents/DocumentDetail';
import { useFolderImport } from '../features/documents/FolderImport';
import { TrashView } from '../features/documents/TrashView';
import { classifyPendingMessage, useClassifyPendingDocuments, useRebuildBrief, useRetitleDocument, useSetDocumentTier, type DocumentTierFields } from '../features/documents/api';
import { tierWords } from '../features/documents/tier';
import { KIND_WORDS, documentStatus } from '../features/documents/status';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/documents/documents.css';
import '../features/filing/filing.css';
import { backlogMessage, documentTypeLabel, DOCUMENT_TYPE_LABELS, useFileBacklog, useUnsorted, useWaitingByDocument } from '../api/filing';
import { UPLOAD_ACCEPT } from '../features/filing/Filing';
import { isHeldDocument } from '../api/patient-check';
import { HELD_EXPLAIN, HELD_WORDS, MINE_LABEL, NOT_MINE_LABEL, PATIENT_KEYS, heldCountWords } from '../features/patient-check/words';
import { CheckDialog } from '../features/self-check/CheckDialog';
import { SELF_CHECK_KEY, SELF_CHECK_MANY_LABEL } from '../features/self-check/words';

/** The reading status filter in plain words (the values stay the stored ones). */
const READING_WORDS: Record<string, string> = {
  pending: 'Waiting to be read',
  extracting: 'Being read',
  extracted: 'Read',
  ocr_needed: 'Needs reading as a scan',
  ocr_running: 'Being read as a scan',
  ocr_done: 'Read as a scan',
  failed: 'Could not be read',
};

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  category: z.enum(DOCUMENT_CATEGORIES).optional().catch(undefined),
  status: z.enum(TEXT_STATUSES).optional().catch(undefined),
  kind: z.enum(DOCUMENT_KINDS).optional().catch(undefined),
  tier: z.enum(SOURCE_TIERS).optional().catch(undefined),
  /** The trash: deleted documents, with Restore. */
  view: z.enum(['trash']).optional().catch(undefined),
  /** Only the likely copies of older documents. */
  copies: z.enum(['1']).optional().catch(undefined),
  /** Only the documents waiting for a look: not sorted yet, a move the clinician suggested, read in part, or held back as "May be someone else's record". */
  show: z.enum(['unsorted', 'partial', 'held']).optional().catch(undefined),
});

type DocRow = DocumentListItem & DocumentTierFields;
type DocumentsSearch = z.infer<typeof searchSchema>;
type ShowChoice = 'all' | 'unsorted' | 'copies' | 'partial' | 'held';

export const Route = createFileRoute('/documents')({
  validateSearch: (search: Record<string, unknown>): DocumentsSearch => searchSchema.parse(search),
  component: DocumentsPage,
});

function DocumentsPage() {
  const search = Route.useSearch();
  if (search.view === 'trash') return <TrashView />;
  return <LiveDocumentsPage />;
}

function LiveDocumentsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [qInput, setQInput] = useState(search.q ?? '');
  /** The q this page last wrote to the URL itself, so only a change made elsewhere moves the box. */
  const sentQ = useRef(search.q);
  const [over, setOver] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [moreFilters, setMoreFilters] = useState(Boolean(search.status || search.kind || search.tier));
  const copiesOnly = search.copies === '1';
  const unsortedOnly = search.show === 'unsorted';
  const partialOnly = search.show === 'partial';
  const heldOnly = search.show === 'held';
  const show: ShowChoice = copiesOnly ? 'copies' : unsortedOnly ? 'unsorted' : partialOnly ? 'partial' : heldOnly ? 'held' : 'all';
  const waitingByDoc = useWaitingByDocument();
  const unsorted = useUnsorted();
  const unsortedWaiting = (unsorted.data?.items ?? []).filter((u) => !u.sorting).length;
  const unsortedSorting = (unsorted.data?.items.length ?? 0) - unsortedWaiting;
  const folder = useFolderImport();

  // Held-back documents ("May be someone else's record") are listed here, tagged, and nowhere else.
  const docs = useDocuments({ q: search.q, category: search.category, kind: search.kind, textStatus: search.status, tier: search.tier, copies: search.copies, patient: 'include' } as DocumentFilters);
  const upload = useUploadDocuments();
  const del = useDeleteDocument();
  const extract = useExtractDocument();
  const reingest = useReingestDocument();
  const retitle = useRetitleDocument();
  const rebuildBrief = useRebuildBrief();
  const setTier = useSetDocumentTier();
  const classifyPending = useClassifyPendingDocuments();
  const backlog = useFileBacklog();
  const canWrite = useMe().canWrite;

  const listed = (docs.data?.items ?? []) as DocRow[];
  const heldItems = useMemo(() => listed.filter((d) => isHeldDocument(d)), [listed]);
  /** Every document but the held ones (the counts and lines below are about these). */
  const allItems = useMemo(() => listed.filter((d) => !d.deletedAt), [listed]);
  const items = useMemo(
    () => (heldOnly ? heldItems : unsortedOnly ? allItems.filter((d) => waitingByDoc.has(d.id)) : partialOnly ? allItems.filter((d) => documentStatus(d).partial) : copiesOnly ? allItems : listed),
    [listed, allItems, heldItems, heldOnly, unsortedOnly, partialOnly, copiesOnly, waitingByDoc],
  );
  // Documents read in part (2026-10-07): the reading stopped, or pages could not be read; each says which pages.
  const partlyRead = useMemo(() => allItems.filter((d) => documentStatus(d).partial && !documentStatus(d).busy), [allItems]);
  const reprocess = useReprocessDocuments();
  const selectedId = search.id ?? null;
  const selected = useMemo(() => items.find((d) => d.id === selectedId) ?? null, [items, selectedId]);
  const selectedHeld = isHeldDocument(selected);
  // Checked against themselves (2026-10-09): the documents shown, once, from More (the cost is shown first).
  const [checkMany, setCheckMany] = useState(false);
  const checkable = useMemo(() => items.filter((d) => !d.deletedAt && d.pageCount > 0).slice(0, 500), [items]);

  function setSearch(patch: Partial<DocumentsSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  }

  // Debounced search box -> URL.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = qInput.trim() || undefined;
      if (q !== search.q) {
        sentQ.current = q;
        setSearch({ q });
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  // URL -> search box, when ?q= changes from elsewhere (the palette, a link, the back button). The page's own
  // write coming back is ignored, so text typed while it was in flight stays in the box.
  useEffect(() => {
    if (search.q === sentQ.current) return;
    sentQ.current = search.q;
    const q = search.q ?? '';
    setQInput((cur) => (cur.trim() === q ? cur : q));
  }, [search.q]);

  function uploadFiles(files: File[]) {
    if (!files.length) return;
    upload.mutate(
      // Never the Type filter: Claude sorts each new file itself.
      { files },
      {
        // The banner at the top follows the upload until every page is read and analysed (or says what is missing).
        onSuccess: (r) => {
          const first = r.items.find((d) => !d.duplicate) ?? r.items[0];
          if (first) setSearch({ id: first.id });
        },
      },
    );
  }

  function openViewer(id = selectedId) {
    if (id) void navigate({ to: '/documents/$id', params: { id }, search: {} });
  }
  /** A held document is not read until the user answers (It's mine). */
  function heldRefusal(id: string | null): boolean {
    if (!id || !heldItems.some((d) => d.id === id)) return false;
    toast("It may be someone else's record: answer It's mine first.", 'info');
    return true;
  }
  function runExtract(id = selectedId) {
    if (!id || heldRefusal(id)) return;
    extract.mutate({ id }, { onSuccess: () => toast('Claude will pull out the details again'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start pulling out the details', 'bad') });
  }
  function runReingest(id = selectedId, forceOcr = false) {
    if (!id || heldRefusal(id)) return;
    reingest.mutate(
      { id, forceOcr },
      { onSuccess: () => toast(forceOcr ? 'Reading the pages as a scan' : 'Reading the pages again'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start reading the pages again', 'bad') },
    );
  }
  /** Continue reading every document read only in part, from where each stopped (above the limit in Settings, each asks first). */
  function runContinueAll() {
    if (!canWrite || reprocess.isPending || !partlyRead.length) return;
    reprocess.mutate(
      { documentIds: partlyRead.slice(0, 500).map((d) => d.id), scope: 'missing', requestedBy: 'user' },
      { onSuccess: (r) => toast(reprocessWords(r), r.queued.length ? 'ok' : 'info'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad') },
    );
  }
  /** Sort with Claude: every document it has not sorted yet is named, typed and filed (the one sorting action of this page). */
  function runSortAll() {
    if (!canWrite || backlog.isPending) return;
    backlog.mutate(undefined, { onSuccess: (r) => toast(backlogMessage(r), r.aiOff ? 'bad' : 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad') });
  }
  function runClassifyPending() {
    if (!canWrite || classifyPending.isPending) return;
    classifyPending.mutate(undefined, {
      onSuccess: (r) => toast(classifyPendingMessage(r), r.queued ? 'ok' : 'info'),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not start naming the older uploads', 'bad'),
    });
  }
  function showTrash() {
    void navigate({ search: { view: 'trash' }, replace: false });
  }
  function setShow(next: ShowChoice) {
    setSearch({ copies: next === 'copies' ? '1' : undefined, show: next === 'unsorted' ? 'unsorted' : next === 'partial' ? 'partial' : next === 'held' ? 'held' : undefined, id: undefined });
  }
  function toggleCopies(on = !copiesOnly) {
    setShow(on ? 'copies' : 'all');
  }
  function clearFilters() {
    setQInput('');
    setSearch({ q: undefined, category: undefined, status: undefined, kind: undefined, tier: undefined, copies: undefined, show: undefined, id: undefined });
  }
  function focusDetail() {
    document.querySelector<HTMLElement>('.doc-detail')?.focus();
  }

  useBindings(
    [
      { keys: 'n', description: 'Add documents (choose files)', group: 'Documents', when: () => canWrite, run: () => fileInput.current?.click() },
      { keys: 'o', description: 'Open the selected document', group: 'Documents', run: () => openViewer() },
      { keys: 'x', description: 'Pull out the details of the selected document again', group: 'Documents', run: () => runExtract() },
      { keys: 'r', description: 'Read the pages of the selected document again', group: 'Documents', run: () => runReingest() },
      { keys: 'Delete', description: 'Delete the selected document (asks first)', group: 'Documents', run: () => selectedId && setDeleteId(selectedId) },
    ],
    [selectedId],
  );

  useRegisterCommands(
    [
      { id: 'documents.upload', title: 'Documents: add documents', group: 'Documents', shortcut: 'n', keywords: 'add file pdf scan import upload', when: () => canWrite, run: () => fileInput.current?.click() },
      { id: 'documents.viewer', title: 'Documents: open the selected document', group: 'Documents', shortcut: 'o', when: () => Boolean(selectedId), run: () => openViewer() },
      { id: 'documents.extract', title: 'Documents: pull out the details again', group: 'Documents', shortcut: 'x', when: () => Boolean(selectedId), run: () => runExtract() },
      { id: 'documents.reingest', title: 'Documents: read the pages again', group: 'Documents', shortcut: 'r', when: () => Boolean(selectedId), run: () => runReingest() },
      {
        id: 'documents.reingestOcr',
        title: 'Documents: read as a scan',
        group: 'Documents',
        keywords: 'ocr scan text layer force',
        when: () => selected?.kind === 'pdf',
        run: () => runReingest(selectedId, true),
      },
      { id: 'documents.delete', title: 'Documents: delete the selected document', group: 'Documents', shortcut: 'Delete', when: () => Boolean(selectedId), run: () => selectedId && setDeleteId(selectedId) },
      { id: 'documents.sortAll', title: 'Documents: sort the unsorted ones with Claude', group: 'Documents', keywords: 'sort file name classify unsorted backlog', when: () => canWrite, run: runSortAll },
      {
        id: 'documents.classifyPending',
        title: 'Documents: name older uploads with Claude (fills only what is unset)',
        group: 'Documents',
        keywords: 'classify tier title triage backfill older uploads unknown name and sort',
        when: () => canWrite,
        run: runClassifyPending,
      },
      { id: 'documents.trash', title: 'Documents: show deleted documents', group: 'Documents', keywords: 'trash deleted restore undo bin', run: showTrash },
      { id: 'documents.filter.unsorted', title: 'Documents: show the ones not sorted yet', group: 'Documents', keywords: 'unsorted waiting not sorted filter', when: () => !unsortedOnly, run: () => setShow('unsorted') },
      { id: 'documents.filter.copies', title: 'Documents: show likely copies', group: 'Documents', keywords: 'duplicate same document copy filter', when: () => !copiesOnly, run: () => toggleCopies(true) },
      { id: 'documents.filter.allCopies', title: 'Documents: show every document', group: 'Documents', keywords: 'duplicate copy filter clear all', when: () => copiesOnly || unsortedOnly || partialOnly || heldOnly, run: () => setShow('all') },
      { id: 'documents.filter.partial', title: 'Documents: show the ones read only in part', group: 'Documents', keywords: 'partial coverage not read pages missing filter', when: () => !partialOnly, run: () => setShow('partial') },
      { id: 'documents.filter.held', title: "Documents: show the ones that may be someone else's record", group: 'Documents', keywords: "wrong patient twin held back quarantine someone else's filter", when: () => !heldOnly, run: () => setShow('held') },
      { id: 'documents.continueAll', title: 'Documents: continue reading every document read only in part', group: 'Documents', keywords: 'resume partial coverage read rest reprocess bulk', when: () => canWrite && partlyRead.length > 0, run: runContinueAll },
      { id: 'documents.selfCheckMany', title: 'Documents: check the documents shown against themselves (lab flags, contradictions; cost shown first)', group: 'Documents', keywords: 'self check contradiction flag itself many all onboarding facility', when: () => canWrite && checkable.length > 0, run: () => setCheckMany(true) },
      { id: 'documents.search', title: 'Documents: find', group: 'Documents', shortcut: '/', run: () => document.querySelector<HTMLInputElement>('input[data-filter]')?.focus() },
      {
        id: 'documents.retitle',
        title: 'Documents: rename with Claude',
        group: 'Documents',
        shortcut: 't',
        keywords: 'classify title name',
        when: () => Boolean(selectedId),
        run: () => {
          if (selectedId) retitle.mutate(selectedId, { onSuccess: () => toast('Claude will rename it'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not start the rename', 'bad') });
        },
      },
      {
        id: 'documents.brief.rebuild',
        title: 'Documents: put the summary together again',
        group: 'Documents',
        keywords: 'summary sheet ledger brief rebuild',
        when: () => Boolean(selectedId),
        run: () => {
          if (selectedId) rebuildBrief.mutate(selectedId, { onSuccess: () => toast('Summary put together again', 'ok') });
        },
      },
      ...SOURCE_TIERS.filter((t) => t !== 'unknown').map((t) => ({
        id: `documents.tier.${t}`,
        title: `Documents: mark where it came from: ${tierWords(t).label}`,
        group: 'Documents',
        keywords: 'tier primary patient compilation external source',
        when: () => Boolean(selectedId),
        run: () => {
          if (selectedId) setTier.mutate({ id: selectedId, sourceTier: t }, { onSuccess: () => toast(`Marked as: ${tierWords(t).label}`, 'ok') });
        },
      })),
      ...SOURCE_TIERS.map((t) => ({
        id: `documents.filter.tier.${t}`,
        title: `Documents: show only: ${tierWords(t).label}`,
        group: 'Documents',
        keywords: 'filter tier source',
        run: () => {
          setMoreFilters(true);
          setSearch({ tier: t, id: undefined });
        },
      })),
    ],
    [selectedId, selected?.kind, canWrite, classifyPending.isPending, backlog.isPending, copiesOnly, unsortedOnly, partialOnly, heldOnly, partlyRead.length, reprocess.isPending, heldItems.length, checkable.length],
  );

  const columns = useMemo<ColumnDef<DocRow, unknown>[]>(
    () => [
      {
        id: 'waiting',
        header: '',
        accessorFn: (d) => (waitingByDoc.has(d.id) ? 1 : 0),
        cell: ({ row }) => (waitingByDoc.has(row.original.id) ? <span className="waiting-dot" title={(waitingByDoc.get(row.original.id)?.length ?? 0) > 0 ? 'The clinician suggested filing this differently' : 'Not sorted yet: Claude has not named or filed it'} /> : null),
        meta: { width: 28, grow: false },
      },
      {
        id: 'date',
        header: 'Date',
        accessorFn: (d) => dateSortKey(d.documentDate),
        cell: ({ row }) => <DateText iso={row.original.documentDate} precision={row.original.documentDatePrecision} text={row.original.documentDateText} />,
        meta: { width: 104 },
      },
      {
        id: 'title',
        header: 'Name',
        accessorKey: 'title',
        meta: { grow: true, minWidth: 240 },
        cell: ({ row }) => {
          const d = row.original;
          const st = documentStatus(d);
          return (
            <>
              <KeepDatesWhole text={d.title} />
              {isHeldDocument(d) ? (
                <span className="doc-copy-tag">
                  <Tag tone="warn" title="Held back: nothing is read or filed from it until you answer It's mine or Not my record">
                    {HELD_WORDS}
                  </Tag>
                </span>
              ) : null}
              {!st.quiet && !isHeldDocument(d) ? <span className={st.bad ? 'doc-name-status bad' : 'doc-name-status'}> · {st.words}</span> : null}
              {d.institutionName ? <span className="doc-name-place"> · {d.institutionName}</span> : null}
              {d.likelyCopyOf ? (
                <span className="doc-copy-tag">
                  <Tag title={`Looks like a copy of "${d.likelyCopyOf.title}" (${copyWording(d.likelyCopyOf.similarity)})`}>likely copy</Tag>
                </span>
              ) : null}
            </>
          );
        },
      },
      // The type wraps to two lines ("Procedure or surgery / report") rather than ending with "…" in a narrow pane.
      { id: 'category', header: 'Type', accessorFn: (d) => documentTypeLabel(d.category), cell: ({ getValue }) => <span className="muted">{String(getValue())}</span>, meta: { width: 130, maxWidth: 200, wrap: true } },
    ],
    [waitingByDoc],
  );

  function onDragOver(e: DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    if (!over) setOver(true);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    uploadFiles(Array.from(e.dataTransfer.files));
  }

  const reading = allItems.filter((d) => documentStatus(d).busy).length;
  const notSorted = allItems.filter((d) => waitingByDoc.has(d.id)).length;
  const anyFilter = Boolean(search.q || search.category || search.status || search.kind || search.tier || copiesOnly || unsortedOnly || partialOnly || heldOnly);
  const nothingYet = !docs.isPending && !listed.length && !anyFilter;
  const moreOn = [search.tier, search.status, search.kind].filter(Boolean).length;

  return (
    <div className="page">
      <PageHeader
        title="Documents"
        meta={docs.isPending ? null : `${allItems.length} document${allItems.length === 1 ? '' : 's'}${reading ? ` · Claude is reading ${reading}` : ''}${heldItems.length ? ` · ${heldItems.length} held back` : ''}${upload.isPending ? ' · adding…' : ''}`}
        intro="Every file you have added. Claude reads each one, names it and files what it holds with your labs, calls and appointments; a dot marks one it has not sorted yet."
        actions={{
          primary: canWrite ? { label: upload.isPending ? 'Adding…' : 'Add documents', onClick: () => fileInput.current?.click(), shortcut: 'n', disabled: upload.isPending, title: 'Choose files from this computer (PDFs, scans, photos, Word files, call transcripts); you can also drop them on the list' } : null,
          secondary: [folder.allowed ? { label: 'Import a folder', onClick: folder.open, shortcut: 'i', title: 'Copy every supported file in a folder on this computer into the case; the folder itself is only read' } : null],
          more: [
            { label: copiesOnly ? 'Show every document' : 'Show likely copies', onClick: () => toggleCopies(), title: 'Documents that look like a copy of one added earlier (the same wording and numbers). Nothing is removed on its own.' },
            canWrite && checkable.length ? { label: SELF_CHECK_MANY_LABEL, onClick: () => setCheckMany(true), title: 'Each document shown is checked against itself only: its lab flags, and Claude reading it for contradictions. You see the cost first.' } : null,
            'separator',
            { label: 'Deleted documents', onClick: showTrash, title: 'Documents you deleted, which you can restore' },
          ],
        }}
      />
      {folder.dialog}
      {checkMany ? <CheckDialog open onClose={() => setCheckMany(false)} documentIds={checkable.map((d) => d.id)} what={`The ${checkable.length} document${checkable.length === 1 ? '' : 's'} shown`} /> : null}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          uploadFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Toolbar label="Find and filters">
        <SearchField label="Find" placeholder="Name, or words in the text" value={qInput} onChange={setQInput} width={230} />
        <FilterGroup label="Type">
          <Select value={search.category ?? ''} options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: DOCUMENT_TYPE_LABELS[c] ?? c }))} placeholder="Every type" onChange={(e) => setSearch({ category: (e.target.value || undefined) as DocumentsSearch['category'] })} aria-label="Type" />
        </FilterGroup>
        <Segmented
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: 'all', label: 'All', title: 'Every document' },
            { value: 'unsorted', label: 'Not sorted yet', count: notSorted || undefined, title: 'Documents Claude has not named or filed yet, or with a move the clinician suggested' },
            { value: 'copies', label: 'Likely copies', title: 'Documents that look like a copy of one added earlier' },
            ...(partlyRead.length || partialOnly ? [{ value: 'partial' as const, label: 'Read in part', count: partlyRead.length || undefined, title: 'Documents Claude read only part of: the reading stopped, or some pages could not be read' }] : []),
            ...(heldItems.length || heldOnly ? [{ value: 'held' as const, label: HELD_WORDS, count: heldItems.length || undefined, title: "Held back: the pages name someone else. Nothing is read or filed from them until you answer" }] : []),
          ]}
        />
        <Button size="sm" variant="ghost" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
          {moreFilters ? 'Fewer filters' : `More filters${moreOn ? ` (${moreOn} on)` : ''}`}
        </Button>
        {moreFilters ? (
          <>
            <FilterGroup label="From">
              <Select value={search.tier ?? ''} options={SOURCE_TIERS.map((t) => ({ value: t, label: tierWords(t).label }))} placeholder="Anywhere" onChange={(e) => setSearch({ tier: (e.target.value || undefined) as DocumentsSearch['tier'] })} aria-label="Where it came from" />
            </FilterGroup>
            <FilterGroup label="Reading">
              <Select value={search.status ?? ''} options={TEXT_STATUSES.map((t) => ({ value: t, label: READING_WORDS[t] ?? t }))} placeholder="Any" onChange={(e) => setSearch({ status: (e.target.value || undefined) as DocumentsSearch['status'] })} aria-label="Reading" />
            </FilterGroup>
            <FilterGroup label="File">
              <Select value={search.kind ?? ''} options={DOCUMENT_KINDS.map((k) => ({ value: k, label: KIND_WORDS[k] ?? k }))} placeholder="Any kind" onChange={(e) => setSearch({ kind: (e.target.value || undefined) as DocumentsSearch['kind'] })} aria-label="File kind" />
            </FilterGroup>
          </>
        ) : null}
        <ToolbarKeys
          items={[
            ['n', 'add'],
            ['j/k', 'move'],
            ['enter', 'to the document'],
            ['o', 'open'],
            ['x', 'pull out details'],
            ['b', 'edit details'],
            selectedId && canWrite && !selectedHeld ? [SELF_CHECK_KEY, 'check against itself'] : null,
            ['/', 'find'],
            ...(heldOnly || selectedHeld ? ([[PATIENT_KEYS.mine, MINE_LABEL.toLowerCase()], [PATIENT_KEYS.notMine, NOT_MINE_LABEL.toLowerCase()]] as Array<[string, string]>) : []),
          ]}
        >
          {anyFilter ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      {unsortedWaiting || unsortedSorting ? (
        // Documents waiting to be sorted: how many, why, and the one action, in plain sight (never only under More).
        <div className="doc-backlog" role="status">
          <span className="doc-backlog-words">
            {unsortedWaiting ? (
              <>
                <strong>
                  {unsortedWaiting} document{unsortedWaiting === 1 ? '' : 's'} not sorted yet.
                </strong>{' '}
                Claude has not named, typed or filed {unsortedWaiting === 1 ? 'it' : 'them'}, usually because {unsortedWaiting === 1 ? 'it was' : 'they were'} added while the API key was not working. A dot marks {unsortedWaiting === 1 ? 'it' : 'each'} in the list.
              </>
            ) : null}
            {unsortedSorting ? <span className="muted"> Claude is sorting {unsortedSorting} now…</span> : null}
          </span>
          {canWrite && unsortedWaiting ? (
            <Button size="sm" variant="accent" disabled={backlog.isPending} onClick={runSortAll} title="Claude names, types and files every document it has not sorted yet">
              {backlog.isPending ? 'Starting…' : 'Sort them now'}
            </Button>
          ) : null}
          {unsortedWaiting && !unsortedOnly ? (
            <Button size="sm" variant="ghost" onClick={() => setShow('unsorted')} title="List only the documents not sorted yet">
              Show them
            </Button>
          ) : null}
        </div>
      ) : null}
      {heldItems.length && !heldOnly ? (
        // Held back as "May be someone else's record": how many, what it means, and where to answer.
        <div className="doc-backlog" role="status">
          <span className="doc-backlog-words">
            <strong>{heldCountWords(heldItems.length)}</strong> {HELD_EXPLAIN}
          </span>
          <Button size="sm" variant="accent" onClick={() => setShow('held')} title="List them, with It's mine and Not my record">
            Show them
          </Button>
        </div>
      ) : null}
      {partlyRead.length && !partialOnly ? (
        // Read only in part: how many, what it means, and the one action (each document says which pages are missing).
        <div className="doc-backlog doc-partial-line" role="status">
          <span className="doc-backlog-words">
            <strong>
              {partlyRead.length} document{partlyRead.length === 1 ? '' : 's'} read only in part.
            </strong>{' '}
            Claude has details from some of {partlyRead.length === 1 ? 'its' : 'their'} pages; the rest {partlyRead.length === 1 ? 'is' : 'are'} not read yet or could not be read. Each one says which pages.
          </span>
          {canWrite ? (
            <Button size="sm" variant="accent" disabled={reprocess.isPending} onClick={runContinueAll} title="Claude carries on from where each one stopped; above your limit in Settings it asks first">
              {reprocess.isPending ? 'Starting…' : 'Continue reading them'}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setShow('partial')} title="List only the documents read in part">
            Show them
          </Button>
        </div>
      ) : null}
      <div className="page-body flush">
        {nothingYet ? (
          <div className="doc-list" data-own-drop onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            {over ? <div className="dropzone over doc-drop-overlay">Drop to add to the case</div> : null}
            <EmptyState
              title="No documents yet"
              action={
                canWrite ? (
                  <Button variant="primary" onClick={() => fileInput.current?.click()} shortcut="n">
                    Add documents
                  </Button>
                ) : undefined
              }
            >
              Add the files of the case (PDFs, scans, photos, Word files, call transcripts): drop them here, or choose them. Claude reads each one, names it and files what it holds.
            </EmptyState>
          </div>
        ) : (
          <SplitView
            storageKey="documents"
            defaultLeft={52}
            minLeft={420}
            minRight={460}
            left={
              <div
                className="doc-list"
                data-own-drop
                onDragOver={onDragOver}
                onDragEnter={onDragOver}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
                }}
                onDrop={onDrop}
              >
                {over ? <div className="dropzone over doc-drop-overlay">Drop to add to the case</div> : null}
                {docs.isPending ? (
                  <Loading>Loading the documents…</Loading>
                ) : (
                  <DataTable
                    columns={columns}
                    data={items}
                    rowId={(d) => d.id}
                    selectedId={selectedId}
                    onSelect={(row) => setSearch({ id: row?.id })}
                    onOpen={() => focusDetail()}
                    initialSort={[{ id: 'date', desc: true }]}
                    emptyText={docs.isError ? 'Could not load the documents.' : copiesOnly ? 'No likely copies.' : unsortedOnly ? 'Every document is sorted.' : partialOnly ? 'Every document was read in full.' : heldOnly ? 'Nothing is held back.' : 'No documents match. Clear filters (in the toolbar) shows them all.'}
                    rowClassName={(d) => (d.textStatus === 'failed' || isHeldDocument(d) ? 'dim' : undefined)}
                    tableId="documents.list"
                    autoFocus
                    footer={notSorted && !unsortedOnly && !unsortedWaiting ? <span>A dot marks {notSorted === 1 ? 'the one document' : `the ${notSorted} documents`} waiting for a look.</span> : undefined}
                  />
                )}
              </div>
            }
            right={
              <DocumentDetailPane
                id={selectedId}
                onRequestDelete={(id) => setDeleteId(id)}
                onSetAside={(id) => {
                  if (selectedId === id) setSearch({ id: undefined });
                }}
              />
            }
          />
        )}
      </div>
      <DeleteDialog
        open={Boolean(deleteId)}
        title={allItems.find((d) => d.id === deleteId)?.title ?? 'This document'}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          const id = deleteId;
          if (!id) return;
          del.mutate(id, {
            onSuccess: () => {
              toast('Moved to Deleted documents (under More on this page); you can restore it there.', 'ok');
              if (selectedId === id) setSearch({ id: undefined });
            },
            onError: (err) => toast(err instanceof Error ? err.message : 'Delete failed', 'bad'),
          });
        }}
      />
    </div>
  );
}

/**
 * The delete confirmation. Cancel holds the focus when it opens, so the
 * Delete key followed by Enter never removes a document by accident.
 */
function DeleteDialog({ open, title, onClose, onConfirm }: { open: boolean; title: string; onClose: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Runs after Dialog's own effect has opened the native dialog (child effects run first).
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete document"
      footer={
        <>
          <button type="button" className="btn" ref={cancelRef} onClick={onClose}>
            Cancel
          </button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="stack">
        <strong>{title}</strong>
        <span>It and the details Claude pulled from it move to Deleted documents. Restoring brings everything back with your checks. The original file is kept.</span>
      </div>
    </Dialog>
  );
}
