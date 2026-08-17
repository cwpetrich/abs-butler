import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from './index.js';
import {
  createServer,
  deleteServer,
  findServer,
  getServerWithKey,
  listServers,
  serverKeyStatus,
  updateServer,
} from './servers.js';
import { completeRun, createRun, listRuns, markRunning, pruneRuns, reconcileOrphanedRuns } from './runs.js';
import { appendLog, listLogs } from './logs.js';
import { getSettings, updateSettings } from './settings.js';
import { createSchedule, dueSchedules, markScheduleRun } from './schedules.js';

let db: Db;
const ORIGINAL_SECRET = process.env.BUTLER_SECRET;

beforeEach(() => {
  db = openMemoryDb();
});

afterEach(() => {
  db.close();
  if (ORIGINAL_SECRET === undefined) delete process.env.BUTLER_SECRET;
  else process.env.BUTLER_SECRET = ORIGINAL_SECRET;
});

const input = { name: 'home', url: 'http://localhost:13378', apiKey: 'secret-key' };

describe('servers', () => {
  it('creates and reads back a server without exposing the key in the record', () => {
    const created = createServer(db, input);
    expect(created.name).toBe('home');
    expect(JSON.stringify(created)).not.toContain('secret-key');
    expect(getServerWithKey(db, created.id)?.apiKey).toBe('secret-key');
  });

  it('stores the key encrypted when a secret is configured', () => {
    process.env.BUTLER_SECRET = 'a-secret';
    const created = createServer(db, input);

    const raw = db.prepare('SELECT api_key FROM servers WHERE id = ?').get(created.id) as {
      api_key: string;
    };
    expect(raw.api_key).not.toContain('secret-key');
    expect(serverKeyStatus(db, created.id).encrypted).toBe(true);
    expect(getServerWithKey(db, created.id)?.apiKey).toBe('secret-key');
  });

  it('normalizes the URL and rejects a malformed one', () => {
    const created = createServer(db, { ...input, url: 'http://localhost:13378/' });
    expect(created.url).toBe('http://localhost:13378');
    expect(() => createServer(db, { ...input, name: 'bad', url: 'not-a-url' })).toThrow();
  });

  it('refuses a duplicate name with a readable message', () => {
    createServer(db, input);
    expect(() => createServer(db, input)).toThrow(/already exists/);
  });

  it('finds by id or by name, case-insensitively', () => {
    const created = createServer(db, input);
    expect(findServer(db, created.id)?.id).toBe(created.id);
    expect(findServer(db, 'home')?.id).toBe(created.id);
    expect(findServer(db, 'HOME')?.id).toBe(created.id);
    expect(findServer(db, 'nope')).toBeNull();
  });

  // The UI never receives the stored key, so it cannot send it back on save.
  it('keeps the existing key when the patch omits it', () => {
    const created = createServer(db, input);
    updateServer(db, created.id, { name: 'renamed' });
    expect(getServerWithKey(db, created.id)?.apiKey).toBe('secret-key');
    expect(getServerWithKey(db, created.id)?.name).toBe('renamed');
  });

  it('replaces the key when one is supplied', () => {
    const created = createServer(db, input);
    updateServer(db, created.id, { apiKey: 'rotated-key' });
    expect(getServerWithKey(db, created.id)?.apiKey).toBe('rotated-key');
  });

  it('deletes a server and cascades its runs', () => {
    const created = createServer(db, input);
    createRun(db, { serverId: created.id, command: 'audit', dryRun: true, trigger: 'manual' });
    deleteServer(db, created.id);
    expect(listServers(db)).toHaveLength(0);
    expect(listRuns(db).total).toBe(0);
  });
});

