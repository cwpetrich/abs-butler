import type { Db } from './index.js';
import type { ProviderResult } from '../providers/types.js';

/**
 * Cached provider answers.
 *
 * A row records that a provider was asked a question and what it said — an
 * empty result set very much included. Misses are the majority of a mature
 * library's lookups and the whole reason this table exists: a book Open
 * Library has never heard of will still be unknown tomorrow, and re-asking
 * nightly forever is the difference between a scheduled run that settles down
 * and one that keeps the same cost forever.
 */
export interface LookupRecord {
  provider: string;
  queryKey: string;
  results: ProviderResult[];
  /** False when the provider answered with nothing. */
  hit: boolean;
  fetchedAt: number;
}

interface LookupRow {
  provider: string;
  query_key: string;
  results: string;
  hit: number;
  fetched_at: number;
}

export function getLookup(db: Db, provider: string, queryKey: string): LookupRecord | null {
  const row = db
    .prepare('SELECT * FROM lookups WHERE provider = ? AND query_key = ?')
    .get(provider, queryKey) as unknown as LookupRow | undefined;
  if (!row) return null;

  let results: ProviderResult[] = [];
  try {
    results = JSON.parse(row.results) as ProviderResult[];
  } catch {
    // A corrupt row is a cache miss, not an error worth failing a run over.
    return null;
  }

  return {
    provider: row.provider,
    queryKey: row.query_key,
    results,
    hit: row.hit === 1,
    fetchedAt: row.fetched_at,
  };
}

export function putLookup(
  db: Db,
  provider: string,
  queryKey: string,
  results: ProviderResult[],
): void {
  db.prepare(
    `INSERT INTO lookups (provider, query_key, results, hit, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, query_key) DO UPDATE SET
       results = excluded.results,
       hit = excluded.hit,
       fetched_at = excluded.fetched_at`,
  ).run(provider, queryKey, JSON.stringify(results), results.length > 0 ? 1 : 0, Date.now());
}

/** Drops everything older than the given age, whatever it holds. */
export function pruneLookups(db: Db, maxAgeMs: number): number {
  const result = db
    .prepare('DELETE FROM lookups WHERE fetched_at < ?')
    .run(Date.now() - maxAgeMs);
  return Number(result.changes ?? 0);
}

export function clearLookups(db: Db): void {
  db.prepare('DELETE FROM lookups').run();
}

export function lookupStats(db: Db): { total: number; hits: number } {
  const row = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(hit), 0) AS hits FROM lookups')
    .get() as unknown as { total: number; hits: number };
  return { total: Number(row?.total ?? 0), hits: Number(row?.hits ?? 0) };
}
