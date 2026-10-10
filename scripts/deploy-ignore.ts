/**
 * Proof that a Railway upload and the Docker build never carry the case or the records (docs/DEPLOY.md).
 *
 *   npm run deploy:check            (the project folder)
 *   npx tsx scripts/deploy-ignore.ts <folder>
 *
 * Applies .railwayignore with the rules `railway up` uses for it (gitignore rules: a name without a slash matches at
 * any depth, a leading slash anchors it to the top, a trailing slash means a folder) and .dockerignore with Docker's
 * (every pattern anchored at the top, `**` for any depth, a matching folder takes everything inside it), each on its
 * own, to the real folder. A folder that is ignored is never opened, as the real tools do, so Files/, data/,
 * backups/ and set-aside/ are never listed: they are only ever seen by name. Each file that would be sent is checked
 * against the private shapes (anything under Files, data, backups or set-aside, a .bak or set-aside folder, any .pdf,
 * .db, .db-*, .sqlite, .zip, keyring.json or keyring-backups), with names compared without regard to case. Exits 1
 * when one would be sent, when a file the build needs would be left out, or when an ignore file holds a "!"
 * exception (the proof relies on an ignored folder never coming back).
 *
 * Read only: nothing is written, moved or deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type IgnoreFlavour = 'gitignore' | 'docker';

export interface IgnoreRule {
  pattern: string;
  regex: RegExp;
  dirOnly: boolean;
}

function escapeRe(ch: string): string {
  return /[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch;
}

/** A glob (no leading slash) as a regex over a whole relative path with forward slashes. */
export function globToRegex(glob: string, caseInsensitive = false): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // "**/" any folders (none included), "/**" everything inside, a lone "**" anything at all.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end;
      }
    } else if (ch === '\\' && i + 1 < glob.length) {
      re += escapeRe(glob[i + 1]);
      i += 1;
    } else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

/** The rules of one ignore file. Throws on a "!" exception (see the header). */
export function parseIgnore(text: string, flavour: IgnoreFlavour, opts: { caseInsensitive?: boolean } = {}): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) throw new Error(`"${line}": exceptions ("!") are not allowed in the deploy ignore files; an ignored folder must stay ignored`);
    const dirOnly = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    if (flavour === 'docker') {
      // Docker: every pattern is relative to the top (a leading slash changes nothing); cleaned like a path.
      const clean = path.posix.normalize(line.replace(/^\/+/, ''));
      rules.push({ pattern: rawLine.trim(), regex: globToRegex(clean, opts.caseInsensitive), dirOnly: false });
      continue;
    }
    // gitignore: a slash at the start or in the middle anchors the pattern to the top; otherwise it matches a name
    // at any depth.
    const anchored = line.startsWith('/') || line.includes('/');
    const body = line.replace(/^\/+/, '');
    const glob = anchored ? body : `**/${body}`;
    rules.push({ pattern: rawLine.trim(), regex: globToRegex(glob, opts.caseInsensitive), dirOnly });
  }
  return rules;
}

/** Whether a relative path (forward slashes) is ignored by the rules; its parents are checked by the walk. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean, flavour: IgnoreFlavour): boolean {
  if (flavour === 'docker') {
    // A pattern excludes a path when it matches the path or any folder above it.
    const parts = rel.split('/');
    for (let n = parts.length; n >= 1; n--) {
      const sub = parts.slice(0, n).join('/');
      if (rules.some((r) => r.regex.test(sub))) return true;
    }
    return false;
  }
  return rules.some((r) => (!r.dirOnly || isDir) && r.regex.test(rel));
}

export interface WalkResult {
  /** Files that would be sent, relative with forward slashes. */
  included: string[];
  bytes: number;
  /** Top-level folders and files left out, by name only. */
  prunedTop: string[];
}

