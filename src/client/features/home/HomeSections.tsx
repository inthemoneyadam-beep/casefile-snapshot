/**
 * Home's sections, in the order the page shows them:
 *
 *   WaitingSection   what needs you, full width: each line says what and why,
 *                    with its one button (Sort them now, File them now, Settle
 *                    it, Review); then, apart and calm, what is only for your
 *                    information (details the clinical record overruled)
 *   ComingUpSection  appointments, to-dos due and promised follow-ups; when
 *                    there are none, the buttons to add them
 *   RecentSection    the documents added last, by the day they were added,
 *                    each with its own date (the document's) and type
 *   AskBox           a question for the clinician (the dock opens beside the page)
 *   DropStrip        a slim strip to add documents (drop anywhere, or choose)
 *
 * Every row is a link or holds one button, marked data-home-row so j / k on the
 * page move the focus through them (routes/index.tsx).
 */
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { reprocessWords, useDocuments, useReprocessDocuments } from '../../api/documents';
import { backlogMessage, documentTypeLabel, useFileBacklog, usePendingCounts, useUnsorted } from '../../api/filing';
import { useMe } from '../../api/users';
import { listCommands } from '../../app/commands';
import { dock } from '../../app/dock';
import { Button } from '../../ui/Button';
import { DateText } from '../../ui/DateText';
import { Loading, Section } from '../../ui/PageHeader';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { prefill } from '../ask/live';
import { documentStatus } from '../documents/status';
import { coverageOf, dollars } from '../documents/coverage';
import { AddDocumentsButton, useAddDocuments } from '../filing/Filing';
import { comingUp, groupByAddedDay, localDay, waitingLines } from './words';
import { useHoldUnheld, usePatientCheck } from '../../api/patient-check';
import { HELD_EXPLAIN, heldCountWords, missingWords, unheldWords } from '../patient-check/words';
import { useCareComingUp } from '../../api/care-team';
import { withCareTeam } from '../care-team/coming-up';

export interface TodayPayload {
  date: string;
  tasksDue: Array<{ id: string; title: string; dueAt: string | null; owner: string; ownerName?: string | null; status: string; priority: string }>;
  followUpsDue: Array<{ id: string; subject: string; followUpPromised: string | null; followUpDue: string | null; withWhom: string }>;
  upcomingEncounters: Array<{ id: string; title: string; occurredAt: string | null; occurredAtPrecision: string; clinician: string | null }>;
  pendingVerification: number;
  pendingMerges: number;
  openGaps: number;
  newFindings: number;
  recentDocuments: Array<{ id: string; title: string; createdAt: string; textStatus: string; extractionStatus: string }>;
  hardStops: Array<{ id: string; substance: string; reaction: string | null }>;
}

