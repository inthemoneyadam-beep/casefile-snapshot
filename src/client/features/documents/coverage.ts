/**
 * How much of a document Claude has read, in plain words (2026-10-07, large exports). The coverage lives in
 * `documents.metadata_json.coverage` (src/shared/schemas/segments.ts): every page is read (details pulled out), read
 * word for word without the model (messages, notes, letters), skipped with a reason (a repeat, blank, nothing
 * readable), could not be read, or not read yet. These helpers turn it into the words the list, the document pane,
 * the "adding" banner and the guide use: "Partly read: details from pp.1-48 of 1,840".
 *
 * Plain TypeScript (no React, no DOM) so tests can import it directly.
 */
import { decodeStateRanges, formatPageRanges, pagesAccounted, pagesToRanges, parseCoverage, type DocumentCoverage, type PageRange } from '@shared/schemas/segments';
import type { PageCoverageState } from '@shared/enums';

/** "1,840": counts in the app's number style. */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** "1 page", "1,840 pages". */
export function pages(n: number): string {
  return `${count(n)} page${n === 1 ? '' : 's'}`;
}

/** The coverage stored on a document row (null when there is none yet, or it does not read). */
export function coverageOf(d: { metadataJson?: string | null } | null | undefined): DocumentCoverage | null {
  if (!d?.metadataJson) return null;
  try {
    return parseCoverage(JSON.parse(d.metadataJson) as unknown);
  } catch {
    return null;
  }
}

/** The pages in any of these states, as ranges. */
export function rangesInState(cov: DocumentCoverage, states: readonly PageCoverageState[]): PageRange[] {
  const per = decodeStateRanges(cov.ranges, cov.pagesTotal);
  const out: number[] = [];
  per.forEach((s, i) => {
    if (states.includes(s)) out.push(i + 1);
  });
  return pagesToRanges(out);
}

/** How many pages a list of ranges holds. */
export function pagesIn(ranges: readonly PageRange[]): number {
  return ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
}

/** Ranges in words, at most `max` of them ("pp.1-48, 61-72 and 14 more"). */
export function rangesWords(ranges: readonly PageRange[], max = 6): string {
  if (!ranges.length) return '';
  if (ranges.length <= max) return formatPageRanges(ranges);
  return `${formatPageRanges(ranges.slice(0, max))} and ${count(ranges.length - max)} more`;
}

/** Pages not read yet (waiting, or being read now). */
export function unreadPages(cov: Pick<DocumentCoverage, 'pagesPending' | 'pagesRunning'>): number {
  return cov.pagesPending + cov.pagesRunning;
}

/** Pages the model read, as words: "pp.1-48 of 1,840", "all 1,840 pages", or null when none was read yet. */
export function detailsFromWords(cov: DocumentCoverage): string | null {
  if (!cov.pagesTotal) return null;
  if (cov.state === 'complete') return `all ${pages(cov.pagesTotal)}`;
  const done = rangesInState(cov, ['done']);
  if (!done.length) return null;
  return `${rangesWords(done, 3)} of ${count(cov.pagesTotal)}`;
}

/** True when the coverage says some pages are not read yet or could not be read. */
export function hasGaps(cov: DocumentCoverage | null): boolean {
  return Boolean(cov && cov.state !== 'complete' && (unreadPages(cov) > 0 || cov.pagesFailed > 0));
}

/** The pages accounted for (read, read word for word, skipped with a reason). */
export function accountedPages(cov: DocumentCoverage): number {
  return pagesAccounted(cov);
}

/**
 * One line for a list or a status line: "Partly read: details from pp.1-48 of 1,840", "Reading: details from 120 of
 * 1,840 pages so far", "Stopped: details from pp.1-48 of 1,840". Null when the coverage has nothing to add.
 */
export function coverageStatusWords(extractionStatus: string, cov: DocumentCoverage | null): string | null {
  if (!cov || !cov.pagesTotal) return null;
  const from = detailsFromWords(cov);
  if (extractionStatus === 'queued' || extractionStatus === 'running' || cov.state === 'running') {
    return cov.pagesDone ? `Reading: details from ${count(cov.pagesDone)} of ${pages(cov.pagesTotal)} so far` : null;
  }
  if (extractionStatus === 'failed') return from ? `Stopped: details from ${from}` : null;
  if (extractionStatus === 'partial' || (cov.state === 'partial' && extractionStatus !== 'none')) {
    return from ? `Partly read: details from ${from}` : `Partly read: ${count(accountedPages(cov))} of ${pages(cov.pagesTotal)} accounted for`;
  }
  return null;
}

/**
 * What is still missing, in one sentence for the document pane: "1,792 pages not read yet; 7 could not be read; 214
 * scanned pages not read by OCR yet." Null when nothing is missing.
 */
export function missingWords(cov: DocumentCoverage | null): string | null {
  if (!cov) return null;
  const parts: string[] = [];
  const unread = unreadPages(cov);
  if (unread) parts.push(`${pages(unread)} not read yet${cov.pagesRunning ? ` (${count(cov.pagesRunning)} being read now)` : ''}`);
  if (cov.pagesFailed) parts.push(`${count(cov.pagesFailed)} could not be read`);
  const scans = Math.max(cov.pagesImage, cov.pagesOcr);
  if (scans > cov.pagesOcr) parts.push(`${count(scans - cov.pagesOcr)} scanned page${scans - cov.pagesOcr === 1 ? '' : 's'} not read by OCR yet`);
  return parts.length ? `${parts.join('; ')}.` : null;
}

/** Skip reasons in words, for the coverage panel. */
export const SKIP_WORDS: Record<string, [string, string]> = {
  duplicate: ['repeat of an earlier page', 'repeats of earlier pages'],
  boilerplate: ['repeated cover sheet', 'repeated cover sheets and insurance blocks'],
  blank: ['blank page', 'blank pages'],
  no_text: ['page with nothing readable', 'pages with nothing readable'],
};

/** A page's state in words (the coverage strip's legend and its hover text). */
export const PAGE_STATE_WORDS: Record<PageCoverageState, string> = {
  done: 'Read by Claude',
  parsed: 'Read word for word',
  skipped: 'Skipped',
  no_text: 'Nothing readable',
  failed: 'Could not be read',
  running: 'Being read now',
  pending: 'Not read yet',
};

/** A reading run's result in words (the runs table). */
export function runStatusWords(status: string): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'partial':
      return 'part read';
    case 'failed':
      return 'did not work';
    case 'interrupted':
      return 'stopped by a lock or restart';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'reading now';
    default:
      return status.replace(/_/g, ' ');
  }
}

/** The tone of a run's result tag. */
export function runStatusTone(status: string): 'ok' | 'bad' | 'warn' | 'info' | 'ash' {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'partial' || status === 'interrupted') return 'warn';
  if (status === 'cancelled') return 'ash';
  return 'info';
}

/** "about $5.10" ("about $0.004" for very small sums). */
export function dollars(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '';
  return `about $${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;
}
