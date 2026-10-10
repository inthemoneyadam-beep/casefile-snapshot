/**
 * One row of the Records checklist, in the right pane (routes/records.tsx), in
 * the order every detail pane follows (docs/DESIGN.md):
 *
 *   header    the kind of record, its name, one status line (where it stands and
 *             when), the actions that matter for where it stands (Mark received
 *             and Mark asked for while you wait for it; Open the document once
 *             you have it; They have none, Refused, Edit and Remove under More)
 *             and the key facts that are known (never an empty row)
 *   notice    a document already in the case that may be this record (a guess,
 *             said as one, with Mark received with it)
 *   Edit the record   the whole row as a form (Enter in a field saves)
 *
 * The status changes are refused while the form has unsaved edits (a change
 * re-seeds the form from the server row); the page learns that through
 * `onDirtyChange`.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { FilingNotice } from '../filing/Filing';
import { DayInput, dayHint, readDay } from '../../ui/DayInput';
import { Link } from '@tanstack/react-router';
import { formatPartialDate, parsePartialDate } from '@shared/dates';
import type { ActionBarProps } from '../../ui/ActionBar';
import { Button } from '../../ui/Button';
import { DateText, DateTimeText, KeepDatesWhole } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import type { DocumentLite, Gap, PersonLite, RecordInput, RecordRow, Transition } from '../../api/records';
import { likelyBasis } from './likely';
import { HELD_COPY_WORDS, HELD_FORM_WORDS, RECORD_FORMAT_OPTIONS, RECORD_FORMAT_WORDS, RECORD_STATUS_OPTIONS, RECORD_TYPE_OPTIONS, RecordStatus, recordTypeWords } from './words';

/** What the page lets a detail pane do. Every action targets the current selection. */
export interface RecordActions {
  transition: (kind: Transition) => void;
  receive: () => void;
  /** Mark the selected row received with this document as its copy (the "likely held" suggestion). */
  receiveDocument: (documentId: string) => void;
  materialize: () => void;
  remove: () => void;
  /** Create (or reuse) the held row for a document; with a source fact the row answers that inferred gap. */
  fromDocument: (documentId: string, recordType?: string, sourceFactId?: string | null) => void;
  /** Put the cursor in the form's first field (e). */
  edit?: () => void;
  /** Open the record's document (Enter). */
  openDocument?: (documentId: string) => void;
}

const HELD_FORMS = Object.keys(HELD_FORM_WORDS);

interface FormState {
  title: string;
  recordType: string;
  institutionId: string;
  system: string;
  format: string;
  held: boolean;
  heldForm: string;
  documentId: string;
  status: string;
  recordDateText: string;
  requestedAt: string;
  receivedAt: string;
  expectedBy: string;
  notes: string;
}

function fromRecord(r: RecordRow | null, seed?: Partial<FormState>): FormState {
  return {
    title: r?.title ?? '',
    recordType: r?.recordType ?? 'other',
    institutionId: r?.institutionId ?? '',
    system: r?.system ?? '',
    format: r?.format ?? 'unknown',
    held: r?.held ?? false,
    heldForm: r?.heldForm ?? '',
    documentId: r?.documentId ?? '',
    status: r?.status ?? 'unknown',
    recordDateText: r?.recordDateText ?? r?.recordDate ?? '',
    requestedAt: r?.requestedAt ?? '',
    receivedAt: r?.receivedAt ?? '',
    expectedBy: r?.expectedBy ?? '',
    notes: r?.notes ?? '',
    ...seed,
  };
}

function toInput(f: FormState): RecordInput {
  return {
    title: f.title.trim(),
    recordType: f.recordType,
    institutionId: f.institutionId || null,
    system: f.system.trim() || null,
    format: f.format,
    held: f.held,
    heldForm: f.heldForm || null,
    documentId: f.documentId || null,
    status: f.status,
    recordDateText: f.recordDateText.trim() || null,
    // Typed days (ui/DayInput) are sent as YYYY-MM-DD; submit refuses one that cannot be read.
    requestedAt: readDay(f.requestedAt).iso,
    receivedAt: readDay(f.receivedAt).iso,
    expectedBy: readDay(f.expectedBy).iso,
    notes: f.notes.trim() || null,
  };
}

/** Where a row stands, in one line: its status and the date that goes with it ("asked for 2025-07-01"). */
export function statusDate(r: Pick<RecordRow, 'status' | 'requestedAt' | 'receivedAt'>): string | null {
  if (r.status === 'received') return r.receivedAt;
  if (r.status === 'requested') return r.requestedAt;
  return null;
}

