/**
 * History view: one row per medication, a bar from start to stop (open to
 * today while the course is current), event ticks coloured by kind, and a
 * today line. A start that was never stated (a list or note only named the
 * drug) is not drawn as one: the bar runs from the first mention, dashed, with
 * "start not recorded" beside it where there is room (course.ts readCourse).
 * Hovering a row says the course in the symptom chart's plain words. Colours
 * come only from the --chart-* and status tokens. The wrapper is focusable:
 * j/k move the selection, Enter opens, Esc clears. The legend, in words, sits
 * above the chart; under it each course is said in words (the same words as
 * the hover), so nothing needs a precise hover to be read.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { chartX } from '@shared/chart';
import { formatPartialDate, todayIso } from '@shared/dates';
import { isCurrent, type MedicationTimelineItem } from '../../api/medications';
import { readCourse } from './course';
import { eventWords, medStatusWords } from './words';
import { DatesInMono } from './MedTags';

const DAY = 86400000;

const STATUS_FILL: Record<string, string> = { active: 'var(--chart-1)', prn: 'var(--chart-4)', planned: 'var(--chart-2)', stopped: 'var(--ash)', unknown: 'var(--ash)' };
const KIND_STROKE: Record<string, string> = { start: 'var(--ok)', stop: 'var(--ash)', dose_change: 'var(--accent-strong)', hold: 'var(--warn)', resume: 'var(--ok)', reaction: 'var(--bad)', note: 'var(--info)' };
/** Rough advance of one character of the row's small words. */
const WORD_CHAR_W = 6.6;
/** The bar's height; a taller row centres it. */
const BAR_H = 12;
const ROW_H = 32;

function fmtTick(t: number, spanMs: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (spanMs > 3 * 365 * DAY) return String(y);
  return `${y}-${m}`;
}

