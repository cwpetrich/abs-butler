import { DEFAULT_TEMPLATE, runOrganizeTask, unavailableMessage } from '../core/organize.js';
import { checkLocalRoot } from '../core/capability.js';
import { openContext, openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface OrganizeOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  limit?: number;
  template?: string;
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
    log.success(`Every item already matches ${result.template}`);
    return;
  }

  printTable(result.plans, [
    { header: 'TITLE', value: (p) => truncate(p.title, 36), maxWidth: 36 },
    { header: 'FROM', value: (p) => color.dim(truncate(p.from, 46)), maxWidth: 46 },
    { header: 'TO', value: (p) => color.green(truncate(p.to, 46)), maxWidth: 46 },
  ]);

  if (!result.applied) log.info('re-run with --apply to move files on disk');
}

export { DEFAULT_TEMPLATE };
