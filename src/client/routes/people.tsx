/**
 * /people — People and places: clinicians, clinics, hospitals and the other
 * people in the case, with how to reach them, every call and message with
 * them, and the documents that name them.
 *
 * Header: Add a person or place (the one primary), Find names in your
 * documents. Toolbar: Find (name, role, specialty or place) and Type (only
 * the types that have someone, shown once there are two), labelled. Split
 * view: the list left, the chosen one right; with nobody yet the page is one
 * empty state with both actions. Selection and filters live in the URL.
 */
import { useMemo, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useMergeSuggestions, usePeople, usePeopleMutations, usePersonSuggestions, type PersonRow } from '../api/people';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { Button } from '../ui/Button';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { SplitView } from '../ui/SplitView';
import { Confirm } from '../ui/Dialog';
import { DateText } from '../ui/DateText';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { ApiError } from '../api/client';
import { PERSON_KINDS } from '@shared/enums';
import { PersonDetail } from '../features/people/PersonDetail';
import { PersonDialog } from '../features/people/PersonDialog';
import { SuggestionsDialog } from '../features/people/SuggestionsDialog';
import { MergeSuggestionsDialog } from '../features/people/Merge';
import { CommunicationDialog } from '../features/communications/CommunicationDialog';
import { PERSON_KIND_WORDS, dialogOpen, personKindWords, personLine, plural } from '../features/people/shared';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/people/contacts.css';

const searchSchema = z.object({
  id: z.string().optional().catch(undefined),
  kind: z.enum(PERSON_KINDS).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});
type PeopleSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/people')({
  validateSearch: (s: Record<string, unknown>): PeopleSearch => searchSchema.parse(s),
  component: PeoplePage,
});

const INTRO = 'Your clinicians, clinics, hospitals and other contacts: how to reach them, every call and message with them, and the documents that name them.';

function PeoplePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const toast = useToast();
  // The type is filtered here, not by the server, so the Type counts stay those of the whole (searched) list.
  const list = usePeople({ q: search.q });
  const everyone = usePeople({});
  const { remove } = usePeopleMutations();
  const [dialog, setDialog] = useState<'none' | 'new' | 'edit' | 'suggest' | 'delete' | 'comm' | 'merge'>('none');

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  const searched = useMemo(() => list.data?.items ?? [], [list.data]);
  const rows = useMemo(() => (search.kind ? searched.filter((p) => p.kind === search.kind) : searched), [searched, search.kind]);
  const selected = useMemo(() => (everyone.data?.items ?? []).find((p) => p.id === search.id) ?? null, [everyone.data, search.id]);
  const total = everyone.data?.items.length ?? 0;
  const nothingYet = everyone.isSuccess && total === 0;
  const suggestions = usePersonSuggestions(nothingYet);
  const suggestionCount = suggestions.data?.items.length;
  // People who may be listed twice (never merged on their own): offered in one line under the toolbar.
  const mergeSuggestions = useMergeSuggestions(null, everyone.isSuccess && !nothingYet);
  const twiceCount = mergeSuggestions.data?.length ?? 0;

  function setSearch(patch: Partial<PeopleSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  }
  const select = (p: PersonRow | null) => setSearch({ id: p?.id });
  const openComms = (p: PersonRow) => void navigate({ to: '/communications', search: { view: undefined, personId: p.id } });

  async function doDelete() {
    if (!selected) return;
    try {
      await remove.mutateAsync(selected.id);
      toast(`Deleted ${selected.name}.`, 'ok');
      setSearch({ id: undefined });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', 'bad');
    }
  }

  const guard = (fn: () => void) => () => {
    if (!dialogOpen()) fn();
  };
  const actions = {
    newPerson: guard(() => setDialog('new')),
    edit: guard(() => selected && setDialog('edit')),
    del: guard(() => selected && setDialog('delete')),
    suggest: guard(() => setDialog('suggest')),
    merge: guard(() => setDialog('merge')),
    logContact: guard(() => selected && setDialog('comm')),
    comms: guard(() => selected && openComms(selected)),
  };

  useBindings(
    [
      { keys: 'n', description: 'Add a person or place', group: 'Page', run: actions.newPerson },
      { keys: 'e', description: 'Edit selected person', group: 'Page', run: actions.edit },
      { keys: 'Delete', description: 'Delete selected person', group: 'Page', run: actions.del },
      { keys: 's', description: 'Find names in your documents', group: 'Page', run: actions.suggest },
      { keys: 'm', description: 'People who may be listed twice (merge or keep apart)', group: 'Page', run: actions.merge },
      { keys: 'c', description: 'Log a call or message with the selected person', group: 'Page', run: actions.logContact },
    ],
    [selected?.id],
  );
  useRegisterCommands(
    [
      { id: 'people.new', title: 'Add a person or place', group: 'Page', shortcut: 'n', keywords: 'new person add clinician institution contact', run: actions.newPerson },
      { id: 'people.suggest', title: 'Find names in your documents', group: 'Page', shortcut: 's', keywords: 'extract names suggested people suggestions', run: actions.suggest },
      { id: 'people.merge', title: 'People who may be listed twice', group: 'Page', shortcut: 'm', keywords: 'merge duplicate same person alias twice combine', run: actions.merge },
      { id: 'people.edit', title: 'Edit the selected person', group: 'Page', shortcut: 'e', run: actions.edit, when: () => Boolean(selected) },
      { id: 'people.delete', title: 'Delete the selected person', group: 'Page', shortcut: 'Delete', run: actions.del, when: () => Boolean(selected) },
      { id: 'people.comm', title: 'Log a call or message with this person', group: 'Page', shortcut: 'c', keywords: 'communication contact', run: actions.logContact, when: () => Boolean(selected) },
      { id: 'people.comms', title: 'Calls and messages with this person', group: 'Page', shortcut: 'enter', keywords: 'communications', run: () => selected && openComms(selected), when: () => Boolean(selected) },
    ],
    [selected?.id],
  );

  // Fits the list pane at 1280 (about 600px): Name (takes the room; the role and place on a second line), Type,
  // Calls and messages, Last contact. Phone, email and the reply time are in the detail.
  const columns = useMemo<ColumnDef<PersonRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorKey: 'name',
        cell: (c) => {
          const line = personLine(c.row.original);
          return (
            <span className="pp-name">
              <span>{c.row.original.name}</span>
              {line ? <span className="pp-line">{line}</span> : null}
            </span>
          );
        },
        meta: { grow: true, minWidth: 220, wrap: false },
      },
      { id: 'kind', header: 'Type', accessorFn: (r) => personKindWords(r.kind), cell: (c) => <span className="muted">{c.getValue<string>()}</span>, meta: { width: 100, maxWidth: 120, wrap: true, shrink: false } },
      { id: 'contacts', header: 'Calls and messages', accessorKey: 'communicationCount', cell: (c) => <span className={c.row.original.communicationCount ? 'mono' : 'mono faint'}>{c.row.original.communicationCount}</span>, meta: { className: 'num', width: 132 } },
      {
        id: 'last',
        header: 'Last contact',
        accessorFn: (r) => r.lastContactAt ?? '',
        cell: (c) => (c.row.original.lastContactAt ? <DateText iso={c.row.original.lastContactAt} /> : <span className="faint" title="No call or message logged">—</span>),
        meta: { width: 104, shrink: false },
        sortUndefined: 'last',
      },
    ],
    [],
  );

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of searched) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [searched]);
  // Only the types someone has; the control only once there is a choice to make (or one is chosen).
  const kindOptions = PERSON_KINDS.filter((k) => kindCounts.get(k) || search.kind === k);
  const showKinds = kindOptions.length >= 2 || Boolean(search.kind);
  const anyFilter = Boolean(search.q || search.kind);

  const left = list.isPending ? (
    <Loading>Loading people and places…</Loading>
  ) : list.isError ? (
    <Loading>Could not load people and places: {list.error instanceof ApiError ? list.error.message : 'error'}</Loading>
  ) : (
    <DataTable
      columns={columns}
      data={rows}
      rowId={(r) => r.id}
      selectedId={search.id ?? null}
      onSelect={select}
      onOpen={openComms}
      initialSort={[{ id: 'name', desc: false }]}
      tableId="people.list"
      autoFocus
      emptyText={anyFilter ? 'No one matches. Clear filters (in the toolbar) shows everyone.' : 'No people or places yet.'}
    />
  );

  const right = search.id ? (
    <PersonDetail id={search.id} onEdit={actions.edit} onDelete={actions.del} onNewCommunication={actions.logContact} onOpenComms={actions.comms} onFindNames={actions.suggest} />
  ) : rows.length ? (
    <EmptyState title="Pick a person or place">See how to reach them, every call and message with them, and the documents that name them. Move with j and k; Enter lists their calls and messages.</EmptyState>
  ) : null;

  return (
    <div className="page contacts">
      <PageHeader
        title="People and places"
        meta={everyone.isPending || nothingYet ? null : <span className="mono">{plural(total, 'person or place', 'people and places')}</span>}
        intro={INTRO}
        actions={{
          primary: { label: 'Add a person or place', onClick: actions.newPerson, shortcut: 'n', title: 'A clinician, clinic, hospital or anyone else in the case' },
          secondary: [{ label: 'Find names in your documents', onClick: actions.suggest, shortcut: 's', title: 'Names of clinicians and hospitals Claude read in your documents that are not on this list yet' }],
        }}
      />
      {nothingYet ? null : (
        <Toolbar label="Find and filters">
          <SearchField label="Find" placeholder="Name, role, specialty or place" value={qLocal} onChange={setQLocal} width={230} />
          {showKinds ? (
            <Segmented
              label="Type"
              value={search.kind ?? ''}
              onChange={(v) => setSearch({ kind: (v || undefined) as PeopleSearch['kind'], id: undefined })}
              options={[{ value: '', label: 'All', count: searched.length }, ...kindOptions.map((k) => ({ value: k, label: PERSON_KIND_WORDS[k] ?? k, count: kindCounts.get(k) ?? 0 }))]}
            />
          ) : null}
          <ToolbarKeys
            items={[
              ['j/k', 'move'],
              ['enter', 'calls and messages'],
              ['n', 'add'],
              ['e', 'edit'],
              ['c', 'log a call'],
              ['s', 'find names'],
              ['m', 'listed twice'],
              ['/', 'find'],
            ]}
          >
            {anyFilter ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQLocal('');
                  setSearch({ q: undefined, kind: undefined });
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </ToolbarKeys>
        </Toolbar>
      )}
      {twiceCount && !nothingYet ? (
        <div className="pp-twice-line" role="status">
          <span>
            <strong>
              {twiceCount} {twiceCount === 1 ? 'person' : 'people'} may be listed twice.
            </strong>{' '}
            Claude read the same person written in different ways in your records. Nothing is merged unless you say so.
          </span>
          <Button size="sm" variant="accent" onClick={actions.merge} shortcut="m">
            Look at them
          </Button>
        </div>
      ) : null}
      <div className="page-body flush">
        {nothingYet ? (
          <EmptyState
            title="No people or places yet"
            action={
              <div className="row">
                <Button variant="primary" onClick={actions.newPerson} shortcut="n">
                  Add a person or place
                </Button>
                <Button onClick={actions.suggest} shortcut="s">
                  Find names in your documents{suggestionCount ? ` (${suggestionCount})` : ''}
                </Button>
              </div>
            }
          >
            Add your clinicians, clinics and hospitals once, with how to reach them. Calls, messages, appointments and to-dos then link to them, and each one shows everything you have with them.
            {suggestions.isSuccess && suggestionCount === 0 ? ' Claude has not found any new names in your documents yet.' : ''}
          </EmptyState>
        ) : (
          <SplitView storageKey="people" defaultLeft={57} minLeft={420} minRight={420} left={left} right={right} />
        )}
      </div>

      <PersonDialog open={dialog === 'new'} onClose={() => setDialog('none')} onSaved={(p) => setSearch({ id: p.id })} />
      <PersonDialog open={dialog === 'edit'} onClose={() => setDialog('none')} initial={selected} />
      <SuggestionsDialog open={dialog === 'suggest'} onClose={() => setDialog('none')} onCreated={(p) => setSearch({ id: p.id })} />
      <MergeSuggestionsDialog open={dialog === 'merge'} onClose={() => setDialog('none')} onMerged={(id) => setSearch({ id })} />
      <CommunicationDialog open={dialog === 'comm'} onClose={() => setDialog('none')} presetParticipants={selected ? [{ personId: selected.id, role: 'to' }] : []} onSaved={(c) => void navigate({ to: '/communications', search: { id: c.id } })} />
      <Confirm
        open={dialog === 'delete'}
        onClose={() => setDialog('none')}
        onConfirm={() => void doDelete()}
        title={`Delete ${selected?.name ?? 'this person'}?`}
        body={<p className="muted small">They are hidden everywhere, not erased. Calls and messages they took part in are kept; their name drops off the lists of who took part.</p>}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
