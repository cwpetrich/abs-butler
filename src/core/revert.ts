import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import type { TaskContext } from '../context.js';
import { getRun } from '../db/runs.js';
import { listRevisions, markReverted, type RevisionRecord } from '../db/revisions.js';
import { log } from '../logger.js';

/**
 * Putting a run back.
 *
 * The counterpart to every `--apply`, and the reason one can be run without
 * holding one's breath. It replays the `before` patch each write recorded,
 * which is the same shape and the same endpoint the original write used.
 */

export interface RevertPlan {
  revisionId: number;
  itemId: string;
  title: string;
  /** Fields this would restore, for the dry-run table. */
  fields: string[];
  patch: AbsMediaPatch;
}

export interface RevertSkip {
  itemId: string;
  title: string;
  reason: string;
}

export interface RevertTaskResult {
  runId: number;
  command: string | null;
  recorded: number;
  alreadyReverted: number;
  restored: number;
  applied: boolean;
  plans: RevertPlan[];
  skipped: RevertSkip[];
}

export const NOTHING_TO_REVERT =
  'That run changed nothing that can be put back. Only applied runs record ' +
  'revisions, and `organize` is not among them — it moves files, which this ' +
  'cannot undo by writing to the API.';

/** The fields a patch touches, named the way the dry-run table shows them. */
export function patchFields(patch: AbsMediaPatch): string[] {
  const fields = Object.keys(patch.metadata ?? {});
  if (patch.tags) fields.push('tags');
  return fields;
}

/**
 * Whether the item still looks the way the run left it.
 *
 * If someone has since corrected a title by hand, restoring the old one would
 * throw their work away silently — worse than the bad value they were fixing.
 * So a changed item is skipped and named, and `--force` is the way to say you
 * meant it anyway.
 */
export function changedSince(item: AbsLibraryItem, after: AbsMediaPatch): string | null {
  for (const [field, written] of Object.entries(after.metadata ?? {})) {
    if (!sameValue(readField(item, field), written)) {
      return `"${field}" has changed since the run`;
    }
  }

  if (after.tags && !sameSet(item.media?.tags ?? [], after.tags)) {
    return 'tags have changed since the run';
  }
  return null;
}

function readField(item: AbsLibraryItem, field: string): unknown {
  const metadata = item.media?.metadata;
  switch (field) {
    case 'authors':
      return (metadata?.authors ?? []).map((a) => a.name);
    case 'narrators':
      return [...(metadata?.narrators ?? [])];
    case 'series':
      return (metadata?.series ?? []).map((s) => `${s.name}#${s.sequence ?? ''}`);
    default:
      return (metadata as unknown as Record<string, unknown> | undefined)?.[field] ?? null;
  }
}

/** Compares a stored patch value against what the item reads back as. */
function sameValue(current: unknown, written: unknown): boolean {
  if (Array.isArray(written)) {
    const normalized = written.map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = entry as { name?: string; sequence?: string | null };
      return record.sequence === undefined ? (record.name ?? '') : `${record.name}#${record.sequence ?? ''}`;
    });
    return sameSet(current as string[], normalized);
  }
  return (current ?? null) === (written ?? null);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

export interface RevertTaskOptions {
  runId: number;
  apply?: boolean;
  /** Restore even where the item has been edited since the run. */
  force?: boolean;
}

export async function runRevertTask(
  ctx: TaskContext,
  options: RevertTaskOptions,
): Promise<RevertTaskResult> {
  const run = getRun(ctx.db, options.runId);
  const revisions = listRevisions(ctx.db, options.runId);
  if (revisions.length === 0) throw new Error(NOTHING_TO_REVERT);

  const pending = revisions.filter((r) => r.revertedAt === null);
  const alreadyReverted = revisions.length - pending.length;

  const plans: RevertPlan[] = [];
  const skipped: RevertSkip[] = [];

  for (const revision of pending) {
    const check = await inspect(ctx, revision, Boolean(options.force));
    if (check.reason) {
      skipped.push({ itemId: revision.itemId, title: revision.title, reason: check.reason });
      continue;
    }
    plans.push({
      revisionId: revision.id,
      itemId: revision.itemId,
      title: revision.title,
      fields: patchFields(revision.before),
      patch: revision.before,
    });
  }

  let restored = 0;
  if (options.apply) {
    // Newest first, so an item written more than once by the same run unwinds
    // in the order it was changed.
    for (const plan of [...plans].reverse()) {
      await ctx.client.patchItemMedia(plan.itemId, plan.patch);
      markReverted(ctx.db, plan.revisionId);
      restored += 1;
    }
    log.success(`Restored ${restored} item(s).`);
  } else {
    log.info(`${plans.length} item(s) would be restored. Apply to write.`);
  }

  if (skipped.length > 0) {
    log.warn(`${skipped.length} item(s) skipped — use --force to restore them anyway.`);
  }

  return {
    runId: options.runId,
    command: run?.command ?? null,
    recorded: revisions.length,
    alreadyReverted,
    restored,
    applied: Boolean(options.apply),
    plans,
    skipped,
  };
}

async function inspect(
  ctx: TaskContext,
  revision: RevisionRecord,
  force: boolean,
): Promise<{ reason: string | null }> {
  let item: AbsLibraryItem;
  try {
    item = await ctx.client.getItem(revision.itemId);
  } catch {
    // A book deleted since the run has nothing to restore onto, and inventing
    // it is not this command's business.
    return { reason: 'no longer on the server' };
  }
  if (force) return { reason: null };
  return { reason: changedSince(item, revision.after) };
}
