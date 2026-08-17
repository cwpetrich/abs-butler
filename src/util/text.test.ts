import { describe, expect, it } from 'vitest';
import { normalizeAuthor, normalizeTitle, padSequence, sanitizePathSegment } from './text.js';

describe('normalizeTitle', () => {
  it('strips articles, case, punctuation, and edition noise', () => {
    expect(normalizeTitle('The Hobbit')).toBe('hobbit');
    expect(normalizeTitle('the hobbit (Unabridged)')).toBe('hobbit');
    expect(normalizeTitle("Harry Potter & the Sorcerer's Stone")).toBe(
      'harry potter the sorcerer s stone',
    );
  });

  // Regression: sort-friendly titles are the most common duplicate form, and
  // "Hobbit, The" previously normalized to "hobbit the" — never matching "hobbit".
  it('treats sort-friendly trailing articles as equivalent', () => {
    expect(normalizeTitle('Hobbit, The (Unabridged)')).toBe(normalizeTitle('The Hobbit'));
    expect(normalizeTitle('Wind in the Willows, The')).toBe(normalizeTitle('The Wind in the Willows'));
    expect(normalizeTitle('Christmas Carol, A')).toBe(normalizeTitle('A Christmas Carol'));
  });

  it('keeps an interior article that is part of the title', () => {
    expect(normalizeTitle('The Wind in the Willows')).toBe('wind in the willows');
  });

  it('folds accents so imported and local titles match', () => {
    expect(normalizeTitle('Les Misérables')).toBe(normalizeTitle('Les Miserables'));
  });

  it('handles empty input', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle('')).toBe('');
  });
});

describe('normalizeAuthor', () => {
  it('treats "Last, First" and "First Last" as the same author', () => {
    expect(normalizeAuthor('King, Stephen')).toBe('stephen king');
    expect(normalizeAuthor('Stephen King')).toBe('stephen king');
  });

  it('keeps only the primary author from a list', () => {
    expect(normalizeAuthor('Neil Gaiman & Terry Pratchett')).toBe('neil gaiman');
    expect(normalizeAuthor('Neil Gaiman and Terry Pratchett')).toBe('neil gaiman');
  });
});

describe('sanitizePathSegment', () => {
  it('replaces separators and reserved characters', () => {
    expect(sanitizePathSegment('Fire & Blood: Part 1/2')).toBe('Fire & Blood- Part 1-2');
  });

  it('drops trailing dots and spaces that break Windows shares', () => {
    expect(sanitizePathSegment('Book Title. ')).toBe('Book Title');
  });

  it('falls back to Unknown rather than an empty segment', () => {
    expect(sanitizePathSegment('///')).toBe('---');
    expect(sanitizePathSegment('   ')).toBe('Unknown');
  });

  it('truncates very long segments', () => {
    expect(sanitizePathSegment('a'.repeat(300)).length).toBe(120);
  });
});

describe('padSequence', () => {
  it('pads numbers so they sort correctly', () => {
    expect(padSequence('2')).toBe('02');
    expect(padSequence('10')).toBe('10');
    expect(padSequence('1.5')).toBe('01.5');
  });

  it('passes through non-numeric and empty sequences', () => {
    expect(padSequence('Prequel')).toBe('Prequel');
    expect(padSequence(null)).toBe('');
  });
});
