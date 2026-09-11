import { describe, expect, it } from 'vitest';
import type { AbsLibraryItem } from '../abs/types.js';
import {
  buildConsensus,
  itemAuthors,
  itemNarrators,
  normalizePersonName,
  normalizeTitleText,
  pickConsensus,
  planNormalize,
  planToPatch,
  splitPeople,
  isAdditive,
  dropNarratorsFromAuthors,
  findNarratorsByTrade,
  itemWorkKey,
  voteOn,
  workKeyFrom,
  WORK_TAG_PREFIX,
  type Consensus,
} from './normalize.js';
import type { Candidate } from './matching.js';

function book(partial: {
  id?: string;
  title?: string | null;
  subtitle?: string | null;
  authorName?: string | null;
  authors?: Array<{ id: string; name: string }>;
  narratorName?: string | null;
  narrators?: string[];
  series?: Array<{ id: string; name: string; sequence: string | null }>;
}): AbsLibraryItem {
  return {
    id: partial.id ?? 'item-1',
    libraryId: 'lib',
    folderId: 'folder',
    path: '/audiobooks/x',
    relPath: 'x',
    isFile: false,
    mediaType: 'book',
    isMissing: false,
    isInvalid: false,
    media: {
      id: 'media',
      coverPath: null,
      tags: [],
      metadata: {
        title: partial.title ?? 'A Book',
        subtitle: partial.subtitle ?? null,
        authorName: partial.authorName ?? null,
        ...(partial.authors ? { authors: partial.authors } : {}),
        narratorName: partial.narratorName ?? null,
        ...(partial.narrators ? { narrators: partial.narrators } : {}),
        ...(partial.series ? { series: partial.series } : {}),
        publishedYear: null,
        publisher: null,
        description: null,
        isbn: null,
        asin: null,
        language: null,
        explicit: false,
      },
    },
  } as AbsLibraryItem;
}

const noConsensus: Consensus = {
  series: new Map(),
  authors: new Map(),
  narrators: new Map(),
  narratorsByTrade: new Set(),
};

function trusted(partial: Record<string, unknown>): Candidate {
  return {
    result: { provider: 'audnexus', signals: [], ...partial },
    match: { score: 1, basis: 'asin', reasons: ['ASIN matched'] },
  } as Candidate;
}

describe('normalizeTitleText', () => {
  it('restores an article moved to the end for sorting', () => {
    expect(normalizeTitleText('Hobbit, The')).toBe('The Hobbit');
  });

  it('strips format markers that describe the file, not the book', () => {
    expect(normalizeTitleText('The Hobbit (Unabridged)')).toBe('The Hobbit');
    expect(normalizeTitleText('Dune [Audiobook]')).toBe('Dune');
  });

  // Audible appends this to nearly everything it sells, and the series field
  // already carries the number — writing it into the title too is a regression
  // on whatever the library had before.
  it('strips a trailing series position', () => {
    expect(normalizeTitleText("Harry Potter and the Sorcerer's Stone, Book 1")).toBe(
      "Harry Potter and the Sorcerer's Stone",
    );
    expect(normalizeTitleText('Mistborn, Vol. 2')).toBe('Mistborn');
  });

  it('does not truncate a title that merely ends in a word like Book', () => {
    expect(normalizeTitleText('The Book Thief')).toBeNull();
    expect(normalizeTitleText('The Neverending Story, Book of Wishes')).toBeNull();
  });

  it('leaves an already-clean title alone', () => {
    expect(normalizeTitleText('The Hobbit')).toBeNull();
  });

  it('does not touch a comma that is part of the title', () => {
    expect(normalizeTitleText('Goodbye, Mr. Chips')).toBeNull();
  });
});

describe('normalizePersonName', () => {
  it('puts an inverted name back in reading order', () => {
    expect(normalizePersonName('King, Stephen')).toBe('Stephen King');
  });

  it('leaves a suffix alone rather than reading it as a given name', () => {
    expect(normalizePersonName('Martin Luther King, Jr.')).toBeNull();
  });

  // Which comma inverts is genuinely ambiguous with two people, so neither does.
  it('refuses to guess with more than one comma', () => {
    expect(normalizePersonName('Pratchett, Terry, Gaiman, Neil')).toBeNull();
  });

  // Two co-authors sharing one record. Swapping the halves would fuse them
  // into a person who never existed, and ABS would then drop the other.
  it('refuses to invert what is really two people', () => {
    expect(normalizePersonName('William Strauss, Neil Howe')).toBeNull();
    expect(normalizePersonName('Sally Clarkson, Sarah Clarkson')).toBeNull();
  });

  it('still inverts an ordinary surname-first name', () => {
    expect(normalizePersonName("L'amour, Louis")).toBe("Louis L'amour");
    expect(normalizePersonName('Tolkien, J.R.R.')).toBe('J.R.R. Tolkien');
  });

  it('leaves a name already in reading order alone', () => {
    expect(normalizePersonName('Stephen King')).toBeNull();
  });
});

