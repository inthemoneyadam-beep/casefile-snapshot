/**
 * The small dialogs of the Care team page: answer the Flare test (typed by a person, with its own source), add a
 * source to facts, change the status, and say yes to a proposal (linking it to People and places).
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Select, Textarea, Input } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import {
  CARE_STATUSES,
  CARE_STATUS_WORDS,
  FIELD_WORDS,
  FLARE_TEST_ITEMS,
  FLARE_VERDICTS,
  FLARE_VERDICT_HINT,
  FLARE_VERDICT_WORDS,
  HOME_STATE_LICENSE,
  HOME_STATE_LICENSE_WORDS,
  SOURCED_FIELDS,
  callWords,
  fieldValueText,
  readCallTime,
  verdictProblem,
  type CareStatus,
  type FlareVerdictKey,
  type HomeStateLicense,
  type SourcedField,
} from '@shared/care-team';
import type { Candidate, CandidateDetail, PersonMatch, SourceInput, VerdictInput } from '../../api/care-team';
import { DayInput, dayHint, readDay } from '../../ui/DayInput';
import { EMPTY_SOURCE, SourceFields, sourceFrom, type SourceState } from './SourceFields';

function Footer({ onClose, onSubmit, label, disabled }: { onClose: () => void; onSubmit: () => void; label: string; disabled: boolean }) {
  return (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={disabled} onClick={onSubmit}>
        {label} <Kbd>ctrl+enter</Kbd>
      </Button>
    </>
  );
}

const ctrlEnter = (fn: () => void) => (e: React.KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    fn();
  }
};

/** The first item answered in words with no answer (or the first item). The home-state license row is a field of its own. */
export function firstOpenItem(c: Pick<Candidate, 'flareTest'>): string {
  return FLARE_TEST_ITEMS.find((i) => !i.field && !c.flareTest[i.key]?.answer)?.key ?? FLARE_TEST_ITEMS[0].key;
}

/** The value of a field as the candidate holds it (the request 6 fields included). */
function valueOf(c: CandidateDetail, f: SourcedField): unknown {
  switch (f) {
    case 'licensedStates':
      return c.licensedStates;
    case 'accessType':
      return c.accessType ?? 'unknown';
    case 'licensedInHomeState':
      return c.licensedInHomeState ?? 'unknown';
    case 'quotedCost':
      return c.quotedCost ?? null;
    case 'earliestVisit':
      return c.earliestVisit ?? null;
    default:
      return c[f];
  }
}

export function FlareDialog({ open, onClose, candidate, item, busy, error, onSave }: { open: boolean; onClose: () => void; candidate: CandidateDetail | null; item: string; busy: boolean; error: string | null; onSave: (p: { item: string; answer: string; source: SourceInput | null }) => void }) {
  const [key, setKey] = useState(item);
  const [answer, setAnswer] = useState('');
  const [src, setSrc] = useState<SourceState>({ ...EMPTY_SOURCE, kind: 'phone' });
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !candidate) return;
    setKey(item);
    setAnswer(candidate.flareTest[item as keyof typeof candidate.flareTest]?.answer ?? '');
    setSrc({ ...EMPTY_SOURCE, kind: 'phone', who: candidate.name });
    setLocal(null);
  }, [open, candidate?.id, item]); // eslint-disable-line react-hooks/exhaustive-deps
  const def = FLARE_TEST_ITEMS.find((i) => i.key === key) ?? FLARE_TEST_ITEMS[0];
  const prev = candidate?.flareTest[def.key]?.answer ?? '';
  function pick(k: string) {
    setKey(k);
    setAnswer(candidate?.flareTest[k as keyof NonNullable<typeof candidate>['flareTest']]?.answer ?? '');
  }
  function submit() {
    if (busy) return;
    const { source, problem } = answer.trim() ? sourceFrom(src) : { source: null, problem: null };
    if (problem) return setLocal(problem);
    if (!answer.trim() && !prev) return setLocal('Type the answer.');
    setLocal(null);
    onSave({ item: def.key, answer, source });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Flare test" width={640} footer={<Footer onClose={onClose} onSubmit={submit} label={answer.trim() ? 'Save the answer' : 'Clear the answer'} disabled={busy || (!answer.trim() && !prev)} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        <p className="muted small">Typed by you, from what they said or wrote. Claude never fills this in.</p>
        <Field label="Question">
          <Select aria-label="Question" value={def.key} options={FLARE_TEST_ITEMS.filter((i) => !i.field).map((i) => ({ value: i.key, label: `${i.label}${candidate?.flareTest[i.key]?.answer ? ' (answered)' : ''}` }))} onChange={(e) => pick(e.target.value)} />
        </Field>
        <p className="small">{def.question}</p>
        <Field label="Their answer">
          <Textarea autoFocus data-autofocus="" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} />
        </Field>
        {answer.trim() ? <SourceFields value={src} onChange={setSrc} calls={candidate?.communications ?? []} label="Source of the answer" /> : null}
      </div>
    </Dialog>
  );
}

