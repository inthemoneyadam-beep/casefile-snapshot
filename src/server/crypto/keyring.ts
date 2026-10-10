/**
 * Passphrase -> data key.
 *
 * A random 32-byte data encryption key (DEK) is generated once and wrapped
 * with a key derived from a passphrase (scrypt). Keyring version 2 keeps one
 * wrap per user in `users`: every user's passphrase unwraps the same DEK, so
 * adding, removing or resetting a user never touches the database or the
 * file store (their keys are derived from the DEK with HKDF and never change).
 *
 * Version 1 files hold a single top-level `kdf` + `wrap`. They are still
 * readable; on the first unlock the server moves that wrap into `users[0]`
 * as the owner's entry (`migrateLegacyKeyring`).
 *
 * Every rewrite is atomic (temp file + rename). Rewrites that take no wrap
 * away (migration, adding a person, renaming) first copy the current file
 * into data/keyring-backups/, because the keyring is the only way back into
 * the data. A reset, a passphrase change or a removal never copies, and
 * afterwards scrubKeyringBackups takes every superseded wrap out of the
 * older copies: keyring-backups/ is inside the keyring's trust boundary, so
 * a removed or replaced passphrase must not open anything there either.
 *
 * What this does not do: the DEK is never rotated, so anyone who already
 * extracted it keeps access until the data is re-keyed, and full backups
 * (backups/*.zip) keep the keyring.json of the day they were made, old
 * wraps included.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface KeyringKdf {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
}

export interface KeyringWrap {
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
}

export interface KeyringUser {
  userId: string;
  name: string;
  kdf: KeyringKdf;
  wrap: KeyringWrap;
  createdAt: string;
  updatedAt: string;
}

export interface KeyringFile {
  version: 1 | 2;
  /** Version 1 only: the single wrap. Absent once migrated. */
  kdf?: KeyringKdf;
  wrap?: KeyringWrap;
  /** Version 2: one wrap per user, the owner first. */
  users?: KeyringUser[];
  createdAt: string;
  updatedAt: string;
  /** Only on a copy in keyring-backups/ whose every wrap was superseded and taken out. */
  scrubbedAt?: string;
}

export interface UnlockResult {
  dek: Buffer;
  /** Null when the file is still version 1 (no user entries yet). */
  userId: string | null;
  name: string | null;
  legacy: boolean;
}

const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

/** The owner's name when none is given (the seed, the old `{ passphrase }` setup body). */
export const DEFAULT_OWNER_NAME = 'Owner';

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}

function deriveKek(passphrase: string, salt: Buffer, params = SCRYPT): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
}

function wrap(dek: Buffer, kek: Buffer): KeyringWrap {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return { alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function unwrap(w: KeyringWrap, kek: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(w.iv, 'base64'));
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]);
  } catch {
    throw new WrongPassphraseError();
  }
}

