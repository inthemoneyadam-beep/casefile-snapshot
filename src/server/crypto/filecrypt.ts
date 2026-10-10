/**
 * Whole-file AES-256-GCM. Layout: magic "CFE1" | 12-byte nonce | 16-byte tag | ciphertext.
 * Files are small enough (documents, not video) to handle in memory.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const MAGIC = Buffer.from('CFE1');

export function encryptBuffer(key: Buffer, plain: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, nonce, c.getAuthTag(), ct]);
}

export function isEncryptedBuffer(buf: Buffer): boolean {
  return buf.length >= 32 && buf.subarray(0, 4).equals(MAGIC);
}

export function decryptBuffer(key: Buffer, data: Buffer): Buffer {
  if (!isEncryptedBuffer(data)) throw new Error('not a Casefile encrypted file');
  const nonce = data.subarray(4, 16);
  const tag = data.subarray(16, 32);
  const ct = data.subarray(32);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
