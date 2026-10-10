/**
 * /communications — Calls and messages: every phone call, portal message,
 * email and letter with the care team, and what anyone promised to do next.
 *
 * Header: Log a call or message (the one primary). Toolbar: View (All ·
 * Threads · By person · Promised follow-ups), Find (subject, summary, topic or
 * name), Logged by (you, or read from records), How (the channel) and, under
 * More filters, Direction and Topic, each labelled.
 *
 * Messages read out of records (2026-10-07: a chart print holds hundreds) are
 * shown as conversations collapsed to one row each, in All and in Threads;
 * picking one (?thread=) shows every message oldest first on the right, the
 * chosen one (?id=) in full: its words exactly as printed, whose words they
 * are, read receipts, the pages it is on and the copies filed separately.
 * Split view: the list left, the chosen one right. While nothing is chosen the
 * right pane says what to do and lists the call and message documents not
 * logged yet, each with "Log it" (the dialog starts filled in from the
 * document). With nothing logged at all the page is one empty state with the
 * same offer. Selection and every filter live in the URL.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useCommunication, useCommunicationMutations, useCommunications, useFollowUps, useMatrix, useTopics, type Communication, type MatrixData } from '../api/communications';
import { usePeople } from '../api/people';
import { useDocumentsLite } from '../api/records';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { SplitView } from '../ui/SplitView';
import { Confirm } from '../ui/Dialog';
import { DateText } from '../ui/DateText';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { ApiError } from '../api/client';
import { COMM_CHANNELS, COMM_DIRECTIONS } from '@shared/enums';
import { CommunicationDetail, FollowUpTag } from '../features/communications/CommunicationDetail';
import { CommunicationDialog } from '../features/communications/CommunicationDialog';
import { MatrixView, PersonTopicsPane } from '../features/communications/MatrixView';
import { MessageDocuments } from '../features/communications/MessageDocuments';
import { presetFromDocument, unloggedMessageDocuments, type CommPreset, type DocLike } from '../features/communications/fromDocuments';
import { NO_TOPIC, pivot, topicWords } from '../features/communications/matrix';
import { CHANNEL_WORDS, DIRECTION_HINT, DIRECTION_WORDS, channelWords, dialogOpen, plural } from '../features/people/shared';
import { ThreadPane, chronological, threadsFromCommunications } from '../features/communications/Threads';
import { detailsOf, isFromRecords, useThreads, type ThreadListItem } from '../api/communications';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/people/contacts.css';

const VIEWS = ['list', 'threads', 'matrix', 'followups'] as const;
const NO_MATRIX: MatrixData = { items: [], people: [], topics: [] };
type View = (typeof VIEWS)[number];
const VIEW_WORDS: Record<View, string> = { list: 'All', threads: 'Threads', matrix: 'By person', followups: 'Promised follow-ups' };
/** Who logged it: you (by hand or from a spreadsheet), or Claude reading it out of a record. */
const BY = ['you', 'records'] as const;
type By = (typeof BY)[number];
/** What each view holds, in one line under the toolbar (the list itself needs none: the page intro says it). */
const VIEW_INTRO: Partial<Record<View, string>> = {
  threads: 'Conversations: the messages and replies of one subject, collapsed to one row each. Pick one to read every message, oldest first, word for word.',
  matrix: 'Who you have been in touch with, and about what. Each number is how many calls and messages; pick one to list them.',
  followups: 'Everything someone promised to do after a call or message, soonest due first. Mark one done when it has happened.',
};
const INTRO = 'Phone calls, portal messages, emails and letters with your care team, and anything someone promised to do next.';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  personId: z.string().optional().catch(undefined),
  topic: z.string().optional().catch(undefined),
  channel: z.enum(COMM_CHANNELS).optional().catch(undefined),
  direction: z.enum(COMM_DIRECTIONS).optional().catch(undefined),
  view: z.enum(VIEWS).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  done: z.boolean().optional().catch(undefined),
  /** The conversation shown on the right (an opaque key). */
  thread: z.string().max(120).optional().catch(undefined),
  /** Only the ones you logged, or only the ones read out of records. */
  by: z.enum(BY).optional().catch(undefined),
});

/** A row of the All list: a call or message, or a conversation read out of a record collapsed to one row. */
type ListRow = Communication & { thread?: { key: string; count: number } };
const threadRowId = (key: string) => `t:${key}`;

