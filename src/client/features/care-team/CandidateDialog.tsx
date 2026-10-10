/**
 * Add or edit a candidate. A new one is linked to People and places: when a row with the same name is there, the
 * dialog asks whether it is the same person (a yes links it; otherwise a new row is made). The facts typed may carry
 * one source; a fact changed later reads "not backed yet" until it gets one.
 */
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import {
  ACCESS_TYPES,
  ACCESS_TYPE_WORDS,
  CARE_ROLES,
  CARE_ROLE_WORDS,
  CARE_ROLE_HINTS,
  CARE_STEPS,
  HOME_STATE_LICENSE,
  HOME_STATE_LICENSE_WORDS,
  readCareRole,
  readPartialDateValue,
  stepWords,
  type AccessType,
  type CareRole,
  type CareStep,
  type HomeStateLicense,
} from '@shared/care-team';
import { formatPartialDate } from '@shared/dates';
import { usePersonMatches, type Candidate, type CandidateInput } from '../../api/care-team';
import { EMPTY_SOURCE, SourceFields, sourceFrom, type SourceState } from './SourceFields';

interface FormState {
  name: string;
  practice: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  licensedStates: string;
  role: string;
  notes: string;
  // Request 6
  step: string;
  accessType: AccessType;
  quotedCost: string;
  licensedInHomeState: HomeStateLicense;
  earliestVisit: string;
}

const EMPTY: FormState = { name: '', practice: '', city: '', state: '', phone: '', website: '', licensedStates: '', role: '', notes: '', step: '', accessType: 'unknown', quotedCost: '', licensedInHomeState: 'unknown', earliestVisit: '' };

/** How "Earliest visit" reads under its box. */
function visitHint(text: string): string | undefined {
  const d = readPartialDateValue(text);
  if (!d) return 'A day, a month or a year: 2027-02-15, Feb 2027.';
  if (!d.value) return 'Could not read this. Type it as 2027-02-15 or Feb 2027.';
  return d.text === d.value ? undefined : `Reads as ${formatPartialDate(d.value, d.precision)}.`;
}

function fromCandidate(c: Candidate): FormState {
  return {
    name: c.name,
    practice: c.practice ?? '',
    city: c.city ?? '',
    state: c.state ?? '',
    phone: c.phone ?? '',
    website: c.website ?? '',
    licensedStates: c.licensedStates.join(', '),
    role: readCareRole(c.role) ?? '',
    notes: c.notes ?? '',
    step: c.step ? String(c.step) : '',
    accessType: c.accessType ?? 'unknown',
    quotedCost: c.quotedCost ?? '',
    licensedInHomeState: c.licensedInHomeState ?? 'unknown',
    earliestVisit: c.earliestVisit?.text ?? c.earliestVisit?.value ?? '',
  };
}

const nz = (s: string) => (s.trim() ? s.trim() : null);

