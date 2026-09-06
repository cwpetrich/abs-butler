import type { AbsMediaPatch } from '../abs/types.js';
import type { Db } from './index.js';

/**
 * What one run changed on one item, and how to put it back.
 *
 * `before` and `after` are both patches in the shape AudiobookShelf accepts, so
 * a revert is replaying `before` — there is nothing to interpret and no second
 * code path that could disagree with the one that made the change.
 */
export interface RevisionRecord {
  id: number;
  runId: number;
  itemId: string;
  title: string;
  before: AbsMediaPatch;
  after: AbsMediaPatch;
  createdAt: number;
  revertedAt: number | null;
}

interface RevisionRow {
  id: number;
  run_id: number;
  item_id: string;
  title: string;
  before: string;
  after: string;
  created_at: number;
  reverted_at: number | null;
}

function toRecord(row: RevisionRow): RevisionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    title: row.title,
    before: JSON.parse(row.before) as AbsMediaPatch,
    after: JSON.parse(row.after) as AbsMediaPatch,
    createdAt: row.created_at,
    revertedAt: row.reverted_at,
  };
}

export interface RevisionInput {
  runId: number;
  itemId: string;
  title: string;
  before: AbsMediaPatch;
  after: AbsMediaPatch;
}

export function recordRevision(db: Db, input: RevisionInput): void {
  db.prepare(
    `INSERT INTO revisions (run_id, item_id, title, before, after, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.itemId,
    input.title,
    JSON.stringify(input.before),
    JSON.stringify(input.after),
    Date.now(),
  );
}

/** Everything a run changed, oldest first. */
export function listRevisions(db: Db, runId: number): RevisionRecord[] {
  const rows = db
    .prepare('SELECT * FROM revisions WHERE run_id = ? ORDER BY id')
    .all(runId) as unknown as RevisionRow[];
  return rows.map(toRecord);
}

export function markReverted(db: Db, revisionId: number): void {
  db.prepare('UPDATE revisions SET reverted_at = ? WHERE id = ?').run(Date.now(), revisionId);
}

/** Runs that still have something to undo, newest first. */
export function revertableRuns(db: Db, limit = 20): Array<{ runId: number; pending: number }> {
  const rows = db
    .prepare(
      `SELECT run_id, COUNT(*) AS pending
       FROM revisions
       WHERE reverted_at IS NULL
       GROUP BY run_id
       ORDER BY run_id DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ run_id: number; pending: number }>;
  return rows.map((row) => ({ runId: row.run_id, pending: Number(row.pending) }));
}

export function countRevisions(db: Db, runId: number): { total: number; reverted: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(reverted_at) AS reverted FROM revisions WHERE run_id = ?`,
    )
    .get(runId) as unknown as { total: number; reverted: number };
  return { total: Number(row?.total ?? 0), reverted: Number(row?.reverted ?? 0) };
}
