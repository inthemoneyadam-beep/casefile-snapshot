/**
 * Under a clinician answer: the values it proposes computing from values printed on lab reports (2026-10-09, D8). It is
 * always a proposal, even when the user asked: "Yes, compute it" computes it now (the app's own arithmetic, from the inputs
 * as they read now; refused when an input changed since), "Not now" leaves it. Once computed, the item says so and links
 * to the value in Labs. Mounted by AskBatchActions (features/documents).
 */
import { Link } from '@tanstack/react-router';
import { errorMessage } from '../../api/client';
import type { Filing } from '../../api/filing';
import { useMe } from '../../api/users';
import { useRegisterCommands } from '../../app/commands';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { computeCardHead, proposalState, withoutStateWords } from '../ask/proposals';
import { useComputeProposalActions } from './computed-api';

/** The filings target of the clinician's proposal to compute a value (shared/labcompute.ts COMPUTE_TARGET). */
export const COMPUTE_TARGET = 'lab_compute';

interface ProposalDetail {
  preview?: { shown?: string; unit?: string | null; day?: string; label?: string | null; pairing?: string | null; analyte?: string };
  reason?: string | null;
  labResultId?: string | null;
}

export function ComputeProposals({ items }: { items: Filing[] }) {
  const waiting = items.filter((f) => f.status === 'waiting').length;
  const computed = items.filter((f) => f.status === 'approved').length;
  return (
    <div className={`filing-panel filing-notice ask-proposal${waiting ? ' waiting' : ''}`} role="group" aria-label="Values the clinician suggests computing">
      <div className="filing-head">
        <span>{computeCardHead(waiting, computed)}</span>
      </div>
      {items.map((f) => (
        <ComputeProposalItem key={f.id} f={f} />
      ))}
    </div>
  );
}

function ComputeProposalItem({ f }: { f: Filing }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const { approve, decline } = useComputeProposalActions();
  const st = proposalState('compute', f.status);
  const d = f.detail as ProposalDetail;
  const busy = approve.isPending || decline.isPending;
  const waiting = f.status === 'waiting';
  const yes = (): void => {
    if (busy) return;
    approve.mutate(f.id, {
      onSuccess: (r) => toast(`Computed: ${r.entry.analyte} ${r.entry.computed?.record.result.shown ?? ''}`, 'ok'),
      onError: (err) => toast(errorMessage(err, 'Could not compute it'), 'bad'),
    });
  };
  const notNow = (): void => {
    if (busy) return;
    decline.mutate(f.id, { onSuccess: () => toast('Not computed', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not answer'), 'bad') });
  };
  useRegisterCommands(
    canWrite && waiting ? [{ id: `ask.compute.approve.${f.id}`, title: `Yes, compute it: ${withoutStateWords(f.summary)}`, group: 'Ask', keywords: 'approve yes compute computed albumin index proposal clinician', run: yes }] : [],
    [canWrite, waiting, f.id, busy],
  );
  return (
    <div className={`filing-item${waiting ? ' pending' : ''}`}>
      <div className="grow">
        <div className="filing-what">{withoutStateWords(f.summary)}</div>
        {d.preview?.pairing ? <div className="small">Pairing: {d.preview.pairing}.</div> : null}
        {d.reason ? <div className="small">{d.reason}</div> : null}
        {f.status === 'approved' && d.labResultId ? (
          <Link className="small" to="/labs" search={{ view: 'results', id: d.labResultId }}>
            see it in Labs
          </Link>
        ) : null}
        {waiting && canWrite ? (
          <div className="ask-proposal-actions">
            <Button variant="primary" disabled={busy} onClick={yes} title="The app computes it from the printed values as they read now, and keeps every input's page">
              Yes, compute it
            </Button>
            <Button variant="ghost" disabled={busy} onClick={notNow}>
              Not now
            </Button>
          </div>
        ) : null}
      </div>
      <Tag tone={st.tone}>{st.word}</Tag>
    </div>
  );
}
