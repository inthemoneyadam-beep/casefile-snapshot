/**
 * By test view of the labs ledger: a GroupedList with one group per sample
 * (CSF first, with a thin left rule), one sub-group per panel ("CSF basic",
 * "CSF immunology", "CBC", ...), then one row per test:
 *
 *   Test          the name, the room it needs (two lines before "…", full name on hover)
 *   Latest        the latest value as printed ("<3", "0.80") with its unit, a lab report's (a summary's only when
 *                 the test has nothing else), and "high" / "low" in red when it is outside the range printed with it
 *                 or flagged by the report (never by the test's range or another lab's: 2026-10, rule 8)
 *   Normal range  the one range the test's readings print, as printed (whatever the filters); "2 ranges" when the
 *                 labs print different ones (each listed, with its lab, in the test's pane)
 *   Date          of the latest value
 *   Readings      each measurement once (copies in other documents fold into it), how many were outside the
 *                 range printed with them, and how many disagree with a clinical record
 *
 * Selection is by `analyteKey::specimen`, the same id the analyte table always used.
 */
import { useMemo, type ReactNode } from 'react';
import { GroupedList, type GroupedListColumn, type GroupedListGroup } from '../../ui/GroupedList';
import { DateText } from '../../ui/DateText';
import { displayRef, isSetAside, type AnalyteSummary, type OrganisedAnalyte, type OrganisedPoint, type OrganisedSpecimen } from '../../api/labs';
import { Breakable, LineNote, RangeTag, specimenLabel } from './tags';
import { isCombined, type PartLike } from './parts';
import { rangeMark, readingMark, readings, readingSummary, type RangeMark, type TestRange } from './range';
import type { LabReadingView } from './reading';
import '../reconcile/reconcile.css';
import './computed.css';

export const analyteRowId = (a: { analyteKey: string; specimen: string }) => `${a.analyteKey}::${a.specimen}`;

/** Values in a test's series that disagree with a clinical record. */
export function inaccurateCount(a: Pick<OrganisedAnalyte, 'series'>): number {
  return a.series.reduce((n, p) => n + (p.trust?.trust === 'inaccurate' ? 1 : 0), 0);
}

/**
 * What the row says about its line: the latest value's (a part of a line that held several tests shows that line,
 * faint), and "one line, several tests" when the test is such a line the app could not split.
 */
export function analyteLineNote(a: Pick<OrganisedAnalyte, 'series'> & { combined?: boolean }): PartLike | null {
  const series = Array.isArray(a.series) ? a.series : [];
  const latest = series[series.length - 1];
  const combined = isCombined(a) || series.some((p) => isCombined(p));
  if (!latest && !combined) return null;
  return { id: latest?.id ?? null, splitFrom: latest?.splitFrom ?? null, combined };
}

/** The test's one range (the summary's, set only when its readings print one), to say it; never to judge a value. */
export function testRangeOf(a: Pick<OrganisedAnalyte, 'refLow' | 'refHigh' | 'refText' | 'unit'>): TestRange | null {
  return a.refLow != null || a.refHigh != null ? { low: a.refLow, high: a.refHigh, unit: a.unit, text: a.refText } : null;
}

/**
 * The latest value's mark, from the summary (the server judges it against the range printed with it): the flag the
 * report printed, else one worked out from its own range ("~"); a summary's own flag (lastRole claimed) never.
 */
export function latestMark(a: Pick<AnalyteSummary, 'lastFlag' | 'lastFlagDerived' | 'lastRole' | 'lastValue' | 'lastDate'> & { series?: readonly OrganisedPoint[] }): RangeMark | null {
  if (a.lastRole === 'claimed') return null;
  // The point the summary took as the latest, read in full (a printed "critical" or "HH" says so).
  const pt = [...(a.series ?? [])].reverse().find((p) => p.reading && p.date === a.lastDate && p.reading.valueShown === a.lastValue && p.reading.role !== 'claimed');
  if (pt?.reading) return readingMark(pt.reading);
  if (!a.lastFlag) return null;
  const f = a.lastFlag.replace('~', '').trim().toUpperCase();
  const word = f === 'H' ? 'high' : f === 'L' ? 'low' : f === 'A' ? 'abnormal' : f === 'C' ? 'flagged C' : null;
  if (!word) return null;
  if (a.lastFlagDerived || a.lastFlag.includes('~')) return word === 'high' || word === 'low' ? { word, by: 'range', title: `${word === 'high' ? 'Above' : 'Below'} the range printed with it; the report printed no flag` } : null;
  return { word, by: 'report', title: word === 'flagged C' ? "Flagged C on the report: critical or corrected, the report's own letter" : `Flagged ${word} on the report` };
}

