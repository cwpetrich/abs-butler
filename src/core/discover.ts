import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { AbsClient } from '../abs/client.js';
import type { AbsLibrary } from '../abs/types.js';
import type { ConnectionRecord } from '../db/connection.js';
import { toLocalPath } from './capability.js';
import { libraryMounts } from './mounts.js';

/**
 * Works out the library root and path prefix by finding the books.
 *
 * The two settings are the part of setup people get wrong, because each names
 * the same directory from a different container and neither container can see
 * the other's name for it. But AudiobookShelf does report where every book is,
 * and a book's own folders — `Author/Title` — are the same from anywhere. So
 * take a few books, and for each place the library could be mounted here, look
 * for them: drop leading folders from the reported path until what is left
 * exists under that mount. What was dropped is AudiobookShelf's name for the
 * mount, which is the prefix.
 *
 * Finding the actual books, rather than a directory that merely exists, is the
 * point. An empty folder Docker created because HOST_LIBRARY_PATH was never set
 * exists and is writable, and it is still the wrong directory.
 */

export interface PathMapping {
  libraryRoot: string;
  /** Null when AudiobookShelf and abs-butler already use the same path. */
  pathPrefix: string | null;
}

export interface SampleItem {
  /** The full path AudiobookShelf reports. */
  path: string;
  /** The same path relative to its library folder. */
  relPath: string;
}

export interface LibrarySample {
  libraryName: string;
  folders: string[];
  items: SampleItem[];
}

export interface Discovery {
  /** Null when none of the sampled books could be found from here. */
  mapping: PathMapping | null;
  /** Books looked for, and how many of them the mapping finds. */
  checked: number;
  found: number;
  /** Whether `mapping` is what is already configured. */
  matchesCurrent: boolean;
}

type Exists = (path: string) => boolean;

function components(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/**
 * Every way this item's path could map onto `root`, keeping the one that
 * matches the most of the path — the most specific evidence. Never drops into
 * the item's own relative path: finding `Title` alone somewhere is coincidence,
 * finding `Author/Title` is the library.
 */
function mappingFor(item: SampleItem, root: string, exists: Exists): PathMapping | null {
  const parts = components(item.path);
  const own = Math.max(components(item.relPath).length, 1);
  for (let dropped = 0; dropped <= parts.length - own; dropped++) {
    if (exists(join(root, ...parts.slice(dropped)))) {
      return { libraryRoot: root, pathPrefix: `/${parts.slice(0, dropped).join('/')}` };
    }
  }
  return null;
}

function translate(path: string, mapping: PathMapping): string | null {
  return toLocalPath(path, { libraryRoot: mapping.libraryRoot, pathPrefix: mapping.pathPrefix });
}

function commonAncestor(paths: string[]): string {
  const split = paths.map(components);
  const shared: string[] = [];
  for (let i = 0; split.every((p) => i < p.length && p[i] === split[0]![i]); i++) {
    shared.push(split[0]![i]!);
  }
  return `/${shared.join('/')}`;
}

/**
 * Restates a mapping at the library folder rather than wherever the match
 * happened to land. `/nas → /audiobooks` and `/nas/AudioBooks →
 * /audiobooks/AudioBooks` translate identically, but the second is what someone
 * looking at AudiobookShelf's settings recognizes. And when both sides come out
 * the same, there is no prefix at all.
 */
function tighten(mapping: PathMapping, folders: string[], exists: Exists): PathMapping {
  const prefix = mapping.pathPrefix ?? mapping.libraryRoot;
  // Only folders this mapping really reaches: one that is not mounted here must
  // not drag the common ancestor up above the one that is.
  const covered = folders.filter((f) => {
    const local = translate(f, mapping);
    return local !== null && exists(local);
  });
  const ancestor = covered.length > 0 ? commonAncestor(covered) : prefix;
  const deeper = ancestor.length > prefix.length ? ancestor : prefix;
  const root = posix.join(mapping.libraryRoot, posix.relative(prefix, deeper));
  return root === deeper ? { libraryRoot: root, pathPrefix: null } : { libraryRoot: root, pathPrefix: deeper };
}

function sameMapping(a: PathMapping, b: Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'>): boolean {
  const trim = (p: string | null) => (p && p.length > 1 ? p.replace(/\/+$/, '') : p) || null;
  return trim(a.libraryRoot) === trim(b.libraryRoot) && trim(a.pathPrefix) === trim(b.pathPrefix);
}

/**
 * Where the library could be: the filesystem root, which covers the case where
 * both sides already agree, every mount that could hold media, and whatever is
 * configured now.
 */
export function candidateRoots(current?: string | null): string[] {
  return [...new Set(['/', ...libraryMounts().map((m) => m.path), ...(current ? [current] : [])])];
}

export function discoverMapping(
  samples: LibrarySample[],
  roots: string[],
  current: Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'> = { libraryRoot: null, pathPrefix: null },
  exists: Exists = existsSync,
): Discovery {
  const items = samples.flatMap((s) => s.items);
  const folders = samples.flatMap((s) => s.folders);
  const none: Discovery = { mapping: null, checked: items.length, found: 0, matchesCurrent: false };
  if (items.length === 0) return none;

  // A few items seed the guesses, so one book missing on disk does not sink
  // the whole search. Every guess is then scored against every sampled book.
  const guesses = new Map<string, PathMapping>();
  for (const item of items.slice(0, 3)) {
    for (const root of roots) {
      const found = mappingFor(item, root, exists);
      if (!found) continue;
      const tightened = tighten(found, folders, exists);
      guesses.set(`${tightened.libraryRoot}\0${tightened.pathPrefix}`, tightened);
    }
  }

  let best: { mapping: PathMapping; found: number } | null = null;
  for (const mapping of guesses.values()) {
    const found = items.filter((item) => {
      const local = translate(item.path, mapping);
      return local !== null && exists(local);
    }).length;
    // Ties go to no prefix at all: the simpler setting, when both are true.
    if (!best || found > best.found || (found === best.found && mapping.pathPrefix === null)) {
      best = { mapping, found };
    }
  }

  if (!best || best.found === 0) return none;
  return {
    mapping: best.mapping,
    checked: items.length,
    found: best.found,
    matchesCurrent: sameMapping(best.mapping, current),
  };
}

/** A handful of books from each book library, as AudiobookShelf reports them. */
export async function sampleLibraries(
  client: AbsClient,
  libraries: AbsLibrary[],
  perLibrary = 5,
): Promise<LibrarySample[]> {
  const samples: LibrarySample[] = [];
  for (const library of libraries.filter((l) => l.mediaType === 'book')) {
    const items: SampleItem[] = [];
    for await (const item of client.iterateLibraryItems(library.id, { pageSize: perLibrary * 2 })) {
      // Already known to be gone from disk, so it cannot be found anywhere.
      if (item.isMissing || !item.path) continue;
      items.push({ path: item.path, relPath: item.relPath ?? '' });
      if (items.length >= perLibrary) break;
    }
    samples.push({ libraryName: library.name, folders: library.folders.map((f) => f.fullPath), items });
  }
  return samples;
}

/** The whole search against a live server. */
export async function discoverFromServer(
  client: AbsClient,
  libraries: AbsLibrary[],
  current: Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'>,
): Promise<Discovery> {
  const samples = await sampleLibraries(client, libraries);
  return discoverMapping(samples, candidateRoots(current.libraryRoot), current);
}
