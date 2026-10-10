/**
 * On a People and places entry: the Care team candidate it belongs to (review 2026-10-09). Calls and messages reach a
 * candidate through this entry, so this is the way back from a call to the candidate (to-dos link back by themselves).
 * Nothing shows for someone who is not on the care team list.
 */
import { Link } from '@tanstack/react-router';
import { Tag } from '../../ui/StatusTag';
import { Section } from '../../ui/PageHeader';
import { useCandidates, type Candidate } from '../../api/care-team';
import { STATUS_TONE, roleWords, statusWords } from './words';

/** The section itself, from the candidates linked to the entry (none: nothing). */
export function PersonCareTeamSection({ items }: { items: ReadonlyArray<Pick<Candidate, 'id' | 'name' | 'role' | 'status'>> }) {
  if (!items.length) return null;
  return (
    <Section title="Care team" count={items.length}>
      <div className="ledger">
        {items.map((c) => (
          <Link key={c.id} to="/care-team" search={{ id: c.id }} className="ledger-row">
            <span className="ledger-date">
              <Tag tone={STATUS_TONE[c.status]}>{statusWords(c.status).toLowerCase()}</Tag>
            </span>
            <span>
              {c.name} <span className="muted">· {roleWords(c.role)}</span>
            </span>
            <span />
          </Link>
        ))}
      </div>
    </Section>
  );
}

export function PersonCareTeam({ personId }: { personId: string }) {
  const list = useCandidates({ personId });
  return <PersonCareTeamSection items={list.data?.items ?? []} />;
}
