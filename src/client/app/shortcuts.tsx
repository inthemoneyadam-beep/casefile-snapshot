/**
 * Global keyboard handling. Single keys and two-key chords ("g d"). Bindings
 * are ignored while typing in a field unless marked `global`.
 *
 * Rules enforced here for every page:
 * - Enter and Space on a focused button, link, tab or other control (or
 *   anywhere inside an open dialog) belong to that control: a page's
 *   non-global `enter` / `space` binding does not run and the browser's own
 *   action does.
 * - While the shortcut sheet is open only global bindings (and `?`) run.
 * - A single key that is also a chord prefix (a page's plain `v` next to the
 *   global `v t`, `v b`, `v r`) waits up to CHORD_MS for a second key: a
 *   completed chord wins, any other key or the timeout runs the single key.
 *   Prefer another letter for page keys; in development registering such a
 *   key logs a warning.
 * - Each key keeps a stack of registrations and the newest one runs. A dialog
 *   or panel that binds a key the page already uses ('/', esc, n) takes it
 *   while mounted; when it unmounts only its own registration goes, so the
 *   page's binding is back without the page registering again. One list
 *   binding the same key twice is a mistake and warns in development.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { NAV } from './nav';
import { groupRank, groupWords, openPalette } from './commands';
import { cycleTheme, toggleLargeType, toggleReducedContrast } from './theme';
import { dock } from './dock';
import { Dialog } from '../ui/Dialog';
import { Kbd } from '../ui/Kbd';

export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="radio"]';

/** A focused control whose own Enter / Space action must win over a page binding. */
export function isActivatable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return typeof el?.closest === 'function' && el.closest(ACTIVATABLE) !== null;
}

/** Enter / Space meant for the focused control or an open dialog, not for the page behind it. */
function yieldsToFocus(b: Binding, name: string, target: EventTarget | null): boolean {
  if (b.global || (name !== 'enter' && name !== 'space')) return false;
  const el = target as HTMLElement | null;
  return isActivatable(target) || (typeof el?.closest === 'function' && el.closest('dialog[open]') !== null);
}

/** Keys that start chords ("g d", "n t", "v t"). */
const CHORD_PREFIXES = new Set(['g', 'n', 'v']);
/** How long the second key of a chord may take. */
export const CHORD_MS = 900;

/** When a chord prefix (g, v, n) was last pressed; 0 when none is pending. Lists read it through chordPending(). */
let pendingPrefixAt = 0;

/**
 * True for a moment after a chord prefix: a focused list must let the next
 * key through so "g e" reaches the chord instead of the list's own "e".
 */
export function chordPending(): boolean {
  return pendingPrefixAt > 0 && Date.now() - pendingPrefixAt < CHORD_MS;
}

export interface Binding {
  keys: string; // "ctrl+k", "?", "g d", "c"
  description: string;
  group: string;
  /** Fire even while typing in a field. */
  global?: boolean;
  /** Only active while this returns true (e.g. a dialog is open, a row is selected). */
  when?: () => boolean;
  /** Default true. Set false to let the browser keep its default (e.g. Enter on a focused button). */
  preventDefault?: boolean;
  run: (e: KeyboardEvent) => void;
}

/** One registration of a binding, and the list that registered it (null: registered on its own). */
interface Registration {
  b: Binding;
  owner: object | null;
}

/** Every live registration per key, oldest first; the last one is the key's binding. A key with none has no entry. */
const stacks = new Map<string, Registration[]>();
const bindingListeners = new Set<() => void>();

/** The binding a key runs now: its newest live registration. */
export function bindingFor(keys: string): Binding | undefined {
  const stack = stacks.get(keys);
  return stack?.[stack.length - 1]?.b;
}

/** The binding each bound key runs now, one per key. */
export function activeBindings(): Binding[] {
  return [...stacks.values()].map((stack) => stack[stack.length - 1].b);
}

function hasChordsFor(prefix: string): boolean {
  for (const k of stacks.keys()) if (k.startsWith(`${prefix} `)) return true;
  return false;
}

/**
 * Development only: say when one list binds a key twice (a page key that a
 * dialog or panel binds again is a stack, not a mistake), or when a single key
 * shadows a chord prefix.
 */
function warnOnCollision(b: Binding, owner: object | null): void {
  const twin = owner ? stacks.get(b.keys)?.find((r) => r.owner === owner) : undefined;
  if (twin) console.warn(`[shortcuts] "${b.keys}" is bound twice in one list: "${twin.b.description}" is shadowed by "${b.description}".`);
  const prefix = b.keys.includes(' ') ? b.keys.split(' ')[0] : null;
  const single = prefix ? bindingFor(prefix) : CHORD_PREFIXES.has(b.keys) && hasChordsFor(b.keys) ? b : undefined;
  if (single && !single.global) {
    console.warn(`[shortcuts] "${single.keys}" (${single.description}) is also the start of chords such as "${prefix ? b.keys : [...stacks.keys()].find((k) => k.startsWith(`${b.keys} `))}"; it now waits ${CHORD_MS} ms for a second key. Use another key.`);
  }
}

