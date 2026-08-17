import type { AbsLibraryItem } from '../abs/types.js';
import {
  assessContent,
  assessmentToTags,
  isButlerTag,
  BAND_MIN_AGE,
  type ContentAssessment,
} from '../content/ageRating.js';
import { collectItems, createContext, itemAuthor, itemTitle, resolveLibraries, type GlobalOptions } from '../context.js';
import { buildProviders } from '../providers/index.js';
import { mapLimit } from '../providers/http.js';
import type { ProviderResult } from '../providers/types.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { truncate } from '../util/text.js';

export interface RateOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  limit?: number;
  providers?: string[];
  minConfidence?: number;
  /** Re-rate items that already carry abs-butler tags. */
  force?: boolean;
  /** Only report items whose band exceeds this reader age. */
  maxAge?: number;
}

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
  providers: ReturnType<typeof buildProviders>,
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

export async function runRate(options: RateOptions): Promise<void> {
  const ctx = await createContext(options);
  const providers = buildProviders(ctx.config, options.providers);
  log.info(`using providers: ${providers.map((p) => p.name).join(', ')}`);

  const libraries = await resolveLibraries(ctx, options.library);
  const all = await collectItems(ctx, libraries, { limit: options.limit });
  const items = options.force ? all : all.filter((i) => !(i.media?.tags ?? []).some(isButlerTag));

  if (items.length === 0) {
    log.success('Every item already has an abs-butler rating. Use --force to re-rate.');
    return;
  }
  log.info(`rating ${items.length} item(s)${options.force ? '' : ' without an existing rating'}…`);

  let done = 0;
  const results = await mapLimit(items, ctx.config.providerConcurrency, async (item) => {
    const result = await rateItem(item, providers, { minConfidence: options.minConfidence });
    done += 1;
    if (done % 25 === 0) log.info(`  ${done}/${items.length}`);
    return result;
  });

  const filtered =
    options.maxAge === undefined
      ? results
      : results.filter(
          (r) => r.assessment.band !== 'unknown' && BAND_MIN_AGE[r.assessment.band] > options.maxAge!,
        );

  if (options.json) {
    printJson({ rated: results.length, results: filtered });
  } else {
    printTable(filtered, [
      { header: 'TITLE', value: (r) => truncate(r.title, 44), maxWidth: 44 },
      { header: 'BAND', value: (r) => bandColor(r.assessment.band) },
      { header: 'CONF', value: (r) => r.assessment.confidence.toFixed(2), align: 'right' },
      { header: 'FLAGS', value: (r) => r.assessment.flags.map((f) => f.flag).join(', ') || color.dim('—') },
      { header: 'SRC', value: (r) => color.dim(r.assessment.sources.join('/') || 'none') },
    ]);
    const unknown = results.filter((r) => r.assessment.band === 'unknown').length;
    if (unknown > 0) log.warn(`${unknown} item(s) had no usable audience signal — band left unknown`);
  }

  const changes = results.filter((r) => r.changed);
  if (!options.apply) {
    log.info(`${changes.length} item(s) would be tagged. Re-run with --apply to write to AudiobookShelf.`);
    return;
  }

  let written = 0;
  for (const change of changes) {
    await ctx.client.patchItemMedia(change.itemId, { tags: change.proposedTags });
    written += 1;
    if (written % 25 === 0) log.info(`  wrote ${written}/${changes.length}`);
  }
  log.success(`Tagged ${written} item(s).`);
}

function bandColor(band: ContentAssessment['band']): string {
  switch (band) {
    case 'early-reader':
      return color.green(band);
    case 'middle-grade':
      return color.cyan(band);
    case 'young-adult':
      return color.yellow(band);
    case 'adult':
      return color.red(band);
    default:
      return color.dim(band);
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}
