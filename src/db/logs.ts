import type { Db } from './index.js';
import type { LogLevel } from '../logger.js';

export interface LogRecord {
  id: number;
  runId: number | null;
  ts: number;
  level: string;
  message: string;
}

interface LogRow {
  id: number;
  run_id: number | null;
  ts: number;
  level: string;
  message: string;
}

function toRecord(row: LogRow): LogRecord {
  return { id: row.id, runId: row.run_id, ts: row.ts, level: row.level, message: row.message };
}

export function appendLog(db: Db, entry: { runId: number | null; level: LogLevel; message: string }): void {
  db.prepare('INSERT INTO logs (run_id, ts, level, message) VALUES (?, ?, ?, ?)').run(
    entry.runId,
    Date.now(),
    entry.level,
    entry.message,
  );
}

export interface LogQuery {
  runId?: number | null;
  /** Only entries with a higher id, for incremental polling from the UI. */
  afterId?: number;
  level?: string;
  search?: string;
  limit?: number;
}

export function listLogs(db: Db, query: LogQuery = {}): LogRecord[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.runId !== undefined) {
    if (query.runId === null) {
      where.push('run_id IS NULL');
    } else {
      where.push('run_id = ?');
      params.push(query.runId);
    }
  }
  if (query.afterId !== undefined) {
    where.push('id > ?');
    params.push(query.afterId);
  }
  if (query.level) {
    where.push('level = ?');
    params.push(query.level);
  }
  if (query.search) {
    where.push('message LIKE ?');
    params.push(`%${query.search}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(query.limit ?? 500, 2000);

  // Newest-first for the query so the limit keeps recent lines, then reversed
  // back to chronological order, which is how anyone actually reads a log.
  const rows = db
    .prepare(`SELECT * FROM logs ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as unknown as LogRow[];

  return rows.map(toRecord).reverse();
}

/** Retention by age; logs attached to pruned runs are removed by cascade. */
export function pruneLogs(db: Db, olderThanMs: number): number {
  const result = db.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - olderThanMs);
  return Number(result.changes);
}
