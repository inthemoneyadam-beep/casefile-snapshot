/**
 * The viewer's left column: every study under a group row (its description,
 * then its date, types and where it was done), its series below as dense rows
 * (number, name, type, how many images). A row click opens the series; the
 * keys live on the page ([ and ] step series, j and k step images), so this
 * list takes no focus of its own. A series this viewer cannot show says so in
 * words ("can't show here"), with the reason on hover.
 */
import { useEffect, useRef } from 'react';
import type { DicomSeriesSummary, DicomStudySummary } from '../../api/dicom';
import { DateText } from '../../ui/DateText';
import { Tag } from '../../ui/StatusTag';

export function seriesLabel(s: Pick<DicomSeriesSummary, 'description' | 'modality' | 'number'>): string {
  return s.description || (s.modality ? `${s.modality} series` : 'Series') + (s.number !== null ? ` ${s.number}` : '');
}

export function SeriesList({ studies, selectedKey, onOpen, emptyText, footer }: { studies: DicomStudySummary[]; selectedKey: string | null; onOpen: (s: DicomSeriesSummary) => void; emptyText: string; footer?: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedKey || !wrap.current) return;
    wrap.current.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, studies]);
  const total = studies.reduce((n, s) => n + s.seriesCount, 0);
  return (
    <>
      <div className="table-wrap dicom-series" ref={wrap}>
        <table className="data-table">
          {studies.map((st) => (
            <tbody key={st.key}>
              <tr className="group-header">
                <th colSpan={4} scope="rowgroup">
                  <span className="group-header-title">
                    <span>{st.description || 'Study without a description'}</span>
                    <span className="dicom-study-sub">
                      <DateText iso={st.date} precision={st.datePrecision} text={st.dateText} />
                      {st.modalities.length ? ` · ${st.modalities.join(', ')}` : ''}
                      {st.institution ? ` · ${st.institution}` : ''}
                    </span>
                  </span>
                </th>
              </tr>
              {st.series.map((s) => {
                const selected = s.key === selectedKey;
                return (
                  <tr key={s.key} data-key={s.key} className={selected ? 'selected' : s.decodable === 'no' ? 'dim' : undefined} aria-selected={selected} onClick={() => onOpen(s)} title={s.reason ?? `${seriesLabel(s)}: ${s.instanceCount} image${s.instanceCount === 1 ? '' : 's'}`}>
                    <td className="n" style={{ width: 28 }}>
                      {s.number ?? ''}
                    </td>
                    <td className="desc">
                      {seriesLabel(s)}
                      {s.decodable === 'no' ? (
                        <span className="dicom-series-note">
                          <Tag tone="neutral" title={s.reason ? `${s.reason}. Download the original to open it in another viewer.` : 'Stored compressed; download the original to open it in another viewer'}>
                            can't show here
                          </Tag>
                        </span>
                      ) : null}
                    </td>
                    <td className="muted small dicom-series-type">{s.modality ?? ''}</td>
                    <td className="n" style={{ width: 44 }} title={s.frameCount !== s.instanceCount ? `${s.instanceCount} images, ${s.frameCount} frames` : `${s.instanceCount} images`}>
                      {s.instanceCount}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
        {studies.length === 0 ? <div className="table-empty">{emptyText}</div> : null}
      </div>
      <div className="table-foot">
        <span>
          {studies.length} stud{studies.length === 1 ? 'y' : 'ies'} · {total} series
        </span>
        {footer}
      </div>
    </>
  );
}
