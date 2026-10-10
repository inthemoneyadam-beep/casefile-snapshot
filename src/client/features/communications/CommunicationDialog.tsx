import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { api, ApiError } from '../../api/client';
import { usePeople } from '../../api/people';
import { useCommunicationMutations, useTopics, type Communication, type CommunicationInput } from '../../api/communications';
import { COMM_CHANNELS, COMM_DIRECTIONS, PARTICIPANT_ROLES } from '@shared/enums';
import { parsePartialDate } from '@shared/dates';
import { CHANNEL_WORDS, DIRECTION_HINT, DIRECTION_WORDS, ROLE_WORDS, nz, personKindWords, splitCsv } from '../people/shared';
import { presetFromDocument, type CommPreset, type DocLike } from './fromDocuments';

interface Participant {
  personId: string;
  role: string;
}

interface FormState {
  occurredAtText: string;
  direction: string;
  channel: string;
  subject: string;
  summary: string;
  outcome: string;
  participants: Participant[];
  topics: string;
  followUpPromised: string;
  followUpDueText: string;
  followUpOwnerPersonId: string;
  documentId: string;
  encounterId: string;
}

/** The choices in words; the stored values stay the codes. */
const DIRECTION_OPTIONS = COMM_DIRECTIONS.map((d) => ({ value: d, label: `${DIRECTION_WORDS[d] ?? d} (${(DIRECTION_HINT[d] ?? '').toLowerCase()})` }));
const CHANNEL_OPTIONS = COMM_CHANNELS.map((c) => ({ value: c, label: CHANNEL_WORDS[c] ?? c }));
const ROLE_OPTIONS = PARTICIPANT_ROLES.map((r) => ({ value: r, label: ROLE_WORDS[r] ?? r }));

const EMPTY: FormState = {
  occurredAtText: '',
  direction: 'outbound',
  channel: 'portal',
  subject: '',
  summary: '',
  outcome: '',
  participants: [],
  topics: '',
  followUpPromised: '',
  followUpDueText: '',
  followUpOwnerPersonId: '',
  documentId: '',
  encounterId: '',
};

function fromRow(c: Communication): FormState {
  return {
    occurredAtText: c.occurredAtText ?? c.occurredAt ?? '',
    direction: c.direction,
    channel: c.channel,
    subject: c.subject,
    summary: c.summary ?? '',
    outcome: c.outcome ?? '',
    participants: c.participants.map((p) => ({ personId: p.personId, role: p.role })),
    topics: c.topics.join(', '),
    followUpPromised: c.followUpPromised ?? '',
    followUpDueText: c.followUpDue ?? '',
    followUpOwnerPersonId: c.followUpOwnerPersonId ?? '',
    documentId: c.documentId ?? '',
    encounterId: c.encounterId ?? '',
  };
}

/**
 * Due date and owner belong to the promise. With no promise they are sent as
 * null, so withdrawing a promise also clears them (the server applies the same
 * rule) instead of re-sending the values left in the disabled fields.
 */
function toInput(f: FormState): CommunicationInput {
  const promised = nz(f.followUpPromised);
  return {
    occurredAtText: nz(f.occurredAtText),
    direction: f.direction,
    channel: f.channel,
    subject: f.subject.trim(),
    summary: nz(f.summary),
    outcome: nz(f.outcome),
    participants: f.participants,
    topics: splitCsv(f.topics),
    followUpPromised: promised,
    followUpDueText: promised ? nz(f.followUpDueText) : null,
    followUpOwnerPersonId: promised ? nz(f.followUpOwnerPersonId) : null,
    documentId: nz(f.documentId),
    encounterId: nz(f.encounterId),
  };
}

interface PickerOption {
  value: string;
  label: string;
  doc?: DocLike;
}

