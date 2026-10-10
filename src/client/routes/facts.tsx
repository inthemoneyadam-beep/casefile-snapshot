/**
 * /facts — "Details from documents", every cited statement. Split view: the details left, the selected one right.
 * Selection and every filter live in the URL. Each detail shows its automatic check (verified, accurate, not backed
 * yet, inaccurate, needs a source, replaced) and can be filtered by it; the filters say what they are (Type:, Check:)
 * and the rare ones (Document, Added by, Whose words, Your answer, the user says otherwise) wait under More filters.
 * Answer keys c accurate, f only in a summary, d wrong, u back to automatic; they follow Your answer's rules
 * (features/reconcile/logic.ts overrideKeyPlan): c on a lab value, scan, vital, procedure or event is It's accurate
 * (POST /keep), and where Your answer does not offer an answer (the user's own correction or choice outranks the
 * detail, the documents disagree, the detail is the user's correction) the key says why and which button to use
 * instead, never a silent answer the page then ignores; s replaced by a newer one, e edit, n new, Delete. The
 * Possible duplicates view (shown only when there are some) decides pairs with a / b / r.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { ASSERTED_BY, FACT_ORIGINS, FACT_STATUSES, FACT_TYPES } from '@shared/enums';
import { TRUSTS } from '@shared/reconcile';
import { dateSortKey } from '@shared/dates';
import { ApiError, useFailToast } from '../api/client';
import { useActiveJobs } from '../api/hooks';
import { flattenFactPages, parseAttributes, useDocumentsLite, useFact, useFactMutations, useFactStats, useFactsPages, useMerges, type Citation, type FactsListParams, type FactVerdictStatus, type VerdictBasis } from '../api/facts';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { moveToNextRow } from '../app/dom';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { Tag, FactStatusTag, TRUST_ORDER } from '../ui/StatusTag';
import { CheckTag } from '../features/reconcile/CheckTag';
import { isReconciledType, useReconcileCounts, useReconcileMutations } from '../api/reconcile';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { Confirm } from '../ui/Dialog';
import { useToast } from '../ui/Toast';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { FactDetail } from '../features/facts/FactDetail';
import { MergesTable, MergeDetail } from '../features/facts/MergesView';
import { FactFormDialog, OverrideDialog, SupersedeDialog } from '../features/facts/FactDialogs';
import { asDetailX, asRowX, useOverrideMutations, type FactRowX } from '../features/facts/api';
import { ANSWER_FILTER_WORDS, ORIGIN_FILTER_WORDS, VOICE_WORDS, documentLabel, factTypeWords } from '../features/facts/words';
import { ToolbarKeys } from '../ui/Toolbar';
import { UNDO_WORDS, keepWords, overrideKeyPlan, overrideOffers, resetKeyWords, type OverrideInput, type UndoKind } from '../features/reconcile/logic';
import '../features/facts/facts.css';
import '../features/reconcile/reconcile.css';

/** The automatic check in the tags' own words (the Check filter); the sentence each stands for is in the Guide. */
const CHECK_FILTER_WORDS: Record<string, string> = { verified: 'Verified', accurate: 'Accurate', unbacked: 'Not backed yet', inaccurate: 'Inaccurate', conflict: 'Needs a source', replaced: 'Replaced' };
const INTRO = 'Every detail Claude read from your documents, each with the page it came from and how it compares with your clinical records.';
/** What each view holds, in one line under the toolbar. */
const VIEW_LINE = {
  all: { lead: 'All details.', text: 'Each is checked against your clinical records by itself; nothing here waits for you. Give your own answer (in the pane, under Check) only when you know better.' },
  merges: { lead: 'Possible duplicates.', text: 'Details from different documents that look like the same thing. Nothing is combined until you choose to keep one of them, or both.' },
} as const;

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  type: z.enum(FACT_TYPES).optional().catch(undefined),
  status: z.enum(FACT_STATUSES).optional().catch(undefined),
  trust: z.enum(TRUSTS).optional().catch(undefined),
  documentId: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  origin: z.enum(FACT_ORIGINS).optional().catch(undefined),
  assertedBy: z.enum(ASSERTED_BY).optional().catch(undefined),
  overridden: z.enum(['1']).optional().catch(undefined),
  view: z.enum(['all', 'merges']).optional().catch(undefined),
  mergeStatus: z.enum(['pending', 'accepted', 'rejected']).optional().catch(undefined),
});
export type FactsSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/facts')({
  validateSearch: (s: Record<string, unknown>): FactsSearch => searchSchema.parse(s),
  component: FactsPage,
});

function FactsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const canWrite = useMe().canWrite;
  const view = search.view ?? 'all';
  const mergeStatus = search.mergeStatus ?? 'pending';
  const selectedId = search.id ?? null;
  /** The rare filters (Document, Added by, Whose words, Your answer, the user says otherwise): open while any is on. */
  const rareOn = [search.documentId, search.origin, search.assertedBy, search.status, search.overridden].filter(Boolean).length;
  const [moreFilters, setMoreFilters] = useState(rareOn > 0);
  useEffect(() => {
    if (rareOn > 0) setMoreFilters(true);
  }, [rareOn]);

  // Newest first on the server too, so the loaded window is the one the table's initial sort shows.
  const listParams = useMemo(
    () => ({ type: search.type, status: search.status, trust: search.trust, documentId: search.documentId, q: search.q, origin: search.origin, assertedBy: search.assertedBy, overridden: search.overridden, sort: '-date' }) as FactsListParams,
    [search.type, search.status, search.trust, search.documentId, search.q, search.origin, search.assertedBy, search.overridden],
  );
  const jobs = useActiveJobs();
  const extracting = (jobs.data?.items ?? []).some((j) => j.type === 'extract_facts');
  const list = useFactsPages(listParams, { refetchInterval: extracting ? 3000 : false });
  const merges = useMerges(mergeStatus);
  const stats = useFactStats();
  const documents = useDocumentsLite();
  const detailQ = useFact(view === 'all' ? selectedId : null);
  // Stable while the query data is: the edit dialog resets its form when this object changes.
  const detailData = useMemo(() => (detailQ.data ? asDetailX(detailQ.data) : undefined), [detailQ.data]);
  const detail = { ...detailQ, data: detailData };
  const m = useFactMutations();
  const ov = useOverrideMutations();
  const rc = useReconcileMutations();
  const reconcileCounts = useReconcileCounts({ refetchInterval: false });

  const items = useMemo(() => flattenFactPages(list.data?.pages).map(asRowX), [list.data]);
  const mergeItems = merges.data?.items ?? [];
  const selectedMerge = view === 'merges' ? mergeItems.find((x) => x.id === selectedId) ?? null : null;

  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [extractConfirmOpen, setExtractConfirmOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const dialogOpen = editOpen || newOpen || supersedeOpen || deleteOpen || overrideOpen || extractConfirmOpen;
  /**
   * Documents Claude would read for details: none pulled out yet, text ready, not already being
   * read (mirrors the server's documentsWithoutFacts closely; the toast reports the real number).
   * null when the document list is not available.
   */
  const unreadDocuments = useMemo(() => {
    const docs = documents.data ?? [];
    if (!docs.length) return null;
    return docs.filter((d) => {
      const x = d as typeof d & { textStatus?: string; pageCount?: number };
      return (d.factsCount ?? 0) === 0 && !['queued', 'running'].includes(d.extractionStatus ?? '') && !['pending', 'extracting', 'ocr_running', 'ocr_needed', 'failed'].includes(x.textStatus ?? '') && (x.pageCount ?? 1) > 0;
    }).length;
  }, [documents.data]);
  const busy = m.verdict.isPending || m.supersede.isPending || m.remove.isPending || m.update.isPending || m.create.isPending || m.acceptMerge.isPending || m.rejectMerge.isPending || ov.set.isPending || ov.clear.isPending || ov.newStatement.isPending;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q, id: undefined }), replace: true }));

  const tableRef = useRef<HTMLDivElement>(null);

  function setSearch(patch: Partial<FactsSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function setView(v: 'all' | 'merges') {
    setSearch({ view: v === 'all' ? undefined : v, id: undefined }, false);
  }
  function openCitation(c: Citation) {
    void navigate({ to: '/documents/$id', params: { id: c.documentId }, search: { page: c.pageNumber, cite: c.id } });
  }
  function openFact(id: string) {
    setSearch({ view: undefined, id }, false);
  }

  // Latest state for key bindings and commands registered once.
  const pendingMerges = stats.data?.pendingMerges ?? 0;
  const latest = useRef({ view, selectedId, selectedMerge, detail: detail.data ?? null, dialogOpen, busy, items, pendingMerges });
  latest.current = { view, selectedId, selectedMerge, detail: detail.data ?? null, dialogOpen, busy, items, pendingMerges };

  /** basis (with 'confirmed'): checked against the original record, or only a summary (the server then asks for the original on the Records checklist). */
  function verdict(status: FactVerdictStatus, note?: string | null, moveOn = false, basis?: VerdictBasis | null) {
    const id = latest.current.selectedId;
    if (!id || latest.current.view !== 'all') return;
    // Back to automatic on a lab value, scan, vital, procedure or event also forgets "not the same event" and lets the comparison set it aside again.
    const d = latest.current.detail;
    if (status === 'unverified' && !basis && note === undefined && d && d.id === id && isReconciledType(d.type)) {
      rc.reset.mutate(id, { onSuccess: () => toast('Back to automatic', 'ok'), onError: fail });
      return;
    }
    m.verdict.mutate(
      { id, status, note, basis },
      {
        onSuccess: () => {
          if (status === 'confirmed' && basis === 'summary' && note === undefined) toast('Marked inferred; the original report is on your Records checklist to request', 'ok');
          if (moveOn) moveToNextRow(tableRef.current);
        },
        onError: fail,
      },
    );
  }
  function decideMerge(action: 'a' | 'b' | 'r') {
    const mg = latest.current.selectedMerge;
    if (!mg || mg.status !== 'pending') return;
    const opts = { onSuccess: () => toast(action === 'r' ? 'Not duplicates; both kept' : `Kept ${action.toUpperCase()}; the other is marked replaced`, 'ok'), onError: fail };
    if (action === 'r') m.rejectMerge.mutate(mg.id, opts);
    else m.acceptMerge.mutate({ id: mg.id, keep: action }, opts);
  }
  /** Paid: asks first (the header button and the command both open the confirmation). */
  function askExtractAll() {
    if (latest.current.dialogOpen) return;
    setExtractConfirmOpen(true);
  }
  function extractAll() {
    m.extract.mutate(
      { allWithoutFacts: true },
      {
        onSuccess: (r) => {
          const waiting = r.skipped.length;
          const tail = waiting ? `; ${waiting} not ready yet (still being read or no text yet)` : '';
          const n = r.jobs.length;
          toast(n ? `Claude will pull details from ${n} document${n === 1 ? '' : 's'}${tail}` : waiting ? `No documents ready yet${tail}` : 'Every document has already been read for details', n ? 'ok' : 'info');
        },
        onError: fail,
      },
    );
  }
  /** Key o: the patient-statement picker, for subjective facts only (objective facts are ground truth). */
  function openOverride() {
    const d = latest.current.detail;
    if (latest.current.dialogOpen || !d || latest.current.view !== 'all') return;
    if (d.effectiveObjectivity === 'objective') {
      toast('Measured values and recorded events stay as recorded; if this one is wrong, mark it Incorrect (d).');
      return;
    }
    setOverrideError(null);
    setOverrideOpen(true);
  }
  function clearOverride() {
    const id = latest.current.selectedId;
    if (!id) return;
    ov.clear.mutate(id, { onSuccess: () => toast("Your statement is no longer used here; the record stands on its own again", 'ok'), onError: fail });
  }
  function runPrecedence() {
    ov.runPrecedence.mutate(undefined, {
      onSuccess: (r) => toast(`Your statements now used instead of ${r.overridden} record${r.overridden === 1 ? '' : 's'}; ${r.findings.created} new finding${r.findings.created === 1 ? '' : 's'}`, 'ok'),
      onError: fail,
    });
  }

  // Keys belong to a view: verdict keys need a selected fact in the All view, merge keys a selected
  // proposal in the Merges view. Outside that they are neither listed in the sheet nor swallowed.
  const factSelected = () => latest.current.view === 'all' && Boolean(latest.current.selectedId) && !latest.current.dialogOpen;
  const factLoaded = () => factSelected() && Boolean(latest.current.detail);
  const mergeSelected = () => latest.current.view === 'merges' && Boolean(latest.current.selectedMerge) && !latest.current.dialogOpen;

  type SelectedOverride = Omit<OverrideInput, 'trust'> & { id: string; trust: OverrideInput['trust'] | null };
  /**
   * What the Override needs to know about the selected detail (its check, the user's answer, its type and its
   * document's tier): from the detail when it is loaded, else from its row in the list; null while neither is.
   */
  function selectedOverride(): SelectedOverride | null {
    const id = latest.current.selectedId;
    if (!id || latest.current.view !== 'all') return null;
    const d = latest.current.detail;
    if (d && d.id === id) {
      return { id, factId: id, trust: d.trust ?? null, status: d.status, basis: d.verdictBasis, reconciled: isReconciledType(d.type), separated: parseAttributes(d)._reconcileSeparate === true, documentTier: d.document ? (d.document.sourceTier ?? null) : null };
    }
    const r = latest.current.items.find((x) => x.id === id);
    if (!r) return null;
    return { id, factId: id, trust: r.trust ?? null, status: r.status, basis: r.verdictBasis, reconciled: isReconciledType(r.type), separated: false, documentTier: r.documentTier };
  }

  /**
   * Keys c (accurate) and f (only in a summary): the Override's answer, where the Override offers it. On a lab
   * value, scan, vital, procedure or event, c is It's accurate (POST /keep, as the Override's button). Where the
   * Override does not offer it, the key says why and which button to use (never the plain verdict, which would be
   * stored and then ignored, or would quietly drop the user's correction).
   */
  function answerKey(answer: 'accurate' | 'summary', moveOn: boolean) {
    const o = selectedOverride();
    if (!o) {
      if (latest.current.selectedId && latest.current.view === 'all') toast('One moment: this detail is still loading.');
      return;
    }
    const plan = overrideKeyPlan(answer, o);
    if (plan.do === 'explain') {
      toast(plan.words);
      return;
    }
    if (plan.do === 'keep') {
      rc.keep.mutate(o.id, {
        onSuccess: (res) => {
          // Quiet when it is simply kept (the next row follows); said plainly when it makes a disagreement to settle.
          if (res?.trust?.trust === 'conflict') toast(keepWords(res.trust), 'ok');
          if (moveOn) moveToNextRow(tableRef.current);
        },
        onError: fail,
      });
      return;
    }
    verdict('confirmed', undefined, moveOn, answer === 'accurate' ? 'original' : 'summary');
  }
  /** The Undo the Override offers on the selected detail (the user's own word that outranks it), if any. */
  function selectedUndo(): { kind: UndoKind; recordFactId: string } | null {
    const o = selectedOverride();
    if (!o?.trust?.recordFactId) return null;
    const kind = overrideOffers({ ...o, trust: o.trust }).undo;
    return kind ? { kind, recordFactId: o.trust.recordFactId } : null;
  }
  function undoOutranking() {
    const u = selectedUndo();
    if (!u) return;
    rc.reset.mutate(u.recordFactId, { onSuccess: () => toast(UNDO_WORDS[u.kind].done, 'ok'), onError: fail });
  }
  /** Key u: back to automatic; on a detail with no answer of its own to forget (the user's word outranks it), say which Undo to use. */
  function resetKey() {
    const o = selectedOverride();
    const words = o?.trust ? resetKeyWords({ ...o, trust: o.trust }) : null;
    if (words) {
      toast(words);
      return;
    }
    verdict('unverified');
  }
  /** The palette lists It's accurate (and Only in a summary) only where the Override offers it. */
  const answerOffered = (answer: 'accurate' | 'summary') => () => {
    if (!factSelected()) return false;
    const o = selectedOverride();
    return !o || overrideKeyPlan(answer, o).do !== 'explain';
  };

  useBindings(
    [
      { keys: 'c', description: "Your answer: the selected detail is accurate (you checked it against the original)", group: 'Facts', when: factSelected, run: () => answerKey('accurate', true) },
      { keys: 'f', description: 'Your answer: the selected detail is only in a summary (asks for the original)', group: 'Facts', when: factSelected, run: () => answerKey('summary', true) },
      { keys: 'd', description: "Your answer: the selected detail is wrong (kept on file, set aside)", group: 'Facts', when: factSelected, run: () => verdict('disputed', undefined, true) },
      { keys: 'u', description: 'Your answer: back to automatic (forget your answer)', group: 'Facts', when: factSelected, run: resetKey },
      { keys: 's', description: 'Selected detail was replaced by a newer one', group: 'Facts', when: factLoaded, run: () => setSupersedeOpen(true) },
      { keys: 'o', description: 'You say otherwise: pick or type your statement', group: 'Facts', when: () => latest.current.view === 'all' && Boolean(latest.current.selectedId), run: openOverride },
      { keys: 'e', description: 'Edit the selected detail', group: 'Facts', when: factLoaded, run: () => setEditOpen(true) },
      { keys: 'n', description: 'Add a detail by hand', group: 'Facts', when: () => !latest.current.dialogOpen, run: () => setNewOpen(true) },
      { keys: 'Delete', description: 'Delete the selected detail (asks first)', group: 'Facts', when: factLoaded, run: () => setDeleteOpen(true) },
      { keys: 'a', description: 'Possible duplicates: keep the first', group: 'Facts', when: mergeSelected, run: () => decideMerge('a') },
      { keys: 'b', description: 'Possible duplicates: keep the second', group: 'Facts', when: mergeSelected, run: () => decideMerge('b') },
      { keys: 'r', description: 'Possible duplicates: not duplicates, keep both', group: 'Facts', when: mergeSelected, run: () => decideMerge('r') },
      { keys: 'v v', description: 'Next view: all details, possible duplicates', group: 'Lists', when: () => !latest.current.dialogOpen && (latest.current.view === 'merges' || latest.current.pendingMerges > 0), run: () => setView(latest.current.view === 'all' ? 'merges' : 'all') },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'facts.confirm', title: "Your answer: the selected detail is accurate", group: 'Facts', shortcut: 'c', keywords: 'verdict verify confirm original accurate', when: answerOffered('accurate'), run: () => answerKey('accurate', false) },
      { id: 'facts.summary', title: 'Your answer: the selected detail is only in a summary', group: 'Facts', shortcut: 'f', keywords: 'verdict confirm secondhand summary inferred request original records checklist', when: answerOffered('summary'), run: () => answerKey('summary', false) },
      { id: 'facts.dispute', title: "Your answer: the selected detail is wrong", group: 'Facts', shortcut: 'd', keywords: 'verdict dispute wrong incorrect set aside', when: factSelected, run: () => verdict('disputed') },
      { id: 'facts.reset', title: 'Your answer: the selected detail back to automatic', group: 'Facts', shortcut: 'u', keywords: 'verdict undo pending automatic', when: factSelected, run: resetKey },
      // Where the user's own correction (or choice of another record) outranks the selected detail: Your answer's Undo.
      ...(['choice', 'correction', 'later', 'value'] as const).map((k) => ({
        id: `facts.undo-${k}`,
        title: `Your answer: ${UNDO_WORDS[k].label.toLowerCase()}`,
        group: 'Facts',
        keywords: 'undo correction choice record outranked back automatic',
        when: () => factSelected() && selectedUndo()?.kind === k,
        run: undoOutranking,
      })),
      { id: 'facts.supersede', title: 'The selected detail was replaced by a newer one', group: 'Facts', shortcut: 's', keywords: 'replace newer supersede', when: factLoaded, run: () => setSupersedeOpen(true) },
      { id: 'facts.edit', title: 'Edit the selected detail', group: 'Facts', shortcut: 'e', keywords: 'change correct', when: factLoaded, run: () => setEditOpen(true) },
      { id: 'facts.delete', title: 'Delete the selected detail', group: 'Facts', shortcut: 'Delete', keywords: 'remove', when: factLoaded, run: () => setDeleteOpen(true) },
      { id: 'facts.merge-keep-a', title: 'Possible duplicate: keep the first', group: 'Facts', shortcut: 'a', keywords: 'duplicate accept', when: mergeSelected, run: () => decideMerge('a') },
      { id: 'facts.merge-keep-b', title: 'Possible duplicate: keep the second', group: 'Facts', shortcut: 'b', keywords: 'duplicate accept', when: mergeSelected, run: () => decideMerge('b') },
      { id: 'facts.merge-reject', title: 'Possible duplicate: not duplicates, keep both', group: 'Facts', shortcut: 'r', keywords: 'duplicate not the same', when: mergeSelected, run: () => decideMerge('r') },
      { id: 'facts.extract-all', title: 'Pull details from documents not read yet (asks first; uses Claude)', group: 'Facts', keywords: 'ai extraction extract run model read new documents', run: askExtractAll },
      { id: 'facts.merges', title: 'Show possible duplicates', group: 'Facts', keywords: 'duplicates dedup merge proposals', shortcut: 'v v', run: () => setView('merges') },
      { id: 'facts.new', title: 'Add a detail by hand', group: 'Facts', keywords: 'manual add new fact', shortcut: 'n', run: () => setNewOpen(true) },
      { id: 'facts.all', title: 'Show all details', group: 'Facts', keywords: 'facts', run: () => setView('all') },
      { id: 'facts.inaccurate', title: 'Show details that disagree with a clinical record', group: 'Facts', keywords: 'inaccurate wrong red reconcile', run: () => setSearch({ view: undefined, trust: 'inaccurate', status: undefined, id: undefined }, false) },
      { id: 'facts.conflict', title: 'Show details your documents disagree about (need a source)', group: 'Facts', keywords: 'conflict needs source reconcile', run: () => setSearch({ view: undefined, trust: 'conflict', status: undefined, id: undefined }, false) },
      { id: 'facts.override', title: 'You say otherwise: pick or type your statement', group: 'Facts', shortcut: 'o', keywords: 'override precedence patient view differs', when: () => latest.current.view === 'all' && Boolean(latest.current.selectedId), run: openOverride },
      { id: 'facts.overridden', title: 'Show details where you say otherwise', group: 'Facts', keywords: 'override precedence', run: () => setSearch({ view: undefined, overridden: '1', id: undefined }, false) },
      { id: 'facts.patient', title: "Show your own statements", group: 'Facts', keywords: 'voice asserted by', run: () => setSearch({ view: undefined, assertedBy: 'patient', id: undefined }, false) },
      { id: 'facts.precedence', title: "Use your statements wherever they differ from a record", group: 'Facts', keywords: 'override rule findings patient precedence pass', run: runPrecedence },
    ],
    [],
  );

  // Widths that fit the list at 1280 (about 580px): Date and Check as wide as their content, the statement takes the
  // room and wraps to two lines with one small line under it (its type, and only when there is something to say,
  // "quote not found" and whose words), From names the document date first so a "…" never cuts the part that tells
  // two reports apart. What used to be the Type, Voice, Cites and Conf columns is that small line and the pane.
  const docDates = useMemo(() => new Map((documents.data ?? []).map((d) => [d.id, d.documentDate ?? null])), [documents.data]);
  const columns = useMemo<ColumnDef<FactRowX, unknown>[]>(
    () => [
      {
        id: 'date',
        header: 'Date',
        accessorFn: (r) => (r.date ? dateSortKey(r.date) : undefined),
        sortUndefined: 'last',
        cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />,
        meta: { width: 96, shrink: false },
      },
      {
        id: 'statement',
        header: 'Statement',
        accessorKey: 'statement',
        cell: ({ row }) => {
          const r = row.original;
          const quoteMissing = r.citationCount > 0 && r.verifiedCitationCount < r.citationCount;
          const notes = [factTypeWords(r.type), r.assertedBy === 'patient' ? "Your own words" : null, r.overriddenByFactId ? 'You say otherwise' : null].filter(Boolean);
          return (
            <span className="facts-cell">
              <span className="clamp2">
                <KeepDatesWhole text={r.statement} />
              </span>
              <span className="facts-sub">
                <span>{notes.join(' · ')}</span>
                {quoteMissing ? (
                  <Tag tone="warn" title="At least one quote could not be found on its page">
                    quote not found
                  </Tag>
                ) : null}
              </span>
            </span>
          );
        },
        meta: { grow: true, minWidth: 220 },
      },
      {
        id: 'document',
        header: 'From',
        accessorFn: (r) => {
          const d = documentLabel(r.documentTitle, r.sourceDocumentId ? docDates.get(r.sourceDocumentId) : null);
          return `${d.date ?? ''} ${d.name}`;
        },
        cell: ({ row }) => {
          const r = row.original;
          if (!r.documentTitle) return <span className="muted">added by hand</span>;
          const d = documentLabel(r.documentTitle, r.sourceDocumentId ? docDates.get(r.sourceDocumentId) : null);
          return (
            <span className="muted">
              {d.date ? <span className="mono nowrap">{d.date}</span> : null}
              {d.date ? ' · ' : null}
              {d.name}
            </span>
          );
        },
        meta: { grow: true, minWidth: 140, maxWidth: 240, wrap: true },
      },
      {
        id: 'status',
        header: 'Check',
        // What needs a look sorts first: inaccurate, then needs a source, not backed yet, accurate, verified.
        accessorFn: (r) => (r.trust ? TRUST_ORDER[r.trust.trust] : 9),
        cell: ({ row }) => (row.original.trust ? <CheckTag trust={row.original.trust} /> : <FactStatusTag status={row.original.status} basis={row.original.verdictBasis} />),
        meta: { width: 104, shrink: false },
      },
    ],
    [docDates],
  );

  const pages = list.data?.pages ?? [];
  const total = pages.length ? pages[pages.length - 1].total : 0;
  const cutOff = items.length < total;
  const selectedOutside = view === 'all' && Boolean(selectedId) && items.length > 0 && !items.some((r) => r.id === selectedId) && Boolean(detail.data);
  const anyFilter = Boolean(search.q || search.type || search.status || search.trust || search.documentId || search.origin || search.assertedBy || search.overridden);
  const showViews = view === 'merges' || pendingMerges > 0;
  const nothingYet = view === 'all' && list.isSuccess && total === 0 && !anyFilter;
  function clearFilters() {
    setQLocal('');
    setSearch({ type: undefined, status: undefined, trust: undefined, documentId: undefined, origin: undefined, q: undefined, assertedBy: undefined, overridden: undefined, id: undefined });
  }
  const readAction = {
    label: m.extract.isPending ? 'Starting…' : unreadDocuments ? `Read ${unreadDocuments} document${unreadDocuments === 1 ? '' : 's'} for details` : 'Pull details from documents not read yet',
    onClick: askExtractAll,
    disabled: m.extract.isPending,
    title: 'Claude reads every document that has not had details pulled out yet; asks first, and costs a little for each document',
  };

  const left =
    view === 'merges' ? (
      <MergesTable items={mergeItems} selectedId={selectedId} onSelect={(r) => select(r?.id ?? null)} onOpen={(r) => openFact(r.a.id)} loading={merges.isPending} />
    ) : list.isPending ? (
      <Loading>Loading details…</Loading>
    ) : list.isError ? (
      <Loading>Could not load the details: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
    ) : nothingYet ? (
      <EmptyState
        title="No details yet"
        action={
          canWrite ? (
            <span className="row">
              <Button variant="primary" onClick={askExtractAll} disabled={readAction.disabled} title={readAction.title}>
                {unreadDocuments ? readAction.label : 'Pull details from your documents'}
              </Button>
              <Button onClick={() => setNewOpen(true)} shortcut="n">
                Add a detail by hand
              </Button>
            </span>
          ) : null
        }
      >
        Claude reads each document you add and lists every detail in it here (results, medications, diagnoses, dates), each with the page it came from.
      </EmptyState>
    ) : (
      <div ref={tableRef} style={{ display: 'contents' }}>
        <DataTable
          columns={columns}
          data={items}
          rowId={(r) => r.id}
          selectedId={selectedId}
          onSelect={(r) => select(r?.id ?? null)}
          onOpen={(r) => {
            // Enter opens the source passage: the first verified citation, else the first one, else the document.
            const d = latest.current.detail;
            const cites = d && d.id === r.id ? d.citations : [];
            const c = cites.find((x) => x.verified) ?? cites[0];
            if (c) openCitation(c);
            else if (r.sourceDocumentId) void navigate({ to: '/documents/$id', params: { id: r.sourceDocumentId } });
            else setEditOpen(true);
          }}
          initialSort={[{ id: 'date', desc: true }]}
          rowClassName={(r) => [r.trust?.trust === 'inaccurate' ? 'inaccurate-row' : '', r.status === 'superseded' ? 'dim' : ''].filter(Boolean).join(' ') || undefined}
          emptyText="No details match these filters. Clear filters (in the toolbar) shows every detail again."
          maxRows={Math.max(5000, items.length)}
          tableId="facts.list"
          footer={
            extracting || cutOff || selectedOutside ? (
              <span>
                {extracting ? 'Claude is pulling out details… ' : ''}
                {cutOff ? (
                  <span>
                    Showing the newest {items.length} of {total}; sorting and j/k cover these.{' '}
                    <Button size="sm" variant="ghost" disabled={list.isFetchingNextPage || !list.hasNextPage} onClick={() => void list.fetchNextPage()}>
                      {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </Button>
                  </span>
                ) : null}
                {selectedOutside ? ' The selected detail is not in this list (filtered out, or further down).' : ''}
              </span>
            ) : undefined
          }
          autoFocus
        />
      </div>
    );

  const right =
    view === 'merges' ? (
      selectedMerge ? (
        <MergeDetail merge={selectedMerge} busy={busy || !canWrite} onAccept={(k) => decideMerge(k)} onReject={() => decideMerge('r')} onOpenFact={openFact} />
      ) : mergeItems.length ? (
        <EmptyState title="Pick a pair">See the two details side by side, then keep the first (a), keep the second (b), or keep both (r). Move with j and k.</EmptyState>
      ) : (
        <EmptyState title="Nothing to decide">Details from different documents that look like the same thing appear here. Nothing is combined until you choose.</EmptyState>
      )
    ) : !selectedId ? (
      items.length ? (
        <EmptyState title="Pick a detail">See what it says, how it compares with your clinical records, and the quote on its page. Move with j and k; Enter opens the page.</EmptyState>
      ) : null
    ) : detail.isPending ? (
      <Loading />
    ) : detail.isError || !detail.data ? (
      <EmptyState title="That detail is not available">{detail.error instanceof ApiError && detail.error.status === 404 ? 'It may have been deleted. ' : ''}Pick another from the list.</EmptyState>
    ) : (
      <FactDetail
        fact={detail.data}
        busy={busy || !canWrite}
        onVerdict={(status, note, basis) => verdict(status, note, false, basis)}
        onEdit={() => setEditOpen(true)}
        onSupersede={() => setSupersedeOpen(true)}
        onDelete={() => setDeleteOpen(true)}
        onOpenCitation={openCitation}
        onOpenFact={openFact}
        onOverride={openOverride}
        onClearOverride={clearOverride}
      />
    );

  const totalDetails = stats.data ? Object.values(stats.data.byType).reduce((a, b) => a + b, 0) : null;
  const rc0 = reconcileCounts.data;

  return (
    <div className="page">
      <PageHeader
        title="Details from documents"
        meta={
          totalDetails != null ? (
            <span className="mono">
              {totalDetails} detail{totalDetails === 1 ? '' : 's'}
              {rc0 ? ` · ${rc0.inaccurate} inaccurate · ${rc0.needsSource} need${rc0.needsSource === 1 ? 's' : ''} a source` : ''}
            </span>
          ) : null
        }
        intro={INTRO}
        actions={
          canWrite
            ? {
                primary: { label: 'Add a detail by hand', onClick: () => setNewOpen(true), shortcut: 'n', title: 'Type a detail yourself, with the page it is on if you have one' },
                secondary: [unreadDocuments ? readAction : null],
                more: [
                  unreadDocuments ? null : readAction,
                  { label: "Use your statements wherever they differ", onClick: runPrecedence, title: "Wherever your own statement differs from an opinion in a record, Claude goes by yours; the records stay as written" },
                  'separator',
                  { label: "Show your own statements", onClick: () => setSearch({ view: undefined, assertedBy: 'patient', id: undefined }, false) },
                  { label: 'Show where you say otherwise', onClick: () => setSearch({ view: undefined, overridden: '1', id: undefined }, false) },
                ],
              }
            : undefined
        }
      />
      <Toolbar label="Views and filters">
        {showViews ? (
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'all', label: 'All details', count: totalDetails ?? undefined, title: 'Every detail, with its check' },
              { value: 'merges', label: 'Possible duplicates', count: pendingMerges, title: 'Pairs that look like the same thing, waiting for you' },
            ]}
          />
        ) : null}
        {view === 'all' ? (
          <>
            <SearchField label="Find" placeholder="Statement, e.g. lisinopril" value={qLocal} onChange={setQLocal} width={190} />
            <FilterGroup label="Type">
              <Select aria-label="Type" value={search.type ?? ''} options={FACT_TYPES.map((t) => ({ value: t, label: factTypeWords(t) }))} placeholder="Any" onChange={(e) => setSearch({ type: (e.target.value || undefined) as FactsSearch['type'], id: undefined })} />
            </FilterGroup>
            <FilterGroup label="Check">
              <Select aria-label="Check" value={search.trust ?? ''} options={TRUSTS.map((v) => ({ value: v, label: CHECK_FILTER_WORDS[v] ?? v }))} placeholder="Any" onChange={(e) => setSearch({ trust: (e.target.value || undefined) as FactsSearch['trust'], id: undefined })} />
            </FilterGroup>
            <Button size="sm" variant="ghost" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)} title="Document, who added it, whose words, your answer, you say otherwise">
              {moreFilters ? 'Fewer filters' : 'More filters'}
              {rareOn ? <span className="mono"> ({rareOn} on)</span> : null}
            </Button>
            {moreFilters ? (
              <>
                <FilterGroup label="Document">
                  <Select
                    aria-label="Document"
                    className="facts-doc-select"
                    value={search.documentId ?? ''}
                    options={(documents.data ?? []).map((d) => ({ value: d.id, label: d.title }))}
                    placeholder={documents.data?.length ? 'Any' : 'Any (none listed)'}
                    onChange={(e) => setSearch({ documentId: e.target.value || undefined, id: undefined })}
                  />
                </FilterGroup>
                <FilterGroup label="Added by">
                  <Select aria-label="Added by" value={search.origin ?? ''} options={FACT_ORIGINS.map((v) => ({ value: v, label: ORIGIN_FILTER_WORDS[v] ?? v }))} placeholder="Anyone" onChange={(e) => setSearch({ origin: (e.target.value || undefined) as FactsSearch['origin'], id: undefined })} />
                </FilterGroup>
                <FilterGroup label="Whose words">
                  <Select aria-label="Whose words" value={search.assertedBy ?? ''} options={ASSERTED_BY.map((v) => ({ value: v, label: VOICE_WORDS[v] ?? v }))} placeholder="Anyone's" onChange={(e) => setSearch({ assertedBy: (e.target.value || undefined) as FactsSearch['assertedBy'], id: undefined })} />
                </FilterGroup>
                <FilterGroup label="Your answer">
                  <Select aria-label="Your answer" value={search.status ?? ''} options={FACT_STATUSES.map((v) => ({ value: v, label: ANSWER_FILTER_WORDS[v] ?? v }))} placeholder="Any" onChange={(e) => setSearch({ status: (e.target.value || undefined) as FactsSearch['status'], id: undefined })} />
                </FilterGroup>
                <label className="facts-check">
                  <input type="checkbox" checked={search.overridden === '1'} onChange={(e) => setSearch({ overridden: e.target.checked ? '1' : undefined, id: undefined })} />
                  Only where you say otherwise
                </label>
              </>
            ) : null}
          </>
        ) : (
          <FilterGroup label="Show">
            <Select
              aria-label="Possible duplicates to show"
              value={mergeStatus}
              options={[
                { value: 'pending', label: 'Waiting for you' },
                { value: 'accepted', label: 'Kept one' },
                { value: 'rejected', label: 'Not duplicates' },
              ]}
              onChange={(e) => setSearch({ mergeStatus: e.target.value === 'pending' ? undefined : (e.target.value as FactsSearch['mergeStatus']), id: undefined })}
            />
          </FilterGroup>
        )}
        <ToolbarKeys
          items={
            view === 'all'
              ? [['j/k', 'move'], ['enter', 'open the page'], ['/', 'find'], ['c', 'accurate'], ['f', 'only in a summary'], ['d', 'wrong'], ['u', 'back to automatic'], ['e', 'edit'], ['n', 'new'], showViews ? ['v v', 'view'] : null]
              : [['j/k', 'move'], ['enter', 'open the first'], ['a', 'keep the first'], ['b', 'keep the second'], ['r', 'keep both'], ['v v', 'view']]
          }
        >
          {view === 'all' && anyFilter ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      <p className="facts-list-line">
        <strong>{VIEW_LINE[view].lead}</strong> {VIEW_LINE[view].text}
      </p>
      <div className="page-body flush">
        <SplitView storageKey={`facts.${view}`} defaultLeft={typeof window !== 'undefined' && window.innerWidth < 1400 ? 56 : 54} minLeft={460} minRight={420} left={left} right={right} />
      </div>

      <FactFormDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setFormError(null);
        }}
        documents={documents.data ?? []}
        busy={m.create.isPending}
        error={formError}
        onCreate={(input) =>
          m.create.mutate(input, {
            onSuccess: (f) => {
              setNewOpen(false);
              setFormError(null);
              toast('Detail added', 'ok');
              setSearch({ view: undefined, id: f.id });
            },
            onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
          })
        }
        onUpdate={() => undefined}
      />
      <FactFormDialog
        open={editOpen && Boolean(detail.data)}
        onClose={() => {
          setEditOpen(false);
          setFormError(null);
        }}
        fact={detail.data ?? null}
        documents={documents.data ?? []}
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
      <OverrideDialog
        open={overrideOpen && Boolean(detail.data)}
        onClose={() => {
          setOverrideOpen(false);
          setOverrideError(null);
        }}
        fact={detail.data ?? null}
        busy={ov.set.isPending || ov.newStatement.isPending}
        error={overrideError}
        onChoose={(byFactId, reason) => {
          const id = latest.current.selectedId;
          if (!id) return;
          ov.set.mutate(
            { id, byFactId, reason },
            {
              onSuccess: () => {
                setOverrideOpen(false);
                toast('Your statement takes precedence; the record is kept as written', 'ok');
              },
              onError: (err) => setOverrideError(err instanceof Error ? err.message : String(err)),
            },
          );
        }}
        onNewStatement={(statement, dateText, reason) => {
          const id = latest.current.selectedId;
          if (!id) return;
          ov.newStatement.mutate(
            { id, statement, dateText, reason },
            {
              onSuccess: () => {
                setOverrideOpen(false);
                toast('Statement saved and takes precedence', 'ok');
              },
              onError: (err) => setOverrideError(err instanceof Error ? err.message : String(err)),
            },
          );
        }}
      />
      <SupersedeDialog
        open={supersedeOpen && Boolean(detail.data)}
        onClose={() => setSupersedeOpen(false)}
        fact={detail.data ?? null}
        busy={m.supersede.isPending}
        onChoose={(byFactId) => {
          const id = latest.current.selectedId;
          if (!id) return;
          m.supersede.mutate(
            { id, byFactId },
            {
              onSuccess: () => {
                setSupersedeOpen(false);
                toast('Marked replaced by the newer one', 'ok');
              },
              onError: fail,
            },
          );
        }}
      />
      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this detail?"
        body={<span className="muted">It is hidden from every view and from search, not erased. Its quotes stay on file.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const id = latest.current.selectedId;
          if (!id) return;
          m.remove.mutate(id, {
            onSuccess: () => {
              toast('Detail deleted', 'ok');
              select(null);
            },
            onError: fail,
          });
        }}
      />
      <Confirm
        open={extractConfirmOpen}
        onClose={() => setExtractConfirmOpen(false)}
        title="Pull details from documents not read yet?"
        body={
          <span className="muted">
            {unreadDocuments == null
              ? 'Claude will read every document that has not had details pulled out yet.'
              : unreadDocuments === 0
                ? 'Every document looks read already. Claude will check and read any it finds that have no details yet.'
                : `Claude will read ${unreadDocuments} document${unreadDocuments === 1 ? '' : 's'} that ${unreadDocuments === 1 ? 'has' : 'have'} not had details pulled out yet.`}{' '}
            This uses Claude, which costs a little for each document. You can keep working while it reads.
          </span>
        }
        confirmLabel="Pull details"
        onConfirm={extractAll}
      />
    </div>
  );
}
