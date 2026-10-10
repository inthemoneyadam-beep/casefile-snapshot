/**
 * Folder import (Documents toolbar, key `i`, owner only, not on a hosted server): copy every supported
 * file in a folder on this computer into the case. The server only reads the
 * folder; the originals stay where they are. Preview (Enter in the folder
 * field) reads and hashes without storing anything; Import (ctrl+enter)
 * stores the new files and queues their ingestion. The data and backups
 * folders are refused by the server.
 *
 * Mounted once in src/client/routes/documents.tsx: <FolderImport />.
 */
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { errorText, useMe } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { useBindings } from '../../app/shortcuts';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field, Select } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { VirtualRows } from '../../ui/VirtualRows';
import { DOCUMENT_CATEGORIES } from '@shared/enums';
import './folder-import.css';

export interface FolderImportItem {
  file: string;
  documentId: string | null;
  title: string | null;
  duplicate: boolean;
  sizeBytes: number;
}

/** POST /api/documents/import-folder (also what the first-run setup reads: imported, duplicates, skipped). */
export interface FolderImportResult {
  folder: string;
  recursive: boolean;
  dryRun: boolean;
  toInbox: boolean;
  autoExtract: boolean;
  imported: number;
  duplicates: number;
  skipped: Array<{ file: string; reason: string }>;
  skippedTotal: number;
  items: FolderImportItem[];
  truncated: boolean;
  bytes: number;
}

export interface FolderImportInput {
  path: string;
  recursive?: boolean;
  category?: string;
  autoExtract?: boolean;
  toInbox?: boolean;
  dryRun?: boolean;
}

export function useImportFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FolderImportInput) => api.post<FolderImportResult>('/api/documents/import-folder', input),
    onSuccess: (r) => {
      if (r.dryRun) return;
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      if (r.toInbox) void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
}

const PATH_KEY = 'casefile.folderImport.path';

function rememberedPath(): string | null {
  try {
    return sessionStorage.getItem(PATH_KEY);
  } catch {
    return null;
  }
}
function rememberPath(p: string): void {
  try {
    sessionStorage.setItem(PATH_KEY, p);
  } catch {
    // per-session convenience only
  }
}

function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** One line: what the run did (or would do). */
export function importSummary(r: FolderImportResult): string {
  const verb = r.dryRun ? 'would import' : 'imported';
  const parts = [`${r.imported} ${verb}`, `${r.duplicates} already in the case`, `${r.skippedTotal} skipped`];
  return `${parts.join(' · ')} · ${megabytes(r.bytes)} read${r.truncated ? ' · more files remain: run it again for the rest' : ''}`;
}

type Line = { file: string; kind: 'new' | 'duplicate' | 'skipped'; detail: string };

function linesOf(r: FolderImportResult): Line[] {
  const out: Line[] = r.items.map((it) => ({
    file: it.file,
    kind: it.duplicate ? 'duplicate' : 'new',
    detail: it.duplicate ? (it.title ? `in the case as "${it.title}"` : 'repeated in this folder') : it.title ?? megabytes(it.sizeBytes),
  }));
  for (const s of r.skipped) out.push({ file: s.file, kind: 'skipped', detail: s.reason });
  return out;
}

const KIND_TONE = { new: 'ok', duplicate: 'neutral', skipped: 'warn' } as const;

/**
 * Keys pressed inside one of these dialogs stay in it: a plain key on a focused
 * button or checkbox (x, n, Delete, Esc) never reaches the page's bindings
 * behind the modal. Native actions are untouched (Enter, Space, Tab, and Esc
 * still closes the dialog), and chords with ctrl, alt or meta (ctrl+enter,
 * ctrl+k) still reach the global handler.
 */
export function keepKeysInDialog(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.stopPropagation();
}

/**
 * The folder import's dialog, its key (i) and its palette command, and the function that opens it, so a page can put
 * "Import a folder" in its own action bar. Owner only, and only when the app runs on this computer: `allowed` is
 * false for everyone else and on a hosted server (no dialog, no key, no palette command).
 */
