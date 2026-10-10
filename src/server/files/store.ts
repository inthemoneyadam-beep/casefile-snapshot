/**
 * Encrypted local file store. Keys look like "ab/ab12…-uuid.pdf.cfe". The
 * key for the store is set on unlock and cleared on lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { encryptBuffer, decryptBuffer } from '../crypto/filecrypt';
import { LockedError } from '../db';

let fileKey: Buffer | null = null;

export function setFileKey(key: Buffer | null): void {
  if (fileKey) fileKey.fill(0);
  fileKey = key;
}

function key(): Buffer {
  if (!fileKey) throw new LockedError();
  return fileKey;
}

export function storagePath(storageKey: string): string {
  return path.join(config.filesDir, storageKey);
}

export function putFile(plain: Buffer, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  const id = randomUUID();
  const shard = id.slice(0, 2);
  const storageKey = path.posix.join(shard, `${id}${ext}.cfe`);
  const full = storagePath(storageKey);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, encryptBuffer(key(), plain));
  fs.renameSync(tmp, full);
  return storageKey;
}

export function getFile(storageKey: string): Buffer {
  const data = fs.readFileSync(storagePath(storageKey));
  return decryptBuffer(key(), data);
}

export function fileExists(storageKey: string): boolean {
  return fs.existsSync(storagePath(storageKey));
}

export function deleteFile(storageKey: string): void {
  try {
    fs.unlinkSync(storagePath(storageKey));
  } catch {
    // already gone
  }
}
