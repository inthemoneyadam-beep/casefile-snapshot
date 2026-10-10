/**
 * "How much was read" on the document pane (2026-10-07, large exports): whether the whole file arrived and every page
 * was stored, which pages Claude read, which were read word for word without the model (messages, notes, letters),
 * which were skipped and why, which could not be read and why, which are not read yet, the scanned pages and OCR, and
 * what the last reading found (the ingestion report). One action does what is missing: Continue reading, with what it
 * costs; above the limit in Settings Claude asks once, and "Not now" is kept.
 *
 * The lab check (2026-10-08): the app's own reading of every lab result line on the pages Claude read, compared with the
 * lab values on file ("Lab check: 412 lab lines found; 3 missed on pp.12, 88, 240: read again; 1 added from the
 * page"), with the pages as links, the lines it added or still misses, and "Read these pages again" (exactly those
 * pages, even when they were read before).
 *
 * 2026-10-09 (lab recall): when reading those pages again costs more than the limit in Settings, Claude asks once, here
 * (the document's reading question, kind labcheck): "Read them again" says yes at the cost shown; "Not now" adds the
 * lines from the page as printed, without Claude. Pages whose lines the app would not add by itself are listed with why.
 *
 * Shown for every document with a gap, a problem, a report, a lab line missed or added, or more than 24 pages; a
 * short finished document says it all in its status line and shows nothing here.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { KeyFacts, type KeyFact } from '../../ui/DetailPane';
import { MoreMenu } from '../../ui/Menu';
import { Section } from '../../ui/PageHeader';
import { useToast } from '../../ui/Toast';
import { useBindings } from '../../app/shortcuts';
import { useRegisterCommands } from '../../app/commands';
import { useMe } from '../../api/users';
import { reprocessWords, useApproveResume, useDeclineResume, useDocumentCoverage, useDocumentOutline, useReprocessDocuments, useResumeReading, type CoverageResponse, type DocumentCoverage, type OutlineEntry } from '../../api/documents';
import { labCheckWords, type LabCheckReport, type LabCheckWords } from '@shared/labcheck';
import { formatBytes, formatPageRanges, pagesToRanges, type IngestionReport } from '@shared/schemas/segments';
import type { PageCoverageState } from '@shared/enums';
import { patientFact } from '../patient-check/words';
import { PAGE_STATE_WORDS, SKIP_WORDS, count, dollars, hasGaps, pages, pagesIn, rangesInState, rangesWords } from './coverage';
// Checked against itself (2026-10-09): its line sits in this panel (features/self-check).
import { useDocumentSelfCheck, type DocumentSelfCheck } from '../../api/self-check';
import { SelfCheckBlock } from '../self-check/SelfCheckBlock';
import { selfCheckWorthShowing } from '../self-check/words';

/** When the section shows: a gap, a problem, a report, a question waiting, or a long document. */
export function coverageWorthShowing(d: CoverageResponse | null | undefined, pageCount: number): boolean {
  if (!d) return false;
  const c = d.coverage;
  const lab = c?.labCheck;
  return Boolean(hasGaps(c) || d.confirmation.problems.length || c?.report || c?.resume?.decision === 'ask' || c?.state === 'running' || pageCount > 24 || d.confirmation.stage === 'failed' || (lab && (lab.missed > 0 || lab.addedCount > 0 || lab.firstMissed)));
}

/** `keys`: bind c (Continue reading) and register the commands; off where c already means something else. */
export function CoverageSection({ documentId, pageCount, onOpenPage, keys = true }: { documentId: string; pageCount: number; onOpenPage?: (page: number) => void; keys?: boolean }) {
  const q = useDocumentCoverage(documentId);
  const sc = useDocumentSelfCheck(documentId);
  const d = q.data;
  if (!d || (!coverageWorthShowing(d, pageCount) && !selfCheckWorthShowing(sc.data))) return null;
  return <CoverageBody documentId={documentId} data={d} onOpenPage={onOpenPage} keys={keys} selfCheck={sc.data ?? null} />;
}

