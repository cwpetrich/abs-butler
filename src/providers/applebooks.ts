import { getJson } from './http.js';
import type { BookQuery, ContentSignal, MetadataProvider, ProviderResult } from './types.js';

const SEARCH_URL = 'https://itunes.apple.com/search';

/**
 * Apple's storefronts are separate catalogues with separate category names.
 * US is the default because it is the largest and the only one the age rules
 * are written against — they are English-only, and a French storefront would
 * return "Littérature pour la jeunesse", which no rule matches.
 */
const DEFAULT_COUNTRY = 'us';

/**
 * Apple ranks commercially rather than lexically, and its book search is loose
 * enough to answer "the final empire sanderson" with a different book in the
 * same series. Scoring throws those out — this is only how many it gets to
 * offer before that happens.
 */
const MAX_RESULTS = 10;

/**
 * How much Apple's own filing is worth, per label.
 *
 * Apple double-files: Charlotte's Web and Holes are both "Kids" *and* "Young
 * Adult", while genuine young-adult books carry no children's label at all. So
 * a young-adult label from Apple means "sold to teenagers or younger", which is
 * much weaker than what the same words mean from a cataloguer — and the rule it
 * matches is the strongest in the table. Discounting it here is the fix: the
 * rules stay right for everyone else, and Apple's own uncertainty is expressed
 * where it is known.
 *
 * Everything else is trusted at 0.8, a shade under a cataloguing standard,
 * because these are still merchandising categories.
 */
const YOUNG_ADULT_LABEL = /young adult/i;
const DEFAULT_WEIGHT = 0.8;
const YOUNG_ADULT_WEIGHT = 0.35;

/**
 * Apple applies "Books" to every book and a handful of others to whole
 * storefront sections. They are true of everything, so they say nothing, and
 * feeding them to the age rules is noise that dilutes the specific labels
 * beside them.
 */
const USELESS_GENRES = new Set([
  'books',
  'audiobooks',
  'fiction & literature',
  'nonfiction',
  // Apple's top-level storefront sections, which sit alongside the specific
  // labels rather than adding to them: every book tagged "Fiction for Kids" is
  // also tagged "Kids". Dropping them is not cosmetic. Rules sum within a
  // provider — only the *same* rule dedupes — so the vague "Kids" rule was
  // stacking 0.24 onto the 0.64 from "Fiction for Kids" and out-voting the
  // 0.72 that "Basic Concepts for Kids" contributes to early-reader. A picture
  // book came back middle-grade because its shelf was counted twice.
  'kids',
  'young adult',
]);

interface AppleResult {
  trackId?: number;
  trackName?: string;
  collectionName?: string;
  artistName?: string;
  description?: string;
  releaseDate?: string;
  genres?: string[];
  primaryGenreName?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  trackViewUrl?: string;
}

/**
 * Apple Books, through the public iTunes Search API.
 *
 * Free and keyless, which is most of why it is here: it is the only source in
 * the set that needs no account at all, so it works on a fresh install before
 * anything is configured.
 *
 * It is queried as an *ebook* source even for audiobooks, which looks wrong and
 * is deliberate. Apple's audiobook records carry a single `primaryGenreName`
 * ("Sci-Fi & Fantasy") while its ebook records carry a dozen specific ones, and
 * categories are the whole reason to ask Apple — it has no narrator, no ISBN,
 * no publisher and no series. The ebook edition of an audiobook describes the
 * same work, so the categories transfer and the answer is richer.
 *
 * What it cannot do is rewrite anything. Apple publishes no identifier this
 * tool can match on — no ISBN, and `lookup?isbn=` returns nothing — so every
 * match is fuzzy, and a fuzzy match is capped below the rewrite threshold by
 * design. Apple fills blanks; it never renames a book.
 *
 * Its categories took two measured corrections before they were worth having,
 * and the first attempt made age banding *worse* — 3 of 8 books correct against
 * Open Library's 4 of 8. Both causes are recorded here because both are easy to
 * reintroduce:
 *
 * Apple double-files. Charlotte's Web and Holes are "Kids" *and* "Young Adult",
 * while genuine young-adult books carry no children's label at all — so a
 * young-adult label from Apple means "sold to teenagers or younger", far weaker
 * than the same words from a cataloguer, and it was matching the strongest rule
 * in the table. Hence the discount below rather than a change to the rule,
 * which is right for everyone else.
 *
 * Apple's storefront sections duplicate its specific labels: everything tagged
 * "Fiction for Kids" is also tagged "Kids". Rules sum within a provider, so the
 * vague one stacked on the specific one and outvoted the early-reader signal.
 * They are dropped in USELESS_GENRES.
 *
 * With both corrections, and with age rules taught Apple's pre-reader
 * vocabulary, Apple and Open Library together score 8 of 11 where Open Library
 * alone scores 7 — and Apple alone gets Holes and Green Eggs right where Open
 * Library does not.
 */
