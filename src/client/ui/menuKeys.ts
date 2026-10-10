/**
 * Keyboard rules for the More menu and the segmented control, the pure part:
 * no React and no DOM, so tests run them as they are
 * (tests/ui-system-keys.test.ts). Menu.tsx and Toolbar.tsx call these.
 *
 * More menu, while it is open and has focus
 *   ArrowDown / j        next action (wraps), skipping disabled ones
 *   ArrowUp / k          previous action (wraps)
 *   Home / End           first / last action
 *   Enter / Space        run the focused action, close the menu
 *   Esc                  close, focus back on the More button
 *   Tab                  close, focus moves on as usual
 *   a letter             the next action whose words start with it
 * More button, while the menu is closed
 *   ArrowDown, Enter, Space   open on the first action
 *   ArrowUp                   open on the last action
 *
 * Segmented control (radio semantics: moving is choosing)
 *   ArrowRight / ArrowDown   next option (wraps), skipping disabled ones
 *   ArrowLeft / ArrowUp      previous option
 *   Home / End               first / last option
 */

export type MenuKeyResult =
  | { type: 'move'; index: number }
  | { type: 'activate'; index: number }
  | { type: 'close'; refocus: boolean }
  | { type: 'none' };

/** The next enabled index from `from` in `step` direction (wrapping); -1 when nothing is enabled. */
export function nextEnabled(from: number, step: 1 | -1, disabled: readonly boolean[]): number {
  const n = disabled.length;
  if (!n) return -1;
  for (let i = 1; i <= n; i++) {
    const k = (((from + step * i) % n) + n) % n;
    if (!disabled[k]) return k;
  }
  return -1;
}

/** The first (or last) enabled index; -1 when nothing is enabled. */
export function edgeEnabled(which: 'first' | 'last', disabled: readonly boolean[]): number {
  if (which === 'first') return nextEnabled(-1, 1, disabled);
  return nextEnabled(disabled.length, -1, disabled);
}

/** What a key does inside an open menu. `index` is the focused action (-1 for none). */
export function menuKey(key: string, index: number, labels: readonly string[], disabled: readonly boolean[]): MenuKeyResult {
  const count = labels.length;
  if (!count) return key === 'Escape' ? { type: 'close', refocus: true } : { type: 'none' };
  switch (key) {
    case 'ArrowDown':
    case 'j': {
      const i = nextEnabled(index < 0 ? -1 : index, 1, disabled);
      return i < 0 ? { type: 'none' } : { type: 'move', index: i };
    }
    case 'ArrowUp':
    case 'k': {
      const i = nextEnabled(index < 0 ? count : index, -1, disabled);
      return i < 0 ? { type: 'none' } : { type: 'move', index: i };
    }
    case 'Home': {
      const i = edgeEnabled('first', disabled);
      return i < 0 ? { type: 'none' } : { type: 'move', index: i };
    }
    case 'End': {
      const i = edgeEnabled('last', disabled);
      return i < 0 ? { type: 'none' } : { type: 'move', index: i };
    }
    case 'Enter':
    case ' ':
      return index >= 0 && !disabled[index] ? { type: 'activate', index } : { type: 'none' };
    case 'Escape':
      return { type: 'close', refocus: true };
    case 'Tab':
      return { type: 'close', refocus: false };
    default: {
      if (key.length === 1 && /\S/.test(key)) {
        const ch = key.toLowerCase();
        for (let step = 1; step <= count; step++) {
          const k = (((index < 0 ? -1 : index) + step) % count + count) % count;
          if (!disabled[k] && labels[k].trim().toLowerCase().startsWith(ch)) return { type: 'move', index: k };
        }
      }
      return { type: 'none' };
    }
  }
}

/** What a key does on the closed More button: open on the first or last action, or nothing. */
export function menuButtonKey(key: string, disabled: readonly boolean[]): { open: true; index: number } | null {
  if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return { open: true, index: edgeEnabled('first', disabled) };
  if (key === 'ArrowUp') return { open: true, index: edgeEnabled('last', disabled) };
  return null;
}

/** The option a key moves a segmented control to, or null when the key is not one of its keys. */
export function segmentedKey(key: string, index: number, disabled: readonly boolean[]): number | null {
  let i = -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') i = nextEnabled(index, 1, disabled);
  else if (key === 'ArrowLeft' || key === 'ArrowUp') i = nextEnabled(index < 0 ? disabled.length : index, -1, disabled);
  else if (key === 'Home') i = edgeEnabled('first', disabled);
  else if (key === 'End') i = edgeEnabled('last', disabled);
  else return null;
  return i < 0 ? null : i;
}

/** Plain text of a label for typeahead (strings and numbers; anything else counts as empty). */
export function labelText(label: unknown): string {
  if (typeof label === 'string' || typeof label === 'number') return String(label);
  return '';
}
