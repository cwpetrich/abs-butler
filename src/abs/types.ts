/**
 * Shapes returned by the AudiobookShelf API, narrowed to the fields abs-butler uses.
 * ABS returns more than this; unknown fields are preserved but untyped.
 * Reference: https://api.audiobookshelf.org
 */

export interface AbsSeriesRef {
  id: string;
  name: string;
  sequence: string | null;
}

export interface AbsAuthorRef {
  id: string;
  name: string;
}

export interface AbsBookMetadata {
  title: string | null;
  titleIgnorePrefix?: string;
  subtitle: string | null;
  authorName?: string | null;
  narratorName?: string | null;
  authors?: AbsAuthorRef[];
  narrators?: string[];
  series?: AbsSeriesRef[];
  seriesName?: string | null;
  genres?: string[];
  publishedYear: string | null;
  publishedDate?: string | null;
  publisher: string | null;
  description: string | null;
  isbn: string | null;
  asin: string | null;
  language: string | null;
  explicit: boolean;
  abridged?: boolean;
}

export interface AbsMedia {
  id: string;
  metadata: AbsBookMetadata;
  coverPath: string | null;
  tags: string[];
  numTracks?: number;
  numAudioFiles?: number;
  duration?: number;
  size?: number;
}

export interface AbsLibraryItem {
  id: string;
  libraryId: string;
  folderId: string;
  path: string;
  relPath: string;
  isFile: boolean;
  mediaType: 'book' | 'podcast';
  isMissing: boolean;
  isInvalid: boolean;
  numFiles?: number;
  size?: number;
  media: AbsMedia;
  addedAt?: number;
  updatedAt?: number;
}

export interface AbsLibraryFolder {
  id: string;
  fullPath: string;
  libraryId: string;
}

export interface AbsLibrary {
  id: string;
  name: string;
  folders: AbsLibraryFolder[];
  mediaType: 'book' | 'podcast';
  provider: string;
}

export interface AbsPage<T> {
  results: T[];
  total: number;
  limit: number;
  page: number;
}

/**
 * Patch body for PATCH /api/items/:id/media. Every field is optional.
 *
 * Authors and series are sent as objects because that is how AudiobookShelf
 * models them — they are records in their own right, not strings on the book —
 * and an entry with no id is created by name. Narrators really are plain
 * strings there.
 */
export interface AbsMediaPatch {
  metadata?: Partial<
    Pick<
      AbsBookMetadata,
      | 'title'
      | 'subtitle'
      | 'description'
      | 'publisher'
      | 'publishedYear'
      | 'isbn'
      | 'asin'
      | 'language'
      | 'explicit'
      | 'genres'
    >
  > & {
    authors?: Array<{ id?: string; name: string }>;
    narrators?: string[];
    series?: Array<{ id?: string; name: string; sequence?: string | null }>;
  };
  tags?: string[];
}
