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

/**
 * One entry of `media.audioFiles` on an expanded item.
 *
 * Only the fields abs-butler reads are named, but the rest are kept rather than
 * discarded: a repair records these objects whole, so a revert can hand them
 * back to AudiobookShelf exactly as they were.
 */
export interface AbsAudioFile {
  index: number;
  ino: string;
  duration: number;
  exclude?: boolean;
  metadata: { filename: string; path: string; relPath: string; size: number; ext?: string };
  [key: string]: unknown;
}

export interface AbsChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

/**
 * One entry of `libraryFiles` on an expanded item — the files AudiobookShelf
 * found on disk at the last scan. `/api/items/:id/file/:ino` resolves against
 * these, which is what makes an audio record whose inode is not among them
 * unplayable.
 */
export interface AbsLibraryFile {
  ino: string;
  fileType?: string;
  metadata: { filename: string; path: string; relPath: string; size: number };
}

export interface AbsMedia {
  id: string;
  metadata: AbsBookMetadata;
  coverPath: string | null;
  tags: string[];
  /** Expanded items only. */
  audioFiles?: AbsAudioFile[];
  /** Expanded items only. */
  chapters?: AbsChapter[];
  numTracks?: number;
  numAudioFiles?: number;
  /**
   * Set when the book has an ebook file. AudiobookShelf reports this in two
   * shapes — a format string on the minified item a library listing returns,
   * an object on the expanded one — and both are read, so a caller does not
   * have to know which listing it is holding.
   */
  ebookFormat?: string | null;
  ebookFile?: { ino?: string; ebookFormat?: string } | null;
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
  /** Expanded items only. */
  libraryFiles?: AbsLibraryFile[];
  addedAt?: number;
  updatedAt?: number;
}

/** A saved listening position, as `/api/users/:id` returns it. */
export interface AbsMediaProgress {
  libraryItemId: string;
  episodeId?: string | null;
  duration: number;
  currentTime: number;
  isFinished: boolean;
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
  /**
   * The whole track list and chapter list, replaced wholesale.
   *
   * ABS marks this part of the endpoint for removal, so it is used only where
   * nothing else will do: by `revert`, to put back exactly the lists a `repair`
   * changed, and by a repair's last resort, which empties the track list of a
   * one-file book so a rescan rebuilds it. Accepted by 2.32 to 2.36.
   */
  audioFiles?: AbsAudioFile[];
  chapters?: AbsChapter[];
}
