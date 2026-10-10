/**
 * Restore from a backup (only while no case exists yet, on a hosted server and on a local copy).
 *
 * The backup goes in pieces of 16 MB (POST /api/auth/restore/chunk), each with XMLHttpRequest so the upload reports
 * its progress (fetch cannot): Railway ends any request whose body takes longer than 5 minutes to arrive, and a
 * backup of a gigabyte or more from a home connection takes longer than that. A piece that does not arrive is sent
 * again from what the server holds (GET /api/auth/restore/chunk), a few times with a pause; the upload's id comes
 * from the file (its size, date and name), so choosing the same file again after a stop, a reload or a lost
 * connection carries on where it stopped. Then POST /api/auth/restore/finish has the server check the backup and
 * unpack it into the empty case; it returns when that is done. While it works, GET /api/auth/status says where it
 * stands (`restore`), which the setup screen polls for its progress line and to recover when the connection drops
 * after the upload finished.
 */
import { ApiError, retryAfterSeconds } from './client';
import { SETUP_TOKEN_HEADER, type AuthStatusFull } from './users';

/** The server refuses a backup larger than this (413). */
export const RESTORE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** One piece of the upload: small enough to arrive well inside Railway's 5 minutes even at 1 Mbit/s. */
export const RESTORE_PIECE_BYTES = 16 * 1024 * 1024;
/** The pauses before sending a piece again (so each piece is tried at most this many times plus one). */
export const PIECE_RETRY_WAITS_MS = [1000, 3000, 8000, 15000];

export interface RestoreResult extends AuthStatusFull {
  ok: true;
  files: number;
  bytes: number;
  /** The uploaded zip's file name, now kept among the server's backups (Settings, Backups), or null. */
  keptAs: string | null;
}

export interface UploadProgress {
  sent: number;
  total: number;
  /** The bytes the server already held when this upload began (an upload that carries on), else 0. */
  resumedFrom?: number;
}

/** The connection broke before the server answered: the upload may still have finished (ask the status). */
export class RestoreConnectionError extends Error {
  constructor(public uploadFinished: boolean) {
    super(uploadFinished ? 'The connection to the server was lost after the backup was sent.' : 'The connection to the server was lost while sending the backup.');
    this.name = 'RestoreConnectionError';
  }
}

/** The person stopped the upload. */
export class RestoreCancelledError extends Error {
  constructor() {
    super('Stopped. Nothing was restored. Choosing the same file again carries on where it stopped.');
    this.name = 'RestoreCancelledError';
  }
}

export interface RestoreOptions {
  /** Hosted only: the setup code (CASEFILE_SETUP_TOKEN). */
  setupToken?: string;
  onProgress?: (p: UploadProgress) => void;
  /** Called once every byte has been sent; the server is now checking and unpacking. */
  onSent?: () => void;
  signal?: AbortSignal;
  /** The pauses between tries of a piece (tests make them short). */
  retryWaitsMs?: number[];
}

function codeHeader(setupToken?: string): Record<string, string> {
  const code = setupToken?.trim();
  return code ? { [SETUP_TOKEN_HEADER]: code } : {};
}

/** The request headers for a restore of `file` in one request: the type, the file's name (kept on the server) and the setup code. */
export function restoreHeaders(file: { name: string }, setupToken?: string): Record<string, string> {
  return { 'content-type': 'application/zip', 'x-casefile-filename': encodeURIComponent(file.name), ...codeHeader(setupToken) };
}

/** The headers of one piece: where it goes, the whole size, the upload's id, the file's name and the setup code. */
export function pieceHeaders(file: { name: string; size: number }, id: string, offset: number, setupToken?: string): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'x-casefile-upload-id': id,
    'x-casefile-offset': String(offset),
    'x-casefile-total': String(file.size),
    'x-casefile-filename': encodeURIComponent(file.name),
    ...codeHeader(setupToken),
  };
}

/**
 * The upload's id, from the file itself (size, last change, a hash of the name), so the same file chosen again
 * carries on where an earlier upload stopped. Letters, digits and dashes, at least 8 characters.
 */
