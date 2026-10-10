/**
 * /search — full-text search over the whole case: documents, every matching
 * page, details, people, calls and messages, records and the ledgers.
 *
 * Split view: the results on the left, grouped by kind (a page leads with its
 * date, then the document's name and the page; a detail shows its check and
 * the document it came from); the selected result read in place on the
 * right (features/search/HitPreview.tsx). "Show:" offers only the kinds that
 * have results, the rest under "Other types". The query, the kind and the
 * selection live in the URL (?q=, ?types=, ?id=) so a search can be linked to.
 *
 * Keys: / search box; j / k (or the arrows from the search box) move; Enter
 * opens where the result lives; Esc clears the selection; a asks the
 * clinician about the query.
 */
import { useMemo, useRef, type ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../api/client';
import type { FactListItem } from '../api/facts';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { dock } from '../app/dock';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { PREFILL_EVENT } from '../features/ask/live';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { SplitView } from '../ui/SplitView';
import { GroupedList, type GroupedListColumn, type GroupedListGroup } from '../ui/GroupedList';
import { Button } from '../ui/Button';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { MoreMenu } from '../ui/Menu';
import { SearchField, Segmented, Toolbar, type SegmentOption } from '../ui/Toolbar';
import { ToolbarKeys } from '../ui/Toolbar';
import { CheckTag } from '../features/reconcile/CheckTag';
import { highlightKeepDates, queryTokens } from '../features/search/highlight';
import { askCurrent, isActivatableTarget, MIN_QUERY, moveSelection, searchKeyBindings, type SearchKeyState } from '../features/search/keys';
import { countByType, formatCount, groupCountLabel, typeCount, type CountSource } from '../features/search/counts';
import { TYPE_LABELS, TYPE_ORDER, factStatusWords, hitTitle, parseTypes, resultCount, showChoices, type HitType } from '../features/search/words';
import { HitPreview, PreviewHint } from '../features/search/HitPreview';
import '../features/search/search.css';

export interface SearchHit {
  type: string;
  id: string;
  title: string;
  snippet?: string;
  date?: string | null;
  href: string;
  documentId?: string;
  pageNumber?: number;
  rank: number;
}

const LIMIT = 200;
const SEARCH_BOX = 'search-everything-q';

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  types: z.string().optional().catch(undefined),
  id: z.string().optional().catch(undefined),
});
export type SearchPageSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/search')({
  validateSearch: (s: Record<string, unknown>): SearchPageSearch => searchSchema.parse(s),
  component: SearchPage,
});

function hitKey(h: Pick<SearchHit, 'type' | 'id'>): string {
  return `${h.type}:${h.id}`;
}

function useHits(q: string, types: HitType[]) {
  const key = types.join(',');
  return useQuery({
    queryKey: ['search', 'page', q, key],
    queryFn: () => api.get<{ items: SearchHit[] }>(`/api/search${api.qs({ q, limit: LIMIT, allPages: 1, types: key || undefined })}`),
    enabled: q.length >= MIN_QUERY,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
}

/**
 * The check of every detail the search found (the same words as Details from documents), keyed by the detail's id.
 * The details list matches a query the same way the search does (and also by plain substring), so it covers them.
 */
function useFactChecks(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['search', 'fact-checks', q],
    queryFn: () => api.get<{ items: FactListItem[] }>(`/api/facts${api.qs({ q, limit: 1000 })}`),
    enabled: enabled && q.length >= MIN_QUERY,
    staleTime: 10_000,
    select: (r) => new Map(r.items.map((f) => [f.id, f])),
  });
}

/** Open the consult dock in find-in-the-records mode with the query; the composer listens for the prefill. */
function askTheClinician(text: string): void {
  dock('open', { presetKey: 'quick' });
  // live.ts keeps the latest prefill in a mailbox, so a dock that mounts after this event still receives it.
  window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail: { text, mode: 'search' } }));
}

function SearchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = (search.q ?? '').trim();
  const types = useMemo(() => parseTypes(search.types), [search.types]);
  const selectedKey = search.id ?? null;
  const ready = q.length >= MIN_QUERY;

  const all = useHits(q, []);
  const filtered = useHits(q, types);
  const source = types.length ? filtered : all;
  const tokens = useMemo(() => queryTokens(q), [q]);

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q, id: undefined }), replace: true }), { ms: 200, trim: true });

  // Both queries stop at LIMIT hits; a count from a query that hit the cap is a lower bound (shown with "+").
  const allCounts = useMemo<CountSource>(() => ({ byType: countByType(all.data?.items ?? []), capped: (all.data?.items.length ?? 0) >= LIMIT }), [all.data]);
  const filteredCounts = useMemo<CountSource | null>(
    () => (types.length && filtered.data && !filtered.isPlaceholderData ? { byType: countByType(filtered.data.items), capped: filtered.data.items.length >= LIMIT } : null),
    [types.length, filtered.data, filtered.isPlaceholderData],
  );
  const countOf = (t: HitType) => typeCount(t, allCounts, types.includes(t) ? filteredCounts : null);

  const groups = useMemo(() => {
    const items = source.data?.items ?? [];
    const shown = types.length ? items.filter((h) => (types as string[]).includes(h.type)) : items;
    return TYPE_ORDER.map((type) => ({ type, hits: shown.filter((h) => h.type === type) })).filter((g) => g.hits.length);
  }, [source.data, types]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const selectedIndex = selectedKey ? flat.findIndex((h) => hitKey(h) === selectedKey) : -1;
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : null;
  const checks = useFactChecks(q, groups.some((g) => g.type === 'fact'));

  function setSearch(patch: Partial<SearchPageSearch>, replace = true) {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  }
  function select(h: SearchHit | null) {
    setSearch({ id: h ? hitKey(h) : undefined });
  }
  function open(h: SearchHit | null) {
    if (!h) return;
    void navigate({ to: h.href });
  }
  function go(to: string) {
    void navigate({ to });
  }
  function showType(t: HitType | 'all') {
    setSearch({ types: t === 'all' ? undefined : t, id: undefined }, false);
  }

  // The bindings and commands below are registered once (on mount). They read the page through this ref at key
  // time; a handler that closed over this render's `flat` or `q` would keep the first render's (empty) values.
  const latest = useRef<SearchKeyState<SearchHit>>({ flat, selectedIndex, q });
  latest.current = { flat, selectedIndex, q };
  // select and open only navigate with a functional search update, so a once-captured copy stays correct.
  const keyActions = { select, open, ask: askTheClinician, focusOnControl: () => isActivatableTarget(document.activeElement) };
  function move(delta: number) {
    moveSelection(latest, keyActions, delta);
  }
  function ask() {
    askCurrent(latest, keyActions);
  }
  const focusBox = () => document.getElementById(SEARCH_BOX)?.focus();

  // j / k move, Enter opens (unless a focused button or link owns Enter), a asks; all read `latest`. Esc clears.
  useBindings([...searchKeyBindings(latest, keyActions), { keys: 'esc', description: 'Clear the selected result', group: 'Lists', when: () => latest.current.selectedIndex >= 0, run: () => select(null) }], []);

  useRegisterCommands(
    [
      { id: 'search.ask', title: 'Search: ask the clinician about this search', group: 'Page', keywords: 'clinician consult find records', shortcut: 'a', when: () => latest.current.q.length >= MIN_QUERY, run: ask },
      { id: 'search.open', title: 'Search: open the selected result', group: 'Page', shortcut: 'enter', when: () => latest.current.selectedIndex >= 0, run: () => open(latest.current.flat[latest.current.selectedIndex] ?? null) },
      { id: 'search.clear-types', title: 'Search: show every kind of result', group: 'Page', keywords: 'all types filter clear', when: () => types.length > 0, run: () => showType('all') },
      { id: 'search.focus', title: 'Search: go to the search box', group: 'Page', shortcut: '/', run: focusBox },
    ],
    [types.length],
  );

  const total = flat.length;
  const loading = ready && source.isPending;
  const sourceCapped = (source.data?.items.length ?? 0) >= LIMIT;

  // "Show:" offers the kinds with results; the rest wait under "Other types".
  const choices = showChoices((t) => countOf(t).n, types);
  const segValue = types.length === 0 ? 'all' : types.length === 1 ? types[0] : 'several';
  const segOptions: SegmentOption<string>[] = [
    { value: 'all', label: 'All', count: all.data ? `${all.data.items.length}${allCounts.capped ? '+' : ''}` : undefined, title: 'Every kind of result' },
    ...choices.shown.map((t) => ({ value: t, label: TYPE_LABELS[t], count: formatCount(countOf(t)), title: countOf(t).more ? `At least ${countOf(t).n}; a search stops at ${LIMIT} results` : undefined })),
    ...(types.length > 1 ? [{ value: 'several', label: 'Chosen kinds', count: String(total), title: types.map((t) => TYPE_LABELS[t]).join(', ') }] : []),
  ];

  const columns = useMemo<GroupedListColumn<SearchHit>[]>(
    () => [
      { id: 'date', header: 'Date', width: 100, shrink: false, cell: (h) => (h.date ? <DateText iso={h.date} /> : null) },
      { id: 'result', header: 'Result', grow: true, minWidth: 240, className: 'wrap', cell: (h) => <HitCell hit={h} tokens={tokens} check={h.type === 'fact' ? checks.data?.get(h.id) : undefined} /> },
    ],
    [tokens, checks.data],
  );
  const listGroups = useMemo<GroupedListGroup<SearchHit>[]>(
    () =>
      groups.map((g) => {
        const more = groupCountLabel(g.hits.length, countOf(g.type));
        return {
          key: g.type,
          header: (
            <>
              {TYPE_LABELS[g.type]}
              {more !== String(g.hits.length) ? <span className="search-group-more"> ({more} shown)</span> : null}
            </>
          ),
          rows: g.hits,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, allCounts, filteredCounts],
  );

  const keyHints = (
    <ToolbarKeys
      items={[
        ['/', 'search'],
        ['j/k', 'move'],
        ['enter', 'open'],
        ['esc', 'clear'],
        ready ? ['a', 'ask the clinician'] : null,
      ]}
    >
      {types.length ? (
        <Button size="sm" variant="ghost" onClick={() => showType('all')}>
          Clear filters
        </Button>
      ) : null}
    </ToolbarKeys>
  );

  const askRow = (
    <div className="search-ask-row">
      <span className="search-ask-words">
        Not what you need? Ask the clinician about <q>{q}</q>; the answer cites the pages it comes from.
      </span>
      <Button size="sm" variant="accent" onClick={ask} shortcut="a">
        Ask the clinician
      </Button>
    </div>
  );

  let body: ReactNode;
  if (!ready) {
    body = (
      <EmptyState title="Search the whole case">
        Type at least two letters in the search box. Every word must appear, and words match by their beginning, so “prot” finds protein. The results cover documents and their pages, details from documents, people, calls and messages, records, appointments, medications, allergies, lab results, scans, to-dos and what Claude noticed.
      </EmptyState>
    );
  } else if (loading) {
    body = <Loading>Searching…</Loading>;
  } else if (source.isError) {
    body = (
      <EmptyState title="The search did not work" action={<Button onClick={() => void source.refetch()}>Try again</Button>}>
        {source.error instanceof Error ? source.error.message : 'Something went wrong.'}
      </EmptyState>
    );
  } else if (!groups.length) {
    body = (
      <EmptyState
        title={`Nothing matches “${q}”${types.length ? ` in ${types.map((t) => TYPE_LABELS[t].toLowerCase()).join(', ')}` : ''}`}
        action={
          <div className="row wrap">
            {types.length ? (
              <Button variant="default" onClick={() => showType('all')}>
                Show every kind
              </Button>
            ) : null}
            <Button variant="accent" onClick={ask} shortcut="a">
              Ask the clinician instead
            </Button>
          </div>
        }
      >
        Try fewer words or the start of a word. The clinician can also look for it in other words across the whole case.
      </EmptyState>
    );
  } else {
    body = (
      <SplitView
        storageKey="search"
        defaultLeft={52}
        minLeft={420}
        minRight={420}
        left={
          <div className="search-list">
            {askRow}
            <GroupedList
              groups={listGroups}
              columns={columns}
              rowId={hitKey}
              selectedId={selectedKey}
              onSelect={select}
              onOpen={open}
              storageKey="search.results"
              rowNoun={['result', 'results']}
              emptyText="Nothing matches."
            />
          </div>
        }
        right={selected ? <HitPreview key={hitKey(selected)} hit={selected} tokens={tokens} onOpen={() => open(selected)} onGo={go} /> : <PreviewHint />}
      />
    );
  }

  return (
    <div className="page search-page">
      <PageHeader
        title="Search everything"
        meta={ready ? <span className="mono">{loading ? 'searching…' : `${resultCount(total, sourceCapped)} for “${q}”`}</span> : null}
        intro="Find a word or name in every document, page, detail and record of the case."
      />
      <Toolbar label="Search and filters">
        <SearchField
          id={SEARCH_BOX}
          label="Search"
          placeholder="A word or name, e.g. protein"
          width={340}
          autoFocus
          value={qLocal}
          onChange={setQLocal}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              open(selectedIndex >= 0 ? flat[selectedIndex] : (flat[0] ?? null));
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (selectedKey) select(null);
              else (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {ready && all.data?.items.length ? <Segmented label="Show" value={segValue} onChange={(v) => v !== 'several' && showType(v as HitType | 'all')} options={segOptions} /> : null}
        {ready && choices.other.length ? (
          <MoreMenu
            label="Other types"
            size="sm"
            align="left"
            title="Kinds of result that did not fit beside the others"
            items={choices.other.map((t) => ({ label: `${TYPE_LABELS[t]} (${formatCount(countOf(t))})`, text: TYPE_LABELS[t], onClick: () => showType(t) }))}
          />
        ) : null}
        {keyHints}
      </Toolbar>
      <div className={`page-body${ready && !loading && groups.length ? ' flush' : ''}`}>{body}</div>
    </div>
  );
}

/** One result in the list: its name (a page: the document and the page; a detail: its check and document), then where it matched. */
function HitCell({ hit, tokens, check }: { hit: SearchHit; tokens: string[]; check?: FactListItem }) {
  if (hit.type === 'fact') {
    const status = check ? null : factStatusWords(hit.snippet);
    return (
      <div className="search-hit">
        <div className="hit-title" title={check?.statement ?? hit.title}>
          {highlightKeepDates(check?.statement ?? hit.title, tokens)}
        </div>
        {check || status ? (
          <div className="hit-line">
            {check?.trust ? <CheckTag trust={check.trust} /> : status ? <span className="hit-status">{status}</span> : null}
            {check?.documentTitle ? <span className="hit-from">from <KeepDatesWhole text={check.documentTitle} /></span> : null}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="search-hit">
      <div className="hit-title" title={hitTitle(hit)}>
        {highlightKeepDates(hitTitle(hit), tokens)}
        {hit.type === 'page' && hit.pageNumber ? <span className="hit-page"> · page {hit.pageNumber}</span> : null}
      </div>
      {hit.snippet ? <div className="hit-snippet">{highlightKeepDates(hit.snippet, tokens)}</div> : null}
    </div>
  );
}
