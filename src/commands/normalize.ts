import { NORMALIZABLE, runNormalizeTask } from '../core/normalize.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printDetails } from './details.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface NormalizeOptions extends GlobalOptions {
  /** List every item the run looked at, with what it had to say about each. */
  details?: boolean;
  /** With --details, leave out the items the run had nothing to do to. */
  onlyChanged?: boolean;
  apply?: boolean;
  json?: boolean;
  limit?: number;
  fields?: string[];
  providers?: string[];
  noConsensus?: boolean;
}

export async function runNormalize(options: NormalizeOptions): Promise<void> {
  const db = openStore();
  // Recorded as a run like any other, so it shows in history and — for the
  // commands that write — can be undone with `abs-butler revert`.
  const { ctx, result, run } = await withRun(db, 'normalize', options as Record<string, unknown>, (c) =>
    runNormalizeTask(c, options),
  );

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  if (result.plans.length === 0) {
    // Every item checked, including the ones with nothing to do — "it looked
    // and found nothing" is a different answer from "it never looked".
    if (options.details) printDetails('normalize', result.report, { onlyAction: options.onlyChanged });
    else log.info('re-run with --details to list every item checked');
    return;
  }

  printTable(
    result.plans.flatMap((plan) => plan.proposals.map((proposal) => ({ plan, proposal }))),
    [
      { header: 'TITLE', value: ({ plan }) => truncate(plan.title, 32), maxWidth: 32 },
      { header: 'FIELD', value: ({ proposal }) => proposal.field },
      { header: 'FROM', value: ({ proposal }) => color.dim(truncate(proposal.from ?? '—', 28)), maxWidth: 28 },
      { header: 'TO', value: ({ proposal }) => color.green(truncate(proposal.to, 28)), maxWidth: 28 },
      // The evidence tier is the thing to scan for in a dry run: `provider`
      // means an exact identifier match, `consensus` means the library already
      // spells it the other way, `local` means only the wording was rearranged.
      { header: 'WHY', value: ({ proposal }) => `${proposal.source} (${proposal.detail})` },
    ],
  );

  // The table lists the changes; this lists the books — including the ones that
  // already agree and the ones the rewrite switch held back. The counts and the
  // evidence breakdown are logged by the task itself, so they read the same
  // from the CLI, the web UI and a scheduled run.
  if (options.details) printDetails('normalize', result.report, { onlyAction: options.onlyChanged });
  else log.info('re-run with --details to list every item checked, not only the changes');

  if (!result.applied) log.info('re-run with --apply to write these changes');
  // Named here because an undo nobody can find is not an undo.
  else log.info(`run ${run.id} — put it back with: abs-butler revert ${run.id}`);
}

export const NORMALIZE_FIELDS = [...NORMALIZABLE];
