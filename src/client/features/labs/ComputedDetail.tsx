/**
 * One computed value, in the right pane of By document and All values (2026-10-09). In the order the user reads it:
 *
 *   header    the test and its value as labs print it, "Computed by you from p.2 and p.3", "input changed: compute
 *             again" when an input was edited, disputed or removed since (never recomputed by itself), the actions
 *             (Show the trend, Compute again; Delete under More), and the key facts: the full number, the formula, the
 *             collection and the gap between the samples, who computed it, the lab's own printed value beside it.
 *   Notices   the inputs that changed; a finding when the lab's printed value differs.
 *   Inputs    each input as printed, how the formula read it (the unit conversion), its collection date, its page.
 *   Range     the range the patient types for this test (dashed on the chart, never red).
 *   Where this came from   every input's quote as found on its page.
 *
 * Never red, never judged by a range, never counted out of range.
 */
import { Link } from '@tanstack/react-router';
import { INPUT_CHANGED, computedTitle } from '@shared/labcompute';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import type { LabEntry } from '../../api/labs';
import { SpecimenTag, sampleWords } from './tags';
import { LabIssueNotices } from './LabIssues';
import { TypedRangeEditor } from './TypedRange';
import { fullWords } from './ComputeDialog';
import './computed.css';

export interface ComputedDetailProps {
  entry: LabEntry;
  name?: string | null;
  busy?: boolean;
  canWrite?: boolean;
  onShowTrend: () => void;
  onComputeAgain: () => void;
  onDelete: () => void;
}

