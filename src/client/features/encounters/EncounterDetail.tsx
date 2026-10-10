import { useEffect, useState, type ReactNode } from 'react';
import { FilingNotice } from '../filing/Filing';
import { Link } from '@tanstack/react-router';
import { todayIso } from '@shared/dates';
import { Button } from '../../ui/Button';
import { FactStatusTag, RecordStatusTag, Tag, TaskStatusTag } from '../../ui/StatusTag';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Input, Textarea } from '../../ui/Field';
import type { ActionBarProps } from '../../ui/ActionBar';
import type { EncounterDetail as EncounterData, EncounterPrep, EncounterQuestion } from '../../api/encounters';
import { ownerLabel } from '../../api/tasks';
import { documentTypeLabel } from '../../api/filing';
import { channelWords, directionWords } from '../people/shared';
// A detail's kind as Details from documents says it at the start of a line ("Medication", "Lab result").
import { factTypeWords } from '../facts/words';
import { ENCOUNTER_STATUS_TONE, RECORD_TYPE_WORDS, datePassed, daysFromToday, encounterKindWords, encounterStatusWords, questionWords } from './words';

export interface EncounterDetailProps {
  encounter: EncounterData;
  prep: EncounterPrep | null;
  prepLoading: boolean;
  busy?: boolean;
  onEdit: () => void;
  onComplete: () => void;
  onBriefing: () => void;
  onDelete: () => void;
  onCalendar: () => void;
  onNewTask: () => void;
  onSaveQuestions: (questions: EncounterQuestion[]) => void;
  onSaveOutcomes: (outcomes: string | null) => void;
}

/**
 * The pane's actions. Coming up: Prepare for this visit (the one main action), Mark done, Edit; under More a to-do,
 * the calendar and Delete. Past: Edit and Add a to-do; the rest under More.
 */
export function encounterActions(e: Pick<EncounterData, 'status' | 'occurredAt' | 'occurredAtPrecision'>, p: Pick<EncounterDetailProps, 'busy' | 'onEdit' | 'onComplete' | 'onBriefing' | 'onDelete' | 'onCalendar' | 'onNewTask'>): ActionBarProps {
  const upcoming = e.status === 'upcoming';
  const prepare = { label: 'Prepare for this visit', onClick: p.onBriefing, shortcut: 'b', disabled: p.busy, title: 'Opens the clinician panel with a request to prepare for this visit from everything in the case' };
  const calendar = e.occurredAt && e.occurredAtPrecision === 'day' ? { label: 'Export to my calendar', onClick: p.onCalendar, disabled: p.busy, title: 'Saves a calendar file of this appointment to open in your calendar' } : null;
  const del = { label: 'Delete…', onClick: p.onDelete, shortcut: 'Delete', danger: true, disabled: p.busy, title: 'Hide this appointment (asks first; it is not erased)' };
  if (upcoming)
    return {
      primary: prepare,
      secondary: [
        { label: 'Mark done', onClick: p.onComplete, shortcut: 'c', disabled: p.busy, title: 'It has happened: write down what was decided' },
        { label: 'Edit', onClick: p.onEdit, shortcut: 'e', disabled: p.busy, title: 'Change the date, who, where, the notes or the documents' },
      ],
      more: [{ label: 'Add a to-do from it', onClick: p.onNewTask, shortcut: 't', disabled: p.busy }, calendar, 'separator', del],
    };
  return {
    secondary: [
      { label: 'Edit', onClick: p.onEdit, shortcut: 'e', disabled: p.busy, title: 'Change the date, who, where, the notes or the documents' },
      { label: 'Add a to-do from it', onClick: p.onNewTask, shortcut: 't', disabled: p.busy },
    ],
    more: [{ ...prepare, label: 'Talk it over with the clinician' }, calendar, 'separator', del],
  };
}

/** Who and where, only what is filled in (never a row of dashes). */
export function encounterFacts(e: EncounterData, prep: EncounterPrep | null): KeyFact[] {
  const out: KeyFact[] = [];
  if (e.clinicianId)
    out.push({
      label: 'With',
      value: (
        <Link to="/people" search={{ id: e.clinicianId }}>
          {e.clinicianName ?? 'Open the person'}
        </Link>
      ),
    });
  if (e.clinicianSpecialty) out.push({ label: 'Specialty', value: e.clinicianSpecialty });
  if (e.institutionId)
    out.push({
      label: 'Hospital or clinic',
      value: (
        <Link to="/people" search={{ id: e.institutionId }}>
          {e.institutionName ?? 'Open the place'}
        </Link>
      ),
    });
  if (e.location) out.push({ label: 'Where exactly', value: e.location, wide: true });
  if (prep?.clinician?.phone) out.push({ label: 'Phone', value: prep.clinician.phone, mono: true });
  if (prep?.clinician?.portal) out.push({ label: 'Portal', value: prep.clinician.portal });
  const imported = /Imported from the calendar file ([^\n]+?) on \d{4}-\d{2}-\d{2}/.exec(e.prepNotes ?? '');
  if (imported) out.push({ label: 'Came from', value: `The calendar file ${imported[1]}`, wide: true });
  return out;
}

