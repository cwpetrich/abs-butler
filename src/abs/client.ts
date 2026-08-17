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
  username?: string;
  password?: string;
  /** Retries for transient failures (429 / 5xx / network). */
  maxRetries?: number;
}

/**
 * Thin client over the AudiobookShelf HTTP API.
 *
 * All writes go through `patchItemMedia` / `scanLibrary`, which are the only
 * mutating calls in this codebase — commands must not hand-roll fetches.
 */
export class AbsClient {
  private readonly baseUrl: string;
  private token: string | undefined;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly maxRetries: number;

  constructor(options: AbsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.username = options.username;
    this.password = options.password;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** Exchanges username/password for a token when no token was supplied. */
  async ensureAuth(): Promise<void> {
    if (this.token) return;
    if (!this.username || !this.password) {
      throw new Error('No ABS credentials available; set ABS_TOKEN or ABS_USERNAME/ABS_PASSWORD.');
    }
    log.debug('logging in to AudiobookShelf as', this.username);
    const res = await this.request<{ user: { token: string } }>('POST', '/login', {
      body: { username: this.username, password: this.password },
      skipAuth: true,
    });
    this.token = res.user?.token;
    if (!this.token) throw new Error('Login succeeded but returned no token.');
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined>; skipAuth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!options.skipAuth && this.token) headers.Authorization = `Bearer ${this.token}`;
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
