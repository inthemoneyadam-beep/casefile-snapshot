import { useEffect, useState, type FormEvent } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { ApiError } from '../../api/client';
import { usePeople, usePeopleMutations, type PersonInput, type PersonRow } from '../../api/people';
import { COMM_CHANNELS, PERSON_KINDS } from '@shared/enums';
import { CHANNEL_WORDS, PERSON_KIND_WORDS, nz, splitCsv } from './shared';

const KIND_OPTIONS = PERSON_KINDS.map((k) => ({ value: k, label: PERSON_KIND_WORDS[k] ?? k }));
const CHANNEL_OPTIONS = COMM_CHANNELS.map((c) => ({ value: c, label: CHANNEL_WORDS[c] ?? c }));

interface FormState {
  name: string;
  kind: string;
  role: string;
  specialty: string;
  institutionId: string;
  phone: string;
  fax: string;
  email: string;
  portal: string;
  address: string;
  preferredChannel: string;
  aliases: string;
  notes: string;
}

const EMPTY: FormState = { name: '', kind: 'clinician', role: '', specialty: '', institutionId: '', phone: '', fax: '', email: '', portal: '', address: '', preferredChannel: '', aliases: '', notes: '' };

function fromRow(p: PersonRow): FormState {
  return {
    name: p.name,
    kind: p.kind,
    role: p.role ?? '',
    specialty: p.specialty ?? '',
    institutionId: p.institutionId ?? '',
    phone: p.phone ?? '',
    fax: p.fax ?? '',
    email: p.email ?? '',
    portal: p.portal ?? '',
    address: p.address ?? '',
    preferredChannel: p.preferredChannel ?? '',
    aliases: p.aliases.join(', '),
    notes: p.notes ?? '',
  };
}

function toInput(f: FormState): PersonInput {
  return {
    name: f.name.trim(),
    kind: f.kind,
    role: nz(f.role),
    specialty: nz(f.specialty),
    institutionId: nz(f.institutionId),
    phone: nz(f.phone),
    fax: nz(f.fax),
    email: nz(f.email),
    portal: nz(f.portal),
    address: nz(f.address),
    preferredChannel: nz(f.preferredChannel),
    notes: nz(f.notes),
    aliases: splitCsv(f.aliases),
  };
}

/** Create or edit a person. Enter in any single-line field saves; Esc cancels. */
export function PersonDialog({ open, onClose, initial, onSaved, presetName }: { open: boolean; onClose: () => void; initial?: PersonRow | null; onSaved?: (p: PersonRow) => void; presetName?: string }) {
  const toast = useToast();
  const { create, update } = usePeopleMutations();
  const people = usePeople({});
  const [f, setF] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(initial ? fromRow(initial) : { ...EMPTY, name: presetName ?? '' });
  }, [open, initial, presetName]);

  const institutions = (people.data?.items ?? []).filter((p) => (p.kind === 'institution' || p.kind === 'clinic') && p.id !== initial?.id).map((p) => ({ value: p.id, label: p.name }));
  const busy = create.isPending || update.isPending;
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!f.name.trim()) {
      setError('Write a name.');
      return;
    }
    setError(null);
    try {
      const input = toInput(f);
      const saved = initial ? await update.mutateAsync({ id: initial.id, patch: input }) : await create.mutateAsync(input);
      toast(initial ? 'Person updated.' : 'Person added.', 'ok');
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? `Edit ${initial.name}` : 'Add a person or place'}
      width={640}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy} shortcut="ctrl+enter">
            {busy ? 'Saving…' : initial ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form
        className="form dense"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <Field label="Name" inline>
          <Input autoFocus value={f.name} onChange={set('name')} placeholder="e.g. Dr Jane Doe, or Mercy General" />
        </Field>
        <Field label="Type" inline>
          <Select options={KIND_OPTIONS} value={f.kind} onChange={set('kind')} aria-label="Type" />
        </Field>
        <Field label="Role" inline>
          <Input value={f.role} onChange={set('role')} placeholder="e.g. attending, nurse coordinator, records clerk" />
        </Field>
        <Field label="Specialty" inline>
          <Input value={f.specialty} onChange={set('specialty')} placeholder="e.g. rheumatology" />
        </Field>
        <Field label="Works at" inline hint={institutions.length ? undefined : 'Add the hospital or clinic first (as a place) to link people to it.'}>
          <Select options={institutions} placeholder="None" value={f.institutionId} onChange={set('institutionId')} aria-label="Works at" />
        </Field>
        <Field label="Phone" inline>
          <Input value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label="Fax" inline>
          <Input value={f.fax} onChange={set('fax')} />
        </Field>
        <Field label="Email" inline>
          <Input value={f.email} onChange={set('email')} />
        </Field>
        <Field label="Portal" inline>
          <Input value={f.portal} onChange={set('portal')} placeholder="e.g. MyChart, or the portal's address" />
        </Field>
        <Field label="Address" inline>
          <Input value={f.address} onChange={set('address')} />
        </Field>
        <Field label="Best reached by" inline>
          <Select options={CHANNEL_OPTIONS} placeholder="No preference" value={f.preferredChannel} onChange={set('preferredChannel')} aria-label="Best reached by" />
        </Field>
        <Field label="Also written as" inline hint="Other spellings the documents use, separated with commas. Names found in your documents skip these.">
          <Input value={f.aliases} onChange={set('aliases')} placeholder="e.g. J. Doe, Doe J" />
        </Field>
        <Field label="Notes" inline>
          <Textarea value={f.notes} onChange={set('notes')} rows={3} />
        </Field>
        {error ? <div className="error full small">{error}</div> : null}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Save
        </button>
      </form>
    </Dialog>
  );
}