export function CandidateDialog({
  open,
  onClose,
  candidate,
  busy,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** Editing this one; otherwise a new one. */
  candidate?: Candidate | null;
  busy: boolean;
  error: string | null;
  onSave: (input: CandidateInput) => void;
}) {
  const editing = Boolean(candidate);
  const [f, setF] = useState<FormState>(EMPTY);
  const [src, setSrc] = useState<SourceState>(EMPTY_SOURCE);
  const [linkTo, setLinkTo] = useState<string>('');
  const [local, setLocal] = useState<string | null>(null);
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seeded.current = null;
      return;
    }
    const key = candidate ? `c:${candidate.id}` : 'new';
    if (seeded.current === key) return;
    seeded.current = key;
    setF(candidate ? fromCandidate(candidate) : EMPTY);
    setSrc(EMPTY_SOURCE);
    setLinkTo('');
    setLocal(null);
  }, [open, candidate]);

  const matches = usePersonMatches(f.name, open && !editing);
  const found = matches.data?.items ?? [];
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  function submit() {
    if (!f.name.trim() || busy) return;
    const { source, problem } = sourceFrom(src);
    if (problem) {
      setLocal(problem);
      return;
    }
    if (f.earliestVisit.trim() && !readPartialDateValue(f.earliestVisit)?.value) {
      setLocal('Earliest visit: type it as 2027-02-15 or Feb 2027.');
      return;
    }
    setLocal(null);
    const input: CandidateInput = {
      name: f.name.trim(),
      practice: nz(f.practice),
      city: nz(f.city),
      state: nz(f.state),
      phone: nz(f.phone),
      website: nz(f.website),
      licensedStates: f.licensedStates,
      role: (f.role || null) as CareRole | null,
      notes: nz(f.notes),
      step: f.step ? (Number(f.step) as CareStep) : null,
      accessType: f.accessType,
      quotedCost: nz(f.quotedCost),
      licensedInHomeState: f.licensedInHomeState,
      earliestVisit: nz(f.earliestVisit),
      source,
    };
    if (!editing && linkTo && linkTo !== 'new') input.personId = linkTo;
    onSave(input);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit candidate' : 'Add a candidate'}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.name.trim() || busy || (!editing && found.length > 0 && !linkTo)} onClick={submit}>
            {editing ? 'Save' : 'Add'} <Kbd>ctrl+enter</Kbd>
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
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        <div className="ct-form">
          <div className="full">
            <Field label="Name" hint="A person, a clinic or a service.">
              <Input autoFocus data-autofocus="" value={f.name} onChange={set('name')} placeholder="e.g. Dr. Jane Example" />
            </Field>
          </div>
          {!editing && found.length ? (
            <div className="full">
              <Field label="Already in People and places?" hint="A yes links this candidate to that entry; calls and to-dos then show here.">
                <Select
                  aria-label="Already in People and places?"
                  value={linkTo}
                  placeholder="Choose one"
                  options={[...found.map((p) => ({ value: p.id, label: `Yes, the same as ${p.name}${p.role ? ` (${p.role})` : ''}` })), { value: 'new', label: 'No, someone new' }]}
                  onChange={(e) => setLinkTo(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <Field label="Step" hint="The order you are working in.">
            <Select aria-label="Step" value={f.step} placeholder="No step yet" options={CARE_STEPS.map((n) => ({ value: String(n), label: stepWords(n) }))} onChange={set('step')} />
          </Field>
          <Field label="Role">
            <Select aria-label="Role" value={f.role} placeholder="No role yet" options={CARE_ROLES.map((r) => ({ value: r, label: CARE_ROLE_WORDS[r] }))} onChange={set('role')} />
          </Field>
          <Field label="Practice">
            <Input value={f.practice} onChange={set('practice')} placeholder="e.g. Example Neurology" />
          </Field>
          <Field label="City">
            <Input value={f.city} onChange={set('city')} />
          </Field>
          <Field label="State">
            <Input value={f.state} onChange={set('state')} placeholder="e.g. OH" />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="Website">
            <Input value={f.website} onChange={set('website')} placeholder="e.g. example.org" />
          </Field>
          <Field label="Licensed in" hint="States, with commas: OH, Indiana">
            <Input value={f.licensedStates} onChange={set('licensedStates')} />
          </Field>
          <Field label="Licensed in home state" hint="The flare test's home-state license item.">
            <Select aria-label="Licensed in home state" value={f.licensedInHomeState} options={HOME_STATE_LICENSE.map((k) => ({ value: k, label: HOME_STATE_LICENSE_WORDS[k] }))} onChange={set('licensedInHomeState')} />
          </Field>
          <Field label="Access type">
            <Select aria-label="Access type" value={f.accessType} options={ACCESS_TYPES.map((k) => ({ value: k, label: ACCESS_TYPE_WORDS[k] }))} onChange={set('accessType')} />
          </Field>
          <Field label="Quoted cost" hint="As they said it, e.g. $2,400 a year">
            <Input value={f.quotedCost} onChange={set('quotedCost')} />
          </Field>
          <Field label="Earliest visit" hint={visitHint(f.earliestVisit)}>
            <Input value={f.earliestVisit} onChange={set('earliestVisit')} placeholder="e.g. 2027-02-15" />
          </Field>
          <div className="full">
            <Field label="Notes">
              <Textarea value={f.notes} onChange={set('notes')} rows={3} />
            </Field>
          </div>
        </div>
        {f.role ? <p className="muted small">{CARE_ROLE_HINTS[f.role as CareRole]}</p> : null}
        <SourceFields value={src} onChange={setSrc} label={editing ? 'Source for what you changed' : 'Source for these facts'} />
      </div>
    </Dialog>
  );
}
