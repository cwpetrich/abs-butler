import type { ContentAssessment } from '../content/ageRating.js';
import { runRateTask } from '../core/rate.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
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
  // Recorded as a run like any other, so it shows in history and — for the
  // commands that write — can be undone with `abs-butler revert`.
  const { ctx, result, run } = await withRun(db, 'rate', options as Record<string, unknown>, (c) =>
    runRateTask(c, options),
  );

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

  if (result.applied && result.tagged > 0) {
    // Named here because an undo nobody can find is not an undo.
    log.info(`run ${run.id} — put it back with: abs-butler revert ${run.id}`);
  }
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