/** The files that would be sent from `root`; ignored folders are never opened. */
export function walkIncluded(root: string, rules: IgnoreRule[], flavour: IgnoreFlavour): WalkResult {
  const included: string[] = [];
  const prunedTop: string[] = [];
  let bytes = 0;
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(abs, e.name);
      // Links (the worktree's node_modules is a junction) are never followed, as neither tool follows them.
      const isDir = e.isDirectory() && !e.isSymbolicLink();
      if (isIgnored(rules, r, isDir || e.isSymbolicLink(), flavour)) {
        if (!rel) prunedTop.push(isDir ? `${e.name}/` : e.name);
        continue;
      }
      if (isDir) walk(full, r);
      else {
        included.push(r);
        try {
          bytes += fs.lstatSync(full).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(root, '');
  return { included: included.sort(), bytes, prunedTop: prunedTop.sort() };
}

const PRIVATE_TOP = new Set(['files', 'data', 'backups', 'set-aside']);

/** Why a relative path must never be sent, or null. Names are compared without regard to case. */
export function privateReason(rel: string): string | null {
  const parts = rel.split('/');
  const top = parts[0].toLowerCase();
  if (parts.length > 1 && PRIVATE_TOP.has(top)) return `inside ${parts[0]}/`;
  if (parts.length > 1 && (/\.bak/i.test(parts[0]) || /set-aside/i.test(parts[0]) || /^data[.-]/i.test(parts[0]))) return `inside ${parts[0]}/`;
  const base = parts[parts.length - 1].toLowerCase();
  if (/\.pdf$/.test(base)) return 'a PDF';
  if (/\.db$/.test(base) || /\.db-/.test(base) || /\.sqlite\d?(-|$)/.test(base)) return 'a database file';
  if (/\.zip$/.test(base)) return 'a zip (a backup?)';
  if (/^keyring.*\.json$/.test(base)) return 'a keyring';
  if (parts.some((p) => p.toLowerCase() === 'keyring-backups')) return 'inside keyring-backups/';
  return null;
}

/** Files the image build needs; leaving one out would break the first deploy. */
export const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'config.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.client.json',
  'tsr.config.json',
  'vite.config.ts',
  'scripts/docker-entrypoint.sh',
  'scripts/container-smoke.ts',
  'src/client/index.html',
  'src/client/main.tsx',
  'src/server/index.ts',
  'src/server/crypto/keyring.ts',
  'src/server/files/store.ts',
  'src/server/files/unzip.ts',
  'src/server/db/schema.ts',
];
/** Railway reads these from the upload (the Dockerfile and its config-as-code). */
export const REQUIRED_FOR_RAILWAY = ['Dockerfile', 'railway.json', '.dockerignore'];

export interface CheckReport {
  flavour: IgnoreFlavour;
  ignoreFile: string;
  included: number;
  bytes: number;
  prunedTop: string[];
  /** Files that would be sent although private: must be empty. */
  violations: Array<{ path: string; reason: string }>;
  /** Files the build needs that would be left out: must be empty. */
  missing: string[];
}

export function checkFolder(root: string, flavour: IgnoreFlavour, opts: { caseInsensitive?: boolean; required?: string[] } = {}): CheckReport {
  const ignoreFile = flavour === 'docker' ? '.dockerignore' : '.railwayignore';
  const text = fs.readFileSync(path.join(root, ignoreFile), 'utf8');
  const rules = parseIgnore(text, flavour, { caseInsensitive: opts.caseInsensitive });
  const walked = walkIncluded(root, rules, flavour);
  const violations: CheckReport['violations'] = [];
  for (const p of walked.included) {
    const reason = privateReason(p);
    if (reason) violations.push({ path: p, reason });
  }
  const set = new Set(walked.included);
  const required = opts.required ?? (flavour === 'docker' ? REQUIRED_FILES : [...REQUIRED_FILES, ...REQUIRED_FOR_RAILWAY]);
  const missing = required.filter((f) => fs.existsSync(path.join(root, f)) && !set.has(f));
  return { flavour, ignoreFile, included: walked.included.length, bytes: walked.bytes, prunedTop: walked.prunedTop, violations, missing };
}

function main(): void {
  const root = path.resolve(process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  let failed = false;
  for (const flavour of ['gitignore', 'docker'] as const) {
    // Both ways of comparing names: the tools compare with case, Windows folders do not.
    for (const caseInsensitive of [false, true]) {
      const r = checkFolder(root, flavour, { caseInsensitive });
      const label = `${r.ignoreFile}${caseInsensitive ? ' (names compared without case)' : ''}`;
      console.log(`${label}: ${r.included} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB would be sent; left out at the top: ${r.prunedTop.join(', ') || 'nothing'}`);
      for (const v of r.violations) console.log(`  WOULD SEND ${v.path} (${v.reason})`);
      for (const m of r.missing) console.log(`  WOULD LEAVE OUT ${m}, which the build needs`);
      if (r.violations.length || r.missing.length) failed = true;
    }
  }
  console.log(failed ? 'NOT SAFE: fix the ignore files before any upload.' : 'Safe: no file under Files, data, backups or set-aside, and no PDF, database, zip or keyring, would be sent.');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
