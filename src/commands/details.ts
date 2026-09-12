import type { RunItemInput, RunItemStatus } from '../db/runItems.js';
import type { RunCommand } from '../db/runs.js';
import { RUN_ITEM_LABELS } from '../core/report.js';
import { color, log } from '../logger.js';
import { truncate } from '../util/text.js';

/**
 * Printing what a run did, book by book.
 *
 * The tables each command prints show the change it is proposing, which is the
 * right summary and a poor account: they leave out every book the run looked at
 * and left alone, and — for `rate` especially — the reasoning behind the line
 * they do show. That detail is computed either way and recorded with the run;
 * this is the same rows, rendered for a terminal.
 *
 * A block per item rather than a table, because the interesting part is a
 * handful of lines of evidence per book and no column is wide enough for it.
 */
const MARK: Record<RunItemStatus, string> = {
  action: color.yellow('»'),
  clean: color.green('ok'),
  skipped: color.dim('—'),
};

export function printDetails(
  command: RunCommand,
  rows: RunItemInput[],
  options: { onlyAction?: boolean } = {},
): void {
  const shown = options.onlyAction ? rows.filter((row) => row.status === 'action') : rows;
  if (shown.length === 0) {
    log.info('nothing to list');
    return;
  }

  log.out('');
  for (const row of shown) {
    const author = row.author ? color.dim(` — ${row.author}`) : '';
    log.out(`${MARK[row.status]} ${truncate(row.title, 60)}${author}`);
    for (const line of row.detail) log.out(`   ${color.dim(line)}`);
  }
  log.out('');

  const labels = RUN_ITEM_LABELS[command];
  const counted = (status: RunItemStatus) => rows.filter((row) => row.status === status).length;
  log.info(
    `${rows.length} item(s) — ${labels.action}: ${counted('action')}, ` +
      `${labels.clean}: ${counted('clean')}, ${labels.skipped}: ${counted('skipped')}`,
  );
}
