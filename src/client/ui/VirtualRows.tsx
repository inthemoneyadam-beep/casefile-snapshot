/**
 * VirtualRows: windowed rendering for long lists. A list of 20 000 rows
 * mounts the rows on screen plus an overscan, with two spacers standing in
 * for the rest, so scrolling and j/k stay instant.
 *
 * Rows must share one height: single-line rows, as DataTable's are (`td` is
 * nowrap at --row-height). The height is read from `--row-height` on the
 * scroll element, then corrected from the first rendered row (borders, the
 * large-type toggle), so it follows the theme without a prop.
 *
 * Hook, for a table or any list that renders its own rows:
 *
 *   const v = useVirtualRows({ count, scrollRef, bodyRef });
 *   <div className="table-wrap" ref={scrollRef}>          // the element that scrolls
 *     <table><thead>…</thead>
 *       <tbody ref={bodyRef}>                              // parent of the rows
 *         <VirtualPad height={v.padTop} colSpan={n} />
 *         {rows.slice(v.start, v.end).map(renderRow)}
 *         <VirtualPad height={v.padBottom} colSpan={n} />
 *       </tbody></table></div>
 *
 *   options   count        number of rows
 *             scrollRef    ref to the scrolling element
 *             bodyRef      ref to the rows' parent (measures where row 0 starts
 *                          below a header and the real row height); optional
 *             enabled      default true; false always renders every row
 *             threshold    default VIRTUAL_THRESHOLD (400): windowing starts above it
 *             overscan     default VIRTUAL_OVERSCAN (20) rows above and below
 *   returns   virtual      false below the threshold: render every row, pads are 0
 *             start, end   render rows [start, end)
 *             padTop, padBottom   spacer heights in px
 *             rowHeight    the height in use
 *             scrollToIndex(i)    bring row i into view ("nearest", below a sticky
 *                          header of the measured offset); use it where a mounted
 *                          row would get scrollIntoView, since row i may not exist
 *
 * Component, for a plain list of divs:
 *
 *   <VirtualRows count={items.length} scrollRef={ref} render={(i) => <div key={items[i].id} className="…">…</div>} />
 *
 * The window moves in steps of WINDOW_STEP rows, so a scroll re-renders every
 * few rows rather than on every pixel. `computeWindow` and `scrollTarget` are
 * the pure geometry, exported for tests.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** Lists longer than this are windowed (DataTable's rule). */
export const VIRTUAL_THRESHOLD = 400;
/** Rows rendered beyond each edge of the viewport. */
export const VIRTUAL_OVERSCAN = 20;
/** The rendered window starts on a multiple of this many rows. */
export const WINDOW_STEP = 10;
/** Used until the CSS variable or a row can be measured (tokens.css --row-height). */
export const FALLBACK_ROW_HEIGHT = 30;

export interface WindowInput {
  count: number;
  rowHeight: number;
  /** scrollTop of the scrolling element. */
  scrollTop: number;
  /** clientHeight of the scrolling element. */
  viewportHeight: number;
  /** Distance from the top of the scrolled content to row 0 (a header above the rows). */
  offset?: number;
  overscan?: number;
  step?: number;
}

export interface RowWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** The rows to render for a scroll position: at least `overscan` rows beyond each edge of the viewport. */
export function computeWindow({ count, rowHeight, scrollTop, viewportHeight, offset = 0, overscan = VIRTUAL_OVERSCAN, step = WINDOW_STEP }: WindowInput): RowWindow {
  const n = Math.max(0, Math.floor(count));
  if (!n) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const rh = rowHeight > 0 ? rowHeight : FALLBACK_ROW_HEIGHT;
  const s = Math.max(1, Math.floor(step));
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rh) + 1);
  const first = Math.min(n - 1, Math.max(0, Math.floor((scrollTop - offset) / rh)));
  const base = Math.floor(first / s) * s;
  const start = Math.max(0, base - overscan);
  const end = Math.min(n, base + s + visible + overscan);
  return { start, end, padTop: start * rh, padBottom: (n - end) * rh };
}

export interface ScrollTargetInput {
  index: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  offset?: number;
  /** Pixels at the top covered by a sticky header (defaults to the offset). */
  stickyTop?: number;
}

/** The scrollTop that brings row `index` fully into view with the least movement, or null when it already is. */
export function scrollTarget({ index, rowHeight, scrollTop, viewportHeight, offset = 0, stickyTop = offset }: ScrollTargetInput): number | null {
  const rh = rowHeight > 0 ? rowHeight : FALLBACK_ROW_HEIGHT;
  const top = offset + index * rh;
  const bottom = top + rh;
  if (top < scrollTop + stickyTop) return Math.max(0, top - stickyTop);
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return null;
}