describe('splitPeople', () => {
  it('splits on unambiguous separators only', () => {
    expect(splitPeople('Terry Pratchett & Neil Gaiman')).toEqual(['Terry Pratchett', 'Neil Gaiman']);
    expect(splitPeople('Jim Dale and Stephen Fry')).toEqual(['Jim Dale', 'Stephen Fry']);
  });

  it('keeps an inverted single name whole', () => {
    expect(splitPeople('King, Stephen')).toEqual(['King, Stephen']);
  });
});

describe('pickConsensus', () => {
  it('picks the spelling the library uses most', () => {
    const winners = pickConsensus([
      'The Stormlight Archive',
      'The Stormlight Archive',
      'The Stormlight Archive',
      'Stormlight Archive',
    ]);
    expect(winners.get('stormlight archive')).toBe('The Stormlight Archive');
  });

  it('breaks a tie toward the fuller name', () => {
    const winners = pickConsensus(['Stormlight Archive', 'The Stormlight Archive']);
    expect(winners.get('stormlight archive')).toBe('The Stormlight Archive');
  });

  // One consistent spelling is not a disagreement, and proposing a change there
  // would mean rewriting a whole library to match itself.
  it('proposes nothing when every book already agrees', () => {
    expect(pickConsensus(['Mistborn', 'Mistborn']).size).toBe(0);
  });
});

describe('buildConsensus', () => {
  // Name order is a local repair, so both spellings canonicalize to the same
  // form and there is no disagreement left for consensus to settle.
  it('leaves a pure name-order difference to the local tier', () => {
    const consensus = buildConsensus([
      book({ id: '1', authors: [{ id: 'a', name: 'Stephen King' }] }),
      book({ id: '2', authors: [{ id: 'a', name: 'Stephen King' }] }),
      book({ id: '3', authors: [{ id: 'a', name: 'King, Stephen' }] }),
    ]);
    expect(consensus.authors.get('stephen king')).toBeUndefined();
  });

  // What consensus is actually for: spellings no rule can choose between,
  // settled by what the rest of the library already does.
  it('elects the majority spelling where no local rule can decide', () => {
    const consensus = buildConsensus([
      book({ id: '1', authors: [{ id: 'a', name: 'H.G. Wells' }] }),
      book({ id: '2', authors: [{ id: 'a', name: 'H.G. Wells' }] }),
      book({ id: '3', authors: [{ id: 'a', name: 'H. G. Wells' }] }),
    ]);
    expect(consensus.authors.get('h g wells')).toBe('H.G. Wells');
  });

  // The inverted form is longer, so a tie-break on length alone would elect it
  // and then rewrite the correct books to match.
  it('never elects a sort-order name over a reading-order one', () => {
    const consensus = buildConsensus([
      book({ id: '1', authors: [{ id: 'a', name: 'L. Frank Baum' }] }),
      book({ id: '2', authors: [{ id: 'a', name: 'Baum, L. Frank' }] }),
    ]);
    expect(consensus.authors.get('l frank baum')).not.toBe('Baum, L. Frank');
  });
});

describe('itemNarrators', () => {
  it('prefers the structured list', () => {
    expect(itemNarrators(book({ narrators: ['Jim Dale'], narratorName: 'ignored' }))).toEqual(['Jim Dale']);
  });

  it('falls back to the joined string', () => {
    expect(itemNarrators(book({ narratorName: 'Jim Dale & Stephen Fry' }))).toEqual([
      'Jim Dale',
      'Stephen Fry',
    ]);
  });

  it('yields nothing from a flattened narrator list containing a comma', () => {
    expect(itemNarrators(book({ narratorName: 'Dale, Jim' }))).toEqual([]);
  });
});

