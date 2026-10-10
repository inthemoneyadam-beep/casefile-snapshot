/**
 * Page and section headers, empty and loading states.
 *
 *   <PageHeader
 *     title="Lab results"
 *     meta={<span className="mono">10 tests · 30 values</span>}
 *     intro="Every lab value, grouped by test. Each value is checked against your clinical records."
 *     actions={{ primary: { label: 'Add a lab value', onClick: add, shortcut: 'n' }, more: [...] }}
 *   />
 *
 * PageHeader   the page title (serif), one line of counts (`meta`, or the older
 *              `sub`), ONE plain sentence of what the page is for (`intro`), and
 *              the page's actions on the right: an ActionBar description
 *              (ui/ActionBar.tsx) or ready-made buttons
 * Section      a section of a pane: a readable sans header in sentence case,
 *              its count, a few actions on the right, an optional intro line
 * Meta         label: value lines (older form; KeyFacts in ui/DetailPane.tsx
 *              is the same idea, two to a row)
 * EmptyState   what the page or list is for and the one next step
 * Loading      one muted line ("Loading tests…"), never a skeleton
 * Empty        the older empty line inside a list
 */
import type { ReactNode } from 'react';
import { ActionBar, isActionBarProps, type ActionBarProps } from './ActionBar';

export interface PageHeaderProps {
  title: ReactNode;
  /** One line of counts or context under the title (mono for numbers). */
  meta?: ReactNode;
  /** Older name for `meta`. */
  sub?: ReactNode;
  /** One plain sentence: what this page is for. */
  intro?: ReactNode;
  /** An ActionBar description or ready-made buttons. */
  actions?: ActionBarProps | ReactNode;
}

export function PageHeader({ title, meta, sub, intro, actions }: PageHeaderProps) {
  const line = meta ?? sub;
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {line ? <div className="sub">{line}</div> : null}
        {intro ? <p className="page-header-intro">{intro}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{isActionBarProps(actions) ? <ActionBar {...actions} /> : actions}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="table-empty">{children}</div>;
}

/** What this page or list is for, and the one next step (a button or a sentence). */
export function EmptyState({ title, children, action }: { title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {title ? <p className="empty-state-title">{title}</p> : null}
      {children ? <p className="empty-state-body">{children}</p> : null}
      {action ?? null}
    </div>
  );
}

/** A single muted line while something loads. */
export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p className="loading-line" role="status">
      {children}
    </p>
  );
}

export interface SectionProps {
  title: ReactNode;
  /** How many things the section holds, shown beside the title in the mono. */
  count?: ReactNode;
  /** A few actions on the right of the header (text buttons, size sm). */
  actions?: ReactNode;
  /** One muted line under the header saying what the section shows. */
  intro?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Section({ title, count, actions, intro, id, className, children }: SectionProps) {
  return (
    <div className={['section', className ?? ''].filter(Boolean).join(' ')} id={id}>
      <div className="section-title">
        <h4>
          {title}
          {count != null && count !== '' ? <span className="section-count">{count}</span> : null}
        </h4>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
      {intro ? <p className="section-intro">{intro}</p> : null}
      {children}
    </div>
  );
}

export function Meta({ items }: { items: Array<[ReactNode, ReactNode] | null | false | undefined> }) {
  return (
    <dl className="detail-meta">
      {items.filter(Boolean).map((it, i) => {
        const [k, v] = it as [ReactNode, ReactNode];
        return (
          <div key={i} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v ?? <span className="faint">—</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}
