import { DEFAULT_TEMPLATE, runOrganizeTask, unavailableMessage } from '../core/organize.js';
import { checkLocalRoot } from '../core/capability.js';
import { openContext, openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printDetails } from './details.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface OrganizeOptions extends GlobalOptions {
  /** List every item the run looked at, with what it had to say about each. */
  details?: boolean;
  /** With --details, leave out the items the run had nothing to do to. */
  onlyChanged?: boolean;
  apply?: boolean;
  json?: boolean;
  limit?: number;
  template?: string;
  singleFiles?: boolean;
  noScan?: boolean;
}

export async function runOrganize(options: OrganizeOptions): Promise<void> {
  const db = openStore();

  // Checked before any network call, and before a run is recorded, so an
  // unavailable server answers instantly with the reason rather than leaving a
  // failed run behind for something that never started.
  const local = checkLocalRoot(openContext(db).connection);
  if (!local.canManageFiles) throw new Error(unavailableMessage(local.reason));

  // Recorded as a run like any other. Note that `organize` records no
  // revisions: it moves files, which `revert` cannot undo through the API.
  const { ctx, result } = await withRun(db, 'organize', options as Record<string, unknown>, (c) =>
    runOrganizeTask(c, options),
  );

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  if (result.plans.length === 0) {
    // Only true when every item was *looked at* and found to be in place. A
    // library where the template rendered empty for everything has no plans
    // either, and telling it everything already matches is a lie about work
    // that never happened — the counts say which of the two it is.
    if (result.inPlace === result.scanned) {
      log.success(`Every item already matches ${result.template}`);
    } else {
      log.warn(
        `Nothing to move: ${result.inPlace} of ${result.scanned} item(s) already match ` +
          `${result.template}, and the rest could not be placed — see the reasons above.`,
      );
    }
    if (options.details) printDetails('organize', result.report, { onlyAction: options.onlyChanged });
    return;
  }

  printTable(result.plans, [
    { header: 'TITLE', value: (p) => truncate(p.title, 36), maxWidth: 36 },
    { header: 'FROM', value: (p) => color.dim(truncate(p.from, 46)), maxWidth: 46 },
    { header: 'TO', value: (p) => color.green(truncate(p.to, 46)), maxWidth: 46 },
  ]);

  if (result.skipped.length > 0) {
    log.out('');
    printTable(result.skipped, [
      { header: 'LEFT ALONE', value: (s) => truncate(s.title, 36), maxWidth: 36 },
      { header: 'WHY', value: (s) => color.yellow(truncate(s.reason, 70)), maxWidth: 70 },
    ]);
  }

  // Every item read, with where it is going or why it is staying put.
  if (options.details) printDetails('organize', result.report, { onlyAction: options.onlyChanged });

  if (!result.applied) log.info('re-run with --apply to move files on disk');
  if (!options.details) log.info('re-run with --details to list every item read');
}

export { DEFAULT_TEMPLATE };
