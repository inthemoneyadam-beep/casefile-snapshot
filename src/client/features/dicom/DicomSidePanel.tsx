/**
 * The viewer's right column, in order of use: where these images sit in the
 * case (the scans and checklist rows that point at them, the document that
 * holds this file), the study, this image (its size, spacing, window), then the
 * technical details folded away, and, with `i`, every element of the file with
 * its dictionary name. Only what is known is listed (never an empty row); the
 * file's ids (UIDs) sit with the technical details, never up front.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { DicomInstanceDetail, DicomStudySummary, DicomTag } from '../../api/dicom';
import { Button } from '../../ui/Button';
import { DateText } from '../../ui/DateText';
import { DetailPane, KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { recordStatusWords } from '../records/words';

const fmt = (n: number | null | undefined, digits = 4) => (n === null || n === undefined ? null : String(Number(n.toPrecision(digits))));

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A key fact only when its value is known: an unknown one is left out, never shown as a dash. */
export function known(label: ReactNode, value: ReactNode, mono = false, wide = false): KeyFact | null {
  if (value === null || value === undefined || value === '') return null;
  return { label, value, mono, wide };
}

/** "120 images", "1 image" */
const images = (n: number) => `${n} image${n === 1 ? '' : 's'}`;

/** The facts of the study: what it was, when, where; its counts. */
export function studyFacts(study: Omit<DicomStudySummary, 'series'>): Array<KeyFact | null> {
  return [
    known('Description', study.description),
    known('Date', study.date ? <DateText iso={study.date} precision={study.datePrecision} text={study.dateText} /> : null),
    known('Types', study.modalities.length ? study.modalities.join(', ') : null),
    known('Where', study.institution),
    known('Accession number', study.accession, true),
    known('Patient', study.patientName || study.patientId ? [study.patientName, study.patientId ? `(${study.patientId})` : null].filter(Boolean).join(' ') : null),
    known('Contents', `${study.seriesCount} series · ${images(study.instanceCount)}`, true),
  ];
}

/** The facts of the image on screen: the file, its number, its size and spacing, its window and values. */
export function imageFacts(instance: DicomInstanceDetail): Array<KeyFact | null> {
  return [
    known('File', `${instance.filename} · ${formatBytes(instance.sizeBytes).replace(' ', '\u00a0')}`, true, true),
    known('Image number', instance.instanceNumber !== null ? String(instance.instanceNumber) : null, true),
    known('Series', instance.seriesDescription),
    known('Size', instance.rows && instance.columns ? `${instance.columns} × ${instance.rows} pixels${instance.frames > 1 ? ` · ${instance.frames} frames` : ''}` : null, true),
    known('Pixel size', instance.pixelSpacing ? `${instance.pixelSpacing.map((v) => fmt(v)).join(' × ')} mm` : null, true),
    known('Slice thickness', instance.sliceThickness !== null ? `${fmt(instance.sliceThickness)} mm` : null, true),
    known('Position', instance.sliceLocation !== null ? `${fmt(instance.sliceLocation)} mm` : null, true),
    known(
      'Window in the file',
      instance.windowCenter !== null && instance.windowWidth !== null ? `${fmt(instance.windowCenter)} / ${fmt(instance.windowWidth)}${instance.windowExplanation ? ` ${instance.windowExplanation}` : ''}` : 'none; the image’s own range is used',
      instance.windowCenter !== null,
    ),
    known('Values', instance.range ? `${fmt(instance.range.min, 6)} to ${fmt(instance.range.max, 6)}` : null, true),
    !instance.decodable ? known('Shown here', <span className="muted">{instance.reason}</span>, false, true) : null,
  ];
}

/** The technical details: how the pixels are stored, and the file's ids. Folded away by default. */
export function technicalFacts(study: Omit<DicomStudySummary, 'series'> | null, instance: DicomInstanceDetail | null): Array<KeyFact | null> {
  return [
    instance ? known('Encoding', instance.transferSyntaxName, false, true) : null,
    instance
      ? known(
          'Pixel format',
          [instance.photometric, instance.bitsAllocated ? `${instance.bitsStored ?? instance.bitsAllocated} of ${instance.bitsAllocated} bits${instance.pixelRepresentation === 1 ? ', signed' : ''}` : null].filter(Boolean).join(' · ') || null,
          true,
          true,
        )
      : null,
    instance && (instance.rescaleSlope !== null || instance.rescaleIntercept !== null)
      ? known('Rescale', `× ${fmt(instance.rescaleSlope ?? 1)} + ${fmt(instance.rescaleIntercept ?? 0)}${instance.rescaleType ? ` ${instance.rescaleType}` : ''}${instance.voiLutFunction && instance.voiLutFunction !== 'LINEAR' ? ` · ${instance.voiLutFunction}` : ''}`, true, true)
      : null,
    instance && instance.warnings.length ? known('While reading', instance.warnings.join('; '), false, true) : null,
    study?.studyUid ? known('Study id (UID)', <span className="dicom-uid">{study.studyUid}</span>, false, true) : null,
    instance?.sopUid ? known('Image id (UID)', <span className="dicom-uid">{instance.sopUid}</span>, false, true) : null,
  ];
}