/**
 * The test's Normal range cell: its one range as printed (a range kept as printed, "<1:40", too), else "2 ranges"
 * (different labs), else nothing. The hover names the lab that printed it and, when the latest value (`latest`) printed
 * none of its own or comes from another lab, says so: a range never reads as the latest value's own.
 */
export function rangeCell(a: Pick<AnalyteSummary, 'refLow' | 'refHigh' | 'refText' | 'ranges'>, latest?: Pick<LabReadingView, 'rangeStatus' | 'labKey' | 'lab' | 'role'> | null): { text: string; title?: string } | null {
  const lab = (a.ranges ?? []).filter((r) => r.role !== 'claimed');
  const one = displayRef(a) ?? (lab.length === 1 ? lab[0].shown : null);
  if (one) {
    const r = lab.length === 1 ? lab[0] : null;
    if (!r) return { text: one };
    const by = r.role === 'typed' ? 'Entered by hand' : `Printed by ${r.lab ?? 'a lab not named'}`;
    const latestWords =
      latest && latest.role !== 'claimed'
        ? latest.rangeStatus === 'none'
          ? '; the latest value printed no range of its own'
          : r.lab && latest.lab && latest.lab !== r.lab
            ? `; the latest value is from ${latest.lab}`
            : ''
        : '';
    return { text: one, title: `${by} with ${r.count} reading${r.count === 1 ? '' : 's'}${latestWords}. Each value is judged only by the range printed with it.` };
  }
  if (lab.length > 1) return { text: `${lab.length} ranges`, title: `The labs print different ranges: ${lab.map((r) => `${r.shown}${r.lab ? ` (${r.lab})` : ''}`).join(', ')}. Each value is judged by its own.` };
  return null;
}

/** A point that counts as a reading: not set aside, not replaced, not one that disagrees with a record. */
function counts(p: OrganisedPoint): boolean {
  return !isSetAside(p) && p.trust?.trust !== 'replaced' && p.trust?.trust !== 'inaccurate';
}

/**
 * A test's readings in words: how many (copies folded), how many were outside the range printed with them, how many
 * disagree with a clinical record. `_range` is ignored (kept for older callers): each reading is judged by its own.
 */
export function analyteReadings(a: Pick<OrganisedAnalyte, 'series' | 'refLow' | 'refHigh' | 'refText' | 'unit'>, _range?: TestRange | null): { count: number; countWords: string; out: string | null; outCount: number; disagree: number } {
  const kept = (Array.isArray(a.series) ? a.series : []).filter(counts);
  const rs = readings(kept);
  const marks = rs.map((r) => rangeMark(r.rows[0]));
  const s = readingSummary(rs.length, marks);
  return { count: rs.length, countWords: s.count, out: s.out, outCount: s.outCount, disagree: inaccurateCount(a) };
}

/** Where a test's ranges are read from: the range fields of a test summary (every range printed, `ranges`). */
export type TestRangeSource = Pick<OrganisedAnalyte, 'refLow' | 'refHigh' | 'refText' | 'unit'> & Partial<Pick<OrganisedAnalyte, 'ranges' | 'units'>>;

/**
 * The fields a test's normal range is read from: the unfiltered summary's when given (`ranges`, by
 * `analyteKey::specimen`), else the row's own. A filter narrows the row to the values it matched; the range stays.
 */
export function rangeSourceOf(a: OrganisedAnalyte, ranges?: ReadonlyMap<string, TestRangeSource>): TestRangeSource {
  return ranges?.get(analyteRowId(a)) ?? a;
}

/** The raw specimen folded into the taxonomy bucket of its group; shown only when the two differ (plasma, whole blood under Serum). */
const BUCKET_OF: Record<string, string> = { serum: 'serum', plasma: 'serum', whole_blood: 'serum', csf: 'csf', urine: 'urine' };

export interface LabPanelsProps {
  specimens: OrganisedSpecimen[];
  selectedId: string | null;
  onSelect: (a: OrganisedAnalyte | null) => void;
  onOpen: (a: OrganisedAnalyte) => void;
  emptyText: string;
  footer?: ReactNode;
  /**
   * Each test's range fields by `analyteKey::specimen`, from the unfiltered summaries (routes/labs.tsx), so a Find or
   * a date filter never drops a test's normal range, its "high" or its readings' marks.
   */
  ranges?: ReadonlyMap<string, TestRangeSource>;
}

