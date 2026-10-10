/**
 * One lab value, in the right pane of By document and All values
 * (routes/labs.tsx):
 *
 *   header    the sample, the test's name with its value, one status line (its
 *             check and where it came from), the actions that matter (Show the
 *             trend, Open the page; Edit, Copy into my lab list and Delete under
 *             More) and the key facts, read from the value's reading
 *             (features/labs/reading.ts, 2026-10):
 *               Value          as printed ("<3", "Negative", "0.80"); a limit says
 *                              "A limit, not a measurement: the test reads below 3";
 *                              your own value says "As printed: ..." under it
 *               Normal range   its own, as printed, with the lab that printed it;
 *                              "kept as printed; not read as numbers"; a summary's
 *                              "as given in this document (not the lab's range)";
 *                              never the test's range
 *               Flag on the report (Flag in this document, Flag you entered)
 *                              exactly as printed: "H", "HH (critical)", "None
 *                              printed", "Not recorded"
 *               By its range   worked out by the app from the value and its own
 *                              range: "High: above 98-108 mmol/L", "In range",
 *                              "Cannot tell: ...", "No range printed with this value"
 *               Collected, Resulted, Received   kept apart; a date whose kind the
 *                              document does not say is "Date", with one muted line
 *             then sample, the report's wording, lab, institution, how it was entered
 *   Warnings  one line each, in the warning tone ("The report printed no flag, but
 *             112 is above the range printed with it")
 *   Notices   the open lab findings naming it (two values in one document, a
 *             summary that differs), a part of a line, a summary-only value, a value
 *             set aside
 *   Check     how it compares with your clinical records, and your own answer
 *   Where this came from   the document, the line, the quote as found on the page; a value the app added from the
 *             page itself (the lab check, or the clinician at your request; 2026-10-08) says so ("Added by the lab
 *             check from p.240.") in Entered and here
 *
 * Never the test's internal key; never "censored" (a limit is "a limit, not a measurement").
 */
import { Link } from '@tanstack/react-router';
import type { ActionBarProps } from '../../ui/ActionBar';
import { TrustOverride } from '../reconcile/TrustOverride';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane, KeyFacts } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import type { DatePrecision } from '@shared/dates';
import { displayValue, isSetAside, type LabEntry } from '../../api/labs';
import { parseAttributes, useFact } from '../../api/facts';
import { labAddedNote } from '@shared/labcheck';
import { CombinedTag, LineNote, RangeTag, SourceTag, SpecimenTag, originWords, sampleWords } from './tags';
import { SourceLink } from './AnalyteDetail';
import { COMBINED_TITLE, isCombined, isPart, splitFromOf } from './parts';
import { readingMark, type TestRange } from './range';
import { CLAIM_FLAG_NOTE, asPrinted, byRangeWords, dateFacts, flagLabel, flagWords, rangeFact, readingOf, valueLabel, valueNotes } from './reading';
import { LabIssueNotices } from './LabIssues';

export interface LabDetailProps {
  entry: LabEntry;
  busy?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onImport: () => void;
  onShowTrend: () => void;
  /** Open the page the value came from (o). */
  onOpenSource?: () => void;
  /**
   * For one part of a line that held several tests: the whole line, as stored, could be loaded, so Edit can open it.
   * Edit never opens on a part alone (saving it would write one test over the whole line).
   */
  lineEditable?: boolean;
  /** Ignored (kept for older callers): a value is judged only against its own range, never its test's (rule 8). */
  testRange?: TestRange | null;
  /** The test's one name (as in By test); the report's own wording shows as a key fact when it differs. */
  name?: string | null;
}

