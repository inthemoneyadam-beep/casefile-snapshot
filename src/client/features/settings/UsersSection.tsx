/**
 * Settings, "People with access": who can open the case and with what role, and (owner only) the audit log. Mounted
 * by src/client/routes/settings.tsx. Only the owner changes anything here; editors and viewers see the list and
 * their own row. Local network access moved to Advanced (NetworkSection.tsx).
 *
 * Keys (owner, while no dialog is open): a add, e edit the selected row (name, role, passphrase reset), x disable or
 * enable, D remove (asks first).
 *
 * The audit log is a DataTable (sortable columns, j/k selection, Enter shows only the selected row's person, Esc
 * clears the selection) over the server's filtered pages: Find ("/" focuses it), Who and What are applied on the
 * server, and "Load older" follows the nextBefore cursor so every row stays reachable. Ids stay in hover text.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AUDIT_ACTIONS, ROLE_HINT, errorText, useAuditLog, useMe, useUserMutations, useUsers, type AuditRow, type Role, type UserRow } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { useBindings } from '../../app/shortcuts';
import { dialogOpen } from '../../app/dom';
import { ActionBar } from '../../ui/ActionBar';
import { Button } from '../../ui/Button';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateTimeText } from '../../ui/DateText';
import { Confirm } from '../../ui/Dialog';
import { KeyFacts } from '../../ui/DetailPane';
import { Select } from '../../ui/Field';
import { Loading, Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { FilterGroup, SearchField } from '../../ui/Toolbar';
import { useToast } from '../../ui/Toast';
import { UserDialog, type UserDialogValues } from '../users/UserDialog';
import { ROLE_WORDS, auditActionWords, auditEntityWords } from './words';
import '../users/users.css';

function statusOf(u: UserRow): { text: string; tone: 'ok' | 'ash' | 'warn'; title: string } {
  if (u.disabled) return { text: 'disabled', tone: 'ash', title: 'Cannot open the case until enabled again' };
  if (!u.hasPassphrase) return { text: 'no passphrase', tone: 'warn', title: 'Has no passphrase yet, so cannot open the case; Edit sets one' };
  return { text: 'active', tone: 'ok', title: 'Can open the case with their passphrase' };
}

const AUDIT_PAGE = 100;
/** The Who filter's value for rows written without a person (idle lock, system). */
const NO_PERSON = '-';

const auditColumns: ColumnDef<AuditRow, unknown>[] = [
  { id: 'at', header: 'When', accessorFn: (a) => a.at, cell: ({ row }) => <DateTimeText iso={row.original.at} />, meta: { width: 140, shrink: false } },
  { id: 'who', header: 'Who', accessorFn: (a) => a.userName ?? '', cell: ({ row }) => row.original.userName ?? <span className="muted">CaseFile</span>, meta: { width: 90, maxWidth: 160 } },
  { id: 'action', header: 'What', accessorFn: (a) => auditActionWords(a.action), meta: { width: 120, maxWidth: 200 } },
  {
    id: 'entity',
    header: 'About',
    accessorFn: (a) => auditEntityWords(a.entityType),
    cell: ({ row }) => <span className="muted">{auditEntityWords(row.original.entityType)}</span>,
    meta: { width: 100, maxWidth: 170 },
  },
  { id: 'summary', header: 'Summary', accessorFn: (a) => a.summary ?? '', meta: { grow: true, minWidth: 240 } },
];

