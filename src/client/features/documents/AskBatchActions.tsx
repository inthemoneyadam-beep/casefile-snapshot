/**
 * Under a clinician answer: what it started or proposed, each with one plain state and, while it waits, one obvious
 * button to say yes (2026-10-07; reworked 2026-10-08, lab check).
 *
 *   Reading requests   documents or pages the clinician asked to have read (again). Ones you asked for in your message
 *                      started at once (above your limit they wait for one yes); ones it proposed on its own wait for
 *                      you: "Yes, read …" starts each with ITS OWN pages (POST /api/ask/proposals/reading/approve; the
 *                      old button re-asked for "the pages not read yet", which on a document read to the end read
 *                      nothing), "Not now" leaves them. Once started, the item says what happened: waiting its turn,
 *                      being read now, then what the lab check found.
 *   Lab values         a lab line from a page the clinician proposed to add to your lab table ("Add it to the lab
 *                      table" / "Not now"), and the ones it added because you asked in your message; each added one
 *                      has Undo and a link to it in Labs.
 *   Computed values    a value the clinician proposes computing from printed lab values (always a proposal, even
 *                      when you asked): "Yes, compute it" / "Not now" (features/labs/ComputeProposals.tsx, 2026-10-09).
 *   Moves in a batch   several documents the clinician suggests filing under another type: "Move them all" or "Leave
 *                      them all" (each move is also listed above with its own Move it / Leave it, and Undo).
 *
 * Each item shows ONE state, from its status, never from its stored summary (the user saw "waiting for a yes" beside
 * "started"). Nothing here runs unless you press it. Mounted by the Ask thread under the answer.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, errorMessage } from '../../api/client';
import { useFilings, type Filing } from '../../api/filing';
import { reprocessWords, useDocumentCoverage } from '../../api/documents';
import { useAskProposalActions, useLabValueStates, type AskLabValue } from '../../api/ask';
import { useActiveJobs } from '../../api/hooks';
import { useMe } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { labCheckWords } from '@shared/labcheck';
import { addedLabValueState, cardWords, labValueCardHead, proposalState, readingCardHead, readingRequestWords, withoutStateWords } from '../ask/proposals';
import { dollars } from './coverage';
import { COMPUTE_TARGET, ComputeProposals } from '../labs/ComputeProposals';

function estimateOf(f: Filing): number | null {
  const v = (f.detail as { estimateUsd?: unknown }).estimateUsd;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function batchOf(f: Filing): string | null {
  const v = (f.detail as { batchId?: unknown }).batchId;
  return typeof v === 'string' && v ? v : null;
}

/** The filings target of a lab value the clinician proposed from a page (services/lab-check.ts). */
const LAB_VALUE_TARGET = 'lab_value';

export function AskBatchActions({ ids, labValues = [] }: { ids: string[]; labValues?: AskLabValue[] }) {
  const q = useFilings({ ids: ids.join(',') }, ids.length > 0);
  const items = q.data?.items ?? [];
  const reads = items.filter((f) => f.action === 'reprocess');
  const labs = items.filter((f) => f.targetType === LAB_VALUE_TARGET);
  const moves = items.filter((f) => f.action === 'move');
  const computes = items.filter((f) => f.targetType === COMPUTE_TARGET);
  const batches = [...new Set(moves.filter((f) => f.status === 'proposed').map(batchOf).filter((b): b is string => Boolean(b)))];
  if (!reads.length && !labs.length && !labValues.length && !batches.length && !computes.length) return null;
  return (
    <div className="ask-batch">
      {reads.length ? <ReadingRequests items={reads} /> : null}
      {labs.length || labValues.length ? <LabValues proposals={labs} added={labValues} /> : null}
      {computes.length ? <ComputeProposals items={computes} /> : null}
      {batches.map((b) => (
        <MoveBatch key={b} batchId={b} items={moves.filter((f) => batchOf(f) === b)} />
      ))}
    </div>
  );
}

