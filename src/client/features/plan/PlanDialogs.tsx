/**
 * The Plan page's dialogs: change an item (its words, who, when and a note; the plan's own wording stays beside
 * them), make a to-do from an item, and use a document already in the case as the plan.
 */
import { useEffect, useMemo, useState } from 'react';
import { TASK_OWNERS, TASK_PRIORITIES } from '@shared/enums';
import { parsePartialDate, formatPartialDate } from '@shared/dates';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { DayInput, dayHint, readDay } from '../../ui/DayInput';
import { useDocuments } from '../../api/documents';
import { useDocumentPlanEstimate, type ItemPatch, type PlanItem, type TodoInput } from '../../api/plans';
import { usd } from '@shared/plan';
import { asWrittenLines, whenWords } from './words';

const OWNER_WORDS: Record<string, string> = { me: 'Me', chief_of_staff: 'Chief of staff', advocate: 'An advocate', person: 'Someone else' };
const PRIORITY_WORDS: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

/** Ctrl+Enter saves, as in every form. */
function onCtrlEnter(run: () => void) {
  return (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  };
}

/** How the typed "when" reads: a date, or kept as words. */
export function whenHint(text: string): string {
  const t = text.trim();
  if (!t) return 'Empty: no time.';
  const p = parsePartialDate(t);
  return p.iso ? `Reads as ${formatPartialDate(p.iso, p.precision)}.` : 'Kept as words.';
}

export function EditItemDialog({ open, item, busy, error, onClose, onSave }: { open: boolean; item: PlanItem | null; busy: boolean; error: string | null; onClose: () => void; onSave: (patch: ItemPatch) => void }) {
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open || !item) return;
    setTitle(item.title);
    setOwner(item.owner ?? '');
    setDue(whenWords(item) ?? '');
    setNote(item.note ?? '');
  }, [open, item]);
  if (!item) return null;
  const save = () => {
    if (busy || !title.trim()) return;
    const patch: ItemPatch = {};
    if (title.trim() !== item.title) patch.title = title.trim();
    if ((owner.trim() || null) !== item.owner) patch.owner = owner.trim() || null;
    if ((due.trim() || null) !== (whenWords(item) ?? null)) patch.due = due.trim() || null;
    if ((note.trim() ? note : null) !== item.note) patch.note = note.trim() ? note : null;
    onSave(patch);
  };
  const written = asWrittenLines(item);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change this item"
      width={640}
      footer={
        <>
          <span className="faint xs grow">
            <Kbd>ctrl+enter</Kbd> save
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack" onKeyDown={onCtrlEnter(save)}>
        {error ? <div className="notice bad small">{error}</div> : null}
        <p className="muted small">The plan’s own words are kept: what you change shows beside them.</p>
        <div className="plan-form">
          <div className="full">
            <Field label="What">
              <Input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <Field label="Who">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={200} placeholder="Not said" />
          </Field>
          <Field label="When" hint={whenHint(due)}>
            <Input value={due} onChange={(e) => setDue(e.target.value)} maxLength={300} placeholder="2027-02-15, or words" />
          </Field>
          <div className="full">
            <Field label="Note">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            </Field>
          </div>
        </div>
        {written.length ? (
          <div className="plan-as-written">
            {written.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function TodoDialog({ open, item, planTitle, busy, error, onClose, onCreate }: { open: boolean; item: PlanItem | null; planTitle: string; busy: boolean; error: string | null; onClose: () => void; onCreate: (input: TodoInput) => void }) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [owner, setOwner] = useState<string>('me');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState<string>('normal');
  useEffect(() => {
    if (!open || !item) return;
    setTitle(item.title);
    setDetail([`From your plan: ${planTitle}`, item.condition ? `When it applies: ${item.condition}` : null, item.dueText ? `When: ${item.dueText}` : null].filter(Boolean).join('\n'));
    setOwner('me');
    setDueAt(item.due && item.duePrecision === 'day' ? item.due : '');
    setPriority('normal');
  }, [open, item, planTitle]);
  if (!item) return null;
  const ok = Boolean(title.trim()) && readDay(dueAt).ok;
  const submit = () => {
    if (!ok || busy) return;
    onCreate({ title: title.trim(), detail: detail.trim() || null, owner, dueAt: readDay(dueAt).iso, priority });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Make a to-do"
      width={640}
      footer={
        <>
          <span className="faint xs grow">
            <Kbd>ctrl+enter</Kbd> add
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !ok} onClick={submit}>
            Add the to-do
          </Button>
        </>
      }
    >
      <div className="stack" onKeyDown={onCtrlEnter(submit)}>
        {error ? <div className="notice bad small">{error}</div> : null}
        <div className="plan-form">
          <div className="full">
            <Field label="What to do">
              <Input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <div className="full">
            <Field label="Notes">
              <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} />
            </Field>
          </div>
          <Field label="Who does it">
            <Select value={owner} options={TASK_OWNERS.filter((o) => o !== 'person').map((o) => ({ value: o, label: OWNER_WORDS[o] ?? o }))} onChange={(e) => setOwner(e.target.value)} />
          </Field>
          <Field label="How urgent">
            <Select value={priority} options={TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_WORDS[p] ?? p }))} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Due" hint={dayHint(dueAt) ?? 'Optional'}>
            <DayInput value={dueAt} onChange={setDueAt} />
          </Field>
        </div>
        <span className="muted small">The to-do and this item point to each other.</span>
      </div>
    </Dialog>
  );
}

