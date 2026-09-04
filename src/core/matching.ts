import type { BookQuery, ProviderResult } from '../providers/types.js';
import { normalizeAuthor, normalizeTitle } from '../util/text.js';

/**
 * How confident abs-butler is that a provider result describes the book in hand.
 *
 * Every provider returns *something* for almost every query — a search for a
 * book it has never heard of still comes back with the nearest thing on the
 * shelf. Taking the first result and trusting it is fine while only blank
 * descriptions get written, and completely unsafe once titles and series names
 * do: a bad match no longer adds noise, it renames a book someone can see.
 *
 * So a match is scored, and what a caller is allowed to write depends on how
 * that score was earned. An identifier match is a different kind of evidence
 * from "the titles look similar", and the two must not be interchangeable.
 */
export type MatchBasis = 'asin' | 'isbn' | 'fuzzy';

export interface MatchScore {
  score: number;
  basis: MatchBasis;
  /** Human-readable justification, surfaced in dry-run output. */
  reasons: string[];
}

export interface Candidate {
  result: ProviderResult;
  match: MatchScore;
}

/**
 * Enough to fill a blank description or publisher — a wrong answer here is
 * noise in a field that was empty anyway, and the titles still had to agree.
 */
export const MATCH_MIN_FILL = 0.5;

/**
 * Required before overwriting something a person can see: title, author,
 * narrator, series. In practice only an ASIN or ISBN match clears this, which
 * is the intent — a fuzzy title match is not evidence enough to rename a book.
 */
export const MATCH_MIN_REWRITE = 0.9;

/** A fuzzy match cannot reach MATCH_MIN_REWRITE no matter how well it scores. */
const FUZZY_CEILING = 0.85;

/** Below this the titles are simply different books. */
const TITLE_FLOOR = 0.6;

function tokens(value: string): Set<string> {
  return new Set(value.split(' ').filter(Boolean));
}

/**
 * Dice coefficient over title words, which handles the ways the same book is
 * written down differently — a missing subtitle, a trailing "Book 1", an
 * article moved to the front — without matching two unrelated titles that
 * happen to share a prefix.
 *
 * This replaces a `startsWith` test in either direction, under which "The
 * Hobbit" matched "The Hobbit and the Lord of the Rings Collection".
 */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = tokens(normalizeTitle(a));
  const right = tokens(normalizeTitle(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export type AuthorAgreement = 'exact' | 'surname' | 'none' | 'unknown';

/**
 * Compares the library's author against every author the provider lists.
 *
 * `unknown` — no local author to compare — is deliberately not the same as
 * `none`. One says the check could not run, the other says it ran and failed,
 * and only the second is grounds for rejecting a candidate outright.
 */
export function compareAuthors(local: string | null | undefined, remote: string[] | undefined): AuthorAgreement {
  const mine = normalizeAuthor(local);
  if (!mine) return 'unknown';

  const theirs = (remote ?? []).map(normalizeAuthor).filter(Boolean);
  if (theirs.length === 0) return 'unknown';

  if (theirs.includes(mine)) return 'exact';

  // Surnames carry the identity: "J.R.R. Tolkien" and "John Ronald Reuel
  // Tolkien" are one person, and initials never survive normalization intact.
  const surname = mine.split(' ').at(-1);
  if (surname && surname.length > 2 && theirs.some((t) => t.split(' ').at(-1) === surname)) {
    return 'surname';
  }
  return 'none';
}

/** ISBNs differ only in punctuation between sources; the X check digit is real. */
function isbnDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** ASINs are alphanumeric, so they must not be run through the ISBN cleaner. */
function asinKey(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * Scores one candidate. A score of 0 means "reject" — the caller should not use
 * this result for anything, at any confidence.
 */
export function scoreCandidate(query: BookQuery, result: ProviderResult): MatchScore {
  const reasons: string[] = [];

  // An ASIN identifies one audio edition. Nothing else needs checking, and
  // nothing else can beat it.
  const asin = asinKey(query.asin);
  if (asin && result.providerId && asinKey(result.providerId) === asin) {
    return { score: 1, basis: 'asin', reasons: [`ASIN ${query.asin} matched exactly`] };
  }

  const isbn = isbnDigits(query.isbn);
  if (isbn && result.isbn && isbnDigits(result.isbn) === isbn) {
    return { score: 0.97, basis: 'isbn', reasons: [`ISBN ${query.isbn} matched exactly`] };
  }

  const similarity = titleSimilarity(query.title, result.title);
  if (similarity < TITLE_FLOOR) {
    return {
      score: 0,
      basis: 'fuzzy',
      reasons: [`title "${result.title ?? ''}" does not match "${query.title}"`],
    };
  }
  reasons.push(`title ${Math.round(similarity * 100)}% similar`);

  const agreement = compareAuthors(query.author, result.authors);
  if (agreement === 'none') {
    return {
      score: 0,
      basis: 'fuzzy',
      reasons: [`author "${(result.authors ?? []).join(', ')}" does not match "${query.author}"`],
    };
  }

  // `unknown` scores below an agreeing author rather than rejecting: plenty of
  // libraries have books with no author set, and those are exactly the ones
  // most in need of filling in. It just cannot earn a high-confidence write.
  const authorScore = agreement === 'exact' ? 1 : agreement === 'surname' ? 0.8 : 0.4;
  reasons.push(
    agreement === 'unknown' ? 'author could not be compared' : `author agreed (${agreement})`,
  );

  const score = Math.min(FUZZY_CEILING, 0.55 * similarity + 0.45 * authorScore);
  return { score: round(score), basis: 'fuzzy', reasons };
}

/**
 * Picks the best-scoring candidate a provider returned, or null when none is
 * usable. Ties keep the provider's own ordering, which is its relevance rank.
 */
export function pickBest(
  query: BookQuery,
  results: ProviderResult[],
  options: { minScore?: number } = {},
): Candidate | null {
  const min = options.minScore ?? MATCH_MIN_FILL;
  let best: Candidate | null = null;

  for (const result of results) {
    const match = scoreCandidate(query, result);
    if (match.score < min) continue;
    if (!best || match.score > best.match.score) best = { result, match };
  }
  return best;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
