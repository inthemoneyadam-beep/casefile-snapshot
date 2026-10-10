/**
 * A record a document mentions that is not on the checklist (an inferred gap),
 * in the right pane of the Missing list: what it is, the passage that mentions
 * it, and the answers. Adding it to the checklist (the outlined action) keeps the
 * passage as its source; Mark asked for and Mark received add it first, then
 * mark it. A document already in the case that may be this record is offered as
 * a guess, said as one.
 */
import { Link } from '@tanstack/react-router';
import type { ActionBarProps } from '../../ui/ActionBar';
import { Button } from '../../ui/Button';
import { DateText } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { FactStatusTag, Tag } from '../../ui/StatusTag';
import type { Gap } from '../../api/records';
import type { RecordActions } from './RecordDetail';
import { likelyBasis } from './likely';
import { recordTypeWords } from './words';

/** Add to the checklist (outlined), Mark asked for, Mark received; the other answers under More. */
export function gapDetailActions(gap: Gap, actions: RecordActions, busy: boolean, onOpenPassage?: () => void): ActionBarProps {
  return {
    primary: { label: 'Add to the checklist', onClick: actions.materialize, shortcut: 'm', disabled: busy, title: 'Adds it as a missing record, keeping the passage that mentions it as its source' },
    secondary: [
      { label: 'Mark asked for', onClick: () => actions.transition('request'), shortcut: 'r', disabled: busy, title: 'Adds it to the checklist, asked for today' },
      { label: 'Mark received…', onClick: actions.receive, shortcut: 'i', disabled: busy, title: 'Adds it to the checklist as received; you can name the document that is the copy' },
    ],
    more: [
      onOpenPassage && gap.sourceDocumentId ? { label: 'Open the passage', onClick: onOpenPassage, shortcut: 'enter', title: 'The page that mentions it, with the passage marked' } : null,
      'separator',
      { label: 'They have none', onClick: () => actions.transition('not-held'), shortcut: 'h', disabled: busy, title: 'Adds it to the checklist, marked: the place says it has no such record' },
      { label: 'They refused', onClick: () => actions.transition('denied'), shortcut: 'x', disabled: busy, title: 'Adds it to the checklist, marked: the place refused to send it' },
    ],
  };
}

/** The key facts that are known; never an empty row. */
export function gapFacts(gap: Gap): KeyFact[] {
  const out: Array<KeyFact | null> = [
    { label: 'Type', value: recordTypeWords(gap.recordType) },
    gap.date || gap.dateText ? { label: 'Date', value: <DateText iso={gap.date} precision={gap.datePrecision} text={gap.dateText} /> } : null,
    gap.institution || gap.institutionId ? { label: 'From', value: gap.institutionId ? <Link to="/people" search={{ id: gap.institutionId }}>{gap.institution ?? 'Open'}</Link> : gap.institution } : null,
    gap.sourceDocumentId ? { label: 'Mentioned in', value: <Link to="/documents/$id" params={{ id: gap.sourceDocumentId }}>{gap.sourceDocumentTitle ?? 'Open the document'}</Link>, wide: true } : null,
    gap.factStatement ? { label: 'As Claude read it', value: <span className="muted">{gap.factStatement}</span>, wide: true } : null,
  ];
  return out.filter((f): f is KeyFact => Boolean(f));
}

export function GapDetail({ gap, actions, busy, onOpenPassage }: { gap: Gap; actions: RecordActions; busy: boolean; onOpenPassage?: () => void }) {
  const c = gap.citation;
  return (
    <DetailPane label="Missing record" className="records-detail">
      <DetailHeader
        eyebrow={
          <>
            <span className="records-eyebrow-kind">{recordTypeWords(gap.recordType)}</span>
            <span>mentioned in a document, not on the checklist</span>
          </>
        }
        title={gap.title}
        status={[
          gap.date ? <DateText key="date" iso={gap.date} precision={gap.datePrecision} text={gap.dateText} /> : null,
          <Tag key="missing" tone="warn" title="A document mentions this record, and it is not on your checklist yet">
            missing
          </Tag>,
          gap.factStatus && gap.factStatus !== 'unverified' ? (
            <span key="answer" className="records-status">
              Your answer: <FactStatusTag status={gap.factStatus} hideAutomatic />
            </span>
          ) : null,
          gap.likelyHeldDocumentId ? (
            <Tag key="likely" tone="warn" title="A document already in the case may be this record (a guess)">
              maybe already here
            </Tag>
          ) : null,
        ]}
        actions={gapDetailActions(gap, actions, busy, onOpenPassage)}
        facts={gapFacts(gap)}
      />

      {gap.likelyHeldDocumentId ? (
        <div className="notice small records-likely">
          <span>
            <Link to="/documents/$id" params={{ id: gap.likelyHeldDocumentId }}>
              {gap.likelyHeldDocumentTitle ?? 'A document in the case'}
            </Link>{' '}
            may be this record. It is a guess ({likelyBasis(gap)}): open it and check first. If it is, add it from that document; the row remembers this mention, so it is no longer missing.
          </span>
          <Button size="sm" variant="accent" disabled={busy} onClick={() => actions.fromDocument(gap.likelyHeldDocumentId!, gap.recordType, gap.sourceFactId)}>
            Add it from that document
          </Button>
        </div>
      ) : null}

      <Section title="Where it is mentioned">
        {c ? (
          <div className="stack tight">
            <blockquote className={`records-quote${c.verified ? ' verified' : ''}`}>{c.quote}</blockquote>
            <div className="row wrap small">
              <Link to="/documents/$id" params={{ id: c.documentId }} search={{ page: c.pageNumber, cite: c.citationId }}>
                {c.documentTitle ?? 'The document'}, page {c.pageNumber}
              </Link>
              {c.verified ? <span className="muted">Found word for word on the page.</span> : <Tag tone="warn">quote not found in the page text</Tag>}
            </div>
          </div>
        ) : (
          <p className="records-hint">This mention has no page reference.</p>
        )}
        {gap.sourceFactId ? (
          <p className="records-hint">
            <Link to="/facts" search={{ id: gap.sourceFactId }}>
              See it in Details from documents
            </Link>
          </p>
        ) : null}
      </Section>
      <p className="records-hint">Mark asked for, Mark received and the other answers add it to the checklist first, keeping this passage as its source.</p>
    </DetailPane>
  );
}
