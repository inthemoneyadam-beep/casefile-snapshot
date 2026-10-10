/**
 * The Find box of a list page: the box keeps its own text while the user types, and the URL's `q` follows once the
 * typing stops (sweep 2026-10-07: one hook for the block every list route copied).
 *   - The box starts from `value` (the URL's `q`) and follows it when it changes (Back, a link, a cleared filter).
 *   - `ms` after the last change of the box, `commit(next)` runs once when `next` differs from `value`; `next` is the
 *     box's text (trimmed when `trim` is set), or undefined when empty, so an empty box removes `q` from the URL.
 *   - Only a change of the box starts the timer, and `value` and `commit` are those of the render where it changed,
 *     exactly as each page's own effect read them.
 * Each page passes its own `commit` (with the resets it makes: `id`, `page`).
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

export interface DebouncedSearchOptions {
  /** Milliseconds after the last change (250; Search uses 200). */
  ms?: number;
  /** Trim the box's text before it is compared and committed (Search). */
  trim?: boolean;
}

export function useDebouncedSearch(value: string | undefined, commit: (next: string | undefined) => void, { ms = 250, trim = false }: DebouncedSearchOptions = {}): [string, Dispatch<SetStateAction<string>>] {
  const [local, setLocal] = useState(value ?? '');
  useEffect(() => setLocal(value ?? ''), [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = (trim ? local.trim() : local) || undefined;
      if (next !== value) commit(next);
    }, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  return [local, setLocal];
}
