import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { itemTitle, type TaskContext } from '../context.js';
import { recordRevision } from '../db/revisions.js';

/**
 * Recording what a write is about to overwrite.
 *
 * Every mutating command routes its writes through `applyPatch`, so an undo
 * record cannot be forgotten by whichever command is added next — the only way
 * to change an item is the way that records the change.
 */

/**
 * The patch that would put this item back the way it is now.
 *
 * Built from the *outgoing* patch rather than from the whole item: restoring
 * only what a run actually touched means an unrelated edit made in between is
 * left alone, and it keeps the record small enough to store for every item of
 * a five-thousand-book library.
 *
 * A field the item did not have comes back as null or an empty list, which is
 * the honest inverse of having supplied one — the point is to restore the state
 * as it was, including its gaps.
 */
export function inversePatch(item: AbsLibraryItem, patch: AbsMediaPatch): AbsMediaPatch {
  const metadata = item.media?.metadata;
  const inverse: AbsMediaPatch = {};

  if (patch.metadata) {
    const before: NonNullable<AbsMediaPatch['metadata']> = {};
    for (const field of Object.keys(patch.metadata) as Array<keyof typeof patch.metadata>) {
      switch (field) {
        case 'authors':
          before.authors = (metadata?.authors ?? []).map((a) => ({ name: a.name }));
          break;
        case 'narrators':
          before.narrators = [...(metadata?.narrators ?? [])];
          break;
        case 'series':
          before.series = (metadata?.series ?? []).map((s) => ({
            name: s.name,
            sequence: s.sequence ?? null,
          }));
          break;
        default: {
          // The scalar metadata fields, which all read straight off the item.
          const current = (metadata as unknown as Record<string, unknown> | undefined)?.[field];
          (before as Record<string, unknown>)[field] = current ?? null;
        }
      }
    }
    inverse.metadata = before;
  }

  if (patch.tags) inverse.tags = [...(item.media?.tags ?? [])];

  return inverse;
}

/**
 * Writes a patch, having first recorded how to undo it.
 *
 * The record is written before the API call, not after: a run interrupted
 * mid-write leaves an undo entry for a change that may not have landed, and
 * replaying it is harmless, while the reverse order would leave a change with
 * no way back. Erring toward a redundant record is the cheap mistake.
 *
 * `runId` is absent only where no run owns the write, and the change then goes
 * unrecorded — the caller has to have decided that is acceptable.
 */
export async function applyPatch(
  ctx: TaskContext,
  item: AbsLibraryItem,
  patch: AbsMediaPatch,
): Promise<void> {
  if (ctx.runId !== undefined) {
    recordRevision(ctx.db, {
      runId: ctx.runId,
      itemId: item.id,
      title: itemTitle(item),
      before: inversePatch(item, patch),
      after: patch,
    });
  }
  await ctx.client.patchItemMedia(item.id, patch);
}
