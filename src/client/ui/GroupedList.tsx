/**
 * GroupedList: a dense table whose rows sit under headers instead of among
 * each other, so the CSF studies stack together and a document's results
 * read as one block. Headers do the differentiating; there is no colour.
 *
 * Renders `groups` of `{ key, header, rows?, subgroups? }` inside a
 * `.table-wrap` as one `<table class="data-table">`: a sticky `.group-header`
 * row per group (sans, semibold, a caret that says it folds, and its count:
 * "CSF  10 tests"), a sticky `.group-subheader` row per subgroup (one step
 * down: "CSF basic  9 tests"), then one `<tr>` per row built from `columns`.
 * A group or subgroup with `rule: true` (CSF) carries a thin left rule on its
 * header. `rowNoun` names what a row is ("test", or ['study', 'studies']) so
 * the counts read as words.
 *
 * Keyboard, while the list has focus (pass `autoFocus`, as with DataTable):
 *   j / k, arrows   move across every visible row, through every group
 *   Enter           opens the selected row (`onOpen`); double click does too
 *   h               collapses or expands the group of the selected row
 *                   (the first group when nothing is selected)
 *   Home / End      first / last row;  PageUp / PageDown  15 rows
 *   Esc             clears the selection
 * Collapsed groups are remembered per `storageKey` in sessionStorage, so each
 * route keeps its own state for the session. Clicking a header toggles it.
 *
 * Props
 *   groups        GroupedListGroup<T>[]   already in display order
 *   columns       GroupedListColumn<T>[]  { id, header, cell(row), width?, className?,
 *                                         grow?, minWidth?, maxWidth?, wrap?, shrink? }
 *   rowId         (row) => string         stable id; selection is by id
 *   selectedId    string | null
 *   onSelect      (row | null) => void
 *   onOpen        (row) => void
 *   storageKey    string                  e.g. 'labs.panels'
 *   emptyText, rowClassName, footer, autoFocus, showColumnHeaders (default true)
 *   onKey         (e, row) => boolean      extra keys; return true to stop
 *   rowNoun       string | [one, many]     what a row is, for the counts ("test")
 *
 * Column widths work as in DataTable (see its header and ui/columnLayout.ts):
 * drag a header's right edge to resize, double-click it to fit the content,
 * "Reset columns" in the footer puts them back; widths are remembered per
 * `storageKey` and column ids in localStorage. One column takes the room left
 * (`grow`, else className 'fill', else the first text column without a width)
 * and never gets narrower than `minWidth` (200px by default); the table
 * scrolls sideways when the columns need more room than the pane. `width` is
 * a starting width (content may widen it up to `maxWidth`, default 240).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { chordPending } from '../app/shortcuts';
import { columnStorageKey, type ColumnSizeMeta } from './columnLayout';
import { countWords } from './GroupHeader';
import { ColGroup, ColumnResizeHandle, ColumnsOutOfView, ResetColumns, showFullTextOnHover, useColumnSizing, useColumnsOutOfView } from './ColumnSizing';

export interface GroupedListColumn<T> extends ColumnSizeMeta {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
}

export interface GroupedListSubgroup<T> {
  key: string;
  header: ReactNode;
  rows: T[];
  /** Thin left rule on the sub-header (CSF). */
  rule?: boolean;
}

export interface GroupedListGroup<T> {
  key: string;
  header: ReactNode;
  /** Rows directly under the header (before any subgroup). */
  rows?: T[];
  subgroups?: GroupedListSubgroup<T>[];
  /** Thin left rule on the header and its sub-headers (CSF). */
  rule?: boolean;
}

export interface GroupedListProps<T> {
  groups: GroupedListGroup<T>[];
  columns: GroupedListColumn<T>[];
  rowId: (row: T) => string;
  selectedId?: string | null;
  onSelect?: (row: T | null) => void;
  onOpen?: (row: T) => void;
  storageKey: string;
  emptyText?: string;
  rowClassName?: (row: T) => string | undefined;
  footer?: ReactNode;
  autoFocus?: boolean;
  showColumnHeaders?: boolean;
  onKey?: (e: React.KeyboardEvent, row: T | null) => boolean | void;
  /** What one row is, so group counts read as words: 'test' (plural adds s) or ['study', 'studies']. */
  rowNoun?: string | readonly [string, string];
}

interface FlatRow<T> {
  row: T;
  id: string;
  groupKey: string;
  hidden: boolean;
}

