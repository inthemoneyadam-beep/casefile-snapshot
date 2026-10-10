/**
 * Lock state, users and sessions. The server is the lock: while locked there
 * is no open database, no file key, and no job worker. Every person with
 * access has their own passphrase in the keyring (all unwrap the same data
 * key) and a `users` row with a role. The browser holds a random session
 * token in an httpOnly cookie; a token is only valid for the unlock it was
 * issued in and carries the user it was issued to.
 *
 * requireUnlocked enforces the role policy (services/users.ts: authorize)
 * and writes the audit rows the policy asks for (logins are written here,
 * non-owner writes, settings changes, exports and purges after the handler
 * succeeded). A create's audit row carries the id the handler created (set
 * with c.set('auditEntityId', id), or read from the JSON response).
 *
 * Idle lock: activity means a person, not HTTP traffic. A write through
 * requireUnlocked always counts; a read counts only when the browser saw
 * keyboard, mouse or touch input within the last minute and says so with
 * `x-casefile-active: 1` (src/client/app/activity.ts). A visible tab polls
 * job status every few seconds, so counting every request would keep an
 * unattended case unlocked for as long as the tab stays on screen.
 * Work holds the lock off: while a job is running or queued, or an AI call
 * is still streaming, the case stays open, and idle time counts from the
 * later of the last activity and the moment the last AI call returned (a
 * Fable pass can take half an hour; a consult pauses between tool turns).
 * The hold ends IDLE_HOLD_MAX_MS after the idle limit with nobody at the
 * screen, so a hung job cannot keep the case open for good; interrupted jobs
 * are re-queued at the next unlock.
 *
 * State-changing requests from another site are refused before any handler
 * runs (rejectCrossSiteWrites), so a web page cannot lock the case, set it
 * up or try passphrases through the user's browser.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { config, projectRoot } from './config';
import { DEFAULT_PORT } from '../shared/constants';
import {
  addKeyringUser,
  createKeyring,
  DEFAULT_OWNER_NAME,
  deriveSubkey,
  hasKeyringEntry,
  keyringExists,
  listKeyringUsers,
  migrateLegacyKeyring,
  removeKeyringUser,
  renameKeyringUser,
  setKeyringUserPassphrase,
  unlockKeyringAs,
  WrongPassphraseError,
  type UnlockResult,
} from './crypto/keyring';
import { eq } from 'drizzle-orm';
import { openDatabase, closeDatabase, isDbOpen, LockedError, db, schema } from './db';
import { setFileKey } from './files/store';
import { activeJobCount, startJobWorker, stopJobWorker } from './jobs/queue';
import { aiCallsInFlight, lastAiCallFinishedAt } from './ai/client';
import { getSetting, clearSettingsCache, setSetting } from './services/settings';
import { createPerson } from './services/people';
import { writeAudit } from './services/audit';
import { captureEvidenceBeforeRepair, repairInterruptedExtraction } from './services/extraction-evidence';
import {
  asRole,
  auditActionFor,
  authorize,
  clearUsersCache,
  countOwners,
  createUserRow,
  ensureUserRow,
  entityFromPath,
  getUser,
  getUserCached,
  listUsers,
  removeUserRow,
  touchLogin,
  updateUserRow,
  ROLES,
  type Role,
  type SessionUser,
  type UserRow,
} from './services/users';
import { newId } from './util/ids';
import { ACTIVITY_HEADER } from '../shared/activity';
import { checkSetupToken, clientAddress, secureCookie, setupTokenConfigured, SETUP_TOKEN_HEADER } from './security';
import { Throttle, waitWords, type ThrottleVerdict } from './util/throttle';
import { describeError, log } from './util/log';
import { finishPieces, piecesState, receivePiece, removeLeftoverUploads, RestoreError, restoreBusy, restoreFromUpload, restoreProgress, type RestoreProgress } from './services/restore-upload';

// Browsers share cookies between ports of one host, so a test copy on another port would sign the real app out.
// The real app (default port) keeps the plain name; any other port gets its own. Hosted, the name carries the
// __Host- prefix: the browser then keeps it only as a Secure cookie for this one site, never shared with a subdomain.
export const SESSION_COOKIE = config.hosted ? '__Host-casefile_session' : config.port === DEFAULT_PORT ? 'casefile_session' : `casefile_session_${config.port}`;
const COOKIE = SESSION_COOKIE;
let dek: Buffer | null = null;
const sessions = new Map<string, { userId: string; issuedAt: number }>();
let lastActivity = Date.now();
let unlockedAt: string | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const listeners = new Set<(unlocked: boolean) => void>();
let lanState: { active: boolean; host: string | null; port: number | null } = { active: false, host: null, port: null };

export class DisabledUserError extends Error {
  constructor() {
    super('This person no longer has access');
    this.name = 'DisabledUserError';
  }
}

export function onLockChange(fn: (unlocked: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isInitialized(): boolean {
  return keyringExists(config.dataDir);
}

export function isUnlocked(): boolean {
  return dek !== null && isDbOpen();
}

export function touch(): void {
  lastActivity = Date.now();
}

/** When the last request that counts as activity arrived (epoch ms); for tests and diagnostics. */
export function lastActivityAt(): number {
  return lastActivity;
}

// ACTIVITY_HEADER (src/shared/activity.ts) is sent by the browser on requests
// made within a minute of real keyboard, mouse or touch input. Forging it
// only keeps a session that already has a valid cookie alive; it opens nothing.
export { ACTIVITY_HEADER };