/** Optional pickers from other slices; a failing endpoint just yields no options. */
function usePicker(path: string, key: string) {
  return useQuery({
    queryKey: [key, 'picker-for-communications'],
    queryFn: async (): Promise<PickerOption[]> => {
      try {
        const r = await api.get<{ items?: Array<{ id: string; title: string; category?: string; documentDate?: string | null }> }>(path);
        return (r.items ?? []).map((x) => ({ value: x.id, label: x.title, doc: { id: x.id, title: x.title, category: x.category ?? 'other', documentDate: x.documentDate ?? null } }));
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
  });
}

/**
 * Create or edit a call or message. Participants are picked from People with
 * their part in it; topics are separated with commas; the follow-up block
 * records what was promised, by when (a date as written), and who owes it.
 * A new one can start from a document (`preset`), and choosing the document
 * fills in the date and subject that are still blank.
 */
export function CommunicationDialog({
  open,
  onClose,
  initial,
  presetParticipants,
  preset,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Communication | null;
  presetParticipants?: Participant[];
  /** Fields a new one starts with, e.g. from a call or message document (fromDocuments.ts). */
  preset?: Partial<CommPreset> | null;
  onSaved?: (c: Communication) => void;
}) {
  const toast = useToast();
  const { create, update } = useCommunicationMutations();
  const people = usePeople({});
  const topics = useTopics();
  const docs = usePicker('/api/documents', 'documents');
  const encounters = usePicker('/api/encounters', 'encounters');
  const [f, setF] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(initial ? fromRow(initial) : { ...EMPTY, ...(preset ?? {}), participants: presetParticipants ?? [] });
    // presetParticipants is a fresh array per render; keyed on its ids instead (and a preset on its document).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial, (presetParticipants ?? []).map((p) => p.personId).join(','), preset?.documentId ?? '']);

  const everyone = people.data?.items ?? [];
  const nameOf = useMemo(() => new Map(everyone.map((p) => [p.id, p.name])), [everyone]);
  const available = everyone.filter((p) => !f.participants.some((x) => x.personId === p.id)).map((p) => ({ value: p.id, label: `${p.name}${p.kind !== 'clinician' ? ` (${personKindWords(p.kind).toLowerCase()})` : ''}` }));
  const ownerOptions = [
    ...f.participants.map((p) => ({ value: p.personId, label: nameOf.get(p.personId) ?? 'Removed person' })),
    ...everyone.filter((p) => !f.participants.some((x) => x.personId === p.id)).map((p) => ({ value: p.id, label: p.name })),
  ];
  const busy = create.isPending || update.isPending;
  const promised = Boolean(f.followUpPromised.trim());
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  /** Choosing the document a new one came from fills in what is still blank (date, subject; and how, while no subject was typed). */
  function setDocument(id: string) {
    setF((s) => {
      const next = { ...s, documentId: id };
      const doc = initial || !id ? undefined : docs.data?.find((d) => d.value === id)?.doc;
      if (!doc) return next;
      const p = presetFromDocument(doc);
      const typed = Boolean(s.subject.trim());
      return { ...next, occurredAtText: s.occurredAtText || p.occurredAtText, subject: typed ? s.subject : p.subject, channel: typed ? s.channel : p.channel, direction: typed ? s.direction : p.direction };
    });
  }

  function addParticipant(personId: string) {
    if (!personId) return;
    setF((s) => ({ ...s, participants: [...s.participants, { personId, role: s.direction === 'inbound' ? 'from' : 'to' }] }));
  }
  function setRole(personId: string, role: string) {
    setF((s) => ({ ...s, participants: s.participants.map((p) => (p.personId === personId ? { ...p, role } : p)) }));
  }
  function removeParticipant(personId: string) {
    setF((s) => ({ ...s, participants: s.participants.filter((p) => p.personId !== personId), followUpOwnerPersonId: s.followUpOwnerPersonId === personId ? '' : s.followUpOwnerPersonId }));
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!f.subject.trim()) {
      setError('Write what it was about (the subject).');
      return;
    }
    // Without a promise the due date is not sent (see toInput), so only check it while one exists.
    if (f.followUpPromised.trim() && f.followUpDueText.trim() && !parsePartialDate(f.followUpDueText).iso) {
      setError('Could not read the due date. Write it as a date, e.g. 2025-03-18, 3/18/2025 or March 2025.');
      return;
    }
    setError(null);
    try {
      const input = toInput(f);
      const saved = initial ? await update.mutateAsync({ id: initial.id, patch: input }) : await create.mutateAsync(input);
      toast(initial ? 'Call or message updated.' : 'Call or message logged.', 'ok');
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    }
  }

  const topTopics = (topics.data?.items ?? []).slice(0, 12);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? 'Edit call or message' : 'Log a call or message'}
      width={700}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy} shortcut="ctrl+enter">
            {busy ? 'Saving…' : 'Save'}
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
        <Field label="Date" inline hint="As written is fine: 2025-03-11, 3/11/25, March 2025, 2024.">
          <Input autoFocus value={f.occurredAtText} onChange={set('occurredAtText')} placeholder="e.g. 2025-03-11, or today" />
        </Field>
        <Field label="How" inline>
          <Select options={CHANNEL_OPTIONS} value={f.channel} onChange={set('channel')} aria-label="How it happened" />
        </Field>
        <Field label="Direction" inline>
          <Select options={DIRECTION_OPTIONS} value={f.direction} onChange={set('direction')} aria-label="Direction" />
        </Field>
        <Field label="Subject" inline>
          <Input value={f.subject} onChange={set('subject')} placeholder="What it was about, in a line" />
        </Field>
        <Field label="With" inline hint={everyone.length ? undefined : 'No people yet. Add them on People and places first.'}>
          <div className="participants">
            {f.participants.map((p) => (
              <div key={p.personId} className="participant-row">
                <span className="truncate">{nameOf.get(p.personId) ?? 'Removed person'}</span>
                <Select options={ROLE_OPTIONS} value={p.role} onChange={(e) => setRole(p.personId, e.target.value)} aria-label="Their part" />
                <Button size="sm" variant="ghost" onClick={() => removeParticipant(p.personId)}>
                  Remove
                </Button>
              </div>
            ))}
            <Select options={available} placeholder={f.participants.length ? 'Add another person…' : 'Add a person…'} value="" onChange={(e) => addParticipant(e.target.value)} aria-label="Add a person" />
          </div>
        </Field>
        <Field label="Topics" inline hint={topTopics.length ? <span>Separate with commas. Already used: {topTopics.map((t) => t.topic).join(', ')}</span> : 'Separate with commas, e.g. records request, referral.'}>
          <Input value={f.topics} onChange={set('topics')} placeholder="e.g. records request, referral" />
        </Field>
        <Field label="Summary" inline>
          <Textarea value={f.summary} onChange={set('summary')} rows={3} placeholder="What was said" />
        </Field>
        <Field label="Outcome" inline>
          <Textarea value={f.outcome} onChange={set('outcome')} rows={2} placeholder="What came of it" />
        </Field>
        <Field label="Promised" inline hint="What they (or you) said would happen next. Leave it empty if nothing was promised.">
          <Input value={f.followUpPromised} onChange={set('followUpPromised')} placeholder="e.g. Will fax the infusion log" />
        </Field>
        {/* Without a promise these show empty (and are not sent); the typed values come back if a promise is entered again. */}
        <Field label="Due" inline>
          <Input value={promised ? f.followUpDueText : ''} onChange={set('followUpDueText')} placeholder="e.g. 2025-03-18, 3/18/2025 or March 2025" disabled={!promised} aria-label="Due" />
        </Field>
        <Field label="Who owes it" inline>
          <Select options={ownerOptions} placeholder="Nobody named" value={promised ? f.followUpOwnerPersonId : ''} onChange={set('followUpOwnerPersonId')} disabled={!promised} aria-label="Who owes it" />
        </Field>
        {docs.data?.length || f.documentId ? (
          <Field label="Document" inline hint={initial ? 'The document holding the message or the call record.' : 'The document holding the message or the call record. Choosing it fills in the date and subject when they are blank.'}>
            <Select options={docs.data ?? []} placeholder="None" value={f.documentId} onChange={(e) => setDocument(e.target.value)} aria-label="Document" />
          </Field>
        ) : null}
        {encounters.data?.length || f.encounterId ? (
          <Field label="Appointment" inline>
            <Select options={encounters.data ?? []} placeholder="None" value={f.encounterId} onChange={set('encounterId')} aria-label="Appointment" />
          </Field>
        ) : null}
        {error ? <div className="error full small">{error}</div> : null}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Save
        </button>
      </form>
    </Dialog>
  );
}
