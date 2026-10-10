/**
 * Imported first by main.tsx, before any schema exists. Zod 4 compiles object parsers with `new Function` when the
 * page allows it, and probes for that with `new Function("")`. The hosted Content-Security-Policy (server/security.ts:
 * no 'unsafe-eval') blocks the probe, and Chrome then reports a violation on every page although Zod falls back by
 * itself. jitless skips the probe and the compiling; parsing works the same, a little slower, which a form or a
 * search param never notices.
 */
import { z } from 'zod';

z.config({ jitless: true });
