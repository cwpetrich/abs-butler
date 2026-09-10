import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, type Db } from './index.js';
import { completeRun, createRun } from './runs.js';
import { countFindings, listFindings, pruneFindings, recordFindings } from './findings.js';

let db: Db;
const ORIGINAL_DATA_DIR = process.env.BUTLER_DATA_DIR;

beforeEach(() => {
  process.env.BUTLER_DATA_DIR = mkdtempSync(join(tmpdir(), 'abs-butler-findings-'));
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

const sample = [
  { itemId: 'a', title: 'Dune', author: 'Frank Herbert', path: '/b/dune', issues: ['unrated', 'missing-cover'] },
  { itemId: 'b', title: 'Emma', author: 'Jane Austen', path: '/b/emma', issues: ['unrated'] },
  { itemId: 'c', title: 'No Title', author: null, path: '/b/x', issues: ['missing-title'] },
];

describe('findings', () => {
  it('records and reads back what an audit found', () => {
    const runId = audit();
    recordFindings(db, runId, sample);

    const all = listFindings(db, { runId });
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({
      itemId: 'a',
      title: 'Dune',
      author: 'Frank Herbert',
      path: '/b/dune',
      issues: ['unrated', 'missing-cover'],
    });
    expect(all[2]!.author).toBeNull();
  });

  it('filters by issue code without matching a code inside another', () => {
    const runId = audit();
    recordFindings(db, runId, [
      ...sample,
      // 'title' is a substring of 'missing-title'; a naive LIKE would match both.
      { itemId: 'd', title: 'Substring Bait', author: null, path: '/b/d', issues: ['title'] },
    ]);

    expect(listFindings(db, { runId, issue: 'unrated' }).map((f) => f.itemId)).toEqual(['a', 'b']);
    expect(listFindings(db, { runId, issue: 'missing-title' }).map((f) => f.itemId)).toEqual(['c']);
    expect(listFindings(db, { runId, issue: 'title' }).map((f) => f.itemId)).toEqual(['d']);
    expect(countFindings(db, { runId, issue: 'unrated' })).toBe(2);
    expect(countFindings(db, { runId })).toBe(4);
  });

  it('pages, so a large library is not sent in one response', () => {
    const runId = audit();
    recordFindings(db, runId, sample);

    expect(listFindings(db, { runId, limit: 2 }).map((f) => f.itemId)).toEqual(['a', 'b']);
    expect(listFindings(db, { runId, limit: 2, offset: 2 }).map((f) => f.itemId)).toEqual(['c']);
    // The count is of everything matched, not of the page returned — it is what
    // tells the UI there is more to ask for.
    expect(countFindings(db, { runId, limit: 2 })).toBe(3);
  });

  it('replaces rather than appends when the same run is recorded twice', () => {
    const runId = audit();
    recordFindings(db, runId, sample);
    recordFindings(db, runId, [sample[0]!]);
    expect(countFindings(db, { runId })).toBe(1);
  });

  it('goes when its run goes', () => {
    const runId = audit();
    recordFindings(db, runId, sample);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    expect(countFindings(db, { runId })).toBe(0);
  });

  it('keeps detail for recent audits only, leaving the counts alone', () => {
    const runs = Array.from({ length: 4 }, () => {
      const id = audit();
      recordFindings(db, id, sample);
      completeRun(db, id, { status: 'success', summary: { itemsWithIssues: 3 } });
      return id;
    });

    expect(pruneFindings(db, 2)).toBe(6);
    expect(countFindings(db, { runId: runs[0]! })).toBe(0);
    expect(countFindings(db, { runId: runs[1]! })).toBe(0);
    expect(countFindings(db, { runId: runs[2]! })).toBe(3);
    expect(countFindings(db, { runId: runs[3]! })).toBe(3);

    // The run itself, and the counts it summarized, are untouched.
    const kept = db.prepare('SELECT summary FROM runs WHERE id = ?').get(runs[0]!) as { summary: string };
    expect(JSON.parse(kept.summary)).toEqual({ itemsWithIssues: 3 });
  });
});