function CoverageBody({ documentId, data, onOpenPage, keys, selfCheck }: { documentId: string; data: CoverageResponse; onOpenPage?: (page: number) => void; keys: boolean; selfCheck?: DocumentSelfCheck | null }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const resume = useResumeReading();
  const decline = useDeclineResume();
  const approve = useApproveResume();
  const reread = useReprocessDocuments();
  // Above the limit in Settings the first press is told the cost; the next press says yes to it.
  const [confirmPages, setConfirmPages] = useState(false);
  const cov = data.coverage;
  const conf = data.confirmation;
  const est = data.estimate;
  const asking = cov?.resume?.decision === 'ask';
  // The question is the lab check's: read again the pages where lab lines have no value (2026-10-09).
  const labAsk = asking && cov?.resume?.kind === 'labcheck';
  const labCost = labAsk && cov?.resume ? dollars(cov.resume.estimateUsd) : '';
  const running = cov?.state === 'running' || conf.stage === 'analysing';
  const gaps = hasGaps(cov);
  const canContinue = canWrite && gaps && !running;
  const cost = est ? dollars(est.approxUsd) : asking && cov?.resume ? dollars(cov.resume.estimateUsd) : '';

  function run(scope: 'missing' | 'failed' | 'whole', confirm = asking) {
    if (resume.isPending) return;
    resume.mutate(
      { id: documentId, scope, confirm },
      {
        onSuccess: (r) => toast(r.askFirst.length && !r.queued.length ? `This costs more than your limit (${dollars(r.askFirst[0].estimateUsd)}); say Continue reading again to go ahead.` : reprocessWords(r), r.queued.length ? 'ok' : 'info'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad'),
      },
    );
  }

  const lab = cov?.labCheck ?? null;
  const labWords = lab ? labCheckWords(lab) : null;
  const missingPages = labWords?.stillMissing ?? [];
  const canReread = canWrite && missingPages.length > 0 && !running && !labAsk;
  function approveLabReread() {
    if (approve.isPending) return;
    approve.mutate(documentId, {
      onSuccess: () => toast('Claude is reading those pages again, a few at a time; lines it still misses are added from the page', 'ok'),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad'),
    });
  }
  function declineQuestion() {
    if (decline.isPending) return;
    decline.mutate(documentId, {
      onSuccess: () => toast(labAsk ? 'The lines were added from the page as printed (pages that looked wrong are listed); Claude will not read those pages again by itself' : 'Claude will not read the rest until you ask', 'ok'),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not answer', 'bad'),
    });
  }
  function readPagesAgain() {
    if (reread.isPending || !missingPages.length) return;
    reread.mutate(
      { documentIds: [documentId], scope: 'pages', pages: pagesToRanges(missingPages).slice(0, 200), requestedBy: 'user', reason: 'lab lines the lab check found missing', confirmAboveCeiling: confirmPages },
      {
        onSuccess: (r) => {
          if (r.askFirst.length && !r.queued.length) {
            setConfirmPages(true);
            toast(`Reading them again costs ${dollars(r.askFirst[0].estimateUsd)}, above your limit; press Read these pages again once more to go ahead.`, 'info');
          } else {
            setConfirmPages(false);
            toast(reprocessWords(r), r.queued.length ? 'ok' : 'info');
          }
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad'),
      },
    );
  }

  useBindings(keys ? [{ keys: 'c', description: 'Continue reading this document (the pages not read yet)', group: 'Documents', when: () => canContinue, run: () => run('missing') }] : [], [documentId, canContinue, asking, resume.isPending, keys]);
  useRegisterCommands(
    [
      { id: 'documents.coverage.continue', title: `Continue reading this document${cost ? ` (${cost})` : ''}`, group: 'Documents', shortcut: keys ? 'c' : undefined, keywords: 'resume read rest missing pages partial coverage', when: () => canContinue, run: () => run('missing') },
      { id: 'documents.coverage.failed', title: 'Read the parts that could not be read again', group: 'Documents', keywords: 'failed retry parts coverage', when: () => canWrite && Boolean(cov?.pagesFailed) && !running, run: () => run('failed', true) },
      { id: 'documents.coverage.notnow', title: labAsk ? 'Not now: add the missed lab lines from the page, without Claude' : 'Not now: do not read the rest of this document', group: 'Documents', keywords: 'decline resume later lab check', when: () => canWrite && asking, run: declineQuestion },
      { id: 'documents.coverage.labask', title: `Read again the pages with missed lab lines${labCost ? ` (${labCost})` : ''}`, group: 'Documents', keywords: 'lab check missed lines yes approve reread', when: () => canWrite && labAsk && !running, run: approveLabReread },
      { id: 'documents.coverage.labcheck', title: `Read these pages again: the lab lines missed on ${missingPages.length === 1 ? 'p.' : 'pp.'}${missingPages.slice(0, 8).join(', ')}`, group: 'Documents', keywords: 'lab check missed lines values reread pages again', when: () => canReread, run: readPagesAgain },
    ],
    [documentId, canContinue, canWrite, asking, labAsk, labCost, running, cov?.pagesFailed, cost, canReread, missingPages.join(','), confirmPages],
  );

  const facts = coverageFacts(data);
  if (labWords) facts.push(labCheckFact(labWords, onOpenPage));
  const actions: ReactNode = canWrite ? (
    <>
      {canContinue ? (
        <Button size="sm" variant="accent" shortcut={keys ? 'c' : undefined} disabled={resume.isPending} onClick={() => run('missing')} title="Claude reads the pages not read yet, from where it stopped; details you checked are kept">
          Continue reading{cost ? ` (${cost})` : ''}
        </Button>
      ) : null}
      {labAsk ? (
        <Button size="sm" variant={canContinue ? 'default' : 'accent'} disabled={approve.isPending || running} onClick={approveLabReread} title="Claude reads again only the pages where lab lines have no value, a few pages at a time, naming each line; details you checked are kept">
          Read them again{labCost ? ` (${labCost})` : ''}
        </Button>
      ) : null}
      {asking ? (
        <Button size="sm" variant="ghost" disabled={decline.isPending} onClick={declineQuestion} title={labAsk ? 'The app adds the lines from the page as printed, without Claude (a page that looks wrong is left out and listed)' : undefined}>
          Not now
        </Button>
      ) : null}
      {canReread ? (
        <Button size="sm" variant={canContinue ? 'default' : 'accent'} disabled={reread.isPending} onClick={readPagesAgain} title="Claude reads exactly the pages with lab lines no value holds, even though they were read before; details you checked are kept">
          Read these pages again
        </Button>
      ) : null}
      <MoreMenu
        size="sm"
        items={[
          cov?.pagesFailed ? { label: 'Read the parts that could not be read again', onClick: () => run('failed', true), disabled: running, title: 'Only the parts that failed; everything else stays as it is' } : null,
          { label: 'Read every page again', onClick: () => run('whole', true), disabled: running, title: 'Claude reads the whole document again; details you checked or edited are kept' },
        ]}
      />
    </>
  ) : null;

  return (
    <Section title="How much was read" actions={actions} intro={conf.sentence} className="doc-coverage">
      {labAsk && cov?.resume ? (
        <p className="doc-coverage-ask">
          Claude asks first: the lab check found {count(cov.resume.rows ?? 0)} lab {cov.resume.rows === 1 ? 'line' : 'lines'} no value holds. Reading those {pages(cov.resume.pagesLeft)} again costs about {dollars(cov.resume.estimateUsd)}
          {cov.resume.calls ? ` in ${count(cov.resume.calls)} small calls` : ''}; your limit for a reading by itself is ${cov.resume.ceilingUsd.toFixed(2)} (Settings, Advanced). Not now adds the lines from the page as printed, without Claude.
        </p>
      ) : asking && cov?.resume ? (
        <p className="doc-coverage-ask">
          Claude stopped and asks first: reading the other {pages(cov.resume.pagesLeft)} costs {dollars(cov.resume.estimateUsd)}, above your limit of ${cov.resume.ceilingUsd.toFixed(2)} (Settings, Advanced).
        </p>
      ) : null}
      {cov && cov.pagesTotal ? <PageStrip cov={cov} onOpenPage={onOpenPage} /> : null}
      <KeyFacts items={facts} />
      {lab ? <LabCheckLines report={lab} onOpenPage={onOpenPage} /> : null}
      {selfCheck && selfCheckWorthShowing(selfCheck) ? <SelfCheckBlock data={selfCheck} /> : null}
      {conf.problems.length ? (
        <ul className="doc-coverage-problems">
          {conf.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {cov?.report ? <ReportBlock report={cov.report} /> : null}
      <OutlineBlock documentId={documentId} onOpenPage={onOpenPage} />
    </Section>
  );
}

/** The key facts: the file, then each kind of page with its ranges. */
export function coverageFacts(data: CoverageResponse): KeyFact[] {
  const cov = data.coverage;
  const conf = data.confirmation;
  const up = data.upload;
  const out: KeyFact[] = [];
  const total = conf.pagesInFile ?? conf.pagesStored;
  out.push({
    label: 'The file',
    wide: true,
    value: up
      ? `${formatBytes(up.bytesReceived)} arrived${up.readBackOk === false ? '; the stored copy does not match' : up.readBackOk ? ' and were checked' : ''}; ${up.pagesInFile != null && up.pagesInFile !== up.pagesStored ? `${count(up.pagesStored)} of its ${pages(up.pagesInFile)} stored` : `all ${pages(up.pagesStored)} stored`}`
      : `${pages(total)} stored`,
  });
  // The wrong-patient guard (2026-10-09): "Patient not confirmed on document" (or confirmed) on the upload record.
  const patient = patientFact(data.patient ?? null);
  if (patient) out.push({ label: 'Patient', wide: true, value: patient });
  if (!cov || !cov.pagesTotal) return out;
  const read = rangesInState(cov, ['done']);
  if (read.length) out.push({ label: 'Read by Claude', wide: true, value: `${rangesWords(read)} (${pages(pagesIn(read))})` });
  const parsed = rangesInState(cov, ['parsed']);
  if (parsed.length) out.push({ label: 'Read word for word', wide: true, value: `${pages(pagesIn(parsed))} of messages, notes or letters, read without the model (${rangesWords(parsed, 4)})` });
  const skips = (['duplicate', 'boilerplate', 'blank', 'no_text'] as const)
    .map((k) => ({ k, n: cov.pagesSkipped[k] }))
    .filter((x) => x.n)
    .map((x) => `${count(x.n)} ${SKIP_WORDS[x.k][x.n === 1 ? 0 : 1]}`);
  if (skips.length) out.push({ label: 'Skipped', wide: true, value: skips.join('; ') });
  if (cov.pagesFailed) {
    const reasons = cov.failures.slice(0, 3).map((f) => `${formatPageRanges([f.pages])}: ${f.reason.replace(/^could not be read:\s*/i, '')}`);
    out.push({ label: 'Could not be read', wide: true, value: `${pages(cov.pagesFailed)}${reasons.length ? ` (${reasons.join('; ')}${cov.failures.length > 3 ? `; and ${cov.failures.length - 3} more` : ''})` : ''}` });
  }
  const running = rangesInState(cov, ['running']);
  if (running.length) out.push({ label: 'Being read now', wide: true, value: `${rangesWords(running)} (${pages(pagesIn(running))})` });
  const pending = rangesInState(cov, ['pending']);
  if (pending.length) out.push({ label: 'Not read yet', wide: true, value: `${pages(pagesIn(pending))} (${rangesWords(pending)})` });
  const scans = Math.max(cov.pagesImage, cov.pagesOcr);
  if (scans) out.push({ label: 'Scanned pages', value: cov.pagesOcr >= scans ? `${count(scans)}, read by OCR` : `${count(scans)}; ${count(cov.pagesOcr)} read by OCR` });
  if (cov.basis === 'legacy') out.push({ label: 'Worked out', wide: true, value: 'from an earlier reading, before documents were read part by part' });
  return out;
}

/** The pages as one thin strip, coloured by state, with the words in a legend (colour never carries meaning alone). */
function PageStrip({ cov, onOpenPage }: { cov: DocumentCoverage; onOpenPage?: (page: number) => void }) {
  const runs = cov.ranges;
  const present = useMemo(() => [...new Set(runs.map((r) => r[2]))] as PageCoverageState[], [runs]);
  return (
    <div className="doc-strip-wrap">
      <div className="doc-strip" role="img" aria-label={present.map((s) => `${PAGE_STATE_WORDS[s]}: ${formatPageRanges(rangesInState(cov, [s]).slice(0, 6))}`).join('; ')}>
        {runs.map(([a, b, s]) => (
          <button
            type="button"
            key={`${a}-${b}`}
            className={`doc-strip-run s-${s}`}
            style={{ flexGrow: b - a + 1 }}
            title={`${a === b ? `Page ${a}` : `Pages ${a}-${b}`}: ${PAGE_STATE_WORDS[s].toLowerCase()}`}
            tabIndex={-1}
            onClick={() => onOpenPage?.(a)}
          />
        ))}
      </div>
      <div className="doc-strip-legend">
        {present.map((s) => (
          <span key={s} className="doc-strip-key">
            <i className={`doc-strip-swatch s-${s}`} aria-hidden="true" />
            {PAGE_STATE_WORDS[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A page number that opens the page (or plain text where the pane cannot open pages). */
function PageLink({ page, onOpenPage }: { page: number; onOpenPage?: (page: number) => void }) {
  if (!onOpenPage) return <span className="mono">p.{page}</span>;
  return (
    <a
      href={`#p${page}`}
      className="mono"
      onClick={(ev) => {
        ev.preventDefault();
        onOpenPage(page);
      }}
    >
      p.{page}
    </a>
  );
}

/** At most this many lines of each kind are listed (the rest are counted). */
const LAB_LINES_SHOWN = 30;

/**
 * The lab check (2026-10-08) as a key fact beside how much was read: its sentence (the shared labCheckWords, never
 * rebuilt here) and the pages it names, each a link to the page.
 */
export function labCheckFact(words: LabCheckWords, onOpenPage?: (page: number) => void): KeyFact {
  return {
    label: 'Lab check',
    wide: true,
    value: (
      <span className="doc-labcheck-fact" aria-live="polite">
        <span className="doc-labcheck-line">{words.line.replace(/^Lab check:\s*/, '')}</span>
        {words.pages.length ? (
          <span className="doc-labcheck-pages small">
            <span className="muted">{words.pages.length === 1 ? 'The page:' : 'The pages:'}</span>{' '}
            {words.pages.map((p, i) => (
              <span key={p}>
                {i ? ', ' : ''}
                <PageLink page={p} onOpenPage={onOpenPage} />
              </span>
            ))}
          </span>
        ) : null}
      </span>
    ),
  };
}

/** The lines the lab check added from the page or still misses, folded: each as printed, with its page. */
function LabCheckLines({ report: r, onOpenPage }: { report: LabCheckReport; onOpenPage?: (page: number) => void }) {
  const lines = r.added.length + r.missedRows.length;
  const shownMissed = Math.min(LAB_LINES_SHOWN, r.missedRows.length);
  const held = r.heldBack ?? [];
  if (!lines && !r.deletedByYou && !r.notes.length && !held.length) return null;
  return (
    <div className="doc-labcheck">
      {/* Why nothing was done by itself (too many lines looked missed to act alone): the user's call. */}
      {r.notes.map((n, i) => (
        <p key={`n-${i}`} className="small text-warn">
          {n} Read the pages again yourself if the lines are real.
        </p>
      ))}
      {/* Pages whose lines the app would not add by itself (its sanity test, 2026-10-09): the page and why. */}
      {held.length ? (
        <details className="doc-labcheck-rows">
          <summary>
            Lines not added by themselves ({count(held.reduce((n, h) => n + h.rows, 0))} on {held.length === 1 ? 'one page' : `${count(held.length)} pages`})
          </summary>
          <ul>
            {held.slice(0, LAB_LINES_SHOWN).map((h) => (
              <li key={`h-${h.page}`}>
                <PageLink page={h.page} onOpenPage={onOpenPage} /> <span className="text-warn">{count(h.rows)} {h.rows === 1 ? 'line' : 'lines'}</span>
                <span className="muted"> · {h.reason}. Check the page; the clinician can add a line you name from it.</span>
              </li>
            ))}
            {held.length > LAB_LINES_SHOWN ? <li className="muted">and {count(held.length - LAB_LINES_SHOWN)} more pages</li> : null}
          </ul>
        </details>
      ) : null}
      {lines ? (
        <details className="doc-labcheck-rows">
          <summary>
            The lab lines it {r.added.length && r.missedRows.length ? 'added and still misses' : r.added.length ? 'added from the page' : 'still misses'} ({count(lines)})
          </summary>
          <ul>
            {r.added.slice(0, LAB_LINES_SHOWN).map((a) => (
              <li key={`a-${a.factId}`}>
                <PageLink page={a.page} onOpenPage={onOpenPage} /> <span className="mono">{a.text}</span>
                {a.undone ? (
                  <span className="muted"> · taken back with Undo; it is not added again</span>
                ) : (
                  <>
                    <span className="muted"> · added {a.by === 'clinician' ? 'by the clinician at your request' : 'by the lab check'} · </span>
                    <Link to="/labs" search={{ id: `fact:${a.factId}` }}>
                      see it in Labs
                    </Link>
                  </>
                )}
              </li>
            ))}
            {r.added.length > LAB_LINES_SHOWN ? <li className="muted">and {count(r.added.length - LAB_LINES_SHOWN)} more added</li> : null}
            {r.missedRows.slice(0, LAB_LINES_SHOWN).map((m, i) => (
              <li key={`m-${m.page}-${i}`}>
                <PageLink page={m.page} onOpenPage={onOpenPage} /> <span className="mono">{m.text}</span>
                <span className="text-warn"> · still missing</span>
              </li>
            ))}
            {r.missed > shownMissed ? <li className="muted">and {count(r.missed - shownMissed)} more still missing</li> : null}
          </ul>
          {r.deletedByYou ? (
            <p className="small muted">
              {count(r.deletedByYou)} {r.deletedByYou === 1 ? 'line is' : 'lines are'} left alone because you deleted the value that held {r.deletedByYou === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/** What the last reading found (written by the communications side after each reading). */
function ReportBlock({ report: r }: { report: IngestionReport }) {
  const kinds = Object.entries(r.communications.byKind).filter(([, n]) => n);
  const KIND_WORDS: Record<string, [string, string]> = {
    portal_message: ['portal message', 'portal messages'],
    telephone_encounter: ['telephone note', 'telephone notes'],
    appointment_request: ['appointment message', 'appointment messages'],
    questionnaire: ['questionnaire', 'questionnaires'],
    letter: ['letter', 'letters'],
    patient_entered_data: ['entry you made', 'entries you made'],
    email: ['email', 'emails'],
    call_record: ['call record', 'call records'],
  };
  const items: ReactNode[] = [];
  if (r.communications.created || r.communications.updated)
    items.push(
      <>
        {count(r.communications.created)} call{r.communications.created === 1 ? '' : 's'} and messages added to <Link to="/communications" search={{ view: 'threads' }}>Calls and messages</Link>
        {kinds.length ? ` (${kinds.map(([k, n]) => `${count(n)} ${(KIND_WORDS[k] ?? [k, k])[n === 1 ? 0 : 1]}`).join(', ')})` : ''}
        {r.communications.updated ? `; ${count(r.communications.updated)} updated` : ''}
      </>,
    );
  if (r.threads.total) items.push(`${count(r.threads.total)} conversation${r.threads.total === 1 ? '' : 's'}${r.threads.mergedWithFiled.length ? `; ${count(r.threads.mergedWithFiled.length)} joined with a copy you filed separately` : ''}`);
  if (r.people.created.length) items.push(`${count(r.people.created.length)} ${r.people.created.length === 1 ? 'person' : 'people'} added to People and places`);
  if (r.people.suggested.length)
    items.push(
      <>
        {count(r.people.suggested.length)} name{r.people.suggested.length === 1 ? '' : 's'} that may be someone already listed: <Link to="/people">check them on People and places</Link> (nothing is merged without you)
      </>,
    );
  if (r.gaps.closed.length) items.push(`${count(r.gaps.closed.length)} missing record${r.gaps.closed.length === 1 ? '' : 's'} now held (${r.gaps.closed.slice(0, 3).map((g) => g.title).join('; ')}${r.gaps.closed.length > 3 ? '; …' : ''})`);
  if (r.gaps.heldRowsCreated) items.push(`${count(r.gaps.heldRowsCreated)} visit${r.gaps.heldRowsCreated === 1 ? '' : 's'} listed on the Records checklist as held here`);
  if (r.trust.passagesBelowDocument) items.push(`${count(r.trust.passagesBelowDocument)} passage${r.trust.passagesBelowDocument === 1 ? ' is' : 's are'} your own words inside this record, so ${r.trust.passagesBelowDocument === 1 ? 'it counts' : 'they count'} as yours, not as the record's${r.trust.changed ? ` (${count(r.trust.changed)} changed this time)` : ''}`);
  if (r.medications.filed || r.medications.conflicts) items.push(`${count(r.medications.filed)} medication${r.medications.filed === 1 ? '' : 's'} filed${r.medications.conflicts ? `; ${count(r.medications.conflicts)} disagree with another record` : ''}`);
  // This document's findings; the run itself checks the whole case, whose totals are said apart (rev-comms #13).
  const caseNew = r.findings.caseNew ?? null;
  const caseCleared = r.findings.caseCleared ?? null;
  const caseWide = caseNew !== null && caseCleared !== null && (caseNew !== r.findings.new || caseCleared !== r.findings.cleared) && (caseNew || caseCleared);
  if (r.findings.new || r.findings.cleared || caseWide)
    items.push(
      `What Claude noticed about this document: ${count(r.findings.new)} new, ${count(r.findings.cleared)} cleared${caseWide ? ` (across the whole case: ${count(caseNew ?? 0)} new, ${count(caseCleared ?? 0)} cleared)` : ''}`,
    );
  for (const n of r.notes.slice(0, 6)) items.push(n);
  if (!items.length) return null;
  return (
    <div className="doc-coverage-report">
      <div className="doc-coverage-subhead">What reading it found</div>
      <ul>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

const OUTLINE_SHOWN = 40;

/** A visit's state in a word or two (the column is narrow; the full words are on hover). */
const OUTLINE_STATE_WORDS: Record<PageCoverageState, string> = {
  done: 'read',
  parsed: 'word for word',
  skipped: 'skipped',
  no_text: 'nothing readable',
  failed: 'could not be read',
  running: 'reading now',
  pending: 'not read yet',
};

/** The visits and sections of an export, folded until opened. */
function OutlineBlock({ documentId, onOpenPage }: { documentId: string; onOpenPage?: (page: number) => void }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const q = useDocumentOutline(documentId, open);
  useEffect(() => {
    setOpen(false);
    setAll(false);
  }, [documentId]);
  const entries = q.data ?? [];
  const many = entries.length > 1;
  return (
    <details className="doc-outline" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>What it holds, visit by visit</summary>
      {!open ? null : q.isPending ? (
        <p className="muted small">Loading the outline…</p>
      ) : !many ? (
        <p className="muted small">This document is read as one piece; it has no visits or sections of its own.</p>
      ) : (
        <>
          <table className="doc-subtable doc-outline-table">
            <thead>
              <tr>
                <th>Pages</th>
                <th>Date</th>
                <th>Visit</th>
                <th>Read</th>
                <th className="num">Details</th>
                <th className="num">Messages</th>
              </tr>
            </thead>
            <tbody>
              {(all ? entries : entries.slice(0, OUTLINE_SHOWN)).map((e) => (
                <OutlineRow key={e.encounterKey} e={e} onOpenPage={onOpenPage} />
              ))}
            </tbody>
          </table>
          {entries.length > OUTLINE_SHOWN ? (
            <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
              {all ? `Show the first ${OUTLINE_SHOWN}` : `Show all ${count(entries.length)}`}
            </Button>
          ) : null}
        </>
      )}
    </details>
  );
}

function OutlineRow({ e, onOpenPage }: { e: OutlineEntry; onOpenPage?: (page: number) => void }) {
  const what = e.type ? `${e.type}${e.department ? ` in ${e.department}` : ''}` : (e.headerText ?? 'Patient details');
  return (
    <tr>
      <td className="mono">
        {onOpenPage ? (
          <a
            href={`#p${e.pageStart}`}
            onClick={(ev) => {
              ev.preventDefault();
              onOpenPage(e.pageStart);
            }}
          >
            {e.pageStart === e.pageEnd ? e.pageStart : `${e.pageStart}-${e.pageEnd}`}
          </a>
        ) : e.pageStart === e.pageEnd ? (
          e.pageStart
        ) : (
          `${e.pageStart}-${e.pageEnd}`
        )}
      </td>
      <td className="mono">{e.dateText ?? e.date ?? ''}</td>
      <td className="wrap">
        {what}
        {e.number ? <span className="muted"> · encounter {e.number}</span> : null}
      </td>
      <td className="doc-outline-state">
        <span className={e.state === 'failed' ? 'text-bad' : e.state === 'pending' || e.state === 'running' ? 'muted' : undefined} title={PAGE_STATE_WORDS[e.state as PageCoverageState]}>
          {OUTLINE_STATE_WORDS[e.state as PageCoverageState] ?? e.state}
        </span>
      </td>
      <td className="num">{e.factsCount || ''}</td>
      <td className="num">{e.messagesCount || ''}</td>
    </tr>
  );
}
