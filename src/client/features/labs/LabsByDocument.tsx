/**
 * By document view of the labs ledger: everything pulled from one report
 * stacked under a document header (its title, its date when the title does not
 * already say it, and where it came from in plain words), with one sub-header
 * per sample and panel in report order, so a lumbar puncture reads as one block
 * and a blood count as another. Rows are the values themselves (row ids or
 * `fact:<id>` for values read from a document; one part of a line that held
 * several tests is `<row or fact id>#<index>`, shown with that line, faint), so
 * the selection carries over to the All values view unchanged.
 */
import { useMemo, type ReactNode } from 'react';
import '../reconcile/reconcile.css';
import { displayRef, labRowClass } from '../../api/labs';
import { readingOf } from './reading';
import { Link } from '@tanstack/react-router';
import { GroupedList, type GroupedListColumn, type GroupedListGroup } from '../../ui/GroupedList';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { sourceWords } from './source';
import { type DocumentLabs, type DocumentPanel, type DocumentSpecimen, type LabSeriesRow } from '../../api/labs';
import { SourceLink } from './AnalyteDetail';
import { Breakable, LineNote, SourceTag, TierTag, ValueRangeTag } from './tags';
import type { TestRange } from './range';

export const NO_DOCUMENT_KEY = 'none';

export function labDocumentKey(d: { documentId: string | null }): string {
  return d.documentId ?? NO_DOCUMENT_KEY;
}

function panelHeader(s: DocumentSpecimen, p: DocumentPanel): ReactNode {
  // CSF panels already say "CSF"; blood and urine panels get the sample in front.
  return s.specimen === 'csf' ? p.panel : `${s.label} · ${p.panel}`;
}

/** The title already ends with its date ("Lab report, 2024-09-17"): the date is not said twice. */
export function titleHasDate(title: string, date: string | null | undefined): boolean {
  return Boolean(date) && title.includes(String(date).slice(0, 10));
}

/**
 * The document's header: its date first (in the mono, the part that tells two reports apart, never cut), then its
 * name without that date repeated, wrapping to two lines before it ends with "…" (the whole on hover); then its
 * kind, where it came from and Open the document, which never give way.
 */
function DocumentHeader({ d }: { d: DocumentLabs }) {
  const w = sourceWords(d.title, null);
  // A date at the end of the name leads instead ("2024-05-01 · Summary of lab report"); a name that holds its date
  // elsewhere keeps it there; otherwise the document's own date leads.
  const lead = w.date ? <span className="mono">{w.date}</span> : d.date && !titleHasDate(d.title, d.date) ? <DateText iso={d.date} precision={d.datePrecision} /> : null;
  const name = w.date ? w.name : d.title;
  return (
    <>
      <span className="labs-doc-head" title={d.title}>
        {lead ? (
          <>
            <span className="labs-doc-date">{lead}</span>
            {' · '}
          </>
        ) : null}
        <span className="labs-doc-title">
          <KeepDatesWhole text={name} />
        </span>
      </span>
      {!d.date && !w.date && d.documentId ? <span className="muted small">not dated</span> : null}
      <TierTag tier={d.tier} />
      {d.institutionName ? <span className="muted small">{d.institutionName}</span> : null}
      {d.documentId ? (
        <Link to="/documents/$id" params={{ id: d.documentId }} className="labs-doc-open" onClick={(e) => e.stopPropagation()} title="Open the document">
          Open the document
        </Link>
      ) : null}
    </>
  );
}

export interface LabsByDocumentProps {
  documents: DocumentLabs[];
  selectedId: string | null;
  onSelect: (r: LabSeriesRow | null) => void;
  onOpen: (r: LabSeriesRow) => void;
  emptyText: string;
  footer?: ReactNode;
  /** Ignored (kept for older callers): each value is judged only against the range printed with it (rule 8). */
  testRanges?: ReadonlyMap<string, TestRange>;
  /** Each test's one name by `analyteKey::specimen` (the same in every view); the report's own wording shows in the value's detail. */
  names?: ReadonlyMap<string, string>;
}

export const CHECK_TITLE = 'How the value compares with your clinical records: verified (from a record), accurate (matches one), not backed yet (nothing to compare with), inaccurate (disagrees with a record).';

export function LabsByDocument({ documents, selectedId, onSelect, onOpen, emptyText, footer, names }: LabsByDocumentProps) {
  const groups = useMemo<GroupedListGroup<LabSeriesRow>[]>(
    () =>
      documents.map((d) => {
        const key = labDocumentKey(d);
        return {
          key,
          header: <DocumentHeader d={d} />,
          subgroups: d.specimens.flatMap((s) => s.panels.map((p) => ({ key: `${key}|${s.specimen}|${p.panel}`, header: panelHeader(s, p), rows: p.rows, rule: s.specimen === 'csf' }))),
        };
      }),
    [documents],
  );

  const columns = useMemo<GroupedListColumn<LabSeriesRow>[]>(
    () => [
      // Widths that fit the pane at 1280px (657px): Test 160 + Value 124-148 + Normal range ~100 + Date 96 + Page 52 +
      // Check from 88 (its tag). The note "from one line" is short and the whole line is on its hover, so it never
      // doubles a row.
      {
        id: 'analyte',
        header: 'Test',
        grow: true,
        minWidth: 160,
        cell: (r) => (
          <>
            <Breakable text={names?.get(`${r.analyteKey}::${r.specimen}`) ?? r.analyte} />
            <LineNote entry={r} />
          </>
        ),
      },
      {
        id: 'value',
        header: 'Value',
        width: 124,
        maxWidth: 148,
        wrap: true,
        cell: (r) => (
          <span className="labs-value">
            <span className="mono">{r.value ? <Breakable text={r.value} /> : '—'}</span>
            {r.unit ? <span className="labs-unit"> {r.unit}</span> : null} <ValueRangeTag value={r} />
          </span>
        ),
      },
      {
        id: 'ref',
        header: 'Normal range',
        width: 96,
        maxWidth: 150,
        shrink: false,
        // Two lines at most: "(this document's)" moves under the range whole instead of being cut to "(this docu…".
        wrap: true,
        // A summary's own range is its claim, said so (never shown bare like a lab's).
        cell: (r) => {
          const ref = displayRef(r) ?? '';
          const claimed = Boolean(ref) && readingOf(r).role === 'claimed';
          return (
            <span className="mono muted" title={claimed ? "The range this document gives, not the lab's" : undefined}>
              {ref}
              {claimed ? (
                <>
                  {' '}
                  <span className="nowrap">(this document's)</span>
                </>
              ) : null}
            </span>
          );
        },
      },
      { id: 'date', header: 'Date', width: 96, shrink: false, cell: (r) => <DateText iso={r.date} precision={r.datePrecision} text={r.dateText} /> },
      { id: 'page', header: 'Page', width: 52, shrink: false, cell: (r) => <SourceLink row={r} short /> },
      { id: 'status', header: <span title={CHECK_TITLE}>Check</span>, width: 88, shrink: false, cell: (r) => <SourceTag source={r.source} trust={r.trust} factStatus={r.factStatus} factBasis={r.factBasis} factDeleted={r.factDeleted} notes={r.notes} computed={r.computed} /> },
    ],
    [names],
  );

  return (
    <GroupedList
      groups={groups}
      columns={columns}
      rowId={(r) => r.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      storageKey="labs.documents"
      emptyText={emptyText}
      footer={footer}
      rowNoun="value"
      rowClassName={labRowClass}
      autoFocus
    />
  );
}
