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

/** Filesystem-safe segment: no separators, no reserved characters, no trailing dots. */
export function sanitizePathSegment(value: string, options: { maxLength?: number } = {}): string {
  const max = options.maxLength ?? 120;
  const cleaned = value
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
