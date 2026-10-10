/**
 * The right-hand pane of a split view, in a fixed order a reader can rely on:
 *
 *   1. eyebrow   what kind of thing this is (a tag or two: "CSF", "Lab test")
 *   2. title     its name, in the serif
 *   3. status    ONE line: where it stands ("3 values · 1 out of range"); pass
 *                the parts as an array and the "·" between them is drawn for
 *                you, never at the start of a wrapped line
 *   4. actions   always on their own row under the status line, so they sit in
 *                the same place for every item (j/k never moves them): the 1-3
 *                that matter, the rest under More
 *   5. facts     a short key-facts grid, label: value (data values in mono),
 *                two to a row; a fact left alone on its row takes the row
 *   6. sections  in order of importance (Section, ui/PageHeader.tsx)
 *
 *   <DetailPane label="Test details">
 *     <DetailHeader
 *       eyebrow={<SpecimenTag specimen="csf" />}
 *       title="Opening pressure"
 *       status="3 values · 1 above the normal range"
 *       actions={{ primary: { label: 'Add a value', onClick: add }, more: [{ label: 'Show all values', onClick: all }] }}
 *       facts={[
 *         { label: 'Last value', value: '38 cmH2O', mono: true },
 *         { label: 'Normal range', value: '10-25 cmH2O', mono: true },
 *         { label: 'Last date', value: <DateText iso="2024-09-17" /> },
 *       ]}
 *     />
 *     <Section title="Trend">...</Section>
 *     <Section title="Values" count={3}>...</Section>
 *   </DetailPane>
 *
 * Never show internal keys or ids (an analyte key, a fact id) or jargon in
 * any of these; words a patient would use.
 */
import { Children, type ReactNode } from 'react';
import { ActionBar, isActionBarProps, type ActionBarProps } from './ActionBar';

export function DetailPane({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <section className={['detail', className ?? ''].filter(Boolean).join(' ')} aria-label={label}>
      {children}
    </section>
  );
}

export interface KeyFact {
  label: ReactNode;
  /** The value; null or undefined shows a dash. */
  value: ReactNode;
  /** A data value (a number, date, unit, id): set in the mono. */
  mono?: boolean;
  /** Hover text for the value. */
  title?: string;
  /** Takes a whole row (a long value, such as a note). */
  wide?: boolean;
}

/**
 * Which facts take a whole row: the wide ones, and a fact that would otherwise sit alone in the left half of a row
 * (the last of an odd run before a wide one, or at the end), so its value has the room instead of an empty half.
 */
export function factSpans(list: ReadonlyArray<Pick<KeyFact, 'wide'>>): boolean[] {
  const out = list.map((f) => Boolean(f.wide));
  let run = 0;
  for (let i = 0; i <= list.length; i++) {
    if (i === list.length || out[i]) {
      if (run % 2 === 1) out[i - 1] = true;
      run = 0;
    } else run++;
  }
  return out;
}

/** The longest label a block lines its values up after, in characters; a longer one wraps. */
const LABEL_CAP = 20;

/**
 * One label width for a whole block of facts (the longest label, up to LABEL_CAP characters), so every value of the
 * block starts at the same place instead of right after its own label. Undefined when a label is not plain text: the
 * labels then size themselves.
 */
export function factLabelWidth(list: ReadonlyArray<Pick<KeyFact, 'label'>>): string | undefined {
  let n = 0;
  for (const f of list) {
    if (typeof f.label !== 'string' && typeof f.label !== 'number') return undefined;
    n = Math.max(n, String(f.label).length);
  }
  return n ? `${Math.min(n, LABEL_CAP)}ch` : undefined;
}

/** Label: value pairs, two to a row when the pane is wide. Empty slots (null, false) are skipped. */
export function KeyFacts({ items, className }: { items: Array<KeyFact | null | false | undefined>; className?: string }) {
  const list = items.filter(Boolean) as KeyFact[];
  if (!list.length) return null;
  const spans = factSpans(list);
  const labelWidth = factLabelWidth(list);
  return (
    <dl className={['key-facts', className ?? ''].filter(Boolean).join(' ')} style={labelWidth ? ({ '--key-fact-label': labelWidth } as React.CSSProperties) : undefined}>
      {list.map((f, i) => (
        <div key={i} className={spans[i] ? 'key-fact wide' : 'key-fact'}>
          <dt>{f.label}</dt>
          <dd className={f.mono ? 'mono' : undefined} title={f.title}>
            {f.value ?? <span className="faint">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface DetailHeaderProps {
  title: ReactNode;
  /** A small line above the title: what kind of thing this is. */
  eyebrow?: ReactNode;
  /** One line under the title: where it stands. An array: its parts, with a "·" drawn between them. */
  status?: ReactNode | ReactNode[];
  /** An ActionBar description (shown small, primary outlined) or ready-made buttons. */
  actions?: ActionBarProps | ReactNode;
  facts?: Array<KeyFact | null | false | undefined>;
  /** Hover text on the title (the full name when it is long). */
  titleHint?: string;
}

export function DetailHeader({ title, eyebrow, status, actions, facts, titleHint }: DetailHeaderProps) {
  return (
    <header className="detail-head">
      <div className="detail-head-top">
        <div className="detail-head-titles">
          {eyebrow ? <div className="detail-eyebrow">{eyebrow}</div> : null}
          <h2 className="detail-title" title={titleHint}>
            {title}
          </h2>
          {Array.isArray(status) ? <StatusLine parts={status} /> : status ? <div className="detail-status">{status}</div> : null}
        </div>
        {actions ? <div className="detail-actions">{isActionBarProps(actions) ? <ActionBar size="sm" primaryStyle="outline" {...actions} /> : actions}</div> : null}
      </div>
      {facts ? <KeyFacts items={facts} /> : null}
    </header>
  );
}

/**
 * A status line of several parts ("5 readings", "all above the normal range"): a "·" between parts on one line, never
 * at the start of a line when the status wraps (the inner row is shifted left by the separator's width and the line
 * clips it, so the part that starts a line shows no dot). Empty parts are skipped.
 */
export function StatusLine({ parts, className }: { parts: ReactNode[]; className?: string }) {
  const shown = Children.toArray(parts.filter((p) => p != null && p !== false && p !== ''));
  if (!shown.length) return null;
  return (
    <div className={['detail-status', 'sep-list', className ?? ''].filter(Boolean).join(' ')}>
      <div className="sep-row">
        {shown.map((p, i) => (
          <span key={i} className="sep-item">
            {p}
          </span>
        ))}
      </div>
    </div>
  );
}
