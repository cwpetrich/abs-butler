import { describe, expect, it, afterEach, vi } from 'vitest';
import { AudibleProvider, ladderCategories, languageCode, normalizeAsin, plainText } from './audible.js';

/** Shaped like a real response, trimmed to the fields the provider reads. */
const CATERPILLAR = {
  asin: 'B08XYZ1234',
  title: 'The Very Hungry Caterpillar',
  subtitle: 'And Other Stories',
  authors: [{ asin: 'A1', name: 'Eric Carle' }],
  narrators: [{ name: 'Kevin R. Free' }],
  series: [{ asin: 'S1', title: 'World of Eric Carle', sequence: '1' }],
  publisher_name: 'Listening Library',
  publisher_summary: '<p>A caterpillar eats <b>a great deal</b>.</p><p>Then &amp; only then, a butterfly.</p>',
  release_date: '2021-03-02',
  language: 'english',
  runtime_length_min: 9,
  is_adult_product: false,
  rating: { overall_distribution: { average_rating: 4.8, num_ratings: 1200 } },
  category_ladders: [
    {
      root: 'Genres',
      ladder: [
        { id: '1', name: "Children's Audiobooks" },
        { id: '2', name: 'Literature & Fiction' },
        { id: '3', name: 'Chapter Books & Readers' },
        { id: '4', name: 'Early Readers' },
      ],
    },
    {
      root: 'Genres',
      ladder: [
        { id: '1', name: "Children's Audiobooks" },
        { id: '5', name: 'Animals & Nature' },
      ],
    },
  ],
};

