/** Contract every external metadata / content-rating source implements. */

export interface BookQuery {
  title: string;
  author?: string | null;
  isbn?: string | null;
  asin?: string | null;
}

/** A single content signal, e.g. "this book is shelved as young adult fiction". */
export interface ContentSignal {
  /** Where it came from, e.g. "openlibrary:subject". */
  source: string;
  /** Raw text of the signal, verbatim from the provider. */
  value: string;
  /** 0..1 — how strongly this source's own labeling should be trusted. */
  weight: number;
}

export interface SeriesRef {
  name: string;
  /** Position within the series, verbatim — "1", "2.5", "Book Two". */
  sequence?: string | undefined;
}

export interface ProviderResult {
  provider: string;
  /** Stable id at the provider, useful for caching and audit trails. */
  providerId?: string;
  title?: string;
  subtitle?: string;
  authors?: string[];
  /** Audiobook-only, and the reason an audiobook source is worth querying at all. */
  narrators?: string[];
  /** The series this edition belongs to, with its position in it. */
  series?: SeriesRef | undefined;
  description?: string;
  publishedYear?: string;
  publisher?: string;
  isbn?: string;
  /** BCP-47-ish code where the provider gives one, e.g. "en". */
  language?: string;
  genres?: string[];
  pageCount?: number;
  /** Subjects, shelves, BISAC categories — the raw material for age banding. */
  subjects?: string[];
  /** Explicit audience labels the provider states outright. */
  audience?: string[];
  /** Provider's own maturity verdict, if it has one. */
  maturityRating?: 'NOT_MATURE' | 'MATURE' | null;
  averageRating?: number;
  ratingsCount?: number;
  url?: string;
  signals: ContentSignal[];
}

export interface MetadataProvider {
  readonly name: string;
  /** False when the provider needs a key that isn't configured. */
  isAvailable(): boolean;
  /**
   * Candidates for this query, in the provider's own relevance order.
   *
   * Providers return every plausible answer rather than picking one: choosing
   * between them needs the query alongside the result, which is scoring's job
   * (see core/matching.ts), not the provider's. Returning only the top hit is
   * what let an unrelated book through whenever it happened to rank first.
   *
   * `signal` belongs to the run, and aborting it must abandon the request
   * rather than finish it quietly: a stopped run that still had a minute of
   * lookups queued would otherwise keep talking to strangers' servers long
   * after the person who started it asked it to stop.
   */
  search(query: BookQuery, signal?: AbortSignal): Promise<ProviderResult[]>;
}
