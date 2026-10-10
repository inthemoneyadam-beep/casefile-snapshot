/**
 * Column widths for DataTable and GroupedList, the pure part: no React and no
 * DOM, so tests can run it as is (tests/ui-shared-columns.test.ts). The hook
 * that measures, drags and remembers lives in ColumnSizing.tsx.
 *
 * How a table's widths are decided
 *   1. planColumns picks the column that takes the room that is left (the
 *      "grow" column, normally the row's name): meta.grow, else a column with
 *      className 'fill', else the 'wrap' columns, else the first text column
 *      with no width, else the text column with the largest width.
 *   2. layoutColumns gives every other column its content width (measured),
 *      never less than meta.width and never more than maxWidth (default 240),
 *      and the grow column whatever is left, never less than its minWidth
 *      (default 200). When the pane is narrow, the other text columns give
 *      way first (down to their meta.width, at least 72px; numbers never), so
 *      the grow column can have its content width up to 360px before anything
 *      else is cut; they give way only when that lifts the grow column above
 *      its floor. When the columns still need more room than the pane, the
 *      table scrolls sideways instead of squashing text.
 *   3. A width the person dragged (or fitted with a double click) replaces the
 *      decided one for that column only, and is remembered in localStorage
 *      under columnStorageKey(...). One drag moves one column: every other
 *      column keeps the width steps 1-2 gave it (they are worked out as if
 *      nothing had been dragged), so widening the name never widens "Latest"
 *      back out of its give-way. Room left over goes to an empty filler
 *      column at the end; a table wider than its pane scrolls sideways (the
 *      footer then says which columns are out of view).
 */

/** The width fields a column may carry (TanStack `meta` for DataTable, the column itself for GroupedList). */
export interface ColumnSizeMeta {
  /** Extra class on the column's cells: 'num' right-aligns monospace numbers, 'fill' marks the grow column, 'wrap' lets the page lay out wrapped text itself. */
  className?: string;
  /** Starting width in px (a number or 'NNpx'). The column still widens to fit its content, up to maxWidth. */
  width?: number | string;
  /** This column takes the room that is left (the row's name). false keeps a column out of the automatic choice. */
  grow?: boolean;
  /** Narrowest automatic width in px (default 200 for the grow column, 36 for others). Also the narrowest a drag can make it, when set. */
  minWidth?: number;
  /** Widest automatic width in px (default 240; none for the grow column). A drag or double click can still go wider. */
  maxWidth?: number;
  /** Wrap to two lines, then end with "…" (default: on for the grow column, off for others). The full text shows on hover. */
  wrap?: boolean;
  /** false: this text column keeps its content width when the pane is narrow (default: text columns give way to the grow column, numbers never). */
  shrink?: boolean;
}

export interface SizingColumn {
  id: string;
  meta?: ColumnSizeMeta | null;
}

export interface ColumnPlan {
  id: string;
  grow: boolean;
  /** The table wraps this column's content in a two-line clamp (wrap on, and the page did not mark the column 'wrap' itself). */
  clamp: boolean;
  /** Narrowest automatic width. */
  min: number;
  /** Widest automatic width. */
  max: number;
  /** Narrowest a drag can make it. */
  userMin: number;
  /** meta.width in px, when it is one. */
  base: number | null;
  /** Gives way (down to its floor) when the grow column is short of room: a text column that is not the grow column. */
  shrink: boolean;
}

export interface ColumnLayout {
  widths: Record<string, number>;
  /** Sum of the column widths. */
  total: number;
  /** Width of the empty filler column at the end (0 when the columns fill the pane or overflow it). */
  filler: number;
}

