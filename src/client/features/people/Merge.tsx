/**
 * People who may be listed twice (2026-10-07): a chart print names the same nurse as "Example, Robin RN" in one
 * place and "Robin Example" in another, and a call record calls her "Robin". Claude suggests which entries may be one
 * person, with its reasons and where it read them; it never merges them itself. Merging is your act: it moves every
 * call, message, detail and document link to the person you keep, adds the other names as "also written as", and can
 * be undone (everything goes back where it was). "Not the same people" is remembered.
 *
 *   MergeSuggestionsDialog  every suggestion, one at a time: j/k move, m merges, x says they are not the same
 *   PersonMergeSection      on a person's pane: who they may be the same as, and the merges into them, with Undo
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { Tag } from '../../ui/StatusTag';
import { Section } from '../../ui/PageHeader';
import { useToast } from '../../ui/Toast';
import { errorMessage } from '../../api/client';
import { useMe } from '../../api/users';
import { useFilings } from '../../api/filing';
import { mergeWords, useMergeMutations, useMergeSuggestions, type MergeSuggestion } from '../../api/people';
import { personKindWords } from './shared';

/** Where Claude read the evidence, in words. */
const EVIDENCE_WORDS: Record<string, string> = {
  alias: 'also written as',
  name_form: 'the same name written another way',
  signature: 'a signature',
  message: 'a message',
  call_record: 'a call record',
  order: 'an order',
};

