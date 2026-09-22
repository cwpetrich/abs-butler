import { clock, runRepairTask } from '../core/repair.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printDetails } from './details.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface RepairOptions extends GlobalOptions {
  /** List every item the run looked at, with what it had to say about each. */
  details?: boolean;
  /** With --details, leave out the items the run had nothing to do to. */
  onlyChanged?: boolean;
  apply?: boolean;
  json?: boolean;
  limit?: number;
}

export async function runRepair(options: RepairOptions): Promise<void> {
  const db = openStore();
  const { ctx, result, run } = await withRun(db, 'repair', options as Record<string, unknown>, (c) =>
    runRepairTask(c, options),
  );

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  const damaged = result.report.filter(
    (row) => row.codes.includes('dead-audio-record') || row.codes.includes('stale-length'),
  );
  if (damaged.length === 0) {
    if (options.details) printDetails('repair', result.report, { onlyAction: options.onlyChanged });
    else log.info('re-run with --details to list every item checked');
    return;
  }

  // The lengths are the headline: they are what a listener notices, and the
  // before/after pair is how anybody judges the report is right.
  printTable(damaged, [
    { header: 'TITLE', value: (row) => truncate(row.title, 36), maxWidth: 36 },
    { header: 'LENGTH', value: (row) => lengthOf(row.plan, row.detail) },
    {
      header: 'OUTCOME',
      value: (row) => {
        const last = row.detail[row.detail.length - 1] ?? '';
        const text = truncate(last, 70);
        return row.status === 'action' ? color.green(text) : color.yellow(text);
      },
      maxWidth: 70,
    },
  ]);

  if (options.details) printDetails('repair', result.report, { onlyAction: options.onlyChanged });
  else log.info('re-run with --details to list every item checked, not only the damaged ones');

  if (!result.applied) {
    if (result.repairable > 0) log.info(`re-run with --apply, or carry this one out with: abs-butler apply ${run.id}`);
  } else if (result.repaired + result.partlyRepaired + result.failed > 0) {
    // Named here because an undo nobody can find is not an undo.
    log.info(`run ${run.id} — put the track lists back with: abs-butler revert ${run.id}`);
  }
}

/** The before/after pair from the plan, or from the report line when there is no plan. */
function lengthOf(plan: unknown, detail: string[]): string {
  const recorded = plan as { durationBefore?: number; durationAfter?: number } | null;
  if (recorded?.durationBefore !== undefined && recorded.durationAfter !== undefined) {
    return `${clock(recorded.durationBefore)} → ${clock(recorded.durationAfter)}`;
  }
  return detail.find((line) => line.startsWith('Length '))?.slice('Length '.length) ?? '';
}
