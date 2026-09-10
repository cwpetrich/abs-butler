import { getJson } from './http.js';
import type { BookQuery, ContentSignal, MetadataProvider, ProviderResult } from './types.js';

/**
 * Audible's own catalog API — the source behind the source.
 *
 * Audnexus is a community proxy in front of exactly this endpoint, so asking it
 * directly is not a new source of truth so much as the same one without the
 * intermediary. What it buys is the thing Audnexus structurally cannot do:
 *
 * - **Title search.** Audnexus is keyed on ASIN alone, so a library
 *   AudiobookShelf never matched gets nothing at all from the audiobook tier
 *   and is carried entirely by Open Library and Google Books — neither of which
 *   knows a narrator exists. Here a title and author are enough to find the
 *   book, and `scoreCandidate` caps what a fuzzy match may rewrite, so the
 *   extra reach fills blanks without ever renaming anything.
 * - **Category ladders.** Audible's categories arrive as full paths —
 *   "Children's Audiobooks > Literature & Fiction > Chapter Books & Readers >
 *   Early Readers" — rather than the flat genre list Audnexus flattens them
 *   into. The audience level lives in those upper nodes, and it is
 *   publisher-assigned against one specific audio edition, which makes it the
 *   most precise age signal available here.
 *
 * The trade is that this API is undocumented and unsanctioned. It is the one
 * the Audible apps use, it has no published terms covering third-party access,
 * and Amazon can change or block it without notice. Audnexus stays in the
 * provider set behind this one for exactly that reason: when one stops
 * answering, the other is already configured.
 *
 * Category names come back localized in non-English marketplaces, and the age
 * rules in content/ageRating.ts are English-only — so on a `de` or `fr` region
 * this still contributes narrator, series and publisher, but not an age band.
 */

/** Marketplace hosts, one per region the settings allow. */
const REGION_HOSTS: Record<string, string> = {
  us: 'api.audible.com',
  ca: 'api.audible.ca',
  uk: 'api.audible.co.uk',
  au: 'api.audible.com.au',
  fr: 'api.audible.fr',
  de: 'api.audible.de',
  jp: 'api.audible.co.jp',
  it: 'api.audible.it',
  in: 'api.audible.in',
  es: 'api.audible.es',
};

/** Where a human goes to see the book, for the `url` on a result. */
const REGION_SITES: Record<string, string> = {
  us: 'www.audible.com',
  ca: 'www.audible.ca',
  uk: 'www.audible.co.uk',
  au: 'www.audible.com.au',
  fr: 'www.audible.fr',
  de: 'www.audible.de',
  jp: 'www.audible.co.jp',
  it: 'www.audible.it',
  in: 'www.audible.in',
  es: 'www.audible.es',
};

/**
 * Everything asked for in one request. The API returns only the field groups
 * named here, and a missing group is silently absent rather than an error —
 * which is why every field below is treated as optional.
 */
const RESPONSE_GROUPS = [
  // Authors, narrators, and — despite the name — publisher_name.
  'contributors',
  // release_date, language, runtime, is_adult_product. Easy to leave out, and
  // its absence is silent: every field simply arrives undefined.
  'product_attrs',
  'product_extended_attrs',
  'product_desc',
  'series',
  'rating',
  'category_ladders',
].join(',');

/**
 * Deliberately larger than the 3 the other providers ask for.
 *
 * Audible ranks by *commercial* relevance, not lexical: searching the title
 * "The Hunger Games" returns the newest book in the series first and the book
 * actually named that fifth. Three results would have missed it entirely.
 * Extra candidates cost bandwidth, never accuracy — `pickBest` scores all of
 * them against the query and keeps one — and the answer is then cached.
 */
const MAX_RESULTS = 10;

interface AudibleNamed {
  asin?: string;
  name?: string;
}

interface AudibleSeries {
  asin?: string;
  /** The series name. Audible calls it `title`, unlike every other field here. */
  title?: string;
  sequence?: string;
}

interface AudibleCategory {
  id?: string;
  name?: string;
}

interface AudibleLadder {
  ladder?: AudibleCategory[];
  root?: string;
}

interface AudibleRating {
  overall_distribution?: {
    average_rating?: number;
    num_ratings?: number;
  };
}

