import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import type { TaskContext } from '../context.js';
import type { ConnectionRecord } from '../db/connection.js';
import { openMemoryDb, type Db } from '../db/index.js';
import { listRevisions } from '../db/revisions.js';
import { countRunItemPlans, listRunItems, recordRunItems } from '../db/runItems.js';
import { createRun, type RunCommand } from '../db/runs.js';
import { getSettings, updateSettings } from '../db/settings.js';
import type { ItemPlan } from './plans.js';
import { runApplyTask } from './apply.js';

/**
 * What `apply` owes the person who read the report: that it writes what the
 * report said, that it does not write it over somebody's correction, and that
 * picking three books out of a thousand applies three books.
 */

let db: Db;
let dir: string;
const ORIGINAL_DATA_DIR = process.env.BUTLER_DATA_DIR;

/** Books as the fake server holds them, mutated by the patches under test. */
let library: Map<string, AbsLibraryItem>;
let patches: Array<{ itemId: string; patch: AbsMediaPatch }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-butler-apply-'));
  process.env.BUTLER_DATA_DIR = dir;
  db = openMemoryDb();
  library = new Map();
  patches = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.BUTLER_DATA_DIR;
  else process.env.BUTLER_DATA_DIR = ORIGINAL_DATA_DIR;
});

function book(id: string, metadata: Record<string, unknown>, tags: string[] = []): AbsLibraryItem {
  const item = {
    id,
    libraryId: 'lib',
    relPath: `${id}`,
    path: `/books/${id}`,
    media: { id: `m-${id}`, coverPath: null, tags, metadata },
  } as unknown as AbsLibraryItem;
  library.set(id, item);
  return item;
}

/** Applies a patch to the stored book the way AudiobookShelf would. */
function absorb(itemId: string, patch: AbsMediaPatch): void {
  const item = library.get(itemId)!;
  const metadata = item.media.metadata as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch.metadata ?? {})) metadata[field] = value;
  if (patch.tags) item.media.tags = [...patch.tags];
}

function context(runId: number): TaskContext {
  return {
    db,
    connection: { url: 'http://localhost:13378' } as unknown as ConnectionRecord,
    settings: getSettings(db),
    runId,
    client: {
      getItem: async (itemId: string) => {
        const item = library.get(itemId);
        if (!item) throw new Error('404');
        return item;
      },
      patchItemMedia: async (itemId: string, patch: AbsMediaPatch) => {
        patches.push({ itemId, patch });
        absorb(itemId, patch);
      },
      scanLibrary: async () => {},
    } as unknown as TaskContext['client'],
  } as TaskContext;
}

/** A finished dry run, with one recorded decision per book given. */
function dryRun(
  command: RunCommand,
  plans: Array<{ item: AbsLibraryItem; plan: ItemPlan }>,
): number {
  const run = createRun(db, { command, options: {}, dryRun: true, trigger: 'manual' });
  recordRunItems(
    db,
    run.id,
    plans.map(({ item, plan }) => ({
      itemId: item.id,
      title: (item.media.metadata.title as string) ?? item.id,
      author: null,
      path: item.relPath,
      status: 'action' as const,
      codes: ['planned'],
      detail: ['Would do something'],
      plan,
    })),
  );
  return run.id;
}

/** The run the apply itself is recorded as. */
function applyRun(command: RunCommand): number {
  return createRun(db, { command, options: {}, dryRun: false, trigger: 'manual' }).id;
}

const fill = (field: string, from: string | null, to: string): ItemPlan => ({
  kind: 'metadata',
  changes: [{ field, from, to, source: 'googlebooks' } as never],
});

