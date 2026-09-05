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
  /** Display form. For list fields this is the joined text, shown to a human. */
  to: string;
  source: ProposalSource;
  /** Where it came from in detail: a provider name, or the rule that fired. */
  detail: string;
  /**
   * For the list-valued fields — author, narrator, series — the exact values to
   * write, positionally. `to` is never split back apart to recover these: a
   * name like "Martin Luther King, Jr." would come apart into two people, and
   * AudiobookShelf replaces the whole list with whatever it is sent.
   */
  values?: string[];
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

/**
 * Same idea for people, but each spelling is put into reading order before it
 * votes.
 *
 * Without that step the vote is decided by the tie-break, and the tie-break
 * prefers the longer string — which for a person is always the sort-order form,
 * because of the comma and space it adds. A library holding "L. Frank Baum" and
 * "Baum, L. Frank" once each would elect the inverted one and then rewrite the
 * correct book to match it, driving the whole library the wrong way.
 *
 * Canonicalizing first means the two forms are the same vote rather than
 * opposing ones, so consensus is left deciding only what a local repair cannot:
 * genuinely different spellings like "J.R.R. Tolkien" against "JRR Tolkien".
 */
function pickPersonConsensus(values: string[]): Map<string, string> {
  const groups = new Map<string, Map<string, number>>();
  for (const raw of values) {
    const value = normalizePersonName(raw) ?? raw;
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
    // The same extractors the planner uses, so the vote is taken over exactly
    // the values that could be proposed — and an ambiguous flattened name is
    // excluded from both rather than voting under a misreading.
    for (const author of itemAuthors(item)) authorNames.push(author);
    for (const narrator of itemNarrators(item)) narratorNames.push(narrator);
  }

  return {
    series: pickConsensus(seriesNames),
    authors: pickPersonConsensus(authorNames),
    narrators: pickPersonConsensus(narratorNames),
  };
}

/**
 * Every author on the book, as a list.
 *
 * `itemAuthor` returns one name for display; this is what normalize needs,
 * because AudiobookShelf replaces the whole author list with whatever it is
 * sent — so anything it does not send is deleted.
 */
export function itemAuthors(item: AbsLibraryItem): string[] {
  const metadata = item.media?.metadata;
  const listed = (metadata?.authors ?? []).map((a) => a.name).filter((n) => !isBlank(n));
  if (listed.length > 0) return listed.map((n) => n.trim());
  return peopleFromFlatName(metadata?.authorName);
}

/**
 * Last resort when only the flattened name is available, which happens when an
 * item could not be expanded.
 *
 * A comma in that string is unresolvably ambiguous: AudiobookShelf joins
 * co-authors with ", " and people write single names as "Last, First", and the
 * two are indistinguishable without knowing the names. Guessing wrong is not
 * cosmetic — ABS replaces the list with whatever it is sent, so reading two
 * people as one deletes somebody, and reading one as two invents somebody.
 *
 * So a comma here yields nothing at all, and the field is simply left alone.
 */
export function peopleFromFlatName(value: string | null | undefined): string[] {
  if (isBlank(value)) return [];
  if (value!.includes(',')) return [];
  return splitPeople(value!);
}

