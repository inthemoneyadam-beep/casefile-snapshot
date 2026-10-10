import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * List on the left, detail on the right, with a draggable divider.
 *
 *   <SplitView storageKey="labs" defaultLeft={48} minLeft={360} left={list} right={detail} />
 *
 *   storageKey   remembers the divider per page (localStorage casefile.split.<key>, a percentage)
 *   defaultLeft  the list's share in percent before anyone drags (default 44)
 *   minLeft      the list's narrowest width in px (default 320): room for its name column
 *   minRight     the detail's narrowest width in px (default 420)
 *
 * Drag the divider to change the split; double-click it to put it back. The
 * divider also takes the keyboard: Tab to it, then ArrowLeft / ArrowRight
 * move it (Shift for bigger steps) and Home puts it back. The list never gets
 * narrower than minLeft and the detail never narrower than minRight; a window
 * too narrow for both splits by the percentage alone. `splitLeftPx` and
 * `splitKey` are the pure rules, exported for tests.
 */
export interface SplitViewProps {
  left: ReactNode;
  right: ReactNode;
  storageKey?: string;
  defaultLeft?: number;
  minLeft?: number;
  minRight?: number;
}

/** Width of the 1px divider. */
const HANDLE = 1;
const PCT_MIN = 10;
const PCT_MAX = 90;

/** The list's width in px for a container width and a share in percent, within the two minimums. */
export function splitLeftPx(container: number, pct: number, minLeft = 320, minRight = 420): number {
  if (!(container > 0)) return 0;
  const share = Math.min(PCT_MAX, Math.max(PCT_MIN, Number.isFinite(pct) ? pct : 44));
  const want = (container * share) / 100;
  const maxLeft = container - minRight - HANDLE;
  // Too narrow for both minimums: split by the share alone, as before.
  if (maxLeft < minLeft) return Math.round(want);
  return Math.round(Math.min(maxLeft, Math.max(minLeft, want)));
}

/** Keyboard on the divider: the new share in percent, 'reset', or null for a key it does not use. */
export function splitKey(key: string, pct: number, shift = false): number | 'reset' | null {
  const step = shift ? 10 : 2;
  if (key === 'ArrowLeft') return Math.max(PCT_MIN, Math.round((pct - step) * 10) / 10);
  if (key === 'ArrowRight') return Math.min(PCT_MAX, Math.round((pct + step) * 10) / 10);
  if (key === 'Home') return 'reset';
  return null;
}

/** A stored share, when it is a sane one. */
export function parseSplit(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= PCT_MIN && v <= PCT_MAX ? v : null;
}

function readSplit(key: string): number | null {
  try {
    return parseSplit(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeSplit(key: string, pct: number | null): void {
  try {
    if (pct == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(pct * 10) / 10));
  } catch {
    // Storage blocked: the split still holds for this visit.
  }
}

export function SplitView({ left, right, storageKey = 'split', defaultLeft = 44, minLeft = 320, minRight = 420 }: SplitViewProps) {
  const key = `casefile.split.${storageKey}`;
  const [stored, setStored] = useState<{ key: string; pct: number | null }>(() => ({ key, pct: readSplit(key) }));
  let pct = stored.pct;
  if (stored.key !== key) {
    pct = readSplit(key);
    setStored({ key, pct });
  }
  const share = pct ?? defaultLeft;
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pct: number } | null>(null);

  // The container's width, followed as the window, the dock or the page changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pctAt = useCallback(
    (clientX: number) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return share;
      const px = splitLeftPx(rect.width, ((clientX - rect.left) / rect.width) * 100, minLeft, minRight);
      return (px / rect.width) * 100;
    },
    [share, minLeft, minRight],
  );

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience.
    }
    drag.current = { pct: share };
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = pctAt(e.clientX);
    drag.current.pct = next;
    setStored({ key, pct: next });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = drag.current.pct;
    drag.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    writeSplit(key, next);
  }
  function onDoubleClick() {
    setStored({ key, pct: null });
    writeSplit(key, null);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const next = splitKey(e.key, shownPct, e.shiftKey);
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    if (next === 'reset') return onDoubleClick();
    // Through the same limits as a drag, so the keys stop where the mouse would.
    const px = splitLeftPx(width, next, minLeft, minRight);
    const pctNext = width > 0 ? (px / width) * 100 : next;
    setStored({ key, pct: pctNext });
    writeSplit(key, pctNext);
  }

  const leftPx = splitLeftPx(width, share, minLeft, minRight);
  const columns = leftPx > 0 ? `${leftPx}px` : `${share}%`;
  const shownPct = width > 0 && leftPx > 0 ? (leftPx / width) * 100 : share;

  return (
    <div className={`split${dragging ? ' resizing' : ''}`} ref={ref} style={{ ['--split-left' as string]: columns }}>
      <div className="split-left">{left}</div>
      <div
        className={`split-handle${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={PCT_MIN}
        aria-valuemax={PCT_MAX}
        aria-valuenow={Math.round(shownPct)}
        aria-label="Divider between the list and the details"
        title="Drag (or use the arrow keys) to change how wide the list is. Double-click (or Home) puts it back."
      />
      <div className="split-right">{right}</div>
    </div>
  );
}
