import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import { log } from '../logger.js';
import { mapLimit } from '../providers/http.js';
import { buildProviders } from '../providers/index.js';
import {
  isBlank,
  normalizeAuthor,
  normalizePersonName,
  normalizeTitle,
  normalizeTitleText,
} from '../util/text.js';
import { lookupItem, type LookupDeps } from './lookup.js';
import { MATCH_MIN_REWRITE, type Candidate } from './matching.js';
import { itemQuery } from './query.js';

/**
 * Bringing a library's metadata into one consistent shape.
 *
 * This is the counterpart to `metadata`, and the line between them is what a
 * change is allowed to do. `metadata` fills fields that are *empty*: nobody can
 * be surprised by a description appearing where there was none. `normalize`
 * rewrites fields that already have a value and that people can see — the
 * title, the author, the narrator, the series. Getting one of those wrong is
 * visible and annoying in a way a wrong publisher never is.
 *
 * So the evidence bar is different, and there are three tiers of it:
 *
 *   provider   an exact ASIN or ISBN match, and only that. A fuzzy title match
 *              is never enough to rename a book (see MATCH_MIN_REWRITE).
 *   consensus  the library agreeing with itself — four books spelling a series
 *              "The Stormlight Archive" and one spelling it without the "The".
 *              Needs no provider and is the single most common real mismatch.
 *   local      deterministic repairs of how the text is written down:
 *              "Hobbit, The" is "The Hobbit", "King, Stephen" is "Stephen
 *              King". No outside fact is being asserted, only a reordering.
 *
 * Higher tiers win. Everything is a dry run until applied, and applying is
 * refused outright unless "Allow metadata rewrite" is switched on.
 */

// Re-exported because they are this command's vocabulary even though they live
// in util/text.js — where the provider query can reach them without a cycle.
export { normalizePersonName, normalizeTitleText };

export const NORMALIZABLE = ['title', 'subtitle', 'author', 'narrator', 'series'] as const;
export type Normalizable = (typeof NORMALIZABLE)[number];

export type ProposalSource = 'provider' | 'consensus' | 'local';

const SOURCE_RANK: Record<ProposalSource, number> = { provider: 3, consensus: 2, local: 1 };

export interface FieldProposal {
  field: Normalizable;
  from: string | null;
  to: string;
  source: ProposalSource;
  /** Where it came from in detail: a provider name, or the rule that fired. */
  detail: string;
}

export interface NormalizePlan {
  itemId: string;
  title: string;
  author: string | null;
  proposals: FieldProposal[];
}

// ---------------------------------------------------------------------------
// Local repairs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Library consensus
// ---------------------------------------------------------------------------

export interface Consensus {
  series: Map<string, string>;
  authors: Map<string, string>;
  narrators: Map<string, string>;
}

/**
 * Picks the form the library already prefers.
 *
 * Two spellings of one series name are the most common metadata mismatch there
 * is, and no provider is needed to see it: the library disagrees with itself,
 * and the majority form is the answer. Ties are broken toward the longer
 * string, on the reasoning that the difference between "Stormlight Archive"
 * and "The Stormlight Archive" is a dropped word rather than an added one.
 */
export function pickConsensus(values: string[]): Map<string, string> {
  const groups = new Map<string, Map<string, number>>();
  for (const value of values) {
    const key = normalizeTitle(value);
    if (!key) continue;
    const forms = groups.get(key) ?? new Map<string, number>();
    forms.set(value, (forms.get(value) ?? 0) + 1);
    groups.set(key, forms);
  }

  const winners = new Map<string, string>();
  for (const [key, forms] of groups) {
    // A single spelling used consistently is not a disagreement to resolve.
    if (forms.size < 2) continue;
    const ranked = [...forms.entries()].sort(
      (a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]),
    );
    winners.set(key, ranked[0]![0]);
  }
  return winners;
}

