import type { ContentAssessment } from '../content/ageRating.js';
import { runRateTask } from '../core/rate.js';
import { openContext, openStore, type GlobalOptions } from '../context.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface RateOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  limit?: number;
  providers?: string[];
  minConfidence?: number;
  force?: boolean;
  maxAge?: number;
}

export async function runRate(options: RateOptions): Promise<void> {
  const db = openStore();
  const ctx = openContext(db);
  const result = await runRateTask(ctx, options);

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  printTable(result.results, [
    { header: 'TITLE', value: (r) => truncate(r.title, 44), maxWidth: 44 },
    { header: 'BAND', value: (r) => bandColor(r.assessment.band) },
    { header: 'CONF', value: (r) => r.assessment.confidence.toFixed(2), align: 'right' },
    { header: 'FLAGS', value: (r) => r.assessment.flags.map((f) => f.flag).join(', ') || color.dim('—') },
    { header: 'SRC', value: (r) => color.dim(r.assessment.sources.join('/') || 'none') },
  ]);

  if (!result.applied && result.wouldTag > 0) {
    log.info('re-run with --apply to write these tags to AudiobookShelf');
  }
}

function bandColor(band: ContentAssessment['band']): string {
  switch (band) {
    case 'early-reader':
      return color.green(band);
    case 'middle-grade':
      return color.cyan(band);
    case 'young-adult':
      return color.yellow(band);
    case 'adult':
      return color.red(band);
    default:
      return color.dim(band);
  }
}
