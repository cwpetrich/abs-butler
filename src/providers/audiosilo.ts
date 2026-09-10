import { normalizeAsin } from './audible.js';
import { getJson } from './http.js';
import type { BookQuery, ContentSignal, MetadataProvider, ProviderResult } from './types.js';

/**
 * AudioSilo Meta — an open, community-maintained audiobook database.
 *
 * The only source here that is not derived from a retailer. It is CC0, needs no
 * key, publishes no rate card, and is edited through pull requests against a
 * public repository, so it answers for editions Audible has delisted and keeps
 * answering if a marketplace stops talking to us.
 *
 * What makes it worth a second audiobook lookup is that it models a **work**
 * separately from its **recordings**. Every other provider here flattens the
 * two, so a book with three narrations is three unrelated records with no way
 * to tell which one is on disk. Here an ASIN — from *any* marketplace, not just
 * the configured one — resolves to one specific narration of one work, which is
 * the strongest identification available for a library that AudiobookShelf has
 * matched against a non-US region.
 *
 * Descriptions are deliberately not read. The community-written ones are
 * share-alike (CC BY-SA 4.0), so writing one into someone's library would put
 * their metadata under a licence they never chose — and they exist for 471 of
 * 277,628 works, which is not a trade worth making. Publisher blurbs come from
 * the retailer sources, which is where they belong.
 */

const BASE_URL = 'https://meta.audiosilo.app';

/** People and series come back as `{ id, name }`; ids are stable slugs. */
interface NamedRef {
  id?: string;
  name?: string;
}

interface SeriesRef extends NamedRef {
  /** A string, deliberately: "2", "2.5" and the omnibus "1-3.5" all occur. */
  position?: string;
}

interface AsinRef {
  region?: string;
  asin?: string;
}

interface RecordingDetail {
  id?: string;
  narrators?: NamedRef[];
  runtime_min?: number;
  release_date?: string;
  publisher?: string;
  asin?: AsinRef[];
  isbn?: string[];
  chapter_count?: number;
}

interface WorkDetail {
  id?: string;
  title?: string;
  subtitle?: string;
  authors?: NamedRef[];
  language?: string;
  first_published?: string;
  /** Slugs from their own retailer-neutral vocabulary: "hard-science-fiction". */
  genres?: string[];
  series?: SeriesRef[];
  recordings?: RecordingDetail[] | null;
}

interface LookupResult {
  work?: { id?: string; title?: string };
  recording_id?: string;
}

/**
 * The `/abs/search` shape, which is AudiobookShelf's own BookMetadata rather
 * than this API's work shape: one entry per recording, names comma-joined,
 * genres as display labels. Only `title` is guaranteed.
 */
interface AbsBook {
  title?: string;
  subtitle?: string;
  author?: string;
  narrator?: string;
  publisher?: string;
  publishedYear?: string;
  isbn?: string;
  asin?: string;
  genres?: string[];
  series?: Array<{ series?: string; sequence?: string }>;
  language?: string;
  duration?: number;
}

/**
 * Community-curated and reviewed rather than crowd-tagged, but describing the
 * work rather than one publisher's edition — so above Open Library's shelving
 * and below a category the publisher assigned to the recording itself.
 */
const GENRE_WEIGHT = 0.8;

export class AudioSiloProvider implements MetadataProvider {
  readonly name = 'audiosilo';

  isAvailable(): boolean {
    return true;
  }

  async search(query: BookQuery, signal?: AbortSignal): Promise<ProviderResult[]> {
    const asin = normalizeAsin(query.asin);
    if (asin) {
      const exact = await this.byAsin(asin, signal);
      if (exact) return [exact];
      // Not an identifier this database carries. The title search still runs,
      // for the same reason it does in the Audible provider: a fuzzy match may
      // fill a blank field, and scoring stops it doing anything more.
    }

    return this.byTitle(query, signal);
  }

