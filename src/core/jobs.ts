import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.js';
import { pruneRunItems } from '../db/runItems.js';
import { appendLog, pruneLogs } from '../db/logs.js';
import { pruneLookups } from '../db/lookups.js';
import {
  completeRun,
  createRun,
  getRun,
  markRunning,
  pruneRuns,
  reconcileOrphanedRuns,
  type RunCommand,
  type RunRecord,
  type RunTrigger,
} from '../db/runs.js';
import { dueSchedules, markScheduleRun } from '../db/schedules.js';
import { getSettings } from '../db/settings.js';
import { pruneSessions } from '../db/sessions.js';
import { openContext } from '../context.js';
import { log, withLogSink } from '../logger.js';
import { runTask, summarizeResult, FILE_COMMANDS } from './tasks.js';
import { unavailableMessage } from './organize.js';
import { checkLocalRoot } from './capability.js';

/** The one wording for a stopped run, used in its log, its record, and the UI. */
export const STOPPED = 'Stopped — this run was cancelled before it finished.';

export interface EnqueueInput {
  command: RunCommand;
  options?: Record<string, unknown>;
  trigger?: RunTrigger;
}

/**
 * Serial job runner.
 *
 * Runs execute one at a time on purpose: they hammer both AudiobookShelf and
 * third-party metadata providers, and two concurrent `rate` runs against the
 * same library would double the request rate for no gain. Queued work is
 * durable — it lives in the runs table, not in memory.
 */