export function useToday() {
  return useQuery({ queryKey: ['today'], queryFn: () => api.get<TodayPayload>('/api/system/today'), refetchInterval: 30_000 });
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** One line that needs you: a dot, what and why, and the one thing to do. */
function WaitingRow({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <li className="home-waiting-row">
      <span className="home-dot" aria-hidden />
      <span className="home-row-words">{children}</span>
      <span className="home-row-action">{action}</span>
    </li>
  );
}

/**
 * Long documents read only in part (2026-10-07): the ones that wait for your go-ahead to read the rest (above your
 * limit in Settings, Claude asks once), and the ones that stopped part way. Worked out from each document's coverage.
 */
function useReadingWaits() {
  const docs = useDocuments({});
  return useMemo(() => {
    const ask: Array<{ id: string; usd: number; lab: boolean }> = [];
    let partial = 0;
    for (const d of docs.data?.items ?? []) {
      const cov = coverageOf(d);
      const st = documentStatus(d);
      if (cov?.resume?.decision === 'ask' && !st.busy) ask.push({ id: d.id, usd: cov.resume.estimateUsd, lab: cov.resume.kind === 'labcheck' });
      else if (st.partial && !st.busy) partial++;
    }
    return { ask, partial };
  }, [docs.data]);
}

export function WaitingSection() {
  const counts = usePendingCounts();
  const reading = useReadingWaits();
  const reprocess = useReprocessDocuments();
  const unsorted = useUnsorted();
  const backlog = useFileBacklog();
  const toast = useToast();
  const navigate = useNavigate();
  const canWrite = useMe().canWrite;
  // The wrong-patient guard (2026-10-09): documents held back, Patient details still to fill, or a check of the whole
  // case that held nothing because most of it named someone else.
  const patientCheck = usePatientCheck();
  const holdUnheld = useHoldUnheld();
  const pc = patientCheck.data?.summary;
  const heldN = pc?.held ?? 0;
  const unheldN = pc?.unheld ?? 0;
  const missing = pc?.missing ?? [];
  const c = counts.data ? { ...counts.data, inbox: Math.max(0, counts.data.inbox - (counts.data.patient ?? 0)) } : counts.data;
  const unsortedItems = unsorted.data?.items ?? [];
  const notSorted = unsortedItems.filter((u) => !u.sorting).length;
  const sorting = unsortedItems.length - notSorted;
  const unfiled = canWrite ? (c?.unfiled ?? 0) : 0;
  const lines = waitingLines(c);
  const inaccurate = c?.inaccurate ?? 0;
  const runBacklog = (done: string) =>
    backlog.mutate(undefined, {
      onSuccess: (r) => toast(backlogMessage(r), r.aiOff ? 'bad' : 'ok'),
      onError: (err) => toast(errText(err, done), 'bad'),
    });
  const askUsd = reading.ask.reduce((n, a) => n + a.usd, 0);
  const rows = (heldN ? 1 : 0) + (missing.length ? 1 : 0) + (unheldN ? 1 : 0) + (notSorted || sorting ? 1 : 0) + (unfiled ? 1 : 0) + lines.length + (reading.ask.length ? 1 : 0) + (reading.partial ? 1 : 0);
  const anything = rows > 0;

  return (
    <Section title="Waiting for you" count={rows || undefined} className="home-waiting">
      {counts.isPending ? (
        <Loading>Checking what is waiting…</Loading>
      ) : anything ? (
        <ul className="home-rows">
          {heldN ? (
            <WaitingRow
              action={
                <Button size="sm" variant="accent" data-home-row="" onClick={() => void navigate({ to: '/inbox', search: { view: 'patient' } })} title="Opens Check before filing, with It's mine and Not my record">
                  Review
                </Button>
              }
            >
              <strong>{heldCountWords(heldN)}</strong> {HELD_EXPLAIN}
            </WaitingRow>
          ) : null}
          {missing.length ? (
            <WaitingRow
              action={
                <Button size="sm" data-home-row="" onClick={() => void navigate({ to: '/settings' })} title="Opens Settings, Patient details">
                  Open Settings
                </Button>
              }
            >
              <strong>Patient details are not filled in.</strong> {missingWords(missing)}
            </WaitingRow>
          ) : null}
          {unheldN ? (
            <WaitingRow
              action={
                <span className="row">
                  <Button size="sm" data-home-row="" onClick={() => void navigate({ to: '/settings' })} title="Opens Settings, Patient details">
                    Open Settings
                  </Button>
                  {canWrite ? (
                    <Button size="sm" variant="ghost" data-home-row="" disabled={holdUnheld.isPending} onClick={() => holdUnheld.mutate(undefined, { onSuccess: (r) => toast(`${r.held} held back.`, 'ok'), onError: (err) => toast(errText(err, 'Could not hold them back'), 'bad') })} title="Hold them back as May be someone else's record, to answer one by one">
                      Hold them back
                    </Button>
                  ) : null}
                </span>
              }
            >
              <strong>{unheldWords(unheldN)}</strong>
            </WaitingRow>
          ) : null}
          {notSorted || sorting ? (
            <WaitingRow
              action={
                canWrite && notSorted ? (
                  <Button size="sm" variant="accent" data-home-row="" disabled={backlog.isPending} onClick={() => runBacklog('Could not start sorting')} title="Claude names, types and files every document it has not sorted yet; each placement can be undone on its document">
                    {backlog.isPending ? 'Starting…' : 'Sort them now'}
                  </Button>
                ) : (
                  <Button size="sm" data-home-row="" onClick={() => void navigate({ to: '/documents', search: { show: 'unsorted' } })}>
                    Show them
                  </Button>
                )
              }
            >
              {notSorted ? (
                <>
                  <strong>
                    {notSorted} document{notSorted === 1 ? '' : 's'} not sorted yet.
                  </strong>{' '}
                  Claude has not named or filed {notSorted === 1 ? 'it' : 'them'}, usually because {notSorted === 1 ? 'it was' : 'they were'} added while the API key was not working.
                </>
              ) : null}
              {sorting ? <span className="muted"> Claude is sorting {sorting} now…</span> : null}
            </WaitingRow>
          ) : null}
          {unfiled ? (
            <WaitingRow
              action={
                <Button size="sm" variant="accent" data-home-row="" disabled={backlog.isPending} onClick={() => runBacklog('Could not file them')} title="Files each one where Claude's naming put it; each placement can be undone on its document">
                  {backlog.isPending ? 'Filing…' : 'File them now'}
                </Button>
              }
            >
              <strong>
                {unfiled} document{unfiled === 1 ? ' was' : 's were'} named but not filed.
              </strong>{' '}
              Claude named {unfiled === 1 ? 'it' : 'them'}, but the filing did not finish.
            </WaitingRow>
          ) : null}
          {reading.ask.length ? (
            <WaitingRow
              action={
                canWrite ? (
                  <Button
                    size="sm"
                    variant="accent"
                    data-home-row=""
                    disabled={reprocess.isPending}
                    title="Claude reads the pages not read yet; details you checked are kept"
                    onClick={() =>
                      reprocess.mutate(
                        { documentIds: reading.ask.map((a) => a.id), scope: 'missing', requestedBy: 'user', confirmAboveCeiling: true },
                        { onSuccess: (r) => toast(reprocessWords(r), 'ok'), onError: (err) => toast(errText(err, 'Could not start'), 'bad') },
                      )
                    }
                  >
                    {reprocess.isPending ? 'Starting…' : `Continue reading (${dollars(askUsd)})`}
                  </Button>
                ) : (
                  <Button size="sm" data-home-row="" onClick={() => void navigate({ to: '/documents', search: { show: 'partial' } })}>
                    Show them
                  </Button>
                )
              }
            >
              <strong>
                {reading.ask.length} long document{reading.ask.length === 1 ? ' waits' : 's wait'} for your go-ahead.
              </strong>{' '}
              {reading.ask.every((a) => a.lab)
                ? 'Reading again the pages where lab lines have no value costs more than your limit in Settings, so Claude asks first.'
                : reading.ask.some((a) => a.lab)
                  ? 'Reading the rest, or reading again pages where lab lines have no value, costs more than your limit in Settings, so Claude asks first.'
                  : 'Reading the rest costs more than your limit in Settings, so Claude asks first.'}
            </WaitingRow>
          ) : null}
          {reading.partial ? (
            <WaitingRow
              action={
                <Button size="sm" data-home-row="" onClick={() => void navigate({ to: '/documents', search: { show: 'partial' } })}>
                  Show them
                </Button>
              }
            >
              <strong>
                {reading.partial} document{reading.partial === 1 ? ' was' : 's were'} read only in part.
              </strong>{' '}
              The reading stopped or some pages could not be read; each one says which pages.
            </WaitingRow>
          ) : null}
          {lines.map((w) => (
            <WaitingRow
              key={w.key}
              action={
                // w.to is a page held as a string, so the router cannot type it: the cast stays (on its search).
                <Button size="sm" variant={w.key === 'needsSource' ? 'accent' : 'default'} data-home-row="" title={w.title} onClick={() => void navigate({ to: w.to, search: (w.search ?? {}) as never })}>
                  {w.action}
                </Button>
              }
            >
              {w.words}
            </WaitingRow>
          ))}
        </ul>
      ) : (
        <p className="home-quiet">Nothing is waiting for you. Claude files what you add and checks its details against your clinical records.</p>
      )}
      {inaccurate ? (
        <div className="home-fyi">
          <span className="home-fyi-head">For your information</span>
          <div className="home-fyi-row">
            <Tag tone="bad" title="Details that disagree with a clinical record">
              inaccurate
            </Tag>
            <span className="home-row-words">
              {inaccurate} detail{inaccurate === 1 ? '' : 's'} disagree{inaccurate === 1 ? 's' : ''} with a clinical record. The record’s value is used; nothing to do.
            </span>
            <Button size="sm" variant="ghost" data-home-row="" onClick={() => void navigate({ to: '/reconcile', search: { tab: 'inaccurate' } })} title="Opens Reconciliation, showing the inaccurate details">
              Show them
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * Go to a page and run one of its commands once it has registered (the add dialog of Appointments or the To-do list).
 * If the page never registers it, you are simply on the page.
 */
function goAndRun(navigate: ReturnType<typeof useNavigate>, to: string, commandId: string): void {
  void navigate({ to }).then(() => {
    const until = Date.now() + 3000;
    const tick = () => {
      const cmd = listCommands().find((x) => x.id === commandId);
      if (cmd) void cmd.run();
      else if (Date.now() < until) setTimeout(tick, 60);
    };
    tick();
  });
}

export function ComingUpSection({ today }: { today: ReturnType<typeof useToday> }) {
  const navigate = useNavigate();
  const canWrite = useMe().canWrite;
  // The care team's open follow-ups and its next flare-test call (2026-10-09, request 6).
  const care = useCareComingUp();
  const items = withCareTeam(comingUp(today.data), care.data);
  return (
    <Section
      title="Coming up"
      count={items.length || undefined}
      actions={
        <Link to="/encounters" className="home-more" data-home-row="">
          All appointments
        </Link>
      }
      className="home-section"
    >
      {today.isPending ? (
        <Loading>Loading…</Loading>
      ) : items.length ? (
        <ul className="home-rows">
          {items.slice(0, 10).map((x) => (
            <li key={x.id}>
              {/* x.to is a page held as a string, so the router cannot type it: the cast stays (on its search). */}
              <Link to={x.to} search={x.search as never} className="home-link-row" data-home-row="">
                <span className="home-date">
                  {x.date ? <DateText iso={x.date} precision={x.precision} /> : <span className="muted">no date</span>}
                  {/* Late items say so under their date, as Calls and the To-do list do. */}
                  {x.late ? (
                    <span className="home-late">
                      <Tag tone="bad">{x.late}</Tag>
                    </span>
                  ) : null}
                </span>
                <span className="home-row-words">
                  {x.what}
                  {x.who ? <span className="muted"> · {x.who}</span> : null}
                </span>
                <span className="home-kind">{x.kind}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="home-empty">
          <p className="home-quiet">Nothing scheduled or due in the next two weeks.</p>
          {canWrite ? (
            <div className="row wrap">
              <Button size="sm" data-home-row="" onClick={() => goAndRun(navigate, '/encounters', 'encounters.new')} title="Opens Appointments with a new appointment to fill in">
                Add an appointment
              </Button>
              <Button size="sm" data-home-row="" onClick={() => goAndRun(navigate, '/tasks', 'tasks.new')} title="Opens the To-do list with a new to-do to fill in">
                Add a to-do
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

export function RecentSection({ today }: { today: string }) {
  const docs = useDocuments({});
  const unsorted = useUnsorted();
  const notSorted = new Set((unsorted.data?.items ?? []).map((u) => u.id));
  const groups = groupByAddedDay(docs.data?.items ?? [], today, 6);
  return (
    <Section
      title="Recently added"
      actions={
        <Link to="/documents" className="home-more" data-home-row="">
          All documents
        </Link>
      }
      className="home-section"
    >
      {docs.isPending ? (
        <Loading>Loading…</Loading>
      ) : groups.length ? (
        <div className="home-recent">
          {groups.map((g) => (
            <div key={g.day} className="home-recent-day">
              <div className="home-added">{g.words}</div>
              <ul className="home-rows">
                {g.items.map((d) => {
                  const st = documentStatus(d);
                  return (
                    <li key={d.id}>
                      <Link to="/documents" search={{ id: d.id }} className="home-link-row" data-home-row="" title={d.title}>
                        <span className="home-date">{d.documentDate ? <DateText iso={d.documentDate} precision={d.documentDatePrecision} /> : <span className="muted">no date</span>}</span>
                        <span className="home-row-words home-doc-title">{d.title}</span>
                        <span className={`home-kind${st.bad ? ' bad' : ''}`}>{!st.quiet ? st.words : notSorted.has(d.id) ? 'Not sorted yet' : documentTypeLabel(d.category)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="home-quiet">No documents yet. Drop files on this window or choose them below to add the first ones.</p>
      )}
    </Section>
  );
}

export const ASK_BOX_ID = 'home-ask-question';

export function AskBox() {
  const [text, setText] = useState('');
  function ask() {
    const q = text.trim();
    dock('open');
    // With a question typed, the clinician starts on it at once; empty, the panel just opens.
    prefill({ text: q, mode: 'question', ...(q ? { send: true } : {}) });
    setText('');
  }
  return (
    <Section
      title="Ask the clinician"
      actions={
        <Link to="/ask" className="home-more" data-home-row="">
          All conversations
        </Link>
      }
      className="home-section"
    >
      <form
        className="home-ask"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          id={ASK_BOX_ID}
          rows={2}
          value={text}
          placeholder="Your question, e.g. how has my CRP changed over time?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            } else if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          }}
          aria-label="Question for the clinician"
        />
        <div className="home-ask-foot">
          <span className="muted">The clinician opens beside this page and starts on your question. Every statement in the answer cites the page it comes from.</span>
          <Button type="submit" variant="primary" shortcut="enter" title="Send the question to the clinician (Enter; Shift+Enter starts a new line)">
            Ask
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** A slim strip: drop files here (or anywhere on the window), or choose them. Owners and editors only. */
export function DropStrip() {
  const { add, busy } = useAddDocuments();
  const canWrite = useMe().canWrite;
  const [over, setOver] = useState(false);
  if (!canWrite) return null;
  function onDragOver(e: DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!over) setOver(true);
  }
  return (
    <div
      className={`home-drop${over ? ' over' : ''}`}
      data-own-drop
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        add(Array.from(e.dataTransfer.files), { open: true });
      }}
    >
      <span className="home-drop-words">
        <strong>{over ? 'Drop to add them to the case.' : 'Add documents.'}</strong> Drop files anywhere on this window, or choose them: PDFs, scans, photos, Word files, call transcripts. Claude reads, names and files each one.
      </span>
      <AddDocumentsButton label={busy ? 'Adding…' : 'Choose files'} variant="default" />
    </div>
  );
}

/** Safety first: the substances never to give, at the top of Home. */
export function NeverGive({ items }: { items: TodayPayload['hardStops'] }) {
  if (!items.length) return null;
  return (
    <div className="hardstop" role="note">
      <strong>Never give</strong>
      {items.map((h) => (
        <div key={h.id}>
          {h.substance}
          {h.reaction ? <span className="muted"> · {h.reaction}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Today's date as YYYY-MM-DD (the server's, else this computer's). */
export function todayOf(t: TodayPayload | undefined): string {
  return t?.date ?? localDay(new Date().toISOString());
}
