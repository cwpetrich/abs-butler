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

export interface ProviderResult {
  provider: string;
  /** Stable id at the provider, useful for caching and audit trails. */
  providerId?: string;
  title?: string;
  authors?: string[];
  description?: string;
  publishedYear?: string;
  publisher?: string;
  isbn?: string;
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
  lookup(query: BookQuery): Promise<ProviderResult | null>;
}
