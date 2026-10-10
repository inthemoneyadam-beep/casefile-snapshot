import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Field';
import './reconcile.css';
import { LONG_TEXT_MAX } from '@shared/constants';

/**
 * The reason the patient gives when his own word corrects a clinical record
 * ("The record is wrong", "This one is right"). A reason is required; Esc
 * cancels. The record itself is never changed.
 */
export function ReasonBox({
  title,
  saveLabel = 'Save',
  placeholder = 'Why the record is wrong here',
  busy,
  onSave,
  onCancel,
}: {
  title: string;
  saveLabel?: string;
  placeholder?: string;
  busy?: boolean;
  onSave: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const text = reason.trim();
  return (
    <div
      className="reason-box"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          onCancel();
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text) {
          e.preventDefault();
          onSave(text);
        }
      }}
    >
      <strong className="small">{title}</strong>
      <span className="hint">Use your own word only to correct a clinical mistake. Say why: what you know, and how (for example, the procedure note in your own records).</span>
      <Textarea autoFocus aria-label="Why" value={reason} maxLength={LONG_TEXT_MAX} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} rows={2} />
      <span className="row">
        <Button size="sm" variant="primary" disabled={busy || !text} onClick={() => onSave(text)}>
          {busy ? 'Saving…' : saveLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}
