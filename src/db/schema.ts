/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 *
 * Never edit a migration that has shipped — append a new one. `user_version`
 * is the count of applied migrations, so removing or reordering entries would
 * silently skip statements on an existing database.
 */
export const MIGRATIONS: string[] = [
  // 1 — servers, run history, logs, settings, sessions
  `
  CREATE TABLE servers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    url           TEXT    NOT NULL,
    api_key       TEXT    NOT NULL,
    library_root  TEXT,
    path_prefix   TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id     INTEGER REFERENCES servers(id) ON DELETE CASCADE,
    command       TEXT    NOT NULL,
    options       TEXT    NOT NULL DEFAULT '{}',
    status        TEXT    NOT NULL,
    dry_run       INTEGER NOT NULL DEFAULT 1,
    trigger       TEXT    NOT NULL DEFAULT 'manual',
    queued_at     INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    summary       TEXT,
    error         TEXT
  );
  CREATE INDEX idx_runs_server ON runs(server_id, queued_at DESC);
  CREATE INDEX idx_runs_status ON runs(status);

  CREATE TABLE logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER REFERENCES runs(id) ON DELETE CASCADE,
    ts            INTEGER NOT NULL,
    level         TEXT    NOT NULL,
    message       TEXT    NOT NULL
  );
  CREATE INDEX idx_logs_run ON logs(run_id, id);
  CREATE INDEX idx_logs_ts ON logs(ts DESC);

  CREATE TABLE settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  );
  `,

  // 2 — recurring jobs configured from the UI
  `
  CREATE TABLE schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    command       TEXT    NOT NULL,
    options       TEXT    NOT NULL DEFAULT '{}',
    interval_minutes INTEGER NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   INTEGER,
    next_run_at   INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
  `,

  // 3 — collapse to a single AudiobookShelf connection
  //
  // abs-butler is now one butler to one server, co-located with it. The first
  // server configured becomes the connection; anything belonging to the others
  // is removed rather than silently re-attributed to a server it never ran on.
  `
  CREATE TABLE connection (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    url           TEXT    NOT NULL,
    api_key       TEXT    NOT NULL,
    library_root  TEXT,
    path_prefix   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  INSERT INTO connection (id, url, api_key, library_root, path_prefix, created_at, updated_at)
  SELECT 1, url, api_key, library_root, path_prefix, created_at, updated_at
  FROM servers ORDER BY id LIMIT 1;

  DELETE FROM schedules WHERE server_id <> (SELECT MIN(id) FROM servers);
  DELETE FROM runs WHERE server_id IS NOT NULL AND server_id <> (SELECT MIN(id) FROM servers);

  DROP INDEX idx_runs_server;
  ALTER TABLE runs DROP COLUMN server_id;
  ALTER TABLE schedules DROP COLUMN server_id;
  DROP TABLE servers;
  `,

  // 4 — retire requireDryRunFirst
  //
  // It was defined, surfaced by the API, and enforced nowhere. Its replacement,
  // allowFileChanges, is a different question with a different default, so the
  // old row is dropped rather than renamed — carrying a value over from a
  // setting that never did anything would be inventing an intent.
  `
  DELETE FROM settings WHERE key = 'requireDryRunFirst';
  `,

  // 5 — remember what the providers already answered
  //
  // Without this every scheduled run re-asks every provider about every book,
  // including the thousands they have already said they know nothing about. A
  // nightly `metadata` schedule over a 3,000-book library was several thousand
  // outbound requests a night to re-learn the same nothing, which is both the
  // slowest part of a run and the fastest way to get rate limited.
  //
  // Keyed on the identifier the query actually used, so re-running after ABS
  // matches a book to an ASIN is correctly a different question with a
  // different answer.
  `
  CREATE TABLE lookups (
    provider    TEXT    NOT NULL,
    query_key   TEXT    NOT NULL,
    results     TEXT    NOT NULL DEFAULT '[]',
    hit         INTEGER NOT NULL DEFAULT 0,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (provider, query_key)
  );
  CREATE INDEX idx_lookups_fetched ON lookups(fetched_at);
  `,

  // 6 — what a run overwrote, so it can be put back
  //
  // `normalize --apply` rewrites titles, authors, narrators and series across a
  // whole library, and until now nothing recorded what they had been. A bad run
  // over three thousand books was unrecoverable, which is a poor property for a
  // tool meant to be left running on a schedule.
  //
  // Both columns hold a patch in the shape the AudiobookShelf API accepts, so
  // reverting is replaying `before` and needs no interpretation. `after` is
  // kept to notice that someone has edited the item since, which is the one
  // case where putting the old value back would destroy newer work.
  `
  CREATE TABLE revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    item_id     TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    before      TEXT    NOT NULL,
    after       TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    reverted_at INTEGER
  );
  CREATE INDEX idx_revisions_run ON revisions(run_id, id);
  `,

  // 7 — enrol existing installs in the two providers added since
  //
  // `updateSettings` writes every key, not just the changed one, so anyone who
  // has ever opened Settings and saved has an explicit `providers` row. A new
  // provider added to the schema default would never reach them: they would
  // silently keep asking three sources while the release notes described four.
  //
  // Rewritten only where the stored list is still exactly the old default —
  // that is someone who never chose, and the new default is what they would
  // get on a fresh install today. A list anyone has actually edited is left
  // alone, including one that deliberately drops a provider.
  `
  UPDATE settings
     SET value = '["audible","audiosilo","audnexus","openlibrary","googlebooks"]'
   WHERE key = 'providers'
     AND value = '["audnexus","openlibrary","googlebooks"]';
  `,
];
