import { runRevertTask } from '../core/revert.js';
import { openContext, openStore } from '../context.js';
import { listRuns } from '../db/runs.js';
import { countRevisions } from '../db/revisions.js';
import { countRunItemPlansByRun } from '../db/runItems.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface RevertOptions {
  apply?: boolean;
  force?: boolean;
  json?: boolean;
}

export async function runRevert(runId: string, options: RevertOptions): Promise<void> {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Expected a run id; got "${runId}". List them with: abs-butler runs`);
  }

  const db = openStore();
  const ctx = openContext(db);
  const result = await runRevertTask(ctx, { runId: id, ...options });

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  if (result.plans.length > 0) {
    printTable(result.plans, [
      { header: 'TITLE', value: (p) => truncate(p.title, 44), maxWidth: 44 },
      { header: 'RESTORES', value: (p) => p.fields.join(', ') },
    ]);
  }

  for (const skip of result.skipped) {
    log.warn(`skipping "${truncate(skip.title, 40)}" — ${skip.reason}`);
  }

  if (result.alreadyReverted > 0) {
    log.info(`${result.alreadyReverted} item(s) from this run were already put back`);
  }
  if (!result.applied && result.plans.length > 0) {
    log.info(`re-run with --apply to restore these ${result.plans.length} item(s)`);
  }
}

/** Recent runs, so a revert — or an apply — has something to name. */
export async function runRunsList(options: { json?: boolean; limit?: number }): Promise<void> {
  const db = openStore();
  const { runs } = listRuns(db, { limit: options.limit ?? 20 });
  // What each run decided and has not carried out. Shown alongside the undo
  // count because the two are the same question pointing opposite ways: what
  // can still be done, and what can still be taken back.
  const waiting = countRunItemPlansByRun(db);
  const rows = runs.map((run) => ({
    run,
    revisions: countRevisions(db, run.id),
    appliable: waiting.get(run.id) ?? 0,
  }));

  if (options.json) {
    printJson(rows.map(({ run, revisions, appliable }) => ({ ...run, revisions, appliable })));
    return;
  }

  if (rows.length === 0) {
    log.info('No runs yet.');
    return;
  }

  printTable(rows, [
    { header: 'ID', value: ({ run }) => String(run.id) },
    { header: 'COMMAND', value: ({ run }) => run.command },
    { header: 'WHEN', value: ({ run }) => new Date(run.queuedAt).toLocaleString() },
    { header: 'TRIGGER', value: ({ run }) => color.dim(run.trigger) },
    { header: 'MODE', value: ({ run }) => (run.dryRun ? color.dim('dry run') : 'applied') },
    { header: 'STATUS', value: ({ run }) => run.status },
    {
      header: 'WAITING',
      value: ({ appliable }) => (appliable === 0 ? color.dim('—') : `${appliable} item(s)`),
    },
    {
      header: 'UNDO',
      value: ({ revisions }) => {
        if (revisions.total === 0) return color.dim('—');
        const pending = revisions.total - revisions.reverted;
        return pending === 0 ? color.dim('reverted') : `${pending} item(s)`;
      },
    },
  ]);
}