const READINGS_TITLE = 'Each measurement counted once, however many documents repeat it; then how many were outside the normal range, and how many disagree with a clinical record.';

export function LabPanels({ specimens, selectedId, onSelect, onOpen, emptyText, footer, ranges }: LabPanelsProps) {
  const groups = useMemo<GroupedListGroup<OrganisedAnalyte>[]>(
    () =>
      specimens.map((s) => ({
        key: s.specimen,
        header: s.label,
        rule: s.specimen === 'csf',
        subgroups: s.panels.map((p) => ({ key: `${s.specimen}|${p.panel}`, header: p.panel, rows: p.analytes })),
      })),
    [specimens],
  );

  const columns = useMemo<GroupedListColumn<OrganisedAnalyte>[]>(
    () => [
      {
        id: 'analyte',
        header: 'Test',
        grow: true,
        minWidth: 180,
        cell: (a) => (
          <>
            {a.analyte}
            {BUCKET_OF[a.specimen] && BUCKET_OF[a.specimen] !== a.specimen ? <span className="muted small"> ({specimenLabel(a.specimen)})</span> : null}
            <LineNote entry={analyteLineNote(a)} />
          </>
        ),
      },
      {
        id: 'latest',
        header: 'Latest',
        width: 128,
        maxWidth: 190,
        wrap: true,
        cell: (a) => {
          const last = a.series[a.series.length - 1];
          // The latest as the summary picks it (a lab report's first), marked by its own range only.
          const mark = latestMark(a);
          const unit = a.lastUnit !== undefined ? a.lastUnit : (last?.unit ?? a.unit);
          return (
            <span className="labs-value" title={a.lastNote ?? undefined}>
              {/* Computed by the user (2026-10-09): an open square, as on the chart; never red. */}
              {a.lastRole === 'computed' ? <span className="computed-square" aria-label="computed" /> : null}
              <span className="mono">{a.lastValue ? <Breakable text={a.lastValue} /> : '—'}</span>
              {unit ? <span className="labs-unit"> {unit}</span> : null}
              {mark ? (
                <>
                  {' '}
                  <RangeTag mark={mark} />
                </>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'ref',
        header: 'Normal range',
        width: 112,
        maxWidth: 140,
        cell: (a) => {
          // The latest value as the summary picks it (a lab report's first), so the hover never lends it another lab's range.
          const latest = [...a.series].reverse().find((p) => p.reading && p.date === a.lastDate && p.reading.valueShown === a.lastValue && p.reading.role !== 'claimed')?.reading ?? null;
          const c = rangeCell(rangeSourceOf(a, ranges), latest) ?? rangeCell(a, latest);
          return c ? (
            <span className="mono muted" title={c.title}>
              {c.text}
            </span>
          ) : null;
        },
      },
      { id: 'date', header: 'Date', width: 96, cell: (a) => <DateText iso={a.lastDate} precision={a.lastDatePrecision} /> },
      {
        id: 'readings',
        header: <span title={READINGS_TITLE}>Readings</span>,
        width: 96,
        maxWidth: 180,
        cell: (a) => {
          const r = analyteReadings(a);
          return (
            <span title={`${r.countWords}${r.out ? `, ${r.out}` : ''}${r.disagree ? `; ${r.disagree} value${r.disagree === 1 ? '' : 's'} disagree${r.disagree === 1 ? 's' : ''} with a clinical record` : ''}. ${a.count} value${a.count === 1 ? '' : 's'} in all, copies included.`}>
              <span className="mono">{r.count}</span>
              {r.out ? <span className="labs-out"> · {r.out}</span> : null}
              {r.disagree ? <span className="rc-bad"> · {r.disagree} disagree{r.disagree === 1 ? 's' : ''}</span> : null}
            </span>
          );
        },
      },
    ],
    [ranges],
  );

  return (
    <GroupedList
      groups={groups}
      columns={columns}
      rowId={analyteRowId}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      storageKey="labs.panels"
      emptyText={emptyText}
      footer={footer}
      rowNoun="test"
      rowClassName={(a) => (inaccurateCount(a) > 0 ? 'inaccurate-row' : undefined)}
      autoFocus
    />
  );
}
