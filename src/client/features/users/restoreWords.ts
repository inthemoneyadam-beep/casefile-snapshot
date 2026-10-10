/**
 * Words for the first screen and the lock screen when the app runs on a server (Railway): the restore's progress,
 * a wait after too many wrong tries, and the refusals that only a hosted server gives. Pure functions, so the
 * tests read them without a browser.
 */
import { ApiError } from '../../api/client';
import type { RestoreStatus } from '../../api/users';

/** A size in the words a person reads: 820 KB, 412 MB, 1.2 GB. */
export function sizeWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** "about 3 minutes", "about 40 seconds", "under 5 seconds". */
export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return 'under 5 seconds';
  if (s < 90) return `about ${Math.ceil(s / 5) * 5} seconds`;
  if (s < 90 * 60) return `about ${Math.round(s / 60)} minutes`;
  const h = s / 3600;
  return `about ${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} hours`;
}

/** The wait after too many wrong tries, live: "Wait 12 minutes and try again." / "Wait 40 seconds and try again." */
export function waitWords(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s > 60) {
    const m = Math.ceil(s / 60);
    return `Too many wrong tries. Wait ${m} minutes and try again.`;
  }
  return `Too many wrong tries. Wait ${s} second${s === 1 ? '' : 's'} and try again.`;
}

/** Seconds to wait from a 429 (the body's retryAfterSeconds, else the Retry-After header), else null. */
export function throttleSeconds(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const b = err.body as { retryAfterSeconds?: unknown } | null;
  if (b && typeof b === 'object' && typeof b.retryAfterSeconds === 'number' && b.retryAfterSeconds > 0) return b.retryAfterSeconds;
  if (typeof err.retryAfter === 'number' && err.retryAfter > 0) return err.retryAfter;
  // A 429 without a time: the server's window is 15 minutes.
  return 15 * 60;
}

/** The server's machine code on a refusal (`setup_token`, `not_backup`, `hosted`, ...), or null. */
export function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const b = err.body as { code?: unknown } | null;
  return b && typeof b === 'object' && typeof b.code === 'string' ? b.code : null;
}

/**
 * "Sending the backup: 412 MB of 1.2 GB (34%), about 3 minutes left." `base` is what the server already held when
 * this upload began (one that carries on): it counts as sent but not toward the speed.
 */
export function uploadLine(sent: number, total: number, elapsedMs: number, base = 0): string {
  const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
  let left = '';
  const moved = sent - base;
  // A time left only once there is enough to go on (two seconds and 1% of the file in this time).
  if (elapsedMs > 2000 && moved > 0 && total > sent && total > 0 && moved / total >= 0.01) {
    const rate = moved / (elapsedMs / 1000);
    left = `, ${durationWords((total - sent) / rate)} left`;
  }
  return `Sending the backup: ${sizeWords(sent)} of ${sizeWords(total)} (${pct}%)${left}.`;
}

/** What the server says it is doing with a restore, in one line. */
export function restoreStatusLine(r: RestoreStatus): string {
  switch (r.state) {
    case 'receiving':
      return r.totalBytes ? `The server has received ${sizeWords(r.receivedBytes)} of ${sizeWords(r.totalBytes)}.` : `The server has received ${sizeWords(r.receivedBytes)}.`;
    case 'checking':
      return 'Checking that the backup is whole and is a CaseFile backup…';
    case 'extracting':
      return r.totalFiles ? `Unpacking the backup: ${r.files.toLocaleString('en-US')} of ${r.totalFiles.toLocaleString('en-US')} files…` : `Unpacking the backup: ${r.files.toLocaleString('en-US')} files…`;
    case 'done':
      return `The backup is restored (${r.files.toLocaleString('en-US')} file${r.files === 1 ? '' : 's'}).`;
    case 'failed':
      return r.error ?? 'The restore did not work. Nothing was restored.';
  }
}

/** True while the server is still receiving, checking or unpacking a backup. */
export function restoreRunning(r: RestoreStatus | null | undefined): boolean {
  return Boolean(r && (r.state === 'receiving' || r.state === 'checking' || r.state === 'extracting'));
}

/** A file the person chose, checked before anything is sent: null when it can go, else why not. */
export function backupFileProblem(file: { name: string; size: number } | null, maxBytes: number): string | null {
  if (!file) return 'Choose the backup file first.';
  if (file.size === 0) return 'That file is empty.';
  if (!/\.zip$/i.test(file.name)) return 'Choose a backup made by CaseFile: a .zip file, named like casefile-20261008-141500.zip.';
  if (file.size > maxBytes) return `That file is ${sizeWords(file.size)}; the server takes backups up to ${sizeWords(maxBytes)}.`;
  return null;
}
