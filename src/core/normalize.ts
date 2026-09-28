import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import { isEbookOnly } from '../abs/media.js';
import { log } from '../logger.js';
import { mapLimitPartial } from '../providers/http.js';
import {
  isBlank,
  isSequenceRange,
  normalizeAuthor,
  normalizePersonName,
  normalizeTitle,
  normalizeTitleText,
} from '../util/text.js';
import { lookupItem, lookupDepsFor } from './lookup.js';
import { MATCH_MIN_IDENTITY, MATCH_MIN_REWRITE, type Candidate } from './matching.js';
import { itemQuery } from './query.js';
import type { RunItemInput } from '../db/runItems.js';
import { breakdown, brief, itemPath, plural, reportItems } from './report.js';
import { applyPatch } from './revisions.js';
import { isButlerTag } from '../content/ageRating.js';

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

export const NORMALIZABLE = [
  'title',
  'subtitle',
  'author',
  'narrator',
  'series',
  'genre',
  'tag',
  'work',
] as const;

/**
 * What a run looks at when it is not told otherwise: everything but tags.
 *
 * Genres are a shared vocabulary — a publisher's shelf, copied onto the book by
 * a match — so a genre most of a series carries is a fact about the series.
 * Tags are that too, but they are also where people keep their own lists:
 * "Favorites", "Read with Sam". Copying one of those across a series because
 * four of its books happen to carry it would be writing someone's reading
 * habits onto books they never chose, so tags are something to ask for.
 */
export const DEFAULT_NORMALIZE_FIELDS: readonly Normalizable[] = NORMALIZABLE.filter((f) => f !== 'tag');

/**
 * Namespace for the work identity, written as a tag because AudiobookShelf has
 * no field for one.
 *
 * The value is an Open Library work key — the identity of the *book*, not of
 * one edition of it. That distinction is the whole point: two servers holding
 * different narrations of the same novel should agree they hold the same book,
 * which an ASIN would deny and an ISBN would answer only for one printing.
 *
 * It exists for clients reading across several servers. AudiobookShelf itself
 * has no use for it, and nothing here depends on it either — a library that
 * never runs this is not worse off, it just leaves its readers' other tools
 * guessing from titles.
 *
 * A box set holds several works, so it may carry several tags — one per book
 * inside it. Those are written by hand; see the work tier in planNormalize.
 */
export const WORK_TAG_PREFIX = 'abs-butler:work:';

export function workTag(key: string): string {
  return `${WORK_TAG_PREFIX}${key}`;
}

/** Every work key recorded on an item: one for a book, one per book for a box set. */
export function itemWorkKeys(item: AbsLibraryItem): string[] {
  return (item.media?.tags ?? [])
    .filter((t) => t.startsWith(WORK_TAG_PREFIX))
    .map((t) => t.slice(WORK_TAG_PREFIX.length));
}

/** The work keys already recorded on an item, as text, or null for none. */
export function itemWorkKey(item: AbsLibraryItem): string | null {
  return itemWorkKeys(item).join(', ') || null;
}

/**
 * Whether an item holds more than one book of its series — a box set numbered
 * "1-3" — and so is more than one work.
 */
export function isBoxSet(item: AbsLibraryItem): boolean {
  return (item.media?.metadata?.series ?? []).some((s) => isSequenceRange(s.sequence));
}

/**
 * Whether the work tier may write this item's identity at all.
 *
 * Not a box set: it is several works, and one match can only ever name one of
 * them — usually the first book, whose title the set shares. Writing that would
 * tell every other server this item *is* book 1, and hide books 2 and 3 from
 * anything counting what the series is missing. Nor an item already carrying
 * several work keys, which someone set by hand and a single one would replace.
 */
export function takesWorkKey(item: AbsLibraryItem): boolean {
  return !isBoxSet(item) && itemWorkKeys(item).length <= 1;
}

/**
 * Open Library returns a work key as a path, "/works/OL27482W". Stored bare, so
 * the tag reads as an identifier rather than a URL fragment.
 */
export function workKeyFrom(candidate: Candidate | undefined): string | null {
  if (!candidate || candidate.result.provider !== 'openlibrary') return null;
  const id = candidate.result.providerId ?? '';
  const match = /\/works\/(OL\d+W)$/.exec(id);
  return match ? match[1]! : null;
}
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
   * For the list-valued fields — author, narrator, series, genre, tag — the
   * exact values to write, positionally. For tags, only the ones abs-butler
   * does not own; its own are kept as the book has them when this is written. `to` is never split back apart to recover these: a
   * name like "Martin Luther King, Jr." would come apart into two people, and
   * AudiobookShelf replaces the whole list with whatever it is sent.
   */
  values?: string[];
  /**
   * Set when a list only grows: every value the book had is still there,
   * written the same way. That is supplying, not replacing, whatever `from`
   * holds.
   */
  additive?: boolean;
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
  /**
   * People this library shows to be narrators by trade, rather than authors who
   * happened to read their own book.
   *
   * Needed because "is also a narrator on this item" is on its own a terrible
   * reason to drop someone from the author list. Measured on two real servers,
   * that alone would have removed Michael Greger from How Not to Die, Gabor
   * Maté from Hold On to Your Kids and Ken Albala from his own lecture course.
   * An author reading their own work is ordinary, especially in non-fiction.
   */
  narratorsByTrade: Set<string>;
  /** Library spelling of each genre and tag, the same vote as series names. */
  genres: Map<string, string>;
  tags: Map<string, string>;
  /** What each series agrees on, keyed by normalized series name. */
  bySeries: Map<string, SeriesProfile>;
}