/**
 * Whether a request through requireUnlocked resets the idle timer: every
 * write does (someone pressed a button), a read only with ACTIVITY_HEADER.
 * Background polls (job status every few seconds, Today, the AI log, busy
 * documents) are reads, so they keep the case open only while a person is
 * actually at the screen.
 */
export function countsAsActivity(method: string, activityHeader: string | undefined): boolean {
  return !readMethod(method.toUpperCase()) || activityHeader === '1';
}

/** lock.idleMinutes as a number of minutes; 0 switches the idle lock off. */
function idleMinutesSetting(): number {
  try {
    const n = Number(getSetting('lock.idleMinutes'));
    return Number.isFinite(n) && n >= 0 ? n : 30;
  } catch {
    return 30;
  }
}

/** index.ts reports whether the LAN listener is up so the status bar can say so. */
export function setLanState(s: { active: boolean; host: string | null; port: number | null }): void {
  lanState = s;
}

/** The Files folder next to the app, suggested for the first-run import; none when hosted (the server has no such folder). */
export function filesFolder(): string | null {
  if (config.hosted) return null;
  return path.join(projectRoot, 'Files');
}

/** AI calls left `running` by a crash or restart can never finish; mark them so the log is honest. */
function repairInterruptedAiCalls(): void {
  try {
    db().update(schema.aiCalls).set({ status: 'interrupted', error: 'server restarted or locked before the call finished' }).where(eq(schema.aiCalls.status, 'running')).run();
  } catch {
    // never block unlock on log hygiene
  }
}

/**
 * At unlock, before anything is repaired or the job worker starts (2026-10-07, findings A.5 and D.5 steps 2-3): first
 * the evidence of every unfinished or failed reading is kept (runs, jobs, model calls, statuses, into
 * `metadata_json.coverage.legacy`, with an audit row of counts), and only then are the stopped readings repaired: model
 * calls and runs left running are marked interrupted, segments left running go back to pending, a document left
 * `running` with no job gets a status that says what it holds. The jobs themselves are re-queued by the worker as it
 * starts, their stopped attempt given back. Never blocks the unlock.
 */
