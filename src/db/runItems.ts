import { isItemPlan, type ItemPlan } from '../core/plans.js';
import type { Db } from './index.js';

/**
 * What a run had to say about one item.
 *
 * - `action`  — something to do, or something done: an issue found, a change
 *   written, or one that would be written on apply.
 * - `clean`   — looked at, nothing to do.
 * - `skipped` — passed over on purpose, with the reason in `detail`.
 *
 * Every scanned item is recorded, not only the interesting ones. A book absent
 * from a run's report is indistinguishable from one that was never looked at,
 * and "what did you leave alone, and why" is as much a question as "what did
 * you change".
 */
export type RunItemStatus = 'action' | 'clean' | 'skipped';

export const RUN_ITEM_STATUSES: RunItemStatus[] = ['action', 'clean', 'skipped'];

export interface RunItemRecord {
  id: number;
  runId: number;
  itemId: string;
  title: string;
  author: string | null;
  path: string;
  status: RunItemStatus;
  /** Facets this item matched, in the command's own vocabulary. */
  codes: string[];
  /** What the run has to say about it, one line per thing. */
  detail: string[];
  /**
   * The change itself, in a form that can still be carried out — null wherever
   * there is nothing left to do, which includes everything the run already
   * wrote. See core/plans.ts.
   */
  plan: ItemPlan | null;
}

interface RunItemRow {
  id: number;
  run_id: number;
  item_id: string;
  title: string;
  author: string | null;
  path: string;
  status: string;
  codes: string;
  detail: string;
  plan: string | null;
}

/**
 * Codes are stored comma-joined *and* comma-wrapped — ",missing-title," rather
 * than "missing-title" — so that matching one code is a plain LIKE '%,x,%'
 * with no risk of a short code matching inside a longer one.
 */
function encode(codes: string[]): string {
  return `,${codes.join(',')},`;
}

function decode(value: string): string[] {
  return value.split(',').filter(Boolean);
}

/**
 * A plan is replayed, never queried, so it travels as JSON in one column — and
 * is validated on the way out, since a row can outlive the version that wrote
 * it. Anything unrecognisable reads back as no plan at all, which leaves the
 * row exactly as unappliable as one that never had one.
 */
function decodePlan(value: string | null): ItemPlan | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isItemPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Detail is display text, never queried, so it travels as JSON in one column. */
function decodeDetail(value: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toRecord(row: RunItemRow): RunItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    title: row.title,
    author: row.author,
    path: row.path,
    status: row.status as RunItemStatus,
    codes: decode(row.codes),
    detail: decodeDetail(row.detail),
    plan: decodePlan(row.plan),
  };
}

export interface RunItemInput {
  itemId: string;
  title: string;
  author: string | null;
  path: string;
  status: RunItemStatus;
  codes: string[];
  detail: string[];
  /** What is left to do to this book, if anything. See core/plans.ts. */
  plan?: ItemPlan | null;
}

/**
 * Replaces this run's items with the ones given.
 *
 * Written as one transaction because a run over a large library is thousands
 * of rows, and one INSERT each would take longer than the run did. Replacing
 * rather than appending keeps a re-run of the same run id — which only happens
 * in tests — from doubling everything.
 */
export function recordRunItems(db: Db, runId: number, items: RunItemInput[]): void {
  const insert = db.prepare(
    `INSERT INTO run_items (run_id, item_id, title, author, path, status, codes, detail, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM run_items WHERE run_id = ?').run(runId);
    for (const item of items) {
      insert.run(
        runId,
        item.itemId,
        item.title,
        item.author,
        item.path,
        item.status,
        encode(item.codes),
        JSON.stringify(item.detail),
        item.plan ? JSON.stringify(item.plan) : null,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface RunItemQuery {
  runId: number;
  /** Restrict to items carrying this code. */
  code?: string;
  status?: RunItemStatus;
  limit?: number;
  offset?: number;
}

function where(query: RunItemQuery): { clause: string; params: Array<string | number> } {
  const params: Array<string | number> = [query.runId];
  let clause = 'WHERE run_id = ?';
  if (query.code) {
    clause += ' AND codes LIKE ?';
    params.push(`%,${query.code},%`);
  }
  if (query.status) {
    clause += ' AND status = ?';
    params.push(query.status);
  }
  return { clause, params };
}

export function listRunItems(db: Db, query: RunItemQuery): RunItemRecord[] {
  const { clause, params } = where(query);
  const rows = db
    // Insertion order is the task's own: whatever it wants read first, first.
    .prepare(`SELECT * FROM run_items ${clause} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...params, query.limit ?? 100, query.offset ?? 0) as unknown as RunItemRow[];
  return rows.map(toRecord);
}

