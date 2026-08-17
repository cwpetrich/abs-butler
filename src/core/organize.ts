import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type ServerContext } from '../context.js';
import type { ServerRecord } from '../db/servers.js';
import { assessCapability, toLocalPath, type ServerCapability } from './capability.js';
import { log } from '../logger.js';
import { padSequence, sanitizePathSegment } from '../util/text.js';

/**
 * Default layout, matching AudiobookShelf's own recommended structure:
 *   Author/Series/Vol - Title/
 * Series segments collapse away for standalone books.
 */
export const DEFAULT_TEMPLATE = '{author}/{series}/{sequence} - {title}';

export interface MovePlan {
  itemId: string;
  title: string;
  from: string;
  to: string;
  /** Absolute paths on THIS machine, already translated from what ABS reports. */
  fromLocal: string;
  toLocal: string;
  libraryId: string;
}

export interface TemplateVars {
  author: string;
  title: string;
  series: string;
  sequence: string;
  year: string;
}

export function templateVars(item: AbsLibraryItem): TemplateVars {
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

export function planMove(
  item: AbsLibraryItem,
  library: AbsLibrary,
  template: string,
  server: Pick<ServerRecord, 'libraryRoot' | 'pathPrefix'>,
): MovePlan | null {
  const folder = library.folders.find((f) => f.id === item.folderId) ?? library.folders[0];
  if (!folder) return null;

  const target = renderTemplate(template, templateVars(item));
  if (!target) return null;

  const currentRel = (item.relPath ?? '').replace(/^\/+/, '');
  if (currentRel === target) return null;

  const fromLocal = toLocalPath(item.path, server);
  const folderLocal = toLocalPath(folder.fullPath, server);
  if (!fromLocal || !folderLocal) return null;

  const toLocal = join(folderLocal, target);
  if (resolve(fromLocal) === resolve(toLocal)) return null;

  return {
    itemId: item.id,
    title: itemTitle(item),
    from: currentRel || item.path,
    to: target,
    fromLocal,
    toLocal,
    libraryId: item.libraryId,
  };
}

/** Moves a directory, falling back to copy+delete when crossing filesystems. */
export async function movePath(from: string, to: string): Promise<void> {
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

export interface OrganizeTaskOptions {
  library?: string;
  apply?: boolean;
  limit?: number;
  template?: string;
  noScan?: boolean;
}

export interface OrganizeTaskResult {
  template: string;
  planned: number;
  moved: number;
  skipped: Array<{ title: string; reason: string }>;
  applied: boolean;
  rescanned: boolean;
  capability: ServerCapability;
  plans: MovePlan[];
}

export async function runOrganizeTask(
  ctx: ServerContext,
  options: OrganizeTaskOptions = {},
): Promise<OrganizeTaskResult> {
  const template = options.template ?? DEFAULT_TEMPLATE;
  const allLibraries = await ctx.client.listLibraries();
  const capability = assessCapability(ctx.server, allLibraries);

  // Organizing is unavailable outright when the media is not mounted here —
  // not "plan now, fail later". abs-butler has no remote file transport, so a
  // plan it could never carry out is a false promise, and one built against
  // paths this machine cannot see is not even verifiable.
  if (!capability.canManageFiles) {
    throw new Error(unavailableMessage(ctx.server.name, capability.reason));
  }

  const libraries = await resolveLibraries(ctx, options.library);
  const plans: MovePlan[] = [];
  for (const library of libraries) {
    const items = await collectItems(ctx, [library], { limit: options.limit });
    for (const item of items) {
      if (item.isFile) {
        log.debug(`skipping single-file item (not a book folder): ${itemTitle(item)}`);
        continue;
      }
      const plan = planMove(item, library, template, ctx.server);
      if (plan) plans.push(plan);
    }
  }

  const skipped: Array<{ title: string; reason: string }> = [];
  let moved = 0;
  let rescanned = false;

  if (!options.apply) {
    log.info(`${plans.length} item(s) would move. Apply to move files on disk.`);
    return { template, planned: plans.length, moved, skipped, applied: false, rescanned, capability, plans };
  }

  const touchedLibraries = new Set<string>();
  for (const plan of plans) {
    const reason = await moveBlockedReason(plan);
    if (reason) {
      log.warn(`skipping "${plan.title}" — ${reason}`);
      skipped.push({ title: plan.title, reason });
      continue;
    }
    await movePath(plan.fromLocal, plan.toLocal);
    touchedLibraries.add(plan.libraryId);
    moved += 1;
    log.debug(`moved ${plan.from} -> ${plan.to}`);
  }
  log.success(`Moved ${moved} item(s).`);

  if (moved > 0 && !options.noScan) {
    for (const libraryId of touchedLibraries) await ctx.client.scanLibrary(libraryId);
    rescanned = true;
    log.success('Triggered a rescan so AudiobookShelf picks up the new paths.');
  }

  return { template, planned: plans.length, moved, skipped, applied: true, rescanned, capability, plans };
}

/**
 * The one message explaining why organizing is off, used by the CLI, the API,
 * and the job runner so the answer never varies by where it is asked.
 */
export function unavailableMessage(serverName: string, reason: string): string {
  return (
    `File organization is unavailable for "${serverName}" from this machine. ${reason}\n` +
    'organize moves files directly and abs-butler has no remote file access, so it only works ' +
    'when the media is mounted where abs-butler runs — on the same machine, or over a network ' +
    'share such as NFS or SMB. Every other command works against this server over the API.'
  );
}

async function moveBlockedReason(plan: MovePlan): Promise<string | null> {
  if (!existsSync(plan.fromLocal)) return `not found at ${plan.fromLocal}`;
  if (existsSync(plan.toLocal)) return `destination already exists: ${plan.toLocal}`;
  const source = await stat(plan.fromLocal);
  if (!source.isDirectory()) return `expected a folder at ${plan.fromLocal}`;
  return null;
}
