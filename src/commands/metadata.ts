import { FILLABLE, runMetadataTask } from '../core/metadata.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printDetails } from './details.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface MetadataOptions extends GlobalOptions {
  /** List every item the run looked at, with what it had to say about each. */
  details?: boolean;
  /** With --details, leave out the items the run had nothing to do to. */
  onlyChanged?: boolean;
  apply?: boolean;
  json?: boolean;
  limit?: number;
  providers?: string[];
  fields?: string[];
  overwrite?: boolean;
}

export async function runMetadata(options: MetadataOptions): Promise<void> {
  const db = openStore();
  // Recorded as a run like any other, so it shows in history and — for the
  // commands that write — can be undone with `abs-butler revert`.
  const { ctx, result, run } = await withRun(db, 'metadata', options as Record<string, unknown>, (c) =>
    runMetadataTask(c, options),
  );

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  if (result.plans.length === 0) {
    // Every item checked, including the ones with nothing to do — "it looked
    // and found nothing" is a different answer from "it never looked".
    if (options.details) printDetails('metadata', result.report, { onlyAction: options.onlyChanged });
    else log.info('re-run with --details to list every item checked');
    return;
  }

  printTable(
    result.plans.flatMap((plan) => plan.changes.map((change) => ({ plan, change }))),
    [
      { header: 'TITLE', value: ({ plan }) => truncate(plan.title, 40), maxWidth: 40 },
      { header: 'FIELD', value: ({ change }) => change.field },
      { header: 'NEW VALUE', value: ({ change }) => color.green(truncate(change.to, 50)), maxWidth: 50 },
      { header: 'SRC', value: ({ change }) => color.dim(change.source) },
    ],
  );

  if (options.details) printDetails('metadata', result.report, { onlyAction: options.onlyChanged });
  else log.info('re-run with --details to list every item checked, not only the changes');

  if (!result.applied) log.info('re-run with --apply to write these changes');
  // Named here because an undo nobody can find is not an undo.
  else log.info(`run ${run.id} — put it back with: abs-butler revert ${run.id}`);
}

export const METADATA_FIELDS = [...FILLABLE];
