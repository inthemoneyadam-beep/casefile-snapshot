/** Zoom levels, bucket keys and window arithmetic for the timeline. */
import type { TimelineBucket, TimelineZoom } from '@shared/timeline';

export const ZOOMS: TimelineZoom[] = ['years', 'months', 'days'];

export function zoomToBucket(z: TimelineZoom): TimelineBucket {
  return z === 'years' ? 'year' : z === 'months' ? 'month' : 'day';
}

export function zoomIn(z: TimelineZoom): TimelineZoom | null {
  const i = ZOOMS.indexOf(z);
  return i < ZOOMS.length - 1 ? ZOOMS[i + 1] : null;
}

export function zoomOut(z: TimelineZoom): TimelineZoom | null {
  const i = ZOOMS.indexOf(z);
  return i > 0 ? ZOOMS[i - 1] : null;
}

function lastDayOf(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The first bucket a partial date covers ("2024" at month -> "2024-01"). */
export function bucketStart(date: string, bucket: TimelineBucket): string {
  const padded = date.length === 4 ? `${date}-01-01` : date.length === 7 ? `${date}-01` : date.slice(0, 10);
  return bucket === 'year' ? padded.slice(0, 4) : bucket === 'month' ? padded.slice(0, 7) : padded;
}

/** The last bucket a partial date covers ("2024" at day -> "2024-12-31"). */
export function bucketEnd(date: string, bucket: TimelineBucket): string {
  let padded: string;
  if (date.length === 4) padded = `${date}-12-31`;
  else if (date.length === 7) {
    const [y, m] = date.split('-');
    padded = `${date}-${String(lastDayOf(+y, +m)).padStart(2, '0')}`;
  } else padded = date.slice(0, 10);
  return bucket === 'year' ? padded.slice(0, 4) : bucket === 'month' ? padded.slice(0, 7) : padded;
}

/** A window expressed at a coarser level: the enclosing periods. */
export function widen(from: string, to: string, bucket: TimelineBucket): { from: string; to: string } {
  return { from: bucketStart(from, bucket), to: bucketEnd(to, bucket) };
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function groupLabel(key: string, bucket: TimelineBucket): string {
  if (bucket === 'year') return key.slice(0, 4);
  const [y, m, d] = key.split('-');
  if (bucket === 'month' || !d) return `${MONTHS[+m - 1]} ${y}`;
  return `${y}-${m}-${d}`;
}
