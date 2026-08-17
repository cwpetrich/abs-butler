import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, planMove, renderTemplate } from './organize.js';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';

const vars = {
  author: 'Brandon Sanderson',
  title: 'The Way of Kings',
  series: 'The Stormlight Archive',
  sequence: '01',
  year: '2010',
};

describe('renderTemplate', () => {
  it('renders the full series layout', () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, vars)).toBe(
      'Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings',
    );
  });

  it('collapses the series folder and separator for a standalone book', () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, { ...vars, series: '', sequence: '' })).toBe(
      'Brandon Sanderson/The Way of Kings',
    );
  });

  it('supports custom templates', () => {
    expect(renderTemplate('{author}/{title} ({year})', vars)).toBe(
      'Brandon Sanderson/The Way of Kings (2010)',
    );
  });

  it('drops unknown placeholders instead of leaving them literal', () => {
    expect(renderTemplate('{author}/{nope}{title}', vars)).toBe('Brandon Sanderson/The Way of Kings');
  });
});

const library: AbsLibrary = {
  id: 'lib-1',
  name: 'Audiobooks',
  mediaType: 'book',
  provider: 'audible',
  folders: [{ id: 'f1', fullPath: '/audiobooks', libraryId: 'lib-1' }],
};

function item(overrides: Partial<AbsLibraryItem> = {}): AbsLibraryItem {
  return {
    id: 'item-1',
    libraryId: 'lib-1',
    folderId: 'f1',
    path: '/audiobooks/misc/kings',
    relPath: 'misc/kings',
    isFile: false,
    mediaType: 'book',
    isMissing: false,
    isInvalid: false,
    media: {
      id: 'media-1',
      coverPath: null,
      tags: [],
      metadata: {
        title: 'The Way of Kings',
        subtitle: null,
        authorName: 'Brandon Sanderson',
        series: [{ id: 's1', name: 'The Stormlight Archive', sequence: '1' }],
        publishedYear: '2010',
        publishedDate: null,
        publisher: null,
        description: null,
        isbn: null,
        asin: null,
        language: null,
        explicit: false,
      },
    },
    ...overrides,
  };
}

describe('planMove', () => {
  it('plans a move to the templated path', () => {
    const plan = planMove(item(), library, DEFAULT_TEMPLATE, {});
    expect(plan?.to).toBe('Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings');
    expect(plan?.toAbsolute).toBe(
      '/audiobooks/Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings',
    );
  });

  it('returns null when the item is already in place', () => {
    const inPlace = item({ relPath: 'Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings' });
    expect(planMove(inPlace, library, DEFAULT_TEMPLATE, {})).toBeNull();
  });

  it('translates container paths to host paths', () => {
    const plan = planMove(item(), library, DEFAULT_TEMPLATE, {
      absPathPrefix: '/audiobooks',
      libraryRoot: '/mnt/media/books',
    });
    expect(plan?.fromAbsolute).toBe('/mnt/media/books/misc/kings');
    expect(plan?.toAbsolute).toBe(
      '/mnt/media/books/Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings',
    );
  });
});