/** Same idea for people, where the grouping key ignores "Last, First" order. */
function pickPersonConsensus(values: string[]): Map<string, string> {
  const groups = new Map<string, Map<string, number>>();
  for (const value of values) {
    const key = normalizeAuthor(value);
    if (!key) continue;
    const forms = groups.get(key) ?? new Map<string, number>();
    forms.set(value, (forms.get(value) ?? 0) + 1);
    groups.set(key, forms);
  }

  const winners = new Map<string, string>();
  for (const [key, forms] of groups) {
    if (forms.size < 2) continue;
    const ranked = [...forms.entries()].sort(
      (a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]),
    );
    winners.set(key, ranked[0]![0]);
  }
  return winners;
}

export function buildConsensus(items: AbsLibraryItem[]): Consensus {
  const seriesNames: string[] = [];
  const authorNames: string[] = [];
  const narratorNames: string[] = [];

  for (const item of items) {
    const metadata = item.media?.metadata;
    for (const series of metadata?.series ?? []) {
      if (series.name) seriesNames.push(series.name);
    }
    for (const author of metadata?.authors ?? []) {
      if (author.name) authorNames.push(author.name);
    }
    if (metadata?.authorName) authorNames.push(...splitPeople(metadata.authorName));
    for (const narrator of itemNarrators(item)) narratorNames.push(narrator);
  }

  return {
    series: pickConsensus(seriesNames),
    authors: pickPersonConsensus(authorNames),
    narrators: pickPersonConsensus(narratorNames),
  };
}

/** ABS stores narrators both ways depending on how the book was matched. */
export function itemNarrators(item: AbsLibraryItem): string[] {
  const metadata = item.media?.metadata;
  const listed = metadata?.narrators ?? [];
  if (listed.length > 0) return listed.filter((n) => !isBlank(n)).map((n) => n.trim());
  return isBlank(metadata?.narratorName) ? [] : splitPeople(metadata!.narratorName!);
}

/**
 * Splits a joined people string. Deliberately does not split on a bare comma:
 * "King, Stephen" is one person, and there is no way to tell it apart from two
 * surnames without knowing the names, so only unambiguous separators count.
 */
