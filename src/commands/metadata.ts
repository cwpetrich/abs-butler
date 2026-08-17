import { FILLABLE, runMetadataTask } from '../core/metadata.js';
import { openServerContext, openStore, type GlobalOptions } from '../context.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface MetadataOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  limit?: number;
  providers?: string[];
  fields?: string[];
  overwrite?: boolean;
}

export async function runMetadata(options: MetadataOptions): Promise<void> {
  const db = openStore();
  const ctx = openServerContext(db, options.server);
  const result = await runMetadataTask(ctx, options);

  if (options.json) {
    printJson({ server: ctx.server.name, ...result });
    return;
  }

  if (result.plans.length === 0) return;

  printTable(
    result.plans.flatMap((plan) => plan.changes.map((change) => ({ plan, change }))),
    [
      { header: 'TITLE', value: ({ plan }) => truncate(plan.title, 40), maxWidth: 40 },
      { header: 'FIELD', value: ({ change }) => change.field },
      { header: 'NEW VALUE', value: ({ change }) => color.green(truncate(change.to, 50)), maxWidth: 50 },
      { header: 'SRC', value: ({ change }) => color.dim(change.source) },
    ],
  );

  if (!result.applied) log.info('re-run with --apply to write these changes');
}

export const METADATA_FIELDS = [...FILLABLE];
