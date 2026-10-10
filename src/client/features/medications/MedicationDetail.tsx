/**
 * One medication, in the detail pane's order (ui/DetailPane.tsx): what it is, one status line ("taking · 150 mg ·
 * started 2025-06-02 · from My notes, p.1"), the actions (Add an event, Edit, the rest under More), the key facts that
 * have a value (no empty "—" rows), then Events, then Where this came from, and the added / changed times last.
 */
import { Link } from '@tanstack/react-router';
import { FilingNotice } from '../filing/Filing';
import { Button } from '../../ui/Button';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { startShown, type MedicationDetail as MedicationDetailData, type SourceFactCitation } from '../../api/medications';
import { SourceFactLine } from './SourceFact';
import { EventTag, MedStatus } from './MedTags';
import { doseWords } from './words';

export { EVENT_TONE } from './words';

export interface MedicationDetailProps {
  med: MedicationDetailData;
  busy?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onOpenCard: () => void;
  /** Opens the Add an event dialog. */
  onAddEvent: () => void;
  onDeleteEvent: (id: string) => void;
  onOpenCitation: (c: SourceFactCitation) => void;
}

const preWrap = (s: string) => <span className="med-prewrap">{s}</span>;

export function MedicationDetail({ med, busy, onEdit, onDelete, onOpenCard, onAddEvent, onDeleteEvent, onOpenCitation }: MedicationDetailProps) {
  const dose = doseWords(med);
  // A start that was never stated (a list or note only named the drug) is said as such, with its first mention.
  const shown = startShown(med);
  const startNode = shown.recorded ? (
    <DateText iso={med.startDate} precision={med.startDatePrecision} text={med.startDateText} />
  ) : (
    <span className="muted" title="The start date was never written down; this is the first date a document mentions it.">
      start not recorded{shown.iso ? (
        <>
          {' '}
          (first seen <DateText iso={shown.iso} precision={shown.precision} />)
        </>
      ) : null}
    </span>
  );
  const stopped = med.stopDate ? <DateText iso={med.stopDate} precision={med.stopDatePrecision} text={med.stopDateText} /> : med.status === 'stopped' ? <span className="muted">date not recorded</span> : null;
  const cite = med.sourceFact?.citation ?? null;
  const fromDoc = med.sourceFact ? (cite ? `${med.sourceFact.documentTitle ?? 'a document'}, p.${cite.pageNumber}` : (med.sourceFact.documentTitle ?? 'a document')) : null;
  const generic = med.genericName && med.genericName.toLowerCase() !== med.name.toLowerCase() ? med.genericName : null;
  // The events table's Dose and Details columns only when an event has one.
  const evDose = med.events.some((e) => e.dose);
  const evDetail = med.events.some((e) => e.detail);

  const facts: KeyFact[] = [];
  if (dose) facts.push({ label: 'Dose', value: dose, mono: true });
  if (med.frequency) facts.push({ label: 'How often', value: med.frequency });
  if (med.route) facts.push({ label: 'How taken', value: med.route });
  facts.push({ label: 'Started', value: startNode });
  if (stopped) facts.push({ label: 'Stopped', value: stopped });
  if (med.prescriberId || med.prescriberName)
    facts.push({
      label: 'Prescribed by',
      value: med.prescriberId ? (
        <Link to="/people" search={{ id: med.prescriberId }}>
          {med.prescriberName ?? 'Open the person'}
        </Link>
      ) : (
        med.prescriberName
      ),
    });
  if (med.drugClass) facts.push({ label: 'Kind of drug', value: med.drugClass });
  if (med.indication) facts.push({ label: 'What it is for', value: med.indication, wide: med.indication.length > 40 });
  if (med.effect) facts.push({ label: 'What it did', value: preWrap(med.effect), wide: true });
  if (med.reasonStopped) facts.push({ label: 'Why it stopped', value: preWrap(med.reasonStopped), wide: true });
  if (med.notes) facts.push({ label: 'Notes', value: preWrap(med.notes), wide: true });
  // The settled timeline (My notes, 2026-10-09): what Medications shows once the user answered on this drug, and who said it.
  if (med.settled?.words)
    facts.push({
      label: 'Settled timeline',
      wide: true,
      value: (
        <span>
          {med.settled.words}.{' '}
          <Link to="/reconcile" search={{ tab: 'meds', id: med.settled.drugKey }}>
            See it by source
          </Link>
        </span>
      ),
    });

  return (
    <DetailPane label="Medication">
      <FilingNotice targetType="medication" targetId={med.id} />
      <DetailHeader
        eyebrow={<span>Medication</span>}
        title={
          <>
            {med.name}
            {generic ? <span className="med-generic"> · {generic}</span> : null}
          </>
        }
        status={[
          <MedStatus key="status" status={med.status} />,
          dose ? (
            <span key="dose" className="mono">
              {dose}
            </span>
          ) : null,
          med.frequency ? <span key="often">{med.frequency}</span> : null,
          shown.recorded && med.startDate ? (
            <span key="start">
              started <DateText iso={med.startDate} precision={med.startDatePrecision} text={med.startDateText} />
            </span>
          ) : null,
          med.stopDate ? (
            <span key="stop">
              stopped <DateText iso={med.stopDate} precision={med.stopDatePrecision} text={med.stopDateText} />
            </span>
          ) : null,
          fromDoc ? <span key="from">from {fromDoc}</span> : <span key="from">entered by hand</span>,
        ]}
        actions={{
          primary: { label: 'Add an event', onClick: onAddEvent, shortcut: 'a', disabled: busy, title: 'A start, stop, dose change, pause or reaction, with its date' },
          secondary: [{ label: 'Edit', onClick: onEdit, shortcut: 'e', disabled: busy, title: 'Change the name, dose, dates or notes' }],
          more: [
            { label: 'Open the page it came from', onClick: () => cite && onOpenCitation(cite), shortcut: 'enter', hidden: !cite },
            { label: 'Emergency card', onClick: onOpenCard, shortcut: 'p', title: 'The printable card with what you take and what must never be given' },
            'separator',
            { label: 'Delete this medication', onClick: onDelete, shortcut: 'Delete', danger: true, disabled: busy, title: 'Hides it from every list (asks first); nothing is erased' },
          ],
        }}
        facts={facts}
      />

      <Section title="Events" count={med.events.length}>
        {med.events.length ? (
          <table className="med-events">
            <thead>
              <tr>
                <th className="date">Date</th>
                <th>What happened</th>
                {evDose ? <th>Dose</th> : null}
                {evDetail ? <th>Details</th> : null}
                <th>From</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {med.events.map((e) => (
                <tr key={e.id}>
                  <td className="date">
                    <DateText iso={e.date} precision={e.datePrecision} text={e.dateText} />
                  </td>
                  <td className="med-event-kind">
                    <EventTag kind={e.kind} listed={e.kind === 'start' && med.startRecorded === false} />
                  </td>
                  {evDose ? <td className="mono">{e.dose ?? ''}</td> : null}
                  {evDetail ? <td>{e.detail ?? ''}</td> : null}
                  <td>
                    {e.sourceFact ? (
                      e.sourceFact.citation ? (
                        <button type="button" className={`cite${e.sourceFact.citation.verified ? '' : ' unverified'}`} onClick={() => onOpenCitation(e.sourceFact!.citation!)} title={`${e.sourceFact.documentTitle ?? 'The document'}: ${e.sourceFact.statement}`}>
                          p.{e.sourceFact.citation.pageNumber}
                        </button>
                      ) : (
                        <Link to="/facts" search={{ id: e.sourceFact.id }} title={e.sourceFact.statement}>
                          a document
                        </Link>
                      )
                    ) : (
                      <span className="muted">you</span>
                    )}
                  </td>
                  <td className="actions">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDeleteEvent(e.id)} title="Remove this event (asks first)">
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="med-none">No events yet. Starts, stops, dose changes, pauses and reactions you add here also show on the symptom and lab charts.</p>
        )}
      </Section>

      <Section title="Where this came from">
        {med.sourceFact ? (
          <SourceFactLine fact={med.sourceFact} onOpenCitation={onOpenCitation} />
        ) : (
          <p className="med-none">You entered this by hand; it is not linked to a document.</p>
        )}
      </Section>

      <p className="med-stamps">
        Added to the list <DateTimeText iso={med.createdAt} /> · last changed <DateTimeText iso={med.updatedAt} />
      </p>
    </DetailPane>
  );
}
