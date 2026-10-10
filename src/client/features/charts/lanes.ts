/**
 * Medication courses (a ChartSpec's `bands`) as lanes under a chart's x axis,
 * and the plain words that describe a course. Pure TypeScript, no React and no
 * DOM, so tests/medlanes-client-lanes.test.ts can run it under node.
 *
 * A band may carry optional fields (set by the server for medication courses):
 * `lane` (bands with the same lane share a row; default: the label),
 * `startKnown` (false when only a mention date is known; default true),
 * `ongoing` (still taking; default: no stop date), `clippedStart` and
 * `clippedEnd` (the course runs past the window and its date was moved to the
 * window's edge). A band without them (lab charts, Ask charts) becomes a lane
 * labelled with its label.
 */
import { chartX, type ChartBand, type ChartSpec, type ChartTone } from '@shared/chart';

/** The optional fields a band may carry. Declared here so the chart works with or without them. */
export interface BandFlags {
  lane?: string | null;
  startKnown?: boolean | null;
  ongoing?: boolean | null;
  clippedStart?: boolean | null;
  clippedEnd?: boolean | null;
}
export type LaneBand = ChartBand & BandFlags;

/** Rows drawn under a chart before the rest are summed up as "+N more". */
export const MAX_LANE_ROWS = 10;
/** Height of one lane row, in px. */
export const LANE_ROW_H = 16;
/** Rough advance of one character of the chart's mono labels (11px; 12.5px in large text). */
export const LABEL_CHAR_W = 7.5;

export interface LaneSegment {
  /** Index of the band in the spec. */
  index: number;
  label: string;
  tone: ChartTone;
  /** The band's dates as given (for the hover title). */
  from: string;
  to: string | null;
  /** Data x of the drawn start and end, clipped to the drawn range. */
  x0: number;
  x1: number;
  startKnown: boolean;
  ongoing: boolean;
  /** The course began before the drawn range (the bar runs from the left edge). */
  openStart: boolean;
  /** Arrowhead at the right end: still taking, or the course runs past the drawn range. */
  arrow: boolean;
  /** End cap: a stop inside the drawn range. */
  endCap: boolean;
  /** A recorded one-day course: drawn as a diamond. */
  oneDay: boolean;
  /** Data x of a recorded start or stop inside the range, for the faint guides on the plot. */
  guides: number[];
  /** Hover words, e.g. "Lisinopril: taking; on your list since 2026-10-04 (start date not recorded)". */
  title: string;
}

export interface Lane {
  key: string;
  /** The row's name: the shortest label among its bands. */
  label: string;
  /** Every distinct label in the row (for the hover title). */
  labels: string[];
  tone: ChartTone;
  segments: LaneSegment[];
}

export interface LaneLayout {
  /** The rows drawn, in order. */
  lanes: Lane[];
  /** Rows past MAX_LANE_ROWS, not drawn. */
  hidden: Lane[];
}

/** A band's optional fields with their defaults. */
export function readBand(b: LaneBand): { key: string; startKnown: boolean; ongoing: boolean; clippedStart: boolean; clippedEnd: boolean; tone: ChartTone } {
  const lane = typeof b.lane === 'string' && b.lane.trim() ? b.lane.trim() : null;
  return {
    key: lane ?? b.label.trim(),
    startKnown: b.startKnown ?? true,
    ongoing: b.ongoing ?? b.to == null,
    clippedStart: Boolean(b.clippedStart),
    clippedEnd: Boolean(b.clippedEnd),
    tone: b.tone ?? 'accent',
  };
}

export interface CourseWordsInput {
  from: string | number;
  to: string | number | null;
  startKnown?: boolean | null;
  ongoing?: boolean | null;
  /** Only for a chart's clipped band: its from/to sit at the window's edge, not the real date. */
  clippedStart?: boolean | null;
  clippedEnd?: boolean | null;
  /**
   * When the start is not recorded: the first date the records mention the drug. Null says no document dates it
   * (`from` is then only the window's edge and is not said); absent, `from` is taken as that first mention.
   */
  firstSeen?: string | null;
}

