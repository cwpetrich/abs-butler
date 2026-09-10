import { log } from '../logger.js';

/**
 * Whether a newer abs-butler has been published.
 *
 * Read from /releases rather than /tags, which is not a detail. A tag exists
 * the instant it is pushed, before anything is built; a release exists only
 * after the image is published, because the release job is gated on it. Read
 * from tags, a failed image build would still tell every install that an
 * upgrade was available and send its operator to a version they cannot pull.
 * The rule is the same one the release workflow follows: announce nothing that
 * cannot be fetched.
 *
 * Drafts and prereleases are skipped, and the ordering GitHub returns is
 * GitHub's business rather than a promise, so the tag names are compared
 * instead of trusted.
 *
 * The check is best-effort in every direction: it is cached, it times out, and
 * a failure is logged at debug and reported as "unknown" rather than raised.
 * Nothing abs-butler does depends on the answer, so nothing should break when
 * GitHub is unreachable, rate-limits an unauthenticated caller, or is simply
 * slow.
 */
const RELEASES_URL = 'https://api.github.com/repos/cwpetrich/abs-butler/releases';
const CACHE_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 5_000;

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: number | null;
  /** Set when the last attempt failed, so the UI can stay quiet about it. */
  error?: string;
}

/** Numeric compare of dotted versions. Returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest release-shaped tag.
 *
 * Tags come back newest-first, but that ordering is GitHub's business and not
 * a promise, so they are compared rather than trusted. Anything not shaped
 * like vX.Y.Z is ignored, which keeps a stray tag from being announced as a
 * release.
 */
export function newestTag(names: string[]): string | null {
  const releases = names.filter((n) => /^v\d+\.\d+(\.\d+)?$/.test(n));
  if (releases.length === 0) return null;
  return releases.reduce((best, n) => (compareVersions(n, best) > 0 ? n : best));
}

let cache: { at: number; latest: string | null; error?: string } | null = null;

/** Exposed so tests do not have to wait out the cache. */
export function resetUpdateCache(): void {
  cache = null;
}

export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateStatus> {
  const fresh = cache && Date.now() - cache.at < CACHE_MS;
  if (!fresh) {
    try {
      const res = await fetchImpl(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as Array<{
        tag_name?: string;
        draft?: boolean;
        prerelease?: boolean;
      }>;
      const names = Array.isArray(body)
        ? body.filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name ?? '')
        : [];
      cache = { at: Date.now(), latest: newestTag(names) };
    } catch (err) {
      const message = (err as Error).message;
      log.debug(`update check failed: ${message}`);
      cache = { at: Date.now(), latest: cache?.latest ?? null, error: message };
    }
  }

  const latest = cache?.latest ?? null;
  return {
    current,
    latest,
    available: Boolean(latest) && compareVersions(latest!, current) > 0,
    checkedAt: cache?.at ?? null,
    ...(cache?.error ? { error: cache.error } : {}),
  };
}
