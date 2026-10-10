/**
 * One thing Claude noticed, in the detail pane's one anatomy (docs/DESIGN.md): what kind and how serious (eyebrow),
 * the finding (title), where your answer stands (status line), Open the record and Add to to-do list (actions), a few
 * key facts, then "Your answer" as one labelled row of the four answers (the keys c, r, x, d, u do the same), why it
 * matters, the records behind it, your note and the to-dos made from it. No stored codes, rule ids or model names on
 * screen: the words come from ./words.ts.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { Tag, FactStatusTag, RecordStatusTag, TaskStatusTag } from '../../ui/StatusTag';
import { DateText, DateTimeText, KeepDatesWhole } from '../../ui/DateText';
import { Section } from '../../ui/PageHeader';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { FilterGroup } from '../../ui/Toolbar';
import { Textarea } from '../../ui/Field';
import { type EvidenceItem, type FindingDetail as FindingDetailData } from '../../api/findings';
import { documentTypeLabel } from '../../api/filing';
import { parseFlag } from '@shared/labvalues';
import { recordTypeWords } from '../records/words';
import { ANSWERS, answerWords, categoryWords, CATEGORY_TITLES, countWords, foundByWords, severityWords } from './words';
import './evidence-wrap.css';


/** How serious, as a tag in words ("high", "medium", "low", "for information"). */
export function SeverityTag({ severity }: { severity: string }) {
  const w = severityWords(severity);
  return (
    <Tag tone={w.tone} title={w.title || undefined}>
      {w.label}
    </Tag>
  );
}

/** Your answer, as a tag in the answer buttons' words ("new", "needs follow-up", "done", "doesn't matter", "incorrect"). */
export function AnswerTag({ status }: { status: string }) {
  const w = answerWords(status);
  return (
    <Tag tone={w.tone} title={w.sentence}>
      {w.label}
    </Tag>
  );
}

/** Where Enter should take the user for one evidence item: the passage first, then the entity. */
export function evidenceTarget(e: EvidenceItem): { to: string; params?: Record<string, string>; search?: Record<string, unknown> } | null {
  if (e.citation) return { to: '/documents/$id', params: { id: e.citation.documentId }, search: { page: e.citation.pageNumber, cite: e.citation.id } };
  if (e.fact) return { to: '/facts', search: { id: e.fact.id } };
  if (e.communication) return { to: '/communications', search: { id: e.communication.id } };
  if (e.lab) return { to: '/labs', search: { id: e.lab.id } };
  if (e.record) return { to: '/records', search: { id: e.record.id } };
  if (e.document) return { to: '/documents/$id', params: { id: e.document.id } };
  if (e.medication) return { to: '/medications', search: { id: e.medication.id } };
  if (e.medicationEvent) return { to: '/medications', search: { id: e.medicationEvent.medicationId } };
  if (e.encounter) return { to: '/encounters', search: { id: e.encounter.id } };
  if (e.task) return { to: '/tasks', search: { id: e.task.id } };
  if (e.symptom) return { to: '/symptoms', search: {} };
  return null;
}

/** What kind of record an evidence item is, in words (sentence case, the sans; never a code). */
export function evidenceKindWords(e: EvidenceItem): string {
  if (e.fact) return 'Detail';
  if (e.citation) return 'Passage';
  if (e.communication) return 'Call or message';
  if (e.lab) return 'Lab value';
  if (e.record) return 'Record';
  if (e.document) return 'Document';
  if (e.medication || e.medicationEvent) return 'Medication';
  if (e.symptom) return 'Symptom';
  if (e.encounter) return 'Appointment';
  if (e.task) return 'To-do';
  return 'Note';
}

const DIRECTION_WORDS: Record<string, string> = { inbound: 'to you', outbound: 'from you', internal: 'between your team', bidirectional: 'both ways' };
const MED_STATUS_WORDS: Record<string, string> = { active: 'taking it', stopped: 'stopped', prn: 'as needed', planned: 'planned', unknown: '' };
const MED_EVENT_WORDS: Record<string, string> = { start: 'started', stop: 'stopped', dose_change: 'dose changed', hold: 'paused', resume: 'resumed', reaction: 'reaction', note: 'note' };
const SPECIMEN_WORDS: Record<string, string> = { csf: 'CSF', serum: 'blood (serum)', plasma: 'blood (plasma)', whole_blood: 'whole blood', urine: 'urine', other: 'other sample' };

/**
 * A lab value named as evidence, as printed (2026-10): the value as it stands ("<3", "0.08"), its unit, the flag as
 * printed ("H", "HH"; a blank or a dash is "no flag printed"), and the printed text when the value was changed since
 * ("as printed: 0.8"). Never a number re-printed for a limit, never a flag worked out by the app.
 */
export function labValue(l: NonNullable<EvidenceItem['lab']>): string {
  const v = (l.valueText ?? '').trim() || (l.valueRaw ?? '').trim() || (l.valueNum != null ? String(l.valueNum) : '?');
  const raw = (l.flagRaw ?? '').trim();
  const cur = (l.flag ?? '').trim();
  const flag =
    l.flagRaw == null
      ? cur
        ? ` ${cur}`
        : ''
      : !raw || raw === '-'
        ? cur
          ? ` ${cur} (no flag printed)`
          : ', no flag printed'
        : cur && parseFlag(raw).printed !== cur.toUpperCase()
          ? ` ${cur} (flag as printed: ${raw})`
          : ` ${raw}`;
  // "As printed" only beside the user's own value: the text the app read is the value itself (or the page's own text
  // when the page's sign was followed), never Claude's transcription called "printed" (2026-10 review).
  const printed = l.valueEdited && l.valueRaw && l.valueRaw.trim() && l.valueText && l.valueRaw.trim() !== l.valueText.trim() ? ` (as printed: ${l.valueRaw.trim()})` : '';
  return `${l.analyte} ${v}${l.unit ? ` ${l.unit}` : ''}${flag}${printed}`;
}

