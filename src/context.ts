import { AbsClient } from './abs/client.js';
import type { AbsLibrary, AbsLibraryItem } from './abs/types.js';
import { openDb, type Db } from './db/index.js';
import {
  getConnection,
  getConnectionWithKey,
  upgradeStoredKey,
  type ConnectionRecord,
  type ConnectionWithKey,
} from './db/connection.js';
import { getSettings, type Settings } from './db/settings.js';
import { assessCapability, type Capability } from './core/capability.js';
import { log } from './logger.js';

export interface GlobalOptions {
  library?: string;
}

/** Everything a task needs: the connection, a client for it, and settings. */
export interface TaskContext {
  db: Db;
  connection: ConnectionRecord;
  client: AbsClient;
  settings: Settings;
}

export const NOT_CONNECTED =
  'AudiobookShelf is not connected yet. Open the web UI to set the server URL and API key, ' +
  'or run: abs-butler connect --url http://localhost:13378 --api-key <key>';

export function buildClient(connection: ConnectionWithKey): AbsClient {
  return new AbsClient({ baseUrl: connection.url, token: connection.apiKey });
}

/** Opens the database, re-sealing any key stored before encryption was automatic. */
export function openStore(): Db {
  const db = openDb();
  if (upgradeStoredKey(db)) {
    log.debug('re-encrypted an API key that was stored in plaintext');
  }
  return db;
}

export function openContext(db: Db): TaskContext {
  const withKey = getConnectionWithKey(db);
  if (!withKey) throw new Error(NOT_CONNECTED);

  return {
    db,
    connection: getConnection(db)!,
    client: buildClient(withKey),
    settings: getSettings(db),
  };
}

/**
 * Resolves the target libraries. With no `--library`, every book library is
 * included; podcast libraries are skipped since none of the book tooling applies.
 */
export async function resolveLibraries(ctx: TaskContext, library?: string): Promise<AbsLibrary[]> {
  if (library) return [await ctx.client.resolveLibrary(library)];

  const all = await ctx.client.listLibraries();
  const books = all.filter((l) => l.mediaType === 'book');
  if (books.length === 0) {
    throw new Error(`No book libraries found on ${ctx.connection.url}.`);
  }
  if (all.length !== books.length) {
    log.debug(`skipping ${all.length - books.length} non-book librar(ies)`);
  }
  return books;
}

export async function checkCapability(ctx: TaskContext): Promise<Capability> {
  const libraries = await ctx.client.listLibraries();
  return assessCapability(ctx.connection, libraries);
}

/** Collects items across libraries, with an optional cap for quick trial runs. */
export async function collectItems(
  ctx: TaskContext,
  libraries: AbsLibrary[],
  options: { limit?: number } = {},
): Promise<AbsLibraryItem[]> {
  const items: AbsLibraryItem[] = [];
  for (const library of libraries) {
    log.info(`reading library ${library.name}…`);
    for await (const item of ctx.client.iterateLibraryItems(library.id)) {
      items.push(item);
      if (options.limit && items.length >= options.limit) return items;
    }
  }
  return items;
}

export function itemTitle(item: AbsLibraryItem): string {
  return item.media?.metadata?.title ?? item.relPath ?? item.id;
}

export function itemAuthor(item: AbsLibraryItem): string | null {
  const metadata = item.media?.metadata;
  return metadata?.authorName ?? metadata?.authors?.[0]?.name ?? null;
}