/**
 * A course in plain words:
 *   taking since 2025-06-02
 *   taking; on your list since 2026-10-04 (start date not recorded)
 *   stopped 2025-06-16 (start date not recorded)
 *   taken 2025-06-02 to 2025-06-16
 */
export function courseWords(c: CourseWordsInput): string {
  const from = String(c.from);
  const to = c.to == null ? null : String(c.to);
  const startKnown = c.startKnown ?? true;
  const ongoing = c.ongoing ?? to == null;
  const s = c.clippedStart ? `before ${from}` : from;
  const notRecorded = '(start date not recorded)';
  // A start that is not recorded and a `from` that is no mention date either: say no date for it.
  const seen = startKnown || c.firstSeen !== null;
  if (ongoing) return startKnown ? `taking since ${s}` : seen ? `taking; on your list since ${s} ${notRecorded}` : `taking ${notRecorded}`;
  if (to == null) return startKnown ? `started ${s}; stop date not recorded` : seen ? `on your list since ${s}; start and stop dates not recorded` : 'start and stop dates not recorded';
  if (c.clippedEnd) return startKnown ? `taking since ${s}; stops after ${to}` : seen ? `on your list since ${s}; stops after ${to} ${notRecorded}` : `stops after ${to} ${notRecorded}`;
  if (!startKnown) return to === from || c.clippedStart || !seen ? `stopped ${to} ${notRecorded}` : `stopped ${to}; first mentioned ${from} ${notRecorded}`;
  if (c.clippedStart) return `taken until ${to}, started before ${from}`;
  return to === from ? `taken on ${from}` : `taken ${from} to ${to}`;
}

