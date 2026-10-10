/**
 * Documents attached to a consult question: the chips under the question box.
 *
 * Each file is uploaded like any other (POST /api/documents, where Claude
 * reads, names and files it); a file already in the case attaches the
 * existing document. A chip follows its document while it is read (the
 * document query polls every 2 s while it is busy), shows the title Claude
 * gives it, lets the patient mark it as the official record (its source tier
 * becomes 'primary', a clinical record, which settles disagreements over
 * measurements and recorded events) and removes it from this question only:
 * the document stays in Documents.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { useDocument, useUploadDocuments, type DocumentDetail } from '../../api/documents';
import { useSetDocumentTier, type DocumentTierFields } from '../documents/api';
import { documentProgressWords } from '../home/progress';
import { useToast } from '../../ui/Toast';
import { ASK_MAX_ATTACHMENTS } from '@shared/ask';

export interface AttachmentDraft {
  /** Local key, stable from the moment the file is picked. */
  key: string;
  /** The file name, shown until the document's title is known. */
  name: string;
  documentId?: string;
  uploading?: boolean;
  uploadError?: string;
  /** The file was already in the case: the existing document is attached. */
  duplicate?: boolean;
  /** The document's title and reading state as last seen (the upload, then the chip's poll). */
  title?: string;
  textStatus?: string;
  /** Jobs are still queued or running for the document. */
  busyJobs?: boolean;
  /** The document is no longer in Documents (deleted meanwhile): it is not sent. */
  missing?: boolean;
  /** Set while the patient's own tick made it the official record here: the tier it had before. */
  tierBefore?: string;
}

export type UpdateAttachments = (fn: (list: AttachmentDraft[]) => AttachmentDraft[]) => void;

export type AttachmentPhase = 'uploading' | 'upload-failed' | 'missing' | 'waiting' | 'read' | 'unreadable';

const TEXT_READ = new Set(['extracted', 'ocr_done']);
const TEXT_READING = new Set(['pending', 'extracting', 'ocr_running']);

export function attachmentPhase(a: AttachmentDraft): AttachmentPhase {
  if (a.uploading) return 'uploading';
  if (a.uploadError || !a.documentId) return 'upload-failed';
  if (a.missing) return 'missing';
  if (!a.textStatus) return 'waiting';
  if (TEXT_READ.has(a.textStatus)) return 'read';
  if (TEXT_READING.has(a.textStatus) || (a.textStatus === 'ocr_needed' && a.busyJobs)) return 'waiting';
  return 'unreadable';
}

/** How many attachments are still being uploaded or read (the question waits for them). */
export function attachmentsWaiting(list: AttachmentDraft[]): number {
  return list.filter((a) => {
    const p = attachmentPhase(a);
    return p === 'uploading' || p === 'waiting';
  }).length;
}

/** The document ids that go with the question (failed uploads and deleted documents are left out). */
export function attachedDocumentIds(list: AttachmentDraft[]): string[] {
  return [...new Set(list.filter((a) => a.documentId && !a.uploadError && !a.missing).map((a) => a.documentId!))];
}

let seq = 0;

/** A chip for a document already on file (a retried question's attachments); it is read again before sending. */
export function draftForDocument(documentId: string, title: string): AttachmentDraft {
  return { key: `attach-${++seq}`, name: title, documentId, title };
}

/**
 * Upload files and attach each document. One request per file, so one file
 * the server refuses does not sink the others; a document attached twice
 * keeps one chip.
 */
export function useAttachFiles(list: AttachmentDraft[], update: UpdateAttachments): (files: File[]) => void {
  const upload = useUploadDocuments();
  const toast = useToast();
  const listRef = useRef(list);
  listRef.current = list;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  return useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const room = ASK_MAX_ATTACHMENTS - listRef.current.length;
      if (room <= 0) {
        toast(`A question can carry at most ${ASK_MAX_ATTACHMENTS} documents.`, 'bad');
        return;
      }
      const take = files.slice(0, room);
      if (files.length > room) toast(`Only ${room} more document${room === 1 ? '' : 's'} fit on this question; the rest were not added.`, 'bad');
      const drafts: AttachmentDraft[] = take.map((f) => ({ key: `attach-${++seq}`, name: f.name || 'file', uploading: true }));
      listRef.current = [...listRef.current, ...drafts];
      update((xs) => [...xs, ...drafts]);
      take.forEach((file, i) => {
        const key = drafts[i].key;
        uploadRef.current.mutateAsync({ files: [file] }).then(
          (r) => {
            const doc = r.items[0];
            if (!doc) {
              update((xs) => xs.map((x) => (x.key === key ? { ...x, uploading: false, uploadError: 'the upload returned nothing' } : x)));
              return;
            }
            update((xs) => {
              // The same document is attached already (picked twice, or a duplicate of an attached file).
              if (xs.some((x) => x.key !== key && x.documentId === doc.id)) return xs.filter((x) => x.key !== key);
              return xs.map((x) => (x.key === key ? { ...x, uploading: false, documentId: doc.id, duplicate: Boolean(doc.duplicate), title: doc.title, textStatus: doc.textStatus } : x));
            });
          },
          (err) => update((xs) => xs.map((x) => (x.key === key ? { ...x, uploading: false, uploadError: errorMessage(err) } : x))),
        );
      });
    },
    [update, toast],
  );
}

