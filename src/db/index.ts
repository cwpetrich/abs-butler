import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { MIGRATIONS } from './schema.js';

export type Db = DatabaseSync;

/**
 * node:sqlite is loaded lazily through require rather than a static import.
 *
 * A static ESM import of a builtin is linked before any user code evaluates,
 * so its ExperimentalWarning would print before silence-warnings.ts could
 * install its filter. Requiring it on first use defers the load past that.
 */
type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };
let sqlite: SqliteModule | undefined;

function sqliteModule(): SqliteModule {
  if (!sqlite) sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  return sqlite;
}

let instance: Db | undefined;

/**
 * Where the database and encryption key live.
 *
 * Deliberately not relative to the working directory: running `abs-butler` from
 * your home directory and later from a checkout would otherwise open two
 * different databases, the second silently empty and looking like lost config.
 * Docker sets BUTLER_DATA_DIR=/data and never reaches the fallbacks.
 */
export function resolveDataDir(): string {
  if (process.env.BUTLER_DATA_DIR) return resolve(process.env.BUTLER_DATA_DIR);
  if (process.env.BUTLER_HOME) return resolve(process.env.BUTLER_HOME, 'data');
  if (process.env.XDG_DATA_HOME) return resolve(process.env.XDG_DATA_HOME, 'abs-butler');
  return resolve(homedir(), '.local', 'share', 'abs-butler');
}

export function databasePath(): string {
  return join(resolveDataDir(), 'abs-butler.db');
}

/**
 * Opens (and migrates) the database. Safe to call repeatedly — the connection
 * is cached for the life of the process.
 */
export function openDb(path = databasePath()): Db {
  if (instance) return instance;

  mkdirSync(dirname(path), { recursive: true });
  const db = new (sqliteModule().DatabaseSync)(path);

  // WAL keeps the web UI readable while a long job writes logs.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  instance = db;
  return db;
}

/** For tests: an isolated in-memory database with the schema applied. */
export function openMemoryDb(): Db {
  const db = new (sqliteModule().DatabaseSync)(":memory:");
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const applied = row?.user_version ?? 0;

  if (applied > MIGRATIONS.length) {
    throw new Error(
      `Database schema is version ${applied} but this build only knows ${MIGRATIONS.length}. ` +
        'It was written by a newer abs-butler — upgrade rather than downgrade.',
    );
  }
  if (applied === MIGRATIONS.length) return;

  for (let version = applied; version < MIGRATIONS.length; version++) {
    log.debug(`applying database migration ${version + 1}`);
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      // PRAGMA does not accept bound parameters, and version is a loop integer.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version + 1} failed: ${(err as Error).message}`);
    }
  }
  log.debug(`database at schema version ${MIGRATIONS.length}`);
}
