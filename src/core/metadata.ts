import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type ServerContext } from '../context.js';
import { log } from '../logger.js';
import { mapLimit } from '../providers/http.js';
import { buildProviders } from '../providers/index.js';
import type { MetadataProvider, ProviderResult } from '../providers/types.js';
import { isBlank, normalizeTitle } from '../util/text.js';

/**
 * Only fields where a provider answer is safe to trust. Notably absent: title
 * and author — a wrong provider match would rename the book, and matching is
 * AudiobookShelf's job via its own quick-match.
 */
export const FILLABLE = ['description', 'publishedYear', 'publisher', 'isbn', 'language'] as const;
export type Fillable = (typeof FILLABLE)[number];

export interface FieldChange {
  field: Fillable;
  from: string | null;
  to: string;
  source: string;
}

export interface MetadataPlan {
  itemId: string;
  title: string;
  author: string | null;
  changes: FieldChange[];
}

function currentValue(item: AbsLibraryItem, field: Fillable): string | null {
  const metadata = item.media?.metadata;
  switch (field) {
    case 'description':
      return metadata?.description ?? null;
    case 'publishedYear':
      return metadata?.publishedYear ?? null;
    case 'publisher':
      return metadata?.publisher ?? null;
    case 'isbn':
      return metadata?.isbn ?? null;
    case 'language':
      return metadata?.language ?? null;
  }
}

function providerValue(result: ProviderResult, field: Fillable): string | null {
  switch (field) {
    case 'description':
      return result.description ?? null;
    case 'publishedYear':
      return result.publishedYear ?? null;
    case 'publisher':
      return result.publisher ?? null;
    case 'isbn':
      return result.isbn ?? null;
    case 'language':
      return null; // No provider here reports language reliably enough to write it.
  }
}

/**
 * Guards against a bad match writing another book's description onto this item:
 * the provider's title must normalize to something recognizably similar.
 */
export function titlesAgree(item: AbsLibraryItem, result: ProviderResult): boolean {
  const local = normalizeTitle(item.media?.metadata?.title);
  const remote = normalizeTitle(result.title);
  if (!local || !remote) return false;
  return local === remote || local.startsWith(remote) || remote.startsWith(local);
}

export async function planMetadata(
  item: AbsLibraryItem,
  providers: MetadataProvider[],
  options: { fields: Fillable[]; overwrite?: boolean },
): Promise<MetadataPlan> {
  const metadata = item.media?.metadata;
  const query = {
    title: metadata?.title ?? '',
    author: itemAuthor(item),
    isbn: metadata?.isbn ?? null,
    asin: metadata?.asin ?? null,
  };

  const results: ProviderResult[] = [];
  for (const provider of providers) {
    try {
      const result = await provider.lookup(query);
      // An ISBN lookup is already an exact match; only fuzzy title lookups need the guard.
      if (result && (query.isbn || titlesAgree(item, result))) results.push(result);
    } catch (err) {
      log.debug(`${provider.name} failed for "${query.title}": ${(err as Error).message}`);
    }
  }

  const changes: FieldChange[] = [];
  for (const field of options.fields) {
    const existing = currentValue(item, field);
    if (!options.overwrite && !isBlank(existing)) continue;

    for (const result of results) {
      const candidate = providerValue(result, field);
      if (isBlank(candidate) || candidate === existing) continue;
      changes.push({ field, from: existing, to: candidate!, source: result.provider });
      break; // Providers are ordered by trust; first answer wins.
    }
  }

  return { itemId: item.id, title: itemTitle(item), author: itemAuthor(item), changes };
}

export interface MetadataTaskOptions {
  library?: string;
  apply?: boolean;
  limit?: number;
  providers?: string[];
  fields?: string[];
  overwrite?: boolean;
}

export interface MetadataTaskResult {
  scanned: number;
  itemsToUpdate: number;
  fieldsToFill: number;
  updated: number;
  applied: boolean;
  fields: Fillable[];
  plans: MetadataPlan[];
}

export async function runMetadataTask(
  ctx: ServerContext,
  options: MetadataTaskOptions = {},
): Promise<MetadataTaskResult> {
  const requested = (options.fields ?? [...FILLABLE]) as Fillable[];
  const invalid = requested.filter((f) => !FILLABLE.includes(f));
  if (invalid.length > 0) {
    throw new Error(`Unknown field(s): ${invalid.join(', ')}. Valid: ${FILLABLE.join(', ')}`);
  }

  const providers = buildProviders(
    {
      googleBooksApiKey: ctx.settings.googleBooksApiKey || undefined,
      providerConcurrency: ctx.settings.providerConcurrency,
    },
    options.providers ?? ctx.settings.providers,
  );

  const libraries = await resolveLibraries(ctx, options.library);
  const items = await collectItems(ctx, libraries, { limit: options.limit });
  log.info(`checking ${items.length} item(s) for missing ${requested.join(', ')}…`);

  const plans = await mapLimit(items, ctx.settings.providerConcurrency, (item) =>
    planMetadata(item, providers, { fields: requested, overwrite: options.overwrite }),
  );
  const actionable = plans.filter((p) => p.changes.length > 0);
  const fieldsToFill = actionable.reduce((sum, p) => sum + p.changes.length, 0);

  let updated = 0;
  if (options.apply) {
    for (const plan of actionable) {
      const patch: AbsMediaPatch = { metadata: {} };
      for (const change of plan.changes) {
        (patch.metadata as Record<string, string>)[change.field] = change.to;
      }
      await ctx.client.patchItemMedia(plan.itemId, patch);
      updated += 1;
    }
    log.success(`Updated ${updated} item(s).`);
  } else if (actionable.length === 0) {
    log.success('Nothing to fill in.');
  } else {
    log.info(`${actionable.length} item(s) would be updated. Apply to write.`);
  }

  return {
    scanned: items.length,
    itemsToUpdate: actionable.length,
    fieldsToFill,
    updated,
    applied: Boolean(options.apply),
    fields: requested,
    plans: actionable,
  };
}
