import { describe, expect, it } from 'vitest';
import type { AbsLibraryItem } from '../abs/types.js';
import {
  buildConsensus,
  itemNarrators,
  normalizePersonName,
  normalizeTitleText,
  pickConsensus,
  planNormalize,
  planToPatch,
  splitPeople,
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

const noConsensus: Consensus = { series: new Map(), authors: new Map(), narrators: new Map() };

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
  it('groups author spellings across name order', () => {
    const consensus = buildConsensus([
      book({ id: '1', authorName: 'Stephen King' }),
      book({ id: '2', authorName: 'Stephen King' }),
      book({ id: '3', authorName: 'King, Stephen' }),
    ]);
    expect(consensus.authors.get('stephen king')).toBe('Stephen King');
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
});

describe('planNormalize', () => {
  it('proposes a local title repair with no provider at all', () => {
    const plan = planNormalize(book({ title: 'Hobbit, The' }), null, noConsensus, {
      fields: ['title'],
    });
    expect(plan.proposals).toEqual([
      expect.objectContaining({ field: 'title', to: 'The Hobbit', source: 'local' }),
    ]);
  });

  it('adopts the library consensus spelling of a series', () => {
    const consensus: Consensus = {
      ...noConsensus,
      series: new Map([['stormlight archive', 'The Stormlight Archive']]),
    };
    const plan = planNormalize(
      book({ series: [{ id: 's1', name: 'Stormlight Archive', sequence: '1' }] }),
      null,
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
      trusted({ title: 'The Hobbit: A Tale' }),
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
    const plan = planNormalize(book({ title: 'The Hobbit' }), weak, noConsensus, { fields: ['title'] });
    expect(plan.proposals).toEqual([]);
  });

  it('takes the narrator list from an identified provider match', () => {
    const plan = planNormalize(
      book({ narratorName: 'Dale, Jim' }),
      trusted({ narrators: ['Jim Dale'] }),
      noConsensus,
      { fields: ['narrator'] },
    );
    expect(plan.proposals[0]).toMatchObject({ field: 'narrator', to: 'Jim Dale', source: 'provider' });
  });

  it('proposes nothing for a book that is already consistent', () => {
    const plan = planNormalize(book({ title: 'The Hobbit', authorName: 'J.R.R. Tolkien' }), null, noConsensus, {
      fields: [...(['title', 'author', 'narrator', 'series'] as const)],
    });
    expect(plan.proposals).toEqual([]);
  });

  it('honours the requested field list', () => {
    const plan = planNormalize(book({ title: 'Hobbit, The', authorName: 'King, Stephen' }), null, noConsensus, {
      fields: ['author'],
    });
    expect(plan.proposals.map((p) => p.field)).toEqual(['author']);
  });
});

describe('planToPatch', () => {
  it('keeps the existing series id and sequence when renaming it', () => {
    const item = book({ series: [{ id: 'series-1', name: 'Stormlight Archive', sequence: '2' }] });
    const patch = planToPatch(item, {
      itemId: item.id,
      title: 'x',
      author: null,
      proposals: [
        { field: 'series', from: 'Stormlight Archive', to: 'The Stormlight Archive', source: 'consensus', detail: 'library spelling' },
      ],
    });
    expect(patch.metadata?.series).toEqual([
      { id: 'series-1', name: 'The Stormlight Archive', sequence: '2' },
    ]);
  });

  it('sends authors as objects and narrators as strings, the way ABS models them', () => {
    const item = book({});
    const patch = planToPatch(item, {
      itemId: item.id,
      title: 'x',
      author: null,
      proposals: [
        { field: 'author', from: 'King, Stephen', to: 'Stephen King', source: 'local', detail: 'name order' },
        { field: 'narrator', from: null, to: 'Jim Dale, Stephen Fry', source: 'provider', detail: 'audnexus' },
      ],
    });
    expect(patch.metadata?.authors).toEqual([{ name: 'Stephen King' }]);
    expect(patch.metadata?.narrators).toEqual(['Jim Dale', 'Stephen Fry']);
  });
});
