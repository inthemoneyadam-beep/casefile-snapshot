/**
 * How the viewer splits page text into requests. Pure (no React, no DOM), so
 * the server-side test project can check it too.
 */

export interface PageRange {
  from: number;
  to: number;
}

/** Pages are fetched in fixed, aligned buckets, well under the server's 200-page window. */
export const PAGE_BUCKET = 50;

/**
 * The aligned buckets that cover the wanted ranges, in page order. Fixed
 * buckets keep query keys stable: widening a range only fetches the new
 * bucket, never the pages already loaded, and no request can be cut short by
 * the server's window limit.
 */
export function pageBuckets(ranges: PageRange[]): PageRange[] {
  const seen = new Set<number>();
  for (const r of ranges) {
    if (!(r.to >= r.from) || r.from < 1) continue;
    const first = Math.floor((r.from - 1) / PAGE_BUCKET);
    const last = Math.floor((r.to - 1) / PAGE_BUCKET);
    for (let b = first; b <= last; b++) seen.add(b);
  }
  return [...seen].sort((a, b) => a - b).map((b) => ({ from: b * PAGE_BUCKET + 1, to: (b + 1) * PAGE_BUCKET }));
}
