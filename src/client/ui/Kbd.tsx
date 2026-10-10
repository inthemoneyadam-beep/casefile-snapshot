import type { ReactNode } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders a shortcut like "ctrl+k" or "g d" as key caps. */
export function Kbd({ children }: { children: ReactNode }) {
  if (typeof children !== 'string') return <kbd className="kbd">{children}</kbd>;
  const parts = children.split(' ');
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {parts.map((p, i) => (
        <kbd key={i} className="kbd">
          {p
            .split('+')
            .map((k) => (k === 'ctrl' ? (isMac ? '⌘' : 'Ctrl') : k === 'shift' ? 'Shift' : k === 'alt' ? 'Alt' : k === 'enter' ? 'Enter' : k === 'esc' ? 'Esc' : k))
            .join('+')}
        </kbd>
      ))}
    </span>
  );
}
