import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { ENCOUNTER_KINDS, ENCOUNTER_STATUSES } from '@shared/enums';
import { usePeople } from '../../api/people';
import { useDocumentsLite } from '../../api/records';
import type { EncounterDetail, EncounterInput, EncounterQuestion } from '../../api/encounters';
import { nz } from '../../app/text';
import { ENCOUNTER_KIND_WORDS, ENCOUNTER_STATUS_WORDS, type EncounterPreset } from './words';

const KIND_OPTIONS = ENCOUNTER_KINDS.map((k) => ({ value: k, label: ENCOUNTER_KIND_WORDS[k] ?? k }));
const STATUS_OPTIONS = ENCOUNTER_STATUSES.map((st) => ({ value: st, label: (ENCOUNTER_STATUS_WORDS[st] ?? st).replace(/^./, (c) => c.toUpperCase()) }));

interface FormState {
  title: string;
  kind: string;
  status: string;
  occurredAtText: string;
  timeText: string;
  clinicianId: string;
  institutionId: string;
  location: string;
  prepNotes: string;
  questions: string;
  documentIds: string[];
}

const EMPTY: FormState = { title: '', kind: 'visit', status: 'upcoming', occurredAtText: '', timeText: '', clinicianId: '', institutionId: '', location: '', prepNotes: '', questions: '', documentIds: [] };

function fromEncounter(e: EncounterDetail): FormState {
  return {
    title: e.title,
    kind: e.kind,
    status: e.status,
    occurredAtText: e.occurredAtText ?? e.occurredAt ?? '',
    timeText: e.timeText ?? '',
    clinicianId: e.clinicianId ?? '',
    institutionId: e.institutionId ?? '',
    location: e.location ?? '',
    prepNotes: e.prepNotes ?? '',
    questions: e.questions.map((q) => q.text).join('\n'),
    // Seed from the live documents only: a deleted document cannot be shown, so it must not be sent back either.
    documentIds: e.documents.map((d) => d.id),
  };
}

/** Keep a stored person that is no longer among the options (deleted, or of another kind) visible instead of showing "none". */
function withStored(options: Array<{ value: string; label: string }>, id: string, all: Array<{ id: string; name: string }> | undefined): Array<{ value: string; label: string }> {
  if (!all || !id || options.some((o) => o.value === id)) return options;
  const p = all.find((x) => x.id === id);
  return [...options, { value: id, label: p ? p.name : 'removed person' }];
}

/** One question per line; existing asked/answer state is kept for lines that did not change. */
function mergeQuestions(text: string, existing: EncounterQuestion[]): EncounterQuestion[] {
  const by = new Map(existing.map((q) => [q.text, q]));
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((t) => by.get(t) ?? { text: t, asked: false, answer: null });
}

export interface EncounterDialogProps {
  open: boolean;
  onClose: () => void;
  encounter?: EncounterDetail | null;
  /** Fields a new appointment starts with, e.g. from a visit document (words.ts encounterPresetFromDocument). */
  preset?: Partial<EncounterPreset> | null;
  busy: boolean;
  error?: string | null;
  onCreate: (input: EncounterInput) => void;
  onUpdate: (id: string, patch: Partial<EncounterInput>) => void;
}

