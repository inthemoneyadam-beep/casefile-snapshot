/**
 * Process configuration. Anything secret or user-editable lives in the
 * encrypted settings table instead; this file only knows where the data is
 * and which port to listen on.
 *
 * Hosted mode (CASEFILE_HOSTED=1, set only on Railway; docs/DEPLOY.md): the server listens on CASEFILE_HOST
 * (default 0.0.0.0) and CASEFILE_PORT, else PORT (Railway's), else config.json, else 4810; the LAN listener is off;
 * CASEFILE_DATA_DIR and CASEFILE_BACKUPS_DIR must be given, and when a Railway volume is attached
 * (RAILWAY_VOLUME_MOUNT_PATH) both must lie inside it. hostedProblems() says what is wrong in plain words and the
 * server refuses to start (src/server/index.ts), so a redeploy can never write the case where the next one loses it.
 * Local mode (the default) is exactly as before: 127.0.0.1, CASEFILE_PORT or config.json or 4810, PORT ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..', '..');

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  filesDir: string;
  tessCacheDir: string;
  logsDir: string;
  backupsDir: string;
  distDir: string;
  isProduction: boolean;
  /** CASEFILE_HOSTED=1: running on a server reachable from the internet (Railway). */
  hosted: boolean;
}

function readConfigFile(): Partial<{ port: number; dataDir: string; backupsDir: string }> {
  const p = path.join(projectRoot, 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** True for "1", "true", "yes" and "on" (any case); everything else, unset included, is false. */
export function envFlag(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

/** A non-empty trimmed env value, or undefined. */
function envValue(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export interface ConfigInputs {
  env: NodeJS.ProcessEnv;
  file: Partial<{ port: number; dataDir: string; backupsDir: string }>;
  root: string;
}

/** The configuration for an environment (pure; the module's `config` is this for process.env). */
export function resolveConfig({ env, file, root }: ConfigInputs): AppConfig {
  const hosted = envFlag(env.CASEFILE_HOSTED);
  const dataDir = path.resolve(root, env.CASEFILE_DATA_DIR ?? file.dataDir ?? 'data');
  const portRaw = hosted ? (envValue(env.CASEFILE_PORT) ?? envValue(env.PORT) ?? file.port ?? DEFAULT_PORT) : (env.CASEFILE_PORT ?? file.port ?? DEFAULT_PORT);
  return {
    port: Number(portRaw),
    host: hosted ? (envValue(env.CASEFILE_HOST) ?? '0.0.0.0') : '127.0.0.1',
    dataDir,
    filesDir: path.join(dataDir, 'files'),
    tessCacheDir: path.join(dataDir, 'tesscache'),
    logsDir: path.join(dataDir, 'logs'),
    backupsDir: path.resolve(root, env.CASEFILE_BACKUPS_DIR ?? file.backupsDir ?? 'backups'),
    // CASEFILE_DIST_DIR: a client built elsewhere (test runs build into .tmp, never into dist/).
    distDir: env.CASEFILE_DIST_DIR ? path.resolve(root, env.CASEFILE_DIST_DIR) : path.join(root, 'dist'),
    isProduction: env.NODE_ENV === 'production',
    hosted,
  };
}

const file = readConfigFile();

export const config: AppConfig = resolveConfig({ env: process.env, file, root: projectRoot });

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Where the Railway volume is mounted, when one is attached. */
export function volumeMountPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return envValue(env.RAILWAY_VOLUME_MOUNT_PATH) ?? null;
}

/** True when the process runs on Railway (any of the variables Railway sets on every deployment). */
export function onRailway(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(envValue(env.RAILWAY_ENVIRONMENT_ID) ?? envValue(env.RAILWAY_PROJECT_ID) ?? envValue(env.RAILWAY_SERVICE_ID) ?? envValue(env.RAILWAY_DEPLOYMENT_ID));
}

/**
 * What stops a hosted start, one plain sentence each (empty when the start may go ahead, and always empty locally).
 * The data and backups folders must be named; with a volume attached both lie inside it; on Railway without a volume
 * nothing may start (the next deploy would lose the case); the two folders must be separate (a restore needs an empty
 * data folder, and a backup must not sit inside what it backs up).
 */
export function hostedProblems(c: AppConfig = config, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!c.hosted) return [];
  const problems: string[] = [];
  if (!envValue(env.CASEFILE_DATA_DIR)) problems.push('CASEFILE_DATA_DIR is not set. Set it to a folder on the volume, for example /data/case.');
  if (!envValue(env.CASEFILE_BACKUPS_DIR)) problems.push('CASEFILE_BACKUPS_DIR is not set. Set it to a folder on the volume, for example /data/backups.');
  const vol = volumeMountPath(env);
  if (vol) {
    if (envValue(env.CASEFILE_DATA_DIR) && !isInside(vol, c.dataDir)) problems.push(`The data folder ${c.dataDir} is not on the volume mounted at ${vol}; it would be lost at the next deploy. Set CASEFILE_DATA_DIR to a folder inside ${vol}, for example ${path.posix.join(vol, 'case')}.`);
    if (envValue(env.CASEFILE_BACKUPS_DIR) && !isInside(vol, c.backupsDir)) problems.push(`The backups folder ${c.backupsDir} is not on the volume mounted at ${vol}; it would be lost at the next deploy. Set CASEFILE_BACKUPS_DIR to a folder inside ${vol}, for example ${path.posix.join(vol, 'backups')}.`);
  } else if (onRailway(env)) {
    problems.push('No volume is attached to this service, so the case would be lost at the next deploy. In Railway, add a volume mounted at /data, then redeploy.');
  }
  if (envValue(env.CASEFILE_DATA_DIR) && envValue(env.CASEFILE_BACKUPS_DIR) && (isInside(c.dataDir, c.backupsDir) || isInside(c.backupsDir, c.dataDir))) {
    problems.push(`The data folder (${c.dataDir}) and the backups folder (${c.backupsDir}) must be separate folders, neither inside the other, for example /data/case and /data/backups.`);
  }
  if (!Number.isInteger(c.port) || c.port <= 0 || c.port > 65535) problems.push(`The port "${String(c.port)}" is not a port number (CASEFILE_PORT or PORT).`);
  return problems;
}

/** Whether a folder can be written: creates it when missing, writes and removes a probe file of its own. */
export function writableProblem(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-check-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
    fs.unlinkSync(probe);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    return `The folder ${dir} cannot be written (${code}).`;
  }
}

/** The build this server runs: the Railway commit, else the image's build argument, else the package version (with the Railway deployment). */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = envValue(env.RAILWAY_GIT_COMMIT_SHA) ?? envValue(env.CASEFILE_BUILD_SHA);
  if (sha) return sha.slice(0, 12);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: string };
    // A deploy from the command line has no commit: the deployment id tells one deploy from the next.
    const deployment = envValue(env.RAILWAY_DEPLOYMENT_ID);
    return deployment ? `${pkg.version ?? 'unknown'}+${deployment.slice(0, 8)}` : (pkg.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export function ensureDirs(): void {
  for (const d of [config.dataDir, config.filesDir, config.tessCacheDir, config.logsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
