import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.js';
import { appendLog, pruneLogs } from '../db/logs.js';
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
import { openServerContext } from '../context.js';
import { log, withLogSink } from '../logger.js';
import { runTask, summarizeResult, FILE_COMMANDS } from './tasks.js';
import { unavailableMessage } from './organize.js';
import { checkLocalRoot } from './capability.js';

export interface EnqueueInput {
  serverId: number;
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
  private draining = false;
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
      serverId: input.serverId,
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

  /** Removes a queued run. A run already executing is left alone. */
  cancel(runId: number): boolean {
    const index = this.queue.indexOf(runId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    completeRun(this.db, runId, { status: 'cancelled' });
    this.emit('updated', getRun(this.db, runId));
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
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

  private async execute(runId: number): Promise<void> {
    const run = getRun(this.db, runId);
    if (!run || run.status === 'cancelled') return;

    this.active = runId;
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
      const ctx = openServerContext(this.db, String(run.serverId));

      // Re-checked here as well as at enqueue: a mount can disappear between
      // queueing a job and running it, and a half-finished reorganization is
      // far worse than one that never started.
      if (FILE_COMMANDS.has(run.command)) {
        const local = checkLocalRoot(ctx.server);
        if (!local.canManageFiles) {
          throw new Error(unavailableMessage(ctx.server.name, local.reason));
        }
      }

      const result = await withLogSink(
        (entry) => buffer.push({ level: entry.level, message: entry.message }),
        () => runTask(ctx, run.command, run.options),
      );

      flush();
      completeRun(this.db, runId, {
        status: 'success',
        summary: summarizeResult(run.command, result),
      });
      this.emit('finished', getRun(this.db, runId));
    } catch (err) {
      const message = (err as Error).message;
      buffer.push({ level: 'error', message });
      flush();
      completeRun(this.db, runId, { status: 'failed', error: message });
      log.error(`run ${runId} (${run.command}) failed: ${message}`);
      this.emit('finished', getRun(this.db, runId));
    } finally {
      clearInterval(flushTimer);
      flush();
      this.active = null;
      this.retain();
    }
  }

  /** Applies history and log retention after every run. */
  private retain(): void {
    try {
      const settings = getSettings(this.db);
      pruneRuns(this.db, settings.historyLimit);
      pruneLogs(this.db, settings.logRetentionDays * 24 * 60 * 60 * 1000);
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
        log.info(`schedule ${schedule.id}: queueing ${schedule.command} on ${schedule.serverName}`);
        this.enqueue({
          serverId: schedule.serverId,
          command: schedule.command,
          options: schedule.options,
          trigger: 'schedule',
        });
      }
    } catch (err) {
      log.error(`scheduler tick failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = undefined;
  }
}