/** Wrap the DEK under a fresh salt for one passphrase. */
function makeEntry(dek: Buffer, passphrase: string, userId: string, name: string, createdAt?: string): KeyringUser {
  const salt = randomBytes(32);
  const kek = deriveKek(passphrase, salt);
  try {
    const now = new Date().toISOString();
    return { userId, name, kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') }, wrap: wrap(dek, kek), createdAt: createdAt ?? now, updatedAt: now };
  } finally {
    kek.fill(0);
  }
}

function tryUnwrap(entry: { kdf: KeyringKdf; wrap: KeyringWrap }, passphrase: string): Buffer | null {
  const kek = deriveKek(passphrase, Buffer.from(entry.kdf.salt, 'base64'), entry.kdf);
  try {
    return unwrap(entry.wrap, kek);
  } catch (err) {
    if (err instanceof WrongPassphraseError) return null;
    throw err;
  } finally {
    kek.fill(0);
  }
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('passphrase must be at least 8 characters');
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

export function keyringPath(dataDir: string): string {
  return path.join(dataDir, 'keyring.json');
}

export function keyringExists(dataDir: string): boolean {
  return fs.existsSync(keyringPath(dataDir));
}

export function readKeyring(dataDir: string): KeyringFile {
  const file = JSON.parse(fs.readFileSync(keyringPath(dataDir), 'utf8')) as KeyringFile;
  if (file.version !== 1 && file.version !== 2) throw new Error(`unsupported keyring version ${String((file as { version?: unknown }).version)}`);
  if (file.version === 2 && (!Array.isArray(file.users) || file.users.length === 0)) throw new Error('keyring has no users');
  if (file.version === 1 && (!file.kdf || !file.wrap)) throw new Error('keyring is missing its wrap');
  return file;
}

export function keyringBackupsDir(dataDir: string): string {
  return path.join(dataDir, 'keyring-backups');
}

/** Write JSON to a temp file (mode 0600) and rename it over the target, so a torn write never replaces the file. */
function writeJsonAtomic(target: string, data: unknown): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** keyring-<stamp>.json, with a counter when two rewrites land in the same millisecond. */
function newBackupPath(dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let p = path.join(dir, `keyring-${stamp}.json`);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `keyring-${stamp}-${i}.json`);
  return p;
}

/**
 * Atomic rewrite of keyring.json. With `keepBackup` the current file is
 * first copied into keyring-backups/ (mode 0600). Only rewrites that take no
 * wrap away keep a copy: a copy made before a reset or a removal would keep
 * the very wrap the reset or removal is meant to retire, and the temp file +
 * rename already protects against a torn write.
 */
function writeKeyring(dataDir: string, file: KeyringFile, opts: { keepBackup: boolean }): void {
  const target = keyringPath(dataDir);
  if (opts.keepBackup && fs.existsSync(target)) {
    const dir = keyringBackupsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(newBackupPath(dir), fs.readFileSync(target), { mode: 0o600, flag: 'wx' });
  }
  file.updatedAt = new Date().toISOString();
  writeJsonAtomic(target, file);
}

export interface BackupScrubResult {
  /** Copies read in keyring-backups/. */
  scanned: number;
  /** File names rewritten without a superseded wrap. */
  rewritten: string[];
  /** File names that could not be read or rewritten (left as they were). */
  failed: string[];
}

function wrapKey(e: { kdf: KeyringKdf; wrap: KeyringWrap }): string {
  return `${e.kdf.salt}|${e.wrap.ct}`;
}

/**
 * The copy without superseded wraps, or null when nothing in it is
 * superseded. A person's entry stays when it is exactly their live wrap, is
 * replaced by the live wrap after a reset or change, and is dropped when the
 * person has no live entry (removed). A version 1 copy whose single wrap is
 * no live wrap any more keeps no wrap at all.
 */
function scrubbedCopy(file: KeyringFile, live: Map<string, KeyringUser>, liveWraps: Set<string>): KeyringFile | null {
  const now = new Date().toISOString();
  const stub = (): KeyringFile => ({ version: 2, users: [], createdAt: file.createdAt, updatedAt: now, scrubbedAt: now });
  if (file.version === 1) {
    if (!file.kdf || !file.wrap || liveWraps.has(wrapKey({ kdf: file.kdf, wrap: file.wrap }))) return null;
    return stub();
  }
  if (!Array.isArray(file.users)) return null;
  let changed = false;
  const users: KeyringUser[] = [];
  for (const u of file.users) {
    if (!u || !u.kdf || !u.wrap) continue;
    const current = live.get(u.userId);
    if (current && wrapKey(current) === wrapKey(u)) {
      users.push(u);
      continue;
    }
    changed = true;
    if (current) users.push({ ...current });
  }
  if (!changed) return null;
  return users.length ? { ...file, users, updatedAt: now } : stub();
}

/**
 * Take every superseded wrap out of data/keyring-backups/ (called after a
 * reset, a passphrase change and a removal). Only copies of this keyring
 * (same createdAt) are touched; each is rewritten atomically, never deleted,
 * and a copy left without any wrap stays as a stub carrying `scrubbedAt`.
 * Never throws: a copy that cannot be read or written is listed in `failed`.
 */
export function scrubKeyringBackups(dataDir: string): BackupScrubResult {
  const result: BackupScrubResult = { scanned: 0, rewritten: [], failed: [] };
  const dir = keyringBackupsDir(dataDir);
  let names: string[];
  let live: KeyringFile;
  try {
    if (!fs.existsSync(dir)) return result;
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    live = readKeyring(dataDir);
  } catch (err) {
    console.error('[keyring] could not scan keyring-backups', err instanceof Error ? err.message : err);
    result.failed.push('keyring-backups');
    return result;
  }
  if (live.version !== 2 || !live.users?.length) return result;
  const liveById = new Map(live.users.map((u) => [u.userId, u]));
  const liveWraps = new Set(live.users.map(wrapKey));
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const file = JSON.parse(fs.readFileSync(p, 'utf8')) as KeyringFile;
      if (!file || typeof file !== 'object') continue;
      result.scanned++;
      if (file.createdAt !== live.createdAt) continue;
      const next = scrubbedCopy(file, liveById, liveWraps);
      if (!next) continue;
      writeJsonAtomic(p, next);
      result.rewritten.push(name);
    } catch (err) {
      console.error(`[keyring] could not scrub keyring-backups/${name}`, err instanceof Error ? err.message : err);
      result.failed.push(name);
    }
  }
  return result;
}