export function splitPeople(value: string): string[] {
  return value
    .split(/\s*(?:;|&|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function propose(
  list: FieldProposal[],
  field: Normalizable,
  from: string | null,
  to: string | null | undefined,
  source: ProposalSource,
  detail: string,
): void {
  if (isBlank(to) || to === from) return;

  const existing = list.findIndex((p) => p.field === field);
  const candidate: FieldProposal = { field, from, to: to!.trim(), source, detail };
  if (existing === -1) {
    list.push(candidate);
    return;
  }
  // Better evidence replaces weaker evidence for the same field, so a provider
  // answer is never overwritten by a local reordering of the old value.
  if (SOURCE_RANK[source] > SOURCE_RANK[list[existing]!.source]) list[existing] = candidate;
}

export interface NormalizeOptions {
  fields: Normalizable[];
  /** Skip the library-consensus tier — useful when a library is mid-import. */
  noConsensus?: boolean;
}

export function planNormalize(
  item: AbsLibraryItem,
  best: Candidate | null,
  consensus: Consensus,
  options: NormalizeOptions,
): NormalizePlan {
  const metadata = item.media?.metadata;
  const wanted = new Set(options.fields);
  const proposals: FieldProposal[] = [];

  // Only an identifier-grade match may rewrite what someone can already read.
  const trusted = best && best.match.score >= MATCH_MIN_REWRITE ? best : null;

  if (wanted.has('title')) {
    const current = metadata?.title ?? null;
    propose(proposals, 'title', current, normalizeTitleText(current), 'local', 'article/edition text');
    if (trusted) {
      propose(proposals, 'title', current, normalizeTitleText(trusted.result.title) ?? trusted.result.title, 'provider', trusted.result.provider);
    }
  }

  if (wanted.has('subtitle') && trusted) {
    propose(proposals, 'subtitle', metadata?.subtitle ?? null, trusted.result.subtitle, 'provider', trusted.result.provider);
  }

  if (wanted.has('author')) {
    const current = itemAuthor(item);
    const tidied = normalizePersonName(current);
    propose(proposals, 'author', current, tidied, 'local', 'name order');
    if (!options.noConsensus && current) {
      propose(proposals, 'author', current, consensus.authors.get(normalizeAuthor(current)), 'consensus', 'library spelling');
    }
    if (trusted) {
      propose(proposals, 'author', current, trusted.result.authors?.[0], 'provider', trusted.result.provider);
    }
  }

  if (wanted.has('narrator')) {
    const current = itemNarrators(item);
    const currentText = current.join(', ');
    const tidied = current.map((name) => normalizePersonName(name) ?? name);
    propose(proposals, 'narrator', currentText || null, joinIfChanged(tidied, current), 'local', 'name order');

    if (!options.noConsensus && current.length > 0) {
      const agreed = current.map((name) => consensus.narrators.get(normalizeAuthor(name)) ?? name);
      propose(proposals, 'narrator', currentText || null, joinIfChanged(agreed, current), 'consensus', 'library spelling');
    }
    if (trusted?.result.narrators?.length) {
      propose(proposals, 'narrator', currentText || null, trusted.result.narrators.join(', '), 'provider', trusted.result.provider);
    }
  }

  if (wanted.has('series')) {
    const current = metadata?.series?.[0]?.name ?? null;
    if (!options.noConsensus && current) {
      propose(proposals, 'series', current, consensus.series.get(normalizeTitle(current)), 'consensus', 'library spelling');
    }
    if (trusted?.result.series?.name) {
      propose(proposals, 'series', current, trusted.result.series.name, 'provider', trusted.result.provider);
    }
  }

  return { itemId: item.id, title: itemTitle(item), author: itemAuthor(item), proposals };
}

function joinIfChanged(next: string[], previous: string[]): string | null {
  const joined = next.join(', ');
  return joined === previous.join(', ') ? null : joined;
}

/**
 * Turns a plan into the patch AudiobookShelf expects.
 *
 * Series keeps its existing sequence: this command normalizes *names*, and the
 * position of a book within its series is something the library already knows
 * and a provider's regional edition may well disagree about.
 */
export function planToPatch(item: AbsLibraryItem, plan: NormalizePlan): AbsMediaPatch {
  const patch: AbsMediaPatch = { metadata: {} };
  const metadata = patch.metadata!;

  for (const proposal of plan.proposals) {
    switch (proposal.field) {
      case 'title':
        metadata.title = proposal.to;
        break;
      case 'subtitle':
        metadata.subtitle = proposal.to;
        break;
      case 'author':
        metadata.authors = splitPeople(proposal.to).map((name) => ({ name }));
        break;
      case 'narrator':
        metadata.narrators = proposal.to.split(',').map((n) => n.trim()).filter(Boolean);
        break;
      case 'series': {
        const existing = item.media?.metadata?.series?.[0];
        metadata.series = [
          {
            ...(existing?.id ? { id: existing.id } : {}),
            name: proposal.to,
            sequence: existing?.sequence ?? null,
          },
        ];
        break;
      }
    }
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * Why an apply was refused before anything was read. The mirror of
 * organize's WRITES_DISABLED, and deliberately worded to distinguish itself
 * from it — the two switches guard different things and are set independently.
 */
export const REWRITE_DISABLED =
  'Metadata rewriting is turned off, so normalize can propose changes but not write them. ' +
  'Turn on "Allow metadata rewrite" in Settings to apply this plan.\n' +
  'Unlike `metadata`, which only fills blank fields, this replaces titles, authors, narrators ' +
  'and series names that already have a value — so it is something you switch on deliberately, ' +
  'and can switch straight back off afterwards.';

export interface NormalizeTaskOptions {
  library?: string;
  apply?: boolean;
  limit?: number;
  fields?: string[];
  providers?: string[];
  noConsensus?: boolean;
}

export interface NormalizeTaskResult {
  scanned: number;
  itemsToChange: number;
  fieldsToChange: number;
  updated: number;
  applied: boolean;
  fields: Normalizable[];
  bySource: Record<ProposalSource, number>;
  plans: NormalizePlan[];
}

export async function runNormalizeTask(
  ctx: TaskContext,
  options: NormalizeTaskOptions = {},
): Promise<NormalizeTaskResult> {
  if (options.apply && !ctx.settings.allowMetadataRewrite) throw new Error(REWRITE_DISABLED);

  const requested = (options.fields ?? [...NORMALIZABLE]) as Normalizable[];
  const invalid = requested.filter((f) => !NORMALIZABLE.includes(f));
  if (invalid.length > 0) {
    throw new Error(`Unknown field(s): ${invalid.join(', ')}. Valid: ${NORMALIZABLE.join(', ')}`);
  }

  const providers = buildProviders(
    {
      googleBooksApiKey: ctx.settings.googleBooksApiKey || undefined,
      audibleRegion: ctx.settings.audibleRegion,
      providerConcurrency: ctx.settings.providerConcurrency,
    },
    options.providers ?? ctx.settings.providers,
  );
  const deps: LookupDeps = { providers, db: ctx.db, cacheDays: ctx.settings.lookupCacheDays };

  const libraries = await resolveLibraries(ctx, options.library);
  const items = await collectItems(ctx, libraries, { limit: options.limit });

  // Consensus is built from everything that was read, before any single item is
  // planned: the whole point is that one book's spelling is judged against the
  // rest of the library rather than against itself.
  const consensus = options.noConsensus
    ? { series: new Map(), authors: new Map(), narrators: new Map() }
    : buildConsensus(items);
  if (!options.noConsensus) {
    log.info(
      `library disagrees with itself on ${consensus.series.size} series, ` +
        `${consensus.authors.size} author(s), ${consensus.narrators.size} narrator(s)`,
    );
  }

  log.info(`checking ${items.length} item(s) for ${requested.join(', ')} inconsistencies…`);

  const plans = await mapLimit(items, ctx.settings.providerConcurrency, async (item) => {
    // An item with no ISBN and no ASIN can never reach MATCH_MIN_REWRITE — a
    // fuzzy match is capped below it by design — so the lookup could not
    // change the outcome and is skipped outright. On a library ABS has not
    // matched, that makes this command entirely local and effectively free.
    const query = itemQuery(item);
    const identified = Boolean(query.asin || query.isbn);
    const best = identified ? (await lookupItem(deps, query)).best : null;

    return planNormalize(item, best, consensus, {
      fields: requested,
      ...(options.noConsensus === undefined ? {} : { noConsensus: options.noConsensus }),
    });
  });

  const actionable = plans.filter((p) => p.proposals.length > 0);
  const fieldsToChange = actionable.reduce((sum, p) => sum + p.proposals.length, 0);

  const bySource: Record<ProposalSource, number> = { provider: 0, consensus: 0, local: 0 };
  for (const plan of actionable) {
    for (const proposal of plan.proposals) bySource[proposal.source] += 1;
  }

  const byId = new Map(items.map((item) => [item.id, item]));

  let updated = 0;
  if (options.apply) {
    for (const plan of actionable) {
      await ctx.client.patchItemMedia(plan.itemId, planToPatch(byId.get(plan.itemId)!, plan));
      updated += 1;
      if (updated % 25 === 0) log.info(`  wrote ${updated}/${actionable.length}`);
    }
    log.success(`Normalized ${updated} item(s).`);
  } else if (actionable.length === 0) {
    log.success('Everything already agrees.');
  } else {
    log.info(`${actionable.length} item(s) would change. Apply to write.`);
  }

  return {
    scanned: items.length,
    itemsToChange: actionable.length,
    fieldsToChange,
    updated,
    applied: Boolean(options.apply),
    fields: requested,
    bySource,
    plans: actionable,
  };
}
