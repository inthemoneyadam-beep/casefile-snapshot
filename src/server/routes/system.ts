import { Hono } from 'hono';
import { passSetAsideSql, reconciledPairSql } from '../services/reconcile';
import { sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../config';
import { db, checkpoint } from '../db';
import { backupFilePath, createBackupZip, isBackupName, listBackups } from '../services/backup';
import { badRequest, notFound } from '../util/errors';
import { log } from '../util/log';
import { inferGaps } from '../services/records';
import { APP_NAME } from '../../shared/constants';
import { todayIso } from '../../shared/dates';

export const systemRoutes = new Hono()
  .get('/info', (c) => {
    const counts = db().all<{ name: string; n: number }>(sql`
      select 'documents' as name, count(*) as n from documents where deleted_at is null
      union all select 'facts', count(*) from facts where deleted_at is null
      union all select 'people', count(*) from people where deleted_at is null
      union all select 'communications', count(*) from communications where deleted_at is null
      union all select 'records', count(*) from records_inventory where deleted_at is null
      union all select 'tasks', count(*) from tasks where deleted_at is null
      union all select 'findings', count(*) from findings where deleted_at is null
    `);
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(`${config.dataDir}/casefile.db`).size;
    } catch {
      // not yet
    }
    return c.json({ app: APP_NAME, dataDir: config.dataDir, backupsDir: config.backupsDir, dbBytes, counts: Object.fromEntries(counts.map((r) => [r.name, r.n])) });
  })
  /** The working view: what is due, promised, upcoming, and waiting on a verdict. */
  .get('/today', (c) => {
    const d = db();
    const today = todayIso();
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 14);
    const soon = todayIso(horizon);
    const tasksDue = d.all<{ id: string; title: string; dueAt: string | null; owner: string; ownerName: string | null; status: string; priority: string }>(sql`
      select id, title, due_at as dueAt, owner, (select p.name from people p where p.id = tasks.owner_person_id) as ownerName, status, priority from tasks
      where deleted_at is null and status in ('open','in_progress') and due_at is not null and due_at <= ${soon}
      order by due_at asc limit 30
    `);
    const followUpsDue = d.all<{ id: string; subject: string; followUpPromised: string | null; followUpDue: string | null; withWhom: string }>(sql`
      select c.id, c.subject, c.follow_up_promised as followUpPromised, c.follow_up_due as followUpDue,
        coalesce((select group_concat(p.name, ', ') from communication_participants cp join people p on p.id = cp.person_id where cp.communication_id = c.id), '') as withWhom
      from communications c
      where c.deleted_at is null and c.follow_up_promised is not null and c.follow_up_done_at is null
        and (c.follow_up_due is null or c.follow_up_due <= ${soon})
      order by coalesce(c.follow_up_due, '9999') asc limit 30
    `);
    const upcomingEncounters = d.all<{ id: string; title: string; occurredAt: string | null; occurredAtPrecision: string; clinician: string | null }>(sql`
      select e.id, e.title, e.occurred_at as occurredAt, e.occurred_at_precision as occurredAtPrecision, p.name as clinician
      from encounters e left join people p on p.id = e.clinician_id
      where e.deleted_at is null and e.status = 'upcoming' and (e.occurred_at is null or e.occurred_at >= ${today})
      order by coalesce(e.occurred_at, '9999') asc limit 10
    `);
    const one = (q: ReturnType<typeof sql>) => (d.get<{ n: number }>(q)?.n ?? 0);
    const pendingVerification = one(sql`select count(*) as n from facts where deleted_at is null and status = 'unverified'`);
    // Proposals involving a value the clinical record set aside are hidden, as on Details from documents; so are pairs
    // of measurements, procedures or events (Reconciliation groups them).
    const pendingMerges = one(sql`select count(*) as n from fact_merges pm where pm.status = 'pending' and not ${passSetAsideSql(sql.raw('pm.fact_id_a'))} and not ${passSetAsideSql(sql.raw('pm.fact_id_b'))} and not ${reconciledPairSql(sql.raw('pm.fact_id_a'), sql.raw('pm.fact_id_b'))}`);
    // Same definition as the Records page Gaps view: inventory rows in a gap state plus inferred record_reference gaps.
    // Only the count is shown, so the likely-held lookups (per-gap document matching) are skipped.
    const openGaps = inferGaps({ resolveLikely: false }).length;
    const newFindings = one(sql`select count(*) as n from findings where deleted_at is null and status = 'new'`);
    const recentDocuments = d.all<{ id: string; title: string; createdAt: string; textStatus: string; extractionStatus: string }>(sql`
      select id, title, created_at as createdAt, text_status as textStatus, extraction_status as extractionStatus
      from documents where deleted_at is null order by created_at desc limit 8
    `);
    const hardStops = d.all<{ id: string; substance: string; reaction: string | null }>(sql`
      select id, substance, reaction from intolerances where deleted_at is null and active = 1 and hard_stop = 1 order by substance
    `);
    return c.json({ date: today, tasksDue, followUpsDue, upcomingEncounters, pendingVerification, pendingMerges, openGaps, newFindings, recentDocuments, hardStops });
  })
  .post('/checkpoint', (c) => {
    checkpoint();
    return c.json({ ok: true });
  })
  .post('/backup', async (c) => {
    const t0 = Date.now();
    const result = await createBackupZip();
    log.info('backup', `backup written (${Math.round(result.bytes / 1024 / 1024)} MB in ${Math.round((Date.now() - t0) / 1000)} s${result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : ''})`);
    // `name` is the file name alone (hosted, the server's path means nothing to the person); `path` stays for the local app.
    return c.json({ ...result, name: path.basename(result.path) });
  })
  /** Settings > Backups: the finished backups on this server, newest first (owner only; services/users.ts authorize). */
  .get('/backups', (c) => c.json({ items: listBackups() }))
  /** One backup, streamed as a download under its own name (owner only). */
  .get('/backups/:name/file', (c) => {
    const name = c.req.param('name');
    if (!isBackupName(name)) throw badRequest('not a backup file name');
    const file = backupFilePath(name);
    if (!file) throw notFound('no such backup');
    const size = fs.statSync(file).size;
    log.info('backup', `backup downloaded (${Math.round(size / 1024 / 1024)} MB)`);
    // isBackupName allows letters, digits, dot, dash, underscore and space only, so the name goes in the header as is.
    return c.body(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, 200, {
      'content-type': 'application/zip',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });
