import { randomUUID, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();
export const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Lower-case, strip punctuation, collapse whitespace. For dedup/grouping keys (shared with the client). */
export { normalizeKey } from '../../shared/text';
