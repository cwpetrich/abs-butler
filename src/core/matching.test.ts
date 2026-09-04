import { describe, expect, it } from 'vitest';
import {
  compareAuthors,
  pickBest,
  scoreCandidate,
  titleSimilarity,
  MATCH_MIN_REWRITE,
} from './matching.js';
import type { BookQuery, ProviderResult } from '../providers/types.js';

function result(partial: Partial<ProviderResult>): ProviderResult {
  return { provider: 'test', signals: [], ...partial };
}

const hobbit: BookQuery = {
  title: 'The Hobbit',
  author: 'J.R.R. Tolkien',
  isbn: null,
  asin: null,
};

describe('titleSimilarity', () => {
  it('treats sort-order and natural titles as the same book', () => {
    expect(titleSimilarity('Hobbit, The', 'The Hobbit')).toBe(1);
  });

  it('ignores edition noise', () => {
    expect(titleSimilarity('The Hobbit (Unabridged)', 'The Hobbit')).toBe(1);
  });

  // The bug this whole module replaces: a prefix test in either direction let
  // a boxed set match one of the books inside it.
  it('does not match a collection that merely starts with the same words', () => {
    const score = titleSimilarity(
      'The Hobbit',
      'The Hobbit and the Lord of the Rings Collection',
    );
    expect(score).toBeLessThan(0.6);
  });

  it('is zero when either side is empty', () => {
    expect(titleSimilarity('', 'The Hobbit')).toBe(0);
    expect(titleSimilarity('The Hobbit', null)).toBe(0);
  });
});

describe('compareAuthors', () => {
  it('matches across name order', () => {
    expect(compareAuthors('Tolkien, J.R.R.', ['J.R.R. Tolkien'])).toBe('exact');
  });

  it('matches on surname when the given names are written differently', () => {
    expect(compareAuthors('J.R.R. Tolkien', ['John Ronald Reuel Tolkien'])).toBe('surname');
  });

  it('rejects a different author', () => {
    expect(compareAuthors('J.R.R. Tolkien', ['Terry Pratchett'])).toBe('none');
  });

  // Distinct from 'none': one is a failed check, the other is no check at all,
  // and only the first should reject a candidate.
  it('reports unknown when there is nothing to compare', () => {
    expect(compareAuthors(null, ['J.R.R. Tolkien'])).toBe('unknown');
    expect(compareAuthors('J.R.R. Tolkien', [])).toBe('unknown');
  });
});

describe('scoreCandidate', () => {
  it('scores an ASIN match at full confidence', () => {
    const match = scoreCandidate(
      { ...hobbit, asin: 'B002V0QMPQ' },
      result({ providerId: 'B002V0QMPQ', title: 'Something Else Entirely' }),
    );
    expect(match.basis).toBe('asin');
    expect(match.score).toBe(1);
  });

  it('does not confuse an ASIN with an ISBN', () => {
    const match = scoreCandidate(
      { ...hobbit, asin: 'B002V0QMPQ' },
      result({ isbn: '9780261102217', title: 'The Hobbit', authors: ['J.R.R. Tolkien'] }),
    );
    expect(match.basis).toBe('fuzzy');
  });

  it('scores an ISBN match on the identifier alone', () => {
    const match = scoreCandidate(
      { ...hobbit, isbn: '978-0-261-10221-7' },
      result({ isbn: '9780261102217' }),
    );
    expect(match.basis).toBe('isbn');
    expect(match.score).toBeGreaterThan(0.9);
  });

  it('rejects a candidate whose author disagrees', () => {
    const match = scoreCandidate(hobbit, result({ title: 'The Hobbit', authors: ['Terry Pratchett'] }));
    expect(match.score).toBe(0);
  });

  it('rejects a candidate whose title is a different book', () => {
    const match = scoreCandidate(hobbit, result({ title: 'The Silmarillion', authors: ['J.R.R. Tolkien'] }));
    expect(match.score).toBe(0);
  });

  // The guarantee normalize leans on: no amount of textual agreement earns the
  // right to rewrite a title someone can see.
  it('never lets a fuzzy match reach the rewrite threshold', () => {
    const match = scoreCandidate(hobbit, result({ title: 'The Hobbit', authors: ['J.R.R. Tolkien'] }));
    expect(match.basis).toBe('fuzzy');
    expect(match.score).toBeLessThan(MATCH_MIN_REWRITE);
  });

  it('accepts a fuzzy match with no local author, but scores it lower', () => {
    const titled = { ...hobbit, author: null };
    const unknown = scoreCandidate(titled, result({ title: 'The Hobbit', authors: ['J.R.R. Tolkien'] }));
    const agreed = scoreCandidate(hobbit, result({ title: 'The Hobbit', authors: ['J.R.R. Tolkien'] }));
    expect(unknown.score).toBeGreaterThan(0);
    expect(unknown.score).toBeLessThan(agreed.score);
  });
});

describe('pickBest', () => {
  it('prefers the identifier match over a better-looking title', () => {
    const best = pickBest({ ...hobbit, isbn: '9780261102217' }, [
      result({ title: 'The Hobbit', authors: ['J.R.R. Tolkien'] }),
      result({ title: 'The Hobbit: Illustrated', isbn: '9780261102217' }),
    ]);
    expect(best?.match.basis).toBe('isbn');
  });

  it('returns null when nothing clears the floor', () => {
    expect(pickBest(hobbit, [result({ title: 'Mistborn', authors: ['Brandon Sanderson'] })])).toBeNull();
  });

  it('returns null for an empty result set', () => {
    expect(pickBest(hobbit, [])).toBeNull();
  });
});
