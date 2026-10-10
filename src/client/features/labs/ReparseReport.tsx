/**
 * "Values re-read" (Lab results > More, and the command palette): the one-time re-read of every lab value from the
 * text as printed (2026-10), in plain words, with the counts in the mono. It runs by itself a few seconds after an
 * unlock (server lab-backfill.ts) and keeps its report in the encrypted database (GET /api/labs/reparse-report):
 * how many values were read again, how many now read differently and why, the first check against the clinical
 * records after it, up to 20 examples, and that nothing you entered was overwritten and nothing was deleted.
 * Before it has run: "Not run yet". After a failure: when, and that it tries again at the next unlock.
 */
import type { ReactNode } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Loading } from '../../ui/PageHeader';
import { DateText } from '../../ui/DateText';
import { useReparseReport, type LabParseReport, type LabParseRule } from '../../api/labs';

const n = (k: number) => <span className="mono">{k}</span>;
const plural = (k: number, one: string, many: string) => (k === 1 ? one : many);

/** One plain line per counter that is not zero, in the order a reader needs them. */
export const RULE_LINES: ReadonlyArray<{ rule: LabParseRule; line: (k: number) => ReactNode; short: string }> = [
  { rule: 'limitNotMeasurement', short: 'a limit, not a measurement', line: (k) => <>{n(k)} {plural(k, 'limit such as "<3" is', 'limits such as "<3" are')} no longer drawn or compared as if {plural(k, 'it were a measurement', 'they were measurements')}.</> },
  { rule: 'wordsNotNumber', short: 'words, not a number', line: (k) => <>{n(k)} {plural(k, 'result in words ("Negative") is', 'results in words ("Negative") are')} no longer read as a number.</> },
  { rule: 'quoteShowsSymbol', short: 'the page shows the sign', line: (k) => <>{n(k)} {plural(k, 'value was', 'values were')} read without the sign the page prints (such as {'"<"'}); the page is followed and each says so.</> },
  { rule: 'rangeShownAsPrinted', short: 'range now shown', line: (k) => <>{n(k)} normal {plural(k, 'range is', 'ranges are')} now shown as printed ({'"<50"'}), or as {'"upper limit 50"'} where only a number was on record (never {'"≤ 50"'} or {'"-50"'}).</> },
  { rule: 'rangeNumbersIgnored', short: 'range numbers set aside', line: (k) => <>{n(k)} {plural(k, 'range had', 'ranges had')} stored numbers that differ from the range as printed; the printed range is used.</> },
  { rule: 'rangeUnparsed', short: 'range kept as printed', line: (k) => <>{n(k)} {plural(k, 'range is', 'ranges are')} kept exactly as printed and not read as numbers (several ranges, a comment, a titre).</> },
  { rule: 'flagChanged', short: 'flag now marked', line: (k) => <>{n(k)} {plural(k, 'flag is', 'flags are')} now marked as printed by the report, or as worked out from the range printed with the value.</> },
  { rule: 'flagNowClaim', short: "a summary's own flag", line: (k) => <>{n(k)} {plural(k, 'flag in a summary or a note is', 'flags in summaries or notes are')} now that document's own claim, never marked red or counted as the lab's.</> },
  { rule: 'flagWarnings', short: 'flag and range disagree', line: (k) => <>{n(k)} {plural(k, 'value is', 'values are')} outside the range printed with {plural(k, 'it', 'them')} while the report printed no flag (or a flag that says otherwise); each now says so.</> },
  { rule: 'unitCollapsed', short: 'unit printed twice', line: (k) => <>{n(k)} {plural(k, 'unit', 'units')} printed twice ("cells/uL cells/uL") {plural(k, 'is', 'are')} shown once.</> },
  { rule: 'regrouped', short: 'listed under its own name', line: (k) => <>{n(k)} {plural(k, 'value is', 'values are')} listed under {plural(k, 'its', 'their')} own test name (for example hs-CRP apart from CRP, IgG index apart from IgG).</> },
  { rule: 'sameSourceConflicts', short: 'two values in one document', line: (k) => <>{n(k)} {plural(k, 'document gives', 'documents give')} two values for one test on one day, like a typing error; see What Claude noticed. Neither value was chosen.</> },
  { rule: 'claimDifferences', short: 'a summary differs', line: (k) => <>{n(k)} {plural(k, 'summary judges', 'summaries judge')} a value, or {plural(k, 'uses', 'use')} a limit, otherwise than the lab report printed it; see What Claude noticed.</> },
];