describe('runs', () => {
  it('moves through its lifecycle and stores a summary', () => {
    const server = createServer(db, input);
    const run = createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });
    expect(run.status).toBe('queued');

    markRunning(db, run.id);
    completeRun(db, run.id, { status: 'success', summary: { scanned: 42 } });

    const [stored] = listRuns(db).runs;
    expect(stored?.status).toBe('success');
    expect(stored?.summary).toEqual({ scanned: 42 });
    expect(stored?.serverName).toBe('home');
  });

  it('filters by server, command, and status', () => {
    const server = createServer(db, input);
    createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });
    const rate = createRun(db, { serverId: server.id, command: 'rate', dryRun: false, trigger: 'cli' });
    completeRun(db, rate.id, { status: 'failed', error: 'boom' });

    expect(listRuns(db, { command: 'rate' }).total).toBe(1);
    expect(listRuns(db, { status: 'failed' }).runs[0]?.error).toBe('boom');
    expect(listRuns(db, { serverId: 999 }).total).toBe(0);
  });

  // A crash leaves rows claiming to be running forever; startup must clear them.
  it('reconciles runs interrupted by a restart', () => {
    const server = createServer(db, input);
    const run = createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });
    markRunning(db, run.id);

    expect(reconcileOrphanedRuns(db)).toBe(1);
    const [stored] = listRuns(db).runs;
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toMatch(/Interrupted/);
  });

  it('prunes history down to the retention limit, keeping the newest', () => {
    const server = createServer(db, input);
    for (let i = 0; i < 10; i++) {
      createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });
    }
    pruneRuns(db, 4);
    const remaining = listRuns(db);
    expect(remaining.total).toBe(4);
    expect(remaining.runs[0]!.id).toBe(10);
  });
});

describe('logs', () => {
  it('returns entries in chronological order and supports incremental tailing', () => {
    const server = createServer(db, input);
    const run = createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });

    appendLog(db, { runId: run.id, level: 'info', message: 'first' });
    appendLog(db, { runId: run.id, level: 'warn', message: 'second' });
    appendLog(db, { runId: run.id, level: 'error', message: 'third' });

    const all = listLogs(db, { runId: run.id });
    expect(all.map((l) => l.message)).toEqual(['first', 'second', 'third']);

    const tail = listLogs(db, { runId: run.id, afterId: all[0]!.id });
    expect(tail.map((l) => l.message)).toEqual(['second', 'third']);
  });

  it('filters by level and searches message text', () => {
    const server = createServer(db, input);
    const run = createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });
    appendLog(db, { runId: run.id, level: 'info', message: 'scanning library' });
    appendLog(db, { runId: run.id, level: 'error', message: 'connection refused' });

    expect(listLogs(db, { level: 'error' })).toHaveLength(1);
    expect(listLogs(db, { search: 'refused' })[0]?.level).toBe('error');
  });

  // The newest lines matter most, so the limit must keep the tail, not the head.
  it('keeps the most recent entries when limited', () => {
    const server = createServer(db, input);
    const run = createRun(db, { serverId: server.id, command: 'audit', dryRun: true, trigger: 'manual' });
    for (let i = 0; i < 20; i++) {
      appendLog(db, { runId: run.id, level: 'info', message: `line ${i}` });
    }
    const limited = listLogs(db, { runId: run.id, limit: 3 });
    expect(limited.map((l) => l.message)).toEqual(['line 17', 'line 18', 'line 19']);
  });
});

describe('settings', () => {
  it('returns defaults for an empty database', () => {
    expect(getSettings(db).minConfidence).toBe(0.35);
    expect(getSettings(db).providerConcurrency).toBe(4);
  });

  it('merges a partial update and persists it', () => {
    updateSettings(db, { minConfidence: 0.6 });
    expect(getSettings(db).minConfidence).toBe(0.6);
    expect(getSettings(db).historyLimit).toBe(500);
  });

  it('rejects values outside the allowed range', () => {
    expect(() => updateSettings(db, { providerConcurrency: 99 })).toThrow();
  });

  it('falls back to defaults rather than failing on a corrupt row', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('minConfidence', 'not-json');
    expect(getSettings(db).minConfidence).toBe(0.35);
  });
});

describe('schedules', () => {
  it('reports a schedule as due only once its next run has passed', () => {
    const server = createServer(db, input);
    const schedule = createSchedule(db, {
      serverId: server.id,
      command: 'audit',
      intervalMinutes: 60,
    });

    expect(dueSchedules(db, Date.now())).toHaveLength(0);
    expect(dueSchedules(db, Date.now() + 61 * 60_000)).toHaveLength(1);

    // Running it re-anchors the next run an hour out from now, so the same
    // moment that was due a line ago no longer is.
    markScheduleRun(db, schedule.id, 60);
    expect(dueSchedules(db, Date.now() + 59 * 60_000)).toHaveLength(0);
    expect(dueSchedules(db, Date.now() + 61 * 60_000)).toHaveLength(1);
  });

  it('skips schedules whose server is disabled', () => {
    const server = createServer(db, input);
    createSchedule(db, { serverId: server.id, command: 'audit', intervalMinutes: 5 });
    updateServer(db, server.id, { enabled: false });
    expect(dueSchedules(db, Date.now() + 10 * 60_000)).toHaveLength(0);
  });
});
