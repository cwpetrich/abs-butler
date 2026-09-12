import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import type { TaskContext } from '../context.js';
import { closeDb, openDb, type Db } from '../db/index.js';
import { countRunItems, listRunItems } from '../db/runItems.js';
import { createRun } from '../db/runs.js';
import { DEFAULT_SETTINGS } from '../db/settings.js';
import { auditItems, findDuplicates, runAuditTask } from './audit.js';

/**
 * An audit that only counts is not actionable: "37 books have no narrator"
 * cannot be acted on until you know which 37. These check that the detail
 * survives the run rather than being computed and thrown away.
 */

const library: AbsLibrary = {
  id: 'lib-1',
  name: 'Books',
  folders: [],
  mediaType: 'book',
  provider: 'audible',
};

const items = [
  {
    id: 'item-1',
    relPath: 'Herbert/Dune',
    media: {
      id: 'm1',
      coverPath: '/covers/1.jpg',
      tags: [],
      numTracks: 3,
      metadata: {
        title: 'Dune',
        authorName: 'Frank Herbert',
        asin: 'B002V0QCYU',
        description: 'A desert.',
        publishedYear: '1965',
        narratorName: 'Simon Vance',
      },
    },
  },
  {
    id: 'item-3',
    relPath: 'Austen/Emma',
    media: {
      id: 'm3',
      coverPath: '/covers/3.jpg',
      tags: ['abs-butler:rated', 'age:teen'],
      numTracks: 9,
      metadata: {
        title: 'Emma',
        authorName: 'Jane Austen',
        isbn: '9780141439587',
        description: 'A matchmaker.',
        publishedYear: '1815',
        narratorName: 'Juliet Stevenson',
      },
    },
  },
  {
    // An EPUB with no audio: a reading copy, not a broken import.
    id: 'item-4',
    relPath: 'Tolkien/The Hobbit',
    media: {
      id: 'm4',
      coverPath: '/covers/4.jpg',
      tags: ['abs-butler:rated'],
      numTracks: 0,
      ebookFormat: 'epub',
      metadata: {
        title: 'The Hobbit',
        authorName: 'J.R.R. Tolkien',
        isbn: '9780547928227',
        description: 'A hobbit.',
        publishedYear: '1937',
      },
    },
  },
  {
    // Neither audio nor an ebook: an import that produced an empty record.
    id: 'item-5',
    relPath: 'Empty/Nothing',
    media: {
      id: 'm5',
      coverPath: '/covers/5.jpg',
      tags: ['abs-butler:rated'],
      numTracks: 0,
      metadata: {
        title: 'Nothing At All',
        authorName: 'A Writer',
        isbn: '9780000000000',
        description: 'Empty.',
        publishedYear: '2020',
        narratorName: 'Nobody',
      },
    },
  },
  {
    id: 'item-2',
    relPath: 'Unknown/Mystery',
    media: {
      id: 'm2',
      coverPath: null,
      tags: [],
      numTracks: 1,
      metadata: { title: 'A Mystery' },
    },
  },
] as unknown as AbsLibraryItem[];

function client(): TaskContext['client'] {
  return {
    async listLibraries() {
      return [library];
    },
    async *iterateLibraryItems() {
      for (const item of items) yield item;
    },
  } as unknown as TaskContext['client'];
}

