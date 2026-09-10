import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../db/index.js';
import { recordFindings } from '../db/findings.js';
import { createRun } from '../db/runs.js';
import { JobRunner } from '../core/jobs.js';
import { buildApiRouter, type ApiDeps } from './api.js';
import type { RequestContext, Router } from './router.js';

/**
 * The route that answers "which books, and what was wrong with them". Exercised
 * through the router so that the path shape and the query parsing are covered,
 * not only the SQL underneath them.
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

describe('GET /api/runs/:id/findings', () => {
  function seed(): number {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    recordFindings(db, runId, [
      { itemId: 'a', title: 'Dune', author: 'Frank Herbert', path: '/b/dune', issues: ['unrated'] },
      { itemId: 'b', title: 'Emma', author: 'Jane Austen', path: '/b/emma', issues: ['unrated', 'unmatched'] },
      { itemId: 'c', title: 'Nameless', author: null, path: '/b/c', issues: ['missing-title'] },
      { itemId: 'd', title: 'Persuasion', author: 'Jane Austen', path: '/b/p', issues: [] },
    ]);
    return runId;
  }

  it('returns every finding with its issues', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/findings`)) as {
      findings: Array<{ title: string; issues: string[] }>;
      total: number;
    };

    expect(result.total).toBe(4);
    expect(result.findings.map((f) => f.title)).toEqual(['Dune', 'Emma', 'Nameless', 'Persuasion']);
    expect(result.findings[1]!.issues).toEqual(['unrated', 'unmatched']);
    // The item that passed is in the report, with nothing against it.
    expect(result.findings[3]!.issues).toEqual([]);
  });

  it('filters to one issue code', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/findings?issue=unmatched`)) as {
      findings: Array<{ itemId: string }>;
      total: number;
    };

    expect(result.total).toBe(1);
    expect(result.findings[0]!.itemId).toBe('b');
  });

  it('pages, and reports the full total alongside the page', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/findings?limit=2`)) as {
      findings: unknown[];
      total: number;
    };

    expect(result.findings).toHaveLength(2);
    // The total is what tells the UI there is more to ask for.
    expect(result.total).toBe(4);
  });

  it('splits passes from problems', async () => {
    const runId = seed();

    const clean = (await get(`/api/runs/${runId}/findings?status=clean`)) as {
      findings: Array<{ itemId: string }>;
      total: number;
    };
    expect(clean.findings.map((f) => f.itemId)).toEqual(['d']);

    const problems = (await get(`/api/runs/${runId}/findings?status=issues`)) as {
      findings: Array<{ itemId: string }>;
      total: number;
    };
    expect(problems.total).toBe(3);
    expect(problems.findings.map((f) => f.itemId)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a status it does not recognize rather than filtering to nothing', async () => {
    const runId = seed();
    const result = (await get(`/api/runs/${runId}/findings?status=banana`)) as { total: number };
    expect(result.total).toBe(4);
  });

  it('caps the page size a caller can ask for', async () => {
    const runId = createRun(db, { command: 'audit', options: {}, dryRun: true, trigger: 'manual' }).id;
    recordFindings(
      db,
      runId,
      Array.from({ length: 600 }, (_, i) => ({
        itemId: `i-${i}`,
        title: `Book ${i}`,
        author: null,
        path: `/b/${i}`,
        issues: ['unrated'],
      })),
    );

    const result = (await get(`/api/runs/${runId}/findings?limit=5000`)) as {
      findings: unknown[];
      total: number;
    };
    expect(result.findings).toHaveLength(500);
    expect(result.total).toBe(600);
  });

  it('is empty rather than an error for a run that recorded nothing', async () => {
    const runId = createRun(db, { command: 'rate', options: {}, dryRun: true, trigger: 'manual' }).id;
    const result = (await get(`/api/runs/${runId}/findings`)) as { findings: unknown[]; total: number };
    expect(result).toEqual({ findings: [], total: 0 });
  });

  it('does not collide with the single-run route', () => {
    // Both patterns start /api/runs/:id; the router matches on segment count,
    // so the longer one is not swallowed by the shorter.
    expect(router.match('GET', '/api/runs/7')!.route.segments).toHaveLength(3);
    expect(router.match('GET', '/api/runs/7/findings')!.route.segments).toHaveLength(4);
  });
});
