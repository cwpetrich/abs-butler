import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConnection } from '../db/connection.js';
import { closeDb, openDb, type Db } from '../db/index.js';
import { recordRunItems } from '../db/runItems.js';
import { createRun } from '../db/runs.js';
import { JobRunner } from '../core/jobs.js';
import { buildApiRouter, type ApiDeps } from './api.js';
import type { RequestContext, Router } from './router.js';

/**
 * The route that answers "which books, and what did the run do to them".
 * Exercised through the router so that the path shape and the query parsing are
 * covered, not only the SQL underneath them.
 */

let dir: string;
let db: Db;
let router: Router;
let runner: JobRunner;

function get(path: string): Promise<unknown> {
  const url = new URL(path, 'http://localhost:13380');
  const matched = router.match('GET', url.pathname);
  if (!matched) throw new Error(`no route for ${url.pathname}`);
  const ctx = { url, params: matched.params, body: undefined, cookies: {} } as unknown as RequestContext;
  return Promise.resolve(matched.route.handler(ctx));
}

// Async so that a handler which refuses outright — every guard here throws
// rather than returning — comes back as a rejection to assert on, the same way
// the server's error middleware sees it.
async function post(path: string, body: unknown): Promise<unknown> {
  const url = new URL(path, 'http://localhost:13380');
  const matched = router.match('POST', url.pathname);
  if (!matched) throw new Error(`no route for ${url.pathname}`);
  const ctx = { url, params: matched.params, body, cookies: {} } as unknown as RequestContext;
  return matched.route.handler(ctx);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butler-api-'));
  process.env.BUTLER_DATA_DIR = dir;
  db = openDb();
  runner = new JobRunner(db);
  router = buildApiRouter({ db, runner, auth: {}, isSecure: () => true } as unknown as ApiDeps);
});

afterEach(() => {
  runner.stop();
  closeDb();
  delete process.env.BUTLER_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/runs/:id/items', () => {
  function seed(): number {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    recordRunItems(db, runId, [
      { itemId: 'a', title: 'Dune', author: 'Frank Herbert', path: '/b/dune', status: 'action', codes: ['unrated'], detail: ['No age rating from abs-butler'] },
      { itemId: 'b', title: 'Emma', author: 'Jane Austen', path: '/b/emma', status: 'action', codes: ['unrated', 'unmatched'], detail: [] },
      { itemId: 'c', title: 'Nameless', author: null, path: '/b/c', status: 'action', codes: ['missing-title'], detail: [] },
      { itemId: 'd', title: 'Persuasion', author: 'Jane Austen', path: '/b/p', status: 'clean', codes: [], detail: [] },
    ]);
    return runId;
  }

  it('returns every item with its codes and detail', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/items`)) as {
      items: Array<{ title: string; codes: string[]; detail: string[] }>;
      total: number;
    };

    expect(result.total).toBe(4);
    expect(result.items.map((i) => i.title)).toEqual(['Dune', 'Emma', 'Nameless', 'Persuasion']);
    expect(result.items[1]!.codes).toEqual(['unrated', 'unmatched']);
    expect(result.items[0]!.detail).toEqual(['No age rating from abs-butler']);
    // The item with nothing to do is in the report, with nothing against it.
    expect(result.items[3]!.codes).toEqual([]);
  });

  it('counts every status and code for the run, not just the page', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/items?status=clean`)) as {
      items: unknown[];
      totals: { total: number; byStatus: Record<string, number>; byCode: Record<string, number> };
    };

    // One row comes back, and the totals still describe the whole run — they
    // are what the filter chips count, so a filter must not shrink them.
    expect(result.items).toHaveLength(1);
    expect(result.totals.total).toBe(4);
    expect(result.totals.byStatus).toEqual({ action: 3, clean: 1, skipped: 0 });
    expect(result.totals.byCode.unrated).toBe(2);
  });

  it('filters to one code', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/items?code=unmatched`)) as {
      items: Array<{ itemId: string }>;
      total: number;
    };

    expect(result.total).toBe(1);
    expect(result.items[0]!.itemId).toBe('b');
  });

  it('pages, and reports the full total alongside the page', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/items?limit=2`)) as {
      items: unknown[];
      total: number;
    };

    expect(result.items).toHaveLength(2);
    // The total is what tells the UI there is more to ask for.
    expect(result.total).toBe(4);
  });

  it('splits the items with something to do from the ones without', async () => {
    const runId = seed();

    const clean = (await get(`/api/runs/${runId}/items?status=clean`)) as {
      items: Array<{ itemId: string }>;
      total: number;
    };
    expect(clean.items.map((i) => i.itemId)).toEqual(['d']);

    const action = (await get(`/api/runs/${runId}/items?status=action`)) as {
      items: Array<{ itemId: string }>;
      total: number;
    };
    expect(action.total).toBe(3);
    expect(action.items.map((i) => i.itemId)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a status it does not recognize rather than filtering to nothing', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/items?status=banana`)) as { total: number };
    expect(result.total).toBe(4);
  });

  it('caps the page size a caller can ask for', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    recordRunItems(
      db,
      runId,
      Array.from({ length: 600 }, (_, i) => ({
        itemId: `i-${i}`,
        title: `Book ${i}`,
        author: null,
        path: `/b/${i}`,
        status: 'action' as const,
        codes: ['unrated'],
        detail: [],
      })),
    );

    const result = (await get(`/api/runs/${runId}/items?limit=5000`)) as {
      items: unknown[];
      total: number;
    };
    expect(result.items).toHaveLength(500);
    expect(result.total).toBe(600);
  });

  it('is empty rather than an error for a run that recorded nothing', async () => {
    const runId = createRun(db, { command: 'rate', options: {}, dryRun: true, trigger: 'manual' }).id;
    const result = (await get(`/api/runs/${runId}/items`)) as { items: unknown[]; total: number };
    expect(result).toEqual({
      items: [],
      total: 0,
      totals: { total: 0, byStatus: { action: 0, clean: 0, skipped: 0 }, byCode: {}, appliable: 0 },
    });
  });

  it('does not collide with the single-run route', () => {
    // Both patterns start /api/runs/:id; the router matches on segment count,
    // so the longer one is not swallowed by the shorter.
    expect(router.match('GET', '/api/runs/7')!.route.segments).toHaveLength(3);
    expect(router.match('GET', '/api/runs/7/items')!.route.segments).toHaveLength(4);
  });
});