export function uploadIdFor(file: { name: string; size: number; lastModified?: number }): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < file.name.length; i++) {
    h ^= file.name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const changed = Math.max(0, Math.floor(file.lastModified ?? 0));
  return `${file.size.toString(36)}-${changed.toString(36)}-${h.toString(36)}`.padEnd(8, '0');
}

/** The server's answer as an ApiError (its `error` sentence, its body, and the wait after a 429). */
export function restoreError(status: number, statusText: string, text: string, retryAfter: string | null): ApiError {
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const b = body as { error?: unknown; retryAfterSeconds?: unknown } | null;
  const msg = b && typeof b === 'object' && typeof b.error === 'string' ? b.error : status === 413 ? 'The backup is larger than 4 GB.' : `${status} ${statusText}`.trim();
  const wait = status === 429 ? (typeof b?.retryAfterSeconds === 'number' ? b.retryAfterSeconds : retryAfterSeconds(retryAfter)) : undefined;
  return new ApiError(status, msg, body, wait);
}

/**
 * Before sending a backup that may be gigabytes: ask, with no file, whether the server would let a restore through
 * (the setup code, a case already there, the server's setup code missing, too many wrong tries). The restore route
 * checks those first and refuses a JSON body as "not the zip" only after them, so that refusal (400) means "go
 * ahead"; a refusal before it (401, 403, 409, 429) is thrown as the error to show, and nothing was sent. Anything
 * else says nothing either way: the upload itself will tell.
 *
 * Why: a server that refuses while a large upload is still arriving cuts the connection, and a browser behind a
 * proxy may then send the same request again by itself (seen with Chrome through a dev proxy: one wrong setup code
 * became five, and the wait for too many wrong tries began). Checking first never sends the file to be refused.
 */
export async function checkRestore(setupToken?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...codeHeader(setupToken) };
  let res: Response;
  try {
    res = await fetch('/api/auth/restore', { method: 'POST', headers, body: '{}', credentials: 'same-origin' });
  } catch {
    return; // the upload will meet the same trouble and say so
  }
  if (res.ok || res.status === 400) return;
  if (res.status === 401 || res.status === 403 || res.status === 409 || res.status === 429) {
    throw restoreError(res.status, res.statusText, await res.text().catch(() => ''), res.headers.get('retry-after'));
  }
}

/** A server answer that is worth another try: a gateway or server hiccup, or a piece that did not all arrive. */
function worthRetrying(status: number): boolean {
  return status === 408 || (status >= 500 && status !== 507);
}

/** How much of upload `id` the server holds: null when it cannot be told now (the pieces then find out); refusals are thrown. */
async function heldBytes(id: string, setupToken?: string): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch(`/api/auth/restore/chunk?id=${encodeURIComponent(id)}`, { headers: codeHeader(setupToken), credentials: 'same-origin' });
  } catch {
    return null;
  }
  const text = await res.text().catch(() => '');
  if (res.ok) {
    try {
      const j = JSON.parse(text) as { received?: unknown };
      return typeof j.received === 'number' && j.received >= 0 ? j.received : null;
    } catch {
      return null;
    }
  }
  if (worthRetrying(res.status)) return null;
  throw restoreError(res.status, res.statusText, text, res.headers.get('retry-after'));
}

type PieceOutcome = { kind: 'ok'; received: number } | { kind: 'refused'; error: ApiError; received: number | null; retry: boolean } | { kind: 'lost' };

