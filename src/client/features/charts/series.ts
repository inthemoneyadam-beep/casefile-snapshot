/**
 * How a line series is drawn when one date holds more than one value (two
 * documents give 62 and 94 mg/dL for the same lumbar puncture): never a
 * vertical jump between them, which reads as a change on one day. The line
 * forks instead: a dashed line from the date before to each value, and from
 * each value to the date after, so both readings are shown and neither is
 * picked. Copies of one value (the same number on the same date from several
 * documents) are one point. A date with no number breaks the line, as before.
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */

export interface LinePoint {
  /** The x value (date as a number, or a number); points with the same xv are one date. */
  xv: number;
  px: number;
  /** null leaves a gap in the line. */
  py: number | null;
}

export interface LinePaths {
  /** The ordinary line: dates that hold one value, joined. */
  solid: string;
  /** The fork: lines to and from a date that holds several different values. */
  dashed: string;
  /** Dates (xv) that hold several different values. */
  forks: number[];
}

/** One date's points: the distinct values drawn there (null for a gap). */
function groupsOf(pts: readonly LinePoint[]): Array<{ xv: number; at: Array<{ px: number; py: number }> } | null> {
  const out: Array<{ xv: number; at: Array<{ px: number; py: number }> } | null> = [];
  let current: { xv: number; at: Array<{ px: number; py: number }>; nulls: number; total: number } | null = null;
  const flush = () => {
    if (!current) return;
    // A date whose every point has no number breaks the line.
    out.push(current.at.length ? { xv: current.xv, at: current.at } : null);
    current = null;
  };
  for (const p of pts) {
    if (!Number.isFinite(p.xv) || !Number.isFinite(p.px)) continue;
    if (!current || current.xv !== p.xv) {
      flush();
      current = { xv: p.xv, at: [], nulls: 0, total: 0 };
    }
    current.total += 1;
    if (p.py == null || !Number.isFinite(p.py)) {
      current.nulls += 1;
      continue;
    }
    // Copies of one value are one point (within half a pixel).
    if (!current.at.some((q) => Math.abs(q.py - (p.py as number)) < 0.5)) current.at.push({ px: p.px, py: p.py });
  }
  flush();
  return out;
}

/**
 * The paths of a line series, in the order its points are given (the server
 * sends them by date). With one value per date this is exactly the old line.
 */
export function lineSegments(pts: readonly LinePoint[]): LinePaths {
  const groups = groupsOf(pts);
  const solid: string[] = [];
  const dashed: string[] = [];
  const forks: number[] = [];
  let penAt: { px: number; py: number } | null = null;
  let prev: { xv: number; at: Array<{ px: number; py: number }> } | null = null;
  for (const g of groups) {
    if (!g) {
      prev = null;
      penAt = null;
      continue;
    }
    if (g.at.length > 1) forks.push(g.xv);
    if (prev) {
      if (prev.at.length === 1 && g.at.length === 1) {
        const a = prev.at[0];
        const b = g.at[0];
        if (!penAt || penAt.px !== a.px || penAt.py !== a.py) solid.push(`M${a.px},${a.py}`);
        solid.push(`L${b.px},${b.py}`);
        penAt = b;
      } else {
        for (const a of prev.at) for (const b of g.at) dashed.push(`M${a.px},${a.py}L${b.px},${b.py}`);
        penAt = null;
      }
    } else if (g.at.length === 1) {
      solid.push(`M${g.at[0].px},${g.at[0].py}`);
      penAt = g.at[0];
    }
    prev = g;
  }
  // A lone move with no line after it draws nothing; drop it so an empty series has an empty path.
  const d = solid.join(' ').replace(/(?:^|\s)M[^ ]+(?=\s+M|$)/g, '').trim();
  return { solid: d, dashed: dashed.join(' '), forks };
}
