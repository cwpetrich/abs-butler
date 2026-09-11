import type { AbsLibraryItem } from '../abs/types.js';
import { hasAudio, hasEbook, isEbookOnly } from '../abs/media.js';
import { TAG_PREFIX } from '../content/ageRating.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import { recordFindings } from '../db/findings.js';
import { log } from '../logger.js';
import { isBlank, normalizeAuthor, normalizeTitle } from '../util/text.js';

export type IssueCode =
  | 'missing-title'
  | 'missing-author'
  | 'missing-cover'
  | 'missing-description'
  | 'missing-year'
  | 'missing-narrator'
  | 'unmatched'
  | 'no-audio'
  | 'missing-on-disk'
  | 'invalid'
  | 'unrated'
  | 'duplicate';

export interface IssueSpec {
  code: IssueCode;
  severity: 'error' | 'warn' | 'info';
  label: string;
  /** Per-item test. Duplicates are detected separately, across the whole set. */
  test?: (item: AbsLibraryItem) => boolean;
}

export const ISSUES: IssueSpec[] = [
  { code: 'missing-on-disk', severity: 'error', label: 'Files missing on disk', test: (i) => i.isMissing === true },
  { code: 'invalid', severity: 'error', label: 'Marked invalid by ABS', test: (i) => i.isInvalid === true },
  // An item with no audio *and* no ebook is empty, which is a real fault: the
  // import produced a record with nothing in it. One with an ebook is a
  // reading copy and is working exactly as intended.
  { code: 'no-audio', severity: 'error', label: 'No audio or ebook files', test: (i) => !hasAudio(i) && !hasEbook(i) },
  { code: 'missing-title', severity: 'error', label: 'No title', test: (i) => isBlank(i.media?.metadata?.title) },
  { code: 'missing-author', severity: 'warn', label: 'No author', test: (i) => isBlank(itemAuthor(i)) },
  { code: 'missing-cover', severity: 'warn', label: 'No cover art', test: (i) => isBlank(i.media?.coverPath) },
  { code: 'unmatched', severity: 'warn', label: 'No ISBN or ASIN (never matched)', test: (i) => isBlank(i.media?.metadata?.isbn) && isBlank(i.media?.metadata?.asin) },
  { code: 'missing-description', severity: 'info', label: 'No description', test: (i) => isBlank(i.media?.metadata?.description) },
  { code: 'missing-year', severity: 'info', label: 'No published year', test: (i) => isBlank(i.media?.metadata?.publishedYear) },
  // Not asked of a reading copy, which has no narrator to be missing. An item
  // holding both an audiobook and an ebook is still asked.
  { code: 'missing-narrator', severity: 'info', label: 'No narrator', test: (i) => !isEbookOnly(i) && isBlank(i.media?.metadata?.narratorName) && (i.media?.metadata?.narrators?.length ?? 0) === 0 },
  { code: 'unrated', severity: 'info', label: 'No age rating from abs-butler', test: (i) => !(i.media?.tags ?? []).includes(TAG_PREFIX.marker) },
  { code: 'duplicate', severity: 'warn', label: 'Possible duplicates' },
];

export const AUDIT_CODES = ISSUES.map((i) => i.code);

export interface AuditFinding {
  itemId: string;
  title: string;
  author: string | null;
  path: string;
  issues: IssueCode[];
}

/**
 * Every audited item, with the issues found on it — an empty list meaning the
 * item passed every check.
 *
 * Clean items are included rather than omitted, so an audit is a report on the
 * library rather than a list of complaints about part of it. "Which books did
 * you look at" and "which books are fine" are both questions an audit should
 * answer, and a book silently absent from the output is indistinguishable from
 * one that was never scanned.
 *
 * Sorted worst-first, so the items wanting attention lead and the clean ones
 * trail.
 */
