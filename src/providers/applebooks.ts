import { getJson } from './http.js';
import type { BookQuery, MetadataProvider, ProviderResult } from './types.js';

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
 * Apple applies "Books" to every book and a handful of others to whole
 * storefront sections. They are true of everything, so they say nothing, and
 * feeding them to the age rules is noise that dilutes the specific labels
 * beside them.
 */
const USELESS_GENRES = new Set(['books', 'audiobooks', 'fiction & literature', 'nonfiction']);

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
 * **It emits no content signals, and that is a measured decision rather than an
 * oversight.** Apple's categories looked like the best audience data available
 * — "Dystopian Fiction for Young Adults", "Counting & Numbers for Kids" — and
 * feeding them to the age rules made banding *worse*: across eight books it
 * scored 3/8 against Open Library's 4/8, moving The Very Hungry Caterpillar and
 * Goodnight Moon to middle-grade. The cause is vocabulary, not weighting.
 * Apple files everything from board books to age twelve under "Kids", so its
 * labels cannot separate picture-book from middle-grade, which is exactly the
 * boundary that was already hardest. Dropping the "Kids" family and keeping the
 * precise "for Young Adults" one was measured too and scored 3/8 again, this
 * time by pushing Charlotte's Web to young-adult.
 *
 * The genres still travel on the result for display and for anything that wants
 * them; they simply do not vote on an age band. Making them useful means rules
 * written for Apple's vocabulary, measured against the table in
 * docs/content-ratings.md — worth doing, and not worth guessing at.
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
    // `genres`, deliberately not `subjects`: subjects is the age rules' raw
    // material, and these are measured not to belong there.
    ...(genres.length > 0 ? { genres } : {}),
    ...(typeof result.averageUserRating === 'number'
      ? { averageRating: result.averageUserRating }
      : {}),
    ...(typeof result.userRatingCount === 'number' ? { ratingsCount: result.userRatingCount } : {}),
    ...(result.trackViewUrl ? { url: result.trackViewUrl } : {}),
    signals: [],
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
