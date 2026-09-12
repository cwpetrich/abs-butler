import type { AbsLibraryItem } from '../abs/types.js';
import {
  assessContent,
  assessmentToTags,
  isButlerTag,
  AGE_BANDS,
  TAG_PREFIX,
  BAND_MIN_AGE,
  type AgeBand,
  type ContentAssessment,
} from '../content/ageRating.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import { log } from '../logger.js';
import { mapLimitPartial } from '../providers/http.js';
import { lookupItem, lookupDepsFor, type LookupDeps } from './lookup.js';
import type { RunItemInput } from '../db/runItems.js';
import { breakdown, itemIdentity, itemPath, plural, reportItems } from './report.js';
import { itemQuery } from './query.js';
import { applyPatch } from './revisions.js';

export interface RatingResult {
  itemId: string;
  title: string;
  author: string | null;
  assessment: ContentAssessment;
  currentTags: string[];
  proposedTags: string[];
  changed: boolean;
}

/** Looks a single item up across all providers and merges the signals. */
export async function rateItem(
  item: AbsLibraryItem,
  deps: LookupDeps,
  options: { minConfidence?: number } = {},
): Promise<RatingResult> {
  // Only results that actually matched this book feed the assessment. Taking
  // whatever a provider ranked first meant an unrelated book's shelving could
  // set the age band, which is the failure mode least likely to be noticed:
  // the tag looks perfectly plausible.
  const { results } = await lookupItem(deps, itemQuery(item));
  const assessment = assessContent(results);

  // ABS's own explicit flag is authoritative when set — it beats any inference.
  const metadata = item.media?.metadata;
  if (metadata?.explicit) {
    assessment.band = 'adult';
    assessment.confidence = Math.max(assessment.confidence, 0.9);
    assessment.evidence.unshift('audiobookshelf: explicit flag set');
  }

  const currentTags = item.media?.tags ?? [];
  const preserved = currentTags.filter((tag) => !isButlerTag(tag));
  const generated = assessmentToTags(assessment, { minConfidence: options.minConfidence });
  const proposedTags = [...preserved, ...generated];

  return {
    itemId: item.id,
    title: itemTitle(item),
    author: itemAuthor(item),
    assessment,
    currentTags,
    proposedTags,
    changed: !sameSet(currentTags, proposedTags),
  };
}

export interface RateTaskOptions {
  library?: string;
  apply?: boolean;
  limit?: number;
  providers?: string[];
  minConfidence?: number;
  force?: boolean;
  maxAge?: number;
}

export interface RateTaskResult {
  rated: number;
  skippedAlreadyRated: number;
  tagged: number;
  wouldTag: number;
  /** Rated, and the tags it already carries say the same thing. */
  unchanged: number;
  applied: boolean;
  bandCounts: Record<string, number>;
  /** How many books each content flag was raised on. */
  flagCounts: Record<string, number>;
  unknownBand: number;
  /** True when the run was stopped before it reached every item. */
  stopped: boolean;
  /** Items it never got to, because it was stopped. */
  notReached: number;
  /**
   * Books where a band was worked out but nothing was confident enough to tag.
   * Worth naming: the run reads as having done nothing to them, when what it
   * did was decline to guess.
   */
  belowConfidence: number;
  results: RatingResult[];
  /**
   * Exactly what was recorded against the run, one row per book. Returned as
   * well as stored so that `--details` on the CLI and the run's page in the web
   * UI show the same words rather than two renderings that drift apart.
   */
  report: RunItemInput[];
}

/** The tags this rating adds and removes, which is the whole of what it changes. */
export function tagDelta(result: RatingResult): { added: string[]; removed: string[] } {
  return {
    added: result.proposedTags.filter((tag) => !result.currentTags.includes(tag)),
    removed: result.currentTags.filter((tag) => !result.proposedTags.includes(tag)),
  };
}

/**
 * What the run has to say about one book, change first: what it would write to
 * AudiobookShelf, then the verdict behind it, then who said so.
 *
 * The change leads because that is the question a dry run exists to answer.
 * "adult — confidence 0.82" is the reasoning, and reasoning belongs second: a
 * reader scanning the list wants to know what is about to happen to the book
 * before they want to know why it is about to happen.
 *
 * And it is written in the conditional until it is true. A dry run saying "Tags
 * added" is describing something it has not done.
 */