/** `--row-height` on an element, in px, or null when it is not a px length. */
export function cssRowHeight(el: Element | null): number | null {
  if (!el || typeof getComputedStyle !== 'function') return null;
  const raw = getComputedStyle(el).getPropertyValue('--row-height').trim();
  if (!raw.endsWith('px')) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface VirtualRowsOptions {
  count: number;
  scrollRef: RefObject<HTMLElement | null>;
  bodyRef?: RefObject<HTMLElement | null>;
  enabled?: boolean;
  threshold?: number;
  overscan?: number;
}

export interface VirtualWindow extends RowWindow {
  virtual: boolean;
  rowHeight: number;
  scrollToIndex: (index: number) => void;
}

interface Geometry {
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  offset: number;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The first rendered row (not a spacer) under the rows' parent. */
function firstRow(body: HTMLElement | null | undefined): HTMLElement | null {
  if (!body) return null;
  for (const el of Array.from(body.children)) if (!(el as HTMLElement).hasAttribute('data-virtual-pad')) return el as HTMLElement;
  return null;
}

export function useVirtualRows({ count, scrollRef, bodyRef, enabled = true, threshold = VIRTUAL_THRESHOLD, overscan = VIRTUAL_OVERSCAN }: VirtualRowsOptions): VirtualWindow {
  const virtual = enabled && count > threshold;
  const [geo, setGeo] = useState<Geometry>({ scrollTop: 0, viewport: 0, rowHeight: FALLBACK_ROW_HEIGHT, offset: 0 });
  const geoRef = useRef(geo);
  geoRef.current = geo;

  const measure = useCallback((): Geometry | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const body = bodyRef?.current ?? null;
    const prev = geoRef.current;
    let rowHeight = cssRowHeight(el) ?? prev.rowHeight;
    const row = firstRow(body);
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h > 0) rowHeight = h;
    }
    const offset = body ? Math.max(0, body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop) : 0;
    return { scrollTop: el.scrollTop, viewport: el.clientHeight, rowHeight, offset };
  }, [scrollRef, bodyRef]);

  // Scroll and resize listeners, only while windowing.
  useEffect(() => {
    if (!virtual) return;
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const g = measure();
      if (!g) return;
      const p = geoRef.current;
      const before = computeWindow({ count, rowHeight: p.rowHeight, scrollTop: p.scrollTop, viewportHeight: p.viewport, offset: p.offset, overscan });
      const after = computeWindow({ count, rowHeight: g.rowHeight, scrollTop: g.scrollTop, viewportHeight: g.viewport, offset: g.offset, overscan });
      const sameWindow = before.start === after.start && before.end === after.end;
      if (sameWindow && Math.abs(p.rowHeight - g.rowHeight) < 0.5 && p.viewport === g.viewport && Math.abs(p.offset - g.offset) < 0.5) return;
      setGeo(g);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    update();
    return () => {
      el.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtual, count, overscan, scrollRef, measure]);

  // After each render: correct the row height and header offset from the DOM (cheap: one or two rects).
  useIsoLayoutEffect(() => {
    if (!virtual) return;
    const g = measure();
    if (!g) return;
    const p = geoRef.current;
    if (Math.abs(p.rowHeight - g.rowHeight) >= 0.5 || Math.abs(p.offset - g.offset) >= 0.5 || p.viewport !== g.viewport) setGeo({ ...g, scrollTop: p.scrollTop });
  });

  const win = virtual
    ? computeWindow({ count, rowHeight: geo.rowHeight, scrollTop: geo.scrollTop, viewportHeight: geo.viewport || 800, offset: geo.offset, overscan })
    : { start: 0, end: count, padTop: 0, padBottom: 0 };

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || index < 0 || index >= count) return;
      if (!virtual) {
        const body = bodyRef?.current;
        const rows = body ? Array.from(body.children).filter((c) => !(c as HTMLElement).hasAttribute('data-virtual-pad')) : [];
        (rows[index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      const g = measure() ?? geoRef.current;
      const target = scrollTarget({ index, rowHeight: g.rowHeight, scrollTop: el.scrollTop, viewportHeight: el.clientHeight, offset: g.offset });
      if (target !== null) el.scrollTop = target;
    },
    [virtual, count, scrollRef, bodyRef, measure],
  );

  return { virtual, ...win, rowHeight: geo.rowHeight, scrollToIndex };
}

/**
 * A spacer standing in for rows that are not rendered. Inside a `<tbody>` it
 * is a `<tr>` with one cell spanning `colSpan` columns; with `as="div"` a div.
 * It takes no pointer events (no hover highlight, no clicks) and is hidden
 * from assistive tech. Renders nothing for a height of 0.
 */
export function VirtualPad({ height, colSpan = 1, as = 'tr' }: { height: number; colSpan?: number; as?: 'tr' | 'div' }) {
  if (!(height > 0)) return null;
  if (as === 'div') return <div aria-hidden="true" data-virtual-pad="" style={{ height, pointerEvents: 'none' }} />;
  return (
    <tr aria-hidden="true" data-virtual-pad="" style={{ pointerEvents: 'none' }}>
      <td colSpan={colSpan} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

/**
 * A windowed list of divs. `render(i)` returns row i with a key; every row
 * must have the same height. `scrollRef` is the element that scrolls (it may
 * be this list's parent or an ancestor).
 */
export function VirtualRows({
  count,
  scrollRef,
  render,
  className,
  threshold = VIRTUAL_THRESHOLD,
  overscan = VIRTUAL_OVERSCAN,
}: {
  count: number;
  scrollRef: RefObject<HTMLElement | null>;
  render: (index: number) => ReactNode;
  className?: string;
  threshold?: number;
  overscan?: number;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const v = useVirtualRows({ count, scrollRef, bodyRef, threshold, overscan });
  const rows: ReactNode[] = [];
  for (let i = v.start; i < v.end; i++) rows.push(render(i));
  return (
    <div ref={bodyRef} className={className}>
      <VirtualPad as="div" height={v.padTop} />
      {rows}
      <VirtualPad as="div" height={v.padBottom} />
    </div>
  );
}
