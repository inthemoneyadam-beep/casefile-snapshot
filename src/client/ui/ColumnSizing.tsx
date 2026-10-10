/**
 * Resizable columns for DataTable and GroupedList (the decisions themselves
 * are pure, in columnLayout.ts).
 *
 *   const sizing = useColumnSizing({ storageKey, columns, wrapRef, tableRef, measureKey });
 *   <table ref={tableRef} className="data-table sized" style={{ width: sizing.tableWidth }} onPointerOver={showFullTextOnHover}>
 *     <ColGroup sizing={sizing} />
 *     <th>…label…<ColumnResizeHandle sizing={sizing} id={col.id} label="Test" /></th>
 *     <td className={sizing.cellClass(id, own)}>{sizing.cell(id, content)}</td>
 *     {sizing.filler ? <td className="dt-filler" aria-hidden="true" /> : null}
 *   </table>
 *   {sizing.customised ? <ResetColumns sizing={sizing} /> : null}
 *
 * The layout is `table-layout: fixed` with one <col> per column. Content
 * widths are measured in one pass (the `measuring` class lays the table out
 * by content, unwrapped, before the browser paints), again when the rows or
 * columns change. Dragging a header's right edge sets that column's width;
 * a double click fits it to the widest content on screen. Widths are kept per
 * table in localStorage (every read and write in try/catch).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { clampUserWidth, columnsOutOfView, fitWidth, headerWords, layoutColumns, outOfViewWords, planColumns, readWidths, sameWidths, writeWidths, type ColumnLayout, type ColumnPlan, type SizingColumn } from './columnLayout';

export interface ColumnSizingOptions {
  storageKey: string;
  columns: SizingColumn[];
  /** The scrolling element around the table: its inner width is the room there is. */
  wrapRef: RefObject<HTMLElement | null>;
  tableRef: RefObject<HTMLTableElement | null>;
  /** Changes when the content may need other widths (rows or columns changed). */
  measureKey: unknown;
}

export interface ColumnSizing extends ColumnLayout {
  plan: ColumnPlan[];
  planById: Record<string, ColumnPlan>;
  /** Width for the <table> element: the columns plus the filler. */
  tableWidth: number;
  /** The column being dragged, if any. */
  resizing: string | null;
  /** The person changed at least one width (offer Reset columns). */
  customised: boolean;
  startResize: (id: string, e: React.PointerEvent<HTMLElement>) => void;
  moveResize: (e: React.PointerEvent<HTMLElement>) => void;
  endResize: (e: React.PointerEvent<HTMLElement>) => void;
  fit: (id: string) => void;
  reset: () => void;
  /** Class for a body cell: the page's own, plus 'wrap' where the table clamps to two lines. */
  cellClass: (id: string, own?: string) => string | undefined;
  /** A body cell's content, inside the two-line clamp where the column wraps. */
  cell: (id: string, content: ReactNode) => ReactNode;
}

/**
 * Content width of every column, read with the table laid out by content (see
 * `.data-table.measuring` in base.css). A page's own max-width on a cell still
 * caps it, except with `full` (a double click asks for everything).
 */
export function measureColumns(table: HTMLTableElement, ids: string[], scroller?: HTMLElement | null, full = false): Record<string, number> {
  const out: Record<string, number> = {};
  const left = scroller?.scrollLeft ?? 0;
  const top = scroller?.scrollTop ?? 0;
  table.classList.add('measuring');
  if (full) table.classList.add('full');
  try {
    let cells: HTMLCollectionOf<HTMLTableCellElement> | null = null;
    const head = table.tHead?.rows[0];
    if (head && head.cells.length >= ids.length) cells = head.cells;
    else {
      const first = table.querySelector<HTMLTableRowElement>('tbody tr[data-id]');
      if (first && first.cells.length >= ids.length) cells = first.cells;
    }
    if (cells) {
      ids.forEach((id, i) => {
        const w = cells![i]?.getBoundingClientRect().width ?? 0;
        if (w > 0) out[id] = Math.ceil(w) + 1;
      });
    }
  } finally {
    table.classList.remove('measuring', 'full');
    if (scroller) {
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
    }
  }
  return out;
}

/** The event app/theme.ts sends after the theme, Large type or Reduced contrast changes. */
export const APPEARANCE_EVENT = 'casefile:appearance';

/**
 * A number that goes up whenever the appearance changes: Large type changes every text width, so a table measured
 * before the switch measures again (a date column never stays cut at "2026-09-…" until a reload).
 */
export function useAppearanceTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener(APPEARANCE_EVENT, on);
    return () => window.removeEventListener(APPEARANCE_EVENT, on);
  }, []);
  return tick;
}

