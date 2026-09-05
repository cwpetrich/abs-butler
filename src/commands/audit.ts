import { ISSUES, runAuditTask, type IssueCode } from '../core/audit.js';
import { openStore, type GlobalOptions } from '../context.js';
import { withRun } from '../core/execute.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface AuditOptions extends GlobalOptions {
  json?: boolean;
  only?: string[];
  limit?: number;
  details?: boolean;
}

export async function runAudit(options: AuditOptions): Promise<void> {
  const db = openStore();
  // Recorded as a run like any other, so it shows in history and — for the
  // commands that write — can be undone with `abs-butler revert`.
  const { ctx, result } = await withRun(db, 'audit', options as Record<string, unknown>, (c) =>
    runAuditTask(c, options),
  );

  if (options.json) {
    printJson({ server: ctx.connection.url, ...result });
    return;
  }

  const counts = result.issueCounts;
  if (Object.keys(counts).length === 0) return;

  printTable(
    ISSUES.filter((spec) => (counts[spec.code] ?? 0) > 0).map((spec) => ({
      spec,
      count: counts[spec.code]!,
    })),
    [
      {
        header: 'ISSUE',
        value: ({ spec }) =>
          spec.severity === 'error'
            ? color.red(spec.label)
            : spec.severity === 'warn'
              ? color.yellow(spec.label)
              : spec.label,
      },
      { header: 'CODE', value: ({ spec }) => color.dim(spec.code) },
      { header: 'ITEMS', value: ({ count }) => String(count), align: 'right' },
    ],
  );

  if (options.details) {
    log.out('');
    printTable(result.findings, [
      { header: 'TITLE', value: (f) => truncate(f.title, 48), maxWidth: 48 },
      { header: 'AUTHOR', value: (f) => truncate(f.author ?? '—', 26), maxWidth: 26 },
      { header: 'ISSUES', value: (f) => f.issues.join(', ') },
    ]);
  } else if (result.findings.length > 0) {
    log.info('re-run with --details to list the affected items');
  }
}

export type { IssueCode };