export class AppleBooksProvider implements MetadataProvider {
  readonly name = 'applebooks';

  constructor(private readonly country: string = DEFAULT_COUNTRY) {}

  isAvailable(): boolean {
    return true;
  }

  async search(query: BookQuery, signal?: AbortSignal): Promise<ProviderResult[]> {
    const term = [query.title, query.author].filter(Boolean).join(' ').trim();
    if (!term) return [];

    const url = new URL(SEARCH_URL);
    url.searchParams.set('term', term);
    url.searchParams.set('media', 'ebook');
    url.searchParams.set('limit', String(MAX_RESULTS));
    url.searchParams.set('country', this.country);

    const data = await getJson<{ results?: AppleResult[] }>(url, { signal });
    return (data?.results ?? [])
      .filter((result) => result.trackName || result.collectionName)
      .map((result) => toResult(this.name, result));
  }
}

function toResult(provider: string, result: AppleResult): ProviderResult {
  const genres = usefulGenres(result);
  const title = result.trackName || result.collectionName || '';

  return {
    provider,
    ...(result.trackId ? { providerId: String(result.trackId) } : {}),
    title,
    ...(result.artistName ? { authors: [result.artistName] } : {}),
    ...(plainText(result.description) ? { description: plainText(result.description) } : {}),
    ...(year(result.releaseDate) ? { publishedYear: year(result.releaseDate) } : {}),
    ...(genres.length > 0 ? { genres, subjects: genres } : {}),
    ...(typeof result.averageUserRating === 'number'
      ? { averageRating: result.averageUserRating }
      : {}),
    ...(typeof result.userRatingCount === 'number' ? { ratingsCount: result.userRatingCount } : {}),
    ...(result.trackViewUrl ? { url: result.trackViewUrl } : {}),
    signals: buildSignals(genres),
  };
}

/**
 * `genres` where Apple gives the full list, falling back to the single
 * `primaryGenreName` an audiobook record carries. Deduplicated case-insensitively,
 * because "Fantasy" and "fantasy" both appear across storefronts.
 */
function usefulGenres(result: AppleResult): string[] {
  const all = result.genres ?? (result.primaryGenreName ? [result.primaryGenreName] : []);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const genre of all) {
    const key = genre.trim().toLowerCase();
    if (!key || USELESS_GENRES.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(genre.trim());
  }
  return kept;
}

function buildSignals(genres: string[]): ContentSignal[] {
  return genres.map((genre) => ({
    source: 'applebooks:genre',
    value: genre,
    weight: YOUNG_ADULT_LABEL.test(genre) ? YOUNG_ADULT_WEIGHT : DEFAULT_WEIGHT,
  }));
}

function year(releaseDate: string | undefined): string | undefined {
  if (!releaseDate) return undefined;
  const match = /^(\d{4})/.exec(releaseDate);
  return match?.[1];
}

/**
 * Apple descriptions are HTML — `<b>`, `<i>`, `<br />` — and AudiobookShelf
 * shows a description as text, so the markup would be read literally.
 */
function plainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}
