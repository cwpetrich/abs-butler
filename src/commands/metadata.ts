import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { collectItems, createContext, itemAuthor, itemTitle, resolveLibraries, type GlobalOptions } from '../context.js';
import { color, log } from '../logger.js';
import { mapLimit } from '../providers/http.js';
import { buildProviders } from '../providers/index.js';
import type { ProviderResult } from '../providers/types.js';
import { printJson, printTable } from '../util/table.js';
import { isBlank, normalizeTitle, truncate } from '../util/text.js';

export interface MetadataOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  limit?: number;
  providers?: string[];
  /** Fields eligible for filling. Defaults to everything safe to infer. */
  fields?: string[];
  /** Overwrite fields that already have a value (off by default). */
  overwrite?: boolean;
}

/**
 * Only fields where a provider answer is safe to trust. Notably absent: title
 * and author — a wrong provider match would rename the book, and matching is
 * ABS's job via its own quick-match.
 */
const FILLABLE = ['description', 'publishedYear', 'publisher', 'isbn', 'language'] as const;
type Fillable = (typeof FILLABLE)[number];

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
function titlesAgree(item: AbsLibraryItem, result: ProviderResult): boolean {
  const local = normalizeTitle(item.media?.metadata?.title);
  const remote = normalizeTitle(result.title);
  if (!local || !remote) return false;
  return local === remote || local.startsWith(remote) || remote.startsWith(local);
}

export async function planMetadata(
  item: AbsLibraryItem,
  providers: ReturnType<typeof buildProviders>,
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

export async function runMetadata(options: MetadataOptions): Promise<void> {
  const requested = (options.fields ?? [...FILLABLE]) as Fillable[];
  const invalid = requested.filter((f) => !FILLABLE.includes(f));
  if (invalid.length > 0) {
    throw new Error(`Unknown field(s): ${invalid.join(', ')}. Valid: ${FILLABLE.join(', ')}`);
  }

  const ctx = await createContext(options);
  const providers = buildProviders(ctx.config, options.providers);
  const libraries = await resolveLibraries(ctx, options.library);
  const items = await collectItems(ctx, libraries, { limit: options.limit });

  log.info(`checking ${items.length} item(s) for missing ${requested.join(', ')}…`);

  const plans = await mapLimit(items, ctx.config.providerConcurrency, (item) =>
    planMetadata(item, providers, { fields: requested, overwrite: options.overwrite }),
  );
  const actionable = plans.filter((p) => p.changes.length > 0);

  if (options.json) {
    printJson({ scanned: items.length, plans: actionable });
  } else if (actionable.length === 0) {
    log.success('Nothing to fill in.');
    return;
  } else {
    printTable(
      actionable.flatMap((plan) => plan.changes.map((change) => ({ plan, change }))),
      [
        { header: 'TITLE', value: ({ plan }) => truncate(plan.title, 40), maxWidth: 40 },
        { header: 'FIELD', value: ({ change }) => change.field },
        { header: 'NEW VALUE', value: ({ change }) => color.green(truncate(change.to, 50)), maxWidth: 50 },
        { header: 'SRC', value: ({ change }) => color.dim(change.source) },
      ],
    );
  }

  if (!options.apply) {
    log.info(`${actionable.length} item(s) would be updated. Re-run with --apply to write.`);
    return;
  }

  let written = 0;
  for (const plan of actionable) {
    const patch: AbsMediaPatch = { metadata: {} };
    for (const change of plan.changes) {
      (patch.metadata as Record<string, string>)[change.field] = change.to;
    }
    await ctx.client.patchItemMedia(plan.itemId, patch);
    written += 1;
  }
  log.success(`Updated ${written} item(s).`);
}

export const METADATA_FIELDS = [...FILLABLE];
