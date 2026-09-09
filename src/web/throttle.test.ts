import { describe, expect, it } from 'vitest';
import { clientKey, Throttle } from './throttle.js';

/** A clock the test moves by hand, so nothing here waits on real time. */
function at(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('Throttle', () => {
  it('lets an ordinary fumbled password through untouched', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 5; i++) {
      expect(t.retryAfterMs('a')).toBe(0);
      t.recordFailure('a');
    }
    // Five is the allowance; the sixth attempt is still permitted to be made.
    expect(t.retryAfterMs('a')).toBe(0);
  });

  it('starts making the caller wait once the allowance is gone', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 6; i++) t.recordFailure('a');
    expect(t.retryAfterMs('a')).toBe(2000);
  });

  it('doubles the wait with each further failure', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 6; i++) t.recordFailure('a');
    const waits: number[] = [t.retryAfterMs('a')];
    for (let i = 0; i < 3; i++) {
      t.recordFailure('a');
      waits.push(t.retryAfterMs('a'));
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000]);
  });

  it('caps the wait rather than growing forever', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 60; i++) t.recordFailure('a');
    expect(t.retryAfterMs('a')).toBe(15 * 60_000);
  });

  it('lets the caller back in once the wait has passed', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 6; i++) t.recordFailure('a');
    clock.advance(1999);
    expect(t.retryAfterMs('a')).toBe(1);
    clock.advance(1);
    expect(t.retryAfterMs('a')).toBe(0);
  });

  // The reason this is keyed by address at all: a single global counter would
  // let anyone on the network lock the operator out of their own instance.
  it('does not let one address block another', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 20; i++) t.recordFailure('attacker');
    expect(t.retryAfterMs('attacker')).toBeGreaterThan(0);
    expect(t.retryAfterMs('operator')).toBe(0);
  });

  it('forgets the history of an address that gets in', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 8; i++) t.recordFailure('a');
    t.clear('a');
    expect(t.retryAfterMs('a')).toBe(0);
  });

  it('forgets an idle address, so the map cannot grow without bound', () => {
    const clock = at();
    const t = new Throttle(clock.now);
    for (let i = 0; i < 8; i++) t.recordFailure('old');
    clock.advance(61 * 60_000);
    t.recordFailure('new'); // prunes on write
    expect(t.retryAfterMs('old')).toBe(0);
  });
});

describe('clientKey', () => {
  // Proxy headers are attacker-controlled: honouring them would hand out a
  // fresh allowance per forged header.
  it('falls back to a constant when the address is unknown', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('10.1.1.5')).toBe('10.1.1.5');
  });
});
