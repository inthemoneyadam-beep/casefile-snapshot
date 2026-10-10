/**
 * "Check it against itself" (one document) and "Check documents against themselves" (many, from Documents): the cost
 * is shown before anything is sent. The lab flags are checked by the app for free; Claude reads each part for
 * contradictions in small calls. "Check again" reads parts already read once more. Ctrl+Enter starts, Esc closes.
 */
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Kbd } from '../../ui/Kbd';
import { useToast } from '../../ui/Toast';
import { useBindings } from '../../app/shortcuts';
import { useRunSelfCheck, useRunSelfCheckMany, useSelfCheckEstimate } from '../../api/self-check';
import { estimateLine, estimateTotalLine, manyResultWords, queueResultWords, usd } from './words';
import './self-check.css';

export function CheckDialog({ open, onClose, documentIds, what }: { open: boolean; onClose: () => void; documentIds: string[]; what?: string }) {
  const toast = useToast();
  const [force, setForce] = useState(false);
  const ids = documentIds.slice(0, 500);
  const est = useSelfCheckEstimate(ids, { force, enabled: open });
  const one = useRunSelfCheck();
  const many = useRunSelfCheckMany();
  const busy = one.isPending || many.isPending;
  const data = est.data;
  const anyChecked = Boolean(data?.items.some((x) => x.checked || (!x.calls && !x.blocked)));
  const single = ids.length === 1;
  const cost = data ? usd(data.totalUsd) : '';

  function start() {
    if (busy || !ids.length || !data) return;
    if (single) {
      one.mutate(
        { id: ids[0], force },
        {
          onSuccess: (r) => {
            toast(queueResultWords(r), r.outcome === 'off' ? 'bad' : 'ok');
            onClose();
          },
          onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad'),
        },
      );
      return;
    }
    many.mutate(
      { documentIds: data.items.map((x) => x.documentId), force },
      {
        onSuccess: (r) => {
          toast(manyResultWords(r), 'ok');
          onClose();
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not start', 'bad'),
      },
    );
  }

  useBindings(open ? [{ keys: 'ctrl+enter', description: 'Check against itself: start (the cost shown)', group: 'Documents', global: true, run: start }] : [], [open, ids.join(','), force, data?.totalUsd, busy]);

  return (
    <Dialog open={open} onClose={onClose} title={single ? 'Check it against itself' : 'Check documents against themselves'} width={620}>
      <div className="stack sc-dialog">
        <p className="sc-p">
          {single ? 'This document is checked against itself only, never against your other records.' : `${what ?? 'These documents'}: each is checked against itself only, never against the others.`} The app compares every lab flag with
          its own value and range. Claude reads each note for places where it says two things that cannot both be true, and quotes both. Nothing is changed; what it finds goes to What Claude noticed.
        </p>
        {est.isPending ? <div className="muted small">Working out the cost…</div> : null}
        {est.isError ? <div className="notice bad">{est.error instanceof Error ? est.error.message : 'Could not work out the cost'}</div> : null}
        {data ? (
          single && data.items[0] ? (
            <p className="sc-cost">{estimateLine(data.items[0])}</p>
          ) : (
            <>
              <p className="sc-cost">{estimateTotalLine(data)}</p>
              {data.missing.length ? <p className="muted small">{data.missing.length} could not be found and are left out.</p> : null}
            </>
          )
        ) : null}
        {anyChecked ? (
          <label className="sc-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Check again: Claude reads parts it already read once more
          </label>
        ) : null}
        <div className="row">
          <Button variant="primary" shortcut="ctrl+enter" onClick={start} disabled={busy || !data || !data.items.length} data-autofocus>
            {single ? 'Check it' : `Check ${data?.items.length ?? ids.length} documents`}
            {cost && data && data.calls ? ` (${cost})` : ''}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <span className="spacer grow" />
          <span className="faint xs">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </Dialog>
  );
}
