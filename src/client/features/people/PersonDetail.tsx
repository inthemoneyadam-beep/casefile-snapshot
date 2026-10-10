import { Link } from '@tanstack/react-router';
import { usePerson, usePersonActivity, type PersonRow } from '../../api/people';
import { documentTypeLabel } from '../../api/filing';
import { Button } from '../../ui/Button';
import { Tag, FactStatusTag } from '../../ui/StatusTag';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { EmptyState, Loading, Section } from '../../ui/PageHeader';
import type { ActionBarProps } from '../../ui/ActionBar';
import { channelWords, directionWords, personKindWords, plural, replyDays } from './shared';
import { PersonMergeSection } from './Merge';
// A hospital's or clinic's records, checked against themselves (2026-10-09).
import { FacilitySection } from '../self-check/FacilitySection';
// A detail's kind as Details from documents says it at the start of a line ("Medication", "Lab result").
import { factTypeWords } from '../facts/words';
// The Care team candidate this entry belongs to: the way back from a call to the candidate (2026-10-09).
import { PersonCareTeam } from '../care-team/PersonCareTeam';

export interface PersonDetailProps {
  id: string;
  onEdit: () => void;
  onDelete: () => void;
  onNewCommunication: () => void;
  /** List every call and message with them (Enter on the list). */
  onOpenComms?: () => void;
  /** Find names in your documents (the page's own action), offered when no document is linked to them yet. */
  onFindNames?: () => void;
}

/** The pane's actions: log a call (the one main action) and Edit; under More their calls and messages (also "List them all" by the section) and Delete. */
export function personActions(p: Pick<PersonRow, 'name' | 'communicationCount'>, a: Pick<PersonDetailProps, 'onEdit' | 'onDelete' | 'onNewCommunication' | 'onOpenComms'>): ActionBarProps {
  return {
    primary: { label: 'Log a call or message', onClick: a.onNewCommunication, shortcut: 'c', title: `A call, message or letter with ${p.name}` },
    secondary: [{ label: 'Edit', onClick: a.onEdit, shortcut: 'e', title: 'Change the name, how to reach them, or the notes' }],
    more: [
      a.onOpenComms && p.communicationCount ? { label: 'All their calls and messages', onClick: a.onOpenComms, shortcut: 'enter', title: 'On Calls and messages, only the ones with this person' } : null,
      a.onOpenComms && p.communicationCount ? 'separator' : null,
      { label: 'Delete…', onClick: a.onDelete, shortcut: 'Delete', danger: true, title: 'Hide this person (asks first; it is not erased)' },
    ],
  };
}

/** How to reach them and what to know, only the facts that are filled in (never a row of dashes). */
export function personFacts(p: PersonRow): KeyFact[] {
  const out: KeyFact[] = [];
  if (p.phone) out.push({ label: 'Phone', value: p.phone, mono: true });
  if (p.fax) out.push({ label: 'Fax', value: p.fax, mono: true });
  if (p.email) out.push({ label: 'Email', value: p.email });
  if (p.portal) out.push({ label: 'Portal', value: p.portal });
  if (p.preferredChannel) out.push({ label: 'Best reached by', value: channelWords(p.preferredChannel) });
  const reply = replyDays(p.medianResponseDays);
  if (reply) out.push({ label: 'Usually replies in', value: reply, mono: true, title: 'The middle of the times from your call or message to their reply' });
  if (p.address) out.push({ label: 'Address', value: p.address, wide: true });
  if (p.aliases.length) out.push({ label: 'Also written as', value: p.aliases.join(', '), wide: true });
  if (p.notes) out.push({ label: 'Notes', value: <span className="prewrap">{p.notes}</span>, wide: true });
  return out;
}

/**
 * Right pane of /people: who they are (eyebrow, name, one status line), the
 * actions, how to reach them, then every call and message with them, the
 * topics, the documents that name them and the details tied to them. Every
 * row links onward, so the chain back to the documents stays one step away.
 */
