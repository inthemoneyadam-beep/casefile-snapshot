/**
 * /ask — talk to the master clinician over the whole case. Split view: the
 * conversations on the left (a dense table, newest first), the open
 * conversation on the right: its name, one status line and its actions
 * (Rename; Delete and Print under More), the thread, then the composer
 * (features/ask/Composer.tsx: the question box with Ask beside Attach
 * documents, then the labelled "Kind of answer:", "Look at:" and "Depth:").
 *
 * Selection lives in the URL (?session=); ?preset= and ?mode= seed the
 * composer. Keys (group Ask): ctrl+enter send, esc stop (anywhere on the page
 * while an answer runs), [ / ] depth, n new conversation, / write the
 * question, e rename, Delete remove the conversation. The list: j / k, Enter
 * (opens and goes to the question box), Esc. Viewers (who may not write under
 * /api/ask) read conversations only: no send, stop, new, rename, delete or
 * answer settings, and none of their keys or commands.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useAskMutations, useAskSessions, usePresets, type AskSessionListItem } from '../api/ask';
import { useMe } from '../api/users';
import { useFailToast } from '../api/client';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { DetailHeader } from '../ui/DetailPane';
import { SearchField, Toolbar } from '../ui/Toolbar';
import { Confirm, Dialog } from '../ui/Dialog';
import { Input } from '../ui/Field';
import { DateTimeText } from '../ui/DateText';
import { useToast } from '../ui/Toast';
import { ToolbarKeys } from '../ui/Toolbar';
import { ConsultPanel, type ConsultPanelHandle } from '../features/ask/ConsultPanel';
import { NEW_SESSION_EVENT, writeStoredSession } from '../features/ask/live';
import '../features/ask/ask.css';

const searchSchema = z.object({
  session: z.string().optional().catch(undefined),
  preset: z.string().optional().catch(undefined),
  mode: z.enum(['question', 'search', 'draft', 'briefing']).optional().catch(undefined),
});
type AskSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/ask')({
  validateSearch: (s: Record<string, unknown>): AskSearch => searchSchema.parse(s),
  component: AskPage,
});

/** "1 message", "4 messages". */
function messages(n: number): string {
  return `${n} message${n === 1 ? '' : 's'}`;
}

function AskPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const fail = useFailToast();
  const sessions = useAskSessions();
  const { presets } = usePresets();
  const readOnly = useMe().isViewer;
  const m = useAskMutations();
  const panel = useRef<ConsultPanelHandle>(null);
  const [filter, setFilter] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const sessionId = search.session ?? null;

  const setSearch = useCallback(
    (patch: Partial<AskSearch>, replace = true) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
    },
    [navigate],
  );
  const selectSession = useCallback(
    (id: string | null) => {
      writeStoredSession(id);
      setSearch({ session: id ?? undefined });
    },
    [setSearch],
  );

  useEffect(() => {
    const onNew = () => setSearch({ session: undefined });
    window.addEventListener(NEW_SESSION_EVENT, onNew);
    return () => window.removeEventListener(NEW_SESSION_EVENT, onNew);
  }, [setSearch]);

  const all = useMemo(() => sessions.data?.items ?? [], [sessions.data]);
  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  }, [all, filter]);
  const selected = useMemo(() => (sessionId ? (all.find((s) => s.id === sessionId) ?? null) : null), [all, sessionId]);
  const depthLabel = useCallback((key: string | null) => (key ? (presets.find((p) => p.key === key)?.label ?? null) : null), [presets]);

  const latest = useRef({ sessionId, selected, dialogOpen: renameOpen || deleteOpen });
  latest.current = { sessionId, selected, dialogOpen: renameOpen || deleteOpen };

  const newSession = useCallback(() => {
    selectSession(null);
    setTimeout(() => panel.current?.focusComposer(), 0);
  }, [selectSession]);
  const openRename = useCallback(() => {
    const s = latest.current.selected;
    if (!s) return;
    setRenameText(s.title);
    setRenameOpen(true);
  }, []);
  const saveRename = () => {
    if (!sessionId || !renameText.trim()) return;
    m.renameSession.mutate({ id: sessionId, title: renameText.trim() }, { onSuccess: () => setRenameOpen(false), onError: fail });
  };

  // Every page key and command writes (or feeds the composer), so a viewer gets none of them.
  useBindings(
    readOnly
      ? []
      : [
          { keys: 'ctrl+enter', description: 'Send the question', group: 'Ask', global: true, run: () => !latest.current.dialogOpen && panel.current?.send() },
          // Outside the composer (the textarea handles its own esc); only while an answer runs, so esc keeps its other meanings otherwise.
          { keys: 'esc', description: 'Stop the answer being written', group: 'Ask', when: () => !latest.current.dialogOpen && Boolean(panel.current?.isRunning()), run: () => panel.current?.stop() },
          { keys: '[', description: 'Quicker answer (Depth one step left)', group: 'Ask', run: () => !latest.current.dialogOpen && panel.current?.moveSlider(-1) },
          { keys: ']', description: 'Deeper answer (Depth one step right)', group: 'Ask', run: () => !latest.current.dialogOpen && panel.current?.moveSlider(1) },
          { keys: 'n', description: 'New conversation', group: 'Ask', run: () => !latest.current.dialogOpen && newSession() },
          // A page binding sits above the global "/" (this page's question box, not its Find box); typed as text in a field.
          { keys: '/', description: 'Write a question to the clinician', group: 'Ask', run: () => !latest.current.dialogOpen && panel.current?.focusComposer() },
          { keys: 'e', description: 'Rename the selected conversation', group: 'Ask', when: () => Boolean(latest.current.selected), run: () => !latest.current.dialogOpen && openRename() },
          { keys: 'Delete', description: 'Delete the selected conversation (asks first)', group: 'Ask', when: () => Boolean(latest.current.selected), run: () => !latest.current.dialogOpen && setDeleteOpen(true) },
        ],
    [readOnly, newSession, openRename],
  );

  useRegisterCommands(
    readOnly
      ? []
      : [
          { id: 'ask.page.new', title: 'New conversation', group: 'Ask', keywords: 'consult session', shortcut: 'n', run: newSession },
          { id: 'ask.page.presets', title: 'Answer settings: what each step of Depth uses', group: 'Ask', keywords: 'slider depth model effort context presets consult settings', run: () => panel.current?.openPresets() },
          { id: 'ask.page.write', title: 'Write a question to the clinician', group: 'Ask', keywords: 'compose focus question box', shortcut: '/', run: () => panel.current?.focusComposer() },
          { id: 'ask.page.rename', title: 'Rename the conversation', group: 'Ask', keywords: 'session title', shortcut: 'e', when: () => Boolean(latest.current.selected), run: openRename },
          { id: 'ask.page.delete', title: 'Delete the conversation', group: 'Ask', keywords: 'session remove', shortcut: 'Delete', when: () => Boolean(latest.current.selected), run: () => setDeleteOpen(true) },
          { id: 'ask.page.print', title: 'Print the conversation', group: 'Ask', keywords: 'paper pdf session', when: () => Boolean(latest.current.selected), run: () => window.print() },
          { id: 'ask.page.master', title: 'Ask with Master clinician', group: 'Ask', keywords: 'deepest depth', run: () => { setSearch({ preset: 'master' }); setTimeout(() => panel.current?.focusComposer(), 0); } },
        ],
    [readOnly, newSession, openRename, setSearch],
  );

  const columns = useMemo<ColumnDef<AskSessionListItem, unknown>[]>(
    () => [
      {
        id: 'title',
        header: 'Conversation',
        accessorKey: 'title',
        cell: ({ row }) => {
          const depth = depthLabel(row.original.lastPreset);
          return (
            <div className="ask-session-cell">
              <span className="ask-session-title">{row.original.title}</span>
              <span className="ask-session-sub">
                {messages(row.original.messageCount)}
                {depth ? ` · ${depth}` : ''}
              </span>
            </div>
          );
        },
        meta: { grow: true, minWidth: 200, className: 'wrap' },
      },
      { id: 'last', header: 'Last message', accessorFn: (r) => r.lastAt ?? r.updatedAt, cell: ({ row }) => <DateTimeText iso={row.original.lastAt ?? row.original.updatedAt} />, meta: { width: 136, shrink: false } },
    ],
    [depthLabel],
  );

  const left = sessions.isPending ? (
    <Loading>Loading conversations…</Loading>
  ) : sessions.isError ? (
    <EmptyState title="The conversations could not be loaded" action={<Button onClick={() => void sessions.refetch()}>Try again</Button>}>
      {sessions.error instanceof Error ? sessions.error.message : 'Something went wrong.'}
    </EmptyState>
  ) : !all.length ? (
    <EmptyState title="No conversations yet">
      {readOnly
        ? 'Conversations show here once an owner or editor asks the clinician something.'
        : 'Each question you ask starts a conversation, listed here with its date. Write your first one on the right, or pick one of the suggested questions there.'}
    </EmptyState>
  ) : (
    <DataTable
      columns={columns}
      data={items}
      rowId={(r) => r.id}
      selectedId={sessionId}
      onSelect={(r) => {
        // esc in the list clears the selection, except while an answer runs: then esc stops it.
        if (!r && panel.current?.isRunning()) return;
        selectSession(r?.id ?? null);
      }}
      onOpen={(r) => {
        selectSession(r.id);
        setTimeout(() => panel.current?.focusComposer(), 0);
      }}
      initialSort={[{ id: 'last', desc: true }]}
      tableId="ask.sessions"
      // j / k work on arrival; a link that asks for a kind of answer or a depth keeps the question box instead.
      autoFocus={!search.preset && !search.mode}
      emptyText="No conversation title matches. Clear the Find box to see them all."
      footer={filter.trim() ? <span>{all.length} conversations in all</span> : null}
    />
  );

  const right = (
    <div className="ask-pane">
      {/* The shared detail header: title, one status line, then the actions on their own row as in every other pane. */}
      <div className="ask-head">
        <DetailHeader
          title={selected ? selected.title : 'New conversation'}
          titleHint={selected?.title}
          status={
            selected
              ? [messages(selected.messageCount), selected.lastAt ? <span key="at">last <DateTimeText iso={selected.lastAt} /></span> : null, depthLabel(selected.lastPreset)]
              : readOnly
                ? 'Pick a conversation to read it.'
                : 'Your first question starts it and gives it a name.'
          }
          actions={
            selected && !readOnly
              ? {
                  secondary: [{ label: 'Rename', onClick: openRename, shortcut: 'e', title: 'Give the conversation another name' }],
                  more: [
                    { label: 'Print the conversation', onClick: () => window.print(), title: 'The questions and answers, with every source listed under its answer' },
                    'separator',
                    { label: 'Delete the conversation…', onClick: () => setDeleteOpen(true), shortcut: 'Delete', danger: true, title: 'Removes the conversation (asks first); documents, details and to-dos made from it stay' },
                  ],
                }
              : undefined
          }
        />
      </div>
      <ConsultPanel ref={panel} sessionId={sessionId} onSessionChange={selectSession} presetKey={search.preset ?? null} mode={search.mode ?? null} />
    </div>
  );

  return (
    <div className="page ask-page">
      <PageHeader
        title="Ask the clinician"
        meta={sessions.data ? <span className="mono">{all.length} conversation{all.length === 1 ? '' : 's'}</span> : null}
        intro="Ask anything about the whole case. Every statement in an answer cites the page it comes from."
        actions={
          readOnly
            ? undefined
            : {
                primary: { label: 'New conversation', onClick: newSession, shortcut: 'n', title: 'Start a fresh conversation; the question box gets the cursor' },
                secondary: [{ label: 'Answer settings', onClick: () => panel.current?.openPresets(), title: 'What each step of Depth uses: how hard Claude thinks and how much of the case it reads' }],
              }
        }
      />
      <Toolbar label="Find a conversation">
        {all.length ? <SearchField label="Find" placeholder="Conversation name" value={filter} onChange={setFilter} width={260} /> : null}
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['enter', 'open'],
            readOnly ? null : ['/', 'write'],
            readOnly ? null : ['ctrl+enter', 'ask'],
            readOnly ? null : ['[/]', 'depth'],
            readOnly ? null : ['n', 'new'],
            readOnly ? null : ['esc', 'stop'],
          ]}
        >
          {filter ? (
            <Button size="sm" variant="ghost" onClick={() => setFilter('')}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      <div className="page-body flush">
        <SplitView storageKey="ask" defaultLeft={32} minLeft={340} minRight={560} left={left} right={right} />
      </div>

      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename the conversation"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!renameText.trim() || m.renameSession.isPending} onClick={saveRename}>
              Save
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveRename();
            }
          }}
          style={{ width: '100%' }}
          aria-label="Conversation name"
        />
      </Dialog>
      <Confirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this conversation?"
        body={<span className="muted">The conversation and its citation links are removed. Details, documents and to-dos made from it are untouched.</span>}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const id = latest.current.sessionId;
          if (!id) return;
          m.deleteSession.mutate(id, {
            onSuccess: () => {
              toast('Conversation deleted', 'ok');
              selectSession(null);
            },
            onError: fail,
          });
        }}
      />
    </div>
  );
}
