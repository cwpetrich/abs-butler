import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  movePath,
  planMove,
  planMoveOutcome,
  renderTemplate,
  runOrganizeTask,
} from './organize.js';
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

  /**
   * A bare `The Hobbit.m4b` in a library root is a perfectly ordinary
   * AudiobookShelf item, and for many libraries it is most of them.
   */
  it('gives a loose file the folder the template describes', () => {
    const loose = item({ relPath: 'kings.m4b', path: '/audiobooks/kings.m4b', isFile: true });
    const plan = planMove(loose, library, DEFAULT_TEMPLATE, localServer);

    expect(plan?.to).toBe(
      'Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings/The Way of Kings.m4b',
    );
    expect(plan?.fromFile).toBe(true);
  });

  it('names the file from the title, not from the folder it lands in', () => {
    const loose = item({ relPath: 'kings.m4b', path: '/audiobooks/kings.m4b', isFile: true });
    // Not "01 - The Way of Kings.m4b" inside "01 - The Way of Kings/".
    expect(planMove(loose, library, DEFAULT_TEMPLATE, localServer)?.to.split('/').pop()).toBe(
      'The Way of Kings.m4b',
    );
  });

  it('keeps whatever extension the file had', () => {
    const epub = item({ relPath: 'kings.epub', path: '/audiobooks/kings.epub', isFile: true });
    expect(planMove(epub, library, DEFAULT_TEMPLATE, localServer)?.to.endsWith('.epub')).toBe(true);
  });

  it('leaves an extensionless file alone rather than inventing a type', () => {
    const odd = item({ relPath: 'kings', path: '/audiobooks/kings', isFile: true });
    expect(planMove(odd, library, DEFAULT_TEMPLATE, localServer)).toBeNull();
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

/**
 * The same decision, with the reason kept. Every one of these used to be an
 * indistinguishable null, so a library where nothing could be placed reported
 * exactly what one that was already tidy reported: "0 items to move".
 */
describe('planMoveOutcome', () => {
  it('says an item is already where the template puts it', () => {
    const inPlace = item({ relPath: 'Brandon Sanderson/The Stormlight Archive/01 - The Way of Kings' });
    const outcome = planMoveOutcome(inPlace, library, DEFAULT_TEMPLATE, localServer);

    expect(outcome.plan).toBeNull();
    expect(outcome).toMatchObject({ code: 'in-place' });
  });

  it('says an extensionless file has nothing to be named with', () => {
    const odd = item({ relPath: 'kings', path: '/audiobooks/kings', isFile: true });
    expect(planMoveOutcome(odd, library, DEFAULT_TEMPLATE, localServer)).toMatchObject({
      code: 'no-extension',
    });
  });

  it('distinguishes a path outside the library root from a book already in place', () => {
    const outcome = planMoveOutcome(item(), library, DEFAULT_TEMPLATE, {
      libraryRoot: null,
      pathPrefix: null,
    });
    expect(outcome).toMatchObject({ code: 'outside-root' });
    // The path is named, because the answer to "why not" is usually in it.
    expect((outcome as { reason: string }).reason).toContain('/audiobooks/misc/kings');
  });

  it('says when the template rendered nothing for this item', () => {
    const outcome = planMoveOutcome(item(), library, '{narrator}', localServer);
    expect(outcome).toMatchObject({ code: 'template-empty' });
    expect((outcome as { reason: string }).reason).toContain('{narrator}');
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

  it('moves a loose file into a folder it creates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-loose-'));
    const from = join(root, 'kings.m4b');
    writeFileSync(from, 'audio');

    const to = join(root, 'Sanderson', 'The Way of Kings', 'The Way of Kings.m4b');
    await movePath(from, to, root);

    expect(statSync(to).isFile()).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  /**
   * The failure this guards against is total: a library whose last item moves
   * out of the root leaves the root empty, and tidying it away removes the very
   * folder AudiobookShelf is configured to watch. Loose files make it likely
   * rather than theoretical, since they sit in the root itself.
   */
  it('never tidies away the library root itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-boundary-'));
    const library = join(root, 'library');
    mkdirSync(library);
    const from = join(library, 'only-book.m4b');
    writeFileSync(from, 'audio');

    // Somewhere else entirely, so the library root is left empty behind it.
    await movePath(from, join(root, 'elsewhere', 'Book', 'Book.m4b'), library);

    expect(existsSync(library)).toBe(true);
    expect(statSync(library).isDirectory()).toBe(true);
  });

  it('still prunes the empty folders a move leaves behind, below the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-prune-'));
    const library = join(root, 'library');
    const nested = join(library, 'misc', 'unsorted');
    mkdirSync(nested, { recursive: true });
    const from = join(nested, 'book');
    mkdirSync(from);
    writeFileSync(join(from, 'book.m4b'), 'audio');

    await movePath(from, join(library, 'Sanderson', 'The Way of Kings'), library);

    expect(existsSync(nested)).toBe(false);
    expect(existsSync(join(library, 'misc'))).toBe(false);
    expect(existsSync(library)).toBe(true);
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
