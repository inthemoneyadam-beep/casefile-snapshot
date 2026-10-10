/**
 * Purge, inside Documents, Trash (owner only, key P): removes a deleted
 * document for good after the server has written a plaintext copy of the
 * original and a JSON manifest to <data>/trash/<date>/. The dialog names the
 * document, says what goes and what stays, and asks for the title to be typed
 * exactly (the server checks it too). The focus lands in the title field;
 * Enter purges only once the title matches, so a stray Enter does nothing.
 *
 * Mounted once in the trash detail of src/client/routes/documents.tsx:
 *   <PurgeDocument doc={selected} onPurged={() => select(undefined)} />
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { DeletedDocument } from '../../api/documents';
import { errorText, useMe } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { useBindings } from '../../app/shortcuts';
import { plural } from '../../app/text';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { keepKeysInDialog } from './FolderImport';
import './folder-import.css';

/** POST /api/documents/:id/purge */
export interface PurgeResult {
  ok: true;
  documentId: string;
  title: string;
  trash: { folder: string; file: string; manifest: string; keepUntil: string };
  removed: Record<string, number>;
  unlinked: Record<string, number>;
  originalRemoved: boolean;
}

export const PURGE_KEY = 'P';

export function usePurgeDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmTitle }: { id: string; confirmTitle: string }) => api.post<PurgeResult>(`/api/documents/${encodeURIComponent(id)}/purge`, { confirmTitle }),
    onSuccess: (_r, { id }) => {
      qc.removeQueries({ queryKey: ['document', id] });
      // A purge reaches facts, labs, imaging, records, communications and encounters: refresh everything once.
      void qc.invalidateQueries();
    },
  });
}

export function PurgeDocument({ doc, onPurged }: { doc: DeletedDocument | null; onPurged?: () => void }) {
  const me = useMe();
  const toast = useToast();
  const purge = usePurgeDocument();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const allowed = me.isOwner && Boolean(doc);
  const matches = Boolean(doc) && typed.trim() === doc?.title.trim();

  // A different selection closes the dialog: it never purges a row the user is not looking at.
  useEffect(() => {
    setOpen(false);
    setTyped('');
    setError(null);
  }, [doc?.id]);

  function openDialog() {
    if (!allowed) return;
    setTyped('');
    setError(null);
    setOpen(true);
  }

  function confirm(e?: FormEvent) {
    e?.preventDefault();
    if (!doc || !matches || purge.isPending) return;
    purge.mutate(
      { id: doc.id, confirmTitle: typed },
      {
        onSuccess: (r) => {
          setOpen(false);
          toast(`Purged "${r.title}". Plaintext copy kept in ${r.trash.folder} as ${r.trash.file} (until ${r.trash.keepUntil}).`, 'ok');
          onPurged?.();
        },
        onError: (err) => setError(errorText(err, 'The purge failed; nothing was removed')),
      },
    );
  }

  useBindings(
    allowed ? [{ keys: PURGE_KEY, description: 'Purge the selected deleted document (asks for its title)', group: 'Documents', when: () => !document.querySelector('dialog[open]'), run: openDialog }] : [],
    [allowed, doc?.id],
  );
  useRegisterCommands(
    allowed ? [{ id: 'documents.trash.purge', title: 'Purge document from the trash (permanent)', group: 'Documents', shortcut: PURGE_KEY, keywords: 'purge permanent erase remove forever', run: openDialog }] : [],
    [allowed, doc?.id],
  );

  if (!doc) return null;
  if (!me.isOwner) return <span className="muted small">Purging is the owner's.</span>;
  return (
    <>
      <Button variant="danger" shortcut={PURGE_KEY} onClick={openDialog} title="Remove this document for good, after a plaintext copy is written to the trash folder">
        Purge
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Purge document" width={620}>
        <form className="stack purge-confirm" onSubmit={confirm} onKeyDown={keepKeysInDialog}>
          <div className="purge-explain stack tight">
            <span>
              Purging removes <strong>{doc.title}</strong> for good:
            </span>
            <ul className="purge-list">
              <li>the encrypted original leaves the file store;</li>
              <li>
                its {plural(doc.pageCount, 'page')} and the {plural(doc.factsCount, 'detail')} pulled out of it, with your answers and their quotes, are deleted, with Claude's readings of it and the lab and scan rows tied to it;
              </li>
              <li>calls and messages, records checklist rows and appointments that link to it keep their own text and lose only the link.</li>
            </ul>
            <span>
              First, a plaintext copy of the original is written to <span className="mono">data/trash/&lt;today&gt;/</span> with a list of the document, its details and every link cleared. Keep it for 30 days; the app never deletes it and nothing is sent anywhere.
            </span>
            <span>There is no undo in the app. While the document is in the trash, Restore is the way back.</span>
          </div>
          <label className="field">
            <span>Type the title to confirm</span>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" aria-label="Type the document title to confirm" data-autofocus />
          </label>
          {error ? <div className="notice bad">{error}</div> : null}
          <div className="row">
            <span className="spacer grow" />
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={!matches || purge.isPending}>
              {purge.isPending ? 'Purging…' : 'Purge'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