/**
 * Bind a key until the returned function is called. The newest registration
 * of a key runs; removing it hands the key back to the registration below.
 * `owner` groups the bindings of one list for the duplicate warning. `under`
 * puts the binding below every live registration of its key instead: the
 * built-in keys use it, because GlobalShortcuts mounts after the page and a
 * page that binds '/' must keep it on a direct load too.
 */
export function registerBinding(b: Binding, owner: object | null = null, under = false): () => void {
  if (import.meta.env.DEV) warnOnCollision(b, owner);
  const keys = b.keys;
  const reg: Registration = { b, owner };
  const stack = stacks.get(keys);
  if (!stack) stacks.set(keys, [reg]);
  else if (under) stack.unshift(reg);
  else stack.push(reg);
  bindingListeners.forEach((l) => l());
  return () => {
    const current = stacks.get(keys);
    const at = current ? current.indexOf(reg) : -1;
    if (!current || at < 0) return; // already removed
    current.splice(at, 1);
    if (!current.length) stacks.delete(keys);
    bindingListeners.forEach((l) => l());
  };
}

export function useBindings(list: Binding[], deps: unknown[] = []): void {
  useEffect(() => {
    const owner = {};
    const offs = list.map((b) => registerBinding(b, owner));
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Normalise a key event to a binding name. With ctrl/alt/meta held, shift is
 * spelled out and the key is lower-cased ("ctrl+shift+t"); with shift alone
 * the produced character is used as-is ("?", "/", "["), matching how people
 * write single-key bindings.
 */
function keyName(e: KeyboardEvent): string {
  const parts: string[] = [];
  const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && (hasModifier || e.key.length > 1)) parts.push('shift');
  let k = e.key;
  if (k === ' ') k = 'space';
  if (k === 'Escape') k = 'esc';
  if (k === 'Enter') k = 'enter';
  if (k.length === 1 && (hasModifier || !e.shiftKey)) k = k.toLowerCase();
  parts.push(k);
  return parts.join('+');
}

/** The state the key handler keeps between keys. */
export interface KeyState {
  /** A chord prefix (g, v, n) waiting for its second key. */
  pending: { key: string; at: number } | null;
  /** A single key that is also a chord prefix, waiting to see whether a chord follows. */
  deferred: { b: Binding; e: KeyboardEvent; timer: ReturnType<typeof setTimeout> } | null;
}

/**
 * The window keydown handler (GlobalShortcuts installs it; tests call it with plain event objects). Only the first
 * key of a chord (g, v, n with chords) arms `pendingPrefixAt`: Tab, Esc, Shift and keys with no binding never do,
 * so a list's j / k / Enter / Esc right after them is never held back.
 */
export function createKeyHandler(state: KeyState, sheetOpen: () => boolean): { onKey: (e: KeyboardEvent) => void; flushDeferred: (run: boolean) => void } {
  /** Run (or drop) the single key that waited for a chord. */
  function flushDeferred(run: boolean) {
    const d = state.deferred;
    if (!d) return;
    state.deferred = null;
    clearTimeout(d.timer);
    if (run && (!d.b.when || d.b.when())) d.b.run(d.e);
  }
  function allowed(b: Binding, name: string, target: EventTarget | null): boolean {
    if (sheetOpen() && !b.global && b.keys !== '?') return false;
    return !yieldsToFocus(b, name, target);
  }
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const name = keyName(e);
    const editable = isEditable(e.target);
    // Chord completion
    const prefix = state.pending;
    state.pending = null;
    pendingPrefixAt = 0;
    if (prefix && Date.now() - prefix.at < CHORD_MS && !editable) {
      const b = bindingFor(`${prefix.key} ${name}`);
      if (b && (!b.when || b.when()) && allowed(b, name, e.target)) {
        flushDeferred(false);
        if (b.preventDefault !== false) e.preventDefault();
        b.run(e);
        return;
      }
    }
    // No chord followed: a single key that waited runs now, before this one.
    flushDeferred(true);
    const b = bindingFor(name);
    const usable = b && (b.global || !editable) && (!b.when || b.when()) && allowed(b, name, e.target) ? b : null;
    const startsChord = !editable && CHORD_PREFIXES.has(name) && hasChordsFor(name);
    if (usable && startsChord && !usable.global) {
      // Both a page key and the start of a chord: wait for the second key.
      if (usable.preventDefault !== false) e.preventDefault();
      state.pending = { key: name, at: Date.now() };
      pendingPrefixAt = Date.now();
      state.deferred = {
        b: usable,
        e,
        timer: setTimeout(() => {
          state.pending = null;
          pendingPrefixAt = 0;
          flushDeferred(true);
        }, CHORD_MS),
      };
      return;
    }
    if (usable) {
      // Do not steal plain keys from dialogs' inputs; global ones are fine.
      if (usable.preventDefault !== false) e.preventDefault();
      usable.run(e);
      return;
    }
    // Only the first key of a chord holds the lists' keys while it waits. (Without these braces every unbound key,
    // Tab, Esc or Shift held a list's j / k / Enter / Esc back for CHORD_MS.)
    if (startsChord) {
      state.pending = { key: name, at: Date.now() };
      pendingPrefixAt = Date.now();
    }
  }
  return { onKey, flushDeferred };
}

export function GlobalShortcuts() {
  const navigate = useNavigate();
  const keyState = useRef<KeyState>({ pending: null, deferred: null });
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheetOpen;

  // Built-in bindings.
  useEffect(() => {
    const offs: Array<() => void> = [];
    // One list (a nav chord that repeats a built-in key warns in development), and under any page
    // binding of the same key: this effect runs after the page's on a direct load.
    const owner = {};
    const add = (b: Binding) => void offs.push(registerBinding(b, owner, true));
    add({ keys: 'ctrl+k', description: 'Find a page or action (command palette)', group: 'Global', global: true, run: () => openPalette() });
    add({ keys: '?', description: 'Keyboard shortcuts', group: 'Global', run: () => setSheetOpen((v) => !v) });
    // Appearance uses chords: ctrl+shift letters are owned by the browser (ctrl+shift+t reopens a tab).
    add({ keys: 'v t', description: 'Cycle theme (dark, dim, light)', group: 'Global', run: () => cycleTheme() });
    add({ keys: 'v b', description: 'Toggle large type', group: 'Global', run: () => toggleLargeType() });
    add({ keys: 'v r', description: 'Toggle reduced contrast', group: 'Global', run: () => toggleReducedContrast() });
    add({ keys: 'ctrl+shift+x', description: 'Lock CaseFile now', group: 'Global', global: true, run: () => void fetch('/api/auth/lock', { method: 'POST' }).then(() => window.dispatchEvent(new CustomEvent('casefile:locked'))) });
    add({ keys: 'ctrl+.', description: 'Show or hide the clinician beside this page', group: 'Global', global: true, run: () => dock('toggle') });
    for (const n of NAV) {
      add({ keys: n.chord, description: `Go to ${n.label}`, group: 'Go to', run: () => void navigate({ to: n.to }) });
    }
    add({ keys: '/', description: "Go to this page's search box", group: 'Global', run: () => document.querySelector<HTMLInputElement>('input[type="search"], input[data-filter]')?.focus() });
    return () => offs.forEach((o) => o());
  }, [navigate]);

  useEffect(() => {
    const { onKey, flushDeferred } = createKeyHandler(keyState.current, () => sheetOpenRef.current);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      flushDeferred(false);
    };
  }, []);

  return <ShortcutSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />;
}

