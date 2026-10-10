/**
 * Restore a backup through the browser, on the setup screen while the server holds no case: the way to bring the user's
 * case from his computer to the hosted server, and to start again locally from a zip. The zip is one made by this
 * app (services/backup.ts: keyring.json, casefile.db, maybe casefile.db-wal, files/, backup.json), still encrypted
 * throughout; the user then unlocks with the passphrase that was in use when it was made.
 *
 * Two ways in (src/server/auth.ts):
 * - In pieces (what the setup screen uses): POST /api/auth/restore/chunk appends one piece (at most
 *   RESTORE_CHUNK_MAX_BYTES) at the offset the server already holds; GET /api/auth/restore/chunk?id= says how much it
 *   holds, so an upload that stopped carries on where it stopped; POST /api/auth/restore/finish checks, unpacks and
 *   places it. Railway ends any request whose body takes longer than 5 minutes to arrive
 *   (docs.railway.com/networking/public-networking/specs-and-limits), so a backup of a gigabyte or more cannot go in
 *   one request from a home connection; a piece of 16 MB can.
 * - In one request (POST /api/auth/restore, the body is the zip): kept for scripts and small backups.
 *
 * Data safety (CLAUDE.md): nothing that exists is ever replaced.
 * - Refused unless the data folder is empty: empty folders (files/, tesscache/, logs/ made at start) are fine, any
 *   file anywhere below is not, and keyring.json means a case is already there. Checked for every piece, and again
 *   just before the move.
 * - The upload streams into a staging folder of its own inside the data folder (`.restore-<random>/upload.zip` for
 *   one request, `.restore-up-<id>/upload.zip` for pieces; on the volume when hosted, never in memory), at most
 *   RESTORE_MAX_BYTES, and only when the disk has room for the zip and its contents.
 * - The zip is checked (a zip, keyring.json and casefile.db present, every path inside the target) and extracted into
 *   `<staging>/case/`, every file checked against its size and CRC-32 (files/unzip.ts); keyring.json must read as a
 *   keyring.
 * - Then each extracted entry is renamed into the data folder (an existing empty folder of the same name is replaced,
 *   anything else stops the restore and what was moved goes back), keyring.json last, so the case only counts as
 *   set up once everything else is in place.
 * - The uploaded zip is kept among the server's backups under its own name (a free name: -2, -3, ... when taken),
 *   so the first backup on the server is the one it was restored from. Only when keeping it fails, or the restore was
 *   refused, is the staging copy removed: it is the server's temporary copy of a file the user still has. A staging
 *   folder left by an upload that stopped is removed when another upload starts, or when a new case is set up, and
 *   only while no upload is under way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { config } from '../config';
import { extractZip, listZipEntries, targetFor } from '../files/unzip';
import { readKeyring } from '../crypto/keyring';
import { log } from '../util/log';

/** The largest backup the browser restore takes. */
export const RESTORE_MAX_BYTES = 4 * 1024 ** 3;
/** The largest piece of an upload in pieces (the setup screen sends 16 MB). */
export const RESTORE_CHUNK_MAX_BYTES = 64 * 1024 ** 2;
/** An upload in pieces with no byte arriving for this long counts as stopped (another may then start). */
export const UPLOAD_IDLE_MS = 90_000;
/** Staging folders this module makes directly inside the data folder. */
export const RESTORE_STAGING_PREFIX = '.restore-';
/** The staging folder of an upload in pieces: this prefix and the upload's id. */
const PIECES_PREFIX = `${RESTORE_STAGING_PREFIX}up-`;
/** An upload id, chosen by the client (the setup screen derives it from the file, so a reload carries on). */
export const UPLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

export type RestoreErrorCode =
  | 'busy'
  | 'initialised'
  | 'not_empty'
  | 'too_large'
  | 'no_space'
  | 'empty_body'
  | 'not_zip'
  | 'not_backup'
  | 'damaged'
  | 'failed'
  | 'bad_request'
  | 'offset'
  | 'mismatch'
  | 'interrupted'
  | 'incomplete'
  | 'no_upload';

