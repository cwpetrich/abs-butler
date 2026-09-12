import type { ContentAssessment } from '../content/ageRating.js';
import { runRateTask } from '../core/rate.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printDetails } from './details.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface RateOptions extends GlobalOptions {
  /** List every item the run looked at, with what it had to say about each. */
  details?: boolean;
  /** With --details, leave out the items the run had nothing to do to. */
  onlyChanged?: boolean;
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

  // The evidence behind each verdict, which the table has no room for: who was
  // asked, what they said, and what that does to the tags.
  if (options.details) printDetails('rate', result.report, { onlyAction: options.onlyChanged });

  if (result.applied && result.tagged > 0) {
    // Named here because an undo nobody can find is not an undo.
    log.info(`run ${run.id} — put it back with: abs-butler revert ${run.id}`);
  }
  if (!result.applied && result.wouldTag > 0) {
    log.info('re-run with --apply to write these tags to AudiobookShelf');
  }
  if (!options.details && result.rated > 0) {
    log.info('re-run with --details to see the evidence behind each rating');
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