/** "Yes, images" / "No" / null when nothing is known. */
function heldWords(r: Pick<RecordRow, 'held' | 'heldForm'>): string {
  if (!r.held) return 'No';
  return r.heldForm ? `Yes: ${HELD_COPY_WORDS[r.heldForm] ?? r.heldForm}` : 'Yes';
}

/** The key facts that are known, in plain words; an unknown one is left out, never shown as a dash. */
export function recordFacts(r: RecordRow, gap?: Gap | null): KeyFact[] {
  const out: Array<KeyFact | null> = [
    { label: 'Type', value: recordTypeWords(r.recordType) },
    r.recordDate || r.recordDateText ? { label: 'Date', value: <DateText iso={r.recordDate} precision={r.recordDatePrecision} text={r.recordDateText} /> } : null,
    r.institutionName || r.institutionId ? { label: 'From', value: r.institutionId ? <Link to="/people" search={{ id: r.institutionId }}>{r.institutionName ?? 'Open'}</Link> : r.institutionName } : null,
    r.system ? { label: 'Kept in', value: r.system } : null,
    r.format && r.format !== 'unknown' ? { label: 'Format', value: RECORD_FORMAT_WORDS[r.format] ?? r.format } : null,
    { label: 'Your copy', value: heldWords(r) },
    r.documentId ? { label: 'Document', value: <Link to="/documents/$id" params={{ id: r.documentId }}>{r.documentTitle ?? 'Open the document'}</Link>, wide: true } : null,
    r.requestedAt ? { label: 'Asked for on', value: <DateText iso={r.requestedAt} /> } : null,
    r.receivedAt ? { label: 'Received on', value: <DateText iso={r.receivedAt} /> } : null,
    r.expectedBy ? { label: 'Expected by', value: <DateText iso={r.expectedBy} /> } : null,
    r.sourceFactId ? { label: 'Mentioned in', value: <Link to="/facts" search={{ id: r.sourceFactId }}>The detail that mentions it</Link>, wide: true } : null,
    gap?.matchedRecordId ? { label: 'Possible duplicate', value: <Link to="/records" search={{ id: gap.matchedRecordId }}>A row you have looks like this one</Link>, wide: true } : null,
  ];
  return out.filter((f): f is KeyFact => Boolean(f));
}

/**
 * The row's actions in order of importance, by where it stands: while you wait for it, Mark received (outlined) and
 * Mark asked for; once you have it, Open the document. Under More: the other answers (They have none, Refused), Edit,
 * and Remove from the checklist (asks first). Every one is held back while the form has unsaved edits.
 */
export function recordDetailActions(r: RecordRow, actions: RecordActions, locked: boolean): ActionBarProps {
  const have = r.status === 'received';
  return {
    primary: have
      ? r.documentId && actions.openDocument
        ? { label: 'Open the document', onClick: () => actions.openDocument!(r.documentId!), shortcut: 'enter', title: 'The copy you have, in Documents' }
        : null
      : { label: 'Mark received…', onClick: actions.receive, shortcut: 'i', disabled: locked, title: 'You have it now: say when, and which document is the copy' },
    secondary: [have ? null : { label: r.status === 'requested' ? 'Asked again today' : 'Mark asked for', onClick: () => actions.transition('request'), shortcut: 'r', disabled: locked, title: 'You asked for it today' }],
    more: [
      { label: 'They have none', onClick: () => actions.transition('not-held'), shortcut: 'h', disabled: locked, hidden: r.status === 'not_held', title: 'The place you asked says it has no such record' },
      { label: 'They refused', onClick: () => actions.transition('denied'), shortcut: 'x', disabled: locked, hidden: r.status === 'denied', title: 'The place you asked refused to send it' },
      have ? { label: 'Mark received again…', onClick: actions.receive, shortcut: 'i', disabled: locked, title: 'Change the date or the document of the copy you have' } : null,
      actions.edit ? { label: 'Edit', onClick: actions.edit, shortcut: 'e', title: 'Change the name, type, dates or notes (the form below)' } : null,
      'separator',
      { label: 'Remove from the checklist…', onClick: actions.remove, shortcut: 'Delete', danger: true, disabled: locked, title: 'Hide this row (asks first; it is not erased)' },
    ],
  };
}

