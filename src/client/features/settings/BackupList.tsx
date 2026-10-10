/**
 * Settings, Backups: the backup zips kept on the server, newest first, each with Download (owner only; the server
 * refuses everyone else). A download is a plain link the browser saves under the backup's own name; the zip is
 * still encrypted and needs a passphrase to open. j/k move in the list, Enter downloads the chosen one.
 */
import { useCallback, useMemo, useState } from 'react';
import { backupFileUrl, useBackups, type BackupFile } from '../../api/system';
import { errorText, useMe } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { Button } from '../../ui/Button';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateTimeText } from '../../ui/DateText';
import { Kbd } from '../../ui/Kbd';
import { Loading } from '../../ui/PageHeader';
import { fmtBytes } from './words';

/** Save a file the server sends as an attachment: a link click, so the browser downloads it (the cookie goes too). */
export function downloadUrl(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadBackup(name: string): void {
  downloadUrl(backupFileUrl(name));
}

export function BackupList() {
  const me = useMe();
  const list = useBackups(me.isOwner);
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const newest = rows[0] ?? null;

  const downloadNewest = useCallback(() => {
    if (newest) downloadBackup(newest.name);
  }, [newest]);
  useRegisterCommands(
    [{ id: 'settings.backup.download', title: 'Download the newest backup', group: 'Page', keywords: 'backup zip download save copy', run: downloadNewest, when: () => me.isOwner && Boolean(newest) }],
    [downloadNewest, me.isOwner, newest],
  );

  const columns = useMemo<ColumnDef<BackupFile, unknown>[]>(
    () => [
      { id: 'name', header: 'Backup', accessorFn: (r) => r.name, cell: ({ row }) => <span className="mono">{row.original.name}</span>, meta: { grow: true, minWidth: 220 } },
      { id: 'made', header: 'Made', accessorFn: (r) => r.createdAt, cell: ({ row }) => <DateTimeText iso={row.original.createdAt} />, meta: { width: 150 } },
      { id: 'size', header: 'Size', accessorFn: (r) => r.bytes, cell: ({ row }) => fmtBytes(row.original.bytes), meta: { className: 'num', width: 90 } },
      {
        id: 'download',
        header: '',
        enableSorting: false,
        cell: ({ row }) => (
          <Button size="sm" variant="ghost" onClick={() => downloadBackup(row.original.name)} title={`Save ${row.original.name} on this device`}>
            Download
          </Button>
        ),
        meta: { width: 100, grow: false },
      },
    ],
    [],
  );

  if (!me.isOwner) return <p className="muted">Only the owner can download backups.</p>;
  if (list.isPending) return <Loading>Loading the backups…</Loading>;
  if (list.isError) return <div className="notice bad">{errorText(list.error, 'Could not list the backups.')}</div>;
  return (
    <div className="backup-list">
      <div className="backup-list-head">
        <span className="settings-subhead">Backups kept here</span>
        {rows.length ? (
          <span className="faint xs">
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>enter</Kbd> download
          </span>
        ) : null}
      </div>
      <div className="backup-table">
        <DataTable
          columns={columns}
          data={rows}
          rowId={(r) => r.name}
          selectedId={selected}
          onSelect={(r) => setSelected(r?.name ?? null)}
          onOpen={(r) => downloadBackup(r.name)}
          emptyText="No backups yet. Back up now makes the first one."
          initialSort={[{ id: 'made', desc: true }]}
          tableId="settings.backups"
        />
      </div>
    </div>
  );
}
