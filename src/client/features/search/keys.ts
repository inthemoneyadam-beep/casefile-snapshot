/**
 * Keyboard logic for pages that register their bindings once (useBindings
 * with `[]` deps). A handler registered on mount keeps the closures of that
 * first render, so every handler here reads the page's state through a ref
 * (`state.current`) at key time instead. Kept free of React and the DOM so
 * tests can run it in node.
 */

/** Minimum query length the Search page acts on (search, ask). */
export const MIN_QUERY = 2;

/**
 * Elements that act on Enter by themselves. A page-level plain Enter binding
 * must stand aside while one of these has focus: GlobalShortcuts calls
 * preventDefault before running a binding, which cancels the control's own
 * activation (Tab to Skip, Enter, and the item was filed instead).
 * The general fix belongs in GlobalShortcuts (shortcuts.tsx is shared).
 */
const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"]';

/** Whether `el` (e.g. document.activeElement) is, or sits inside, a control that handles Enter itself. */
export function isActivatableTarget(el: unknown): boolean {
  const c = el as { closest?: (selector: string) => unknown } | null | undefined;
  return Boolean(c && typeof c.closest === 'function' && c.closest(ACTIVATABLE));
}

/** The index to select after stepping `delta` rows through a list of `length`; -1 for an empty list. */
export function stepIndex(length: number, selectedIndex: number, delta: number): number {
  if (length <= 0) return -1;
  if (selectedIndex < 0 || selectedIndex >= length) return delta > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, selectedIndex + delta));
}

/** A binding as useBindings takes it (structurally; app/shortcuts' Binding is not imported so node tests stay DOM-free). */
export interface KeyBinding {
  keys: string;
  description: string;
  group: string;
  when: () => boolean;
  run: () => void;
}

export interface SearchKeyState<H> {
  /** The results in display order. */
  flat: readonly H[];
  /** Index of the selected result in `flat`, or -1. */
  selectedIndex: number;
  /** The trimmed query the results are for. */
  q: string;
}

export interface SearchKeyActions<H> {
  select: (hit: H) => void;
  open: (hit: H) => void;
  ask: (q: string) => void;
  /** True while focus sits on a control that handles Enter itself (see isActivatableTarget). */
  focusOnControl: () => boolean;
}

export type StateRef<S> = { readonly current: S };

/** Step the selection through the results as they are now. */
export function moveSelection<H>(state: StateRef<SearchKeyState<H>>, act: Pick<SearchKeyActions<H>, 'select'>, delta: number): void {
  const { flat, selectedIndex } = state.current;
  const next = stepIndex(flat.length, selectedIndex, delta);
  if (next >= 0) act.select(flat[next]);
}

/** Ask the clinician about the query as it is now. */
export function askCurrent<H>(state: StateRef<SearchKeyState<H>>, act: Pick<SearchKeyActions<H>, 'ask'>): void {
  const q = state.current.q;
  if (q.length >= MIN_QUERY) act.ask(q);
}

/** The Search page's key bindings: j / k move, Enter opens, a asks. Safe to register once. */
export function searchKeyBindings<H>(state: StateRef<SearchKeyState<H>>, act: SearchKeyActions<H>): KeyBinding[] {
  return [
    { keys: 'j', description: 'Next result', group: 'Lists', when: () => state.current.flat.length > 0, run: () => moveSelection(state, act, 1) },
    { keys: 'k', description: 'Previous result', group: 'Lists', when: () => state.current.flat.length > 0, run: () => moveSelection(state, act, -1) },
    {
      keys: 'enter',
      description: 'Open the selected result',
      group: 'Lists',
      when: () => state.current.selectedIndex >= 0 && !act.focusOnControl(),
      run: () => {
        const { flat, selectedIndex } = state.current;
        const hit = flat[selectedIndex];
        if (hit) act.open(hit);
      },
    },
    { keys: 'a', description: 'Ask the clinician about this query', group: 'Page', when: () => state.current.q.length >= MIN_QUERY, run: () => askCurrent(state, act) },
  ];
}