export function SourceDialog({ open, onClose, candidate, busy, error, onSave }: { open: boolean; onClose: () => void; candidate: CandidateDetail | null; busy: boolean; error: string | null; onSave: (p: { fields: SourcedField[]; source: SourceInput }) => void }) {
  const filled = candidate ? SOURCED_FIELDS.filter((f) => fieldValueText(f, valueOf(candidate, f))) : [];
  const [fields, setFields] = useState<SourcedField[]>([]);
  const [src, setSrc] = useState<SourceState>({ ...EMPTY_SOURCE, kind: 'web' });
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !candidate) return;
    // The facts still not backed come ticked.
    setFields(filled.filter((f) => candidate.backing[f] === 'not_backed'));
    setSrc({ ...EMPTY_SOURCE, kind: 'web' });
    setLocal(null);
  }, [open, candidate?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  function submit() {
    if (busy) return;
    if (!fields.length) return setLocal('Tick what this source says.');
    const { source, problem } = sourceFrom(src);
    if (problem || !source) return setLocal(problem ?? 'Choose a web page or a phone call.');
    setLocal(null);
    onSave({ fields, source });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Add a source" width={640} footer={<Footer onClose={onClose} onSubmit={submit} label="Add the source" disabled={busy || !fields.length} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        {filled.length ? (
          <Field label="What it says">
            <div className="ct-fieldset">
              {filled.map((f) => (
                <label key={f}>
                  <input type="checkbox" checked={fields.includes(f)} onChange={(e) => setFields((xs) => (e.target.checked ? [...xs, f] : xs.filter((x) => x !== f)))} />
                  {FIELD_WORDS[f]}
                  {candidate?.backing[f] === 'not_backed' ? <span className="muted small"> (not backed yet)</span> : null}
                </label>
              ))}
            </div>
          </Field>
        ) : (
          <p className="muted">Nothing to back yet: fill in a fact first (Edit).</p>
        )}
        <SourceFields value={src} onChange={setSrc} allowNone={false} calls={candidate?.communications ?? []} />
      </div>
    </Dialog>
  );
}

/** "Call booked for" in words under its box: how it reads, or what to type. */
export function callHint(text: string): string | undefined {
  const t = text.trim();
  if (!t) return 'A day and a time, e.g. 2026-10-14 3:30 pm. A day alone is fine.';
  const c = readCallTime(t);
  if (!c) return 'Could not read this. Type it as 2026-10-14 3:30 pm.';
  return `Reads as ${callWords(c)}${c.precision === 'day' && !c.time ? ' (no time yet)' : ''}.`;
}

