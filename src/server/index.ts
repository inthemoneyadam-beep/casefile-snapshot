/**
 * Casefile API server. One process. Locally it is bound to 127.0.0.1; hosted (CASEFILE_HOSTED=1, Railway;
 * docs/DEPLOY.md) it listens on CASEFILE_HOST (0.0.0.0) and Railway's PORT, refuses to start when the case
 * would not live on the volume (config.ts hostedProblems), and logs one line per event for `railway logs`
 * (util/log.ts). In production it also serves the built client from dist/. In development Vite proxies /api here.
 * The HTTP app itself is built in app.ts.
 *
 * Optional LAN access (local only): the settings `access.lan` and `access.lanHost` live
 * inside the encrypted database, so they are read right after the first
 * unlock; when `access.lan` is on, a second listener is started on the LAN
 * host (same port). Every request there needs a user login like any other.
 * Changing the setting takes effect on the next start. Hosted there is no LAN listener.
 */
import fs from 'node:fs';
import { reindexImagingSearch } from './services/imaging';
import { reindexMedicationsSearch } from './services/medications';
import { reindexEncountersSearch } from './services/encounters';
import { reindexFindingsSearch } from './services/findings';
import { reindexFactNotesSearch } from './services/facts';
import { autoSortTick, medNamesCleanupV1, quietChecksMigration } from './services/filing';
import { reconcileAfterUnlock } from './services/reconcile';
import { labParseBackfill, recordReconcileAfterReread } from './services/lab-backfill';
import { runLabChecks } from './services/lab-rules';
import { ingestAfterUnlock } from './services/reprocess';
import { labCheckAfterUnlock, sweepWords } from './services/lab-check';
import { repairStampDates } from './services/date-repair';
import { patientCheckAfterUnlock } from './services/patient-check';
import { selfCheckSince } from './services/self-check';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { appVersion, config, ensureDirs, hostedProblems, isInside, projectRoot, volumeMountPath, writableProblem } from './config';
import { lock, onLockChange, setLanState, isUnlocked } from './auth';
import { registerAllJobHandlers } from './jobs/handlers';
import { getSetting } from './services/settings';
import { APP_NAME } from '../shared/constants';
import { buildApp } from './app';
import { describeError, log, logLevel } from './util/log';
import { findBrowserExecutable } from './export/pdf';
import { setupTokenConfigured } from './security';

// Hosted: a start that would put the case where the next deploy loses it, or that cannot write it, stops here.
if (config.hosted) {
  process.on('uncaughtException', (err) => {
    log.error('process', `uncaught exception: ${describeError(err)}`);
    try {
      lock();
    } catch {
      // ignore
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('process', `unhandled rejection: ${describeError(reason)}`);
    try {
      lock();
    } catch {
      // ignore
    }
    process.exit(1);
  });
  const problems = hostedProblems();
  if (!problems.length) {
    for (const d of [config.dataDir, config.backupsDir]) {
      const p = writableProblem(d);
      if (p) problems.push(p);
    }
  }
  if (problems.length) {
    for (const p of problems) log.error('startup', `${APP_NAME} did not start: ${p}`);
    process.exit(1);
  }
}

ensureDirs();
registerAllJobHandlers();

const app = buildApp();

/** The startup line(s): what runs where, never anything from the case. */
function logStartup(address: string, port: number): void {
  if (!config.hosted) {
    console.log(`${APP_NAME} API listening on http://${address}:${port} (data: ${path.relative(projectRoot, config.dataDir) || '.'})`);
    return;
  }
  const vol = volumeMountPath();
  const where = (d: string) => (vol ? (isInside(vol, d) ? 'on the volume' : 'NOT on the volume') : 'no volume attached');
  const browser = findBrowserExecutable();
  log.info(
    'startup',
    `${APP_NAME} hosted, version ${appVersion()}, Node ${process.version}, listening on ${address}:${port}; data ${config.dataDir} (${where(config.dataDir)}), backups ${config.backupsDir} (${where(config.backupsDir)}); time zone ${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone}; log level ${logLevel()}`,
  );
  log.info(
    'startup',
    `setup code ${setupTokenConfigured() ? 'configured' : 'NOT configured (setup and restore are refused)'}; packets ${browser ? `print with ${browser}` : 'have no browser (stored as HTML)'}; client ${fs.existsSync(path.join(config.distDir, 'index.html')) ? 'built' : 'NOT built (API only)'}; the case is locked until someone unlocks it`,
  );
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logStartup(info.address, info.port);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    if (config.hosted) {
      log.error('startup', `could not listen on ${config.host}:${config.port}: the port is in use`);
      process.exit(1);
    }
    // Said plainly: an older copy keeps the new one from starting, and the new screens would talk to the old server.
    console.error(`
${APP_NAME} could not start: another copy is already running on port ${config.port}.
Close every CaseFile window, then start it once more.
`);
    process.exit(1);
  }
  throw err;
});

