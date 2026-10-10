/**
 * The document's summary: what Claude found in it, built from the sorting
 * and the details pulled out. A short summary, the key points, then one table
 * per kind of detail (lab values, medications, diagnoses...) with readable
 * sentence-case headers. Every row links to its page and shows its automatic
 * check (verified, accurate, not backed yet, inaccurate in red, needs a
 * source). Nothing waits for an answer: "Your answer" on a row opens the
 * user's own answers for that one detail. A lab value outside the range
 * printed with it (or flagged by the report) says "high" or "low" in red; a
 * value is never judged by its test's range, another lab's or another row's,
 * and a summary's own flag is its claim, never red (2026-10, rules 8, 11, 12).
 * Default content of the document pane and the
 * first view of the full document page. Which model sorted it and when the
 * summary was built are under Technical details, at the end.
 */
import { createContext, Fragment, useContext, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Tag, FactStatusTag, MED_STATUS_WORDS } from '../../ui/StatusTag';
import { RECORD_TYPE_WORDS } from '../records/words';
import { CheckTag } from '../reconcile/CheckTag';
import { DateText } from '../../ui/DateText';
import { Kbd } from '../../ui/Kbd';
import { useMe } from '../../api/users';
import { LineChart } from '../charts/LineChart';
import { TrustOverride, notComparedWithRecord, trustSentence } from '../reconcile/TrustOverride';
import { namesUncomparedRecord } from '../reconcile/logic';
import { parseLabValue } from '@shared/labvalues';
import { chartWords, hasNumericPoint, resultMark, WORDS_NOTE } from '../labs/words';
import type { TestRange } from '../labs/range';
import { AUTHOR_WORDS } from './tier';
import '../reconcile/reconcile.css';
import { type BriefLabGroup, type BriefLabRow, type BriefRowBase, type DocumentBrief as Brief } from './api';

export interface DocumentBriefProps {
  documentId: string;
  brief: Brief | undefined;
  loading: boolean;
  error?: string | null;
  /** Compact = inside the split-view detail pane (narrower tables). */
  compact?: boolean;
  /**
   * Show where it came from, who wrote it, its date and institution above the summary (default). The document pane
   * already has them in its key facts and passes false; the count of details always shows.
   */
  showHead?: boolean;
  /** Ignored (kept for older callers): a value is judged only against the range printed with it (rule 8). */
  testRanges?: ReadonlyMap<string, TestRange>;
  extractionStatus?: string;
  canExtract?: boolean;
}

const SPECIMEN_LABEL: Record<string, string> = { csf: 'CSF', serum: 'Serum', urine: 'Urine', other: 'Other specimens' };

function PageLink({ documentId, row, children }: { documentId: string; row: Pick<BriefRowBase, 'page' | 'citationId'>; children?: ReactNode }) {
  if (!row.page) return <span className="faint">—</span>;
  return (
    <Link to="/documents/$id" params={{ id: documentId }} search={{ page: row.page, cite: row.citationId ?? undefined, tab: 'text' }} className="brief-link" title="Open the passage in the page text">
      {children ?? `p.${row.page}`}
    </Link>
  );
}

/** The document's source tier, for each row's Override (a clinical record restating the report offers no It's accurate). */
const BriefTier = createContext<string | null | undefined>(undefined);

/**
 * The header's count of details: every row shown, and how many of them the
 * reconciliation set aside (shown, with their check, but not counted in
 * counts.facts). "0 details" never sits above ledgers that list some.
 */
export function briefDetailsWords(shown: number, counted: number): string {
  const setAside = shown - counted;
  return setAside > 0 ? `${shown} · ${setAside} set aside` : String(shown);
}

/** Every ledger row of the brief, for counting checks. */
function allRows(b: Brief): BriefRowBase[] {
  return [
    ...b.labs.flatMap((g) => g.rows),
    ...b.medications,
    ...b.diagnoses,
    ...b.imaging,
    ...b.procedures,
    ...b.symptoms,
    ...b.statements,
    ...b.recommendations,
    ...b.followUps,
    ...b.referrals,
    ...b.recordReferences,
    ...b.intolerances,
    ...b.events,
  ];
}

