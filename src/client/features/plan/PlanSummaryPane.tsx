/**
 * Right pane of the Plan page's All plans tab: one plan, where it stands (current, replaced, new), how its reading
 * went, its checklist progress, its summary as read and a short history; Open it, Make this the current plan, Read it
 * again and Remove.
 */
import { Link } from '@tanstack/react-router';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { DateText, DateTimeText } from '../../ui/DateText';
import type { ActionBarProps } from '../../ui/ActionBar';
import type { PlanSummary } from '../../api/plans';
import { PLAN_STATUS_WORDS, readingWords } from '@shared/plan';

export interface PlanSummaryPaneProps {
  plan: PlanSummary;
  history?: Array<{ at: string; by?: string | null; what: string }>;
  canWrite: boolean;
  busy: boolean;
  onOpen: () => void;
  onMakeCurrent: () => void;
  onReadAgain: () => void;
  onRemove: () => void;
}

export function planStatusTone(status: string): 'ok' | 'ash' | 'info' {
  return status === 'current' ? 'ok' : status === 'draft' ? 'info' : 'ash';
}

export function PlanSummaryPane(p: PlanSummaryPaneProps) {
  const { plan } = p;
  const read = plan.reading?.state === 'done';
  const actions: ActionBarProps = {
    primary: { label: 'Open it', onClick: p.onOpen, shortcut: 'enter', title: 'Its framework, checklist and timeline' },
    secondary: p.canWrite ? [plan.status !== 'current' && read ? { label: 'Make this the current plan', onClick: p.onMakeCurrent, disabled: p.busy, title: 'The current plan is kept, replaced' } : null] : [],
    more: p.canWrite
      ? [
          { label: 'Read it again…', onClick: p.onReadAgain, disabled: p.busy, title: 'Shows the cost first. Your checklist is kept.' },
          'separator',
          { label: 'Remove this plan…', onClick: p.onRemove, danger: true, disabled: p.busy, title: 'Hidden, not erased; its document stays in Documents' },
        ]
      : [],
  };
  const facts: KeyFact[] = [
    { label: 'Checklist', value: plan.progressWords },
    plan.planDate ? { label: 'Dated', value: <DateText iso={plan.planDate} precision={plan.planDatePrecision} text={plan.planDateText} />, mono: true } : null,
    { label: 'Added', value: <DateTimeText iso={plan.createdAt} />, mono: true },
    plan.createdBy ? { label: 'Added by', value: plan.createdBy } : null,
    plan.documentId ? {
      label: 'Document',
      wide: true,
      value: (
        <Link to="/documents/$id" params={{ id: plan.documentId }}>
          {plan.documentTitle ?? 'The plan document'}
        </Link>
      ),
    } : null,
  ].filter(Boolean) as KeyFact[];
  return (
    <DetailPane label="Plan">
      <DetailHeader
        eyebrow={<span>Plan</span>}
        title={plan.title}
        status={[
          <Tag key="s" tone={planStatusTone(plan.status)}>
            {PLAN_STATUS_WORDS[plan.status] ?? plan.status}
          </Tag>,
          plan.supersededAt ? (
            <span key="r" className="muted">
              replaced {plan.supersededAt.slice(0, 10)}
            </span>
          ) : null,
          !read ? (
            <span key="w" className="muted">
              {readingWords(plan.reading)}
            </span>
          ) : null,
        ]}
        actions={actions}
        facts={facts}
      />
      {plan.summary ? (
        <Section title="What it is (as read)">
          <p className="plan-summary">{plan.summary}</p>
        </Section>
      ) : null}
      {read && plan.reading ? <p className="muted small">{readingWords(plan.reading)}</p> : null}
      {p.history?.length ? (
        <Section title="What happened to it">
          <ul className="plan-history">
            {[...p.history].reverse().slice(0, 12).map((h, i) => (
              <li key={i}>
                <DateTimeText iso={h.at} /> {h.what}
                {h.by ? ` (${h.by})` : ''}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </DetailPane>
  );
}
