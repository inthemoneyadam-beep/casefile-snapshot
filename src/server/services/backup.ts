/**
 * Backup = a consistent snapshot of the encrypted database, plus keyring.json
 * and files/, zipped into backups/casefile-YYYYMMDD-HHMMSS.zip. Everything in
 * the zip is still encrypted; the passphrase is needed to restore.
 *
 * Consistency. The job worker and the API keep committing while a zip is
 * built, and SQLite's checkpoints (automatic every ~1000 WAL pages, or a
 * second backup's) rewrite pages of casefile.db in place. Streaming the live
 * file would capture pages from different moments: a torn copy that fails
 * integrity_check on restore, silently. So the snapshot is taken in one
 * synchronous block: wal_checkpoint(TRUNCATE), then copy casefile.db (and
 * the WAL only when the checkpoint could not empty it) into a private
 * staging folder, and read keyring.json. better-sqlite3 runs on this thread
 * and this process holds the only connection, so no commit and no
 * checkpoint can land in between. The zip is built from the staged copy,
 * which is removed afterwards. casefile.db-shm is never archived (SQLite
 * rebuilds it on open).
 *
 * `npm run backup` while the app has the case unlocked cannot checkpoint
 * (it has no key): it copies the files as quickly as it can and warns that
 * Back up now in Settings is the consistent way.
 *
 * Nothing under backups/ is ever overwritten or deleted. A name that exists
 * gets -2, -3, ...; the archive is written to <name>.partial (created
 * exclusively) and renamed to <name> only once it is complete; a failed run
 * leaves its .partial where it is and rejects. Backups run one at a time.
 *
 * Never use the SQLite online-backup API or VACUUM INTO here: they would
 * write a plaintext copy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { config } from '../config';
import { checkpoint, isDbOpen, type CheckpointResult } from '../db';

export interface BackupResult {
  path: string;
  bytes: number;
  /** Anything the user should know about this copy (empty when it is clean). */
  warnings: string[];
}

