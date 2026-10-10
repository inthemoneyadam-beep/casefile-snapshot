/**
 * One thin bar per bucket, height proportional to the item count, in the muted
 * text colour so it reads against the band. The hovered or selected bucket is
 * drawn in the accent colour; the current window is a soft band behind the
 * bars. Click a bar to see that period. The line under it says, in words, what
 * the strip covers and, on hover, what the bar holds ("2024: 46 items, 17
 * documents, 29 details").
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineBucket, TimelineDensityRow } from '@shared/timeline';
import { kindCount } from './words';

export interface StripBucket {
  key: string;
  total: number;
  counts: Record<string, number>;
}

export function bucketLabel(key: string, bucket: TimelineBucket): string {
  if (bucket === 'year') return key;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = key.split('-');
  if (bucket === 'month') return `${months[+m - 1]} ${y}`;
  return `${d} ${months[+m - 1]}`;
}

/** Fill the buckets between `start` and `end` (inclusive), in calendar order. */
export function fillBuckets(rows: TimelineDensityRow[], bucket: TimelineBucket, start: string, end: string): StripBucket[] {
  const have = new Map(rows.map((r) => [r.bucket, r.counts]));
  const out: StripBucket[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard++ < 20000) {
    const counts = have.get(cur) ?? {};
    out.push({ key: cur, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
    cur = stepBucket(cur, bucket, 1);
  }
  return out;
}

/** Move a bucket key by `n` buckets. */
export function stepBucket(key: string, bucket: TimelineBucket, n: number): string {
  const [y, m = '01', d = '01'] = key.split('-');
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (bucket === 'year') dt.setUTCFullYear(dt.getUTCFullYear() + n);
  else if (bucket === 'month') dt.setUTCMonth(dt.getUTCMonth() + n);
  else dt.setUTCDate(dt.getUTCDate() + n);
  const iso = dt.toISOString().slice(0, 10);
  return bucket === 'year' ? iso.slice(0, 4) : bucket === 'month' ? iso.slice(0, 7) : iso;
}

export function DensityStrip({
  buckets,
  bucket,
  windowFrom,
  windowTo,
  selectedKey,
  onPick,
}: {
  buckets: StripBucket[];
  bucket: TimelineBucket;
  /** Bucket keys at this level. */
  windowFrom?: string | null;
  windowTo?: string | null;
  selectedKey?: string | null;
  onPick: (key: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(200, Math.floor(entry.contentRect.width));
      setW((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 48;
  const labelH = 12;
  const plotH = H - labelH - 2;
  const n = buckets.length;
  const max = useMemo(() => Math.max(1, ...buckets.map((b) => b.total)), [buckets]);
  const slot = n ? W / n : W;
  const gap = Math.min(1.5, slot * 0.25);
  const every = Math.max(1, Math.ceil(n / 12));
  // windowFrom/windowTo are bucket keys at this level.
  const wFrom = windowFrom ?? null;
  const wTo = windowTo ?? null;
  const winStart = wFrom ? buckets.findIndex((b) => b.key >= wFrom) : -1;
  let winEnd = wTo ? buckets.findIndex((b) => b.key > wTo) - 1 : -1;
  if (wTo && winEnd === -2) winEnd = n - 1;
  const hovered = hover ? buckets.find((b) => b.key === hover) : null;

  if (!n) {
    return (
      <div className="timeline-strip" ref={wrapRef}>
        <div className="timeline-strip-foot">
          <span>Nothing dated in these dates.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-strip" ref={wrapRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Density by ${bucket}`}>
        {winStart >= 0 && winEnd >= winStart ? <rect className="window" x={winStart * slot} y={0} width={(winEnd - winStart + 1) * slot} height={plotH + 2} /> : null}
        <line x1={0} x2={W} y1={plotH + 1.5} y2={plotH + 1.5} stroke="var(--border-strong)" strokeWidth={1} />
        {buckets.map((b, i) => {
          const h = b.total ? Math.max(2, (b.total / max) * plotH) : 0;
          const active = b.key === hover || b.key === selectedKey;
          return (
            <g key={b.key} onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover((h0) => (h0 === b.key ? null : h0))} onClick={() => onPick(b.key)}>
              <rect className="bar hit" x={i * slot} y={0} width={slot} height={plotH + 2} />
              <rect className={active ? 'bar active' : 'bar'} x={i * slot + gap / 2} y={plotH - h} width={Math.max(0.5, slot - gap)} height={h}>
                <title>{`${bucketLabel(b.key, bucket)}: ${b.total} item${b.total === 1 ? '' : 's'}`}</title>
              </rect>
            </g>
          );
        })}
        {buckets.map((b, i) =>
          i % every === 0 ? (
            <text key={`l-${b.key}`} x={i * slot + 1} y={H - 1}>
              {bucketLabel(b.key, bucket)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="timeline-strip-foot">
        <span>
          {n} {bucket === 'year' ? (n === 1 ? 'year' : 'years') : bucket === 'month' ? (n === 1 ? 'month' : 'months') : n === 1 ? 'day' : 'days'}, <span className="mono">{bucketLabel(buckets[0].key, bucket)}</span> to <span className="mono">{bucketLabel(buckets[n - 1].key, bucket)}</span>.{' '}
          {bucket === 'day' ? 'Click a bar to pick its first item.' : `Click a bar to see that ${bucket}.`}
        </span>
        <span>
          {hovered
            ? `${bucketLabel(hovered.key, bucket)}: ${hovered.total} item${hovered.total === 1 ? '' : 's'}${hovered.total ? ', ' + Object.entries(hovered.counts).map(([k, v]) => kindCount(k, v)).join(', ') : ''}`
            : selectedKey
              ? `The selected item is in ${bucketLabel(selectedKey, bucket)}`
              : ''}
        </span>
      </div>
    </div>
  );
}
