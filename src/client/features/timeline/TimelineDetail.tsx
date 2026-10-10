/**
 * The Timeline's statuses and its right pane.
 *
 * RowStatus     the one tag a row needs, and only when it says something: a
 *               detail you marked incorrect or replaced, a document that could
 *               not be read, an upcoming or cancelled appointment, a lab flag as
 *               printed, an open follow-up. Routine states ("accepted",
 *               "extracted", "completed") stay quiet in the list.
 * ItemStatusTag the full status, for the pane.
 * TimelineDetail the selected item: what kind, its title, one status line (date,
 *               who, status), Open (where it lives) and Open the document, the key
 *               facts that are known, and the full text. Never a link's address
 *               or an id on screen.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { TimelineItem } from '../../api/timeline';
import { DateText } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { FactStatusTag, FindingStatusTag, Tag, TaskStatusTag, type TagTone } from '../../ui/StatusTag';
import { READING_WORDS, isFileName, kindWords, openWords, subKindWords } from './words';

export const OVERRIDE_HINT = 'Your own statement takes precedence over this assessment in the consult';

const ENCOUNTER_TONE: Record<string, TagTone> = { upcoming: 'info', completed: 'ok', cancelled: 'ash' };
const READING_TONE: Record<string, TagTone> = { pending: 'neutral', extracting: 'info', ocr_running: 'info', ocr_needed: 'warn', failed: 'bad', extracted: 'ok', ocr_done: 'ok' };

/** The flag printed with a lab value, as printed ("H"), with what it is on hover. Nothing for a normal flag. */
function LabFlag({ flag }: { flag: string }) {
  if (/^n$/i.test(flag)) return null;
  return (
    <Tag tone={/^(c|hh|ll)/i.test(flag) ? 'danger' : 'warn'} title="The flag printed with the value on the report">
      flag {flag}
    </Tag>
  );
}

/** The marker for an assessment your own statement outranks. */
export function OverrideTag({ item }: { item: TimelineItem }) {
  if (item.kind !== 'fact' || !item.overriddenBy) return null;
  return (
    <Tag tone="ash" title={OVERRIDE_HINT}>
      patient view differs
    </Tag>
  );
}

/** The one tag a row needs, or nothing (routine states stay quiet in the list). */
export function RowStatus({ item }: { item: TimelineItem }): ReactNode {
  const s = item.status;
  if (!s) return null;
  switch (item.kind) {
    case 'fact':
      // Your answers that change how the detail counts; "accepted" and automatic ones stay quiet here.
      return s === 'disputed' || s === 'superseded' ? <FactStatusTag status={s} /> : null;
    case 'document':
      return s === 'failed' || s === 'ocr_needed' || s === 'pending' || s === 'extracting' || s === 'ocr_running' ? <Tag tone={READING_TONE[s] ?? 'neutral'}>{(READING_WORDS[s] ?? s).toLowerCase()}</Tag> : null;
    case 'encounter':
      return s === 'completed' ? null : <Tag tone={ENCOUNTER_TONE[s] ?? 'neutral'}>{s}</Tag>;
    case 'lab':
      return <LabFlag flag={s} />;
    case 'communication':
      return <Tag tone="warn">{s}</Tag>;
    case 'task':
      return s === 'open' ? null : <TaskStatusTag status={s} />;
    case 'finding':
      return <FindingStatusTag status={s} />;
    default:
      return null;
  }
}

/** The full status, for the pane. */
export function ItemStatusTag({ item }: { item: TimelineItem }): ReactNode {
  const s = item.status;
  if (!s) return null;
  switch (item.kind) {
    case 'fact':
      return <FactStatusTag status={s} hideAutomatic />;
    case 'document':
      return <Tag tone={READING_TONE[s] ?? 'neutral'}>{(READING_WORDS[s] ?? s).toLowerCase()}</Tag>;
    case 'encounter':
      return <Tag tone={ENCOUNTER_TONE[s] ?? 'neutral'}>{s}</Tag>;
    case 'lab':
      return <LabFlag flag={s} />;
    case 'communication':
      return <Tag tone="warn">{s}</Tag>;
    case 'task':
      return <TaskStatusTag status={s} />;
    case 'finding':
      return <FindingStatusTag status={s} />;
    default:
      return <Tag>{s}</Tag>;
  }
}

export interface TimelineDetailProps {
  item: TimelineItem;
  /** Open where the item lives (Enter). */
  onOpen: () => void;
  /** Clear the selection (Esc). */
  onClear: () => void;
  /** Show only this kind on the timeline. */
  onOnlyKind?: () => void;
  /** Open the document it came from. */
  onOpenDocument?: () => void;
}

export function TimelineDetail({ item, onOpen, onClear, onOnlyKind, onOpenDocument }: TimelineDetailProps) {
  const sub = subKindWords(item.kind, item.subKind);
  const isFact = item.kind === 'fact';
  // Your own answer on a detail says so ("Your answer: accepted"), apart from the automatic check.
  const answered = isFact && Boolean(item.status) && item.status !== 'unverified';
  const status = answered ? (
    <span key="status" className="timeline-answer">
      Your answer: <ItemStatusTag item={item} />
    </span>
  ) : (
    <ItemStatusTag key="status" item={item} />
  );
  // A detail's "detail" is the document's name (the From fact); a document's is its notes or its file name; for the
  // rest it is the text worth reading.
  const fileName = item.kind === 'document' && isFileName(item.detail) ? item.detail : null;
  const text = !isFact && !fileName && item.detail ? item.detail : null;
  // The date, the kind and who are in the lines above; the facts add only where it came from.
  const facts: Array<KeyFact | null> = [
    item.documentId && item.kind !== 'document'
      ? { label: 'From', value: <Link to="/documents/$id" params={{ id: item.documentId }}>{isFact && item.detail ? item.detail : 'Open the document'}</Link>, wide: true }
      : null,
    fileName ? { label: 'File', value: fileName, mono: true } : null,
    isFact && item.overriddenBy ? { label: 'Your account', value: <Link to="/facts" search={{ id: item.overriddenBy }} title={OVERRIDE_HINT}>Open your own statement about it</Link>, wide: true } : null,
  ];
  return (
    <DetailPane label="Timeline item" className="timeline-detail">
      <DetailHeader
        eyebrow={
          <>
            <span className="timeline-detail-kind">{kindWords(item.kind, 1)}</span>
            {sub ? <span>{sub}</span> : null}
          </>
        }
        title={item.title}
        status={[<DateText key="date" iso={item.date} precision={item.datePrecision} />, item.personName ? <span key="who">{item.personName}</span> : null, status, <OverrideTag key="override" item={item} />]}
        actions={{
          primary: { label: openWords(item.kind), onClick: onOpen, shortcut: 'enter', title: 'Go to where this lives in the case (double-click on the row does the same)' },
          secondary: [item.documentId && item.kind !== 'document' && onOpenDocument ? { label: 'Open the document', onClick: onOpenDocument, title: 'The document this came from' } : null],
          more: [onOnlyKind ? { label: `Show only ${kindWords(item.kind).toLowerCase()}`, onClick: onOnlyKind } : null, { label: 'Clear the selection', onClick: onClear, shortcut: 'esc' }],
        }}
        facts={facts}
      />
      {text ? (
        <Section title={item.kind === 'document' ? 'Note' : 'In full'}>
          <p className="timeline-detail-text">{text}</p>
        </Section>
      ) : null}
    </DetailPane>
  );
}
