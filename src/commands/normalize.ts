import { NORMALIZABLE, runNormalizeTask } from '../core/normalize.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface NormalizeOptions extends GlobalOptions {
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

  if (result.plans.length === 0) return;

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

  log.info(
    `${result.fieldsToChange} change(s) across ${result.itemsToChange} item(s) — ` +
      `${result.bySource.provider} from providers, ${result.bySource.consensus} from library ` +
      `consensus, ${result.bySource.local} local`,
  );
  if (!result.applied) log.info('re-run with --apply to write these changes');
  // Named here because an undo nobody can find is not an undo.
  else log.info(`run ${run.id} — put it back with: abs-butler revert ${run.id}`);
}

export const NORMALIZE_FIELDS = [...NORMALIZABLE];
