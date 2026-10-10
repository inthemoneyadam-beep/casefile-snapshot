/**
 * Dense table with real sorting, filtering and keyboard row navigation.
 * Built on TanStack Table. Rows are selected (highlighted) with j/k or the
 * arrow keys, opened with Enter. The table element is focusable; features
 * can pass `autoFocus` to land the keyboard there on mount.
 *
 * Column widths (ui/columnLayout.ts decides, ui/ColumnSizing.tsx measures):
 *   - Drag a header's right edge to change a column's width; double-click the
 *     edge to fit the column to its widest content on screen. Widths are
 *     remembered per table in localStorage: under `tableId` when given, else
 *     under the route path plus the column ids. "Reset columns" in the footer
 *     (shown once a width was changed) puts them back.
 *   - One column takes the room that is left (the row's name). It is chosen
 *     from `meta.grow`, else a column with className 'fill', else the 'wrap'
 *     columns, else the first text column without a width. It never gets
 *     narrower than its minWidth (200px by default); when the columns need
 *     more room than the pane the table scrolls sideways instead of
 *     squashing text to "O...".
 *   - Every other column is as wide as its content (measured), at least
 *     `meta.width`, at most `meta.maxWidth` (default 240px). In a narrow pane
 *     the text columns give way first, so the grow column can show its
 *     content (up to 360px) before anything else is cut.
 *   - Text cut short shows in full on hover. The grow column wraps to two
 *     lines before it ends with "…".
 *
 * Column meta fields (`meta: { ... }` on a ColumnDef), all optional:
 *   className  string    extra class on the column's cells: 'num' (right,
 *                        monospace), 'fill' (the grow column), 'wrap' (the
 *                        page lays out wrapped text itself, e.g. .clamp2)
 *   width      number    starting width in px; content may widen it up to maxWidth
 *   grow       boolean   this column takes the room left; false keeps a
 *                        column out of the automatic choice
 *   minWidth   number    narrowest automatic width (grow default 200, others
 *                        36); also the narrowest a drag can make it
 *   maxWidth   number    widest automatic width (default 240; grow: none)
 *   wrap       boolean   two lines, then "…" (default on for the grow
 *                        column, off for the others)
 *   shrink     boolean   false keeps a text column at its content width when
 *                        the pane is narrow (default: text columns give way
 *                        to the grow column down to meta.width or 72px)
 * Example: { id: 'analyte', header: 'Test', meta: { grow: true, minWidth: 220 } },
 *          { id: 'value', header: 'Value', meta: { className: 'num', maxWidth: 140 } }
 *
 * Prop for widths: `tableId`, a stable name (e.g. 'labs.values') under which
 * the widths are remembered, so they survive a column being added.
 *
 * Above VIRTUAL_THRESHOLD (400) rows the body is windowed with useVirtualRows:
 * only the rows on screen plus an overscan are mounted. Windowed rows must
 * share one height, so the table gets the `virtual` class, which clamps
 * `wrap` cells (two-line clamps) to one line (base.css). Never look a row up
 * with querySelector(tr[data-id]); it may not be mounted. Use its index.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { chordPending } from '../app/shortcuts';
import { useVirtualRows, VirtualPad } from './VirtualRows';
import { columnStorageKey, type ColumnSizeMeta } from './columnLayout';
import { ColGroup, ColumnResizeHandle, ColumnsOutOfView, ResetColumns, showFullTextOnHover, useColumnSizing, useColumnsOutOfView } from './ColumnSizing';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // Column meta carries the width fields documented above (ColumnSizeMeta in columnLayout.ts).
  interface ColumnMeta<TData extends RowData, TValue> extends ColumnSizeMeta {}
}

export type { ColumnDef, SortingState, ColumnSizeMeta };

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  rowId: (row: T) => string;
  selectedId?: string | null;
  onSelect?: (row: T | null) => void;
  onOpen?: (row: T) => void;
  initialSort?: SortingState;
  globalFilter?: string;
  emptyText?: string;
  rowClassName?: (row: T) => string | undefined;
  footer?: ReactNode;
  autoFocus?: boolean;
  /** Extra key handling when the table has focus; return true to stop propagation. */
  onKey?: (e: React.KeyboardEvent, row: T | null) => boolean | void;
  maxRows?: number;
  /** Stable name under which this table's column widths are remembered (default: the route path and the column ids). */
  tableId?: string;
}

function currentPath(): string {
  try {
    return typeof window === 'undefined' ? '/' : window.location.pathname;
  } catch {
    return '/';
  }
}

