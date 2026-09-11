import type { AbsLibraryItem } from './types.js';

/**
 * What kind of thing a library item actually is.
 *
 * A book library is not only audiobooks — AudiobookShelf holds EPUBs and PDFs
 * in the same libraries — and several decisions turn on the difference: an
 * ebook has no audio and no narrator by its nature, and neither fact is a
 * defect in it.
 *
 * These live here rather than in one of the commands because more than one of
 * them needs the answer, and because the shapes AudiobookShelf reports an
 * ebook in are an API detail rather than a rule about libraries.
 */
export function hasAudio(item: AbsLibraryItem): boolean {
  return (item.media?.numTracks ?? item.media?.numAudioFiles ?? 0) > 0;
}

/** Both shapes: a format string on a minified item, an object on an expanded one. */
export function hasEbook(item: AbsLibraryItem): boolean {
  return Boolean(item.media?.ebookFormat || item.media?.ebookFile);
}

/** A reading copy. An item carrying both is an audiobook with an ebook beside it. */
export function isEbookOnly(item: AbsLibraryItem): boolean {
  return !hasAudio(item) && hasEbook(item);
}
