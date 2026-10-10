/**
 * The HTTP app: health check, (hosted) security headers and request log, the API behind the lock, and in production
 * the built client from dist/. src/server/index.ts serves it; tests call buildApp() and app.request().
 *
 * Order: hosted, the security headers wrap every response, then the request log; GET /healthz (no auth, no session,
 * nothing but {ok, version, locked}); the cross-site write guard before every /api route, /api/auth included;
 * /api/auth; the lock (requireUnlocked) before the rest of /api.
 *
 * Request log. Locally as before: only slow (over 500 ms) or failed (5xx) /api requests, silenced by CASEFILE_QUIET.
 * Hosted, every request as one line `[http] METHOD <route pattern> STATUS MSms` (the pattern, e.g.
 * /api/documents/:id, never the path's ids, never a query string or a body): at info for writes, errors, slow
 * requests and reads a person asked for (x-casefile-active); at debug for background polls, the client's files and
 * /healthz, so LOG_LEVEL=debug shows everything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { matchedRoutes, routePath } from 'hono/route';
import { serveStatic } from '@hono/node-server/serve-static';
import { appVersion, config } from './config';
import { authRoutes, requireUnlocked, rejectCrossSiteWrites, isUnlocked, ACTIVITY_HEADER } from './auth';
import { apiRoutes } from './routes';
import { HttpError } from './util/errors';
import { LockedError } from './db';
import { APP_NAME } from '../shared/constants';
import { appCsp, inlineScriptHashes, securityHeaders } from './security';
import { describeError, log } from './util/log';

/**
 * The registered pattern of the route a request was for (e.g. /api/documents/:id), never the path with its ids: the
 * handler that answered when it is a real route, else (a middleware answered first, such as the lock with 423) the
 * most specific route that matched, else the catch-all that matched.
 */
export function routePattern(c: Context): string {
  try {
    const answered = routePath(c);
    if (answered && !answered.endsWith('*')) return answered;
    const specific = matchedRoutes(c).find((r) => r.method !== 'ALL' && !r.path.endsWith('*'));
    if (specific) return specific.path;
    if (answered) return answered;
  } catch {
    // fall through
  }
  return c.req.path.startsWith('/api/') ? '/api/(unmatched)' : '(static)';
}

/** The level a hosted request line is logged at. */
export function requestLogLevel(input: { method: string; path: string; status: number; ms: number; active: boolean }): 'debug' | 'info' | 'warn' | 'error' {
  if (input.status >= 500) return 'error';
  if (input.path === '/healthz') return 'debug';
  if (!input.path.startsWith('/api/')) return input.status >= 400 ? 'info' : 'debug';
  if (input.status >= 400) return 'info';
  // A restore sends a large backup in hundreds of pieces; the [restore] lines say how far it got every tenth.
  if (input.path === '/api/auth/restore/chunk') return 'debug';
  if (input.ms >= 1500) return 'info';
  const read = input.method === 'GET' || input.method === 'HEAD' || input.method === 'OPTIONS';
  if (read && !input.active) return 'debug';
  return 'info';
}

export interface BuildAppOptions {
  /** Where the built client lives (default config.distDir). */
  distDir?: string;
}

export function buildApp(opts: BuildAppOptions = {}): Hono {
  const distDir = opts.distDir ?? config.distDir;
  const indexHtml = path.join(distDir, 'index.html');
  const version = appVersion();
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof LockedError) return c.json({ error: 'locked' }, 423);
    const msg = err instanceof Error ? err.message : String(err);
    if (config.hosted) {
      log.error('api', `${c.req.method} ${routePattern(c)} -> 500 ${describeError(err)}`);
    } else {
      console.error(`[api] ${c.req.method} ${c.req.path} -> ${msg}`);
      if (process.env.CASEFILE_DEBUG && err instanceof Error) console.error(err.stack);
    }
    return c.json({ error: msg }, 500);
  });

  if (config.hosted) {
    let csp: string | null = null;
    const cspNow = () => {
      if (csp) return csp;
      let hashes: string[] = [];
      try {
        hashes = inlineScriptHashes(fs.readFileSync(indexHtml, 'utf8'));
      } catch {
        // no built client: only the API answers, and no page needs a script hash
      }
      csp = appCsp(hashes);
      return csp;
    };
    app.use('*', securityHeaders(cspNow));
    app.use('*', async (c, next) => {
      const t0 = Date.now();
      await next();
      const ms = Date.now() - t0;
      const level = requestLogLevel({ method: c.req.method.toUpperCase(), path: c.req.path, status: c.res.status, ms, active: c.req.header(ACTIVITY_HEADER) === '1' });
      log[level]('http', `${c.req.method} ${routePattern(c)} ${c.res.status} ${ms}ms`);
    });
  } else {
    // Minimal request log (no bodies, no cookies).
    app.use('/api/*', async (c, next) => {
      const t0 = Date.now();
      await next();
      if (process.env.CASEFILE_QUIET) return;
      const ms = Date.now() - t0;
      if (ms > 500 || c.res.status >= 500) console.log(`[api] ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
    });
  }

  // Railway's health check (and anyone's): no auth, nothing about the case beyond whether it is locked.
  app.get('/healthz', (c) => {
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, version, locked: !isUnlocked() });
  });

  // Before every route, /api/auth included: no state change from another site.
  app.use('/api/*', rejectCrossSiteWrites);
  app.route('/api/auth', authRoutes);
  app.use('/api/*', requireUnlocked);
  app.route('/api', apiRoutes);
  app.get('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // Production static client.
  if (fs.existsSync(indexHtml)) {
    const relDist = path.relative(process.cwd(), distDir).split(path.sep).join('/');
    app.use('/*', serveStatic({ root: relDist }));
    app.get('*', (c) => c.html(fs.readFileSync(indexHtml, 'utf8')));
  } else {
    app.get('/', (c) => c.text(`${APP_NAME} API is running. In development open the Vite dev server at http://127.0.0.1:4811/. For production run: npm start`));
  }
  return app;
}
