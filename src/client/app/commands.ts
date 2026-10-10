/**
 * Command registry for the palette and shortcut sheet. Features register
 * commands while mounted (useRegisterCommands) and the palette lists them.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { NAV } from './nav';

export interface Command {
  id: string;
  title: string;
  group: string; // 'Go to' | 'Actions' | 'Documents' | ...
  keywords?: string;
  shortcut?: string; // display only, e.g. "g d" or "ctrl+k"
  run: () => void | Promise<void>;
  /** When set, the command only appears while this predicate is true. */
  when?: () => boolean;
}

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd);
  emit();
  return () => {
    if (commands.get(cmd.id) === cmd) {
      commands.delete(cmd.id);
      emit();
    }
  };
}

export function listCommands(): Command[] {
  return [...commands.values()].filter((c) => !c.when || c.when());
}

export function useCommands(): Command[] {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  return listCommands();
}

/** Register a set of commands for the lifetime of the component. */
export function useRegisterCommands(cmds: Command[], deps: unknown[] = []): void {
  useEffect(() => {
    const offs = cmds.map(registerCommand);
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Open the palette from anywhere. */
export function openPalette(initialQuery = ''): void {
  window.dispatchEvent(new CustomEvent('casefile:palette', { detail: { query: initialQuery } }));
}

/**
 * A command group's name as the reader sees it: the page's own name, never an internal group key ("Facts",
 * "Communications"). The palette and the keyboard sheet (shortcuts.tsx) both use it, so they say the same. A page's
 * own keys and actions ("Page", "Lists") carry the name of the page that is open (as the sidebar says it), so the
 * palette and the sheet head them alike on every page; "This page" / "This list" only where no page matches.
 */
export const GROUP_WORDS: Record<string, string> = {
  Page: 'This page',
  Lists: 'This list',
  Global: 'Anywhere',
  Actions: 'Anywhere',
  'Go to': 'Go to a page',
  Facts: 'Details from documents',
  Communications: 'Calls and messages',
  Tasks: 'To-do list',
  Findings: 'What Claude noticed',
  Ask: 'Ask the clinician',
  Labs: 'Lab results',
  Imaging: 'Scans and imaging',
};

/** The address bar's path, or '' outside a browser (tests). */
function currentPath(): string {
  return typeof location === 'undefined' ? '' : location.pathname;
}

/** The sidebar's name for the page at `path` ("/documents/abc" is Documents); null when none matches. */
export function pageLabelFor(path: string): string | null {
  if (!path) return null;
  const hit = NAV.find((n) => (n.to === '/' ? path === '/' : path === n.to || path.startsWith(`${n.to}/`)));
  return hit?.label ?? null;
}

export function groupWords(group: string, path: string = currentPath()): string {
  if (group === 'Page' || group === 'Lists') return pageLabelFor(path) ?? GROUP_WORDS[group];
  return GROUP_WORDS[group] ?? group;
}

/** Where a group goes in the palette and the keyboard sheet: this page's own first, the keys that work anywhere and the pages last. */
export function groupRank(words: string, path: string = currentPath()): number {
  // The open page's own group first, whatever key its commands were registered under.
  if (words === pageLabelFor(path)) return 0;
  // "Ask the clinician" holds the clinician panel's commands, which are there on every page: after this page's own.
  const rank: Record<string, number> = { 'This page': 0, 'This list': 2, 'Ask the clinician': 3, Anywhere: 4, 'Go to a page': 5 };
  return rank[words] ?? 1;
}