export class RestoreError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 500 | 507,
    readonly code: RestoreErrorCode,
    message: string,
    /** For an upload in pieces: the bytes the server holds, so the client carries on from there. */
    readonly received?: number,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreProgress {
  state: 'receiving' | 'checking' | 'extracting' | 'done' | 'failed';
  receivedBytes: number;
  totalBytes: number | null;
  files: number;
  totalFiles: number | null;
  error: string | null;
  at: string;
}

export interface RestoreResult {
  files: number;
  bytes: number;
  /** The kept zip's file name in the backups folder, or null when it could not be kept. */
  keptAs: string | null;
}

/** An upload in pieces: its staging folder and how far it got. */
interface PieceUpload {
  id: string;
  dir: string;
  zip: string;
  total: number;
  fileName: string | null;
  received: number;
  /** A piece is being written now. */
  appending: boolean;
  /** When the last byte arrived (ms). */
  lastAt: number;
  /** The last tenth of the way logged. */
  loggedTenth: number;
}

let progress: RestoreProgress | null = null;
/** Checking, unpacking and placing (or a one-request upload) is under way. */
let busy = false;
/** The upload in pieces this server last took a piece of (null after a finish, or when none since the start). */
let pieces: PieceUpload | null = null;

function piecesActive(p: PieceUpload | null = pieces): boolean {
  return Boolean(p && (p.appending || Date.now() - p.lastAt < UPLOAD_IDLE_MS));
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024).toLocaleString('en-US')} MB`;

function stoppedWords(p: PieceUpload): string {
  return `The upload stopped at ${mb(p.received)} of ${mb(p.total)}. Nothing was restored. Choose the same file and restore again to carry on from there.`;
}

/** The current or last restore (null when none ran since the server started). */
export function restoreProgress(): RestoreProgress | null {
  if (!progress) return null;
  // An upload in pieces whose sender went away (a closed tab) is not running any more: say where it stopped.
  if (progress.state === 'receiving' && !busy && pieces && !piecesActive()) return { ...progress, state: 'failed', error: stoppedWords(pieces) };
  return { ...progress };
}

/** True while a restore runs: checking or unpacking, a one-request upload, or an upload in pieces still arriving. */
export function restoreBusy(): boolean {
  return busy || piecesActive();
}

function setProgress(patch: Partial<RestoreProgress>): void {
  progress = { ...(progress ?? { state: 'receiving', receivedBytes: 0, totalBytes: null, files: 0, totalFiles: null, error: null, at: '' }), ...patch, at: new Date().toISOString() };
}

/**
 * Files (and links) below `dir` that make it non-empty, at most `limit`, relative with forward slashes. Empty folders
 * do not count, nor do this module's own staging folders at the top.
 */
export function dataDirContents(dir: string, limit = 5): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, top: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (top && e.isDirectory() && e.name.startsWith(RESTORE_STAGING_PREFIX)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r, false);
      else out.push(r);
    }
  };
  walk(dir, '', true);
  return out;
}

/** Free bytes on the disk holding `dir` (null when the platform cannot say). */
function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function refuseNoSpace(dataDir: string, total: number): void {
  const free = freeBytes(dataDir);
  const need = total * 2 + 64 * 1024 * 1024;
  if (free !== null && free < need) {
    throw new RestoreError(507, 'no_space', `There is not enough room on the server's disk: ${mb(free)} free, about ${mb(need)} needed (the backup and its unpacked copy). Make the volume larger in Railway, then try again.`);
  }
}

function tooLarge(max: number): RestoreError {
  return new RestoreError(413, 'too_large', `The backup is larger than ${Math.round(max / 1024 ** 3)} GB.`);
}

/** A safe name for the kept copy: the uploaded name when it is a plain *.zip name, else restored-<stamp>.zip. */
export function keptName(given: string | null, now = new Date()): string {
  const base = path.basename((given ?? '').replace(/\\/g, '/')).trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._ -]{0,150}\.zip$/i.test(base) && !base.includes('..')) return base;
  const p = (n: number) => String(n).padStart(2, '0');
  return `restored-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}

/** Moves `src` to a free name in `dir` (never over an existing file); returns the name used. */
function keepZip(src: string, dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const stem = name.replace(/\.zip$/i, '');
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${stem}.zip` : `${stem}-${i}.zip`;
    const target = path.join(dir, candidate);
    if (fs.existsSync(target) || fs.existsSync(`${target}.partial`)) continue;
    try {
      // Same disk (the volume): a rename. Another disk: copy without overwriting, then the staging copy goes.
      fs.linkSync(src, target);
      fs.unlinkSync(src);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err;
      fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(src);
    }
    return candidate;
  }
  throw new Error('no free name for the kept backup');
}

