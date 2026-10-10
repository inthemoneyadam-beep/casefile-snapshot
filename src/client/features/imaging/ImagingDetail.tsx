/**
 * One scan, in the right pane of Scans and imaging (routes/imaging.tsx), in the
 * order every detail pane follows (docs/DESIGN.md):
 *
 *   header    the kind of scan, its name, one status line (its check, its date,
 *             the report it came from), the actions that matter (Open the report,
 *             Compare with the previous scan; Compare with another, Edit or Copy
 *             into my scan list, and Delete under More) and the key facts that
 *             are known (never an empty row)
 *   notices   a scan set aside, or seen only in a summary
 *   Impression and Findings   what the report says, as prose
 *   Compare   what changed between two reports, word by word
 *   Check     how it compares with your clinical records, and your own answer
 *   Image files   the scan's image files (DICOM), to open in the viewer
 *   Where this came from   the report, the detail Claude read, the quote as found
 *
 * Never an internal id, a stored code or the word "fact" on screen.
 */
import { useState } from 'react';
import type { TrustInfo } from '@shared/reconcile';
import { TrustOverride } from '../reconcile/TrustOverride';
import { CheckTag } from '../reconcile/CheckTag';
import { ReportImpression } from '../reconcile/ReportImpression';
import '../reconcile/reconcile.css';
import { Link } from '@tanstack/react-router';
import type { ActionBarProps } from '../../ui/ActionBar';
import { Button } from '../../ui/Button';
import { DateText, DateTimeText, KeepDatesWhole } from '../../ui/DateText';
import { DetailHeader, DetailPane, KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Select } from '../../ui/Field';
import { FactStatusTag, Tag } from '../../ui/StatusTag';
import { formatPartialDate } from '@shared/dates';
import { useImagingCompare, type DiffSegment, type ImagingDetail as ImagingDetailData, type ImagingEntry } from '../../api/imaging';
import type { DocumentLite } from '../../api/labs';
import { sourceLine } from '../labs/source';
import { fileKindWords, imagesWords, modalityWord, scanOriginWords } from './words';

/**
 * A scan's automatic check (verified, accurate, not compared, not backed yet,
 * inaccurate, needs a source, replaced); a scan whose detail was deleted, or
 * one typed by hand, says so.
 */
export function StudyStatusTag({ source, trust, factStatus, factBasis, factDeleted }: { source: 'row' | 'fact'; trust?: TrustInfo | null; factStatus: string | null; factBasis?: string | null; factDeleted?: boolean }) {
  if (factDeleted) return <Tag tone="ash" title="Added from a detail that was later deleted on Details from documents; not counted among the scans of the same kind">detail deleted</Tag>;
  if (trust) return <CheckTag trust={trust} />;
  if (factStatus === 'confirmed' || factStatus === 'unverified' || factStatus === 'disputed' || factStatus === 'superseded') return <FactStatusTag status={factStatus} basis={factBasis} />;
  if (source === 'fact') return <Tag tone="info" title="Read by Claude from a document">read by Claude</Tag>;
  return (
    <Tag tone="neutral" title="Typed in by hand; not compared with a record">
      entered by hand
    </Tag>
  );
}

/**
 * Scans set aside (marked wrong, replaced, deleted) are dimmed in every list;
 * a scan that disagrees with a clinical record gets a red marker. Nothing
 * waits for a check, so nothing is yellow.
 */
export function studyRowClass(s: Pick<ImagingEntry, 'factStatus' | 'factDeleted'> & { trust?: TrustInfo | null }): string | undefined {
  const dim = s.factStatus === 'disputed' || s.factStatus === 'superseded' || s.factDeleted;
  return [s.trust?.trust === 'inaccurate' ? 'inaccurate-row' : '', dim ? 'dim' : ''].filter(Boolean).join(' ') || undefined;
}

/**
 * The report a scan came from, as a link to its page. In a list the document's date leads ("2024-03-18 · MRI
 * report, p.2": the part that tells two reports apart is never the part cut off); `short` is the page alone, for
 * the By document view whose group header already names the report.
 */
export function StudySourceLink({ e, short, documentDate }: { e: Pick<ImagingEntry, 'documentId' | 'documentTitle' | 'pageNumber' | 'citationId' | 'citationVerified'>; short?: boolean; documentDate?: string | null }) {
  if (!e.documentId) return <span className="muted">entered by hand</span>;
  // The page alone, where the group row already names the report: nothing to say without a page.
  if (short && !e.pageNumber) return null;
  const line = sourceLine(e.documentTitle, documentDate ?? null, e.pageNumber);
  return (
    <Link
      to="/documents/$id"
      params={{ id: e.documentId }}
      search={{ page: e.pageNumber ?? undefined, cite: e.citationId ?? undefined }}
      className={`imaging-source${e.citationVerified === false ? ' unverified' : ''}`}
      title={`${line}${e.citationVerified === false ? ' (quote not found in the page text)' : ''}`}
      onClick={(ev) => ev.stopPropagation()}
    >
      {short ? `p.${e.pageNumber}` : line}
    </Link>
  );
}