/** ABS stores narrators both ways depending on how the book was matched. */
export function itemNarrators(item: AbsLibraryItem): string[] {
  const metadata = item.media?.metadata;
  const listed = metadata?.narrators ?? [];
  if (listed.length > 0) return listed.filter((n) => !isBlank(n)).map((n) => n.trim());
  return peopleFromFlatName(metadata?.narratorName);
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

/**
 * Authors and series are records in AudiobookShelf, not strings on the book,
 * and it resolves them by name case-insensitively. So a rename that changes
 * only capitalization has nothing to resolve to but the record already
 * attached, and the write is accepted and silently does nothing.
 *
 * Proposing it anyway would mean a scheduled run that reports the same change
 * every night and never converges — the one failure a set-and-forget tool
 * cannot have. Narrators are plain strings on the book and are not affected.
 */
const RESOLVED_BY_NAME: ReadonlySet<Normalizable> = new Set<Normalizable>(['author', 'series']);

function unachievableRename(field: Normalizable, from: string | null, to: string): boolean {
  if (!RESOLVED_BY_NAME.has(field) || !from) return false;
  return from.toLowerCase() === to.toLowerCase();
}

function propose(
  list: FieldProposal[],
  field: Normalizable,
  from: string | null,
  to: string | null | undefined,
  source: ProposalSource,
  detail: string,
  values?: string[],
): void {
  if (isBlank(to) || to === from) return;
  if (unachievableRename(field, from, to!.trim())) return;

  const existing = list.findIndex((p) => p.field === field);
  const candidate: FieldProposal = {
    field,
    from,
    to: to!.trim(),
    source,
    detail,
    ...(values ? { values } : {}),
  };
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
    const current = itemAuthors(item);
    const currentText = current.join(', ') || null;

    const tidied = current.map((name) => normalizePersonName(name) ?? name);
    propose(proposals, 'author', currentText, joinIfChanged(tidied, current), 'local', 'name order', tidied);

    if (!options.noConsensus && current.length > 0) {
      const agreed = current.map((name) => consensus.authors.get(normalizeAuthor(name)) ?? name);
      propose(proposals, 'author', currentText, joinIfChanged(agreed, current), 'consensus', 'library spelling', agreed);
    }

    // AudiobookShelf replaces the author list with whatever it is sent, so a
    // provider that lists fewer authors than the library would silently delete
    // the rest. Audible routinely credits only the lead author of a
    // collaboration, which makes this the common case rather than the odd one.
    const fromProvider = trusted?.result.authors ?? [];
    if (fromProvider.length >= current.length && fromProvider.length > 0) {
      propose(proposals, 'author', currentText, fromProvider.join(', '), 'provider', trusted!.result.provider, fromProvider);
    }
  }

  if (wanted.has('narrator')) {
    const current = itemNarrators(item);
    const currentText = current.join(', ');
    const tidied = current.map((name) => normalizePersonName(name) ?? name);
    propose(proposals, 'narrator', currentText || null, joinIfChanged(tidied, current), 'local', 'name order', tidied);

    if (!options.noConsensus && current.length > 0) {
      const agreed = current.map((name) => consensus.narrators.get(normalizeAuthor(name)) ?? name);
      propose(proposals, 'narrator', currentText || null, joinIfChanged(agreed, current), 'consensus', 'library spelling', agreed);
    }

    const narrated = trusted?.result.narrators ?? [];
    if (narrated.length >= current.length && narrated.length > 0) {
      propose(proposals, 'narrator', currentText || null, narrated.join(', '), 'provider', trusted!.result.provider, narrated);
    }
  }

  if (wanted.has('series')) {
    // Every entry, because AudiobookShelf replaces the series list too — a book
    // in two series would lose the second if only the first were sent back.
    const current = (metadata?.series ?? []).map((s) => s.name).filter((n): n is string => !!n);
    const currentText = current.join(', ') || null;

    if (!options.noConsensus && current.length > 0) {
      const agreed = current.map((name) => consensus.series.get(normalizeTitle(name)) ?? name);
      propose(proposals, 'series', currentText, joinIfChanged(agreed, current), 'consensus', 'library spelling', agreed);
    }

    // A provider knows about one series, so it can rename the book's own but
    // never enumerate the set. Applied to the first entry, or added when there
    // is none at all.
    const found = trusted?.result.series?.name;
    if (found) {
      const merged = current.length > 0 ? [found, ...current.slice(1)] : [found];
      propose(proposals, 'series', currentText, joinIfChanged(merged, current), 'provider', trusted!.result.provider, merged);
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
 * The list fields are written from `proposal.values`, never by splitting the
 * display text: ABS replaces the author, narrator and series lists wholesale
 * with whatever arrives, so a name that came apart on the wrong comma would
 * not be a cosmetic error but a deleted co-author.
 *
 * Series keeps its existing sequence, matched positionally. This command
 * normalizes *names*; where a book sits in its series is something the library
 * already knows and a provider's regional edition may well disagree about.
 */
export function planToPatch(item: AbsLibraryItem, plan: NormalizePlan): AbsMediaPatch {
  const patch: AbsMediaPatch = { metadata: {} };
  const metadata = patch.metadata!;
  const existingSeries = item.media?.metadata?.series ?? [];

  for (const proposal of plan.proposals) {
    const values = proposal.values ?? [proposal.to];
    switch (proposal.field) {
      case 'title':
        metadata.title = proposal.to;
        break;
      case 'subtitle':
        metadata.subtitle = proposal.to;
        break;
      case 'author':
        metadata.authors = values.map((name) => ({ name }));
        break;
      case 'narrator':
        metadata.narrators = values;
        break;
      case 'series':
        // No id: ABS resolves a series by name and creates it when new, so an
        // id would suggest a stability the endpoint does not actually offer.
        metadata.series = values.map((name, index) => ({
          name,
          sequence: existingSeries[index]?.sequence ?? null,
        }));
        break;
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
  // Expanded: this command reads and rewrites the structured author, narrator
  // and series lists, and the minified listing carries none of them.
  const items = await collectItems(ctx, libraries, { limit: options.limit, expand: true });

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