describe('applying what a run decided', () => {
  it('writes the recorded value without asking a provider again', async () => {
    const item = book('a', { title: 'Dune', description: null });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);

    const result = await runApplyTask(context(applyRun('metadata')), {
      applyFrom: source,
      apply: true,
    });

    expect(result.written).toBe(1);
    expect(patches).toEqual([{ itemId: 'a', patch: { metadata: { description: 'Spice.' } } }]);
  });

  // The undo record is what makes applying a report a reversible act; without
  // it, saying yes to a dry run would be the one write with no way back.
  it('records how to undo everything it writes', async () => {
    const item = book('a', { title: 'Dune', description: null });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);
    const run = applyRun('metadata');

    await runApplyTask(context(run), { applyFrom: source, apply: true });

    const revisions = listRevisions(db, run);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.before).toEqual({ metadata: { description: null } });
  });

  // A dry run is the answer to "is this report still true?", which is exactly
  // the question a report read yesterday raises.
  it('writes nothing without apply, and leaves the report appliable', async () => {
    const item = book('a', { title: 'Dune', description: null });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);

    const result = await runApplyTask(context(applyRun('metadata')), { applyFrom: source });

    expect(patches).toHaveLength(0);
    expect(result.applied).toBe(false);
    expect(countRunItemPlans(db, source)).toBe(1);
  });

  it('applies only the books it was given', async () => {
    const first = book('a', { title: 'Dune', description: null });
    const second = book('b', { title: 'Emma', description: null });
    const source = dryRun('metadata', [
      { item: first, plan: fill('description', null, 'Spice.') },
      { item: second, plan: fill('description', null, 'Highbury.') },
    ]);

    const result = await runApplyTask(context(applyRun('metadata')), {
      applyFrom: source,
      items: ['b'],
      apply: true,
    });

    expect(result.selected).toBe(1);
    expect(patches.map((p) => p.itemId)).toEqual(['b']);
    // The book that was not picked is still waiting, so it can be applied later.
    expect(countRunItemPlans(db, source)).toBe(1);
  });

  // Writing over a correction somebody made in between is the one failure that
  // would make a stored plan worse than re-running the command.
  it('leaves a field alone when the library has moved on', async () => {
    const item = book('a', { title: 'Dune', description: 'Written by hand since.' });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);

    const result = await runApplyTask(context(applyRun('metadata')), {
      applyFrom: source,
      apply: true,
    });

    expect(patches).toHaveLength(0);
    expect(result.stale).toBe(1);
    expect(result.written).toBe(0);
  });

  it('says a book already carries what the run proposed rather than writing it again', async () => {
    const item = book('a', { title: 'Dune', description: 'Spice.' });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);

    const result = await runApplyTask(context(applyRun('metadata')), {
      applyFrom: source,
      apply: true,
    });

    expect(result.unchanged).toBe(1);
    expect(patches).toHaveLength(0);
  });

  // Once carried out it is not waiting any more, and the report it came from
  // should stop offering it.
  it('stops offering a change it has carried out', async () => {
    const item = book('a', { title: 'Dune', description: null });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);

    await runApplyTask(context(applyRun('metadata')), { applyFrom: source, apply: true });

    expect(countRunItemPlans(db, source)).toBe(0);
  });

  it('refuses a run that has nothing left to carry out', async () => {
    const empty = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' });
    await expect(
      runApplyTask(context(applyRun('audit')), { applyFrom: empty.id, apply: true }),
    ).rejects.toThrow(/nothing left to carry out/);
  });

  it('refuses to carry out one command as another', async () => {
    const item = book('a', { title: 'Dune', description: null });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);
    await expect(
      runApplyTask(context(applyRun('rate')), { applyFrom: source, command: 'rate', apply: true }),
    ).rejects.toThrow(/cannot be applied as rate/);
  });
});

describe('applying a rating', () => {
  // The recorded delta, not the tag list it wanted: a tag added in between is
  // somebody's own and has nothing to do with this run.
  it('adds and removes exactly what the run decided, leaving new tags alone', async () => {
    const item = book('a', { title: 'Dune' }, ['fiction', 'age:middle-grade']);
    const source = dryRun('rate', [
      {
        item,
        plan: { kind: 'rate', added: ['age:young-adult', 'abs-butler:rated'], removed: ['age:middle-grade'] },
      },
    ]);

    // Added by hand after the run looked, and nothing to do with it.
    item.media.tags.push('favourites');

    await runApplyTask(context(applyRun('rate')), { applyFrom: source, apply: true });

    expect(patches[0]!.patch.tags).toEqual([
      'fiction',
      'favourites',
      'age:young-adult',
      'abs-butler:rated',
    ]);
  });

  it('does nothing where the tags already say it', async () => {
    const item = book('a', { title: 'Dune' }, ['age:adult']);
    const source = dryRun('rate', [{ item, plan: { kind: 'rate', added: ['age:adult'], removed: [] } }]);

    const result = await runApplyTask(context(applyRun('rate')), { applyFrom: source, apply: true });

    expect(result.unchanged).toBe(1);
    expect(patches).toHaveLength(0);
  });
});

