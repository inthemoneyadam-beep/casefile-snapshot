import { Button } from '../../ui/Button';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { Section } from '../../ui/PageHeader';
import { documentTypeLabel } from '../../api/filing';
import type { VisitDocLike } from './words';

/**
 * "Visits in your documents, not added yet": the visit notes, discharge
 * summaries and procedure reports not linked to any appointment, each with
 * "Add it" (Add an appointment opens filled in from the document). Shown under
 * the empty state and in the right pane of Past while nothing is selected.
 */
export function VisitDocuments({ docs, onAdd, limit = 12 }: { docs: ReadonlyArray<VisitDocLike & { documentDatePrecision?: string }>; onAdd: (d: VisitDocLike) => void; limit?: number }) {
  if (!docs.length) return null;
  const shown = docs.slice(0, limit);
  return (
    <Section title="Visits in your documents, not added yet" count={docs.length} intro="Each of these documents records a visit, a procedure or a hospital stay. Add it to keep what was decided with the visit; the form starts filled in from the document.">
      <div className="ledger">
        {shown.map((d) => (
          <div key={d.id} className="ledger-row en-doc-row">
            <span className="ledger-date">{d.documentDate ? <DateText iso={d.documentDate} precision={d.documentDatePrecision} /> : 'No date'}</span>
            <span className="en-doc-title">
              <KeepDatesWhole text={d.title.replace(/,\s*\d{4}(-\d{2}(-\d{2})?)?\s*$/, '')} />
              <span className="en-doc-kind">{documentTypeLabel(d.category)}</span>
            </span>
            <Button size="sm" onClick={() => onAdd(d)} title={`Add "${d.title}" as a past appointment`}>
              Add it
            </Button>
          </div>
        ))}
        {docs.length > shown.length ? <p className="en-none">and {docs.length - shown.length} more on Documents</p> : null}
      </div>
    </Section>
  );
}