interface AudibleProduct {
  asin?: string;
  title?: string;
  subtitle?: string;
  authors?: AudibleNamed[];
  narrators?: AudibleNamed[];
  series?: AudibleSeries[];
  publication_name?: string;
  publisher_name?: string;
  publisher_summary?: string;
  merchandising_summary?: string;
  release_date?: string;
  issue_date?: string;
  language?: string;
  isbn?: string;
  runtime_length_min?: number;
  is_adult_product?: boolean;
  category_ladders?: AudibleLadder[];
  rating?: AudibleRating;
}

export class AudibleProvider implements MetadataProvider {
  readonly name = 'audible';
  private readonly host: string;
  private readonly site: string;

  constructor(private readonly region = 'us') {
    this.host = REGION_HOSTS[region] ?? REGION_HOSTS.us!;
    this.site = REGION_SITES[region] ?? REGION_SITES.us!;
  }

  isAvailable(): boolean {
    return true;
  }

  async search(query: BookQuery, signal?: AbortSignal): Promise<ProviderResult[]> {
    const asin = normalizeAsin(query.asin);

    if (asin) {
      const exact = await this.byAsin(asin, signal);
      if (exact) return [this.toResult(exact)];
      // An ASIN that returns nothing usually means the book is not sold in this
      // marketplace rather than that it does not exist, so the title search
      // still runs. A different edition found that way cannot match the ASIN,
      // so scoring reads it as fuzzy and it may fill blanks but never rewrite.
    }

    return (await this.byTitle(query, signal)).map((product) => this.toResult(product));
  }

  /**
   * One product by ASIN.
   *
   * Audible answers 200 with a stub `{ product: { asin } }` for an ASIN it does
   * not know, so "found" is decided by whether a title came back, not by the
   * status code.
   */
  private async byAsin(asin: string, signal?: AbortSignal): Promise<AudibleProduct | null> {
    const url = new URL(`https://${this.host}/1.0/catalog/products/${asin}`);
    url.searchParams.set('response_groups', RESPONSE_GROUPS);

    const body = await getJson<{ product?: AudibleProduct }>(url, { signal });
    return body?.product?.title ? body.product : null;
  }

  private async byTitle(query: BookQuery, signal?: AbortSignal): Promise<AudibleProduct[]> {
    const title = query.title?.trim();
    if (!title) return [];

    const url = new URL(`https://${this.host}/1.0/catalog/products`);
    url.searchParams.set('title', title);
    if (query.author) url.searchParams.set('author', query.author);
    url.searchParams.set('num_results', String(MAX_RESULTS));
    url.searchParams.set('products_sort_by', 'Relevance');
    url.searchParams.set('response_groups', RESPONSE_GROUPS);

    const body = await getJson<{ products?: AudibleProduct[] }>(url, { signal });
    return (body?.products ?? []).filter((product) => Boolean(product.title));
  }

  private toResult(product: AudibleProduct): ProviderResult {
    const categories = ladderCategories(product.category_ladders);
    const series = product.series?.[0];
    const overall = product.rating?.overall_distribution;

    return {
      provider: this.name,
      // Matched against the library's ASIN by scoreCandidate, which is what
      // lets an Audible answer clear the bar for rewriting a title.
      providerId: product.asin,
      title: product.title,
      subtitle: product.subtitle || undefined,
      authors: names(product.authors),
      narrators: names(product.narrators),
      series: series?.title
        ? { name: series.title, sequence: series.sequence || undefined }
        : undefined,
      description: plainText(product.publisher_summary ?? product.merchandising_summary),
      publishedYear: year(product.release_date ?? product.issue_date),
      publisher: product.publisher_name || undefined,
      isbn: product.isbn || undefined,
      language: languageCode(product.language),
      genres: categories.leaves,
      subjects: categories.all,
      maturityRating:
        product.is_adult_product === undefined
          ? null
          : product.is_adult_product
            ? 'MATURE'
            : 'NOT_MATURE',
      averageRating: overall?.average_rating,
      ratingsCount: overall?.num_ratings,
      url: product.asin ? `https://${this.site}/pd/${product.asin}` : undefined,
      signals: buildSignals(product, categories),
    };
  }
}

