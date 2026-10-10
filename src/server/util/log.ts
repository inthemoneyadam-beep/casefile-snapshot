/**
 * One-line operational log for `railway logs` (and the local console). Each line is
 * `<ISO time> <LEVEL> [<tag>] <message>`; debug and info go to stdout, warn and error to stderr (Railway marks
 * stderr lines as errors). Lines carry ids, counts, statuses and timings only: never a passphrase, a key, page text,
 * a document title or a person's name (tests/railway-logs.test.ts greps captured output for them). A message is
 * forced onto one line, and anything shaped like an Anthropic key is masked as a last guard.
 *
 * Level: LOG_LEVEL (debug, info, warn, error, silent). Default info when hosted; warn locally, so the local console
 * reads as it always has (the older console lines elsewhere are unchanged).
 */
import { config } from '../config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function levelFromEnv(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'silent') return v;
  if (v === 'warning') return 'warn';
  return config.hosted ? 'info' : 'warn';
}

let threshold: LogLevel = levelFromEnv();

/** Tests and scripts: change the level (returns the one before). */
export function setLogLevel(level: LogLevel): LogLevel {
  const before = threshold;
  threshold = level;
  return before;
}

export function logLevel(): LogLevel {
  return threshold;
}

export function logEnabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return ORDER[level] >= ORDER[threshold];
}

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{6,}/g;

/** One line, keys masked, at most 4000 characters. */
export function oneLine(s: string): string {
  const flat = s.replace(/\r?\n\s*/g, ' | ').replace(KEY_SHAPE, 'sk-ant-[redacted]');
  return flat.length > 4000 ? `${flat.slice(0, 4000)}...` : flat;
}

function emit(level: Exclude<LogLevel, 'silent'>, tag: string, message: string): void {
  if (!logEnabled(level)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${tag}] ${oneLine(message)}`;
  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (tag: string, message: string) => emit('debug', tag, message),
  info: (tag: string, message: string) => emit('info', tag, message),
  warn: (tag: string, message: string) => emit('warn', tag, message),
  error: (tag: string, message: string) => emit('error', tag, message),
};

/**
 * Why something failed, for a log line about the case's work (a job, a reading): the error's class and its message
 * with anything in quotes taken out (a title or a quoted passage would sit there), at most 300 characters.
 */
export function safeReason(err: unknown): string {
  const ctor = err && typeof err === 'object' ? (err as { constructor?: { name?: string } }).constructor?.name : undefined;
  const name = err instanceof Error ? (ctor && ctor !== 'Error' ? ctor : err.name) : 'Error';
  // An API error: its HTTP status and error type say what went wrong; its message is the response body.
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  if (typeof status === 'number') {
    const type = (err as { error?: { error?: { type?: unknown } } }).error?.error?.type;
    return `${name} (HTTP ${status}${typeof type === 'string' ? `, ${type}` : ''})`;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = raw
    .replace(/"[^"\n]{0,2000}"/g, '"..."')
    .replace(/“[^”\n]{0,2000}”/g, '"..."')
    .replace(/(^|[\s(:=])'[^'\n]{0,2000}'(?=$|[\s),.;:])/g, '$1\'...\'')
    .replace(/`[^`\n]{0,2000}`/g, '`...`');
  const line = oneLine(scrubbed);
  return `${name}: ${line.length > 300 ? `${line.slice(0, 300)}...` : line}`;
}

/** An error's class, message and stack frames on one line (no source text beyond what the error itself says). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const frames = (err.stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, 12);
  return `${err.name}: ${err.message}${frames.length ? ` | ${frames.join(' | ')}` : ''}`;
}
