import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Kbd } from './Kbd';

/**
 * A text button. Variants, in order of weight:
 *   primary  filled accent: the one main action of a page
 *   accent   outlined accent: the one main action of a pane or dialog section
 *   default  bordered: a secondary action
 *   ghost    no border: a quiet action (Clear, Cancel in a row)
 *   danger   outlined in the danger colour: delete, remove (usually under More)
 * `shortcut` shows its key after the words when key hints are on in Settings.
 */
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'accent' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  shortcut?: string;
  children: ReactNode;
}

export function Button({ variant = 'default', size = 'md', shortcut, className = '', children, type = 'button', ...rest }: Props) {
  const cls = ['btn', variant !== 'default' ? variant : '', size === 'sm' ? 'sm' : '', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {children}
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </button>
  );
}
