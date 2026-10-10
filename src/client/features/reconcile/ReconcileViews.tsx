/**
 * The pieces of the Reconciliation page (routes/reconcile.tsx): one event
 * with its record and its mentions grouped by what they say, the actions that
 * bring the source of truth (upload the record, or use a document already
 * here after a plain warning), two clinical records that disagree (this one
 * is right, or both happened), one inaccurate bit of information beside what
 * the record says, and what a record just added did to its event. The rules
 * (which answers show, which documents are offered and in what order) are in
 * ./logic.ts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { formatPartialDate, type DatePrecision } from '@shared/dates';
import type { InaccurateItem, Mention, ReconcileEvent } from '@shared/reconcile';
import { Button } from '../../ui/Button';
import { DetailHeader, DetailPane, KeyFacts } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { DateText } from '../../ui/DateText';
import { Tag } from '../../ui/StatusTag';
import { CheckTag } from './CheckTag';
import { useToast } from '../../ui/Toast';
import { errorMessage } from '../../api/client';
import { useMe } from '../../api/users';
import { useDocument, useUploadDocuments } from '../../api/documents';
import { useDocumentsLite, useFact, useFactMutations, type DocumentLite } from '../../api/facts';
import { documentTypeLabel } from '../../api/filing';
import { useReconcileEventOrNull, useReconcileMutations } from '../../api/reconcile';
import { documentProgressWords } from '../home/progress';
import { UPLOAD_ACCEPT } from '../filing/Filing';
import { ReasonBox } from './ReasonBox';
import { NOT_COMPARED_TAG, UNDO_WORDS, answeredWithRecord, namesUncomparedRecord, UPLOAD_WORDS, bothHappenedTarget, eventDate, eventTag, inaccurateActions, inaccurateRecordWords, inaccurateUndo, isChosenValue, laterResetWords, notComparedWithRecord, offersRecordActions, officialWarning, otherReadingRecord, paneSentence, recordChoices, recordHereAdvice, recordMentions, recordsDisagree, trustSentence, uploadOutcome } from './logic';
import './reconcile.css';

export { eventDate };

/** What kind of detail an event is about, in plain words. */
export const TYPE_WORDS: Record<string, string> = { lab_result: 'lab value', imaging_result: 'scan', vital: 'vital sign', procedure: 'procedure', event: 'event' };

export function mentionWords(n: number, docs: number): string {
  return `${n} mention${n === 1 ? '' : 's'} in ${docs} document${docs === 1 ? '' : 's'}`;
}

/** The same for a list column: "12 in 4 documents" (mentionWords is the tooltip and the detail pane). */
export function mentionShort(n: number, docs: number): string {
  return `${n} in ${docs} document${docs === 1 ? '' : 's'}`;
}

/** A link to the page a mention was read from (with its quote highlighted). */
export function PageLink({ m, children }: { m: Pick<Mention, 'documentId' | 'page' | 'citationId'>; children?: ReactNode }) {
  if (!m.documentId) return <span className="faint">—</span>;
  return (
    <Link to="/documents/$id" params={{ id: m.documentId }} search={{ page: m.page ?? undefined, cite: m.citationId ?? undefined }} className="cite" onClick={(e) => e.stopPropagation()} title="Open the page it came from">
      {children ?? (m.page ? `p.${m.page}` : 'open')}
    </Link>
  );
}

function DocTitle({ m }: { m: Pick<Mention, 'documentId' | 'documentTitle' | 'page' | 'citationId'> }) {
  if (!m.documentId) return <span className="muted">{m.documentTitle ?? 'Entered by hand'}</span>;
  return (
    <Link to="/documents/$id" params={{ id: m.documentId }} search={{ page: m.page ?? undefined, cite: m.citationId ?? undefined }} title="Open the page it came from">
      {m.documentTitle ?? 'Untitled document'}
    </Link>
  );
}

