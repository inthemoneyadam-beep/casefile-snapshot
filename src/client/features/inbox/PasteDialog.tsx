import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { INBOX_NAME } from './words';

/** Pasted text becomes a .txt document in the Inbox. Ctrl+Enter saves. */
export function PasteDialog({ open, initialText, busy, error, onClose, onSave }: { open: boolean; initialText: string; busy: boolean; error: string | null; onClose: () => void; onSave: (text: string, title: string) => void }) {
  const [text, setText] = useState(initialText);
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setText(initialText);
      setTitle('');
      setTimeout(() => titleRef.current?.focus(), 0);
    }
  }, [open, initialText]);
  const canSave = text.trim().length > 0 && !busy;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Paste text into ${INBOX_NAME}`}
      width={640}
      footer={
        <>
          <span className="faint xs grow">
            <Kbd>ctrl+enter</Kbd> save
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => onSave(text, title)}>
            Add it
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSave) {
            e.preventDefault();
            onSave(text, title);
          }
        }}
      >
        <Field label="Title (optional)" hint="Becomes the file name; Claude suggests a proper title.">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Portal message from Dr. Smith"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && canSave) {
                e.preventDefault();
                onSave(text, title);
              }
            }}
          />
        </Field>
        <Field label="Text" hint={`${text.length} characters`}>
          <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a portal message, an email, or a transcript" />
        </Field>
        {error ? <div className="notice bad small">{error}</div> : null}
      </div>
    </Dialog>
  );
}
