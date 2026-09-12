import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from './index.js';
import { completeRun, createRun } from './runs.js';
import {
  clearRunItemPlans,
  countRunItemPlans,
  countRunItemPlansByRun,
  countRunItems,
  listRunItemPlans,
  listRunItems,
  pruneRunItems,
  recordRunItems,
  summarizeRunItems,
  type RunItemInput,
} from './runItems.js';

let db: Db;
const ORIGINAL_DATA_DIR = process.env.BUTLER_DATA_DIR;

beforeEach(() => {
  process.env.BUTLER_DATA_DIR = mkdtempSync(join(tmpdir(), 'abs-butler-run-items-'));
  db = openMemoryDb();
});

afterEach(() => {
  db.close();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.BUTLER_DATA_DIR;
  else process.env.BUTLER_DATA_DIR = ORIGINAL_DATA_DIR;
});

function audit(): number {
  return createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
}

const sample: RunItemInput[] = [
  { itemId: 'a', title: 'Dune', author: 'Frank Herbert', path: '/b/dune', status: 'action', codes: ['unrated', 'missing-cover'], detail: ['No age rating from abs-butler', 'No cover art'] },
  { itemId: 'b', title: 'Emma', author: 'Jane Austen', path: '/b/emma', status: 'action', codes: ['unrated'], detail: [] },
  { itemId: 'c', title: 'No Title', author: null, path: '/b/x', status: 'action', codes: ['missing-title'], detail: [] },
];

/** An item the run looked at and had nothing to do to. */
const clean: RunItemInput = {
  itemId: 'd',
  title: 'Persuasion',
  author: 'Jane Austen',
  path: '/b/p',
  status: 'clean',
  codes: [],
  detail: [],
};

describe('run items', () => {
  it('records and reads back what a run did', () => {
    const runId = audit();
    recordRunItems(db, runId, sample);

    const all = listRunItems(db, { runId });
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({
      itemId: 'a',
      title: 'Dune',
      author: 'Frank Herbert',
      path: '/b/dune',
      codes: ['unrated', 'missing-cover'],
      detail: ['No age rating from abs-butler', 'No cover art'],
    });
    expect(all[2]!.author).toBeNull();
  });

  it('separates the items with something to do from the ones without', () => {
    const runId = audit();
    recordRunItems(db, runId, [...sample, clean]);

    expect(listRunItems(db, { runId, status: 'clean' }).map((item) => item.itemId)).toEqual(['d']);
    expect(listRunItems(db, { runId, status: 'action' }).map((item) => item.itemId)).toEqual(['a', 'b', 'c']);
    // Unfiltered means everything audited, which is the point of recording the
    // passes at all.
    expect(countRunItems(db, { runId })).toBe(4);
    expect(countRunItems(db, { runId, status: 'clean' })).toBe(1);
  });

  it('reads an empty code list back as empty', () => {
    const runId = audit();
    recordRunItems(db, runId, [clean]);
    expect(listRunItems(db, { runId })[0]!.codes).toEqual([]);
  });

  it('filters by code without matching a code inside another', () => {
    const runId = audit();
    recordRunItems(db, runId, [
      ...sample,
      // 'title' is a substring of 'missing-title'; a naive LIKE would match both.
      { itemId: 'd', title: 'Substring Bait', author: null, path: '/b/d', status: 'action' as const, codes: ['title'], detail: [] },
    ]);

    expect(listRunItems(db, { runId, code: 'unrated' }).map((item) => item.itemId)).toEqual(['a', 'b']);
    expect(listRunItems(db, { runId, code: 'missing-title' }).map((item) => item.itemId)).toEqual(['c']);
    expect(listRunItems(db, { runId, code: 'title' }).map((item) => item.itemId)).toEqual(['d']);
    expect(countRunItems(db, { runId, code: 'unrated' })).toBe(2);
    expect(countRunItems(db, { runId })).toBe(4);
  });

  it('pages, so a large library is not sent in one response', () => {
    const runId = audit();
    recordRunItems(db, runId, sample);

    expect(listRunItems(db, { runId, limit: 2 }).map((item) => item.itemId)).toEqual(['a', 'b']);
    expect(listRunItems(db, { runId, limit: 2, offset: 2 }).map((item) => item.itemId)).toEqual(['c']);
    // The count is of everything matched, not of the page returned — it is what
    // tells the UI there is more to ask for.
    expect(countRunItems(db, { runId, limit: 2 })).toBe(3);
  });

  it('replaces rather than appends when the same run is recorded twice', () => {
    const runId = audit();
    recordRunItems(db, runId, sample);
    recordRunItems(db, runId, [sample[0]!]);
    expect(countRunItems(db, { runId })).toBe(1);
  });

  // The counts behind the filter chips. Computed from the rows rather than from
  // each command's summary, so a page of items and the chips above it cannot
  // disagree about how many there are.
  it('counts every status and code across the run', () => {
    const runId = audit();
    recordRunItems(db, runId, [
      ...sample,
      clean,
      { itemId: 'e', title: 'Left Alone', author: null, path: '/b/e', status: 'skipped', codes: ['already-rated'], detail: ['Already rated'] },
    ]);

    const totals = summarizeRunItems(db, runId);
    expect(totals.total).toBe(5);
    expect(totals.byStatus).toEqual({ action: 3, clean: 1, skipped: 1 });
    expect(totals.byCode).toEqual({
      unrated: 2,
      'missing-cover': 1,
      'missing-title': 1,
      'already-rated': 1,
    });
  });

  it('counts nothing for a run that recorded nothing', () => {
    expect(summarizeRunItems(db, audit())).toEqual({
      total: 0,
      byStatus: { action: 0, clean: 0, skipped: 0 },
      byCode: {},
      appliable: 0,
    });
  });

  it('goes when its run goes', () => {
    const runId = audit();
    recordRunItems(db, runId, sample);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    expect(countRunItems(db, { runId })).toBe(0);
  });

  it('keeps detail for recent runs only, leaving the counts alone', () => {
    const runs = Array.from({ length: 4 }, () => {
      const id = audit();
      recordRunItems(db, id, sample);
      completeRun(db, id, { status: 'success', summary: { itemsWithIssues: 3 } });
      return id;
    });

    expect(pruneRunItems(db, 2)).toBe(6);
    expect(countRunItems(db, { runId: runs[0]! })).toBe(0);
    expect(countRunItems(db, { runId: runs[1]! })).toBe(0);
    expect(countRunItems(db, { runId: runs[2]! })).toBe(3);
    expect(countRunItems(db, { runId: runs[3]! })).toBe(3);

    // The run itself, and the counts it summarized, are untouched.
    const kept = db.prepare('SELECT summary FROM runs WHERE id = ?').get(runs[0]!) as { summary: string };
    expect(JSON.parse(kept.summary)).toEqual({ itemsWithIssues: 3 });
  });
});