function readCollapsed(key: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(key);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(key: string, set: Set<string>): void {
  try {
    if (set.size) sessionStorage.setItem(key, JSON.stringify([...set]));
    else sessionStorage.removeItem(key);
  } catch {
    // sessionStorage may be unavailable; the state still lives in memory.
  }
}

function countRows<T>(g: GroupedListGroup<T>): number {
  return (g.rows?.length ?? 0) + (g.subgroups?.reduce((n, s) => n + s.rows.length, 0) ?? 0);
}

export function GroupedList<T>({ groups, columns, rowId, selectedId, onSelect, onOpen, storageKey, emptyText = 'Nothing here yet.', rowClassName, footer, autoFocus, showColumnHeaders = true, onKey, rowNoun }: GroupedListProps<T>) {
  const stateKey = `casefile.grouped.${storageKey}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(stateKey));
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  // Re-read when the route changes its key (one component instance may serve several views).
  useEffect(() => {
    setCollapsed(readCollapsed(stateKey));
  }, [stateKey]);

  const flat = useMemo<FlatRow<T>[]>(() => {
    const out: FlatRow<T>[] = [];
    for (const g of groups) {
      const hidden = collapsed.has(g.key);
      for (const r of g.rows ?? []) out.push({ row: r, id: rowId(r), groupKey: g.key, hidden });
      for (const s of g.subgroups ?? []) for (const r of s.rows) out.push({ row: r, id: rowId(r), groupKey: g.key, hidden });
    }
    return out;
  }, [groups, collapsed, rowId]);
  const visible = useMemo(() => flat.filter((r) => !r.hidden), [flat]);
  const sizingColumns = columns.map((c) => ({ id: c.id, meta: { className: c.className, width: c.width, grow: c.grow, minWidth: c.minWidth, maxWidth: c.maxWidth, wrap: c.wrap, shrink: c.shrink } }));
  const measureKey = useMemo(() => ({}), [groups, columns, visible.length]);
  // Widths are remembered per list and column set: casefile.cols.grouped.<storageKey>|<column ids>.
  const columnIds = columns.map((c) => c.id);
  const sizing = useColumnSizing({ storageKey: columnStorageKey(`grouped.${storageKey}|${columnIds.join(',')}`, '', columnIds), columns: sizingColumns, wrapRef, tableRef, measureKey });
  const outOfView = useColumnsOutOfView(wrapRef, tableRef, measureKey);
  const selectedIndex = useMemo(() => (selectedId ? flat.findIndex((r) => r.id === selectedId) : -1), [flat, selectedId]);
  const current = selectedIndex >= 0 ? flat[selectedIndex] : null;

  useEffect(() => {
    if (autoFocus) wrapRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!selectedId || !wrapRef.current) return;
    wrapRef.current.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  function toggle(groupKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      writeCollapsed(stateKey, next);
      return next;
    });
  }

  /** Step from the current row to the next visible one in `delta`'s direction; from nothing, the first or last visible row. */
  function move(delta: number) {
    if (!visible.length) return;
    if (selectedIndex < 0 || current?.hidden) {
      onSelect?.(delta > 0 ? visible[0].row : visible[visible.length - 1].row);
      return;
    }
    const step = delta > 0 ? 1 : -1;
    let i = selectedIndex;
    let remaining = Math.abs(delta);
    let last = selectedIndex;
    while (remaining > 0) {
      i += step;
      if (i < 0 || i >= flat.length) break;
      if (flat[i].hidden) continue;
      last = i;
      remaining--;
    }
    if (last !== selectedIndex) onSelect?.(flat[last].row);
  }

  function handleKey(e: React.KeyboardEvent) {
    // The second key of a global chord (g e, v t) belongs to the chord, not to this list.
    if (chordPending()) return;
    if (onKey && onKey(e, current?.row ?? null)) {
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
      case 'h': {
        e.preventDefault();
        const key = current?.groupKey ?? groups[0]?.key;
        if (key) toggle(key);
        break;
      }
      case 'Home':
        e.preventDefault();
        if (visible.length) onSelect?.(visible[0].row);
        break;
      case 'End':
        e.preventDefault();
        if (visible.length) onSelect?.(visible[visible.length - 1].row);
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
          onOpen?.(current.row);
        }
        break;
      case 'Escape':
        onSelect?.(null);
        break;
    }
  }

  const wrapStyle = { '--group-top': showColumnHeaders ? 'var(--th-height)' : '0px' } as CSSProperties;
  // Keep a row clear of the sticky headers when it scrolls into view.
  const rowStyle: CSSProperties = { scrollMarginTop: 'calc(var(--group-top, 0px) + var(--group-height) + var(--subgroup-height))' };
  const span = Math.max(1, columns.length) + (sizing.filler > 0 ? 1 : 0);

  function renderRow(r: T) {
    const id = rowId(r);
    const selected = id === selectedId;
    const extra = rowClassName?.(r);
    return (
      <tr key={id} data-id={id} className={[selected ? 'selected' : '', extra ?? ''].join(' ').trim() || undefined} style={rowStyle} onClick={() => onSelect?.(r)} onDoubleClick={() => onOpen?.(r)} aria-selected={selected}>
        {columns.map((c) => (
          <td key={c.id} className={sizing.cellClass(c.id, c.className)}>
            {sizing.cell(c.id, c.cell(r))}
          </td>
        ))}
        {sizing.filler > 0 ? <td className="dt-filler" aria-hidden="true" /> : null}
      </tr>
    );
  }

  return (
    <>
      <div className="table-wrap" ref={wrapRef} tabIndex={0} onKeyDown={handleKey} role="grid" aria-rowcount={visible.length} style={wrapStyle}>
        <table ref={tableRef} className={`data-table sized${sizing.resizing ? ' resizing' : ''}`} style={sizing.tableWidth ? { width: sizing.tableWidth } : undefined} onPointerOver={showFullTextOnHover}>
          <ColGroup sizing={sizing} />
          {showColumnHeaders ? (
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.id} className={c.className}>
                    {c.header}
                    <ColumnResizeHandle sizing={sizing} id={c.id} label={typeof c.header === 'string' && c.header ? c.header : undefined} />
                  </th>
                ))}
                {sizing.filler > 0 ? <th className="dt-filler" aria-hidden="true" /> : null}
              </tr>
            </thead>
          ) : null}
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.key);
            const n = countRows(g);
            return (
              <tbody key={g.key} data-group={g.key}>
                <tr className={['group-header', g.rule ? 'rule' : '', isCollapsed ? 'collapsed' : ''].join(' ').trim()} onClick={() => toggle(g.key)} aria-expanded={!isCollapsed}>
                  <th colSpan={span} scope="rowgroup" title={isCollapsed ? 'Click (or press h) to show this group' : 'Click (or press h) to fold this group'}>
                    {/* The count sits right after the caret and never gives way; a long header is what ends with "…". */}
                    <span className="group-row">
                      <span className="group-caret" aria-hidden="true">
                        ▾
                      </span>
                      <span className="group-header-title">{g.header}</span>
                      <span className="group-header-n">
                        {countWords(n, rowNoun)}
                        {isCollapsed ? ' · folded' : ''}
                      </span>
                    </span>
                  </th>
                </tr>
                {isCollapsed ? null : (
                  <>
                    {(g.rows ?? []).map(renderRow)}
                    {(g.subgroups ?? []).map((s) => (
                      <SubgroupRows key={s.key} subgroup={s} span={span} rule={Boolean(g.rule || s.rule)} renderRow={renderRow} rowNoun={rowNoun} />
                    ))}
                  </>
                )}
              </tbody>
            );
          })}
        </table>
        {visible.length === 0 ? <div className="table-empty">{flat.length ? 'Every group is folded. Click a group (or press h) to show it again.' : emptyText}</div> : null}
      </div>
      <div className="table-foot">
        <span>
          {visible.length}
          {flat.length > visible.length ? ` of ${flat.length}` : ''} {flat.length === 1 ? 'row' : 'rows'} · {groups.length} group{groups.length === 1 ? '' : 's'}
        </span>
        {footer}
        <ColumnsOutOfView cue={outOfView} wrapRef={wrapRef} />
        <ResetColumns sizing={sizing} />
      </div>
    </>
  );
}

function SubgroupRows<T>({ subgroup, span, rule, renderRow, rowNoun }: { subgroup: GroupedListSubgroup<T>; span: number; rule: boolean; renderRow: (r: T) => ReactNode; rowNoun?: string | readonly [string, string] }) {
  return (
    <>
      <tr className={rule ? 'group-subheader rule' : 'group-subheader'}>
        <th colSpan={span} scope="rowgroup">
          <span className="group-header-title">{subgroup.header}</span>
          <span className="group-header-n">{countWords(subgroup.rows.length, rowNoun)}</span>
        </th>
      </tr>
      {subgroup.rows.map(renderRow)}
    </>
  );
}
