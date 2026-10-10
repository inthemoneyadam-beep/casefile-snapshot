import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { useToast } from '../../ui/Toast';
import { ApiError } from '../../api/client';
import { usePeopleMutations, usePersonSuggestions, type PersonRow, type PersonSuggestion } from '../../api/people';
import { factTypeWords, plural } from './shared';

/**
 * Names Claude read in the documents (facts.attributes._people) that are not
 * on People and places yet. They are Claude's reading, unchecked, so each row
 * can show the details that named it (o, or "Where it came from"), each
 * linking to the detail and its page. j/k move, Enter adds the selected name
 * as a clinician, i as a place (hospital or institution); the new entry's
 * notes record which details it came from. The list refreshes after each add.
 */
export function SuggestionsDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (p: PersonRow) => void }) {
  const toast = useToast();
  const q = usePersonSuggestions(open);
  const { accept } = usePeopleMutations();
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const items = q.data?.items ?? [];

  useEffect(() => {
    if (open) {
      setIndex(0);
      setShown(new Set());
      setTimeout(() => listRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  function toggleSources(name: string) {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function create(s: PersonSuggestion, kind: 'clinician' | 'institution') {
    try {
      const p = await accept.mutateAsync({ name: s.name, kind, factIds: s.factIds });
      toast(`Added ${p.name} as ${kind === 'clinician' ? 'a clinician' : 'a place'}.`, 'ok');
      onCreated?.(p);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add.', 'bad');
    }
  }

  function onKey(e: React.KeyboardEvent) {
    // Enter/Space on a focused source link or button inside the list keep their own meaning.
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('a, button') && (e.key === 'Enter' || e.key === ' ')) return;
    const cur = items[index];
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        setIndex((i) => Math.min(items.length - 1, i + 1));
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
        break;
      case 'o':
        if (cur) {
          e.preventDefault();
          toggleSources(cur.name);
        }
        break;
      case 'Enter':
        if (cur) {
          e.preventDefault();
          void create(cur, 'clinician');
        }
        break;
      case 'i':
        if (cur) {
          e.preventDefault();
          void create(cur, 'institution');
        }
        break;
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Names found in your documents"
      width={720}
      footer={
        <>
          {items.length ? (
            <span className="pp-dialog-keys">
              Keys: <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>o</Kbd> where it came from · <Kbd>enter</Kbd> add as a clinician · <Kbd>i</Kbd> add as a place
            </span>
          ) : null}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <p className="pp-dialog-intro">
        Names Claude read in your documents that are not on your list yet. Check where each came from before adding it: a name can be misread, split differently, or a hospital read as a person. Names and other spellings already on the list are left out.
      </p>
      {q.isPending ? (
        <p className="pp-dialog-intro">Looking through your documents…</p>
      ) : items.length === 0 ? (
        <p className="pp-dialog-intro">No new names to suggest. Names come from the details Claude pulls out of your documents; none of them names a person or place that is not on your list.</p>
      ) : (
        <div className="suggest-list" ref={listRef} tabIndex={0} onKeyDown={onKey} role="listbox" aria-activedescendant={items[index] ? `sug-${index}` : undefined}>
          {items.map((s, i) => {
            const expanded = shown.has(s.name);
            return (
              <div key={s.name} id={`sug-${i}`} className={`suggest-row${i === index ? ' selected' : ''}`} onClick={() => setIndex(i)} role="option" aria-selected={i === index}>
                <span className="pp-suggest-name">
                  {s.name}
                  <span className="pp-ledger-sub">
                    {plural(s.count, 'mention')} in {s.factTypes.map((t) => factTypeWords(t)).join(', ')}
                  </span>
                </span>
                <span className="row" style={{ gap: 'var(--sp-2)' }}>
                  <Button size="sm" variant="ghost" onClick={() => toggleSources(s.name)} aria-expanded={expanded}>
                    {expanded ? 'Hide where' : 'Where it came from'}
                  </Button>
                  <Button size="sm" onClick={() => void create(s, 'clinician')} disabled={accept.isPending} title={`Add ${s.name} as a clinician`}>
                    Add as a clinician
                  </Button>
                  <Button size="sm" onClick={() => void create(s, 'institution')} disabled={accept.isPending} title={`Add ${s.name} as a hospital or institution`}>
                    Add as a place
                  </Button>
                </span>
                {expanded ? (
                  <ul className="suggest-sources">
                    {s.sources.map((src) => (
                      <li key={src.factId}>
                        <span className="pp-ledger-sub">{factTypeWords(src.type)}</span>
                        <Link to="/facts" search={{ id: src.factId }} className="truncate" title={src.statement}>
                          {src.statement}
                        </Link>
                        <span className="pp-ledger-sub truncate">{src.documentTitle ?? 'No document'}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