export interface RecordDetailProps {
  /** null = a new row. */
  record: RecordRow | null;
  /** When the row is shown from the Missing view, the gap context (likely held, twin). */
  gap?: Gap | null;
  institutions: PersonLite[];
  documents: DocumentLite[];
  busy: boolean;
  actions: RecordActions;
  onSave: (body: RecordInput) => Promise<void>;
  onCancelNew?: () => void;
  note?: string | null;
  /** Told whenever the form gains or loses unsaved edits (and false on unmount). Pass a stable function. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The checklist row. The parent keys this component on `${id}:${updatedAt}` so the form re-seeds whenever the server
 * row changes. A re-seed would drop unsaved edits, so while the form is dirty the status actions are disabled here and
 * refused by the page (which learns the state through `onDirtyChange`) until the edits are saved or discarded.
 */
export function RecordDetail({ record, gap, institutions, documents, busy, actions, onSave, onCancelNew, note, onDirtyChange }: RecordDetailProps) {
  const [form, setForm] = useState<FormState>(() => fromRecord(record));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = record === null;
  const locked = busy || (!isNew && dirty);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function discard() {
    setForm(fromRecord(record));
    setDirty(false);
    setError(null);
  }

  const parsedDate = useMemo(() => parsePartialDate(form.recordDateText), [form.recordDateText]);

  const institutionOptions = useMemo(() => {
    const opts = institutions.map((p) => ({ value: p.id, label: p.name }));
    if (form.institutionId && !institutions.some((p) => p.id === form.institutionId)) opts.unshift({ value: form.institutionId, label: record?.institutionName ?? 'The place on this record' });
    return opts;
  }, [institutions, form.institutionId, record?.institutionName]);

  const documentOptions = useMemo(() => {
    const opts = documents.map((d) => ({ value: d.id, label: `${d.documentDate ? `${d.documentDate} · ` : ''}${d.title}` }));
    if (form.documentId && !documents.some((d) => d.id === form.documentId)) opts.unshift({ value: form.documentId, label: record?.documentTitle ?? 'The linked document' });
    return opts;
  }, [documents, form.documentId, record?.documentTitle]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.title.trim()) {
      setError('Give the record a name.');
      return;
    }
    const unread = ([['Asked for on', form.requestedAt], ['Received on', form.receivedAt], ['Expected by', form.expectedBy]] as const).find(([, v]) => !readDay(v).ok);
    if (unread) {
      setError(`${unread[0]}: type the day as 2026-10-20.`);
      return;
    }
    try {
      await onSave(toInput(form));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const when = record ? statusDate(record) : null;

  return (
    <DetailPane label={isNew ? 'New record' : 'Record'} className="records-detail">
      <FilingNotice targetType="record" targetId={record?.id} />
      {isNew ? (
        <DetailHeader eyebrow={<span>Records checklist</span>} title="Add a record" status="Name the record and say where it stands. Only the name is needed; the rest can wait." />
      ) : (
        <DetailHeader
          eyebrow={
            <>
              <span className="records-eyebrow-kind">{recordTypeWords(record.recordType)}</span>
              {gap?.kind === 'inventory' ? <span>on the checklist, not in hand</span> : null}
            </>
          }
          title={record.title}
          status={[
            <span key="status" className="records-status">
              <RecordStatus status={record.status} />
              {when ? <DateText iso={when} /> : null}
            </span>,
            record.held ? <span key="held">you have a copy</span> : null,
            gap?.likelyHeldDocumentId ? (
              <Tag key="likely" tone="warn" title="A document already in the case may be this record (a guess)">
                maybe already here
              </Tag>
            ) : null,
            dirty ? (
              <span key="dirty" className="records-unsaved">
                unsaved changes
              </span>
            ) : null,
          ]}
          actions={recordDetailActions(record, actions, locked)}
          facts={recordFacts(record, gap)}
        />
      )}
      {note ? <div className="notice warn small">{note}</div> : null}
      {!isNew && gap?.likelyHeldDocumentId ? (
        <div className="notice small records-likely">
          <span>
            <Link to="/documents/$id" params={{ id: gap.likelyHeldDocumentId }}>
              {gap.likelyHeldDocumentTitle ?? 'A document in the case'}
            </Link>{' '}
            may be this record. It is a guess ({likelyBasis(gap)}): open it and check first.
          </span>
          <Button size="sm" variant="accent" disabled={locked} onClick={() => actions.receiveDocument(gap.likelyHeldDocumentId!)} title="Marks this row received, with that document as your copy; the notes say it came from the guess">
            Mark received with it
          </Button>
        </div>
      ) : null}
      {!isNew && dirty ? <p className="records-hint">Save or discard the edits below before changing where it stands.</p> : !isNew && record.documentId && record.status === 'received' ? <p className="records-hint">They have none and They refused unlink the document (after asking) and note it in the row.</p> : null}

      <Section title={isNew ? 'The record' : 'Edit the record'}>
        <form className="form records-form" onSubmit={submit}>
          <Field inline label="Name">
            <Input data-record-title autoFocus={isNew} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. MRI brain with contrast, report" />
          </Field>
          <Field inline label="Type">
            <Select value={form.recordType} onChange={(e) => set('recordType', e.target.value)} options={RECORD_TYPE_OPTIONS} />
          </Field>
          <Field inline label="Where it stands">
            <Select value={form.status} onChange={(e) => set('status', e.target.value)} options={RECORD_STATUS_OPTIONS} aria-label="Where it stands" />
          </Field>
          <Field inline label="From" hint={institutions.length ? 'The hospital, clinic or lab that holds it.' : 'No places are listed yet; add them under People and places.'}>
            <Select value={form.institutionId} onChange={(e) => set('institutionId', e.target.value)} options={institutionOptions} placeholder="Not given" />
          </Field>
          <Field inline label="Kept in" hint="Where it lives, e.g. MyChart, Epic Care Everywhere, paper.">
            <Input value={form.system} onChange={(e) => set('system', e.target.value)} placeholder="e.g. MyChart" />
          </Field>
          <Field inline label="Format">
            <Select value={form.format} onChange={(e) => set('format', e.target.value)} options={RECORD_FORMAT_OPTIONS} />
          </Field>
          <Field inline label="Your copy">
            <label className="row records-check">
              <input type="checkbox" checked={form.held} onChange={(e) => set('held', e.target.checked)} /> You have a copy
            </label>
          </Field>
          <Field inline label="Your copy is">
            <Select value={form.heldForm} onChange={(e) => set('heldForm', e.target.value)} options={HELD_FORMS.map((f) => ({ value: f, label: HELD_FORM_WORDS[f] }))} placeholder="Not said" />
          </Field>
          <Field inline label="Document" hint={documents.length ? 'The copy in the case, when you have one.' : 'No documents are listed yet.'}>
            <Select value={form.documentId} onChange={(e) => set('documentId', e.target.value)} options={documentOptions} placeholder="Not linked" />
          </Field>
          <Field inline label="Date of the record" hint={form.recordDateText ? (parsedDate.iso ? `Reads as ${formatPartialDate(parsedDate.iso, parsedDate.precision)}.` : 'Could not read this as a date; it is kept as written.') : 'As written is fine: 2024-03, March 2024, 3/11/24.'}>
            <Input value={form.recordDateText} onChange={(e) => set('recordDateText', e.target.value)} placeholder="e.g. 2024-03-18" />
          </Field>
          <div className="full records-dates">
            <div>
              <label htmlFor="records-asked">Asked for on</label>
              <DayInput id="records-asked" placeholder="YYYY-MM-DD" value={form.requestedAt} onChange={(v) => set('requestedAt', v)} />
              {dayHint(form.requestedAt) ? (
                <span className="hint">
                  <KeepDatesWhole text={dayHint(form.requestedAt)} />
                </span>
              ) : null}
            </div>
            <div>
              <label htmlFor="records-received">Received on</label>
              <DayInput id="records-received" placeholder="YYYY-MM-DD" value={form.receivedAt} onChange={(v) => set('receivedAt', v)} />
              {dayHint(form.receivedAt) ? (
                <span className="hint">
                  <KeepDatesWhole text={dayHint(form.receivedAt)} />
                </span>
              ) : null}
            </div>
            <div>
              <label htmlFor="records-expected">Expected by</label>
              <DayInput id="records-expected" placeholder="YYYY-MM-DD" value={form.expectedBy} onChange={(v) => set('expectedBy', v)} />
              {dayHint(form.expectedBy) ? (
                <span className="hint">
                  <KeepDatesWhole text={dayHint(form.expectedBy)} />
                </span>
              ) : null}
            </div>
          </div>
          <Field inline label="Notes">
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={4} />
          </Field>
          <div className="form-actions">
            <Button variant="primary" type="submit" disabled={busy || (!isNew && !dirty)}>
              {isNew ? 'Add to the checklist' : 'Save'}
            </Button>
            {isNew && onCancelNew ? <Button onClick={onCancelNew}>Cancel</Button> : null}
            {!isNew && dirty ? (
              <Button disabled={busy} onClick={discard}>
                Discard
              </Button>
            ) : null}
            {error ? <span className="error small">{error}</span> : null}
            <span className="records-hint">Enter in a field saves.</span>
          </div>
        </form>
      </Section>
      {!isNew ? (
        <p className="records-hint">
          Last changed <DateTimeText iso={record.updatedAt} />
        </p>
      ) : null}
    </DetailPane>
  );
}
