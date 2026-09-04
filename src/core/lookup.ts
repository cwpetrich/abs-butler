import type { Db } from '../db/index.js';
import { getLookup, putLookup } from '../db/lookups.js';
import { log } from '../logger.js';
import type { BookQuery, MetadataProvider, ProviderResult } from '../providers/types.js';
import { normalizeAuthor, normalizeTitle } from '../util/text.js';
import { pickBest, type Candidate } from './matching.js';

/**
 * One question, asked once.
 *
 * Both `rate` and `metadata` need the same provider answers about the same
 * books, and before this they each ran their own sweep — two full passes over
 * a library to fetch one set of facts. Routing every provider call through here
 * means the second pass is free, and so is tomorrow's.
 */

export interface LookupDeps {
  providers: MetadataProvider[];
  /** Omitted for the CLI's one-shot paths and in tests; caching is then off. */
  db?: Db | undefined;
  cacheDays: number;
}

export interface ItemLookup {
  /** The best candidate from each provider that answered, best first. */
  candidates: Candidate[];
  /** Every result behind those candidates, for signal merging in `rate`. */
  results: ProviderResult[];
  best: Candidate | null;
  /** Providers whose answer came from the cache rather than the network. */
  cached: string[];
}

/**
 * The identity of a question, so two books that ask the same thing share an
 * answer and one book that starts asking a *different* thing gets a fresh one.
 *
 * Identifier queries key on the identifier alone: the title is not part of what
 * was asked, so letting it into the key would miss the cache every time someone
 * fixes a typo. Fuzzy queries key on the normalized title and author, which is
 * exactly what the provider was sent.
 */
export function queryKey(query: BookQuery): string {
  if (query.asin) return `asin:${query.asin.trim().toUpperCase()}`;
  if (query.isbn) return `isbn:${query.isbn.replace(/[^0-9Xx]/g, '').toUpperCase()}`;
  return `q:${normalizeTitle(query.title)}|${normalizeAuthor(query.author)}`;
}

/**
 * Misses expire sooner than hits.
 *
 * "Nothing found" is usually about the library rather than the book — an item
 * ABS has not matched yet, a title with a typo in it. Those get fixed, and when
 * they do the answer should not be a month stale. A hit is a stable fact about
 * a published book and can sit for the full retention.
 */
export function ttlFor(hit: boolean, cacheDays: number): number {
  const day = 24 * 60 * 60 * 1000;
  return hit ? cacheDays * day : Math.max(1, Math.floor(cacheDays / 4)) * day;
}

async function providerResults(
  deps: LookupDeps,
  provider: MetadataProvider,
  query: BookQuery,
  key: string,
): Promise<{ results: ProviderResult[]; cached: boolean }> {
  const cached = deps.db ? getLookup(deps.db, provider.name, key) : null;
  if (cached && Date.now() - cached.fetchedAt < ttlFor(cached.hit, deps.cacheDays)) {
    return { results: cached.results, cached: true };
  }

  try {
    const results = await provider.search(query);
    if (deps.db) putLookup(deps.db, provider.name, key, results);
    return { results, cached: false };
  } catch (err) {
    // A provider that threw has not answered "nothing" — it has not answered.
    // Caching that would turn one outage into a month of empty results, so the
    // failure is logged and left uncached, and any stale row stays usable.
    log.debug(`${provider.name} failed for "${query.title}": ${(err as Error).message}`);
    return { results: cached?.results ?? [], cached: Boolean(cached) };
  }
}

export async function lookupItem(deps: LookupDeps, query: BookQuery): Promise<ItemLookup> {
  const key = queryKey(query);
  const candidates: Candidate[] = [];
  const results: ProviderResult[] = [];
  const cached: string[] = [];

  for (const provider of deps.providers) {
    const answer = await providerResults(deps, provider, query, key);
    if (answer.cached) cached.push(provider.name);

    const best = pickBest(query, answer.results);
    if (best) candidates.push(best);
  }

  // Best-scoring first, and a stable sort keeps the configured trust order
  // between providers that scored the same — which is what decides whose
  // answer wins when a field could be filled from either.
  candidates.sort((a, b) => b.match.score - a.match.score);
  results.push(...candidates.map((c) => c.result));

  return { candidates, results, best: candidates[0] ?? null, cached };
}