export function DicomSidePanel({
  study,
  instance,
  showTags,
  tags,
  tagsLoading,
  tagsError,
  onToggleTags,
}: {
  study: Omit<DicomStudySummary, 'series'> | null;
  instance: DicomInstanceDetail | null;
  showTags: boolean;
  tags: DicomTag[] | null;
  tagsLoading: boolean;
  tagsError: string | null;
  /** Show or hide every element of the file (i). */
  onToggleTags?: () => void;
}) {
  const tech = technicalFacts(study, instance).filter(Boolean);
  return (
    <div className="dicom-col dicom-side">
      <DetailPane label="About these images">
        <Section title="In the case">
          <div className="dicom-links">
            {instance ? (
              <div className="row-item">
                <Link to="/documents/$id" params={{ id: instance.documentId }} title="The document that holds this file">
                  {instance.title}
                </Link>
                <span className="muted small">this file</span>
              </div>
            ) : null}
            {study?.imagingStudies.map((s) => (
              <div className="row-item" key={s.id}>
                <Link to="/imaging" search={{ id: s.id }} title={s.linked ? 'This scan lists these images' : 'A scan on the same day; these images are not attached to it'}>
                  {s.title}
                </Link>
                <span className="row dicom-link-tags">
                  {s.performedAt ? <DateText iso={s.performedAt} precision={s.performedAtPrecision} className="muted small" /> : null}
                  <Tag tone={s.linked ? 'ok' : 'neutral'} title={s.linked ? 'These images are attached to this scan' : 'Same day, not attached'}>
                    {s.linked ? 'attached' : 'same day'}
                  </Tag>
                </span>
              </div>
            ))}
            {study?.records.map((r) => (
              <div className="row-item" key={r.id}>
                <Link to="/records" search={{ id: r.id }} title={r.linked ? 'This checklist row holds this file' : 'A checklist row for images on the same day'}>
                  {r.title}
                </Link>
                <span className="row dicom-link-tags">
                  <span className="muted small">{recordStatusWords(r.status)}</span>
                  <Tag tone={r.linked ? 'ok' : 'neutral'} title={r.linked ? 'This checklist row holds this file' : 'Same day, not attached'}>
                    {r.linked ? 'attached' : 'same day'}
                  </Tag>
                </span>
              </div>
            ))}
            {study && !study.imagingStudies.length && !study.records.length ? <p className="muted small dicom-none">No scan or checklist row points at these images yet.</p> : null}
            {!study && !instance ? <p className="muted small dicom-none">Once a series is open, this says which scan and checklist row its images belong to, and describes the study and each image.</p> : null}
          </div>
        </Section>

        {study ? (
          <Section title="Study">
            <KeyFacts items={studyFacts(study)} />
          </Section>
        ) : null}

        {instance ? (
          <Section title="This image">
            <KeyFacts items={imageFacts(instance)} />
          </Section>
        ) : null}

        {tech.length ? (
          <details className="dicom-tech">
            <summary>Technical details</summary>
            <KeyFacts items={tech} />
          </details>
        ) : null}

        {showTags ? (
          <TagTable tags={tags} loading={tagsLoading} error={tagsError} />
        ) : instance && onToggleTags ? (
          <div>
            <Button size="sm" onClick={onToggleTags} shortcut="i" title="Every element stored in the file, with its name">
              Show every detail in the file
            </Button>
          </div>
        ) : null}
      </DetailPane>
    </div>
  );
}

function TagTable({ tags, loading, error }: { tags: DicomTag[] | null; loading: boolean; error: string | null }) {
  const [q, setQ] = useState('');
  // Shown on request (File details, i): brought into view, since it sits under the image's facts.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!tags) return [];
    if (!needle) return tags;
    return tags.filter((t) => t.tag.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle) || t.value.toLowerCase().includes(needle));
  }, [tags, q]);
  return (
    <Section title="Every detail in the file" count={tags ? tags.length : undefined}>
      <div className="dicom-tags" ref={ref}>
        <label className="search-field dicom-tags-find">
          <span className="filter-label">Find</span>
          <input type="search" placeholder="Tag number, name or value" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find in the file's details: tag number, name or value" onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLInputElement).blur()} />
        </label>
        {loading ? (
          <p className="muted small dicom-none" role="status">
            Reading the file…
          </p>
        ) : error ? (
          <p className="muted small dicom-none">Could not read the details: {error}</p>
        ) : null}
        {tags ? (
          <table>
            <thead>
              <tr>
                <th className="tag-id">Tag</th>
                <th className="tag-vr" title="Value representation: how the value is stored">
                  Kind
                </th>
                <th className="tag-name">Name</th>
                <th className="tag-value">Value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t, i) => (
                <tr key={`${t.tag}-${i}`} className={t.private ? 'private' : undefined}>
                  <td className="tag-id" style={t.depth ? { paddingLeft: 4 + t.depth * 8 } : undefined}>
                    {t.tag}
                  </td>
                  <td className="tag-vr">{t.vr ?? ''}</td>
                  <td className="tag-name">{t.name}</td>
                  <td className="tag-value" title={t.value}>
                    {t.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {tags && !shown.length ? <p className="muted small dicom-none">No detail matches.</p> : null}
      </div>
    </Section>
  );
}
