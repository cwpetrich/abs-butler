import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConnection } from '../db/connection.js';
import { closeDb, openDb, type Db } from '../db/index.js';
import { listLogs } from '../db/logs.js';
import { getRun } from '../db/runs.js';
import type { TaskContext } from '../context.js';
import { JobRunner, STOPPED } from './jobs.js';

/**
 * The tasks themselves are stubbed out: what is under test is the runner's
 * half of the bargain — that it hands every run a signal, and that a run which
 * ends because that signal fired is recorded as stopped rather than failed.
 */
const task = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('./tasks.js', () => ({
  FILE_COMMANDS: new Set<string>(['organize']),
  runTask: (ctx: TaskContext) => task.run(ctx),
  summarizeResult: () => ({ scanned: 1 }),
}));

/** Resolves when the runner has finished (or stopped) whatever it is doing. */
function finished(runner: JobRunner): Promise<void> {
  return new Promise((resolve) => runner.once('finished', () => resolve()));
}

/**
 * Resolves once a run is executing. Subscribed before `enqueue`, because a
 * runner with nothing to do starts the next run within that same call.
 */
function started(runner: JobRunner): Promise<void> {
  return new Promise((resolve) => runner.once('started', () => resolve()));
}

/** A task that hangs until the run is stopped, then gives up the way a real one does. */
function blocksUntilStopped(ctx: TaskContext): Promise<never> {
  return new Promise((_, reject) => {
    ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason), { once: true });
  });
}

describe('JobRunner', () => {
  let dir: string;
  let db: Db;
  let runner: JobRunner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butler-jobs-'));
    process.env.BUTLER_DATA_DIR = dir;
    db = openDb();
    saveConnection(db, { url: 'http://localhost:13378', apiKey: 'k' });
    runner = new JobRunner(db);
    task.run.mockReset();
  });

  afterEach(async () => {
    // Stopped and awaited, so nothing is still writing to a closed database —
    // which is exactly what shutdown does.
    runner.stop();
    // Bounded tightly: one test deliberately leaves a task that never stops.
    await runner.drained(1000);
    closeDb();
    delete process.env.BUTLER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  // The run id is what every write attaches its undo record to, and the signal
  // is what stops the run. Both belong to the run, and neither comes from
  // openContext — a task that gets a context without them silently loses the
  // ability to be undone or to be stopped.
  it('hands the task a context carrying the run and its signal', async () => {
    let seen: TaskContext | undefined;
    task.run.mockImplementation(async (ctx: TaskContext) => {
      seen = ctx;
    });

    const run = runner.enqueue({ command: 'audit' });
    await finished(runner);

    expect(seen?.runId).toBe(run.id);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen!.signal!.aborted).toBe(false);
    expect(getRun(db, run.id)?.status).toBe('success');
  });

  // The report of the bug this exists for: a run that will never finish, and
  // nothing to do about it but restart the server.
  it('stops a run that is already executing', async () => {
    task.run.mockImplementation(blocksUntilStopped);

    const running = started(runner);
    const run = runner.enqueue({ command: 'rate' });
    await running;

    const done = finished(runner);
    expect(runner.cancel(run.id)).toBe(true);
    await done;

    const record = getRun(db, run.id);
    expect(record?.status).toBe('cancelled');
    expect(record?.error).toBe(STOPPED);
    expect(record?.finishedAt).not.toBeNull();
    expect(runner.activeRunId).toBeNull();
  });

  // Stopping is not failing: the run did what it was asked to do.
  it('says so in the run log rather than logging an error', async () => {
    task.run.mockImplementation(blocksUntilStopped);

    const running = started(runner);
    const run = runner.enqueue({ command: 'rate' });
    await running;

    const done = finished(runner);
    runner.cancel(run.id);
    await done;

    const logs = listLogs(db, { runId: run.id });
    expect(logs.some((entry) => entry.level === 'error')).toBe(false);
    expect(logs.at(-1)?.message).toBe(STOPPED);
  });

  // `organize` finishes the move it is making and returns rather than throwing.
  // It still ended because it was stopped, and its summary still counts.
  it('records a task that returns after being stopped as cancelled', async () => {
    task.run.mockImplementation(async (ctx: TaskContext) => {
      await new Promise((resolve) =>
        ctx.signal!.addEventListener('abort', resolve, { once: true }),
      );
      return { moved: 3 };
    });

    const running = started(runner);
    const run = runner.enqueue({ command: 'normalize' });
    await running;

    const done = finished(runner);
    runner.cancel(run.id);
    await done;

    const record = getRun(db, run.id);
    expect(record?.status).toBe('cancelled');
    expect(record?.summary).toEqual({ scanned: 1 });
  });

  it('still fails a run that broke on its own', async () => {
    task.run.mockImplementation(async () => {
      throw new Error('AudiobookShelf is unreachable');
    });

    const run = runner.enqueue({ command: 'audit' });
    await finished(runner);

    const record = getRun(db, run.id);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('AudiobookShelf is unreachable');
  });

  it('drops a queued run without ever starting it', async () => {
    let releaseFirst: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    task.run.mockImplementation(() => first);

    const running = runner.enqueue({ command: 'audit' });
    const waiting = runner.enqueue({ command: 'rate' });

    expect(runner.cancel(waiting.id)).toBe(true);
    expect(getRun(db, waiting.id)?.status).toBe('cancelled');

    releaseFirst!();
    await finished(runner);

    expect(task.run).toHaveBeenCalledTimes(1);
    expect(getRun(db, running.id)?.status).toBe('success');
  });

  it('refuses to stop a run that has already finished', async () => {
    task.run.mockImplementation(async () => ({}));
    const run = runner.enqueue({ command: 'audit' });
    await finished(runner);

    expect(runner.cancel(run.id)).toBe(false);
  });

  // Otherwise shutdown waits out a run with an hour of lookups left, the
  // process is killed instead, and the run is reconciled as a failure on the
  // next start — for having been interrupted by an orderly stop.
  it('stops the running job when the runner shuts down', async () => {
    task.run.mockImplementation(blocksUntilStopped);

    const running = started(runner);
    const run = runner.enqueue({ command: 'rate' });
    await running;

    runner.stop();
    // The database is closed straight after this returns, so by then the run
    // has to have written its status and its last log lines.
    await runner.drained();

    expect(runner.activeRunId).toBeNull();
    expect(getRun(db, run.id)?.status).toBe('cancelled');
    expect(listLogs(db, { runId: run.id }).at(-1)?.message).toBe(STOPPED);
  });

  // A task that never looks at its signal cannot hold the process open.
  it('gives up waiting on a run that ignores being stopped', async () => {
    task.run.mockImplementation(() => new Promise(() => {}));

    const running = started(runner);
    runner.enqueue({ command: 'rate' });
    await running;

    runner.stop();
    await runner.drained(10);

    expect(runner.activeRunId).not.toBeNull();
  });
});
