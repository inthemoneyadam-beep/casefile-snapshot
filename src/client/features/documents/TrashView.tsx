/**
 * Deleted documents (Documents, ?view=trash): the documents you deleted, with the details pulled from them, and
 * Restore. Moved unchanged from routes/documents.tsx (sweep 2026-10-07); the route still renders it for the trash view.
 */
import { useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { EmptyState, Meta, PageHeader } from '../../ui/PageHeader';
import { SplitView } from '../../ui/SplitView';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/StatusTag';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Toolbar, ToolbarKeys } from '../../ui/Toolbar';
import { useToast } from '../../ui/Toast';
import { useRegisterCommands } from '../../app/commands';
import { useBindings } from '../../app/shortcuts';
import { dateSortKey } from '@shared/dates';
import { setAsideTrashWords, useDeletedDocuments, useRestoreDocument, type DeletedDocument } from '../../api/documents';
import { useMe } from '../../api/users';
import { documentTypeLabel } from '../../api/filing';
import { PurgeDocument } from './PurgeDocument';
import { KIND_WORDS } from './status';
import { HELD_WORDS, NOT_MINE_LABEL } from '../patient-check/words';
import { isHeldDocument } from '../../api/patient-check';

const TRASH_KEYS = { restore: 'u' } as const;

/** Deleted documents (the trash view, ?view=trash): soft-deleted documents with Restore. */
export function TrashView() {
  const search = useSearch({ from: '/documents' });
  const navigate = useNavigate({ from: '/documents' });
  const toast = useToast();
  const trash = useDeletedDocuments();
  const restore = useRestoreDocument();
  // Viewers read the trash; restoring is a write (the server answers 403).
  const canWrite = useMe().canWrite;
  const items = trash.data?.items ?? [];
  const selectedId = search.id ?? null;
  const selected = items.find((d) => d.id === selectedId) ?? null;

  function select(id: string | undefined) {
    void navigate({ search: (prev) => ({ ...prev, id }), replace: true });
  }
  function back() {
    void navigate({ search: {} });
  }
  function focusRestore() {
    document.querySelector<HTMLButtonElement>('button[data-restore]')?.focus();
  }
  function runRestore(doc: DeletedDocument | null = selected) {
    if (!doc || restore.isPending || !canWrite) return;
    if (doc.duplicateOf) {
      toast(`The same file is in the case as "${doc.duplicateOf.title}"; delete that copy first`, 'bad');
      return;
    }
    restore.mutate(doc.id, {
      onSuccess: (r) => {
        // "Not my record" comes back held; so does a document never checked whose pages name someone else.
        if (doc.wrongPatient || isHeldDocument(r.document)) toast(`Back as "${HELD_WORDS}": its details stay hidden until you answer.`, 'ok');
        else toast(`Restored${r.factsRestored ? ` with ${r.factsRestored} detail${r.factsRestored === 1 ? '' : 's'}` : ''}`, 'ok');
        void navigate({ search: { id: r.document.id } });
      },
      onError: (err) => toast(err instanceof Error ? err.message : 'Restore failed', 'bad'),
    });
  }

  useBindings(
    [{ keys: TRASH_KEYS.restore, description: 'Restore the selected deleted document', group: 'Documents', when: () => Boolean(selected) && canWrite, run: () => runRestore() }],
    [selected, restore.isPending, items, canWrite],
  );
  useRegisterCommands(
    [
      { id: 'documents.trash.restore', title: 'Restore deleted document', group: 'Documents', shortcut: TRASH_KEYS.restore, keywords: 'undo delete undelete', when: () => Boolean(selected) && canWrite, run: () => runRestore() },
      { id: 'documents.trash.back', title: 'Back to documents', group: 'Documents', run: back },
    ],
    [selected, restore.isPending, items, canWrite],
  );

  const columns = useMemo<ColumnDef<DeletedDocument, unknown>[]>(
    () => [
      { id: 'deleted', header: 'Deleted', accessorKey: 'deletedAt', cell: ({ getValue }) => <DateTimeText iso={String(getValue())} />, meta: { width: 130 } },
      {
        id: 'title',
        header: 'Title',
        accessorKey: 'title',
        cell: ({ row }) => (
          <span title={row.original.filename}>
            {row.original.title}
            {row.original.wrongPatient ? <span className="muted small"> · {NOT_MINE_LABEL.toLowerCase()}</span> : null}
          </span>
        ),
      },
      {
        id: 'date',
        header: 'Date',
        accessorFn: (d) => dateSortKey(d.documentDate),
        cell: ({ row }) => <DateText iso={row.original.documentDate} precision={row.original.documentDatePrecision} text={row.original.documentDateText} />,
        meta: { width: 104 },
      },
      { id: 'kind', header: 'File', accessorKey: 'kind', cell: ({ getValue }) => <span className="muted small">{KIND_WORDS[String(getValue())] ?? String(getValue())}</span>, meta: { width: 110 } },
      { id: 'facts', header: 'Details', accessorKey: 'factsCount', meta: { className: 'num', width: 64 } },
    ],
    [],
  );

  return (
    <div className="page">
      <PageHeader
        title="Deleted documents"
        meta={trash.isPending ? null : `${items.length} deleted document${items.length === 1 ? '' : 's'}`}
        intro="Documents you deleted, with the details pulled from them. Restore brings one back with your answers unchanged; the original file was never removed."
        actions={{ secondary: [{ label: 'Back to documents', onClick: back, title: 'The list of every document' }] }}
      />
      <Toolbar label="Deleted documents">
        <ToolbarKeys
          items={[
            ['j/k', 'move'],
            ['enter', 'to Restore'],
            [TRASH_KEYS.restore, 'restore'],
          ]}
        />
      </Toolbar>
      <div className="page-body flush">
        <SplitView
          storageKey="documents-trash"
          defaultLeft={52}
          left={
            <DataTable
              columns={columns}
              data={items}
              rowId={(d) => d.id}
              selectedId={selectedId}
              onSelect={(row) => select(row?.id)}
              onOpen={() => focusRestore()}
              initialSort={[{ id: 'deleted', desc: true }]}
              emptyText={trash.isPending ? 'Loading…' : trash.isError ? 'Could not load the deleted documents.' : 'Nothing has been deleted.'}
              autoFocus
            />
          }
          right={
            selected ? (
              <DetailPane label="Deleted document">
                <DetailHeader
                  eyebrow={
                    <>
                      <Tag tone="warn">deleted</Tag>
                      {selected.wrongPatient ? <Tag tone="warn">{NOT_MINE_LABEL.toLowerCase()} (wrong patient)</Tag> : null}
                      <span>{documentTypeLabel(selected.category)}</span>
                    </>
                  }
                  title={selected.title}
                  status={<span className="mono small" title={selected.filename}>{selected.filename}</span>}
                />
                <Meta
                  items={[
                    ['Deleted on', <DateTimeText key="del" iso={selected.deletedAt} />],
                    ['Date', <DateText key="d" iso={selected.documentDate} precision={selected.documentDatePrecision} text={selected.documentDateText} />],
                    ['Type', documentTypeLabel(selected.category)],
                    ['Pages', <span key="p" className="mono">{selected.pageCount}</span>],
                    ['Details', <span key="f" className="mono">{selected.factsCount}</span>],
                    ['Added on', <DateTimeText key="a" iso={selected.createdAt} />],
                  ]}
                />
                {selected.setAsideAsCopyOf ? <div className="muted small">{setAsideTrashWords(selected.setAsideAsCopyOf, selected.setAsideCheckedDetails ?? 0)}</div> : null}
                {selected.wrongPatient ? (
                  <div className="muted small">You said this is not your record (wrong patient). Restore brings it back as "{HELD_WORDS}", with its details still hidden, to check again.</div>
                ) : selected.duplicateOf ? (
                  <div className="notice warn">The same file is in the case as "{selected.duplicateOf.title}". Delete that copy first to restore this one with its details.</div>
                ) : (
                  <div className="muted small">Restoring brings the document back with the {selected.factsCount} detail{selected.factsCount === 1 ? '' : 's'} deleted with it, your checks unchanged. Details deleted on their own earlier stay deleted.</div>
                )}
                <div className="row">
                  {canWrite ? (
                    <Button variant="primary" data-restore shortcut={TRASH_KEYS.restore} disabled={restore.isPending || Boolean(selected.duplicateOf)} onClick={() => runRestore()}>
                      Restore
                    </Button>
                  ) : (
                    <span className="muted small">Restoring is for the owner and editors.</span>
                  )}
                  <PurgeDocument doc={selected} onPurged={() => select(undefined)} />
                </div>
              </DetailPane>
            ) : (
              <EmptyState title={items.length ? 'Pick a deleted document' : 'Nothing has been deleted'}>{items.length ? 'See what was deleted with it, and restore it.' : 'Documents you delete land here, with their details, until you restore them.'}</EmptyState>
            )
          }
        />
      </div>
    </div>
  );
}
