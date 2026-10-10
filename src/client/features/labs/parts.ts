/**
 * A lab line that held several tests.
 *
 * The server reads a line such as "CSF opening pressure / protein: OP 17;
 * protein 52" as one entry per test: each part carries `splitFrom` (the line
 * as written, which part it is, how many there are) and an id of the form
 * `<row or fact id>#<index>`. A line the server could not split stays one
 * entry marked `combined`. A part is shown with a faint "from one line: ..."
 * under it; a combined entry with a small "one line, several tests" label.
 *
 * Every open, edit and delete acts on the original row or fact (labResultId /
 * factId), never on the part id: the line is stored once, as written.
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import type { ChartSpec } from '@shared/chart';
import { unitKey, type LabReadingView } from '@shared/labvalues';

export interface LabSplitFrom {
  /** The line as written in the document. */
  text: string;
  /** Which part of the line this entry is. */
  index: number;
  /** How many tests the line held. */
  of: number;
}

/** The fields the helpers read; every one optional so older payloads pass through. */
export interface PartLike {
  id?: string | null;
  source?: 'row' | 'fact' | string | null;
  labResultId?: string | null;
  factId?: string | null;
  splitFrom?: LabSplitFrom | null;
  combined?: boolean | null;
}

export const COMBINED_LABEL = 'one line, several tests';
export const COMBINED_TITLE = 'This line names several tests and the app could not tell which value is which; open the document to read it.';
export const FROM_LINE_PREFIX = 'from one line: ';

const PART_SUFFIX = /#\d+$/;

/** A part id: `<row or fact id>#<index>`. */
export function isPartId(id: string | null | undefined): boolean {
  return typeof id === 'string' && PART_SUFFIX.test(id);
}

/** The part's line, when the entry carries a usable one (defensive about the payload's shape). */
export function splitFromOf(e: PartLike | null | undefined): LabSplitFrom | null {
  const sf = e?.splitFrom;
  if (!sf || typeof sf !== 'object') return null;
  const text = typeof sf.text === 'string' ? sf.text.trim() : '';
  if (!text) return null;
  return { text, index: Number.isFinite(sf.index) ? sf.index : 0, of: Number.isFinite(sf.of) ? sf.of : 0 };
}

/** One part of a line that held several tests. */
export function isPart(e: PartLike | null | undefined): boolean {
  return Boolean(splitFromOf(e)) || isPartId(e?.id);
}

/** A line naming several tests that the app could not split. */
export function isCombined(e: PartLike | null | undefined): boolean {
  return e?.combined === true;
}

/**
 * The id of the stored entry behind this one: the entry's own id, or for a part the original
 * row's (labResultId) or fact's (`fact:<factId>`). Used to open, link and resolve old links.
 */
export function originalEntryId(e: PartLike & { id: string }): string {
  if (!isPart(e)) return e.id;
  if (e.source !== 'fact' && e.labResultId) return e.labResultId;
  if (e.source === 'fact' && e.factId) return `fact:${e.factId}`;
  if (e.labResultId) return e.labResultId;
  return e.id.replace(PART_SUFFIX, '');
}

/** The lab_results id that Edit and Delete act on: the original row's, never a part id. Null for a value only read by Claude. */
export function rowActionId(e: (PartLike & { id: string }) | null | undefined): string | null {
  if (!e || e.source !== 'row') return null;
  return e.labResultId ?? e.id.replace(PART_SUFFIX, '');
}

/** "from one line: <the line as written>", or null for an entry that is not a part. */
export function fromLineWords(e: PartLike | null | undefined): string | null {
  const sf = splitFromOf(e);
  return sf ? `${FROM_LINE_PREFIX}${sf.text}` : null;
}

/** Hover words for the "from one line" note. */
export function fromLineTitle(e: PartLike | null | undefined): string | undefined {
  const sf = splitFromOf(e);
  if (!sf) return undefined;
  const n = sf.of > 1 ? `one of ${sf.of} tests` : 'one of several tests';
  return `This value is ${n} written on one line of the document: ${sf.text}. Opening, editing or deleting it acts on that whole line.`;
}

