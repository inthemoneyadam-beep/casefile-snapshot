import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { TASK_OWNERS, TASK_PRIORITIES, TASK_STATUSES } from '@shared/enums';
import { usePeople } from '../../api/people';
import type { Task, TaskInput } from '../../api/tasks';
import { nz } from '../../app/text';
import { OWNER_WORDS, SOURCE_LONG, TASK_STATUS_WORDS } from './words';
import { personKindWords } from '../people/shared';

const OWNER_OPTIONS = TASK_OWNERS.map((o) => ({ value: o, label: OWNER_WORDS[o] ?? o }));
const PRIORITY_OPTIONS = TASK_PRIORITIES.map((p) => ({ value: p, label: p.replace(/^./, (c) => c.toUpperCase()) }));
const STATUS_OPTIONS = TASK_STATUSES.map((st) => ({ value: st, label: (TASK_STATUS_WORDS[st] ?? st).replace(/^./, (c) => c.toUpperCase()) }));

interface FormState {
  title: string;
  detail: string;
  owner: string;
  ownerPersonId: string;
  dueAt: string;
  remindAt: string;
  priority: string;
  status: string;
}

const EMPTY: FormState = { title: '', detail: '', owner: 'me', ownerPersonId: '', dueAt: '', remindAt: '', priority: 'normal', status: 'open' };

function fromTask(t: Task): FormState {
  return {
    title: t.title,
    detail: t.detail ?? '',
    owner: t.owner,
    ownerPersonId: t.ownerPersonId ?? '',
    dueAt: t.dueAt ?? '',
    remindAt: t.remindAt ? t.remindAt.replace('T', ' ') : '',
    priority: t.priority,
    status: t.status,
  };
}

export interface TaskDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this task; otherwise it creates one. */
  task?: Task | null;
  /** Prefilled fields for a new task (e.g. from an encounter). */
  preset?: Partial<TaskInput> | null;
  busy: boolean;
  error?: string | null;
  onCreate: (input: TaskInput) => void;
  onUpdate: (id: string, patch: Partial<TaskInput>) => void;
}

export function TaskDialog({ open, onClose, task, preset, busy, error, onCreate, onUpdate }: TaskDialogProps) {
  const editing = Boolean(task);
  const [f, setF] = useState<FormState>(EMPTY);
  const people = usePeople();

  // Seed the form once per opening (or when it switches to another task or source), never on a mere re-render:
  // a refetch or a new preset object while the dialog is open must not wipe what the user has typed.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seededFor.current = null;
      return;
    }
    const key = task ? `task:${task.id}` : `new:${preset?.sourceType ?? ''}:${preset?.sourceId ?? ''}`;
    if (seededFor.current === key) return;
    seededFor.current = key;
    if (task) setF(fromTask(task));
    else setF({ ...EMPTY, title: preset?.title ?? '', detail: preset?.detail ?? '', owner: preset?.owner ?? 'me', ownerPersonId: preset?.ownerPersonId ?? '', dueAt: preset?.dueAt ?? '', priority: preset?.priority ?? 'normal' });
  }, [open, task, preset]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const canSubmit = f.title.trim().length > 0 && !(f.owner === 'person' && !f.ownerPersonId) && !busy;

  function submit() {
    if (!canSubmit) return;
    const base: Partial<TaskInput> = {
      title: f.title.trim(),
      detail: nz(f.detail),
      owner: f.owner,
      ownerPersonId: nz(f.ownerPersonId),
      dueAt: nz(f.dueAt),
      remindAt: nz(f.remindAt),
      priority: f.priority,
    };
    if (editing && task) onUpdate(task.id, { ...base, status: f.status });
    else onCreate({ ...(base as TaskInput), sourceType: preset?.sourceType ?? 'manual', sourceId: preset?.sourceId ?? null });
  }

  const peopleOptions = (people.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.name}${p.kind !== 'clinician' ? ` (${personKindWords(p.kind).toLowerCase()})` : ''}` }));
  // A person deleted since the task was saved is still the stored owner; show that instead of a misleading "none".
  if (people.data && f.ownerPersonId && !peopleOptions.some((o) => o.value === f.ownerPersonId)) peopleOptions.push({ value: f.ownerPersonId, label: 'Removed person' });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit to-do' : 'Add a to-do'}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {editing ? 'Save' : 'Add it'} <Kbd>ctrl+enter</Kbd>
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
        <div className="tk-form">
          <div className="full">
            <Field label="To-do">
              <Input autoFocus value={f.title} onChange={set('title')} placeholder="What needs to happen, e.g. Call the clinic about the lab report" />
            </Field>
          </div>
          <div className="full">
            <Field label="Detail" hint="Why, who to ask, what was promised.">
              <Textarea value={f.detail} onChange={set('detail')} rows={3} />
            </Field>
          </div>
          <Field label="Who owes it">
            <Select value={f.owner} options={OWNER_OPTIONS} onChange={set('owner')} aria-label="Who owes it" />
          </Field>
          <Field label="Person" hint={f.owner === 'person' ? 'Needed: who owes it.' : 'Optional: who it concerns.'}>
            <Select value={f.ownerPersonId} options={peopleOptions} placeholder={people.isPending ? 'Loading…' : 'Nobody named'} onChange={set('ownerPersonId')} aria-label="Person" />
          </Field>
          <Field label="Due" hint="e.g. 2027-01-20, 1/20/2027, Jan 2027">
            <Input value={f.dueAt} onChange={set('dueAt')} placeholder="No due date" />
          </Field>
          <Field label="Reminder" hint="A day, or a day and time: 2026-10-19 09:00">
            <Input value={f.remindAt} onChange={set('remindAt')} placeholder="No reminder" />
          </Field>
          <Field label="Priority">
            <Select value={f.priority} options={PRIORITY_OPTIONS} onChange={set('priority')} aria-label="Priority" />
          </Field>
          {editing ? (
            <Field label="Status">
              <Select value={f.status} options={STATUS_OPTIONS} onChange={set('status')} aria-label="Status" />
            </Field>
          ) : preset?.sourceType && preset.sourceType !== 'manual' ? (
            <Field label="Came from">
              <span className="muted">{SOURCE_LONG[preset.sourceType] ?? preset.sourceType.replace(/_/g, ' ')}</span>
            </Field>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