/** Names visible on the lock screen. Empty for a version 1 file. */
export function listKeyringUsers(dataDir: string): Array<{ userId: string; name: string }> {
  if (!keyringExists(dataDir)) return [];
  try {
    const file = readKeyring(dataDir);
    return (file.users ?? []).map((u) => ({ userId: u.userId, name: u.name }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Create, unlock, migrate
// ---------------------------------------------------------------------------

/**
 * Create a version 2 keyring with one owner entry and return the DEK. The
 * owner's userId defaults to a fresh UUID (the server creates the matching
 * users row on first unlock).
 */
export function createKeyring(dataDir: string, passphrase: string, owner: { userId?: string; name?: string } = {}): Buffer {
  if (keyringExists(dataDir)) throw new Error('keyring already exists');
  assertPassphrase(passphrase);
  fs.mkdirSync(dataDir, { recursive: true });
  const dek = randomBytes(32);
  const now = new Date().toISOString();
  const file: KeyringFile = {
    version: 2,
    users: [makeEntry(dek, passphrase, owner.userId ?? randomUUID(), owner.name?.trim() || DEFAULT_OWNER_NAME)],
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(keyringPath(dataDir), JSON.stringify(file, null, 2), { mode: 0o600 });
  return dek;
}

/**
 * Unlock as a named user, or try every entry when `userId` is omitted (the
 * single-user lock screen, the seed script). Throws WrongPassphraseError when
 * nothing unwraps.
 */
export function unlockKeyringAs(dataDir: string, passphrase: string, userId?: string | null): UnlockResult {
  const file = readKeyring(dataDir);
  if (file.version === 1) {
    const dek = tryUnwrap({ kdf: file.kdf!, wrap: file.wrap! }, passphrase);
    if (!dek) throw new WrongPassphraseError();
    return { dek, userId: null, name: null, legacy: true };
  }
  const candidates = userId ? file.users!.filter((u) => u.userId === userId) : file.users!;
  if (!candidates.length) throw new WrongPassphraseError();
  for (const u of candidates) {
    const dek = tryUnwrap(u, passphrase);
    if (dek) return { dek, userId: u.userId, name: u.name, legacy: false };
  }
  throw new WrongPassphraseError();
}

/** DEK only; kept for callers that do not care who unlocked (seed, tests). */
export function unlockKeyring(dataDir: string, passphrase: string, userId?: string | null): Buffer {
  return unlockKeyringAs(dataDir, passphrase, userId).dek;
}

/**
 * Move a version 1 wrap into `users[0]` as the owner's entry. No passphrase
 * is needed: the salt and ciphertext are kept as they are. Idempotent.
 */
export function migrateLegacyKeyring(dataDir: string, owner: { userId: string; name: string }): boolean {
  const file = readKeyring(dataDir);
  if (file.version !== 1) return false;
  const now = new Date().toISOString();
  const next: KeyringFile = {
    version: 2,
    users: [{ userId: owner.userId, name: owner.name, kdf: file.kdf!, wrap: file.wrap!, createdAt: file.createdAt, updatedAt: now }],
    createdAt: file.createdAt,
    updatedAt: now,
  };
  // The wrap is unchanged (only the file shape changes), so the copy retires nothing.
  writeKeyring(dataDir, next, { keepBackup: true });
  return true;
}

// ---------------------------------------------------------------------------
// User entries (all need the DEK, which the server holds while unlocked)
// ---------------------------------------------------------------------------

function requireV2(dataDir: string): KeyringFile & { users: KeyringUser[] } {
  const file = readKeyring(dataDir);
  if (file.version !== 2) throw new Error('keyring has not been migrated to version 2 yet (unlock once first)');
  return file as KeyringFile & { users: KeyringUser[] };
}

export function addKeyringUser(dataDir: string, dek: Buffer, user: { userId: string; name: string }, passphrase: string): void {
  assertPassphrase(passphrase);
  const file = requireV2(dataDir);
  if (file.users.some((u) => u.userId === user.userId)) throw new Error('user already has a passphrase');
  file.users.push(makeEntry(dek, passphrase, user.userId, user.name));
  writeKeyring(dataDir, file, { keepBackup: true });
}

/**
 * Replace a user's wrap (owner reset, or the user's own change after
 * verification). No copy of the old file is kept, and older copies in
 * keyring-backups/ are scrubbed of the replaced wrap afterwards.
 */
export function setKeyringUserPassphrase(dataDir: string, dek: Buffer, userId: string, passphrase: string): BackupScrubResult {
  assertPassphrase(passphrase);
  const file = requireV2(dataDir);
  const i = file.users.findIndex((u) => u.userId === userId);
  if (i < 0) throw new Error('user has no keyring entry');
  const old = file.users[i];
  file.users[i] = makeEntry(dek, passphrase, old.userId, old.name, old.createdAt);
  writeKeyring(dataDir, file, { keepBackup: false });
  return scrubKeyringBackups(dataDir);
}

export function renameKeyringUser(dataDir: string, userId: string, name: string): void {
  const file = requireV2(dataDir);
  const u = file.users.find((x) => x.userId === userId);
  if (!u) return;
  u.name = name;
  u.updatedAt = new Date().toISOString();
  writeKeyring(dataDir, file, { keepBackup: true });
}

/**
 * Remove a user's wrap. The data is untouched; the last entry can never be
 * removed. No copy of the old file is kept, and older copies in
 * keyring-backups/ are scrubbed of the person's wraps afterwards (also when
 * the live file had no entry for them any more).
 */
export function removeKeyringUser(dataDir: string, userId: string): boolean {
  const file = requireV2(dataDir);
  const before = file.users.length;
  const rest = file.users.filter((u) => u.userId !== userId);
  if (rest.length === before) {
    scrubKeyringBackups(dataDir);
    return false;
  }
  if (rest.length === 0) throw new Error('cannot remove the last passphrase');
  file.users = rest;
  writeKeyring(dataDir, file, { keepBackup: false });
  scrubKeyringBackups(dataDir);
  return true;
}

export function hasKeyringEntry(dataDir: string, userId: string): boolean {
  return listKeyringUsers(dataDir).some((u) => u.userId === userId);
}

/**
 * Change a passphrase after proving the old one. With `userId` the check is
 * limited to that entry (the caller's own); without it, whichever entry the
 * old passphrase opens is re-wrapped (version 1 files are migrated first
 * under a generated owner id).
 */
export function changePassphrase(dataDir: string, oldPassphrase: string, newPassphrase: string, userId?: string | null): void {
  assertPassphrase(newPassphrase);
  const r = unlockKeyringAs(dataDir, oldPassphrase, userId);
  try {
    let id = r.userId;
    if (r.legacy) {
      id = randomUUID();
      migrateLegacyKeyring(dataDir, { userId: id, name: DEFAULT_OWNER_NAME });
    }
    setKeyringUserPassphrase(dataDir, r.dek, id!, newPassphrase);
  } finally {
    r.dek.fill(0);
  }
}

/** Derive a purpose-specific 32-byte subkey from the DEK. */
export function deriveSubkey(dek: Buffer, info: 'casefile/db' | 'casefile/files' | 'casefile/session'): Buffer {
  return Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), info, 32));
}
