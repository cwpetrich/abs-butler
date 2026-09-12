import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import type { TaskContext } from '../context.js';
import { closeDb, openDb, type Db } from '../db/index.js';
import { DEFAULT_SETTINGS } from '../db/settings.js';
import { runRateTask } from './rate.js';

/**
 * The whole path, end to end, with the network stubbed at `fetch`: a rate run
 * over a library, through the provider set, down to the HTTP layer and back.
 * The two things being checked are the two things that made a keyless run
 * unusable — that it can be stopped, and that it stops asking a provider that
 * only ever says no.
 */

const library: AbsLibrary = { id: 'lib-1', name: 'Books', folders: [], mediaType: 'book', provider: 'audible' };

function books(count: number): AbsLibraryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    media: { id: `m-${i}`, coverPath: null, tags: [], metadata: { title: `Book ${i}`, authorName: 'A Writer' } },
  })) as unknown as AbsLibraryItem[];
}

/** Everything runRateTask asks of AudiobookShelf, and nothing else. */
function client(items: AbsLibraryItem[]) {
  return {
    async listLibraries() {
      return [library];
    },
    async *iterateLibraryItems() {
      for (const item of items) yield item;
    },
  } as unknown as TaskContext['client'];
}

describe('runRateTask', () => {
  let dir: string;
  let db: Db;
  let calls: string[];

  function context(items: AbsLibraryItem[], signal?: AbortSignal): TaskContext {
    return {
      db,
      connection: { url: 'http://localhost:13378' } as TaskContext['connection'],
      client: client(items),
      // No Google Books key, which is the configuration that provoked this.
      settings: { ...DEFAULT_SETTINGS, providerConcurrency: 2 },
      signal,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butler-rate-'));
    process.env.BUTLER_DATA_DIR = dir;
    db = openDb();
    calls = [];

    // Google Books rate limits the way it does for an anonymous caller;
    // everything else answers, emptily and instantly.
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const host = new URL(url).host;
      calls.push(host);
      if (host === 'www.googleapis.com') return new Response('{}', { status: 429 });
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeDb();
    delete process.env.BUTLER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  // The reported symptom: a run that appears to go on forever, because every
  // book pays two Google Books requests and a backoff to learn nothing.
  it('stops asking Google Books once it has refused three times', async () => {
    const result = await runRateTask(context(books(40)));

    expect(result.rated).toBe(40);
    const google = calls.filter((host) => host === 'www.googleapis.com');
    // Four refusals at most — the three that decide it, plus the one that was
    // already in flight beside them — and each is retried once inside getJson.
    // Without the breaker this is 80: two requests for every book in the library.
    expect(google.length).toBeLessThanOrEqual(8);
    // Open Library is untouched by another provider's quota.
    expect(calls.filter((host) => host === 'openlibrary.org')).toHaveLength(40);
  });

  it('stops partway through when the run is stopped', async () => {
    const controller = new AbortController();
    const ctx = context(books(200), controller.signal);

    let seen = 0;
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (++seen === 10) controller.abort(new Error('Stopped'));
      calls.push(new URL(url).host);
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });

    await expect(runRateTask(ctx)).rejects.toThrow('Stopped');
    expect(calls.length).toBeLessThan(200);
  });

  it('runs to the end when nothing stops it', async () => {
    const controller = new AbortController();
    const result = await runRateTask(context(books(5), controller.signal));
    expect(result.rated).toBe(5);
    expect(controller.signal.aborted).toBe(false);
  });

  // "Tagged 300 item(s)" is not an account of anything. The verdict on each
  // book, and what it was based on, is the part worth keeping.
  it('reports what it decided about each book, not only how many it tagged', async () => {
    const result = await runRateTask(context(books(2)));

    expect(result.report).toHaveLength(2);
    const first = result.report[0]!;
    expect(first.title).toBe('Book 0');
    // Nothing answered, so there is no band — said out loud rather than left
    // as an absence for someone to interpret.
    expect(first.status).toBe('action');
    expect(first.codes).toContain('unknown');
    expect(first.detail[0]).toBe('No usable audience signal');
    expect(first.detail.some((line) => line.startsWith('Tags added:'))).toBe(true);
    expect(result.bandCounts).toEqual({ unknown: 2 });
  });

  it('says which books it passed over, and what they already carry', async () => {
    const rated = books(1).map((item) => ({
      ...item,
      media: { ...item.media, tags: ['abs-butler:rated', 'age:adult'] },
    })) as AbsLibraryItem[];

    const result = await runRateTask(context(rated));

    expect(result.rated).toBe(0);
    expect(result.skippedAlreadyRated).toBe(1);
    // A skipped book is in the report rather than absent from it: "left alone
    // because it already has one" and "never looked at" are different answers.
    expect(result.report).toHaveLength(1);
    expect(result.report[0]!.status).toBe('skipped');
    expect(result.report[0]!.codes).toEqual(['already-rated']);
    expect(result.report[0]!.detail[1]).toBe('Current tags: abs-butler:rated, age:adult');
  });
});
