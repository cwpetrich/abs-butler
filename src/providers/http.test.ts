import { describe, expect, it } from 'vitest';
import { mapLimit } from './http.js';

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