/**
 * The entry a URL id points at: the one with that id; else, for an older link carrying the original row or fact id,
 * the first part of that line; else, for a part id that is gone (its line was edited and now reads differently), that
 * line: the stored entry, or its first part.
 */
export function resolveSelection<T extends PartLike & { id: string }>(items: readonly T[], selectedId: string | null | undefined): T | null {
  if (!selectedId) return null;
  const firstPartOf = (id: string) => items.find((r) => isPart(r) && originalEntryId(r) === id);
  const exact = items.find((r) => r.id === selectedId) ?? firstPartOf(selectedId);
  if (exact || !isPartId(selectedId)) return exact ?? null;
  const line = selectedId.replace(PART_SUFFIX, '');
  return items.find((r) => r.id === line) ?? firstPartOf(line) ?? null;
}

/**
 * The entry the URL names: the listed one (by its own id, or the first part of the line an older link names), else
 * the one fetched by id (a link outside the current filters). A fetch that answered with another entry never stands in.
 */
export function pickSelected<T extends PartLike & { id: string }>(items: readonly T[], selectedId: string | null | undefined, fetched: T | null | undefined): T | null {
  if (!selectedId) return null;
  const listed = resolveSelection(items, selectedId);
  const own = fetched && fetched.id === selectedId ? fetched : null;
  if (listed && listed.id === selectedId) return own ?? listed;
  return listed ?? own;
}

/**
 * What Edit opens: the entry itself, or for a part the whole line as stored, once it is loaded. Never the part: the
 * form saves every field, so a part would write one test over the whole line.
 */
export function editTarget<T extends PartLike & { id: string }>(selected: T | null | undefined, line: T | null | undefined): T | null {
  if (!selected) return null;
  if (!isPart(selected)) return selected;
  const lineId = rowActionId(selected);
  return lineId && line && line.id === lineId && !isPart(line) ? line : null;
}

// ---------------------------------------------------------------------------
// Charts: one per unit
// ---------------------------------------------------------------------------

export interface UnitChart {
  /** The unit as written ('' for values given without one). */
  unit: string;
  /** "cmH2O", or "no unit printed". */
  unitLabel: string;
  spec: ChartSpec;
}

const unitOf = (u: string | null | undefined): string => (typeof u === 'string' ? u.trim() : '');
/** A series with a number to draw (as words.ts hasNumericPoint; kept here so this file imports nothing of the client). */
const drawableSeries = (s: ChartSpec['series'][number]): boolean => Array.isArray(s?.points) && s.points.some((p) => typeof p?.y === 'number' && Number.isFinite(p.y));
/** A unit's name on its chart: as printed, or "no unit printed" (values printed without one are their own series). */
export const unitLabel = (u: string): string => u || 'no unit printed';

/** A value in view on the chart (a test's readings in the dates shown), with its reading (LabEntry.reading). */
export interface BandReading {
  reading?: LabReadingView | null;
  /** A value marked inaccurate is not drawn, so its range does not count. */
  trust?: { trust: string } | null;
}

/** A range's signature: its bounds, their signs and its unit (as the server's rangeSignature). */
function bandSignature(v: LabReadingView): string {
  return `${v.rangeLow ?? ''}|${v.rangeLowComparator ?? ''}|${v.rangeHigh ?? ''}|${v.rangeHighComparator ?? ''}|${v.rangeUnitKey ?? ''}`;
}

/**
 * The chart's band (rule 8, amendment D3): the server shades the one range the readings in view printed. When it drew
 * none, the band may be added here only from the readings in view, and only when those that printed a range (a lab
 * report, a document not sorted yet, or entered by hand; never a summary's claim) all printed one and the same range
 * (bounds, signs, unit). Readings that printed none do not cancel it, and are not judged by it. Two different ranges:
 * no band (each point is judged by its own range, the chart note names them). A range is never borrowed from readings
 * outside the view, nor from the test as a whole. The band goes in the unit its range is written in: a series in that
 * unit, or a chart in one unit. Otherwise the chart comes back as it is.
 */
