import { useEffect, useMemo, useState } from 'react';
import { dateSortKey, parsePartialDate, todayIso } from '@shared/dates';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { DataTable, type ColumnDef } from '../../ui/DataTable';
import { DateText } from '../../ui/DateText';
import { Loading } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import type { PersonRow } from '../../api/people';
import { isCurrent, notMedicationLabel, type AcceptInput, type EventInput, type Intolerance, type IntoleranceInput, type MedicationDetail, type MedicationInput, type MedicationProposal, type MedicationRow } from '../../api/medications';
import { EVENT_OPTIONS, INTOLERANCE_KIND_OPTIONS, MED_STATUS_OPTIONS, SEVERITY_OPTIONS, medStatusWords } from './words';

// ---------------------------------------------------------------------------
// Medication form (new / edit)
// ---------------------------------------------------------------------------

export interface MedicationFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this medication; otherwise it creates one. */
  med?: MedicationDetail | null;
  people: PersonRow[];
  busy: boolean;
  error?: string | null;
  onSubmit: (input: MedicationInput) => void;
}

const EMPTY_MED: MedicationInput = { name: '', genericName: '', drugClass: '', dose: '', unit: '', route: '', frequency: '', status: 'active', startDateText: '', stopDateText: '', prescriberId: '', indication: '', reasonStopped: '', effect: '', notes: '' };

/**
 * True when the stop date as written parses to a date strictly before today,
 * compared at its own precision ('2023' is past; this month or a future end
 * date is not, so a course with a planned end stays current).
 */
function stopHasPassed(stopText: string): boolean {
  const iso = parsePartialDate(stopText).iso;
  if (!iso) return false;
  return iso < todayIso().slice(0, iso.length);
}

/**
 * The status the form will save. Typing a stop date that has passed into a
 * current course (active, prn, planned) makes it stopped unless the user has
 * picked a status themselves; otherwise the course would stay on the Current
 * view and the emergency card. Only a stop date that differs from the one the
 * dialog opened with counts, so editing other fields never flips a status.
 */
function formStatus(f: MedicationInput, statusTouched: boolean, initialStop: string): { status: string; auto: boolean } {
  const status = f.status ?? 'unknown';
  const stop = (f.stopDateText ?? '').trim();
  const auto = !statusTouched && stop !== '' && stop !== initialStop.trim() && isCurrent(status) && stopHasPassed(stop);
  return auto ? { status: 'stopped', auto } : { status, auto };
}

function medToForm(m: MedicationDetail): MedicationInput {
  return {
    name: m.name,
    genericName: m.genericName ?? '',
    drugClass: m.drugClass ?? '',
    dose: m.dose ?? '',
    unit: m.unit ?? '',
    route: m.route ?? '',
    frequency: m.frequency ?? '',
    status: m.status,
    startDateText: m.startDateText ?? m.startDate ?? '',
    stopDateText: m.stopDateText ?? m.stopDate ?? '',
    prescriberId: m.prescriberId ?? '',
    indication: m.indication ?? '',
    reasonStopped: m.reasonStopped ?? '',
    effect: m.effect ?? '',
    notes: m.notes ?? '',
  };
}

