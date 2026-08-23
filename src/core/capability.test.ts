import { mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessCapability, checkLocalRoot, toLocalPath } from './capability.js';
import type { AbsLibrary } from '../abs/types.js';
import type { ConnectionRecord } from '../db/connection.js';

function connection(patch: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    url: 'http://localhost:13378',
    libraryRoot: null,
    pathPrefix: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function library(fullPath: string): AbsLibrary {
  return {
    id: 'lib1',
    name: 'Audiobooks',
    mediaType: 'book',
    provider: 'audible',
    folders: [{ id: 'f1', fullPath, libraryId: 'lib1' }],
  };
}

describe('toLocalPath', () => {
  it('translates a container path to the host path', () => {
    const s = { libraryRoot: '/mnt/media/books', pathPrefix: '/audiobooks' };
    expect(toLocalPath('/audiobooks/Author/Title', s)).toBe('/mnt/media/books/Author/Title');
  });

  it('passes paths through when no prefix translation is configured', () => {
    expect(toLocalPath('/srv/books/Title', { libraryRoot: '/srv/books', pathPrefix: null })).toBe(
      '/srv/books/Title',
    );
  });

  it('returns null when the prefix does not match what the server reports', () => {
    const s = { libraryRoot: '/mnt/media', pathPrefix: '/audiobooks' };
    expect(toLocalPath('/somewhere-else/Title', s)).toBeNull();
  });

  it('returns null with no library root, meaning API-only', () => {
    expect(toLocalPath('/audiobooks/Title', { libraryRoot: null, pathPrefix: null })).toBeNull();
  });
});

describe('checkLocalRoot', () => {
  it('disables file management when no library root is set', () => {
    const status = checkLocalRoot(connection());
    expect(status.canManageFiles).toBe(false);
    expect(status.access).toBe('not-configured');
    expect(status.reason).toMatch(/No library root is set/);
    expect(status.path).toBeNull();
  });

  // The decisive case: abs-butler on a different machine from the media.
  it('disables file management when the root does not exist here', () => {
    const status = checkLocalRoot({ libraryRoot: '/mnt/some-other-machine/audiobooks' });
    expect(status.canManageFiles).toBe(false);
    expect(status.access).toBe('unreachable');
  });

  it('enables file management for a writable local root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-local-'));
    const status = checkLocalRoot({ libraryRoot: dir });
    expect(status.canManageFiles).toBe(true);
    expect(status.access).toBe('read-write');
    expect(status.path).toBe(dir);
  });

  // A read-only mount is not "same machine enough" — moving files would fail.
  it('does not enable file management for a read-only root', () => {
    if (process.getuid?.() === 0) return;
    const base = mkdtempSync(join(tmpdir(), 'butler-localro-'));
    const dir = join(base, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const status = checkLocalRoot({ libraryRoot: dir });
      expect(status.canManageFiles).toBe(false);
      expect(status.access).toBe('read-only');
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('assessCapability', () => {
  it('refuses file management, with a reason, when no library root is set', () => {
    const result = assessCapability(connection(), [library('/audiobooks')]);
    expect(result.canManageFiles).toBe(false);
    expect(result.reason).toMatch(/No library root is set/);
    expect(result.libraries[0]!.access).toBe('not-configured');
  });

  it('reports read-write for a real writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-cap-'));
    const result = assessCapability(
      connection({ libraryRoot: dir, pathPrefix: '/audiobooks' }),
      [library('/audiobooks')],
    );
    expect(result.canManageFiles).toBe(true);
    expect(result.libraries[0]!.access).toBe('read-write');
    expect(result.libraries[0]!.localPath).toBe(dir);
  });

  it('reports unreachable when the translated path does not exist here', () => {
    const result = assessCapability(
      connection({ libraryRoot: '/definitely/not/here', pathPrefix: '/audiobooks' }),
      [library('/audiobooks')],
    );
    expect(result.canManageFiles).toBe(false);
    expect(result.libraries[0]!.access).toBe('unreachable');
    expect(result.reason).toMatch(/does not exist on this machine/);
  });

  it('reports read-only rather than writable for an unwritable directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'butler-ro-'));
    const dir = join(base, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const result = assessCapability(
        connection({ libraryRoot: dir, pathPrefix: '/audiobooks' }),
        [library('/audiobooks')],
      );
      // Running as root defeats permission bits, so only assert when it applies.
      if (process.getuid?.() !== 0) {
        expect(result.canManageFiles).toBe(false);
        expect(result.libraries[0]!.access).toBe('read-only');
      }
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  // Confinement and a locked-down parent both surface as EACCES on stat, which
  // must not be reported as a missing directory: the path is right where the
  // operator left it, and telling them otherwise sends them hunting for it.
  it('does not call a path that exists but is hidden "missing"', () => {
    if (process.getuid?.() === 0) return;
    const base = mkdtempSync(join(tmpdir(), 'butler-hidden-'));
    const outer = join(base, 'outer');
    mkdirSync(join(outer, 'library'), { recursive: true });
    chmodSync(outer, 0o000);
    try {
      const result = assessCapability(
        connection({ libraryRoot: join(outer, 'library'), pathPrefix: '/audiobooks' }),
        [library('/audiobooks')],
      );
      expect(result.canManageFiles).toBe(false);
      expect(result.libraries[0]!.access).toBe('unreachable');
      expect(result.reason).not.toMatch(/does not exist/);
    } finally {
      chmodSync(outer, 0o700);
    }
  });

  it('ignores podcast libraries, which none of the book tooling applies to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-pod-'));
    const podcasts: AbsLibrary = {
      id: 'lib2',
      name: 'Podcasts',
      mediaType: 'podcast',
      provider: 'itunes',
      folders: [{ id: 'f2', fullPath: '/podcasts', libraryId: 'lib2' }],
    };
    const result = assessCapability(
      connection({ libraryRoot: dir, pathPrefix: '/audiobooks' }),
      [library('/audiobooks'), podcasts],
    );
    expect(result.libraries).toHaveLength(1);
    expect(result.libraries[0]!.libraryName).toBe('Audiobooks');
  });
});