export function emptyConsensus(): Consensus {
  return {
    series: new Map(),
    authors: new Map(),
    narrators: new Map(),
    narratorsByTrade: new Set(),
    genres: new Map(),
    tags: new Map(),
    bySeries: new Map(),
  };
}

/** Narrations before someone counts as a narrator by trade, and by what margin. */
const TRADE_MIN_NARRATIONS = 5;
const TRADE_RATIO = 4;

/**
 * The most an author list can hold and still be believable.
 *
 * A book credited to a dozen people has had its cast list written into the
 * author field, and removing the two this rule recognises leaves it just as
 * wrong. Changing it would be churn, so it is left alone entirely.
 */
const PLAUSIBLE_AUTHORS = 3;

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
  const genreNames: string[] = [];
  const tagNames: string[] = [];

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
    genreNames.push(...itemGenres(item));
    tagNames.push(...itemTags(item));
  }

  return {
    series: pickConsensus(seriesNames),
    authors: pickPersonConsensus(authorNames),
    narrators: pickPersonConsensus(narratorNames),
    narratorsByTrade: findNarratorsByTrade(items),
    genres: pickConsensus(genreNames),
    tags: pickConsensus(tagNames),
    bySeries: profileSeries(items),
  };
}

// ---------------------------------------------------------------------------
// Series consensus
// ---------------------------------------------------------------------------

/**
 * What the books of one series agree on.
 *
 * A series is the strongest evidence a library holds about its own books. The
 * fourteen volumes of one saga were written by the same person and shelved in
 * the same genre, so when twelve of them say "Dakota Krout" and two say
 * "Dakota Krout, Luke Daniels", the two are the ones that are wrong — whatever
 * put the extra name there, a file tag or a match against the wrong edition.
 * And when AudiobookShelf matched three of them on a day the publisher called
 * them LitRPG and the rest on a day it did not, the genre belongs to all of
 * them.
 */
export interface SeriesProfile {
  /** The series as the library spells it, for the dry run to name. */
  name: string;
  /**
   * The person on most of the series' books. Only books crediting them count
   * as members: two unrelated series that share a name — there is more than
   * one "Legacy" — are then not mistaken for one series with a disputed author.
   */
  lead: string;
  /** Books in the series crediting the lead. */
  members: number;
  /** The author list a strict majority of members share, if one does. */
  authors: { names: string[]; count: number } | null;
  /** Genres and tags enough members carry to be the series', by normalized key. */
  genres: Map<string, { value: string; count: number }>;
  tags: Map<string, { value: string; count: number }>;
}

/**
 * Below this many agreeing books a series proves nothing about its authors.
 * Two books against one is a coin that landed twice.
 */
const SERIES_MIN_AGREEING = 3;

/**
 * How widely a genre has to be carried before the rest of the series gets it.
 *
 * Deliberately below a majority. The problem this answers is a genre that only
 * a few books happened to be matched with, so requiring most of them to have
 * it already would leave exactly that case alone. Two books is the floor so a
 * single book's own subject — the Christmas novella in a fantasy series — does
 * not spread to its siblings, and a quarter keeps two books out of forty from
 * speaking for the other thirty-eight.
 */
const SERIES_MIN_CARRIERS = 2;
const SERIES_MIN_SHARE = 0.25;

/** Tags abs-butler writes itself: age bands, content flags, the work identity. */
export function isOwnedTag(tag: string): boolean {
  return isButlerTag(tag) || tag.startsWith(WORK_TAG_PREFIX);
}

export function itemGenres(item: AbsLibraryItem): string[] {
  return (item.media?.metadata?.genres ?? []).map((g) => g.trim()).filter((g) => g !== '');
}

/** The tags a person or a match put there, leaving out the ones abs-butler owns. */
export function itemTags(item: AbsLibraryItem): string[] {
  return (item.media?.tags ?? []).map((t) => t.trim()).filter((t) => t !== '' && !isOwnedTag(t));
}

function seriesKeys(item: AbsLibraryItem): string[] {
  const keys = (item.media?.metadata?.series ?? []).map((s) => normalizeTitle(s.name)).filter(Boolean);
  return [...new Set(keys)];
}

/** An author list as a set: the same people in any order are the same credit. */
function creditKey(names: string[]): string {
  return [...new Set(names.map((name) => normalizeAuthor(name)).filter(Boolean))].sort().join('|');
}

