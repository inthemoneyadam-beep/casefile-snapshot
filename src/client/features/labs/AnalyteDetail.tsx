/**
 * One test, in the right pane of By test (routes/labs.tsx), in the order a
 * reader needs it:
 *
 *   header    the sample, the test's name, one status line ("5 readings · 6
 *             copies in other documents · all above the normal range"), the
 *             actions that matter (Show every value, Overlay medications; the
 *             rest under More) and the key facts (latest value, when, the
 *             normal range, first date, how many documents)
 *   Trend     the chart: red diamonds are outside the normal range whether or
 *             not the report flagged them, a ring means the report flagged it,
 *             and a date two documents disagree about forks instead of jumping
 *   Readings  each reading once (copies in other documents fold into it, "and
 *             3 more"), its range mark, and where it came from: the document's
 *             name (two lines before "…"), under it the check tag, the page and
 *             the document's date when it is not the reading's own
 *
 * One word for one count: a "reading" is one measurement, however many
 * documents repeat it (the copies); the chart's header counts the readings it
 * draws. A test whose results are all words has no chart: its readings are a
 * dated list. Fewer than two readings to draw (one number, the rest limits
 * such as "<2" or words) is no chart either, with a plain note saying why and
 * what the limits mean. Never the test's internal key.
 *
 * Lab values as printed (2026-10): each reading is judged only against the range
 * printed with it (rule 8), never the test's or another lab's; a reading that
 * printed none is never marked. The key facts list every range the test's
 * readings printed, each with its lab and how many readings printed it, whatever
 * the list's filters (`range`, the unfiltered summary's); a summary's own range
 * is listed last as that document's. Mixed units are said ("In mg/dL and g/dL.
 * Each reading keeps its own unit."), never one unit over all. The latest value
 * is a lab report's (a summary's only when the test has nothing else, and said
 * so). On the chart the band is the one range the readings in view printed
 * (none when they print different ones: the note says which), and values
 * stated in summaries or notes are open circles, apart from the line.
 *
 * Computed values (2026-10-09): a value the patient computed from printed values (an albumin index) is an open square on the
 * same line as the lab's printed values of that index, never red; its From says "Computed by you from p.2 and p.3"
 * with each page; the lab's own printed value of the same collection is named under it. A test with computed values
 * shows "Your range": the range the patient types, dashed on the chart and labelled as his.
 */
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ChartSpec } from '@shared/chart';
import type { Trust } from '@shared/reconcile';
import { analyteLabel, type AnalyteMatch } from '@shared/analytes';
import { DateText, KeepDatesWhole } from '../../ui/DateText';
import { DetailHeader, DetailPane } from '../../ui/DetailPane';
import { Loading, Section } from '../../ui/PageHeader';
import { LineChart } from '../charts/LineChart';
import { bandWords, pointMark } from '../charts/range';
import { stackedChartAlign } from '../charts/lanes';
import { displayRef, isSetAside, labRowClass, useLabDocuments, useLabSeries, type AnalyteRange, type AnalyteSummary, type LabSeriesRow } from '../../api/labs';
import { CombinedTag, RangeTag, ResultMarkTag, SourceTag, SpecimenTag } from './tags';
import { COMBINED_LABEL, COMBINED_TITLE, fromLineTitle, fromLineWords, isCombined, unitCharts, withTestBand, type BandReading } from './parts';
import { disagreeingDates, inOwnRange, rangeMark, readings, readingSummary, type Reading, type TestRange } from './range';
import { UNDRAWABLE_NOTE, drawnPointCount, fewPointsNote, hasNumericPoint, isWordResult, noChartNote, notDrawnNote, resultMark, trendShape } from './words';
import { sourceDateDiffers, sourceLine, sourceWords } from './source';
import { dateLabel, rangeUnitSuffix, readingOf } from './reading';
import { testRangeOf } from './LabPanels';
import { TypedRangeEditor } from './TypedRange';
import type { ComputedView } from '@shared/labcompute';
import '../reconcile/reconcile.css';

export interface AnalyteDetailProps {
  analyteKey: string;
  specimen: string;
  summary: AnalyteSummary | null;
  /**
   * The test's ranges whatever the list's filters (the unfiltered summary's): a Find or a date filter narrows the
   * summary to the values it matched, but the key facts still list every range the test's readings printed, each with
   * its lab (amendment D3). Never used to judge a reading.
   */
  range?: RangeSource | null;
  from?: string;
  to?: string;
  overlay: boolean;
  busy?: boolean;
  onToggleOverlay: () => void;
  onNewResult: () => void;
  onShowResults: () => void;
  onImportAll: () => void;
}

