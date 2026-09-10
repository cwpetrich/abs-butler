import type { AbsLibraryItem } from '../abs/types.js';
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
  { code: 'no-audio', severity: 'error', label: 'No audio tracks', test: (i) => (i.media?.numTracks ?? i.media?.numAudioFiles ?? 0) === 0 },
  { code: 'missing-title', severity: 'error', label: 'No title', test: (i) => isBlank(i.media?.metadata?.title) },
  { code: 'missing-author', severity: 'warn', label: 'No author', test: (i) => isBlank(itemAuthor(i)) },
  { code: 'missing-cover', severity: 'warn', label: 'No cover art', test: (i) => isBlank(i.media?.coverPath) },
  { code: 'unmatched', severity: 'warn', label: 'No ISBN or ASIN (never matched)', test: (i) => isBlank(i.media?.metadata?.isbn) && isBlank(i.media?.metadata?.asin) },
  { code: 'missing-description', severity: 'info', label: 'No description', test: (i) => isBlank(i.media?.metadata?.description) },
  { code: 'missing-year', severity: 'info', label: 'No published year', test: (i) => isBlank(i.media?.metadata?.publishedYear) },
  { code: 'missing-narrator', severity: 'info', label: 'No narrator', test: (i) => isBlank(i.media?.metadata?.narratorName) && (i.media?.metadata?.narrators?.length ?? 0) === 0 },
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

export function auditItems(items: AbsLibraryItem[], only?: string[]): AuditFinding[] {
  const wanted = only && only.length > 0 ? new Set(only) : null;
  const active = (wanted ? ISSUES.filter((spec) => wanted.has(spec.code)) : ISSUES).filter((s) => s.test);

  const findings = new Map<string, AuditFinding>();
  const record = (item: AbsLibraryItem, code: IssueCode) => {
    const existing = findings.get(item.id);
    if (existing) {
      existing.issues.push(code);
      return;
    }
    findings.set(item.id, {
      itemId: item.id,
      title: itemTitle(item),
      author: itemAuthor(item),
      path: item.relPath ?? item.path,
      issues: [code],
    });
  };

  for (const item of items) {
    for (const spec of active) {
      if (spec.test?.(item)) record(item, spec.code);
    }
  }

  if (!wanted || wanted.has('duplicate')) {
    for (const group of findDuplicates(items)) {
      for (const item of group) record(item, 'duplicate');
    }
  }

  return [...findings.values()].sort((a, b) => b.issues.length - a.issues.length);
}

/** Groups items sharing a normalized title+author. Only groups of 2+ are returned. */
export function findDuplicates(items: AbsLibraryItem[]): AbsLibraryItem[][] {
  const buckets = new Map<string, AbsLibraryItem[]>();
  for (const item of items) {
    const title = normalizeTitle(item.media?.metadata?.title);
    if (!title) continue;
    const key = `${title}::${normalizeAuthor(itemAuthor(item))}`;
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
  const findings = auditItems(items, options.only);

  const issueCounts = summarizeFindings(findings);

  log.info(`audited ${items.length} item(s) across ${libraries.length} librar(ies)`);
  if (findings.length === 0) {
    log.success('No issues found.');
  } else {
    // Named on one line rather than as a table, which both the CLI and the web
    // UI already draw from the same counts. Without it the log says only "25
    // items have at least one issue", which reads as an alarm when it is
    // usually one benign check: every book is `unrated` until `rate` has run.
    const breakdown = ISSUES.filter((spec) => issueCounts[spec.code])
      .map((spec) => `${issueCounts[spec.code]} ${spec.code}`)
      .join(', ');
    log.info(`${findings.length} item(s) have at least one issue — ${breakdown}`);
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
    itemsWithIssues: findings.length,
    findings,
  };
}
