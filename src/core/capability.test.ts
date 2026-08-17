import { mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessCapability, toLocalPath } from './capability.js';
import type { AbsLibrary } from '../abs/types.js';
import type { ServerRecord } from '../db/servers.js';

function server(patch: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: 1,
    name: 'test',
    url: 'http://localhost:13378',
    libraryRoot: null,
    pathPrefix: null,
    enabled: true,
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

describe('assessCapability', () => {
  it('reports API-only, with a reason, when no library root is set', () => {
    const result = assessCapability(server(), [library('/audiobooks')]);
    expect(result.canManageFiles).toBe(false);
    expect(result.reason).toMatch(/No library root configured/);
    expect(result.libraries[0]!.access).toBe('not-configured');
  });

  it('reports read-write for a real writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-cap-'));
    const result = assessCapability(
      server({ libraryRoot: dir, pathPrefix: '/audiobooks' }),
      [library('/audiobooks')],
    );
    expect(result.canManageFiles).toBe(true);
    expect(result.libraries[0]!.access).toBe('read-write');
    expect(result.libraries[0]!.localPath).toBe(dir);
  });

  it('reports unreachable when the translated path does not exist here', () => {
    const result = assessCapability(
      server({ libraryRoot: '/definitely/not/here', pathPrefix: '/audiobooks' }),
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
        server({ libraryRoot: dir, pathPrefix: '/audiobooks' }),
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
      server({ libraryRoot: dir, pathPrefix: '/audiobooks' }),
      [library('/audiobooks'), podcasts],
    );
    expect(result.libraries).toHaveLength(1);
    expect(result.libraries[0]!.libraryName).toBe('Audiobooks');
  });
});