/** What a part of a line that held several tests says about its actions, in plain words. */
export function partWords(e: Pick<LabEntry, 'source' | 'splitFrom' | 'id'>): string | null {
  if (!isPart(e)) return null;
  const sf = splitFromOf(e);
  const n = sf && sf.of > 1 ? `one of ${sf.of} tests` : 'one of several tests';
  return e.source === 'row'
    ? `This value is ${n} written on one line of the document. Edit and Delete act on that whole line, as it was read.`
    : `Claude read this value as ${n} written on one line of the document. Copying it into your lab list, and any answer you give about it, act on that whole line.`;
}

/**
 * The warnings said under the key facts, one line each. A range kept as printed is said once, in the Normal range fact
 * itself ("(not read as numbers)" and why), never again as a warning (2026-10 review).
 */
export function shownWarnings(v: Pick<ReturnType<typeof readingOf>, 'warnings' | 'warningCodes'>): string[] {
  return v.warnings.filter((_, i) => v.warningCodes[i] !== 'range_unparsed');
}

/** Why Edit is not offered on a part whose whole line could not be loaded. */
export const LINE_NOT_LOADED = 'Only the whole line can be edited, and it is not loaded yet; open the document to read it.';

/** Why a value is kept out of trends, charts and the list of tests, in plain words. */
function setAsideWords(e: LabEntry): string {
  if (e.factDeleted) return 'The detail this value came from was deleted. The value stays listed with its document link, but it is kept out of trends, charts and the list of tests. Delete it here if the value itself is wrong.';
  if (e.factStatus === 'disputed') return 'Marked wrong, so it is kept out of trends, charts and the list of tests.';
  if (e.trust?.trust === 'inaccurate') return `It disagrees with ${e.trust.recordDocumentTitle ?? 'the clinical record'}, whose value is used instead; it is kept out of trends, charts and the list of tests.`;
  if (e.trust?.trust === 'accurate') return `It repeats ${e.trust.recordDocumentTitle ?? 'the clinical record'}, which is listed on its own; this copy is kept out of trends, charts and the list of tests.`;
  return 'This value was replaced by a newer reading or merged into its duplicate, so it is kept out of trends, charts and the list of tests. The value that replaced it is listed on its own.';
}

/**
 * The value's actions in order of importance: Show the trend (outlined), Open the page; under More, Edit (the whole
 * line, for a part), Copy into my lab list (a value Claude read), and Delete (asks first).
 */
export function labDetailActions(e: LabEntry, p: Pick<LabDetailProps, 'busy' | 'onEdit' | 'onDelete' | 'onImport' | 'onShowTrend' | 'onOpenSource' | 'lineEditable'>): ActionBarProps {
  const virtual = e.source === 'fact';
  const part = isPart(e);
  const canEditLine = !part || Boolean(p.lineEditable);
  return {
    primary: { label: 'Show the trend', onClick: p.onShowTrend, shortcut: 't', title: 'Every value of this test over time, on a chart' },
    secondary: [e.documentId && p.onOpenSource ? { label: 'Open the page', onClick: p.onOpenSource, shortcut: 'o', title: 'The page of the document this value was read from, with the line marked' } : null],
    more: [
      virtual
        ? {
            label: part ? 'Copy the whole line into my lab list' : 'Copy into my lab list',
            onClick: p.onImport,
            shortcut: 'i',
            disabled: p.busy || e.factStatus === 'disputed',
            title: 'Claude read this value from the document. A copy in your own lab list can be edited; the value stays linked to its page.',
          }
        : {
            label: part ? 'Edit the whole line' : 'Edit',
            onClick: p.onEdit,
            shortcut: 'e',
            disabled: p.busy || !canEditLine,
            title: canEditLine ? (part ? 'Edit the whole line this value was read from' : 'Change the value, its range or its date') : LINE_NOT_LOADED,
          },
      virtual ? null : 'separator',
      virtual ? null : { label: part ? 'Delete the whole line…' : 'Delete…', onClick: p.onDelete, shortcut: 'Delete', danger: true, disabled: p.busy, title: part ? 'Delete the whole line this value was read from (asks first)' : 'Hide this value (asks first; it is not erased)' },
    ],
  };
}