/** One suggestion: who, why, the evidence, and the two answers. */
function SuggestionCard({ s, active, busy, onMerge, onDecline }: { s: MergeSuggestion; active: boolean; busy: boolean; onMerge: (keepId: string, mergeIds: string[]) => void; onDecline: () => void }) {
  const canWrite = useMe().canWrite;
  const people = [s.keep, ...s.others];
  const [keepId, setKeepId] = useState(s.keep.personId);
  useEffect(() => setKeepId(s.keep.personId), [s.id, s.keep.personId]);
  const keep = people.find((p) => p.personId === keepId) ?? s.keep;
  const merge = people.filter((p) => p.personId !== keep.personId);
  return (
    <div className={`pp-merge-card${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined}>
      <div className="pp-merge-head">
        <span className="pp-merge-names">
          {people.map((p, i) => (
            <span key={p.personId}>
              {i ? <span className="muted"> and </span> : null}
              <Link to="/people" search={{ id: p.personId }}>
                {p.name}
              </Link>
              <span className="muted"> ({personKindWords(p.kind).toLowerCase()})</span>
            </span>
          ))}
        </span>
        <Tag tone={s.strength === 'strong' ? 'info' : 'neutral'}>{s.strength === 'strong' ? 'likely the same' : 'possibly the same'}</Tag>
      </div>
      <p className="pp-merge-reason">{s.reason}</p>
      {s.evidence.length ? (
        <ul className="pp-merge-evidence">
          {s.evidence.slice(0, 6).map((e, i) => (
            <li key={i}>
              <span className="muted">{EVIDENCE_WORDS[e.kind] ?? 'seen'}: </span>“{e.text}”
              {e.documentId ? (
                <>
                  {' '}
                  <Link to="/documents/$id" params={{ id: e.documentId }} search={e.page ? { page: e.page } : {}}>
                    {e.page ? `page ${e.page}` : 'the document'}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canWrite ? (
        <div className="pp-merge-actions">
          {people.length > 1 ? (
            <label className="pp-merge-keep">
              <span className="muted">Keep the name</span>
              <select value={keepId} onChange={(e) => setKeepId(e.target.value)} aria-label="Which entry to keep">
                {people.map((p) => (
                  <option key={p.personId} value={p.personId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button size="sm" variant="accent" disabled={busy} onClick={() => onMerge(keep.personId, merge.map((p) => p.personId))} title={`Everything linked to ${merge.map((p) => p.name).join(' and ')} moves to ${keep.name}; Undo puts it back`}>
            Merge into {keep.name}
            {active ? <Kbd>m</Kbd> : null}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDecline} title="They are different people; this is not suggested again">
            Not the same people
            {active ? <Kbd>x</Kbd> : null}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Every suggestion, one at a time (j/k), from the People page. */
export function MergeSuggestionsDialog({ open, onClose, onMerged }: { open: boolean; onClose: () => void; onMerged?: (keepId: string) => void }) {
  const toast = useToast();
  const q = useMergeSuggestions(null, open);
  const { merge, decline, undo } = useMergeMutations();
  const items = q.data ?? [];
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const busy = merge.isPending || decline.isPending;
  const [lastMerge, setLastMerge] = useState<{ filingId: string; keepName: string } | null>(null);

  useEffect(() => {
    if (open) {
      setIndex(0);
      setTimeout(() => listRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  function doMerge(s: MergeSuggestion, keepId: string, mergeIds: string[]) {
    const keepName = [s.keep, ...s.others].find((p) => p.personId === keepId)?.name ?? s.keep.name;
    merge.mutate(
      { keepId, mergeIds, suggestionId: s.id },
      {
        onSuccess: (r) => {
          toast(mergeWords(r, keepName), 'ok');
          setLastMerge({ filingId: r.filingId, keepName });
          onMerged?.(r.keepId);
        },
        onError: (err) => toast(errorMessage(err, 'Could not merge them'), 'bad'),
      },
    );
  }
  function doDecline(s: MergeSuggestion) {
    decline.mutate(s.id, { onSuccess: () => toast('Kept apart; not suggested again.', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not save that'), 'bad') });
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('a, button, select') && (e.key === 'Enter' || e.key === ' ')) return;
    const s = items[index];
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'm' && s && !busy) {
      e.preventDefault();
      doMerge(s, s.keep.personId, s.others.map((p) => p.personId));
    } else if (e.key === 'x' && s && !busy) {
      e.preventDefault();
      doDecline(s);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="People who may be listed twice"
      width={720}
      footer={
        <div className="row">
          {lastMerge ? (
            <Button size="sm" variant="ghost" disabled={undo.isPending} onClick={() => undo.mutate(lastMerge.filingId, { onSuccess: () => { toast(`Undone: ${lastMerge.keepName} is two entries again.`, 'ok'); setLastMerge(null); }, onError: (err) => toast(errorMessage(err, 'Could not undo'), 'bad') })}>
              Undo the last merge
            </Button>
          ) : null}
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      <p className="muted small">
        Claude read these names in your records and thinks each group may be one person. Nothing is merged unless you say so; a merge can be undone. <Kbd>j</Kbd>/<Kbd>k</Kbd> move, <Kbd>m</Kbd> merge, <Kbd>x</Kbd> not the same.
      </p>
      <div className="pp-merge-list" ref={listRef} tabIndex={0} onKeyDown={onKey} role="list" aria-label="Suggestions">
        {q.isPending ? (
          <p className="muted">Loading the suggestions…</p>
        ) : !items.length ? (
          <p className="muted">No one looks listed twice.</p>
        ) : (
          items.map((s, i) => (
            <div key={s.id} role="listitem" onClick={() => setIndex(i)}>
              <SuggestionCard s={s} active={i === index} busy={busy} onMerge={(keepId, mergeIds) => doMerge(s, keepId, mergeIds)} onDecline={() => doDecline(s)} />
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

/** On a person's pane: who they may be the same as (merge or keep apart), and the merges into them (Undo). */
export function PersonMergeSection({ personId, personName }: { personId: string; personName: string }) {
  const toast = useToast();
  const canWrite = useMe().canWrite;
  const suggestions = useMergeSuggestions(personId);
  const filings = useFilings({ targetType: 'person', targetId: personId }, Boolean(personId));
  const { merge, decline, undo } = useMergeMutations();
  const merges = (filings.data?.items ?? []).filter((f) => f.action === 'merge' && f.status !== 'undone' && f.status !== 'rejected');
  const items = suggestions.data ?? [];
  if (!items.length && !merges.length) return null;
  return (
    <Section
      title={items.length ? 'May be the same person' : 'Merged into this person'}
      count={items.length || undefined}
      intro={items.length ? `Claude read these names in your records and thinks they may be ${personName}. Nothing is merged unless you say so.` : 'Undo puts each one back as it was, with its calls, messages and details.'}
    >
      {items.map((s) => (
        <SuggestionCard
          key={s.id}
          s={s}
          active={false}
          busy={merge.isPending || decline.isPending}
          onMerge={(keepId, mergeIds) =>
            merge.mutate(
              { keepId, mergeIds, suggestionId: s.id },
              { onSuccess: (r) => toast(mergeWords(r, [s.keep, ...s.others].find((p) => p.personId === keepId)?.name ?? s.keep.name), 'ok'), onError: (err) => toast(errorMessage(err, 'Could not merge them'), 'bad') },
            )
          }
          onDecline={() => decline.mutate(s.id, { onSuccess: () => toast('Kept apart; not suggested again.', 'ok') })}
        />
      ))}
      {merges.length && items.length ? <div className="pp-merge-subhead">Merged into {personName}</div> : null}
      {merges.length ? (
        <ul className="pp-merge-done">
          {merges.map((f) => (
            <li key={f.id}>
              <span>{f.summary}</span>
              {canWrite ? (
                <Button size="sm" variant="ghost" disabled={undo.isPending} onClick={() => undo.mutate(f.id, { onSuccess: () => toast('Undone: the entries are apart again, with their links.', 'ok'), onError: (err) => toast(errorMessage(err, 'Could not undo'), 'bad') })}>
                  Undo
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
