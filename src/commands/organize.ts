import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, cp, readdir, rmdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import { collectItems, createContext, itemAuthor, itemTitle, resolveLibraries, type GlobalOptions } from '../context.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';
import { padSequence, sanitizePathSegment, truncate } from '../util/text.js';

/**
 * Default layout, matching AudiobookShelf's own recommended structure:
 *   Author/Series/Vol - Title/
 * Series segments collapse away for standalone books.
 */
export const DEFAULT_TEMPLATE = '{author}/{series}/{sequence} - {title}';

export interface OrganizeOptions extends GlobalOptions {
  apply?: boolean;
  json?: boolean;
  limit?: number;
  template?: string;
  /** Skip the post-move library scan. */
  noScan?: boolean;
}

export interface MovePlan {
  itemId: string;
  title: string;
  from: string;
  to: string;
  /** Absolute host paths, resolved through LIBRARY_ROOT / ABS_PATH_PREFIX. */
  fromAbsolute: string;
  toAbsolute: string;
  libraryId: string;
}

interface TemplateVars {
  author: string;
  title: string;
  series: string;
  sequence: string;
  year: string;
}

function templateVars(item: AbsLibraryItem): TemplateVars {
  const metadata = item.media?.metadata;
  const series = metadata?.series?.[0];
  return {
    author: sanitizePathSegment(itemAuthor(item) ?? 'Unknown Author'),
    title: sanitizePathSegment(metadata?.title ?? 'Unknown Title'),
    series: series?.name ? sanitizePathSegment(series.name) : '',
    sequence: padSequence(series?.sequence),
    year: metadata?.publishedYear ?? '',
  };
}

/**
 * Renders a template into a relative path.
 *
 * A path segment that ends up empty is dropped entirely, and a `{x} - {y}`
 * separator whose left side is empty loses the separator too — so a standalone
 * book renders `Author/Title`, not `Author//  - Title`.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .split('/')
    .map((segment) =>
      segment
        .replace(/\{(\w+)\}/g, (_, key: string) => vars[key as keyof TemplateVars] ?? '')
        .replace(/^[\s\-–]+|[\s\-–]+$/g, '')
        .replace(/\s{2,}/g, ' '),
    )
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * ABS reports paths as its own process sees them. When it runs in a container,
 * those differ from this machine's paths, so translate through the configured
 * prefix pair before touching the filesystem.
 */
function toHostPath(absPath: string, config: { libraryRoot?: string; absPathPrefix?: string }): string {
  if (config.absPathPrefix && config.libraryRoot && absPath.startsWith(config.absPathPrefix)) {
    return join(config.libraryRoot, relative(config.absPathPrefix, absPath));
  }
  return absPath;
}

export function planMove(
  item: AbsLibraryItem,
  library: AbsLibrary,
  template: string,
  config: { libraryRoot?: string; absPathPrefix?: string },
): MovePlan | null {
  const folder = library.folders.find((f) => f.id === item.folderId) ?? library.folders[0];
  if (!folder) return null;

  const target = renderTemplate(template, templateVars(item));
  if (!target) return null;

  const currentRel = (item.relPath ?? '').replace(/^\/+/, '');
  if (currentRel === target) return null;

  const fromAbsolute = toHostPath(item.path, config);
  const toAbsolute = join(toHostPath(folder.fullPath, config), target);
  if (resolve(fromAbsolute) === resolve(toAbsolute)) return null;

  return {
    itemId: item.id,
    title: itemTitle(item),
    from: currentRel || item.path,
    to: target,
    fromAbsolute,
    toAbsolute,
    libraryId: item.libraryId,
  };
}

/** Moves a directory, falling back to copy+delete when crossing filesystems. */
async function movePath(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    log.debug(`cross-device move, copying instead: ${from}`);
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
  await pruneEmptyParents(dirname(from));
}

/** Cleans up directories left behind by a move, stopping at the first non-empty one. */
async function pruneEmptyParents(dir: string, depth = 3): Promise<void> {
  for (let i = 0; i < depth; i++) {
    if (!existsSync(dir) || dir === sep) return;
    const entries = await readdir(dir);
    if (entries.length > 0) return;
    await rmdir(dir);
    dir = dirname(dir);
  }
}

export async function runOrganize(options: OrganizeOptions): Promise<void> {
  const ctx = await createContext(options);
  const template = options.template ?? DEFAULT_TEMPLATE;
  const libraries = await resolveLibraries(ctx, options.library);

  const plans: MovePlan[] = [];
  for (const library of libraries) {
    const items = await collectItems(ctx, [library], { limit: options.limit });
    for (const item of items) {
      if (item.isFile) {
        log.debug(`skipping single-file item (not a book folder): ${itemTitle(item)}`);
        continue;
      }
      const plan = planMove(item, library, template, ctx.config);
      if (plan) plans.push(plan);
    }
  }

  if (options.json) {
    printJson({ template, plans });
  } else if (plans.length === 0) {
    log.success(`Every item already matches ${template}`);
    return;
  } else {
    printTable(plans, [
      { header: 'TITLE', value: (p) => truncate(p.title, 36), maxWidth: 36 },
      { header: 'FROM', value: (p) => color.dim(truncate(p.from, 46)), maxWidth: 46 },
      { header: 'TO', value: (p) => color.green(truncate(p.to, 46)), maxWidth: 46 },
    ]);
  }

  if (!options.apply) {
    log.info(`${plans.length} item(s) would move. Re-run with --apply to move files on disk.`);
    return;
  }

  if (!ctx.config.libraryRoot && ctx.config.absPathPrefix) {
    throw new Error('ABS_PATH_PREFIX is set but LIBRARY_ROOT is not; both are needed to translate paths.');
  }

  let moved = 0;
  const touchedLibraries = new Set<string>();
  for (const plan of plans) {
    if (!existsSync(plan.fromAbsolute)) {
      log.warn(`skipping "${plan.title}" — not found at ${plan.fromAbsolute}`);
      continue;
    }
    if (existsSync(plan.toAbsolute)) {
      log.warn(`skipping "${plan.title}" — destination already exists: ${plan.toAbsolute}`);
      continue;
    }
    const source = await stat(plan.fromAbsolute);
    if (!source.isDirectory()) {
      log.warn(`skipping "${plan.title}" — expected a folder at ${plan.fromAbsolute}`);
      continue;
    }
    await movePath(plan.fromAbsolute, plan.toAbsolute);
    touchedLibraries.add(plan.libraryId);
    moved += 1;
    log.debug(`moved ${plan.from} -> ${plan.to}`);
  }
  log.success(`Moved ${moved} item(s).`);

  if (moved > 0 && !options.noScan) {
    for (const libraryId of touchedLibraries) {
      await ctx.client.scanLibrary(libraryId);
    }
    log.success('Triggered a rescan so AudiobookShelf picks up the new paths.');
  }
}