function ratingDetail(result: RatingResult, applied: boolean): string[] {
  const { assessment } = result;
  const { added, removed } = tagDelta(result);
  const lines: string[] = [];

  if (added.length > 0) lines.push(`${applied ? 'Added' : 'Would add'}: ${added.join(', ')}`);
  if (removed.length > 0) {
    lines.push(`${applied ? 'Removed' : 'Would remove'}: ${removed.join(', ')}`);
  }
  if (added.length === 0 && removed.length === 0) {
    lines.push('No tag change — it already says exactly this');
  }

  lines.push(
    assessment.band === 'unknown'
      ? 'No usable audience signal'
      : `${assessment.band} — confidence ${assessment.confidence.toFixed(2)}`,
  );

  if (assessment.flags.length > 0) {
    lines.push(
      `Flags: ${assessment.flags.map((f) => `${f.flag} (${f.confidence.toFixed(2)})`).join(', ')}`,
    );
  }

  if (assessment.sources.length > 0) {
    lines.push(`Asked: ${[...new Set(assessment.sources)].join(', ')}`);
  }
  // Truncated, not dropped: the first few signals are the ones that decided it,
  // and twenty lines of evidence per book would bury the table it sits in.
  for (const line of assessment.evidence.slice(0, 3)) lines.push(line);
  if (assessment.evidence.length > 3) {
    lines.push(`…and ${assessment.evidence.length - 3} more signal(s)`);
  }
  return lines;
}

/** True when a band was worked out but no `age:` tag cleared `minConfidence`. */
function isBelowConfidence(result: RatingResult): boolean {
  return (
    result.assessment.band !== 'unknown' &&
    !result.proposedTags.some((tag) => tag.startsWith(TAG_PREFIX.age))
  );
}

/**
 * Filterable facets, in the vocabulary of the tags themselves: the age band,
 * every content flag raised, and the two states someone goes looking for —
 * a book nothing could be said about, and one where the answer was known but
 * not confidently enough to write down.
 */
function ratingCodes(result: RatingResult): string[] {
  const codes: string[] = [result.assessment.band, ...result.assessment.flags.map((f) => f.flag)];
  if (isBelowConfidence(result)) codes.push('below-confidence');
  return codes;
}