export function EncounterDialog({ open, onClose, encounter, preset, busy, error, onCreate, onUpdate }: EncounterDialogProps) {
  const editing = Boolean(encounter);
  const [f, setF] = useState<FormState>(EMPTY);
  const people = usePeople();
  const documents = useDocumentsLite();

  // Seed once per opening (or when switching encounter), not on every refetch of the encounter while the dialog is open.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seededFor.current = null;
      return;
    }
    const key = encounter ? `enc:${encounter.id}` : `new:${preset?.documentIds?.join(',') ?? ''}`;
    if (seededFor.current === key) return;
    seededFor.current = key;
    setF(encounter ? fromEncounter(encounter) : { ...EMPTY, ...(preset ?? {}), documentIds: preset?.documentIds ?? [] });
  }, [open, encounter, preset]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const canSubmit = f.title.trim().length > 0 && !busy;

  const clinicians = useMemo(() => (people.data?.items ?? []).filter((p) => p.kind === 'clinician' || p.kind === 'other' || p.kind === 'advocate'), [people.data]);
  const institutions = useMemo(() => (people.data?.items ?? []).filter((p) => p.kind === 'institution' || p.kind === 'clinic'), [people.data]);
  const clinicianOptions = withStored(
    clinicians.map((p) => ({ value: p.id, label: p.specialty ? `${p.name} · ${p.specialty}` : p.name })),
    f.clinicianId,
    people.data?.items,
  );
  const institutionOptions = withStored(
    institutions.map((p) => ({ value: p.id, label: p.name })),
    f.institutionId,
    people.data?.items,
  );
  const docs = useMemo(() => [...(documents.data ?? [])].sort((a, b) => (b.documentDate ?? '').localeCompare(a.documentDate ?? '')), [documents.data]);

  function submit() {
    if (!canSubmit) return;
    const base: Partial<EncounterInput> = {
      title: f.title.trim(),
      kind: f.kind,
      occurredAtText: nz(f.occurredAtText),
      timeText: nz(f.timeText),
      clinicianId: nz(f.clinicianId),
      institutionId: nz(f.institutionId),
      location: nz(f.location),
      prepNotes: nz(f.prepNotes),
      questions: mergeQuestions(f.questions, encounter?.questions ?? []),
      documentIds: f.documentIds,
    };
    if (editing && encounter) onUpdate(encounter.id, { ...base, status: f.status });
    else onCreate({ ...(base as EncounterInput), status: f.status });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit appointment' : 'Add an appointment'}
      width={720}
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
        <div className="en-form">
          <div className="full">
            <Field label="Title">
              <Input autoFocus value={f.title} onChange={set('title')} placeholder="e.g. Rheumatology follow-up" />
            </Field>
          </div>
          <Field label="Type">
            <Select value={f.kind} options={KIND_OPTIONS} onChange={set('kind')} aria-label="Type" />
          </Field>
          <Field label="Status" hint={editing ? undefined : 'Done, for a visit that has already happened.'}>
            <Select value={f.status} options={STATUS_OPTIONS} onChange={set('status')} aria-label="Status" />
          </Field>
          <Field label="Date" hint="e.g. 2027-01-19, 1/19/2027, Jan 2027">
            <Input value={f.occurredAtText} onChange={set('occurredAtText')} placeholder="Not known yet" />
          </Field>
          <Field label="Time" hint="e.g. 10:30 or 2pm">
            <Input value={f.timeText} onChange={set('timeText')} placeholder="Not known yet" />
          </Field>
          <Field label="Clinician">
            <Select value={f.clinicianId} options={clinicianOptions} placeholder={people.isPending ? 'Loading…' : 'None'} onChange={set('clinicianId')} aria-label="Clinician" />
          </Field>
          <Field label="Hospital or clinic" hint={!f.institutionId && f.clinicianId ? 'Left empty, it is where the clinician works.' : undefined}>
            <Select value={f.institutionId} options={institutionOptions} placeholder="None" onChange={set('institutionId')} aria-label="Hospital or clinic" />
          </Field>
          <div className="full">
            <Field label="Where exactly">
              <Input value={f.location} onChange={set('location')} placeholder="e.g. building, room, or the video link" />
            </Field>
          </div>
          <div className="full">
            <Field label="Prep notes" hint="What to bring, what to raise, what changed.">
              <Textarea value={f.prepNotes} onChange={set('prepNotes')} rows={3} />
            </Field>
          </div>
          <div className="full">
            <Field label="Questions to ask" hint="One per line. Ticks and answers stay with the lines you do not change.">
              <Textarea value={f.questions} onChange={set('questions')} rows={4} />
            </Field>
          </div>
          <div className="full">
            <Field label="Documents from this visit" hint={docs.length ? `${f.documentIds.length} chosen` : 'No documents yet.'}>
              {docs.length ? (
                <div className="en-docs">
                  {docs.map((d) => {
                    const on = f.documentIds.includes(d.id);
                    return (
                      <label key={d.id}>
                        <input type="checkbox" checked={on} onChange={() => setF((s) => ({ ...s, documentIds: on ? s.documentIds.filter((x) => x !== d.id) : [...s.documentIds, d.id] }))} />
                        <span className="mono small muted">{d.documentDate ?? 'No date'}</span>
                        <span className="truncate">{d.title}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