// --- Optional LAN listener (read from settings after the first unlock) -----
let lanServer: ReturnType<typeof serve> | null = null;
let lanChecked = false;

function startLanIfEnabled(): void {
  if (lanChecked) return;
  lanChecked = true;
  // Hosted, the server already listens on every interface behind Railway's proxy; there is no LAN listener.
  if (config.hosted) return;
  let enabled = false;
  let host = '0.0.0.0';
  try {
    enabled = Boolean(getSetting('access.lan'));
    host = String(getSetting('access.lanHost') || '0.0.0.0').trim() || '0.0.0.0';
  } catch (err) {
    console.error('[access] could not read the LAN setting', err instanceof Error ? err.message : err);
    return;
  }
  if (!enabled) {
    console.log('[access] local network access is off (Settings, People with access); listening on 127.0.0.1 only');
    return;
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    console.log(`[access] access.lan is on but access.lanHost is ${host}; nothing else to bind`);
    return;
  }
  try {
    const s = serve({ fetch: app.fetch, hostname: host, port: config.port }, (info) => {
      setLanState({ active: true, host: info.address, port: info.port });
      console.log(`[access] REACHABLE ON THE LOCAL NETWORK at http://${info.address}:${info.port} (every request needs a user login; trusted home network only, no HTTPS; use a VPN such as Tailscale for remote access)`);
    });
    s.on('error', (err: NodeJS.ErrnoException) => {
      setLanState({ active: false, host, port: config.port });
      console.error(`[access] could not listen on ${host}:${config.port}: ${err.code ?? err.message}. The app stays reachable on 127.0.0.1 only.`);
      lanServer = null;
    });
    lanServer = s;
  } catch (err) {
    setLanState({ active: false, host, port: config.port });
    console.error('[access] LAN listener failed', err instanceof Error ? err.message : err);
  }
}

onLockChange((unlocked) => {
  if (unlocked) startLanIfEnabled();
});