export function profileSeries(items: AbsLibraryItem[]): Map<string, SeriesProfile> {
  const groups = new Map<string, { names: string[]; items: AbsLibraryItem[] }>();
  for (const item of items) {
    for (const series of item.media?.metadata?.series ?? []) {
      const key = normalizeTitle(series.name);
      if (!key) continue;
      const group = groups.get(key) ?? { names: [], items: [] };
      group.names.push(series.name);
      if (!group.items.includes(item)) group.items.push(item);
      groups.set(key, group);
    }
  }

  const profiles = new Map<string, SeriesProfile>();
  for (const [key, group] of groups) {
    const credited = group.items.map((item) => itemAuthors(item));

    // The lead has to be on more than half the books. A "series" with no such
    // person is a name two unrelated sets of books share, and it says nothing.
    const people = new Map<string, number>();
    for (const names of credited) {
      for (const person of new Set(names.map((n) => normalizeAuthor(n)).filter(Boolean))) {
        people.set(person, (people.get(person) ?? 0) + 1);
      }
    }
    const [lead, leadCount] = [...people.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (!lead || leadCount * 2 <= group.items.length) continue;

    const members = group.items.filter((_, i) => credited[i]!.some((n) => normalizeAuthor(n) === lead));

    const lists = new Map<string, { names: string[]; count: number }>();
    for (const item of members) {
      const names = itemAuthors(item).map((n) => normalizePersonName(n) ?? n);
      const id = creditKey(names);
      const entry = lists.get(id) ?? { names, count: 0 };
      entry.count += 1;
      lists.set(id, entry);
    }
    const top = [...lists.values()].sort((a, b) => b.count - a.count)[0] ?? null;
    const authors =
      top && top.count >= SERIES_MIN_AGREEING && top.count * 2 > members.length ? top : null;

    profiles.set(key, {
      name: pickConsensus(group.names).get(key) ?? group.names[0]!,
      lead,
      members: members.length,
      authors,
      genres: sharedValues(members.map(itemGenres), members.length),
      tags: sharedValues(members.map(itemTags), members.length),
    });
  }
  return profiles;
}

function sharedValues(
  perBook: string[][],
  members: number,
): Map<string, { value: string; count: number }> {
  const counts = new Map<string, { forms: Map<string, number>; count: number }>();
  for (const values of perBook) {
    const seen = new Set<string>();
    for (const value of values) {
      const key = normalizeTitle(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { forms: new Map(), count: 0 };
      entry.count += 1;
      entry.forms.set(value, (entry.forms.get(value) ?? 0) + 1);
      counts.set(key, entry);
    }
  }

  const shared = new Map<string, { value: string; count: number }>();
  for (const [key, entry] of counts) {
    if (entry.count < SERIES_MIN_CARRIERS || entry.count < members * SERIES_MIN_SHARE) continue;
    const value = [...entry.forms.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    shared.set(key, { value, count: entry.count });
  }
  return shared;
}

/** The profiles of every series this book belongs to and is a member of. */
function profilesFor(item: AbsLibraryItem, consensus: Consensus): SeriesProfile[] {
  const authors = new Set(itemAuthors(item).map((n) => normalizeAuthor(n)));
  return seriesKeys(item)
    .map((key) => consensus.bySeries.get(key))
    .filter((p): p is SeriesProfile => !!p && authors.has(p.lead));
}

/**
 * People who read many books here and wrote almost none of them.
 *
 * Counted over the library rather than judged per item, because the question
 * is what someone does for a living, and one book cannot answer it.
 */
export function findNarratorsByTrade(items: AbsLibraryItem[]): Set<string> {
  const authored = new Map<string, number>();
  const narrated = new Map<string, number>();
  const tally = (map: Map<string, number>, name: string) => {
    const key = normalizeAuthor(name);
    if (key) map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const item of items) {
    for (const person of itemAuthors(item)) tally(authored, person);
    for (const person of itemNarrators(item)) tally(narrated, person);
  }

  const byTrade = new Set<string>();
  for (const [key, narrations] of narrated) {
    if (narrations < TRADE_MIN_NARRATIONS) continue;
    if (narrations > (authored.get(key) ?? 0) * TRADE_RATIO) byTrade.add(key);
  }
  return byTrade;
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

/**
 * What the sources that identified this edition agree on, for one field.
 */
export interface ProviderVote<T> {
  value: T;
  /** Every source that gave this value, most-trusted first. */
  providers: string[];
}

/**
 * Counts the sources rather than believing the first one.
 *
 * Before this, a rewrite took whatever the single best-scoring candidate said
 * and the rest were decoration. Two things were wrong with that. A source with
 * nothing to say about a field still won it — Audible carries a subtitle where
 * AudioSilo carries none, so a reordering of the provider list could have
 * replaced a correct subtitle with nothing. And where sources genuinely
 * disagree — "The Mistborn Saga" against "Mistborn" — the answer was decided by
 * position in an array rather than by evidence.
 *
 * So each field is settled on its own: a source only votes where it has a
 * value, the most-agreed value wins, and a tie goes to the most trusted source
 * that offered it. `candidates` arrives sorted by match strength with the
 * configured provider order breaking its ties, so iterating in order and only
 * replacing the leader on a *strictly* higher count is exactly that rule.
 *
 * Every voter has already cleared MATCH_MIN_REWRITE, so counting them adds
 * reach without lowering the bar: this changes which identified answer is
 * chosen, never whether an unidentified one may be used.
 */
export function voteOn<T>(
  candidates: Candidate[],
  read: (result: Candidate['result']) => T | null | undefined,
  key: (value: T) => string,
): ProviderVote<T> | null {
  const groups = new Map<string, ProviderVote<T>>();

  for (const candidate of candidates) {
    const value = read(candidate.result);
    if (value === null || value === undefined) continue;
    const identity = key(value);
    if (!identity) continue;

    const group = groups.get(identity);
    // The first source to say it also decides how it is written, which is why
    // insertion order matters: it is the most trusted one that said it.
    if (group) group.providers.push(candidate.result.provider);
    else groups.set(identity, { value, providers: [candidate.result.provider] });
  }

  let winner: ProviderVote<T> | null = null;
  for (const group of groups.values()) {
    if (!winner || group.providers.length > winner.providers.length) winner = group;
  }
  return winner;
}

/** A list of people votes as a unit: the same names in the same order agree. */
function peopleKey(names: string[]): string {
  return names.map((name) => normalizeAuthor(name)).join('|');
}

function nonEmpty(names: string[] | undefined): string[] | null {
  return names && names.length > 0 ? names : null;
}

/** How a voted proposal explains itself in a dry run: "audible + audnexus". */
function attribution(vote: ProviderVote<unknown>): string {
  return vote.providers.join(' + ');
}

/**
 * One voice per catalogue. Audnexus is Audible's catalogue served another way,
 * so the two agreeing is one source saying something twice, not two sources.
 */
function voice(provider: string): string {
  return provider === 'audnexus' ? 'audible' : provider;
}

/** Sources that describe the written work, not one audio edition of it. */
const WORK_SOURCES: ReadonlySet<string> = new Set(['openlibrary', 'googlebooks']);

/**
 * Whether a provider list may put a person on a book who is not there now.
 *
 * Replacing a list is how a respelling lands, and for that one source is
 * plenty. Adding somebody is a different claim, and one source alone has been
 * wrong about it in exactly the way nobody notices: Google Books credits a
 * print edition's illustrator as its author, so an ISBN match wrote Brandon
 * Dorman onto every Fablehaven audiobook beside Brandon Mull. A person is only
 * added when two independent catalogues credit them.
 */
export function mayAddPeople(current: string[], proposed: string[], vote: ProviderVote<string[]>): boolean {
  if (current.length === 0) return true;
  const have = new Set(current.map((name) => normalizeAuthor(name)));
  if (proposed.every((name) => have.has(normalizeAuthor(name)))) return true;
  return new Set(vote.providers.map(voice)).size >= 2;
}

/**
 * Co-authors the identified sources, taken together, say are not authors.
 *
 * Each catalogue that identified this edition and lists authors either credits
 * the person or does not. They are removed only when at least two catalogues
 * leave them out, more leave them out than credit them, and one of those is a
 * source describing the written work. That last condition is the guard for a
 * real collaboration: Audible often credits only the lead author, and a rule
 * the audiobook catalogues could satisfy on their own would delete co-authors
 * they merely did not bother to list.
 *
 * The first-credited author is never removed. Whoever put a wrong name on a
 * book added it, and a list with its lead wrong needs a person, not this.
 */
export function outvotedAuthors(
  names: string[],
  rewritable: Candidate[],
): { removed: string[]; detail: string } {
  const none = { removed: [], detail: '' };
  if (names.length < 2) return none;

  const lists = rewritable
    .filter((c) => (c.result.authors ?? []).length > 0)
    .map((c) => ({
      voice: voice(c.result.provider),
      keys: new Set((c.result.authors ?? []).map((name) => normalizeAuthor(name))),
    }));

  const removed: string[] = [];
  const against = new Set<string>();
  for (const name of names.slice(1)) {
    const key = normalizeAuthor(name);
    const support = new Set(lists.filter((l) => l.keys.has(key)).map((l) => l.voice));
    const opposed = new Set(lists.filter((l) => !l.keys.has(key) && !support.has(l.voice)).map((l) => l.voice));
    const fromWork = [...opposed].some((v) => WORK_SOURCES.has(v));
    if (opposed.size >= 2 && opposed.size > support.size && fromWork) {
      removed.push(key);
      for (const v of opposed) against.add(v);
    }
  }
  if (removed.length === 0) return none;
  return { removed, detail: `not credited by ${[...against].join(' + ')}` };
}

/**
 * People on this book who are not on the author list the rest of its series
 * agrees on.
 *
 * Only ever a removal, and only when the book already credits everyone the
 * series does: a book by somebody else entirely is left alone, since a series
 * can genuinely change hands and a spin-off can sit inside it. Anyone an
 * identified source credits on this very book is kept, which is what lets a
 * real guest co-author on one volume survive.
 */
export function seriesExtras(
  item: AbsLibraryItem,
  names: string[],
  consensus: Consensus,
  rewritable: Candidate[],
): { removed: string[]; detail: string } | null {
  const profiles = profilesFor(item, consensus).filter((p) => p.authors);
  if (profiles.length === 0) return null;

  const agreed = profiles.map((p) => creditKey(p.authors!.names));
  // A book in two series that credit different people has no one answer.
  if (new Set(agreed).size > 1) return null;

  const expected = new Set(agreed[0]!.split('|'));
  const keys = names.map((name) => normalizeAuthor(name));
  if (![...expected].every((key) => keys.includes(key))) return null;

  const credited = new Set(
    rewritable.flatMap((c) => (c.result.authors ?? []).map((name) => normalizeAuthor(name))),
  );
  const removed = keys.filter((key) => !expected.has(key) && !credited.has(key));
  if (removed.length === 0) return null;

  const profile = profiles[0]!;
  return {
    removed,
    detail:
      `${profile.authors!.count} of ${profile.members} books in ${profile.name} ` +
      `credit ${profile.authors!.names.join(', ')}`,
  };
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

/**
 * Removes people from an author list who are really its narrators.
 *
 * Two independent things have to be true, because either alone is wrong. They
 * must be credited as a narrator on this very item — a library-wide reputation
 * is no reason to touch a book they genuinely wrote — and the library must show
 * them to be a narrator by trade, so an author reading their own work keeps
 * their credit.
 *
 * Nothing is removed if it would empty the list, and nothing is removed from a
 * list still implausibly long afterwards: a book credited to a dozen people has
 * had its cast written into the author field, and dropping the two names this
 * recognises leaves it just as wrong for extra churn.
 */
export function dropNarratorsFromAuthors(
  authors: string[],
  narrators: string[],
  consensus: Consensus,
): string[] {
  const credited = new Set(narrators.map((n) => normalizeAuthor(n)));
  const written = authors.filter((name) => {
    const key = normalizeAuthor(name);
    return !(credited.has(key) && consensus.narratorsByTrade.has(key));
  });

  if (written.length === 0 || written.length === authors.length) return authors;
  return written.length <= PLAUSIBLE_AUTHORS ? written : authors;
}

/**
 * What the item says for one field right now, written the way a proposal's
 * `from` is written.
 *
 * The two have to agree exactly, because this is what tells a change that is
 * still current from one the library has moved past since — the check `apply`
 * makes before replaying a recorded proposal onto a book someone may have
 * corrected by hand in the meantime.
 */
export function currentText(item: AbsLibraryItem, field: Normalizable): string | null {
  const metadata = item.media?.metadata;
  switch (field) {
    case 'title':
      return metadata?.title ?? null;
    case 'subtitle':
      return metadata?.subtitle ?? null;
    case 'author':
      return itemAuthors(item).join(', ') || null;
    case 'narrator':
      return itemNarrators(item).join(', ') || null;
    case 'series':
      return (metadata?.series ?? []).map((s) => s.name).filter(Boolean).join(', ') || null;
    case 'genre':
      return itemGenres(item).join(', ') || null;
    case 'tag':
      return itemTags(item).join(', ') || null;
    case 'work':
      return itemWorkKey(item);
  }
}

export function planNormalize(
  item: AbsLibraryItem,
  candidates: Candidate[],
  consensus: Consensus,
  options: NormalizeOptions,
): NormalizePlan {
  const metadata = item.media?.metadata;
  const wanted = new Set(options.fields);
  const proposals: FieldProposal[] = [];

  // Only identifier-grade matches may rewrite what someone can already read —
  // every one of them, not merely the best. See voteOn.
  const rewritable = candidates.filter((c) => c.match.score >= MATCH_MIN_REWRITE);

  if (wanted.has('title')) {
    const current = metadata?.title ?? null;
    propose(proposals, 'title', current, normalizeTitleText(current), 'local', 'article/edition text');
    const vote = voteOn(
      rewritable,
      (r) => (r.title ? normalizeTitleText(r.title) ?? r.title : null),
      normalizeTitle,
    );
    if (vote) propose(proposals, 'title', current, vote.value, 'provider', attribution(vote));
  }

  if (wanted.has('subtitle')) {
    // A source with no subtitle abstains rather than voting for an empty one,
    // which is the whole point of settling fields separately.
    const vote = voteOn(rewritable, (r) => r.subtitle ?? null, normalizeTitle);
    if (vote) {
      propose(proposals, 'subtitle', metadata?.subtitle ?? null, vote.value, 'provider', attribution(vote));
    }
  }

  if (wanted.has('author')) {
    const current = itemAuthors(item);
    const currentText = current.join(', ') || null;

    // Both local repairs compose into one proposal rather than competing as two
    // of equal rank, where the first would simply win: a book can need a
    // narrator removed from its author list *and* the remaining name put back
    // into reading order.
    const dropped = dropNarratorsFromAuthors(current, itemNarrators(item), consensus);
    const tidied = dropped.map((name) => normalizePersonName(name) ?? name);
    const detail = dropped.length === current.length ? 'name order' : 'narrator in the author field';
    propose(proposals, 'author', currentText, joinIfChanged(tidied, current), 'local', detail, tidied);

    if (!options.noConsensus && current.length > 0) {
      const agreed = current.map((name) => consensus.authors.get(normalizeAuthor(name)) ?? name);
      propose(proposals, 'author', currentText, joinIfChanged(agreed, current), 'consensus', 'library spelling', agreed);
    }

    // AudiobookShelf replaces the author list with whatever it is sent, so a
    // provider that lists fewer authors than the library would silently delete
    // the rest. Audible routinely credits only the lead author of a
    // collaboration, which makes this the common case rather than the odd one.
    const vote = voteOn(rewritable, (r) => nonEmpty(r.authors), peopleKey);
    const fromProvider = vote?.value ?? [];
    if (vote && fromProvider.length >= current.length && mayAddPeople(current, fromProvider, vote)) {
      propose(proposals, 'author', currentText, fromProvider.join(', '), 'provider', attribution(vote), fromProvider);
    }

    // Then take away the people the evidence says are not authors of this book,
    // from whichever list the tiers above settled on — so a respelling and a
    // removal land as one change rather than the stronger discarding the other.
    const settled = proposals.find((p) => p.field === 'author');
    const base = settled?.values ?? current;
    const outvoted = outvotedAuthors(base, rewritable);
    const bySeries = options.noConsensus ? null : seriesExtras(item, base, consensus, rewritable);
    const removed = new Set([...outvoted.removed, ...(bySeries?.removed ?? [])]);
    const kept = base.filter((name) => !removed.has(normalizeAuthor(name)));

    if (removed.size > 0 && kept.length > 0) {
      const reasons = [
        ...(outvoted.removed.length > 0 ? [outvoted.detail] : []),
        ...(bySeries && bySeries.removed.length > 0 ? [bySeries.detail] : []),
      ];
      const source: ProposalSource = outvoted.removed.length > 0 ? 'provider' : 'consensus';
      const to = joinIfChanged(kept, current);
      if (to) {
        // Replaces rather than competes: it already contains whatever the
        // stronger tiers decided, minus the people it has reason to remove.
        const index = proposals.findIndex((p) => p.field === 'author');
        const proposal: FieldProposal = {
          field: 'author',
          from: currentText,
          to,
          source: settled && SOURCE_RANK[settled.source] > SOURCE_RANK[source] ? settled.source : source,
          detail: [...(settled ? [settled.detail] : []), ...reasons].join('; '),
          values: kept,
        };
        if (index === -1) proposals.push(proposal);
        else proposals[index] = proposal;
      }
    }
  }

  // A reading copy has no narrator, so there is none to correct and none to
  // supply. Left unguarded this was not merely useless: an ISBN match scores
  // 0.97, above the rewrite bar, and a source that carries narrators for a
  // recording would have written an audiobook's cast onto an EPUB — plausible
  // enough that nobody would question it.
  if (wanted.has('narrator') && !isEbookOnly(item)) {
    const current = itemNarrators(item);
    const currentText = current.join(', ');
    const tidied = current.map((name) => normalizePersonName(name) ?? name);
    propose(proposals, 'narrator', currentText || null, joinIfChanged(tidied, current), 'local', 'name order', tidied);

    if (!options.noConsensus && current.length > 0) {
      const agreed = current.map((name) => consensus.narrators.get(normalizeAuthor(name)) ?? name);
      propose(proposals, 'narrator', currentText || null, joinIfChanged(agreed, current), 'consensus', 'library spelling', agreed);
    }

    const vote = voteOn(rewritable, (r) => nonEmpty(r.narrators), peopleKey);
    const narrated = vote?.value ?? [];
    if (vote && narrated.length >= current.length) {
      propose(proposals, 'narrator', currentText || null, narrated.join(', '), 'provider', attribution(vote), narrated);
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
    // The field the sources most often disagree on, and the reason the vote
    // exists: "The Mistborn Saga" and "Mistborn" are both real names for it.
    const vote = voteOn(rewritable, (r) => r.series?.name ?? null, normalizeTitle);
    if (vote) {
      const merged = current.length > 0 ? [vote.value, ...current.slice(1)] : [vote.value];
      propose(proposals, 'series', currentText, joinIfChanged(merged, current), 'provider', attribution(vote), merged);
    }
  }

  if (!options.noConsensus) {
    if (wanted.has('genre')) {
      planShared(proposals, 'genre', itemGenres(item), consensus.genres, profilesFor(item, consensus), (p) => p.genres);
    }
    if (wanted.has('tag')) {
      planShared(proposals, 'tag', itemTags(item), consensus.tags, profilesFor(item, consensus), (p) => p.tags);
    }
  }

  if (wanted.has('work') && takesWorkKey(item)) {
    // Open Library specifically: it is the only provider here that models a
    // work at all. Audnexus answers for one audio edition and Google Books for
    // one printing, so neither can say what this book *is* independently of the
    // copy in hand — which is exactly what a second server needs to agree on.
    const source = candidates.find(
      (c) => c.result.provider === 'openlibrary' && c.match.score >= MATCH_MIN_IDENTITY,
    );
    const key = workKeyFrom(source);
    if (key) propose(proposals, 'work', itemWorkKey(item), key, 'provider', 'openlibrary');
  }

  return { itemId: item.id, title: itemTitle(item), author: itemAuthor(item), proposals };
}

/**
 * Genres and tags, settled against the library and the book's series.
 *
 * Two things, composed into one proposal. The library's own spelling first —
 * "Litrpg" becomes "LitRPG" where most books write it that way — and then
 * whatever the series carries that this book is missing. Nothing is ever taken
 * away that is not respelled, so a proposal that only adds is marked additive
 * and goes through with the rewrite switch off: supplying a genre contradicts
 * nothing anyone chose.
 */
function planShared(
  proposals: FieldProposal[],
  field: 'genre' | 'tag',
  current: string[],
  spelling: Map<string, string>,
  profiles: SeriesProfile[],
  shared: (profile: SeriesProfile) => Map<string, { value: string; count: number }>,
): void {
  const next: string[] = [];
  const keys = new Set<string>();
  for (const value of current) {
    const key = normalizeTitle(value);
    if (keys.has(key)) continue;
    keys.add(key);
    next.push(spelling.get(key) ?? value);
  }
  const respelled = next.some((value, i) => value !== current[i]) || next.length !== current.length;

  const reasons: string[] = [];
  if (respelled) reasons.push('library spelling');
  for (const profile of profiles) {
    const added: string[] = [];
    for (const [key, { value, count }] of shared(profile)) {
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(spelling.get(key) ?? value);
      added.push(`${value} (${count} of ${profile.members})`);
    }
    if (added.length > 0) reasons.push(`${profile.name}: ${added.join(', ')}`);
  }
  if (reasons.length === 0) return;

  const from = current.join(', ') || null;
  const to = next.join(', ');
  if (to === from) return;
  proposals.push({
    field,
    from,
    to,
    source: 'consensus',
    detail: reasons.join('; '),
    values: next,
    ...(respelled ? {} : { additive: true }),
  });
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
  // Tags can be written by two proposals, the work identity and the series'
  // tags, so they are assembled once after both have been read.
  let userTags: string[] | null = null;
  let workKey: string | null = null;

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
      case 'genre':
        metadata.genres = values;
        break;
      case 'tag':
        userTags = values;
        break;
      case 'work':
        workKey = proposal.to;
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

  if (userTags || workKey) {
    // Every other tag survives, including the age bands `rate` writes: the
    // work proposal owns the work namespace and nothing else in it, and the
    // tag proposal owns only the tags abs-butler did not write.
    const existing = item.media?.tags ?? [];
    let tags = userTags ? [...userTags, ...existing.filter(isOwnedTag)] : [...existing];
    if (workKey) tags = [...tags.filter((t) => !t.startsWith(WORK_TAG_PREFIX)), workTag(workKey)];
    patch.tags = tags;
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
/**
 * Whether a proposal replaces something or supplies something absent.
 *
 * The switch exists to stop a value someone can already read being changed
 * underneath them. Filling an empty subtitle, or stamping a work identity on a
 * book that had none, is not that — nothing is lost and nothing a person chose
 * is contradicted. Treating the two alike meant anyone who wanted work tags for
 * a multi-server client had to consent to having their titles rewritten as
 * well, which is a bad trade and not one the guard was ever meant to force.
 */
export function isAdditive(proposal: FieldProposal): boolean {
  return isBlank(proposal.from) || proposal.additive === true;
}

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
  /** Also copy tags a series shares onto its books that lack them. */
  seriesTags?: boolean;
}

export interface NormalizeTaskResult {
  scanned: number;
  itemsToChange: number;
  fieldsToChange: number;
  /** Replacements refused because "Allow metadata rewrite" is off. */
  heldBack: number;
  /** Items whose every proposal was held back, so nothing was written to them. */
  itemsHeldBack: number;
  updated: number;
  applied: boolean;
  fields: Normalizable[];
  bySource: Record<ProposalSource, number>;
  /** How many changes each field accounts for. */
  byField: Record<string, number>;
  /** True when the run was stopped before it reached every item. */
  stopped: boolean;
  /** Items it never got to, because it was stopped. */
  notReached: number;
  plans: NormalizePlan[];
  /**
   * Exactly what was recorded against the run, one row per book — including the
   * ones that already agree. Returned as well as stored so `--details` and the
   * run's page in the web UI say the same thing.
   */
  report: RunItemInput[];
}

/**
 * One line per proposal: the old spelling, the new one, and which of the three
 * evidence tiers backs it. The tier is the thing to scan for in a dry run —
 * `provider` is an exact identifier match, `consensus` is the rest of the
 * library already spelling it the other way, `local` is only a rearrangement of
 * the wording that is already there.
 */
function normalizeDetail(plan: NormalizePlan, mayReplace: boolean, applied: boolean): string[] {
  return plan.proposals.map((proposal) => {
    const held = !mayReplace && !isAdditive(proposal);
    // Held back is neither past nor conditional — it is a refusal, and saying
    // "would change" of something that will not change however many times you
    // apply it is the misreading this line exists to prevent.
    const verb = held ? 'Held back' : applied ? 'Changed' : 'Would change';
    return (
      `${verb} ${proposal.field}: ${brief(proposal.from)} → ${brief(proposal.to, 70)} ` +
      `(${proposal.source}: ${proposal.detail})` +
      `${held ? ' — turn on Allow metadata rewrite to apply it' : ''}`
    );
  });
}

export async function runNormalizeTask(
  ctx: TaskContext,
  options: NormalizeTaskOptions = {},
): Promise<NormalizeTaskResult> {

  const requested = [...(options.fields ?? DEFAULT_NORMALIZE_FIELDS)] as Normalizable[];
  if (options.seriesTags && !requested.includes('tag')) requested.push('tag');
  const invalid = requested.filter((f) => !NORMALIZABLE.includes(f));
  if (invalid.length > 0) {
    throw new Error(`Unknown field(s): ${invalid.join(', ')}. Valid: ${NORMALIZABLE.join(', ')}`);
  }

  const deps = lookupDepsFor(ctx, options.providers);

  const libraries = await resolveLibraries(ctx, options.library);
  // Expanded: this command reads and rewrites the structured author, narrator
  // and series lists, and the minified listing carries none of them.
  const items = await collectItems(ctx, libraries, { limit: options.limit, expand: true });

  // Consensus is built from everything that was read, before any single item is
  // planned: the whole point is that one book's spelling is judged against the
  // rest of the library rather than against itself.
  const consensus = options.noConsensus ? emptyConsensus() : buildConsensus(items);
  if (!options.noConsensus) {
    log.info(
      `library disagrees with itself on ${consensus.series.size} series, ` +
        `${consensus.authors.size} author(s), ${consensus.narrators.size} narrator(s); ` +
        `${plural(consensus.bySeries.size, 'series', 'series')} to check books against`,
    );
  }

  log.info(`checking ${plural(items.length, 'item')} for ${requested.join(', ')} inconsistencies…`);

  // Partial on purpose: a run stopped partway has still judged everything up to
  // that point against the library, and those judgements are worth keeping.
  const planned = await mapLimitPartial(
    items,
    ctx.settings.providerConcurrency,
    async (item) => {
      // An item with no ISBN and no ASIN can never reach MATCH_MIN_REWRITE — a
      // fuzzy match is capped below it by design — so the lookup could not
      // change the outcome and is skipped outright. On a library ABS has not
      // matched, that makes this command entirely local and effectively free.
      const query = itemQuery(item);
      const identified = Boolean(query.asin || query.isbn);
      const wanted = new Set(requested);
      // The work tier needs Open Library whether or not the item carries an
      // identifier, since a work key is what an unidentified book most needs;
      // the rewrite tiers still ignore anything below identifier grade.
      const needsLookup = identified || (wanted.has('work') && takesWorkKey(item));
      const candidates = needsLookup ? (await lookupItem(deps, query)).candidates : [];

      return planNormalize(item, candidates, consensus, {
        fields: requested,
        ...(options.noConsensus === undefined ? {} : { noConsensus: options.noConsensus }),
      });
    },
    { signal: ctx.signal },
  );
  const plans = planned.results;
  if (planned.stopped) {
    log.warn(
      `stopped after checking ${plans.length} of ${items.length} item(s) — ` +
        `${planned.unreached} were not reached.`,
    );
  }

  const actionable = plans.filter((p) => p.proposals.length > 0);
  const fieldsToChange = actionable.reduce((sum, p) => sum + p.proposals.length, 0);

  const bySource: Record<ProposalSource, number> = { provider: 0, consensus: 0, local: 0 };
  const byField: Record<string, number> = {};
  for (const plan of actionable) {
    for (const proposal of plan.proposals) {
      bySource[proposal.source] += 1;
      byField[proposal.field] = (byField[proposal.field] ?? 0) + 1;
    }
  }

  const byId = new Map(items.map((item) => [item.id, item]));

  // With the switch off, the additive half of a plan is still applied and the
  // replacements are held back — reported, not silently dropped, so the run
  // says plainly what it declined to do and why.
  const mayReplace = ctx.settings.allowMetadataRewrite;
  const applicable = mayReplace
    ? actionable
    : actionable
        .map((plan) => ({ ...plan, proposals: plan.proposals.filter(isAdditive) }))
        .filter((plan) => plan.proposals.length > 0);
  const heldBack = fieldsToChange - applicable.reduce((sum, p) => sum + p.proposals.length, 0);
  const writable = new Set(applicable.map((plan) => plan.itemId));
  // Items where *everything* proposed was a replacement: the run has nothing
  // left to write to them, which is a different outcome from a partial hold.
  const itemsHeldBack = actionable.filter((plan) => !writable.has(plan.itemId)).length;

  // Warned in a dry run too. Held-back changes are the ones most likely to be
  // read as "it did not find anything", and finding out only on apply — after
  // reading the whole library — is late.
  if (heldBack > 0) {
    log.warn(
      `${plural(heldBack, 'change')} across ${plural(itemsHeldBack, 'item')} ` +
        `${options.apply ? 'were' : 'would be'} held back — they replace an existing value. ${REWRITE_DISABLED}`,
    );
  }

  // Which books were actually written to, so the report can tell a correction
  // that was made from one that was only ever going to be.
  const written = new Set<string>();
  let updated = 0;
  if (options.apply) {
    for (const plan of applicable) {
      // Between whole items, and an ending rather than a failure: what was
      // written stays written, and the report says which books never got there.
      if (ctx.signal?.aborted) {
        log.warn(`stopped after writing ${updated} of ${applicable.length} — the rest were left alone.`);
        break;
      }
      const item = byId.get(plan.itemId)!;
      await applyPatch(ctx, item, planToPatch(item, plan));
      written.add(plan.itemId);
      updated += 1;
      if (updated % 25 === 0) log.info(`  wrote ${updated}/${applicable.length}`);
    }
  }

  // What kind of disagreement this library has, and on what evidence. A bare
  // "412 item(s) would change" says nothing about whether that is one series
  // spelled two ways or every narrator in the library.
  if (fieldsToChange > 0) {
    log.info(
      `${plural(fieldsToChange, 'change')} across ${plural(actionable.length, 'item')} — ` +
        `${breakdown(byField, requested)}`,
    );
    log.info(
      `evidence — ${bySource.provider} from providers, ${bySource.consensus} from library ` +
        `consensus, ${bySource.local} local`,
    );
  }

  if (options.apply) {
    log.success(
      `Normalized ${plural(updated, 'item')} of ${plans.length} checked` +
        `; ${plans.length - actionable.length} already agreed.`,
    );
  } else if (actionable.length === 0) {
    log.success(`Everything already agrees — all ${plural(plans.length, 'item')} checked.`);
  } else {
    log.info(
      `${plural(actionable.length, 'item')} would change` +
        `${itemsHeldBack > 0 ? ` (${itemsHeldBack} of them held back entirely)` : ''}` +
        `; ${plans.length - actionable.length} already agree. Apply to write.`,
    );
  }

  // Every book checked, with what it disagreed with the library about — and
  // which of those the rewrite switch stopped from being written.
  const report: RunItemInput[] = plans.map((plan) => {
      const held = !mayReplace && plan.proposals.some((proposal) => !isAdditive(proposal));
      const nothingWritable = plan.proposals.length > 0 && !writable.has(plan.itemId);
      // Had something to write, and the run ended before it was written.
      const unwritten = Boolean(options.apply) && writable.has(plan.itemId) && !written.has(plan.itemId);
      return {
        itemId: plan.itemId,
        title: plan.title,
        author: plan.author,
        path: itemPath(byId.get(plan.itemId)!),
        status:
          plan.proposals.length === 0
            ? ('clean' as const)
            : nothingWritable
              ? ('skipped' as const)
              : ('action' as const),
        codes: [
          ...new Set([
            ...plan.proposals.map((proposal) => proposal.field),
            ...plan.proposals.map((proposal) => proposal.source),
            ...(held ? ['held-back'] : []),
            ...(unwritten ? ['not-written'] : []),
          ]),
        ],
        detail:
          plan.proposals.length === 0
            ? ['Already agrees with the rest of the library']
            : [
                ...normalizeDetail(plan, mayReplace, written.has(plan.itemId)),
                ...(unwritten ? ['The run was stopped before this was written'] : []),
              ],
        // The proposals, not the patch they produce: the patch is rebuilt
        // against the book as it stands when this is applied, which is what
        // keeps a series sequence and the tags outside the work namespace.
        // Held-back replacements are kept too — turning the switch on and
        // applying the report is exactly the case they exist for.
        plan:
          plan.proposals.length > 0 && !written.has(plan.itemId)
            ? { kind: 'normalize' as const, proposals: plan.proposals }
            : null,
    };
  });
  reportItems(ctx, report);

  return {
    // What it actually checked; see the note in metadata.ts.
    scanned: plans.length,
    itemsToChange: actionable.length,
    fieldsToChange,
    heldBack,
    itemsHeldBack,
    updated,
    applied: Boolean(options.apply),
    fields: requested,
    bySource,
    byField,
    stopped: planned.stopped || Boolean(ctx.signal?.aborted),
    notReached: planned.unreached,
    plans: actionable,
    report,
  };
}
