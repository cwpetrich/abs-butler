import { existsSync } from 'node:fs';
import { chmod, chown, cp, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import type { ConnectionRecord } from '../db/connection.js';
import { assessCapability, toLocalPath, type Capability } from './capability.js';
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
  config: Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'>,
): MovePlan | null {
  const folder = library.folders.find((f) => f.id === item.folderId) ?? library.folders[0];
  if (!folder) return null;

  const target = renderTemplate(template, templateVars(item));
  if (!target) return null;

  const currentRel = (item.relPath ?? '').replace(/^\/+/, '');
  if (currentRel === target) return null;

  const fromLocal = toLocalPath(item.path, config);
  const folderLocal = toLocalPath(folder.fullPath, config);
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

/**
 * Creates a directory and any missing parents, giving each new one the same
 * ownership and permissions as the nearest existing ancestor.
 *
 * Plain mkdir stamps them with whoever abs-butler runs as instead — root under
 * snap, often uid 1000 under Docker. Either way the move succeeds and leaves
 * behind Author/ and Series/ folders the library's real owner can no longer
 * write to, which is a worse outcome than not organizing at all: it is silent,
 * and it compounds with every run.
 */
async function mkdirInheriting(dir: string): Promise<void> {
  const missing: string[] = [];
  let ancestor = dir;
  while (!existsSync(ancestor)) {
    missing.push(ancestor);
    const parent = dirname(ancestor);
    // dirname('/') === '/', so this is the guard against looping at the root.
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (missing.length === 0) return;

  const template = await stat(ancestor);
  // Shallowest first, so each parent exists before its child is created.
  for (const path of missing.reverse()) {
    try {
      await mkdir(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      continue;
    }
    await copyOwnership(path, template.uid, template.gid, template.mode);
  }
}

/**
 * Best-effort, because only root may hand a file to a different user. Running
 * unprivileged the new path already belongs to us, so a refusal here means the
 * ownership is already as close to right as it can get.
 *
 * chown comes first and chmod second, and the order is load-bearing: chown
 * clears the setgid bit, so doing it afterwards would strip the very bit this
 * function exists to carry over. A shared media directory is usually mode 2775,
 * and losing the setgid on the folders below it is exactly the silent breakage
 * mkdirInheriting was written to prevent. Each call is guarded on its own so a
 * refused chown — the ordinary case when running unprivileged — still leaves
 * the mode applied.
 */
async function copyOwnership(path: string, uid: number, gid: number, mode: number): Promise<void> {
  try {
    await chown(path, uid, gid);
  } catch (err) {
    log.debug(`could not apply ownership to ${path}: ${(err as Error).message}`);
  }
  try {
    await chmod(path, mode & 0o7777);
  } catch (err) {
    log.debug(`could not apply permissions to ${path}: ${(err as Error).message}`);
  }
}

/** Applies one owner to a freshly copied tree, which cp writes as the current user. */
async function applyOwnershipDeep(path: string, uid: number, gid: number): Promise<void> {
  const info = await stat(path);
  await copyOwnership(path, uid, gid, info.mode);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await applyOwnershipDeep(join(path, entry), uid, gid);
  }
}

/** Moves a directory, falling back to copy+delete when crossing filesystems. */
export async function movePath(from: string, to: string): Promise<void> {
  await mkdirInheriting(dirname(to));
  // Captured before the move, since the source is gone by the time we need it.
  const source = await stat(from);
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    log.debug(`cross-device move, copying instead: ${from}`);
    // Unlike rename, cp does not carry ownership across — the copy belongs to
    // whoever abs-butler runs as until this puts it back.
    await cp(from, to, { recursive: true });
    await applyOwnershipDeep(to, source.uid, source.gid);
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
  capability: Capability;
  plans: MovePlan[];
}

/**
 * Why an apply was refused before anything was read.
 *
 * Deliberately distinct from the capability messages: those say the files are
 * out of reach, this says they are within reach and abs-butler has been told
 * not to touch them. Confusing the two sends people to check a mount that is
 * mounted perfectly well.
 */
export const WRITES_DISABLED =
  'File changes are turned off, so organize can plan moves but not carry them out. ' +
  'Turn on "Allow file changes" in Settings to apply this plan.\n' +
  "This is abs-butler's own guard rather than a filesystem permission — it exists so moving " +
  'files is always a deliberate act, and it can be turned straight back off afterwards.';

export async function runOrganizeTask(
  ctx: TaskContext,
  options: OrganizeTaskOptions = {},
): Promise<OrganizeTaskResult> {
  // Checked before the first network call: an apply that is going to be refused
  // should say so immediately, not after reading an entire library.
  if (options.apply && !ctx.settings.allowFileChanges) throw new Error(WRITES_DISABLED);

  const template = options.template ?? DEFAULT_TEMPLATE;
  const allLibraries = await ctx.client.listLibraries();
  const capability = assessCapability(ctx.connection, allLibraries);

  // Organizing is unavailable outright when the media is not mounted here —
  // not "plan now, fail later". abs-butler has no remote file transport, so a
  // plan it could never carry out is a false promise, and one built against
  // paths this machine cannot see is not even verifiable.
  if (!capability.canManageFiles) {
    throw new Error(unavailableMessage(capability.reason));
  }

  const libraries = await resolveLibraries(ctx, options.library);
  const plans: MovePlan[] = [];
  for (const library of libraries) {
    // Expanded, because the path template renders {series} and {sequence} from
    // the structured series field. A minified item has neither, so every book
    // in a series would plan a move to Author/Title — physically lifting it out
    // of its series folder on apply.
    const items = await collectItems(ctx, [library], { limit: options.limit, expand: true });
    for (const item of items) {
      if (item.isFile) {
        log.debug(`skipping single-file item (not a book folder): ${itemTitle(item)}`);
        continue;
      }
      const plan = planMove(item, library, template, ctx.connection);
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
    // Between whole items only. A stopped run leaves the moves it already made
    // in place — they are on disk and correct — and the rescan below still
    // fires for the libraries it touched, so AudiobookShelf is never left
    // pointing at paths that moved out from under it.
    if (ctx.signal?.aborted) {
      log.warn(`stopped after ${moved} move(s) — the rest were left where they are.`);
      break;
    }
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
export function unavailableMessage(reason: string): string {
  return (
    `File organization is unavailable from this machine. ${reason}\n` +
    'organize moves files directly and abs-butler has no remote file access, so it needs the ' +
    'media mounted here — abs-butler is meant to run beside AudiobookShelf and share its ' +
    'library mount. Every other command works over the API and needs no mount at all.'
  );
}

async function moveBlockedReason(plan: MovePlan): Promise<string | null> {
  if (!existsSync(plan.fromLocal)) return `not found at ${plan.fromLocal}`;
  if (existsSync(plan.toLocal)) return `destination already exists: ${plan.toLocal}`;
  const source = await stat(plan.fromLocal);
  if (!source.isDirectory()) return `expected a folder at ${plan.fromLocal}`;
  return null;
}
