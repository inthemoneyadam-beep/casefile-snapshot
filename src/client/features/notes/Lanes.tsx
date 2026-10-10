/**
 * One drug's timeline as each source states it: one row per clinical record, then one per note of the user's own, with
 * a mark where each gives a start (filled circle), a stop (open square) or a dose (small diamond). A mark in a
 * records-vs-records disagreement still open is ringed in ochre; one of his notes that differs from the settled records
 * is ringed in rust; a record he said is wrong is faint. The settled starts and stops are dashed lines across the rows.
 * Under it, the same in words, so nothing needs a hover to be read. Colours only from tokens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { chartX } from '@shared/chart';
import { whenWords, type DrugTimeline, type TimelinePoint } from '@shared/notes';

const ROW_H = 30;
const LABEL_W = 190;
const PAD_R = 24;
const AXIS_H = 22;
const DAY = 86400000;

function shortTitle(s: string, n = 28): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function ticks(min: number, max: number, width: number): number[] {
  const out: number[] = [];
  const span = max - min;
  const yearly = span > 2.5 * 365 * DAY;
  const target = Math.max(2, Math.floor(width / 90));
  const d0 = new Date(min);
  if (yearly) {
    const step = Math.max(1, Math.ceil(span / (365 * DAY) / target));
    for (let y = d0.getUTCFullYear(); ; y += step) {
      const t = Date.UTC(y, 0, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
    }
  } else {
    const step = Math.max(1, Math.ceil(span / (30 * DAY) / target));
    for (let i = 0; ; i += step) {
      const t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
    }
  }
  return out;
}

function tickLabel(t: number, yearly: boolean): string {
  const d = new Date(t);
  return yearly ? String(d.getUTCFullYear()) : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function pointWords(p: TimelinePoint): string {
  const what = p.kind === 'start' ? 'start' : p.kind === 'stop' ? 'stop' : `dose ${p.dose ?? ''}`.trim();
  return `${what} ${whenWords(p.date, p.precision)}`;
}

export function Lanes({ timeline }: { timeline: DrugTimeline }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(420, Math.floor(entries[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const openIds = useMemo(() => new Set(timeline.disagreements.filter((d) => d.open).flatMap((d) => d.groups.flatMap((g) => g.points.map((p) => p.id)))), [timeline]);
  const differIds = useMemo(() => new Set(timeline.notes.filter((n) => n.standing === 'differs' && !n.answer).map((n) => n.point.id)), [timeline]);
  // A record's date your notes won over: it stays as written, and is marked.
  const overruled = useMemo(() => {
    const out = new Set<string>();
    const won = [...timeline.settled.starts, ...timeline.settled.stops, ...timeline.settled.doses].filter((s) => s.by === 'notes' && s.recordsSaid);
    for (const l of timeline.lanes) for (const p of l.points) if (l.tier === 'record' && won.some((s) => s.kind === p.kind && s.recordsSaid!.date === p.date)) out.add(p.id);
    return out;
  }, [timeline]);
  const dated = timeline.lanes.flatMap((l) => l.points.filter((p) => p.date));
  const xs = dated.map((p) => chartX(p.date!, 'date')).filter((n) => Number.isFinite(n));
  const settledDates = [...timeline.settled.starts, ...timeline.settled.stops].map((s) => (s.date ? chartX(s.date, 'date') : NaN)).filter((n) => Number.isFinite(n));
  if (!xs.length) return <p className="nt-line">No source gives a date for this drug yet.</p>;
  const lo = Math.min(...xs, ...settledDates);
  const hi = Math.max(...xs, ...settledDates);
  const pad = Math.max(15 * DAY, (hi - lo) * 0.06);
  const min = lo - pad;
  const max = hi + pad;
  const plotW = Math.max(200, width - LABEL_W - PAD_R);
  const x = (t: number) => LABEL_W + ((t - min) / (max - min)) * plotW;
  const height = timeline.lanes.length * ROW_H + AXIS_H + 8;
  const yearly = max - min > 2.5 * 365 * DAY;

  return (
    <div className="nt-lanes">
      <div className="nt-legend" aria-hidden="true">
        <span>● start</span>
        <span>□ stop</span>
        <span>◆ dose</span>
        <span>ringed ochre: the records disagree</span>
        <span>ringed rust: your notes differ</span>
        <span>dashed: settled</span>
      </div>
      <div className="nt-lanes-wrap" ref={wrapRef}>
        <svg width={width} height={height} role="img" aria-label={`${timeline.name}: each source's dates`}>
          {timeline.lanes.map((l, i) => (
            <g key={l.documentId}>
              <rect className={`lane-row ${l.tier}`} x={0} y={i * ROW_H} width={width} height={ROW_H} />
              <text className={`lane-label ${l.tier}`} x={4} y={i * ROW_H + ROW_H / 2 + 4}>
                <title>{`${l.tier === 'record' ? 'Clinical record' : 'Your note'}: ${l.title}`}</title>
                {`${l.tier === 'note' ? 'Note: ' : ''}${shortTitle(l.title)}`}
              </text>
            </g>
          ))}
          {ticks(min, max, plotW).map((t) => (
            <g key={t}>
              <line className="lane-grid" x1={x(t)} x2={x(t)} y1={0} y2={timeline.lanes.length * ROW_H} />
              <text className="tick-label" x={x(t) + 3} y={timeline.lanes.length * ROW_H + 15}>
                {tickLabel(t, yearly)}
              </text>
            </g>
          ))}
          {[...timeline.settled.starts, ...timeline.settled.stops].map((s, i) =>
            s.date ? <line key={`s${i}`} className="settled-line" x1={x(chartX(s.date, 'date'))} x2={x(chartX(s.date, 'date'))} y1={0} y2={timeline.lanes.length * ROW_H}><title>{`settled ${s.kind} ${whenWords(s.date, s.precision)} ${s.who}`}</title></line> : null,
          )}
          {timeline.lanes.map((l, i) =>
            l.points
              .filter((p) => p.date)
              .map((p) => {
                const cx = x(chartX(p.date!, 'date'));
                const cy = i * ROW_H + ROW_H / 2;
                const cls = ['pt', p.kind, openIds.has(p.id) ? 'open' : '', differIds.has(p.id) ? 'differs' : '', p.answer?.answer === 'wrong' || overruled.has(p.id) ? 'wrong' : ''].filter(Boolean).join(' ');
                const title = `${l.title}: ${pointWords(p)}${overruled.has(p.id) ? ' (your notes say otherwise)' : ''}`;
                if (p.kind === 'start') return <circle key={p.id} className={cls} cx={cx} cy={cy} r={5}><title>{title}</title></circle>;
                if (p.kind === 'stop') return <rect key={p.id} className={cls} x={cx - 5} y={cy - 5} width={10} height={10}><title>{title}</title></rect>;
                return <path key={p.id} className={cls} d={`M ${cx} ${cy - 5} L ${cx + 5} ${cy} L ${cx} ${cy + 5} L ${cx - 5} ${cy} Z`}><title>{title}</title></path>;
              }),
          )}
        </svg>
      </div>
      <ul className="nt-lanes-words" aria-label="Each source in words">
        {timeline.lanes.map((l) => (
          <li key={l.documentId}>
            <strong>{l.tier === 'record' ? l.title : `Your note: ${l.title}`}</strong>: {l.points.map((p) => `${pointWords(p)}${overruled.has(p.id) ? ' (your notes say otherwise)' : ''}`).join('; ')}
          </li>
        ))}
      </ul>
    </div>
  );
}
