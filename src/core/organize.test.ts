import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, movePath, planMove, renderTemplate, runOrganizeTask } from './organize.js';
import type { TaskContext } from '../context.js';
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

const localServer = { libraryRoot: '/audiobooks', pathPrefix: null };

describe('planMove', () => {
  it('plans a move to the templated path', () => {
    const plan = planMove(item(), library, DEFAULT_TEMPLATE, localServer);
    expect(plan?.to).toBe('Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings');
    expect(plan?.toLocal).toBe(
      '/audiobooks/Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings',
    );
  });

  it('returns null when the item is already in place', () => {
    const inPlace = item({ relPath: 'Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings' });
    expect(planMove(inPlace, library, DEFAULT_TEMPLATE, localServer)).toBeNull();
  });

  it('translates container paths to host paths', () => {
    const plan = planMove(item(), library, DEFAULT_TEMPLATE, {
      pathPrefix: '/audiobooks',
      libraryRoot: '/mnt/media/books',
    });
    expect(plan?.fromLocal).toBe('/mnt/media/books/misc/kings');
    expect(plan?.toLocal).toBe(
      '/mnt/media/books/Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings',
    );
  });

  // An API-only server has no local path, so there is nothing to move.
  it('returns null when no library root is configured', () => {
    expect(planMove(item(), library, DEFAULT_TEMPLATE, { libraryRoot: null, pathPrefix: null })).toBeNull();
  });
});

describe('movePath', () => {
  it('moves a book directory to its new home, creating the parents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-move-'));
    const from = join(root, 'loose-book');
    mkdirSync(from);
    writeFileSync(join(from, 'book.m4b'), 'audio');

    const to = join(root, 'Sanderson', 'Stormlight', '01 - The Way of Kings');
    await movePath(from, to);

    expect(statSync(join(to, 'book.m4b')).isFile()).toBe(true);
  });

  // The whole point of mkdirInheriting: without it these come out at the
  // process umask, and under a root daemon at root ownership too.
  it('gives new parent directories the library root\'s permissions, not the umask', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-inherit-'));
    const library = join(root, 'library');
    mkdirSync(library);
    // setgid + group-write is the usual shape of a shared media directory, and
    // exactly what a plain mkdir would drop.
    chmodSync(library, 0o2775);

    const from = join(root, 'incoming');
    mkdirSync(from);
    writeFileSync(join(from, 'book.m4b'), 'audio');

    await movePath(from, join(library, 'Sanderson', 'Stormlight', '01 - The Way of Kings'));

    const author = statSync(join(library, 'Sanderson'));
    const series = statSync(join(library, 'Sanderson', 'Stormlight'));
    expect(author.mode & 0o7777).toBe(0o2775);
    expect(series.mode & 0o7777).toBe(0o2775);
  });

  it('leaves existing parent directories alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-existing-'));
    const author = join(root, 'Sanderson');
    mkdirSync(author);
    chmodSync(author, 0o700);

    const from = join(root, 'incoming');
    mkdirSync(from);
    writeFileSync(join(from, 'book.m4b'), 'audio');

    await movePath(from, join(author, 'The Way of Kings'));

    expect(statSync(author).mode & 0o7777).toBe(0o700);
  });
});

describe('the file-changes guard', () => {
  // The client throws on any call, so reaching it at all is the failure.
  function contextRefusingRequests(allowFileChanges: boolean): TaskContext {
    return {
      settings: { allowFileChanges },
      client: {
        listLibraries: () => {
          throw new Error('reached the network');
        },
      },
    } as unknown as TaskContext;
  }

  it('refuses an apply before reading anything when file changes are off', async () => {
    await expect(runOrganizeTask(contextRefusingRequests(false), { apply: true })).rejects.toThrow(
      /File changes are turned off/,
    );
  });

  // A dry run is still worth doing while the guard is on, so it must pass
  // through — proven here by it getting far enough to attempt a request.
  it('lets a dry run proceed while file changes are off', async () => {
    await expect(runOrganizeTask(contextRefusingRequests(false), { apply: false })).rejects.toThrow(
      /reached the network/,
    );
  });

  it('lets an apply proceed once file changes are allowed', async () => {
    await expect(runOrganizeTask(contextRefusingRequests(true), { apply: true })).rejects.toThrow(
      /reached the network/,
    );
  });
});