/** Sends one piece; never rejects except for a stop (RestoreCancelledError). */
function sendPiece(body: Blob, headers: Record<string, string>, signal: AbortSignal | undefined, onLoaded: (n: number) => void): Promise<PieceOutcome> {
  return new Promise<PieceOutcome>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const onAbort = () => xhr.abort();
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    xhr.open('POST', '/api/auth/restore/chunk');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let received: number | null = null;
        try {
          const j = JSON.parse(xhr.responseText) as { received?: unknown };
          if (typeof j.received === 'number') received = j.received;
        } catch {
          // unreadable: ask the server what it holds
        }
        done(() => resolve(received === null ? { kind: 'lost' } : { kind: 'ok', received }));
        return;
      }
      const error = restoreError(xhr.status, xhr.statusText, xhr.responseText, xhr.getResponseHeader('retry-after'));
      const b = error.body as { code?: unknown; received?: unknown } | null;
      const code = b && typeof b === 'object' && typeof b.code === 'string' ? b.code : null;
      const received = b && typeof b === 'object' && typeof b.received === 'number' ? b.received : null;
      // Carry on: the server holds a different amount than this piece assumed, it is still writing the last piece,
      // a piece did not all arrive, or a gateway hiccup. Anything else is the server's refusal to show.
      const retry = (xhr.status === 409 && received !== null && (code === 'offset' || code === 'busy')) || code === 'interrupted' || worthRetrying(xhr.status);
      done(() => resolve({ kind: 'refused', error, received, retry }));
    };
    xhr.onerror = () => done(() => resolve({ kind: 'lost' }));
    xhr.ontimeout = () => done(() => resolve({ kind: 'lost' }));
    xhr.onabort = () => done(() => reject(new RestoreCancelledError()));
    if (signal?.aborted) {
      done(() => reject(new RestoreCancelledError()));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    xhr.send(body);
  });
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new RestoreCancelledError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new RestoreCancelledError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Has the server check, unpack and place the whole upload; returns when the restore is done. */
async function finishRestore(id: string, setupToken?: string): Promise<RestoreResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/restore/finish', { method: 'POST', headers: { 'content-type': 'application/json', ...codeHeader(setupToken) }, body: JSON.stringify({ id }), credentials: 'same-origin' });
  } catch {
    throw new RestoreConnectionError(true);
  }
  const text = await res.text().catch(() => '');
  if (res.ok) {
    try {
      return JSON.parse(text) as RestoreResult;
    } catch {
      throw new ApiError(res.status, 'The server answered in a way CaseFile could not read.');
    }
  }
  // A gateway that gave up while the server unpacks: the status says how the restore ends.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new RestoreConnectionError(true);
  throw restoreError(res.status, res.statusText, text, res.headers.get('retry-after'));
}

/** Send the backup in pieces (carrying on from what the server holds) and wait for the restore to finish. */
export async function restoreBackup(file: File, opts: RestoreOptions = {}): Promise<RestoreResult> {
  if (opts.signal?.aborted) throw new RestoreCancelledError();
  const waits = opts.retryWaitsMs ?? PIECE_RETRY_WAITS_MS;
  const id = uploadIdFor(file);
  const total = file.size;
  let received = (await heldBytes(id, opts.setupToken)) ?? 0;
  if (received > total) received = 0;
  const resumedFrom = received;
  opts.onProgress?.({ sent: received, total, resumedFrom });
  let failures = 0;
  while (received < total) {
    if (opts.signal?.aborted) throw new RestoreCancelledError();
    const offset = received;
    const end = Math.min(total, offset + RESTORE_PIECE_BYTES);
    const out = await sendPiece(file.slice(offset, end), pieceHeaders(file, id, offset, opts.setupToken), opts.signal, (n) => opts.onProgress?.({ sent: offset + n, total, resumedFrom }));
    if (out.kind === 'ok' && out.received > offset) {
      received = out.received;
      failures = 0;
      opts.onProgress?.({ sent: received, total, resumedFrom });
      continue;
    }
    if (out.kind === 'refused' && !out.retry) throw out.error;
    failures += 1;
    if (failures > waits.length) {
      if (out.kind === 'refused') throw out.error;
      throw new RestoreConnectionError(false);
    }
    // The server said how much it holds: carry on from there at once. Otherwise wait, then ask it.
    if (out.kind === 'refused' && out.received !== null && out.error.status === 409 && (out.error.body as { code?: unknown } | null)?.code === 'offset') {
      received = out.received;
      continue;
    }
    await pause(waits[failures - 1], opts.signal);
    const held = await heldBytes(id, opts.setupToken);
    if (held !== null && held <= total) received = held;
    else if (out.kind === 'refused' && out.received !== null) received = out.received;
  }
  if (opts.signal?.aborted) throw new RestoreCancelledError();
  opts.onSent?.();
  return finishRestore(id, opts.setupToken);
}
