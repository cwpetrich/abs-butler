import { describe, expect, it } from 'vitest';
import { mapLimit, mapLimitPartial } from './http.js';

describe('mapLimit', () => {
  it('preserves input order regardless of completion order', async () => {
    const results = await mapLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('keeps no more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(4);
  });

  // What a stopped run relies on: the queue drains no further, and the items
  // already in flight are left to finish rather than abandoned half-done.
  it('claims no new work once the signal is aborted', async () => {
    const controller = new AbortController();
    const seen: number[] = [];

    const work = mapLimit(Array.from({ length: 100 }, (_, i) => i), 2, async (n) => {
      seen.push(n);
      if (n === 3) controller.abort(new Error('Stopped'));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }, { signal: controller.signal });

    await expect(work).rejects.toThrow('Stopped');
    expect(seen.length).toBeLessThan(10);
    expect(seen).toContain(3);
  });

  it('does not start at all when handed an already-stopped run', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped'));

    let called = false;
    await expect(
      mapLimit([1, 2, 3], 2, async () => {
        called = true;
      }, { signal: controller.signal }),
    ).rejects.toThrow('Stopped');
    expect(called).toBe(false);
  });
});

/**
 * The same work, for callers that have something to say about a stopped run:
 * `rate` stopped at book 300 has reached a verdict on 300 books, and those
 * verdicts are the whole of what the run has to show for itself.
 */
describe('mapLimitPartial', () => {
  it('returns what finished, in input order, and says it was stopped', async () => {
    const controller = new AbortController();

    const mapped = await mapLimitPartial(
      Array.from({ length: 100 }, (_, i) => i),
      1,
      async (n) => {
        if (n === 3) controller.abort(new Error('Stopped'));
        return n * 2;
      },
      { signal: controller.signal },
    );

    // Item 3 was already in flight when the stop landed, so it finished.
    expect(mapped.results).toEqual([0, 2, 4, 6]);
    expect(mapped.stopped).toBe(true);
    expect(mapped.unreached).toBe(96);
  });

  // The stop reaches the HTTP layer, so whatever was in flight rejects with the
  // abort reason. That is the run ending, not the item failing.
  it('keeps the rest when the item in flight is the one the stop interrupts', async () => {
    const controller = new AbortController();

    const mapped = await mapLimitPartial(
      [0, 1, 2, 3],
      1,
      async (n) => {
        if (n === 2) {
          controller.abort(new Error('Stopped'));
          controller.signal.throwIfAborted();
        }
        return n;
      },
      { signal: controller.signal },
    );

    expect(mapped.results).toEqual([0, 1]);
    expect(mapped.stopped).toBe(true);
  });

  // A stop is an ending; anything else is still a failure and must be raised.
  it('still throws a real error', async () => {
    await expect(
      mapLimitPartial([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('provider exploded');
        return n;
      }),
    ).rejects.toThrow('provider exploded');
  });

  it('reports nothing stopped when nothing stopped it', async () => {
    const mapped = await mapLimitPartial([1, 2, 3], 2, async (n) => n + 1);
    expect(mapped).toEqual({ results: [2, 3, 4], stopped: false, unreached: 0 });
  });
});