function ticks(min: number, max: number, width: number): number[] {
  const span = max - min;
  const target = Math.max(2, Math.floor(width / 90));
  const out: number[] = [];
  const d0 = new Date(min);
  if (span > 3 * 365 * DAY) {
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

export interface MedicationGanttProps {
  items: MedicationTimelineItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpen?: (id: string) => void;
  /** Land the keyboard on the chart when it mounts, as the DataTable views do, so j/k work straight away. */
  autoFocus?: boolean;
}

export function MedicationGantt({ items, selectedId, onSelect, onOpen, autoFocus }: MedicationGanttProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (autoFocus) wrapRef.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 160) setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const labelW = 200;
  const top = 22;
  const bottom = 26;
  const rowH = ROW_H;
  const right = 18;
  const plotW = Math.max(120, width - labelW - right);
  const todayMs = chartX(todayIso(), 'date');

  // Each course as drawn: from its recorded start, else from its first mention (dashed), with its plain words.
  const courses = useMemo(() => items.map((it) => readCourse({ start: it.start, stop: it.stop, startRecorded: it.startRecorded, firstSeen: it.firstSeen, current: isCurrent(it.status) })), [items]);

  const model = useMemo(() => {
    const xs: number[] = [todayMs];
    items.forEach((it, i) => {
      const from = courses[i]?.from;
      if (from) xs.push(chartX(from, 'date'));
      if (it.stop) xs.push(chartX(it.stop, 'date'));
      for (const e of it.events) if (e.date) xs.push(chartX(e.date, 'date'));
    });
    const finite = xs.filter(Number.isFinite);
    let min = Math.min(...finite);
    let max = Math.max(...finite);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = todayMs - 365 * DAY;
      max = todayMs;
    }
    if (max - min < 60 * DAY) {
      min -= 30 * DAY;
      max += 30 * DAY;
    }
    const pad = (max - min) * 0.04;
    min -= pad;
    max += pad;
    const sx = (t: number) => labelW + ((t - min) / (max - min)) * plotW;
    return { min, max, sx, ticks: ticks(min, max, plotW) };
  }, [items, courses, plotW, todayMs]);

  const { sx, min, max } = model;
  const height = top + Math.max(1, items.length) * rowH + bottom;
  const idx = selectedId ? items.findIndex((i) => i.medicationId === selectedId) : -1;

  function move(delta: number) {
    if (!items.length) return;
    const next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, idx + delta));
    onSelect(items[next].medicationId);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        if (items.length) onSelect(items[0].medicationId);
        break;
      case 'End':
        e.preventDefault();
        if (items.length) onSelect(items[items.length - 1].medicationId);
        break;
      case 'Enter':
        if (selectedId) {
          e.preventDefault();
          onOpen?.(selectedId);
        }
        break;
      case 'Escape':
        onSelect(null);
        break;
    }
  }

  const legend: Array<[string, string]> = [
    [medStatusWords('active'), STATUS_FILL.active],
    [medStatusWords('prn'), STATUS_FILL.prn],
    [medStatusWords('planned'), STATUS_FILL.planned],
    [medStatusWords('stopped'), STATUS_FILL.stopped],
  ];

  return (
    <>
      <div className="gantt-legend" aria-label="What the colours and marks mean">
        <span className="gantt-legend-label">Bars:</span>
        {legend.map(([k, c]) => (
          <span key={k}>
            <i style={{ background: c }} />
            {k}
          </span>
        ))}
        <span title="The start was never written down: the bar runs from the first document that mentions the drug.">
          <i className="dashed" />
          start not recorded (from first mention)
        </span>
        <span className="gantt-legend-label">Marks:</span>
        {Object.entries(KIND_STROKE).map(([k, c]) => (
          <span key={k}>
            <i className="tick" style={{ background: c }} />
            {eventWords(k)}
          </span>
        ))}
      </div>
      <div className="gantt" ref={wrapRef} tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={items.length} aria-label="Medication history">
        <svg width={width} height={height} role="img" aria-label="Medication history">
          <title>Medication history</title>
          {model.ticks.map((t) => (
            <g key={t}>
              <line x1={sx(t)} x2={sx(t)} y1={top} y2={top + items.length * rowH} stroke="var(--chart-grid)" />
              <text x={sx(t)} y={top + items.length * rowH + 16} textAnchor="middle">
                {fmtTick(t, max - min)}
              </text>
            </g>
          ))}
          {todayMs >= min && todayMs <= max ? (
            <g>
              <line x1={sx(todayMs)} x2={sx(todayMs)} y1={top - 6} y2={top + items.length * rowH} stroke="var(--text-faint)" strokeDasharray="2 3" />
              <text x={sx(todayMs) + 3} y={top - 8}>
                today
              </text>
            </g>
          ) : null}
          {items.map((it, i) => {
            const y = top + i * rowH;
            const selected = it.medicationId === selectedId;
            const current = isCurrent(it.status);
            const course = courses[i];
            const startX = course?.from ? sx(chartX(course.from, 'date')) : null;
            const stopX = it.stop ? sx(chartX(it.stop, 'date')) : null;
            const fill = STATUS_FILL[it.status] ?? 'var(--ash)';
            const barH = BAR_H;
            const barY = y + (rowH - barH) / 2;
            const wordY = barY + barH / 2 + 3;
            // A small word beside a mark, on the side it reads best where there is room, else the other side, else left
            // off (the row's hover says it). Never over the name column or past the right edge.
            const word = (text: string, left: number, right: number, prefer: 'left' | 'right', allowRight = true) => {
              const w = text.length * WORD_CHAR_W;
              const fitsLeft = left - 6 - w >= labelW + 2;
              const fitsRight = allowRight && right + 6 + w <= width - 4;
              const side = prefer === 'right' ? (fitsRight ? 'right' : fitsLeft ? 'left' : null) : fitsLeft ? 'left' : fitsRight ? 'right' : null;
              if (!side) return null;
              return (
                <text x={side === 'left' ? left - 6 : right + 6} y={wordY} textAnchor={side === 'left' ? 'end' : 'start'} className="row-sub">
                  {text}
                </text>
              );
            };
            let bar: React.ReactNode = null;
            if (startX != null && course && (stopX != null || current)) {
              const x1 = stopX ?? sx(Math.min(max, Math.max(todayMs, chartX(course.from!, 'date'))));
              const x0 = Math.min(startX, x1);
              const w = Math.max(2, Math.abs(x1 - startX));
              bar = course.startRecorded ? (
                <rect x={x0} y={barY} width={w} height={barH} fill={fill} opacity={0.85} />
              ) : (
                // Start not recorded: dashed, from the first mention.
                <g>
                  <rect className="bar-unrecorded" x={x0} y={barY} width={Math.max(6, w)} height={barH} fill={fill} stroke={fill} />
                  {word('start not recorded', x0, x0 + Math.max(6, w), 'left', stopX != null)}
                </g>
              );
            } else if (startX != null && course) {
              // Stopped (or status unknown) with no stop date: a start mark and a dashed tail.
              bar = (
                <g>
                  {course.startRecorded ? (
                    <rect x={startX} y={barY} width={4} height={barH} fill={fill} />
                  ) : (
                    <rect className="bar-unrecorded" x={startX} y={barY} width={4} height={barH} fill={fill} stroke={fill} />
                  )}
                  <line x1={startX + 4} x2={startX + 40} y1={barY + barH / 2} y2={barY + barH / 2} stroke={fill} strokeDasharray="2 3" />
                  {word(course.startRecorded ? 'stop not recorded' : 'start and stop not recorded', startX, startX + 40, 'right')}
                </g>
              );
            } else if (stopX != null) {
              // Known only by its stop.
              bar = (
                <g>
                  <line x1={stopX - 40} x2={stopX - 4} y1={barY + barH / 2} y2={barY + barH / 2} stroke={fill} strokeDasharray="2 3" />
                  <rect x={stopX - 4} y={barY} width={4} height={barH} fill={fill} />
                  {word('start not recorded', stopX - 40, stopX, 'left')}
                </g>
              );
            } else {
              bar = (
                <text x={labelW + 6} y={y + rowH / 2 + 4} className="row-sub">
                  no dates recorded · {medStatusWords(it.status)}
                </text>
              );
            }
            const hover = `${it.name}: ${course?.words ?? `no dates recorded · ${medStatusWords(it.status)}`}`;
            const name = it.name.length > 28 ? `${it.name.slice(0, 27)}…` : it.name;
            return (
              <g key={it.medicationId}>
                <rect className={`row-bg${selected ? ' selected' : ''}`} x={0} y={y} width={width} height={rowH} onClick={() => onSelect(it.medicationId)} onDoubleClick={() => onOpen?.(it.medicationId)}>
                  <title>{hover}</title>
                </rect>
                {selected ? <rect x={0} y={y} width={2} height={rowH} fill="var(--accent)" /> : null}
                <text x={10} y={y + rowH / 2 + 4} className="row-label" style={{ pointerEvents: 'none' }}>
                  {name}
                </text>
                <g style={{ pointerEvents: 'none' }}>{bar}</g>
                {it.events.map((e) => {
                  if (!e.date) return null;
                  const x = sx(chartX(e.date, 'date'));
                  return (
                    <line key={e.id} x1={x} x2={x} y1={y + 3} y2={y + rowH - 3} stroke={KIND_STROKE[e.kind] ?? 'var(--ash)'} strokeWidth={2}>
                      <title>{`${it.name}: ${e.kind === 'start' && it.startRecorded === false ? 'on a list' : eventWords(e.kind)} · ${formatPartialDate(e.date, e.datePrecision as 'day' | 'month' | 'year')}${e.dose ? ` · ${e.dose}` : ''}${e.detail ? ` · ${e.detail}` : ''}`}</title>
                    </line>
                  );
                })}
              </g>
            );
          })}
          {!items.length ? (
            <text x={labelW + 8} y={top + rowH / 2 + 4} className="row-sub">
              No medications yet.
            </text>
          ) : null}
        </svg>
        {items.length ? (
          <ul className="gantt-words" aria-label="Each medication's course in words">
            {items.map((it, i) => (
              <li key={it.medicationId} className={it.medicationId === selectedId ? 'selected' : undefined}>
                <button type="button" tabIndex={-1} onClick={() => onSelect(it.medicationId)} onDoubleClick={() => onOpen?.(it.medicationId)}>
                  <span className="gantt-words-name">{it.name}</span>
                  <span className="gantt-words-course">
                    <DatesInMono text={`${courses[i]?.words ?? `no dates recorded · ${medStatusWords(it.status)}`}${it.settled?.words ? ` (settled: ${it.settled.words})` : ''}`} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
