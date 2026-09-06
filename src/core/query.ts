import type { AbsLibraryItem } from '../abs/types.js';
import { itemAuthor } from '../context.js';
import type { BookQuery } from '../providers/types.js';
import { normalizePersonName, normalizeTitleText } from '../util/text.js';

/**
 * What abs-butler knows about a book, in the shape providers are asked in.
 *
 * Shared by every task that consults a provider so they all ask the identical
 * question — which is what lets one cached answer serve all of them, and what
 * stops `rate` and `metadata` disagreeing about which book they were looking at.
 */
export function itemQuery(item: AbsLibraryItem): BookQuery {
  const metadata = item.media?.metadata;
  const title = metadata?.title ?? '';
  const author = itemAuthor(item);

  // Asked with the noise taken out, because providers index the book rather
  // than the file: a search for "Dune (Unabridged)" finds nothing at all, while
  // "Dune" finds it immediately. Scoring still compares against the library's
  // own title, so cleaning the question does not loosen the answer.
  return {
    title: normalizeTitleText(title) ?? title,
    author: author ? (normalizePersonName(author) ?? author) : author,
    isbn: metadata?.isbn ?? null,
    asin: metadata?.asin ?? null,
  };
}
