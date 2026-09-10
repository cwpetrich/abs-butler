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

/** Runs tasks with a bounded number in flight, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal } = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      // Checked before claiming the next item rather than mid-flight: work
      // already started is allowed to finish, so a stopped run leaves whole
      // items behind it rather than half of one.
      options.signal?.throwIfAborted();
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
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
