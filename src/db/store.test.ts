import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from './index.js';
import {
  connectionKeyStatus,
  deleteConnection,
  getConnection,
  getConnectionWithKey,
  isConfigured,
  rotateEncryptionKey,
  saveConnection,
  updateConnection,
  upgradeStoredKey,
} from './connection.js';
import { resetKeyCache } from '../core/crypto.js';
import { completeRun, createRun, listRuns, markRunning, pruneRuns, reconcileOrphanedRuns } from './runs.js';
import { appendLog, listLogs } from './logs.js';
import { getSettings, updateSettings } from './settings.js';
import { MIGRATIONS } from './schema.js';
import { createSchedule, dueSchedules, markScheduleRun, updateSchedule } from './schedules.js';

let db: Db;
const ORIGINAL_DATA_DIR = process.env.BUTLER_DATA_DIR;

beforeEach(() => {
  process.env.BUTLER_DATA_DIR = mkdtempSync(join(tmpdir(), 'abs-butler-store-'));
  resetKeyCache();
  db = openMemoryDb();
});

afterEach(() => {
  db.close();
  process.env.BUTLER_DATA_DIR = ORIGINAL_DATA_DIR;
  resetKeyCache();
});

const input = { url: 'http://localhost:13378', apiKey: 'secret-key' };

describe('connection', () => {
  it('reports nothing configured on a fresh database', () => {
    expect(isConfigured(db)).toBe(false);
    expect(getConnection(db)).toBeNull();
    expect(getConnectionWithKey(db)).toBeNull();
  });

  it('saves and reads back without exposing the key in the record', () => {
    const saved = saveConnection(db, input);
    expect(saved.url).toBe('http://localhost:13378');
    expect(JSON.stringify(saved)).not.toContain('secret-key');
    expect(getConnectionWithKey(db)?.apiKey).toBe('secret-key');
  });

  it('encrypts the key at rest with no configuration needed', () => {
    saveConnection(db, input);

    const raw = db.prepare('SELECT api_key FROM connection WHERE id = 1').get() as {
      api_key: string;
    };
    expect(raw.api_key).not.toContain('secret-key');
    expect(connectionKeyStatus(db).encrypted).toBe(true);
  });

  it('normalizes the URL and rejects a malformed one', () => {
    expect(saveConnection(db, { ...input, url: 'http://localhost:13378/' }).url).toBe(
      'http://localhost:13378',
    );
    expect(() => saveConnection(db, { ...input, url: 'not-a-url' })).toThrow();
  });

  // There is exactly one row by construction, not by convention.
  it('replaces rather than accumulating when saved twice', () => {
    saveConnection(db, input);
    saveConnection(db, { ...input, url: 'http://other:13378', apiKey: 'second-key' });

    const count = db.prepare('SELECT COUNT(*) AS n FROM connection').get() as { n: number };
    expect(count.n).toBe(1);
    expect(getConnectionWithKey(db)?.url).toBe('http://other:13378');
    expect(getConnectionWithKey(db)?.apiKey).toBe('second-key');
  });

  // The UI never receives the stored key, so it cannot send it back on save.
  it('keeps the existing key when the patch omits it', () => {
    saveConnection(db, input);
    updateConnection(db, { libraryRoot: '/library' });
    expect(getConnectionWithKey(db)?.apiKey).toBe('secret-key');
    expect(getConnection(db)?.libraryRoot).toBe('/library');
  });

  it('replaces the key when one is supplied', () => {
    saveConnection(db, input);
    updateConnection(db, { apiKey: 'rotated-key' });
    expect(getConnectionWithKey(db)?.apiKey).toBe('rotated-key');
  });

  it('clears the library root when set to empty, disabling organize', () => {
    saveConnection(db, { ...input, libraryRoot: '/library' });
    updateConnection(db, { libraryRoot: '' });
    expect(getConnection(db)?.libraryRoot).toBeNull();
  });

  it('deletes without touching run history', () => {
    saveConnection(db, input);
    createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
    deleteConnection(db);

    expect(isConfigured(db)).toBe(false);
    expect(listRuns(db).total).toBe(1);
  });

  it('re-seals a key stored in plaintext by an older install', () => {
    saveConnection(db, input);
    db.prepare('UPDATE connection SET api_key = ? WHERE id = 1').run('plain:legacy-key');
    expect(connectionKeyStatus(db).encrypted).toBe(false);

    expect(upgradeStoredKey(db)).toBe(true);
    expect(connectionKeyStatus(db).encrypted).toBe(true);
    expect(getConnectionWithKey(db)?.apiKey).toBe('legacy-key');
    expect(upgradeStoredKey(db)).toBe(false);
  });

  // The failure this replaces: changing BUTLER_SECRET orphaned the stored key.
  it('rotates the encryption key and keeps the API key readable', () => {
    saveConnection(db, input);
    const before = db.prepare('SELECT api_key FROM connection WHERE id = 1').get() as {
      api_key: string;
    };

    rotateEncryptionKey(db);

    const after = db.prepare('SELECT api_key FROM connection WHERE id = 1').get() as {
      api_key: string;
    };
    expect(after.api_key).not.toBe(before.api_key);
    expect(getConnectionWithKey(db)?.apiKey).toBe('secret-key');
  });
});