/** Removes a staging folder this module made directly inside `dataDir`, and nothing else. */
function removeStaging(dataDir: string, staging: string | null): void {
  if (!staging) return;
  const resolved = path.resolve(staging);
  if (path.dirname(resolved) !== path.resolve(dataDir) || !path.basename(resolved).startsWith(RESTORE_STAGING_PREFIX)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    log.warn('restore', `could not remove the staging folder ${path.basename(resolved)}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

/**
 * Removes every staging folder in `dataDir` (left by a restore or an upload that stopped; with nothing under way they
 * hold nothing the case needs: a failed move that could not be undone leaves the data folder non-empty, and every
 * caller refuses a non-empty data folder before this). Returns how many went.
 */
function removeStaleStaging(dataDir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir).filter((n) => n.startsWith(RESTORE_STAGING_PREFIX));
  } catch {
    return 0;
  }
  for (const n of names) removeStaging(dataDir, path.join(dataDir, n));
  if (names.length) log.info('restore', `removed ${names.length} staging folder${names.length === 1 ? '' : 's'} left by an earlier restore that did not finish`);
  return names.length;
}

/**
 * For setup (POST /api/auth/setup), just before a new case is made in the empty data folder: the staging folders of
 * uploads that stopped go, so a partial backup does not sit on the volume for good. Nothing happens while a restore
 * or an upload is under way (setup refuses then anyway), nor when the data folder holds any file: a restore whose
 * move could not be undone leaves its entries there and its staging folder for a person to look at.
 */
export function removeLeftoverUploads(dataDir = config.dataDir): void {
  if (restoreBusy()) return;
  const dir = path.resolve(dataDir);
  if (dataDirContents(dir, 1).length) return;
  pieces = null;
  removeStaleStaging(dir);
}

/**
 * Moves every top-level entry of `from` into `to` (keyring.json last). A folder of the same name that exists and is
 * empty is replaced; anything else that exists stops the move, and the entries moved so far go back.
 */
function moveInto(from: string, to: string, state: { rollbackFailed: boolean }): void {
  const names = fs.readdirSync(from).sort((a, b) => (a === 'keyring.json' ? 1 : b === 'keyring.json' ? -1 : a.localeCompare(b)));
  const moved: Array<{ name: string; replacedEmptyDir: boolean }> = [];
  try {
    for (const name of names) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      let replacedEmptyDir = false;
      if (fs.existsSync(dst)) {
        const st = fs.lstatSync(dst);
        if (!st.isDirectory() || fs.readdirSync(dst).length > 0) throw new RestoreError(409, 'not_empty', `The data folder on the server already has ${name}, so nothing was restored.`);
        fs.rmdirSync(dst);
        replacedEmptyDir = true;
      }
      fs.renameSync(src, dst);
      moved.push({ name, replacedEmptyDir });
    }
  } catch (err) {
    for (const m of moved.reverse()) {
      try {
        fs.renameSync(path.join(to, m.name), path.join(from, m.name));
        if (m.replacedEmptyDir) fs.mkdirSync(path.join(to, m.name), { recursive: true });
      } catch (back) {
        state.rollbackFailed = true;
        log.error('restore', `could not put ${m.name} back after a failed restore: ${(back as NodeJS.ErrnoException).code ?? 'error'}`);
      }
    }
    throw err;
  }
}

export interface RestoreOptions {
  /** The upload's Content-Length, when given. */
  totalBytes: number | null;
  /** The uploaded file's name (kept for the copy among the backups). */
  fileName: string | null;
  /** True when a case exists (auth.ts isInitialized); checked before and after the upload. */
  isInitialized: () => boolean;
  dataDir?: string;
  backupsDir?: string;
  maxBytes?: number;
}

function refuseIfNotEmpty(dataDir: string, isInitialized: () => boolean): void {
  if (isInitialized()) throw new RestoreError(409, 'initialised', 'This server already holds a case, so nothing was restored. A backup can only be restored onto an empty server.');
  const found = dataDirContents(dataDir, 3);
  if (found.length) throw new RestoreError(409, 'not_empty', `The data folder on the server is not empty (it holds ${found.join(', ')}${found.length >= 3 ? ', ...' : ''}), so nothing was restored.`);
}

function busyError(): RestoreError {
  return new RestoreError(409, 'busy', 'A restore is already running.');
}

/** Streams `body` into a new file; refuses (413) past `max` bytes. */
async function receive(body: WebReadableStream<Uint8Array> | ReadableStream<Uint8Array>, file: string, max: number): Promise<number> {
  let received = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > max) {
        cb(tooLarge(max));
        return;
      }
      if (received - lastReport >= 1 << 20) {
        lastReport = received;
        setProgress({ receivedBytes: received });
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), counter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  setProgress({ receivedBytes: received });
  return received;
}

interface RunState {
  staging: string | null;
  moveState: { rollbackFailed: boolean };
  t0: number;
}

/**
 * One restore at a time: `work` runs with the busy flag held; whatever it throws comes out as a RestoreError with a
 * plain message, and its staging folder is removed afterwards (unless a move could not be undone: then everything
 * stays where it is for a person to look at).
 */
async function runRestore(dataDir: string, work: (run: RunState) => Promise<RestoreResult>): Promise<RestoreResult> {
  if (busy) throw busyError();
  busy = true;
  const run: RunState = { staging: null, moveState: { rollbackFailed: false }, t0: Date.now() };
  try {
    return await work(run);
  } catch (err) {
    let e = err instanceof RestoreError ? err : new RestoreError(500, 'failed', `The restore did not work: ${err instanceof Error ? err.message : String(err)}. Nothing was restored.`);
    if (run.moveState.rollbackFailed) {
      e = new RestoreError(500, 'failed', `The restore stopped part-way and could not be undone; what was unpacked is kept in ${run.staging ? path.basename(run.staging) : 'the staging folder'} inside the data folder. Nothing was deleted. Ask for help before trying again.`);
    }
    // A refusal before anything was received leaves no progress behind for the screen.
    if (progress && run.staging) setProgress({ state: 'failed', error: e.message });
    log.warn('restore', `refused (${e.code}) after ${Math.round((Date.now() - run.t0) / 1000)} s`);
    throw e;
  } finally {
    if (!run.moveState.rollbackFailed) removeStaging(dataDir, run.staging);
    busy = false;
  }
}

/** Checks the received zip, unpacks it, moves it into the data folder (keyring.json last) and keeps the zip. */
async function placeZip(run: RunState, zip: string, o: { fileName: string | null; isInitialized: () => boolean; dataDir: string; backupsDir: string }): Promise<RestoreResult> {
  const staging = run.staging!;
  setProgress({ state: 'checking' });
  let names: string[];
  try {
    names = listZipEntries(zip).map((e) => e.name);
  } catch {
    throw new RestoreError(400, 'not_zip', 'That file is not a zip file. Choose a backup made by CaseFile (a casefile-....zip file).');
  }
  if (!names.includes('keyring.json') || !names.includes('casefile.db')) throw new RestoreError(400, 'not_backup', 'That zip is not a CaseFile backup: it has no keyring.json and casefile.db at its top.');
  const caseDir = path.join(staging, 'case');
  for (const n of names) {
    try {
      targetFor(caseDir, n);
    } catch {
      throw new RestoreError(400, 'damaged', `The backup is damaged: it holds a path that leads outside its folder (${n.slice(0, 120)}). Nothing was restored.`);
    }
  }

  setProgress({ state: 'extracting', totalFiles: null });
  let extracted: { files: number; bytes: number };
  try {
    extracted = await extractZip(zip, caseDir, { onProgress: (d) => setProgress({ files: d.files, totalFiles: d.totalFiles }) });
  } catch (err) {
    throw new RestoreError(400, 'damaged', `The backup is damaged: ${err instanceof Error ? err.message : String(err)}. Nothing was restored.`);
  }
  try {
    readKeyring(caseDir);
  } catch (err) {
    throw new RestoreError(400, 'damaged', `The backup is damaged: its keyring.json cannot be read (${err instanceof Error ? err.message : String(err)}). Nothing was restored.`);
  }
  if (!fs.statSync(path.join(caseDir, 'casefile.db')).isFile()) throw new RestoreError(400, 'not_backup', 'That zip is not a CaseFile backup: casefile.db is not a file.');

  // Nothing may have arrived meanwhile (a setup from another tab); then the move, keyring.json last.
  refuseIfNotEmpty(o.dataDir, o.isInitialized);
  moveInto(caseDir, o.dataDir, run.moveState);

  let keptAs: string | null = null;
  try {
    keptAs = keepZip(zip, o.backupsDir, keptName(o.fileName));
  } catch (err) {
    log.warn('restore', `the uploaded zip could not be kept among the backups: ${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : 'error')}`);
  }
  setProgress({ state: 'done', files: extracted.files, totalFiles: extracted.files });
  log.info('restore', `restored ${extracted.files} files (${mb(extracted.bytes)}) in ${Math.round((Date.now() - run.t0) / 1000)} s; the case now waits for its passphrase${keptAs ? '; the zip is kept among the backups' : ''}`);
  return { files: extracted.files, bytes: extracted.bytes, keptAs };
}

/**
 * The whole restore in one request: checks, upload, extraction, the move into the data folder, the kept copy. Throws
 * RestoreError with a plain message (and its HTTP status) when anything is refused; the data folder is then as it was.
 */
export async function restoreFromUpload(body: WebReadableStream<Uint8Array> | ReadableStream<Uint8Array> | null, opts: RestoreOptions): Promise<RestoreResult> {
  if (busy) throw busyError();
  if (piecesActive()) throw new RestoreError(409, 'busy', 'A backup is being sent to the server in pieces; wait for it to finish, or stop it, then try again.');
  const dataDir = path.resolve(opts.dataDir ?? config.dataDir);
  const backupsDir = path.resolve(opts.backupsDir ?? config.backupsDir);
  const max = opts.maxBytes ?? RESTORE_MAX_BYTES;
  return runRestore(dataDir, async (run) => {
    fs.mkdirSync(dataDir, { recursive: true });
    refuseIfNotEmpty(dataDir, opts.isInitialized);
    removeStaleStaging(dataDir);
    pieces = null;
    if (opts.totalBytes !== null && opts.totalBytes > max) throw tooLarge(max);
    if (!body) throw new RestoreError(400, 'empty_body', 'No file was sent.');
    if (opts.totalBytes !== null) refuseNoSpace(dataDir, opts.totalBytes);
    setProgress({ state: 'receiving', receivedBytes: 0, totalBytes: opts.totalBytes, files: 0, totalFiles: null, error: null });
    log.info('restore', `receiving a backup (${opts.totalBytes === null ? 'size not given' : mb(opts.totalBytes)})`);
    run.staging = fs.mkdtempSync(path.join(dataDir, RESTORE_STAGING_PREFIX));
    const zip = path.join(run.staging, 'upload.zip');
    const received = await receive(body, zip, max);
    if (received === 0) throw new RestoreError(400, 'empty_body', 'No file was sent.');
    if (opts.totalBytes !== null && received !== opts.totalBytes) throw new RestoreError(400, 'damaged', `The upload stopped part-way (${mb(received)} of ${mb(opts.totalBytes)}). Nothing was restored; try again.`);
    return placeZip(run, zip, { fileName: opts.fileName, isInitialized: opts.isInitialized, dataDir, backupsDir });
  });
}

// ---------------------------------------------------------------------------
// The upload in pieces
// ---------------------------------------------------------------------------

export interface PieceOptions {
  /** The upload's id (UPLOAD_ID_RE), chosen by the client. */
  id: string;
  /** Where this piece starts in the backup: must be what the server already holds. */
  offset: number;
  /** The whole backup's size in bytes. */
  total: number;
  /** The uploaded file's name (kept for the copy among the backups). */
  fileName: string | null;
  isInitialized: () => boolean;
  dataDir?: string;
  maxBytes?: number;
  chunkMaxBytes?: number;
}

export interface PieceState {
  /** Bytes of the backup the server holds. */
  received: number;
  /** The backup's size, or null when the server holds none of it. */
  total: number | null;
}

function checkId(id: string): void {
  if (!UPLOAD_ID_RE.test(id)) throw new RestoreError(400, 'bad_request', 'The upload has no valid id. Reload the page and try again.');
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The upload with this id: the one in memory, else what a staging folder on disk holds (after a restart), else null. */
function findPieces(dataDir: string, id: string): PieceUpload | null {
  const dir = path.join(dataDir, `${PIECES_PREFIX}${id}`);
  if (pieces && pieces.id === id && pieces.dir === dir && fs.existsSync(pieces.zip)) {
    if (!pieces.appending) pieces.received = sizeOf(pieces.zip);
    return pieces;
  }
  let meta: { total?: unknown; fileName?: unknown };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'upload.json'), 'utf8')) as typeof meta;
  } catch {
    return null;
  }
  const zip = path.join(dir, 'upload.zip');
  if (typeof meta.total !== 'number' || !Number.isSafeInteger(meta.total) || meta.total <= 0 || !fs.existsSync(zip)) return null;
  const received = sizeOf(zip);
  return { id, dir, zip, total: meta.total, fileName: typeof meta.fileName === 'string' ? meta.fileName : null, received, appending: false, lastAt: 0, loggedTenth: Math.floor((received / meta.total) * 10) };
}

/** How much of upload `id` the server holds (GET /api/auth/restore/chunk). */
export function piecesState(o: { id: string; isInitialized: () => boolean; dataDir?: string }): PieceState {
  checkId(o.id);
  const dataDir = path.resolve(o.dataDir ?? config.dataDir);
  if (busy) throw busyError();
  refuseIfNotEmpty(dataDir, o.isInitialized);
  const p = findPieces(dataDir, o.id);
  return p ? { received: p.received, total: p.total } : { received: 0, total: null };
}

/**
 * One piece of an upload in pieces (POST /api/auth/restore/chunk): appended only when `offset` is what the server
 * already holds; otherwise a 409 says how much it holds (`received`). The first piece runs the checks of a restore in
 * one request, in the same order: a case already there, a data folder that is not empty, too large, no room.
 */
export async function receivePiece(body: WebReadableStream<Uint8Array> | ReadableStream<Uint8Array> | null, o: PieceOptions): Promise<PieceState> {
  checkId(o.id);
  if (!Number.isSafeInteger(o.offset) || o.offset < 0 || !Number.isSafeInteger(o.total) || o.total <= 0 || o.offset > o.total) {
    throw new RestoreError(400, 'bad_request', "The piece does not say where it goes or how large the backup is. Reload the page and try again.");
  }
  if (busy) throw busyError();
  const dataDir = path.resolve(o.dataDir ?? config.dataDir);
  const max = o.maxBytes ?? RESTORE_MAX_BYTES;
  const chunkMax = o.chunkMaxBytes ?? RESTORE_CHUNK_MAX_BYTES;
  fs.mkdirSync(dataDir, { recursive: true });
  refuseIfNotEmpty(dataDir, o.isInitialized);
  if (o.total > max) throw tooLarge(max);

  let p = findPieces(dataDir, o.id);
  if (!p) {
    if (pieces && pieces.id !== o.id && piecesActive()) {
      throw new RestoreError(409, 'busy', 'Another backup is being sent to the server; wait for it to finish, or stop it, then try again.');
    }
    if (o.offset !== 0) throw new RestoreError(409, 'offset', 'The server holds none of this backup yet; it starts again from the beginning.', 0);
    removeStaleStaging(dataDir);
    refuseNoSpace(dataDir, o.total);
    const dir = path.join(dataDir, `${PIECES_PREFIX}${o.id}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const fileName = o.fileName ? o.fileName.slice(0, 200) : null;
    fs.writeFileSync(path.join(dir, 'upload.json'), JSON.stringify({ total: o.total, fileName, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    const zip = path.join(dir, 'upload.zip');
    fs.closeSync(fs.openSync(zip, 'wx', 0o600));
    p = { id: o.id, dir, zip, total: o.total, fileName, received: 0, appending: false, lastAt: Date.now(), loggedTenth: 0 };
    setProgress({ state: 'receiving', receivedBytes: 0, totalBytes: o.total, files: 0, totalFiles: null, error: null });
    log.info('restore', `receiving a backup in pieces (${mb(o.total)})`);
  } else if (p.total !== o.total) {
    throw new RestoreError(409, 'mismatch', 'The server holds part of a different backup under this id. Choose the file again.', p.received);
  } else if (p.appending) {
    throw new RestoreError(409, 'busy', 'The server is still taking the previous piece.', p.received);
  } else if (pieces !== p && pieces && piecesActive()) {
    throw new RestoreError(409, 'busy', 'Another backup is being sent to the server; wait for it to finish, or stop it, then try again.');
  }
  if (o.offset !== p.received) throw new RestoreError(409, 'offset', `The server holds ${mb(p.received)} of this backup; the upload carries on from there.`, p.received);
  if (!body) throw new RestoreError(400, 'empty_body', 'No file was sent.', p.received);

  const up = p;
  pieces = up;
  up.appending = true;
  up.lastAt = Date.now();
  if (up.received > 0 && progress?.state !== 'receiving') setProgress({ state: 'receiving', receivedBytes: up.received, totalBytes: up.total, files: 0, totalFiles: null, error: null });
  const start = up.received;
  let n = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > chunkMax) return cb(new RestoreError(413, 'too_large', `A piece of the upload is larger than ${mb(chunkMax)}.`));
      if (start + n > up.total) return cb(new RestoreError(400, 'bad_request', 'More was sent than the size of the backup. Choose the file again.'));
      up.lastAt = Date.now();
      if (n - lastReport >= 1 << 20) {
        lastReport = n;
        setProgress({ receivedBytes: start + n });
      }
      cb(null, chunk);
    },
  });
  let failure: unknown = null;
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), counter, fs.createWriteStream(up.zip, { flags: 'a' }));
    // Each piece is on the disk before the server says it has it, so a restart carries on from what it said.
    const fd = fs.openSync(up.zip, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    failure = err;
  } finally {
    up.received = sizeOf(up.zip);
    up.appending = false;
    up.lastAt = Date.now();
  }
  if (failure) {
    if (failure instanceof RestoreError) throw new RestoreError(failure.status, failure.code, failure.message, up.received);
    setProgress({ state: 'failed', receivedBytes: up.received, error: stoppedWords(up) });
    log.warn('restore', `a piece stopped part-way: ${mb(up.received)} of ${mb(up.total)} kept; the upload can carry on from there`);
    throw new RestoreError(400, 'interrupted', 'The piece stopped part-way; the upload carries on from what arrived.', up.received);
  }
  setProgress({ state: 'receiving', receivedBytes: up.received, totalBytes: up.total, error: null });
  const tenth = Math.floor((up.received / up.total) * 10);
  if (tenth > up.loggedTenth) {
    up.loggedTenth = tenth;
    log.info('restore', `received ${tenth * 10}% (${mb(up.received)} of ${mb(up.total)})`);
  }
  return { received: up.received, total: up.total };
}

