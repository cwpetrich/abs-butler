import { getJson } from './http.js';
import type { BookQuery, MetadataProvider, ProviderResult } from './types.js';

const SEARCH_URL = 'https://www.googleapis.com/books/v1/volumes';

interface GbVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    pageCount?: number;
    language?: string;
    categories?: string[];
    maturityRating?: 'NOT_MATURE' | 'MATURE';
    averageRating?: number;
    ratingsCount?: number;
    infoLink?: string;
  };
}

/**
 * Google Books. Works keyless (heavily rate limited) or with an API key from Settings.
 * Two things make it worth querying alongside Open Library: BISAC categories
 * ("Juvenile Fiction / Social Themes / Bullying") and an explicit maturityRating.
 */
export class GoogleBooksProvider implements MetadataProvider {
  readonly name = 'googlebooks';

  constructor(private readonly apiKey?: string) {}

  isAvailable(): boolean {
    return true;
  }

  async search(query: BookQuery): Promise<ProviderResult[]> {
    const terms: string[] = [];
    if (query.isbn) {
      terms.push(`isbn:${query.isbn.replace(/[^0-9Xx]/g, '')}`);
    } else {
      terms.push(`intitle:${quote(query.title)}`);
      if (query.author) terms.push(`inauthor:${quote(query.author)}`);
    }

    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', terms.join('+'));
    url.searchParams.set('maxResults', '3');
    url.searchParams.set('printType', 'books');
    if (this.apiKey) url.searchParams.set('key', this.apiKey);

    const data = await getJson<{ items?: GbVolume[] }>(url);
    return (data?.items ?? [])
      .filter((volume): volume is GbVolume & { volumeInfo: NonNullable<GbVolume['volumeInfo']> } =>
        Boolean(volume.volumeInfo),
      )
      .map((volume) => toResult(this.name, volume));
  }
}

function toResult(
  provider: string,
  volume: GbVolume & { volumeInfo: NonNullable<GbVolume['volumeInfo']> },
): ProviderResult {
  const info = volume.volumeInfo;
  const categories = info.categories ?? [];
  const signals = categories.map((value) => ({
    source: 'googlebooks:category',
    value,
    weight: 0.85, // BISAC categories are publisher-assigned, so more reliable than crowd shelves.
  }));
  if (info.maturityRating) {
    signals.push({
      source: 'googlebooks:maturity',
      value: info.maturityRating,
      weight: 0.9,
    });
  }

  return {
    provider,
    providerId: volume.id,
    title: info.title,
    subtitle: info.subtitle,
    authors: info.authors,
    description: info.description,
    publishedYear: info.publishedDate?.slice(0, 4),
    publisher: info.publisher,
    isbn: info.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier,
    pageCount: info.pageCount,
    language: info.language,
    subjects: categories,
    maturityRating: info.maturityRating ?? null,
    averageRating: info.averageRating,
    ratingsCount: info.ratingsCount,
    url: info.infoLink,
    signals,
  };
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}
