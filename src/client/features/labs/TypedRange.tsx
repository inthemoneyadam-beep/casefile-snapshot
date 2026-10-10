/**
 * The range the patient types for a computed test (2026-10-09, D6): one per test (the albumin index, the IgG index, a ratio he
 * named), drawn on the chart as dashed lines labelled "range typed by you". It never makes a value red and never
 * judges one; it is not the lab's range.
 */
import { useEffect, useState } from 'react';
import { typedRangeWords } from '@shared/labcompute';
import { errorMessage } from '../../api/client';
import { Button } from '../../ui/Button';
import { Field, Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { useComputeMutations, useTypedRanges } from './computed-api';
import './computed.css';

/** A number typed in a box, or null when the box is empty; NaN when it is not a number. */
export function typedNumber(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function TypedRangeEditor({ analyteKey, canWrite = true }: { analyteKey: string; canWrite?: boolean }) {
  const ranges = useTypedRanges();
  const m = useComputeMutations();
  const toast = useToast();
  const current = ranges.data?.[analyteKey] ?? null;
  const [editing, setEditing] = useState(false);
  const [low, setLow] = useState('');
  const [high, setHigh] = useState('');
  useEffect(() => {
    if (!editing) return;
    setLow(current?.low != null ? String(current.low) : '');
    setHigh(current?.high != null ? String(current.high) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const lo = typedNumber(low);
  const hi = typedNumber(high);
  const bad = Number.isNaN(lo) || Number.isNaN(hi) ? 'Type numbers only.' : lo == null && hi == null ? 'Type a lower or an upper limit, or both.' : lo != null && hi != null && lo > hi ? 'The lower limit is above the upper limit.' : null;
  const busy = m.setRange.isPending || m.clearRange.isPending;

  function save() {
    if (bad || busy) return;
    m.setRange.mutate(
      { analyteKey, low: lo, high: hi },
      { onSuccess: () => { setEditing(false); toast('Your range is drawn on the chart', 'ok'); }, onError: (err) => toast(errorMessage(err, 'Could not save the range'), 'bad') },
    );
  }
  function clear() {
    if (busy) return;
    m.clearRange.mutate(analyteKey, { onSuccess: () => toast('Your range is cleared', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not clear it'), 'bad') });
  }

  if (editing) {
    return (
      <div
        className="computed-range"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      >
        <Field label="From">
          <Input autoFocus inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} placeholder="none" />
        </Field>
        <Field label="To">
          <Input inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} placeholder="none" />
        </Field>
        <Button size="sm" variant="primary" disabled={Boolean(bad) || busy} onClick={save} title={bad ?? 'Drawn dashed on the chart; it never makes a value red'}>
          Save my range
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {bad && (low || high) ? <span className="computed-small">{bad}</span> : null}
      </div>
    );
  }
  return (
    <div className="computed-range">
      {current ? (
        <span className="computed-range-line">
          <span className="computed-range-swatch" aria-hidden="true" />
          <span className="mono">{typedRangeWords(current)}</span>, {current.label}
        </span>
      ) : (
        <span className="computed-small">No range of your own yet. The lab prints none for a value you compute.</span>
      )}
      {canWrite ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="Type the range you and your doctor use for this value; drawn dashed, never red">
            {current ? 'Change my range' : 'Type my range'}
          </Button>
          {current ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={clear}>
              Clear it
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