// Automatic sorting: a little after each unlock, then every few minutes while unlocked, anything not yet named and
// filed is sorted without the user having to ask (documents added while the API key was failing, for instance).
// After each unlock, in this order: the one-time quiet-checks and medication-names cleanups, the one-time re-read of
// lab values and the one-time repair of dates printed with a time (each settled by a setting, so each runs once); the
// stopped readings carried on (started here, not awaited: ingestAfterUnlock); the sorting; one full reconciliation pass
// so every detail's trust and the Reconciliation counts are current; then the lab checks (rules 10 and 12).
let autoSortTimer: ReturnType<typeof setTimeout> | null = null;
function runAutoSort(): void {
  if (!isUnlocked()) return;
  try {
    const r = autoSortTick();
    if (r.filed || r.queued) console.log(`[filing] sorted automatically: ${r.queued} queued for Claude, ${r.filed} placement${r.filed === 1 ? '' : 's'} filed`);
  } catch (err) {
    console.warn(`[filing] automatic sorting: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function runAfterUnlock(): void {
  if (!isUnlocked()) return;
  // The wrong-patient guard (2026-10-09), first: once per change of Patient details, every document is checked for
  // someone else's name before anything below reads, resumes or checks it (no AI; never throws).
  patientCheckAfterUnlock(isUnlocked);
  try {
    quietChecksMigration();
  } catch (err) {
    console.warn(`[filing] quiet checks cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }
  // One-time: medications made from a list heading ("current working list") are taken back (settled by a setting).
  try {
    medNamesCleanupV1();
  } catch (err) {
    console.warn(`[filing] medication names cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }
  // One-time (2026-10): every lab value re-read from the text as printed; the new lab columns filled, never a value the
  // user entered (settled by a setting; it logs and never throws, a failure retries at the next unlock).
  try {
    labParseBackfill();
  } catch (err) {
    console.warn(`[labs] values re-read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // One-time (2026-10-07): dates printed as a day and a time ("07/14/30 2215") read as that day, not a year; only the
  // derived date columns change, the text as written stays (settled by a setting).
  try {
    const r = repairStampDates();
    if (r?.total) console.log(`[dates] ${r.total} date${r.total === 1 ? '' : 's'} printed with a time now read as their day`);
  } catch (err) {
    console.warn(`[dates] stamp dates: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Readings stopped part-way (2026-10-07, large exports; findings D.5 steps 4-7). The evidence and the repair (steps
  // 2-3) already ran inside the unlock, before the job worker started (auth.ts repairAfterUnlock). Here: coverage for
  // documents read before segments existed, segmentation for every document without segments (behind uploads), the
  // communications side's after-unlock hook, then each stopped reading carries on by itself, one document at a time,
  // when what is left costs at most ai.autoResumeCeilingUsd; above it Claude asks once.
  void ingestAfterUnlock(isUnlocked)
    .then((r) => {
      const asked = r.resumed.filter((x) => x.decision === 'ask').length;
      const going = r.resumed.length - asked;
      if (r.legacyCoverage || r.segmentationQueued || r.resumed.length) {
        console.log(`[extraction] after unlock: coverage worked out for ${r.legacyCoverage} documents, ${r.segmentationQueued} queued to be cut into parts, ${going} readings carrying on, ${asked} waiting for a yes`);
      }
    })
    .catch((err) => console.warn(`[extraction] after unlock: ${err instanceof Error ? err.message : String(err)}`))
    // Once (setting migration.labCheckV1, by version; 2026-10-08): the lab check of every document already read, after
    // the coverage above is worked out. No AI here: a page with lab lines no detail holds is read again by a queued job
    // of small calls under ai.autoResumeCeilingUsd (and, for this sweep, that limit in all), else Claude asks once; lines
    // already read again are added from the page. A document being read is checked when its reading ends. Every unlock
    // first settles a lab-check re-read that ended without its pass (cancelled, lost), so none reads "being read again"
    // for good (2026-10-09). Version 2002 (2026-10-09, lab recall): a document the old guard left alone is checked again.
    .then(() => (isUnlocked() ? labCheckAfterUnlock(isUnlocked) : null))
    .then((r) => {
      if (r && (r.missed || r.rereads || r.added || r.asked)) console.log(`[labs] lab check after unlock: ${sweepWords(r)}`);
    })
    .catch((err) => console.warn(`[labs] lab check after unlock: ${err instanceof Error ? err.message : String(err)}`));
  runAutoSort();
  if (!isUnlocked()) return;
  try {
    const r = reconcileAfterUnlock();
    if (r && (r.copies || r.conflicts || r.repointed || r.undone)) console.log(`[reconcile] after unlock: ${r.copies} matching, ${r.conflicts} disagreeing, ${r.repointed} re-pointed, ${r.undone} put back`);
    // The first pass after the re-read: its counts join the re-read's report once (never throws).
    recordReconcileAfterReread(r);
  } catch (err) {
    console.warn(`[reconcile] after unlock: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isUnlocked()) return;
  // Rules 10 and 12 (2026-10): lab values one document gives twice like a typing error, and a summary's judgement or
  // limit that differs from the lab report's, stored as findings; ones that no longer hold are cleared.
  try {
    const r = runLabChecks({ trigger: 'unlock' });
    if (r.created || r.retired) console.log(`[labs] checks after unlock: ${r.created} new finding${r.created === 1 ? '' : 's'}, ${r.retired} cleared`);
  } catch (err) {
    console.warn(`[labs] checks after unlock: ${err instanceof Error ? err.message : String(err)}`);
  }
}
onLockChange((unlocked) => {
  if (autoSortTimer) clearTimeout(autoSortTimer);
  autoSortTimer = unlocked ? setTimeout(runAfterUnlock, 8000) : null;
});
setInterval(runAutoSort, 5 * 60 * 1000).unref();

// Notes became searchable on 2026-10-05: entries written before that are rebuilt once per unlock (small tables, fast).
onLockChange((unlocked) => {
  if (!unlocked) return;
  setTimeout(() => {
    if (!isUnlocked()) return;
    try {
      const n = reindexImagingSearch() + reindexMedicationsSearch() + reindexEncountersSearch() + reindexFindingsSearch() + reindexFactNotesSearch();
      if (n) console.log(`[search] notes indexed for ${n} item${n === 1 ? '' : 's'}`);
    } catch (err) {
      console.warn(`[search] could not refresh the notes index: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 3000);
});

// Checked against itself (2026-10-09, services/self-check.ts): the moment it first ran is kept (setting selfCheck.since)
// at once on unlock, before any upload can arrive, so every document added from then on is checked by itself.
onLockChange((unlocked) => {
  if (!unlocked) return;
  try {
    selfCheckSince();
  } catch (err) {
    console.warn(`[self-check] could not note when the check began: ${err instanceof Error ? err.message : String(err)}`);
  }
});

function shutdown(signal: string): void {
  if (config.hosted) log.info('shutdown', `${signal}: locking the case and stopping (a redeploy or restart locks the app; unlock again when it is back)`);
  else console.log('shutting down');
  try {
    lock();
  } catch {
    // ignore
  }
  server.close();
  lanServer?.close();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
