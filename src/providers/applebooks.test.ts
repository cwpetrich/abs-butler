import { describe, expect, it, afterEach, vi } from 'vitest';
import { AppleBooksProvider } from './applebooks.js';

/** One `/search?media=ebook` hit, trimmed to the fields the provider reads. */
const HIT = {
  trackId: 953141184,
  trackName: 'The Final Empire',
  artistName: 'Brandon Sanderson',
  description: '<b>From #1 <i>New York Times</i> bestselling author.</b><br />A heist.',
  releaseDate: '2006-07-17T07:00:00Z',
  genres: ['Epic Fantasy', 'Books', 'Sci-Fi & Fantasy', 'Fantasy'],
  averageUserRating: 4.5,
  userRatingCount: 1344,
  trackViewUrl: 'https://books.apple.com/us/book/x/id953141184',
};

function stub(body: unknown, status = 200): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppleBooksProvider', () => {
  it('needs no configuration at all', () => {
    expect(new AppleBooksProvider().isAvailable()).toBe(true);
  });

  it('searches the ebook catalogue by title and author', async () => {
    const urls = stub({ resultCount: 1, results: [HIT] });
    await new AppleBooksProvider().search({ title: 'The Final Empire', author: 'Brandon Sanderson' });

    const url = new URL(urls[0]!);
    expect(url.searchParams.get('term')).toBe('The Final Empire Brandon Sanderson');
    // Ebooks even for audiobooks: Apple's audiobook records carry one genre,
    // its ebook records carry a dozen, and categories are why it is queried.
    expect(url.searchParams.get('media')).toBe('ebook');
    expect(url.searchParams.get('country')).toBe('us');
  });

  it('maps a hit onto the common result shape', async () => {
    stub({ resultCount: 1, results: [HIT] });
    const [result] = await new AppleBooksProvider().search({ title: 'The Final Empire' });

    expect(result).toMatchObject({
      provider: 'applebooks',
      providerId: '953141184',
      title: 'The Final Empire',
      authors: ['Brandon Sanderson'],
      publishedYear: '2006',
      averageRating: 4.5,
      ratingsCount: 1344,
    });
  });

  it('strips the HTML Apple puts in a description', async () => {
    stub({ resultCount: 1, results: [HIT] });
    const [result] = await new AppleBooksProvider().search({ title: 'x' });
    expect(result!.description).toBe('From #1 New York Times bestselling author.\nA heist.');
  });

  it('drops the genres that are true of every book', async () => {
    stub({ resultCount: 1, results: [HIT] });
    const [result] = await new AppleBooksProvider().search({ title: 'x' });
    // "Books" is on everything, so it distinguishes nothing and only dilutes
    // the specific labels beside it.
    expect(result!.genres).toEqual(['Epic Fantasy', 'Sci-Fi & Fantasy', 'Fantasy']);
  });

  /**
   * Measured, not assumed. Apple's categories looked like the best audience
   * data going and made age banding worse: 3/8 against Open Library's 4/8,
   * with The Very Hungry Caterpillar and Goodnight Moon pushed to middle-grade,
   * because Apple files everything from board books to age twelve under "Kids".
   */
  it('emits no content signals, so it cannot move an age band', async () => {
    stub({ resultCount: 1, results: [HIT] });
    const [result] = await new AppleBooksProvider().search({ title: 'x' });
    expect(result!.signals).toEqual([]);
    // The genres still travel for display; they are just not `subjects`, which
    // is what the age rules read.
    expect(result!.genres).not.toHaveLength(0);
    expect(result!.subjects).toBeUndefined();
  });

  it('falls back to the single genre an audiobook record carries', async () => {
    stub({
      resultCount: 1,
      results: [{ trackName: 'A Book', primaryGenreName: 'Kids & Young Adults' }],
    });
    const [result] = await new AppleBooksProvider().search({ title: 'x' });
    expect(result!.genres).toEqual(['Kids & Young Adults']);
  });

  it('deduplicates genres that differ only in case', async () => {
    stub({ resultCount: 1, results: [{ trackName: 'A Book', genres: ['Fantasy', 'fantasy'] }] });
    const [result] = await new AppleBooksProvider().search({ title: 'x' });
    expect(result!.genres).toEqual(['Fantasy']);
  });

  it('never claims an identifier, so it can never rewrite a field', async () => {
    stub({ resultCount: 1, results: [HIT] });
    const [result] = await new AppleBooksProvider().search({ title: 'x' });
    // Apple publishes no ISBN and no ASIN. Scoring caps a fuzzy match below the
    // rewrite threshold, which is the whole reason this provider is safe to
    // enable by default.
    expect(result!.isbn).toBeUndefined();
    expect(result!.narrators).toBeUndefined();
  });

  it('asks for nothing when there is no title', async () => {
    const urls = stub({ resultCount: 0, results: [] });
    expect(await new AppleBooksProvider().search({ title: '' })).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('returns nothing rather than throwing when Apple has no match', async () => {
    stub({ resultCount: 0, results: [] });
    expect(await new AppleBooksProvider().search({ title: 'nothing' })).toEqual([]);
  });

  it('skips a result with no usable name', async () => {
    stub({ resultCount: 2, results: [{ trackId: 1 }, HIT] });
    const results = await new AppleBooksProvider().search({ title: 'x' });
    expect(results).toHaveLength(1);
  });

  it('honours a different storefront', async () => {
    const urls = stub({ resultCount: 0, results: [] });
    await new AppleBooksProvider('de').search({ title: 'x' });
    expect(new URL(urls[0]!).searchParams.get('country')).toBe('de');
  });
});
