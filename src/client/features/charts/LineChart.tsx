/**
 * Shared SVG chart. Renders a ChartSpec (src/shared/chart.ts): line, bar or
 * scatter series over a date, number or category axis, with a reference
 * band, event markers and periods (medication courses). Colours come only
 * from the --chart-* and status tokens. Hover shows a crosshair and the
 * values in a text legend beside the plot (no floating tooltips).
 *
 * Periods are not shaded over the plot. They are drawn as lanes under the x
 * axis (see lanes.ts): one row per lane, the name in the left column, a bar
 * from start to stop (solid from a recorded start, dashed where only a
 * mention date is known), an arrowhead while ongoing or running past the
 * window, an end cap at a stop, a diamond for a one-day course. Very faint
 * vertical guides on the plot mark recorded starts and stops. With
 * `bandMode="guides"` only the guides are drawn (a second chart over the same
 * window, so the rows are not repeated). Nothing is ever drawn over the
 * legend: names are shortened with an ellipsis and clipped to their column,
 * with the full name on hover. Charts stacked over one window (the symptom
 * and sleep charts) pass the same `xRange` and `labelWidth` (lanes.ts
 * stackedChartAlign) so their plots, dates and guides line up.
 *
 * The normal range (spec.referenceBand) is the --chart-band fill with a
 * dashed edge. A point outside the range is drawn as a red diamond
 * (--chart-out, edged in the surface colour so it stands off the line)
 * whether or not the report flagged it, so it differs from a normal (round)
 * point by its shape as well as its colour, and the red is darker than the
 * line in lightness; a point the report itself flagged (H, L, A, C) also gets
 * a ring around it (range.ts). On a lab chart (the server's, `source: 'db'`)
 * each point is judged by its own flag only, printed or worked out from the
 * range printed with that value ("H~"): the band never judges a point, so a
 * value that printed no range of its own is never red (2026-10, rule 8). With
 * `hollowScatter` (the Labs page) a scatter series is drawn as open circles,
 * never joined: the values stated in summaries or notes, apart from the lab
 * reports' line (rule 11). The legend says what each means. Date ticks say the year (on
 * the first tick and wherever the year changes) and the end ticks are kept
 * inside the chart. A
 * date that holds several different values (two documents disagree) is drawn
 * as separate points with a dashed fork to each, never a vertical jump
 * (series.ts).
 *
 * Owned by the lead; feature slices (consult, symptoms, labs) import it.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { chartX, type ChartSpec, type ChartTone } from '@shared/chart';
import { buildLanes, fitLabel, laneAreaHeight, laneLabelWidth, LABEL_CHAR_W, LANE_ROW_H, markerLabelPlace, MIN_LABEL_W, specCategories, specXExtent, stackLabels, type LaneBand, type LaneSegment } from './lanes';
import { bandWords, pointMark } from './range';
import { lineSegments } from './series';
import { typedRangeWords } from '@shared/labcompute';
import './charts.css';

const TONE_VAR: Record<ChartTone, string> = {
  accent: 'var(--accent)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  ok: 'var(--ok)',
  ash: 'var(--ash)',
  info: 'var(--info)',
};

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * The words under each date tick: years over a long range, year and month over months, and over days the month and
 * day with the year on the first tick and wherever the year changes ("2023-05-31", "06-05", ... ), so a chart of a
 * few weeks still says which year it is.
 */
export function dateTickLabels(ticks: number[], spanMs: number): string[] {
  let lastYear: number | null = null;
  return ticks.map((t) => {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    if (spanMs > 3 * 365 * 86400000) return String(y);
    if (spanMs > 120 * 86400000) return `${y}-${m}`;
    const full = lastYear !== y;
    lastYear = y;
    return full ? `${y}-${m}-${day}` : `${m}-${day}`;
  });
}

/** Where a tick's words go: centred under the tick, or turned to end (or start) at the tick so they never run past the chart's edge. */
export function tickLabelPlace(x: number, textWidth: number, lo: number, hi: number): { x: number; anchor: 'start' | 'middle' | 'end' } {
  if (x + textWidth / 2 > hi) return { x: Math.min(x, hi), anchor: 'end' };
  if (x - textWidth / 2 < lo) return { x: Math.max(x, lo), anchor: 'start' };
  return { x, anchor: 'middle' };
}

/** Rough width of one character of the mono tick text (12px). */
const TICK_CHAR_W = 7.3;

