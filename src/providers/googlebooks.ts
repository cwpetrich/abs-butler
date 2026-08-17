import { getJson } from './http.js';
import type { BookQuery, MetadataProvider, ProviderResult } from './types.js';

const SEARCH_URL = 'https://www.googleapis.com/books/v1/volumes';

interface GbVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    pageCount?: number;
    categories?: string[];
    maturityRating?: 'NOT_MATURE' | 'MATURE';
    averageRating?: number;
    ratingsCount?: number;
    infoLink?: string;
  };
}

/**
 * Google Books. Works keyless (heavily rate limited) or with GOOGLE_BOOKS_API_KEY.
 * Two things make it worth querying alongside Open Library: BISAC categories
 * ("Juvenile Fiction / Social Themes / Bullying") and an explicit maturityRating.
 */
export class GoogleBooksProvider implements MetadataProvider {
  readonly name = 'googlebooks';

  constructor(private readonly apiKey?: string) {}

  isAvailable(): boolean {
    return true;
  }

  async lookup(query: BookQuery): Promise<ProviderResult | null> {
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
    const volume = data?.items?.[0];
    const info = volume?.volumeInfo;
    if (!info) return null;

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
      provider: this.name,
      providerId: volume?.id,
      title: info.title,
      authors: info.authors,
      description: info.description,
      publishedYear: info.publishedDate?.slice(0, 4),
      publisher: info.publisher,
      isbn: info.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier,
      pageCount: info.pageCount,
      subjects: categories,
      maturityRating: info.maturityRating ?? null,
      averageRating: info.averageRating,
      ratingsCount: info.ratingsCount,
      url: info.infoLink,
      signals,
    };
  }
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}