/**
 * Check and voice marks for one row: the automatic check (trust), a small
 * "override" that opens the user's own answers under the row, patient voice,
 * and the precedence mark. Replaced rows only show their tag.
 */
function Marks({ row, open, onToggle, toggleRef }: { row: BriefRowBase; open: boolean; onToggle: () => void; toggleRef: React.RefObject<HTMLButtonElement | null> }) {
  const canWrite = useMe().canWrite;
  const canOverride = canWrite && Boolean(row.trust) && row.trust.trust !== 'replaced';
  return (
    <span className="brief-marks">
      {row.trust ? <CheckTag trust={row.trust} /> : <FactStatusTag status={row.status} basis={row.verdictBasis} />}
      {canOverride ? (
        <button
          ref={toggleRef}
          type="button"
          className="brief-override"
          aria-expanded={open}
          title={open ? 'Close (Esc)' : 'Give your own answer for this detail, when you know better than the automatic check'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
          }}
        >
          {open ? 'Close' : 'Your answer'}
        </button>
      ) : null}
      {row.assertedBy === 'patient' ? (
        <Tag tone="accent" title="In your own words (you or your chief of staff)">
          your words
        </Tag>
      ) : null}
      {row.overriddenByFactId ? (
        <Link to="/facts" search={{ id: row.factId }} className="brief-link">
          <Tag tone="ash" title="Your own statement takes precedence over this assessment when the clinician reasons about the case; the record is shown as written">
            your view differs
          </Tag>
        </Link>
      ) : null}
    </span>
  );
}

/**
 * One row of a brief table: its cells, the marks, the page link, and (after
 * "override") the user's answers on a row of their own underneath. Esc
 * closes them and gives the focus back to "override".
 */
