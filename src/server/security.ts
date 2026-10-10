/**
 * What the hosted server adds for the internet (CASEFILE_HOSTED=1; src/server/config.ts). Locally none of this runs,
 * except that a request which arrived over HTTPS through a proxy (X-Forwarded-Proto) gets a Secure cookie.
 * - Security headers on every response: HSTS, nosniff, no referrer, a Permissions-Policy, X-Frame-Options DENY
 *   (SAMEORIGIN for the original-file route the document page shows in its own frame), and on HTML a
 *   Content-Security-Policy the built app runs under: scripts only from this origin plus the hash of each inline
 *   script in the served index.html (the theme script that keeps the lock screen dark), styles from this origin and
 *   inline (React style props, the packet preview), images and fonts from this origin, data: and blob:.
 * - The setup code (CASEFILE_SETUP_TOKEN): setup and restore from a backup need it, compared in constant time;
 *   without it configured both are refused, so nobody who finds the address first can claim the case.
 * - The client's address for throttling: X-Real-IP, which Railway's proxy sets to the address it saw (its documented
 *   header), else the first X-Forwarded-For hop, else the socket. X-Forwarded-For comes first from the visitor and
 *   Railway does not document stripping it, so a visitor could write a new address on every try.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from './config';

/** sha256 (base64) of every inline script (no src) in an HTML page, as CSP source hashes need them. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(createHash('sha256').update(m[2], 'utf8').digest('base64'));
  }
  return out;
}

/** The Content-Security-Policy for the app's HTML. */
export function appCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((h) => ` 'sha256-${h}'`).join('')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), display-capture=(), magnetometer=(), gyroscope=(), accelerometer=()';
export const HSTS = 'max-age=31536000; includeSubDomains';

/** The one route whose responses the app shows inside its own frame (the original PDF on the document page). */
export function framableByApp(p: string): boolean {
  return /^\/api\/documents\/[^/]+\/file$/.test(p);
}

/**
 * Hosted only: the security headers on every response. A header the route set itself (a stricter sandbox CSP on a
 * stored file, for instance) is kept. The app CSP goes on HTML responses only: a PDF shown in the browser's own
 * viewer must not carry it (object-src 'none' would stop the viewer).
 */
export function securityHeaders(csp: () => string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    let headers = c.res.headers;
    const put = (name: string, value: string) => {
      if (headers.has(name)) return;
      try {
        headers.set(name, value);
      } catch {
        // An immutable response: copy it once, then set.
        c.res = new Response(c.res.body, c.res);
        headers = c.res.headers;
        headers.set(name, value);
      }
    };
    put('strict-transport-security', HSTS);
    put('x-content-type-options', 'nosniff');
    put('referrer-policy', 'no-referrer');
    put('permissions-policy', PERMISSIONS_POLICY);
    put('x-frame-options', framableByApp(c.req.path) ? 'SAMEORIGIN' : 'DENY');
    if ((headers.get('content-type') ?? '').toLowerCase().includes('text/html')) put('content-security-policy', csp());
  };
}

/**
 * The client's address for throttling and logs: hosted, X-Real-IP (Railway's proxy sets it to the address it saw;
 * docs.railway.com, Specs & Limits), else the first X-Forwarded-For hop, else the socket. Locally, the socket.
 */
export function clientAddress(c: Context): string {
  if (config.hosted) {
    const real = c.req.header('x-real-ip')?.split(',')[0]?.trim();
    if (real) return real.slice(0, 100);
    const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first.slice(0, 100);
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** True when the request reached the server over HTTPS (directly or, by a proxy's word, X-Forwarded-Proto). */
export function viaHttps(c: Context): boolean {
  const xfp = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (xfp === 'https') return true;
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The session cookie is Secure when hosted, and whenever the request came over HTTPS. */
export function secureCookie(c: Context): boolean {
  return config.hosted || viaHttps(c);
}

export type SetupTokenCheck = { ok: true } | { ok: false; status: 401 | 403; code: 'setup_token' | 'setup_token_unset'; error: string };

export const SETUP_TOKEN_HEADER = 'x-casefile-setup-token';

/** Hosted: whether the setup code is configured on the server. */
export function setupTokenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CASEFILE_SETUP_TOKEN?.trim());
}

/** Hosted: the given setup code against CASEFILE_SETUP_TOKEN, in constant time. Locally always ok. */
export function checkSetupToken(given: string | null | undefined, env: NodeJS.ProcessEnv = process.env): SetupTokenCheck {
  if (!config.hosted) return { ok: true };
  const want = env.CASEFILE_SETUP_TOKEN?.trim();
  if (!want) {
    return {
      ok: false,
      status: 403,
      code: 'setup_token_unset',
      error: "Setting up is turned off: the server has no setup code (CASEFILE_SETUP_TOKEN). Add it in Railway's Variables and redeploy.",
    };
  }
  const got = (given ?? '').trim();
  const a = createHash('sha256').update(got, 'utf8').digest();
  const b = createHash('sha256').update(want, 'utf8').digest();
  if (!got || !timingSafeEqual(a, b)) return { ok: false, status: 401, code: 'setup_token', error: 'The setup code is wrong.' };
  return { ok: true };
}
