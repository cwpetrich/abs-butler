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
import { mapLimit } from './providers/http.js';

export interface GlobalOptions {
  library?: string;
}

/** Everything a task needs: the connection, a client for it, and settings. */
export interface TaskContext {
  db: Db;
  connection: ConnectionRecord;
  client: AbsClient;
  settings: Settings;
  /**
   * The run these writes belong to, so each one can record how to undo it.
   *
   * Absent only where no run owns the work — every path that applies changes
   * sets it, and `applyPatch` silently records nothing without it, which is why
   * commands must go through that rather than calling the client directly.
   */
  runId?: number;
  /**
   * Aborted when someone stops the run. Tasks are expected to cooperate: check
   * it before starting the next item and let it reach the network layer, so a
   * stopped run ends within a request rather than at the end of the library.
   *
   * Absent on the CLI paths, where Ctrl-C already ends the process.
   */
  signal?: AbortSignal | undefined;
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

/**
 * Number of expanded item fetches in flight. This talks to AudiobookShelf,
 * which is normally the same machine, so it is bounded to be polite rather
 * than because the network is slow.
 */
const EXPAND_CONCURRENCY = 8;

/**
 * Collects items across libraries, with an optional cap for quick trial runs.
 *
 * `expand` decides which of two genuinely different shapes comes back.
 * AudiobookShelf's library listing returns *minified* items, and minified
 * metadata has no `authors`, `narrators` or `series` — only the flattened
 * `authorName`, `narratorName` and `seriesName` strings. Those flattened forms
 * are lossy in ways that matter: `authorName` joins co-authors with a comma,
 * which is indistinguishable from a single name written "Last, First", and
 * `seriesName` folds the sequence into the name as "Barsoom #1".
 *
 * So anything that reads the structured fields has to ask for each item in
 * full, one request apiece. Anything that only needs the flat fields — audit,
 * rate, metadata — stays on the single cheap listing.
 */
export async function collectItems(
  ctx: TaskContext,
  libraries: AbsLibrary[],
  options: { limit?: number; expand?: boolean } = {},
): Promise<AbsLibraryItem[]> {
  const items: AbsLibraryItem[] = [];
  outer: for (const library of libraries) {
    log.info(`reading library ${library.name}…`);
    for await (const item of ctx.client.iterateLibraryItems(library.id)) {
      ctx.signal?.throwIfAborted();
      items.push(item);
      if (options.limit && items.length >= options.limit) break outer;
    }
  }

  if (!options.expand) return items;

  log.info(`fetching full metadata for ${items.length} item(s)…`);
  return mapLimit(items, EXPAND_CONCURRENCY, async (item) => {
    try {
      return await ctx.client.getItem(item.id);
    } catch (err) {
      // A stopped run is the one failure worth propagating — it is the answer
      // to a question someone asked, not a flaw in the item.
      if (ctx.signal?.aborted) throw err;
      // One unreadable item should not abort a whole run. The minified copy is
      // still usable for everything but the structured fields.
      log.debug(`could not expand ${item.id}: ${(err as Error).message}`);
      return item;
    }
  }, { signal: ctx.signal });
}

export function itemTitle(item: AbsLibraryItem): string {
  return item.media?.metadata?.title ?? item.relPath ?? item.id;
}

export function itemAuthor(item: AbsLibraryItem): string | null {
  const metadata = item.media?.metadata;
  return metadata?.authorName ?? metadata?.authors?.[0]?.name ?? null;
}
