/**
 * MoreMenu: the plain "More" button that holds a page's or a pane's rare
 * actions, so the toolbar shows one primary action and a few secondary ones.
 * Text only: every entry is words (with its key, when it has one, on the
 * right in the mono).
 *
 *   <MoreMenu items={[
 *     { label: 'Show all values', onClick: showAll, shortcut: 'l' },
 *     { heading: 'Copies' },
 *     { label: 'Likely copies', onClick: openCopies },
 *     'separator',
 *     { label: 'Delete this value', onClick: askDelete, danger: true },
 *   ]} />
 *
 * Keyboard (rules in menuKeys.ts): on the button, Enter, Space or ArrowDown
 * opens on the first action and ArrowUp on the last; in the menu ArrowDown /
 * ArrowUp (or j / k) move, Home / End jump, Enter or Space runs the action,
 * Esc closes and puts the focus back on the button, Tab closes, and a letter
 * moves to the next action that starts with it. While the menu has the focus
 * it keeps every plain key to itself, so a page shortcut never fires behind
 * it. A click outside closes it. The menu opens upward when there is no room
 * below.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { labelText, menuButtonKey, menuKey } from './menuKeys';

/** One action: in an ActionBar it is a button, in a MoreMenu a menu item. */
export interface Action {
  /** Stable key (defaults to the label's text). */
  id?: string;
  label: ReactNode;
  onClick: () => void;
  /** The key that does the same thing (shown in the menu; on buttons only when key hints are on). */
  shortcut?: string;
  /** Hover text: what the action does, in a sentence. */
  title?: string;
  disabled?: boolean;
  /** Destructive (delete, remove): drawn in the danger colour. */
  danger?: boolean;
  /** Leave it out without changing the array (an action that does not apply right now). */
  hidden?: boolean;
  /** Plain words for typeahead when `label` is not a string. */
  text?: string;
  /** A toggle that is on (a filter being shown): the button shows it pressed (aria-pressed). */
  pressed?: boolean;
}

export type MenuEntry = Action | 'separator' | { heading: ReactNode } | null | false | undefined;

export interface MoreMenuProps {
  items: MenuEntry[];
  /** The button's words (default "More"). */
  label?: ReactNode;
  /** Hover text for the button. */
  title?: string;
  /** Which edge of the button the menu lines up with (default 'right'). */
  align?: 'left' | 'right';
  size?: 'sm' | 'md';
  className?: string;
}

export function isAction(e: MenuEntry): e is Action {
  return Boolean(e) && typeof e === 'object' && 'onClick' in (e as object);
}

/** The entries that show: hidden actions, empty slots and doubled or dangling separators dropped. */
export function visibleEntries(items: MenuEntry[]): Exclude<MenuEntry, null | false | undefined>[] {
  const out: Exclude<MenuEntry, null | false | undefined>[] = [];
  for (const e of items) {
    if (!e) continue;
    if (isAction(e) && e.hidden) continue;
    if (e === 'separator' && (!out.length || out[out.length - 1] === 'separator')) continue;
    out.push(e);
  }
  while (out.length && (out[out.length - 1] === 'separator' || (typeof out[out.length - 1] === 'object' && !isAction(out[out.length - 1])))) out.pop();
  return out;
}

const KEY_WORDS: Record<string, string> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', esc: 'Esc' };
function keyText(k: string): string {
  return k
    .split(' ')
    .map((p) => p.split('+').map((x) => KEY_WORDS[x] ?? x).join('+'))
    .join(' then ');
}

export function MoreMenu({ items, label = 'More', title, align = 'right', size = 'md', className }: MoreMenuProps) {
  const entries = visibleEntries(items);
  const actions = entries.filter(isAction);
  const labels = actions.map((a) => a.text ?? labelText(a.label));
  const disabled = actions.map((a) => Boolean(a.disabled));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  function close(refocus: boolean) {
    setOpen(false);
    setActive(-1);
    if (refocus) btnRef.current?.focus();
  }
  function openAt(index: number) {
    setOpen(true);
    setActive(index);
  }
  function run(index: number) {
    const a = actions[index];
    if (!a || a.disabled) return;
    close(true);
    a.onClick();
  }

  // The focused action follows `active`.
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Open upward when the room below is short and there is more above.
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    const m = menuRef.current;
    if (!b || !m || typeof window === 'undefined') return;
    const below = window.innerHeight - b.bottom;
    setUp(below < Math.min(m.scrollHeight, 420) + 12 && b.top > below);
  }, [open]);

  if (!actions.length) return null;

  function onButtonKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const r = menuKey(e.key, -1, labels, disabled);
        if (r.type === 'move') setActive(r.index);
      }
      return;
    }
    // Enter and Space open through the click (a keyboard click opens on the first action).
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const r = menuButtonKey(e.key, disabled);
      if (r) {
        e.preventDefault();
        e.stopPropagation();
        openAt(r.index);
      }
    }
  }

  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const r = menuKey(e.key, active, labels, disabled);
    if (r.type === 'move') setActive(r.index);
    else if (r.type === 'activate') run(r.index);
    else if (r.type === 'close') close(true);
    // Every plain key stays in the menu: nothing behind it runs while it is open.
    if (r.type !== 'none' || e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const btnClass = ['btn', size === 'sm' ? 'sm' : '', className ?? ''].filter(Boolean).join(' ');
  let ai = -1;
  return (
    <span className="menu-anchor" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={btnClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title}
        onClick={(e) => {
          if (open) close(false);
          // detail 0: Enter or Space, not a mouse click: start on the first action.
          else openAt(e.detail === 0 ? menuButtonKey('Enter', disabled)?.index ?? -1 : -1);
        }}
        onKeyDown={onButtonKey}
      >
        {label}
        <span className="btn-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label={typeof label === 'string' ? `${label} actions` : 'More actions'} className={['menu', align === 'left' ? 'align-left' : '', up ? 'up' : ''].filter(Boolean).join(' ')} onKeyDown={onMenuKey}>
          {entries.map((e, i) => {
            if (e === 'separator') return <div key={`sep-${i}`} role="separator" className="menu-sep" />;
            if (!isAction(e)) {
              return (
                <div key={`h-${i}`} role="presentation" className="menu-heading">
                  {e.heading}
                </div>
              );
            }
            ai += 1;
            const index = ai;
            return (
              <button
                key={e.id ?? `${labels[index]}-${i}`}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={e.disabled}
                title={e.title}
                className={e.danger ? 'menu-item danger' : 'menu-item'}
                onClick={() => run(index)}
                onMouseEnter={() => !e.disabled && setActive(index)}
              >
                <span>{e.label}</span>
                {e.shortcut ? <span className="menu-key">{keyText(e.shortcut)}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