describe('runAuditTask', () => {
  let dir: string;
  let db: Db;

  function context(runId?: number): TaskContext {
    return {
      db,
      connection: { url: 'http://localhost:13378' } as TaskContext['connection'],
      client: client(),
      settings: DEFAULT_SETTINGS,
      ...(runId === undefined ? {} : { runId }),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butler-audit-'));
    process.env.BUTLER_DATA_DIR = dir;
    db = openDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.BUTLER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps which items were affected, not just how many', () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;

    return runAuditTask(context(runId)).then((result) => {
      expect(result.scanned).toBe(5);
      expect(result.itemsWithIssues).toBe(3);

      // Every audited item is recorded, including the one with nothing wrong:
      // a book missing from the report is indistinguishable from one that was
      // never scanned.
      const stored = listRunItems(db, { runId });
      expect(stored).toHaveLength(5);

      const mystery = stored.find((f) => f.itemId === 'item-2')!;
      // The second book is missing nearly everything, and each gap is named.
      expect(mystery.codes).toEqual(
        expect.arrayContaining(['missing-author', 'missing-cover', 'unmatched', 'missing-description']),
      );
      expect(mystery.title).toBe('A Mystery');
      expect(mystery.path).toBe('Unknown/Mystery');
    });
  });

  it('flags a fully populated book as unrated and nothing else', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await runAuditTask(context(runId));

    const dune = listRunItems(db, { runId }).find((f) => f.itemId === 'item-1')!;
    // Every book is unrated until `rate` has run once, which is why a first
    // audit legitimately reports the whole library.
    expect(dune.codes).toEqual(['unrated']);
  });

  it('records a clean item with no issues rather than leaving it out', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await runAuditTask(context(runId));

    const clean = listRunItems(db, { runId, status: 'clean' });
    // item-4 is an EPUB with no audio and no narrator, and both of those are
    // descriptions of a reading copy rather than faults in it.
    expect(clean.map((f) => f.itemId).sort()).toEqual(['item-3', 'item-4']);
    expect(clean[0]!.codes).toEqual([]);

    expect(listRunItems(db, { runId, status: 'action' }).map((f) => f.itemId).sort()).toEqual([
      'item-1',
      'item-2',
      'item-5',
    ]);
  });

  it('lists the worst first and the clean last', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await runAuditTask(context(runId));

    // item-2 is missing nearly everything, item-1 is only unrated, item-3 is
    // fine — so attention-first ordering is 2, 1, 3.
    const order = listRunItems(db, { runId }).map((f) => f.itemId);
    expect(order[0]).toBe('item-2');
    expect(order.slice(-2).sort()).toEqual(['item-3', 'item-4']);
  });

  it('does not call an ebook a broken book', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    const result = await runAuditTask(context(runId));

    // The whole point: an EPUB has no audio because it is an EPUB.
    expect(result.issueCounts['no-audio']).toBe(1);
    const empty = listRunItems(db, { runId }).find((f) => f.itemId === 'item-5')!;
    expect(empty.codes).toContain('no-audio');

    const ebook = listRunItems(db, { runId }).find((f) => f.itemId === 'item-4')!;
    expect(ebook.codes).not.toContain('no-audio');
    // Nor is it missing a narrator it was never going to have.
    expect(ebook.codes).not.toContain('missing-narrator');
  });

  it('still asks an audiobook for its narrator when an ebook sits beside it', () => {
    const both = [
      {
        id: 'both',
        relPath: 'X/Y',
        media: { id: 'mb', coverPath: '/c.jpg', tags: [], numTracks: 4, ebookFormat: 'epub', metadata: { title: 'Both', authorName: 'A', isbn: '9780000000001', description: 'd', publishedYear: '2001' } },
      },
    ] as unknown as Parameters<typeof auditItems>[0];

    expect(auditItems(both)[0]!.issues).toContain('missing-narrator');
  });

  /**
   * One book in two formats is not a mistake, and `duplicate` is a warning
   * someone acts on — sometimes by deleting something.
   */
  it('does not call an ebook and an audiobook of the same book duplicates', () => {
    const pair = [
      { id: 'a', relPath: 'x', media: { id: 'ma', coverPath: null, tags: [], numTracks: 5, metadata: { title: 'Dune', authorName: 'Frank Herbert' } } },
      { id: 'b', relPath: 'y', media: { id: 'mb', coverPath: null, tags: [], ebookFormat: 'epub', metadata: { title: 'Dune', authorName: 'Frank Herbert' } } },
    ] as unknown as Parameters<typeof findDuplicates>[0];

    expect(findDuplicates(pair)).toEqual([]);
    // Unless asked for.
    expect(findDuplicates(pair, { crossFormat: true })).toHaveLength(1);
  });

  it('still reports two copies of the same format', () => {
    const twice = [
      { id: 'a', relPath: 'Dune', media: { id: 'ma', coverPath: null, tags: [], ebookFormat: 'epub', metadata: { title: 'Dune', authorName: 'Frank Herbert' } } },
      { id: 'b', relPath: 'Dune (1)', media: { id: 'mb', coverPath: null, tags: [], ebookFormat: 'epub', metadata: { title: 'Dune', authorName: 'Frank Herbert' } } },
    ] as unknown as Parameters<typeof findDuplicates>[0];

    // The case actually worth catching: the same book imported twice.
    expect(findDuplicates(twice)).toHaveLength(1);
  });

  it('records nothing when no run owns the work', async () => {
    const result = await runAuditTask(context());
    expect(result.findings).toHaveLength(5);
    expect(countRunItems(db, { runId: 0 })).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_items').get()).toMatchObject({ n: 0 });
  });
});