/** Parse the server-built href ("/documents/<id>?page=<n>") for navigation. */
export function parseDocumentHref(href: string | null | undefined): { id: string; page?: number } | null {
  if (!href) return null;
  const m = href.match(/^\/documents\/([^?#]+)(?:\?page=(\d+))?/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), page: m[2] ? Number(m[2]) : undefined };
}

/**
 * The page a value was read from. `short`: the page alone ("p.1", a chip); `plain`: the document's name and page as a
 * plain link in a table or a key fact ("Lab report, 2024-09-17, p.1"); otherwise the chip with the name.
 */
export function SourceLink({ row, short, plain }: { row: Pick<LabSeriesRow, 'documentId' | 'documentTitle' | 'pageNumber' | 'citationId' | 'citationVerified'>; short?: boolean; plain?: boolean }) {
  if (!row.documentId) return <span className="muted">entered by hand</span>;
  const label = short ? `p.${row.pageNumber ?? '?'}` : plain ? `${row.documentTitle ?? 'Document'}${row.pageNumber ? `, p.${row.pageNumber}` : ''}` : `${row.documentTitle ?? 'document'}${row.pageNumber ? ` · p.${row.pageNumber}` : ''}`;
  return (
    <Link
      to="/documents/$id"
      params={{ id: row.documentId }}
      search={{ page: row.pageNumber ?? undefined, cite: row.citationId ?? undefined }}
      className={plain ? `labs-source${row.citationVerified === false ? ' unverified' : ''}` : `cite${row.citationVerified === false ? ' unverified' : ''}`}
      title={row.documentTitle ? `${row.documentTitle}${row.pageNumber ? `, page ${row.pageNumber}` : ''}${row.citationVerified === false ? ' (quote not found in the page text)' : ''}` : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </Link>
  );
}

/**
 * Where a value came from, for a table cell, so the part that tells two reports apart is never the part cut off.
 * In a list (All values): the document's date first, then its name without that date repeated, then the page, as one
 * link that wraps ("2024-09-17 · Lab report, p.1"). With `pageBelow` (a test's readings, whose Date column already
 * gives the reading's date): the document's name as the link, wrapping to two lines before it ends with "…"; under
 * it one small line with the check tag (`check`), the page, the document's date only when it differs from the
 * reading's (`rowDate`), and `sub` ("from one line · and 3 more"). The full words on hover. `documentDate` is the
 * document's own date, for a name that does not end with one.
 */
export function SourceCell({ row, documentDate, sub, pageBelow, check, rowDate }: { row: Pick<LabSeriesRow, 'documentId' | 'documentTitle' | 'pageNumber' | 'citationId' | 'citationVerified'> & { computed?: ComputedView | null }; documentDate?: string | null; sub?: ReactNode; pageBelow?: boolean; check?: ReactNode; rowDate?: string | null }) {
  // A value the patient computed (2026-10-09): who computed it and each input's page, never "entered by hand".
  if (row.computed) return <ComputedFrom computed={row.computed} check={pageBelow ? check : null} />;
  if (!row.documentId) {
    if (!pageBelow || !check) return <span className="muted">entered by hand</span>;
    return (
      <span className="labs-from labs-from-stack">
        <span className="muted">entered by hand</span>
        <SubLine items={[check]} />
      </span>
    );
  }
  const w = sourceWords(row.documentTitle, documentDate);
  const page = row.pageNumber ? `p.${row.pageNumber}` : null;
  const full = `${sourceLine(row.documentTitle, documentDate, row.pageNumber)}${row.citationVerified === false ? ' (quote not found in the page text)' : ''}`;
  const link = (children: ReactNode) => (
    <Link
      to="/documents/$id"
      params={{ id: row.documentId! }}
      search={{ page: row.pageNumber ?? undefined, cite: row.citationId ?? undefined }}
      className={`labs-source${row.citationVerified === false ? ' unverified' : ''}`}
      title={full}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
  if (pageBelow) {
    // The name takes the first two lines; the small line under it holds the check, the page, the document's date
    // when it is not the reading's own, and the copies.
    const dated = w.date && sourceDateDiffers(w.date, rowDate) ? (
      <span className="labs-from-date" title={`The document's date${rowDate ? `; the reading is from ${rowDate}` : ''}`}>
        dated {w.date}
      </span>
    ) : null;
    return (
      <span className="labs-from labs-from-stack">
        {link(<KeepDatesWhole text={w.name} />)}
        <SubLine items={[check ?? null, page ? <span className="labs-from-page">{page}</span> : null, dated, ...(Array.isArray(sub) ? sub : [sub ?? null])]} />
      </span>
    );
  }
  return (
    <span className="labs-from">
      {link(
        <>
          {w.date ? (
            <>
              <span className="labs-from-date">{w.date}</span>
              {' · '}
            </>
          ) : null}
          <KeepDatesWhole text={w.name} />
          {page ? `, ${page}` : ''}
        </>,
      )}
      {sub ? <span className="labs-from-sub">{sub}</span> : null}
    </span>
  );
}

/** Where a test's ranges are read from: a test summary's range fields (every range printed, `ranges`, since 2026-10). */
export type RangeSource = Pick<AnalyteSummary, 'refLow' | 'refHigh' | 'refText' | 'unit'> & Partial<Pick<AnalyteSummary, 'ranges' | 'units'>>;

/**
 * The test's one range, when it has one: the unfiltered one (`range`), else the summary's, else the chart's band. Said
 * in the key facts only; a reading is judged by its own range, never by this.
 */
export function rangeOf(summary: RangeSource | null, chart: ChartSpec | null, range?: RangeSource | null): TestRange | null {
  const own = range ? testRangeOf(range) : null;
  if (own) return own;
  if (summary) return testRangeOf(summary);
  const b = chart?.referenceBand;
  if (b && (b.low != null || b.high != null)) return { low: b.low, high: b.high, unit: chart?.yLabel ?? null };
  return null;
}

/** A value that counts as a reading of the test: not set aside, replaced, or disagreeing with a record. */
const kept = (r: LabSeriesRow) => !isSetAside(r) && r.trust?.trust !== 'replaced' && r.trust?.trust !== 'inaccurate';

/** A summary's or a note's value (its claim): never the latest when a lab report gives one (amendment D4). */
const claimed = (r: LabSeriesRow) => readingOf(r).role === 'claimed';

/**
 * A test asked for by a name that is not on file (an old link from before hs-CRP was listed apart from CRP): the
 * server's answer, its reason and the similar tests on file (rule 9), said instead of an empty test. Null otherwise.
 */
export function unmatchedTest(data: { rows?: readonly unknown[]; match?: AnalyteMatch } | undefined, pending: boolean): Exclude<AnalyteMatch, { status: 'exact' }> | null {
  const m = data?.match;
  if (pending || !m || m.status === 'exact' || (data?.rows?.length ?? 0) > 0) return null;
  return m;
}

/** "15–45 mg/dL · Anvale · 3 readings"; a summary's own: "0–35 mg/dL · stated in Dossier (not the lab's)". */
/**
 * The values' unit after a range, only when the range is read as numbers and prints no unit of its own: a range
 * printed in its own unit ("0.15-0.45 g/L") is never relabelled with the values' (rule 5), and a range kept as printed
 * ("see comment") or in words gets none.
 */
export function rangeLineUnit(r: Pick<AnalyteRange, 'shown' | 'unit' | 'rangeUnit' | 'asNumbers'>): string {
  if (!r.unit || r.rangeUnit || r.asNumbers === false || /^"/.test(r.shown.trim())) return '';
  return r.shown.toLowerCase().includes(r.unit.toLowerCase()) ? '' : ` ${r.unit}`;
}

export function rangeLine(r: AnalyteRange): string {
  const unit = rangeLineUnit(r);
  if (r.role === 'claimed') return `${r.shown}${unit} · stated in ${r.documentTitle ?? 'a summary'} (not the lab's)`;
  const who = r.role === 'typed' ? 'entered by hand' : (r.lab ?? 'lab not named');
  return `${r.shown}${unit} · ${who} · ${r.count} reading${r.count === 1 ? '' : 's'}`;
}

/**
 * "In mg/dL and g/dL. Each reading keeps its own unit." for a test whose readings come in several units (rule 5);
 * values printed with no unit are said last ("In mg/dL, and some with no unit printed.").
 */
export function unitsWords(units: readonly string[]): string | null {
  if (units.length < 2) return null;
  const named = units.filter(Boolean);
  const list = named.length <= 2 ? named.join(' and ') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  const none = units.includes('') ? `${named.length ? ', and some' : 'Some'} with no unit printed` : '';
  return `${named.length ? `In ${list}` : ''}${none}. Each reading keeps its own unit.`;
}

/**
 * The ranges to list in the test's key facts: the lab reports' each with its lab (as the summaries give them), then a
 * summary's own ranges, one line per range however many summaries state it ("stated in 3 summaries or notes").
 */
export function rangeLines(ranges: readonly AnalyteRange[]): Array<{ key: string; text: string; claim: boolean; title?: string }> {
  const out: Array<{ key: string; text: string; claim: boolean; title?: string }> = [];
  const claims = new Map<string, AnalyteRange[]>();
  for (const r of ranges) {
    if (r.role !== 'claimed') {
      out.push({ key: `${r.role}|${r.shown}|${r.lab ?? ''}|${r.unit ?? ''}`, text: rangeLine(r), claim: false });
      continue;
    }
    const k = `${r.shown}|${r.unit ?? ''}`;
    claims.set(k, [...(claims.get(k) ?? []), r]);
  }
  for (const [k, list] of claims) {
    if (list.length === 1) {
      out.push({ key: `c|${k}`, text: rangeLine(list[0]), claim: true });
      continue;
    }
    const r = list[0];
    const unit = rangeLineUnit(r);
    out.push({ key: `c|${k}`, text: `${r.shown}${unit} · stated in ${list.length} summaries or notes (not the lab's)`, claim: true, title: list.map((x) => x.documentTitle ?? 'a summary').join('\n') });
  }
  return out;
}

/**
 * What the readings' own ranges say, counting only what was judged (rule 8): "all above the normal range", "2 above
 * the normal range, 1 below", "all within the normal range", "3 within the normal range; 2 printed no range of their
 * own". A reading that printed no range, a result in words ("Positive") or a limit that cannot be judged is never called
 * within; nothing is said when no reading was judged. With several printed ranges, "the range printed with them".
 * `counts`: readings marked out, judged within, with no range of their own; `n` readings in all.
 */
export function rangeStatus(outWords: string | null, counts: { out: number; within: number; noRange: number }, n: number, severalRanges = false): string | null {
  if (!n) return null;
  const { out, within, noRange } = counts;
  const notJudged = Math.max(0, n - out - within - noRange);
  const range = (k: number) => (severalRanges ? `the range printed with ${k === 1 ? 'it' : 'them'}` : 'the normal range');
  const tail = [noRange ? `${noRange} printed no range of ${noRange === 1 ? 'its' : 'their'} own` : null, notJudged ? `${notJudged} not judged` : null].filter(Boolean).join('; ');
  const withTail = (s: string) => (tail ? `${s}; ${tail}` : s);
  if (!out) {
    if (!within) return null;
    if (within === n) return n > 1 ? `all within ${range(n)}` : `within ${range(1)}`;
    return withTail(`${within} within ${range(within)}`);
  }
  if (out === n && outWords === 'all high') return `all above ${range(n)}`;
  if (out === n && outWords === 'all low') return `all below ${range(n)}`;
  if (out === n && outWords === 'all out of range') return `all outside ${range(n)}`;
  const words = `${outWords?.replace(/(\d+) high/, '$1 above').replace(/(\d+) low/, '$1 below')} ${range(out)}`;
  return withTail(within ? `${words}, ${within} within` : words);
}

export function AnalyteDetail({ analyteKey, specimen, summary, range, from, to, overlay, busy, onToggleOverlay, onNewResult, onShowResults, onImportAll }: AnalyteDetailProps) {
  const series = useLabSeries({ analyteKey, specimen: specimen || undefined, from, to, overlay });
  // Each document's own date, for a reading's From when the document's name does not end with one.
  const documents = useLabDocuments();
  const documentDates = useMemo(() => new Map((documents.data ?? []).map((d) => [d.id, d.documentDate] as const)), [documents.data]);
  const rows = series.data?.rows ?? [];
  const chart = series.data?.chart ?? null;
  // No chart without a number to draw: a test whose results are all words is a dated list; a test with numbers and
  // words draws the numbers and lists every result under the chart.
  const shape = trendShape({ wordOnly: series.data?.wordOnly, chart, rows });
  // One point makes no line: with fewer than two readings to draw (the others limits such as "<2", or words) there is
  // no chart, only a note that says so and what the limits mean.
  const drawn = drawnPointCount(chart);
  // Readings in several units are one chart per unit (never one axis): a unit with fewer than two readings to draw
  // makes no chart of its own, and when no unit has two there is no chart at all (one point makes no line).
  const perUnit = chart ? unitCharts(chart).map((c) => drawnPointCount(c.spec)) : [];
  const unitsTooFew = perUnit.length > 1 && perUnit.every((n) => n < 2);
  const few = (shape === 'numbers' || shape === 'mixed') && (drawn < 2 || unitsTooFew);
  const noChart = shape === 'words' || shape === 'undrawable' || few;
  const label = summary?.analyte ?? rows[0]?.analyte ?? (chart?.title ? chart.title.split(' — ')[0] : 'This test');
  // A link to a test that is not on file under that name (an old bookmark from before hs-CRP was listed apart from CRP):
  // the server's reason, with the similar tests on file, instead of an empty test.
  const unmatched = unmatchedTest(series.data, series.isPending);
  // Every range the test's readings printed, from the unfiltered summary first (a filter never hides them), each with
  // its lab; an older summary gives one range (refText or its numbers).
  const ranges: AnalyteRange[] | null = range?.ranges ?? summary?.ranges ?? null;
  const ref = (range ? displayRef(range) : null) ?? (summary ? displayRef(summary) : null);
  const navigate = useNavigate();
  const test = rangeOf(summary, chart, range);
  const inaccurate = rows.filter((r) => r.trust?.trust === 'inaccurate').length;
  // Tests read out of a line of several are not on the Reconciliation page's list: each shows what the record says on its own row.
  const inaccurateListed = rows.filter((r) => r.trust?.trust === 'inaccurate' && !r.splitFrom).length;
  // Every unit as printed ('' for "no unit printed"), the readings' own or the summary's.
  const rowUnits = [...new Set(rows.map((r) => (r.unit ?? '').trim()))];
  const units = rows.length ? (rowUnits.length > 1 || rowUnits[0] ? rowUnits : []) : (range?.units ?? summary?.units ?? []);
  const combined = isCombined(summary) || rows.some((r) => isCombined(r));
  const keptRows = rows.filter(kept);
  const rs = readings(keptRows);
  // Each reading by its own range (rule 8); a summary's claim is never marked.
  const marks = rs.map((r) => rangeMark(r.rows[0]));
  const sum = readingSummary(rs.length, marks);
  // The latest is a lab report's (or yours); a summary's only when the test has nothing else (amendment D4).
  const own = keptRows.filter((r) => !claimed(r));
  const latest = own[own.length - 1] ?? keptRows[keptRows.length - 1] ?? rows[rows.length - 1] ?? null;
  const latestClaim = latest && claimed(latest) ? `from ${latest.documentTitle ?? 'a summary'} (a summary)` : latest?.computed ? latest.computed.record.label : null;
  // First and Documents from the readings this pane lists (oldest first), so a Find in the list, which narrows the
  // summary to the values it matched, never contradicts them; the summary's until the readings load.
  const first = keptRows[0] ?? rows[0] ?? null;
  const documentCount = rows.length ? new Set(rows.map((r) => r.documentId).filter(Boolean)).size : (summary?.documentCount ?? null);
  const latestMark = latest ? rangeMark(latest) : null;
  // Only what was judged is said (rule 8): a word result ("Positive") or a reading with no range of its own is never "within".
  const status = rangeStatus(
    sum.out,
    {
      out: sum.outCount,
      within: rs.filter((r) => inOwnRange(r.rows[0])).length,
      noRange: rs.filter((r) => !claimed(r.rows[0]) && !r.rows[0].computed && readingOf(r.rows[0]).rangeStatus === 'none').length,
    },
    rs.length,
    new Set(rs.map((r) => readingOf(r.rows[0])).filter((v) => v.role !== 'claimed' && v.rangeStatus === 'parsed').map((v) => `${v.rangeLow ?? ''}|${v.rangeLowComparator ?? ''}|${v.rangeHigh ?? ''}|${v.rangeHighComparator ?? ''}|${v.rangeUnitKey ?? ''}|${v.rangeKind === 'text' ? v.rangeShown : ''}`)).size > 1,
  );
  // The same measurement repeated in other documents: "copies", never a second count of "values" or "results".
  const copies = keptRows.length - rs.length;
  // One row per reading (its copies left out), for the notes that count readings.
  const readingRows = rs.map((r) => r.rows[0]);
  const unitWord = units.length > 1 ? null : (summary?.unit ?? test?.unit ?? units[0] ?? null);
  const latestKind = latest ? readingOf(latest).dateKind : null;
  /** One value in the All values view, selected (where its check is shown); the list narrowed to this test as Show every value does. */
  const valueSearch = (r: LabSeriesRow) => ({ view: 'results' as const, id: r.id, analyteKey, specimen: specimen || undefined, from, to });
  const openValue = (r: LabSeriesRow) => void navigate({ to: '/labs', search: valueSearch(r) });

  return (
    <DetailPane label="Test details" className="labs-detail">
      <DetailHeader
        eyebrow={
          <>
            <SpecimenTag specimen={specimen || summary?.specimen} />
            <span>Lab test</span>
            {combined ? <CombinedTag /> : null}
          </>
        }
        title={label}
        status={
          series.isPending && !rows.length
            ? [<span key="loading">Loading the readings…</span>]
            : [
                <span key="n">{rs.length ? sum.count : `${rows.length} reading${rows.length === 1 ? '' : 's'}`}</span>,
                rs.length && copies > 0 ? (
                  <span key="copies" className="muted" title="The same measurement repeated in other documents (a summary, a letter) is counted once">
                    {copies} cop{copies === 1 ? 'y' : 'ies'} in other documents
                  </span>
                ) : null,
                status ? (
                  <span key="range" className={sum.outCount ? 'labs-out' : undefined}>
                    {status}
                  </span>
                ) : null,
                inaccurateListed ? (
                  <Link key="wrong" to="/reconcile" search={{ tab: 'inaccurate', q: label }} className="rc-bad" title="Readings of this test that disagree with a clinical record; see them beside what the record says">
                    {inaccurateListed} disagree{inaccurateListed === 1 ? 's' : ''} with a clinical record
                  </Link>
                ) : null,
                inaccurate > inaccurateListed ? (
                  <span key="wrong-lines" className="rc-bad" title="Read out of a line that held several tests; each row below says what the clinical record says">
                    {inaccurate - inaccurateListed} in combined lines disagree{inaccurate - inaccurateListed === 1 ? 's' : ''} with a record
                  </span>
                ) : null,
              ]
        }
        actions={{
          primary: { label: 'Show every value', onClick: onShowResults, shortcut: 'enter', title: 'Every value of this test, copies included, in the All values list' },
          secondary: [noChart ? null : { label: overlay ? 'Hide medications' : 'Overlay medications', onClick: onToggleOverlay, shortcut: 'm', title: 'Show (or hide) your medication courses under the chart' }],
          more: [
            { label: 'Add a value for this test', onClick: onNewResult, shortcut: 'n' },
            summary?.factOnlyCount
              ? { label: "Copy Claude's values into my lab list", onClick: onImportAll, shortcut: 'f', disabled: busy, title: 'Values Claude read from your documents are shown here already. Copying them into your own lab list lets you edit them.' }
              : null,
            inaccurateListed ? { label: 'Open the disagreements in Reconciliation', onClick: () => void navigate({ to: '/reconcile', search: { tab: 'inaccurate', q: label } }) } : null,
          ],
        }}
        facts={[
          latest ? { label: 'Latest', value: <LatestValue row={latest} mark={latestMark} note={latestClaim} /> } : null,
          latest ? { label: dateLabel(latestKind), value: <DateText iso={latest.date} precision={latest.datePrecision} text={latest.dateText} /> } : null,
          // A test whose results are words shows its printed ranges too ("Negative", "<1:40" kept as printed); with none,
          // nothing is said for it (a word result is never judged).
          shape === 'words' && !(ranges && ranges.length)
            ? null
            : ranges && ranges.length
              ? {
                  label: ranges.length > 1 ? 'Normal ranges as printed' : 'Normal range',
                  wide: ranges.length > 1,
                  title: 'Each range as printed, with the lab that printed it. A reading is judged only against the range printed with it.',
                  value: (
                    <span className="labs-ranges">
                      {rangeLines(ranges).map((r) => (
                        <span key={r.key} className={r.claim ? 'labs-range-claim' : 'mono'} title={r.title}>
                          {r.text}
                        </span>
                      ))}
                    </span>
                  ),
                }
              : ref || test
                ? { label: 'Normal range', value: `${ref ?? bandWords({ low: test?.low ?? null, high: test?.high ?? null }).replace(/^Normal range:? /, '')}${unitWord && !(ref ?? '').includes(unitWord) ? ` ${unitWord}` : ''}`, mono: true }
                : { label: 'Normal range', value: <span className="muted">{rows.length ? 'not given on the reports' : 'no readings'}</span> },
          first?.date && first.date !== latest?.date ? { label: 'First', value: <DateText iso={first.date} precision={first.datePrecision} text={first.dateText} /> } : !first && summary?.firstDate && summary.firstDate !== latest?.date ? { label: 'First', value: <DateText iso={summary.firstDate} /> } : null,
          documentCount != null ? { label: 'Documents', value: String(documentCount), mono: true } : null,
          units.length > 1 ? { label: 'Units', value: unitsWords(units), wide: true, title: 'The values come in more than one unit; each unit has its own chart, and nothing is converted or relabelled.' } : null,
        ]}
      />

      {unmatched ? (
        <div className="notice small labs-unmatched" role="note">
          {unmatched.reason}
          {unmatched.candidates.length ? (
            <span className="row wrap">
              {unmatched.candidates.map((k) => (
                <Link key={k} to="/labs" search={{ view: 'panels', id: `${k}::${specimen || summary?.specimen || ''}` }} className="labs-source">
                  {analyteLabel(k)}
                </Link>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {shape === 'words' ? (
        <Section title="Readings" count={rs.length || rows.length}>
          <p className="section-intro labs-nochart">{noChartNote(rows)}</p>
          <WordResults rows={rows} onOpen={openValue} linkSearch={valueSearch} documentDates={documentDates} />
        </Section>
      ) : (
        <>
          <Section title="Trend">
            {series.isPending ? (
              <Loading>Loading the trend…</Loading>
            ) : series.isError ? (
              <div className="notice bad small">{series.error instanceof Error ? series.error.message : 'Could not load the values.'}</div>
            ) : few ? (
              <p className="section-intro labs-nochart">
                {unitsTooFew && drawn >= 2
                  ? `No chart: the readings come in ${perUnit.length} units and no unit has two readings to draw (one point makes no line; nothing is converted). Every reading is listed below.`
                  : fewPointsNote(drawn, readingRows.length ? readingRows : rows)}
              </p>
            ) : chart && (shape === 'numbers' || shape === 'mixed') ? (
              <>
                <UnitCharts chart={chart} inView={rows} disagree={disagreeingDates(keptRows)} />
                {notDrawnNote(readingRows.length ? readingRows : rows) ? <p className="labs-chart-note">{notDrawnNote(readingRows.length ? readingRows : rows)}</p> : null}
              </>
            ) : shape === 'undrawable' ? (
              <div className="stack tight">
                <p className="section-intro labs-nochart">{UNDRAWABLE_NOTE}</p>
                {chart?.note ? <p className="labs-chart-note">{chart.note}</p> : null}
              </div>
            ) : (
              <p className="section-intro">Nothing to draw in these dates.</p>
            )}
          </Section>

          {rows.some((r) => r.computed) ? (
            <Section title="Your range" intro="For the values you compute: drawn dashed on the chart and labelled as yours. It never makes a value red.">
              <TypedRangeEditor analyteKey={analyteKey} />
            </Section>
          ) : null}
          <Section title="Readings" count={rs.length || rows.length} intro={rows.length ? 'Each reading once, newest first. Click one to see where it came from and how it was checked.' : undefined}>
            {rows.length ? <AnalyteValues rows={rows} onOpen={openValue} linkSearch={valueSearch} documentDates={documentDates} /> : <p className="section-intro">{series.isPending ? '' : 'No readings in these dates.'}</p>}
          </Section>
        </>
      )}
    </DetailPane>
  );
}

function LatestValue({ row, mark, note }: { row: LabSeriesRow; mark: ReturnType<typeof rangeMark>; note?: string | null }) {
  const value = (
    <span className="labs-value">
      {readingOf(row).valueShown || row.value || '—'}
      {row.unit ? <span className="labs-unit"> {row.unit}</span> : null}
      {mark ? (
        <>
          {' '}
          <RangeTag mark={mark} />
        </>
      ) : null}
    </span>
  );
  if (!note) return value;
  return (
    <span className="labs-fact">
      {value}
      <span className="labs-fact-note">{note}</span>
    </span>
  );
}

/**
 * What the chart shows, said exactly: the band (the one range the readings in view printed), red (outside the range
 * printed with that reading, or flagged by the report), the ring, open circles (values stated in summaries or notes),
 * the line, and a date with two values. Only what the chart has.
 */
export function chartKey(spec: ChartSpec, disagree: Array<{ date: string; values: string[]; sameDocument?: boolean }> = []): string {
  const band = spec.referenceBand && (spec.referenceBand.low != null || spec.referenceBand.high != null) ? spec.referenceBand : null;
  const ownFlags = spec.source === 'db';
  const pts = spec.series.flatMap((s) => s.points).filter((p) => p.y != null);
  const marks = pts.map((p) => pointMark(p, band, ownFlags));
  const red = marks.some((m) => m.out);
  const flagged = marks.some((m) => m.flagged);
  const hollow = spec.series.some((s) => s.kind === 'scatter' && s.points.some((p) => p.y != null));
  const parts: string[] = [];
  if (band) {
    const range = bandWords(band).replace(/^Normal range:? /, '');
    if (!ownFlags) parts.push(red ? `The shaded band is the normal range (${range}); red diamonds are outside it, whether or not the report flagged them.` : `The shaded band is the normal range (${range}); every point is inside it.`);
    else parts.push(`The shaded band is the normal range printed with these readings (${range}).${red ? ' Red diamonds are outside the range printed with them, or flagged by the report.' : ''}`);
  } else if (red) parts.push(ownFlags ? 'Red diamonds are outside the range printed with them, or flagged by the report; no single range is shaded.' : 'Red diamonds were flagged by the report; no normal range was given to shade.');
  if (flagged) parts.push('A ring means the report itself flagged the value.');
  if (hollow) parts.push('Open circles are values stated in summaries or notes, not lab reports; they are not joined into the line.');
  // Computed by the user (2026-10-09): open squares on the same line, never red; his own range dashed.
  if (pts.some((p) => p.marker === 'square')) parts.push('Open squares are values computed by you from printed values; they are never red and never judged by a range.');
  if (spec.typedRange && (spec.typedRange.low != null || spec.typedRange.high != null)) parts.push(`The dashed lines are the ${spec.typedRange.label}; it never makes a value red.`);
  parts.push('The line joins the readings in date order.');
  for (const d of disagree.slice(0, 2))
    parts.push(
      d.sameDocument
        ? `On ${d.date} one document gives two values (${d.values.join(' and ')}): dashed lines go to each; see What Claude noticed.`
        : `On ${d.date} your documents give different values (${d.values.join(' and ')}): dashed lines go to each; see Reconciliation.`,
    );
  parts.push('Click a point to open its page.');
  return parts.join(' ');
}

function openPoint(spec: ChartSpec) {
  return (si: number, pi: number) => {
    const t = parseDocumentHref(spec.series[si]?.points[pi]?.href);
    if (t) window.dispatchEvent(new CustomEvent('casefile:labs-open', { detail: t }));
  };
}

/**
 * The trend: one chart, or one chart per unit when the values come in several (each with its own scale and named by
 * its unit, so 17 cmH2O and 38 mmHg are never drawn on one axis). Stacked charts share one date range; medication
 * rows are drawn under the first, the others keep the faint start and stop lines.
 */
/**
 * The chart as the Labs page draws it: its header counts the readings it draws (copies are one point), never the
 * server's count of every copy; the server's "not plotted" words about results in words or limits are left out (the
 * page says those in plain words under the chart).
 */
export function labChartSpec(chart: ChartSpec): ChartSpec {
  const n = drawnPointCount(chart);
  const years = /·\s*(\d{4}(?:–\d{4})?)\s*$/.exec(chart.subtitle ?? '')?.[1] ?? null;
  const note = (chart.note ?? '')
    .split(' · ')
    .filter((part) => part.trim() && !/non-numeric|in words|limits? .*not drawn|not drawn: below or above/i.test(part))
    .join(' · ');
  return { ...chart, subtitle: `${n} reading${n === 1 ? '' : 's'} drawn${years ? ` · ${years}` : ''}`, note: note || null };
}

export function UnitCharts({ chart: raw, inView, initialWidth, disagree = [] }: { chart: ChartSpec; inView?: ReadonlyArray<BandReading> | null; initialWidth?: number; disagree?: Array<{ date: string; values: string[]; sameDocument?: boolean }> }) {
  // Never an empty chart: with no number to draw the caller lists the results instead.
  if (!hasNumericPoint(raw)) return null;
  // The band: the server's, else the one range the readings in view printed (never one from outside the view).
  const chart = labChartSpec(withTestBand(raw, inView));
  const charts = unitCharts(chart);
  if (charts.length <= 1) {
    return (
      <div className="labs-chart">
        <LineChart spec={chart} height={260} onPointClick={openPoint(chart)} initialWidth={initialWidth} hollowScatter />
        <p className="labs-chart-note">{chartKey(chart, disagree)}</p>
      </div>
    );
  }
  const align = stackedChartAlign(charts.map((c) => c.spec));
  return (
    <div className="labs-unit-charts">
      {charts.map((c, i) => (
        <div className="labs-chart" key={`${i}-${c.unit}`} data-unit={c.unitLabel}>
          <LineChart spec={c.spec} height={220} onPointClick={openPoint(c.spec)} bandMode={i === 0 ? 'lanes' : 'guides'} xRange={align.xRange} labelWidth={align.labelWidth} initialWidth={initialWidth} hollowScatter />
        </div>
      ))}
      <p className="labs-chart-note">
        The values come in {charts.length} units, so each unit has its own chart. Nothing is converted. {chartKey(chart, disagree)}
      </p>
    </div>
  );
}

/** "Computed by you from p.2 and p.3", each page a link to its input's page; under it the check tag. */
export function ComputedFrom({ computed: c, check }: { computed: ComputedView; check?: ReactNode }) {
  const r = c.record;
  const by = r.label.replace(/ from .*$/, '');
  const seen = new Set<string>();
  const pages = r.inputs.filter((i) => {
    const k = `${i.citation.documentId}|${i.citation.page}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <span className="labs-from labs-from-stack computed-from">
      <span title={r.inputs.map((i) => `${i.slotLabel}: ${i.citation.documentTitle ?? 'a document'}, p.${i.citation.page}`).join('\n')}>
        {by} from{' '}
        {pages.map((i, n) => (
          <span key={`${i.citation.documentId}-${i.citation.page}`}>
            {n ? (n === pages.length - 1 ? ' and ' : ', ') : ''}
            <Link to="/documents/$id" params={{ id: i.citation.documentId }} search={{ page: i.citation.page, cite: i.citation.citationId ?? undefined }} onClick={(e) => e.stopPropagation()}>
              p.{i.citation.page}
            </Link>
          </span>
        ))}
      </span>
      {check ? <SubLine items={[check]} /> : null}
    </span>
  );
}

/** The lab's own printed value of the same index and collection, under a computed one (D5). */
function PrintedBesideNote({ computed: c }: { computed: ComputedView | null | undefined }) {
  if (!c || !c.printed.length) return null;
  return (
    <>
      {c.printed.map((p) => (
        <span key={p.entryId} className="labs-own-ref" title={p.differs ? `Differs from ${p.computedAtPrecision} at the lab's precision; see What Claude noticed` : "Matches at the lab's precision"}>
          lab printed {p.valueShown}
          {p.unit ? ` ${p.unit}` : ''}
          {p.differs ? ' (differs)' : ''}
        </span>
      ))}
    </>
  );
}

/**
 * Most trusted first: the copy a folded reading shows (its document link and its check). Among records that agree,
 * the one the other copies were checked against (Reconciliation's "the record": the lab report before a clinic note
 * that repeats it), so both pages name the same document for a reading.
 */
const SHOW_ORDER: Record<Trust, number> = { verified: 0, accurate: 1, unbacked: 2, conflict: 3, replaced: 4, inaccurate: 5 };
export function shownCopy(r: Reading<LabSeriesRow>): LabSeriesRow {
  const named = new Set(r.rows.map((x) => x.trust?.recordFactId).filter(Boolean));
  const notNamed = (x: LabSeriesRow) => (x.factId && named.has(x.factId) ? 0 : 1);
  return [...r.rows].sort(
    (a, b) => Number(isSetAside(a)) - Number(isSetAside(b)) || (a.trust ? SHOW_ORDER[a.trust.trust] : 2.5) - (b.trust ? SHOW_ORDER[b.trust.trust] : 2.5) || notNamed(a) - notNamed(b),
  )[0];
}

/** "and 3 more", with every document and its check in the hover. */
function MoreCopies({ reading, shown }: { reading: Reading<LabSeriesRow>; shown: LabSeriesRow }) {
  const others = reading.rows.filter((r) => r !== shown);
  if (!others.length) return null;
  const wrong = others.filter((r) => r.trust?.trust === 'inaccurate').length;
  const title = `Also in:\n${others.map((r) => `${r.documentTitle ?? 'entered by hand'}${r.pageNumber ? `, p.${r.pageNumber}` : ''}${r.trust ? ` (${r.trust.trust === 'unbacked' ? 'not backed yet' : r.trust.trust})` : ''}`).join('\n')}`;
  return (
    <span className="labs-copies" title={title}>
      and {others.length} more{wrong ? <span className="rc-bad"> ({wrong} disagree{wrong === 1 ? 's' : ''})</span> : null}
    </span>
  );
}

/**
 * On the From cell's small line, after the check and the page: the line a part of the value came from ("from one
 * line", the whole line on hover), a line that names several tests ("one line, several tests"), and its copies
 * ("and 3 more"), each its own part of the muted line.
 */
function fromSubItems(reading: Reading<LabSeriesRow>, shown: LabSeriesRow): ReactNode[] {
  const parts: ReactNode[] = [];
  if (isCombined(shown))
    parts.push(
      <span key="combined" title={COMBINED_TITLE}>
        {COMBINED_LABEL}
      </span>,
    );
  if (fromLineWords(shown))
    parts.push(
      <span key="line" className="labs-fromline" title={fromLineTitle(shown)}>
        from one line
      </span>,
    );
  if (reading.rows.length > 1) parts.push(<MoreCopies key="more" reading={reading} shown={shown} />);
  return parts;
}

/** The From cell's small second line: its parts with "·" between them, never at the start of a wrapped line. */
function SubLine({ items }: { items: ReactNode[] }) {
  const shown = items.filter((x) => x != null && x !== false && x !== '');
  if (!shown.length) return null;
  return (
    <span className="labs-from-sub sep-list">
      <span className="sep-row">
        {shown.map((x, i) => (
          <span key={i} className="sep-item">
            {x}
          </span>
        ))}
      </span>
    </span>
  );
}

/** The From column's header: the document, and on the small line under it the check and the page. */
const FROM_TITLE = 'The document the reading came from; under it how it was checked against your clinical records, its page, and the document’s date when it is not the reading’s';

/**
 * Every reading of the test, newest first: one row per measurement (copies in other documents fold into it, "and 3
 * more"). Date and Value are as wide as their content (a long value wraps); From takes the rest of the room: the
 * document's name (two lines before "…", the whole name on hover), and under it one small line with the check tag,
 * the page, the document's date only when it is not the reading's own, "from one line" for one part of a line that
 * held several tests (the whole line on hover) and the copies. Each reading is marked by the range printed with it
 * (never the test's); when the readings print different ranges, each says its own under its value, with its lab; a
 * summary's own range says it is that document's. Clicking a row opens the value in All values.
 */
export function AnalyteValues<S>({ rows, onOpen, linkSearch, documentDates }: { rows: LabSeriesRow[]; test?: TestRange | null; onOpen: (r: LabSeriesRow) => void; linkSearch: (r: LabSeriesRow) => S; documentDates?: ReadonlyMap<string, string | null> }) {
  const rs = readings(rows);
  // The ranges the lab readings print: one is said in the key facts; several are said on each row.
  const labRanges = new Set(rows.map((r) => readingOf(r)).filter((v) => v.role !== 'claimed' && v.rangeShown).map((v) => `${v.rangeShown}|${v.labKey ?? ''}`));
  return (
    <table className="labs-results labs-values">
      <thead>
        <tr>
          <th className="labs-c-date">Date</th>
          <th className="labs-c-value">Value</th>
          <th title={FROM_TITLE}>From</th>
        </tr>
      </thead>
      <tbody>
        {[...rs].reverse().map((reading) => {
          const r = shownCopy(reading);
          const cls = labRowClass(r);
          const v = readingOf(r);
          const words = !r.flag && isWordResult(r) && resultMark(r);
          const mark = words ? null : rangeMark(r);
          // The reading's own range on its row when the readings print several, or when it is a summary's own.
          const ownRef = v.rangeShown && (v.role === 'claimed' || labRanges.size > 1) ? v.rangeShown : null;
          const ownLab = v.role === 'claimed' ? "this document's" : v.lab;
          const hover = v.rangeShown ? `Range printed with it: ${v.rangeShown}${rangeUnitSuffix(v, v.rangeShown)}${v.lab ? ` (${v.lab})` : ''}` : 'No range printed with this value';
          return (
            <tr key={reading.key} className={cls} onClick={() => onOpen(r)} title="Open this value">
              <td className="labs-c-date">
                {/* linkSearch is generic (S), so the router cannot type its result: the cast stays. */}
                <Link to="/labs" search={linkSearch(r) as never} onClick={(e) => e.stopPropagation()}>
                  <DateText iso={r.date} precision={r.datePrecision} text={r.dateText} />
                </Link>
              </td>
              <td className="labs-val labs-c-value" title={hover}>
                <span className="labs-val-fit">
                  <span className="labs-val-num">{v.valueShown || r.value || '—'}</span>
                  {r.unit ? <span className="labs-unit"> {r.unit}</span> : null}
                  {/* A result in words with no flag of its own: marked when it reads positive or abnormal. */}
                  {words ? (
                    <>
                      {' '}
                      <ResultMarkTag result={r} />
                    </>
                  ) : mark ? (
                    <>
                      {' '}
                      <RangeTag mark={mark} />
                    </>
                  ) : null}
                  {ownRef ? (
                    <span className="labs-own-ref">
                      range {ownRef}
                      {ownLab ? <span className="labs-own-lab"> · {ownLab}</span> : null}
                    </span>
                  ) : null}
                  <PrintedBesideNote computed={r.computed} />
                </span>
              </td>
              <td className="src">
                <SourceCell
                  row={r}
                  pageBelow
                  rowDate={r.date}
                  documentDate={r.documentId ? (documentDates?.get(r.documentId) ?? null) : null}
                  sub={fromSubItems(reading, r)}
                  check={<SourceTag source={r.source} trust={r.trust} factStatus={r.factStatus} factBasis={r.factBasis} factDeleted={r.factDeleted} notes={r.notes} computed={r.computed} />}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * A test whose results are all words (Negative, Clear, Colorless, Not detected): no chart, a compact dated list,
 * newest first, each reading once. Each result as written and where it came from, laid out as the readings table
 * (AnalyteValues): the document's name taking the room, the check and the page on the small line under it. A
 * positive or abnormal result carries a plain mark (positive, abnormal, or the report's own flag) so it stands out.
 * Clicking a result opens it in All values.
 */
export function WordResults<S>({ rows, onOpen, linkSearch, documentDates }: { rows: LabSeriesRow[]; onOpen: (r: LabSeriesRow) => void; linkSearch: (r: LabSeriesRow) => S; documentDates?: ReadonlyMap<string, string | null> }) {
  const rs = readings(rows);
  return (
    <table className="labs-results labs-words">
      <thead>
        <tr>
          <th className="labs-c-date">Date</th>
          <th className="labs-c-value">Result</th>
          <th title={FROM_TITLE}>From</th>
        </tr>
      </thead>
      <tbody>
        {[...rs].reverse().map((reading) => {
          const r = shownCopy(reading);
          const marked = Boolean(resultMark(r));
          const cls = labRowClass(r);
          return (
              <tr key={reading.key} className={[cls ?? '', marked ? 'marked' : ''].join(' ').trim() || undefined} onClick={() => onOpen(r)} title="Open this value">
                <td className="labs-c-date">
                  {/* linkSearch is generic (S), so the router cannot type its result: the cast stays. */}
                  <Link to="/labs" search={linkSearch(r) as never} onClick={(e) => e.stopPropagation()}>
                    <DateText iso={r.date} precision={r.datePrecision} text={r.dateText} />
                  </Link>
                </td>
                <td className="labs-word labs-c-value">
                  <span className="labs-val-fit">
                    <span className="labs-word-value">{r.value || <span className="faint">—</span>}</span>
                    {r.unit ? <span className="muted"> {r.unit}</span> : null}
                    {marked ? (
                      <span className="labs-word-mark">
                        <ResultMarkTag result={r} />
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="src">
                  <SourceCell
                    row={r}
                    pageBelow
                    rowDate={r.date}
                    documentDate={r.documentId ? (documentDates?.get(r.documentId) ?? null) : null}
                    sub={fromSubItems(reading, r)}
                    check={<SourceTag source={r.source} trust={r.trust} factStatus={r.factStatus} factBasis={r.factBasis} factDeleted={r.factDeleted} notes={r.notes} />}
                  />
                </td>
              </tr>
          );
        })}
      </tbody>
    </table>
  );
}