/** Records every URL asked for, and answers with whatever the test queued. */
function stubFetch(...bodies: unknown[]) {
  const urls: string[] = [];
  let call = 0;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    urls.push(String(url));
    const body = bodies[Math.min(call++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeAsin', () => {
  it('accepts a bare ASIN in either case', () => {
    expect(normalizeAsin('b017v4im1g')).toBe('B017V4IM1G');
  });

  it('rejects anything that is not one', () => {
    expect(normalizeAsin('https://audible.com/pd/B017V4IM1G')).toBeNull();
    expect(normalizeAsin('9780261102217')).toBeNull();
    expect(normalizeAsin(null)).toBeNull();
  });
});

describe('languageCode', () => {
  it('maps a language name to a code and drops what it cannot map', () => {
    expect(languageCode('english')).toBe('en');
    expect(languageCode('esperanto')).toBeUndefined();
  });
});

describe('plainText', () => {
  // `description` is written straight into a field AudiobookShelf shows as
  // text, so markup arriving there is markup a person reads.
  it('strips markup and decodes entities', () => {
    expect(plainText('<p>Salt &amp; pepper</p>')).toBe('Salt & pepper');
    expect(plainText('a<br>b')).toBe('a\nb');
    expect(plainText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
  });

  it('has nothing to say about nothing', () => {
    expect(plainText(undefined)).toBeUndefined();
    expect(plainText('<p></p>')).toBeUndefined();
  });
});

describe('ladderCategories', () => {
  it('separates what a book was filed under from the shelf above it', () => {
    const { all, leaves } = ladderCategories(CATERPILLAR.category_ladders);
    expect(leaves).toEqual(['Early Readers', 'Animals & Nature']);
    expect(all).toContain("Children's Audiobooks");
    // Named by both ladders, listed once.
    expect(all.filter((c) => c === "Children's Audiobooks")).toHaveLength(1);
  });

  it('copes with an empty or absent ladder', () => {
    expect(ladderCategories(undefined)).toEqual({ all: [], leaves: [] });
    expect(ladderCategories([{ ladder: [] }])).toEqual({ all: [], leaves: [] });
  });
});

describe('AudibleProvider', () => {
  it('looks an ASIN up directly and maps the edition', async () => {
    const urls = stubFetch({ product: CATERPILLAR });
    const [result] = await new AudibleProvider('us').search({
      title: 'The Very Hungry Caterpillar',
      author: 'Eric Carle',
      asin: 'B08XYZ1234',
    });

    expect(urls[0]).toContain('api.audible.com/1.0/catalog/products/B08XYZ1234');
    expect(result).toMatchObject({
      provider: 'audible',
      // What lets scoreCandidate call this an exact edition match.
      providerId: 'B08XYZ1234',
      title: 'The Very Hungry Caterpillar',
      subtitle: 'And Other Stories',
      authors: ['Eric Carle'],
      narrators: ['Kevin R. Free'],
      series: { name: 'World of Eric Carle', sequence: '1' },
      publisher: 'Listening Library',
      publishedYear: '2021',
      language: 'en',
      maturityRating: 'NOT_MATURE',
      averageRating: 4.8,
      ratingsCount: 1200,
      url: 'https://www.audible.com/pd/B08XYZ1234',
    });
    expect(result!.description).toBe('A caterpillar eats a great deal.\n\nThen & only then, a butterfly.');
  });

  // The node a book was filed under has to be able to outvote the shelf it sits
  // on: "Early Readers" is nested under "Chapter Books & Readers", and equal
  // weighting banded a picture book as middle grade.
  it('weighs the leaf above the nodes it hangs from', async () => {
    stubFetch({ product: CATERPILLAR });
    const [result] = await new AudibleProvider().search({ title: 'x', asin: 'B08XYZ1234' });

    const weight = (value: string) => result!.signals.find((s) => s.value === value)?.weight;
    expect(weight('Early Readers')).toBe(0.9);
    expect(weight('Chapter Books & Readers')).toBe(0.55);
    expect(weight("Children's Audiobooks")).toBe(0.55);
  });

  it('claims nothing about maturity for an ordinary book, and says so for an adult one', async () => {
    stubFetch({ product: { ...CATERPILLAR, is_adult_product: true } });
    const [adult] = await new AudibleProvider().search({ title: 'x', asin: 'B08XYZ1234' });
    expect(adult!.signals).toContainEqual({ source: 'audible:adult', value: 'MATURE', weight: 0.95 });

    stubFetch({ product: CATERPILLAR });
    const [ordinary] = await new AudibleProvider().search({ title: 'x', asin: 'B08XYZ1234' });
    expect(ordinary!.signals.some((s) => s.source === 'audible:adult')).toBe(false);
  });

  it('searches by title and author when there is no ASIN', async () => {
    const urls = stubFetch({ products: [CATERPILLAR] });
    const results = await new AudibleProvider('us').search({
      title: 'The Very Hungry Caterpillar',
      author: 'Eric Carle',
    });

    const url = new URL(urls[0]!);
    expect(url.searchParams.get('title')).toBe('The Very Hungry Caterpillar');
    expect(url.searchParams.get('author')).toBe('Eric Carle');
    expect(results).toHaveLength(1);
  });

  /**
   * Audible answers 200 with a stub product for an ASIN it does not know, which
   * is how a book sold in another marketplace looks. Falling through to the
   * title search is what keeps that book from losing its audiobook data
   * entirely; scoring reads the different edition as fuzzy, so it can fill a
   * blank but never rename anything.
   */
  it('falls back to a title search when the ASIN is unknown here', async () => {
    const urls = stubFetch({ product: { asin: 'B0NOTHERE1' } }, { products: [CATERPILLAR] });
    const results = await new AudibleProvider().search({
      title: 'The Very Hungry Caterpillar',
      author: 'Eric Carle',
      asin: 'B0NOTHERE1',
    });

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('title=The+Very+Hungry+Caterpillar');
    expect(results).toHaveLength(1);
  });

  it('asks the marketplace it was configured for', async () => {
    const urls = stubFetch({ products: [] });
    await new AudibleProvider('de').search({ title: 'Dune' });
    expect(urls[0]).toContain('api.audible.de');
  });

  it('falls back to the US marketplace for a region it does not know', async () => {
    const urls = stubFetch({ products: [] });
    await new AudibleProvider('zz').search({ title: 'Dune' });
    expect(urls[0]).toContain('api.audible.com');
  });

  it('drops products that came back without a title', async () => {
    stubFetch({ products: [{ asin: 'B1' }, CATERPILLAR] });
    const results = await new AudibleProvider().search({ title: 'The Very Hungry Caterpillar' });
    expect(results).toHaveLength(1);
  });

  it('makes no request at all with nothing to ask about', async () => {
    const urls = stubFetch({ products: [] });
    await expect(new AudibleProvider().search({ title: '   ' })).resolves.toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
