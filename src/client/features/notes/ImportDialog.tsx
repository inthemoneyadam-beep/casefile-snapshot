/**
 * Import notes: drop many files at once, a zip, or a whole folder (chosen in the browser); on this computer only, also
 * a folder by its path. Every note is filed as your own note with its own date, nothing is read yet. Then: what was
 * added, what was already in, what was skipped and why; while the text of each note is stored, one line says so; then
 * ONE estimate for reading them all, with "Read them" and "Not now". Nothing is read without the yes.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { NoteImportResult } from '@shared/notes';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { useMe } from '../../api/users';
import { useImportStatus, useNotesImport } from '../../api/notes';
import { errorMessage } from '../../api/client';
import { hasFiles } from '../../app/dom';
import { NOTE_ACCEPT, importWords, plural } from './words';
import { droppedFiles } from './drop';
import './notes.css';

export function ImportDialog({ open, onClose, initialFiles }: { open: boolean; onClose: () => void; initialFiles?: File[] | null }) {
  const toast = useToast();
  const me = useMe();
  const imp = useNotesImport();
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<(NoteImportResult & { truncated?: boolean }) | null>(null);
  const [path, setPath] = useState('');
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const status = useImportStatus(result?.batch ?? null);
  const lastInitial = useRef<File[] | null>(null);
  const busy = imp.files.isPending || imp.folder.isPending;

  function send(files: File[]) {
    if (!files.length || busy) return;
    imp.files.mutate(files, {
      onSuccess: (r) => setResult(r),
      onError: (err) => toast(errorMessage(err, 'Could not import the notes'), 'bad'),
    });
  }
  // Files dropped on the page before the dialog opened.
  useEffect(() => {
    if (open && initialFiles?.length && lastInitial.current !== initialFiles) {
      lastInitial.current = initialFiles;
      send(initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFiles]);

  function close() {
    setResult(null);
    setPath('');
    imp.files.reset();
    imp.folder.reset();
    onClose();
  }
  function readThem() {
    if (!result) return;
    imp.read.mutate(
      { batch: result.batch },
      {
        onSuccess: (r) => {
          toast(r.jobs ? `Claude is reading ${plural(r.estimate.packedNotes + r.estimate.aloneNotes, 'note')}.` : 'Nothing to read.', 'ok');
          close();
        },
        onError: (err) => toast(errorMessage(err, 'Could not start the reading'), 'bad'),
      },
    );
  }

  const s = status.data;
  const drop = {
    'data-own-drop': '',
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      // A dropped folder is read file by file (drop.ts).
      void droppedFiles(e.dataTransfer).then(send);
    },
  };

  const footer = result ? (
    <div className="row">
      {s?.estimate ? (
        <Button variant="primary" onClick={readThem} disabled={imp.read.isPending} data-autofocus shortcut="enter">
          {imp.read.isPending ? 'Starting…' : 'Read them'}
        </Button>
      ) : null}
      <Button variant="ghost" onClick={close}>
        {s?.estimate ? 'Not now' : 'Close'}
      </Button>
    </div>
  ) : (
    <div className="row">
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onClose={close} title="Import your notes" width={620} footer={footer}>
      {!result ? (
        <div className={`nt-drop${over ? ' over' : ''}`} {...drop}>
          <p>
            Drop your notes here: many files at once, a zip, or a folder. Text, Word, PDF, web pages, Rich Text, spreadsheets of entries, Google Keep (Takeout) and Evernote all work.
          </p>
          <p>Each note is filed as your own note, dated by its own date. Nothing is read until you say so.</p>
          <div className="nt-import-actions">
            <Button variant="accent" onClick={() => filesRef.current?.click()} disabled={busy} data-autofocus>
              Choose files
            </Button>
            <Button onClick={() => folderRef.current?.click()} disabled={busy}>
              Choose a folder
            </Button>
            {busy ? <span className="muted">Importing…</span> : null}
          </div>
          <input ref={filesRef} type="file" multiple accept={NOTE_ACCEPT} hidden onChange={(e) => send(Array.from(e.target.files ?? []))} />
          {/* webkitdirectory is not in React's types: set as an attribute. */}
          <input ref={folderRef} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} onChange={(e) => send(Array.from(e.target.files ?? []))} />
          {!me.hosted && me.isOwner ? (
            <form
              className="nt-folder"
              onSubmit={(e) => {
                e.preventDefault();
                if (!path.trim() || busy) return;
                imp.folder.mutate({ path: path.trim(), recursive: true }, { onSuccess: (r) => setResult(r), onError: (err) => toast(errorMessage(err, 'Could not read that folder'), 'bad') });
              }}
            >
              <label className="muted small" htmlFor="nt-folder-path">
                Or a folder on this computer:
              </label>
              <Input id="nt-folder-path" type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Notes" />
              <Button type="submit" size="sm" disabled={!path.trim() || busy}>
                Import
              </Button>
            </form>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="nt-estimate">{importWords(result)}</p>
          {result.truncated ? <p className="nt-line warn">The folder held more files than one import takes. Import it again for the rest; what is in already is skipped.</p> : null}
          {result.skipped.length ? (
            <details>
              <summary className="muted">Skipped ({result.skippedTotal})</summary>
              <ul className="nt-skipped">
                {result.skipped.map((k, i) => (
                  <li key={i}>
                    <span className="mono">{k.file}</span>: {k.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {!s ? (
            <p className="nt-line">Getting the text of each note…</p>
          ) : s.pending > 0 ? (
            <p className="nt-line">Getting the text of each note: {s.ready} of {s.notes} done.</p>
          ) : s.estimate ? (
            <p className="nt-estimate">
              Reading them: {s.estimate.words} Claude pulls out what each note says (drugs, doses, dates, symptoms) and sets it beside your records.
            </p>
          ) : (
            <p className="nt-line">{s.notes ? 'Nothing to read: every note is read already or has no text.' : 'No new notes to read.'}</p>
          )}
          {s && s.likelyCopies ? <p className="nt-line">{plural(s.likelyCopies, 'note')} look like a copy of one you have; each says which on its page.</p> : null}
          {s && s.held ? <p className="nt-line warn">{plural(s.held, 'note')} held back: it may be someone else's. Check before filing asks you.</p> : null}
        </div>
      )}
    </Dialog>
  );
}