export async function runRateTask(
  ctx: TaskContext,
  options: RateTaskOptions = {},
): Promise<RateTaskResult> {
  const deps = lookupDepsFor(ctx, options.providers);

  const libraries = await resolveLibraries(ctx, options.library);
  const all = await collectItems(ctx, libraries, { limit: options.limit });
  const items = options.force ? all : all.filter((i) => !(i.media?.tags ?? []).some(isButlerTag));
  // By id rather than by identity: a library is thousands of items, and a
  // linear scan per item would make the skip list cost more than the ratings.
  const rating = new Set(items.map((item) => item.id));
  const passedOver = options.force ? [] : all.filter((item) => !rating.has(item.id));
  const skipped = passedOver.length;

  // Recorded even though nothing was done to them, and saying which rating they
  // already carry. A book left out of the report is indistinguishable from one
  // the run never reached, and "why was this one left alone" is the question a
  // skip creates.
  const skippedRows: RunItemInput[] = passedOver.map((item) => {
    const existing = (item.media?.tags ?? []).filter(isButlerTag);
    return {
      ...itemIdentity(item),
      status: 'skipped' as const,
      codes: ['already-rated'],
      detail: [
        'Already carries an abs-butler rating — re-run with force to rate it again',
        existing.length > 0 ? `Current tags: ${existing.join(', ')}` : 'Current tags: the marker only',
      ],
    };
  });

  if (items.length === 0) {
    // Told apart, because "there is nothing here" and "there is nothing left to
    // do here" are different answers and the second one used to cover both.
    if (all.length === 0) log.warn('No items to rate — the library came back empty.');
    else {
      log.success(
        `Every item already has an abs-butler rating (${plural(skipped, 'item')}). Use force to re-rate.`,
      );
    }
    reportItems(ctx, skippedRows);
    return {
      rated: 0,
      skippedAlreadyRated: skipped,
      tagged: 0,
      wouldTag: 0,
      unchanged: 0,
      applied: Boolean(options.apply),
      bandCounts: {},
      flagCounts: {},
      unknownBand: 0,
      belowConfidence: 0,
      stopped: false,
      notReached: 0,
      results: [],
      report: skippedRows,
    };
  }

  log.info(
    `rating ${plural(items.length, 'item')}${options.force ? '' : ' without an existing rating'}` +
      `${skipped > 0 ? `, skipping ${skipped} already rated` : ''}…`,
  );

  // A rating carries no path — it is about the book, not the files — and the
  // report wants one, so it is taken from the item it came from.
  const byPath = new Map(all.map((item) => [item.id, itemPath(item)]));

  const minConfidence = options.minConfidence ?? ctx.settings.minConfidence;
  let done = 0;
  // Partial on purpose: a run stopped at book 300 has reached a verdict on 300
  // books, and those verdicts are worth keeping even though the rest never ran.
  const ratings = await mapLimitPartial(
    items,
    ctx.settings.providerConcurrency,
    async (item) => {
      const result = await rateItem(item, deps, { minConfidence });
      done += 1;
      if (done % 25 === 0) log.info(`  ${done}/${items.length}`);
      return result;
    },
    { signal: ctx.signal },
  );
  const results = ratings.results;
  if (ratings.stopped) {
    log.warn(
      `stopped after rating ${results.length} of ${items.length} item(s) — ` +
        `${ratings.unreached} were not reached.`,
    );
  }

  const bandCounts: Record<string, number> = {};
  const flagCounts: Record<string, number> = {};
  for (const result of results) {
    const band = result.assessment.band;
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
    for (const flag of result.assessment.flags) {
      flagCounts[flag.flag] = (flagCounts[flag.flag] ?? 0) + 1;
    }
  }
  const unknownBand = bandCounts.unknown ?? 0;
  const belowConfidence = results.filter(isBelowConfidence).length;

  // What the run decided, on one line each. Without them the log says only how
  // many books were tagged, which is the least interesting thing about a
  // command whose entire job is to reach a verdict on each one.
  log.info(`bands — ${breakdown(bandCounts, [...AGE_BANDS, 'unknown'])}`);
  if (Object.keys(flagCounts).length > 0) {
    log.info(`content flags — ${breakdown(flagCounts)}`);
  }
  if (unknownBand > 0) {
    log.warn(`${plural(unknownBand, 'item')} had no usable audience signal and were left untagged`);
  }
  if (belowConfidence > 0) {
    log.warn(
      `${plural(belowConfidence, 'item')} had a band below the ${minConfidence.toFixed(2)} ` +
        'confidence floor — tagged as rated, but with no age tag',
    );
  }

  const changes = results.filter((r) => r.changed);
  const unchanged = results.length - changes.length;
  // Which books were actually written to, so the report can tell a tag that was
  // applied from one that was only ever going to be.
  const written = new Set<string>();
  let tagged = 0;
  if (options.apply) {
    const byId = new Map(all.map((item) => [item.id, item]));
    for (const change of changes) {
      // Between whole items, and an ending rather than a failure: the books
      // already tagged stay tagged, this run's undo record covers exactly them,
      // and the report below says which ones never got their turn.
      if (ctx.signal?.aborted) {
        log.warn(`stopped after writing ${tagged} of ${changes.length} — the rest were left alone.`);
        break;
      }
      await applyPatch(ctx, byId.get(change.itemId)!, { tags: change.proposedTags });
      written.add(change.itemId);
      tagged += 1;
      if (tagged % 25 === 0) log.info(`  wrote ${tagged}/${changes.length}`);
    }
    log.success(
      `Tagged ${plural(tagged, 'item')} of ${results.length} rated` +
        `; ${unchanged} already said the same thing${skipped > 0 ? `, ${skipped} skipped as already rated` : ''}.`,
    );
  } else {
    log.info(
      `${plural(changes.length, 'item')} would be tagged` +
        `; ${unchanged} already say the same thing${skipped > 0 ? `, ${skipped} skipped as already rated` : ''}. ` +
        'Apply to write to AudiobookShelf.',
    );
  }

  // Every book the run looked at, with the verdict and the evidence for it.
  const report: RunItemInput[] = [
    ...results.map((result) => ({
      itemId: result.itemId,
      title: result.title,
      author: result.author,
      path: byPath.get(result.itemId) ?? '',
      status: result.changed ? ('action' as const) : ('clean' as const),
      codes: [
        ...ratingCodes(result),
        // Named so it can be filtered on: after a stopped apply, "which books
        // did it decide on but never get to write?" is the first question.
        ...(options.apply && result.changed && !written.has(result.itemId) ? ['not-written'] : []),
      ],
      detail: [
        ...ratingDetail(result, written.has(result.itemId)),
        ...(options.apply && result.changed && !written.has(result.itemId)
          ? ['The run was stopped before this was written']
          : []),
      ],
      // The delta rather than the finished tag list, so applying it later adds
      // and removes exactly what this run decided and leaves a tag somebody
      // added in the meantime alone.
      plan:
        result.changed && !written.has(result.itemId)
          ? { kind: 'rate' as const, ...tagDelta(result) }
          : null,
    })),
    ...skippedRows,
  ];
  reportItems(ctx, report);

  const filtered =
    options.maxAge === undefined
      ? results
      : results.filter(
          (r) => r.assessment.band !== 'unknown' && BAND_MIN_AGE[r.assessment.band as AgeBand] > options.maxAge!,
        );

  return {
    rated: results.length,
    skippedAlreadyRated: skipped,
    tagged,
    wouldTag: changes.length,
    unchanged,
    applied: Boolean(options.apply),
    bandCounts,
    flagCounts,
    unknownBand,
    belowConfidence,
    stopped: ratings.stopped || Boolean(ctx.signal?.aborted),
    notReached: ratings.unreached,
    results: filtered,
    report,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}
