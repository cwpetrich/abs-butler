import { DEFAULT_TEMPLATE, runOrganizeTask } from '../core/organize.js';
import { openServerContext, openStore, type GlobalOptions } from '../context.js';
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
  const ctx = openServerContext(db, options.server);
  const result = await runOrganizeTask(ctx, options);

  if (options.json) {
    printJson({ server: ctx.server.name, ...result });
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