/**
 * A run's decisions, kept so they can be carried out later. The row says what
 * happened in words; this is the same thing in a form that can be replayed.
 */
describe('what a run decided', () => {
  const waiting: RunItemInput[] = [
    {
      itemId: 'a',
      title: 'Dune',
      author: 'Frank Herbert',
      path: '/b/dune',
      status: 'action',
      codes: ['description'],
      detail: ['Would set description'],
      plan: {
        kind: 'metadata',
        changes: [{ field: 'description', from: null, to: 'Spice.', source: 'googlebooks' }],
      },
    },
    {
      itemId: 'b',
      title: 'Emma',
      author: 'Jane Austen',
      path: '/b/emma',
      status: 'clean',
      codes: [],
      detail: ['Nothing missing'],
    },
  ];

  function seeded(): number {
    const runId = createRun(db, {
      command: 'metadata',
      options: {},
      dryRun: true,
      trigger: 'manual',
    }).id;
    recordRunItems(db, runId, waiting);
    return runId;
  }

  it('reads a plan back exactly as it was stored', () => {
    const runId = seeded();
    const plans = listRunItemPlans(db, runId);

    expect(plans).toHaveLength(1);
    expect(plans[0]!.itemId).toBe('a');
    expect(plans[0]!.plan).toEqual({
      kind: 'metadata',
      changes: [{ field: 'description', from: null, to: 'Spice.', source: 'googlebooks' }],
    });
  });

  it('leaves a row with nothing to do without one', () => {
    const runId = seeded();
    expect(listRunItems(db, { runId })[1]!.plan).toBeNull();
    expect(countRunItemPlans(db, runId)).toBe(1);
  });

  it('narrows to the books asked for', () => {
    const runId = seeded();
    expect(listRunItemPlans(db, runId, ['b'])).toHaveLength(0);
    expect(listRunItemPlans(db, runId, ['a', 'b'])).toHaveLength(1);
  });

  // Carried out is not waiting: the report it came from should stop offering it.
  it('forgets a plan once it has been carried out', () => {
    const runId = seeded();
    clearRunItemPlans(db, runId, ['a']);

    expect(countRunItemPlans(db, runId)).toBe(0);
    // The row itself stays — it is still the account of what the run did.
    expect(listRunItems(db, { runId })).toHaveLength(2);
  });

  it('counts what every run has waiting in one pass', () => {
    const first = seeded();
    const second = seeded();
    clearRunItemPlans(db, second, ['a']);

    const counts = countRunItemPlansByRun(db);
    expect(counts.get(first)).toBe(1);
    expect(counts.has(second)).toBe(false);
  });

  // Rows outlive the code that wrote them. A plan this version cannot read
  // should leave the row unappliable rather than reach the apply path.
  it('ignores a plan it cannot make sense of', () => {
    const runId = seeded();
    db.prepare("UPDATE run_items SET plan = ? WHERE run_id = ? AND item_id = 'a'").run(
      '{"kind":"telepathy"}',
      runId,
    );

    expect(listRunItems(db, { runId })[0]!.plan).toBeNull();
    expect(listRunItemPlans(db, runId)).toHaveLength(0);
  });
});