function dateTicks(min: number, max: number, width: number): number[] {
  const span = max - min;
  // A date tick about every 70px (at least three), so a narrow chart still says when; over days, where a tick may
  // carry the year ("2024-06-05"), about every 90px.
  const days = span <= 120 * 86400000;
  const target = Math.max(days ? 2 : 3, Math.floor(width / (days ? 90 : 70)));
  const out: number[] = [];
  const d0 = new Date(min);
  if (span > 3 * 365 * 86400000) {
    const yStep = Math.max(1, Math.ceil(span / (365 * 86400000) / target));
    for (let y = d0.getUTCFullYear(); ; y += yStep) {
      const t = Date.UTC(y, 0, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
    }
  } else if (span > 120 * 86400000) {
    const mStep = Math.max(1, Math.ceil(span / (30 * 86400000) / target));
    for (let i = 0; ; i += mStep) {
      const t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
    }
  } else {
    const dStep = Math.max(1, Math.ceil(span / 86400000 / target));
    for (let t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()); t <= max; t += dStep * 86400000) {
      if (t >= min) out.push(t);
    }
  }
  return out;
}

/** A diamond (a square on its point) centred on x, y, `r` from the centre to each point. */
function diamond(x: number, y: number, r: number): string {
  return `M${x},${y - r}L${x + r},${y}L${x},${y + r}L${x - r},${y}Z`;
}

const LABEL_LANE_H = 12;
/** Under this width the legend goes under the plot instead of beside it. */
export const LEGEND_BELOW_UNDER = 520;
/** The "start not recorded" word: its text and rough width (a smaller face than the names). */
const START_WORD = 'start not recorded';
const START_WORD_W = START_WORD.length * 7;
/** A dashed bar (start not recorded) is at least this long, so a stop-only course still reads as "taken before, stopped here". */
const MIN_DASHED_PX = 18;

export interface LineChartProps {
  spec: ChartSpec;
  height?: number;
  onPointClick?: (seriesIndex: number, pointIndex: number) => void;
  /** 'lanes' (default): periods as rows under the x axis plus faint guides; 'guides': the guides only. */
  bandMode?: 'lanes' | 'guides';
  /** Words after "+N more" when rows are left off, e.g. "listed below". */
  moreLanesNote?: string;
  /**
   * The x range (data units) the chart covers at least, before its padding. Charts stacked over one window pass the
   * same range (lanes.ts stackedChartAlign) so a date falls at the same x in each. Ignored on a category axis.
   */
  xRange?: readonly [number, number] | null;
  /**
   * Width wanted for the left column (y axis and lane names), before the chart caps it to its share of the width.
   * Stacked charts pass the same one so their plots start at the same x, whether or not they draw the lanes.
   */
  labelWidth?: number | null;
  /** Width drawn until the chart has measured its box (server rendering, tests). */
  initialWidth?: number;
  /**
   * Scatter series drawn as open circles (the Labs page: values stated in summaries or notes, drawn apart from the lab
   * reports' line, never red).
   */
  hollowScatter?: boolean;
}

interface SegmentDraw {
  seg: LaneSegment;
  px0: number;
  px1: number;
  word: { x: number; anchor: 'start' | 'end' } | null;
}

