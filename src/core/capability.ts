import { accessSync, constants, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AbsLibrary } from '../abs/types.js';
import type { ServerRecord } from '../db/servers.js';

/**
 * Whether this machine can manage a given server's files.
 *
 * Everything except `organize` runs entirely over the HTTP API, so a server on
 * another host is fully manageable. `organize` moves files, which needs the
 * media mounted here — so it is probed up front and disabled with a reason
 * rather than failing halfway through a batch of moves.
 */

export type FileAccess = 'read-write' | 'read-only' | 'unreachable' | 'not-configured';

export interface LibraryCapability {
  libraryId: string;
  libraryName: string;
  /** The path AudiobookShelf reports for this folder. */
  absPath: string;
  /** Where that maps to on this machine, once the prefix is translated. */
  localPath: string | null;
  access: FileAccess;
  reason?: string;
}

export interface ServerCapability {
  canManageFiles: boolean;
  /** Human-readable explanation, always present when canManageFiles is false. */
  reason: string;
  libraries: LibraryCapability[];
}

/**
 * Translates an AudiobookShelf-reported path into a local one.
 *
 * When pathPrefix is set, ABS sees the library at a different root than we do
 * (the usual case when ABS runs in a container). When it is not set but
 * libraryRoot is, paths are assumed to already agree.
 */
export function toLocalPath(absPath: string, server: Pick<ServerRecord, 'libraryRoot' | 'pathPrefix'>): string | null {
  if (server.pathPrefix && server.libraryRoot) {
    if (!absPath.startsWith(server.pathPrefix)) return null;
    return join(server.libraryRoot, relative(server.pathPrefix, absPath));
  }
  if (server.libraryRoot) return absPath;
  return null;
}

function probe(path: string): { access: FileAccess; reason?: string } {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) {
      return { access: 'unreachable', reason: `${path} exists but is not a directory` };
    }
  } catch {
    return { access: 'unreachable', reason: `${path} does not exist on this machine` };
  }

  try {
    accessSync(path, constants.W_OK);
    return { access: 'read-write' };
  } catch {
    return { access: 'read-only', reason: `${path} is not writable by this process` };
  }
}

export function assessCapability(server: ServerRecord, libraries: AbsLibrary[]): ServerCapability {
  const bookLibraries = libraries.filter((l) => l.mediaType === 'book');

  if (!server.libraryRoot) {
    return {
      canManageFiles: false,
      reason:
        'No library root configured. Set one to the path where this machine can see the media, ' +
        'or leave it blank to manage this server over the API only.',
      libraries: bookLibraries.flatMap((library) =>
        library.folders.map((folder) => ({
          libraryId: library.id,
          libraryName: library.name,
          absPath: folder.fullPath,
          localPath: null,
          access: 'not-configured' as const,
        })),
      ),
    };
  }

  const results: LibraryCapability[] = [];
  for (const library of bookLibraries) {
    for (const folder of library.folders) {
      const localPath = toLocalPath(folder.fullPath, server);
      if (!localPath) {
        results.push({
          libraryId: library.id,
          libraryName: library.name,
          absPath: folder.fullPath,
          localPath: null,
          access: 'unreachable',
          reason: `Path prefix "${server.pathPrefix}" does not match the path AudiobookShelf reports`,
        });
        continue;
      }
      const { access, reason } = probe(localPath);
      results.push({
        libraryId: library.id,
        libraryName: library.name,
        absPath: folder.fullPath,
        localPath,
        access,
        ...(reason ? { reason } : {}),
      });
    }
  }

  const writable = results.filter((r) => r.access === 'read-write');
  if (writable.length === 0) {
    const first = results.find((r) => r.reason);
    return {
      canManageFiles: false,
      reason: first?.reason ?? 'No library folder on this server is writable from this machine.',
      libraries: results,
    };
  }

  const partial = results.length - writable.length;
  return {
    canManageFiles: true,
    reason:
      partial > 0
        ? `${writable.length} of ${results.length} folders are writable; the rest will be skipped.`
        : 'All library folders are reachable and writable.',
    libraries: results,
  };
}