export function useFolderImport(): { allowed: boolean; open: () => void; dialog: ReactNode } {
  const me = useMe();
  const toast = useToast();
  const run = useImportFolder();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [toInbox, setToInbox] = useState(false);
  const [autoExtract, setAutoExtract] = useState(false);
  const [category, setCategory] = useState('');
  const [result, setResult] = useState<FolderImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A hosted server (Railway) has no folders of the user's to read: the import by path is off there (the server refuses
  // it too); dropping or choosing files in the browser works everywhere.
  const allowed = me.isOwner && !me.hosted;

  function openDialog() {
    if (!allowed) return;
    // Suggest the folder used last in this session, else the Files folder next to the app.
    setFolder((f) => f || rememberedPath() || me.filesFolder || '');
    setResult(null);
    setError(null);
    setOpen(true);
  }

  function start(dryRun: boolean) {
    const path = folder.trim();
    if (!path || run.isPending) return;
    rememberPath(path);
    setError(null);
    run.mutate(
      { path, recursive, toInbox, autoExtract: toInbox ? false : autoExtract, category: !toInbox && category ? category : undefined, dryRun },
      {
        onSuccess: (r) => {
          setResult(r);
          if (!r.dryRun) toast(`Imported ${r.imported} file${r.imported === 1 ? '' : 's'}; ${r.duplicates} already in the case; ${r.skippedTotal} skipped`, r.imported ? 'ok' : 'info');
        },
        onError: (err) => {
          setResult(null);
          setError(errorText(err, 'The import failed'));
        },
      },
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    start(true);
  }

  useBindings(
    allowed ? [{ keys: 'i', description: 'Import a folder of documents (copies; the folder is only read)', group: 'Documents', when: () => !document.querySelector('dialog[open]'), run: openDialog }] : [],
    [allowed],
  );
  // Bound only while the dialog is open, so it never shadows another page's ctrl+enter.
  useBindings(
    open ? [{ keys: 'ctrl+enter', description: 'Folder import: import now', group: 'Documents', global: true, run: () => start(false) }] : [],
    [open, folder, recursive, toInbox, autoExtract, category, run.isPending],
  );
  useRegisterCommands(
    [{ id: 'documents.importFolder', title: 'Import a folder of documents', group: 'Documents', shortcut: 'i', keywords: 'folder bulk files copy import directory', when: () => allowed, run: openDialog }],
    [allowed],
  );

  const lines = useMemo(() => (result ? linesOf(result) : []), [result]);

  if (!allowed) return { allowed: false, open: openDialog, dialog: null };
  const dialog = (
    <>
      <Dialog open={open} onClose={() => setOpen(false)} title="Import a folder" width={720}>
        <form className="stack fi" onSubmit={onSubmit} onKeyDown={keepKeysInDialog}>
          <Field label="Folder" hint="The files are copied into the encrypted store and the folder is only read; nothing in it is moved or changed. The case data and backups folders are refused.">
            <input type="text" className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} aria-label="Folder path" data-autofocus />
          </Field>
          <div className="fi-options">
            <label className="fi-check">
              <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
              Include subfolders
            </label>
            <label className="fi-check">
              <input type="checkbox" checked={toInbox} onChange={(e) => setToInbox(e.target.checked)} />
              Send to the Inbox for triage
            </label>
            <label className="fi-check" title={toInbox ? 'Inbox items are extracted when filed' : 'Each new document is read by the model after ingestion (model calls)'}>
              <input type="checkbox" checked={autoExtract && !toInbox} disabled={toInbox} onChange={(e) => setAutoExtract(e.target.checked)} />
              Extract facts after reading (model calls)
            </label>
            <label className="fi-check">
              Category
              <Select value={category} disabled={toInbox} options={DOCUMENT_CATEGORIES} placeholder="other" onChange={(e) => setCategory(e.target.value)} aria-label="Category for the new documents" />
            </label>
          </div>
          <div className="row">
            <Button type="submit" shortcut="enter" disabled={run.isPending || !folder.trim()}>
              Preview
            </Button>
            <Button variant="primary" shortcut="ctrl+enter" onClick={() => start(false)} disabled={run.isPending || !folder.trim()}>
              Import
            </Button>
            <span className="spacer grow" />
            <span className="faint xs">
              <Kbd>esc</Kbd> close
            </span>
          </div>
          {run.isPending ? <div className="muted small">Reading the folder…</div> : null}
          {error ? <div className="notice bad">{error}</div> : null}
          {result && !run.isPending ? (
            <div className="stack tight">
              <div className="muted small">
                {result.dryRun ? 'Preview: ' : ''}
                {importSummary(result)}
              </div>
              <div className="faint xs mono truncate" title={result.folder}>
                {result.folder}
              </div>
              {lines.length ? (
                <div className="fi-results" ref={listRef} tabIndex={0} aria-label="Files in the folder">
                  <VirtualRows
                    count={lines.length}
                    scrollRef={listRef}
                    render={(i) => {
                      const l = lines[i];
                      return (
                        <div key={`${l.kind}:${l.file}:${i}`} className="fi-row">
                          <span className="mono truncate" title={l.file}>
                            {l.file}
                          </span>
                          <Tag tone={KIND_TONE[l.kind]}>{l.kind}</Tag>
                          <span className="muted truncate" title={l.detail}>
                            {l.detail}
                          </span>
                        </div>
                      );
                    }}
                  />
                </div>
              ) : (
                <div className="muted small">The folder holds no files.</div>
              )}
              {result.skipped.length < result.skippedTotal ? <div className="faint xs">Showing the first {result.skipped.length} of {result.skippedTotal} skipped files.</div> : null}
            </div>
          ) : null}
        </form>
      </Dialog>
    </>
  );
  return { allowed, open: openDialog, dialog };
}

/** The folder import as a button with its dialog (key i). Pages with an action bar use useFolderImport instead. */
export function FolderImport() {
  const f = useFolderImport();
  if (!f.allowed) return null;
  return (
    <>
      <Button size="sm" shortcut="i" onClick={f.open} title="Copy every supported file in a folder on this computer into the case; the folder itself is only read">
        Import folder
      </Button>
      {f.dialog}
    </>
  );
}