export function LineChart({ spec, height = 240, onPointClick, bandMode = 'lanes', moreLanesNote, xRange, labelWidth, initialWidth = 640, hollowScatter = false }: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 120) setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The data ranges do not depend on pixels; the lanes are grouped from them
  // first, so the label column can be sized before the plot.
  const rangeLo = xRange?.[0];
  const rangeHi = xRange?.[1];
  const domain = useMemo(() => {
    const categories = specCategories(spec);
    const ys: number[] = [];
    for (const s of spec.series) for (const p of s.points) if (p.y != null && Number.isFinite(p.y)) ys.push(p.y);
    if (spec.referenceBand) {
      if (spec.referenceBand.low != null) ys.push(spec.referenceBand.low);
      if (spec.referenceBand.high != null) ys.push(spec.referenceBand.high);
    }
    // A range the patient typed for a computed test (dashed): its lines stay on the plot.
    if (spec.typedRange) {
      if (spec.typedRange.low != null) ys.push(spec.typedRange.low);
      if (spec.typedRange.high != null) ys.push(spec.typedRange.high);
    }
    // Everything drawn, widened to the shared range when one is given (never narrowed, so nothing falls outside).
    const xs: number[] = [...(specXExtent(spec, categories) ?? [])];
    if (spec.xType !== 'category' && rangeLo != null && rangeHi != null && Number.isFinite(rangeLo) && Number.isFinite(rangeHi)) xs.push(rangeLo, rangeHi);
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
      xMin = 0;
      xMax = 1;
    }
    if (xMin === xMax) {
      const padX = spec.xType === 'date' ? 15 * 86400000 : 1;
      xMin -= padX;
      xMax += padX;
    } else if (spec.xType === 'category') {
      xMin -= 0.5;
      xMax += 0.5;
    } else {
      const padX = (xMax - xMin) * 0.03;
      xMin -= padX;
      xMax += padX;
    }
    let yMin: number;
    let yMax: number;
    if (Array.isArray(spec.yDomain)) {
      [yMin, yMax] = spec.yDomain;
    } else {
      yMin = ys.length ? Math.min(...ys) : 0;
      yMax = ys.length ? Math.max(...ys) : 1;
      if (spec.type === 'bar' && yMin > 0) yMin = 0;
      if (yMin === yMax) {
        yMin -= 1;
        yMax += 1;
      } else {
        const padY = (yMax - yMin) * 0.08;
        yMin -= padY;
        yMax += padY;
      }
    }
    return { categories, xMin, xMax, yMin, yMax };
  }, [spec, rangeLo, rangeHi]);

  const laneLayout = useMemo(
    () => buildLanes(spec.bands as LaneBand[] | null | undefined, { xType: spec.xType, categories: domain.categories, xMin: domain.xMin, xMax: domain.xMax }),
    [spec.bands, spec.xType, domain],
  );
  const showLanes = bandMode === 'lanes' && laneLayout.lanes.length > 0;

  // A narrow chart (a detail pane at 1280px) gives the plot the whole width and puts the legend under it.
  const legendBelow = width < LEGEND_BELOW_UNDER;
  const legendWidth = legendBelow ? 0 : 176;
  const labelCap = Math.max(60, Math.min(170, Math.round(width * 0.24)));
  // The left column fits the lane names (up to its cap); a stacked chart takes the width its partner asks for, so
  // both plots start at the same x even where this one draws no rows.
  const padLeft = labelWidth != null && Number.isFinite(labelWidth) ? Math.round(Math.max(MIN_LABEL_W, Math.min(labelCap, labelWidth))) : showLanes ? laneLabelWidth(laneLayout, MIN_LABEL_W, labelCap) : MIN_LABEL_W;
  const pad = { top: 18, right: 12, bottom: 30, left: padLeft };
  const plotW = Math.max(80, width - legendWidth - pad.left - pad.right);
  const plotH = Math.max(60, height - pad.top - pad.bottom);
  const plotRight = pad.left + plotW;
  const plotBottom = pad.top + plotH;
  const lanesH = showLanes ? laneAreaHeight(laneLayout) : 0;
  const lanesTop = plotBottom + pad.bottom + 8;
  const svgH = height + lanesH;

  const model = useMemo(() => {
    const { categories, xMin, xMax, yMin, yMax } = domain;
    const sx = (x: number) => pad.left + ((x - xMin) / (xMax - xMin)) * plotW;
    const sy = (y: number) => pad.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;
    const xTicks = spec.xType === 'date' ? dateTicks(xMin, xMax, plotW) : spec.xType === 'category' ? (categories ?? []).map((_, i) => i) : niceTicks(xMin, xMax, Math.max(2, Math.floor(plotW / 80)));
    const yTicks = niceTicks(yMin, yMax, Math.max(2, Math.floor(plotH / 40)));
    const series = spec.series.map((s) => ({
      ...s,
      pts: s.points.map((p, i) => ({ ...p, i, xv: chartX(p.x, spec.xType, categories), px: sx(chartX(p.x, spec.xType, categories)), py: p.y == null ? null : sy(p.y) })),
    }));
    return { categories, xMin, xMax, yMin, yMax, sx, sy, xTicks, yTicks, series };
  }, [domain, spec.series, spec.xType, plotW, plotH, pad.left, pad.top]);

  const { sx, sy, xTicks, yTicks, series, categories, xMin, xMax } = model;
  const spanMs = xMax - xMin;
  const xLabels = spec.xType === 'date' ? dateTickLabels(xTicks, spanMs) : xTicks.map((t) => (spec.xType === 'category' ? (categories?.[t] ?? '') : fmtNum(t)));

  // Nearest x for hover.
  const hovered = useMemo(() => {
    if (hoverX == null) return null;
    let best: { xv: number; dist: number } | null = null;
    for (const s of series) {
      for (const p of s.pts) {
        if (!Number.isFinite(p.xv)) continue;
        const dist = Math.abs(sx(p.xv) - hoverX);
        if (!best || dist < best.dist) best = { xv: p.xv, dist };
      }
    }
    return best && best.dist < 40 ? best.xv : null;
  }, [hoverX, series, sx]);

  const barGroupW = spec.type === 'bar' ? Math.max(2, Math.min(28, (plotW / Math.max(1, series[0]?.pts.length ?? 1)) * 0.7)) : 0;

  // Marker labels stack up from the bottom of the plot in up to a third of its
  // height, and stay inside the plot (they turn to the left of their tick near
  // the right edge), so they never run into the legend.
  const maxLanes = Math.max(1, Math.min(4, Math.floor(plotH / 3 / LABEL_LANE_H)));
  const markerGeom = useMemo(
    () =>
      (spec.markers ?? []).map((m) => {
        const x = sx(chartX(m.x, spec.xType, categories));
        const place = markerLabelPlace(x, m.label.length * LABEL_CHAR_W, pad.left + 2, plotRight - 2);
        return { x, start: place.start, width: place.width, text: fitLabel(m.label, place.width) };
      }),
    [spec.markers, spec.xType, categories, sx, pad.left, plotRight],
  );
  const markerLanes = useMemo(() => stackLabels(markerGeom.map((g) => ({ start: g.start, width: g.text.length * LABEL_CHAR_W })), maxLanes), [markerGeom, maxLanes]);

  // Faint guides at recorded starts and stops: the drawn rows' (or, in guides
  // mode, every course's), one line per pixel column.
  const guides = useMemo(() => {
    const lanes = bandMode === 'lanes' ? laneLayout.lanes : [...laneLayout.lanes, ...laneLayout.hidden];
    const byPx = new Map<number, { x: number; tone: ChartTone; titles: string[] }>();
    for (const lane of lanes) {
      for (const seg of lane.segments) {
        for (const g of seg.guides) {
          const x = sx(g);
          if (x < pad.left - 0.5 || x > plotRight + 0.5) continue;
          const k = Math.round(x);
          const hit = byPx.get(k);
          if (hit) hit.titles.push(seg.title);
          else byPx.set(k, { x, tone: seg.tone, titles: [seg.title] });
        }
      }
    }
    return [...byPx.values()];
  }, [bandMode, laneLayout, sx, pad.left, plotRight]);

  // Each row's segments in pixels, and where the "start not recorded" word fits (never over a bar or another word).
  const laneDraw = useMemo(() => {
    if (!showLanes) return [];
    return laneLayout.lanes.map((lane) => {
      const draws: SegmentDraw[] = lane.segments.map((seg) => {
        let px0 = sx(seg.x0);
        const px1 = sx(seg.x1);
        if (!seg.startKnown && px1 - px0 < MIN_DASHED_PX) px0 = Math.max(pad.left, px1 - MIN_DASHED_PX);
        return { seg, px0, px1, word: null };
      });
      const taken = draws.map((d) => [d.px0 - 2, d.px1 + 6] as [number, number]);
      const free = (a: number, b: number) => a >= pad.left && b <= plotRight && taken.every(([c, e]) => b <= c || a >= e);
      for (const d of draws) {
        if (d.seg.startKnown) continue;
        const leftA = d.px0 - 5 - START_WORD_W;
        const rightA = d.px1 + 8;
        if (free(leftA, d.px0 - 5)) {
          d.word = { x: d.px0 - 5, anchor: 'end' };
          taken.push([leftA, d.px0 - 5]);
        } else if (!d.seg.arrow && free(rightA, rightA + START_WORD_W)) {
          d.word = { x: rightA, anchor: 'start' };
          taken.push([rightA, rightA + START_WORD_W]);
        }
      }
      return { lane, draws };
    });
  }, [showLanes, laneLayout, sx, pad.left, plotRight]);

  const legendX = plotRight + 14;
  const legendTextW = Math.max(0, width - legendX - 12 - 4);
  const hasRef = Boolean(spec.referenceBand && (spec.referenceBand.low != null || spec.referenceBand.high != null));
  const band = hasRef ? (spec.referenceBand ?? null) : null;
  // A lab chart's points carry their own flags (printed, or "~" worked out from their own range): the band never judges one.
  const ownFlags = spec.source === 'db';
  const isHollow = (s: { kind?: string | null }) => hollowScatter && (s.kind ?? spec.type) === 'scatter';
  const crossBottom = showLanes ? lanesTop + laneLayout.lanes.length * LANE_ROW_H : plotBottom;
  // What the legend has to explain: a red point (outside the range, or flagged), a ring (flagged by the report).
  const marks = useMemo(() => {
    let out = false;
    let flagged = false;
    for (const s of spec.series) {
      for (const p of s.points) {
        if (p.y == null) continue;
        const m = pointMark(p, band, ownFlags);
        out ||= m.out;
        flagged ||= m.flagged;
      }
    }
    return { out, flagged };
  }, [spec.series, band, ownFlags]);
  const outTitle = ownFlags ? 'A red diamond is outside the range printed with it, or flagged by the report' : 'A red diamond is outside the normal range, whether or not the report flagged it';
  const legendRows = series.length + (hasRef ? 1 : 0);
  // A range the patient typed for a computed test (2026-10-09): dashed lines, labelled, never judging a point.
  const typed = spec.typedRange && (spec.typedRange.low != null || spec.typedRange.high != null) ? spec.typedRange : null;
  // A value the patient computed: an open square, never red; the legend says so.
  const hasSquare = spec.series.some((x) => x.points.some((pt) => pt.marker === 'square' && pt.y != null));
  const isSquares = (x: { points: ReadonlyArray<{ marker?: string | null }> }) => x.points.length > 0 && x.points.every((pt) => pt.marker === 'square');
  const extraTop = legendRows + (marks.out ? 1 : 0) + (marks.flagged ? 1 : 0);

  return (
    <div className="chart" ref={wrapRef}>
      {spec.title ? (
        <div className="row between" style={{ marginBottom: 4 }}>
          <span className="small">{spec.title}</span>
          <span className="faint xs">
            {spec.source === 'model' ? 'assembled by the model from retrieved text · ' : ''}
            {spec.subtitle ?? ''}
          </span>
        </div>
      ) : null}
      <svg
        width={width}
        height={svgH}
        role="img"
        aria-label={spec.title ?? 'chart'}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHoverX(e.clientX - rect.left);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        <title>{spec.title ?? 'chart'}</title>
        <defs>
          <clipPath id={`${uid}-plot`}>
            <rect x={pad.left} y={0} width={plotW} height={plotBottom} />
          </clipPath>
          <clipPath id={`${uid}-names`}>
            <rect x={0} y={lanesTop - 2} width={Math.max(0, pad.left - 6)} height={lanesH + 4} />
          </clipPath>
          <clipPath id={`${uid}-legend`}>
            <rect x={legendX} y={0} width={Math.max(0, width - legendX)} height={svgH} />
          </clipPath>
        </defs>
        {/* the normal range: a soft band with dashed edges */}
        {band ? (
          <g className="chart-band">
            <rect x={pad.left} width={plotW} y={sy(band.high ?? model.yMax)} height={Math.max(0, sy(band.low ?? model.yMin) - sy(band.high ?? model.yMax))} fill="var(--chart-band)">
              <title>{bandWords(band)}</title>
            </rect>
            {band.high != null ? <line className="chart-band-edge" x1={pad.left} x2={plotRight} y1={sy(band.high)} y2={sy(band.high)} /> : null}
            {band.low != null ? <line className="chart-band-edge" x1={pad.left} x2={plotRight} y1={sy(band.low)} y2={sy(band.low)} /> : null}
          </g>
        ) : null}
        {typed ? (
          <g className="chart-typed-range">
            <title>{typedRangeWords(typed)}</title>
            {typed.high != null ? <line x1={pad.left} x2={plotRight} y1={sy(typed.high)} y2={sy(typed.high)} stroke="var(--text-muted)" strokeDasharray="5 4" strokeWidth={1.25} /> : null}
            {typed.low != null ? <line x1={pad.left} x2={plotRight} y1={sy(typed.low)} y2={sy(typed.low)} stroke="var(--text-muted)" strokeDasharray="5 4" strokeWidth={1.25} /> : null}
          </g>
        ) : null}
        {/* faint guides at recorded medication starts and stops */}
        {guides.map((g) => (
          <line key={`guide-${Math.round(g.x)}`} className="chart-guide" x1={g.x} x2={g.x} y1={pad.top} y2={plotBottom} stroke={TONE_VAR[g.tone]}>
            <title>{g.titles.join('\n')}</title>
          </line>
        ))}
        {/* grid + y axis */}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line x1={pad.left} x2={plotRight} y1={sy(t)} y2={sy(t)} stroke="var(--chart-grid)" />
            <text x={pad.left - 6} y={sy(t) + 3} textAnchor="end">
              {fmtNum(t)}
            </text>
          </g>
        ))}
        {/* x axis */}
        {xTicks.map((t, i) => {
          // The end ticks' words stay inside the chart: at the right they end at the tick instead of being cut off.
          const place = tickLabelPlace(sx(t), xLabels[i].length * TICK_CHAR_W, 2, legendBelow ? width - 2 : plotRight + pad.right);
          return (
            <g key={`x-${i}`}>
              <line x1={sx(t)} x2={sx(t)} y1={plotBottom} y2={plotBottom + 4} stroke="var(--border-strong)" />
              <text x={place.x} y={plotBottom + 16} textAnchor={place.anchor}>
                {xLabels[i]}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke="var(--border-strong)" />
        {spec.yLabel ? (
          <text x={pad.left} y={10} textAnchor="start">
            {spec.yLabel}
          </text>
        ) : null}
        {/* markers */}
        {(spec.markers ?? []).map((m, i) => {
          const g = markerGeom[i];
          const lane = markerLanes[i];
          const tone = m.tone ?? 'ash';
          return (
            <g key={`m-${i}`}>
              <line x1={g.x} x2={g.x} y1={pad.top} y2={plotBottom} stroke={TONE_VAR[tone]} strokeDasharray="2 3">
                <title>{`${String(m.x)} ${m.label}`}</title>
              </line>
              {lane == null || !g.text ? null : (
                <text x={g.start} y={plotBottom - 4 - lane * LABEL_LANE_H} fill={TONE_VAR[tone]} clipPath={`url(#${uid}-plot)`}>
                  {g.text}
                  {g.text !== m.label ? <title>{m.label}</title> : null}
                </text>
              )}
            </g>
          );
        })}
        {/* series */}
        {series.map((s, si) => {
          const color = `var(--chart-${(si % 6) + 1})`;
          const kind = s.kind ?? spec.type;
          if (kind === 'bar') {
            const n = series.filter((x) => (x.kind ?? spec.type) === 'bar').length || 1;
            const w = barGroupW / n;
            return (
              <g key={s.name}>
                {s.pts.map((p) =>
                  p.py == null ? null : (
                    <rect key={p.i} x={p.px - barGroupW / 2 + si * w} width={Math.max(1, w - 1)} y={Math.min(p.py, sy(0))} height={Math.abs(sy(0) - p.py)} fill={color} opacity={0.85} onClick={() => onPointClick?.(si, p.i)} />
                  ),
                )}
              </g>
            );
          }
          // One value per date: the line as always. Several different values on one date: a dashed fork to each.
          const paths = kind === 'line' && s.pts.length > 1 ? lineSegments(spec.xType === 'category' ? s.pts.map((p, i) => ({ ...p, xv: i })) : s.pts) : null;
          return (
            <g key={s.name}>
              {paths?.solid ? <path d={paths.solid} fill="none" stroke={color} strokeWidth={1.5} /> : null}
              {paths?.dashed ? <path className="chart-fork" d={paths.dashed} fill="none" stroke={color} strokeWidth={1.25} /> : null}
              {s.pts.map((p) => {
                if (p.py == null) return null;
                const m = pointMark(p, band, ownFlags);
                const r = hovered === p.xv ? 4.5 : 3;
                return (
                  <g key={p.i} style={{ cursor: onPointClick || p.href ? 'pointer' : 'default' }} onClick={() => onPointClick?.(si, p.i)}>
                    {p.label ? <title>{p.label}</title> : null}
                    {p.marker === 'square' ? (
                      // Computed by the user from printed values: an open square, never red, never ringed.
                      <rect className="chart-computed-point" x={p.px - r} y={p.py - r} width={r * 2} height={r * 2} fill="var(--surface)" stroke={color} strokeWidth={1.5} data-computed="1" />
                    ) : null}
                    {p.marker !== 'square' && m.flagged ? <circle className="chart-ring" cx={p.px} cy={p.py} r={r + 3} fill="none" stroke="var(--chart-out)" strokeWidth={1.25} /> : null}
                    {p.marker === 'square' ? null : m.out ? (
                      // Outside the range: a red diamond edged in the surface colour, so it differs from a round normal point by its shape, not only its colour.
                      <path className="chart-out-point" d={diamond(p.px, p.py, r + 1.5)} fill="var(--chart-out)" stroke="var(--surface)" strokeWidth={1.25} data-out={m.flagged ? 'flagged' : 'range'} />
                    ) : isHollow(s) ? (
                      // Stated in a summary or a note: an open circle, apart from the lab reports' line.
                      <circle className="chart-hollow-point" cx={p.px} cy={p.py} r={r + 0.5} fill="var(--surface)" stroke={color} strokeWidth={1.5} data-claim="1" />
                    ) : (
                      <circle cx={p.px} cy={p.py} r={r} fill={color} stroke="none" />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* medication lanes under the x axis */}
        {laneDraw.map(({ lane, draws }, row) => {
          const top = lanesTop + row * LANE_ROW_H;
          const cy = top + LANE_ROW_H / 2;
          return (
            <g key={`lane-${lane.key}`} className="chart-lane-row">
              <title>{[lane.labels.join(' / '), ...lane.segments.map((s) => s.title)].join('\n')}</title>
              <rect className="chart-lane-hit" x={0} y={top} width={plotRight} height={LANE_ROW_H} />
              <line className="chart-lane-track" x1={pad.left} x2={plotRight} y1={cy} y2={cy} />
              <text className="chart-lane-name" x={0} y={cy + 4} clipPath={`url(#${uid}-names)`}>
                {fitLabel(lane.label, pad.left - 10)}
              </text>
              {draws.map((d) => {
                const tone = TONE_VAR[d.seg.tone];
                if (d.seg.oneDay) {
                  return <path key={`seg-${d.seg.index}`} d={`M${d.px0},${cy - 4.5}L${d.px0 + 4.5},${cy}L${d.px0},${cy + 4.5}L${d.px0 - 4.5},${cy}Z`} fill={tone} />;
                }
                const arrowW = d.seg.arrow ? Math.min(6, Math.max(0, d.px1 - d.px0)) : 0;
                const barEnd = Math.max(d.px0, d.px1 - arrowW);
                return (
                  <g key={`seg-${d.seg.index}`}>
                    {barEnd > d.px0 || !d.seg.arrow ? (
                      <line className={d.seg.startKnown ? undefined : 'chart-lane-dashed'} x1={d.px0} x2={Math.max(barEnd, d.px0 + 1.5)} y1={cy} y2={cy} stroke={tone} strokeWidth={4} />
                    ) : null}
                    {d.seg.arrow ? <path d={`M${d.px1 - 6},${cy - 4.5}L${d.px1},${cy}L${d.px1 - 6},${cy + 4.5}Z`} fill={tone} /> : null}
                    {d.seg.endCap ? <line x1={d.px1} x2={d.px1} y1={cy - 5} y2={cy + 5} stroke={tone} strokeWidth={1.5} /> : null}
                    {d.word ? (
                      <text className="chart-lane-word" x={d.word.x} y={cy + 3.5} textAnchor={d.word.anchor}>
                        {START_WORD}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
        {showLanes && laneLayout.hidden.length ? (
          <text className="chart-lane-more" x={0} y={lanesTop + laneLayout.lanes.length * LANE_ROW_H + LANE_ROW_H / 2 + 4}>
            +{laneLayout.hidden.length} more{moreLanesNote ? `, ${moreLanesNote}` : ''}
            <title>{laneLayout.hidden.map((l) => l.labels.join(' / ')).join('\n')}</title>
          </text>
        ) : null}
        {/* crosshair */}
        {hovered != null ? <line x1={sx(hovered)} x2={sx(hovered)} y1={pad.top} y2={crossBottom} stroke="var(--text-faint)" strokeDasharray="1 2" /> : null}
        {/* legend: shortened to its column and clipped to it, the full name on hover */}
        {legendBelow ? null : (
        <g clipPath={`url(#${uid}-legend)`}>
          <g transform={`translate(${legendX}, ${pad.top})`}>
            {hovered != null ? (
              <text x={0} y={0} fill="var(--text-muted)">
                {spec.xType === 'date' ? new Date(hovered).toISOString().slice(0, 10) : spec.xType === 'category' ? (categories?.[hovered] ?? '') : fmtNum(hovered)}
              </text>
            ) : null}
            {series.map((s, si) => {
              const color = `var(--chart-${(si % 6) + 1})`;
              // Every value at the hovered date (two documents may give two): "62 / 94 mg/dL".
              const here = hovered == null ? [] : [...new Set(s.pts.filter((p) => p.xv === hovered && p.y != null).map((p) => fmtNum(p.y as number)))];
              const flag = hovered == null ? null : (s.pts.find((p) => p.xv === hovered && p.flag)?.flag ?? null);
              const value = here.length ? ` ${here.join(' / ')}${s.unit ? ` ${s.unit}` : ''}${flag ? ` ${flag}` : ''}` : '';
              const name = fitLabel(s.name, legendTextW - value.length * LABEL_CHAR_W);
              return (
                <g key={s.name} transform={`translate(0, ${14 + si * 15})`}>
                  <title>{s.name}</title>
                  {isSquares(s) ? <rect x={0.5} y={-6.5} width={7} height={7} fill="none" stroke={color} strokeWidth={1.5} /> : isHollow(s) ? <circle cx={4} cy={-3} r={3.5} fill="none" stroke={color} strokeWidth={1.5} /> : <rect x={0} y={-7} width={8} height={8} fill={color} />}
                  <text className="chart-legend-name" x={12} y={0}>
                    {name}
                    {value}
                  </text>
                </g>
              );
            })}
            {band ? (
              <g transform={`translate(0, ${14 + series.length * 15})`}>
                <title>{bandWords(band)}</title>
                <rect x={0} y={-7} width={8} height={8} fill="var(--chart-band)" stroke="var(--ok)" strokeDasharray="2 1.5" />
                <text className="chart-legend-ref" x={12} y={0}>
                  {fitLabel(bandWords(band).length * LABEL_CHAR_W <= legendTextW ? bandWords(band) : 'Normal range', legendTextW)}
                </text>
              </g>
            ) : null}
            {marks.out ? (
              <g transform={`translate(0, ${14 + legendRows * 15})`}>
                <title>{outTitle}</title>
                <path d={diamond(4, -3, 4.5)} fill="var(--chart-out)" />
                <text className="chart-legend-ref" x={12} y={0}>
                  {fitLabel('Outside the range', legendTextW)}
                </text>
              </g>
            ) : null}
            {marks.flagged ? (
              <g transform={`translate(0, ${14 + (legendRows + (marks.out ? 1 : 0)) * 15})`}>
                <title>A ring: the report itself flagged it (high, low, abnormal or critical)</title>
                <circle cx={4} cy={-3} r={5} fill="none" stroke="var(--chart-out)" strokeWidth={1.25} />
                <text className="chart-legend-ref" x={12} y={0}>
                  {fitLabel('Flagged by report', legendTextW)}
                </text>
              </g>
            ) : null}
            {hasSquare ? (
              <g transform={`translate(0, ${14 + extraTop * 15})`}>
                <title>An open square: computed by you from values printed on lab reports; never red, never judged by a range</title>
                <rect x={0.5} y={-6.5} width={7} height={7} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} />
                <text className="chart-legend-ref" x={12} y={0}>
                  {fitLabel('computed', legendTextW)}
                </text>
              </g>
            ) : null}
            {typed ? (
              <g transform={`translate(0, ${14 + (extraTop + (hasSquare ? 1 : 0)) * 15})`}>
                <title>{`${typed.label}: ${typedRangeWords(typed)}. It never makes a value red.`}</title>
                <line x1={0} x2={9} y1={-3} y2={-3} stroke="var(--text-muted)" strokeDasharray="3 2" strokeWidth={1.5} />
                <text className="chart-legend-ref" x={12} y={0}>
                  {fitLabel(typed.label, legendTextW)}
                </text>
              </g>
            ) : null}
          </g>
        </g>
        )}
      </svg>
      {legendBelow ? (
        <div className="chart-legend-below">
          {hovered != null ? <span className="chart-legend-at mono">{spec.xType === 'date' ? new Date(hovered).toISOString().slice(0, 10) : spec.xType === 'category' ? (categories?.[hovered] ?? '') : fmtNum(hovered)}</span> : null}
          {series.map((s, si) => {
            const here = hovered == null ? [] : [...new Set(s.pts.filter((p) => p.xv === hovered && p.y != null).map((p) => fmtNum(p.y as number)))];
            return (
              <span key={s.name} className="chart-legend-item">
                <span className={`chart-swatch s${(si % 6) + 1}${isSquares(s) ? ' square' : isHollow(s) ? ' hollow' : ''}`} aria-hidden="true" />
                {s.name}
                {here.length ? <span className="mono"> {here.join(' / ')}{s.unit ? ` ${s.unit}` : ''}</span> : null}
              </span>
            );
          })}
          {band ? (
            <span className="chart-legend-item">
              <span className="chart-swatch band" aria-hidden="true" />
              {bandWords(band)}
            </span>
          ) : null}
          {marks.out ? (
            <span className="chart-legend-item" title={outTitle}>
              <span className="chart-dot out" aria-hidden="true" />
              Outside the range
            </span>
          ) : null}
          {marks.flagged ? (
            <span className="chart-legend-item" title="A ring: the report itself flagged it (high, low, abnormal or critical)">
              <span className="chart-dot ring" aria-hidden="true" />
              Flagged by report
            </span>
          ) : null}
          {hasSquare ? (
            <span className="chart-legend-item" title="An open square: computed by you from values printed on lab reports; never red, never judged by a range">
              <span className="chart-dot square" aria-hidden="true" />
              computed
            </span>
          ) : null}
          {typed ? (
            <span className="chart-legend-item" title={`${typedRangeWords(typed)}. It never makes a value red.`}>
              <span className="chart-dash" aria-hidden="true" />
              {typed.label}
            </span>
          ) : null}
        </div>
      ) : null}
      {spec.note ? <div className="faint xs">{spec.note}</div> : null}
    </div>
  );
}