/**
 * "Not compared: the lab report gives 112 mg/dL on 2024-03-18 (another unit)." (or a scan report's impression, in
 * its own words) under a mention the app could not compare with its record, with the record to open. Also the
 * user's own answer (Not sure, Only in a summary) on such a value: "Your answer: ... <record> gives ...".
 */
function NotComparedLine({ m }: { m: Mention }) {
  // Also a disagreement the record here could not settle (it gives the value in another unit): why, on its own line.
  if (!namesUncomparedRecord(m.trust) && !answeredWithRecord(m.trust)) return null;
  const s = trustSentence(m.trust);
  const docId = m.trust.recordDocumentId;
  return (
    <div className={`rc-mention-why trust-line ${m.trust.trust}`}>
      <strong>{s.label}:</strong> {s.rest}
      {docId ? (
        <>
          {' '}
          <Link to="/documents/$id" params={{ id: docId }} className="xs" onClick={(e) => e.stopPropagation()} title={`Open ${m.trust.recordDocumentTitle ?? 'the record'}`}>
            open the record
          </Link>
        </>
      ) : null}
    </div>
  );
}

/** One mention: its document and page, its date and check, the sentence it came from, and an optional action. */
function MentionRow({ m, action, below }: { m: Mention; action?: ReactNode; below?: ReactNode }) {
  return (
    <div className="rc-mention">
      <div className="rc-mention-doc">
        <span className="rc-mention-title">
          <DocTitle m={m} />
        </span>
        {m.page ? <PageLink m={m} /> : null}
        <DateText iso={m.date} precision={m.datePrecision} text={m.dateText} />
        <CheckTag trust={m.trust} />
      </div>
      <div className="rc-mention-actions">{action}</div>
      <div className="rc-mention-statement">{m.statement}</div>
      <NotComparedLine m={m} />
      {below}
    </div>
  );
}

/**
 * "This one is right": the patient's own word makes this mention the truth
 * for the event (with a reason). On a clinical record it chooses between two
 * records that disagree.
 */
function ThisOneIsRight({ m, record = false, title }: { m: Mention; record?: boolean; title?: string }) {
  const rc = useReconcileMutations();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const canWrite = useMe().canWrite;
  // A correction stands for one day: a month- or year-only mention cannot.
  if (!canWrite || m.datePrecision !== 'day') return null;
  return asking ? (
    <ReasonBox
      title={`This one is right: ${m.says}`}
      placeholder={record ? 'Why this record is right and the other one is not' : 'Why this one is right'}
      busy={rc.correct.isPending}
      onCancel={() => setAsking(false)}
      onSave={(reason) =>
        rc.correct.mutate(
          { factId: m.factId, reason },
          {
            onSuccess: () => {
              toast('Saved. Your word settles this event; every other mention is compared with it.', 'ok');
              setAsking(false);
            },
            onError: (err) => toast(errorMessage(err, 'Could not save it'), 'bad'),
          },
        )
      }
    />
  ) : (
    // A consequential answer, so a real (bordered) button, never words that look like plain text.
    <Button
      size="sm"
      onClick={() => setAsking(true)}
      title={title ?? (record ? 'This record is the right one: it settles the event, and the other record is shown as wrong here (never changed). A reason is required.' : 'No record to upload? Your own word can settle it, when you know the clinical record is wrong or missing. A reason is required.')}
    >
      This one is right
    </Button>
  );
}

/**
 * It's wrong on one value of an event whose documents disagree while the record of that day is here but could not
 * settle them (it gives the value in another unit): the facts verdict (disputed), as the Override's It's wrong. The
 * value stays on file, set aside; the others are compared with the record again.
 */
