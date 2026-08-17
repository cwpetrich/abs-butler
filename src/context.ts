import { AbsClient } from './abs/client.js';
import type { AbsLibrary, AbsLibraryItem } from './abs/types.js';
import { loadEnvConfig } from './config.js';
import { openDb, type Db } from './db/index.js';
import {
  createServer,
  findServer,
  getServerWithKey,
  listServers,
  type ServerRecord,
  type ServerWithKey,
} from './db/servers.js';
import { getSettings, updateSettings, type Settings } from './db/settings.js';
import { assessCapability, type ServerCapability } from './core/capability.js';
import { log } from './logger.js';

export interface GlobalOptions {
  config?: string;
  server?: string;
  library?: string;
}

/** Everything a command needs to act on one AudiobookShelf server. */
export interface ServerContext {
  db: Db;
  server: ServerRecord;
  client: AbsClient;
  settings: Settings;
}

export function buildClient(server: ServerWithKey): AbsClient {
  return new AbsClient({ baseUrl: server.url, token: server.apiKey });
}

/**
 * Carries a pre-0.2 environment configuration into the database the first time
 * it runs, so an existing .env keeps working without manual migration.
 */
export function bootstrapFromEnv(db: Db): ServerRecord | null {
  if (listServers(db).length > 0) return null;

  const env = loadEnvConfig();
  if (!env) return null;

  const apiKey = env.absToken;
  if (!apiKey) {
    log.warn(
      'ABS_URL is set but ABS_TOKEN is not. Username/password login is no longer imported ' +
        'automatically — add the server with an API token: abs-butler server add',
    );
    return null;
  }

  const server = createServer(db, {
    name: env.name ?? 'default',
    url: env.absUrl,
    apiKey,
    libraryRoot: env.libraryRoot ?? null,
    pathPrefix: env.absPathPrefix ?? null,
  });
  log.info(`imported server "${server.name}" from environment configuration`);

  if (env.googleBooksApiKey || env.providerConcurrency) {
    updateSettings(db, {
      ...(env.googleBooksApiKey ? { googleBooksApiKey: env.googleBooksApiKey } : {}),
      ...(env.providerConcurrency ? { providerConcurrency: env.providerConcurrency } : {}),
    });
  }
  return server;
}

/** Opens the database, importing any legacy env configuration on first use. */
export function openStore(): Db {
  const db = openDb();
  bootstrapFromEnv(db);
  return db;
}

export function resolveServerRecord(db: Db, idOrName?: string): ServerRecord {
  const servers = listServers(db);
  if (servers.length === 0) {
    throw new Error(
      'No servers configured. Add one with:\n' +
        '  abs-butler server add --name home --url http://localhost:13378 --api-key <key>',
    );
  }

  if (idOrName) {
    const found = findServer(db, idOrName);
    if (!found) {
      throw new Error(
        `No server matching "${idOrName}". Configured: ${servers.map((s) => s.name).join(', ')}`,
      );
    }
    return found;
  }

  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 1) return enabled[0]!;
  if (enabled.length === 0) throw new Error('Every configured server is disabled.');

  throw new Error(
    `More than one server is configured; choose one with --server. ` +
      `Configured: ${enabled.map((s) => s.name).join(', ')}`,
  );
}

export function openServerContext(db: Db, idOrName?: string): ServerContext {
  const record = resolveServerRecord(db, idOrName);
  const withKey = getServerWithKey(db, record.id);
  if (!withKey) throw new Error(`Server ${record.name} disappeared while loading it.`);

  return {
    db,
    server: record,
    client: buildClient(withKey),
    settings: getSettings(db),
  };
}

/** Every enabled server, for commands run across the whole fleet. */
export function openAllServerContexts(db: Db): ServerContext[] {
  return listServers(db)
    .filter((s) => s.enabled)
    .map((s) => openServerContext(db, String(s.id)));
}

/**
 * Resolves the target libraries. With no `--library`, every book library is
 * included; podcast libraries are skipped since none of the book tooling applies.
 */
export async function resolveLibraries(ctx: ServerContext, library?: string): Promise<AbsLibrary[]> {
  if (library) return [await ctx.client.resolveLibrary(library)];

  const all = await ctx.client.listLibraries();
  const books = all.filter((l) => l.mediaType === 'book');
  if (books.length === 0) {
    throw new Error(`No book libraries found on ${ctx.server.name}.`);
  }
  if (all.length !== books.length) {
    log.debug(`skipping ${all.length - books.length} non-book librar(ies)`);
  }
  return books;
}

export async function checkCapability(ctx: ServerContext): Promise<ServerCapability> {
  const libraries = await ctx.client.listLibraries();
  return assessCapability(ctx.server, libraries);
}

/** Collects items across libraries, with an optional cap for quick trial runs. */
export async function collectItems(
  ctx: ServerContext,
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