describe('runs', () => {
  it('moves through its lifecycle and stores a summary', () => {
    const run = createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
    expect(run.status).toBe('queued');

    markRunning(db, run.id);
    completeRun(db, run.id, { status: 'success', summary: { scanned: 42 } });

    const [stored] = listRuns(db).runs;
    expect(stored?.status).toBe('success');
    expect(stored?.summary).toEqual({ scanned: 42 });
  });

  it('filters by command and status', () => {
    createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
    const rate = createRun(db, { command: 'rate', dryRun: false, trigger: 'cli' });
    completeRun(db, rate.id, { status: 'failed', error: 'boom' });

    expect(listRuns(db, { command: 'rate' }).total).toBe(1);
    expect(listRuns(db, { status: 'failed' }).runs[0]?.error).toBe('boom');
    expect(listRuns(db, { command: 'organize' }).total).toBe(0);
  });

  // A crash leaves rows claiming to be running forever; startup must clear them.
  it('reconciles runs interrupted by a restart', () => {
    const run = createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
    markRunning(db, run.id);

    expect(reconcileOrphanedRuns(db)).toBe(1);
    const [stored] = listRuns(db).runs;
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toMatch(/Interrupted/);
  });

  it('prunes history down to the retention limit, keeping the newest', () => {
    for (let i = 0; i < 10; i++) {
      createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
    }
    pruneRuns(db, 4);
    const remaining = listRuns(db);
    expect(remaining.total).toBe(4);
    expect(remaining.runs[0]!.id).toBe(10);
  });
});

describe('logs', () => {
  it('returns entries in chronological order and supports incremental tailing', () => {
    const run = createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });

    appendLog(db, { runId: run.id, level: 'info', message: 'first' });
    appendLog(db, { runId: run.id, level: 'warn', message: 'second' });
    appendLog(db, { runId: run.id, level: 'error', message: 'third' });

    const all = listLogs(db, { runId: run.id });
    expect(all.map((l) => l.message)).toEqual(['first', 'second', 'third']);

    const tail = listLogs(db, { runId: run.id, afterId: all[0]!.id });
    expect(tail.map((l) => l.message)).toEqual(['second', 'third']);
  });

  it('filters by level and searches message text', () => {
    const run = createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
    appendLog(db, { runId: run.id, level: 'info', message: 'scanning library' });
    appendLog(db, { runId: run.id, level: 'error', message: 'connection refused' });

    expect(listLogs(db, { level: 'error' })).toHaveLength(1);
    expect(listLogs(db, { search: 'refused' })[0]?.level).toBe('error');
  });

  // The newest lines matter most, so the limit must keep the tail, not the head.
  it('keeps the most recent entries when limited', () => {
    const run = createRun(db, { command: 'audit', dryRun: true, trigger: 'manual' });
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
    const schedule = createSchedule(db, { command: 'audit', intervalMinutes: 60 });

    expect(dueSchedules(db, Date.now())).toHaveLength(0);
    expect(dueSchedules(db, Date.now() + 61 * 60_000)).toHaveLength(1);

    // Running it re-anchors the next run an hour out from now, so the same
    // moment that was due a line ago no longer is.
    markScheduleRun(db, schedule.id, 60);
    expect(dueSchedules(db, Date.now() + 59 * 60_000)).toHaveLength(0);
    expect(dueSchedules(db, Date.now() + 61 * 60_000)).toHaveLength(1);
  });

  it('skips a disabled schedule', () => {
    const schedule = createSchedule(db, { command: 'audit', intervalMinutes: 5 });
    updateSchedule(db, schedule.id, { enabled: false });
    expect(dueSchedules(db, Date.now() + 10 * 60_000)).toHaveLength(0);
  });
});

describe('settings migration', () => {
  it('drops requireDryRunFirst, which was never enforced, and defaults its replacement off', () => {
    // Simulate a database written before the setting was retired.
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'requireDryRunFirst',
      JSON.stringify(true),
    );
    const stale = db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'requireDryRunFirst'")
      .get() as { n: number };
    expect(stale.n).toBe(1);

    // getSettings ignores unknown keys, so the guard must start off regardless
    // of whatever the retired setting happened to say.
    expect(getSettings(db).allowFileChanges).toBe(false);
  });

  /**
   * `updateSettings` writes every key, so anyone who has ever saved Settings
   * has an explicit provider list — and would otherwise never see a provider
   * added to the schema default afterwards.
   */
  describe('the provider list', () => {
    // The migration is already applied to `db`; re-running it is how its effect
    // on a row written before it can be observed.
    const enrol = () => db.exec(MIGRATIONS.at(-1)!);

    it('defaults to every provider on a fresh install', () => {
      expect(getSettings(db).providers).toEqual([
        'audible',
        'audiosilo',
        'audnexus',
        'openlibrary',
        'googlebooks',
      ]);
    });

    it('adds the new sources to an install still carrying the old default', () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'providers',
        JSON.stringify(['audnexus', 'openlibrary', 'googlebooks']),
      );
      enrol();
      expect(getSettings(db).providers).toEqual([
        'audible',
        'audiosilo',
        'audnexus',
        'openlibrary',
        'googlebooks',
      ]);
    });

    it('leaves a list someone actually chose alone', () => {
      updateSettings(db, { providers: ['openlibrary'] });
      enrol();
      expect(getSettings(db).providers).toEqual(['openlibrary']);
    });
  });

  it('keeps allowFileChanges off unless it is explicitly turned on', () => {
    expect(getSettings(db).allowFileChanges).toBe(false);
    expect(updateSettings(db, { allowFileChanges: true }).allowFileChanges).toBe(true);
    expect(getSettings(db).allowFileChanges).toBe(true);
  });
});