type Doc = DocumentDetail & DocumentTierFields;

function AttachmentChip({ a, update }: { a: AttachmentDraft; update: UpdateAttachments }) {
  const q = useDocument(a.documentId);
  const doc = q.data as Doc | undefined;
  const setTier = useSetDocumentTier();
  const qc = useQueryClient();
  const toast = useToast();
  // The patient's tick shows at once; the document's own tier takes over when the change is saved.
  const [pendingTier, setPendingTier] = useState<string | null>(null);

  const busyJobs = doc ? doc.jobs.some((j) => j.status === 'queued' || j.status === 'running') : undefined;
  useEffect(() => {
    if (!doc) return;
    update((xs) => {
      const cur = xs.find((x) => x.key === a.key);
      if (!cur || (cur.title === doc.title && cur.textStatus === doc.textStatus && cur.busyJobs === busyJobs)) return xs;
      return xs.map((x) => (x.key === a.key ? { ...x, title: doc.title, textStatus: doc.textStatus, busyJobs } : x));
    });
  }, [doc, busyJobs, a.key, update]);
  const gone = q.error instanceof ApiError && q.error.status === 404;
  useEffect(() => {
    if (gone) update((xs) => (xs.some((x) => x.key === a.key && !x.missing) ? xs.map((x) => (x.key === a.key ? { ...x, missing: true } : x)) : xs));
  }, [gone, a.key, update]);

  const phase = attachmentPhase(a);
  const tier = pendingTier ?? doc?.sourceTier ?? 'unknown';
  const official = tier === 'primary';
  // Marked as a clinical record elsewhere (by Claude's sorting or on the document page): changed there, not here.
  const officialElsewhere = official && a.tierBefore === undefined && pendingTier === null;

  const setOfficial = (on: boolean) => {
    if (!a.documentId) return;
    const before = doc?.sourceTier ?? 'unknown';
    // Unticking restores what the document was before the tick here (usually 'unknown', so Claude may sort it again).
    const next = on ? 'primary' : (a.tierBefore ?? 'unknown');
    setPendingTier(next);
    update((xs) => xs.map((x) => (x.key === a.key ? { ...x, tierBefore: on ? before : undefined } : x)));
    setTier.mutate(
      { id: a.documentId, sourceTier: next },
      {
        // The saved tier shows at once (the hook also refetches the document).
        onSuccess: () => qc.setQueryData<Doc>(['document', a.documentId], (old) => (old ? { ...old, sourceTier: next } : old)),
        onSettled: () => setPendingTier(null),
        onError: (err) => {
          update((xs) => xs.map((x) => (x.key === a.key ? { ...x, tierBefore: on ? undefined : a.tierBefore } : x)));
          toast(`Could not change the source: ${errorMessage(err)}`, 'bad');
        },
      },
    );
  };

  let state: string;
  if (phase === 'uploading') state = 'Uploading…';
  else if (phase === 'upload-failed') state = `Upload failed: ${a.uploadError ?? 'unknown error'}`;
  else if (phase === 'missing') state = 'No longer in Documents, so it will not be sent';
  else {
    const textStatus = doc?.textStatus ?? a.textStatus ?? 'pending';
    // Once read, the question can go: say so (the details Claude pulls out later are not what it waits for).
    state = phase === 'read' ? 'Read; it goes with your question' : documentProgressWords(textStatus, doc?.extractionStatus ?? 'none');
    if (phase === 'unreadable') state = `${state}${doc?.textError ? `: ${doc.textError}` : ''}. Claude will be told it could not be read; remove it or ask anyway.`;
  }
  const title = doc?.title ?? a.title ?? a.name;
  const tone = phase === 'upload-failed' || phase === 'missing' || phase === 'unreadable' ? ' bad' : '';

  return (
    <li className={`ask-attach-chip${official ? ' official' : ''}${tone}`}>
      <span className="ask-attach-name" title={a.name !== title ? `${title} (file: ${a.name})` : title}>
        {title}
      </span>
      <span className="ask-attach-state" role="status">
        {state}
        {a.duplicate ? ' · already in the case' : ''}
      </span>
      {a.documentId && !a.missing ? (
        <label
          className="ask-attach-official"
          title={
            officialElsewhere
              ? 'This document is already marked as a clinical record. Change its source on the document page if that is wrong.'
              : 'Sets the document’s source to clinical record. For measurements and recorded events it then settles disagreements with summaries and notes.'
          }
        >
          <input type="checkbox" checked={official} disabled={!doc || officialElsewhere || setTier.isPending} onChange={(e) => setOfficial(e.target.checked)} />
          This is the official record
        </label>
      ) : null}
      <button type="button" className="ask-link" onClick={() => update((xs) => xs.filter((x) => x.key !== a.key))} title="Remove it from this question. The document stays in Documents.">
        Remove
      </button>
    </li>
  );
}

export function AttachmentChips({ list, update }: { list: AttachmentDraft[]; update: UpdateAttachments }) {
  if (!list.length) return null;
  return (
    <>
      <ul className="ask-attach-list" aria-label="Attached documents">
        {list.map((a) => (
          <AttachmentChip key={a.key} a={a} update={update} />
        ))}
      </ul>
      <div className="ask-attach-hint">Claude reads and files attachments like any upload. Mark one as the official record to let it settle disagreements.</div>
    </>
  );
}
