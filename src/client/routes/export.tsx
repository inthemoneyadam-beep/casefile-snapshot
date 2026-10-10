/**
 * /export — Make a packet. Two views, chosen under View: in the toolbar (?view=):
 *   new   the form, full width, as numbered steps, with Make the packet (the page's one primary action) and Preview
 *         in a footer that stays in view (features/export/PacketBuilder.tsx)
 *   past  the packets already made, list left, the chosen one right (selection in ?id=, which opens this view)
 * The form's choices are remembered locally and its free text only for this tab until a lock (builderState.ts); a
 * packet can be reused as the start of a new one. Previews are rendered by POST, also for the new-tab preview.
 * Keys: n new packet, v v the other view, p preview, ctrl+enter make, o open, t reuse, Delete delete; j/k, Enter
 * and Esc in the lists; Space and a tick documents in step 2.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { ApiError, useFailToast } from '../api/client';
import { useDocuments } from '../api/documents';
import { ACTIVE_PACKET, fetchPreviewHtml, packetFileUrl, useExportMutations, useExportOptions, usePacket, usePackets, type PacketRow } from '../api/export';
import { useMe } from '../api/users';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { dialogOpen } from '../app/dom';
import { Button } from '../ui/Button';
import { Confirm } from '../ui/Dialog';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { DateTimeText } from '../ui/DateText';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { ToolbarKeys } from '../ui/Toolbar';
import { PacketBuilder } from '../features/export/PacketBuilder';
import { PacketDetail, PacketStatusTag } from '../features/export/PacketDetail';
import { clearDraft, emptyState, fromConfig, readDraft, toConfig, writeDraft, type BuilderState } from '../features/export/builderState';
import { browserWords, packetStatusWords, plural } from '../features/export/words';
import '../features/export/export.css';

const VIEWS = ['new', 'past'] as const;
type View = (typeof VIEWS)[number];

const searchSchema = z.object({
  view: z.enum(VIEWS).optional().catch(undefined),
  id: z.string().optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/export')({
  validateSearch: (s: Record<string, unknown>): Search => searchSchema.parse(s),
  component: ExportPage,
});

const INTRO = 'Put chosen records into one PDF with a cover page and summaries, to send to a clinician or bring to a visit. The original documents are added at the end.';

function ExportPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const selectedId = search.id ?? null;
  // A selected packet (a link, the palette) opens the list of packets already made.
  const view: View = search.view ?? (selectedId ? 'past' : 'new');

  const packets = usePackets();
  const detail = usePacket(view === 'past' ? selectedId : null);
  const options = useExportOptions();
  const documents = useDocuments({});
  const m = useExportMutations();
  const me = useMe();
  // Viewers may look at packets and fill in the form; making and deleting need an editor or the owner.
  const canWrite = me.canWrite;

  const [state, setState] = useState<BuilderState>(() => readDraft() ?? emptyState());
  const [preview, setPreview] = useState<{ html: string | null; loading: boolean; error: string | null; open: boolean }>({ html: null, loading: false, error: null, open: false });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const busy = m.create.isPending || m.remove.isPending;

  // Remember the draft (debounced) so leaving the page does not lose the form.
  useEffect(() => {
    const t = setTimeout(() => writeDraft(state), 300);
    return () => clearTimeout(t);
  }, [state]);

  const patch = useCallback((p: Partial<BuilderState>) => setState((s) => ({ ...s, ...p })), []);

  function setSearch(p: Partial<Search>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...p }), replace });
  }
  function select(id: string | null) {
    setSearch({ id: id ?? undefined });
  }
  function setView(v: View) {
    setSearch({ view: v === 'new' ? undefined : v, id: undefined }, false);
  }
  function openFile(p: PacketRow | null | undefined) {
    if (!p || p.status !== 'done' || !p.storageKey) return;
    window.open(packetFileUrl(p.id), '_blank', 'noopener');
  }

  const items = useMemo(() => packets.data?.items ?? [], [packets.data]);
  const latest = useRef({ view, selectedId, detail: detail.data ?? null, state, busy, deleteOpen, previewLoading: preview.loading, canWrite, items });
  latest.current = { view, selectedId, detail: detail.data ?? null, state, busy, deleteOpen, previewLoading: preview.loading, canWrite, items };

  const generate = useCallback(() => {
    const s = latest.current.state;
    if (!s.title.trim() || latest.current.busy || !latest.current.canWrite) return;
    m.create.mutate(toConfig(s), {
      onSuccess: (r) => {
        toast('The packet is being made in the background; it is listed under Past packets.', 'ok');
        setPreview({ html: null, loading: false, error: null, open: false });
        setSearch({ view: 'past', id: r.packet.id }, false);
      },
      onError: fail,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPreview = useCallback(() => {
    const s = latest.current.state;
    if (latest.current.previewLoading) return;
    setPreview({ html: null, loading: true, error: null, open: true });
    setTimeout(() => document.getElementById('export-preview')?.scrollIntoView({ block: 'start' }), 0);
    fetchPreviewHtml(toConfig({ ...s, title: s.title.trim() || 'Untitled packet' }))
      .then((html) => setPreview({ html, loading: false, error: null, open: true }))
      .catch((err: unknown) => setPreview({ html: null, loading: false, error: err instanceof Error ? err.message : String(err), open: true }));
  }, []);

  // The tab is opened inside the click (so it is not treated as a pop-up), then
  // filled from the POST preview through a blob URL; nothing goes in a URL.
  const openPreviewTab = useCallback(() => {
    const s = latest.current.state;
    const w = window.open('', '_blank');
    if (!w) {
      toast('The browser blocked the new tab. Allow pop-ups for CaseFile, or use Preview.', 'bad');
      return;
    }
    try {
      w.opener = null;
    } catch {
      // not settable in this browser; the packet HTML runs no script anyway
    }
    const say = (text: string) => {
      try {
        w.document.title = 'Packet preview';
        w.document.body.textContent = text;
      } catch {
        // the tab was closed or navigated away
      }
    };
    say('Making the packet preview…');
    fetchPreviewHtml(toConfig({ ...s, title: s.title.trim() || 'Untitled packet' }))
      .then((html) => {
        if (w.closed) return;
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        w.location.replace(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        say(`The preview could not be made: ${message}`);
        fail(err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newPacket = useCallback(() => {
    setView('new');
    setTimeout(() => titleRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const useTemplate = useCallback(() => {
    const d = latest.current.detail;
    if (!d) return;
    setState(fromConfig(d.config));
    setPreview({ html: null, loading: false, error: null, open: false });
    setView('new');
    toast('The form now holds that packet’s choices. Change what you need and press Make the packet.', 'info');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = useCallback(() => {
    setState(emptyState());
    clearDraft();
    setPreview({ html: null, loading: false, error: null, open: false });
  }, []);

  const builderVisible = () => latest.current.view === 'new';
  const hasSelection = () => latest.current.view === 'past' && Boolean(latest.current.selectedId) && Boolean(latest.current.detail) && !latest.current.deleteOpen;
  const selectedHasFile = () => {
    const d = latest.current.detail;
    return hasSelection() && Boolean(d && d.status === 'done' && d.storageKey);
  };
  const canGenerate = () => builderVisible() && latest.current.canWrite && latest.current.state.title.trim().length > 0 && !latest.current.busy;
  // Same rule as the Delete action: not while the packet is still being made.
  const canDelete = () => {
    const d = latest.current.detail;
    return hasSelection() && latest.current.canWrite && !latest.current.busy && Boolean(d) && !ACTIVE_PACKET.has(d!.status);
  };

  useBindings(
    [
      { keys: 'n', description: 'Start a new packet (the form, with the title in focus)', group: 'Page', when: () => !dialogOpen(), run: newPacket },
      { keys: 'v v', description: 'Switch between the new packet and the packets already made', group: 'Lists', when: () => !dialogOpen(), run: () => setView(latest.current.view === 'new' ? 'past' : 'new') },
      { keys: 'p', description: 'Preview the packet', group: 'Page', when: () => builderVisible() && !dialogOpen(), run: runPreview },
      { keys: 'ctrl+enter', description: 'Make the packet', group: 'Page', global: true, when: canGenerate, run: generate },
      { keys: 'o', description: 'Open the selected packet', group: 'Page', when: selectedHasFile, run: () => openFile(latest.current.detail) },
      { keys: 't', description: 'Reuse the selected packet for a new one', group: 'Page', when: hasSelection, run: useTemplate },
      { keys: 'Delete', description: 'Delete the selected packet (asks first)', group: 'Page', when: canDelete, run: () => setDeleteOpen(true) },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'export.new', title: 'Make a packet: start a new packet', group: 'Page', keywords: 'export pdf packet build new form', shortcut: 'n', run: newPacket },
      { id: 'export.view.past', title: 'Make a packet: packets already made', group: 'Page', keywords: 'export packets list past made', shortcut: 'v v', when: () => latest.current.view !== 'past', run: () => setView('past') },
      { id: 'export.generate', title: 'Make the packet', group: 'Page', keywords: 'export pdf packet generate', shortcut: 'ctrl+enter', when: canGenerate, run: generate },
      { id: 'export.preview', title: 'Make a packet: preview', group: 'Page', keywords: 'export packet html', shortcut: 'p', when: builderVisible, run: runPreview },
      { id: 'export.preview-tab', title: 'Make a packet: open the preview in a new tab', group: 'Page', keywords: 'export packet html tab', when: builderVisible, run: openPreviewTab },
      { id: 'export.open', title: 'Open the selected packet', group: 'Page', shortcut: 'o', when: selectedHasFile, run: () => openFile(latest.current.detail) },
      { id: 'export.template', title: 'Reuse the selected packet for a new one', group: 'Page', keywords: 'template copy again', shortcut: 't', when: hasSelection, run: useTemplate },
      { id: 'export.delete', title: 'Delete the selected packet', group: 'Page', keywords: 'export packet remove', shortcut: 'Delete', when: canDelete, run: () => setDeleteOpen(true) },
      { id: 'export.reset', title: 'Make a packet: clear the form', group: 'Page', keywords: 'export packet clear draft empty', when: builderVisible, run: resetForm },
    ],
    [],
  );

  const columns = useMemo<ColumnDef<PacketRow, unknown>[]>(
    () => [
      { id: 'created', header: 'Made', accessorKey: 'createdAt', cell: ({ getValue }) => <DateTimeText iso={String(getValue())} />, meta: { width: 128, shrink: false } },
      { id: 'title', header: 'Title', accessorKey: 'title', meta: { grow: true, minWidth: 200 } },
      { id: 'status', header: 'Status', accessorFn: (r) => packetStatusWords(r.status).label, cell: ({ row }) => <PacketStatusTag status={row.original.status} />, meta: { width: 90, shrink: false } },
      { id: 'pages', header: 'Pages', accessorFn: (r) => r.pageCount ?? -1, cell: ({ row }) => (row.original.pageCount == null ? null : row.original.pageCount), meta: { className: 'num', width: 60 } },
    ],
    [],
  );

  const activeCount = items.filter((p) => ACTIVE_PACKET.has(p.status)).length;
  const readyCount = items.filter((p) => p.status === 'done').length;
  const browser = options.data ? browserWords(options.data.browser) : undefined;
  const testNames = useMemo(() => new Map((options.data?.analytes ?? []).map((a) => [a.analyteKey, a.analyte])), [options.data]);

  const builder = (
    <PacketBuilder
      state={state}
      onChange={patch}
      documents={documents.data?.items ?? []}
      documentsLoading={documents.isPending}
      options={options.data}
      busy={busy}
      onGenerate={generate}
      onPreview={runPreview}
      onReset={resetForm}
      preview={preview}
      onClosePreview={() => setPreview((p) => ({ ...p, open: false }))}
      onPreviewTab={openPreviewTab}
      readOnly={!canWrite}
      titleRef={titleRef}
    />
  );

  const list = packets.isPending ? (
    <Loading>Loading packets…</Loading>
  ) : packets.isError ? (
    <Loading>Could not load the packets: {packets.error instanceof Error ? packets.error.message : 'error'}</Loading>
  ) : (
    <DataTable
      columns={columns}
      data={items}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={(r) => select(r?.id ?? null)}
      onOpen={(r) => openFile(r)}
      initialSort={[{ id: 'created', desc: true }]}
      emptyText="No packets yet."
      tableId="export.packets"
      autoFocus
      footer={<span>{activeCount ? `${activeCount} being made · ` : ''}{plural(readyCount, 'packet')} ready</span>}
    />
  );

  const right = !selectedId ? (
    <EmptyState title="Pick a packet">Open it, download it, or reuse its choices for a new one. Move with j and k; Enter opens the file.</EmptyState>
  ) : detail.isPending ? (
    <Loading />
  ) : detail.isError || !detail.data ? (
    <EmptyState
      title="This packet is not available"
      action={
        <Button variant="accent" onClick={newPacket}>
          Start a new packet
        </Button>
      }
    >
      {detail.error instanceof ApiError && detail.error.status === 404 ? 'It was deleted, or the link is old.' : 'It could not be loaded.'} Pick another one on the left.
    </EmptyState>
  ) : (
    <PacketDetail packet={detail.data} busy={busy} readOnly={!canWrite} onOpen={() => openFile(detail.data)} onTemplate={useTemplate} onDelete={() => setDeleteOpen(true)} testNames={testNames} />
  );

  const noPackets = view === 'past' && packets.isSuccess && !items.length;

  return (
    <div className="page">
      <PageHeader
        title="Make a packet"
        meta={
          packets.isSuccess ? (
            <span>
              <span className="mono">{items.length}</span> {items.length === 1 ? 'packet' : 'packets'} made{activeCount ? <>, <span className="mono">{activeCount}</span> being made now</> : null}
            </span>
          ) : null
        }
        intro={INTRO}
        actions={view === 'past' ? { primary: { label: 'Start a new packet', onClick: newPacket, shortcut: 'n', title: 'The form, with the title in focus' } } : undefined}
      />
      <Toolbar label="View">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'new', label: 'New packet', title: 'The form: choose what goes in, preview it, make it' },
            { value: 'past', label: 'Past packets', count: packets.isSuccess ? items.length : undefined, title: 'Packets already made: open, download, reuse or delete' },
          ]}
        />
        <ToolbarKeys
          items={
            view === 'new'
              ? [['n', 'new'], ['v v', 'past packets'], ['p', 'preview'], ['ctrl+enter', 'make'], ['space', 'tick a document'], ['/', 'find a document']]
              : [['j/k', 'move'], ['enter', 'open'], ['esc', 'clear'], ['o', 'open'], ['t', 'reuse'], ['Delete', 'delete'], ['v v', 'new packet']]
          }
        />
      </Toolbar>
      {view === 'new' && options.data && !browser ? (
        <div className="notice warn export-nobrowser" role="status">
          {me.hosted ? (
            <>
              <strong>No PDF maker on the server.</strong> CaseFile makes PDFs with Chromium, which this server does not have (see CASEFILE_CHROME_PATH in the deploy notes), so the packet will be saved as a web page, without the original documents at the end.
            </>
          ) : (
            <>
              <strong>No PDF maker on this computer.</strong> CaseFile makes PDFs with Microsoft Edge or Google Chrome and found neither, so the packet will be saved as a web page, without the original documents at the end.
            </>
          )}
        </div>
      ) : null}
      {view === 'new' ? (
        <div className="page-body export-body">{builder}</div>
      ) : noPackets ? (
        <div className="page-body flush">
          <EmptyState
            title="No packets yet"
            action={
              <Button variant="primary" onClick={newPacket} shortcut="n">
                Start a new packet
              </Button>
            }
          >
            A packet is one PDF of chosen records with a cover page and summaries, made to send to a clinician or bring to a visit. Each one you make is listed here, to open again, download or reuse.
          </EmptyState>
        </div>
      ) : (
        <div className="page-body flush">
          <SplitView storageKey="export" defaultLeft={52} minLeft={440} minRight={440} left={list} right={right} />
        </div>
      )}

      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete ${detail.data ? `“${detail.data.title}”` : 'this packet'}?`}
        body={<span className="muted">The packet is hidden from the list. Its file stays in the encrypted store; nothing is erased.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const id = latest.current.selectedId;
          if (!id) return;
          m.remove.mutate(id, {
            onSuccess: () => {
              toast('Packet deleted', 'ok');
              select(null);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}
