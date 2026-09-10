import { describe, expect, it, afterEach, vi } from 'vitest';
import { AudioSiloProvider, splitNames, unslug } from './audiosilo.js';

/** `/api/v1/works/{id}`, trimmed to the fields the provider reads. */
const WORK = {
  id: 'project-hail-mary',
  title: 'Project Hail Mary',
  authors: [{ id: 'andy-weir', name: 'Andy Weir' }],
  language: 'en',
  first_published: '2021-05-04',
  description: 'A community write-up that must never be read.',
  genres: ['hard-science-fiction', 'space-opera'],
  series: [{ id: 's', name: 'Hail Mary', position: '1' }],
  recordings: [
    {
      id: 'ray-porter-2021',
      narrators: [{ id: 'ray-porter', name: 'Ray Porter' }],
      runtime_min: 970,
      release_date: '2021-05-04',
      publisher: 'Audible Studios',
      asin: [
        { region: 'us', asin: 'B08G9PRS1K' },
        { region: 'uk', asin: 'B08GB2RLKM' },
      ],
      isbn: ['9781250774293'],
    },
    {
      id: 'william-angiuli-2024',
      narrators: [{ id: 'william-angiuli', name: 'William Angiuli' }],
      release_date: '2024-02-05',
      publisher: 'Mondadori',
      asin: [{ region: 'de', asin: 'B0CTZYCZW7' }],
      isbn: [],
    },
  ],
};

/** One `/abs/search` match: AudiobookShelf's shape, not this API's. */
const ABS_MATCH = {
  title: 'The Hunger Games',
  author: 'Suzanne Collins',
  narrator: 'Tatiana Maslany, Carolyn McCormick',
  publisher: 'Scholastic Audio',
  publishedYear: '2018',
  asin: 'B07HHH7L77',
  genres: ['Action Adventure', 'Dystopian', 'Young Adult'],
  series: [
    { series: 'Hunger Games', sequence: '1' },
    { series: 'The Hunger Games', sequence: '1' },
  ],
  language: 'en',
  duration: 636,
};

function stubFetch(...responses: Array<unknown | { status: number }>) {
  const urls: string[] = [];
  let call = 0;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    urls.push(String(url));
    const next = responses[Math.min(call++, responses.length - 1)];
    if (next && typeof next === 'object' && 'status' in next && Object.keys(next).length === 1) {
      return new Response('{"error":"not found"}', { status: (next as { status: number }).status });
    }
    return new Response(JSON.stringify(next), { status: 200 });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unslug', () => {
  // The JSON API serves slugs and /abs/search serves labels for one vocabulary,
  // so the same book has to yield the same signal text either way.
  it('turns a slug into the label the other endpoint would have sent', () => {
    expect(unslug('hard-science-fiction')).toBe('Hard Science Fiction');
    expect(unslug('childrens')).toBe('Childrens');
  });
});

describe('splitNames', () => {
  it('splits the comma-joined list back into names', () => {
    expect(splitNames('Eric Carle, Kevin R. Free')).toEqual(['Eric Carle', 'Kevin R. Free']);
  });

  it('has nothing to say about nothing', () => {
    expect(splitNames(undefined)).toBeUndefined();
    expect(splitNames(' , ')).toBeUndefined();
  });
});

