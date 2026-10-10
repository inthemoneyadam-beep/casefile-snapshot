import { Link } from '@tanstack/react-router';
import { FilingNotice } from '../filing/Filing';
import { useCommunication, type Communication } from '../../api/communications';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/StatusTag';
import { DateText, DateTimeText, KeepDatesWhole } from '../../ui/DateText';
import { DetailHeader, DetailPane, KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { EmptyState, Loading, Section } from '../../ui/PageHeader';
import type { ActionBarProps } from '../../ui/ActionBar';
import { DIRECTION_HINT, ROLE_WORDS, channelWords, directionWords } from '../people/shared';

export interface CommunicationDetailProps {
  id: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFollowUp: () => void;
  /** Open the document it came from (o). */
  onOpenDocument?: () => void;
  busy?: boolean;
}

/** Where a promised follow-up stands: 'open', 'overdue', 'done', or null when nothing was promised. */
export function followUpState(c: Pick<Communication, 'followUpPromised' | 'followUpDoneAt' | 'overdue'>): 'open' | 'overdue' | 'done' | null {
  if (!c.followUpPromised) return null;
  if (c.followUpDoneAt) return 'done';
  return c.overdue ? 'overdue' : 'open';
}

/** The follow-up as a tag (lists and the status line); nothing when none was promised. */
export function FollowUpTag({ c, long = false }: { c: Pick<Communication, 'followUpPromised' | 'followUpDoneAt' | 'overdue'>; long?: boolean }) {
  const s = followUpState(c);
  if (!s) return null;
  if (s === 'done') return <Tag tone="ok">{long ? 'follow-up done' : 'done'}</Tag>;
  if (s === 'overdue') return <Tag tone="bad">{long ? 'follow-up overdue' : 'overdue'}</Tag>;
  return <Tag tone="warn">{long ? 'follow-up open' : 'open'}</Tag>;
}

/** The pane's actions: the follow-up when one is open, and Edit; under More the document (also linked in the facts), Reopen and Delete. */
export function communicationActions(c: Communication, p: Pick<CommunicationDetailProps, 'onEdit' | 'onDelete' | 'onToggleFollowUp' | 'onOpenDocument' | 'busy'>): ActionBarProps {
  const s = followUpState(c);
  return {
    primary: s === 'open' || s === 'overdue' ? { label: 'Mark the follow-up done', onClick: p.onToggleFollowUp, shortcut: 'f', disabled: p.busy, title: 'What was promised has happened' } : null,
    secondary: [{ label: 'Edit', onClick: p.onEdit, shortcut: 'e', title: 'Change the date, who took part, the summary or the follow-up' }],
    more: [
      c.documentId && p.onOpenDocument ? { label: 'Open the document', onClick: p.onOpenDocument, shortcut: 'o', title: 'The message or call record this came from' } : null,
      s === 'done' ? { label: 'Reopen the follow-up', onClick: p.onToggleFollowUp, shortcut: 'f', disabled: p.busy, title: 'It has not happened after all' } : null,
      s === 'done' ? 'separator' : null,
      { label: 'Delete…', onClick: p.onDelete, shortcut: 'Delete', danger: true, title: 'Hide this call or message (asks first; it is not erased)' },
    ],
  };
}

/**
 * Right pane of /communications: one call or message. Eyebrow (how it
 * happened), the subject, one status line (date, direction, follow-up), the
 * actions, who took part and what it was about, then the follow-up, what was
 * said and what came of it. Every person, topic, document and appointment
 * links onward.
 */
export function CommunicationDetail({ id, onEdit, onDelete, onToggleFollowUp, onOpenDocument, busy }: CommunicationDetailProps) {
  const q = useCommunication(id);
  const c = q.data;
  if (q.isPending) return <Loading>Loading the call or message…</Loading>;
  if (q.isError || !c) return <EmptyState title="This call or message is not here any more">It may have been deleted. Pick another one from the list.</EmptyState>;
  const state = followUpState(c);
  const facts: KeyFact[] = [];
  if (c.participants.length)
    facts.push({
      label: 'With',
      wide: true,
      value: (
        <span className="cm-people">
          {c.participants.map((p) => (
            <span key={p.personId}>
              <Link to="/people" search={{ id: p.personId }}>
                {p.name}
              </Link>
              {p.role === 'cc' ? <span className="muted"> ({ROLE_WORDS[p.role]})</span> : null}
            </span>
          ))}
        </span>
      ),
    });
  if (c.topics.length)
    facts.push({
      label: 'Topics',
      wide: true,
      value: (
        <span className="cm-topics">
          {c.topics.map((t) => (
            <Link key={t} to="/communications" search={{ view: undefined, topic: t }} className="tag accent" title={`Every call and message about ${t}`}>
              {t}
            </Link>
          ))}
        </span>
      ),
    });
  if (c.documentId)
    facts.push({
      label: 'Document',
      wide: true,
      value: (
        <Link to="/documents/$id" params={{ id: c.documentId }}>
          <KeepDatesWhole text={c.documentTitle ?? 'Open the document'} />
        </Link>
      ),
    });
  if (c.encounterId)
    facts.push({
      label: 'Appointment',
      wide: true,
      value: (
        <Link to="/encounters" search={{ id: c.encounterId }}>
          {c.encounterTitle ?? 'Open the appointment'}
        </Link>
      ),
    });

  const followUp = c.followUpPromised ? (
    <Section key="follow" title="Follow-up" intro={state === 'overdue' ? 'Promised and past its due date.' : state === 'open' ? 'Promised and not done yet.' : undefined}>
      <KeyFacts
        items={[
          { label: 'Promised', value: <span className="prewrap">{c.followUpPromised}</span>, wide: true },
          c.followUpDue ? { label: 'Due', value: <DateText iso={c.followUpDue} />, mono: true } : null,
          c.followUpOwnerPersonId ? { label: 'Who owes it', value: <Link to="/people" search={{ id: c.followUpOwnerPersonId }}>{c.followUpOwnerName ?? 'Open the person'}</Link> } : null,
          c.followUpDoneAt ? { label: 'Done', value: <DateTimeText iso={c.followUpDoneAt} />, mono: true } : null,
        ]}
      />
    </Section>
  ) : null;

  return (
    <DetailPane label="Call or message">
      <FilingNotice targetType="communication" targetId={c.id} />
      <DetailHeader
        eyebrow={<span>{channelWords(c.channel)}</span>}
        title={c.subject}
        status={[
          c.occurredAt || c.occurredAtText ? <DateText key="date" iso={c.occurredAt} precision={c.occurredAtPrecision} text={c.occurredAtText} /> : 'No date',
          <span key="dir" title={DIRECTION_HINT[c.direction]}>
            {directionWords(c.direction)}
          </span>,
          state ? <FollowUpTag key="fu" c={c} long /> : null,
        ]}
        actions={communicationActions(c, { onEdit, onDelete, onToggleFollowUp, onOpenDocument, busy })}
        facts={facts.length ? facts : undefined}
      />

      {state === 'open' || state === 'overdue' ? followUp : null}

      {c.summary || c.outcome ? (
        <>
          {c.summary ? (
            <Section title="What was said">
              <div className="prewrap">{c.summary}</div>
            </Section>
          ) : null}
          {c.outcome ? (
            <Section title="What came of it">
              <div className="prewrap">{c.outcome}</div>
            </Section>
          ) : null}
        </>
      ) : (
        <Section title="What was said">
          <p className="cm-none">Nothing written yet about what was said or what came of it.</p>
          <div>
            <Button size="sm" onClick={onEdit}>
              Write it down
            </Button>
          </div>
        </Section>
      )}

      {state === 'done' ? followUp : null}

      <p className="cm-logged">
        Logged <DateTimeText iso={c.createdAt} />
      </p>
    </DetailPane>
  );
}
