import { log } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 15_000;
// Sent to Open Library and Google Books, both of which ask that clients
// identify themselves. The URL has to be the real one — it is how they reach
// a maintainer when a client misbehaves.
const USER_AGENT = 'abs-butler/0.4 (+https://github.com/cwpetrich/abs-butler)';

/**
 * A provider turned the request away for a reason that will not clear up on
 * its own: an exhausted quota, or a key it will not accept.
 *
 * Distinct from "no answer" on purpose. Google Books without an API key
 * refuses nearly every request from a shared address, and treating that as an
 * empty result meant a library-wide run paid the same rejection — two requests
 * and a backoff — once per book, for hours, and learned nothing. Raised
 * instead, so `lookupItem` can stop asking. See core/lookup.ts.
 */
export class ProviderRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
  ) {
    super(
      status === 429
        ? `${host} is rate limiting us (HTTP 429)`
        : `${host} refused the request (HTTP ${status})`,
    );
    this.name = 'ProviderRefusedError';
  }
}

/**
 * GET JSON with a timeout and one retry on transient failure.
 *
 * Returns null rather than throwing when a provider simply has no answer, so a
 * single flaky source never aborts a whole library run. Throws only for the
 * two things a caller must react to: a refusal (see above) and cancellation.
 */
export async function getJson<T>(
  url: string | URL,
  options: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let refusedWith: number | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    options.signal?.throwIfAborted();
    if (attempt > 0) await sleep(500 * attempt, options.signal);

    // Two reasons to give up on one request: it took too long, or the run it
    // belongs to was stopped. Combining them here is what lets a cancelled run
    // drop its in-flight lookups immediately instead of waiting out the timeout.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        log.debug(`provider request failed ${res.status}: ${url}`);
        // 403 is a rejected or over-quota key: retrying in half a second
        // insults everyone's time, so it is reported straight away.
        if (res.status === 403) refusedWith = 403;
        else if (res.status === 429) refusedWith = 429;
        if (refusedWith === 403) break;
        if (res.status >= 500 || res.status === 429) continue;
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      options.signal?.throwIfAborted();
      log.debug(`provider request errored: ${(err as Error).message}`);
    }
  }

  if (refusedWith !== null) throw new ProviderRefusedError(new URL(url).host, refusedWith);
  return null;
}

export interface PartialMap<R> {
  /** What finished, in input order. */
  results: R[];
  /** True when a stop ended it before every item was reached. */
  stopped: boolean;
  /** How many items were never started. */
  unreached: number;
}

/**
 * Runs tasks with a bounded number in flight, preserving input order, and
 * treats a stop as an ending rather than an error: whatever finished comes
 * back, and `stopped` says the rest never ran.
 *
 * That distinction is the whole point. A stopped run has still done everything
 * up to the moment it was stopped -- a `rate` run stopped at book 300 has
 * reached a verdict on 300 books -- and throwing the results away on the way
 * out left the run with nothing to show for the work it did.
 */
export async function mapLimitPartial<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): Promise<PartialMap<R>> {
  const slots = new Array<{ value: R } | undefined>(items.length);
  let cursor = 0;
  let stopped = false;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      // Checked before claiming the next item rather than mid-flight: work
      // already started is allowed to finish, so a stopped run leaves whole
      // items behind it rather than half of one.
      if (options.signal?.aborted) {
        stopped = true;
        return;
      }
      const index = cursor++;
      if (index >= items.length) return;
      try {
        slots[index] = { value: await fn(items[index]!, index) };
      } catch (err) {
        // A stop reaches the HTTP layer, so the item in flight fails with the
        // abort reason. That is the run ending, not the item failing, and
        // anything else is a real error that must still end the run.
        if (options.signal?.aborted) {
          stopped = true;
          return;
        }
        throw err;
      }
    }
  });

  await Promise.all(workers);

  const results: R[] = [];
  for (const slot of slots) if (slot) results.push(slot.value);
  return { results, stopped, unreached: items.length - results.length };
}

/**
 * The same, for callers with nothing useful to say about partial work: a stop
 * is raised as the error it was.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): Promise<R[]> {
  const mapped = await mapLimitPartial(items, limit, fn, options);
  if (mapped.stopped) options.signal?.throwIfAborted();
  return mapped.results;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
