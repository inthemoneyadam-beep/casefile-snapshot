/**
 * /records — the Records checklist: which records exist, which you have, which
 * you asked for, and which your documents mention but you do not have yet.
 * Split view: the list left, the selected row right (features/records/*).
 *
 * The header: Add a record (the one primary) and Add your documents to the
 * checklist. The toolbar, each part labelled:
 *   Show:  All · Missing · Asked for · Have (with counts)
 *   Type:  any record type     From: any place (only when places exist)
 *   Find:  record name or place
 * then Clear filters and the keys; one line under it says what the list holds.
 * The list: Date · Record (takes the room) · Type · From (only when a row has a
 * place) · Where it stands (the status and its date). Missing: Date · What ·
 * Type · Mentioned in (the document's date first) · Maybe here (a guess).
 * With nothing on the checklist and nothing missing, the page says what it is
 * for and offers both first steps. Selection and filters live in the URL.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { dateSortKey } from '@shared/dates';
import { Button } from '../ui/Button';
import { Confirm, Dialog } from '../ui/Dialog';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { Select } from '../ui/Field';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { Tag } from '../ui/StatusTag';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { dialogOpen } from '../app/dom';
import {
  useCreateRecord,
  useDeleteRecord,
  useDocumentsLite,
  useFromDocument,
  useGaps,
  useInstitutions,
  useMaterialize,
  useRecord,
  useRecords,
  useTransition,
  useUpdateRecord,
  type DocumentLite,
  type Gap,
  type RecordInput,
  type RecordRow,
  type Transition,
} from '../api/records';
import { documentTypeLabel } from '../api/filing';
import { RecordDetail, statusDate, type RecordActions } from '../features/records/RecordDetail';
import { GapDetail } from '../features/records/GapDetail';
import { ReceiveDialog, type ReceivePayload, type ReceiveSuggestion } from '../features/records/ReceiveDialog';
import { likelyBasis, suggestedLinkNote } from '../features/records/likely';
import { RECORDS_INTRO, RECORDS_VIEW_INTRO, RECORDS_VIEW_WORDS, RECORDS_VIEWS, TRANSITION_TITLE, TRANSITION_WORDS, type RecordsView } from '../features/records/page';
import { RECORD_TYPE_OPTIONS, RecordStatus, recordStatusWords, recordTypeWords } from '../features/records/words';
import { sourceLine } from '../features/labs/source';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/records/records.css';

type View = RecordsView;
const NEW_ID = 'new';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  view: z.enum(RECORDS_VIEWS).optional().catch(undefined),
  recordType: z.string().optional().catch(undefined),
  institutionId: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/records')({ component: RecordsPage, validateSearch: searchSchema });

/**
 * Document categories that are compilations or correspondence rather than
 * records to track. "Add your documents to the checklist" skips them unless asked.
 */
const NON_RECORD_CATEGORIES = new Set(['summary', 'dossier', 'letter', 'call_transcript']);