export function DiffText({ segments }: { segments: DiffSegment[] }) {
  if (!segments.length) return <span className="muted small">Neither report has this part.</span>;
  return (
    <p className="imaging-diff">
      {segments.map((s, i) => (
        <span key={i} className={`imaging-seg ${s.kind}`}>
          {i ? ' ' : ''}
          {s.text}
        </span>
      ))}
    </p>
  );
}

export interface ImagingDetailProps {
  study: ImagingDetailData;
  compareWith: string | null;
  dicomDocuments: DocumentLite[];
  /** The study before this one of the same modality and body part (from the organised view), when there is one. */
  previous?: Pick<ImagingEntry, 'id' | 'title' | 'performedAt' | 'performedAtPrecision'> | null;
  /** Where the scan stands among the scans of its kind ("2nd of 3 MRI brain scans"), when known. */
  serial?: string | null;
  busy?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onImport: () => void;
  onCompareWith: (id: string | null) => void;
  onLinkDicom: (documentId: string) => void;
  onUnlinkDicom: (documentId: string) => void;
  /** Open the report's page (o). */
  onOpenSource?: () => void;
}

/** Puts the focus on the "Compare with" picker (c). */
export function focusComparePicker(): void {
  document.querySelector<HTMLSelectElement>('[data-compare-pick]')?.focus();
}

const dateWords = (iso: string | null, precision: string) => formatPartialDate(iso, precision as 'day') || 'no date';

/**
 * The scan's actions in order of importance: Open the report (outlined), Compare with the previous scan; under
 * More, Compare with another scan, Edit (a scan on your list) or Copy into my scan list (one Claude read), and
 * Delete (asks first).
 */
export function imagingDetailActions(s: ImagingDetailData, p: Pick<ImagingDetailProps, 'previous' | 'compareWith' | 'busy' | 'onEdit' | 'onDelete' | 'onImport' | 'onCompareWith' | 'onOpenSource'>): ActionBarProps {
  const virtual = s.source === 'fact';
  const prev = p.previous ?? null;
  return {
    primary: s.documentId && p.onOpenSource ? { label: 'Open the report', onClick: p.onOpenSource, shortcut: 'o', title: 'The page of the report this scan was read from, with the passage marked' } : null,
    secondary: [
      prev
        ? {
            label: 'Compare with the previous scan',
            onClick: () => p.onCompareWith(p.compareWith === prev.id ? null : prev.id),
            shortcut: 'p',
            pressed: p.compareWith === prev.id,
            title: `What changed since ${prev.title} (${dateWords(prev.performedAt, prev.performedAtPrecision)}), word by word`,
          }
        : null,
    ],
    more: [
      { label: 'Compare with another scan…', onClick: focusComparePicker, shortcut: 'c', disabled: !s.compareCandidates.length, title: s.compareCandidates.length ? 'Choose any other scan to compare the two reports' : 'There is no other scan to compare with' },
      virtual
        ? { label: 'Copy into my scan list', onClick: p.onImport, shortcut: 'i', disabled: p.busy || s.factStatus === 'disputed', title: 'Claude read this scan from the report. A copy in your own scan list can be edited and can have its image files attached; it stays linked to its page.' }
        : { label: 'Edit', onClick: p.onEdit, shortcut: 'e', disabled: p.busy, title: 'Change the scan’s date, type, report or notes' },
      virtual ? null : 'separator',
      virtual ? null : { label: 'Delete…', onClick: p.onDelete, shortcut: 'Delete', danger: true, disabled: p.busy, title: 'Hide this scan (asks first; it is not erased)' },
    ],
  };
}

/** The key facts that are known, in plain words; an unknown one is left out, never shown as a dash. */
export function imagingFacts(s: ImagingDetailData, serial?: string | null): KeyFact[] {
  const images = imagesWords(s);
  const out: Array<KeyFact | null> = [
    { label: 'Type', value: modalityWord(s.modality) },
    s.performedAt || s.performedAtText ? { label: 'Date', value: <DateText iso={s.performedAt} precision={s.performedAtPrecision} text={s.performedAtText} /> } : { label: 'Date', value: <span className="muted">not given</span> },
    s.bodyPart ? { label: 'Body part', value: s.bodyPart } : null,
    s.contrast ? { label: 'Contrast', value: s.contrast } : null,
    s.institutionName || s.institutionId ? { label: 'Where', value: s.institutionId ? <Link to="/people" search={{ id: s.institutionId }}>{s.institutionName ?? 'Open'}</Link> : s.institutionName } : null,
    images ? { label: 'Images', value: images } : null,
    serial ? { label: 'In order', value: serial } : null,
    // A scan typed in by hand already says so in its status line; the fact is kept for the ones Claude read.
    s.source === 'row' && !s.factId && !s.factDeleted ? null : { label: 'Entered', value: scanOriginWords(s) },
    s.notes ? { label: 'Notes', value: s.notes, wide: true } : null,
  ];
  return out.filter((f): f is KeyFact => Boolean(f));
}

