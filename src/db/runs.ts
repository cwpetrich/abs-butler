import type { Db } from './index.js';

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type RunCommand = 'audit' | 'rate' | 'metadata' | 'normalize' | 'organize';
export type RunTrigger = 'manual' | 'schedule' | 'cli';

export interface RunRecord {
  id: number;
  command: RunCommand;
  options: Record<string, unknown>;
  status: RunStatus;
  dryRun: boolean;
  trigger: RunTrigger;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}

interface RunRow {
  id: number;
  command: string;
  options: string;
  status: string;
  dry_run: number;
  trigger: string;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  summary: string | null;
  error: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    command: row.command as RunCommand,
    options: parseJson<Record<string, unknown>>(row.options, {}),
    status: row.status as RunStatus,
    dryRun: row.dry_run === 1,
    trigger: row.trigger as RunTrigger,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: parseJson<Record<string, unknown> | null>(row.summary, null),
    error: row.error,
  };
}

export function createRun(
  db: Db,
  input: {
    command: RunCommand;
    options?: Record<string, unknown>;
    dryRun: boolean;
    trigger: RunTrigger;
  },
): RunRecord {
  const result = db
    .prepare(
      `INSERT INTO runs (command, options, status, dry_run, trigger, queued_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    )
    .run(
      input.command,
      JSON.stringify(input.options ?? {}),
      input.dryRun ? 1 : 0,
      input.trigger,
      Date.now(),
    );
  return getRun(db, Number(result.lastInsertRowid))!;
}

export function getRun(db: Db, id: number): RunRecord | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as
    | RunRow
    | undefined;
  return row ? toRecord(row) : null;
}

export function markRunning(db: Db, id: number): void {
  db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), id);
}

export function completeRun(
  db: Db,
  id: number,
  outcome: { status: Extract<RunStatus, 'success' | 'failed' | 'cancelled'>; summary?: unknown; error?: string },
): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ?').run(
    outcome.status,
    Date.now(),
    outcome.summary === undefined ? null : JSON.stringify(outcome.summary),
    outcome.error ?? null,
    id,
  );
}

export interface RunQuery {
  command?: RunCommand;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export function listRuns(db: Db, query: RunQuery = {}): { runs: RunRecord[]; total: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.command) {
    where.push('runs.command = ?');
    params.push(query.command);
  }
  if (query.status) {
    where.push('runs.status = ?');
    params.push(query.status);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM runs ${clause}`).get(...params) as { n: number }
  ).n;

  const limit = Math.min(query.limit ?? 50, 200);
  const rows = db
    .prepare(`SELECT * FROM runs ${clause} ORDER BY runs.queued_at DESC, runs.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, query.offset ?? 0) as unknown as RunRow[];

  return { runs: rows.map(toRecord), total };
}

/** Any run left 'running' when the process died can never finish. */
export function reconcileOrphanedRuns(db: Db): number {
  const result = db
    .prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?, error = ?
       WHERE status IN ('running', 'queued')`,
    )
    .run(Date.now(), 'Interrupted — abs-butler restarted while this run was in progress.');
  return Number(result.changes);
}

/**
 * History retention, invoked after each run.
 *
 * Ordered by id as well as timestamp: several runs can be queued within the
 * same millisecond, and on a tie SQLite's row order is arbitrary — which would
 * make it unpredictable which of them survived a prune.
 */
export function pruneRuns(db: Db, keep: number): number {
  const result = db
    .prepare(
      `DELETE FROM runs WHERE id NOT IN (
         SELECT id FROM runs ORDER BY queued_at DESC, id DESC LIMIT ?
       )`,
    )
    .run(keep);
  return Number(result.changes);
}