function EvidenceRow({ e }: { e: EvidenceItem }) {
  const kind = evidenceKindWords(e);
  let main: ReactNode = null;
  const links: ReactNode[] = [];
  if (e.fact) {
    main = (
      <span className="main">
        {e.fact.statement} <FactStatusTag status={e.fact.status} hideAutomatic />
        {e.fact.date ? (
          <span className="evidence-sub">
            {' '}
            <DateText iso={e.fact.date} precision={e.fact.datePrecision} text={e.fact.dateText} />
          </span>
        ) : null}
      </span>
    );
    links.push(
      <Link key="fact" to="/facts" search={{ id: e.fact.id }} className="cite">
        Open the detail
      </Link>,
    );
  } else if (e.communication) {
    const c = e.communication;
    main = (
      <span className="main">
        {c.subject}
        <span className="evidence-sub">
          {' '}
          · {c.channel}
          {DIRECTION_WORDS[c.direction] ? `, ${DIRECTION_WORDS[c.direction]}` : ''} · <DateText iso={c.occurredAt} precision={c.occurredAtPrecision} />
          {c.followUpPromised ? ` · promised: ${c.followUpPromised}${c.followUpDue ? ` (due ${c.followUpDue})` : ''}${c.followUpDoneAt ? ', done' : ', still open'}` : ''}
        </span>
      </span>
    );
    links.push(
      <Link key="comm" to="/communications" search={{ id: c.id }} className="cite">
        Open the call or message
      </Link>,
    );
  } else if (e.lab) {
    main = (
      <span className="main">
        <span className="mono">{labValue(e.lab)}</span>
        <span className="evidence-sub">
          {' '}
          · {SPECIMEN_WORDS[e.lab.specimen] ?? e.lab.specimen} · <DateText iso={e.lab.collectedAt} precision={e.lab.collectedAtPrecision} />
        </span>
      </span>
    );
    links.push(
      <Link key="lab" to="/labs" search={{ id: e.lab.id }} className="cite">
        Open the lab value
      </Link>,
    );
  } else if (e.record) {
    main = (
      <span className="main">
        {e.record.title} <RecordStatusTag status={e.record.status} /> <span className="evidence-sub">{recordTypeWords(e.record.recordType)}</span>
      </span>
    );
    links.push(
      <Link key="rec" to="/records" search={{ id: e.record.id }} className="cite">
        Open the record
      </Link>,
    );
  } else if (e.medicationEvent) {
    main = (
      <span className="main">
        {e.medicationEvent.medicationName} {MED_EVENT_WORDS[e.medicationEvent.kind] ?? e.medicationEvent.kind.replace(/_/g, ' ')}{' '}
        {e.medicationEvent.date ? <DateText iso={e.medicationEvent.date} /> : null}
      </span>
    );
    links.push(
      <Link key="med" to="/medications" search={{ id: e.medicationEvent.medicationId }} className="cite">
        Open the medication
      </Link>,
    );
  } else if (e.medication) {
    const status = MED_STATUS_WORDS[e.medication.status] ?? e.medication.status;
    main = (
      <span className="main">
        {e.medication.name} {status ? <span className="evidence-sub">{status}</span> : null}
      </span>
    );
    links.push(
      <Link key="med" to="/medications" search={{ id: e.medication.id }} className="cite">
        Open the medication
      </Link>,
    );
  } else if (e.symptom) {
    main = <span className="main">{e.symptom.name}, in the symptom diary</span>;
    links.push(
      <Link key="sym" to="/symptoms" search={{}} className="cite">
        Open the symptom diary
      </Link>,
    );
  } else if (e.encounter) {
    main = (
      <span className="main">
        {e.encounter.title} <span className="evidence-sub">{e.encounter.status}</span>
      </span>
    );
    links.push(
      <Link key="enc" to="/encounters" search={{ id: e.encounter.id }} className="cite">
        Open the appointment
      </Link>,
    );
  } else if (e.task) {
    main = (
      <span className="main">
        {e.task.title} <TaskStatusTag status={e.task.status} />
      </span>
    );
    links.push(
      <Link key="task" to="/tasks" search={{ id: e.task.id }} className="cite">
        Open the to-do
      </Link>,
    );
  } else if (e.document && !e.citation) {
    main = (
      <span className="main">
        {e.document.title} <span className="evidence-sub">{documentTypeLabel(e.document.category)}</span>
      </span>
    );
  }
  if (e.citation) {
    links.push(
      <Link key="cite" to="/documents/$id" params={{ id: e.citation.documentId }} search={{ page: e.citation.pageNumber, cite: e.citation.id }} className={`cite${e.citation.verified ? '' : ' unverified'}`} title={e.citation.verified ? 'The quote was found on the page' : 'The quote was not found on the page'}>
        {e.citation.documentTitle ?? 'The document'}, p.{e.citation.pageNumber}
      </Link>,
    );
  } else if (e.document && (e.fact || e.lab)) {
    links.push(
      <Link key="doc" to="/documents/$id" params={{ id: e.document.id }} className="cite">
        {e.document.title}
      </Link>,
    );
  }
  return (
    <div className="evidence-row evidence-wrap">
      <span className="evidence-kind">{kind}</span>
      <div className="evidence-body">
        {main}
        {e.citation ? <blockquote className={`evidence-quote${e.citation.verified ? ' verified' : ''}`}>{e.citation.quote}</blockquote> : null}
        {e.note ? <span className="note">{e.note}</span> : null}
        {e.citation && !e.citation.verified ? (
          <span>
            <Tag tone="warn">quote not found on the page</Tag>
          </span>
        ) : null}
      </div>
      <div className="evidence-links">{links}</div>
    </div>
  );
}

/** The verdict note as typed, for the page's verdict keys: a dirty note travels with the verdict instead of being lost. */
export interface NoteDraft {
  findingId: string;
  note: string;
  dirty: boolean;
}

export interface FindingDetailProps {
  finding: FindingDetailData;
  busy?: boolean;
  onVerdict: (status: string, note?: string | null) => void;
  onMakeTask: () => void;
  /** Open the first record behind it (Enter); left out where there is nothing to open. */
  onOpenEvidence?: () => void;
  /** Called whenever the typed note changes. */
  onNoteDraft?: (draft: NoteDraft) => void;
}

/** The records behind a finding, counted the way the list shows them (a note on its own is not a record). */
export function evidenceCount(f: Pick<FindingDetailData, 'evidence'>): number {
  return f.evidence.filter((e) => evidenceKindWords(e) !== 'Note').length;
}

