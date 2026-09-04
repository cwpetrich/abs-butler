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
 * large — an audit of 5,000 books carries 5,000 findings — so runs store the
 * headline numbers and the detail is re-derivable by running again.
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
        applied: r.applied,
        bandCounts: r.bandCounts,
        unknownBand: r.unknownBand,
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
      };
    }
    case 'normalize': {
      const r = result as NormalizeTaskResult;
      return {
        scanned: r.scanned,
        itemsToChange: r.itemsToChange,
        fieldsToChange: r.fieldsToChange,
        updated: r.updated,
        applied: r.applied,
        fields: r.fields,
        bySource: r.bySource,
      };
    }
    case 'organize': {
      const r = result as OrganizeTaskResult;
      return {
        template: r.template,
        planned: r.planned,
        moved: r.moved,
        skipped: r.skipped.length,
        applied: r.applied,
        rescanned: r.rescanned,
        canManageFiles: r.capability.canManageFiles,
      };
    }
  }
}
