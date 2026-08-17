import { AbsClient } from './abs/client.js';
import type { AbsLibrary, AbsLibraryItem } from './abs/types.js';
import { loadConfig, type Config } from './config.js';
import { log } from './logger.js';

export interface GlobalOptions {
  config?: string;
  library?: string;
}

export interface RunContext {
  config: Config;
  client: AbsClient;
}

/** Loads config, builds a client, and authenticates. Every command starts here. */
export async function createContext(options: GlobalOptions = {}): Promise<RunContext> {
  const config = loadConfig({ configPath: options.config });
  const client = new AbsClient({
    baseUrl: config.absUrl,
    token: config.absToken,
    username: config.absUsername,
    password: config.absPassword,
  });
  await client.ensureAuth();
  return { config, client };
}

/**
 * Resolves the target libraries. With no `--library`, every book library is
 * included; podcast libraries are skipped since none of the book tooling applies.
 */
export async function resolveLibraries(ctx: RunContext, library?: string): Promise<AbsLibrary[]> {
  if (library) return [await ctx.client.resolveLibrary(library)];

  const all = await ctx.client.listLibraries();
  const books = all.filter((l) => l.mediaType === 'book');
  if (books.length === 0) {
    throw new Error('No book libraries found on this server.');
  }
  if (all.length !== books.length) {
    log.debug(`skipping ${all.length - books.length} non-book librar(ies)`);
  }
  return books;
}

/** Collects items across libraries, with an optional cap for quick trial runs. */
export async function collectItems(
  ctx: RunContext,
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
