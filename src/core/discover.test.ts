import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMapping, type LibrarySample } from './discover.js';

/** A filesystem holding exactly these paths and their parents. */
function fakeFs(...paths: string[]): (path: string) => boolean {
  return (candidate) =>
    candidate === '/' || paths.some((p) => p === candidate || p.startsWith(`${candidate}/`));
}

function sample(folder: string, relPaths: string[], libraryName = 'Audiobooks'): LibrarySample {
  return {
    libraryName,
    folders: [folder],
    items: relPaths.map((relPath) => ({ path: `${folder}/${relPath}`, relPath })),
  };
}

const BOOKS = ['Frank Herbert/Dune', 'Jane Austen/Emma', 'Mary Shelley/Frankenstein'];

describe('discoverMapping', () => {
  // The case that prompted this: AudiobookShelf in its own container calls the
  // library /nas/AudioBooks, and abs-butler's container has it at /audiobooks.
  it('finds a library mounted under a different name in each container', () => {
    const exists = fakeFs(...BOOKS.map((b) => `/audiobooks/${b}`));
    const result = discoverMapping([sample('/nas/AudioBooks', BOOKS)], ['/', '/audiobooks'], undefined, exists);
    expect(result.mapping).toEqual({ libraryRoot: '/audiobooks', pathPrefix: '/nas/AudioBooks' });
    expect(result).toMatchObject({ checked: 3, found: 3, matchesCurrent: false });
  });

  it('needs no prefix when both sides already use the same path', () => {
    const exists = fakeFs(...BOOKS.map((b) => `/audiobooks/${b}`));
    const result = discoverMapping([sample('/audiobooks', BOOKS)], ['/', '/audiobooks'], undefined, exists);
    expect(result.mapping).toEqual({ libraryRoot: '/audiobooks', pathPrefix: null });
  });

  // abs-butler has the whole share, AudiobookShelf only the folder inside it.
  // Both translate the same way; the one stated at the library folder is the
  // one a person can check against AudiobookShelf's settings.
  it('states the mapping at the library folder when abs-butler mounts a level higher', () => {
    const exists = fakeFs(...BOOKS.map((b) => `/share/AudioBooks/${b}`));
    const result = discoverMapping([sample('/nas/AudioBooks', BOOKS)], ['/', '/share'], undefined, exists);
    expect(result.mapping).toEqual({ libraryRoot: '/share/AudioBooks', pathPrefix: '/nas/AudioBooks' });
    expect(result.found).toBe(3);
  });

  // The default compose mount when HOST_LIBRARY_PATH is unset: a directory
  // that exists and is writable, and has none of the books in it.
  it('finds nothing in an empty mount, rather than settling for a folder that exists', () => {
    const exists = fakeFs('/audiobooks');
    const result = discoverMapping([sample('/nas/AudioBooks', BOOKS)], ['/', '/audiobooks'], undefined, exists);
    expect(result.mapping).toBeNull();
    expect(result).toMatchObject({ checked: 3, found: 0 });
  });

  it('does not take a lone title somewhere as the library', () => {
    const exists = fakeFs('/audiobooks/Dune', '/audiobooks/Emma', '/audiobooks/Frankenstein');
    const result = discoverMapping([sample('/nas/AudioBooks', BOOKS)], ['/', '/audiobooks'], undefined, exists);
    expect(result.mapping).toBeNull();
  });

  it('still finds the library when some books are missing on disk', () => {
    const exists = fakeFs('/audiobooks/Mary Shelley/Frankenstein');
    const result = discoverMapping([sample('/nas/AudioBooks', BOOKS)], ['/', '/audiobooks'], undefined, exists);
    expect(result.mapping).toEqual({ libraryRoot: '/audiobooks', pathPrefix: '/nas/AudioBooks' });
    expect(result).toMatchObject({ checked: 3, found: 1 });
  });

  it('covers several libraries under one mount with their common folder', () => {
    const exists = fakeFs('/media/Adults/Frank Herbert/Dune', '/media/Kids/Roald Dahl/Matilda');
    const result = discoverMapping(
      [
        sample('/nas/Adults', ['Frank Herbert/Dune']),
        sample('/nas/Kids', ['Roald Dahl/Matilda'], 'Kids'),
      ],
      ['/', '/media'],
      undefined,
      exists,
    );
    expect(result.mapping).toEqual({ libraryRoot: '/media', pathPrefix: '/nas' });
    expect(result.found).toBe(2);
  });

  it('handles a single-file book at the top of the library', () => {
    const exists = fakeFs('/audiobooks/The Hobbit.m4b');
    const result = discoverMapping(
      [sample('/nas/AudioBooks', ['The Hobbit.m4b'])],
      ['/', '/audiobooks'],
      undefined,
      exists,
    );
    expect(result.mapping).toEqual({ libraryRoot: '/audiobooks', pathPrefix: '/nas/AudioBooks' });
  });

  it('says when what it found is already configured', () => {
    const exists = fakeFs(...BOOKS.map((b) => `/audiobooks/${b}`));
    const result = discoverMapping(
      [sample('/nas/AudioBooks', BOOKS)],
      ['/', '/audiobooks'],
      { libraryRoot: '/audiobooks/', pathPrefix: '/nas/AudioBooks' },
      exists,
    );
    expect(result.matchesCurrent).toBe(true);
  });

  it('reports nothing checked for a library with no books', () => {
    const result = discoverMapping([sample('/nas/AudioBooks', [])], ['/'], undefined, fakeFs());
    expect(result).toEqual({ mapping: null, checked: 0, found: 0, matchesCurrent: false });
  });

  it('works against a real directory tree', () => {
    const base = mkdtempSync(join(tmpdir(), 'butler-discover-'));
    const mount = join(base, 'audiobooks');
    mkdirSync(join(mount, 'Frank Herbert', 'Dune'), { recursive: true });
    writeFileSync(join(mount, 'The Hobbit.m4b'), '');
    const result = discoverMapping(
      [sample('/nas/AudioBooks', ['Frank Herbert/Dune', 'The Hobbit.m4b'])],
      ['/', mount],
    );
    expect(result.mapping).toEqual({ libraryRoot: mount, pathPrefix: '/nas/AudioBooks' });
    expect(result.found).toBe(2);
  });
});
