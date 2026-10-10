/**
 * Per-type result counts for the Search page. The page runs two capped
 * queries: every type (the chips) and the selected types (the list). A
 * count from a query that hit its cap is only a lower bound and is shown
 * with a "+"; an uncapped query's count is exact. DOM-free for node tests.
 */

export interface TypeCount {
  n: number;
  /** n is a lower bound: there may be more. */
  more: boolean;
}

export interface CountSource {
  /** Hits per type in this query's result. */
  byType: Record<string, number>;
  /** The query returned as many hits as it was allowed to. */
  capped: boolean;
}

export function countByType(items: ReadonlyArray<{ type: string }>): Record<string, number> {
  const c: Record<string, number> = {};
  for (const h of items) c[h.type] = (c[h.type] ?? 0) + 1;
  return c;
}

/**
 * The best count for one type. `all` is the unfiltered query; `filtered`
 * is the query for the selected types, passed only when `type` is one of
 * them and its data is for the current selection.
 */
export function typeCount(type: string, all: CountSource, filtered: CountSource | null): TypeCount {
  const a = all.byType[type] ?? 0;
  if (!all.capped) return { n: a, more: false };
  if (filtered && !filtered.capped) return { n: filtered.byType[type] ?? 0, more: false };
  return { n: Math.max(a, filtered?.byType[type] ?? 0), more: true };
}

export function formatCount(c: TypeCount): string {
  return `${c.n}${c.more ? '+' : ''}`;
}

/** The count beside a group heading: the hits shown, then the total when it is known to be larger or may be. */
export function groupCountLabel(shown: number, total: TypeCount): string {
  if (total.n > shown) return `${shown} of ${formatCount(total)}`;
  return total.more ? `${shown}+` : String(shown);
}