const DATE_LINE = (k: number) => (
  <>
    {n(k)} {plural(k, 'date is', 'dates are')} not marked on the report as collected or resulted; each value says so in its detail. Nothing was guessed.
  </>
);

/** A date the way every other date is shown: ISO, in the mono (DateText). */
function when(iso: string): ReactNode {
  const day = (iso ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? <DateText iso={day} precision="day" /> : iso;
}

/** The report in words (pure, so tests can render it). */
export function ReparseReportBody({ report, error }: { report: LabParseReport | null; error: { at: string; error: string } | null }) {
  if (!report) {
    return (
      <div className="labs-reparse">
        <p>Not run yet. It runs a few seconds after you unlock.</p>
        {error ? (
          <div className="notice warn small">
            The last try{error.at ? <> on {when(error.at)}</> : null} did not finish: {error.error}. It tries again at the next unlock; nothing was changed.
          </div>
        ) : null}
      </div>
    );
  }
  const values = report.rows.live + report.facts.total;
  const changed = report.rows.readingChanged + report.facts.readingChanged;
  const lines = RULE_LINES.filter((r) => (report.byRule[r.rule] ?? 0) > 0);
  const dates = report.byRule.dateKindUnknown ?? 0;
  const rc = report.reconcile;
  const short = new Map(RULE_LINES.map((r) => [r.rule as string, r.short] as const));
  return (
    <div className="labs-reparse">
      <p>
        On {when(report.ranAt)}, {n(values)} lab {plural(values, 'value was', 'values were')} read again from the text as printed. {n(changed)} now {plural(changed, 'reads', 'read')} differently.
        {report.dryRun ? ' This was a trial run: nothing was written.' : ''}
      </p>
      {lines.length ? (
        <ul>
          {lines.map((r) => (
            <li key={r.rule}>{r.line(report.byRule[r.rule] ?? 0)}</li>
          ))}
        </ul>
      ) : null}
      {dates ? <p className="muted">{DATE_LINE(dates)}</p> : null}
      {rc && (rc.undone || rc.setAside || rc.notCompared) ? (
        <p>
          Then the check against your clinical records ran again: {n(rc.undone)} {plural(rc.undone, 'detail', 'details')} set aside before {plural(rc.undone, 'is', 'are')} back on the list, {n(rc.setAside)} {plural(rc.setAside, 'was', 'were')} set aside, and {n(rc.notCompared)} {plural(rc.notCompared, 'pair is', 'pairs are')} no longer compared (a limit against a measurement inside it).
        </p>
      ) : null}
      <p>
        <strong>Nothing you entered or changed was overwritten. Nothing was deleted.</strong>
      </p>
      {report.error ? <div className="notice warn small">It did not finish: {report.error}. It tries again at the next unlock.</div> : null}
      {report.examples.length ? (
        <div>
          <p className="muted small">For example:</p>
          <ul className="labs-reparse-examples">
            {report.examples.slice(0, 20).map((x, i) => (
              <li key={`${x.entryId}|${x.rule}|${i}`}>
                {x.test}: was {x.before}; now {x.after}
                {short.get(x.rule) ? <span className="muted"> ({short.get(x.rule)})</span> : null}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The dialog: loads the report when it opens. */
export function ReparseReport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useReparseReport(open);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Lab values re-read from the text as printed"
      width={640}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {q.isPending ? (
        <Loading>Loading the report…</Loading>
      ) : q.isError ? (
        <div className="notice bad small">{q.error instanceof Error ? q.error.message : 'The report could not be loaded.'}</div>
      ) : (
        <ReparseReportBody report={q.data?.report ?? null} error={q.data?.error ?? null} />
      )}
    </Dialog>
  );
}
