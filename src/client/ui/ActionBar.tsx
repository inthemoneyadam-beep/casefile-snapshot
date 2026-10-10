/**
 * ActionBar: a page's or a pane's actions with a clear order of importance.
 * ONE primary action (filled accent in a page header, outlined in a pane),
 * a few secondary actions as plain text buttons, and everything rare under a
 * "More" menu (ui/Menu.tsx). Buttons are words, never icons.
 *
 *   <ActionBar
 *     primary={{ label: 'Add a lab value', onClick: add, shortcut: 'n' }}
 *     secondary={[{ label: "Add Claude's values", onClick: importAll, shortcut: 'f', title: 'Puts every value Claude read on your list' }]}
 *     more={[{ label: 'Show all values', onClick: showAll }, 'separator', { label: 'Delete', onClick: del, danger: true }]}
 *   />
 *
 * Rules: at most one primary; two or three secondary actions (more goes under
 * More); a destructive action goes under More unless it is the point of the
 * pane. Order on screen is order of importance: primary, secondary, More.
 * A More that would hold a single action shows that action as a plain button
 * instead (a menu of one hides it for nothing), unless it is destructive. An action with `pressed` is a
 * toggle that is on: its button looks pressed and says so (aria-pressed).
 */
import type { ReactNode } from 'react';
import { Button } from './Button';
import { MoreMenu, isAction, visibleEntries, type Action, type MenuEntry } from './Menu';

export type { Action, MenuEntry } from './Menu';

export interface ActionBarProps {
  primary?: Action | null | false;
  secondary?: Array<Action | null | false | undefined>;
  more?: MenuEntry[];
  /** Words on the More button (default "More"). */
  moreLabel?: ReactNode;
  /** 'md' (default) in a page header, 'sm' in a pane. */
  size?: 'sm' | 'md';
  /** How the primary looks: 'filled' (default; a page's main action) or 'outline' (a pane's main action). */
  primaryStyle?: 'filled' | 'outline';
  className?: string;
}

function key(a: Action, i: number): string {
  return a.id ?? (typeof a.label === 'string' ? a.label : `action-${i}`);
}

/**
 * The one action a More would hold, when it would hold only one (it then shows as a plain button). A destructive one
 * stays under More: deleting is never one stray click away.
 */
export function loneMoreAction(more: MenuEntry[]): Action | null {
  const entries = visibleEntries(more);
  return entries.length === 1 && isAction(entries[0]) && !entries[0].danger ? entries[0] : null;
}

export function ActionBar({ primary, secondary = [], more = [], moreLabel = 'More', size = 'md', primaryStyle = 'filled', className }: ActionBarProps) {
  const lone = loneMoreAction(more);
  const shownSecondary = [...secondary, lone].filter((a): a is Action => Boolean(a) && !(a as Action).hidden);
  const showPrimary = primary && !primary.hidden ? primary : null;
  return (
    <div className={['action-bar', className ?? ''].filter(Boolean).join(' ')}>
      {showPrimary ? (
        <Button variant={showPrimary.danger ? 'danger' : primaryStyle === 'outline' ? 'accent' : 'primary'} size={size} onClick={showPrimary.onClick} disabled={showPrimary.disabled} title={showPrimary.title} shortcut={showPrimary.shortcut}>
          {showPrimary.label}
        </Button>
      ) : null}
      {shownSecondary.map((a, i) => (
        <Button
          key={key(a, i)}
          variant={a.danger ? 'danger' : 'default'}
          size={size}
          onClick={a.onClick}
          disabled={a.disabled}
          title={a.title}
          shortcut={a.shortcut}
          aria-pressed={a.pressed == null ? undefined : a.pressed}
          className={a.pressed ? 'pressed' : undefined}
        >
          {a.label}
        </Button>
      ))}
      {lone ? null : <MoreMenu items={more} label={moreLabel} size={size} />}
    </div>
  );
}

/** True for an ActionBar description (rather than ready-made elements). */
export function isActionBarProps(v: unknown): v is ActionBarProps {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if ('$$typeof' in (v as object)) return false;
  return 'primary' in (v as object) || 'secondary' in (v as object) || 'more' in (v as object);
}
