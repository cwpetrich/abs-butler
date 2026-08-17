import type { Db } from './index.js';
import type { RunCommand } from './runs.js';

export interface ScheduleRecord {
  id: number;
  serverId: number;
  serverName?: string;
  command: RunCommand;
  options: Record<string, unknown>;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ScheduleRow {
  id: number;
  server_id: number;
  server_name?: string | null;
  command: string;
  options: string;
  interval_minutes: number;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: ScheduleRow): ScheduleRecord {
  let options: Record<string, unknown> = {};
  try {
    options = JSON.parse(row.options) as Record<string, unknown>;
  } catch {
    options = {};
  }
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name ?? undefined,
    command: row.command as RunCommand,
    options,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `
  SELECT schedules.*, servers.name AS server_name
  FROM schedules JOIN servers ON servers.id = schedules.server_id
`;

export function listSchedules(db: Db): ScheduleRecord[] {
  const rows = db.prepare(`${SELECT} ORDER BY schedules.id`).all() as unknown as ScheduleRow[];
  return rows.map(toRecord);
}

export function getSchedule(db: Db, id: number): ScheduleRecord | null {
  const row = db.prepare(`${SELECT} WHERE schedules.id = ?`).get(id) as unknown as ScheduleRow | undefined;
  return row ? toRecord(row) : null;
}

export interface ScheduleInput {
  serverId: number;
  command: RunCommand;
  options?: Record<string, unknown>;
  intervalMinutes: number;
  enabled?: boolean;
}

export function createSchedule(db: Db, input: ScheduleInput): ScheduleRecord {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO schedules (server_id, command, options, interval_minutes, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.serverId,
      input.command,
      JSON.stringify(input.options ?? {}),
      input.intervalMinutes,
      input.enabled === false ? 0 : 1,
      now + input.intervalMinutes * 60_000,
      now,
      now,
    );
  return getSchedule(db, Number(result.lastInsertRowid))!;
}

export function updateSchedule(db: Db, id: number, patch: Partial<ScheduleInput>): ScheduleRecord {
  const existing = getSchedule(db, id);
  if (!existing) throw new Error(`No schedule with id ${id}`);

  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.command !== undefined) set('command', patch.command);
  if (patch.options !== undefined) set('options', JSON.stringify(patch.options));
  if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
  if (patch.intervalMinutes !== undefined) {
    set('interval_minutes', patch.intervalMinutes);
    // Re-anchor from now, so shortening an interval takes effect immediately
    // rather than waiting out the old one.
    set('next_run_at', Date.now() + patch.intervalMinutes * 60_000);
  }

  if (fields.length === 0) return existing;
  set('updated_at', Date.now());
  values.push(id);

  db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getSchedule(db, id)!;
}

export function deleteSchedule(db: Db, id: number): void {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

/** Enabled schedules whose next run is due, on servers that are themselves enabled. */
export function dueSchedules(db: Db, now = Date.now()): ScheduleRecord[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE schedules.enabled = 1 AND servers.enabled = 1
       AND schedules.next_run_at IS NOT NULL AND schedules.next_run_at <= ?`,
    )
    .all(now) as unknown as ScheduleRow[];
  return rows.map(toRecord);
}

export function markScheduleRun(db: Db, id: number, intervalMinutes: number): void {
  const now = Date.now();
  db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
    now,
    now + intervalMinutes * 60_000,
    id,
  );
}