export function LabDetail({ entry: e, busy, onEdit, onDelete, onImport, onShowTrend, onOpenSource, lineEditable, name }: LabDetailProps) {
  const testName = name?.trim() || e.analyte;
  const v = readingOf(e);
  const value = displayValue(e);
  const part = isPart(e);
  const combined = isCombined(e);
  const line = splitFromOf(e);
  const mark = readingMark(v);
  const range = rangeFact(v);
  const by = byRangeWords(v);
  const printed = asPrinted(v);
  const notes = valueNotes(v);
  const dates = dateFacts(v, e.date || e.dateText ? { iso: e.date, precision: (e.datePrecision as DatePrecision) || 'unknown', text: e.dateText } : null);
  // The lab is said with its range ("printed by Example Reference Lab"); on its own only when no range says it.
  const labSaid = Boolean(e.labName && range?.note?.includes(e.labName));
  // A value the app added from the page (the lab check, or the clinician at your request) says so: its detail carries
  // how it was added (shared labAddedNote), read from the detail itself.
  const detail = useFact(e.factId && !e.factDeleted ? e.factId : null);
  const added = detail.data && detail.data.id === e.factId ? labAddedNote(parseAttributes(detail.data)) : null;
  return (
    <DetailPane label="Lab value" className="labs-detail">
      <DetailHeader
        eyebrow={
          <>
            <SpecimenTag specimen={e.specimen} />
            <span>Lab value</span>
            {combined ? <CombinedTag /> : null}
          </>
        }
        title={
          <>
            {testName} <span className="labs-title-value">{value || '—'}{e.unit ? ` ${e.unit}` : ''}</span>
          </>
        }
        status={[
          <SourceTag key="check" source={e.source} trust={e.trust} factStatus={e.factStatus} factBasis={e.factBasis} factDeleted={e.factDeleted} notes={e.notes} />,
          e.documentId ? (
            <span key="from">
              from <SourceLink row={e} plain />
            </span>
          ) : (
            <span key="from">no source document</span>
          ),
        ]}
        actions={labDetailActions(e, { busy, onEdit, onDelete, onImport, onShowTrend, onOpenSource, lineEditable })}
        facts={[
          {
            label: valueLabel(v),
            value: (
              <span className="labs-fact">
                <span className="labs-value">
                  {value || '—'}
                  {e.unit ? <span className="labs-unit"> {e.unit}</span> : null}
                </span>
                {printed ? (
                  <span className="labs-fact-note">
                    As printed: <span className="mono">{printed}</span>
                  </span>
                ) : null}
                {notes.map((n) => (
                  <span key={n} className="labs-fact-note">
                    {n}
                  </span>
                ))}
              </span>
            ),
          },
          {
            label: 'Normal range',
            value: range ? (
              <span className="labs-fact">
                <span>
                  <span className="mono">{range.shown}</span>
                  {range.suffix ? `, ${range.suffix}` : null}
                </span>
                {range.note ? <span className="labs-fact-note">{range.note}</span> : null}
              </span>
            ) : (
              <span className="muted">No range printed with this value</span>
            ),
          },
          {
            label: flagLabel(v.role),
            value: (
              <span className="labs-fact">
                <span className="row wrap">
                  <span className="mono">{flagWords(v)}</span>
                  {mark && mark.by === 'report' ? <RangeTag mark={mark} /> : null}
                </span>
                {v.role === 'claimed' ? <span className="labs-fact-note">{CLAIM_FLAG_NOTE}</span> : null}
              </span>
            ),
            title: v.role === 'claimed' ? "The flag as this document gives it: its own claim, never counted as the lab's" : 'The flag exactly as printed beside the value',
          },
          {
            label: 'By its range',
            value: (
              <span className="row wrap">
                {mark && mark.by === 'range' ? <RangeTag mark={mark} /> : null}
                <span>{by.words}</span>
              </span>
            ),
            title: "Worked out by the app from the value and the range printed with it; never from another lab's range",
          },
          ...(dates.length
            ? dates.map((d) => ({
                label: d.label,
                value: (
                  <span className="labs-fact">
                    <DateText iso={d.date.iso} precision={d.date.precision} text={d.date.text} />
                    {d.note ? <span className="labs-fact-note">{d.note}</span> : null}
                  </span>
                ),
              }))
            : [{ label: 'Date', value: <span className="muted">not given</span> }]),
          { label: 'Sample', value: sampleWords(e.specimen) },
          v.sampleLabel ? { label: 'Sample label', value: v.sampleLabel, title: 'The label printed with the value (a tube, a time, a repeat)' } : null,
          testName !== e.analyte ? { label: 'As written', value: e.analyte, title: 'What the report calls this test' } : null,
          e.labName && !labSaid ? { label: 'Lab', value: e.labName } : null,
          e.institutionName || e.institutionId ? { label: 'Institution', value: e.institutionId ? <Link to="/people" search={{ id: e.institutionId }}>{e.institutionName ?? 'Open'}</Link> : e.institutionName } : null,
          { label: 'Entered', value: added ?? originWords(e) },
          e.notes && !/^imported from /.test(e.notes) ? { label: 'Notes', value: e.notes, wide: true } : null,
        ]}
      />

      {shownWarnings(v).length ? (
        <div className="stack tight labs-warnings">
          {shownWarnings(v).map((w) => (
            <div key={w} className="notice warn small">
              {w}
            </div>
          ))}
        </div>
      ) : null}
      <LabIssueNotices issues={e.labIssues} names={[e.analyte, testName]} />
      {line ? (
        <div className="labs-line-note">
          <LineNote entry={{ splitFrom: line }} block />
        </div>
      ) : null}
      {isSetAside(e) ? <div className="notice small">{setAsideWords(e)}</div> : null}
      {part ? <div className="notice small">{partWords(e)}</div> : null}
      {combined ? <div className="notice small">{COMBINED_TITLE}</div> : null}
      {e.factStatus === 'confirmed' && e.factBasis === 'summary' && !e.factDeleted ? (
        <div className="notice small">You have only seen this value in a summary, not the original report. The original is on your Records checklist to request.</div>
      ) : null}

      {e.factId && !e.factDeleted ? (
        <Section title="Check" intro="How this value compares with your clinical records. Give your own answer only when you know better.">
          <TrustOverride factId={e.factId} trust={e.trust} status={e.factStatus} basis={e.factBasis} reconciled />
        </Section>
      ) : null}

      <Section title="Where this came from">
        {added ? <p className="labs-added-note">{added} The app read the line on the page itself; the quote below is that line.</p> : null}
        <KeyFacts
          items={[
            { label: 'Document', value: e.documentId ? <SourceLink row={e} plain /> : <span className="muted">none</span>, wide: true },
            line ? { label: 'The line', value: <span className="small muted">{line.text}</span>, wide: true } : null,
            e.factId ? { label: 'The detail', value: <Link to="/facts" search={{ id: e.factId }}>Open it in Details from documents</Link>, wide: true } : null,
            e.factStatement ? { label: added ? 'As the app read it' : 'As Claude read it', value: <span className="small muted">{e.factStatement}</span>, wide: true } : null,
          ]}
        />
        {e.quote ? (
          <div className="stack tight">
            <blockquote className={`labs-quote${e.citationVerified ? ' verified' : ''}`}>{e.quote}</blockquote>
            <div className="row wrap small">{e.citationVerified ? <span className="muted">Found word for word on the page.</span> : <Tag tone="warn">quote not found in the page text</Tag>}</div>
          </div>
        ) : null}
        <p className="labs-added">
          Added <DateTimeText iso={e.createdAt} />
        </p>
      </Section>
    </DetailPane>
  );
}
