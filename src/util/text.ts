/** Normalization helpers shared by dedupe, matching, and path building. */

const LEADING_ARTICLE = /^(the|a|an)\s+/i;
/**
 * Sort-friendly titles put the article last ("Hobbit, The"), which is how most
 * taggers and many ABS libraries store them. Both forms must normalize alike or
 * duplicate detection misses the most common kind of duplicate there is.
 */
const TRAILING_ARTICLE = /\s+(the|a|an)$/i;

/** Lowercase, strip punctuation and articles — for comparing titles across sources. */
export function normalizeTitle(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(unabridged|abridged|audiobook)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_ARTICLE, '')
    .replace(TRAILING_ARTICLE, '')
    .trim();
}

/** "King, Stephen" and "Stephen King" both normalize to "stephen king". */
export function normalizeAuthor(value: string | null | undefined): string {
  if (!value) return '';
  const first = value.split(/\s*[,&;]\s*|\s+and\s+/i).filter(Boolean);
  const primary = value.includes(',') && first.length >= 2 ? `${first[1]} ${first[0]}` : first[0] ?? value;
  return normalizeTitle(primary);
}

/**
 * Filesystem-safe segment: no separators, no reserved characters, no trailing
 * dots — and one spelling of every apostrophe.
 *
 * Audible writes `Stalin’s War` with a curly apostrophe and people type folder
 * names with a straight one. The two look alike in every listing, so a library
 * holding both forms cannot be told apart by eye. The straight one wins because
 * it is the one anyone can type in a shell.
 */
export function sanitizePathSegment(value: string, options: { maxLength?: number } = {}): string {
  const max = options.maxLength ?? 120;
  const cleaned = value
    .normalize('NFC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned) || 'Unknown';
}

/** Pads a series sequence so "2" sorts before "10". Non-numeric sequences pass through. */
export function padSequence(sequence: string | null | undefined, width = 2): string {
  if (!sequence) return '';
  const match = /^(\d+)(\.\d+)?$/.exec(sequence.trim());
  if (!match) return sequence.trim();
  return match[1]!.padStart(width, '0') + (match[2] ?? '');
}

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}

export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/** Format markers that describe the file, not the book. */
const EDITION_NOISE =
  /\s*[([]\s*(unabridged|abridged|audiobook|audio\s?book|audio\s?edition|dramatized(\s+adaptation)?)\s*[)\]]/gi;

/**
 * A trailing series position, which Audible appends to almost every title it
 * sells: "Harry Potter and the Sorcerer's Stone, Book 1".
 *
 * Left in place it makes the provider tier actively harmful — it would replace
 * a correct title with one carrying a number the series field already holds,
 * and every book in a series would end up with its position written twice.
 * Restricted to a bare digit so a real title is never truncated.
 */
const TRAILING_SERIES_POSITION = /,\s*(book|bk\.?|volume|vol\.?)\s*\d+(\.\d+)?\s*$/i;

const TRAILING_ARTICLE_FORM = /^(.+),\s*(the|a|an)$/i;

/**
 * Restores an article moved to the end for sorting: "Hobbit, The" reads as
 * "The Hobbit" everywhere except a card catalogue, and AudiobookShelf sorts on
 * `titleIgnorePrefix` by itself, so nothing is lost by writing it naturally.
 */
export function normalizeTitleText(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  let next = value!.replace(EDITION_NOISE, '').replace(TRAILING_SERIES_POSITION, '');
  next = next.replace(/\s+/g, ' ').replace(/\s+([,:;])/g, '$1').trim();

  const inverted = TRAILING_ARTICLE_FORM.exec(next);
  if (inverted) {
    const article = inverted[2]!.toLowerCase();
    next = `${article.charAt(0).toUpperCase()}${article.slice(1)} ${inverted[1]!.trim()}`;
  }

  next = next.replace(/\s+/g, ' ').trim();
  return next && next !== value ? next : null;
}

/**
 * A series reference appended to an author name, which some taggers write as
 * "L'amour, Louis - Sackett's 10". The name is the author; the rest belongs in
 * the series field, and while it sits here it keeps one writer from grouping
 * with themselves — five books on one real server, each its own Louis L'Amour.
 */
const AUTHOR_SERIES_SUFFIX = /\s+-\s+\S.*?\s*\d+\s*$/;

export function stripSeriesReference(value: string): string {
  const stripped = value.replace(AUTHOR_SERIES_SUFFIX, '').trim();
  // Never let it consume the name outright.
  return stripped === '' ? value : stripped;
}

/**
 * A credit role appended to a name, which Audible writes into the author list
 * itself: "Susan Trott, Libby Spurrier - adaptor", "Larry Correia - foreword".
 *
 * AudiobookShelf has no field for the role, so it arrives as part of the person
 * — a separate author called "Libby Spurrier - adaptor", and a folder named
 * after them. Only a known role word qualifies, so a hyphenated name or a
 * title-like suffix is never touched.
 */
const CREDIT_ROLE =
  /\s+[-–]\s+(adaptor|adapter|adaptation|afterword|annotator|compiler|contributor|editor|editors|epilogue|foreword|illustrator|introduction|narrator|preface|prologue|translator|translation)\s*(?=,|$)/gi;

/** Removes credit roles from a name, or from each name in a flattened list. */
export function stripCreditRoles(value: string): string {
  const stripped = value.replace(CREDIT_ROLE, '').trim();
  return stripped === '' ? value : stripped;
}

/**
 * The form two paths are compared in when deciding whether a book has to move.
 *
 * Only Unicode composition is ignored. macOS and SMB shares rewrite an accented
 * name between its composed and decomposed forms underneath a folder, so a move
 * made to fix it would be undone by the filesystem and planned again next run.
 */
export function pathComparisonKey(value: string): string {
  return value.normalize('NFC');
}

/** Name suffixes that follow a comma and must not be read as an inversion. */
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|phd|md|esq)\.?$/i;

/**
 * "King, Stephen" → "Stephen King".
 *
 * Only a single comma qualifies, and only when the tail is not a suffix — "Doe,
 * Jr." is one name written correctly, and "Pratchett, Terry and Gaiman, Neil"
 * is two names this must not touch, since which comma inverts is genuinely
 * ambiguous there.
 */
export function normalizePersonName(value: string | null | undefined): string | null {
  if (isBlank(value)) return null;
  const trimmed = stripCreditRoles(stripSeriesReference(value!.replace(/\s+/g, ' ').trim()));

  const parts = trimmed.split(',');
  if (parts.length !== 2) return trimmed !== value ? trimmed : null;

  const [last, first] = parts.map((p) => p.trim()) as [string, string];
  if (!last || !first || NAME_SUFFIX.test(first)) return trimmed !== value ? trimmed : null;

  // Only a shape that actually looks inverted: one word on the left, at most
  // two on the right. "L'amour, Louis" is a surname and a given name;
  // "William Strauss, Neil Howe" is two people who happen to share a record,
  // and swapping its halves would fuse them into one person that never existed.
  // AudiobookShelf replaces the author list with whatever it is sent, so that
  // is not a cosmetic error — it is a co-author deleted.
  const leftWords = last.split(/\s+/).filter(Boolean).length;
  const rightWords = first.split(/\s+/).filter(Boolean).length;
  if (leftWords !== 1 || rightWords > 2) return trimmed !== value ? trimmed : null;

  const next = `${first} ${last}`;
  return next !== value ? next : null;
}