export function repairAfterUnlock(): { evidence: number; repair: ReturnType<typeof repairInterruptedExtraction> | null } {
  let evidence = 0;
  try {
    evidence = captureEvidenceBeforeRepair();
  } catch (err) {
    console.warn(`[auth] evidence before repair: ${err instanceof Error ? err.message : String(err)}`);
  }
  repairInterruptedAiCalls();
  let repair: ReturnType<typeof repairInterruptedExtraction> | null = null;
  try {
    repair = repairInterruptedExtraction();
    if (repair.runsInterrupted || repair.segmentsReset || repair.documentsSettled) {
      console.log(`[auth] repaired stopped readings: ${repair.runsInterrupted} runs, ${repair.segmentsReset} parts, ${repair.documentsSettled} documents (evidence kept for ${evidence})`);
    }
  } catch (err) {
    console.warn(`[auth] repair of stopped readings: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { evidence, repair };
}

function issueSession(userId: string): string {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId, issuedAt: Date.now() });
  return token;
}

function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, name: row.name, role: asRole(row.role) };
}

/**
 * Turn a keyring unlock into a users row. A version 1 keyring is migrated
 * here: the legacy wrap becomes the owner's entry (reusing the single
 * existing owner row when the database already has one).
 */
function resolveUnlockedUser(r: UnlockResult): UserRow {
  if (r.legacy) {
    const owners = listUsers().filter((u) => u.role === 'owner');
    const id = owners.length === 1 ? owners[0].id : newId();
    let name = owners.length === 1 ? owners[0].name : '';
    if (!name) {
      try {
        name = String(getSetting('patient.name') ?? '').trim();
      } catch {
        name = '';
      }
    }
    const row = ensureUserRow(id, name || DEFAULT_OWNER_NAME);
    migrateLegacyKeyring(config.dataDir, { userId: row.id, name: row.name });
    // No name in the log (it may be read on a hosting service).
    console.log('[auth] keyring migrated to version 2; the owner entry was made');
    return row;
  }
  return ensureUserRow(r.userId!, r.name ?? '');
}

/**
 * Verify a passphrase (for the named user, or any user when omitted), open
 * the database on the first unlock, and issue a session for that user.
 */
export function unlock(passphrase: string, userId?: string | null): { token: string; user: SessionUser } {
  const r = unlockKeyringAs(config.dataDir, passphrase, userId);
  const openedHere = !isUnlocked();
  if (openedHere) {
    openDatabase(deriveSubkey(r.dek, 'casefile/db'));
    setFileKey(deriveSubkey(r.dek, 'casefile/files'));
    // Evidence first, then the repair (model calls, runs and segments left running), then the worker re-queues jobs.
    repairAfterUnlock();
    dek = r.dek;
    unlockedAt = new Date().toISOString();
    clearSettingsCache();
    clearUsersCache();
    touch();
    startJobWorker();
    startIdleWatch();
    for (const fn of listeners) fn(true);
  } else {
    r.dek.fill(0);
  }
  const row = resolveUnlockedUser(r);
  if (row.disabled) {
    // A disabled person's passphrase must not leave the case open for anyone.
    writeAudit({ userId: row.id, userName: row.name, action: 'login', summary: 'refused: access disabled' });
    if (openedHere) lock();
    throw new DisabledUserError();
  }
  touchLogin(row.id);
  writeAudit({ userId: row.id, userName: row.name, action: 'login', summary: `${row.role} unlocked` });
  touch();
  // The role only, never a name.
  log.info('auth', openedHere ? `unlocked (${asRole(row.role)} signed in; the case is open and work may run)` : `signed in (${asRole(row.role)}; the case was already open)`);
  return { token: issueSession(row.id), user: toSessionUser(row) };
}

export interface SetupInput {
  passphrase: string;
  /** The owner's name. */
  name?: string;
  chiefOfStaff?: { name?: string; passphrase?: string } | null;
  apiKey?: string | null;
  theme?: 'dark' | 'dim' | 'light' | null;
}

export interface SetupResult {
  token: string;
  user: SessionUser;
  chiefOfStaffPersonId: string | null;
  chiefOfStaffUserId: string | null;
  filesFolder: string | null;
}

/**
 * First run: create the keyring with the owner's passphrase, unlock, create
 * the owner row, and optionally the chief of staff (people row of kind
 * chief_of_staff; an editor user when a passphrase was given), the AI key
 * and the theme.
 */
export function setup(input: SetupInput): SetupResult {
  if (isInitialized()) throw new Error('already initialised');
  const givenName = (input.name ?? '').trim();
  const ownerName = givenName || DEFAULT_OWNER_NAME;
  const ownerId = newId();
  createKeyring(config.dataDir, input.passphrase, { userId: ownerId, name: ownerName }).fill(0);
  const { token } = unlock(input.passphrase, ownerId);
  const owner = getUser(ownerId);
  let chiefOfStaffPersonId: string | null = null;
  let chiefOfStaffUserId: string | null = null;
  const cosName = (input.chiefOfStaff?.name ?? '').trim();
  if (cosName) {
    setSetting('patient.chiefOfStaffName', cosName);
    const person = createPerson({ name: cosName, kind: 'chief_of_staff', role: 'Chief of staff' });
    chiefOfStaffPersonId = person.id;
    const cosPass = input.chiefOfStaff?.passphrase ?? '';
    if (cosPass.length >= 8) {
      const u = createUserWithPassphrase({ name: cosName, role: 'editor', passphrase: cosPass }, toSessionUser(owner));
      chiefOfStaffUserId = u.id;
    }
  }
  if (input.apiKey && input.apiKey.trim()) setSetting('ai.apiKey', input.apiKey.trim());
  if (input.theme) setSetting('ui.theme', input.theme);
  // The owner is the patient: a name typed on the setup screen also fills the
  // patient details (the old `{ passphrase }` body leaves them alone).
  try {
    if (givenName && !String(getSetting('patient.name') ?? '').trim()) setSetting('patient.name', givenName);
  } catch {
    // optional
  }
  writeAudit({ userId: owner.id, userName: owner.name, action: 'setup', summary: `case created${cosName ? `; chief of staff ${cosName}${chiefOfStaffUserId ? ' (editor)' : ''}` : ''}${input.apiKey ? '; AI key stored' : ''}` });
  return { token, user: toSessionUser(owner), chiefOfStaffPersonId, chiefOfStaffUserId, filesFolder: filesFolder() };
}

export function lock(): void {
  if (!dek && !isDbOpen()) return;
  log.info('auth', `locked (${sessions.size} session${sessions.size === 1 ? '' : 's'} ended; running work stops and continues at the next unlock)`);
  stopJobWorker();
  closeDatabase();
  setFileKey(null);
  if (dek) dek.fill(0);
  dek = null;
  unlockedAt = null;
  sessions.clear();
  clearSettingsCache();
  clearUsersCache();
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  for (const fn of listeners) fn(false);
}

/** How long past the idle limit running work may hold the lock off with nobody at the screen. */
export const IDLE_HOLD_MAX_MS = 12 * 60 * 60_000;

/** Whether a job is waiting for a worker slot (the worker picks it up within a second). */
function jobQueued(): boolean {
  try {
    return Boolean(db().select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.status, 'queued')).limit(1).get());
  } catch {
    return false;
  }
}

/**
 * The work the idle lock waits for, in words ("1 job running, 1 AI call in
 * progress"), or null when there is none. A queued job counts so that the
 * moment between two jobs of a batch is not mistaken for the end of it.
 */
function activeWork(): string | null {
  const parts: string[] = [];
  const jobs = activeJobCount();
  if (jobs > 0) parts.push(`${jobs} job${jobs === 1 ? '' : 's'} running`);
  else if (jobQueued()) parts.push('a job about to start');
  const calls = aiCallsInFlight();
  if (calls > 0) parts.push(`${calls} AI call${calls === 1 ? '' : 's'} in progress`);
  return parts.length ? parts.join(', ') : null;
}

/** Idle time counts from the later of the last activity and the last AI call returning. */
function idleSince(): number {
  return Math.max(lastActivity, lastAiCallFinishedAt());
}

/**
 * One idle check (the watch runs it every 15 s while unlocked). True when it
 * locked. Running work holds the lock off (see the header), for at most
 * IDLE_HOLD_MAX_MS past the limit, counted from the last person rather than
 * the last AI call so that a long run of calls cannot stretch it.
 */
export function lockIfIdle(now = Date.now()): boolean {
  if (!isUnlocked()) return false;
  const minutes = idleMinutesSetting();
  if (minutes <= 0) return false;
  const limit = minutes * 60_000;
  const pastHold = now - lastActivity > limit + IDLE_HOLD_MAX_MS;
  if (!pastHold && (now - idleSince() <= limit || activeWork())) return false;
  const work = pastHold ? activeWork() : null;
  console.log(work ? `[auth] idle timeout, locking although work is still running (${work})` : '[auth] idle timeout, locking');
  writeAudit({ action: 'lock', summary: work ? `idle timeout: no activity for ${minutes} min; stopped waiting for ${work} after ${Math.round(IDLE_HOLD_MAX_MS / 3_600_000)} h` : `idle timeout: no activity for ${minutes} min` });
  lock();
  return true;
}

function startIdleWatch(): void {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => void lockIfIdle(), 15_000);
  // The watch alone never keeps the process alive (tests, scripts).
  idleTimer.unref?.();
}

// ---------------------------------------------------------------------------
// User management helpers that need the data key (used by routes/users.ts)
// ---------------------------------------------------------------------------

function requireDek(): Buffer {
  if (!dek || !isDbOpen()) throw new LockedError();
  return dek;
}

export function createUserWithPassphrase(input: { name: string; role: Role; passphrase: string }, actor: SessionUser | null): UserRow {
  if (input.passphrase.length < 8) throw new Error('passphrase must be at least 8 characters');
  const row = createUserRow({ name: input.name, role: input.role });
  try {
    addKeyringUser(config.dataDir, requireDek(), { userId: row.id, name: row.name }, input.passphrase);
  } catch (err) {
    removeUserRow(row.id);
    throw err;
  }
  writeAudit({ userId: actor?.id, userName: actor?.name, action: 'user', entityType: 'users', entityId: row.id, summary: `added ${row.name} as ${row.role}` });
  return row;
}

export function updateUser(id: string, patch: { name?: string; role?: Role; disabled?: boolean }, actor: SessionUser | null): UserRow {
  const before = getUser(id);
  const row = updateUserRow(id, patch);
  if (patch.name !== undefined && patch.name !== before.name) renameKeyringUser(config.dataDir, id, row.name);
  if (patch.disabled === true) dropSessionsFor(id);
  const changes: string[] = [];
  if (patch.name !== undefined && patch.name !== before.name) changes.push(`renamed ${before.name} to ${row.name}`);
  if (patch.role !== undefined && patch.role !== before.role) changes.push(`role ${before.role} to ${row.role}`);
  if (patch.disabled !== undefined && patch.disabled !== before.disabled) changes.push(patch.disabled ? 'disabled' : 'enabled');
  if (changes.length) writeAudit({ userId: actor?.id, userName: actor?.name, action: 'user', entityType: 'users', entityId: id, summary: `${row.name}: ${changes.join('; ')}` });
  return row;
}

/** Owner reset: a new passphrase for someone else (or for the owner, without the old one). */
export function resetUserPassphrase(id: string, passphrase: string, actor: SessionUser | null): void {
  const row = getUser(id);
  if (hasKeyringEntry(config.dataDir, id)) setKeyringUserPassphrase(config.dataDir, requireDek(), id, passphrase);
  else addKeyringUser(config.dataDir, requireDek(), { userId: id, name: row.name }, passphrase);
  if (actor?.id !== id) dropSessionsFor(id);
  writeAudit({ userId: actor?.id, userName: actor?.name, action: 'passphrase', entityType: 'users', entityId: id, summary: `passphrase reset for ${row.name}` });
}

/** The caller's own passphrase, after proving the current one. */
export function changeOwnPassphrase(user: SessionUser, current: string, next: string): void {
  unlockKeyringAs(config.dataDir, current, user.id).dek.fill(0);
  setKeyringUserPassphrase(config.dataDir, requireDek(), user.id, next);
  writeAudit({ userId: user.id, userName: user.name, action: 'passphrase', entityType: 'users', entityId: user.id, summary: 'changed own passphrase' });
}

/** Removes the wrap and the row; the data is untouched. */
export function removeUser(id: string, actor: SessionUser | null): UserRow {
  if (actor && actor.id === id) throw new Error('you cannot remove yourself');
  const row = getUser(id);
  if (row.role === 'owner' && countOwners() <= 1) throw new Error('the last owner cannot be removed');
  removeKeyringUser(config.dataDir, id);
  removeUserRow(id);
  dropSessionsFor(id);
  writeAudit({ userId: actor?.id, userName: actor?.name, action: 'user', entityType: 'users', entityId: id, summary: `removed ${row.name} (${row.role}); data untouched` });
  return row;
}

/** Drop every session of a user (after a disable, a removal or a reset by the owner). */
function dropSessionsFor(userId: string): void {
  for (const [token, s] of sessions) {
    if (s.userId === userId) sessions.delete(token);
  }
}

// ---------------------------------------------------------------------------
// Status and middleware
// ---------------------------------------------------------------------------

export interface AuthStatus {
  initialized: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
  idleMinutes: number;
  /**
   * Set while the idle lock waits for work (a running or queued job, an AI
   * call in progress): "locks after the current work finishes (...)". Null
   * when nothing holds it, when the lock is off, or while locked.
   */
  idleHeld: string | null;
  session: boolean;
  user: SessionUser | null;
  /** Names on the lock screen; empty for a version 1 keyring. */
  users: Array<{ id: string; name: string }>;
  lan: { enabled: boolean; host: string; active: boolean; port: number | null } | null;
  /** The Files folder next to the app (first-run import); only with a session, never when hosted. */
  filesFolder: string | null;
  /** CASEFILE_HOSTED=1: the server is on the internet (Railway). Hosted, `users` is empty without a session, `lan` and `filesFolder` are null. */
  hosted: boolean;
  /** Hosted: setup and restore need the setup code (CASEFILE_SETUP_TOKEN). */
  setupTokenRequired: boolean;
  /** Hosted and no setup code is configured on the server: setup and restore are refused until it is. */
  setupTokenMissing: boolean;
  /** The restore from a backup in progress, or the last one since the server started. */
  restore: RestoreProgress | null;
}

export function statusPayload(user: SessionUser | null = null, session = false): AuthStatus {
  let idleMinutes = 30;
  let idleHeld: string | null = null;
  let lan: AuthStatus['lan'] = null;
  if (isUnlocked()) {
    idleMinutes = idleMinutesSetting();
    const work = idleMinutes > 0 ? activeWork() : null;
    if (work) idleHeld = `locks after the current work finishes (${work})`;
    try {
      // Hosted there is no LAN listener, so nothing to say about it.
      if (!config.hosted) lan = { enabled: Boolean(getSetting('access.lan')), host: String(getSetting('access.lanHost') || '0.0.0.0'), active: lanState.active, port: lanState.port };
    } catch {
      // ignore
    }
  }
  return {
    initialized: isInitialized(),
    unlocked: isUnlocked(),
    unlockedAt,
    idleMinutes,
    idleHeld,
    session,
    user,
    // Hosted, the names of the people with access are not shown to whoever opens the address; the lock screen then
    // asks for a passphrase only (unlock without a userId tries every person's).
    users: config.hosted && !session ? [] : listKeyringUsers(config.dataDir).map((u) => ({ id: u.userId, name: u.name })),
    lan,
    filesFolder: session ? filesFolder() : null,
    hosted: config.hosted,
    setupTokenRequired: config.hosted,
    setupTokenMissing: config.hosted && !setupTokenConfigured(),
    restore: restoreProgress(),
  };
}

function sessionUserFor(c: Context): { token: string; user: UserRow } | null {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const row = getUserCached(s.userId);
  if (!row || row.disabled) {
    sessions.delete(token);
    return null;
  }
  return { token, user: row };
}

/** The user behind the request's session, or null. */
export function currentUser(c: Context): SessionUser | null {
  const fromCtx = (c.get as (k: string) => unknown)('user') as SessionUser | undefined;
  if (fromCtx) return fromCtx;
  if (!isUnlocked()) return null;
  const s = sessionUserFor(c);
  return s ? toSessionUser(s.user) : null;
}

function readMethod(m: string): boolean {
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // "null" (sandboxed frames, file://) or garbage
  }
}

/**
 * Mounted on /api/* before every route, /api/auth included. Refuses a
 * state-changing request that the browser marks as coming from another
 * origin (Sec-Fetch-Site other than same-origin), or, from a browser too old
 * to send that header, whose Origin is not the host it was sent to. The app
 * only ever calls its own origin (in development Vite proxies /api and keeps
 * the Host header), so such a request can only be another web page trying
 * to lock the case, run setup or try passphrases through the user's
 * browser; the SameSite cookie does not help with endpoints that need no
 * cookie. Requests without these headers (curl, scripts) pass and still
 * need a session like any other.
 */
export const rejectCrossSiteWrites: MiddlewareHandler = async (c, next) => {
  if (readMethod(c.req.method.toUpperCase())) return next();
  const site = c.req.header('sec-fetch-site');
  const origin = c.req.header('origin');
  // Hosted behind Railway's proxy the Host header is the public domain; the proxy's X-Forwarded-Host and the
  // domain Railway names (RAILWAY_PUBLIC_DOMAIN) count as this site too, should the Host ever be rewritten.
  const hosts = [c.req.header('host')];
  if (config.hosted) hosts.push(c.req.header('x-forwarded-host')?.split(',')[0]?.trim(), process.env.RAILWAY_PUBLIC_DOMAIN?.trim());
  const foreign = site ? site !== 'same-origin' && site !== 'none' : origin !== undefined && !hosts.some((h) => h && originMatchesHost(origin, h));
  if (foreign) return c.json({ error: 'cross-site request refused' }, 403);
  return next();
};

/** What the policy wants recorded once a request succeeded. */
function auditForRequest(user: SessionUser, method: string, apiPath: string, settingsKeys: string[] | null): Parameters<typeof writeAudit>[0] | null {
  const base = { userId: user.id, userName: user.name };
  if (method === 'PATCH' && apiPath === '/settings') return { ...base, action: 'settings', entityType: 'settings', summary: settingsKeys?.length ? `changed ${settingsKeys.join(', ')}` : 'changed settings' };
  if (method === 'POST' && apiPath === '/export/packets') return { ...base, action: 'export', entityType: 'packet', summary: 'packet export started' };
  const dl = /^\/export\/packets\/([^/]+)\/file$/.exec(apiPath);
  if (method === 'GET' && dl) return { ...base, action: 'export', entityType: 'packet', entityId: dl[1], summary: 'packet downloaded' };
  if (method === 'GET' && /\/ics$/.test(apiPath)) return { ...base, action: 'export', entityType: 'ics', summary: `calendar exported: ${apiPath}` };
  const purge = /^\/documents\/([^/]+)\/purge$/.exec(apiPath);
  if (method === 'POST' && purge) return { ...base, action: 'purge', entityType: 'documents', entityId: purge[1], summary: 'document purged' };
  if (user.role !== 'owner' && !readMethod(method)) {
    const action = auditActionFor(method);
    if (!action) return null;
    const { entityType, entityId } = entityFromPath(apiPath);
    return { ...base, action, entityType, entityId, summary: `${method} ${apiPath}` };
  }
  return null;
}

/** What a create's audit row records: the entity id, and how its summary ends. */
export interface CreatedEntity {
  /** The one entity created; null when a list response created several. */
  id: string | null;
  /** The id, or "3 created, first <id>" for several. */
  label: string;
}

function pickId(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
}

function idOf(v: unknown): string | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? pickId((v as Record<string, unknown>).id) : null;
}

/**
 * What a create's JSON response says it created: `id`, else `item.id`, else
 * `run.id` (findings runs), else the ids in `items` (document and inbox
 * uploads). A single item gives its id; several leave the entity id empty
 * and name the first id with a count. Null when the body names no id.
 */
export function createdEntityFromBody(body: unknown): CreatedEntity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const direct = pickId(b.id) ?? idOf(b.item) ?? idOf(b.run);
  if (direct) return { id: direct, label: direct };
  if (!Array.isArray(b.items)) return null;
  const ids = b.items.map(idOf).filter((v): v is string => v !== null);
  if (!ids.length) return null;
  if (ids.length === 1 && b.items.length === 1) return { id: ids[0], label: ids[0] };
  return { id: null, label: `${b.items.length} created, first ${ids[0]}` };
}

/**
 * The id a create made: what the handler set with c.set('auditEntityId', id),
 * else what the JSON response body names (createdEntityFromBody). Null when
 * neither exists.
 */
async function createdEntityId(c: Context): Promise<CreatedEntity | null> {
  const explicit = pickId((c.get as (k: string) => unknown)('auditEntityId'));
  if (explicit) return { id: explicit, label: explicit };
  if (!(c.res.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    return createdEntityFromBody(await c.res.clone().json());
  } catch {
    return null;
  }
}

/** Middleware for every /api route except /api/auth. */
export const requireUnlocked: MiddlewareHandler = async (c, next) => {
  if (!isUnlocked()) return c.json({ error: 'locked', ...statusPayload() }, 423);
  const s = sessionUserFor(c);
  if (!s) return c.json({ error: 'no session', ...statusPayload() }, 401);
  const user = toSessionUser(s.user);
  const method = c.req.method.toUpperCase();
  const apiPath = c.req.path.startsWith('/api/') ? c.req.path.slice(4) : c.req.path;
  if (countsAsActivity(method, c.req.header(ACTIVITY_HEADER))) touch();
  let settingsKeys: string[] | null = null;
  if (method === 'PATCH' && apiPath === '/settings') {
    const body = await c.req.json().catch(() => null);
    settingsKeys = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>) : [];
  }
  const decision = authorize({ role: user.role, method, path: apiPath, settingsKeys });
  if (!decision.ok) return c.json({ error: user.role, role: user.role, detail: decision.reason ?? 'not allowed for this role' }, 403);
  (c.set as (k: string, v: unknown) => void)('user', user);
  try {
    await next();
  } catch (err) {
    if (err instanceof LockedError) return c.json({ error: 'locked', ...statusPayload() }, 423);
    throw err;
  }
  if (c.res.status < 400 && isUnlocked()) {
    const row = auditForRequest(user, method, apiPath, settingsKeys);
    if (row) {
      if (method === 'POST' && !row.entityId) {
        const created = await createdEntityId(c);
        if (created) {
          if (created.id) row.entityId = created.id;
          row.summary = `${row.summary ?? `${method} ${apiPath}`} -> ${created.label}`;
        }
      }
      writeAudit(row);
    }
  }
};

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', secure: secureCookie(c) });
}

function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE, { path: '/', secure: secureCookie(c) });
}

// ---------------------------------------------------------------------------
// Passphrase throttling (hosted): unlock, setup and restore share one count
// per client address and a global cap (util/throttle.ts). Locally there is
// none (the 400 ms pause after a wrong passphrase stays, as before).
// ---------------------------------------------------------------------------

export const authThrottle = new Throttle();
const throttleSalt = randomBytes(16);

/** A short stand-in for a client address in the log: enough to tell tries apart, nothing to identify anyone. */
function clientTag(addr: string): string {
  return createHash('sha256').update(throttleSalt).update(addr).digest('hex').slice(0, 8);
}

function throttled(c: Context, v: ThrottleVerdict): Response {
  c.header('Retry-After', String(v.retryAfterSeconds));
  return c.json({ error: `Too many wrong tries. ${waitWords(v.retryAfterSeconds)} and try again.`, code: 'throttled', retryAfterSeconds: v.retryAfterSeconds }, 429);
}

/** Hosted: a 429 response when the client may not try now, else null. */
function throttleGate(c: Context, what: string): Response | null {
  if (!config.hosted) return null;
  const addr = clientAddress(c);
  const v = authThrottle.check(addr);
  if (v.ok) return null;
  log.warn('auth', `${what} refused: too many failures (${v.scope === 'global' ? 'all clients' : `client ${clientTag(addr)}`}), retry after ${v.retryAfterSeconds} s`);
  return throttled(c, v);
}

/** Hosted: count a failure (never the passphrase or code itself in the log). */
function throttleFailure(c: Context, what: string): void {
  if (!config.hosted) return;
  const addr = clientAddress(c);
  const n = authThrottle.failure(addr);
  log.warn('auth', `${what} (client ${clientTag(addr)}: ${n.client} in the last 15 minutes; all clients: ${n.global})`);
}

function throttleSuccess(c: Context): void {
  if (config.hosted) authThrottle.success(clientAddress(c));
}

/** Hosted: the setup code from the header or the body; a 401/403 response when it is missing or wrong, else null. */
function setupTokenGate(c: Context, fromBody: string | null | undefined, what: string): Response | null {
  const check = checkSetupToken(c.req.header(SETUP_TOKEN_HEADER) ?? fromBody ?? null);
  if (check.ok) return null;
  if (check.code === 'setup_token') throttleFailure(c, `${what}: wrong setup code`);
  else log.warn('auth', `${what} refused: CASEFILE_SETUP_TOKEN is not set on the server`);
  return c.json({ error: check.error, code: check.code }, check.status);
}

/** The uploaded file's name from x-casefile-filename (URI-encoded), or null. */
function uploadName(c: Context): string | null {
  const raw = c.req.header('x-casefile-filename');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch {
    return null;
  }
}

/** The gates every restore route passes first, in this order: too many wrong tries, the setup code, a case already there. */
function restoreGates(c: Context): Response | null {
  const gate = throttleGate(c, 'restore');
  if (gate) return gate;
  const denied = setupTokenGate(c, null, 'restore');
  if (denied) return denied;
  if (isInitialized()) return c.json({ error: 'This server already holds a case, so nothing was restored. A backup can only be restored onto an empty server.', code: 'initialised' }, 409);
  return null;
}

/** A RestoreError as its plain sentence and code (and, for an upload in pieces, the bytes the server holds). */
function restoreRefusal(c: Context, err: unknown): Response {
  if (!(err instanceof RestoreError)) throw err;
  return c.json({ error: err.message, code: err.code, ...(err.received !== undefined ? { received: err.received } : {}) }, err.status);
}

const passBody = z.object({ passphrase: z.string().min(1).max(1024), userId: z.string().max(64).optional().nullable() });

const setupBody = z.object({
  passphrase: z.string().min(1).max(1024),
  name: z.string().trim().max(120).optional(),
  chiefOfStaff: z
    .object({ name: z.string().trim().max(120).optional(), passphrase: z.string().max(1024).optional() })
    .optional()
    .nullable(),
  apiKey: z.string().max(400).optional().nullable(),
  theme: z.enum(['dark', 'dim', 'light']).optional().nullable(),
  /** Hosted: the setup code (CASEFILE_SETUP_TOKEN); the x-casefile-setup-token header works too. Ignored locally. */
  setupToken: z.string().max(400).optional().nullable(),
});

export { ROLES };

export const authRoutes = new Hono()
  .get('/status', (c) => {
    const s = isUnlocked() ? sessionUserFor(c) : null;
    return c.json(statusPayload(s ? toSessionUser(s.user) : null, Boolean(s)));
  })
  .post('/setup', async (c) => {
    const gate = throttleGate(c, 'setup');
    if (gate) return gate;
    const raw: unknown = await c.req.json().catch(() => ({}));
    const given = raw && typeof raw === 'object' ? (raw as { setupToken?: unknown }).setupToken : undefined;
    const denied = setupTokenGate(c, typeof given === 'string' ? given : null, 'setup');
    if (denied) return denied;
    const body = setupBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'passphrase required' }, 400);
    if (isInitialized()) return c.json({ error: 'already initialised' }, 409);
    if (restoreBusy()) return c.json({ error: 'A restore from a backup is running; wait for it to finish.', code: 'busy' }, 409);
    if (body.data.passphrase.length < 8) return c.json({ error: 'passphrase must be at least 8 characters' }, 400);
    const cosPass = body.data.chiefOfStaff?.passphrase ?? '';
    if (cosPass && cosPass.length < 8) return c.json({ error: 'the chief of staff passphrase must be at least 8 characters' }, 400);
    const { setupToken: _code, ...input } = body.data;
    // A backup upload that stopped part-way leaves its staging folder in the data folder; the new case does not need it.
    removeLeftoverUploads();
    const r = setup(input);
    throttleSuccess(c);
    log.info('auth', 'case set up (a new keyring and database were made)');
    setSessionCookie(c, r.token);
    return c.json({ ...statusPayload(r.user, true), chiefOfStaffPersonId: r.chiefOfStaffPersonId, chiefOfStaffUserId: r.chiefOfStaffUserId, filesFolder: r.filesFolder });
  })
  /**
   * Restore a backup zip onto a server that holds no case (services/restore-upload.ts), in one request: the body is
   * the zip itself (not multipart), at most 4 GB; hosted it needs the setup code in x-casefile-setup-token. Answers
   * when the restore is done; GET /status shows `restore` meanwhile. The user then unlocks with the backup's
   * passphrase. For scripts and small backups (Railway cuts a body that takes over 5 minutes; the setup screen sends
   * pieces, below). A JSON body is refused after the gates, which the setup screen uses to ask before sending.
   */
  .post('/restore', async (c) => {
    const refused = restoreGates(c);
    if (refused) return refused;
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (type.startsWith('multipart/') || type.startsWith('application/json') || type.startsWith('text/')) {
      return c.json({ error: 'Send the backup zip itself as the body of the request (not a form).', code: 'empty_body' }, 400);
    }
    const len = Number(c.req.header('content-length'));
    try {
      const r = await restoreFromUpload(c.req.raw.body, { totalBytes: Number.isFinite(len) && len >= 0 && c.req.header('content-length') ? len : null, fileName: uploadName(c), isInitialized });
      throttleSuccess(c);
      return c.json({ ok: true, files: r.files, bytes: r.bytes, keptAs: r.keptAs, ...statusPayload() });
    } catch (err) {
      return restoreRefusal(c, err);
    }
  })
  /**
   * Restore in pieces (services/restore-upload.ts), what the setup screen uses: Railway ends a request whose body takes
   * longer than 5 minutes to arrive, so a large backup cannot go in one request. GET ?id= says how much of upload `id`
   * the server holds ({received, total}); POST appends one piece (the body, at most 64 MB) at x-casefile-offset of a
   * backup of x-casefile-total bytes, the upload's id in x-casefile-upload-id, and a 409 carries `received` to carry
   * on from; POST /restore/finish {id} checks, unpacks and places it. Hosted, each needs the setup code.
   */
  .get('/restore/chunk', (c) => {
    const refused = restoreGates(c);
    if (refused) return refused;
    try {
      return c.json(piecesState({ id: c.req.query('id') ?? '', isInitialized }));
    } catch (err) {
      return restoreRefusal(c, err);
    }
  })
  .post('/restore/chunk', async (c) => {
    const refused = restoreGates(c);
    if (refused) return refused;
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (type.startsWith('multipart/') || type.startsWith('application/json') || type.startsWith('text/')) {
      return c.json({ error: 'Send the piece of the backup itself as the body of the request (not a form).', code: 'empty_body' }, 400);
    }
    const whole = (name: string): number => {
      const v = c.req.header(name)?.trim() ?? '';
      return /^\d{1,16}$/.test(v) ? Number(v) : Number.NaN;
    };
    try {
      const r = await receivePiece(c.req.raw.body, { id: c.req.header('x-casefile-upload-id') ?? '', offset: whole('x-casefile-offset'), total: whole('x-casefile-total'), fileName: uploadName(c), isInitialized });
      return c.json({ ok: true, ...r });
    } catch (err) {
      return restoreRefusal(c, err);
    }
  })
  .post('/restore/finish', async (c) => {
    const refused = restoreGates(c);
    if (refused) return refused;
    const body = z.object({ id: z.string().max(100) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'The request names no upload.', code: 'bad_request' }, 400);
    try {
      const r = await finishPieces({ id: body.data.id, isInitialized });
      throttleSuccess(c);
      return c.json({ ok: true, files: r.files, bytes: r.bytes, keptAs: r.keptAs, ...statusPayload() });
    } catch (err) {
      return restoreRefusal(c, err);
    }
  })
  .post('/unlock', async (c) => {
    const gate = throttleGate(c, 'unlock');
    if (gate) return gate;
    const body = passBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'passphrase required' }, 400);
    if (!isInitialized()) return c.json({ error: 'not initialised' }, 409);
    try {
      const r = unlock(body.data.passphrase, body.data.userId ?? null);
      throttleSuccess(c);
      setSessionCookie(c, r.token);
      return c.json(statusPayload(r.user, true));
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        throttleFailure(c, 'unlock: wrong passphrase');
        await new Promise((r) => setTimeout(r, 400));
        return c.json({ error: 'wrong passphrase' }, 401);
      }
      if (err instanceof DisabledUserError) {
        throttleFailure(c, 'unlock: access disabled for that person');
        await new Promise((r) => setTimeout(r, 400));
        return c.json({ error: err.message }, 403);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/not a database/i.test(msg)) {
        throttleFailure(c, 'unlock: the database did not open with that passphrase');
        return c.json({ error: 'wrong passphrase' }, 401);
      }
      log.error('auth', `unlock failed: ${describeError(err)}`);
      return c.json({ error: msg }, 500);
    }
  })
  .post('/lock', (c) => {
    // Locking ends every session and stops running work, so it needs one of
    // them; while already locked it stays a harmless no-op.
    if (isUnlocked()) {
      const s = sessionUserFor(c);
      if (!s) return c.json({ error: 'no session', ...statusPayload() }, 401);
      writeAudit({ userId: s.user.id, userName: s.user.name, action: 'lock', summary: `locked by ${s.user.name} (${asRole(s.user.role)})` });
    }
    lock();
    clearSessionCookie(c);
    return c.json(statusPayload());
  })
  .post('/change-passphrase', async (c) => {
    if (!isUnlocked()) return c.json({ error: 'locked' }, 423);
    const s = sessionUserFor(c);
    if (!s) return c.json({ error: 'no session' }, 401);
    const body = z.object({ current: z.string().min(1), next: z.string().min(8) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'current and next (8+ chars) required' }, 400);
    try {
      changeOwnPassphrase(toSessionUser(s.user), body.data.current, body.data.next);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof WrongPassphraseError) return c.json({ error: 'current passphrase is wrong' }, 401);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
