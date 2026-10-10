import { Button } from '../../ui/Button';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { Section } from '../../ui/PageHeader';
import { documentTypeLabel } from '../../api/filing';
import { titleWithoutDate } from '../people/shared';
import type { DocLike } from './fromDocuments';

/**
 * "In your documents, not logged yet": the phone call records, portal messages
 * and letters that are not the document of a logged call or message, each with
 * "Log it" (the dialog opens filled in from the document). Shown under the
 * empty state and in the right pane while nothing is selected.
 */
export function MessageDocuments({ docs, onLog, limit = 12 }: { docs: ReadonlyArray<DocLike & { documentDatePrecision?: string }>; onLog: (d: DocLike) => void; limit?: number }) {
  if (!docs.length) return null;
  const shown = docs.slice(0, limit);
  return (
    <Section title="In your documents, not logged yet" count={docs.length} intro="Each of these documents is a call or a message. Log it to keep who took part, what was said and anything promised; the form starts filled in from the document.">
      <div className="ledger cm-docs">
        {shown.map((d) => (
          <div key={d.id} className="ledger-row cm-doc-row">
            <span className="ledger-date">{d.documentDate ? <DateText iso={d.documentDate} precision={d.documentDatePrecision} /> : 'No date'}</span>
            <span className="cm-doc-title">
              <KeepDatesWhole text={titleWithoutDate(d.title)} />
              <span className="cm-doc-kind">{documentTypeLabel(d.category)}</span>
            </span>
            <Button size="sm" onClick={() => onLog(d)} title={`Log "${d.title}" as a call or message`}>
              Log it
            </Button>
          </div>
        ))}
        {docs.length > shown.length ? <p className="cm-none">and {docs.length - shown.length} more on Documents</p> : null}
      </div>
    </Section>
  );
}