export function auditItems(
  items: AbsLibraryItem[],
  only?: string[],
  crossFormat?: boolean,
): AuditFinding[] {
  const wanted = only && only.length > 0 ? new Set(only) : null;
  const active = (wanted ? ISSUES.filter((spec) => wanted.has(spec.code)) : ISSUES).filter((s) => s.test);

  const findings = new Map<string, AuditFinding>(
    items.map((item) => [
      item.id,
      {
        itemId: item.id,
        title: itemTitle(item),
        author: itemAuthor(item),
        path: item.relPath ?? item.path,
        issues: [] as IssueCode[],
      },
    ]),
  );
  const record = (item: AbsLibraryItem, code: IssueCode) => {
    findings.get(item.id)?.issues.push(code);
  };

  for (const item of items) {
    for (const spec of active) {
      if (spec.test?.(item)) record(item, spec.code);
    }
  }

  if (!wanted || wanted.has('duplicate')) {
    for (const group of findDuplicates(items, { crossFormat })) {
      for (const item of group) record(item, 'duplicate');
    }
  }

  return [...findings.values()].sort((a, b) => b.issues.length - a.issues.length);
}

/**
 * Groups items sharing a normalized title+author. Only groups of 2+ are
 * returned.
 *
 * Format is part of the key by default, so the audiobook and the EPUB of the
 * same book are not reported against each other. They are not duplicates —
 * they are one book in two formats, and a great many libraries deliberately
 * hold both. `duplicate` is a warning someone acts on, sometimes by deleting
 * something, so a pair that is obviously fine should not be in a list of
 * things to review at all.
 *
 * `crossFormat` puts them back for anyone who does want to see them. Two copies
 * of the *same* format are reported either way, which is the case worth
 * catching: the same EPUB imported twice under different folder names.
 */
export function findDuplicates(
  items: AbsLibraryItem[],
  options: { crossFormat?: boolean } = {},
): AbsLibraryItem[][] {
  const buckets = new Map<string, AbsLibraryItem[]>();
  for (const item of items) {
    const title = normalizeTitle(item.media?.metadata?.title);
    if (!title) continue;
    const format = options.crossFormat ? '' : `::${isEbookOnly(item) ? 'ebook' : 'audio'}`;
    const key = `${title}::${normalizeAuthor(itemAuthor(item))}${format}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets.values()].filter((group) => group.length > 1);
}

export function summarizeFindings(findings: AuditFinding[]): Partial<Record<IssueCode, number>> {
  const counts: Partial<Record<IssueCode, number>> = {};
  for (const finding of findings) {
    for (const code of finding.issues) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

export interface AuditTaskOptions {
  library?: string;
  only?: string[];
  limit?: number;
  /**
   * Report an audiobook and an ebook of the same book as possible duplicates.
   * Off unless asked for; see findDuplicates.
   */
  crossFormatDuplicates?: boolean;
}

export interface AuditTaskResult {
  scanned: number;
  libraries: Array<{ id: string; name: string }>;
  issueCounts: Partial<Record<IssueCode, number>>;
  itemsWithIssues: number;
  findings: AuditFinding[];
}

export async function runAuditTask(
  ctx: TaskContext,
  options: AuditTaskOptions = {},
): Promise<AuditTaskResult> {
  const libraries = await resolveLibraries(ctx, options.library);
  const items = await collectItems(ctx, libraries, { limit: options.limit });
  const findings = auditItems(
    items,
    options.only,
    options.crossFormatDuplicates ?? ctx.settings.crossFormatDuplicates,
  );
  const affected = findings.filter((finding) => finding.issues.length > 0);

  const issueCounts = summarizeFindings(findings);

  log.info(`audited ${items.length} item(s) across ${libraries.length} librar(ies)`);
  if (affected.length === 0) {
    log.success(`No issues found — all ${items.length} item(s) passed every check.`);
  } else {
    // Named on one line rather than as a table, which both the CLI and the web
    // UI already draw from the same counts. Without it the log says only "25
    // items have at least one issue", which reads as an alarm when it is
    // usually one benign check: every book is `unrated` until `rate` has run.
    const breakdown = ISSUES.filter((spec) => issueCounts[spec.code])
      .map((spec) => `${issueCounts[spec.code]} ${spec.code}`)
      .join(', ');
    log.info(
      `${affected.length} of ${items.length} item(s) have at least one issue — ${breakdown}` +
        `; ${items.length - affected.length} passed`,
    );
  }

  // Kept for the run, so the web UI can show which books and why rather than
  // only how many. Absent on a context with no run — nothing owns the rows.
  if (ctx.runId !== undefined) {
    recordFindings(ctx.db, ctx.runId, findings);
  }

  return {
    scanned: items.length,
    libraries: libraries.map((l) => ({ id: l.id, name: l.name })),
    issueCounts,
    itemsWithIssues: affected.length,
    findings,
  };
}
