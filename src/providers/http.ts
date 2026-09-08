import { log } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 15_000;
// Sent to Open Library and Google Books, both of which ask that clients
// identify themselves. The URL has to be the real one — it is how they reach
// a maintainer when a client misbehaves.
const USER_AGENT = 'abs-butler/0.4 (+https://github.com/cwpetrich/abs-butler)';

/**
 * GET JSON with a timeout and one retry on transient failure.
 * Returns null rather than throwing when a provider simply has no answer,
 * so a single flaky source never aborts a whole library run.
 */
export async function getJson<T>(
  url: string | URL,
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<T | null> {
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        // 429 is worth a real warning: it means results are silently incomplete,
        // not that the book is unknown.
        if (res.status === 429) log.warn(`rate limited by ${new URL(url).host} — some lookups will be skipped`);
        else log.debug(`provider request failed ${res.status}: ${url}`);
        if (res.status >= 500 || res.status === 429) continue;
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      log.debug(`provider request errored: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Runs tasks with a bounded number in flight, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