export function UsersSection() {
  const me = useMe();
  const toast = useToast();
  const users = useUsers(Boolean(me.user));
  const m = useUserMutations();

  // --- Audit log state --------------------------------------------------------
  const [auditInput, setAuditInput] = useState('');
  const [auditQ, setAuditQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAuditQ(auditInput.trim()), 250);
    return () => clearTimeout(t);
  }, [auditInput]);
  const [auditWho, setAuditWho] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const audit = useAuditLog({ userId: auditWho || undefined, action: auditAction || undefined, q: auditQ || undefined }, me.isOwner, AUDIT_PAGE);
  const auditRows = useMemo(() => audit.data?.pages.flatMap((p) => p.items) ?? [], [audit.data]);
  const auditTotal = audit.data?.pages[0]?.total ?? 0;
  const auditFiltered = Boolean(auditWho || auditAction || auditQ);
  const [auditSelectedId, setAuditSelectedId] = useState<string | null>(null);
  const auditSelected = auditRows.find((r) => r.id === auditSelectedId) ?? null;
  const { hasNextPage: auditHasOlder, isFetchingNextPage: auditLoadingOlder, fetchNextPage: fetchOlderAudit } = audit;
  const loadOlder = useCallback(() => {
    if (auditHasOlder && !auditLoadingOlder) void fetchOlderAudit();
  }, [auditHasOlder, auditLoadingOlder, fetchOlderAudit]);
  const clearAudit = () => {
    setAuditInput('');
    setAuditQ('');
    setAuditWho('');
    setAuditAction('');
  };

  const rows = useMemo(() => users.data?.items ?? [], [users.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const [dialog, setDialog] = useState<'add' | 'edit' | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const busy = m.create.isPending || m.update.isPending || m.resetPassphrase.isPending || m.remove.isPending;
  const canManage = me.isOwner;

  const fail = useCallback((err: unknown) => toast(errorText(err), 'bad'), [toast]);

  // --- Actions --------------------------------------------------------------
  const openAdd = useCallback(() => {
    if (!canManage || dialogOpen()) return;
    setDialogError(null);
    setDialog('add');
  }, [canManage]);
  const openEdit = useCallback(() => {
    if (!canManage || !selected || dialogOpen()) return;
    setDialogError(null);
    setDialog('edit');
  }, [canManage, selected]);
  const toggleDisabled = useCallback(() => {
    if (!canManage || !selected || dialogOpen()) return;
    if (selected.isMe) return toast('You cannot disable yourself.', 'bad');
    const next = !selected.disabled;
    m.update.mutate({ id: selected.id, patch: { disabled: next } }, { onSuccess: (r) => toast(next ? `${r.name} disabled; their sessions are closed.` : `${r.name} enabled.`, 'ok'), onError: fail });
  }, [canManage, selected, m.update, toast, fail]);
  const openRemove = useCallback(() => {
    if (!canManage || !selected || dialogOpen()) return;
    if (selected.isMe) return toast('You cannot remove yourself.', 'bad');
    setRemoveOpen(true);
  }, [canManage, selected, toast]);
  const confirmRemove = useCallback(() => {
    if (!selected) return;
    m.remove.mutate(selected.id, {
      onSuccess: () => {
        toast(`${selected.name} removed. Only their passphrase is gone; nothing in the case changed.`, 'ok');
        setSelectedId(null);
      },
      onError: fail,
    });
  }, [selected, m.remove, toast, fail]);

  function submitDialog(v: UserDialogValues) {
    setDialogError(null);
    if (dialog === 'add') {
      m.create.mutate(
        { name: v.name, role: v.role, passphrase: v.passphrase },
        {
          onSuccess: (r) => {
            toast(`${r.name} added as ${(ROLE_WORDS[r.role] ?? r.role).toLowerCase()}.`, 'ok');
            setSelectedId(r.id);
            setDialog(null);
          },
          onError: (err) => setDialogError(errorText(err)),
        },
      );
      return;
    }
    if (!selected) return;
    const patch: { name?: string; role?: Role } = {};
    if (v.name !== selected.name) patch.name = v.name;
    if (v.role !== selected.role) patch.role = v.role;
    const finish = () => {
      toast(`${v.name} updated.`, 'ok');
      setDialog(null);
    };
    const afterPatch = () => {
      if (v.passphrase) m.resetPassphrase.mutate({ id: selected.id, passphrase: v.passphrase }, { onSuccess: finish, onError: (err) => setDialogError(errorText(err)) });
      else finish();
    };
    if (Object.keys(patch).length) m.update.mutate({ id: selected.id, patch }, { onSuccess: afterPatch, onError: (err) => setDialogError(errorText(err)) });
    else afterPatch();
  }

  // --- Keys and commands ----------------------------------------------------
  useBindings(
    [
      { keys: 'a', description: 'Add a person with access', group: 'Page', when: () => canManage && !dialogOpen(), run: openAdd },
      { keys: 'e', description: 'Edit the selected person (name, role, passphrase)', group: 'Page', when: () => canManage && Boolean(selected) && !dialogOpen(), run: openEdit },
      { keys: 'x', description: 'Disable or enable the selected person', group: 'Page', when: () => canManage && Boolean(selected) && !dialogOpen(), run: toggleDisabled },
      { keys: 'D', description: 'Remove the selected person (their passphrase only; asks first)', group: 'Page', when: () => canManage && Boolean(selected) && !dialogOpen(), run: openRemove },
    ],
    [canManage, selected, openAdd, openEdit, toggleDisabled, openRemove],
  );
  useRegisterCommands(
    [
      { id: 'users.add', title: 'Add a person with access', group: 'Page', shortcut: 'a', keywords: 'user access chief of staff editor viewer', run: openAdd, when: () => canManage },
      { id: 'users.edit', title: 'Edit the selected person with access', group: 'Page', shortcut: 'e', run: openEdit, when: () => canManage && Boolean(selected) },
      { id: 'users.toggle', title: selected?.disabled ? 'Enable the selected person' : 'Disable the selected person', group: 'Page', shortcut: 'x', run: toggleDisabled, when: () => canManage && Boolean(selected) },
      { id: 'users.remove', title: 'Remove the selected person', group: 'Page', shortcut: 'D', run: openRemove, when: () => canManage && Boolean(selected) },
      { id: 'users.audit.filter', title: 'Find in the audit log', group: 'Page', keywords: 'audit log who action search filter', run: () => document.querySelector<HTMLInputElement>('#audit-filter')?.focus(), when: () => canManage },
      { id: 'users.audit.older', title: 'Load older audit log rows', group: 'Page', keywords: 'audit log more older page', run: loadOlder, when: () => canManage && auditHasOlder },
    ],
    [canManage, selected, openAdd, openEdit, toggleDisabled, openRemove, loadOlder, auditHasOlder],
  );

  // --- Table ----------------------------------------------------------------
  const columns = useMemo<ColumnDef<UserRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <span>
            {row.original.name}
            {row.original.isMe ? <span className="muted"> (you)</span> : null}
          </span>
        ),
        meta: { grow: true, minWidth: 160 },
      },
      { id: 'role', header: 'Role', accessorFn: (r) => ROLE_WORDS[r.role] ?? r.role, cell: ({ row }) => <span title={ROLE_HINT[row.original.role]}>{ROLE_WORDS[row.original.role] ?? row.original.role}</span>, meta: { width: 80 } },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => statusOf(r).text,
        cell: ({ row }) => {
          const st = statusOf(row.original);
          return (
            <Tag tone={st.tone} title={st.title}>
              {st.text}
            </Tag>
          );
        },
        meta: { width: 110 },
      },
      { id: 'lastLogin', header: 'Last signed in', accessorFn: (r) => r.lastLoginAt ?? '', cell: ({ row }) => (row.original.lastLoginAt ? <DateTimeText iso={row.original.lastLoginAt} /> : <span className="muted">never</span>), meta: { width: 140 } },
      { id: 'added', header: 'Added', accessorFn: (r) => r.createdAt, cell: ({ row }) => <DateTimeText iso={row.original.createdAt} />, meta: { width: 140 } },
    ],
    [],
  );

  return (
    <div className="users-section">
      <Section
        title="People with access"
        id="settings-access"
        count={rows.length || undefined}
        intro="Everyone opens the same encrypted case with a passphrase of their own. Removing someone deletes only their passphrase; nothing in the case changes."
        actions={
          canManage ? (
            <ActionBar
              size="sm"
              primaryStyle="outline"
              primary={{ label: 'Add a person', onClick: openAdd, shortcut: 'a', disabled: busy }}
              secondary={[
                { label: 'Edit', onClick: openEdit, shortcut: 'e', disabled: busy || !selected, title: selected ? `Name, role or a new passphrase for ${selected.name}` : 'Pick a person first' },
                { label: selected?.disabled ? 'Enable' : 'Disable', onClick: toggleDisabled, shortcut: 'x', disabled: busy || !selected || Boolean(selected?.isMe), title: selected?.isMe ? 'You cannot disable yourself' : 'A disabled person cannot open the case until enabled again' },
              ]}
              more={[{ label: 'Remove…', onClick: openRemove, shortcut: 'D', danger: true, disabled: busy || !selected || Boolean(selected?.isMe), title: 'Delete their passphrase (asks first); nothing in the case changes' }]}
            />
          ) : null
        }
      >
        <KeyFacts
          className="users-roles"
          items={[
            { label: 'Owner', value: ROLE_HINT.owner, wide: true },
            { label: 'Editor', value: ROLE_HINT.editor, wide: true },
            { label: 'Viewer', value: ROLE_HINT.viewer, wide: true },
          ]}
        />
        {users.isPending ? (
          <Loading />
        ) : users.isError ? (
          <div className="notice bad">{errorText(users.error, 'Could not load the people with access.')}</div>
        ) : (
          <div className="users-table">
            <DataTable
              columns={columns}
              data={rows}
              rowId={(r) => r.id}
              selectedId={selectedId}
              onSelect={(r) => setSelectedId(r?.id ?? null)}
              onOpen={() => openEdit()}
              emptyText="No one yet."
              initialSort={[{ id: 'added', desc: false }]}
              tableId="settings.users"
            />
          </div>
        )}
        {canManage ? null : <p className="muted">Only the owner changes who has access. Change your own passphrase under Lock above.</p>}
      </Section>

      {canManage ? (
        <Section
          title="Audit log"
          id="settings-audit"
          count={auditTotal || undefined}
          intro="Sign-ins, locks, settings changes, packets, anything erased for good, changes to who has access, and every change made by an editor or a viewer."
        >
          <div className="audit-filters">
            <SearchField
              id="audit-filter"
              label="Find"
              placeholder="Name, action or words"
              value={auditInput}
              onChange={setAuditInput}
              width={280}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && auditInput) {
                  e.preventDefault();
                  e.stopPropagation();
                  setAuditInput('');
                }
              }}
            />
            <FilterGroup label="Who">
              <Select aria-label="Who" placeholder="Everyone" options={[...rows.map((u) => ({ value: u.id, label: u.name })), { value: NO_PERSON, label: 'CaseFile itself (no person)' }]} value={auditWho} onChange={(e) => setAuditWho(e.target.value)} />
            </FilterGroup>
            <FilterGroup label="What">
              <Select aria-label="What" placeholder="Everything" options={AUDIT_ACTIONS.map((a) => ({ value: a, label: auditActionWords(a) }))} value={auditAction} onChange={(e) => setAuditAction(e.target.value)} />
            </FilterGroup>
            {auditFiltered ? (
              <Button size="sm" variant="ghost" onClick={clearAudit}>
                Clear filters
              </Button>
            ) : null}
          </div>
          {audit.isPending ? (
            <Loading />
          ) : audit.isError ? (
            <div className="notice bad">{errorText(audit.error, 'Could not load the audit log.')}</div>
          ) : (
            <div className="audit-log">
              <DataTable
                columns={auditColumns}
                data={auditRows}
                rowId={(a) => a.id}
                selectedId={auditSelectedId}
                onSelect={(a) => setAuditSelectedId(a?.id ?? null)}
                onOpen={(a) => setAuditWho(a.userId ?? NO_PERSON)}
                initialSort={[{ id: 'at', desc: true }]}
                emptyText={auditFiltered ? 'Nothing matches these filters.' : 'Nothing recorded yet.'}
                tableId="settings.audit"
                footer={
                  <span className="row">
                    <span>
                      of {auditTotal} {auditFiltered ? 'matching' : 'recorded'}
                    </span>
                    {auditHasOlder ? (
                      <Button size="sm" variant="ghost" onClick={loadOlder} disabled={auditLoadingOlder}>
                        {auditLoadingOlder ? 'Loading…' : 'Load older'}
                      </Button>
                    ) : null}
                  </span>
                }
              />
              {auditSelected ? (
                <div className="audit-detail" title={auditSelected.entityId ? `Record ${auditSelected.entityId}` : undefined}>
                  <KeyFacts
                    items={[
                      { label: 'When', value: <DateTimeText iso={auditSelected.at} /> },
                      { label: 'Who', value: auditSelected.userName ?? 'CaseFile itself' },
                      { label: 'What', value: auditActionWords(auditSelected.action) },
                      auditSelected.entityType ? { label: 'About', value: auditEntityWords(auditSelected.entityType) } : null,
                      auditSelected.summary ? { label: 'Summary', value: auditSelected.summary, wide: true } : null,
                    ]}
                  />
                </div>
              ) : null}
            </div>
          )}
        </Section>
      ) : null}

      <UserDialog open={dialog !== null} mode={dialog ?? 'add'} user={dialog === 'edit' ? selected : null} busy={busy} error={dialogError} onClose={() => setDialog(null)} onSubmit={submitDialog} />
      <Confirm
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={confirmRemove}
        title={`Remove ${selected?.name ?? 'this person'}?`}
        body={
          <>
            <p className="muted">Their passphrase is deleted, together with the earlier copies CaseFile keeps of the passphrase list, so it no longer opens this case. Nothing in the case changes; what they recorded stays in the audit log under their name.</p>
            <p className="muted">Full backups made before now still hold their passphrase: anyone with one of those backup files and that passphrase can open the backup.</p>
          </>
        }
        confirmLabel="Remove access"
        danger
      />
    </div>
  );
}