/**
 * The end of an upload in pieces (POST /api/auth/restore/finish): once every byte is there, the checks, the
 * extraction, the move and the kept copy, as for a restore in one request.
 */
export async function finishPieces(o: { id: string; isInitialized: () => boolean; dataDir?: string; backupsDir?: string }): Promise<RestoreResult> {
  checkId(o.id);
  if (busy) throw busyError();
  const dataDir = path.resolve(o.dataDir ?? config.dataDir);
  const backupsDir = path.resolve(o.backupsDir ?? config.backupsDir);
  const p = findPieces(dataDir, o.id);
  if (!p) throw new RestoreError(404, 'no_upload', 'The server holds none of this backup. Send it again.');
  if (p.appending) throw new RestoreError(409, 'busy', 'The server is still taking the last piece.', p.received);
  if (p.received !== p.total) throw new RestoreError(409, 'incomplete', `The server holds ${mb(p.received)} of ${mb(p.total)}; the rest has to be sent first.`, p.received);
  return runRestore(dataDir, async (run) => {
    run.staging = p.dir;
    pieces = null;
    refuseIfNotEmpty(dataDir, o.isInitialized);
    setProgress({ state: 'checking', receivedBytes: p.total, totalBytes: p.total, files: 0, totalFiles: null, error: null });
    log.info('restore', `all ${mb(p.total)} received; checking and unpacking`);
    return placeZip(run, p.zip, { fileName: p.fileName, isInitialized: o.isInitialized, dataDir, backupsDir });
  });
}