/** The grow column's narrowest automatic width: room for a test or document name. */
export const GROW_MIN = 200;
/** Narrowest automatic width of any other column. */
export const AUTO_MIN = 36;
/** Widest automatic width of a column that is not the grow column. */
export const AUTO_MAX = 240;
/** Width used for a column before it can be measured. */
export const FALLBACK_WIDTH = 96;
/** The grow column's content width is met up to this before other columns give way to it. */
export const GROW_PREFERRED = 360;
/** A text column giving way to the grow column stops here (or at its meta.width, when that is wider). */
export const SHRINK_FLOOR = 72;
/** A dragged width is kept between these. */
export const USER_MIN = 40;
export const USER_MAX = 1600;
/** A double click (fit to content) never makes a column wider than this. */
export const FIT_MAX = 900;

function hasClass(className: string | undefined | null, name: string): boolean {
  return Boolean(className) && String(className).split(/\s+/).includes(name);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** meta.width as px: a positive number or a 'NNpx' / 'NN' string; percentages and the rest are ignored. */
export function pxWidth(width: number | string | undefined | null): number | null {
  if (typeof width === 'number') return Number.isFinite(width) && width > 0 ? width : null;
  if (typeof width === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(width);
    if (m) {
      const n = Number(m[1]);
      return n > 0 ? n : null;
    }
  }
  return null;
}

/** Which column grows, which wrap, and each column's limits. */
export function planColumns(columns: SizingColumn[]): ColumnPlan[] {
  const meta = (c: SizingColumn): ColumnSizeMeta => c.meta ?? {};
  let grow = new Set(columns.filter((c) => meta(c).grow === true).map((c) => c.id));
  if (!grow.size) {
    const eligible = columns.filter((c) => meta(c).grow !== false);
    const text = eligible.filter((c) => !hasClass(meta(c).className, 'num'));
    const fill = eligible.filter((c) => hasClass(meta(c).className, 'fill'));
    const wraps = eligible.filter((c) => meta(c).wrap === true || hasClass(meta(c).className, 'wrap'));
    if (fill.length) grow = new Set(fill.map((c) => c.id));
    else if (wraps.length) grow = new Set(wraps.map((c) => c.id));
    else {
      const free = text.find((c) => pxWidth(meta(c).width) == null);
      if (free) grow = new Set([free.id]);
      else {
        let best: SizingColumn | null = null;
        for (const c of text) if (!best || (pxWidth(meta(c).width) ?? 0) > (pxWidth(meta(best).width) ?? 0)) best = c;
        if (best) grow = new Set([best.id]);
      }
    }
  }
  return columns.map((c) => {
    const m = meta(c);
    const isGrow = grow.has(c.id);
    const base = pxWidth(m.width);
    const wrap = m.wrap ?? (hasClass(m.className, 'wrap') || isGrow);
    const min = m.minWidth != null && m.minWidth > 0 ? m.minWidth : isGrow ? GROW_MIN : AUTO_MIN;
    const max = m.maxWidth != null && m.maxWidth > 0 ? Math.max(m.maxWidth, min) : isGrow ? USER_MAX : Math.max(AUTO_MAX, base ?? 0, min);
    return {
      id: c.id,
      grow: isGrow,
      clamp: wrap && !hasClass(m.className, 'wrap'),
      min,
      max,
      userMin: m.minWidth != null && m.minWidth > 0 ? Math.min(m.minWidth, USER_MAX) : USER_MIN,
      base,
      shrink: !isGrow && !hasClass(m.className, 'num') && m.shrink !== false,
    };
  });
}

/** A dragged or stored width, kept within the column's limits. */
export function clampUserWidth(width: number, plan?: Pick<ColumnPlan, 'userMin'>): number {
  return Math.round(clamp(width, plan?.userMin ?? USER_MIN, USER_MAX));
}

/** The width a double click gives: the widest content measured, within limits. */
export function fitWidth(measured: number | undefined, plan?: Pick<ColumnPlan, 'userMin'>): number | null {
  if (measured == null || !Number.isFinite(measured) || measured <= 0) return null;
  return Math.round(clamp(Math.ceil(measured), plan?.userMin ?? USER_MIN, FIT_MAX));
}

/**
 * Every column's width in px. `user` holds dragged widths, `natural` the
 * measured content widths, `available` the pane's inner width (0 when not
 * known yet: the grow column then gets its minimum).
 */
export function layoutColumns(plan: ColumnPlan[], input: { user?: Record<string, number>; natural?: Record<string, number>; available?: number }): ColumnLayout {
  const user = input.user ?? {};
  const available = Math.max(0, Math.floor(input.available ?? 0));
  // The automatic widths, worked out as if nothing had been dragged; a dragged width then replaces its own column's
  // only, so one drag never moves another column.
  const auto = automaticWidths(plan, input.natural ?? {}, available);
  const widths: Record<string, number> = {};
  for (const p of plan) {
    const u = user[p.id];
    widths[p.id] = typeof u === 'number' && Number.isFinite(u) ? clampUserWidth(u, p) : auto[p.id];
  }
  const total = plan.reduce((n, p) => n + widths[p.id], 0);
  return { widths, total, filler: Math.max(0, available - total) };
}

/** Steps 1-2 of the header comment: every column's automatic width, with no dragged width in play. */
function automaticWidths(plan: ColumnPlan[], natural: Record<string, number>, available: number): Record<string, number> {
  const widths: Record<string, number> = {};
  const growing: ColumnPlan[] = [];
  let fixed = 0;
  for (const p of plan) {
    if (p.grow) {
      growing.push(p);
      continue;
    }
    const n = natural[p.id];
    const content = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : p.base ?? FALLBACK_WIDTH;
    widths[p.id] = Math.round(clamp(Math.max(p.base ?? 0, content), p.min, p.max));
    fixed += widths[p.id];
  }
  // A narrow pane: text columns give way (proportionally to what they can spare) until the grow column has its
  // content width, up to GROW_PREFERRED. Numbers and shrink: false never give way.
  if (growing.length && available > 0) {
    const want = growing.reduce((n, g) => {
      const nat = natural[g.id];
      const content = typeof nat === 'number' && Number.isFinite(nat) && nat > 0 ? nat : g.min;
      return n + clamp(content, g.min, Math.max(g.min, GROW_PREFERRED));
    }, 0);
    const deficit = want - (available - fixed);
    if (deficit > 0) {
      const pool = plan
        .filter((p) => !p.grow && p.shrink)
        .map((p) => ({ p, spare: widths[p.id] - Math.max(p.base ?? 0, p.min, SHRINK_FLOOR) }))
        .filter((x) => x.spare > 0);
      const spare = pool.reduce((n, x) => n + x.spare, 0);
      const floor = growing.reduce((n, g) => n + g.min, 0);
      // Only when it lifts the grow column above its floor: otherwise the table scrolls sideways and every column keeps its content.
      const helps = available - (fixed - spare) > floor;
      const take = helps ? Math.min(deficit, spare) : 0;
      if (take > 0) {
        for (const x of pool) {
          const cut = Math.floor((take * x.spare) / spare);
          widths[x.p.id] -= cut;
          fixed -= cut;
        }
      }
    }
  }
  if (growing.length) {
    const left = Math.max(0, available - fixed);
    // Several grow columns (a test and the document it came from): each gets its minimum, then the room above the
    // minimums goes first to whichever needs it for its content (in proportion), then evenly.
    const room = left - growing.reduce((n, g) => n + g.min, 0);
    const wants = growing.map((g) => {
      const nat = natural[g.id];
      const content = typeof nat === 'number' && Number.isFinite(nat) && nat > 0 ? nat : g.min;
      return Math.max(0, clamp(content, g.min, Math.max(g.min, Math.min(GROW_PREFERRED, g.max))) - g.min);
    });
    const wantSum = wants.reduce((n, w) => n + w, 0);
    if (growing.length > 1 && room > 0 && wantSum > 0) {
      const alloc = growing.map((g, i) => g.min + Math.floor(Math.min(wants[i], (room * wants[i]) / wantSum)));
      // What is left after every want is met goes evenly to the columns still under their maxWidth.
      let extra = left - alloc.reduce((n, w) => n + w, 0);
      for (let pass = 0; extra > 0 && pass < growing.length; pass++) {
        const open = growing.map((g, i) => i).filter((i) => alloc[i] < growing[i].max);
        if (!open.length) break;
        const each = Math.floor(extra / open.length);
        let given = 0;
        open.forEach((i, k) => {
          const add = Math.min(growing[i].max - alloc[i], each + (k === 0 ? extra - each * open.length : 0));
          alloc[i] += add;
          given += add;
        });
        extra -= given;
        if (!given) break;
      }
      growing.forEach((g, i) => {
        widths[g.id] = Math.round(clamp(alloc[i], g.min, g.max));
      });
    } else {
      const share = Math.floor(left / growing.length);
      let rest = left - share * growing.length;
      for (const g of growing) {
        let w = clamp(share, g.min, g.max);
        // The odd pixels go to the first grow column, so the columns meet the pane's edge exactly.
        if (rest > 0 && w === share) {
          w += rest;
          rest = 0;
        }
        widths[g.id] = Math.round(w);
      }
    }
  }
  return widths;
}

/** A header's words for the "more columns to the right" note: its text without the sort arrow. */
export function headerWords(text: string | null | undefined): string {
  return (text ?? '').replace(/[▴▾]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Which columns are out of view in a table that scrolls sideways, from each header's left and right edge and the
 * pane's: a column counts as out of view when more than a third of it is past the edge. Pure, for tests.
 */
export function columnsOutOfView(cols: Array<{ name: string; left: number; right: number }>, view: { left: number; right: number }): { left: string[]; right: string[] } {
  const left: string[] = [];
  const right: string[] = [];
  for (const c of cols) {
    const w = Math.max(1, c.right - c.left);
    if (c.right - view.right > w / 3) right.push(c.name || 'a column');
    else if (view.left - c.left > w / 3) left.push(c.name || 'a column');
  }
  return { left, right };
}

/** "2 more columns to the right: Settled by, Mentions." */
export function outOfViewWords(cue: { left: string[]; right: string[] }): string | null {
  const list = (names: string[]) => names.filter(Boolean).join(', ');
  if (cue.right.length) return `${cue.right.length} more column${cue.right.length === 1 ? '' : 's'} to the right: ${list(cue.right)}.`;
  if (cue.left.length) return `${cue.left.length} column${cue.left.length === 1 ? '' : 's'} to the left: ${list(cue.left)}.`;
  return null;
}

/** Route path with ids taken out, so every document's page shares one set of widths. */
export function routeKey(pathname: string): string {
  return (
    pathname
      .split('/')
      .map((s) => (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s) || /^\d+$/.test(s) || /^[0-9a-f]{16,}$/i.test(s) ? ':id' : s))
      .join('/')
      .replace(/\/+$/, '') || '/'
  );
}

/** Where a table's widths are remembered: its tableId, else the route and its column ids. */
export function columnStorageKey(tableId: string | null | undefined, pathname: string, ids: string[]): string {
  return tableId ? `casefile.cols.${tableId}` : `casefile.cols.${routeKey(pathname)}|${ids.join(',')}`;
}

/** Stored widths, kept only for columns the table has and only when they are sane numbers. */
export function parseStoredWidths(raw: string | null | undefined, ids: string[]): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  const known = new Set(ids);
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (known.has(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = clampUserWidth(v);
  }
  return out;
}

/** Same widths? (Avoids a re-render when a measurement finds nothing new.) */
export function sameWidths(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** The local storage of this browser, or null where it is blocked (private windows, previews). */
function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readWidths(key: string, ids: string[]): Record<string, number> {
  try {
    return parseStoredWidths(storage()?.getItem(key), ids);
  } catch {
    return {};
  }
}

export function writeWidths(key: string, widths: Record<string, number>): void {
  try {
    const s = storage();
    if (!s) return;
    if (Object.keys(widths).length) s.setItem(key, JSON.stringify(widths));
    else s.removeItem(key);
  } catch {
    // Storage full or blocked: the widths still hold for this visit.
  }
}