/** Shorten a label to fit `maxPx` with an ellipsis. */
export function fitLabel(text: string, maxPx: number, charW = LABEL_CHAR_W): string {
  const max = Math.floor(maxPx / charW);
  if (text.length <= max) return text;
  if (max <= 0) return '';
  if (max === 1) return '…';
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface LaneOptions {
  xType: ChartSpec['xType'];
  categories?: string[];
  /** The chart's drawn x range (data units). */
  xMin: number;
  xMax: number;
  maxRows?: number;
}

/**
 * Group bands into rows by lane key and clip each to [xMin, xMax]. Rows are
 * ordered by their first drawn start, ties by the order the bands were given
 * (the server lists courses by their true start, so a course moved to the
 * window's left edge keeps its true place). Bands with no usable start, or
 * wholly outside the range, are left out.
 */
export function buildLanes(bands: LaneBand[] | null | undefined, opts: LaneOptions): LaneLayout {
  const { xType, categories, xMin, xMax } = opts;
  const maxRows = Math.max(1, opts.maxRows ?? MAX_LANE_ROWS);
  const byKey = new Map<string, { lane: Lane; first: number; start: number }>();
  (bands ?? []).forEach((b, index) => {
    const r = readBand(b);
    const fromX = chartX(b.from, xType, categories);
    if (!Number.isFinite(fromX)) return;
    const toRaw = b.to == null ? null : chartX(b.to, xType, categories);
    const toX = toRaw != null && Number.isFinite(toRaw) ? Math.max(toRaw, fromX) : null;
    const endX = toX ?? xMax;
    if (endX < xMin || fromX > xMax) return;
    const x0 = Math.max(fromX, xMin);
    const x1 = Math.min(Math.max(endX, x0), xMax);
    const openStart = r.clippedStart || fromX < xMin;
    const runsPast = r.clippedEnd || (toX != null && toX > xMax);
    const stopInside = !r.ongoing && toX != null && !runsPast;
    const guides: number[] = [];
    if (r.startKnown && !openStart) guides.push(fromX);
    if (stopInside && !(r.startKnown && toX === fromX)) guides.push(toX);
    const seg: LaneSegment = {
      index,
      label: b.label,
      tone: r.tone,
      from: String(b.from),
      to: b.to == null ? null : String(b.to),
      x0,
      x1,
      startKnown: r.startKnown,
      ongoing: r.ongoing,
      openStart,
      arrow: r.ongoing || runsPast,
      endCap: stopInside,
      oneDay: r.startKnown && stopInside && toX === fromX,
      guides,
      // A chart band whose start is not recorded may begin at the window's edge rather than a mention date
      // (a course known only by its stop), so a stopped one's hover never names a first-mention date.
      title: `${b.label}: ${courseWords({ from: b.from, to: b.to, startKnown: r.startKnown, ongoing: r.ongoing, clippedStart: openStart, clippedEnd: runsPast, firstSeen: !r.startKnown && !r.ongoing ? null : undefined })}`,
    };
    const hit = byKey.get(r.key);
    if (hit) {
      hit.lane.segments.push(seg);
      hit.start = Math.min(hit.start, x0);
    } else {
      byKey.set(r.key, { lane: { key: r.key, label: b.label, labels: [], tone: r.tone, segments: [seg] }, first: index, start: x0 });
    }
  });
  const rows = [...byKey.values()].sort((a, b) => a.start - b.start || a.first - b.first);
  const lanes = rows.map(({ lane }) => {
    lane.segments.sort((a, b) => a.x0 - b.x0 || a.index - b.index);
    const labels = [...new Set(lane.segments.map((s) => s.label.trim()).filter(Boolean))];
    const label = labels.reduce((best, l) => (l.length < best.length ? l : best), labels[0] ?? lane.key);
    const last = lane.segments[lane.segments.length - 1];
    const tone = (lane.segments.find((s) => s.ongoing) ?? last).tone;
    return { ...lane, label, labels, tone };
  });
  return { lanes: lanes.slice(0, maxRows), hidden: lanes.slice(maxRows) };
}

/** Pixel height the lane area adds under the x axis (0 when there are no lanes). */
export function laneAreaHeight(layout: LaneLayout): number {
  if (!layout.lanes.length) return 0;
  return 8 + layout.lanes.length * LANE_ROW_H + (layout.hidden.length ? LANE_ROW_H : 0) + 4;
}

/**
 * Width of the label column on the left (the y axis gutter widened for the
 * names): fits the longest name up to `cap`, never narrower than `min`.
 */
export function laneLabelWidth(layout: LaneLayout, min: number, cap: number): number {
  if (!layout.lanes.length) return min;
  const longest = Math.max(...layout.lanes.map((l) => l.label.length));
  return Math.round(Math.max(min, Math.min(cap, longest * LABEL_CHAR_W + 14)));
}

/** The categories of a category axis, in the order LineChart draws them (first seen in the series). */
export function specCategories(spec: Pick<ChartSpec, 'xType' | 'series'>): string[] | undefined {
  return spec.xType === 'category' ? [...new Set(spec.series.flatMap((s) => s.points.map((p) => String(p.x))))] : undefined;
}

/**
 * The x extent of everything a chart draws (series points, band ends, markers), in data units, before any
 * padding; null when nothing has a usable x.
 */
export function specXExtent(spec: Pick<ChartSpec, 'xType' | 'series' | 'bands' | 'markers'>, categories = specCategories(spec)): [number, number] | null {
  const xs: number[] = [];
  for (const s of spec.series) for (const p of s.points) xs.push(chartX(p.x, spec.xType, categories));
  for (const b of spec.bands ?? []) {
    xs.push(chartX(b.from, spec.xType, categories));
    if (b.to != null) xs.push(chartX(b.to, spec.xType, categories));
  }
  for (const m of spec.markers ?? []) xs.push(chartX(m.x, spec.xType, categories));
  const ok = xs.filter(Number.isFinite);
  return ok.length ? [Math.min(...ok), Math.max(...ok)] : null;
}

/** What two or more charts stacked over one window share so they line up: the x range and the left column's width. */
export interface StackedAlign {
  /** The x range every chart covers (each chart pads it the same way), or null on a category axis or with no data. */
  xRange: [number, number] | null;
  /** Width wanted for the left column (y axis and lane names), before each chart caps it to its share of the width. */
  labelWidth: number;
}

/** The left column's narrowest width (the y axis labels alone). */
export const MIN_LABEL_W = 48;

/**
 * Line up charts drawn one above the other over the same window (the symptom chart and the sleep chart): the same x
 * range (the union of what each draws, so nothing falls outside either plot) and the same left column (wide enough
 * for the longest lane name any of them would draw). Charts of the same width then put a date at the same x, and the
 * faint start and stop guides fall on the same x in each.
 */
export function stackedChartAlign(specs: Array<Pick<ChartSpec, 'xType' | 'series' | 'bands' | 'markers'>>): StackedAlign {
  const dated = specs.filter((s) => s.xType !== 'category');
  const extents = dated.map((s) => specXExtent(s)).filter((e): e is [number, number] => e != null);
  const xRange: [number, number] | null = extents.length && dated.length === specs.length ? [Math.min(...extents.map((e) => e[0])), Math.max(...extents.map((e) => e[1]))] : null;
  let labelWidth = MIN_LABEL_W;
  for (const s of specs) {
    const ext = xRange ?? specXExtent(s);
    if (!ext) continue;
    const layout = buildLanes(s.bands as LaneBand[] | null | undefined, { xType: s.xType, categories: specCategories(s), xMin: ext[0], xMax: ext[1] });
    labelWidth = Math.max(labelWidth, laneLabelWidth(layout, MIN_LABEL_W, Number.POSITIVE_INFINITY));
  }
  return { xRange, labelWidth };
}

/**
 * Stack labels into up to `rows` rows so they never overprint: each label
 * takes the first row whose previous label has ended. Returns the row per
 * label, or null when every row is taken (that label is left off; its tick
 * keeps a hover title and the page lists it).
 */
export function stackLabels(items: Array<{ start: number; width: number }>, rows: number, gap = 8): Array<number | null> {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || a - b);
  const ends = new Array<number>(Math.max(1, rows)).fill(Number.NEGATIVE_INFINITY);
  const out = new Array<number | null>(items.length).fill(null);
  for (const i of order) {
    const row = ends.findIndex((e) => e <= items[i].start);
    if (row < 0) continue;
    out[i] = row;
    ends[row] = items[i].start + items[i].width + gap;
  }
  return out;
}

