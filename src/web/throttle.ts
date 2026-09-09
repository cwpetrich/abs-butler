/**
 * Failure throttling for the two unauthenticated doors: the login and the
 * setup code.
 *
 * abs-butler is published on the network by default, the same as the server it
 * manages, so its password is guessable at whatever rate the machine will
 * answer. scrypt makes each attempt cost something, but "expensive" is not
 * "bounded" — a weak password still falls to a patient loop. This bounds it.
 *
 * Keyed by client address so one attacker cannot lock out the operator, which
 * is the failure mode a single global counter would have. An attacker on the
 * same address as the operator can still be a nuisance; that is a network
 * problem, not one this can solve.
 */

/** Failures allowed before waiting starts. Fat-fingering a password is normal. */
const FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60_000;
/** Entries idle this long are forgotten, so the map cannot grow without bound. */
const FORGET_AFTER_MS = 60 * 60_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  seenAt: number;
}

export class Throttle {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds still to wait, or 0 when the caller may try. */
  retryAfterMs(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const remaining = entry.blockedUntil - this.now();
    return remaining > 0 ? remaining : 0;
  }

  recordFailure(key: string): void {
    this.prune();
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, seenAt: now };
    entry.failures += 1;
    entry.seenAt = now;
    if (entry.failures > FREE_ATTEMPTS) {
      // Doubles per failure past the allowance: 2s, 4s, 8s… capped, so a
      // forgotten password costs seconds and a script costs the rest of the day.
      const step = entry.failures - FREE_ATTEMPTS - 1;
      const delay = Math.min(BASE_DELAY_MS * 2 ** step, MAX_DELAY_MS);
      entry.blockedUntil = now + delay;
    }
    this.entries.set(key, entry);
  }

  /** Called on success: getting in clears the history for that address. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const cutoff = this.now() - FORGET_AFTER_MS;
    for (const [key, entry] of this.entries) {
      if (entry.seenAt < cutoff) this.entries.delete(key);
    }
  }
}

/**
 * Best-effort client identity.
 *
 * Proxy headers are deliberately ignored: anything a client can set, a client
 * can vary to get a fresh allowance. Behind a reverse proxy every request
 * therefore shares the proxy's allowance, which is the safe direction to be
 * wrong in.
 */
export function clientKey(remoteAddress: string | undefined): string {
  return remoteAddress ?? 'unknown';
}
