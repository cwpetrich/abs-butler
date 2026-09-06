import { getJson } from './http.js';
import type { BookQuery, MetadataProvider, ProviderResult } from './types.js';

const BASE_URL = 'https://api.audnex.us';

interface AudnexNamed {
  asin?: string;
  name?: string;
}

interface AudnexSeries {
  asin?: string;
  name?: string;
  position?: string;
}

interface AudnexGenre {
  asin?: string;
  name?: string;
  /** Audible's own split: `genre` is the shelf, `tag` the finer category. */
  type?: 'genre' | 'tag';
}

interface AudnexBook {
  asin?: string;
  title?: string;
  subtitle?: string;
  authors?: AudnexNamed[];
  narrators?: AudnexNamed[];
  seriesPrimary?: AudnexSeries;
  seriesSecondary?: AudnexSeries;
  publisherName?: string;
  releaseDate?: string;
  description?: string;
  summary?: string;
  language?: string;
  isbn?: string;
  genres?: AudnexGenre[];
  rating?: string;
  formatType?: string;
  literatureType?: string;
  isAdult?: boolean;
  runtimeLengthMin?: number;
}

/**
 * Audnexus — the source AudiobookShelf itself matches against.
 *
 * It is the only provider here that knows an audiobook is an audiobook. Open
 * Library and Google Books describe the *work*: they have no narrator, no
 * audio edition, and their series data is thin where it exists at all. Every
 * field this tool wants to normalize but could not before — narrator, series
 * name and position, subtitle — comes from here.
 *
 * The trade is that it is keyed on ASIN alone. There is no title search, so a
 * book AudiobookShelf never matched yields nothing and the general-purpose
 * providers carry the lookup. That is the right shape: an ASIN is an exact
 * identifier for one edition, which is precisely the confidence needed before
 * overwriting a title someone can see.
 */
export class AudnexusProvider implements MetadataProvider {
  readonly name = 'audnexus';

  constructor(private readonly region = 'us') {}

  isAvailable(): boolean {
    return true;
  }

  async search(query: BookQuery): Promise<ProviderResult[]> {
    const asin = normalizeAsin(query.asin);
    if (!asin) return [];

    const url = new URL(`${BASE_URL}/books/${asin}`);
    url.searchParams.set('region', this.region);

    // A 404 covers both "no such ASIN" and "not sold in this region", and
    // getJson turns either into null — nothing to distinguish, since both mean
    // this provider has no answer.
    const book = await getJson<AudnexBook>(url);
    if (!book?.title) return [];

    const genres = (book.genres ?? []).map((g) => g.name).filter(isPresent);
    const series = book.seriesPrimary?.name
      ? { name: book.seriesPrimary.name, sequence: book.seriesPrimary.position || undefined }
      : undefined;

    return [{
      provider: this.name,
      providerId: book.asin ?? asin,
      title: book.title,
      subtitle: book.subtitle || undefined,
      authors: (book.authors ?? []).map((a) => a.name).filter(isPresent),
      narrators: (book.narrators ?? []).map((n) => n.name).filter(isPresent),
      series,
      // `summary` is the publisher's blurb as HTML; `description` is the same
      // text flattened. The flat one is what belongs in a metadata field.
      description: book.description || undefined,
      publishedYear: year(book.releaseDate),
      publisher: book.publisherName || undefined,
      // Audnexus returns an empty string for books it has no ISBN for.
      isbn: book.isbn || undefined,
      language: languageCode(book.language),
      genres,
      averageRating: book.rating ? Number(book.rating) || undefined : undefined,
      url: `https://www.audible.com/pd/${asin}`,
      signals: buildSignals(book, genres),
    }];
  }
}

/**
 * Audible categories are publisher-assigned and audiobook-specific, so they are
 * trusted a little above Google Books' BISAC and well above crowd shelving.
 * `isAdult` is the closest thing Audible has to a maturity verdict.
 */
function buildSignals(book: AudnexBook, genres: string[]): ProviderResult['signals'] {
  const signals = genres.map((value) => ({
    source: 'audnexus:genre',
    value,
    weight: 0.9,
  }));
  if (book.isAdult) {
    signals.push({ source: 'audnexus:adult', value: 'MATURE', weight: 0.95 });
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

function year(releaseDate: string | undefined): string | undefined {
  if (!releaseDate) return undefined;
  const match = /^(\d{4})/.exec(releaseDate);
  return match?.[1];
}

/**
 * Audnexus reports a language name ("english"), while AudiobookShelf and every
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

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