describe('AudioSiloProvider', () => {
  /**
   * The reason this provider is worth two requests: /abs/search publishes only
   * the US ASIN, so a library matched against Audible UK would never match on
   * identifier. Resolving it here is what earns the score `normalize` needs
   * before it will rewrite a narrator.
   */
  it('resolves an ASIN from any marketplace to one exact narration', async () => {
    const urls = stubFetch({ work: { id: 'project-hail-mary' }, recording_id: 'ray-porter-2021' }, WORK);
    const [result] = await new AudioSiloProvider().search({
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      asin: 'B08GB2RLKM',
    });

    expect(urls[0]).toContain('/api/v1/lookup?asin=B08GB2RLKM');
    expect(urls[1]).toContain('/api/v1/works/project-hail-mary');
    expect(result).toMatchObject({
      provider: 'audiosilo',
      // The identifier that was asked about, because the lookup established it
      // names this recording — which is what scoring needs to call it exact.
      providerId: 'B08GB2RLKM',
      title: 'Project Hail Mary',
      authors: ['Andy Weir'],
      narrators: ['Ray Porter'],
      series: { name: 'Hail Mary', sequence: '1' },
      publisher: 'Audible Studios',
      publishedYear: '2021',
      isbn: '9781250774293',
      language: 'en',
      genres: ['Hard Science Fiction', 'Space Opera'],
      url: 'https://meta.audiosilo.app/works/project-hail-mary',
    });
  });

  // The whole point of the work/recording split: two narrations, one answer.
  it('picks the narration the identifier named, not the first one', async () => {
    stubFetch({ work: { id: 'project-hail-mary' }, recording_id: 'william-angiuli-2024' }, WORK);
    const [result] = await new AudioSiloProvider().search({ title: 'x', asin: 'B0CTZYCZW7' });

    expect(result!.narrators).toEqual(['William Angiuli']);
    expect(result!.publisher).toBe('Mondadori');
    expect(result!.publishedYear).toBe('2024');
    expect(result!.isbn).toBeUndefined();
  });

  it('falls back to the first narration when the named one is missing', async () => {
    stubFetch({ work: { id: 'project-hail-mary' }, recording_id: 'gone' }, WORK);
    const [result] = await new AudioSiloProvider().search({ title: 'x', asin: 'B0000000AA' });
    expect(result!.narrators).toEqual(['Ray Porter']);
  });

  /**
   * Community descriptions are CC BY-SA. Writing one into a library would put
   * that person's metadata under a share-alike licence they never chose, and
   * they exist for well under 1% of works — so they are never read, from either
   * endpoint.
   */
  it('never reads a description', async () => {
    stubFetch({ work: { id: 'project-hail-mary' }, recording_id: 'ray-porter-2021' }, WORK);
    const [result] = await new AudioSiloProvider().search({ title: 'x', asin: 'B08G9PRS1K' });
    expect(result!.description).toBeUndefined();
  });

  it('searches by title, author and ISBN when there is no ASIN', async () => {
    const urls = stubFetch({ matches: [ABS_MATCH] });
    const [result] = await new AudioSiloProvider().search({
      title: 'The Hunger Games',
      author: 'Suzanne Collins',
      isbn: '9780439023481',
    });

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/abs/search');
    expect(url.searchParams.get('query')).toBe('The Hunger Games');
    expect(url.searchParams.get('author')).toBe('Suzanne Collins');
    expect(url.searchParams.get('isbn')).toBe('9780439023481');

    expect(result).toMatchObject({
      providerId: 'B07HHH7L77',
      authors: ['Suzanne Collins'],
      // Comma-joined on the wire, because that is AudiobookShelf's own shape.
      narrators: ['Tatiana Maslany', 'Carolyn McCormick'],
      series: { name: 'Hunger Games', sequence: '1' },
      publishedYear: '2018',
      genres: ['Action Adventure', 'Dystopian', 'Young Adult'],
    });
  });

  it('searches by title when the database has never heard of the ASIN', async () => {
    const urls = stubFetch({ status: 404 }, { matches: [ABS_MATCH] });
    const results = await new AudioSiloProvider().search({
      title: 'The Hunger Games',
      asin: 'B0NOTHERE1',
    });

    expect(urls[0]).toContain('/api/v1/lookup');
    expect(urls[1]).toContain('/abs/search');
    expect(results).toHaveLength(1);
  });

  it('weighs its genres as curated, not as crowd shelving', async () => {
    stubFetch({ matches: [ABS_MATCH] });
    const [result] = await new AudioSiloProvider().search({ title: 'The Hunger Games' });
    expect(result!.signals).toContainEqual({
      source: 'audiosilo:genre',
      value: 'Young Adult',
      weight: 0.8,
    });
  });

  it('drops matches that came back without a title', async () => {
    stubFetch({ matches: [{ author: 'Nobody' }, ABS_MATCH] });
    const results = await new AudioSiloProvider().search({ title: 'The Hunger Games' });
    expect(results).toHaveLength(1);
  });

  it('makes no request at all with nothing to ask about', async () => {
    const urls = stubFetch({ matches: [] });
    await expect(new AudioSiloProvider().search({ title: '  ' })).resolves.toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
