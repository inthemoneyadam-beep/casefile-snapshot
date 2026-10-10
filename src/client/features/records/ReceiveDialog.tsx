import { useEffect, useState, type FormEvent } from 'react';
import { todayIso } from '@shared/dates';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field, Input, Select } from '../../ui/Field';
import { DayInput, dayHint, readDay } from '../../ui/DayInput';
import type { DocumentLite } from '../../api/records';

export interface ReceivePayload {
  documentId: string | null;
  receivedAt: string | null;
  note: string | null;
}

/** The server's "likely held" guess, offered as the default document but labelled as a guess. */
export interface ReceiveSuggestion {
  documentId: string;
  title: string | null;
  /** What the guess matched on, e.g. "same record type, an agreeing date and the modality". */
  basis: string;
  /** Appended to the row's notes when the suggested document is the one linked. */
  note: string;
}

/**
 * "Mark received": optionally link the document that is the received copy.
 * The select starts on the row's current link, else on the suggestion; a
 * suggested document is never linked silently: the hint under the field names
 * it as a guess, and linking it adds a line to the row's notes saying so.
 */
export function ReceiveDialog({
  open,
  title,
  documents,
  defaultDocumentId,
  suggestion,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string | null;
  documents: DocumentLite[];
  defaultDocumentId?: string | null;
  suggestion?: ReceiveSuggestion | null;
  onClose: () => void;
  onConfirm: (p: ReceivePayload) => void;
}) {
  const [documentId, setDocumentId] = useState('');
  const [receivedAt, setReceivedAt] = useState(todayIso());
  const [note, setNote] = useState('');
  const initialDocumentId = defaultDocumentId ?? suggestion?.documentId ?? '';

  useEffect(() => {
    if (open) {
      setDocumentId(initialDocumentId);
      setReceivedAt(todayIso());
      setNote('');
    }
  }, [open, initialDocumentId]);

  const usingSuggestion = Boolean(suggestion && documentId === suggestion.documentId && documentId !== (defaultDocumentId ?? ''));

  function submit(e: FormEvent) {
    e.preventDefault();
    const lines = [note.trim(), usingSuggestion && suggestion ? suggestion.note : ''].filter(Boolean);
    if (!readDay(receivedAt).ok) return;
    onConfirm({ documentId: documentId || null, receivedAt: readDay(receivedAt).iso, note: lines.join('\n') || null });
  }

  const options = documents.map((d) => ({ value: d.id, label: `${d.documentDate ? `${d.documentDate} · ` : ''}${d.title}` }));
  const hint = !documents.length ? (
    'No documents are listed yet; the row is still marked received.'
  ) : usingSuggestion && suggestion ? (
    <>
      Chosen from a guess, not a confirmed match: {suggestion.title ?? 'this document'} matched on {suggestion.basis}. Check it before you save; the row's notes will say it came from the guess.
    </>
  ) : suggestion && !documentId ? (
    <>
      A guess: {suggestion.title ?? 'a document in the case'} ({suggestion.basis}). Leave it empty if the copy is not in the case yet.
    </>
  ) : (
    'Leave it empty if the copy is not in the case yet.'
  );

  return (
    <Dialog open={open} onClose={onClose} title="Mark received" width={520}>
      <form onSubmit={submit} className="stack" id="records-receive-form">
        {title ? <div className="muted small truncate">{title}</div> : null}
        <Field label="The copy you have" hint={hint}>
          <Select autoFocus value={documentId} onChange={(e) => setDocumentId(e.target.value)} options={options} placeholder="Not in the case (on paper, or elsewhere)" />
        </Field>
        <Field label="Received on" hint={dayHint(receivedAt) ?? 'Today unless you change it.'}>
          <DayInput value={receivedAt} onChange={setReceivedAt} />
        </Field>
        <Field label="Note" hint="Added to the row's notes.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. arrived on disc, 2 of 3 studies" />
        </Field>
        <div className="row records-dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit">
            Mark received
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