export function PersonDetail({ id, onEdit, onDelete, onNewCommunication, onOpenComms, onFindNames }: PersonDetailProps) {
  const person = usePerson(id);
  const activity = usePersonActivity(id);
  const p = person.data;
  const a = activity.data;

  if (person.isPending) return <Loading>Loading…</Loading>;
  if (person.isError || !p) return <EmptyState title="This person is not here any more">They may have been deleted. Pick someone else from the list.</EmptyState>;

  const what = [p.role, p.specialty].filter(Boolean).join(', ');
  const loading = activity.isPending;
  return (
    <DetailPane label="Person or place">
      <DetailHeader
        eyebrow={<span>{personKindWords(p.kind)}</span>}
        title={p.name}
        status={[
          what || null,
          p.institutionId && p.institutionName ? (
            <Link key="inst" to="/people" search={{ id: p.institutionId }}>
              {p.institutionName}
            </Link>
          ) : null,
          p.communicationCount ? plural(p.communicationCount, 'call or message', 'calls and messages') : 'No calls or messages yet',
          p.lastContactAt ? (
            <span key="last">
              last <DateText iso={p.lastContactAt} />
            </span>
          ) : null,
        ]}
        actions={personActions(p, { onEdit, onDelete, onNewCommunication, onOpenComms })}
        facts={personFacts(p)}
      />

      <PersonMergeSection key={`merge-${p.id}`} personId={p.id} personName={p.name} />

      {p.kind === 'institution' || p.kind === 'clinic' ? <FacilitySection key={`sc-${p.id}`} personId={p.id} /> : null}

      <Section
        title="Calls and messages"
        count={a?.communications.length || undefined}
        actions={
          a?.communications.length ? (
            <Link to="/communications" search={{ view: undefined, personId: p.id }} className="small">
              List them all
            </Link>
          ) : null
        }
      >
        {a?.communications.length ? (
          <div className="ledger">
            {a.communications.map((c) => {
              const open = c.followUpPromised && !c.followUpDoneAt;
              return (
                <Link key={c.id} to="/communications" search={{ id: c.id }} className={`ledger-row${c.overdue ? ' overdue' : ''}`}>
                  <span className="ledger-date">
                    <DateText iso={c.occurredAt} precision={c.occurredAtPrecision} text={c.occurredAtText} />
                  </span>
                  <span className="pp-ledger-what">
                    {c.subject}
                    <span className="pp-ledger-sub">
                      {channelWords(c.channel)}, {directionWords(c.direction).toLowerCase()}
                      {c.topics.length ? ` · ${c.topics.join(', ')}` : ''}
                    </span>
                  </span>
                  <span>{open ? <Tag tone={c.overdue ? 'bad' : 'warn'}>{c.overdue ? 'follow-up overdue' : 'follow-up open'}</Tag> : null}</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="pp-none">
            <span>{loading ? 'Loading…' : `No calls or messages with ${p.name} yet.`}</span>
            {loading ? null : (
              <Button size="sm" onClick={onNewCommunication}>
                Log one
              </Button>
            )}
          </div>
        )}
      </Section>

      {a?.topics.length ? (
        <Section
          title="Topics"
          count={a.topics.length}
          actions={
            <Link to="/communications" search={{ view: 'matrix', personId: p.id }} className="small">
              See by person
            </Link>
          }
        >
          <div className="ledger">
            {a.topics.map((t) => (
              <Link key={t.topic} to="/communications" search={{ view: undefined, personId: p.id, topic: t.topic }} className="ledger-row">
                <span className="ledger-date">
                  <DateText iso={t.last} />
                </span>
                <span className="pp-ledger-what">{t.topic}</span>
                <span className="pp-ledger-count">
                  <span className="mono">{t.count}</span>
                  {t.openFollowUps ? <Tag tone="warn">{t.openFollowUps} open</Tag> : null}
                </span>
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {a?.documents.length ? (
        <Section title="Documents that name them" count={a.documents.length}>
          <div className="ledger">
            {a.documents.map((d) => (
              <Link key={d.id} to="/documents/$id" params={{ id: d.id }} className="ledger-row">
                <span className="ledger-date">
                  <DateText iso={d.documentDate} precision={d.documentDatePrecision} text={d.documentDateText} />
                </span>
                <span className="pp-ledger-what">
                  <KeepDatesWhole text={d.title} />
                  <span className="pp-ledger-sub">
                    {documentTypeLabel(d.category)}
                    {d.authorPersonId === p.id ? ', written by them' : d.institutionId === p.id ? ', from here' : ''}
                  </span>
                </span>
                <span />
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {a?.facts.length ? (
        <Section title="Details from documents" count={a.facts.length} intro="What the documents say that names them.">
          <div className="ledger">
            {a.facts.map((f) => (
              <Link key={f.id} to="/facts" search={{ id: f.id }} className="ledger-row">
                <span className="ledger-date">
                  <DateText iso={f.date} precision={f.datePrecision} text={f.dateText} />
                </span>
                <span className="pp-ledger-what">
                  <KeepDatesWhole text={f.statement} />
                  <span className="pp-ledger-sub">
                    {factTypeWords(f.type)}
                    {f.documentTitle ? ` · ${f.documentTitle}` : ''}
                  </span>
                </span>
                <FactStatusTag status={f.status} basis={f.verdictBasis} hideAutomatic />
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Said as it is: a document may well name them without being linked to them (Search finds it). */}
      {!loading && a && !a.documents.length && !a.facts.length ? (
        <div className="pp-quiet">
          <p>No documents are linked to {p.name} yet.</p>
          {onFindNames ? (
            <Button size="sm" onClick={onFindNames} title="Names of clinicians and hospitals Claude read in your documents that are not on this list yet">
              Find names in your documents
            </Button>
          ) : null}
        </div>
      ) : null}
      <PersonCareTeam personId={p.id} />
    </DetailPane>
  );
}
