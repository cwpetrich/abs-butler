import { getJson } from './http.js';
import type { BookQuery, MetadataProvider, ProviderResult } from './types.js';

const SEARCH_URL = 'https://openlibrary.org/search.json';

interface OlDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  isbn?: string[];
  number_of_pages_median?: number;
  subject?: string[];
  ratings_average?: number;
  ratings_count?: number;
}

/**
 * Open Library. Free, no key, and its crowd-sourced `subject` list is the single
 * richest audience signal available without scraping — it carries Dewey-style
 * shelving like "Juvenile fiction" and "Young adult fiction" alongside content
 * subjects like "Violence" or "Sexual abuse".
 */
export class OpenLibraryProvider implements MetadataProvider {
  readonly name = 'openlibrary';

  isAvailable(): boolean {
    return true;
  }

  async search(query: BookQuery): Promise<ProviderResult[]> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('limit', '3');
    url.searchParams.set(
      'fields',
      'key,title,author_name,first_publish_year,publisher,isbn,number_of_pages_median,subject,ratings_average,ratings_count',
    );

    if (query.isbn) {
      url.searchParams.set('isbn', query.isbn.replace(/[^0-9Xx]/g, ''));
    } else {
      url.searchParams.set('title', query.title);
      if (query.author) url.searchParams.set('author', query.author);
    }

    const data = await getJson<{ docs?: OlDoc[] }>(url);
    return (data?.docs ?? []).map((doc) => toResult(this.name, doc));
  }
}

function toResult(provider: string, doc: OlDoc): ProviderResult {
  const subjects = doc.subject ?? [];
  return {
    provider,
    providerId: doc.key,
    title: doc.title,
    authors: doc.author_name,
    publishedYear: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
    publisher: doc.publisher?.[0],
    isbn: doc.isbn?.[0],
    pageCount: doc.number_of_pages_median,
    subjects,
    averageRating: doc.ratings_average,
    ratingsCount: doc.ratings_count,
    url: doc.key ? `https://openlibrary.org${doc.key}` : undefined,
    // Cap the subject list: popular titles carry hundreds, and the long tail is noise.
    signals: subjects.slice(0, 80).map((value) => ({
      source: 'openlibrary:subject',
      value,
      weight: 0.7,
    })),
  };
}