export function FindingDetail({ finding, busy, onVerdict, onMakeTask, onOpenEvidence, onNoteDraft }: FindingDetailProps) {
  // The draft remembers which finding it was typed for, so a newly selected
  // finding never shows (or saves) the previous finding's text.
  const [draft, setDraft] = useState({ findingId: finding.id, text: finding.verdictNote ?? '' });
  useEffect(() => setDraft({ findingId: finding.id, text: finding.verdictNote ?? '' }), [finding.id, finding.verdictNote]);
  const note = draft.findingId === finding.id ? draft.text : (finding.verdictNote ?? '');
  const setNote = (text: string) => setDraft({ findingId: finding.id, text });
  const noteDirty = note !== (finding.verdictNote ?? '');
  useEffect(() => onNoteDraft?.({ findingId: finding.id, note, dirty: noteDirty }), [onNoteDraft, finding.id, note, noteDirty]);
  /** A verdict carries the typed note along when it has not been saved yet. */
  const decide = (status: string) => onVerdict(status, noteDirty ? note : undefined);
  const records = evidenceCount(finding);
  const openable = finding.evidence.some((e) => evidenceTarget(e) !== null);
  const answer = answerWords(finding.status);

  return (
    <DetailPane label="Finding">
      <DetailHeader
        eyebrow={
          <>
            <SeverityTag severity={finding.severity} />
            <span title={CATEGORY_TITLES[finding.category]}>{categoryWords(finding.category)}</span>
          </>
        }
        title={<KeepDatesWhole text={finding.title} />}
        titleHint={finding.title}
        status={[answer.sentence, <span key="recs">{countWords(records, 'record')} behind it</span>]}
        actions={{
          primary: onOpenEvidence ? { label: 'Open the record', onClick: onOpenEvidence, shortcut: 'enter', disabled: !openable, title: openable ? 'The first record behind it: the page with the passage marked, or the item itself' : 'Nothing behind it can be opened' } : null,
          secondary: [{ label: finding.tasks.length ? 'Add another to-do' : 'Add to to-do list', onClick: onMakeTask, shortcut: 't', disabled: busy, title: 'Make a to-do from it (for example: ask the clinic to correct their summary). Press Yes, done once it is done.' }],
        }}
        facts={[
          { label: 'Found', value: <DateTimeText iso={finding.createdAt} /> },
          { label: 'Found by', value: foundByWords(finding) },
          finding.verdictAt ? { label: 'Answered', value: <DateTimeText iso={finding.verdictAt} /> } : null,
        ]}
      />

      <FilterGroup label="Is this right?" className="fd-answers">
        <span className="fd-answer-buttons">
          {ANSWERS.map((a) => (
            <Button key={a.status} size="sm" shortcut={a.key} aria-pressed={finding.status === a.status} disabled={busy} onClick={() => decide(a.status)} title={a.title}>
              {a.label}
            </Button>
          ))}
          {finding.status !== 'new' ? (
            <Button size="sm" variant="ghost" shortcut="u" disabled={busy} onClick={() => decide('new')} title="Forget your answer; it is open again">
              Undo my answer
            </Button>
          ) : null}
        </span>
      </FilterGroup>

      <Section title="Why it matters">
        <p className="findings-why">
          <KeepDatesWhole text={finding.whyItMatters} />
        </p>
      </Section>

      {finding.detail ? (
        <Section title="In detail">
          <p className="findings-detail-text">
            <KeepDatesWhole text={finding.detail} />
          </p>
        </Section>
      ) : null}

      <Section title="The records behind it" count={records}>
        {finding.evidence.length ? (
          <div className="evidence-list">
            {finding.evidence.map((e) => (
              <EvidenceRow key={e.id} e={e} />
            ))}
          </div>
        ) : (
          <p className="section-intro">No records are linked to this one.</p>
        )}
      </Section>

      <Section
        title="Your note"
        intro="What you checked, who you asked, what came of it. It is saved with your answer too."
        actions={
          <Button size="sm" disabled={busy || !noteDirty} onClick={() => onVerdict(finding.status, note)}>
            Save note
          </Button>
        }
      >
        <div className="findings-note">
          <Textarea aria-label="Your note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Asked the clinic on 2024-04-15; they will correct the summary." rows={3} />
        </div>
      </Section>

      {finding.tasks.length ? (
        <Section title="To-dos made from it" count={finding.tasks.length}>
          <div className="stack tight">
            {finding.tasks.map((t) => (
              <div key={t.id} className="row">
                <Link to="/tasks" search={{ id: t.id }}>
                  {t.title}
                </Link>
                <TaskStatusTag status={t.status} />
                {t.dueAt ? (
                  <span className="muted small">
                    due <DateText iso={t.dueAt.slice(0, 10)} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </DetailPane>
  );
}
