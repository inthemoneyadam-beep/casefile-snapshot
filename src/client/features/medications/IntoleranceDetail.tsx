/**
 * One allergy, intolerance or drug that must never be given, in the detail pane's order: what it is, one status line,
 * the actions (Mark as never give, Edit, the rest under More), the key facts that have a value, then Where this came
 * from, and the added / changed times last. A drug marked never give says where it shows.
 */
import { FilingNotice } from '../filing/Filing';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import type { Intolerance, SourceFactCitation } from '../../api/medications';
import { SourceFactLine } from './SourceFact';
import { NeverGiveTag, SeverityTag } from './MedTags';
import { intoleranceKindWords, SEVERITY_TONE } from './words';

export { SEVERITY_TONE };

export interface IntoleranceDetailProps {
  item: Intolerance;
  busy?: boolean;
  onEdit: () => void;
  onToggleHardStop: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onOpenCard: () => void;
  onOpenCitation: (c: SourceFactCitation) => void;
}

export function IntoleranceDetail({ item, busy, onEdit, onToggleHardStop, onToggleActive, onDelete, onOpenCard, onOpenCitation }: IntoleranceDetailProps) {
  const kind = intoleranceKindWords(item.kind);
  const cite = item.sourceFact?.citation ?? null;
  const facts: KeyFact[] = [
    { label: 'Never give', value: item.hardStop ? (item.active ? 'Yes' : 'Yes, but it no longer applies') : 'No' },
    item.date ? { label: 'When it happened', value: <DateText iso={item.date} precision={item.datePrecision} text={item.dateText} /> } : null,
    item.reaction ? { label: 'What happens', value: item.reaction, wide: true } : null,
    item.notes ? { label: 'Notes', value: <span className="med-prewrap">{item.notes}</span>, wide: true } : null,
  ].filter(Boolean) as KeyFact[];

  return (
    <DetailPane label="Allergy">
      <FilingNotice targetType="intolerance" targetId={item.id} />
      <DetailHeader
        eyebrow={
          <>
            {item.hardStop ? <NeverGiveTag /> : null}
            <span>{kind === 'never give' ? 'Drug that must never be given' : kind[0].toUpperCase() + kind.slice(1)}</span>
            {!item.active ? <Tag tone="ash">no longer applies</Tag> : null}
          </>
        }
        title={item.substance}
        status={[
          <SeverityTag key="sev" severity={item.severity} />,
          item.sourceFact ? <span key="from">from {item.sourceFact.documentTitle ?? 'a document'}</span> : <span key="from">entered by hand</span>,
        ]}
        actions={{
          primary: { label: 'Edit', onClick: onEdit, shortcut: 'e', disabled: busy, title: 'Change what happens, how severe it is, the date or the notes' },
          // Never the primary: taking a drug off the Never give list should take a deliberate click (and it asks first).
          secondary: [
            {
              label: item.hardStop ? 'Stop marking never give' : 'Mark as never give',
              onClick: onToggleHardStop,
              shortcut: 'h',
              disabled: busy,
              title: item.hardStop ? 'It stays listed as a caution, but leaves the Never give banner and the emergency card (asks first)' : 'Shows it on every medications screen, the Home page and the emergency card (asks first)',
            },
          ],
          more: [
            { label: 'Open the page it came from', onClick: () => cite && onOpenCitation(cite), shortcut: 'enter', hidden: !cite },
            { label: item.active ? 'Mark as no longer applying' : 'Mark as applying again', onClick: onToggleActive, disabled: busy, title: item.active ? 'Keeps it on file but takes it off the banner and the card' : 'Puts it back on the banner and the card' },
            { label: 'Emergency card', onClick: onOpenCard, shortcut: 'p' },
            'separator',
            { label: 'Delete this allergy', onClick: onDelete, shortcut: 'Delete', danger: true, disabled: busy, title: 'Hides it from every list (asks first); nothing is erased' },
          ],
        }}
        facts={facts}
      />

      {item.hardStop && item.active ? <p className="notice bad med-notice">Shown as never give on every medications screen, the Home page and the printed emergency card.</p> : null}

      <Section title="Where this came from">
        {item.sourceFact ? <SourceFactLine fact={item.sourceFact} onOpenCitation={onOpenCitation} /> : <p className="med-none">You entered this by hand; it is not linked to a document.</p>}
      </Section>

      <p className="med-stamps">
        Added to the list <DateTimeText iso={item.createdAt} /> · last changed <DateTimeText iso={item.updatedAt} />
      </p>
    </DetailPane>
  );
}
