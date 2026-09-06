import { openContext, type TaskContext } from '../context.js';
import type { Db } from '../db/index.js';
import {
  completeRun,
  createRun,
  markRunning,
  pruneRuns,
  type RunCommand,
  type RunRecord,
} from '../db/runs.js';
import { getSettings } from '../db/settings.js';
import { log } from '../logger.js';
import { summarizeResult, type TaskResult } from './tasks.js';

/**
 * Runs a task from the CLI the way the job runner runs one from the web UI.
 *
 * Two reasons it exists. The README has always said history covers every run
 * "manual, scheduled, or from the CLI", and the `cli` trigger has been in the
 * schema since the first migration, but nothing ever wrote one — a typed
 * `--apply` left no trace at all.
 *
 * And more importantly, a revision belongs to a run. Without a row to attach
 * to, anything applied from the CLI could not be undone, which would make the
 * undo depend on which door the change came through.
 */
export async function withRun<T extends TaskResult>(
  db: Db,
  command: RunCommand,
  options: Record<string, unknown>,
  fn: (ctx: TaskContext) => Promise<T>,
): Promise<{ ctx: TaskContext; result: T; run: RunRecord }> {
  const run = createRun(db, {
    command,
    options,
    dryRun: !options.apply,
    trigger: 'cli',
  });
  markRunning(db, run.id);

  const ctx: TaskContext = { ...openContext(db), runId: run.id };

  try {
    const result = await fn(ctx);
    completeRun(db, run.id, { status: 'success', summary: summarizeResult(command, result) });
    retain(db);
    return { ctx, result, run };
  } catch (err) {
    completeRun(db, run.id, { status: 'failed', error: (err as Error).message });
    throw err;
  }
}

/**
 * History retention, applied here as well as after a queued run — otherwise a
 * machine driven entirely from the CLI would grow its history without bound.
 */
function retain(db: Db): void {
  try {
    pruneRuns(db, getSettings(db).historyLimit);
  } catch (err) {
    log.debug(`retention pass failed: ${(err as Error).message}`);
  }
}