/** Logged by you (by hand, or from a spreadsheet you imported) or read out of a record. */
function loggedBy(c: Communication): By {
  return isFromRecords(c) ? 'records' : 'you';
}

/**
 * The All list: messages read out of records that belong to a conversation are collapsed into one row per
 * conversation (its newest message stands for it, with how many there are); everything else is one row each.
 */
function collapseThreads(rows: Communication[]): ListRow[] {
  // Every row of a conversation that holds a message read out of a record, a copy filed on its own included
  // (2026-10-07 review, rev-comms #10: the filed copy stood beside its own conversation and the count was one short).
  const counts = new Map<string, number>();
  const fromRecords = new Set<string>();
  for (const c of rows) {
    if (!c.threadKey) continue;
    counts.set(c.threadKey, (counts.get(c.threadKey) ?? 0) + 1);
    if (isFromRecords(c)) fromRecords.add(c.threadKey);
  }
  const collapsed = (key: string | null | undefined): key is string => Boolean(key && fromRecords.has(key) && (counts.get(key) ?? 0) >= 2);
  const newest = new Map<string, Communication>();
  const named = new Map<string, Communication>();
  /** How a row ranks for naming its conversation: a portal message printed in the record, then any row of it, then the rest. */
  const rank = (c: Communication) => (isFromRecords(c) ? (c.channel === 'portal' ? 0 : 1) : 2);
  for (const c of rows) {
    if (!collapsed(c.threadKey)) continue;
    const key = c.threadKey;
    const prev = newest.get(key);
    if (!prev || chronological([prev, c])[1] === c) newest.set(key, c);
    const name = named.get(key);
    if (!name || rank(c) < rank(name) || (rank(c) === rank(name) && chronological([name, c])[0] === c)) named.set(key, c);
  }
  const out: ListRow[] = [];
  const placed = new Set<string>();
  for (const c of rows) {
    const key = collapsed(c.threadKey) ? c.threadKey : null;
    if (!key) {
      out.push(c);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    // Dated by its newest message; named by the subject printed on its first message in the record.
    out.push({ ...(newest.get(key) ?? c), subject: named.get(key)?.subject ?? c.subject, thread: { key, count: counts.get(key) ?? 1 } });
  }
  return out;
}
type CommSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/communications')({
  validateSearch: (s: Record<string, unknown>): CommSearch => searchSchema.parse(s),
  component: CommunicationsPage,
});

function withNames(c: Communication): string {
  return c.participants.map((p) => p.name).join(', ');
}

/** The author as the record printed it, for a message read out of a record with nobody linked yet. */
function authorOf(c: Communication): string {
  try {
    const d = JSON.parse(c.detailsJson || '{}') as { authorText?: string };
    return d.authorText ?? '';
  } catch {
    return '';
  }
}

function CommunicationsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  const view: View = search.view ?? 'list';
  const listFilters = { personId: search.personId, topic: search.topic, channel: search.channel, direction: search.direction, q: search.q };
  const list = useCommunications(listFilters);
  const threads = useThreads({ personId: search.personId, fromRecords: search.by === 'records' ? true : search.by === 'you' ? false : undefined, q: search.q }, view === 'threads');
  const [focusToken, setFocusToken] = useState(0);
  // Everything logged, unfiltered: the counts in the header, and which documents are already logged.
  const everything = useCommunications({});
  const matrix = useMatrix(view === 'matrix');
  const followUps = useFollowUps(Boolean(search.done), view === 'followups');
  const topics = useTopics();
  const people = usePeople({});
  const documents = useDocumentsLite();
  const current = useCommunication(search.id);
  const { remove, done, reopen } = useCommunicationMutations();
  const [dialog, setDialog] = useState<'none' | 'new' | 'edit' | 'delete'>('none');
  const [preset, setPreset] = useState<CommPreset | null>(null);
  const [moreFilters, setMoreFilters] = useState(Boolean(search.direction || search.topic));
  useEffect(() => {
    if (search.direction || search.topic) setMoreFilters(true);
  }, [search.direction, search.topic]);

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  const selected = current.data && current.data.id === search.id ? current.data : null;
  // A message of a conversation read out of a record opens in its conversation, even from a deep link (?id= alone).
  const openThread = search.thread ?? (selected?.threadKey && isFromRecords(selected) ? selected.threadKey : null);
  const personName = search.personId ? (people.data?.items.find((p) => p.id === search.personId)?.name ?? 'this person') : null;

  const setSearch = useCallback(
    (patch: Partial<CommSearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );
  const setView = (v: View) => setSearch({ view: v === 'list' ? undefined : v, thread: v === 'list' || v === 'threads' ? search.thread : undefined });
  const focusList = () => document.querySelector<HTMLElement>('.contacts .split-left .table-wrap')?.focus();
  const openThreadMessages = (key: string) => {
    setSearch({ thread: key, id: undefined });
    setFocusToken((n) => n + 1);
  };
  const openDocument = (c: Communication | null) => {
    if (!c?.documentId) return;
    // A message read out of a record opens on its own page, not on page 1 of the record.
    const page = detailsOf(c).headerPage ?? detailsOf(c).pages?.[0];
    void navigate({ to: '/documents/$id', params: { id: c.documentId }, search: page ? { page } : {} });
  };
  const openRow = (c: Communication) => {
    if (c.documentId) openDocument(c);
    else if (c.participants[0]) void navigate({ to: '/people', search: { id: c.participants[0].personId } });
  };
  const openCell = useCallback(
    (personId: string, topic?: string) => {
      setSearch({ view: undefined, personId, topic: topic === undefined ? undefined : topic === '' ? NO_TOPIC : topic, id: undefined });
    },
    [setSearch],
  );
  function logFrom(d: DocLike) {
    setPreset(presetFromDocument(d));
    setDialog('new');
  }
  function logNew() {
    setPreset(null);
    setDialog('new');
  }

  async function toggleFollowUp() {
    if (!selected?.followUpPromised) {
      toast('Nothing was promised on this one. Edit it (e) to add a follow-up.');
      return;
    }
    try {
      if (selected.followUpDoneAt) {
        await reopen.mutateAsync(selected.id);
        toast('Follow-up reopened.');
      } else {
        await done.mutateAsync(selected.id);
        toast('Follow-up marked done.', 'ok');
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'bad');
    }
  }
  async function doDelete() {
    if (!selected) return;
    try {
      await remove.mutateAsync(selected.id);
      toast('Call or message deleted.', 'ok');
      setSearch({ id: undefined });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', 'bad');
    }
  }

  const guard = (fn: () => void) => () => {
    if (!dialogOpen()) fn();
  };
  const actions = {
    newComm: guard(logNew),
    edit: guard(() => selected && setDialog('edit')),
    del: guard(() => selected && setDialog('delete')),
    toggle: guard(() => void toggleFollowUp()),
    openDoc: guard(() => openDocument(selected)),
    list: guard(() => setView('list')),
    threads: guard(() => setView('threads')),
    matrix: guard(() => setView('matrix')),
    followups: guard(() => setView('followups')),
  };

  useBindings(
    [
      { keys: 'n', description: 'Log a call or message', group: 'Communications', run: actions.newComm },
      { keys: 'e', description: 'Edit selected call or message', group: 'Communications', run: actions.edit },
      { keys: 'f', description: 'Mark follow-up done / reopen', group: 'Communications', run: actions.toggle },
      { keys: 'o', description: 'Open the document of the selected call or message', group: 'Communications', when: () => Boolean(selected?.documentId), run: actions.openDoc },
      { keys: 'Delete', description: 'Delete selected call or message', group: 'Communications', run: actions.del },
      { keys: 'v l', description: 'Show all', group: 'Communications', run: actions.list },
      { keys: 'v t', description: 'Show the conversations (threads)', group: 'Communications', run: actions.threads },
      { keys: 'v m', description: 'Show by person (who, about what)', group: 'Communications', run: actions.matrix },
      { keys: 'v f', description: 'Show promised follow-ups', group: 'Communications', run: actions.followups },
    ],
    [selected?.id, selected?.followUpDoneAt, selected?.followUpPromised, selected?.documentId, view],
  );
  useRegisterCommands(
    [
      { id: 'comms.new', title: 'Log a call or message', group: 'Calls and messages', shortcut: 'n', keywords: 'log call portal message email contact new communication', run: actions.newComm },
      { id: 'comms.matrix', title: 'Calls and messages by person (who, about what)', group: 'Calls and messages', shortcut: 'v m', keywords: 'matrix', run: actions.matrix },
      { id: 'comms.followups', title: 'Promised follow-ups', group: 'Calls and messages', shortcut: 'v f', keywords: 'promised due overdue follow-ups', run: actions.followups },
      { id: 'comms.list', title: 'All calls and messages', group: 'Calls and messages', shortcut: 'v l', keywords: 'communications list', run: actions.list },
      { id: 'comms.threads', title: 'Conversations (threads)', group: 'Calls and messages', shortcut: 'v t', keywords: 'threads conversations messages replies from records chart print', run: actions.threads },
      { id: 'comms.by.records', title: 'Only calls and messages read out of records', group: 'Calls and messages', keywords: 'from records extracted logged by filter', run: () => setSearch({ by: 'records', id: undefined }) },
      { id: 'comms.by.you', title: 'Only calls and messages you logged', group: 'Calls and messages', keywords: 'logged by you manual filter', run: () => setSearch({ by: 'you', id: undefined }) },
      { id: 'comms.edit', title: 'Edit the selected call or message', group: 'Calls and messages', keywords: 'communication', shortcut: 'e', run: actions.edit, when: () => Boolean(selected) },
      { id: 'comms.toggle', title: selected?.followUpDoneAt ? 'Reopen the follow-up' : 'Mark the follow-up done', group: 'Calls and messages', shortcut: 'f', run: actions.toggle, when: () => Boolean(selected?.followUpPromised) },
      { id: 'comms.open-document', title: 'Open the document of the selected call or message', group: 'Calls and messages', keywords: 'transcript message source', shortcut: 'o', run: actions.openDoc, when: () => Boolean(selected?.documentId) },
      { id: 'comms.delete', title: 'Delete the selected call or message', group: 'Calls and messages', keywords: 'communication remove', shortcut: 'Delete', run: actions.del, when: () => Boolean(selected) },
    ],
    [selected?.id, selected?.followUpDoneAt, selected?.followUpPromised, selected?.documentId],
  );

  // Widths that fit the list pane at 1280 (about 630px) with nothing out of view: Date, Subject (takes the room and
  // wraps), With, How, Follow-up. Direction and topics are in the detail and the filters.
  const listColumns = useMemo<ColumnDef<ListRow, unknown>[]>(
    () => [
      {
        id: 'date',
        header: 'Date',
        accessorFn: (r) => r.occurredAt ?? '',
        cell: (c) => <DateText iso={c.row.original.occurredAt} precision={c.row.original.occurredAtPrecision} text={c.row.original.occurredAtText} />,
        meta: { width: 96, shrink: false },
      },
      {
        id: 'subject',
        header: 'Subject',
        accessorKey: 'subject',
        cell: (c) => {
          const r = c.row.original;
          return r.thread ? (
            <span>
              {r.subject} <span className="muted">· conversation of {r.thread.count} messages</span>
            </span>
          ) : (
            <span>{r.subject}</span>
          );
        },
        meta: { grow: true, minWidth: 200 },
      },
      {
        id: 'with',
        header: 'With',
        accessorFn: (r) => withNames(r) || authorOf(r),
        cell: (c) => {
          const who = withNames(c.row.original) || authorOf(c.row.original);
          return who ? <span>{who}</span> : <span className="faint">Nobody named</span>;
        },
        meta: { width: 110, maxWidth: 180, wrap: true },
      },
      { id: 'channel', header: 'How', accessorFn: (r) => channelWords(r.channel), cell: (c) => <span className="muted" title={`${channelWords(c.row.original.channel)}, ${(DIRECTION_HINT[c.row.original.direction] ?? '').toLowerCase()}`}>{c.getValue<string>()}</span>, meta: { width: 84, maxWidth: 130, wrap: true } },
      {
        id: 'followup',
        header: 'Follow-up',
        accessorFn: (r) => (r.followUpPromised ? (r.followUpDoneAt ? 'z' : (r.followUpDue ?? '9999')) : ''),
        cell: (c) => {
          const r = c.row.original;
          if (!r.followUpPromised) return null;
          // Still open with a date: "due 2026-10-20"; overdue and done say so in a tag (the date is in the hover).
          if (!r.followUpDoneAt && !r.overdue && r.followUpDue)
            return (
              <span className="cm-follow" title={r.followUpPromised}>
                <span className="muted">due</span> <DateText iso={r.followUpDue} />
              </span>
            );
          return (
            <span className="cm-follow" title={`${r.followUpPromised}${r.followUpDue ? ` (due ${r.followUpDue})` : ''}`}>
              <FollowUpTag c={r} />
            </span>
          );
        },
        meta: { width: 84, maxWidth: 130, shrink: false },
      },
    ],
    [],
  );

  const followUpColumns = useMemo<ColumnDef<Communication, unknown>[]>(
    () => [
      {
        id: 'due',
        header: 'Due',
        accessorFn: (r) => r.followUpDue ?? '9999',
        cell: (c) => (c.row.original.followUpDue ? <DateText iso={c.row.original.followUpDue} /> : <span className="faint">No date</span>),
        meta: { width: 96, shrink: false },
      },
      { id: 'promised', header: 'Promised', accessorFn: (r) => r.followUpPromised ?? '', meta: { grow: true, minWidth: 200 } },
      { id: 'state', header: 'Status', accessorFn: (r) => (r.followUpDoneAt ? 'done' : r.overdue ? 'overdue' : 'open'), cell: (c) => <FollowUpTag c={c.row.original} />, meta: { width: 84, shrink: false } },
      { id: 'owner', header: 'Who owes it', accessorFn: (r) => r.followUpOwnerName ?? withNames(r), cell: (c) => (c.getValue<string>() ? <span>{c.getValue<string>()}</span> : <span className="faint">Nobody named</span>), meta: { width: 110, maxWidth: 170, wrap: true } },
      { id: 'subject', header: 'From', accessorKey: 'subject', cell: (c) => <span className="muted">{c.row.original.subject}</span>, meta: { width: 110, maxWidth: 170, wrap: true } },
    ],
    [],
  );

  // The conversations list: Last (newest message), Subject (with its last words under it), Messages, Follow-ups.
  const threadColumns = useMemo<ColumnDef<ThreadListItem, unknown>[]>(
    () => [
      { id: 'last', header: 'Last', accessorFn: (t) => t.lastAt ?? '', cell: (c) => <DateText iso={c.row.original.lastAt} />, meta: { width: 96, shrink: false } },
      {
        id: 'subject',
        header: 'Subject',
        accessorKey: 'subject',
        cell: (c) => (
          <span className="cm-thread-row">
            <span>{c.row.original.subject}</span>
            {c.row.original.lastSnippet ? <span className="cm-thread-snippet">{c.row.original.lastSnippet}</span> : null}
          </span>
        ),
        meta: { grow: true, minWidth: 220, wrap: false },
      },
      { id: 'count', header: 'Messages', accessorKey: 'count', cell: (c) => <span className="mono">{c.row.original.count}</span>, meta: { className: 'num', width: 84 } },
      { id: 'open', header: 'Follow-ups', accessorKey: 'openFollowUps', cell: (c) => (c.row.original.openFollowUps ? <span className="mono">{c.row.original.openFollowUps} open</span> : null), meta: { width: 90, shrink: false } },
    ],
    [],
  );

  const all = useMemo(() => everything.data?.items ?? [], [everything.data]);
  // Logged by you or read out of records; conversations read out of records collapsed to one row each.
  const listRows = useMemo(() => collapseThreads((list.data?.items ?? []).filter((c) => !search.by || loggedBy(c) === search.by)), [list.data, search.by]);
  /** Which collapsed row a message belongs to (its conversation's row is the one highlighted). */
  const threadOfRow = useMemo(() => new Map((list.data?.items ?? []).filter((c) => c.threadKey && isFromRecords(c)).map((c) => [c.id, c.threadKey as string])), [list.data]);
  const fromRecordsCount = useMemo(() => all.filter((c) => isFromRecords(c)).length, [all]);
  // The conversations: the server's list, or worked out on the page while the server has none.
  const threadRows = useMemo<ThreadListItem[]>(() => {
    if (threads.data?.length) return threads.data;
    const base = all.filter((c) => (!search.by || loggedBy(c) === search.by) && (!search.personId || c.participants.some((p) => p.personId === search.personId)));
    const q = search.q?.trim().toLowerCase();
    const items = threadsFromCommunications(base);
    return q ? items.filter((t) => `${t.subject} ${t.lastSnippet}`.toLowerCase().includes(q)) : items;
  }, [threads.data, all, search.by, search.personId, search.q]);
  const listSelectedId = search.thread ? threadRowId(search.thread) : search.id ? (threadOfRow.has(search.id) && listRows.some((r) => r.thread?.key === threadOfRow.get(search.id!)) ? threadRowId(threadOfRow.get(search.id)!) : search.id) : null;
  const followRows = followUps.data?.items ?? [];
  const matrixData = matrix.data ?? NO_MATRIX;
  const openCount = useMemo(() => all.filter((c) => c.followUpPromised && !c.followUpDoneAt).length, [all]);
  const overdueCount = useMemo(() => all.filter((c) => c.followUpPromised && !c.followUpDoneAt && c.overdue).length, [all]);
  const matrixSide = useMemo(() => (view === 'matrix' && search.personId ? (pivot(matrixData).rows.find((r) => r.personId === search.personId) ?? null) : null), [view, search.personId, matrixData]);
  const unlogged = useMemo(() => (everything.isSuccess ? unloggedMessageDocuments(documents.data ?? [], all) : []), [documents.data, all, everything.isSuccess]);

  const anyFilter = Boolean(search.personId || search.topic || search.q || search.channel || search.direction || search.by);
  const nothingYet = everything.isSuccess && all.length === 0 && view === 'list' && !anyFilter;
  const moreOn = [search.direction, search.topic].filter(Boolean).length;
  const clearFilters = () => {
    setQLocal('');
    setSearch({ personId: undefined, topic: undefined, q: undefined, channel: undefined, direction: undefined, by: undefined, id: undefined, thread: undefined });
  };

  const meta = everything.isPending || !all.length ? null : (
    <span className="mono">
      {plural(all.length, 'call or message', 'calls and messages')}
      {fromRecordsCount ? ` · ${fromRecordsCount} read from records` : ''}
      {openCount ? ` · ${plural(openCount, 'open follow-up')}` : ''}
      {overdueCount ? ` · ${overdueCount} overdue` : ''}
    </span>
  );

  const leftPane =
    view === 'matrix' ? (
      matrix.isPending ? (
        <Loading>Loading who you have been in touch with…</Loading>
      ) : (
        <MatrixView data={matrixData} selectedPersonId={search.personId ?? null} onSelectPerson={(pid) => setSearch({ personId: pid ?? undefined })} onOpenCell={openCell} />
      )
    ) : view === 'followups' ? (
      followUps.isPending ? (
        <Loading>Loading the follow-ups…</Loading>
      ) : (
        <DataTable
          columns={followUpColumns}
          data={followRows}
          rowId={(r) => r.id}
          selectedId={search.id ?? null}
          onSelect={(r) => setSearch({ id: r?.id })}
          onOpen={openRow}
          initialSort={[]}
          tableId="communications.follow-ups"
          autoFocus
          emptyText={search.done ? 'Nothing has been promised on a call or message yet. Add a promise when you log one (or edit one).' : 'No open follow-ups: everything promised has been done.'}
        />
      )
    ) : view === 'threads' ? (
      threads.isPending && !all.length ? (
        <Loading>Loading the conversations…</Loading>
      ) : (
        <DataTable
          columns={threadColumns}
          data={threadRows}
          rowId={(t) => threadRowId(t.key)}
          selectedId={search.thread ? threadRowId(search.thread) : null}
          onSelect={(t) => setSearch({ thread: t?.key, id: undefined })}
          onOpen={(t) => openThreadMessages(t.key)}
          initialSort={[]}
          tableId="communications.threads"
          autoFocus
          emptyText={anyFilter ? 'No conversation matches these filters. Clear filters (in the toolbar) shows them all.' : 'No conversations yet. Messages read out of your records, and their replies, are gathered here.'}
        />
      )
    ) : list.isPending ? (
      <Loading>Loading the calls and messages…</Loading>
    ) : list.isError ? (
      <Loading>Could not load the calls and messages: {list.error instanceof ApiError ? list.error.message : 'error'}</Loading>
    ) : (
      <DataTable
        columns={listColumns}
        data={listRows}
        rowId={(r) => (r.thread ? threadRowId(r.thread.key) : r.id)}
        selectedId={listSelectedId}
        onSelect={(r) => (r?.thread ? setSearch({ thread: r.thread.key, id: undefined }) : setSearch({ id: r?.id, thread: undefined }))}
        onOpen={(r) => (r.thread ? openThreadMessages(r.thread.key) : openRow(r))}
        initialSort={[]}
        tableId="communications.list"
        autoFocus
        emptyText={anyFilter ? 'Nothing matches these filters. Clear filters (in the toolbar) shows them all.' : 'Nothing logged yet.'}
      />
    );

  const rightPane =
    view === 'matrix' ? (
      matrixSide ? (
        <PersonTopicsPane row={matrixSide} onOpenCell={openCell} />
      ) : matrixData.people.length ? (
        <EmptyState title="Pick a person">See what you talked about with them, topic by topic. Move with j and k; Enter lists every call and message with them.</EmptyState>
      ) : (
        <EmptyState
          title="No one to show yet"
          action={
            <Button variant="primary" onClick={actions.newComm} shortcut="n">
              Log a call or message
            </Button>
          }
        >
          Each person you log a call or message with gets a row here, with what you talked about.
        </EmptyState>
      )
    ) : openThread && view !== 'followups' ? (
      <ThreadPane
        key={openThread}
        threadKey={openThread}
        selectedId={search.id ?? null}
        onSelectMessage={(id) => setSearch({ thread: openThread, id: id ?? undefined })}
        onBack={() => {
          setSearch({ id: undefined });
          focusList();
        }}
        rows={all}
        focusToken={focusToken}
        onFocusTaken={() => setFocusToken(0)}
      />
    ) : search.id ? (
      <CommunicationDetail id={search.id} onEdit={actions.edit} onDelete={actions.del} onToggleFollowUp={actions.toggle} onOpenDocument={actions.openDoc} busy={done.isPending || reopen.isPending} />
    ) : (
      <div className="cm-idle">
        {view === 'threads' ? (
          threadRows.length ? <EmptyState title="Pick a conversation">Read every message of it, oldest first and word for word, with whose words each one is. Move with j and k; Enter goes to its messages.</EmptyState> : null
        ) : (view === 'followups' ? followRows : listRows).length ? (
          <EmptyState title={view === 'followups' ? 'Pick a follow-up' : 'Pick a call or message'}>
            {view === 'followups' ? 'See what was promised, by whom and by when, and mark it done. Move with j and k; Enter opens the document.' : 'Read what was said, who took part and anything promised. Move with j and k; Enter opens its document (a conversation opens its messages).'}
          </EmptyState>
        ) : view === 'followups' ? (
          <EmptyState
            title="No follow-ups open"
            action={
              <Button variant="primary" onClick={actions.newComm} shortcut="n">
                Log a call or message
              </Button>
            }
          >
            When a call or message promises something, it is listed here until it is done. &quot;All, with done&quot; shows the finished ones.
          </EmptyState>
        ) : null}
        {view === 'list' ? <MessageDocuments docs={unlogged} onLog={logFrom} /> : null}
      </div>
    );

  return (
    <div className="page contacts">
      <PageHeader title="Calls and messages" meta={meta} intro={INTRO} actions={{ primary: { label: 'Log a call or message', onClick: actions.newComm, shortcut: 'n', title: 'A call, portal message, email or letter: who took part, what was said, anything promised' } }} />
      <Toolbar label="Views and filters">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: VIEW_WORDS.list, count: all.length || undefined, title: 'Every call and message, newest first; a conversation read out of a record is one row' },
            { value: 'threads', label: VIEW_WORDS.threads, title: 'Conversations: messages and their replies, one row each' },
            { value: 'matrix', label: VIEW_WORDS.matrix, title: 'Who you have been in touch with, about what' },
            { value: 'followups', label: VIEW_WORDS.followups, count: openCount || undefined, title: 'What someone promised to do next' },
          ]}
        />
        {(view === 'list' || view === 'threads') && !nothingYet && fromRecordsCount ? (
          <Segmented
            label="Logged by"
            value={search.by ?? ''}
            onChange={(v) => setSearch({ by: (v || undefined) as By | undefined, id: undefined })}
            options={[
              { value: '', label: 'Anyone', title: 'Every call and message' },
              { value: 'you', label: 'You', title: 'The ones you logged yourself' },
              { value: 'records', label: 'From records', count: fromRecordsCount, title: 'Messages, telephone notes, letters and questionnaires Claude read word for word out of your records' },
            ]}
          />
        ) : null}
        {view === 'threads' && !nothingYet ? <SearchField label="Find" placeholder="Subject or words of a message" value={qLocal} onChange={setQLocal} width={230} /> : null}
        {view === 'list' && !nothingYet ? (
          <>
            <SearchField label="Find" placeholder="Subject, summary, topic or name" value={qLocal} onChange={setQLocal} width={230} />
            <FilterGroup label="How">
              <Select value={search.channel ?? ''} options={COMM_CHANNELS.map((c) => ({ value: c, label: CHANNEL_WORDS[c] ?? c }))} placeholder="Any way" onChange={(e) => setSearch({ channel: (e.target.value || undefined) as CommSearch['channel'] })} aria-label="How it happened" />
            </FilterGroup>
            <Button size="sm" variant="ghost" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
              {moreFilters ? 'Fewer filters' : `More filters${moreOn ? ` (${moreOn} on)` : ''}`}
            </Button>
            {moreFilters ? (
              <>
                <FilterGroup label="Direction">
                  <Select value={search.direction ?? ''} options={COMM_DIRECTIONS.map((d) => ({ value: d, label: DIRECTION_WORDS[d] ?? d }))} placeholder="Either way" onChange={(e) => setSearch({ direction: (e.target.value || undefined) as CommSearch['direction'] })} aria-label="Direction" />
                </FilterGroup>
                <FilterGroup label="Topic">
                  <Select
                    options={[{ value: NO_TOPIC, label: topicWords(NO_TOPIC) }, ...(topics.data?.items ?? []).map((t) => ({ value: t.topic, label: `${t.topic} (${t.count})` }))]}
                    placeholder="Any topic"
                    value={search.topic ?? ''}
                    onChange={(e) => setSearch({ topic: e.target.value || undefined })}
                    aria-label="Topic"
                  />
                </FilterGroup>
              </>
            ) : null}
          </>
        ) : null}
        {view === 'followups' ? (
          <Segmented
            label="Show"
            value={search.done ? 'all' : 'open'}
            onChange={(v) => setSearch({ done: v === 'all' ? true : undefined, id: undefined })}
            options={[
              { value: 'open', label: 'Still open', title: 'Promised and not done yet' },
              { value: 'all', label: 'All, with done', title: 'Every promise, including the ones done' },
            ]}
          />
        ) : null}
        {search.personId && view !== 'matrix' ? (
          <FilterGroup label="With">
            <span className="cm-with">{personName}</span>
            <Button size="sm" variant="ghost" onClick={() => setSearch({ personId: undefined })} title="Show the calls and messages with everyone">
              Everyone
            </Button>
          </FilterGroup>
        ) : null}
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['enter', view === 'matrix' ? 'list them' : view === 'threads' ? 'its messages' : 'open'],
            openThread ? ['[/]', 'messages'] : null,
            openThread ? ['esc', 'back to the list'] : null,
            ['n', 'log one'],
            view === 'matrix' || view === 'threads' ? null : ['e', 'edit'],
            view === 'matrix' || view === 'threads' ? null : ['f', 'follow-up done'],
            ['v l/v t/v m/v f', 'views'],
            view === 'list' || view === 'threads' ? ['/', 'find'] : null,
          ]}
        >
          {anyFilter && (view === 'list' || view === 'threads') ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </ToolbarKeys>
      </Toolbar>
      {VIEW_INTRO[view] ? <p className="cm-view-intro">{VIEW_INTRO[view]}</p> : null}
      <div className="page-body flush">
        {nothingYet ? (
          <div className="cm-empty">
            <EmptyState
              title="No calls or messages logged yet"
              action={
                <Button variant="primary" onClick={actions.newComm} shortcut="n">
                  Log a call or message
                </Button>
              }
            >
              Keep each call, portal message, email and letter here: who took part, what was said, and anything someone promised to do next, so nothing promised is forgotten.
            </EmptyState>
            <div className="cm-empty-docs">
              <MessageDocuments docs={unlogged} onLog={logFrom} limit={20} />
            </div>
          </div>
        ) : (
          <SplitView storageKey={view === 'matrix' ? 'communications-matrix' : 'communications'} defaultLeft={view === 'matrix' ? 62 : 60} minLeft={440} minRight={420} left={leftPane} right={rightPane} />
        )}
      </div>

      <CommunicationDialog
        open={dialog === 'new'}
        onClose={() => {
          setDialog('none');
          setPreset(null);
        }}
        preset={preset}
        presetParticipants={search.personId && search.personId !== '' ? [{ personId: search.personId, role: 'to' }] : []}
        onSaved={(c) => setSearch({ id: c.id, view: undefined })}
      />
      <CommunicationDialog open={dialog === 'edit'} onClose={() => setDialog('none')} initial={selected} />
      <Confirm
        open={dialog === 'delete'}
        onClose={() => setDialog('none')}
        onConfirm={() => void doDelete()}
        title="Delete this call or message?"
        body={<p className="muted small">{selected?.subject}. It is hidden everywhere, not erased, and drops out of By person, the follow-ups and the reply times.</p>}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
