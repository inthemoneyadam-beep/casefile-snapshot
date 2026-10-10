/**
 * Small typed fetch wrapper. All API calls go through here so a 423 (locked)
 * anywhere flips the app back to the lock screen.
 */
import { useCallback } from 'react';
import { useToast } from '../ui/Toast';

export class ApiError extends Error {
  /**
   * @param retryAfter seconds to wait before trying again, from a 429's Retry-After header (passphrase throttling,
   * hosted mode), else undefined.
   */
  constructor(public status: number, message: string, public body?: unknown, public retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Seconds from a Retry-After header: a number of seconds, or an HTTP date (seconds from now). Undefined when
 * absent or unreadable; never negative.
 */
export function retryAfterSeconds(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const at = Date.parse(t);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The words for a failed call: the server's `error` text (an ApiError) or any Error's message, as it is (an empty
 * message stays empty); for anything else the fallback when one is given, else the value as a string.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message;
  return fallback ?? String(err);
}

/** `toast(errorMessage(err), 'bad')`: the failure toast every page's `onError` uses (the same function on each render). */
export function useFailToast(): (err: unknown) => void {
  const toast = useToast();
  return useCallback((err: unknown) => toast(errorMessage(err), 'bad'), [toast]);
}

export const LOCK_EVENT = 'casefile:locked';

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { ...init, method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 423 || (res.status === 401 && !path.startsWith('/api/auth/'))) {
    window.dispatchEvent(new CustomEvent(LOCK_EVENT));
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string')
      ? (data as { error: string }).error
      : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, data, res.status === 429 ? retryAfterSeconds(res.headers.get('retry-after')) : undefined);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('POST', path, body, init),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('PATCH', path, body, init),
  put: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>('PUT', path, body, init),
  delete: <T>(path: string, init?: RequestInit) => request<T>('DELETE', path, undefined, init),
  /** Build a query string, skipping empty values. */
  qs(params: Record<string, string | number | boolean | null | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : '';
  },
};

/**
 * The `items` of a list the page only picks from (documents, places), or an empty list when the answer holds none or
 * the call fails with 404 or 500, so the page keeps working; any other failure is thrown. `requireId` keeps only the
 * rows with a string id.
 */
export async function listOrEmpty<T>(path: string, { requireId = false }: { requireId?: boolean } = {}): Promise<T[]> {
  try {
    const r = await api.get<{ items?: T[] }>(path);
    if (!Array.isArray(r?.items)) return [];
    return requireId ? r.items.filter((x) => x && typeof (x as { id?: unknown }).id === 'string') : r.items;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 500)) return [];
    throw err;
  }
}

/**
 * Split a Server-Sent Events body into its `data:` payloads (the lines of one
 * event joined with "\n"), each parsed as JSON, or the raw string when it is
 * not JSON. Comments and events without data are skipped. Stopping early
 * (a `break` in the consumer) cancels the body.
 */
export async function* parseSse<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = chunk.split('\n').filter((l) => l.startsWith('data:'));
        if (!lines.length) continue;
        const data = lines.map((l) => l.slice(5).trimStart()).join('\n');
        let parsed: T;
        try {
          parsed = JSON.parse(data) as T;
        } catch {
          parsed = data as unknown as T;
        }
        yield parsed;
      }
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Open an event stream. Uses the global fetch at call time, so the activity
 * header (app/activity.ts) is added as on any API call; a 423 or 401 flips the
 * app to the lock screen; a failed response throws ApiError with the server's
 * `error` text.
 */
async function* openSse<T>(path: string, init: RequestInit): AsyncGenerator<T> {
  const res = await fetch(path, { ...init, credentials: 'same-origin' });
  if (res.status === 423 || res.status === 401) window.dispatchEvent(new CustomEvent(LOCK_EVENT));
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, msg);
  }
  yield* parseSse<T>(res.body);
}

/** Stream Server-Sent Events from a POST endpoint; yields parsed `data:` payloads. */
export function streamPost<T = unknown>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  return openSse<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
}

/** Stream Server-Sent Events from a GET endpoint (every role may read); yields parsed `data:` payloads. */
export function streamGet<T = unknown>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
  return openSse<T>(path, { method: 'GET', headers: { accept: 'text/event-stream' }, signal });
}
