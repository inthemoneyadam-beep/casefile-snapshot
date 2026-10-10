/**
 * Static SVG rendering of a ChartSpec for the printed packet. A deliberately
 * small subset of the client LineChart: line/scatter series over a date or
 * number axis, a reference band, period bands and markers, flagged points.
 * Colours are a fixed print palette (the packet carries its own stylesheet).
 * Band and marker labels stack into rows instead of sharing one baseline.
 */
import { chartX, type ChartSpec } from '../../shared/chart';
import { formatRange, rangeFromNumbers } from '../../shared/labvalues';

const PRINT = {
  text: '#333',
  faint: '#777',
  grid: '#d9d4cc',
  axis: '#888',
  series: ['#2f6657', '#8d6f22', '#4f6d85', '#5f7a3c', '#8a5f3c', '#555'],
  flagged: '#a0502f',
  refBand: '#f3eddc',
  band: '#e3ebe7',
  bandText: '#2f6657',
  marker: '#999',
};

export interface ChartSvgOptions {
  width?: number;
  height?: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '');
}

function fmtDate(t: number, spanMs: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (spanMs > 3 * 365 * 86400000) return String(y);
  if (spanMs > 120 * 86400000) return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

function dateTicks(min: number, max: number, width: number): number[] {
  const span = max - min;
  const target = Math.max(2, Math.floor(width / 90));
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

/** Overlay labels (band and marker names) are 8px mono; one character advances about 0.6em. */
const LABEL_FONT = 8;
const LABEL_CHAR_W = LABEL_FONT * 0.6;
const LABEL_LANE_H = 10;
const LABEL_GAP = 4;
const NOTE_LINE_H = 11;

interface LabelSlot {
  /** Left edge of the text. */
  x: number;
  /** Row counted from the label group's baseline, or null when it did not fit on the plot. */
  lane: number | null;
}

function labelWidth(label: string): number {
  return [...label].length * LABEL_CHAR_W;
}

/**
 * Stack overlay labels into rows so labels whose x extents overlap do not
 * overprint, as the client LineChart does on screen. A label starts just
 * right of its anchor and takes the first row whose previous label has
 * already ended. Near the right edge it stays inside the plot: a marker
 * label flips to end just left of its line, a band label ends at the edge.
 * A label gets lane null when every row is taken or it is wider than the
 * plot; the caller lists those under the chart, since a printed page has
 * no hover title.
 */
function labelLanes(anchors: number[], labels: string[], lanes: number, left: number, right: number, nearRight: 'flip' | 'clamp'): LabelSlot[] {
  const out: LabelSlot[] = anchors.map((a) => ({ x: a + 3, lane: null }));
  const ends = new Array<number>(Math.max(1, lanes)).fill(Number.NEGATIVE_INFINITY);
  const order = anchors.map((_, i) => i).filter((i) => Number.isFinite(anchors[i]));
  for (const i of order) {
    const w = labelWidth(labels[i]);
    const x = anchors[i] + 3;
    out[i].x = x + w <= right ? x : Math.max(left, nearRight === 'flip' ? anchors[i] - 3 - w : right - w);
  }
  order.sort((a, b) => out[a].x - out[b].x || a - b);
  for (const i of order) {
    const w = labelWidth(labels[i]);
    if (!labels[i] || w > right - left) continue;
    const lane = ends.findIndex((e) => e <= out[i].x);
    if (lane < 0) continue;
    out[i].lane = lane;
    ends[lane] = out[i].x + w + LABEL_GAP;
  }
  return out;
}

/** Greedy word wrap by estimated character width. */
function wrapText(text: string, maxWidth: number): string[] {
  const perLine = Math.max(10, Math.floor(maxWidth / LABEL_CHAR_W));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if ([...next].length <= perLine || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Render a ChartSpec to a standalone `<svg>` string. Returns null when nothing is plottable. */
export function renderChartSvg(spec: ChartSpec, opts: ChartSvgOptions = {}): string | null {
  const width = opts.width ?? 640;
  const height = opts.height ?? 220;
  const legendWidth = 150;
  const pad = { top: 16, right: 10, bottom: 28, left: 46 };
  const plotW = Math.max(80, width - legendWidth - pad.left - pad.right);
  const plotH = Math.max(60, height - pad.top - pad.bottom);

  const categories = spec.xType === 'category' ? [...new Set(spec.series.flatMap((s) => s.points.map((p) => String(p.x))))] : undefined;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of spec.series) {
    for (const p of s.points) {
      const x = chartX(p.x, spec.xType, categories);
      if (Number.isFinite(x) && p.y != null && Number.isFinite(p.y)) {
        xs.push(x);
        ys.push(p.y);
      }
    }
  }
  if (!ys.length) return null;
  for (const b of spec.bands ?? []) {
    const a = chartX(b.from, spec.xType, categories);
    if (Number.isFinite(a)) xs.push(a);
    if (b.to != null) {
      const z = chartX(b.to, spec.xType, categories);
      if (Number.isFinite(z)) xs.push(z);
    }
  }
  for (const m of spec.markers ?? []) {
    const x = chartX(m.x, spec.xType, categories);
    if (Number.isFinite(x)) xs.push(x);
  }
  if (spec.referenceBand) {
    if (spec.referenceBand.low != null) ys.push(spec.referenceBand.low);
    if (spec.referenceBand.high != null) ys.push(spec.referenceBand.high);
  }
  // A range the patient typed for a computed test: its lines stay on the plot.
  if (spec.typedRange) {
    if (spec.typedRange.low != null) ys.push(spec.typedRange.low);
    if (spec.typedRange.high != null) ys.push(spec.typedRange.high);
  }
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMin === xMax) {
    const padX = spec.xType === 'date' ? 15 * 86400000 : 1;
    xMin -= padX;
    xMax += padX;
  } else if (spec.xType === 'category') {
    xMin -= 0.5;
    xMax += 0.5;
  } else {
    const padX = (xMax - xMin) * 0.04;
    xMin -= padX;
    xMax += padX;
  }
  let yMin: number;
  let yMax: number;
  if (Array.isArray(spec.yDomain)) [yMin, yMax] = spec.yDomain;
  else {
    yMin = Math.min(...ys);
    yMax = Math.max(...ys);
    if (spec.type === 'bar' && yMin > 0) yMin = 0;
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    } else {
      const padY = (yMax - yMin) * 0.1;
      yMin -= padY;
      yMax += padY;
    }
  }
  const sx = (x: number) => pad.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y: number) => pad.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;
  const xTicks = spec.xType === 'date' ? dateTicks(xMin, xMax, plotW) : spec.xType === 'category' ? (categories ?? []).map((_, i) => i) : niceTicks(xMin, xMax, Math.max(2, Math.floor(plotW / 80)));
  const yTicks = niceTicks(yMin, yMax, Math.max(2, Math.floor(plotH / 36)));
  const spanMs = xMax - xMin;

  // Band labels stack down from the top of the plot and marker labels up from
  // the bottom, each in up to a third of the plot height. Labels that find no
  // row are listed in a note under the axis rather than left off the page.
  const maxLanes = Math.max(1, Math.min(4, Math.floor(plotH / 3 / LABEL_LANE_H)));
  const plotRight = pad.left + plotW;
  const bands = (spec.bands ?? []).map((b) => {
    const x0 = sx(chartX(b.from, spec.xType, categories));
    const x1 = b.to == null ? plotRight : sx(chartX(b.to, spec.xType, categories));
    const ok = Number.isFinite(x0) && Number.isFinite(x1);
    return { b, ok, left: ok ? Math.min(x0, x1) : NaN, width: ok ? Math.max(1, Math.abs(x1 - x0)) : 0 };
  });
  const bandSlots = labelLanes(bands.map((g) => g.left), bands.map((g) => g.b.label), maxLanes, pad.left, plotRight, 'clamp');
  const markers = (spec.markers ?? []).map((m) => ({ m, x: sx(chartX(m.x, spec.xType, categories)) }));
  const markerSlots = labelLanes(markers.map((g) => g.x), markers.map((g) => g.m.label), maxLanes, pad.left, plotRight, 'flip');
  const unplaced: string[] = [];
  bands.forEach((g, i) => {
    if (g.ok && g.b.label && bandSlots[i].lane == null) unplaced.push(`${g.b.label} (${String(g.b.from)}${g.b.to == null ? ' on' : `–${String(g.b.to)}`})`);
  });
  markers.forEach((g, i) => {
    if (Number.isFinite(g.x) && g.m.label && markerSlots[i].lane == null) unplaced.push(`${g.m.label} (${String(g.m.x)})`);
  });
  const noteLines = unplaced.length ? wrapText(`Also marked: ${unplaced.join('; ')}`, width - pad.left - pad.right) : [];
  const totalHeight = height + noteLines.length * NOTE_LINE_H;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" role="img" aria-label="${esc(spec.title ?? 'chart')}" font-family="Consolas, 'Courier New', monospace" font-size="9">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${totalHeight}" fill="#fff"/>`);
  const rb = spec.referenceBand;
  if (rb && (rb.low != null || rb.high != null)) {
    const top = sy(rb.high ?? yMax);
    const bottom = sy(rb.low ?? yMin);
    parts.push(`<rect x="${pad.left}" y="${top.toFixed(1)}" width="${plotW}" height="${Math.max(0, bottom - top).toFixed(1)}" fill="${PRINT.refBand}"/>`);
  }
  bands.forEach((g, i) => {
    if (!g.ok) return;
    parts.push(`<rect x="${g.left.toFixed(1)}" y="${pad.top}" width="${g.width.toFixed(1)}" height="${plotH}" fill="${PRINT.band}"/>`);
    const slot = bandSlots[i];
    if (slot.lane != null) parts.push(`<text x="${slot.x.toFixed(1)}" y="${pad.top + 10 + slot.lane * LABEL_LANE_H}" fill="${PRINT.bandText}" font-size="${LABEL_FONT}">${esc(g.b.label)}</text>`);
  });
  for (const t of yTicks) {
    parts.push(`<line x1="${pad.left}" x2="${pad.left + plotW}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" stroke="${PRINT.grid}"/>`);
    parts.push(`<text x="${pad.left - 5}" y="${(sy(t) + 3).toFixed(1)}" text-anchor="end" fill="${PRINT.faint}">${fmtNum(t)}</text>`);
  }
  for (const t of xTicks) {
    const x = sx(t);
    const label = spec.xType === 'date' ? fmtDate(t, spanMs) : spec.xType === 'category' ? (categories?.[t] ?? '') : fmtNum(t);
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.top + plotH}" y2="${pad.top + plotH + 4}" stroke="${PRINT.axis}"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${pad.top + plotH + 15}" text-anchor="middle" fill="${PRINT.faint}">${esc(label)}</text>`);
  }
  parts.push(`<line x1="${pad.left}" x2="${pad.left + plotW}" y1="${pad.top + plotH}" y2="${pad.top + plotH}" stroke="${PRINT.axis}"/>`);
  if (spec.yLabel) parts.push(`<text x="${pad.left}" y="9" fill="${PRINT.faint}">${esc(spec.yLabel)}</text>`);
  markers.forEach((g, i) => {
    if (!Number.isFinite(g.x)) return;
    parts.push(`<line x1="${g.x.toFixed(1)}" x2="${g.x.toFixed(1)}" y1="${pad.top}" y2="${pad.top + plotH}" stroke="${PRINT.marker}" stroke-dasharray="2 3"/>`);
    const slot = markerSlots[i];
    if (slot.lane != null) parts.push(`<text x="${slot.x.toFixed(1)}" y="${pad.top + plotH - 4 - slot.lane * LABEL_LANE_H}" fill="${PRINT.faint}" font-size="${LABEL_FONT}">${esc(g.m.label)}</text>`);
  });
  spec.series.forEach((s, si) => {
    const color = PRINT.series[si % PRINT.series.length];
    const kind = s.kind ?? spec.type;
    const pts = s.points
      .map((p) => ({ x: chartX(p.x, spec.xType, categories), y: p.y, flag: p.flag, marker: p.marker ?? null }))
      .filter((p) => Number.isFinite(p.x))
      .sort((a, b) => a.x - b.x);
    if (kind === 'bar') {
      const w = Math.max(2, Math.min(18, (plotW / Math.max(1, pts.length)) * 0.6));
      for (const p of pts) {
        if (p.y == null) continue;
        const y0 = sy(Math.max(yMin, 0));
        const y1 = sy(p.y);
        parts.push(`<rect x="${(sx(p.x) - w / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.abs(y0 - y1).toFixed(1)}" fill="${color}" opacity="0.85"/>`);
      }
      return;
    }
    if (kind === 'line' && pts.length > 1) {
      let d = '';
      let pen = false;
      for (const p of pts) {
        if (p.y == null) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)} `;
        pen = true;
      }
      if (d) parts.push(`<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
    }
    for (const p of pts) {
      if (p.y == null) continue;
      // A value computed by the patient: an open square, never red (2026-10-09).
      if (p.marker === 'square') {
        parts.push(`<rect x="${(sx(p.x) - 3).toFixed(1)}" y="${(sy(p.y) - 3).toFixed(1)}" width="6" height="6" fill="#fff" stroke="${color}" stroke-width="1.3"/>`);
        continue;
      }
      const flagged = Boolean(p.flag && /H|L|A|C/.test(p.flag));
      parts.push(`<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${flagged ? 3.2 : 2.4}" fill="${flagged ? PRINT.flagged : color}"/>`);
    }
  });
  // Legend.
  const lx = pad.left + plotW + 12;
  spec.series.forEach((s, si) => {
    const color = PRINT.series[si % PRINT.series.length];
    const y = pad.top + 10 + si * 14;
    parts.push(`<rect x="${lx}" y="${y - 7}" width="8" height="8" fill="${color}"/>`);
    const name = s.name.length > 18 ? `${s.name.slice(0, 18)}…` : s.name;
    parts.push(`<text x="${lx + 12}" y="${y}" fill="${PRINT.text}">${esc(name)}${s.unit ? ` (${esc(s.unit)})` : ''}</text>`);
  });
  let ly = pad.top + 10 + spec.series.length * 14;
  if (rb && (rb.low != null || rb.high != null)) {
    parts.push(`<rect x="${lx}" y="${ly - 7}" width="8" height="8" fill="${PRINT.refBand}" stroke="#c9b97a"/>`);
    // A band with no label says its bounds in words ("upper limit 50"), never "–50" for a missing bound (rule 3).
    parts.push(`<text x="${lx + 12}" y="${ly}" fill="${PRINT.faint}">${esc(rb.label ?? `ref ${formatRange(rangeFromNumbers(rb.low, rb.high)) ?? ''}`)}</text>`);
    ly += 14;
  }
  const tr = spec.typedRange;
  if (tr && (tr.low != null || tr.high != null)) {
    for (const y of [tr.low, tr.high]) if (y != null) parts.push(`<line x1="${pad.left}" x2="${pad.left + plotW}" y1="${sy(y).toFixed(1)}" y2="${sy(y).toFixed(1)}" stroke="${PRINT.faint}" stroke-dasharray="4 3"/>`);
    parts.push(`<line x1="${lx}" x2="${lx + 8}" y1="${ly - 3}" y2="${ly - 3}" stroke="${PRINT.faint}" stroke-dasharray="2 1.5"/>`);
    parts.push(`<text x="${lx + 12}" y="${ly}" fill="${PRINT.faint}">${esc(tr.label)}</text>`);
    ly += 14;
  }
  if (spec.series.some((s) => s.points.some((p) => p.marker === 'square'))) {
    parts.push(`<rect x="${lx + 1}" y="${ly - 6}" width="6" height="6" fill="#fff" stroke="${PRINT.text}" stroke-width="1.2"/>`);
    parts.push(`<text x="${lx + 12}" y="${ly}" fill="${PRINT.faint}">computed</text>`);
    ly += 14;
  }
  if (spec.series.some((s) => s.points.some((p) => p.flag && /H|L|A|C/.test(p.flag)))) {
    parts.push(`<circle cx="${lx + 4}" cy="${ly - 3}" r="3" fill="${PRINT.flagged}"/>`);
    parts.push(`<text x="${lx + 12}" y="${ly}" fill="${PRINT.faint}">out of range</text>`);
  }
  noteLines.forEach((line, i) => {
    parts.push(`<text x="${pad.left}" y="${height + 4 + i * NOTE_LINE_H}" fill="${PRINT.faint}" font-size="${LABEL_FONT}">${esc(line)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}
