import { describe, expect, it } from 'vitest';
import { AudnexusProvider, languageCode, normalizeAsin } from './audnexus.js';

describe('normalizeAsin', () => {
  it('accepts a bare ASIN in either case', () => {
    expect(normalizeAsin('b017v4im1g')).toBe('B017V4IM1G');
  });

  // A wrong ASIN does not fail — it confidently returns a different book's
  // narrator, which is the worst possible outcome for this provider.
  it('rejects anything that is not one', () => {
    expect(normalizeAsin('https://audible.com/pd/B017V4IM1G')).toBeNull();
    expect(normalizeAsin('9780261102217')).toBeNull(); // an ISBN is 13 characters
    expect(normalizeAsin('')).toBeNull();
    expect(normalizeAsin(null)).toBeNull();
  });
});

describe('languageCode', () => {
  it('maps a language name to a code', () => {
    expect(languageCode('english')).toBe('en');
    expect(languageCode('German')).toBe('de');
  });

  it('drops anything it cannot map rather than writing a guess', () => {
    expect(languageCode('esperanto')).toBeUndefined();
    expect(languageCode(undefined)).toBeUndefined();
  });
});

describe('AudnexusProvider', () => {
  it('answers nothing at all without an ASIN, making no request', async () => {
    const provider = new AudnexusProvider();
    await expect(provider.search({ title: 'The Hobbit', author: 'J.R.R. Tolkien' })).resolves.toEqual(
      [],
    );
  });
});
