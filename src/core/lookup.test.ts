import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type Db } from '../db/index.js';
import { lookupStats } from '../db/lookups.js';
import { lookupItem, queryKey, ttlFor } from './lookup.js';
import type { BookQuery, MetadataProvider, ProviderResult } from '../providers/types.js';

/** Counts how many times it was actually asked, which is the point of the cache. */
class CountingProvider implements MetadataProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly answers: ProviderResult[],
  ) {}
  isAvailable(): boolean {
    return true;
  }
  async search(): Promise<ProviderResult[]> {
    this.calls += 1;
    return this.answers;
  }
}

class ThrowingProvider implements MetadataProvider {
  readonly name = 'flaky';
  calls = 0;
  isAvailable(): boolean {
    return true;
  }
  async search(): Promise<ProviderResult[]> {
    this.calls += 1;
    throw new Error('upstream is down');
  }
}

const hobbit: BookQuery = { title: 'The Hobbit', author: 'J.R.R. Tolkien', isbn: null, asin: null };

function match(): ProviderResult {
  return { provider: 'test', title: 'The Hobbit', authors: ['J.R.R. Tolkien'], signals: [] };
}

describe('queryKey', () => {
  it('keys an identifier query on the identifier alone', () => {
    expect(queryKey({ ...hobbit, asin: 'b002v0qmpq' })).toBe('asin:B002V0QMPQ');
    expect(queryKey({ ...hobbit, isbn: '978-0-261-10221-7' })).toBe('isbn:9780261102217');
  });

  // Otherwise fixing a typo in a title would miss a cache entry that answered
  // a question the title was never part of.
  it('prefers the ASIN over everything else', () => {
    expect(queryKey({ title: 'anything', asin: 'B002V0QMPQ', isbn: '9780261102217' })).toBe(
      'asin:B002V0QMPQ',
    );
  });

  it('normalizes a fuzzy query so trivial differences share an answer', () => {
    expect(queryKey({ title: 'Hobbit, The', author: 'Tolkien, J.R.R.' })).toBe(
      queryKey({ title: 'The Hobbit', author: 'J.R.R. Tolkien' }),
    );
  });
});

describe('ttlFor', () => {
  it('expires a miss sooner than a hit', () => {
    expect(ttlFor(false, 30)).toBeLessThan(ttlFor(true, 30));
  });

  it('never expires a miss in under a day', () => {
    expect(ttlFor(false, 1)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('lookupItem', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butler-lookup-'));
    process.env.BUTLER_DATA_DIR = dir;
    db = openDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.BUTLER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks a provider once and serves the second call from cache', async () => {
    const provider = new CountingProvider('test', [match()]);
    const deps = { providers: [provider], db, cacheDays: 30 };

    const first = await lookupItem(deps, hobbit);
    const second = await lookupItem(deps, hobbit);

    expect(provider.calls).toBe(1);
    expect(first.best?.result.title).toBe('The Hobbit');
    expect(second.best?.result.title).toBe('The Hobbit');
    expect(second.cached).toEqual(['test']);
  });

  // The expensive half of a real library: books nothing has ever heard of.
  it('caches "nothing found" too', async () => {
    const provider = new CountingProvider('test', []);
    const deps = { providers: [provider], db, cacheDays: 30 };

    await lookupItem(deps, hobbit);
    await lookupItem(deps, hobbit);

    expect(provider.calls).toBe(1);
    expect(lookupStats(db)).toEqual({ total: 1, hits: 0 });
  });

  it('re-asks when the question changes', async () => {
    const provider = new CountingProvider('test', [match()]);
    const deps = { providers: [provider], db, cacheDays: 30 };

    await lookupItem(deps, hobbit);
    await lookupItem(deps, { ...hobbit, asin: 'B002V0QMPQ' });

    expect(provider.calls).toBe(2);
  });

  // A provider that threw has not said "nothing" — caching that would turn one
  // outage into a month of empty answers.
  it('does not cache a failure', async () => {
    const provider = new ThrowingProvider();
    const deps = { providers: [provider], db, cacheDays: 30 };

    await lookupItem(deps, hobbit);
    await lookupItem(deps, hobbit);

    expect(provider.calls).toBe(2);
    expect(lookupStats(db).total).toBe(0);
  });

  it('works with no database, simply without caching', async () => {
    const provider = new CountingProvider('test', [match()]);
    const deps = { providers: [provider], cacheDays: 30 };

    await lookupItem(deps, hobbit);
    await lookupItem(deps, hobbit);

    expect(provider.calls).toBe(2);
  });

  it('orders candidates by match strength, not provider order', async () => {
    const weak = new CountingProvider('weak', [
      { provider: 'weak', title: 'The Hobbit', authors: ['J.R.R. Tolkien'], signals: [] },
    ]);
    const strong = new CountingProvider('strong', [
      { provider: 'strong', title: 'The Hobbit', isbn: '9780261102217', signals: [] },
    ]);
    const deps = { providers: [weak, strong], db, cacheDays: 30 };

    const found = await lookupItem(deps, { ...hobbit, isbn: '9780261102217' });
    expect(found.candidates.map((c) => c.result.provider)).toEqual(['strong', 'weak']);
    expect(found.best?.match.basis).toBe('isbn');
  });

  it('drops a provider result that does not match the book', async () => {
    const provider = new CountingProvider('test', [
      { provider: 'test', title: 'Mistborn', authors: ['Brandon Sanderson'], signals: [] },
    ]);
    const found = await lookupItem({ providers: [provider], db, cacheDays: 30 }, hobbit);
    expect(found.best).toBeNull();
    expect(found.results).toEqual([]);
  });
});