/**
 * Where a tick's label starts so it stays inside [left, right]: just right of
 * the tick, or ending just left of it when it would run past the right edge.
 * The width returned is what is left for the text (it is shortened to fit).
 */
export function markerLabelPlace(x: number, width: number, left: number, right: number): { start: number; width: number } {
  const after = x + 3;
  if (after + width <= right) return { start: after, width };
  const before = x - 3 - width;
  if (before >= left) return { start: before, width };
  // Too long for either side: take the wider side and shorten the text to it.
  const roomRight = right - after;
  const roomLeft = x - 3 - left;
  return roomRight >= roomLeft ? { start: after, width: Math.max(0, roomRight) } : { start: left, width: Math.max(0, roomLeft) };
}

/**
 * Bands in the order their rows are drawn (row by row, then by start within a
 * row): the page's list under the chart follows it, so it reads as the rows'
 * key. Works on any band list (the page passes the overlays with true dates).
 */
export function laneOrder<T extends LaneBand>(bands: T[], xType: ChartSpec['xType'] = 'date'): T[] {
  const keyOf = (b: T) => readBand(b).key;
  const at = (b: T) => {
    const x = chartX(b.from, xType);
    return Number.isFinite(x) ? x : Number.POSITIVE_INFINITY;
  };
  const rowStart = new Map<string, { start: number; first: number }>();
  bands.forEach((b, i) => {
    const k = keyOf(b);
    const cur = rowStart.get(k);
    if (!cur) rowStart.set(k, { start: at(b), first: i });
    else cur.start = Math.min(cur.start, at(b));
  });
  return bands
    .map((b, i) => ({ b, i }))
    .sort((p, q) => {
      const a = rowStart.get(keyOf(p.b))!;
      const c = rowStart.get(keyOf(q.b))!;
      return a.start - c.start || a.first - c.first || at(p.b) - at(q.b) || p.i - q.i;
    })
    .map((p) => p.b);
}
