/**
 * The Medications page's tags, in words (features/medications/words.ts): a status ("taking", "as needed"), an event
 * ("dose changed"), a severity ("life-threatening"), "never give", and the check of the document detail a row came
 * from. Colour always comes with a word.
 */
import { FactStatusTag, Tag } from '../../ui/StatusTag';
import { EVENT_TONE, MED_STATUS_TITLES, MED_STATUS_TONE, SEVERITY_TONE, eventWords, medStatusWords, severityWords } from './words';

export function MedStatus({ status }: { status: string }) {
  return (
    <Tag tone={MED_STATUS_TONE[status] ?? 'neutral'} title={MED_STATUS_TITLES[status]}>
      {medStatusWords(status)}
    </Tag>
  );
}

export function EventTag({ kind, listed }: { kind: string; listed?: boolean }) {
  // On a course whose start is not recorded, a "start" line is only the date a list named the drug.
  if (listed)
    return (
      <Tag tone="neutral" title="The date a list or note named it; not a start date">
        on a list
      </Tag>
    );
  return <Tag tone={EVENT_TONE[kind] ?? 'neutral'}>{eventWords(kind)}</Tag>;
}

export function SeverityTag({ severity }: { severity: string }) {
  return <Tag tone={SEVERITY_TONE[severity] ?? 'neutral'}>{severityWords(severity)}</Tag>;
}

export function NeverGiveTag() {
  return (
    <Tag tone="danger" title="Must never be given: shown on every medications screen, the Home page and the emergency card">
      never give
    </Tag>
  );
}

/**
 * Your answer about the document detail a row came from, when it says something: accurate, inferred, your
 * correction, unsure, incorrect, replaced. A plain "accepted" (confirmed without saying against what) and the
 * automatic state say nothing a reader needs here, so they show nothing.
 */
export function SourceCheck({ status, basis }: { status: string | null | undefined; basis?: string | null }) {
  if (!status) return null;
  if (status === 'confirmed' && !basis) return null;
  return <FactStatusTag status={status} basis={basis} hideAutomatic />;
}

/** Words with every date in them set in the mono, kept whole ("taking since 2025-06-02"). */
export function DatesInMono({ text }: { text: string }) {
  const parts = text.split(/(\d{4}(?:-\d{2}(?:-\d{2})?)?)/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="mono nowrap">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