export class JobRunner extends EventEmitter {
  private queue: number[] = [];
  private active: number | null = null;
  /** Aborts the run currently executing. Null whenever nothing is running. */
  private activeController: AbortController | null = null;
  private draining = false;
  /** Resolves when the queue is empty; see `drained`. */
  private idle: Promise<void> = Promise.resolve();
  private schedulerTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly db: Db) {
    super();
  }

  /** Fails runs left mid-flight by a crash, then resumes normal operation. */
  recover(): void {
    const orphaned = reconcileOrphanedRuns(this.db);
    if (orphaned > 0) log.warn(`marked ${orphaned} interrupted run(s) as failed`);
  }

  get activeRunId(): number | null {
    return this.active;
  }

  get queuedRunIds(): number[] {
    return [...this.queue];
  }

  enqueue(input: EnqueueInput): RunRecord {
    const options = input.options ?? {};
    const run = createRun(this.db, {
      command: input.command,
      options,
      dryRun: !options.apply,
      trigger: input.trigger ?? 'manual',
    });

    this.queue.push(run.id);
    this.emit('queued', run);
    void this.drain();
    return run;
  }

  /**
   * Stops a run, queued or executing.
   *
   * A queued run is simply dropped. One already executing is asked to stop:
   * the signal reaches the loop over items and the HTTP layer under it, so the
   * run ends within a request or two rather than at the end of the library.
   * Work already applied stays applied — a rate run that tagged 300 books
   * before being stopped has tagged 300 books, and the run's undo record
   * covers exactly those. Returns false only when the run is already over.
   */
  cancel(runId: number): boolean {
    const index = this.queue.indexOf(runId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      completeRun(this.db, runId, { status: 'cancelled' });
      this.emit('updated', getRun(this.db, runId));
      return true;
    }

    if (this.active === runId && this.activeController) {
      // Aborting twice is not an error, but it is not news either.
      if (!this.activeController.signal.aborted) {
        log.info(`run ${runId}: stop requested`);
        this.activeController.abort(new Error(STOPPED));
      }
      return true;
    }

    return false;
  }

  private drain(): Promise<void> {
    if (!this.draining && !this.stopped) this.idle = this.runQueue();
    return this.idle;
  }

  private async runQueue(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const runId = this.queue.shift()!;
        await this.execute(runId);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Resolves once nothing is executing — after `stop`, that is the run winding
   * up. Shutdown waits on this so the run's last log lines and its final status
   * are written before the database closes; without it a stopped run is still
   * marked 'running' at exit and is reconciled as a failure on the next start.
   *
   * Bounded, because a task that ignores its signal must not hold the process
   * open indefinitely. Exceeding the bound is the orphan case, and recovery
   * already handles it.
   */
  async drained(timeoutMs = 10_000): Promise<void> {
    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref());
    await Promise.race([this.idle, timer]);
  }

  private async execute(runId: number): Promise<void> {
    const run = getRun(this.db, runId);
    if (!run || run.status === 'cancelled') return;

    this.active = runId;
    const controller = new AbortController();
    this.activeController = controller;
    markRunning(this.db, runId);
    this.emit('started', getRun(this.db, runId));

    // Buffer log lines and flush in batches: a large run emits thousands, and
    // one INSERT each would dominate its runtime.
    let buffer: Array<{ level: string; message: string }> = [];
    const flush = () => {
      if (buffer.length === 0) return;
      const pending = buffer;
      buffer = [];
      for (const entry of pending) {
        appendLog(this.db, { runId, level: entry.level as never, message: entry.message });
      }
      this.emit('log', runId);
    };
    const flushTimer = setInterval(flush, 500);

    try {
      // `runId` is what lets every write this run makes record how to undo it,
      // and `signal` is what lets it be stopped; both belong to the run rather
      // than to the connection, so they are added here rather than in
      // openContext, which the CLI shares.
      const ctx = { ...openContext(this.db), runId, signal: controller.signal };

      // Re-checked here as well as at enqueue: a mount can disappear between
      // queueing a job and running it, and a half-finished reorganization is
      // far worse than one that never started.
      if (FILE_COMMANDS.has(run.command)) {
        const local = checkLocalRoot(ctx.connection);
        if (!local.canManageFiles) throw new Error(unavailableMessage(local.reason));
      }

      const result = await withLogSink(
        (entry) => buffer.push({ level: entry.level, message: entry.message }),
        () => runTask(ctx, run.command, run.options),
      );

      flush();
      // A task that noticed the stop and returned early — `organize` finishes
      // the move it was making rather than throwing — still ended because it
      // was stopped. Its summary is kept: it says how far it got.
      const summary = summarizeResult(run.command, result);
      completeRun(
        this.db,
        runId,
        controller.signal.aborted
          ? { status: 'cancelled', summary, error: STOPPED }
          : { status: 'success', summary },
      );
      this.emit('finished', getRun(this.db, runId));
    } catch (err) {
      const message = (err as Error).message;
      // A run that was asked to stop did what it was told; recording that as a
      // failure would put a red mark against the person who pressed the button.
      if (controller.signal.aborted) {
        buffer.push({ level: 'warn', message: STOPPED });
        flush();
        completeRun(this.db, runId, { status: 'cancelled', error: STOPPED });
        log.warn(`run ${runId} (${run.command}) stopped`);
      } else {
        buffer.push({ level: 'error', message });
        flush();
        completeRun(this.db, runId, { status: 'failed', error: message });
        log.error(`run ${runId} (${run.command}) failed: ${message}`);
      }
      this.emit('finished', getRun(this.db, runId));
    } finally {
      clearInterval(flushTimer);
      flush();
      this.active = null;
      this.activeController = null;
      this.retain();
    }
  }

  /** Applies history and log retention after every run. */
  private retain(): void {
    try {
      const settings = getSettings(this.db);
      pruneRuns(this.db, settings.historyLimit);
      pruneLogs(this.db, settings.logRetentionDays * 24 * 60 * 60 * 1000);
      // Expired rows are already ignored on read; this stops the table growing
      // without bound on a library that keeps churning through unmatched books.
      pruneLookups(this.db, settings.lookupCacheDays * 24 * 60 * 60 * 1000);
      // Per-item detail is bulky and only interesting while it is current; the
      // counts in each run's summary outlive it.
      pruneRunItems(this.db);
      pruneSessions(this.db);
    } catch (err) {
      log.debug(`retention pass failed: ${(err as Error).message}`);
    }
  }

  /** Starts the recurring-schedule poller. */
  startScheduler(intervalMs = 30_000): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => this.tickSchedules(), intervalMs);
    this.schedulerTimer.unref();
    this.tickSchedules();
  }

  tickSchedules(): void {
    if (this.stopped) return;
    try {
      for (const schedule of dueSchedules(this.db)) {
        // Re-anchor before enqueueing, so a long run cannot stack up duplicates.
        markScheduleRun(this.db, schedule.id, schedule.intervalMinutes);
        log.info(`schedule ${schedule.id}: queueing ${schedule.command}`);
        this.enqueue({
          command: schedule.command,
          options: schedule.options,
          trigger: 'schedule',
        });
      }
    } catch (err) {
      log.error(`scheduler tick failed: ${(err as Error).message}`);
    }
  }

  /** Shuts the runner down: no new work, and the current run is asked to stop. */
  stop(): void {
    this.stopped = true;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = undefined;
    // Without this a shutdown waits out whatever the run had left, and the
    // process is usually killed before that — which is how runs ended up
    // orphaned and reconciled as failures on the next start.
    if (this.activeController && !this.activeController.signal.aborted) {
      this.activeController.abort(new Error(STOPPED));
    }
  }
}