export function ComputedDetail({ entry: e, name, busy, canWrite = true, onShowTrend, onComputeAgain, onDelete }: ComputedDetailProps) {
  const c = e.computed;
  const testName = name?.trim() || e.analyte;
  if (!c) return null;
  const r = c.record;
  const shown = `${r.result.shown}${e.unit ? ` ${e.unit}` : ''}`;
  return (
    <DetailPane label="Computed value" className="labs-detail">
      <DetailHeader
        eyebrow={
          <>
            <SpecimenTag specimen={e.specimen} />
            <span>Computed value</span>
          </>
        }
        title={
          <>
            {testName} <span className="labs-title-value">{shown}</span>
          </>
        }
        status={[
          <span key="label" title={computedTitle(r.inputs)}>
            {r.label}
          </span>,
          c.changes.length ? (
            <Tag key="changed" tone="warn" title={c.changes.join('\n')}>
              {INPUT_CHANGED}
            </Tag>
          ) : null,
        ]}
        actions={{
          primary: { label: 'Show the trend', onClick: onShowTrend, shortcut: 't', title: 'This test over time, printed and computed values on one chart' },
          secondary: [canWrite ? { label: 'Compute again', onClick: onComputeAgain, shortcut: 'c', title: 'Open the formula with the same inputs; nothing changes until you save' } : null],
          more: canWrite ? [{ label: 'Delete…', onClick: onDelete, shortcut: 'Delete', danger: true, disabled: busy, title: 'Hide this computed value (asks first; it is not erased)' }] : [],
        }}
        facts={[
          {
            label: 'Value',
            value: (
              <span className="labs-fact">
                <span className="labs-value">{shown}</span>
                <span className="labs-fact-note">{fullWords(r.result.full, r.result.shown)}</span>
              </span>
            ),
          },
          { label: 'Formula', value: r.formula.expression, wide: true },
          {
            // "Collected" only when the first input's report labels its date so (rule 7).
            label: r.inputs[0]?.date.kind === 'collected' ? 'Collected' : 'Date',
            value: (
              <span className="labs-fact">
                <DateText iso={e.date} precision={e.datePrecision} text={e.dateText} />
                {r.pairing.words ? <span className="labs-fact-note">{r.pairing.words}</span> : null}
              </span>
            ),
          },
          { label: 'Sample', value: sampleWords(e.specimen) },
          { label: 'Range', value: <span className="muted">Never judged by a range; never red</span> },
          {
            label: 'Computed by',
            value: (
              <span className="labs-fact">
                <span>
                  {r.by.name || 'You'}, <DateTimeText iso={r.by.at} />
                </span>
                {r.by.via === 'clinician' ? <span className="labs-fact-note">The clinician proposed it; you said yes.</span> : null}
              </span>
            ),
          },
          ...c.printed.map((p) => ({
            label: 'Printed by the lab',
            wide: true,
            value: (
              <span className="labs-fact">
                <span>
                  <span className="mono">
                    {p.valueShown}
                    {p.unit ? ` ${p.unit}` : ''}
                  </span>{' '}
                  {p.documentId ? (
                    <Link to="/documents/$id" params={{ id: p.documentId }} search={{ page: p.pageNumber ?? undefined }}>
                      {p.documentTitle ?? 'the report'}
                      {p.pageNumber ? `, p.${p.pageNumber}` : ''}
                    </Link>
                  ) : null}
                </span>
                <span className="labs-fact-note">{p.differs ? `Differs from yours (${p.computedAtPrecision} at the lab's precision); see What Claude noticed.` : `Matches yours at the lab's precision (${p.computedAtPrecision}).`}</span>
              </span>
            ),
          })),
        ]}
      />

      {c.changes.length ? (
        <div className="notice warn small">
          <strong>An input changed since this was computed.</strong> It is kept as it was; nothing is recomputed by itself. Compute it again to use the inputs as they read now.
          <ul className="computed-list">
            {c.changes.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <LabIssueNotices issues={e.labIssues} names={[e.analyte, testName]} />

      <Section title="Inputs" count={r.inputs.length} intro="Each value as printed on its lab report, and how the formula read it.">
        <table className="computed-inputs">
          <thead>
            <tr>
              <th>Input</th>
              <th>As printed</th>
              <th>Read as</th>
              <th>Collected</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            {r.inputs.map((i) => (
              <tr key={i.slot}>
                <td>{i.slotLabel}</td>
                <td className="mono">
                  {i.valueShown}
                  {i.unit ? ` ${i.unit}` : ''}
                  {i.flagShown ? <div className="computed-small">flag {i.flagShown}: shown, not used</div> : null}
                </td>
                <td className="mono">{i.conversion.words}</td>
                <td>
                  {i.date.text || i.date.day}
                  {i.date.kind === 'unknown' ? <div className="computed-small">not labelled as collected</div> : null}
                </td>
                <td>
                  <Link to="/documents/$id" params={{ id: i.citation.documentId }} search={{ page: i.citation.page, cite: i.citation.citationId ?? undefined }} title={i.citation.documentTitle ?? undefined}>
                    p.{i.citation.page}
                  </Link>
                  <div className="computed-small">{i.citation.documentTitle ?? 'document'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Your range" intro="Drawn dashed on the chart and labelled as yours. It never makes a value red.">
        <TypedRangeEditor analyteKey={e.analyteKey} canWrite={canWrite} />
      </Section>

      <Section title="Where this came from">
        <p className="computed-small">
          The app did the arithmetic from the values below, as printed on their pages. Units convert only by a fixed table (mg/dL, g/dL, g/L, mg/L).
        </p>
        <ul className="computed-list">
          {r.inputs.map((i) => (
            <li key={i.slot}>
              {i.slotLabel}, p.{i.citation.page} of {i.citation.documentTitle ?? 'a document'}
              {i.citation.quote ? <blockquote className={`labs-quote${i.citation.verified ? ' verified' : ''}`}>{i.citation.quote}</blockquote> : null}
              {i.citation.verified ? null : <Tag tone="warn">quote not found in the page text</Tag>}
            </li>
          ))}
        </ul>
        <p className="labs-added">
          Computed <DateTimeText iso={r.by.at} />
        </p>
      </Section>
    </DetailPane>
  );
}
