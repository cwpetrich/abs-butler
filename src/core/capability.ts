import { accessSync, constants, statSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import type { AbsLibrary } from '../abs/types.js';
import type { ConnectionRecord } from '../db/connection.js';
import { explainDenial } from './deployment.js';

/**
 * Whether this machine can manage the library's files.
 *
 * abs-butler runs beside AudiobookShelf and shares its media, so this is
 * normally just true. It is still checked rather than assumed: `organize`
 * moves files, and a mount that vanished is worth catching before a batch of
 * moves is half-applied, not after.
 *
 * Everything else — audit, rate, metadata — is pure HTTP API and never consults
 * this.
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

export interface Capability {
  canManageFiles: boolean;
  /** Human-readable explanation, always present when canManageFiles is false. */
  reason: string;
  libraries: LibraryCapability[];
}

type PathConfig = Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'>;

const NOT_CONFIGURED =
  'No library root is set, so abs-butler does not know where the media lives on this machine. ' +
  'Set it in Settings → Connection to enable file organization.';

/**
 * Translates an AudiobookShelf-reported path into a local one.
 *
 * AudiobookShelf reports paths as *it* sees them, which for a containerized ABS
 * is a path that does not exist here. pathPrefix is what ABS calls the library
 * root; libraryRoot is what this machine calls it. With no prefix set, the two
 * are assumed to already agree — the case when ABS runs natively.
 */
export function toLocalPath(absPath: string, config: PathConfig): string | null {
  if (config.pathPrefix && config.libraryRoot) {
    if (!absPath.startsWith(config.pathPrefix)) return null;
    return join(config.libraryRoot, relative(config.pathPrefix, absPath));
  }
  if (config.libraryRoot) return absPath;
  return null;
}

function probe(path: string): { access: FileAccess; reason?: string } {
  let info: Stats;
  try {
    info = statSync(path);
  } catch (err) {
    // A refused stat is not a missing directory, and saying so sends people
    // hunting for a path that is sitting right where they left it. This is the
    // ordinary case for an unconfined snap interface, so it is worth splitting.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { access: 'unreachable', reason: explainDenial({ path, kind: 'not-visible' }) };
    }
    return { access: 'unreachable', reason: `${path} does not exist on this machine` };
  }

  if (!info.isDirectory()) {
    return { access: 'unreachable', reason: `${path} exists but is not a directory` };
  }

  try {
    accessSync(path, constants.W_OK);
    return { access: 'read-write' };
  } catch {
    return {
      access: 'read-only',
      reason: explainDenial({
        path,
        kind: 'not-writable',
        owner: { uid: info.uid, gid: info.gid, mode: info.mode },
      }),
    };
  }
}

export interface LocalRootStatus {
  /** False means organize is unavailable, full stop. */
  canManageFiles: boolean;
  access: FileAccess;
  reason: string;
  path: string | null;
}

/**
 * Cheap answer to "can this machine touch the files?", from the configured
 * library root alone.
 *
 * Makes no network call, so the UI can disable organize up front and the job
 * runner can re-check immediately before executing without a round trip.
 */
export function checkLocalRoot(config: Pick<ConnectionRecord, 'libraryRoot'>): LocalRootStatus {
  if (!config.libraryRoot) {
    return { canManageFiles: false, access: 'not-configured', reason: NOT_CONFIGURED, path: null };
  }

  const { access, reason } = probe(config.libraryRoot);
  return {
    canManageFiles: access === 'read-write',
    access,
    reason: reason ?? 'The library root is reachable and writable from this machine.',
    path: config.libraryRoot,
  };
}

/**
 * The full report: every library folder, where it maps to here, and whether
 * that path is usable. Needs the library list, so it costs one API call.
 */
export function assessCapability(config: PathConfig, libraries: AbsLibrary[]): Capability {
  const bookLibraries = libraries.filter((l) => l.mediaType === 'book');

  if (!config.libraryRoot) {
    return {
      canManageFiles: false,
      reason: NOT_CONFIGURED,
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
      const localPath = toLocalPath(folder.fullPath, config);
      if (!localPath) {
        results.push({
          libraryId: library.id,
          libraryName: library.name,
          absPath: folder.fullPath,
          localPath: null,
          access: 'unreachable',
          reason:
            `Path prefix "${config.pathPrefix}" does not match "${folder.fullPath}", the path ` +
            'AudiobookShelf reports for this folder.',
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
      reason: first?.reason ?? 'No library folder is writable from this machine.',
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