  /**
   * Resolve an ASIN to the exact narration it names.
   *
   * Worth two requests for what it buys: `/abs/search` publishes only the
   * US-region ASIN for a recording, so a library matched against Audible UK
   * would never match on identifier and would fall back to comparing titles.
   * The lookup endpoint resolves any region's ASIN, which is precisely the
   * evidence `normalize` needs before it will rewrite a narrator.
   */
  private async byAsin(asin: string, signal?: AbortSignal): Promise<ProviderResult | null> {
    const url = new URL(`${BASE_URL}/api/v1/lookup`);
    url.searchParams.set('asin', asin);

    const found = await getJson<LookupResult>(url, { signal });
    const workId = found?.work?.id;
    if (!workId) return null;

    const work = await getJson<WorkDetail>(
      new URL(`${BASE_URL}/api/v1/works/${encodeURIComponent(workId)}`),
      { signal },
    );
    if (!work?.title) return null;

    const recordings = work.recordings ?? [];
    const recording = recordings.find((r) => r.id === found.recording_id) ?? recordings[0];

    // Reported as the ASIN that was asked about rather than the one this record
    // happens to publish. That is what the lookup established — this identifier
    // names this narration — and it is what lets scoring treat it as exact.
    return workToResult(work, recording, asin);
  }

  private async byTitle(query: BookQuery, signal?: AbortSignal): Promise<ProviderResult[]> {
    const title = query.title?.trim();
    if (!title) return [];

    const url = new URL(`${BASE_URL}/abs/search`);
    url.searchParams.set('query', title);
    if (query.author) url.searchParams.set('author', query.author);
    // Resolved exactly when it is known here, and ignored otherwise.
    if (query.isbn) url.searchParams.set('isbn', query.isbn);
    url.searchParams.set('mediaType', 'book');

    const body = await getJson<{ matches?: AbsBook[] }>(url, { signal });
    return (body?.matches ?? []).filter((m) => m.title).map((m) => absBookToResult(m, this.name));
  }
}

function workToResult(
  work: WorkDetail,
  recording: RecordingDetail | undefined,
  asin: string,
): ProviderResult {
  const genres = (work.genres ?? []).map(unslug);
  const series = work.series?.[0];

  return {
    provider: 'audiosilo',
    providerId: asin,
    title: work.title,
    subtitle: work.subtitle || undefined,
    authors: names(work.authors),
    narrators: names(recording?.narrators),
    series: series?.name
      ? { name: series.name, sequence: series.position || undefined }
      : undefined,
    // The audio release, not the work's first publication — the same choice the
    // other audiobook sources make, so the three cannot disagree about which
    // date a year means.
    publishedYear: year(recording?.release_date ?? work.first_published),
    publisher: recording?.publisher || undefined,
    isbn: recording?.isbn?.[0] || undefined,
    language: work.language || undefined,
    genres,
    subjects: genres,
    url: work.id ? `${BASE_URL}/works/${work.id}` : undefined,
    signals: genreSignals(genres),
  };
}

function absBookToResult(book: AbsBook, provider: string): ProviderResult {
  const genres = book.genres ?? [];
  const series = book.series?.[0];

  return {
    provider,
    providerId: book.asin || undefined,
    title: book.title,
    subtitle: book.subtitle || undefined,
    authors: splitNames(book.author),
    narrators: splitNames(book.narrator),
    series: series?.series
      ? { name: series.series, sequence: series.sequence || undefined }
      : undefined,
    publishedYear: year(book.publishedYear),
    publisher: book.publisher || undefined,
    isbn: book.isbn || undefined,
    language: book.language || undefined,
    genres,
    subjects: genres,
    signals: genreSignals(genres),
  };
}

function genreSignals(genres: string[]): ContentSignal[] {
  return genres.map((value) => ({ source: 'audiosilo:genre', value, weight: GENRE_WEIGHT }));
}

/**
 * "hard-science-fiction" to "Hard Science Fiction".
 *
 * The JSON API serves slugs and `/abs/search` serves display labels for the
 * same vocabulary. Converting here means one book yields the same signal text
 * whichever way it was found, so the two paths cannot disagree about a rating.
 */
export function unslug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * `/abs/search` joins names with ", " because that is the shape
 * AudiobookShelf's own fields use. Splitting it back is lossy in exactly one
 * case — a name stored "Last, First" — and this database stores natural order,
 * so the split is safe here and would not be against ABS's own `authorName`.
 */
export function splitNames(joined: string | undefined): string[] | undefined {
  if (!joined) return undefined;
  const parts = joined
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function names(people: NamedRef[] | undefined): string[] | undefined {
  const found = (people ?? []).map((p) => p.name).filter(isPresent);
  return found.length > 0 ? found : undefined;
}

function year(date: string | undefined): string | undefined {
  if (!date) return undefined;
  return /^(\d{4})/.exec(date)?.[1];
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
