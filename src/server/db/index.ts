/**
 * Database lifecycle. The database only exists while unlocked: `openDatabase`
 * takes the derived 32-byte key, runs migrations, and ensures the full-text
 * tables; `closeDatabase` checkpoints and closes. `db()` throws LockedError
 * when there is no open connection, which the API layer turns into 423.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import { config } from '../config';

const here = path.dirname(fileURLToPath(import.meta.url));

export type Db = BetterSQLite3Database<typeof schema>;
export type RawDb = Database.Database;

let rawDb: RawDb | null = null;
let drizzleDb: Db | null = null;

export class LockedError extends Error {
  constructor() {
    super('Casefile is locked');
    this.name = 'LockedError';
  }
}

export function dbPath(): string {
  return path.join(config.dataDir, 'casefile.db');
}

export function isDbOpen(): boolean {
  return drizzleDb !== null;
}

export function db(): Db {
  if (!drizzleDb) throw new LockedError();
  return drizzleDb;
}

export function raw(): RawDb {
  if (!rawDb) throw new LockedError();
  return rawDb;
}

export function openDatabase(dbKey: Buffer, opts: { file?: string; migrationsFolder?: string } = {}): Db {
  if (drizzleDb) return drizzleDb;
  const file = opts.file ?? dbPath();
  const r = new Database(file);
  let d: Db;
  try {
    r.pragma(`cipher='sqlcipher'`);
    r.pragma(`legacy=4`);
    r.pragma(`key="x'${dbKey.toString('hex')}'"`);
    // Forces the key to be checked; throws "file is not a database" when wrong.
    r.prepare('select count(*) as n from sqlite_master').get();
    r.pragma('journal_mode = WAL');
    r.pragma('foreign_keys = ON');
    r.pragma('busy_timeout = 5000');
    r.pragma('synchronous = NORMAL');
    d = drizzle(r, { schema });
    migrate(d, { migrationsFolder: opts.migrationsFolder ?? path.join(here, 'migrations') });
    ensureFts(r);
  } catch (err) {
    // A wrong key or a failed migration must not leave a handle (and, on
    // Windows, a lock) on casefile.db for the life of the process.
    try {
      r.close();
    } catch {
      // already closed
    }
    throw err;
  }
  rawDb = r;
  drizzleDb = d;
  return d;
}

/** An in-memory, unencrypted database for tests. */
export function openMemoryDatabase(): Db {
  const r = new Database(':memory:');
  r.pragma('foreign_keys = ON');
  const d = drizzle(r, { schema });
  migrate(d, { migrationsFolder: path.join(here, 'migrations') });
  ensureFts(r);
  rawDb = r;
  drizzleDb = d;
  return d;
}

export interface CheckpointResult {
  /** 1 when another connection or an open statement kept the checkpoint from finishing. */
  busy: number;
  /** Frames in the WAL before the checkpoint (-1 when not in WAL mode). */
  log: number;
  /** Frames copied into the main file. */
  checkpointed: number;
}

/**
 * wal_checkpoint(TRUNCATE): copy the WAL into the main file and empty it.
 * Best effort; returns null when the database is closed or the call failed,
 * and the pragma's result otherwise (complete when busy is 0 and
 * checkpointed equals log).
 */
export function checkpoint(): CheckpointResult | null {
  if (!rawDb) return null;
  try {
    const rows = rawDb.pragma('wal_checkpoint(TRUNCATE)') as CheckpointResult[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export function closeDatabase(): void {
  if (!rawDb) return;
  checkpoint();
  rawDb.close();
  rawDb = null;
  drizzleDb = null;
}

/**
 * Full-text indexes. Standalone FTS5 tables maintained by the services that
 * write pages and facts (see src/server/services/search.ts). Created here so
 * they exist before any migration-independent code runs.
 */
function ensureFts(r: RawDb): void {
  r.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      page_id UNINDEXED, document_id UNINDEXED, page_number UNINDEXED, text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      fact_id UNINDEXED, statement, subject,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
      entity_type UNINDEXED, entity_id UNINDEXED, title, body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

export { schema };