function BriefRow({ documentId, row, reconciled, className, cells }: { documentId: string; row: BriefRowBase; reconciled: boolean; className?: string; cells: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };
  const tier = useContext(BriefTier);
  const inaccurate = row.trust?.trust === 'inaccurate';
  // What the record says (or why it needs a source, or that a record of that day gives it in another unit or other
  // words, so it was not compared) on a line of its own, not only in the tag's tooltip, which touch screens never
  // show. The open override row says it already.
  const why = !open && row.trust && (row.trust.trust === 'inaccurate' || row.trust.trust === 'conflict' || notComparedWithRecord(row.trust)) ? trustSentence(row.trust) : null;
  return (
    <>
      <tr className={[className ?? '', inaccurate ? 'inaccurate-row' : '', why ? 'has-reason' : ''].filter(Boolean).join(' ') || undefined}>
        {cells}
        <td className="marks">
          <Marks row={row} open={open} onToggle={() => setOpen((v) => !v)} toggleRef={toggleRef} />
        </td>
        <td className="src">
          <PageLink documentId={documentId} row={row} />
        </td>
      </tr>
      {why ? (
        <tr className={['brief-override-row', 'brief-reason-row', inaccurate ? 'inaccurate-row' : ''].filter(Boolean).join(' ')}>
          <td colSpan={cells.filter(Boolean).length + 2}>
            <div className={`trust-line ${row.trust.trust}`}>
              <strong>{why.label}:</strong> {why.rest}
              {row.trust.trust === 'conflict' ? (
                <>
                  {' '}
                  <Link to="/reconcile" search={{ tab: 'needs', id: row.trust.eventKey ?? undefined }} className="brief-link">
                    See Reconciliation.
                  </Link>
                </>
              ) : null}
              {/* Not compared (a scan report's impression, another unit...): the record to read beside this row. */}
              {namesUncomparedRecord(row.trust) && row.trust.recordDocumentId && row.trust.recordDocumentId !== documentId ? (
                <>
                  {' '}
                  <Link to="/documents/$id" params={{ id: row.trust.recordDocumentId }} className="brief-link" title={`Open ${row.trust.recordDocumentTitle ?? 'the record'}`}>
                    open the record
                  </Link>
                </>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
      {open ? (
        <tr
          className="brief-override-row"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            e.preventDefault();
            close();
          }}
        >
          <td colSpan={cells.filter(Boolean).length + 2}>
            <TrustOverride factId={row.factId} trust={row.trust} status={row.status} basis={row.verdictBasis ?? null} reconciled={reconciled} documentTier={tier} compact onDone={close} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

const FLAG_WORD: Record<string, string> = { H: 'high', L: 'low', A: 'abnormal', C: 'flagged C' };

/**
 * A lab row's red mark, by the same rule as Lab results (features/labs/range.ts), from the row the server read
 * (BRIEF_LABS_VERSION 3): the flag the report printed; else the flag worked out from the range printed with the row
 * ("H~"), with the server's words; else the server's own out-of-range mark. Never the test's range, another lab's or
 * another row's; a summary's own flag or range is its claim (rangeRole claimed): no mark. Null within range or unjudged.
 */
export function briefRangeMark(row: Pick<BriefLabRow, 'flag' | 'ref' | 'outOfRange' | 'flagState' | 'flagComputed' | 'rangeRole' | 'warnings'>): { word: string; title: string } | null {
  if (row.rangeRole === 'claimed') return null;
  const flag = (row.flag ?? '').trim();
  const worked = flag.endsWith('~');
  const letter = flag.replace('~', '').toUpperCase();
  const said = (re: RegExp) => (row.warnings ?? []).find((w) => re.test(w)) ?? null;
  const within = row.ref ? ` (${row.ref})` : '';
  if (FLAG_WORD[letter] && !worked) return { word: FLAG_WORD[letter], title: letter === 'C' ? "Flagged C on the report: critical or corrected, the report's own letter" : `Flagged ${FLAG_WORD[letter]} on the report` };
  if ((letter === 'H' || letter === 'L') && worked) return { word: FLAG_WORD[letter], title: said(/printed no flag|no flag was recorded/) ?? `${letter === 'H' ? 'Above' : 'Below'} the range printed with it${within}; the report printed no flag` };
  // The report marks it normal, but the value is outside the range printed with it.
  if (letter === 'N' && (row.flagComputed === 'H' || row.flagComputed === 'L')) return { word: FLAG_WORD[row.flagComputed], title: said(/marks it normal/) ?? `The report marks it normal (N), but it is outside the range printed with it${within}` };
  if (row.outOfRange === true) return { word: 'out of range', title: `Outside the range printed with it${within}` };
  return null;
}

/**
 * The tag of one result in a trend's list: a summary's own flag is its claim (never a red mark); a flag the app worked
 * out ("H~") is said as worked out from the value's own range, never "flagged on the report" (briefRangeMark, 2026-10
 * review); a result in words is marked by what it says.
 */
export function trendResultMark(row: BriefLabRow, measurement: number | null, specimen: string | null | undefined): ReturnType<typeof resultMark> {
  const range = briefRangeMark(row);
  if (range) return { word: range.word, tone: 'danger', title: range.title };
  return resultMark({ value: row.value, valueNum: measurement, flag: row.rangeRole === 'claimed' || (row.flag ?? '').includes('~') ? null : row.flag, specimen: specimen ?? undefined });
}

function RangeWordTag({ row }: { row: BriefLabRow }) {
  const mark = briefRangeMark(row);
  if (!mark) return null;
  return (
    <Tag tone="danger" title={mark.title}>
      {mark.word}
    </Tag>
  );
}

const NO_RANGES: ReadonlyMap<string, TestRange> = new Map();

/**
 * Kept for the pages that show a brief (they pass it in): a value is judged only against the range printed with it
 * (rule 8), so no test's range is fetched or used. Always an empty map.
 */
export function useTestRanges(): Map<string, TestRange> {
  return NO_RANGES as Map<string, TestRange>;
}

type LabTrend = Brief['labTrends'][number];

/** Every result of one trend's test in this document, dated, in the ledger's order (oldest date first). */
function trendResults(groups: BriefLabGroup[], t: LabTrend): { date: string | null; datePrecision: string; row: BriefLabRow }[] {
  return groups
    .filter((g) => g.specimen === t.specimen)
    .flatMap((g) => g.rows.filter((r) => r.analyteKey === t.analyteKey).map((row) => ({ date: g.date, datePrecision: g.datePrecision, row })))
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/**
 * A trend across this document. Drawn only with a number to draw: a test whose results here are all words is its
 * dated results as text ("Results in words; no chart."). A test with numbers and words draws the numbers and lists
 * every result, words included, under the chart; a positive or abnormal result is marked so it stands out.
 */
function BriefTrend({ documentId, groups, t }: { documentId: string; groups: BriefLabGroup[]; t: LabTrend }) {
  const results = trendResults(groups, t);
  const drawn = hasNumericPoint(t.chart);
  // A measurement as the server read it (a limit "<2" or "1:160" is never a number here).
  const measurement = (r: BriefLabRow): number | null => {
    if (r.valueKind && r.valueKind !== 'number') return null;
    const v = parseLabValue(r.value);
    return v.kind === 'number' ? v.number : null;
  };
  const words = results.some((x) => measurement(x.row) == null && x.row.value.trim() !== '');
  const list = results.length ? (
    <div className="row wrap small">
      {results.map((x) => {
        const mark = trendResultMark(x.row, measurement(x.row), t.specimen);
        return (
          <span key={x.row.factId} className="nowrap">
            <DateText iso={x.date} precision={x.datePrecision} /> <span className="mono">{x.row.value || '—'}</span>
            {x.row.unit ? <span className="unit muted"> {x.row.unit}</span> : null}
            {mark ? (
              <>
                {' '}
                <Tag tone={mark.tone} title={mark.title}>
                  {mark.word}
                </Tag>
              </>
            ) : null}{' '}
            <PageLink documentId={documentId} row={x.row} />
          </span>
        );
      })}
    </div>
  ) : (
    <div className="row wrap small">
      {chartWords(t.chart).map((p, i) => (
        <span key={i} className="nowrap">
          <DateText iso={p.x} /> <span className="mono">{p.text}</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="brief-chart">
      <div className="brief-sub">
        <span>{t.analyte} across this document</span>
      </div>
      {drawn ? <LineChart spec={t.chart} height={80} /> : <div className="muted small">{WORDS_NOTE}</div>}
      {!drawn || words ? list : null}
    </div>
  );
}

function LabsLedger({ documentId, groups, trends }: { documentId: string; groups: BriefLabGroup[]; trends: Brief['labTrends']; ranges?: ReadonlyMap<string, TestRange> }) {
  const bySpecimen = new Map<string, BriefLabGroup[]>();
  for (const g of groups) {
    if (!bySpecimen.has(g.specimen)) bySpecimen.set(g.specimen, []);
    bySpecimen.get(g.specimen)!.push(g);
  }
  return (
    <>
      {[...bySpecimen.entries()].map(([specimen, list]) => (
        <section key={specimen} className="brief-section">
          <h3 className="brief-h">{SPECIMEN_LABEL[specimen] ?? specimen}</h3>
          {list.map((g) => {
            // The normal range only when the report prints one for some value here (an empty column only pushed the
            // "high" away from its value); "high" / "low" sits right beside the value, as on Lab results.
            const anyRef = g.rows.some((r) => (r.ref ?? '').trim());
            return (
              <Fragment key={`${g.panel}|${g.date ?? ''}`}>
                <div className="brief-sub">
                  <span>{g.panel}</span>
                  <span className="mono">{g.date ? <DateText iso={g.date} precision={g.datePrecision} /> : 'undated'}</span>
                </div>
                <table className="brief-table labs">
                  <thead>
                    <tr>
                      <th>Test</th>
                      <th className="val">Value</th>
                      {anyRef ? <th>Normal range</th> : null}
                      <th className="marks">Check</th>
                      <th className="src">Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <BriefRow
                        key={r.partId ?? r.factId}
                        documentId={documentId}
                        row={r}
                        reconciled
                        className={r.outOfRange ? 'oor' : undefined}
                        cells={[
                          <td key="name" className="name">
                            {r.analyte}
                          </td>,
                          <td key="num" className="val mono">
                            {r.value || '—'}
                            {r.unit ? <span className="unit"> {r.unit}</span> : null}
                            <span className="flag">
                              <RangeWordTag row={r} />
                            </span>
                          </td>,
                          anyRef ? (
                            <td key="ref" className="ref mono muted" title={r.rangeRole === 'claimed' && r.ref ? "The range this document gives, not the lab's" : undefined}>
                              {r.ref ?? ''}
                              {r.rangeRole === 'claimed' && r.ref ? <span> (this document's)</span> : null}
                            </td>
                          ) : null,
                        ]}
                      />
                    ))}
                  </tbody>
                </table>
              </Fragment>
            );
          })}
          {trends
            .filter((t) => t.specimen === specimen)
            .map((t) => (
              <BriefTrend key={`${t.specimen}|${t.analyteKey}`} documentId={documentId} groups={list} t={t} />
            ))}
        </section>
      ))}
    </>
  );
}

interface Col<T> {
  key: string;
  header: string;
  cell: (r: T) => ReactNode;
  className?: string;
  /** For a column that is often empty: its value; when no row has one, the column is left out (no column of dashes). */
  value?: (r: T) => unknown;
}

/** Ledgers whose details are compared with the clinical records (imaging, procedures, events and vitals; labs above). */
const RECONCILED_LEDGERS = new Set(['Imaging', 'Procedures', 'Events and vitals']);

function Ledger<T extends BriefRowBase>({ documentId, title, rows, columns: allColumns, count }: { documentId: string; title: string; rows: T[]; columns: Col<T>[]; count?: number }) {
  if (!rows.length) return null;
  const columns = allColumns.filter((c) => !c.value || rows.some((r) => { const v = c.value!(r); return v != null && v !== ''; }));
  return (
    <section className="brief-section">
      <h3 className="brief-h">
        {title}
        <span className="brief-n">{count ?? rows.length}</span>
      </h3>
      <table className="brief-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.className}>
                {c.header}
              </th>
            ))}
            <th className="marks">Check</th>
            <th className="src">Page</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <BriefRow
              key={r.factId}
              documentId={documentId}
              row={r}
              reconciled={RECONCILED_LEDGERS.has(title)}
              className={r.overriddenByFactId ? 'overridden' : undefined}
              cells={columns.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.cell(r)}
                </td>
              ))}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

const dash = (v: string | null | undefined): ReactNode => (v ? v : <span className="faint">—</span>);
/** A stored word in the page's words (`words`: the same map the page for it uses), else with its underscores as spaces. */
const low = (v: string | null | undefined, words?: Record<string, string>): ReactNode => (v ? <span className="muted">{words?.[v] ?? v.replace(/_/g, ' ')}</span> : <span className="faint">—</span>);

export function DocumentBrief({ documentId, brief, loading, error, compact, extractionStatus, canExtract, showHead = true }: DocumentBriefProps) {
  if (loading && !brief) return <div className="brief-status">Putting the summary together…</div>;
  if (error && !brief) return <div className="brief-status">The summary could not be put together: {error}</div>;
  if (!brief) return <div className="brief-status">No summary yet.</div>;
  const b = brief;
  // Every row the ledgers list, including the details the reconciliation set aside (shown with their check, not
  // counted in counts.facts): a document whose details were all set aside still has ledgers, not "extract facts".
  const rows = allRows(b);
  const noFacts = rows.length === 0 && b.counts.facts === 0;
  const extracting = extractionStatus === 'queued' || extractionStatus === 'running';
  const inaccurate = rows.filter((r) => r.trust?.trust === 'inaccurate').length;
  const conflict = rows.filter((r) => r.trust?.trust === 'conflict').length;
  const verified = rows.filter((r) => r.trust?.trust === 'verified').length;
  const notCompared = rows.filter((r) => notComparedWithRecord(r.trust)).length;

  const body = (
    <div className={`brief${compact ? ' compact' : ''}`}>
      {/* Where it came from and its date are in the page's own header; who wrote it and where are said here once. */}
      {showHead && (b.authorRole || b.author || b.institution) ? (
        <div className="brief-head">
          {b.authorRole ? (
            <span className="brief-kv">
              <span className="k">Written by:</span>
              {AUTHOR_WORDS[b.authorRole] ?? b.authorRole.replace(/_/g, ' ')}
            </span>
          ) : null}
          {b.author ? (
            <span className="brief-kv">
              <span className="k">By:</span>
              {b.author}
            </span>
          ) : null}
          {b.institution ? (
            <span className="brief-kv">
              <span className="k">Institution:</span>
              {b.institution}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="brief-counts">
        <span className="k">Details:</span> <span className="mono">{briefDetailsWords(rows.length, b.counts.facts)}</span>
        {verified ? <span> · {verified} verified</span> : null}
        {inaccurate ? (
          <>
            {' · '}
            <span className="rc-bad">{inaccurate} inaccurate</span>
          </>
        ) : null}
        {conflict ? <span> · {conflict} need a source</span> : null}
        {notCompared ? <span> · {notCompared} not compared</span> : null}
        {b.counts.overridden ? <span> · {b.counts.overridden} where your view differs</span> : null}
      </div>

      {b.summary ? (
        <p className="brief-summary">{b.summary}</p>
      ) : (
        <p className="brief-nosummary">No summary yet. Claude writes one when it sorts the document{extracting ? '; it is reading it now' : ''}.</p>
      )}
      {b.summary && b.summarySource === 'extraction' ? <div className="brief-note">Written while Claude pulled out the details; not checked against the pages.</div> : null}

      {b.keyPoints.length ? (
        <section className="brief-section">
          <h3 className="brief-h">Key points</h3>
          <ol className="brief-points">
            {b.keyPoints.map((k, i) => (
              <li key={i}>
                <span>{k.text}</span>
                {k.page ? (
                  <Link
                    to="/documents/$id"
                    params={{ id: documentId }}
                    search={{ page: k.page, q: k.quote && k.quote.length <= 120 ? k.quote : undefined, tab: 'text' }}
                    className={`brief-chip${k.verified === false ? ' unverified' : ''}`}
                    title={k.quote ? `"${k.quote}"${k.verified === false ? ' (not found verbatim on that page)' : ''}` : undefined}
                  >
                    p.{k.page}
                    {k.verified === false ? ' ?' : ''}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {noFacts ? (
        <div className="brief-empty">
          {extracting ? (
            'Claude is pulling out the details; these tables fill in when it is done.'
          ) : canExtract ? (
            <>
              No details pulled out yet. Pull out details (<Kbd>x</Kbd>) to fill these tables.
            </>
          ) : (
            'These tables fill in once the pages have been read and the details pulled out.'
          )}
        </div>
      ) : null}

      {b.labs.length ? <LabsLedger documentId={documentId} groups={b.labs} trends={b.labTrends} /> : null}

      <Ledger
        documentId={documentId}
        title="Medications"
        rows={b.medications}
        columns={[
          { key: 'name', header: 'Drug', cell: (r) => r.name, className: 'name' },
          { key: 'dose', header: 'Dose', cell: (r) => <span className="mono">{r.dose ?? ''}</span>, value: (r) => r.dose },
          { key: 'status', header: 'Status', cell: (r) => low(r.medStatus, MED_STATUS_WORDS), value: (r) => r.medStatus },
          { key: 'effect', header: 'Effect', cell: (r) => dash(r.effect), className: 'wrap', value: (r) => r.effect },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Diagnoses"
        rows={b.diagnoses}
        columns={[
          { key: 'name', header: 'Diagnosis', cell: (r) => r.name, className: 'name' },
          { key: 'certainty', header: 'How certain', cell: (r) => low(r.certainty) },
          { key: 'by', header: 'Stated by', cell: (r) => dash(r.statedBy), className: 'wrap', value: (r) => r.statedBy },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Imaging"
        rows={b.imaging}
        columns={[
          { key: 'study', header: 'Study', cell: (r) => `${r.modality}${r.bodyPart ? ` ${r.bodyPart}` : ''}`, className: 'name' },
          { key: 'impression', header: 'Impression', cell: (r) => dash(r.impression), className: 'wrap' },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Procedures"
        rows={b.procedures}
        columns={[
          { key: 'name', header: 'Procedure', cell: (r) => r.name, className: 'name' },
          { key: 'by', header: 'By', cell: (r) => dash(r.performedBy), value: (r) => r.performedBy },
          { key: 'result', header: 'Result', cell: (r) => dash(r.result), className: 'wrap', value: (r) => r.result },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Symptoms"
        rows={b.symptoms}
        columns={[
          { key: 'name', header: 'Symptom', cell: (r) => r.name, className: 'name' },
          { key: 'severity', header: 'Severity', cell: (r) => dash(r.severity), value: (r) => r.severity },
          { key: 'course', header: 'Course', cell: (r) => low(r.course), value: (r) => r.course },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Clinician statements"
        rows={b.statements}
        columns={[
          { key: 'by', header: 'Who', cell: (r) => dash(r.statedBy), className: 'name' },
          { key: 'about', header: 'About', cell: (r) => dash(r.about) },
          { key: 'stance', header: 'Stance', cell: (r) => low(r.stance) },
          { key: 'statement', header: 'Statement', cell: (r) => r.statement, className: 'wrap' },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Recommendations"
        rows={b.recommendations}
        columns={[
          { key: 'action', header: 'Recommended', cell: (r) => r.action, className: 'wrap name' },
          { key: 'by', header: 'By', cell: (r) => dash(r.recommendedBy), value: (r) => r.recommendedBy },
          { key: 'acted', header: 'Acted on', cell: (r) => low(r.actedOn) },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Follow-ups"
        rows={b.followUps}
        columns={[
          { key: 'what', header: 'What', cell: (r) => r.what, className: 'wrap name' },
          { key: 'who', header: 'Who', cell: (r) => dash(r.who), value: (r) => r.who },
          { key: 'due', header: 'Due', cell: (r) => <span className="mono">{r.due ?? ''}</span>, value: (r) => r.due },
          { key: 'status', header: 'Status', cell: (r) => low(r.followUpStatus) },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Referrals"
        rows={b.referrals}
        columns={[
          { key: 'to', header: 'To', cell: (r) => r.to, className: 'name' },
          { key: 'specialty', header: 'Specialty', cell: (r) => dash(r.specialty), value: (r) => r.specialty },
          { key: 'status', header: 'Status', cell: (r) => low(r.referralStatus) },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Records referred to"
        rows={b.recordReferences}
        columns={[
          { key: 'desc', header: 'Record', cell: (r) => r.description, className: 'wrap name' },
          { key: 'type', header: 'Type', cell: (r) => low(r.recordType, RECORD_TYPE_WORDS) },
          { key: 'here', header: 'In this document', cell: (r) => (r.presentHere ? 'yes' : <span className="muted">mentioned only</span>) },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Allergies and intolerances"
        rows={b.intolerances}
        columns={[
          { key: 'substance', header: 'Substance', cell: (r) => r.substance, className: 'name' },
          { key: 'kind', header: 'Kind', cell: (r) => low(r.kind) },
          { key: 'reaction', header: 'Reaction', cell: (r) => dash(r.reaction), className: 'wrap' },
        ]}
      />
      <Ledger
        documentId={documentId}
        title="Events and vitals"
        rows={b.events}
        columns={[
          { key: 'date', header: 'Date', cell: (r) => <DateText iso={r.date} precision={r.datePrecision} /> },
          { key: 'name', header: 'What', cell: (r) => r.name, className: 'name' },
          { key: 'detail', header: 'Detail', cell: (r) => dash(r.detail), className: 'wrap' },
        ]}
      />

      {b.people.length ? (
        <section className="brief-section">
          <h3 className="brief-h">People named</h3>
          <p className="brief-people">
            {b.people.map((p, i) => (
              <Fragment key={p.name}>
                {i ? ', ' : ''}
                {p.personId ? (
                  <Link to="/people" search={{ id: p.personId }}>
                    {p.name}
                  </Link>
                ) : (
                  <span>{p.name}</span>
                )}
              </Fragment>
            ))}
          </p>
        </section>
      ) : null}

      <details className="brief-foot">
        <summary>Technical details</summary>
        <div className="brief-foot-body">
          {b.classification ? `Sorted by Claude (${b.classification.model}) from the first ${b.classification.pagesUsed} page${b.classification.pagesUsed === 1 ? '' : 's'}, ${Math.round(b.classification.confidence * 100)}% sure.` : 'Not sorted by Claude yet.'}{' '}
          {b.summary && b.summarySource === 'extraction' && b.summaryModel ? `Summary written by ${b.summaryModel}. ` : ''}
          This summary was put together on {b.builtAt.slice(0, 16).replace('T', ' ')}.
        </div>
      </details>
    </div>
  );
  return <BriefTier.Provider value={b.tier ?? null}>{body}</BriefTier.Provider>;
}
