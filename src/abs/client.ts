import { log } from '../logger.js';
import type {
  AbsLibrary,
  AbsLibraryItem,
  AbsMediaPatch,
  AbsPage,
} from './types.js';

export class AbsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'AbsApiError';
  }
}

export interface AbsClientOptions {
  baseUrl: string;
  token?: string;
  /** Retries for transient failures (429 / 5xx / network). */
  maxRetries?: number;
}

/**
 * Thin client over the AudiobookShelf HTTP API.
 *
 * All writes go through `patchItemMedia` / `scanLibrary`, which are the only
 * mutating calls in this codebase — commands must not hand-roll fetches. The
 * one other POST is `login`, which touches no library data: it exchanges
 * credentials for the API token everything else runs on.
 */
export class AbsClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly maxRetries: number;

  constructor(options: AbsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(2 ** attempt * 250, 4000);
        log.debug(`retrying ${method} ${path} in ${delay}ms (attempt ${attempt + 1})`);
        await sleep(delay);
      }
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        if (res.ok) {
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }

        const body = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          throw new AbsApiError(
            `AudiobookShelf rejected the credentials (${res.status}) on ${method} ${path}.`,
            res.status,
            body,
          );
        }
        if (res.status >= 500 || res.status === 429) {
          lastError = new AbsApiError(`${method} ${path} failed: ${res.status}`, res.status, body);
          continue;
        }
        throw new AbsApiError(`${method} ${path} failed: ${res.status} ${body.slice(0, 300)}`, res.status, body);
      } catch (err) {
        if (err instanceof AbsApiError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`${method} ${path} failed after ${this.maxRetries + 1} attempts`);
  }

  async listLibraries(): Promise<AbsLibrary[]> {
    const res = await this.request<{ libraries: AbsLibrary[] }>('GET', '/api/libraries');
    return res.libraries ?? [];
  }

  /**
   * Exchanges a username and password for a long-lived API token.
   *
   * AudiobookShelf returns three credentials from `/login`. `user.token` is the
   * one to keep: it carries no `exp` claim, so it behaves exactly like the API
   * token copied out of the web UI, and abs-butler stores nothing else. The
   * `accessToken` beside it expires in an hour and the refresh token arrives as
   * an httpOnly cookie, so both would drag session handling into a scheduler
   * that runs unattended.
   *
   * Verified against AudiobookShelf 2.36.0.
   */
  async login(username: string, password: string): Promise<string> {
    const res = await this.request<AbsLoginResponse>('POST', '/login', {
      body: { username, password },
    });
    const token = res?.user?.token;
    if (!token) {
      // Reached on a version that has dropped the legacy field. Everything
      // downstream assumes a durable token, so failing here beats storing an
      // accessToken that dies in an hour.
      throw new Error(
        'AudiobookShelf accepted the login but returned no long-lived API token. ' +
          'Create an API token in AudiobookShelf (Settings → Users → your user → API Token) ' +
          'and connect with that instead.',
      );
    }
    return token;
  }

  /** Resolves a library by id, exact name, or case-insensitive name. */
  async resolveLibrary(idOrName: string): Promise<AbsLibrary> {
    const libraries = await this.listLibraries();
    const match =
      libraries.find((l) => l.id === idOrName) ??
      libraries.find((l) => l.name === idOrName) ??
      libraries.find((l) => l.name.toLowerCase() === idOrName.toLowerCase());
    if (!match) {
      const names = libraries.map((l) => `${l.name} (${l.id})`).join(', ') || 'none found';
      throw new Error(`No library matching "${idOrName}". Available: ${names}`);
    }
    return match;
  }

  /** Yields every item in a library, paging transparently. */
  async *iterateLibraryItems(
    libraryId: string,
    options: { pageSize?: number } = {},
  ): AsyncGenerator<AbsLibraryItem> {
    const limit = options.pageSize ?? 100;
    let page = 0;
    let fetched = 0;
    for (;;) {
      const res = await this.request<AbsPage<AbsLibraryItem>>('GET', `/api/libraries/${libraryId}/items`, {
        query: { limit, page },
      });
      const results = res.results ?? [];
      for (const item of results) yield item;
      fetched += results.length;
      if (results.length < limit || fetched >= (res.total ?? 0)) return;
      page += 1;
    }
  }

  async listLibraryItems(libraryId: string): Promise<AbsLibraryItem[]> {
    const items: AbsLibraryItem[] = [];
    for await (const item of this.iterateLibraryItems(libraryId)) items.push(item);
    return items;
  }

  async getItem(itemId: string): Promise<AbsLibraryItem> {
    return this.request<AbsLibraryItem>('GET', `/api/items/${itemId}`, { query: { expanded: 1 } });
  }

  async patchItemMedia(itemId: string, patch: AbsMediaPatch): Promise<void> {
    await this.request('PATCH', `/api/items/${itemId}/media`, { body: patch });
  }

  async scanLibrary(libraryId: string, options: { force?: boolean } = {}): Promise<void> {
    await this.request('POST', `/api/libraries/${libraryId}/scan`, {
      query: options.force ? { force: 1 } : {},
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only the field abs-butler keeps; `/login` returns a great deal more. */
interface AbsLoginResponse {
  user?: { token?: string };
}

/** Either way of proving who you are. Exactly one of the two is used. */
export interface AbsCredentials {
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

/**
 * Reduces either credential form to the API token that gets stored.
 *
 * The password is used for this one request and then goes out of scope: it is
 * never written to the database, and the logger never records request bodies.
 * An API token is preferred when both are somehow present, because it is the
 * credential that can be revoked in AudiobookShelf without a password change.
 */
export async function resolveApiKey(
  baseUrl: string,
  credentials: AbsCredentials,
): Promise<string> {
  if (credentials.apiKey) return credentials.apiKey;
  if (credentials.username && credentials.password) {
    return new AbsClient({ baseUrl }).login(credentials.username, credentials.password);
  }
  throw new Error('Provide either an API token, or a username and password.');
}
