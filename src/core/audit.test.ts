import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import type { TaskContext } from '../context.js';
import { closeDb, openDb, type Db } from '../db/index.js';
import { countFindings, listFindings } from '../db/findings.js';
import { createRun } from '../db/runs.js';
import { DEFAULT_SETTINGS } from '../db/settings.js';
import { runAuditTask } from './audit.js';

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
      expect(result.scanned).toBe(3);
      expect(result.itemsWithIssues).toBe(2);

      // Every audited item is recorded, including the one with nothing wrong:
      // a book missing from the report is indistinguishable from one that was
      // never scanned.
      const stored = listFindings(db, { runId });
      expect(stored).toHaveLength(3);

      const mystery = stored.find((f) => f.itemId === 'item-2')!;
      // The second book is missing nearly everything, and each gap is named.
      expect(mystery.issues).toEqual(
        expect.arrayContaining(['missing-author', 'missing-cover', 'unmatched', 'missing-description']),
      );
      expect(mystery.title).toBe('A Mystery');
      expect(mystery.path).toBe('Unknown/Mystery');
    });
  });

  it('flags a fully populated book as unrated and nothing else', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await runAuditTask(context(runId));

    const dune = listFindings(db, { runId }).find((f) => f.itemId === 'item-1')!;
    // Every book is unrated until `rate` has run once, which is why a first
    // audit legitimately reports the whole library.
    expect(dune.issues).toEqual(['unrated']);
  });

  it('records a clean item with no issues rather than leaving it out', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await runAuditTask(context(runId));

    const clean = listFindings(db, { runId, status: 'clean' });
    expect(clean.map((f) => f.itemId)).toEqual(['item-3']);
    expect(clean[0]!.issues).toEqual([]);

    expect(listFindings(db, { runId, status: 'issues' }).map((f) => f.itemId).sort()).toEqual([
      'item-1',
      'item-2',
    ]);
  });

  it('lists the worst first and the clean last', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await runAuditTask(context(runId));

    // item-2 is missing nearly everything, item-1 is only unrated, item-3 is
    // fine — so attention-first ordering is 2, 1, 3.
    expect(listFindings(db, { runId }).map((f) => f.itemId)).toEqual(['item-2', 'item-1', 'item-3']);
  });

  it('records nothing when no run owns the work', async () => {
    const result = await runAuditTask(context());
    expect(result.findings).toHaveLength(3);
    expect(countFindings(db, { runId: 0 })).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM findings').get()).toMatchObject({ n: 0 });
  });
});