export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `casefile-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}

/** Start of the page SQLite never uses; on Windows its first 512 bytes carry byte-range locks. */
const LOCK_BYTE = 0x40000000;
const LOCK_SPAN = 512;

function touchesLockBytes(pos: number, len: number): boolean {
  return pos < LOCK_BYTE + LOCK_SPAN && pos + len > LOCK_BYTE;
}

/**
 * Synchronous copy through a shared-mode handle (the open connection keeps
 * casefile.db open). A read that fails only because it touches SQLite's lock
 * bytes (databases over 1 GiB on Windows) is retried in 512-byte blocks and
 * the locked block is written as zeros; SQLite never reads that page.
 */
function copyFileShared(src: string, dst: string): void {
  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK);
  const inFd = fs.openSync(src, 'r');
  let outFd: number | null = null;
  try {
    outFd = fs.openSync(dst, 'wx', 0o600);
    const size = fs.fstatSync(inFd).size;
    for (let pos = 0; pos < size; pos += CHUNK) {
      const len = Math.min(CHUNK, size - pos);
      try {
        const n = fs.readSync(inFd, buf, 0, len, pos);
        fs.writeSync(outFd, buf, 0, n, pos);
        if (n < len) break;
      } catch (err) {
        if (!touchesLockBytes(pos, len)) throw err;
        for (let p = pos; p < pos + len; p += LOCK_SPAN) {
          const l = Math.min(LOCK_SPAN, pos + len - p);
          try {
            fs.readSync(inFd, buf, 0, l, p);
          } catch (inner) {
            if (!touchesLockBytes(p, l)) throw inner;
            buf.fill(0, 0, l);
          }
          fs.writeSync(outFd, buf, 0, l, p);
        }
      }
    }
  } finally {
    fs.closeSync(inFd);
    if (outFd !== null) fs.closeSync(outFd);
  }
}

type SnapshotEntry = { name: string; file: string } | { name: string; data: Buffer };

interface Snapshot {
  stagingDir: string | null;
  entries: SnapshotEntry[];
  meta: { database: 'checkpointed' | 'with-wal' | 'copied-while-open-elsewhere' | 'copied-closed' | 'none'; checkpoint: CheckpointResult | null };
  warnings: string[];
}

/** Removes only a staging folder this module created directly under the OS temp folder. */
function removeStaging(dir: string | null): void {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('casefile-backup-')) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    console.error('[backup] could not remove the staging folder', resolved, err instanceof Error ? err.message : err);
  }
}

function takeSnapshot(): Snapshot {
  const dbFile = path.join(config.dataDir, 'casefile.db');
  const walFile = `${dbFile}-wal`;
  const shmFile = `${dbFile}-shm`;
  const keyringFile = path.join(config.dataDir, 'keyring.json');
  const entries: SnapshotEntry[] = [];
  const warnings: string[] = [];
  let stagingDir: string | null = null;
  let walCopied = false;
  // ---- One synchronous block: no await and no callback until the copies are done.
  const own = isDbOpen();
  const openElsewhere = !own && (fs.existsSync(walFile) || fs.existsSync(shmFile));
  const ck = own ? checkpoint() : null;
  const keyring = fs.existsSync(keyringFile) ? fs.readFileSync(keyringFile) : null;
  try {
    if (fs.existsSync(dbFile)) {
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'casefile-backup-'));
      copyFileShared(dbFile, path.join(stagingDir, 'casefile.db'));
      entries.push({ name: 'casefile.db', file: path.join(stagingDir, 'casefile.db') });
      if (fs.existsSync(walFile) && fs.statSync(walFile).size > 0) {
        copyFileShared(walFile, path.join(stagingDir, 'casefile.db-wal'));
        entries.push({ name: 'casefile.db-wal', file: path.join(stagingDir, 'casefile.db-wal') });
        walCopied = true;
      }
    }
  } catch (err) {
    removeStaging(stagingDir);
    throw err;
  }
  // ---- End of the snapshot.
  if (keyring) entries.unshift({ name: 'keyring.json', data: keyring });
  else warnings.push('keyring.json was not found: this backup cannot be unlocked on its own.');
  let database: Snapshot['meta']['database'] = 'none';
  if (stagingDir) {
    if (own) database = walCopied ? 'with-wal' : 'checkpointed';
    else database = openElsewhere ? 'copied-while-open-elsewhere' : 'copied-closed';
  }
  if (openElsewhere) {
    warnings.push(
      'The database was open in another process (the app is probably running and unlocked), so it was copied without a checkpoint and may be inconsistent if the app wrote during the copy. For a guaranteed-consistent backup use Back up now in Settings, or lock the app first.',
    );
  }
  return { stagingDir, entries, meta: { database, checkpoint: ck }, warnings };
}

/** A name nobody has: <stamp>.zip, else <stamp>-2.zip, ...; its .partial is created exclusively. */
function reserveArchive(destDir: string, now: Date): { out: string; partial: string; fd: number } {
  const base = backupFileName(now).replace(/\.zip$/, '');
  for (let i = 1; i < 1000; i++) {
    const out = path.join(destDir, i === 1 ? `${base}.zip` : `${base}-${i}.zip`);
    const partial = `${out}.partial`;
    if (fs.existsSync(out) || fs.existsSync(partial)) continue;
    try {
      return { out, partial, fd: fs.openSync(partial, 'wx', 0o600) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`no free backup name for ${base} in ${destDir}`);
}

async function runBackup(destDir: string): Promise<BackupResult> {
  const now = new Date();
  const snap = takeSnapshot();
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const target = reserveArchive(destDir, now);
    const warnings = [...snap.warnings];
    try {
      const output = fs.createWriteStream(target.partial, { fd: target.fd });
      const zip = archiver('zip', { zlib: { level: 6 } });
      zip.on('warning', (err: Error & { code?: string }) => {
        // A file in files/ that vanished mid-walk (a purge); anything else is an error.
        if (err.code === 'ENOENT') warnings.push(`skipped a file that disappeared during the backup: ${err.message}`);
        else zip.emit('error', err);
      });
      const written = pipeline(zip, output);
      for (const e of snap.entries) {
        if ('file' in e) zip.file(e.file, { name: e.name });
        else zip.append(e.data, { name: e.name });
      }
      if (fs.existsSync(config.filesDir)) zip.directory(config.filesDir, 'files');
      zip.append(JSON.stringify({ createdAt: now.toISOString(), app: 'casefile', version: 1, ...snap.meta, warnings }, null, 2), { name: 'backup.json' });
      await Promise.all([zip.finalize(), written]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`backup failed: ${msg}. The incomplete archive was left at ${target.partial}; no earlier backup was touched.`);
    }
    if (fs.existsSync(target.out)) throw new Error(`backup finished but ${target.out} appeared meanwhile; the archive was left at ${target.partial}`);
    fs.renameSync(target.partial, target.out);
    return { path: target.out, bytes: fs.statSync(target.out).size, warnings };
  } finally {
    removeStaging(snap.stagingDir);
  }
}

let tail: Promise<unknown> | null = null;

/**
 * Create a backup zip. Calls run one after another; when none is running
 * the snapshot is taken synchronously inside this call, so nothing written
 * after it returns is in the archive.
 */
export function createBackupZip(destDir = config.backupsDir): Promise<BackupResult> {
  const run = tail ? tail.then(() => runBackup(destDir)) : runBackup(destDir);
  const settled: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  );
  tail = settled;
  void settled.then(() => {
    if (tail === settled) tail = null;
  });
  return run;
}

// ---------------------------------------------------------------------------
// The backups folder as Settings > Backups shows it (owner only; routes/system.ts)
// ---------------------------------------------------------------------------

export interface BackupListItem {
  /** The file name, e.g. casefile-20261008-141500.zip. */
  name: string;
  bytes: number;
  /** When the file was last written (ISO). */
  createdAt: string;
}

/** A backup's file name as the list gives it: a plain *.zip name, no folder, no way out. */
export function isBackupName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}\.zip$/i.test(name) && !name.includes('..') && path.basename(name) === name;
}

/** The finished backups (no .partial) directly in the backups folder, newest first. */
export function listBackups(dir = config.backupsDir): BackupListItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: BackupListItem[] = [];
  for (const name of names) {
    if (!isBackupName(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ name, bytes: st.size, createdAt: st.mtime.toISOString() });
    } catch {
      // gone meanwhile
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** The path of one listed backup, or null when the name is not a backup in the folder. */
export function backupFilePath(name: string, dir = config.backupsDir): string | null {
  if (!isBackupName(name)) return null;
  const file = path.join(dir, name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}