describe('planNormalize', () => {
  it('proposes a local title repair with no provider at all', () => {
    const plan = planNormalize(book({ title: 'Hobbit, The' }), [], noConsensus, {
      fields: ['title'],
    });
    expect(plan.proposals).toEqual([
      expect.objectContaining({ field: 'title', to: 'The Hobbit', source: 'local' }),
    ]);
  });

  // ABS resolves a series by name, case-insensitively, so this write would be
  // accepted and change nothing — and be proposed again on every later run.
  it('does not propose a series rename that differs only by case', () => {
    const consensus: Consensus = {
      ...noConsensus,
      series: new Map([['barsoom', 'Barsoom']]),
    };
    const plan = planNormalize(
      book({ series: [{ id: 's1', name: 'barsoom', sequence: '3' }] }),
      [],
      consensus,
      { fields: ['series'] },
    );
    expect(plan.proposals).toEqual([]);
  });

  it('does not propose an author rename that differs only by case', () => {
    const consensus: Consensus = {
      ...noConsensus,
      authors: new Map([['jrr tolkien', 'J.R.R. TOLKIEN']]),
    };
    const item = book({ authors: [{ id: 'a1', name: 'J.R.R. Tolkien' }] });
    const plan = planNormalize(item, [], consensus, { fields: ['author'] });
    expect(plan.proposals).toEqual([]);
  });

  it('adopts the library consensus spelling of a series', () => {
    const consensus: Consensus = {
      ...noConsensus,
      series: new Map([['stormlight archive', 'The Stormlight Archive']]),
    };
    const plan = planNormalize(
      book({ series: [{ id: 's1', name: 'Stormlight Archive', sequence: '1' }] }),
      [],
      consensus,
      { fields: ['series'] },
    );
    expect(plan.proposals).toEqual([
      expect.objectContaining({ field: 'series', to: 'The Stormlight Archive', source: 'consensus' }),
    ]);
  });

  it('lets a provider answer outrank a local rearrangement of the old value', () => {
    const plan = planNormalize(
      book({ title: 'Hobbit, The' }),
      [trusted({ title: 'The Hobbit: A Tale' })],
      noConsensus,
      { fields: ['title'] },
    );
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]).toMatchObject({ source: 'provider', to: 'The Hobbit: A Tale' });
  });

  // A fuzzy match scores below MATCH_MIN_REWRITE by construction, so a
  // provider that merely looks right must not reach the title at all.
  it('ignores a provider match that is not identifier-grade', () => {
    const weak: Candidate = {
      result: { provider: 'openlibrary', signals: [], title: 'The Hobbit, or There and Back Again' },
      match: { score: 0.85, basis: 'fuzzy', reasons: [] },
    };
    const plan = planNormalize(book({ title: 'The Hobbit' }), [weak], noConsensus, { fields: ['title'] });
    expect(plan.proposals).toEqual([]);
  });

  it('takes the narrator list from an identified provider match', () => {
    const plan = planNormalize(
      book({ narratorName: 'Dale, Jim' }),
      [trusted({ narrators: ['Jim Dale'] })],
      noConsensus,
      { fields: ['narrator'] },
    );
    expect(plan.proposals[0]).toMatchObject({ field: 'narrator', to: 'Jim Dale', source: 'provider' });
  });

  /**
   * The failure this prevents is quiet and convincing: an ISBN match scores
   * 0.97, above the rewrite bar, and a source carrying narrators for a
   * recording would have written an audiobook's cast onto an EPUB. Nobody
   * inspecting the library afterwards would think to question it.
   */
  it('never offers a narrator to a reading copy', () => {
    const epub = book({ narratorName: null });
    (epub.media as { ebookFormat?: string }).ebookFormat = 'epub';

    const plan = planNormalize(epub, [trusted({ narrators: ['Jim Dale'] })], noConsensus, {
      fields: ['narrator'],
    });
    expect(plan.proposals).toEqual([]);
  });

  it('still offers one to an audiobook that has an ebook beside it', () => {
    const both = book({ narratorName: 'Dale, Jim' });
    (both.media as { ebookFormat?: string; numTracks?: number }).ebookFormat = 'epub';
    (both.media as { numTracks?: number }).numTracks = 7;

    const plan = planNormalize(both, [trusted({ narrators: ['Jim Dale'] })], noConsensus, {
      fields: ['narrator'],
    });
    expect(plan.proposals[0]).toMatchObject({ field: 'narrator', to: 'Jim Dale' });
  });

  it('proposes nothing for a book that is already consistent', () => {
    const plan = planNormalize(book({ title: 'The Hobbit', authorName: 'J.R.R. Tolkien' }), [], noConsensus, {
      fields: [...(['title', 'author', 'narrator', 'series'] as const)],
    });
    expect(plan.proposals).toEqual([]);
  });

  it('honours the requested field list', () => {
    // Structured authors, not the flattened name: a comma in the flat form is
    // ambiguous and deliberately yields nothing, which would mask the point.
    const item = book({ title: 'Hobbit, The', authors: [{ id: 'a1', name: 'King, Stephen' }] });
    const plan = planNormalize(item, [], noConsensus, { fields: ['author'] });
    expect(plan.proposals.map((p) => p.field)).toEqual(['author']);
    expect(plan.proposals[0]).toMatchObject({ to: 'Stephen King', values: ['Stephen King'] });
  });
});

