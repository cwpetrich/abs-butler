import type { AbsLibraryItem } from '../abs/types.js';
import {
  assessContent,
  assessmentToTags,
  isButlerTag,
  BAND_MIN_AGE,
  type AgeBand,
  type ContentAssessment,
} from '../content/ageRating.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type ServerContext } from '../context.js';
import { log } from '../logger.js';
import { mapLimit } from '../providers/http.js';
import { buildProviders } from '../providers/index.js';
import type { MetadataProvider, ProviderResult } from '../providers/types.js';

export interface RatingResult {
  itemId: string;
  title: string;
  author: string | null;
  assessment: ContentAssessment;
  currentTags: string[];
  proposedTags: string[];
  changed: boolean;
}

/** Looks a single item up across all providers and merges the signals. */
export async function rateItem(
  item: AbsLibraryItem,
  providers: MetadataProvider[],
  options: { minConfidence?: number } = {},
): Promise<RatingResult> {
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
      if (result) results.push(result);
    } catch (err) {
      log.debug(`${provider.name} failed for "${query.title}": ${(err as Error).message}`);
    }
  }

  const assessment = assessContent(results);

  // ABS's own explicit flag is authoritative when set — it beats any inference.
  if (metadata?.explicit) {
    assessment.band = 'adult';
    assessment.confidence = Math.max(assessment.confidence, 0.9);
    assessment.evidence.unshift('audiobookshelf: explicit flag set');
  }

  const currentTags = item.media?.tags ?? [];
  const preserved = currentTags.filter((tag) => !isButlerTag(tag));
  const generated = assessmentToTags(assessment, { minConfidence: options.minConfidence });
  const proposedTags = [...preserved, ...generated];

  return {
    itemId: item.id,
    title: itemTitle(item),
    author: itemAuthor(item),
    assessment,
    currentTags,
    proposedTags,
    changed: !sameSet(currentTags, proposedTags),
  };
}

export interface RateTaskOptions {
  library?: string;
  apply?: boolean;
  limit?: number;
  providers?: string[];
  minConfidence?: number;
  force?: boolean;
  maxAge?: number;
}

export interface RateTaskResult {
  rated: number;
  skippedAlreadyRated: number;
  tagged: number;
  wouldTag: number;
  applied: boolean;
  bandCounts: Record<string, number>;
  unknownBand: number;
  results: RatingResult[];
}

export async function runRateTask(
  ctx: ServerContext,
  options: RateTaskOptions = {},
): Promise<RateTaskResult> {
  const providers = buildProviders(
    {
      googleBooksApiKey: ctx.settings.googleBooksApiKey || undefined,
      providerConcurrency: ctx.settings.providerConcurrency,
    },
    options.providers ?? ctx.settings.providers,
  );
  log.info(`using providers: ${providers.map((p) => p.name).join(', ')}`);

  const libraries = await resolveLibraries(ctx, options.library);
  const all = await collectItems(ctx, libraries, { limit: options.limit });
  const items = options.force ? all : all.filter((i) => !(i.media?.tags ?? []).some(isButlerTag));
  const skipped = all.length - items.length;

  if (items.length === 0) {
    log.success('Every item already has an abs-butler rating. Use force to re-rate.');
    return {
      rated: 0,
      skippedAlreadyRated: skipped,
      tagged: 0,
      wouldTag: 0,
      applied: Boolean(options.apply),
      bandCounts: {},
      unknownBand: 0,
      results: [],
    };
  }

  log.info(`rating ${items.length} item(s)${options.force ? '' : ' without an existing rating'}…`);

  const minConfidence = options.minConfidence ?? ctx.settings.minConfidence;
  let done = 0;
  const results = await mapLimit(items, ctx.settings.providerConcurrency, async (item) => {
    const result = await rateItem(item, providers, { minConfidence });
    done += 1;
    if (done % 25 === 0) log.info(`  ${done}/${items.length}`);
    return result;
  });

  const bandCounts: Record<string, number> = {};
  for (const result of results) {
    const band = result.assessment.band;
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }
  const unknownBand = bandCounts.unknown ?? 0;
  if (unknownBand > 0) log.warn(`${unknownBand} item(s) had no usable audience signal`);

  const changes = results.filter((r) => r.changed);
  let tagged = 0;
  if (options.apply) {
    for (const change of changes) {
      await ctx.client.patchItemMedia(change.itemId, { tags: change.proposedTags });
      tagged += 1;
      if (tagged % 25 === 0) log.info(`  wrote ${tagged}/${changes.length}`);
    }
    log.success(`Tagged ${tagged} item(s).`);
  } else {
    log.info(`${changes.length} item(s) would be tagged. Apply to write to AudiobookShelf.`);
  }

  const filtered =
    options.maxAge === undefined
      ? results
      : results.filter(
          (r) => r.assessment.band !== 'unknown' && BAND_MIN_AGE[r.assessment.band as AgeBand] > options.maxAge!,
        );

  return {
    rated: results.length,
    skippedAlreadyRated: skipped,
    tagged,
    wouldTag: changes.length,
    applied: Boolean(options.apply),
    bandCounts,
    unknownBand,
    results: filtered,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}