function sizingSignature(columns: SizingColumn[]): string {
  return columns.map((c) => [c.id, c.meta?.grow ?? '', c.meta?.minWidth ?? '', c.meta?.maxWidth ?? '', c.meta?.wrap ?? '', c.meta?.width ?? '', c.meta?.className ?? '', c.meta?.shrink ?? ''].join('\u0002')).join('\u0001');
}

export function useColumnSizing({ storageKey, columns, wrapRef, tableRef, measureKey }: ColumnSizingOptions): ColumnSizing {
  const sig = sizingSignature(columns);
  const ids = useMemo(() => columns.map((c) => c.id), [sig]);
  const plan = useMemo(() => planColumns(columns), [sig]);
  const planById = useMemo(() => Object.fromEntries(plan.map((p) => [p.id, p])), [plan]);

  // Dragged widths, re-read when the table's storage key changes (adjusted during render, so a new key never sees old widths).
  const [userState, setUserState] = useState(() => ({ key: storageKey, widths: readWidths(storageKey, ids) }));
  let user = userState.widths;
  if (userState.key !== storageKey) {
    user = readWidths(storageKey, ids);
    setUserState({ key: storageKey, widths: user });
  }
  const setUser = useCallback(
    (next: Record<string, number>, persist: boolean) => {
      setUserState({ key: storageKey, widths: next });
      if (persist) writeWidths(storageKey, next);
    },
    [storageKey],
  );

  const [natural, setNatural] = useState<Record<string, number>>({});
  const [available, setAvailable] = useState(0);

  // The room there is: the scroller's inner width, followed as the pane or window changes.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setAvailable(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapRef]);

  // Content widths, before paint, whenever the rows or columns change, and after the type size or theme changes.
  const appearance = useAppearanceTick();
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const next = measureColumns(table, ids, wrapRef.current);
    setNatural((prev) => (sameWidths(prev, next) ? prev : next));
  }, [measureKey, ids, tableRef, wrapRef, appearance]);

  const layout = useMemo(() => layoutColumns(plan, { user, natural, available }), [plan, user, natural, available]);

  const drag = useRef<{ id: string; startX: number; startW: number; moved: boolean; widths: Record<string, number> } | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const userRef = useRef(user);
  userRef.current = user;

  const startResize = useCallback((id: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience; the drag still works while the pointer stays on the handle.
    }
    drag.current = { id, startX: e.clientX, startW: layoutRef.current.widths[id] ?? 100, moved: false, widths: userRef.current };
    setResizing(id);
  }, []);

  const moveResize = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < 2) return;
      d.moved = true;
      const w = clampUserWidth(d.startW + dx, planById[d.id]);
      if (d.widths[d.id] === w) return;
      d.widths = { ...d.widths, [d.id]: w };
      setUser(d.widths, false);
    },
    [planById, setUser],
  );

  const endResize = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setResizing(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released.
      }
      if (d.moved) setUser(d.widths, true);
    },
    [setUser],
  );

  const fit = useCallback(
    (id: string) => {
      const table = tableRef.current;
      if (!table) return;
      const w = fitWidth(measureColumns(table, ids, wrapRef.current, true)[id], planById[id]);
      if (w == null) return;
      setUser({ ...userRef.current, [id]: w }, true);
    },
    [ids, planById, setUser, tableRef, wrapRef],
  );

  const reset = useCallback(() => setUser({}, true), [setUser]);

  const cellClass = useCallback((id: string, own?: string) => {
    const clamp = planById[id]?.clamp;
    return [own ?? '', clamp ? 'wrap' : ''].join(' ').trim() || undefined;
  }, [planById]);

  const cell = useCallback((id: string, content: ReactNode) => (planById[id]?.clamp ? <div className="dt-clamp">{content}</div> : content), [planById]);

  return {
    ...layout,
    plan,
    planById,
    tableWidth: layout.total + layout.filler,
    resizing,
    customised: Object.keys(user).some((k) => k in planById),
    startResize,
    moveResize,
    endResize,
    fit,
    reset,
    cellClass,
    cell,
  };
}

/** One <col> per column (and the filler), carrying the widths. */
export function ColGroup({ sizing }: { sizing: ColumnSizing }) {
  return (
    <colgroup>
      {sizing.plan.map((p) => (
        <col key={p.id} style={{ width: sizing.widths[p.id] }} />
      ))}
      {sizing.filler > 0 ? <col className="dt-filler-col" style={{ width: sizing.filler }} /> : null}
    </colgroup>
  );
}