describe('planToPatch', () => {
  // No id is sent: ABS resolves a series by name and creates it when new, so
  // the sequence is the only thing worth carrying across.
  it('keeps the existing sequence when renaming a series', () => {
    const item = book({ series: [{ id: 'series-1', name: 'Stormlight Archive', sequence: '2' }] });
    const patch = planToPatch(item, {
      itemId: item.id,
      title: 'x',
      author: null,
      proposals: [
        { field: 'series', from: 'Stormlight Archive', to: 'The Stormlight Archive', source: 'consensus', detail: 'library spelling', values: ['The Stormlight Archive'] },
      ],
    });
    expect(patch.metadata?.series).toEqual([
      { name: 'The Stormlight Archive', sequence: '2' },
    ]);
  });

  it('sends authors as objects and narrators as strings, the way ABS models them', () => {
    const item = book({});
    const patch = planToPatch(item, {
      itemId: item.id,
      title: 'x',
      author: null,
      proposals: [
        { field: 'author', from: 'King, Stephen', to: 'Stephen King', source: 'local', detail: 'name order', values: ['Stephen King'] },
        { field: 'narrator', from: null, to: 'Jim Dale, Stephen Fry', source: 'provider', detail: 'audnexus', values: ['Jim Dale', 'Stephen Fry'] },
      ],
    });
    expect(patch.metadata?.authors).toEqual([{ name: 'Stephen King' }]);
    expect(patch.metadata?.narrators).toEqual(['Jim Dale', 'Stephen Fry']);
  });

  // ABS replaces these lists with whatever arrives, so recovering them by
  // splitting the display text on commas would delete a person outright.
  it('never splits a name apart to recover the list', () => {
    const item = book({});
    const patch = planToPatch(item, {
      itemId: item.id,
      title: 'x',
      author: null,
      proposals: [
        {
          field: 'author',
          from: 'King, Martin Luther, Jr.',
          to: 'Martin Luther King, Jr.',
          source: 'local',
          detail: 'name order',
          values: ['Martin Luther King, Jr.'],
        },
      ],
    });
    expect(patch.metadata?.authors).toEqual([{ name: 'Martin Luther King, Jr.' }]);
  });
});

describe('itemAuthors', () => {
  it('returns every author, not just the display name', () => {
    const item = book({
      authors: [
        { id: 'a1', name: 'Terry Pratchett' },
        { id: 'a2', name: 'Neil Gaiman' },
      ],
      authorName: 'Terry Pratchett & Neil Gaiman',
    });
    expect(itemAuthors(item)).toEqual(['Terry Pratchett', 'Neil Gaiman']);
  });

  it('falls back to splitting the joined name on an unambiguous separator', () => {
    expect(itemAuthors(book({ authorName: 'Terry Pratchett & Neil Gaiman' }))).toEqual([
      'Terry Pratchett',
      'Neil Gaiman',
    ]);
  });

  // ABS joins co-authors with ", " and people write single names as
  // "Last, First". Nothing distinguishes them, and either misreading edits the
  // wrong number of people into a list ABS replaces wholesale.
  it('yields nothing from a flattened name containing a comma', () => {
    expect(itemAuthors(book({ authorName: 'Mark Twain, Charles Dudley Warner' }))).toEqual([]);
    expect(itemAuthors(book({ authorName: 'Twain, Mark' }))).toEqual([]);
  });
});

