import { useEffect, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { DayInput, dayHint, readDay } from '../../ui/DayInput';
import { TASK_OWNERS, TASK_PRIORITIES } from '@shared/enums';
import type { FindingDetail, ToTaskInput } from '../../api/findings';

/** Who does it, in words (the stored values stay the same). */
const OWNER_WORDS: Record<string, string> = { me: 'Me', chief_of_staff: 'Chief of staff', advocate: 'An advocate', person: 'Someone else' };
const PRIORITY_WORDS: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

export function TaskDialog({ open, onClose, finding, busy, error, onCreate }: { open: boolean; onClose: () => void; finding: FindingDetail | null; busy: boolean; error?: string | null; onCreate: (input: ToTaskInput) => void }) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [owner, setOwner] = useState<string>('me');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState<string>('normal');

  useEffect(() => {
    if (!open || !finding) return;
    setTitle(finding.title);
    setDetail(finding.whyItMatters);
    setOwner('me');
    setDueAt('');
    setPriority(finding.severity === 'high' ? 'high' : 'normal');
  }, [open, finding]);

  function submit() {
    if (!title.trim() || busy || !readDay(dueAt).ok) return;
    onCreate({ title: title.trim(), detail: detail.trim() || null, owner, dueAt: readDay(dueAt).iso, priority });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add it to the to-do list"
      width={640}
      footer={
        <>
          <span className="faint xs grow">
            <Kbd>ctrl+enter</Kbd> add
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !title.trim() || !readDay(dueAt).ok} onClick={submit}>
            Add the to-do
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      >
        {error ? <div className="notice bad small">{error}</div> : null}
        <div className="findings-form">
          <div className="full">
            <Field label="What to do">
              <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <div className="full">
            <Field label="Notes" hint="Starts as why the finding matters; change it freely.">
              <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} />
            </Field>
          </div>
          <Field label="Who does it">
            <Select value={owner} options={TASK_OWNERS.map((o) => ({ value: o, label: OWNER_WORDS[o] ?? o }))} onChange={(e) => setOwner(e.target.value)} />
          </Field>
          <Field label="How urgent">
            <Select value={priority} options={TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_WORDS[p] ?? p }))} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Due" hint={dayHint(dueAt) ?? 'Optional'}>
            <DayInput value={dueAt} onChange={setDueAt} />
          </Field>
        </div>
        <span className="muted small">A finding has one open to-do: asking again shows the one already on the list.</span>
      </div>
    </Dialog>
  );
}