export function countRunItems(db: Db, query: RunItemQuery): number {
  const { clause, params } = where(query);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM run_items ${clause}`).get(...params) as unknown as {
    n: number;
  };
  return row.n;
}

/**
 * The books this run decided something about that has not been carried out —
 * every row still carrying a plan, restricted to the ones asked for.
 *
 * Ordered by id, which is the task's own order: a report is applied in the
 * order it was read.
 */
export function listRunItemPlans(
  db: Db,
  runId: number,
  itemIds?: string[],
): Array<RunItemRecord & { plan: ItemPlan }> {
  const rows = db
    .prepare(`SELECT * FROM run_items WHERE run_id = ? AND plan IS NOT NULL ORDER BY id`)
    .all(runId) as unknown as RunItemRow[];

  // Filtered here rather than in SQL: the selection comes from a request body
  // and can be any length, and a thousand-parameter IN clause is the one shape
  // SQLite refuses outright.
  const wanted = itemIds ? new Set(itemIds) : null;
  return rows
    .map(toRecord)
    .filter((row): row is RunItemRecord & { plan: ItemPlan } => row.plan !== null)
    .filter((row) => !wanted || wanted.has(row.itemId));
}

/**
 * Marks these books as no longer waiting — the run that carried them out says
 * so, and the report they came from should stop offering them.
 *
 * Only what was settled: a change held back by a switch, or a move the
 * filesystem refused, is still waiting on something a person can change, and
 * keeping its plan is what lets them come back to it.
 */
export function clearRunItemPlans(db: Db, runId: number, itemIds: string[]): void {
  // Chunked because a selection can be a whole library and SQLite binds a
  // bounded number of parameters per statement.
  for (let i = 0; i < itemIds.length; i += 200) {
    const chunk = itemIds.slice(i, i + 200);
    const holes = chunk.map(() => '?').join(', ');
    db.prepare(
      `UPDATE run_items SET plan = NULL WHERE run_id = ? AND item_id IN (${holes})`,
    ).run(runId, ...chunk);
  }
}

/**
 * How much each run still has waiting, for the runs list — one grouped query
 * rather than a count per row, since the list is fifty runs at a time.
 */
export function countRunItemPlansByRun(db: Db): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT run_id, COUNT(*) AS n FROM run_items WHERE plan IS NOT NULL GROUP BY run_id`,
    )
    .all() as unknown as Array<{ run_id: number; n: number }>;
  return new Map(rows.map((row) => [Number(row.run_id), Number(row.n)]));
}

/** How much of this run is still waiting to be carried out. */
export function countRunItemPlans(db: Db, runId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM run_items WHERE run_id = ? AND plan IS NOT NULL')
    .get(runId) as unknown as { n: number };
  return Number(row?.n ?? 0);
}

export interface RunItemTotals {
  total: number;
  byStatus: Record<RunItemStatus, number>;
  /** How many items carry each code, most common first. */
  byCode: Record<string, number>;
  /** How many still carry a change that could be applied. */
  appliable: number;
}

/**
 * The counts behind the filters, computed here rather than in each command's
 * summary so that a page of items and the chips above it can never disagree.
 *
 * Grouped in SQL by (status, codes): a library has thousands of items and only
 * a handful of distinct combinations, so this collapses to a few rows however
 * large the run was.
 */
export function summarizeRunItems(db: Db, runId: number): RunItemTotals {
  const rows = db
    .prepare('SELECT status, codes, COUNT(*) AS n FROM run_items WHERE run_id = ? GROUP BY status, codes')
    .all(runId) as unknown as Array<{ status: string; codes: string; n: number }>;

  const totals: RunItemTotals = {
    total: 0,
    byStatus: { action: 0, clean: 0, skipped: 0 },
    byCode: {},
    appliable: countRunItemPlans(db, runId),
  };
  for (const row of rows) {
    totals.total += row.n;
    const status = row.status as RunItemStatus;
    totals.byStatus[status] = (totals.byStatus[status] ?? 0) + row.n;
    for (const code of decode(row.codes)) {
      totals.byCode[code] = (totals.byCode[code] ?? 0) + row.n;
    }
  }
  return totals;
}

/**
 * Detail is worth keeping for the last few runs and not for the five
 * hundredth-from-last, which is what the run history holds by default. It is a
 * row per book per run — the bulky part — while the counts in each run's
 * summary cost nothing and are left alone, so an old run still says what it
 * did, just not to which books.
 */
export function pruneRunItems(db: Db, keepRuns = 10): number {
  const result = db
    .prepare(
      `DELETE FROM run_items
        WHERE run_id NOT IN (
          SELECT run_id FROM (
            SELECT DISTINCT run_id FROM run_items ORDER BY run_id DESC LIMIT ?
          )
        )`,
    )
    .run(keepRuns);
  return Number(result.changes ?? 0);
}