// The whole class of bug this shape exists to prevent: ABS deletes anything
// the patch does not mention, so a proposal must always carry the full list.
describe('planNormalize preserves collaborators', () => {
  it('keeps a co-author when fixing the spelling of the other', () => {
    const consensus: Consensus = {
      ...noConsensus,
      authors: new Map([['terry pratchett', 'Terry Pratchett']]),
    };
    const item = book({
      authors: [
        { id: 'a1', name: 'Pratchett, Terry' },
        { id: 'a2', name: 'Neil Gaiman' },
      ],
    });
    const plan = planNormalize(item, [], consensus, { fields: ['author'] });
    const patch = planToPatch(item, plan);
    expect(patch.metadata?.authors).toEqual([
      { name: 'Terry Pratchett' },
      { name: 'Neil Gaiman' },
    ]);
  });

  // Audible commonly credits only the lead author of a collaboration.
  it('refuses a provider author list shorter than the library has', () => {
    const item = book({
      authors: [
        { id: 'a1', name: 'Terry Pratchett' },
        { id: 'a2', name: 'Neil Gaiman' },
      ],
    });
    const plan = planNormalize(item, [trusted({ authors: ['Terry Pratchett'] })], noConsensus, {
      fields: ['author'],
    });
    expect(plan.proposals).toEqual([]);
  });

  it('keeps a second series when renaming the first', () => {
    const consensus: Consensus = {
      ...noConsensus,
      series: new Map([['stormlight archive', 'The Stormlight Archive']]),
    };
    const item = book({
      series: [
        { id: 's1', name: 'Stormlight Archive', sequence: '1' },
        { id: 's2', name: 'The Cosmere', sequence: '4' },
      ],
    });
    const plan = planNormalize(item, [], consensus, { fields: ['series'] });
    const patch = planToPatch(item, plan);
    expect(patch.metadata?.series).toEqual([
      { name: 'The Stormlight Archive', sequence: '1' },
      { name: 'The Cosmere', sequence: '4' },
    ]);
  });
});

describe('voting across sources', () => {
  /** An identifier-grade match, the only kind allowed to rewrite anything. */
  const src = (provider: string, result: Partial<Candidate['result']>): Candidate => ({
    result: { provider, signals: [], ...result },
    match: { score: 1, basis: 'asin', reasons: [] },
  });

  const name = (v: string | null | undefined) => v ?? null;
  const same = (v: string) => v.toLowerCase();

  it('takes the value the most sources gave', () => {
    const vote = voteOn(
      [
        src('audible', { title: 'The Mistborn Saga' }),
        src('audiosilo', { title: 'Mistborn' }),
        src('audnexus', { title: 'Mistborn' }),
      ],
      (r) => name(r.title),
      same,
    );
    expect(vote).toEqual({ value: 'Mistborn', providers: ['audiosilo', 'audnexus'] });
  });

  // The configured order is the tie-break, not the decision.
  it('falls back to the most trusted source when nothing is agreed', () => {
    const vote = voteOn(
      [src('audible', { title: 'A' }), src('audiosilo', { title: 'B' })],
      (r) => name(r.title),
      same,
    );
    expect(vote).toEqual({ value: 'A', providers: ['audible'] });
  });

  it('keeps the winning form from the most trusted source that said it', () => {
    const vote = voteOn(
      [
        src('audible', { title: 'THE HOBBIT' }),
        src('audiosilo', { title: 'the hobbit' }),
        src('audnexus', { title: 'Something Else' }),
      ],
      (r) => name(r.title),
      same,
    );
    expect(vote!.value).toBe('THE HOBBIT');
    expect(vote!.providers).toEqual(['audible', 'audiosilo']);
  });

  it('lets a source abstain rather than vote for nothing', () => {
    const vote = voteOn(
      [src('audible', {}), src('audiosilo', { title: 'Mistborn' })],
      (r) => name(r.title),
      same,
    );
    expect(vote).toEqual({ value: 'Mistborn', providers: ['audiosilo'] });
  });

  it('has no answer when nobody does', () => {
    expect(voteOn([src('audible', {})], (r) => name(r.title), same)).toBeNull();
    expect(voteOn([], (r) => name(r.title), same)).toBeNull();
  });
});