export function DataTable<T>({
  columns,
  data,
  rowId,
  selectedId,
  onSelect,
  onOpen,
  initialSort = [],
  globalFilter = '',
  emptyText = 'Nothing here yet.',
  rowClassName,
  footer,
  autoFocus,
  onKey,
  maxRows = 20000,
  tableId,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => rowId(row),
    globalFilterFn: 'includesString',
  });

  const rows = table.getRowModel().rows;
  const shown = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  const selectedIndex = useMemo(() => (selectedId ? shown.findIndex((r) => r.id === selectedId) : -1), [shown, selectedId]);
  const v = useVirtualRows({ count: shown.length, scrollRef: wrapRef, bodyRef });

  const leafColumns = table.getVisibleLeafColumns();
  const sizingColumns = leafColumns.map((c) => ({ id: c.id, meta: (c.columnDef.meta ?? null) as ColumnSizeMeta | null }));
  // The route is read once per table: widths follow the page the table was opened on.
  const [path] = useState(currentPath);
  const storageKey = columnStorageKey(tableId, path, sizingColumns.map((c) => c.id));
  const measureKey = useMemo(() => ({}), [data, shown.length, columns, v.virtual]);
  const sizing = useColumnSizing({ storageKey, columns: sizingColumns, wrapRef, tableRef, measureKey });
  const outOfView = useColumnsOutOfView(wrapRef, tableRef, measureKey);
  const colSpan = leafColumns.length + (sizing.filler > 0 ? 1 : 0);

  useEffect(() => {
    if (autoFocus) wrapRef.current?.focus();
  }, [autoFocus]);

  // Keep the selected row in view: when the selection changes, and when the
  // selected row first appears (a deep link before the data arrived). By index,
  // since a windowed row may not be mounted.
  const selectedFound = selectedIndex >= 0;
  useEffect(() => {
    if (selectedIndex >= 0) v.scrollToIndex(selectedIndex);
  }, [selectedId, selectedFound]);

  function move(delta: number) {
    if (!shown.length) return;
    const next = selectedIndex < 0 ? (delta > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, selectedIndex + delta));
    onSelect?.(shown[next].original);
  }

  function handleKey(e: React.KeyboardEvent) {
    // The second key of a global chord (g e, v t) belongs to the chord, not to this list.
    if (chordPending()) return;
    const current = selectedIndex >= 0 ? shown[selectedIndex].original : null;
    if (onKey && onKey(e, current)) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        if (shown.length) onSelect?.(shown[0].original);
        break;
      case 'End':
        e.preventDefault();
        if (shown.length) onSelect?.(shown[shown.length - 1].original);
        break;
      case 'PageDown':
        e.preventDefault();
        move(15);
        break;
      case 'PageUp':
        e.preventDefault();
        move(-15);
        break;
      case 'Enter':
        if (current) {
          e.preventDefault();
          onOpen?.(current);
        }
        break;
      case 'Escape':
        onSelect?.(null);
        break;
    }
  }

  const tableClass = ['data-table', 'sized', v.virtual ? 'virtual' : '', sizing.resizing ? 'resizing' : ''].filter(Boolean).join(' ');

  return (
    <>
      <div className="table-wrap" ref={wrapRef} tabIndex={0} onKeyDown={handleKey} role="grid" aria-rowcount={shown.length + 1}>
        <table ref={tableRef} className={tableClass} style={sizing.tableWidth ? { width: sizing.tableWidth } : undefined} onPointerOver={showFullTextOnHover}>
          <ColGroup sizing={sizing} />
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const canSort = h.column.getCanSort();
                  const dir = h.column.getIsSorted();
                  const meta = (h.column.columnDef.meta ?? {}) as ColumnSizeMeta;
                  const header = h.column.columnDef.header;
                  return (
                    <th
                      key={h.id}
                      className={[canSort ? 'sortable' : '', meta.className ?? ''].join(' ').trim() || undefined}
                      onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                      title={canSort && typeof header === 'string' && header ? `Click to sort by ${header}; click again to reverse` : undefined}
                      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                    >
                      {h.isPlaceholder ? null : flexRender(header, h.getContext())}
                      {dir ? <span className="sort-ind">{dir === 'asc' ? '▴' : '▾'}</span> : null}
                      {h.isPlaceholder ? null : <ColumnResizeHandle sizing={sizing} id={h.column.id} label={typeof header === 'string' && header ? header : undefined} />}
                    </th>
                  );
                })}
                {sizing.filler > 0 ? <th className="dt-filler" aria-hidden="true" /> : null}
              </tr>
            ))}
          </thead>
          <tbody ref={bodyRef}>
            <VirtualPad height={v.padTop} colSpan={colSpan} />
            {shown.slice(v.start, v.end).map((row: Row<T>, i) => {
              const selected = row.id === selectedId;
              const extra = rowClassName?.(row.original);
              return (
                <tr
                  key={row.id}
                  data-id={row.id}
                  className={[selected ? 'selected' : '', extra ?? ''].join(' ').trim() || undefined}
                  onClick={() => onSelect?.(row.original)}
                  onDoubleClick={() => onOpen?.(row.original)}
                  aria-selected={selected}
                  aria-rowindex={v.start + i + 2}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = (cell.column.columnDef.meta ?? {}) as ColumnSizeMeta;
                    return (
                      <td key={cell.id} className={sizing.cellClass(cell.column.id, meta.className)}>
                        {sizing.cell(cell.column.id, flexRender(cell.column.columnDef.cell, cell.getContext()))}
                      </td>
                    );
                  })}
                  {sizing.filler > 0 ? <td className="dt-filler" aria-hidden="true" /> : null}
                </tr>
              );
            })}
            <VirtualPad height={v.padBottom} colSpan={colSpan} />
          </tbody>
        </table>
        {shown.length === 0 ? <div className="table-empty">{emptyText}</div> : null}
      </div>
      <div className="table-foot">
        <span>
          {shown.length}
          {rows.length > shown.length ? ` of ${rows.length}` : ''} {rows.length === 1 ? 'row' : 'rows'}
        </span>
        {footer}
        <ColumnsOutOfView cue={outOfView} wrapRef={wrapRef} />
        <ResetColumns sizing={sizing} />
      </div>
    </>
  );
}