/** "2 summaries, 1 letter" in the words of the Documents page. */
function categoryCounts(docs: DocumentLite[]): string {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${documentTypeLabel(c).toLowerCase()} ${n}`).join(', ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function sortableDate(iso: string | null): string {
  return iso ? dateSortKey(iso) : '';
}

/** Where a row stands: its status in words and the date that goes with it. */
function StandsCell({ r }: { r: RecordRow }) {
  const when = statusDate(r);
  return (
    <span className="records-status">
      <RecordStatus status={r.status} />
      {when ? <DateText iso={when} className="muted" /> : null}
    </span>
  );
}

function RecordsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const toast = useToast();
  const view: View = search.view ?? 'all';
  const selectedId = search.id ?? null;

  const records = useRecords();
  const gaps = useGaps();
  const institutions = useInstitutions();
  const documents = useDocumentsLite();
  const create = useCreateRecord();
  const update = useUpdateRecord();
  const remove = useDeleteRecord();
  const transition = useTransition();
  const materialize = useMaterialize();
  const fromDocument = useFromDocument();

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The record form has unsaved edits: transitions and navigation that would re-seed it are refused. */
  const [formDirty, setFormDirty] = useState(false);
  /** A not-held/denied transition waiting for the user to confirm unlinking the row's document. */
  const [confirmUnlink, setConfirmUnlink] = useState<'not-held' | 'denied' | null>(null);
  /** "Add your documents to the checklist": what would be created, shown in a confirm first. */
  const [bulkPlan, setBulkPlan] = useState<{ records: DocumentLite[]; other: DocumentLite[] } | null>(null);
  const [bulkIncludeOther, setBulkIncludeOther] = useState(false);

  const setSearch = useCallback(
    (patch: Partial<Search>, replace = false) => {
      void navigate({ to: '/records', search: (prev) => ({ ...prev, ...patch }), replace });
    },
    [navigate],
  );

  // ---- data for the current view ----------------------------------------
  const allRows = useMemo(() => records.data?.items ?? [], [records.data]);
  const allGaps = useMemo(() => gaps.data?.items ?? [], [gaps.data]);
  const matchesFilters = useCallback(
    (recordType: string, institutionId: string | null) => (!search.recordType || recordType === search.recordType) && (!search.institutionId || institutionId === search.institutionId),
    [search.recordType, search.institutionId],
  );
  const filteredRows = useMemo(() => allRows.filter((r) => matchesFilters(r.recordType, r.institutionId)), [allRows, matchesFilters]);
  const filteredGaps = useMemo(() => allGaps.filter((g) => matchesFilters(g.recordType, g.institutionId)), [allGaps, matchesFilters]);
  const counts: Record<View, number> = {
    all: filteredRows.length,
    gaps: filteredGaps.length,
    requested: filteredRows.filter((r) => r.status === 'requested').length,
    held: filteredRows.filter((r) => r.held).length,
  };
  const viewRows = useMemo(() => (view === 'held' ? filteredRows.filter((r) => r.held) : view === 'requested' ? filteredRows.filter((r) => r.status === 'requested') : filteredRows), [view, filteredRows]);

  // ---- selection -----------------------------------------------------------
  const isNew = selectedId === NEW_ID;
  const selectedGap = view === 'gaps' && selectedId ? (filteredGaps.find((g) => g.id === selectedId) ?? null) : null;
  const listRow = selectedId && !isNew ? (allRows.find((r) => r.id === selectedId) ?? null) : null;
  // A row id to show in the detail: the selected row, or the inventory row behind an inventory gap,
  // or (after a transition from the Missing view) a row that is no longer a gap.
  const detailRecordId = isNew ? null : selectedGap ? (selectedGap.kind === 'inventory' ? selectedGap.id : null) : selectedId;
  const fetched = useRecord(detailRecordId);
  const detailRecord: RecordRow | null = detailRecordId ? (fetched.data ?? listRow) : null;

  // ---- actions (latest-ref so key bindings never go stale) ------------------
  const busy = create.isPending || update.isPending || remove.isPending || transition.isPending || materialize.isPending || fromDocument.isPending;

  /**
   * True (with a toast) while the record form has unsaved edits. Any status
   * change re-seeds the form from the server row, and Save sends the whole
   * form, so edits must be saved or discarded before a transition runs.
   */
  function blockedByEdits(): boolean {
    if (!formDirty) return false;
    toast('Save or discard the edits to this record first.');
    return true;
  }

  /** Change the selection or view, unless that would drop unsaved edits. */
  function select(patch: Partial<Search>, replace = false) {
    const sameSelection = (!('id' in patch) || patch.id === selectedId) && (!('view' in patch) || patch.view === view);
    if (!sameSelection && blockedByEdits()) return;
    setSearch(patch, replace);
  }

  /** The inventory row id for the selection, creating it from an inferred gap when needed. */
  async function ensureRecordId(): Promise<string | null> {
    if (detailRecordId) return detailRecordId;
    if (selectedGap?.kind === 'inferred' && selectedGap.sourceFactId) {
      const row = await materialize.mutateAsync(selectedGap.sourceFactId);
      return row.id;
    }
    return null;
  }

  async function doMaterialize() {
    if (!selectedGap || selectedGap.kind !== 'inferred' || !selectedGap.sourceFactId) {
      toast('Pick a record that a document mentions, under Show: Missing, first.');
      return;
    }
    try {
      const row = await materialize.mutateAsync(selectedGap.sourceFactId);
      toast(`Added "${row.title}" to the checklist as missing.`, 'ok');
      setSearch({ id: row.id });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the row.', 'bad');
    }
  }

  async function doTransition(kind: Transition, body?: ReceivePayload, opts: { confirmedUnlink?: boolean } = {}) {
    if (blockedByEdits()) return;
    if ((kind === 'not-held' || kind === 'denied') && detailRecord?.documentId && !opts.confirmedUnlink) {
      // The row links its held copy: marking it not held or denied unlinks that document, so ask first.
      setConfirmUnlink(kind);
      return;
    }
    try {
      const id = await ensureRecordId();
      if (!id) {
        toast('Pick a record first.');
        return;
      }
      const row = await transition.mutateAsync({ id, kind, body: body ?? {} });
      toast(`Marked ${TRANSITION_WORDS[kind]}: ${row.title}`, 'ok');
      if (selectedId !== row.id) setSearch({ id: row.id });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The change did not work.', 'bad');
    }
  }

  function openReceive() {
    if (!detailRecordId && !(selectedGap?.kind === 'inferred')) {
      toast('Pick a record first.');
      return;
    }
    if (blockedByEdits()) return;
    setReceiveOpen(true);
  }

  /** "Mark received with it": link the likely-held document to the selected inventory gap row (no second row). */
  function receiveSuggested(documentId: string) {
    const g = selectedGap?.likelyHeldDocumentId === documentId ? selectedGap : null;
    const note = g ? suggestedLinkNote(g, g.likelyHeldDocumentTitle) : null;
    void doTransition('receive', { documentId, receivedAt: null, note });
  }

  function askRemove() {
    if (!detailRecordId || blockedByEdits()) return;
    setConfirmDelete(true);
  }

  async function doRemove() {
    if (!detailRecordId) return;
    try {
      await remove.mutateAsync(detailRecordId);
      toast('Removed from the checklist.', 'ok');
      setSearch({ id: undefined });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it.', 'bad');
    }
  }

  /**
   * Create (or reuse) the held row for a document. With `sourceFactId` (an
   * inferred gap's "this is the record"), the row remembers the fact so the
   * gap resolves. When the document's row already answers another reference,
   * this gap gets its own row, received with the same document.
   */
  async function doFromDocument(documentId: string, recordType?: string, sourceFactId?: string | null) {
    if (blockedByEdits()) return;
    try {
      const row = await fromDocument.mutateAsync({ documentId, recordType, sourceFactId: sourceFactId ?? undefined });
      if (sourceFactId && !row.factLinked) {
        const own = await materialize.mutateAsync(sourceFactId);
        const note = `Received copy is "${row.documentTitle ?? 'the linked document'}", which also backs the row "${row.title}" for another reference.`;
        const received = await transition.mutateAsync({ id: own.id, kind: 'receive', body: { documentId, note } });
        toast(`That document is already the copy of "${row.title}"; this mention got its own row, received with it.`, 'ok');
        setSearch({ view: undefined, id: received.id });
        return;
      }
      if (sourceFactId) toast(row.existing ? `Linked this mention to the row you have: ${row.title}` : `Added a row you have for this mention: ${row.title}`, 'ok');
      else toast(row.existing ? `Already on the checklist: ${row.title}` : `Added: ${row.title}`, 'ok');
      setSearch({ view: undefined, id: row.id });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the row.', 'bad');
    }
  }

  /** Work out which documents have no row yet and ask before creating any. */
  async function planFromDocuments() {
    let docs: DocumentLite[] = [];
    try {
      docs = (await documents.refetch()).data ?? [];
    } catch {
      docs = [];
    }
    if (!docs.length) {
      toast('No documents are in the case yet.');
      return;
    }
    const linked = new Set(allRows.map((r) => r.documentId).filter(Boolean));
    const missing = docs.filter((d) => !linked.has(d.id));
    if (!missing.length) {
      toast('Every document already has a row on the checklist.');
      return;
    }
    setBulkIncludeOther(false);
    setBulkPlan({ records: missing.filter((d) => !NON_RECORD_CATEGORIES.has(d.category)), other: missing.filter((d) => NON_RECORD_CATEGORIES.has(d.category)) });
  }

  async function runFromDocuments(docs: DocumentLite[]) {
    let created = 0;
    let failed = 0;
    for (const d of docs) {
      try {
        const row = await fromDocument.mutateAsync({ documentId: d.id });
        if (!row.existing) created++;
      } catch {
        failed++;
      }
    }
    void qc.invalidateQueries({ queryKey: ['records'] });
    toast(`Added ${plural(created, 'row')} from your documents${failed ? `; ${failed} could not be added` : ''}. Remove any you do not want from its pane (More).`, failed ? 'bad' : 'ok');
  }

  function startNew() {
    select({ id: NEW_ID });
  }

  function focusEdit() {
    const el = document.querySelector<HTMLInputElement>('[data-record-title]');
    if (el) {
      el.focus();
      el.select();
    } else if (selectedGap?.kind === 'inferred') {
      toast('Add it to the checklist first (m); then it can be edited.');
    } else {
      toast('Pick a record to edit, or add one with n.');
    }
  }

  function openSelected(target?: RecordRow | Gap) {
    const t = target ?? selectedGap ?? listRow;
    if (!t) return;
    if ('kind' in t && t.kind === 'inferred') {
      if (blockedByEdits()) return;
      if (t.citation) void navigate({ to: '/documents/$id', params: { id: t.citation.documentId }, search: { page: t.citation.pageNumber, cite: t.citation.citationId } });
      else if (t.sourceDocumentId) void navigate({ to: '/documents/$id', params: { id: t.sourceDocumentId } });
      return;
    }
    const documentId = 'kind' in t ? (allRows.find((r) => r.id === t.id)?.documentId ?? null) : t.documentId;
    if (documentId) {
      if (!blockedByEdits()) void navigate({ to: '/documents/$id', params: { id: documentId } });
    } else focusEdit();
  }

  function clearFilters() {
    setSearch({ recordType: undefined, institutionId: undefined, q: undefined }, true);
  }

  const inferredSelected = selectedGap?.kind === 'inferred';
  const page = {
    doMaterialize,
    doTransition,
    openReceive,
    askRemove,
    startNew,
    focusEdit,
    openSelected,
    planFromDocuments,
    select,
    dialogOpen,
    hasRecord: Boolean(detailRecordId),
    hasTarget: Boolean(detailRecordId) || inferredSelected,
    inferredSelected,
  };
  const latest = useRef(page);
  latest.current = page;

  // `i` marks received: a plain `v` would shadow the global `v t` / `v b` / `v r` appearance chords.
  useBindings(
    [
      { keys: 'n', description: 'Add a record', group: 'Lists', run: () => !latest.current.dialogOpen() && latest.current.startNew() },
      { keys: 'e', description: 'Edit the selected record', group: 'Lists', run: () => !latest.current.dialogOpen() && latest.current.focusEdit() },
      { keys: 'm', description: 'Add the missing record to the checklist', group: 'Lists', run: () => !latest.current.dialogOpen() && void latest.current.doMaterialize() },
      { keys: 'r', description: 'Mark the record asked for (today)', group: 'Lists', run: () => !latest.current.dialogOpen() && void latest.current.doTransition('request') },
      { keys: 'i', description: 'Mark the record received (and name the copy)', group: 'Lists', run: () => !latest.current.dialogOpen() && latest.current.openReceive() },
      { keys: 'h', description: 'Mark that they have no such record', group: 'Lists', run: () => !latest.current.dialogOpen() && void latest.current.doTransition('not-held') },
      { keys: 'x', description: 'Mark that they refused to send it', group: 'Lists', run: () => !latest.current.dialogOpen() && void latest.current.doTransition('denied') },
      { keys: 'Delete', description: 'Remove the selected record from the checklist (asks first)', group: 'Lists', run: () => !latest.current.dialogOpen() && latest.current.askRemove() },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'records.gaps', title: 'Records checklist: show missing records', group: 'Records checklist', keywords: 'missing records gap gaps inventory', run: () => latest.current.select({ view: 'gaps', id: undefined }) },
      { id: 'records.new', title: 'Records checklist: add a record', group: 'Records checklist', keywords: 'add record inventory new row', shortcut: 'n', run: () => latest.current.startNew() },
      { id: 'records.fromDocuments', title: 'Records checklist: add your documents to the checklist…', group: 'Records checklist', keywords: 'documents held inventory sync rows add from documents', run: () => void latest.current.planFromDocuments() },
      { id: 'records.requested', title: 'Records checklist: show what you asked for', group: 'Records checklist', keywords: 'requested', run: () => latest.current.select({ view: 'requested', id: undefined }) },
      { id: 'records.held', title: 'Records checklist: show what you have', group: 'Records checklist', keywords: 'held', run: () => latest.current.select({ view: 'held', id: undefined }) },
      // Actions on the selection: the same handlers as the keys.
      { id: 'records.edit', title: 'Records checklist: edit the selected record', group: 'Records checklist', keywords: 'change update form', shortcut: 'e', when: () => latest.current.hasRecord, run: () => latest.current.focusEdit() },
      { id: 'records.materialize', title: 'Records checklist: add the missing record to the checklist', group: 'Records checklist', keywords: 'materialise materialize expected gap inventory', shortcut: 'm', when: () => latest.current.inferredSelected, run: () => void latest.current.doMaterialize() },
      { id: 'records.request', title: 'Records checklist: mark asked for', group: 'Records checklist', keywords: 'request requested status', shortcut: 'r', when: () => latest.current.hasTarget, run: () => void latest.current.doTransition('request') },
      { id: 'records.receive', title: 'Records checklist: mark received…', group: 'Records checklist', keywords: 'received link document held status', shortcut: 'i', when: () => latest.current.hasTarget, run: () => latest.current.openReceive() },
      { id: 'records.notHeld', title: 'Records checklist: they have none', group: 'Records checklist', keywords: 'not held status missing', shortcut: 'h', when: () => latest.current.hasTarget, run: () => void latest.current.doTransition('not-held') },
      { id: 'records.denied', title: 'Records checklist: they refused', group: 'Records checklist', keywords: 'denied refused status', shortcut: 'x', when: () => latest.current.hasTarget, run: () => void latest.current.doTransition('denied') },
      { id: 'records.remove', title: 'Records checklist: remove the selected row…', group: 'Records checklist', keywords: 'delete remove', shortcut: 'Delete', when: () => latest.current.hasRecord, run: () => latest.current.askRemove() },
    ],
    [],
  );

  const actions: RecordActions = {
    transition: (kind) => void doTransition(kind),
    receive: openReceive,
    receiveDocument: receiveSuggested,
    materialize: () => void doMaterialize(),
    remove: askRemove,
    fromDocument: (documentId, recordType, sourceFactId) => void doFromDocument(documentId, recordType, sourceFactId),
    edit: focusEdit,
    openDocument: (documentId) => {
      if (!blockedByEdits()) void navigate({ to: '/documents/$id', params: { id: documentId } });
    },
  };

  async function save(body: RecordInput) {
    if (isNew) {
      const row = await create.mutateAsync(body);
      toast(`Added "${row.title}" to the checklist.`, 'ok');
      setSearch({ id: row.id });
    } else if (detailRecordId) {
      await update.mutateAsync({ id: detailRecordId, body });
      toast('Saved.', 'ok');
    }
  }

  // ---- columns ---------------------------------------------------------------
  const docDates = useMemo(() => new Map((documents.data ?? []).map((d) => [d.id, d.documentDate] as const)), [documents.data]);
  // "From" only when a row names a place: a column of dashes says nothing.
  const anyPlace = allRows.some((r) => r.institutionName);
  const recordColumns = useMemo<ColumnDef<RecordRow, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (r) => sortableDate(r.recordDate), cell: ({ row }) => <DateText iso={row.original.recordDate} precision={row.original.recordDatePrecision} text={row.original.recordDateText} />, meta: { width: 96, shrink: false } },
      { id: 'title', header: 'Record', accessorKey: 'title', cell: ({ row }) => <KeepDatesWhole text={row.original.title} />, meta: { grow: true, minWidth: 200 } },
      { id: 'type', header: 'Type', accessorFn: (r) => recordTypeWords(r.recordType), meta: { width: 132, maxWidth: 160 } },
      ...(anyPlace ? [{ id: 'institution', header: 'From', accessorFn: (r: RecordRow) => r.institutionName ?? '', cell: ({ getValue }: { getValue: () => unknown }) => <span className="muted">{String(getValue())}</span>, meta: { width: 120, maxWidth: 160 } } as ColumnDef<RecordRow, unknown>] : []),
      { id: 'status', header: 'Where it stands', accessorFn: (r) => `${recordStatusWords(r.status)} ${statusDate(r) ?? ''}`, cell: ({ row }) => <StandsCell r={row.original} />, meta: { width: 176, maxWidth: 200, shrink: false } },
    ],
    [anyPlace],
  );

  const anyLikely = allGaps.some((g) => g.likelyHeldDocumentId);
  const gapColumns = useMemo<ColumnDef<Gap, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (g) => sortableDate(g.date), cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />, meta: { width: 96, shrink: false } },
      { id: 'title', header: 'What', accessorKey: 'title', cell: ({ row }) => <KeepDatesWhole text={row.original.title} />, meta: { grow: true, minWidth: 160 } },
      { id: 'type', header: 'Type', accessorFn: (g) => recordTypeWords(g.recordType), meta: { width: 112, maxWidth: 160 } },
      {
        id: 'source',
        header: 'Mentioned in',
        // The document's date first ("2024-02-20 · Summary of the February ER visit, p.1"), so a cut never hides it.
        accessorFn: (g) => (g.kind === 'inventory' ? `checklist ${recordStatusWords(g.status)}` : sourceLine(g.sourceDocumentTitle, g.sourceDocumentId ? (docDates.get(g.sourceDocumentId) ?? null) : null, g.citation?.pageNumber ?? null)),
        cell: ({ row }) => {
          const g = row.original;
          if (g.kind === 'inventory')
            return (
              <span className="records-mention">
                <span className="muted">your checklist</span>
                <RecordStatus status={g.status} />
              </span>
            );
          const line = sourceLine(g.sourceDocumentTitle, g.sourceDocumentId ? (docDates.get(g.sourceDocumentId) ?? null) : null, g.citation?.pageNumber ?? null);
          return (
            <span className="records-mention">
              {g.citation ? (
                <Link to="/documents/$id" params={{ id: g.citation.documentId }} search={{ page: g.citation.pageNumber, cite: g.citation.citationId }} onClick={(e) => e.stopPropagation()} className={g.citation.verified ? undefined : 'unverified'}>
                  {line}
                </Link>
              ) : (
                <span className="muted">{g.sourceDocumentTitle ? line : 'no page given'}</span>
              )}
              {g.citation && !g.citation.verified ? (
                <Tag tone="warn" title="The quote was not found in the page text">
                  quote not found
                </Tag>
              ) : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: 140 },
      },
      ...(anyLikely
        ? [
            {
              id: 'likely',
              header: 'Maybe here',
              accessorFn: (g: Gap) => (g.likelyHeldDocumentId ? `yes ${g.likelyHeldDocumentTitle ?? ''}` : ''),
              cell: ({ row }: { row: { original: Gap } }) =>
                row.original.likelyHeldDocumentId ? (
                  <Tag tone="warn" title={`A guess: ${row.original.likelyHeldDocumentTitle ?? 'a document in the case'} (${likelyBasis(row.original)})`}>
                    maybe
                  </Tag>
                ) : null,
              meta: { width: 84, shrink: false },
            } as ColumnDef<Gap, unknown>,
          ]
        : []),
    ],
    [docDates, anyLikely],
  );

  // ---- render ---------------------------------------------------------------
  const loading = records.isPending || (view === 'gaps' && gaps.isPending);
  const loadError = records.error ?? (view === 'gaps' ? gaps.error : null);
  const institutionList = institutions.data ?? [];
  const documentList = documents.data ?? [];
  const anyFilter = Boolean(search.recordType || search.institutionId || search.q);
  const nothingYet = records.isSuccess && gaps.isSuccess && !allRows.length && !allGaps.length && !anyFilter && !isNew;
  const filteredEmpty = 'Nothing matches these filters. Clear filters (in the toolbar) shows every row again.';
  const emptyText: Record<View, string> = {
    all: anyFilter ? filteredEmpty : 'Nothing on the checklist yet.',
    gaps: anyFilter ? filteredEmpty : 'Nothing missing: every record your documents mention is on the checklist, and you have it.',
    requested: anyFilter ? filteredEmpty : 'Nothing asked for and waiting.',
    held: anyFilter ? filteredEmpty : 'No copies on the checklist yet. Add your documents to the checklist (in the header) to list the ones you have.',
  };

  const left = loadError ? (
    <Loading>Could not load the checklist: {loadError.message}</Loading>
  ) : loading ? (
    <Loading>Loading the checklist…</Loading>
  ) : view === 'gaps' ? (
    <DataTable<Gap>
      key="gaps"
      columns={gapColumns}
      data={filteredGaps}
      rowId={(g) => g.id}
      selectedId={selectedId}
      onSelect={(g) => select({ id: g?.id }, true)}
      onOpen={(g) => openSelected(g)}
      initialSort={[{ id: 'date', desc: true }]}
      globalFilter={search.q ?? ''}
      emptyText={emptyText.gaps}
      tableId="records.gaps"
      autoFocus
    />
  ) : (
    <DataTable<RecordRow>
      key="rows"
      columns={recordColumns}
      data={viewRows}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={(r) => select({ id: r?.id }, true)}
      onOpen={(r) => openSelected(r)}
      initialSort={[{ id: 'date', desc: true }]}
      globalFilter={search.q ?? ''}
      rowClassName={(r) => (r.status === 'not_held' || r.status === 'denied' ? 'dim' : undefined)}
      emptyText={emptyText[view]}
      tableId="records.list"
      autoFocus
    />
  );

  let right: React.ReactNode;
  if (isNew) {
    right = <RecordDetail key="new" record={null} institutions={institutionList} documents={documentList} busy={busy} actions={actions} onSave={save} onCancelNew={() => setSearch({ id: undefined })} onDirtyChange={setFormDirty} />;
  } else if (selectedGap?.kind === 'inferred') {
    right = <GapDetail gap={selectedGap} actions={actions} busy={busy} onOpenPassage={() => openSelected(selectedGap)} />;
  } else if (detailRecord) {
    const note = view === 'gaps' && !selectedGap ? 'This record is not missing any more.' : null;
    // Keyed on updatedAt so the form re-seeds after a change; transitions are refused while it has unsaved edits.
    right = (
      <RecordDetail
        key={`${detailRecord.id}:${detailRecord.updatedAt}`}
        record={detailRecord}
        gap={selectedGap}
        institutions={institutionList}
        documents={documentList}
        busy={busy}
        actions={actions}
        onSave={save}
        note={note}
        onDirtyChange={setFormDirty}
      />
    );
  } else if (selectedId && fetched.isPending) {
    right = <Loading>Loading the record…</Loading>;
  } else if (selectedId) {
    right = <EmptyState title="This record is not on the checklist any more">It may have been removed. Pick another on the left.</EmptyState>;
  } else if ((view === 'gaps' ? filteredGaps : viewRows).length) {
    right = (
      <EmptyState title={view === 'gaps' ? 'Pick a missing record' : 'Pick a record'}>
        {view === 'gaps'
          ? 'Read the passage that mentions it, then add it to the checklist or mark it asked for. Move with j and k; Enter opens the passage.'
          : 'See where it stands and change it: asked for, received, they have none. Move with j and k; Enter opens its document.'}
      </EmptyState>
    );
  } else if (!loading) {
    right = <EmptyState title="Nothing to pick">When the list on the left shows records, pick one to see where it stands and change it.</EmptyState>;
  } else right = null;

  const receiveTarget = detailRecord ?? selectedGap;
  const receiveSuggestion: ReceiveSuggestion | null = selectedGap?.likelyHeldDocumentId
    ? { documentId: selectedGap.likelyHeldDocumentId, title: selectedGap.likelyHeldDocumentTitle, basis: likelyBasis(selectedGap), note: suggestedLinkNote(selectedGap, selectedGap.likelyHeldDocumentTitle) }
    : null;
  const bulkDocs = bulkPlan ? (bulkIncludeOther ? [...bulkPlan.records, ...bulkPlan.other] : bulkPlan.records) : [];

  const firstRun = (
    <EmptyState
      title="Nothing on the checklist yet"
      action={
        <div className="row wrap">
          <Button variant="accent" onClick={() => void planFromDocuments()} disabled={busy} title="Each document you have added becomes a row marked received, linked to its file. You see the list first.">
            Add your documents to the checklist
          </Button>
          <Button onClick={startNew} shortcut="n">
            Add a record
          </Button>
        </div>
      }
    >
      List the records that exist for the case: the ones you have, the ones you asked for, and the ones you still need. Start with the documents you already have: each becomes a row marked received. Records your documents mention but you do not have show up under Missing by themselves.
    </EmptyState>
  );

  return (
    <div className="page">
      <PageHeader
        title="Records checklist"
        intro={RECORDS_INTRO}
        actions={{
          primary: { label: 'Add a record', onClick: startNew, shortcut: 'n', title: 'A record that exists or should exist: a scan report, a clinic note, the images on a disc' },
          secondary: [{ label: 'Add your documents to the checklist', onClick: () => void planFromDocuments(), disabled: busy, title: 'Each document you have added becomes a row marked received, linked to its file. You see the list first.' }],
        }}
      />
      {nothingYet ? null : (
        <>
          <Toolbar label="Show and filters">
            <Segmented label="Show" value={view} onChange={(v) => select({ view: v === 'all' ? undefined : v, id: undefined })} options={RECORDS_VIEWS.map((v) => ({ value: v, label: RECORDS_VIEW_WORDS[v], count: counts[v], title: RECORDS_VIEW_INTRO[v] }))} />
            <FilterGroup label="Type">
              <Select value={search.recordType ?? ''} onChange={(e) => setSearch({ recordType: e.target.value || undefined })} options={RECORD_TYPE_OPTIONS} placeholder="Any" aria-label="Record type" />
            </FilterGroup>
            {institutionList.length ? (
              <FilterGroup label="From">
                <Select value={search.institutionId ?? ''} onChange={(e) => setSearch({ institutionId: e.target.value || undefined })} options={institutionList.map((p) => ({ value: p.id, label: p.name }))} placeholder="Anywhere" aria-label="From (place)" />
              </FilterGroup>
            ) : null}
            <SearchField label="Find" placeholder="Record name or place" value={search.q ?? ''} onChange={(v) => setSearch({ q: v || undefined }, true)} width={200} />
            <ToolbarKeys
              items={[
                ['j/k', 'move'],
                ['enter', 'open'],
                ['n', 'add'],
                ['e', 'edit'],
                view === 'gaps' ? ['m', 'add to checklist'] : null,
                ['r', 'asked for'],
                ['i', 'received'],
                ['/', 'find'],
              ]}
            >
              {anyFilter ? (
                <Button size="sm" variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </ToolbarKeys>
          </Toolbar>
          <p className={`records-tab-intro${view === 'gaps' && counts.gaps > 0 ? ' warn' : ''}`}>
            <strong>{RECORDS_VIEW_WORDS[view]}.</strong> {RECORDS_VIEW_INTRO[view]}
          </p>
        </>
      )}
      <div className="page-body flush">{nothingYet ? firstRun : <SplitView storageKey="records" defaultLeft={typeof window !== 'undefined' && window.innerWidth < 1400 ? 58 : 56} minLeft={460} minRight={440} left={left} right={right} />}</div>

      <ReceiveDialog
        open={receiveOpen}
        title={receiveTarget?.title ?? null}
        documents={documentList}
        defaultDocumentId={detailRecord?.documentId ?? null}
        suggestion={receiveSuggestion}
        onClose={() => setReceiveOpen(false)}
        onConfirm={(p) => {
          setReceiveOpen(false);
          void doTransition('receive', p);
        }}
      />
      <Confirm
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void doRemove()}
        title="Remove this row from the checklist?"
        body={<span className="muted">{detailRecord?.title ?? ''}. The row is hidden, not erased; a record a document mentions shows again under Missing.</span>}
        confirmLabel="Remove"
        danger
      />
      <Confirm
        open={confirmUnlink !== null}
        onClose={() => setConfirmUnlink(null)}
        onConfirm={() => {
          if (confirmUnlink) void doTransition(confirmUnlink, undefined, { confirmedUnlink: true });
        }}
        title={confirmUnlink ? `${TRANSITION_TITLE[confirmUnlink]} and unlink the document?` : ''}
        body={
          <span className="muted">
            "{detailRecord?.title ?? ''}" has "{detailRecord?.documentTitle ?? 'a document'}" as the copy you have. Marking it this way removes that link and the kind of copy. A line in the row's notes names the document, so Mark received can link it
            again.
          </span>
        }
        confirmLabel={confirmUnlink ? TRANSITION_TITLE[confirmUnlink] : 'Mark'}
      />
      <Dialog
        open={bulkPlan !== null}
        onClose={() => setBulkPlan(null)}
        title="Add your documents to the checklist?"
        width={560}
        footer={
          <>
            <Button onClick={() => setBulkPlan(null)}>Cancel</Button>
            <Button
              variant="primary"
              autoFocus
              disabled={!bulkDocs.length || busy}
              onClick={() => {
                const docs = bulkDocs;
                setBulkPlan(null);
                void runFromDocuments(docs);
              }}
            >
              Add {plural(bulkDocs.length, 'row')}
            </Button>
          </>
        }
      >
        {bulkPlan ? (
          <div className="stack">
            <p className="records-dialog-text">
              {bulkPlan.records.length
                ? `${plural(bulkPlan.records.length, 'document')} have no row on the checklist yet (${categoryCounts(bulkPlan.records)}). Each becomes a row marked received, linked to its document, with its type taken from the document's type.`
                : 'Every record-type document already has a row on the checklist.'}
            </p>
            {bulkPlan.other.length ? (
              <label className="row records-dialog-check">
                <input type="checkbox" checked={bulkIncludeOther} onChange={(e) => setBulkIncludeOther(e.target.checked)} />
                <span>
                  Also add {plural(bulkPlan.other.length, 'summary, letter or call')} ({categoryCounts(bulkPlan.other)}). These are usually not records to track, so they are left out unless you tick this.
                </span>
              </label>
            ) : null}
            <p className="records-hint">There is no undo for all of them at once: a row you do not want is removed on its own, from its pane (More, Remove from the checklist).</p>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
