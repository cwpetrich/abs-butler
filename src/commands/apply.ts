import { runApplyTask } from '../core/apply.js';
import { withRun } from '../core/execute.js';
import { openStore, type GlobalOptions } from '../context.js';
import { getRun } from '../db/runs.js';
import { log } from '../logger.js';
import { printDetails } from './details.js';
import { printJson } from '../util/table.js';

export interface ApplyOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  /** Restrict to these AudiobookShelf item ids — the per-book half of it. */
  items?: string[];
  /** List every book it looked at, not only the ones it had something to do to. */
  details?: boolean;
}

/**
 * Carries out what an earlier run decided.
 *
 * A dry run first, like everything else that writes — and here that is not
 * ceremony: it is the answer to "is this report still true?", which is the
 * question a report read yesterday raises. Only then does `--apply` write.
 */
export async function runApply(runId: string, options: ApplyOptions): Promise<void> {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Expected a run id; got "${runId}". List them with: abs-butler runs`);
  }

  const db = openStore();
  const source = getRun(db, id);
  if (!source) throw new Error(`No run #${id} in history. List them with: abs-butler runs`);

  // Recorded under the command it is carrying out, so history reads as what it
  // is and — since these are writes like any other — it can be undone.
  const { ctx, result, run } = await withRun(
    db,
    source.command,
    {
      applyFrom: id,
      ...(options.items ? { items: options.items } : {}),
      ...(options.apply ? { apply: true } : {}),
    },
    (c) =>
      runApplyTask(c, {
        applyFrom: id,
        command: source.command,
        ...(options.items ? { items: options.items } : {}),
        ...(options.apply ? { apply: true } : {}),
      }),
  );

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  // The report is this command's whole output — it is applying a list somebody
  // has already read — so the changes print by default and --details adds the
  // books it looked at and left alone, with the reason why.
  printDetails(source.command, result.report, { onlyAction: !options.details });

  if (!result.applied) {
    log.info(`re-run with --apply to carry out what run ${id} decided`);
    return;
  }
  // Named here because an undo nobody can find is not an undo. `organize` moves
  // files and records no revisions, so it has none to offer.
  if (source.command !== 'organize' && result.written > 0) {
    log.info(`run ${run.id} — put it back with: abs-butler revert ${run.id}`);
  }
}
