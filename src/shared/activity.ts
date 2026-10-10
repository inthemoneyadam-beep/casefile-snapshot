/**
 * Idle lock: what the browser and the server agree on. The browser sends
 * ACTIVITY_HEADER on /api requests made within ACTIVITY_WINDOW_MS of real
 * keyboard, mouse or touch input (src/client/app/activity.ts); the server
 * counts a read as activity only when it carries the header
 * (countsAsActivity in src/server/auth.ts).
 */
export const ACTIVITY_HEADER = 'x-casefile-active';

/** How long one keystroke or click keeps requests marked as activity. */
export const ACTIVITY_WINDOW_MS = 60_000;

export function inputIsRecent(lastInputAt: number, now: number): boolean {
  return now - lastInputAt < ACTIVITY_WINDOW_MS;
}

/** A same-origin request under /api/ (a string or URL; anything else, such as a Request object, is not marked). */
export function isApiUrl(input: unknown, base: string): boolean {
  if (typeof input !== 'string' && !(input instanceof URL)) return false;
  try {
    const u = new URL(String(input), base);
    return u.origin === new URL(base).origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}