/** The keys every list answers to (DataTable, GroupedList), said once at the top of the keyboard sheet. */
export const LIST_KEYS_WORDS =
  'In any list: j / k or the arrow keys move, Enter opens, Esc clears the selection, and in a list with groups h folds or opens the group. Chords like g d are two keys pressed one after the other.';

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    bindingListeners.add(l);
    return () => void bindingListeners.delete(l);
  }, []);
  // Grouped by the name the reader sees; this page's keys first (audit S-11), then its lists, then the keys that work
  // anywhere and the page chords last.
  const groups = new Map<string, Binding[]>();
  for (const b of activeBindings()) {
    if (b.when && !b.when()) continue;
    const g = groupWords(b.group);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(b);
  }
  const sorted = [...groups.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]));
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={760}>
      {/* The list keys first: they work on every page, so they lead instead of trailing under "Go to a page". */}
      <p className="muted small" style={{ marginBottom: 16 }}>
        {LIST_KEYS_WORDS}
      </p>
      <div className="shortcuts">
        {sorted.map(([group, list]) => (
          <div key={group}>
            <h4 style={{ marginBottom: 8 }}>{group}</h4>
            <dl>
              {list.map((b) => (
                <div key={b.keys} style={{ display: 'contents' }}>
                  <dt>
                    <Kbd>{b.keys}</Kbd>
                  </dt>
                  <dd>{b.description}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