function ItsWrong({ m, title }: { m: Mention; title: string }) {
  const facts = useFactMutations();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  if (!canWrite) return null;
  return (
    <Button
      size="sm"
      disabled={facts.verdict.isPending}
      onClick={() =>
        facts.verdict.mutate(
          { id: m.factId, status: 'disputed', basis: null },
          { onSuccess: () => toast('Marked wrong. It stays on file, set aside; the clinician will not rely on it.', 'ok'), onError: (err) => toast(errorMessage(err, 'That did not work'), 'bad') },
        )
      }
      title={title}
    >
      It's wrong
    </Button>
  );
}

export interface UploadedRecord {
  documentId: string;
  title: string;
  /** What it was added for ("Lumbar puncture around 2024-03-18"). */
  forWhat: string;
  /** The event it was added for, re-read once the record is read. */
  eventKey: string;
  /** A few of the event's mentions: when the event's key moves (it takes the record's date), one of them says where it went. */
  factIds: string[];
}

/** One document in the chooser: its title, its type and its date. */
function choiceLabel(d: DocumentLite): string {
  const when = d.documentDate ? formatPartialDate(d.documentDate, (d.documentDatePrecision as DatePrecision | null) ?? null) : 'no date';
  return `${d.title} · ${documentTypeLabel(d.category)} · ${when}`;
}

/**
 * The two ways to bring the source of truth for an event: upload the record
 * (marked as an official record at once; Claude reads it and every mention
 * is compared with it), or pick a document already in the case, after a
 * plain warning that every detail in it becomes the truth. `secondary` when
 * two clinical records already disagree: choosing between them comes first.
 */
