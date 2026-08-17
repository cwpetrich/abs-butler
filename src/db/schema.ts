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
];
