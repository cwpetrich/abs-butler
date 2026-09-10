import type { Db } from './index.js';

/**
 * What an audit found, one row per affected item.
 *
 * Kept out of the run's summary on purpose: summaries travel with every row of
 * the runs list, and a large library's findings would be paid for on every page
 * load. Here they are fetched only when someone opens the run that produced
 * them, and filtered server-side by issue code.
 */
export interface FindingRecord {
  id: number;
  runId: number;
  itemId: string;
  title: string;
  author: string | null;
  path: string;
  issues: string[];
}

interface FindingRow {
  id: number;
  run_id: number;
  item_id: string;
  title: string;
  author: string | null;
  path: string;
  issues: string;
}

/**
 * Codes are stored comma-joined *and* comma-wrapped — ",missing-title," rather
 * than "missing-title" — so that matching one code is a plain LIKE '%,x,%'
 * with no risk of a short code matching inside a longer one.
 */
function encode(issues: string[]): string {
  return `,${issues.join(',')},`;
}

function decode(value: string): string[] {
  return value.split(',').filter(Boolean);
}

function toRecord(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    title: row.title,
    author: row.author,
    path: row.path,
    issues: decode(row.issues),
  };
}

export interface FindingInput {
  itemId: string;
  title: string;
  author: string | null;
  path: string;
  issues: string[];
}

/**
 * Replaces this run's findings with the ones given.
 *
 * Written as one transaction because an audit of a large library is thousands
 * of rows, and one INSERT each would take longer than the audit did. Replacing
 * rather than appending keeps a re-run of the same run id — which only happens
 * in tests — from doubling everything.
 */
export function recordFindings(db: Db, runId: number, findings: FindingInput[]): void {
  const insert = db.prepare(
    'INSERT INTO findings (run_id, item_id, title, author, path, issues) VALUES (?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM findings WHERE run_id = ?').run(runId);
    for (const finding of findings) {
      insert.run(runId, finding.itemId, finding.title, finding.author, finding.path, encode(finding.issues));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface FindingQuery {
  runId: number;
  /** Restrict to items carrying this issue code. */
  issue?: string;
  limit?: number;
  offset?: number;
}

function where(query: FindingQuery): { clause: string; params: Array<string | number> } {
  const params: Array<string | number> = [query.runId];
  let clause = 'WHERE run_id = ?';
  if (query.issue) {
    clause += ' AND issues LIKE ?';
    params.push(`%,${query.issue},%`);
  }
  return { clause, params };
}

export function listFindings(db: Db, query: FindingQuery): FindingRecord[] {
  const { clause, params } = where(query);
  const rows = db
    .prepare(`SELECT * FROM findings ${clause} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...params, query.limit ?? 100, query.offset ?? 0) as unknown as FindingRow[];
  return rows.map(toRecord);
}

export function countFindings(db: Db, query: FindingQuery): number {
  const { clause, params } = where(query);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM findings ${clause}`).get(...params) as unknown as {
    n: number;
  };
  return row.n;
}

/**
 * Detail is worth keeping for the last few audits and not for the five
 * hundredth-from-last, which is what the run history holds by default. The
 * counts in each run's summary are unaffected, so an old audit still says what
 * it found — just not for which books.
 */
export function pruneFindings(db: Db, keepRuns = 10): number {
  const result = db
    .prepare(
      `DELETE FROM findings
        WHERE run_id NOT IN (
          SELECT run_id FROM (
            SELECT DISTINCT run_id FROM findings ORDER BY run_id DESC LIMIT ?
          )
        )`,
    )
    .run(keepRuns);
  return Number(result.changes ?? 0);
}