/** The grab strip on a header's right edge: drag to change the width, double click to fit the content. */
export function ColumnResizeHandle({ sizing, id, label }: { sizing: ColumnSizing; id: string; label?: string }) {
  const name = label ? `the ${label} column` : 'this column';
  return (
    <span
      className={`col-resize${sizing.resizing === id ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Width of ${name}`}
      title={`Drag to change the width of ${name}. Double-click to fit its contents.`}
      onPointerDown={(e) => sizing.startResize(id, e)}
      onPointerMove={sizing.moveResize}
      onPointerUp={sizing.endResize}
      onPointerCancel={sizing.endResize}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        sizing.fit(id);
      }}
    />
  );
}

/** The plain footer action that puts every width back. */
export function ResetColumns({ sizing }: { sizing: ColumnSizing }) {
  if (!sizing.customised) return null;
  return (
    <button type="button" className="table-foot-action" onClick={sizing.reset} title="Put the column widths back to how they started">
      Reset columns
    </button>
  );
}

/**
 * Columns out of view in a table wider than its pane (it scrolls sideways): their header words, to the right and to
 * the left of what shows. Read again on scroll and whenever the pane or the table changes size.
 */
export function useColumnsOutOfView(wrapRef: RefObject<HTMLElement | null>, tableRef: RefObject<HTMLTableElement | null>, key: unknown): { left: string[]; right: string[] } {
  const [cue, setCue] = useState<{ left: string[]; right: string[] }>({ left: [], right: [] });
  const appearance = useAppearanceTick();
  useEffect(() => {
    const wrap = wrapRef.current;
    const table = tableRef.current;
    if (!wrap || !table) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const head = table.tHead?.rows[0];
      if (!head || wrap.scrollWidth <= wrap.clientWidth + 1) {
        setCue((prev) => (prev.left.length || prev.right.length ? { left: [], right: [] } : prev));
        return;
      }
      const box = wrap.getBoundingClientRect();
      const view = { left: box.left + wrap.clientLeft, right: box.left + wrap.clientLeft + wrap.clientWidth };
      const cols = Array.from(head.cells)
        .filter((c) => !c.classList.contains('dt-filler'))
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { name: headerWords(c.textContent), left: r.left, right: r.right };
        });
      const next = columnsOutOfView(cols, view);
      setCue((prev) => (prev.left.join('|') === next.left.join('|') && prev.right.join('|') === next.right.join('|') ? prev : next));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    wrap.addEventListener('scroll', soon, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    ro?.observe(wrap);
    ro?.observe(table);
    return () => {
      wrap.removeEventListener('scroll', soon);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [wrapRef, tableRef, key, appearance]);
  return cue;
}

/**
 * The footer's cue for a table wider than its pane: which columns are out of view, and a plain button that scrolls
 * to them (Shift and the mouse wheel, or the scrollbar, do the same).
 */
export function ColumnsOutOfView({ cue, wrapRef }: { cue: { left: string[]; right: string[] }; wrapRef: RefObject<HTMLElement | null> }) {
  const words = outOfViewWords(cue);
  if (!words) return null;
  const toRight = cue.right.length > 0;
  return (
    <span className="table-cue" role="status">
      <span className="table-cue-words">{words}</span>
      <button
        type="button"
        className="table-foot-action"
        title={toRight ? 'Scroll the table to the right (or use Shift and the mouse wheel)' : 'Scroll the table back to the left'}
        onClick={() => {
          const el = wrapRef.current;
          if (el) el.scrollTo({ left: toRight ? el.scrollWidth : 0, behavior: 'smooth' });
        }}
      >
        {toRight ? 'Scroll right' : 'Scroll back'}
      </button>
    </span>
  );
}

/** The cell elements that may cut text short. */
const CLIPPERS = '.dt-clamp, .clamp2, .truncate';

/** True when a cell shows less than its whole text (cut with "…" or past two lines). */
export function isClipped(cell: HTMLElement): boolean {
  if (cell.scrollWidth > cell.clientWidth + 1) return true;
  for (const el of Array.from(cell.querySelectorAll<HTMLElement>(CLIPPERS))) {
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) return true;
  }
  return false;
}

/**
 * Table onPointerOver: a cell whose text is cut short shows all of it as a
 * hover title. A title the page set itself (on the cell or inside it) wins.
 */
export function showFullTextOnHover(e: React.PointerEvent<HTMLElement>): void {
  const target = e.target as Element | null;
  const cell = target?.closest?.('td, th') as HTMLElement | null;
  if (!cell || cell.classList.contains('dt-filler')) return;
  const ours = cell.dataset.autoTitle === '1';
  if (!ours && cell.hasAttribute('title')) return;
  const drop = () => {
    if (ours) {
      cell.removeAttribute('title');
      delete cell.dataset.autoTitle;
    }
  };
  if (cell.querySelector('[title]:not(.col-resize)')) return drop();
  if (!isClipped(cell)) return drop();
  const text = (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return drop();
  cell.title = text;
  cell.dataset.autoTitle = '1';
}