/**
 * Every distinct name in every ladder, plus the most specific one from each.
 *
 * Both halves are wanted and for different reasons. The leaves are the genre a
 * person would recognize, and the claim the publisher actually made about the
 * edition; the full set adds the upper nodes — "Children's Audiobooks", "Teen
 * & Young Adult" — which is where the audience level lives. They are scored at
 * different weights for the reason given at ANCESTOR_WEIGHT.
 *
 * A name that is a leaf in one ladder and an ancestor in another counts as a
 * leaf: something was filed there.
 */
export function ladderCategories(ladders: AudibleLadder[] | undefined): {
  all: string[];
  leaves: string[];
} {
  const all = new Set<string>();
  const leaves = new Set<string>();

  for (const ladder of ladders ?? []) {
    const steps = (ladder.ladder ?? []).map((c) => c.name).filter(isPresent);
    for (const step of steps) all.add(step);
    const leaf = steps.at(-1);
    if (leaf) leaves.add(leaf);
  }

  return { all: [...all], leaves: [...leaves] };
}

/**
 * Weight of the node a book was actually filed under. Publisher-assigned and
 * specific to one audio edition, so it sits above Google Books' BISAC
 * categories and well above crowd shelving.
 */
const LEAF_WEIGHT = 0.9;

/**
 * Weight of the nodes above it.
 *
 * Lower, because Audible's tree nests specific under general in ways that
 * invert what a reader would infer. *The Very Hungry Caterpillar* is filed
 * under "Early Readers", whose parent is "Chapter Books & Readers" — and a
 * chapter book is middle grade. Weighted equally, the parent plus the kids
 * shelf outvoted the leaf and banded a picture book as middle grade. Ancestors
 * are context; the leaf is the claim.
 */
const ANCESTOR_WEIGHT = 0.55;

function buildSignals(
  product: AudibleProduct,
  categories: { all: string[]; leaves: string[] },
): ContentSignal[] {
  const leaves = new Set(categories.leaves);
  const signals: ContentSignal[] = categories.all.map((value) => ({
    source: 'audible:category',
    value,
    weight: leaves.has(value) ? LEAF_WEIGHT : ANCESTOR_WEIGHT,
  }));

  // Only when true. "Not adult" is the default state of the catalogue rather
  // than a verdict anyone recorded, and treating it as evidence would let every
  // ordinary book argue about its own age band.
  if (product.is_adult_product) {
    signals.push({ source: 'audible:adult', value: 'MATURE', weight: 0.95 });
  }

  return signals;
}

/**
 * Audible ASINs are 10 characters, and AudiobookShelf stores whatever was typed
 * into it — sometimes a full product URL. Anything that is not a bare ASIN is
 * rejected rather than guessed at, since a wrong one returns another book's
 * narrator with complete confidence.
 */
export function normalizeAsin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(trimmed) ? trimmed : null;
}

/**
 * Audible reports a language name ("english"), while AudiobookShelf and every
 * other provider here speak in codes. Only the languages worth a confident
 * mapping are translated; anything else is dropped rather than written wrong.
 */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  swedish: 'sv',
  norwegian: 'no',
  danish: 'da',
  finnish: 'fi',
  polish: 'pl',
  russian: 'ru',
  japanese: 'ja',
  chinese: 'zh',
  korean: 'ko',
};

export function languageCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return LANGUAGE_CODES[value.trim().toLowerCase()];
}

/**
 * Audible's summaries are HTML, and `description` is written straight into a
 * field AudiobookShelf renders as text — so the markup has to come off here
 * rather than surface as literal tags in someone's library.
 */
export function plainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    // Paragraph and line breaks are the only structure worth keeping; without
    // this a multi-paragraph blurb collapses into one run-on sentence.
    .replace(/<\/(p|div|h[1-6])>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|quot|apos|lt|gt|#39);/g, (_, entity: string) => ENTITIES[entity] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  '#39': "'",
  lt: '<',
  gt: '>',
};

function year(date: string | undefined): string | undefined {
  if (!date) return undefined;
  return /^(\d{4})/.exec(date)?.[1];
}

function names(people: AudibleNamed[] | undefined): string[] | undefined {
  const found = (people ?? []).map((p) => p.name).filter(isPresent);
  return found.length > 0 ? found : undefined;
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
