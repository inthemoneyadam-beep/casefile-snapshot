/**
 * On People and places, for a hospital or clinic (2026-10-09): what its records were like when each was checked against
 * itself ("From Valley Clinic: 3 flags don't match, 1 contradiction in 4 documents checked"), with a link to those
 * findings. Shown only when at least one of its documents was checked.
 */
import { Link } from '@tanstack/react-router';
import { Section } from '../../ui/PageHeader';
import { useFacilitySelfCheck } from '../../api/self-check';
import './self-check.css';

export function FacilitySection({ personId }: { personId: string }) {
  const q = useFacilitySelfCheck(personId);
  const f = q.data?.items[0];
  if (!f || !f.documents) return null;
  return (
    <Section title="Its records, checked against themselves" intro="Each of its documents was checked against itself only: lab flags against their own values and ranges, and each note for places where it contradicts itself.">
      <p className="sc-p">
        {f.words}.{f.open ? ` ${f.open} still without your answer.` : ''}
      </p>
      {f.flags || f.contradictions ? (
        <p className="small">
          <Link to="/findings" search={f.name ? { q: `From ${f.name}:` } : { category: f.flags ? 'flag_mismatch' : 'contradicts_itself' }}>
            See them in What Claude noticed
          </Link>
        </p>
      ) : null}
    </Section>
  );
}