describe('POST /api/runs/:id/apply', () => {
  /** A finished dry run with one book still waiting to be written. */
  function planned(): number {
    saveConnection(db, { url: 'http://localhost:13378', apiKey: 'k' });
    const runId = createRun(db, {
      command: 'metadata',
      options: {},
      dryRun: true,
      trigger: 'manual',
    }).id;
    recordRunItems(db, runId, [
      {
        itemId: 'a',
        title: 'Dune',
        author: 'Frank Herbert',
        path: '/b/dune',
        status: 'action',
        codes: ['description'],
        detail: ['Would set description'],
        plan: { kind: 'metadata', changes: [{ field: 'description', from: null, to: 'Spice.', source: 'googlebooks' }] },
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
    ]);
    return runId;
  }

  // Queued as a run of the same command, so it waits its turn behind other
  // work, appears in history, and carries its own log and undo record.
  it('queues a run that carries out what the source run decided', async () => {
    const source = planned();
    const created = (await post(`/api/runs/${source}/apply`, { apply: true })) as {
      command: string;
      options: Record<string, unknown>;
      dryRun: boolean;
    };

    expect(created.command).toBe('metadata');
    expect(created.options).toEqual({ applyFrom: source, apply: true });
    expect(created.dryRun).toBe(false);
  });

  it('carries a selection of books through to the run', async () => {
    const source = planned();
    const created = (await post(`/api/runs/${source}/apply`, { items: ['a'], apply: true })) as {
      options: Record<string, unknown>;
    };
    expect(created.options).toEqual({ applyFrom: source, items: ['a'], apply: true });
  });

  // Dry by default, like everything else here that writes.
  it('is a dry run unless asked to apply', async () => {
    const source = planned();
    const created = (await post(`/api/runs/${source}/apply`, {})) as { dryRun: boolean };
    expect(created.dryRun).toBe(true);
  });

  it('refuses a run with nothing left to carry out', async () => {
    saveConnection(db, { url: 'http://localhost:13378', apiKey: 'k' });
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    await expect(post(`/api/runs/${runId}/apply`, { apply: true })).rejects.toThrow(
      /nothing left to carry out/,
    );
  });

  it('404s for a run that does not exist', async () => {
    await expect(post('/api/runs/999/apply', {})).rejects.toThrow(/No such run/);
  });

  // The page needs to know which rows it may offer, and how much is waiting in
  // the run as a whole — the plans themselves stay on the server.
  it('says which rows are still waiting, and how many', async () => {
    const source = planned();
    const items = (await get(`/api/runs/${source}/items`)) as {
      items: Array<{ itemId: string; canApply: boolean; plan?: unknown }>;
      totals: { appliable: number };
    };

    expect(items.items.map((i) => [i.itemId, i.canApply])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(items.items[0]).not.toHaveProperty('plan');
    expect(items.totals.appliable).toBe(1);

    const run = (await get(`/api/runs/${source}`)) as { appliable: number };
    expect(run.appliable).toBe(1);
  });
});