export function StatusDialog({ open, onClose, candidate, busy, error, onSave }: { open: boolean; onClose: () => void; candidate: Candidate | null; busy: boolean; error: string | null; onSave: (p: { status: CareStatus; note: string | null; callBookedFor?: string | null }) => void }) {
  const [status, setStatus] = useState<CareStatus>('found');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !candidate) return;
    setStatus(candidate.status);
    setNote('');
    setWhen(candidate.callBookedFor?.text ?? '');
    setLocal(null);
  }, [open, candidate?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const booking = status === 'call_booked';
  const whenChanged = booking && when.trim() !== (candidate?.callBookedFor?.text ?? '');
  const submit = () => {
    if (busy) return;
    if (booking && !readCallTime(when)) return setLocal('A booked call needs a time: say when it is booked for.');
    setLocal(null);
    onSave({ status, note: note.trim() || null, ...(booking ? { callBookedFor: when.trim() } : {}) });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Status" width={520} footer={<Footer onClose={onClose} onSubmit={submit} label="Save" disabled={busy || (status === candidate?.status && !note.trim() && !whenChanged)} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        <Field label="Where they stand">
          <Select autoFocus data-autofocus="" aria-label="Where they stand" value={status} options={CARE_STATUSES.map((s) => ({ value: s, label: CARE_STATUS_WORDS[s] }))} onChange={(e) => setStatus(e.target.value as CareStatus)} />
        </Field>
        {booking ? (
          <Field label="Call booked for" hint={callHint(when)}>
            <Input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. 2027-01-12 3:30 pm" />
          </Field>
        ) : null}
        <Field label="Note" hint="Optional: why, or what was said.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * What the verdict dialog starts from: the verdict already decided, else Not decided. Never a Pass nobody chose
 * (review 2026-10-09: a new verdict started at Pass).
 */
export function verdictDraft(c: Pick<CandidateDetail, 'flareVerdict'> | null, me: string | null): { verdict: FlareVerdictKey; reason: string; who: string } {
  const v = c?.flareVerdict ?? null;
  return { verdict: v?.verdict ?? 'not_decided', reason: v?.reason ?? '', who: v?.decidedBy ?? me ?? '' };
}

/**
 * The verdict on the whole flare test (request 6): Pass, Fail or Not decided, a one-line reason (required for Pass and
 * Fail), who decided and when. Typed by a person; Claude never fills it in.
 */
export function VerdictDialog({ open, onClose, candidate, me, busy, error, onSave }: { open: boolean; onClose: () => void; candidate: CandidateDetail | null; me: string | null; busy: boolean; error: string | null; onSave: (v: VerdictInput) => void }) {
  const [verdict, setVerdict] = useState<FlareVerdictKey>('not_decided');
  const [reason, setReason] = useState('');
  const [who, setWho] = useState('');
  const [on, setOn] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !candidate) return;
    const d = verdictDraft(candidate, me);
    setVerdict(d.verdict);
    setReason(d.reason);
    setWho(d.who);
    setOn('');
    setLocal(null);
  }, [open, candidate?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  function submit() {
    if (busy) return;
    const p = verdictProblem(verdict, reason);
    if (p) return setLocal(p);
    if (on.trim() && !readDay(on).ok) return setLocal('Type the day as 2026-10-09.');
    setLocal(null);
    onSave({ verdict, reason: reason.trim() || null, decidedBy: who.trim() || null, decidedOn: on.trim() ? readDay(on).iso : null });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Flare test: pass or fail" width={600} footer={<Footer onClose={onClose} onSubmit={submit} label="Save the verdict" disabled={busy} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        <p className="small">{FLARE_VERDICT_HINT}</p>
        <Field label="Verdict">
          <Select autoFocus data-autofocus="" aria-label="Verdict" value={verdict} options={FLARE_VERDICTS.map((v) => ({ value: v, label: FLARE_VERDICT_WORDS[v] }))} onChange={(e) => setVerdict(e.target.value as FlareVerdictKey)} />
        </Field>
        <Field label="Why, in one line" hint={verdict === 'not_decided' ? 'Optional.' : verdict === 'pass' ? 'Who places the treatment order, and in how many hours.' : 'What they said instead.'}>
          <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="ct-form">
          <Field label="Decided by">
            <Input value={who} onChange={(e) => setWho(e.target.value)} />
          </Field>
          <Field label="On" hint={dayHint(on) ?? 'Today when blank.'}>
            <DayInput value={on} onChange={setOn} />
          </Field>
        </div>
        <p className="muted small">Typed by you. Claude never fills this in.</p>
      </div>
    </Dialog>
  );
}

/** "Verified by phone" ticked: who called and when, and the facts it covers (each one found on the web). */
export function PhoneCheckDialog({ open, onClose, candidate, busy, error, onSave }: { open: boolean; onClose: () => void; candidate: CandidateDetail | null; busy: boolean; error: string | null; onSave: (p: { who: string; when: string; fields: SourcedField[] }) => void }) {
  const web = candidate ? SOURCED_FIELDS.filter((f) => candidate.verification?.[f]) : [];
  const [fields, setFields] = useState<SourcedField[]>([]);
  const [who, setWho] = useState('');
  const [when, setWhen] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !candidate) return;
    setFields(web.filter((f) => candidate.verification?.[f] === 'unverified'));
    setWho('');
    setWhen('');
    setLocal(null);
  }, [open, candidate?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  function submit() {
    if (busy) return;
    if (!who.trim()) return setLocal('Say who called.');
    if (!when.trim() || !readDay(when).ok) return setLocal('Say the day of the call, e.g. 2026-10-09.');
    if (!fields.length) return setLocal('Tick what the call checked.');
    setLocal(null);
    onSave({ who: who.trim(), when: readDay(when).iso ?? when.trim(), fields });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Verified by phone" width={600} footer={<Footer onClose={onClose} onSubmit={submit} label="Tick it" disabled={busy || !fields.length} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        <p className="muted small">Someone called and checked what the web search found. A phone source goes beside each web one, and "unverified" goes.</p>
        <div className="ct-form">
          <Field label="Who called">
            <Input autoFocus data-autofocus="" value={who} onChange={(e) => setWho(e.target.value)} placeholder="e.g. Robin" />
          </Field>
          <Field label="When" hint={dayHint(when)}>
            <DayInput value={when} onChange={setWhen} />
          </Field>
        </div>
        {web.length ? (
          <Field label="What the call checked">
            <div className="ct-fieldset">
              {web.map((f) => (
                <label key={f}>
                  <input type="checkbox" checked={fields.includes(f)} onChange={(e) => setFields((xs) => (e.target.checked ? [...xs, f] : xs.filter((x) => x !== f)))} />
                  {FIELD_WORDS[f]}
                  {candidate?.verification?.[f] === 'unverified' ? <span className="muted small"> (unverified)</span> : null}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The home-state license row of the flare test: the "Licensed in home state" fact, with its source (one value). */
export function HomeStateDialog({ open, onClose, candidate, busy, error, onSave }: { open: boolean; onClose: () => void; candidate: CandidateDetail | null; busy: boolean; error: string | null; onSave: (p: { licensedInHomeState: HomeStateLicense; source: SourceInput | null }) => void }) {
  const [v, setV] = useState<HomeStateLicense>('unknown');
  const [src, setSrc] = useState<SourceState>({ ...EMPTY_SOURCE, kind: 'phone' });
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !candidate) return;
    setV(candidate.licensedInHomeState ?? 'unknown');
    setSrc({ ...EMPTY_SOURCE, kind: 'phone', who: candidate.name });
    setLocal(null);
  }, [open, candidate?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  function submit() {
    if (busy) return;
    const { source, problem } = v === 'unknown' ? { source: null, problem: null } : sourceFrom(src);
    if (problem) return setLocal(problem);
    setLocal(null);
    onSave({ licensedInHomeState: v, source });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Licensed in home state" width={600} footer={<Footer onClose={onClose} onSubmit={submit} label="Save" disabled={busy} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        {error || local ? <div className="notice bad small">{local ?? error}</div> : null}
        <p className="muted small">The flare test's home-state license item and this fact are one answer.</p>
        <Field label="Licensed in home state">
          <Select autoFocus data-autofocus="" aria-label="Licensed in home state" value={v} options={HOME_STATE_LICENSE.map((k) => ({ value: k, label: HOME_STATE_LICENSE_WORDS[k] }))} onChange={(e) => setV(e.target.value as HomeStateLicense)} />
        </Field>
        {v !== 'unknown' ? <SourceFields value={src} onChange={setSrc} calls={candidate?.communications ?? []} label="Source" /> : <p className="muted small">Unknown needs no source.</p>}
      </div>
    </Dialog>
  );
}

/** Yes to a proposal: link it to an entry in People and places with the same name, or make a new one. */
export function AcceptDialog({ open, onClose, candidate, matches, busy, onAccept }: { open: boolean; onClose: () => void; candidate: Candidate | null; matches: PersonMatch[]; busy: boolean; onAccept: (personId: string | null) => void }) {
  const [choice, setChoice] = useState('');
  useEffect(() => {
    if (open) setChoice('');
  }, [open]);
  const submit = () => choice && !busy && onAccept(choice === 'new' ? null : choice);
  return (
    <Dialog open={open} onClose={onClose} title={`Add ${candidate?.name ?? 'this candidate'}?`} width={560} footer={<Footer onClose={onClose} onSubmit={submit} label="Yes, add" disabled={!choice || busy} />}>
      <div className="stack" onKeyDown={ctrlEnter(submit)}>
        <p>People and places already has someone with this name.</p>
        <Field label="Is it the same person?">
          <Select autoFocus data-autofocus="" aria-label="Is it the same person?" value={choice} placeholder="Choose one" options={[...matches.map((p) => ({ value: p.id, label: `Yes, the same as ${p.name}${p.role ? ` (${p.role})` : ''}` })), { value: 'new', label: 'No, someone new' }]} onChange={(e) => setChoice(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
