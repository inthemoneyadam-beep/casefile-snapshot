/**
 * Ctrl+K. Reaches every page, every registered action, and (through
 * /api/search) every entity by title or content.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { FactListItem } from '../api/facts';
import { NAV } from './nav';
import { groupRank, groupWords, useCommands } from './commands';
import { Kbd } from '../ui/Kbd';
import { TYPE_ONE, isHitType } from '../features/search/words';

/** Only a page's or a document's match is text worth showing; other kinds' index lines carry stored codes. */
function shownSnippet(h: SearchHit): string | null {
  return (h.type === 'page' || h.type === 'document') && h.snippet ? h.snippet : null;
}

/**
 * Where the keyboard goes when the palette closes: back to what had it when the palette opened (a list keeps j / k),
 * or, when that is gone (the command moved to another page), the page's list. Nothing moves when the command itself
 * put the focus somewhere (a dialog it opened).
 */
export function restoreFocus(returnTo: HTMLElement | null, doc: Document = document): void {
  const now = doc.activeElement;
  if (now && now !== doc.body && now !== doc.documentElement) return;
  if (returnTo?.isConnected) {
    returnTo.focus();
    return;
  }
  doc.querySelector<HTMLElement>('.split-left [role="grid"], [role="grid"]')?.focus();
}

export interface SearchHit {
  type: string; // document | fact | person | communication | record | task | finding | encounter | medication | lab | imaging
  id: string;
  title: string;
  snippet?: string;
  date?: string | null;
  href: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const commands = useCommands();
  const inputRef = useRef<HTMLInputElement>(null);
  /** What had the keyboard when the palette opened; it gets it back on close. */
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query ?? '';
      const active = document.activeElement;
      // A second ctrl+k while open keeps the first opener.
      if (!inputRef.current) returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
      setQuery(q);
      setOpen(true);
    };
    window.addEventListener('casefile:palette', onOpen);
    return () => window.removeEventListener('casefile:palette', onOpen);
  }, []);

  // Tab stays in the palette: its one field is the only stop (the results move with the arrow keys), so Tab never
  // reaches the sidebar behind the backdrop.
  useEffect(() => {
    if (!open) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onTab, true);
    return () => window.removeEventListener('keydown', onTab, true);
  }, [open]);

  const trimmed = query.trim();
  const search = useQuery({
    queryKey: ['palette-search', trimmed],
    queryFn: () => api.get<{ items: SearchHit[] }>(`/api/search${api.qs({ q: trimmed, limit: 25 })}`),
    enabled: open && trimmed.length >= 2,
    staleTime: 10_000,
  });

  // A detail found by the search names the document it came from, so five details that say the same thing ("Lumbar
  // puncture performed on 2024-03-18") read apart. The same lookup the Search everything page makes for its checks.
  const factHits = Boolean(search.data?.items.some((h) => h.type === 'fact'));
  const factSources = useQuery({
    queryKey: ['palette-fact-sources', trimmed],
    queryFn: () => api.get<{ items: FactListItem[] }>(`/api/facts${api.qs({ q: trimmed, limit: 500 })}`),
    enabled: open && trimmed.length >= 2 && factHits,
    staleTime: 10_000,
    select: (r) => new Map(r.items.map((f) => [f.id, f.documentTitle])),
  });

  // This page's actions first (audit S-11), then every page under "Go to a page".
  const grouped = useMemo(() => {
    // Grouped by the name the reader sees, so two internal keys for one page ("Tasks", "To-do list") make one group.
    const g = new Map<string, typeof commands>();
    for (const c of commands) {
      const k = groupWords(c.group);
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(c);
    }
    return new Map([...g.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0])));
  }, [commands]);

  function close() {
    setOpen(false);
    setQuery('');
    const back = returnTo.current;
    returnTo.current = null;
    // After the command ran and React drew: a dialog it opened keeps the focus it took.
    requestAnimationFrame(() => restoreFocus(back));
  }

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <Command className="palette" label="Command palette" shouldFilter={true} loop>
        <Command.Input ref={inputRef} autoFocus value={query} onValueChange={setQuery} placeholder="Go to, do, or find anything…" onKeyDown={(e) => e.key === 'Escape' && close()} />
        <Command.List>
          <Command.Empty>{trimmed.length >= 2 && search.isFetching ? 'Searching…' : 'No matches.'}</Command.Empty>
          {search.data?.items.length ? (
            <Command.Group heading="Search results">
              {search.data.items.map((h) => {
                const from = h.type === 'fact' ? (factSources.data?.get(h.id) ?? null) : null;
                return (
                  <Command.Item
                    key={`${h.type}:${h.id}`}
                    value={`${h.type} ${h.title} ${h.snippet ?? ''} ${from ?? ''} ${h.id}`}
                    onSelect={() => {
                      close();
                      void navigate({ to: h.href });
                    }}
                  >
                    <span className="truncate">
                      {/* A detail that names its document says only "Detail": the room goes to the words that tell it apart. */}
                      <span className="palette-kind">{from ? 'Detail' : isHitType(h.type) ? TYPE_ONE[h.type] : h.type.replace(/_/g, ' ')}</span>
                      {h.title}
                      {from ? <span className="muted"> — from {from}</span> : shownSnippet(h) ? <span className="muted"> — {shownSnippet(h)}</span> : null}
                    </span>
                    <span className="meta">{h.date ?? ''}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          ) : null}
          {[...grouped.entries()].map(([group, list]) => (
            <Command.Group key={group} heading={group}>
              {list.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.title} ${c.keywords ?? ''}`}
                  onSelect={() => {
                    close();
                    void c.run();
                  }}
                >
                  <span>{c.title}</span>
                  {c.shortcut ? (
                    <span className="meta">
                      <Kbd>{c.shortcut}</Kbd>
                    </span>
                  ) : null}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          <Command.Group heading="Go to a page">
            {NAV.map((n) => (
              <Command.Item
                key={n.to}
                value={`go to ${n.label}`}
                onSelect={() => {
                  close();
                  void navigate({ to: n.to });
                }}
              >
                <span>{n.label}</span>
                <span className="meta">
                  <Kbd>{n.chord}</Kbd>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
        <div className="palette-foot">
          <span>
            <Kbd>enter</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
          <span>Type two or more letters to search documents, details, people and more</span>
        </div>
      </Command>
    </div>
  );
}