/** Kinds of document the reading can see. */
const PLAN_KINDS = new Set(['pdf', 'docx', 'text', 'image']);

export function FromDocumentDialog({ open, busy, error, onClose, onPick }: { open: boolean; busy: boolean; error: string | null; onClose: () => void; onPick: (documentId: string) => void }) {
  const docs = useDocuments({});
  const [chosen, setChosen] = useState('');
  useEffect(() => {
    if (open) setChosen('');
  }, [open]);
  const options = useMemo(
    () =>
      (docs.data?.items ?? [])
        .filter((d) => PLAN_KINDS.has(d.kind))
        .map((d) => ({ value: d.id, label: `${d.title}${d.documentDate ? ` (${d.documentDate})` : ''}` })),
    [docs.data],
  );
  const estimate = useDocumentPlanEstimate(open && chosen ? chosen : null);
  const pick = () => {
    // The cost is on screen before the pick (it is known: the pages are stored).
    if (chosen && !busy && (estimate.data || estimate.isError)) onPick(chosen);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Use a document already added"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen || busy || (!estimate.data && !estimate.isError)} onClick={pick}>
            Read it as the plan
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="notice bad small">{error}</div> : null}
        <Field label="Document" hint="A PDF, Word file, text file or photo already in Documents.">
          {docs.isPending ? <span className="muted">Loading the documents…</span> : <Select data-autofocus value={chosen} options={options} placeholder="Choose one" onChange={(e) => setChosen(e.target.value)} />}
        </Field>
        <p className="muted small">{costWords(chosen, estimate.data, estimate.isError)}</p>
      </div>
    </Dialog>
  );
}

/** The cost line of "Use a document already added": known before the pick, since the pages are stored. */
export function costWords(chosen: string, e: { estimateUsd: number; calls: number; pages: number; aboveCeiling: boolean; existingPlanId: string | null } | undefined, failed = false): string {
  if (!chosen) return 'Claude reads it into the plan. The cost shows here once you choose.';
  if (failed) return 'The cost could not be worked out.';
  if (!e) return 'Working out the cost…';
  if (e.existingPlanId) return 'This document is already a plan: it opens, nothing is read again.';
  const size = `${e.calls} call${e.calls === 1 ? '' : 's'} to Claude, ${e.pages} page${e.pages === 1 ? '' : 's'}`;
  return e.aboveCeiling ? `About ${usd(e.estimateUsd)} (${size}): more than your limit per document, so the page asks once more before reading.` : `Claude reads it into the plan: about ${usd(e.estimateUsd)} (${size}).`;
}