export function ImagingDetail({ study: s, compareWith, dicomDocuments, previous, serial, busy, onEdit, onDelete, onImport, onCompareWith, onLinkDicom, onUnlinkDicom, onOpenSource }: ImagingDetailProps) {
  const virtual = s.source === 'fact';
  const cmp = useImagingCompare(s.id, compareWith);
  const [linkPick, setLinkPick] = useState('');
  const linkable = dicomDocuments.filter((d) => d.kind === 'dicom' && !s.dicomDocumentIds.includes(d.id));
  const other = cmp.data ? (cmp.data.a.id === s.id ? cmp.data.b : cmp.data.a) : null;
  const hasCheck = Boolean(s.factId && !s.factDeleted);

  return (
    <DetailPane label="Scan" className="imaging-detail">
      <DetailHeader
        eyebrow={
          <>
            <Tag tone="neutral">{modalityWord(s.modality)}</Tag>
            <span>Scan</span>
          </>
        }
        title={s.title}
        status={[
          <StudyStatusTag key="check" source={s.source} trust={s.trust} factStatus={s.factStatus} factBasis={s.factBasis} factDeleted={s.factDeleted} />,
          s.performedAt ? <DateText key="date" iso={s.performedAt} precision={s.performedAtPrecision} text={s.performedAtText} /> : null,
          s.documentId ? (
            <span key="from">
              from <StudySourceLink e={s} />
            </span>
          ) : (
            <span key="from">no report on file</span>
          ),
        ]}
        actions={imagingDetailActions(s, { previous, compareWith, busy, onEdit, onDelete, onImport, onCompareWith, onOpenSource })}
        facts={imagingFacts(s, serial)}
      />

      {s.factDeleted ? (
        <div className="notice small">The detail this scan was added from was deleted on Details from documents. The scan stays listed with its report link, but it is not counted among the scans of the same kind. Delete it here if the scan itself is wrong.</div>
      ) : s.factStatus === 'superseded' ? (
        <div className="notice small">
          {s.trust?.trust === 'inaccurate'
            ? `It disagrees with ${s.trust.recordDocumentTitle ?? 'the clinical record'}, whose report is used instead, so it is not counted among the scans of the same kind.`
            : s.trust?.trust === 'accurate'
              ? `It repeats ${s.trust.recordDocumentTitle ?? 'the clinical record'}, which is listed on its own, so this copy is not counted among the scans of the same kind.`
              : 'The detail behind this scan was replaced by a newer reading or merged into its duplicate, so it is not counted among the scans of the same kind. The one that replaced it is listed on its own.'}
        </div>
      ) : null}
      {s.factStatus === 'confirmed' && s.factBasis === 'summary' && !s.factDeleted ? (
        <div className="notice small">You have only seen this result in a summary, not the original report. The original is on your Records checklist to request.</div>
      ) : null}

      <Section title="Impression">
        {s.impression ? <p className="imaging-impression">
            <KeepDatesWhole text={s.impression} />
          </p> : <p className="muted small imaging-none">The report’s conclusion was not recorded for this scan.</p>}
        {hasCheck ? <ReportImpression factId={s.factId!} trust={s.trust} /> : null}
      </Section>
      {s.findings ? (
        <Section title="Findings">
          <p className="imaging-findings">
            <KeepDatesWhole text={s.findings} />
          </p>
        </Section>
      ) : null}

      <Section
        title="Compare with another scan"
        intro={
          other ? (
            <>
              What changed between this report and {other.title} (<span className="mono nowrap">{dateWords(other.performedAt, other.performedAtPrecision)}</span>), word by word.
            </>
          ) : s.compareCandidates.length ? (
            'Choose a scan to see what changed between the two reports, word by word.'
          ) : null
        }
      >
        {s.compareCandidates.length ? (
          <div className="imaging-compare-pick">
            <label className="filter-label" htmlFor={`compare-${s.id}`}>
              Compare with:
            </label>
            <Select
              id={`compare-${s.id}`}
              data-compare-pick
              aria-label="Compare with"
              value={compareWith ?? ''}
              options={s.compareCandidates.map((c) => ({ value: c.id, label: `${dateWords(c.performedAt, c.performedAtPrecision)} · ${c.title}${c.modality !== s.modality ? ` (${modalityWord(c.modality)})` : ''}` }))}
              placeholder="Choose a scan"
              onChange={(e) => onCompareWith(e.target.value || null)}
            />
            {compareWith ? (
              <Button size="sm" variant="ghost" onClick={() => onCompareWith(null)}>
                Stop comparing
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="muted small imaging-none">There is no other scan to compare with yet.</p>
        )}
        {compareWith ? (
          cmp.isPending ? (
            <p className="muted small imaging-none" role="status">
              Comparing the two reports…
            </p>
          ) : cmp.isError ? (
            <div className="notice bad small">{cmp.error instanceof Error ? cmp.error.message : 'Could not compare.'}</div>
          ) : cmp.data ? (
            <div className="stack">
              <p className="imaging-diff-legend">
                The older report comes first. Words the newer report <span className="add">added</span> are underlined in green; words it <span className="del">removed</span> are struck through in red. <span className="mono">{cmp.data.stats.impression.added + cmp.data.stats.findings.added}</span> added, <span className="mono">{cmp.data.stats.impression.removed + cmp.data.stats.findings.removed}</span> removed,{' '}
                <span className="mono">{cmp.data.stats.impression.same + cmp.data.stats.findings.same}</span> the same.
              </p>
              <div className="stack tight">
                <h5 className="imaging-compare-head">Impression</h5>
                <DiffText segments={cmp.data.impression} />
              </div>
              <div className="stack tight">
                <h5 className="imaging-compare-head">Findings</h5>
                <DiffText segments={cmp.data.findings} />
              </div>
            </div>
          ) : null
        ) : null}
      </Section>

      {hasCheck ? (
        <Section title="Check" intro="How this scan compares with your clinical records. Give your own answer only when you know better.">
          <TrustOverride factId={s.factId!} trust={s.trust} status={s.factStatus} basis={s.factBasis} reconciled />
        </Section>
      ) : null}

      <Section title="Image files" count={s.dicomDocuments.length || undefined} intro={virtual ? 'Image files can be attached once the scan is copied into your scan list (More).' : null}>
        {s.dicomDocuments.length ? (
          <div className="imaging-dicom">
            {s.dicomDocuments.map((d) => (
              <div key={d.id} className="row-item">
                <span className="imaging-dicom-name">
                  <Link to="/documents/$id" params={{ id: d.id }}>
                    {d.title}
                  </Link>
                  <span className="muted small"> · {fileKindWords(d.kind)}</span>
                </span>
                <span className="row imaging-dicom-actions">
                  {d.kind === 'dicom' ? (
                    <Link to="/imaging/viewer/$id" params={{ id: d.id }} title="Open the images in the scan image viewer">
                      Open in the viewer
                    </Link>
                  ) : null}
                  {!virtual ? (
                    <Button size="sm" variant="ghost" onClick={() => onUnlinkDicom(d.id)} disabled={busy} title="Detach this file from the scan (the file stays in Documents)">
                      Detach
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted small imaging-none">{s.hasImages ? 'You have the images, but no image file is attached here yet.' : 'No image files are attached to this scan.'}</p>
        )}
        {!virtual && linkable.length ? (
          <div className="imaging-compare-pick">
            <label className="filter-label" htmlFor={`attach-${s.id}`}>
              Attach:
            </label>
            <Select id={`attach-${s.id}`} aria-label="Attach an image file" value={linkPick} options={linkable.map((d) => ({ value: d.id, label: d.title }))} placeholder="Choose an image file" onChange={(e) => setLinkPick(e.target.value)} />
            <Button
              size="sm"
              disabled={!linkPick || busy}
              onClick={() => {
                if (linkPick) onLinkDicom(linkPick);
                setLinkPick('');
              }}
            >
              Attach
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title="Where this came from">
        <KeyFacts
          items={[
            { label: 'Report', value: s.documentId ? <StudySourceLink e={s} /> : <span className="muted">none; entered by hand</span>, wide: true },
            s.factId ? { label: 'The detail', value: <Link to="/facts" search={{ id: s.factId }}>Open it in Details from documents</Link>, wide: true } : s.factDeleted ? { label: 'The detail', value: <span className="muted">deleted</span>, wide: true } : null,
            s.factStatement ? { label: 'As Claude read it', value: <span className="small muted">{s.factStatement}</span>, wide: true } : null,
          ]}
        />
        {s.quote ? (
          <div className="stack tight">
            <blockquote className={`imaging-quote${s.citationVerified ? ' verified' : ''}`}>{s.quote}</blockquote>
            <div className="row wrap small">{s.citationVerified ? <span className="muted">Found word for word on the page.</span> : <Tag tone="warn">quote not found in the page text</Tag>}</div>
          </div>
        ) : null}
        <p className="imaging-added">
          Added <DateTimeText iso={s.createdAt} />
        </p>
      </Section>
    </DetailPane>
  );
}
