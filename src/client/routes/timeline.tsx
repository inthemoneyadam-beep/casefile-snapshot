/**
 * /timeline — one chronology over everything dated. Split view: the periods
 * left (a header per year, month or day, its items one line each: date, kind,
 * title, where it came from, a tag only when it says something), the selected
 * item right (features/timeline/TimelineDetail.tsx); with nothing selected the
 * pane says what to do.
 *
 * Above the list, the toolbar, each part labelled:
 *   Show:   All · Documents · Details · ... (only the kinds that have items)
 *   Zoom:   Years · Months · Days
 *   Find:   title, detail or person
 *   Dates:  the dates in view (a bar of the strip, the zoom or [ and ] set
 *           them) and Show all dates; only while some are set
 * then Clear filters and the keys; under it the density strip (click a bar to
 * see that period). At year and month zoom each period lists its first five
 * items, with "N more in 2024: show that year". Every filter, the zoom and the
 * selection live in the URL. The kinds are said in the app's words
 * (features/timeline/words.ts), never "fact", "contact" or "encounter".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useTimeline, useTimelineDensity, type TimelineItem } from '../api/timeline';
import { useRegisterCommands } from '../app/commands';
import { useBindings, isEditable } from '../app/shortcuts';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { SplitView } from '../ui/SplitView';
import { EmptyState, Loading, PageHeader } from '../ui/PageHeader';
import { DateText, KeepDatesWhole } from '../ui/DateText';
import { GroupHeader } from '../ui/GroupHeader';
import { FilterGroup, SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { TIMELINE_KINDS, isTimelineKind, timelineKey, type TimelineKind, type TimelineZoom } from '@shared/timeline';
import { DensityStrip, fillBuckets, stepBucket } from '../features/timeline/DensityStrip';
import { bucketEnd, bucketStart, groupLabel, widen, zoomIn, zoomOut, zoomToBucket } from '../features/timeline/zoom';
import { OverrideTag, RowStatus, TimelineDetail } from '../features/timeline/TimelineDetail';
import { KIND_WORDS, TIMELINE_INTRO, kindCount, kindWords, lowerFirst, rowDetail, subKindWords, trimTrailingDate } from '../features/timeline/words';
import { ToolbarKeys } from '../ui/Toolbar';
import '../features/timeline/timeline.css';

const PARTIAL = /^\d{4}(-\d{2}(-\d{2})?)?$/;

const searchSchema = z.object({
  from: z.string().regex(PARTIAL).optional().catch(undefined),
  to: z.string().regex(PARTIAL).optional().catch(undefined),
  kinds: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  zoom: z.enum(['years', 'months', 'days']).optional().catch(undefined),
  id: z.string().optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/timeline')({ component: TimelinePage, validateSearch: searchSchema });

const MAX_STRIP_BUCKETS = 1500;
const PREVIEW_PER_GROUP = 5;
const ZOOM_WORDS: Record<TimelineZoom, string> = { years: 'Years', months: 'Months', days: 'Days' };
const PERIOD_WORDS: Record<string, string> = { year: 'year', month: 'month', day: 'day' };

function parseKinds(s: string | undefined): Set<TimelineKind> | null {
  if (!s) return null;
  const ks = s.split(',').filter(isTimelineKind);
  return ks.length ? new Set(ks) : null;
}

const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

function TimelinePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const zoom: TimelineZoom = search.zoom ?? 'years';
  const bucket = zoomToBucket(zoom);
  const kindSet = useMemo(() => parseKinds(search.kinds), [search.kinds]);
  const selectedKey = search.id ?? null;

  const setSearch = useCallback(
    (patch: Partial<Search>, replace = false) => {
      void navigate({ search: (prev: Search) => ({ ...prev, ...patch }), replace });
    },
    [navigate],
  );

  const apiParams = useMemo(() => ({ from: search.from, to: search.to, kinds: search.kinds, q: search.q?.trim() || undefined }), [search.from, search.to, search.kinds, search.q]);
  // At year and month zoom only the first few items of each period are shown,
  // so only those are fetched; the period totals come from the density query.
  // Fetching the whole range instead ran into the row limit and dropped the
  // most recent periods.
  const preview = bucket !== 'day';
  const listParams = useMemo(() => (preview ? { ...apiParams, perBucket: PREVIEW_PER_GROUP, bucket } : apiParams), [apiParams, preview, bucket]);
  const list = useTimeline(listParams);
  const density = useTimelineDensity(bucket, apiParams);

  const rows = list.data?.items ?? [];
  const counts = list.data?.counts ?? {};
  const range = list.data?.range ?? { min: null, max: null };
  const shownKinds: readonly TimelineKind[] = kindSet ? [...kindSet] : TIMELINE_KINDS;
  const totalInView = shownKinds.reduce<number>((a, k) => a + (counts[k] ?? 0), 0);
  const allDated = TIMELINE_KINDS.reduce<number>((a, k) => a + (counts[k] ?? 0), 0);
  // Not while the previous zoom's rows stand in for this one (a preview list is short by design).
  const capped = Boolean(list.data) && !list.isPlaceholderData && !preview && rows.length < totalInView;

  // --- Window and strip extent -------------------------------------------
  const windowFrom = search.from ? bucketStart(search.from, bucket) : null;
  const windowTo = search.to ? bucketEnd(search.to, bucket) : null;
  const extentStart = windowFrom ?? (range.min ? bucketStart(range.min, bucket) : null);
  const extentEnd = windowTo ?? (range.max ? bucketEnd(range.max, bucket) : null);

  const buckets = useMemo(() => {
    if (!extentStart || !extentEnd || extentStart > extentEnd) return [];
    const all = fillBuckets(density.data?.items ?? [], bucket, extentStart, extentEnd);
    return all.length > MAX_STRIP_BUCKETS ? all.slice(all.length - MAX_STRIP_BUCKETS) : all;
  }, [density.data, bucket, extentStart, extentEnd]);

  // --- Grouping ------------------------------------------------------------
  const densityCounts = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    if (preview && density.data && density.data.bucket === bucket && !density.isPlaceholderData) for (const r of density.data.items) m.set(r.bucket, r.counts);
    return m;
  }, [preview, density.data, density.isPlaceholderData, bucket]);

  const groups = useMemo(() => {
    // total: every item in the period (null while the density query is loading).
    const map = new Map<string, { key: string; label: string; items: TimelineItem[]; byKind: Record<string, number>; total: number | null }>();
    for (const it of rows) {
      const key = bucket === 'day' ? it.date : bucketStart(it.date, bucket);
      let g = map.get(key);
      if (!g) {
        g = { key, label: bucket === 'day' ? '' : groupLabel(key, bucket), items: [], byKind: {}, total: null };
        map.set(key, g);
      }
      g.items.push(it);
      g.byKind[it.kind] = (g.byKind[it.kind] ?? 0) + 1;
    }
    for (const g of map.values()) {
      if (!preview) {
        g.total = g.items.length;
        continue;
      }
      const dc = densityCounts.get(g.key);
      if (!dc) continue;
      const byKind: Record<string, number> = {};
      for (const k of TIMELINE_KINDS) if (dc[k]) byKind[k] = dc[k];
      g.byKind = byKind;
      g.total = Math.max(g.items.length, Object.values(byKind).reduce((a, n) => a + n, 0));
    }
    return [...map.values()];
  }, [rows, bucket, preview, densityCounts]);

  const visible = useMemo(() => groups.flatMap((g) => (preview ? g.items.slice(0, PREVIEW_PER_GROUP) : g.items)), [groups, preview]);
  // A preview list holds only the first items of each period, so zooming out
  // can drop the selected item from it: keep showing the last one seen for
  // the same key instead of losing the detail panel.
  const [lastSelected, setLastSelected] = useState<TimelineItem | null>(null);
  const selected = useMemo(() => {
    if (!selectedKey) return null;
    const matches = (i: TimelineItem) => timelineKey(i) === selectedKey || i.id === selectedKey;
    const found = rows.find(matches);
    if (found) return found;
    const keep = preview && lastSelected && matches(lastSelected) && (!kindSet || kindSet.has(lastSelected.kind));
    return keep ? lastSelected : null;
  }, [rows, selectedKey, lastSelected, preview, kindSet]);
  useEffect(() => {
    if (selected && selected !== lastSelected) setLastSelected(selected);
  }, [selected, lastSelected]);
  const selectedIndex = selected ? visible.findIndex((i) => i === selected) : -1;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedKey || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(selectedKey)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, visible]);

  // --- Actions -------------------------------------------------------------
  const select = useCallback((it: TimelineItem | null) => setSearch({ id: it ? timelineKey(it) : undefined }, true), [setSearch]);

  const move = useCallback(
    (delta: number) => {
      if (!visible.length) return;
      const next = selectedIndex < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, selectedIndex + delta));
      select(visible[next]);
    },
    [visible, selectedIndex, select],
  );

  const open = useCallback(
    (it: TimelineItem | null) => {
      if (it) void navigate({ href: it.href });
    },
    [navigate],
  );

  const zoomInto = useCallback(
    (key: string) => {
      const next = zoomIn(zoom);
      if (!next) {
        const first = rows.find((i) => i.date === key || bucketStart(i.date, 'day') === key);
        if (first) select(first);
        return;
      }
      setSearch({ zoom: next, from: key, to: key, id: undefined });
    },
    [zoom, rows, select, setSearch],
  );

  const doZoomIn = useCallback(() => {
    const next = zoomIn(zoom);
    if (!next) return;
    if (search.from && search.to) {
      setSearch({ zoom: next });
      return;
    }
    // No window: open the most recent bucket at this level.
    const last = range.max ? bucketEnd(range.max, bucket) : null;
    setSearch({ zoom: next, from: last ?? undefined, to: last ?? undefined });
  }, [zoom, search.from, search.to, range.max, bucket, setSearch]);

  const doZoomOut = useCallback(() => {
    const prev = zoomOut(zoom);
    if (!prev) return;
    if (prev === 'years') {
      setSearch({ zoom: prev, from: undefined, to: undefined });
      return;
    }
    if (search.from && search.to) {
      const w = widen(search.from, search.to, 'year');
      setSearch({ zoom: prev, from: w.from, to: w.to });
    } else setSearch({ zoom: prev });
  }, [zoom, search.from, search.to, setSearch]);

  const shift = useCallback(
    (n: number) => {
      if (!range.max) return;
      if (windowFrom && windowTo) {
        setSearch({ from: stepBucket(windowFrom, bucket, n), to: stepBucket(windowTo, bucket, n), id: undefined });
      } else {
        const last = bucketEnd(range.max, bucket);
        setSearch({ from: last, to: last, id: undefined });
      }
    },
    [range.max, windowFrom, windowTo, bucket, setSearch],
  );

  const onlyKind = useCallback((k: TimelineKind) => setSearch({ kinds: k }), [setSearch]);
  const clearFilters = useCallback(() => setSearch({ from: undefined, to: undefined, kinds: undefined, q: undefined, id: undefined }), [setSearch]);

  // --- Text filter (debounced into the URL) ------------------------------
  const [qText, setQText] = useState(search.q ?? '');
  useEffect(() => setQText(search.q ?? ''), [search.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = qText.trim();
      if (v !== (search.q ?? '')) setSearch({ q: v || undefined }, true);
    }, 250);
    return () => clearTimeout(t);
  }, [qText, search.q, setSearch]);

  // --- Keys and commands ---------------------------------------------------
  useBindings(
    [
      { keys: 'j', description: 'Next item', group: 'Lists', run: () => move(1) },
      { keys: 'k', description: 'Previous item', group: 'Lists', run: () => move(-1) },
      { keys: '[', description: 'Earlier dates', group: 'Page', run: () => shift(-1) },
      { keys: ']', description: 'Later dates', group: 'Page', run: () => shift(1) },
      { keys: '-', description: 'Zoom out (days, months, years)', group: 'Page', run: doZoomOut },
      { keys: '=', description: 'Zoom in (years, months, days)', group: 'Page', run: doZoomIn },
    ],
    [move, shift, doZoomOut, doZoomIn],
  );

  // Enter and Escape are not registered globally: a global binding would
  // preventDefault them, stopping Enter from activating a focused button and
  // Escape from closing dialogs. Handle them only when nothing else owns them.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (isEditable(t) || t?.closest('button, a, select, dialog, [role="dialog"], [role="menu"]') || document.querySelector('dialog[open]')) return;
      if (e.key === 'Enter') {
        if (!selected) return;
        e.preventDefault();
        open(selected);
      } else if (selected) {
        e.preventDefault();
        select(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, open, select]);

  useRegisterCommands(
    [
      { id: 'timeline.zoom-in', title: 'Timeline: zoom in', group: 'Page', shortcut: '=', run: doZoomIn },
      { id: 'timeline.zoom-out', title: 'Timeline: zoom out', group: 'Page', shortcut: '-', run: doZoomOut },
      { id: 'timeline.earlier', title: 'Timeline: earlier dates', group: 'Page', shortcut: '[', run: () => shift(-1) },
      { id: 'timeline.later', title: 'Timeline: later dates', group: 'Page', shortcut: ']', run: () => shift(1) },
      { id: 'timeline.clear-window', title: 'Timeline: clear the dates and filters', group: 'Page', run: clearFilters },
      { id: 'timeline.open', title: 'Timeline: open the selected item', group: 'Page', shortcut: 'enter', run: () => open(selected), when: () => Boolean(selected) },
      ...TIMELINE_KINDS.map((k) => ({ id: `timeline.only.${k}`, title: `Timeline: show only ${lowerFirst(KIND_WORDS[k])}`, group: 'Page', keywords: `kind filter ${k}`, run: () => onlyKind(k) })),
    ],
    [doZoomIn, doZoomOut, shift, clearFilters, open, selected, onlyKind],
  );

  // The capped list holds the earliest items; offer the latest month instead.
  const narrowWindow = useCallback(() => {
    const end = search.to ?? range.max;
    if (!end) return;
    const month = bucketEnd(end, 'month');
    setSearch({ from: month, to: month, id: undefined });
  }, [search.to, range.max, setSearch]);

  // --- Render --------------------------------------------------------------
  const undated = counts.undated ?? 0;
  const anyFilter = Boolean(search.from || search.to || search.kinds || search.q);
  const nothingYet = list.isSuccess && !list.isPlaceholderData && allDated === 0 && !anyFilter;
  const period = PERIOD_WORDS[bucket];
  const showValue = kindSet ? (kindSet.size === 1 ? [...kindSet][0] : 'several') : 'all';
  const kindOptions = TIMELINE_KINDS.filter((k) => (counts[k] ?? 0) > 0 || kindSet?.has(k));

  const left = (
    <>
      <div className="timeline-list" ref={listRef} role="listbox" aria-label="Timeline items">
        {capped ? (
          <div className="notice warn small timeline-cap">
            Only the first {rows.length} of {totalInView} items in these dates are listed; the later ones are left out.{' '}
            <Button size="sm" variant="ghost" onClick={narrowWindow}>
              Show only the last month
            </Button>{' '}
            or step through the dates with <Kbd>[</Kbd> and <Kbd>]</Kbd>.
          </div>
        ) : null}
        {list.isPending ? (
          <Loading>Loading the timeline…</Loading>
        ) : list.isError ? (
          <Loading>Could not load the timeline: {list.error instanceof Error ? list.error.message : 'error'}</Loading>
        ) : !groups.length ? (
          <EmptyState
            title="Nothing matches"
            action={
              <Button variant="primary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            Nothing matches these dates, kinds and words. Clearing the filters shows the whole timeline again.
          </EmptyState>
        ) : (
          groups.map((g) => {
            const shownItems = preview ? g.items.slice(0, PREVIEW_PER_GROUP) : g.items;
            const more = preview ? (g.total == null ? (g.items.length >= PREVIEW_PER_GROUP ? null : 0) : g.total - shownItems.length) : 0;
            return (
              <section key={g.key} className="timeline-period" aria-label={bucket === 'day' ? g.key : g.label}>
                <GroupHeader
                  title={bucket === 'day' ? <DateText iso={g.items[0].date} precision={g.items[0].datePrecision} /> : g.label}
                  count={g.total ?? g.items.length}
                  noun={['item', 'items']}
                  actions={
                    preview && Object.keys(g.byKind).length ? (
                      <span className="timeline-period-kinds">
                        {Object.entries(g.byKind)
                          .map(([k, n]) => kindCount(k, n))
                          .join(' · ')}
                      </span>
                    ) : null
                  }
                />
                <div className="timeline-rows">
                  {shownItems.map((it) => {
                    const key = timelineKey(it);
                    const isSel = selected === it;
                    const sub = subKindWords(it.kind, it.subKind);
                    const title = trimTrailingDate(it.title, it.date);
                    const detail = rowDetail(it);
                    return (
                      <div
                        key={key}
                        data-key={key}
                        className={`timeline-item${isSel ? ' selected' : ''}`}
                        onClick={() => select(it)}
                        onDoubleClick={() => open(it)}
                        aria-selected={isSel}
                        role="option"
                        title={`${it.title}${it.detail ? `\n${it.detail}` : ''}`}
                      >
                        <span className="timeline-item-date">
                          <DateText iso={it.date} precision={it.datePrecision} />
                        </span>
                        <span className="timeline-item-kind" title={sub ?? undefined}>
                          {kindWords(it.kind, 1)}
                        </span>
                        <span className="timeline-item-body">
                          {/* Two lines at most, dates kept whole: the value, the date or the name that tells two items apart shows. */}
                          <span className="timeline-item-title">
                            <KeepDatesWhole text={title} />
                          </span>
                          {detail ? (
                            <span className="timeline-item-detail">
                              <KeepDatesWhole text={detail} />
                            </span>
                          ) : null}
                        </span>
                        <span className="timeline-item-tags">
                          <RowStatus item={it} />
                          <OverrideTag item={it} />
                        </span>
                      </div>
                    );
                  })}
                </div>
                {more === null || more > 0 ? (
                  <div className="timeline-more">
                    <Button size="sm" variant="ghost" onClick={() => zoomInto(g.key)} title={`Zoom in to every item of ${g.label}`}>
                      {more === null ? `More in ${g.label}: show that ${period}` : `${more} more in ${g.label}: show that ${period}`}
                    </Button>
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </div>
      <div className="table-foot">
        <span>
          {list.data && rows.length < totalInView
            ? preview
              ? `Showing ${visible.length} of ${items(totalInView)}: the first ${PREVIEW_PER_GROUP} of each ${period}. Zoom in to see them all.`
              : `Showing ${rows.length} of ${items(totalInView)}.`
            : items(visible.length)}
        </span>
        {undated ? <span>{undated} without a date (not shown)</span> : null}
      </div>
    </>
  );

  const right = selected ? (
    <TimelineDetail
      key={timelineKey(selected)}
      item={selected}
      onOpen={() => open(selected)}
      onClear={() => select(null)}
      onOnlyKind={kindSet?.size === 1 && kindSet.has(selected.kind) ? undefined : () => onlyKind(selected.kind)}
      onOpenDocument={selected.documentId ? () => void navigate({ to: '/documents/$id', params: { id: selected.documentId! } }) : undefined}
    />
  ) : visible.length ? (
    <EmptyState title="Pick an item">
      See it in full, where it came from and where it lives. Move with j and k; Enter opens it, Esc clears. A date known only to the month or the year is marked ~ and sits at the start of that month or year.
    </EmptyState>
  ) : list.isPending ? null : (
    <EmptyState title="Nothing to pick">When the list on the left shows items, pick one to see it in full, where it came from and where it lives.</EmptyState>
  );

  return (
    <div className="page">
      <PageHeader title="Timeline" meta={list.data && allDated ? <span className="mono">{`${allDated} dated item${allDated === 1 ? '' : 's'}${undated ? ` · ${undated} without a date` : ''}`}</span> : null} intro={TIMELINE_INTRO} />
      {nothingYet ? null : (
        <>
          <Toolbar label="Show, zoom and find">
            <Segmented
              label="Show"
              value={showValue}
              onChange={(v) => setSearch({ kinds: v === 'all' ? undefined : v, id: undefined })}
              options={[{ value: 'all', label: 'All', count: allDated || undefined, title: 'Everything with a date' }, ...kindOptions.map((k) => ({ value: k, label: KIND_WORDS[k], count: counts[k] ?? 0, title: `Only ${lowerFirst(KIND_WORDS[k])}` }))]}
            />
            <Segmented label="Zoom" value={zoom} onChange={(z) => setSearch({ zoom: z, ...(z === 'years' ? { from: undefined, to: undefined } : {}) })} options={(['years', 'months', 'days'] as TimelineZoom[]).map((z) => ({ value: z, label: ZOOM_WORDS[z], title: `One group per ${z.slice(0, -1)}` }))} />
            <SearchField label="Find" placeholder="Title, detail or person" value={qText} onChange={setQText} width={200} />
            {search.from || search.to ? (
              // The dates in view, set by a bar of the strip, the zoom or [ and ]: said, with the way back.
              <FilterGroup label="Dates">
                <span className="mono timeline-window">
                  {search.from ?? '…'} to {search.to ?? '…'}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSearch({ from: undefined, to: undefined, zoom: undefined, id: undefined })} title="Back to every year">
                  Show all dates
                </Button>
              </FilterGroup>
            ) : null}
            <ToolbarKeys
              items={[
                ['j/k', 'move'],
                ['enter', 'open'],
                ['esc', 'clear'],
                ['[/]', 'earlier, later'],
                ['-/=', 'zoom'],
                ['/', 'find'],
              ]}
            >
              {anyFilter ? (
                <Button size="sm" variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </ToolbarKeys>
          </Toolbar>
          <DensityStrip buckets={buckets} bucket={bucket} windowFrom={windowFrom} windowTo={windowTo} selectedKey={selected ? bucketStart(selected.date, bucket) : null} onPick={zoomInto} />
        </>
      )}
      <div className="page-body flush">
        {nothingYet ? (
          <EmptyState title="Nothing dated yet">Documents, the details read from them, appointments, calls, medication changes and lab values appear here in date order as they are added to the case.</EmptyState>
        ) : (
          <SplitView storageKey="timeline" defaultLeft={60} minLeft={480} minRight={400} left={left} right={right} />
        )}
      </div>
    </div>
  );
}
