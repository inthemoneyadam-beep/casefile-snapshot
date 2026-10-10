/**
 * Grouped views of Scans and imaging.
 *
 * `ImagingByModality`: one group row per kind of scan (MRI, CT, ...), one
 * sub-group row per body part (Brain, Cervical spine, ...), and under it the
 * scans in date order. Where a scan stands among the scans of its kind ("2nd
 * of 3") is said in its pane; Compare with the previous scan is the pane's
 * action (and the p key), so the list keeps the room for the scan's name.
 *
 * `ImagingByDocument`: scans stacked under the report they came from. The
 * report's header leads with its date (the part that tells two reports apart,
 * never cut), then its name, where it came from and Open the report; scans
 * entered by hand without a report come last.
 *
 * Columns: the scan's name takes the room (two lines, then "…", the whole on
 * hover); the report column leads with the report's date. Widths can be dragged
 * and are remembered per view.
 */
import { useMemo, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { GroupedList, type GroupedListColumn, type GroupedListGroup } from '../../ui/GroupedList';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import type { DocumentImaging, ImagingEntry, ImagingGroup, SerialStudy } from '../../api/imaging';
import { TierTag } from '../documents/tier';
import { sourceWords } from '../labs/source';
import { StudySourceLink, StudyStatusTag, studyRowClass } from './ImagingDetail';
import { imagesWords, modalityWord, serialWords } from './words';

export const NO_REPORT_KEY = 'none';
export const SCAN_NOUN = ['scan', 'scans'] as const;

/** Every study of the organised groups, flat, for selection lookups. */
export function flattenGroups(groups: ImagingGroup[]): SerialStudy[] {
  return groups.flatMap((g) => g.studies);
}

/** Where a scan stands among the scans of its kind, from the organised groups ("2nd of 3 MRI brain scans"). */
export function serialWordsFor(groups: ImagingGroup[], id: string | null): string | null {
  if (!id) return null;
  for (const g of groups) {
    const s = g.studies.find((x) => x.id === id);
    if (s) return serialWords(s.serial, g.studies.filter((x) => x.serial > 0).length, s.modality, g.bodyPart);
  }
  return null;
}

/** The scan's image files in a list cell: "3 image files", "images held", or nothing. */
export function ImagesCell({ e }: { e: Pick<ImagingEntry, 'dicomCount' | 'hasImages'> }) {
  const w = imagesWords(e);
  return w ? <span className="muted">{w}</span> : null;
}

export interface ImagingByModalityProps {
  groups: ImagingGroup[];
  selectedId: string | null;
  onSelect: (s: SerialStudy | null) => void;
  onOpen: (s: SerialStudy) => void;
  /** Kept for older callers: comparing is the pane's action now (Compare with the previous scan, p). */
  onComparePrevious?: (s: SerialStudy) => void;
  emptyText: string;
  footer?: ReactNode;
  /** Each report's own date by document id, so the report column leads with it. */
  docDates?: ReadonlyMap<string, string | null>;
}

export function ImagingByModality({ groups, selectedId, onSelect, onOpen, emptyText, footer, docDates }: ImagingByModalityProps) {
  const folded = useMemo<GroupedListGroup<SerialStudy>[]>(() => {
    const byModality = new Map<string, GroupedListGroup<SerialStudy>>();
    for (const g of groups) {
      let m = byModality.get(g.modality);
      if (!m) {
        m = { key: g.modality, header: modalityWord(g.modality), subgroups: [] };
        byModality.set(g.modality, m);
      }
      m.subgroups!.push({ key: g.key, header: g.bodyPart, rows: g.studies });
    }
    return [...byModality.values()];
  }, [groups]);

  const columns = useMemo<GroupedListColumn<SerialStudy>[]>(
    () => [
      { id: 'date', header: 'Date', width: 96, shrink: false, cell: (s) => <DateText iso={s.performedAt} precision={s.performedAtPrecision} text={s.performedAtText} /> },
      { id: 'title', header: 'Scan', grow: true, minWidth: 160, cell: (s) => s.title },
      { id: 'report', header: 'Report', grow: true, minWidth: 120, cell: (s) => <StudySourceLink e={s} documentDate={s.documentId ? (docDates?.get(s.documentId) ?? null) : null} /> },
      { id: 'images', header: 'Images', width: 96, maxWidth: 130, cell: (s) => <ImagesCell e={s} /> },
      { id: 'status', header: 'Check', width: 100, shrink: false, cell: (s) => <StudyStatusTag source={s.source} trust={s.trust} factStatus={s.factStatus} factBasis={s.factBasis} factDeleted={s.factDeleted} /> },
    ],
    [docDates],
  );

  return (
    <GroupedList
      groups={folded}
      columns={columns}
      rowId={(s) => s.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      storageKey="imaging.modality"
      emptyText={emptyText}
      footer={footer}
      rowClassName={studyRowClass}
      rowNoun={SCAN_NOUN}
      autoFocus
    />
  );
}

/**
 * The report's group header: its date first (never cut), then its name without that date repeated, wrapping to two
 * lines before it ends with "…" (the whole on hover); then where it came from and Open the report.
 */
function ReportHeader({ d }: { d: DocumentImaging }) {
  if (!d.documentId) return <span className="imaging-doc-head">Entered by hand, without a report</span>;
  const w = sourceWords(d.title, null);
  const lead = w.date ? <span className="mono">{w.date}</span> : d.date ? <DateText iso={d.date} precision={d.datePrecision} /> : null;
  const name = w.date ? w.name : d.title;
  return (
    <>
      <span className="imaging-doc-head" title={d.title}>
        {lead ? (
          <>
            <span className="imaging-doc-date">{lead}</span>
            {' · '}
          </>
        ) : null}
        <span className="imaging-doc-title">
          <KeepDatesWhole text={name} />
        </span>
      </span>
      {!lead ? <span className="muted small">not dated</span> : null}
      <TierTag tier={d.tier} />
      <Link to="/documents/$id" params={{ id: d.documentId }} className="imaging-doc-open" onClick={(e) => e.stopPropagation()} title="Open the report">
        Open the report
      </Link>
    </>
  );
}

export interface ImagingByDocumentProps {
  documents: DocumentImaging[];
  selectedId: string | null;
  onSelect: (s: ImagingEntry | null) => void;
  onOpen: (s: ImagingEntry) => void;
  emptyText: string;
  footer?: ReactNode;
}

export function ImagingByDocument({ documents, selectedId, onSelect, onOpen, emptyText, footer }: ImagingByDocumentProps) {
  const groups = useMemo<GroupedListGroup<ImagingEntry>[]>(() => documents.map((d) => ({ key: d.documentId ?? NO_REPORT_KEY, header: <ReportHeader d={d} />, rows: d.studies })), [documents]);

  // The Page column only when a row has something to say in it (a page, or "entered by hand"): never an empty column.
  const showPage = useMemo(() => documents.some((d) => d.studies.some((s) => !s.documentId || s.pageNumber)), [documents]);
  const columns = useMemo<GroupedListColumn<ImagingEntry>[]>(
    () => [
      { id: 'date', header: 'Date', width: 96, shrink: false, cell: (s) => <DateText iso={s.performedAt} precision={s.performedAtPrecision} text={s.performedAtText} /> },
      { id: 'modality', header: 'Type', width: 80, maxWidth: 110, cell: (s) => modalityWord(s.modality) },
      { id: 'title', header: 'Scan', grow: true, minWidth: 170, cell: (s) => s.title },
      ...(showPage ? [{ id: 'page', header: 'Page', width: 56, shrink: false, cell: (s: ImagingEntry) => (s.documentId ? <StudySourceLink e={s} short /> : null) }] : []),
      { id: 'images', header: 'Images', width: 96, maxWidth: 130, cell: (s) => <ImagesCell e={s} /> },
      { id: 'status', header: 'Check', width: 100, shrink: false, cell: (s) => <StudyStatusTag source={s.source} trust={s.trust} factStatus={s.factStatus} factBasis={s.factBasis} factDeleted={s.factDeleted} /> },
    ],
    [showPage],
  );

  return (
    <GroupedList
      groups={groups}
      columns={columns}
      rowId={(s) => s.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      storageKey="imaging.documents"
      emptyText={emptyText}
      footer={footer}
      rowClassName={studyRowClass}
      rowNoun={SCAN_NOUN}
      autoFocus
    />
  );
}