function ReadingRequests({ items }: { items: Filing[] }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const { approveReading, declineReading } = useAskProposalActions();
  const waiting = items.filter((f) => f.status === 'waiting');
  const started = items.filter((f) => f.status === 'approved');
  const total = waiting.reduce((n, f) => n + (estimateOf(f) ?? 0), 0);
  const busy = approveReading.isPending || declineReading.isPending;
  function readThem() {
    if (busy || !waiting.length) return;
    approveReading.mutate(
      waiting.map((f) => f.id),
      { onSuccess: (r) => toast(reprocessWords(r), r.queued.length ? 'ok' : 'info'), onError: (err) => toast(errorMessage(err, 'Could not start'), 'bad') },
    );
  }
  function notNow() {
    if (busy || !waiting.length) return;
    declineReading.mutate(
      waiting.map((f) => f.id),
      { onSuccess: () => toast('Left as it is; nothing was read', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not answer'), 'bad') },
    );
  }
  const yes = `Yes, read ${waiting.length === 1 ? 'it' : 'them'}${total ? ` (${dollars(total)})` : ''}`;
  useRegisterCommands(
    canWrite && waiting.length
      ? [
          { id: `ask.reading.approve.${waiting[0].id}`, title: `${yes}: ${readingRequestWords(waiting[0])}${waiting.length > 1 ? ` and ${waiting.length - 1} more` : ''}`, group: 'Ask', keywords: 'approve yes read again pages proposal clinician', run: readThem },
          { id: `ask.reading.decline.${waiting[0].id}`, title: 'Not now: leave the reading the clinician suggests', group: 'Ask', keywords: 'decline no proposal clinician', run: notNow },
        ]
      : [],
    [canWrite, waiting.map((f) => f.id).join(','), busy],
  );
  return (
    <div className={`filing-panel filing-notice ask-proposal${waiting.length ? ' waiting' : ''}`} role="group" aria-label="Reading the clinician suggested">
      <div className="filing-head">
        <span>{readingCardHead(waiting.length, started.length, items.length)}</span>
      </div>
      {items.map((f) => (
        <ReadingItem key={f.id} f={f} />
      ))}
      {waiting.length ? (
        canWrite ? (
          <div className="ask-proposal-actions">
            <Button variant="primary" disabled={busy} onClick={readThem} title="Claude reads exactly these pages again; details you checked or edited are kept">
              {yes}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={notNow}>
              Not now
            </Button>
          </div>
        ) : (
          <p className="small muted">Waiting for the owner or an editor of the case to say yes.</p>
        )
      ) : null}
    </div>
  );
}

const READING_JOBS = new Set(['extract_facts', 'resume_extraction']);

/** One reading request: what it asks for, its one state, and once started what happened. */
function ReadingItem({ f }: { f: Filing }) {
  const st = proposalState('reading', f.status);
  const approved = f.status === 'approved';
  const jobs = useActiveJobs();
  const cov = useDocumentCoverage(approved ? f.documentId : null, approved);
  const job = approved ? (jobs.data?.items ?? []).find((j) => j.documentId === f.documentId && READING_JOBS.has(j.type)) : undefined;
  const lab = cov.data?.coverage?.labCheck ?? null;
  const decided = f.decidedAt ?? f.createdAt;
  let after: string | null = null;
  if (approved) {
    if (job) after = job.status === 'running' ? 'Being read now.' : 'Waiting its turn to be read.';
    else if (lab && lab.at >= decided) after = `Read again. ${labCheckWords(lab)?.line ?? ''}`.trim();
    else if (cov.data) after = 'Read again.';
  }
  const reason = typeof f.detail.reason === 'string' && f.detail.reason.trim() ? f.detail.reason.trim() : null;
  return (
    <div className={`filing-item${f.status === 'waiting' ? ' pending' : ''}`}>
      <div className="grow">
        <div className="filing-what">{readingRequestWords(f)}</div>
        {reason ? <div className="small">{reason}</div> : null}
        {after ? <div className="small ask-proposal-after">{after}</div> : null}
        {f.documentId ? (
          <Link className="small" to="/documents" search={{ id: f.documentId }}>
            see the document
          </Link>
        ) : null}
      </div>
      <Tag tone={st.tone}>{st.word}</Tag>
    </div>
  );
}

/** The row as printed, from a proposal's detail (the shared parser's reading of the line on the page). */
function proposedRow(f: Filing): { page: number | null; text: string | null } {
  const parsed = (f.detail.parsed ?? null) as { page?: unknown; text?: unknown } | null;
  const page = typeof f.detail.page === 'number' ? f.detail.page : typeof parsed?.page === 'number' ? parsed.page : null;
  const text = typeof parsed?.text === 'string' ? parsed.text : typeof f.detail.row === 'string' ? f.detail.row : typeof f.detail.quote === 'string' ? f.detail.quote : null;
  return { page, text };
}

function LabValues({ proposals, added }: { proposals: Filing[]; added: AskLabValue[] }) {
  const states = useLabValueStates(added.map((a) => a.factId));
  const stateOf = new Map((states.data ?? []).map((s) => [s.factId, s.state]));
  const waiting = proposals.filter((f) => f.status === 'waiting').length;
  const addedCount = proposals.filter((f) => f.status === 'approved').length + added.filter((a) => addedLabValueState(a.outcome, stateOf.get(a.factId)).word === 'added').length;
  return (
    <div className={`filing-panel filing-notice ask-proposal${waiting ? ' waiting' : ''}`} role="group" aria-label="Lab values from the page">
      <div className="filing-head">
        <span>{labValueCardHead(waiting, addedCount)}</span>
      </div>
      {proposals.map((f) => (
        <LabProposalItem key={f.id} f={f} />
      ))}
      {added.map((a) => (
        <AddedLabValueItem key={a.factId} a={a} state={stateOf.get(a.factId)} />
      ))}
    </div>
  );
}

function LabLinks({ factId, documentId, page }: { factId: string | null; documentId: string | null; page: number | null }) {
  return (
    <span className="row wrap small">
      {factId ? (
        <Link to="/labs" search={{ id: `fact:${factId}` }}>
          see it in Labs
        </Link>
      ) : null}
      {documentId && page ? (
        <Link to="/documents/$id" params={{ id: documentId }} search={{ page }}>
          open p.{page}
        </Link>
      ) : null}
    </span>
  );
}

/** A lab value the clinician proposed: waiting for your yes, added (with Undo), not now, or taken back. */
function LabProposalItem({ f }: { f: Filing }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const { approveLabValue, declineLabValue, undoLabValue } = useAskProposalActions();
  const st = proposalState('lab_value', f.status);
  const row = proposedRow(f);
  const factId = typeof f.detail.factId === 'string' && f.detail.factId ? f.detail.factId : null;
  const busy = approveLabValue.isPending || declineLabValue.isPending || undoLabValue.isPending;
  const waiting = f.status === 'waiting';
  const add = (): void => {
    if (busy) return;
    approveLabValue.mutate(f.id, {
      onSuccess: (r) => toast(r.result.words ? cardWords(r.result.words) : 'Added to your lab table', 'ok'),
      onError: (err) => toast(errorMessage(err, 'Could not add it'), 'bad'),
    });
  };
  const notNow = (): void => {
    if (busy) return;
    declineLabValue.mutate(f.id, { onSuccess: () => toast('Not added', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not answer'), 'bad') });
  };
  const undo = (): void => {
    if (!factId || busy) return;
    undoLabValue.mutate(factId, { onSuccess: (r) => toast(r.words || 'Taken back', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not take it back'), 'bad') });
  };
  useRegisterCommands(
    canWrite && waiting
      ? [{ id: `ask.labvalue.approve.${f.id}`, title: `Add it to the lab table: ${withoutStateWords(f.summary)}`, group: 'Ask', keywords: 'approve yes add lab value table page proposal clinician', run: add }]
      : [],
    [canWrite, waiting, f.id, busy],
  );
  return (
    <div className={`filing-item${waiting ? ' pending' : ''}`}>
      <div className="grow">
        <div className="filing-what">{withoutStateWords(f.summary)}</div>
        {row.text ? (
          <div className="small">
            As printed{row.page ? ` on p.${row.page}` : ''}: <span className="mono">{row.text}</span>
          </div>
        ) : null}
        <LabLinks factId={f.status === 'approved' ? factId : null} documentId={f.documentId} page={row.page} />
        {waiting && canWrite ? (
          <div className="ask-proposal-actions">
            <Button variant="primary" disabled={busy} onClick={add} title="The app reads the line on the page itself and adds it, with a citation of that page; you can undo it">
              Add it to the lab table
            </Button>
            <Button variant="ghost" disabled={busy} onClick={notNow}>
              Not now
            </Button>
          </div>
        ) : null}
        {f.status === 'approved' && factId && canWrite ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={undo} title="Take this value back out of your lab table">
            Undo
          </Button>
        ) : null}
      </div>
      <Tag tone={st.tone}>{st.word}</Tag>
    </div>
  );
}

/** A lab value the clinician added because you asked in your message: added (with Undo), already on file, or taken back. */
function AddedLabValueItem({ a, state }: { a: AskLabValue; state: 'live' | 'taken_back' | 'replaced' | 'gone' | undefined }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const { undoLabValue } = useAskProposalActions();
  const st = addedLabValueState(a.outcome, state);
  const live = st.word === 'added' || st.word === 'already on file';
  return (
    <div className="filing-item">
      <div className="grow">
        <div className="filing-what">{cardWords(a.words)}</div>
        <div className="small">{a.outcome === 'added' ? 'Added because you asked; it says so in its detail.' : 'Nothing new was added.'}</div>
        <LabLinks factId={live ? a.factId : null} documentId={a.documentId} page={a.page} />
        {a.undoable && st.word === 'added' && canWrite ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={undoLabValue.isPending}
            onClick={() => undoLabValue.mutate(a.factId, { onSuccess: (r) => toast(r.words || 'Taken back', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not take it back'), 'bad') })}
            title="Take this value back out of your lab table"
          >
            Undo
          </Button>
        ) : null}
      </div>
      <Tag tone={st.tone}>{st.word}</Tag>
    </div>
  );
}

function MoveBatch({ batchId, items }: { batchId: string; items: Filing[] }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'decline') => api.post<{ applied?: number }>(`/api/filing/moves/batch/${encodeURIComponent(batchId)}/${d}`, {}),
    onSettled: () => void qc.invalidateQueries(),
  });
  const waiting = items.filter((f) => f.status === 'proposed').length;
  if (!waiting || !canWrite || items.length < 2) return null;
  return (
    <div className="filing-panel filing-notice waiting">
      <div className="filing-head">
        <span>All {waiting} moves suggested above, at once</span>
      </div>
      <span className="row">
        <Button size="sm" variant="accent" disabled={decide.isPending} onClick={() => decide.mutate('approve', { onSuccess: () => toast('Moved, and filed again under the new types; each can be undone', 'ok'), onError: (err) => toast(err instanceof Error ? err.message : 'Could not move them', 'bad') })}>
          Move them all
        </Button>
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate('decline', { onSuccess: () => toast('Left where they were', 'ok') })}>
          Leave them all
        </Button>
      </span>
    </div>
  );
}