describe('applying a normalize', () => {
  const rename: ItemPlan = {
    kind: 'normalize',
    proposals: [
      { field: 'title', from: 'Hobbit, The', to: 'The Hobbit', source: 'local', detail: 'article' },
      { field: 'subtitle', from: null, to: 'There and Back Again', source: 'provider', detail: 'audible' },
    ],
  };

  it('writes the whole plan when rewriting is allowed', async () => {
    updateSettings(db, { allowMetadataRewrite: true });
    const item = book('a', { title: 'Hobbit, The', subtitle: null });
    const source = dryRun('normalize', [{ item, plan: rename }]);

    const result = await runApplyTask(context(applyRun('normalize')), {
      applyFrom: source,
      apply: true,
    });

    expect(result.written).toBe(1);
    expect(patches[0]!.patch.metadata).toEqual({
      title: 'The Hobbit',
      subtitle: 'There and Back Again',
    });
  });

  // The switch is re-read here rather than taken from the run that planned it,
  // so turning it on and applying the report is the way to get what was held.
  it('holds back a replacement while the switch is off, and still fills a blank', async () => {
    updateSettings(db, { allowMetadataRewrite: false });
    const item = book('a', { title: 'Hobbit, The', subtitle: null });
    const source = dryRun('normalize', [{ item, plan: rename }]);

    const result = await runApplyTask(context(applyRun('normalize')), {
      applyFrom: source,
      apply: true,
    });

    expect(result.heldBack).toBe(1);
    expect(patches[0]!.patch.metadata).toEqual({ subtitle: 'There and Back Again' });
  });

  it('keeps a wholly held-back book appliable, so turning the switch on is enough', async () => {
    updateSettings(db, { allowMetadataRewrite: false });
    const item = book('a', { title: 'Hobbit, The', subtitle: 'There and Back Again' });
    const source = dryRun('normalize', [{ item, plan: rename }]);

    const result = await runApplyTask(context(applyRun('normalize')), {
      applyFrom: source,
      apply: true,
    });

    expect(result.itemsHeldBack).toBe(1);
    expect(patches).toHaveLength(0);
    expect(countRunItemPlans(db, source)).toBe(1);
  });

  // Rebuilt against the book as it stands, which is what keeps the sequence the
  // library already knows and the tags this command does not own.
  it('rebuilds the patch from the book it is writing to', async () => {
    updateSettings(db, { allowMetadataRewrite: true });
    const item = book('a', {
      title: 'Dune',
      series: [{ id: 's', name: 'Dune Chronicles', sequence: '1' }],
    });
    const source = dryRun('normalize', [
      {
        item,
        plan: {
          kind: 'normalize',
          proposals: [
            {
              field: 'series',
              from: 'Dune Chronicles',
              to: 'Dune',
              source: 'provider',
              detail: 'audible',
              values: ['Dune'],
            },
          ],
        },
      },
    ]);

    await runApplyTask(context(applyRun('normalize')), { applyFrom: source, apply: true });

    expect(patches[0]!.patch.metadata?.series).toEqual([{ name: 'Dune', sequence: '1' }]);
  });
});

describe('the report an apply leaves behind', () => {
  it('records a row per book, the way every other command does', async () => {
    const first = book('a', { title: 'Dune', description: null });
    const second = book('b', { title: 'Emma', description: 'Already here.' });
    const source = dryRun('metadata', [
      { item: first, plan: fill('description', null, 'Spice.') },
      { item: second, plan: fill('description', null, 'Highbury.') },
    ]);
    const run = applyRun('metadata');

    await runApplyTask(context(run), { applyFrom: source, apply: true });

    const rows = listRunItems(db, { runId: run });
    expect(rows.map((row) => [row.itemId, row.status])).toEqual([
      ['a', 'action'],
      ['b', 'skipped'],
    ]);
    expect(rows[1]!.codes).toEqual(['changed-since']);
    // Nothing left to do to either of them from this run's own page.
    expect(rows.every((row) => row.plan === null)).toBe(true);
  });

  it('says so when a book has left the server', async () => {
    const item = book('a', { title: 'Dune', description: null });
    const source = dryRun('metadata', [{ item, plan: fill('description', null, 'Spice.') }]);
    library.delete('a');

    const result = await runApplyTask(context(applyRun('metadata')), {
      applyFrom: source,
      apply: true,
    });

    expect(result.missing).toBe(1);
    expect(result.written).toBe(0);
  });
});