export function MedicationFormDialog({ open, onClose, med, people, busy, error, onSubmit }: MedicationFormDialogProps) {
  const editing = Boolean(med);
  const [f, setF] = useState<MedicationInput>(EMPTY_MED);
  const [statusTouched, setStatusTouched] = useState(false);
  const [initialStop, setInitialStop] = useState('');
  useEffect(() => {
    if (!open) return;
    const start = med ? medToForm(med) : EMPTY_MED;
    setF(start);
    setStatusTouched(false);
    setInitialStop(start.stopDateText ?? '');
  }, [open, med]);
  const set = (k: keyof MedicationInput, v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const canSubmit = Boolean(f.name.trim()) && !busy;
  const peopleOptions = useMemo(() => people.map((p) => ({ value: p.id, label: `${p.name}${p.role ? ` · ${p.role}` : p.kind !== 'clinician' ? ` · ${p.kind.replace(/_/g, ' ')}` : ''}` })), [people]);
  const shown = formStatus(f, statusTouched, initialStop);

  function submit() {
    if (!canSubmit) return;
    onSubmit({ ...f, name: f.name.trim(), status: shown.status, prescriberId: f.prescriberId || null });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit medication' : 'Add a medication'}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {editing ? 'Save' : 'Add medication'} <Kbd>ctrl+enter</Kbd>
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
        <div className="med-form-grid">
          <Field label="Name *">
            <Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="As prescribed, e.g. Lisinopril" />
          </Field>
          <Field label="Generic name">
            <Input value={f.genericName ?? ''} onChange={(e) => set('genericName', e.target.value)} />
          </Field>
          <Field label="Kind of drug">
            <Input value={f.drugClass ?? ''} onChange={(e) => set('drugClass', e.target.value)} placeholder="e.g. ACE inhibitor" />
          </Field>
          <Field label="Status" hint={shown.auto ? 'Stopped, because the stop date has passed. Pick another status if the course continues.' : undefined}>
            <Select
              value={shown.status}
              options={MED_STATUS_OPTIONS}
              onChange={(e) => {
                setStatusTouched(true);
                set('status', e.target.value);
              }}
            />
          </Field>
          <Field label="Dose">
            <Input value={f.dose ?? ''} onChange={(e) => set('dose', e.target.value)} placeholder="e.g. 100" />
          </Field>
          <Field label="Unit">
            <Input value={f.unit ?? ''} onChange={(e) => set('unit', e.target.value)} placeholder="e.g. mg" />
          </Field>
          <Field label="How taken">
            <Input value={f.route ?? ''} onChange={(e) => set('route', e.target.value)} placeholder="e.g. by mouth, IV, injection" />
          </Field>
          <Field label="How often">
            <Input value={f.frequency ?? ''} onChange={(e) => set('frequency', e.target.value)} placeholder="e.g. twice a day" />
          </Field>
          <Field label="Started, as written" hint="e.g. 2024-03-11, March 2024 or 2023. A start event is added when there is none.">
            <Input value={f.startDateText ?? ''} onChange={(e) => set('startDateText', e.target.value)} />
          </Field>
          <Field label="Stopped, as written" hint="Leave empty while you still take it. A stop date that has passed marks it stopped.">
            <Input value={f.stopDateText ?? ''} onChange={(e) => set('stopDateText', e.target.value)} />
          </Field>
          <Field label="Prescribed by">
            <Select value={f.prescriberId ?? ''} options={peopleOptions} placeholder="Not known" onChange={(e) => set('prescriberId', e.target.value)} />
          </Field>
          <Field label="What it is for">
            <Input value={f.indication ?? ''} onChange={(e) => set('indication', e.target.value)} />
          </Field>
          <Field label="What it did" hint="In your words: helped, no change, side effects.">
            <Input value={f.effect ?? ''} onChange={(e) => set('effect', e.target.value)} />
          </Field>
          <Field label="Why it stopped">
            <Input value={f.reasonStopped ?? ''} onChange={(e) => set('reasonStopped', e.target.value)} />
          </Field>
          <div className="full">
            <Field label="Notes">
              <Textarea rows={3} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Intolerance form (new / edit)
// ---------------------------------------------------------------------------

export interface IntoleranceFormDialogProps {
  open: boolean;
  onClose: () => void;
  item?: Intolerance | null;
  busy: boolean;
  error?: string | null;
  onSubmit: (input: IntoleranceInput) => void;
}

const EMPTY_INTOL: IntoleranceInput = { substance: '', kind: 'intolerance', reaction: '', severity: 'unknown', hardStop: false, dateText: '', notes: '', active: true };

export function IntoleranceFormDialog({ open, onClose, item, busy, error, onSubmit }: IntoleranceFormDialogProps) {
  const editing = Boolean(item);
  const [f, setF] = useState<IntoleranceInput>(EMPTY_INTOL);
  useEffect(() => {
    if (!open) return;
    setF(item ? { substance: item.substance, kind: item.kind, reaction: item.reaction ?? '', severity: item.severity, hardStop: item.hardStop, dateText: item.dateText ?? item.date ?? '', notes: item.notes ?? '', active: item.active } : EMPTY_INTOL);
  }, [open, item]);
  const canSubmit = Boolean(f.substance.trim()) && !busy;
  const hardStop = f.kind === 'hard_stop' ? true : Boolean(f.hardStop);

  function submit() {
    if (!canSubmit) return;
    onSubmit({ ...f, substance: f.substance.trim(), hardStop });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit allergy or intolerance' : 'Add an allergy or intolerance'}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {editing ? 'Save' : 'Add allergy'} <Kbd>ctrl+enter</Kbd>
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
        <div className="med-form-grid">
          <Field label="Substance *">
            <Input autoFocus value={f.substance} onChange={(e) => setF({ ...f, substance: e.target.value })} placeholder="e.g. a drug, drug class, food or material" />
          </Field>
          <Field label="Kind" hint="Never give always marks it as never to be given.">
            <Select value={f.kind ?? 'intolerance'} options={INTOLERANCE_KIND_OPTIONS} onChange={(e) => setF({ ...f, kind: e.target.value })} />
          </Field>
          <Field label="How severe">
            <Select value={f.severity ?? 'unknown'} options={SEVERITY_OPTIONS} onChange={(e) => setF({ ...f, severity: e.target.value })} />
          </Field>
          <Field label="When it happened, as written">
            <Input value={f.dateText ?? ''} onChange={(e) => setF({ ...f, dateText: e.target.value })} placeholder="e.g. 2019 or March 2021" />
          </Field>
          <div className="full">
            <Field label="What happens">
              <Input value={f.reaction ?? ''} onChange={(e) => setF({ ...f, reaction: e.target.value })} placeholder="e.g. anaphylaxis, hives" />
            </Field>
          </div>
          <Field label="Never give" hint="Shown on every medications screen, the Home page and the emergency card.">
            <label className="med-check">
              <input type="checkbox" checked={hardStop} disabled={f.kind === 'hard_stop'} onChange={(e) => setF({ ...f, hardStop: e.target.checked })} />
              Must never be given
            </label>
          </Field>
          {editing ? (
            <Field label="Still applies">
              <label className="med-check">
                <input type="checkbox" checked={Boolean(f.active)} onChange={(e) => setF({ ...f, active: e.target.checked })} />
                Yes, it still applies
              </label>
            </Field>
          ) : null}
          <div className="full">
            <Field label="Notes">
              <Textarea rows={3} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Proposals from facts
// ---------------------------------------------------------------------------

export interface ProposalsDialogProps {
  open: boolean;
  onClose: () => void;
  items: MedicationProposal[];
  loading: boolean;
  medications: MedicationRow[];
  busy: boolean;
  onAccept: (input: AcceptInput) => void;
  onOpenFact: (p: MedicationProposal) => void;
}

/** The name a medication proposal would be added under. */
function proposedName(p: MedicationProposal | null): string {
  const n = p?.proposed?.name;
  return typeof n === 'string' ? n : '';
}

export function ProposalsDialog({ open, onClose, items, loading, medications, busy, onAccept, onOpenFact }: ProposalsDialogProps) {
  // Nothing is selected when the dialog opens, so a row whose name is not one drug is never picked for the user.
  const [sel, setSel] = useState<string | null>(null);
  const [attachTo, setAttachTo] = useState<string>('');
  const [eventKind, setEventKind] = useState<string>('');
  const [name, setName] = useState<string>('');
  const selected = items.find((p) => p.factId === sel) ?? null;
  const selectedLabel = selected ? notMedicationLabel(selected) : null;
  // A row whose name is a list heading or two drugs in one line is added under a name the user can edit.
  const editsName = Boolean(selected && selectedLabel && selected.kind === 'medication' && !attachTo);

  useEffect(() => {
    if (open) {
      setSel(null);
      setAttachTo('');
      setEventKind('');
      setName('');
    }
  }, [open]);
  // Default the attach target to the matching medication, if any, and the name to the one proposed.
  useEffect(() => {
    setAttachTo(selected?.kind === 'medication' && selected.existing ? selected.existing.id : '');
    setEventKind('');
    setName(proposedName(selected));
  }, [selected?.factId, selected?.kind, selected?.existing]);

  const columns = useMemo<ColumnDef<MedicationProposal, unknown>[]>(
    () => [
      { id: 'date', header: 'Date', accessorFn: (p) => (p.date ? dateSortKey(p.date) : undefined), sortUndefined: 'last', cell: ({ row }) => <DateText iso={row.original.date} precision={row.original.datePrecision} text={row.original.dateText} />, meta: { width: 96 } },
      { id: 'kind', header: 'Kind', accessorKey: 'kind', cell: ({ getValue }) => <Tag tone={getValue() === 'intolerance' ? 'warn' : 'info'}>{getValue() === 'intolerance' ? 'allergy' : 'medication'}</Tag>, meta: { width: 96 } },
      {
        id: 'statement',
        header: 'What the document says',
        accessorKey: 'statement',
        cell: ({ row, getValue }) => {
          const label = notMedicationLabel(row.original);
          return (
            <>
              <span className="med-clamp" title={String(getValue())}>
                {String(getValue())}
              </span>
              {label ? <span className="med-not-med">{label}</span> : null}
            </>
          );
        },
        meta: { className: 'wrap', grow: true, minWidth: 240 },
      },
      { id: 'document', header: 'Document', accessorFn: (p) => p.documentTitle ?? '', cell: ({ row }) => <span className="muted">{row.original.documentTitle ?? 'No document'}{row.original.citation ? ` · p.${row.original.citation.pageNumber}` : ''}</span>, meta: { width: 150, maxWidth: 200 } },
      { id: 'existing', header: 'Already listed as', accessorFn: (p) => p.existing?.name ?? '', cell: ({ row }) => (row.original.existing ? <Tag tone="warn">{row.original.existing.name}</Tag> : null), meta: { width: 120, maxWidth: 160 } },
    ],
    [],
  );

  function acceptSelected(p: MedicationProposal | null = selected) {
    if (!p || busy) return;
    if (p.kind === 'medication' && attachTo) onAccept({ factId: p.factId, medicationId: attachTo, eventKind: eventKind || undefined });
    else if (p.kind === 'medication' && notMedicationLabel(p)) {
      // Added under the name as edited (the name field shows when the row is selected).
      if (p.factId !== selected?.factId) {
        setSel(p.factId);
        return;
      }
      const edited = name.trim();
      if (!edited) return;
      onAccept(edited !== proposedName(p).trim() ? { factId: p.factId, overrides: { name: edited } } : { factId: p.factId });
    } else onAccept({ factId: p.factId });
  }

  /** Enter or a on a row: accept it, except a row whose name is not one drug, which goes to its name field first. */
  function keyAccept(p: MedicationProposal) {
    if (p.kind === 'medication' && notMedicationLabel(p) && !(p.factId === selected?.factId && attachTo)) {
      setSel(p.factId);
      window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-proposal-name]')?.focus(), 0);
      return;
    }
    acceptSelected(p);
  }

  const medOptions = useMemo(() => medications.map((m) => ({ value: m.id, label: `${m.name}${m.status ? ` (${medStatusWords(m.status)})` : ''}` })), [medications]);

  if (!open) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Find medications and allergies in your documents"
      width={860}
      footer={
        <div className="med-proposal-foot grow">
          <span className="faint xs grow">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>enter</Kbd> or <Kbd>a</Kbd> add · <Kbd>o</Kbd> open the page · <Kbd>esc</Kbd> close
          </span>
          {selected?.kind === 'medication' ? (
            <>
              <Select aria-label="Add to a medication already listed" value={attachTo} options={medOptions} placeholder="As a new medication" onChange={(e) => setAttachTo(e.target.value)} />
              {attachTo ? <Select aria-label="What happened" value={eventKind} options={EVENT_OPTIONS} placeholder="What happened: work it out" onChange={(e) => setEventKind(e.target.value)} /> : null}
              {editsName ? (
                <Input
                  data-proposal-name
                  aria-label="Name to add"
                  title="Edit the name to the one medication to add"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      acceptSelected();
                    }
                  }}
                />
              ) : null}
            </>
          ) : null}
          <Button variant="primary" disabled={!selected || busy || (editsName && !name.trim())} onClick={() => acceptSelected()}>
            {selected?.kind === 'medication' && attachTo ? 'Add as an event' : selected?.kind === 'intolerance' ? 'Add as an allergy' : 'Add as a new medication'}
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="small muted">
          Medications and allergies Claude found in your documents that are not on your list yet. Details you marked incorrect or replaced are left out. Adding one keeps the page it came from as its source; nothing is merged without you.
        </div>
        <div className="med-proposals">
          {loading ? (
            <Loading>Reading your documents…</Loading>
          ) : (
            <DataTable
              columns={columns}
              data={items}
              rowId={(p) => p.factId}
              selectedId={sel}
              onSelect={(p) => setSel(p?.factId ?? null)}
              onOpen={(p) => keyAccept(p)}
              initialSort={[{ id: 'date', desc: true }]}
              emptyText="Nothing to add. Every medication and allergy found in the documents is already listed, disputed, or replaced."
              autoFocus
              onKey={(e, row) => {
                if (e.key === 'o' && row) {
                  onOpenFact(row);
                  return true;
                }
                if (e.key === 'a' && row) {
                  keyAccept(row);
                  return true;
                }
                return false;
              }}
            />
          )}
        </div>
        {selected ? (
          <div className="med-fact small">
            <div className="statement">{selected.statement}</div>
            {selectedLabel ? <div className="med-not-med">{selectedLabel}</div> : null}
            <div className="row wrap small muted">
              {selected.citation ? <span className="mono">“{selected.citation.quote}”</span> : <span>No page quoted</span>}
              {selected.prescriberText ? <span>Prescribed by, as written: {selected.prescriberText} (not in People and places)</span> : null}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add an event (start, stop, dose change, pause, restart, reaction, note)
// ---------------------------------------------------------------------------

export interface AddEventDialogProps {
  open: boolean;
  onClose: () => void;
  /** The medication's name, for the title. */
  name: string;
  busy: boolean;
  error?: string | null;
  onSubmit: (input: EventInput) => void;
}

/** What each kind of event does to the course, said once in the dialog. */
const EVENT_EFFECT: Record<string, string> = {
  start: 'Starts the course when it was planned or not known; a start after a stop starts it again (the earlier course stays in the list).',
  stop: 'Marks the course stopped on this date.',
  dose_change: 'Changes the dose shown for this medication.',
  hold: 'A pause; the course stays as it is.',
  resume: 'Taking it again after a pause; one dated after a stop starts the course again.',
  reaction: 'Something it caused. If it must never be given again, add it under Allergies and never give too.',
  note: 'A note on the course; nothing else changes.',
};

export function AddEventDialog({ open, onClose, name, busy, error, onSubmit }: AddEventDialogProps) {
  const [kind, setKind] = useState<string>('note');
  const [dateText, setDateText] = useState('');
  const [dose, setDose] = useState('');
  const [detail, setDetail] = useState('');
  useEffect(() => {
    if (!open) return;
    setKind('note');
    setDateText('');
    setDose('');
    setDetail('');
  }, [open]);
  const canSubmit = !busy && Boolean(dateText.trim() || detail.trim() || dose.trim() || kind !== 'note');
  function submit() {
    if (!canSubmit) return;
    onSubmit({ kind, dateText: dateText.trim() || null, dose: dose.trim() || null, detail: detail.trim() || null });
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add an event to ${name}`}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            Add event <Kbd>ctrl+enter</Kbd>
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
        <div className="med-form-grid">
          <Field label="What happened" hint={EVENT_EFFECT[kind]}>
            <Select autoFocus value={kind} options={EVENT_OPTIONS} onChange={(e) => setKind(e.target.value)} />
          </Field>
          <Field label="When, as written" hint="e.g. 2024-03-11, March 2024 or 2023">
            <Input data-event-date value={dateText} placeholder="e.g. 2024-03-11" onChange={(e) => setDateText(e.target.value)} />
          </Field>
          <Field label="Dose" hint={kind === 'dose_change' ? 'The new dose' : undefined}>
            <Input value={dose} placeholder="e.g. 20 mg" onChange={(e) => setDose(e.target.value)} />
          </Field>
          <div className="full">
            <Field label="Details">
              <Input value={detail} placeholder="e.g. stopped because of nausea" onChange={(e) => setDetail(e.target.value)} />
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