describe('planNormalize across several sources', () => {
  const src = (provider: string, result: Partial<Candidate['result']>, score = 1): Candidate => ({
    result: { provider, signals: [], ...result },
    match: { score, basis: score === 1 ? 'asin' : 'fuzzy', reasons: [] },
  });

  /**
   * The hazard field-level settling exists for: AudioSilo carries no subtitles,
   * and under the old single-winner rule a reordering of the provider list
   * would have replaced a correct subtitle with nothing.
   */
  it('does not let a source with no subtitle erase one', () => {
    const plan = planNormalize(
      book({ subtitle: 'Wrong Subtitle' }),
      [src('audiosilo', { title: 'A Book' }), src('audible', { title: 'A Book', subtitle: 'Book One' })],
      noConsensus,
      { fields: ['subtitle'] },
    );
    expect(plan.proposals).toEqual([
      expect.objectContaining({ field: 'subtitle', to: 'Book One', source: 'provider' }),
    ]);
  });

  it('renames a series to what two of three sources call it', () => {
    const series = (n: string) => ({ name: n });
    const plan = planNormalize(
      book({ series: [{ id: 's', name: 'Mistborn Saga', sequence: '1' }] }),
      [
        src('audible', { series: series('The Mistborn Saga') }),
        src('audiosilo', { series: series('Mistborn') }),
        src('audnexus', { series: series('Mistborn') }),
      ],
      noConsensus,
      { fields: ['series'] },
    );
    expect(plan.proposals[0]).toMatchObject({
      field: 'series',
      to: 'Mistborn',
      source: 'provider',
      detail: 'audiosilo + audnexus',
    });
  });

  // Counting sources must not become a way in for answers that never
  // identified the book: only matches past MATCH_MIN_REWRITE get a vote.
  it('gives no vote to a source that only matched on the title', () => {
    const plan = planNormalize(
      book({ title: 'A Book' }),
      [
        src('audible', { title: 'A Book' }),
        src('audiosilo', { title: 'A Different Book' }, 0.85),
        src('audnexus', { title: 'A Different Book' }, 0.85),
      ],
      noConsensus,
      { fields: ['title'] },
    );
    expect(plan.proposals).toEqual([]);
  });

  it('still reports a single source as itself', () => {
    const plan = planNormalize(
      book({ narrators: ['Wrong Person'] }),
      [src('audible', { narrators: ['Michael Kramer'] })],
      noConsensus,
      { fields: ['narrator'] },
    );
    expect(plan.proposals[0]).toMatchObject({ to: 'Michael Kramer', detail: 'audible' });
  });
});

describe('work identity', () => {
  const olCandidate = (score: number, key = '/works/OL27482W'): Candidate => ({
    result: { provider: 'openlibrary', signals: [], providerId: key, title: 'The Hobbit' },
    match: { score, basis: 'fuzzy', reasons: [] },
  })

  it('reads a work key back off an item', () => {
    const item = book({})
    item.media.tags = ['fiction', `${WORK_TAG_PREFIX}OL27482W`]
    expect(itemWorkKey(item)).toBe('OL27482W')
    expect(itemWorkKey(book({}))).toBeNull()
  })

  it('takes the bare key out of Open Library\'s path form', () => {
    expect(workKeyFrom(olCandidate(1))).toBe('OL27482W')
  })

  // Audnexus answers for one audio edition and Google Books for one printing,
  // so neither can say what the book is independently of the copy in hand.
  it('ignores a provider that does not model works', () => {
    const audnexus: Candidate = {
      result: { provider: 'audnexus', signals: [], providerId: 'B017V4IM1G' },
      match: { score: 1, basis: 'asin', reasons: [] },
    }
    expect(workKeyFrom(audnexus)).toBeNull()
  })

  it('proposes a work tag from a confident Open Library match', () => {
    const plan = planNormalize(book({}), [olCandidate(0.85)], noConsensus, { fields: ['work'] })
    expect(plan.proposals[0]).toMatchObject({ field: 'work', to: 'OL27482W', source: 'provider' })
  })

  // A wrong identity is shared across every server that reads it, so this bar
  // sits above the one for filling a blank description.
  it('refuses a match too weak to assert an identity on', () => {
    const plan = planNormalize(book({}), [olCandidate(0.73)], noConsensus, { fields: ['work'] })
    expect(plan.proposals).toEqual([])
  })

  it('writes the tag without disturbing the ones rate owns', () => {
    const item = book({})
    item.media.tags = ['fiction', 'age:middle-grade', 'abs-butler:rated']
    const patch = planToPatch(item, {
      itemId: item.id, title: 'x', author: null,
      proposals: [{ field: 'work', from: null, to: 'OL27482W', source: 'provider', detail: 'openlibrary' }],
    })
    expect(patch.tags).toEqual(['fiction', 'age:middle-grade', 'abs-butler:rated', `${WORK_TAG_PREFIX}OL27482W`])
  })

  it('replaces an existing work tag rather than adding a second', () => {
    const item = book({})
    item.media.tags = [`${WORK_TAG_PREFIX}OL999W`]
    const patch = planToPatch(item, {
      itemId: item.id, title: 'x', author: null,
      proposals: [{ field: 'work', from: 'OL999W', to: 'OL27482W', source: 'provider', detail: 'openlibrary' }],
    })
    expect(patch.tags).toEqual([`${WORK_TAG_PREFIX}OL27482W`])
  })
})

