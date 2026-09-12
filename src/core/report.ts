import type { AbsLibraryItem } from '../abs/types.js';
import { itemAuthor, itemTitle, type TaskContext } from '../context.js';
import type { RunCommand } from '../db/runs.js';
import { recordRunItems, type RunItemInput, type RunItemStatus } from '../db/runItems.js';

/**
 * How each command says the three statuses out loud.
 *
 * The statuses themselves are shared — `action`, `clean`, `skipped` — so that a
 * report can be narrowed to the items worth looking at without knowing which
 * command produced it. What they *mean* is not shared: an audit's `action` is a
 * book with something wrong with it, an organize's is a book that moved. The
 * wording lives here, server-side, so the CLI and the web UI name them
 * identically rather than each keeping a copy that drifts.
 */
export const RUN_ITEM_LABELS: Record<RunCommand, Record<RunItemStatus, string>> = {
  audit: { action: 'With issues', clean: 'Passed', skipped: 'Not checked' },
  rate: { action: 'Tags change', clean: 'Tags already right', skipped: 'Already rated' },
  metadata: { action: 'Gaps to fill', clean: 'Nothing missing', skipped: 'Skipped' },
  normalize: { action: 'Corrections', clean: 'Already agrees', skipped: 'Held back' },
  organize: { action: 'Moves', clean: 'Already in place', skipped: 'Left alone' },
};

/** Where the book is, as ABS reports it — what someone needs to go and look. */
export function itemPath(item: AbsLibraryItem): string {
  return item.relPath ?? item.path ?? '';
}

/** The identity half of a row, so no task has to spell it out four ways. */
export function itemIdentity(item: AbsLibraryItem): Pick<RunItemInput, 'itemId' | 'title' | 'author' | 'path'> {
  return {
    itemId: item.id,
    title: itemTitle(item),
    author: itemAuthor(item),
    path: itemPath(item),
  };
}

/**
 * Records what the run had to say about each item it looked at.
 *
 * A no-op without a run to own the rows — `runTask` is also called from tests
 * and from contexts that are not a run — which is why every task may call it
 * unconditionally.
 */
export function reportItems(ctx: TaskContext, items: RunItemInput[]): void {
  if (ctx.runId === undefined) return;
  recordRunItems(ctx.db, ctx.runId, items);
}

/**
 * "3 adult, 1 young-adult" — the tail of the one-line breakdown every task logs
 * when it finishes.
 *
 * Counts on their own read as an alarm and give nobody anything to do: "25
 * item(s) have at least one issue" is usually one benign check firing across a
 * whole library. Naming the parts is what makes the number legible.
 */
export function breakdown(counts: Record<string, number>, order?: readonly string[]): string {
  const keys = order
    ? order.filter((key) => counts[key])
    : Object.keys(counts)
        .filter((key) => counts[key])
        .sort((a, b) => counts[b]! - counts[a]!);
  return keys.map((key) => `${counts[key]} ${key}`).join(', ');
}

/** `1 item`, `3 items` — pluralized, because "1 item(s)" reads like a stub. */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** Shortens a value for a one-line log or a table cell, keeping the shape of it. */
export function brief(value: string | null | undefined, max = 60): string {
  if (value === null || value === undefined || value === '') return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