export function RecordActions({ event, onUploaded, secondary = false, quiet = false }: { event: ReconcileEvent; onUploaded: (u: UploadedRecord) => void; secondary?: boolean; quiet?: boolean }) {
  const canWrite = useMe().canWrite;
  const upload = useUploadDocuments();
  const rc = useReconcileMutations();
  const docs = useDocumentsLite();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState('');
  const [confirming, setConfirming] = useState(false);
  const choices = useMemo(() => recordChoices(docs.data ?? [], event, q), [docs.data, event, q]);
  useEffect(() => setConfirming(false), [pick]);
  if (!canWrite) return null;
  const forWhat = `${event.subject} ${event.dateLabel}`;
  const factIds = event.groups.flatMap((g) => g.mentions.map((m) => m.factId)).slice(0, 5);
  const picked = (docs.data ?? []).find((x) => x.id === pick) ?? null;

  async function addFiles(files: File[]) {
    if (!files.length) return;
    try {
      const r = await upload.mutateAsync({ files });
      for (const d of r.items) {
        await rc.official.mutateAsync(d.id);
        onUploaded({ documentId: d.id, title: d.title, forWhat, eventKey: event.key, factIds });
      }
      toast(r.items.length === 1 ? 'Added as an official record. Claude is reading it; the line at the top of this page says what it settled when that is done.' : `Added ${r.items.length} files as official records. Claude is reading them; the lines at the top of this page say what each settled.`, 'ok');
    } catch (err) {
      toast(errorMessage(err, 'The upload did not work'), 'bad');
    }
  }

  function useExisting() {
    const d = picked;
    if (!d) return;
    rc.official.mutate(d.id, {
      onSuccess: () => {
        toast(`${d.title} is now an official record.`, 'ok');
        onUploaded({ documentId: d.id, title: d.title, forWhat, eventKey: event.key, factIds });
        setPick('');
        setQ('');
        setConfirming(false);
      },
      onError: (err) => toast(errorMessage(err, 'Could not mark it'), 'bad'),
    });
  }

  const busy = upload.isPending || rc.official.isPending;
  const option = (d: DocumentLite) => (
    <option key={d.id} value={d.id}>
      {choiceLabel(d)}
    </option>
  );
  return (
    <div className="rc-source">
      <div className="rc-source-row">
        <Button
          variant={secondary || quiet ? 'default' : 'primary'}
          shortcut="u"
          disabled={busy}
          onClick={() => input.current?.click()}
          title="Choose the clinical record (the lab report, procedure note, scan report) from this computer. It is marked as an official record and settles every mention at once."
        >
          {upload.isPending ? 'Adding…' : secondary ? 'Upload a third record' : 'Upload the record'}
        </Button>
        <input
          ref={input}
          data-rc-upload
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          accept={UPLOAD_ACCEPT}
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <span className="small muted">from this computer</span>
      </div>
      <div className="rc-source-pick">
        <span className="rc-source-label" id={`rc-pick-${event.key}`}>
          Or use a document already in the case
        </span>
        <div className="rc-source-row">
          <input type="search" aria-label="Narrow the list of documents" placeholder="Type to narrow the list" value={q} onChange={(e) => setQ(e.target.value)} />
          <select data-rc-pick aria-labelledby={`rc-pick-${event.key}`} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{docs.isPending ? 'Loading documents…' : 'Choose the document that settles this'}</option>
            {choices.likely.length ? <optgroup label="Likely records: lab reports, clinic notes, scan reports">{choices.likely.map(option)}</optgroup> : null}
            {choices.other.length ? <optgroup label="Other documents">{choices.other.map(option)}</optgroup> : null}
            {choices.mentioned.length ? <optgroup label="Documents that disagree here (rarely the record)">{choices.mentioned.map(option)}</optgroup> : null}
          </select>
          <Button disabled={!picked || busy} aria-expanded={confirming} onClick={() => setConfirming(true)} title="This document is a clinical record: what it states settles every mention of it. You are asked to confirm first.">
            Use this as the record
          </Button>
        </div>
      </div>
      {confirming && picked ? (
        <div
          className="rc-confirm"
          role="alertdialog"
          aria-label="Use this document as an official record?"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            e.preventDefault();
            setConfirming(false);
          }}
        >
          <span className="grow">{officialWarning(picked.title)}</span>
          <span className="row">
            <Button size="sm" variant="primary" disabled={busy} onClick={useExisting}>
              {rc.official.isPending ? 'Saving…' : 'Confirm'}
            </Button>
            <Button size="sm" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A record added from this page (uploaded, or a document already here): its
 * reading, then what it did to the event it was added for. The event is read
 * again by its key; if it still needs a source, that is said plainly (never
 * "checked" as if it settled), with the document to open.
 */
export function UploadProgress({ u, onDismiss }: { u: UploadedRecord; onDismiss: () => void }) {
  const doc = useDocument(u.documentId);
  const qc = useQueryClient();
  const d = doc.data;
  const failed = Boolean(d && (d.textStatus === 'failed' || d.extractionStatus === 'failed'));
  const ready = Boolean(d && d.extractionStatus === 'done' && !['pending', 'extracting', 'ocr_running'].includes(d.textStatus));
  const was = useRef(ready);
  useEffect(() => {
    // Once its details are read, the comparison has new facts: refresh the lists and this event.
    if (ready && !was.current) void qc.invalidateQueries({ queryKey: ['reconcile'] });
    was.current = ready;
  }, [ready, qc]);
  const ev = useReconcileEventOrNull(u.eventKey, ready);
  // A settled event takes the record's date, so its key can move: one of its mentions says where it went.
  const moved = ready && (ev.isError || (ev.isSuccess && ev.data === null));
  const firstFact = u.factIds[0] ?? null;
  const mention = useFact(moved ? firstFact : null);
  const outcome = uploadOutcome({
    ready,
    failed,
    documentId: u.documentId,
    event: ev.isSuccess ? ev.data : ev.isError ? null : undefined,
    mentionTrust: !moved ? undefined : !firstFact || mention.isError ? null : mention.isSuccess ? (mention.data.trust ?? null) : undefined,
  });
  const words = d ? documentProgressWords(d.textStatus, d.extractionStatus) : 'Reading…';
  const stillNeeds = outcome === 'unsettled' || outcome === 'disagree';
  return (
    <div className={`rc-upload${stillNeeds ? ' unsettled' : ''}`} role="status">
      <span className="grow">
        <strong>{d?.title ?? u.title}</strong> <span className="muted">for {u.forWhat}, marked as an official record.</span>
        {outcome !== 'reading' ? <span className="rc-upload-outcome">{UPLOAD_WORDS[outcome]}</span> : null}
      </span>
      {outcome === 'reading' || outcome === 'failed' ? (
        <Tag tone={outcome === 'failed' ? 'bad' : 'info'}>{words}</Tag>
      ) : outcome === 'settled' ? (
        <Tag tone="ok">settled</Tag>
      ) : stillNeeds ? (
        <Tag tone="warn">still needs a source</Tag>
      ) : null}
      <Link to="/documents/$id" params={{ id: u.documentId }} className="xs" title="Open the record">
        Open it
      </Link>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** Two clinical records disagree: each with what it says and This one is right, and Both happened when they can be kept apart. */
function RecordsDisagree({ event }: { event: ReconcileEvent }) {
  const rc = useReconcileMutations();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const records = recordMentions(event);
  const target = bothHappenedTarget(event);
  return (
    <Section
      title="Two clinical records disagree"
      className="rc-disagree"
      intro={
        canWrite
          ? target
            ? 'Choose the one that is right with This one is right (a reason is needed), or Both happened if they are separate readings or separate occasions.'
            : 'Choose the one that is right with This one is right (a reason is needed), or add a third record that settles it.'
          : undefined
      }
    >
      {records.map((m) => (
        <MentionRow key={m.factId} m={m} action={<ThisOneIsRight m={m} record />} below={<div className="rc-mention-says">says <span className="rc-says">{m.says}</span></div>} />
      ))}
      {canWrite && target ? (
        <div className="row wrap">
          <Button
            size="sm"
            disabled={rc.busy}
            onClick={() =>
              rc.separate.mutate(target.factId, {
                onSuccess: () => toast('Kept both: they are treated as separate readings or separate occasions.', 'ok'),
                onError: (err) => toast(errorMessage(err, 'That did not work'), 'bad'),
              })
            }
            title="Keep both: they are separate readings or separate occasions"
          >
            Both happened
          </Button>
          <span className="small muted">Keep both: they are separate readings or separate occasions.</span>
        </div>
      ) : null}
    </Section>
  );
}

/** What kind of detail an event is about, as the small line above its title. */
const KIND_WORDS: Record<string, string> = { lab_result: 'Lab value', imaging_result: 'Scan', vital: 'Vital sign', procedure: 'Procedure', event: 'Event' };

/** A link drawn as a small text button (a page to open is a link, so it can also open in a new tab). */
function LinkButton({ m, children, variant = 'default', title }: { m: Pick<Mention, 'documentId' | 'page' | 'citationId'>; children: ReactNode; variant?: 'default' | 'accent'; title?: string }) {
  if (!m.documentId) return null;
  return (
    <Link to="/documents/$id" params={{ id: m.documentId }} search={{ page: m.page ?? undefined, cite: m.citationId ?? undefined }} className={`btn sm${variant === 'accent' ? ' accent' : ''} rc-link-btn`} title={title}>
      {children}
    </Link>
  );
}

/**
 * One event, in the order a reader needs it: what it is and where it stands (the header), the sentence that says what
 * to do, the record that settles it (when there is one), the two records that disagree (when they do), how to settle
 * it (Upload the record, or a document already here), then what each document says, grouped by value. On a settled
 * event the documents that differ from the record are listed open, by name; those that agree are folded.
 */
export function EventDetail({ event, onUploaded }: { event: ReconcileEvent; onUploaded: (u: UploadedRecord) => void }) {
  const settled = event.state === 'settled';
  const record = event.record;
  const disagree = event.state === 'needs_source' && recordsDisagree(event);
  const recordIds = new Set(disagree ? recordMentions(event).map((m) => m.factId) : []);
  const tag = eventTag(event);
  // Documents disagree while the record here could not settle them: one piece of advice for the sentence, the line
  // above the mentions and the buttons (It's wrong on a value that does not match the record, This one is right on
  // the one that does).
  const advice = recordHereAdvice(event);
  // A tag, not a cause: why each one was not compared differs (another unit, only the month, a scan worded otherwise).
  const ncTag = (g: ReconcileEvent['groups'][number]) =>
    g.mentions.some((m) => notComparedWithRecord(m.trust)) ? (
      <span className="muted small" title={NOT_COMPARED_TAG.title}>
        {NOT_COMPARED_TAG.label}
      </span>
    ) : null;
  const marked = (g: ReconcileEvent['groups'][number]) => g.mentions.some((m) => m.trust.trust === 'inaccurate');
  // A group giving another value than the record is listed open, whatever its checks say, so nothing that differs is folded away.
  const differs = (g: ReconcileEvent['groups'][number]) => marked(g) || Boolean(record && g.says.trim() !== record.says.trim());
  const recordLabel = record ? (record.trust.byUser ? (record.documentTier === 'primary' ? 'The record you chose' : isChosenValue(record.trust) ? 'The value you chose' : 'Your correction') : 'The record') : '';
  const sentence = paneSentence(event);
  return (
    <DetailPane label="Event" className="rc-detail">
      <DetailHeader
        eyebrow={
          <>
            <Tag tone={tag.tone}>{tag.label}</Tag>
            <span>{KIND_WORDS[event.type] ?? TYPE_WORDS[event.type] ?? event.type}</span>
          </>
        }
        title={event.subject}
        status={[<span key="when" className="mono">{event.dateLabel}</span>, <span key="n">{mentionWords(event.mentionCount, event.documentCount)}</span>]}
        actions={
          settled && record?.documentId ? (
            <LinkButton m={record} variant="accent" title="The page of the record that settles this, with the passage marked">
              Open the record
            </LinkButton>
          ) : undefined
        }
      />
      {/* One explanation per tab: the line under the toolbar says what the plain cases mean, so the pane says only what
          is particular to this event (records disagree, a record here that could not settle it, not compared). */}
      {sentence ? <p className="rc-sentence">{sentence}</p> : null}

      {record ? (
        <Section title={recordLabel}>
          <div className="rc-record">
            <div className="rc-record-says">
              <span className="rc-says big">{record.says}</span>
              <CheckTag trust={record.trust} />
            </div>
            <div className="rc-mention-doc">
              <span className="rc-mention-title">
                <DocTitle m={record} />
              </span>
              {record.page ? <PageLink m={record} /> : null}
            </div>
            <div className="rc-mention-statement">{record.statement}</div>
          </div>
        </Section>
      ) : null}

      {disagree ? <RecordsDisagree event={event} /> : null}
      {/* Never "Upload the record" where a record is already here (logic.ts offersRecordActions). */}
      {offersRecordActions(event) ? (
        <Section
          title={disagree ? 'Or settle it with a third record' : event.state === 'needs_source' ? 'Settle it' : 'Check it against the record (optional)'}
        >
          <RecordActions event={event} onUploaded={onUploaded} secondary={disagree} quiet={event.state !== 'needs_source'} />
        </Section>
      ) : null}

      <Section
        title="What each document says"
        count={event.groups.reduce((n, g) => n + g.mentions.length, 0) || undefined}
        intro={event.state === 'needs_source' && !disagree ? (advice ? advice.footer : 'This one is right: use your own word only to correct a clinical mistake, when the record is wrong or cannot be had.') : undefined}
      >
        {event.groups.map((g) =>
          settled ? (
            <details key={g.says} className="rc-group" open={differs(g)}>
              <summary className="rc-group-head">
                <span>
                  Says <span className="rc-says">{g.says}</span>
                </span>
                <span className="n">
                  {g.mentions.length} mention{g.mentions.length === 1 ? '' : 's'}
                </span>
                {marked(g) ? (
                  <span className="rc-bad small">differs from the record: marked inaccurate</span>
                ) : otherReadingRecord(event, g) ? (
                  // Two lab reports can each give a reading of one day: the value stands as a second reading, and these
                  // mentions match it, which is why their checks are green.
                  <span className="rc-ok small" title="Two clinical records give a reading of this test on the same day (two samples, or two runs). Each is kept as its own reading; these mentions match this one, so their checks say verified or accurate.">
                    a second reading that day, from {otherReadingRecord(event, g)!.title}; these match it
                  </span>
                ) : differs(g) ? (
                  <span className="rc-warn small">a different value from the record; each one's check says why</span>
                ) : (
                  <span className="muted small">agrees with the record</span>
                )}
                {ncTag(g)}
              </summary>
              {g.mentions.map((m) => (
                <MentionRow key={m.factId} m={m} />
              ))}
            </details>
          ) : (
            <div key={g.says} className="rc-group">
              <div className="rc-group-head">
                <span>
                  Says <span className="rc-says">{g.says}</span>
                </span>
                <span className="n">
                  {g.mentions.length} mention{g.mentions.length === 1 ? '' : 's'}
                </span>
                {ncTag(g)}
              </div>
              {g.mentions.map((m) => (
                // Two records disagree: the choice is made between the records above, not on each mention.
                <MentionRow
                  key={m.factId}
                  m={m}
                  action={
                    event.state === 'needs_source' && !disagree ? (
                      <>
                        <ThisOneIsRight m={m} title={advice?.rightTitle} />
                        {advice && m.trust.trust === 'conflict' && !m.trust.byUser ? <ItsWrong m={m} title={advice.wrongTitle} /> : null}
                      </>
                    ) : null
                  }
                  below={recordIds.has(m.factId) ? <div className="muted small">A clinical record (see above).</div> : undefined}
                />
              ))}
            </div>
          ),
        )}
      </Section>
    </DetailPane>
  );
}

/**
 * One inaccurate bit of information: what this document says beside what the record says (stacked, so neither is
 * squeezed), why, the sentence as written, then the answers that apply to it (./logic.ts inaccurateActions), each
 * with what it does: it's actually right, not the same event, the record is wrong, undo my correction, back to
 * automatic.
 */
export function InaccurateDetail({ item, asking, setAsking, onShowEvent }: { item: InaccurateItem; asking: boolean; setAsking: (v: boolean) => void; onShowEvent?: () => void }) {
  const rc = useReconcileMutations();
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const t = item.trust;
  const rec = item.record;
  // What it is compared with: the record, the user's correction, the record they chose, the value they chose, or
  // (on an older correction of theirs) their later correction; and the why in the same words.
  const words = inaccurateRecordWords(item);
  const acts = inaccurateActions(item);
  const undoKind = inaccurateUndo(item);
  const undo = undoKind ? UNDO_WORDS[undoKind] : null;
  const laterReset = laterResetWords(item);
  const ok = (msg: string) => () => {
    toast(msg, 'ok');
    setAsking(false);
  };
  const fail = (err: unknown) => toast(errorMessage(err, 'That did not work'), 'bad');
  const busy = rc.busy;
  const answers = canWrite && (acts.keep || acts.separate || acts.wrong || (acts.undoCorrection && rec && undo) || acts.reset);
  return (
    <DetailPane label="Inaccurate detail" className="rc-detail">
      <DetailHeader
        eyebrow={
          <>
            <CheckTag trust={t} />
            <span>{KIND_WORDS[(item.event.key ?? '').split('|')[0]] ?? 'Detail'}</span>
          </>
        }
        title={item.event.subject}
        status={
          <>
            <span className="mono">{item.event.dateLabel}</span>
          </>
        }
        actions={
          <>
            <LinkButton m={item} title="The page this detail was read from, with the passage marked">
              Open the page
            </LinkButton>
            {onShowEvent && item.event.key ? (
              <Button size="sm" onClick={onShowEvent} title="Every mention of this event, with its record">
                See the whole event
              </Button>
            ) : null}
          </>
        }
      />

      <div className="rc-compare-cards">
        <div className="rc-compare-card wrong">
          <div className="rc-compare-label">{item.documentTitle ?? 'This detail'} says</div>
          <div className="rc-compare-value">
            <span className="rc-says big">{item.says}</span> <PageLink m={item} />
          </div>
        </div>
        {rec ? (
          <div className="rc-compare-card record">
            <div className="rc-compare-label">{words.label}</div>
            <div className="rc-compare-value">
              <span className="rc-says big">{rec.says}</span> <PageLink m={rec} />
            </div>
          </div>
        ) : null}
      </div>
      <KeyFacts
        items={[
          words.why ? { label: 'Why', value: words.why, wide: true } : null,
          { label: 'As written', value: <span className="muted">{item.statement}</span>, wide: true },
        ]}
      />
      {answers ? (
        <Section title="Your answer">
          <div className="rc-answers">
            {acts.keep ? (
              <div className="rc-answer">
                <Button shortcut="a" disabled={busy} onClick={() => rc.keep.mutate(item.factId, { onSuccess: ok('Kept as accurate. It is no longer listed here.'), onError: fail })} title="You checked: this document is right here. It is kept as accurate whatever the record says.">
                  It's actually right
                </Button>
                <span className="rc-answer-words">You checked: this document is right here, whatever the record says.</span>
              </div>
            ) : null}
            {acts.separate ? (
              <div className="rc-answer">
                <Button shortcut="x" disabled={busy} onClick={() => rc.separate.mutate(item.factId, { onSuccess: ok('Marked as another occasion. It is compared on its own date only from now on.'), onError: fail })} title="It is about another occasion (another test, another day): compare it on its own date only.">
                  Not the same event
                </Button>
                <span className="rc-answer-words">It is about another occasion (another test, another day).</span>
              </div>
            ) : null}
            {acts.wrong ? (
              <div className="rc-answer">
                <Button shortcut="w" aria-expanded={asking} disabled={busy} onClick={() => setAsking(!asking)} title="Your own word corrects a clinical mistake: this document's version is used, and the record is shown as wrong here (never changed).">
                  The record is wrong
                </Button>
                <span className="rc-answer-words">Your own word corrects a clinical mistake; a reason is needed. The record itself is never changed.</span>
              </div>
            ) : null}
            {acts.undoCorrection && rec && undo ? (
              <div className="rc-answer">
                <Button variant="ghost" disabled={busy} onClick={() => rc.reset.mutate(rec.factId, { onSuccess: ok(undo.done), onError: fail })} title={undo.title}>
                  {undo.label}
                </Button>
                <span className="rc-answer-words">{undo.title}</span>
              </div>
            ) : null}
            {acts.reset ? (
              <div className="rc-answer">
                <Button variant="ghost" disabled={busy} onClick={() => rc.reset.mutate(item.factId, { onSuccess: ok(laterReset?.done ?? 'Back to automatic'), onError: fail })} title={laterReset?.title ?? 'Forget your answer and let the app compare it with the records again.'}>
                  Back to automatic
                </Button>
                <span className="rc-answer-words">{laterReset?.title ?? 'Forget your answer and let the app compare it with the records again.'}</span>
              </div>
            ) : null}
          </div>
          {asking && acts.wrong ? (
            <ReasonBox title="The record is wrong" busy={rc.correct.isPending} onCancel={() => setAsking(false)} onSave={(reason) => rc.correct.mutate({ factId: item.factId, reason }, { onSuccess: ok('Saved. This version is used for the event; the record is kept as written and shown as wrong here.'), onError: fail })} />
          ) : null}
        </Section>
      ) : null}
    </DetailPane>
  );
}