/**
 * Right pane of /encounters: one appointment. Eyebrow (the kind), the title,
 * one status line (date, how far off, where it stands), the actions, who and
 * where; then, coming up, the questions to ask, the notes and the prep sheet
 * (never give, medications, what is owed, recent calls, new details, records
 * to bring); past, what was decided, the questions with their answers, and the
 * documents, calls and to-dos that came out of it.
 */
export function EncounterDetail(p: EncounterDetailProps) {
  const { encounter: e, prep } = p;
  const today = todayIso();
  const upcoming = e.status === 'upcoming';
  const [newQ, setNewQ] = useState('');
  const [outcomes, setOutcomes] = useState(e.outcomes ?? '');
  const [editingAnswer, setEditingAnswer] = useState<number | null>(null);
  const [answerDraft, setAnswerDraft] = useState('');
  useEffect(() => {
    setOutcomes(e.outcomes ?? '');
    setEditingAnswer(null);
    setNewQ('');
  }, [e.id, e.outcomes]);
  const outcomesDirty = outcomes !== (e.outcomes ?? '');
  const when = daysFromToday(e.occurredAt, e.occurredAtPrecision, today);
  const passed = datePassed(e, today);

  function toggleAsked(i: number) {
    p.onSaveQuestions(e.questions.map((q, j) => (j === i ? { ...q, asked: !q.asked } : q)));
  }
  function removeQuestion(i: number) {
    p.onSaveQuestions(e.questions.filter((_, j) => j !== i));
  }
  function addQuestion() {
    const text = newQ.trim();
    if (!text) return;
    p.onSaveQuestions([...e.questions, { text, asked: false, answer: null }]);
    setNewQ('');
  }
  function saveAnswer(i: number) {
    p.onSaveQuestions(e.questions.map((q, j) => (j === i ? { ...q, answer: answerDraft.trim() || null, asked: q.asked || Boolean(answerDraft.trim()) } : q)));
    setEditingAnswer(null);
  }

  const questions = (
    <Section key="questions" title={upcoming ? 'Questions to ask' : 'Questions'} count={e.questionCount ? questionWords(e.askedCount, e.questionCount) : undefined}>
      {e.questions.length ? (
        <div className="en-questions">
          {e.questions.map((q, i) => (
            <div key={`${i}:${q.text}`} className={`en-question${q.asked ? ' asked' : ''}`}>
              <input type="checkbox" checked={q.asked} onChange={() => toggleAsked(i)} aria-label={q.asked ? `Asked: ${q.text}` : `Not asked yet: ${q.text}`} disabled={p.busy} />
              <div>
                <div className="q">{q.text}</div>
                {editingAnswer === i ? (
                  <div className="answer">
                    <Input
                      autoFocus
                      value={answerDraft}
                      placeholder="What they said"
                      aria-label="Their answer"
                      onChange={(ev) => setAnswerDraft(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          saveAnswer(i);
                        } else if (ev.key === 'Escape') {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setEditingAnswer(null);
                        }
                      }}
                      onBlur={() => saveAnswer(i)}
                    />
                  </div>
                ) : q.answer ? (
                  <div className="answer">
                    <span className="en-answer-label">Answer: </span>
                    {q.answer}
                  </div>
                ) : null}
              </div>
              <span className="row" style={{ gap: 'var(--sp-2)' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={p.busy}
                  onClick={() => {
                    setAnswerDraft(q.answer ?? '');
                    setEditingAnswer(i);
                  }}
                >
                  {q.answer ? 'Edit the answer' : 'Write the answer'}
                </Button>
                <Button size="sm" variant="ghost" disabled={p.busy} onClick={() => removeQuestion(i)} title={`Remove: ${q.text}`}>
                  Remove
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="en-add">
        <Input
          value={newQ}
          placeholder={e.questions.length ? 'Another question to ask' : 'A question to ask, e.g. Is a repeat LP needed?'}
          aria-label="New question"
          onChange={(ev) => setNewQ(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              addQuestion();
            }
          }}
        />
        <Button size="sm" disabled={p.busy || !newQ.trim()} onClick={addQuestion}>
          Add the question
        </Button>
      </div>
    </Section>
  );

  const decided = (
    <Section
      key="decided"
      title="What was decided"
      intro={upcoming ? 'After the visit: what was decided, prescribed, ordered or promised. Mark done asks for it too.' : undefined}
      actions={
        <Button size="sm" disabled={p.busy || !outcomesDirty} onClick={() => p.onSaveOutcomes(outcomes.trim() || null)}>
          Save
        </Button>
      }
    >
      <div className="en-outcomes">
        <Textarea value={outcomes} onChange={(ev) => setOutcomes(ev.target.value)} rows={upcoming ? 3 : 4} placeholder="e.g. Physical therapy started; repeat X-ray if the pain returns" aria-label="What was decided" />
      </div>
    </Section>
  );

  const notes = e.prepNotes ? (
    <Section key="notes" title="Notes for the visit">
      <div className="en-text">{e.prepNotes}</div>
    </Section>
  ) : null;

  const documents =
    e.documents.length || !upcoming ? (
      <Section key="documents" title="Documents from this visit" count={e.documents.length || undefined}>
        {e.documents.length ? (
          <div className="en-ledger">
            {e.documents.map((d) => (
              <Link key={d.id} to="/documents/$id" params={{ id: d.id }} className="en-ledger-row">
                <span className="when">
                  <DateText iso={d.documentDate} precision={d.documentDatePrecision} />
                </span>
                <span className="what">
                  <KeepDatesWhole text={d.title} />
                  <span className="sub">{documentTypeLabel(d.category)}</span>
                </span>
                <span />
              </Link>
            ))}
          </div>
        ) : (
          <div className="en-none">
            <span>No documents linked yet: the visit note, a letter or results from it.</span>
            <Button size="sm" onClick={p.onEdit} disabled={p.busy}>
              Link documents
            </Button>
          </div>
        )}
      </Section>
    ) : null;

  const comms = e.communications.length ? (
    <Section key="comms" title="Calls and messages about this visit" count={e.communications.length}>
      <div className="en-ledger">
        {e.communications.map((c) => (
          <Link key={c.id} to="/communications" search={{ id: c.id }} className="en-ledger-row">
            <span className="when">
              <DateText iso={c.occurredAt} precision={c.occurredAtPrecision} />
            </span>
            <span className="what">
              {c.subject}
              <span className="sub">
                {channelWords(c.channel)}, {directionWords(c.direction).toLowerCase()}
                {c.participants.length ? ` · ${c.participants.map((x) => x.name).join(', ')}` : ''}
              </span>
            </span>
            <span />
          </Link>
        ))}
      </div>
    </Section>
  ) : null;

  const tasks = e.tasks.length ? (
    <Section key="tasks" title="To-dos from this visit" count={e.tasks.length}>
      <div className="en-ledger">
        {e.tasks.map((t) => (
          <Link key={t.id} to="/tasks" search={{ id: t.id }} className="en-ledger-row">
            <span className="when">{t.dueAt ? <DateText iso={t.dueAt} /> : <span className="muted">No date</span>}</span>
            <span className="what">
              {t.title}
              <span className="sub">{ownerLabel(t)}</span>
            </span>
            <TaskStatusTag status={t.status} />
          </Link>
        ))}
      </div>
    </Section>
  ) : null;

  const sections: ReactNode[] = upcoming
    ? [questions, notes, <PrepSheet key="prep" prep={prep} loading={p.prepLoading} />, tasks, comms, documents, decided]
    : [decided, e.questions.length ? questions : null, documents, comms, tasks, notes];

  return (
    <DetailPane label="Appointment">
      <FilingNotice targetType="encounter" targetId={e.id} />
      <DetailHeader
        eyebrow={<span>{encounterKindWords(e.kind)}</span>}
        title={e.title}
        status={[
          e.occurredAt || e.occurredAtText ? (
            <span key="date">
              <DateText iso={e.occurredAt} precision={e.occurredAtPrecision} text={e.occurredAtText} />
              {e.timeText ? <span className="mono"> {e.timeText}</span> : null}
            </span>
          ) : (
            'No date yet'
          ),
          when,
          passed ? (
            <Tag key="passed" tone="warn" title="Its date has gone by: mark it done (and write what was decided) or cancelled">
              date passed
            </Tag>
          ) : (
            <Tag key="status" tone={ENCOUNTER_STATUS_TONE[e.status] ?? 'neutral'}>
              {encounterStatusWords(e.status)}
            </Tag>
          ),
        ]}
        actions={encounterActions(e, p)}
        facts={encounterFacts(e, prep)}
      />
      {sections}
    </DetailPane>
  );
}

/** Before the visit: what never to give, the medications, what is owed, recent calls, new details, records to bring. */
function PrepSheet({ prep, loading }: { prep: EncounterPrep | null; loading: boolean }) {
  if (!prep) return loading ? <p className="en-none">Gathering what to bring to the visit…</p> : null;
  return (
    <>
      {prep.hardStops.length ? (
        <div className="hardstop">
          <strong>Never give</strong>
          {prep.hardStops.map((h) => (
            <div key={h.id}>
              {h.substance}
              {h.reaction ? <span className="muted">: {h.reaction}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      <Section title="Current medications" count={prep.activeMedications.length || undefined}>
        {prep.activeMedications.length ? (
          <div className="en-ledger">
            {prep.activeMedications.map((m) => (
              <Link key={m.id} to="/medications" search={{ id: m.id }} className="en-ledger-row en-med-row">
                <span className="what">
                  {m.name}
                  <span className="sub">{[m.dose && m.unit ? `${m.dose} ${m.unit}` : m.dose, m.route, m.frequency].filter(Boolean).join(', ')}</span>
                </span>
                <span className="muted small">{m.status === 'prn' ? 'as needed' : (m.prescriberName ?? '')}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="en-none">No current medications on the list.</p>
        )}
      </Section>

      {prep.openFollowUps.length ? (
        <Section title="Promised and still open" count={prep.openFollowUps.length}>
          <div className="en-ledger">
            {prep.openFollowUps.map((c) => (
              <Link key={c.id} to="/communications" search={{ id: c.id }} className="en-ledger-row">
                <span className="when">{c.followUpDue ? <DateText iso={c.followUpDue} /> : <span className="muted">No date</span>}</span>
                <span className="what">
                  {c.followUpPromised ?? c.subject}
                  <span className="sub">{c.followUpOwnerName ?? c.participants.map((x) => x.name).join(', ')}</span>
                </span>
                {c.overdue ? <Tag tone="bad">overdue</Tag> : <span />}
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {prep.openTasksForOwner.length ? (
        <Section title="Their open to-dos" count={prep.openTasksForOwner.length}>
          <div className="en-ledger">
            {prep.openTasksForOwner.map((t) => (
              <Link key={t.id} to="/tasks" search={{ id: t.id }} className="en-ledger-row">
                <span className="when">{t.dueAt ? <DateText iso={t.dueAt} /> : <span className="muted">No date</span>}</span>
                <span className="what">{t.title}</span>
                {t.overdue ? <Tag tone="bad">overdue</Tag> : <TaskStatusTag status={t.status} />}
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {prep.lastContacts.length ? (
        <Section title="Last calls and messages with them" count={prep.lastContacts.length}>
          <div className="en-ledger">
            {prep.lastContacts.slice(0, 6).map((c) => (
              <Link key={c.id} to="/communications" search={{ id: c.id }} className="en-ledger-row">
                <span className="when">
                  <DateText iso={c.occurredAt} precision={c.occurredAtPrecision} />
                </span>
                <span className="what">
                  {c.subject}
                  <span className="sub">
                    {channelWords(c.channel)}, {directionWords(c.direction).toLowerCase()}
                    {c.outcome ? ` · ${c.outcome}` : ''}
                  </span>
                </span>
                {c.followUpPromised && !c.followUpDoneAt ? <Tag tone={c.overdue ? 'bad' : 'warn'}>{c.overdue ? 'follow-up overdue' : 'follow-up open'}</Tag> : <span />}
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="New since the last visit"
        count={prep.recentFacts.length || undefined}
        intro={
          <>
            Details dated from <span className="mono">{prep.recentSince}</span> on.
          </>
        }
      >
        {prep.recentFacts.length ? (
          <div className="en-ledger">
            {prep.recentFacts.slice(0, 25).map((f) => (
              <Link key={f.id} to="/facts" search={{ id: f.id }} className="en-ledger-row">
                <span className="when">
                  <DateText iso={f.date} precision={f.datePrecision} />
                </span>
                <span className="what">
                  <KeepDatesWhole text={f.statement} />
                  <span className="sub">
                    {factTypeWords(f.type)}
                    {f.documentTitle ? ` · ${f.documentTitle}` : ''}
                  </span>
                </span>
                <FactStatusTag status={f.status} hideAutomatic />
              </Link>
            ))}
            {prep.recentFacts.length > 25 ? <p className="en-none">and {prep.recentFacts.length - 25} more on Details from documents</p> : null}
          </div>
        ) : (
          <p className="en-none">Nothing new dated since then.</p>
        )}
      </Section>

      {prep.gaps.length ? (
        <Section title="Records to bring or request" count={prep.gaps.length}>
          <div className="en-ledger">
            {prep.gaps.map((g) => (
              <Link key={g.id} to="/records" search={{ view: 'gaps', id: g.id }} className="en-ledger-row">
                <span className="when">
                  <DateText iso={g.date} precision={g.datePrecision} />
                </span>
                <span className="what">
                  {g.title}
                  <span className="sub">
                    {RECORD_TYPE_WORDS[g.recordType] ?? g.recordType.replace(/_/g, ' ')}
                    {g.institution ? ` · ${g.institution}` : ''}
                  </span>
                </span>
                <RecordStatusTag status={g.status} />
              </Link>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}
