import type { TaskContext } from '../context.js';
import type { RunCommand } from '../db/runs.js';
import { runAuditTask, type AuditTaskResult } from './audit.js';
import { runMetadataTask, type MetadataTaskResult } from './metadata.js';
import { runNormalizeTask, type NormalizeTaskResult } from './normalize.js';
import { runOrganizeTask, type OrganizeTaskResult } from './organize.js';
import { runRateTask, type RateTaskResult } from './rate.js';

export type TaskResult =
  | AuditTaskResult
  | RateTaskResult
  | MetadataTaskResult
  | NormalizeTaskResult
  | OrganizeTaskResult;

export const COMMANDS: RunCommand[] = ['audit', 'rate', 'metadata', 'normalize', 'organize'];

/** Commands that need the media mounted on this machine. */
export const FILE_COMMANDS: ReadonlySet<RunCommand> = new Set<RunCommand>(['organize']);

/** Commands that can change the server or the filesystem when applied. */
export const MUTATING_COMMANDS: ReadonlySet<RunCommand> = new Set<RunCommand>([
  'rate',
  'metadata',
  'normalize',
  'organize',
]);

export function isRunCommand(value: string): value is RunCommand {
  return (COMMANDS as string[]).includes(value);
}

/**
 * Single entry point used by both the CLI and the job runner, so a scheduled
 * run and a typed one execute exactly the same code path.
 */
export async function runTask(
  ctx: TaskContext,
  command: RunCommand,
  options: Record<string, unknown> = {},
): Promise<TaskResult> {
  switch (command) {
    case 'audit':
      return runAuditTask(ctx, options);
    case 'rate':
      return runRateTask(ctx, options);
    case 'metadata':
      return runMetadataTask(ctx, options);
    case 'normalize':
      return runNormalizeTask(ctx, options);
    case 'organize':
      return runOrganizeTask(ctx, options);
  }
}

/**
 * A compact, JSON-safe digest for the history list. The full result can be
 * large — a run over 5,000 books carries a row per book — so runs store the
 * headline numbers here and the per-item detail goes to `run_items`, which is
 * read only when someone opens the run that produced it.
 *
 * The breakdowns travel with the numbers. "38 item(s) would be updated" is the
 * same sentence whether it is 38 missing descriptions or one field missing
 * everywhere, and the counts are what make the difference legible from the
 * history list without opening anything.
 */
export function summarizeResult(command: RunCommand, result: TaskResult): Record<string, unknown> {
  switch (command) {
    case 'audit': {
      const r = result as AuditTaskResult;
      return {
        scanned: r.scanned,
        itemsWithIssues: r.itemsWithIssues,
        issueCounts: r.issueCounts,
        libraries: r.libraries.map((l) => l.name),
      };
    }
    case 'rate': {
      const r = result as RateTaskResult;
      return {
        rated: r.rated,
        tagged: r.tagged,
        wouldTag: r.wouldTag,
        unchanged: r.unchanged,
        applied: r.applied,
        bandCounts: r.bandCounts,
        flagCounts: r.flagCounts,
        unknownBand: r.unknownBand,
        belowConfidence: r.belowConfidence,
        skippedAlreadyRated: r.skippedAlreadyRated,
      };
    }
    case 'metadata': {
      const r = result as MetadataTaskResult;
      return {
        scanned: r.scanned,
        itemsToUpdate: r.itemsToUpdate,
        fieldsToFill: r.fieldsToFill,
        updated: r.updated,
        applied: r.applied,
        fields: r.fields,
        fieldCounts: r.fieldCounts,
        sourceCounts: r.sourceCounts,
      };
    }
    case 'normalize': {
      const r = result as NormalizeTaskResult;
      return {
        scanned: r.scanned,
        itemsToChange: r.itemsToChange,
        fieldsToChange: r.fieldsToChange,
        heldBack: r.heldBack,
        itemsHeldBack: r.itemsHeldBack,
        updated: r.updated,
        applied: r.applied,
        fields: r.fields,
        bySource: r.bySource,
        byField: r.byField,
      };
    }
    case 'organize': {
      const r = result as OrganizeTaskResult;
      return {
        template: r.template,
        scanned: r.scanned,
        planned: r.planned,
        moved: r.moved,
        inPlace: r.inPlace,
        skipped: r.skipped.length,
        declined: r.declined,
        applied: r.applied,
        rescanned: r.rescanned,
        canManageFiles: r.capability.canManageFiles,
      };
    }
  }
}