export function withTestBand(spec: ChartSpec, inView: ReadonlyArray<BandReading | null | undefined> | null | undefined): ChartSpec {
  const band = spec.referenceBand;
  if (band && (band.low != null || band.high != null)) return spec;
  if (!Array.isArray(inView) || !inView.length) return spec;
  const sigs = new Map<string, LabReadingView>();
  for (const x of inView) {
    const v = x?.reading;
    // Only the values drawn: a measurement, not marked inaccurate.
    if (!v || v.measurement == null || x?.trust?.trust === 'inaccurate') continue;
    if (v.role === 'claimed' || v.rangeStatus !== 'parsed' || v.rangeKind === 'text' || (v.rangeLow == null && v.rangeHigh == null)) continue;
    sigs.set(bandSignature(v), v);
  }
  if (sigs.size !== 1) return spec;
  const v = [...sigs.values()][0];
  const units = [...new Set((Array.isArray(spec.series) ? spec.series : []).map((s) => unitOf(s.unit)).filter(Boolean))];
  const want = v.rangeUnitKey;
  const unit = want ? units.find((u) => unitKey(u) === want) : units.length <= 1 ? (units[0] ?? '') : undefined;
  if (unit === undefined) return spec;
  const shown = v.rangeShown ?? '';
  // A range printed in its own unit keeps it, never relabelled with the series' (rule 5).
  const withUnit = unit && !v.rangeUnit && !shown.toLowerCase().includes(unit.toLowerCase()) ? ` ${unit}` : '';
  return { ...spec, referenceBand: { low: v.rangeLow, high: v.rangeHigh, label: `ref ${shown}${withUnit}` } };
}

/**
 * A chart whose series come in several units, as one chart per unit (each with its own y axis, labelled by its
 * unit), so 17 cmH2O and 38 mmHg are never drawn against one scale. The reference band stays with the unit it is
 * written in (its label ends with that unit; else the first series'), the note goes under the last chart. A chart in
 * one unit comes back as it is.
 */
export function unitCharts(spec: ChartSpec): UnitChart[] {
  const all = Array.isArray(spec?.series) ? spec.series : [];
  // A unit with no number to draw gets no chart of its own (never an empty chart beside a drawn one).
  const drawable = all.filter(drawableSeries);
  const series = drawable.length && drawable.length < all.length ? drawable : all;
  const units: string[] = [];
  for (const s of series) {
    const u = unitOf(s.unit);
    if (!units.includes(u)) units.push(u);
  }
  if (units.length <= 1) {
    const u = units[0] ?? unitOf(spec?.yLabel);
    return [{ unit: u, unitLabel: unitLabel(u), spec: series === all ? spec : { ...spec, series } }];
  }
  const bandLabel = spec.referenceBand?.label?.trim() ?? '';
  const bandUnit = [...units].filter(Boolean).sort((a, b) => b.length - a.length).find((u) => bandLabel.endsWith(` ${u}`)) ?? units[0];
  const base = (spec.title ?? '').trim();
  return units.map((u, i) => {
    const own = series.filter((s) => unitOf(s.unit) === u);
    const n = own.reduce((k, s) => k + s.points.filter((p) => p.y != null).length, 0);
    return {
      unit: u,
      unitLabel: unitLabel(u),
      spec: {
        ...spec,
        title: base ? `${base} · ${unitLabel(u)}` : unitLabel(u),
        subtitle: `${n} value${n === 1 ? '' : 's'} in ${unitLabel(u)}`,
        yLabel: u || null,
        series: own,
        referenceBand: u === bandUnit ? (spec.referenceBand ?? null) : null,
        note: i === units.length - 1 ? (spec.note ?? null) : null,
      },
    };
  });
}
