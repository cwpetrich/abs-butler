import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import { log } from '../logger.js';
import { mapLimit } from '../providers/http.js';
import { buildProviders } from '../providers/index.js';
import type { ProviderResult } from '../providers/types.js';
import { isBlank } from '../util/text.js';
import { lookupItem, type LookupDeps } from './lookup.js';
import { itemQuery } from './query.js';

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
      return result.language ?? null;
  }
}

export async function planMetadata(
  item: AbsLibraryItem,
  deps: LookupDeps,
  options: { fields: Fillable[]; overwrite?: boolean },
): Promise<MetadataPlan> {
  const { results } = await lookupItem(deps, itemQuery(item));

  const changes: FieldChange[] = [];
  for (const field of options.fields) {
    const existing = currentValue(item, field);
    if (!options.overwrite && !isBlank(existing)) continue;

    for (const result of results) {
      const candidate = providerValue(result, field);
      if (isBlank(candidate) || candidate === existing) continue;
      changes.push({ field, from: existing, to: candidate!, source: result.provider });
      break; // Results arrive best-match first, so the strongest answer wins.
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
  ctx: TaskContext,
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
      audibleRegion: ctx.settings.audibleRegion,
      providerConcurrency: ctx.settings.providerConcurrency,
    },
    options.providers ?? ctx.settings.providers,
  );
  const deps: LookupDeps = {
    providers,
    db: ctx.db,
    cacheDays: ctx.settings.lookupCacheDays,
  };

  const libraries = await resolveLibraries(ctx, options.library);
  const items = await collectItems(ctx, libraries, { limit: options.limit });
  log.info(`checking ${items.length} item(s) for missing ${requested.join(', ')}…`);

  const plans = await mapLimit(items, ctx.settings.providerConcurrency, (item) =>
    planMetadata(item, deps, { fields: requested, overwrite: options.overwrite }),
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