describe('isAdditive', () => {
  // The switch guards changing a value someone can read, not supplying a
  // missing one — so work tags do not require consenting to title rewrites.
  it('treats supplying a missing value as additive', () => {
    expect(isAdditive({ field: 'work', from: null, to: 'OL1W', source: 'provider', detail: 'x' })).toBe(true)
    expect(isAdditive({ field: 'series', from: '', to: 'Barsoom', source: 'provider', detail: 'x' })).toBe(true)
  })

  it('treats changing an existing value as a replacement', () => {
    expect(isAdditive({ field: 'title', from: 'Hobbit, The', to: 'The Hobbit', source: 'local', detail: 'x' })).toBe(false)
  })
})

describe('narrators in the author field', () => {
  const byTrade = (...names: string[]): Consensus => ({
    ...noConsensus,
    narratorsByTrade: new Set(names.map((n) => n.toLowerCase())),
  })

  it('drops a narrator credited as an author', () => {
    const kept = dropNarratorsFromAuthors(
      ['Nick Podehl', 'Andrew Rowe'],
      ['Nick Podehl'],
      byTrade('nick podehl'),
    )
    expect(kept).toEqual(['Andrew Rowe'])
  })

  // Measured against two live servers: without the second signal this rule
  // removed Michael Greger from How Not to Die, Gabor Maté from Hold On to Your
  // Kids, and Ken Albala from his own lecture course.
  it('keeps an author who narrated their own book', () => {
    const kept = dropNarratorsFromAuthors(
      ['Michael Greger', 'Gene Stone'],
      ['Michael Greger'],
      byTrade(), // narrates one book: his own
    )
    expect(kept).toEqual(['Michael Greger', 'Gene Stone'])
  })

  it('never empties the author list', () => {
    const kept = dropNarratorsFromAuthors(['Jason Culp'], ['Jason Culp'], byTrade('jason culp'))
    expect(kept).toEqual(['Jason Culp'])
  })

  // A whole cast written into the author field is wrong in a way this cannot
  // fix, and shuffling it would be churn.
  it('leaves an implausibly long author list alone', () => {
    const cast = ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'Dakota Krout']
    const kept = dropNarratorsFromAuthors(cast, ['A One'], byTrade('a one'))
    expect(kept).toEqual(cast)
  })

  it('does not touch a book the person genuinely wrote', () => {
    // Credited as a narrator elsewhere, but not on this item.
    const kept = dropNarratorsFromAuthors(['Chugong'], [], byTrade('chugong'))
    expect(kept).toEqual(['Chugong'])
  })
})

describe('findNarratorsByTrade', () => {
  it('counts who reads many books and writes almost none', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) =>
        book({ id: `n${i}`, narrators: ['Nick Podehl'], authors: [{ id: 'a', name: 'Andrew Rowe' }] }),
      ),
      book({ id: 'x', authors: [{ id: 'p', name: 'Nick Podehl' }] }),
    ]
    const byTrade = findNarratorsByTrade(items)
    expect(byTrade.has('nick podehl')).toBe(true)
    expect(byTrade.has('andrew rowe')).toBe(false)
  })

  it('does not count someone who mostly narrates their own work', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      book({ id: `g${i}`, narrators: ['Michael Greger'], authors: [{ id: 'g', name: 'Michael Greger' }] }),
    )
    expect(findNarratorsByTrade(items).has('michael greger')).toBe(false)
  })
})
