/**
 * "Checked against itself" inside a document's "How much was read" (2026-10-09): the lab flags that don't match their
 * own value and range, the contradictions Claude found inside the document, each linked to What Claude noticed, the
 * facility's totals ("From Valley Clinic: 3 flags don't match, 1 contradiction in 4 documents checked"), and, when the
 * automatic check costs more than the limit, the one question: Check it / Not now.
 */
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { Tag } from '../../ui/StatusTag';
import { useToast } from '../../ui/Toast';
import { useRegisterCommands } from '../../app/commands';
import { useMe } from '../../api/users';
import { useAnswerSelfCheck, type DocumentSelfCheck } from '../../api/self-check';
import { answerWords } from '../findings/words';
import { contradictionsLine, flagsLine, queueResultWords, summaryLine, usd } from './words';
import './self-check.css';

export function SelfCheckBlock({ data }: { data: DocumentSelfCheck }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const answer = useAnswerSelfCheck();
  const c = data.record?.contradictions;
  const asking = c?.state === 'ask';
  const id = data.documentId;

  function reply(a: 'yes' | 'not_now') {
    if (answer.isPending) return;
    answer.mutate(
      { id, answer: a },
      {
        onSuccess: (r) => toast(a === 'yes' ? queueResultWords(r) : 'Kept: Claude will not read it for contradictions by itself. Check it against itself (More) still works.', 'ok'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not answer', 'bad'),
      },
    );
  }

  useRegisterCommands(
    [
      { id: 'documents.selfCheck.yes', title: `Read it for contradictions${c?.estimateUsd != null ? ` (${usd(c.estimateUsd)})` : ''}`, group: 'Documents', keywords: 'check against itself contradictions yes approve limit', when: () => canWrite && asking, run: () => reply('yes') },
      { id: 'documents.selfCheck.notNow', title: 'Not now: do not read it for contradictions', group: 'Documents', keywords: 'check against itself contradictions decline later', when: () => canWrite && asking, run: () => reply('not_now') },
    ],
    [id, canWrite, asking, c?.estimateUsd, answer.isPending],
  );

  const flags = flagsLine(data);
  const contra = contradictionsLine(data);
  return (
    <div className="sc-block">
      <div className="doc-coverage-subhead">{summaryLine(data)}</div>
      {asking ? (
        <div className="doc-coverage-ask sc-ask">
          <span>{contra}</span>
          {canWrite ? (
            <span className="row">
              <Button size="sm" variant="accent" disabled={answer.isPending} onClick={() => reply('yes')} title="Claude reads each part of this document for contradictions within it, at the cost shown">
                Check it ({usd(c?.estimateUsd)})
              </Button>
              <Button size="sm" variant="ghost" disabled={answer.isPending} onClick={() => reply('not_now')} title="Kept: it is not asked again for this document">
                Not now
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}
      <ul className="sc-lines">
        {flags ? <li>{flags}</li> : null}
        {contra && !asking ? <li>{contra}</li> : null}
      </ul>
      {data.findings.length ? (
        <ul className="sc-findings">
          {data.findings.map((f) => (
            <li key={f.id}>
              <Link to="/findings" search={{ id: f.id }}>
                {f.title}
              </Link>{' '}
              <Tag tone={answerWords(f.status).tone}>{answerWords(f.status).label}</Tag>
            </li>
          ))}
        </ul>
      ) : null}
      {data.facilityTotals && data.facility.id ? (
        <p className="muted small sc-facility">
          <Link to="/people" search={{ id: data.facility.id }}>
            {data.facilityTotals.words}
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
