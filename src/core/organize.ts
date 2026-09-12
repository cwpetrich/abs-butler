import { existsSync } from 'node:fs';
import { chmod, chown, cp, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { AbsLibrary, AbsLibraryItem } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import type { ConnectionRecord } from '../db/connection.js';
import type { RunItemInput } from '../db/runItems.js';
import { assessCapability, toLocalPath, type Capability } from './capability.js';
import { itemIdentity, plural, reportItems } from './report.js';
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
  /**
   * The library folder this item lives under, on this machine. Tidying up after
   * a move stops here: emptying a library root and then removing it would take
   * the folder AudiobookShelf is configured to watch with it.
   */
  rootLocal: string;
  /**
   * True when the source is a loose file rather than a book folder. It changes
   * what the move is allowed to find on disk, and it is the one case that
   * creates the folder the file lands in.
   */
  fromFile?: boolean;
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

/**
 * Where a loose file goes.
 *
 * AudiobookShelf accepts a bare `The Hobbit.m4b` sitting in a library root as
 * a library item, and a great many libraries are largely that. The template
 * renders a *folder* path, so a file needs one more decision: it is given the
 * folder the template describes and keeps its own extension, which leaves the
 * library uniform — every item a folder, nothing loose — and matches the
 * layout AudiobookShelf recommends.
 *
 *   The Hobbit.m4b -> J.R.R. Tolkien/The Hobbit/The Hobbit.m4b
 *
 * The file inside is named from the title rather than from the last template
 * segment, so a series book does not end up as `01 - The Final Empire.m4b`
 * inside a folder already called `01 - The Final Empire`.
 */
function fileTarget(item: AbsLibraryItem, folderPath: string): string | null {
  const extension = extname(item.relPath || item.path);
  if (!extension) return null;
  const vars = templateVars(item);
  return `${folderPath}/${vars.title}${extension}`;
}

/**
 * Why an item is not moving.
 *
 * `in-place` is the good outcome and the common one — the book is already where
 * the template says it belongs. The rest are the run declining, and each one
 * used to be an indistinguishable `null`: a library where every item failed to
 * render a path reported exactly the same "0 items to move" as one that was
 * already perfectly organized.
 */
export type NoMoveCode =
  | 'in-place'
  | 'unknown-folder'
  | 'template-empty'
  | 'no-extension'
  | 'outside-root';

export interface NoMove {
  code: NoMoveCode;
  reason: string;
}

export type MoveOutcome = { plan: MovePlan } | { plan: null } & NoMove;

/**
 * Where an item belongs under the template, or why that question has no answer
 * for it.
 *
 * `planMove` is the same decision with the reason thrown away; it stays because
 * most callers only want the plan.
 */
export function planMoveOutcome(
  item: AbsLibraryItem,
  library: AbsLibrary,
  template: string,
  config: Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'>,
): MoveOutcome {
  const folder = library.folders.find((f) => f.id === item.folderId) ?? library.folders[0];
  if (!folder) {
    return { plan: null, code: 'unknown-folder', reason: 'its library folder is not one this server reports' };
  }

  const rendered = renderTemplate(template, templateVars(item));
  if (!rendered) {
    return {
      plan: null,
      code: 'template-empty',
      reason: `the template rendered empty — ${template} needs fields this item does not have`,
    };
  }

  // A file with no extension is left alone: it cannot be named on the far side
  // without inventing one, and guessing at a media type is not this tool's job.
  const target = item.isFile ? fileTarget(item, rendered) : rendered;
  if (!target) {
    return { plan: null, code: 'no-extension', reason: 'it is a loose file with no extension to move under' };
  }

  const currentRel = (item.relPath ?? '').replace(/^\/+/, '');
  if (currentRel === target) return { plan: null, code: 'in-place', reason: 'it already matches the template' };

  const fromLocal = toLocalPath(item.path, config);
  const folderLocal = toLocalPath(folder.fullPath, config);
  if (!fromLocal || !folderLocal) {
    return {
      plan: null,
      code: 'outside-root',
      reason: `its path (${item.path}) is not under the configured library root`,
    };
  }

  const toLocal = join(folderLocal, target);
  if (resolve(fromLocal) === resolve(toLocal)) {
    return { plan: null, code: 'in-place', reason: 'it already matches the template' };
  }

  return {
    plan: {
      itemId: item.id,
      title: itemTitle(item),
      ...(item.isFile ? { fromFile: true } : {}),
      rootLocal: folderLocal,
      from: currentRel || item.path,
      to: target,
      fromLocal,
      toLocal,
      libraryId: item.libraryId,
    },
  };
}

export function planMove(
  item: AbsLibraryItem,
  library: AbsLibrary,
  template: string,
  config: Pick<ConnectionRecord, 'libraryRoot' | 'pathPrefix'>,
): MovePlan | null {
  return planMoveOutcome(item, library, template, config).plan;
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

/**
 * Moves a file or directory, falling back to copy+delete when crossing
 * filesystems.
 *
 * `stopAt` bounds the tidying afterwards. Without it, moving the last item out
 * of a library root would leave that root empty and then remove it — which is
 * the folder AudiobookShelf is configured to watch, so the library would come
 * back empty on the next scan. Loose files make this likely rather than
 * theoretical: they sit in the root itself.
 */
export async function movePath(from: string, to: string, stopAt?: string): Promise<void> {
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
  await pruneEmptyParents(dirname(from), stopAt);
}

/**
 * Cleans up directories left behind by a move, stopping at the first non-empty
 * one — and never at or above `boundary`, which is the library root.
 */
async function pruneEmptyParents(dir: string, boundary?: string, depth = 3): Promise<void> {
  const limit = boundary ? resolve(boundary) : null;
  for (let i = 0; i < depth; i++) {
    if (!existsSync(dir) || dir === sep) return;
    if (limit && (resolve(dir) === limit || !resolve(dir).startsWith(limit + sep))) return;
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
  /**
   * Also file loose single-file items — a bare `The Hobbit.m4b` in a library
   * root — into the folder the template describes.
   *
   * Off by default, and deliberately so. It is the one change here that
   * *creates* structure rather than rearranging it, on the items most likely to
   * be numerous, and `revert` cannot undo a move. Turn it on once a dry run has
   * shown what it would do.
   */
  singleFiles?: boolean;
}

export interface OrganizeTaskResult {
  template: string;
  /** Every item read, whether or not the template had anything to say about it. */
  scanned: number;
  planned: number;
  moved: number;
  /** Already where the template says they belong. */
  inPlace: number;
  skipped: Array<{ title: string; reason: string }>;
  /** Why the items with no plan have none, counted by reason. */
  declined: Partial<Record<NoMoveCode, number>>;
  /** True when the run was stopped before it reached every planned move. */
  stopped: boolean;
  /** Planned moves it never got to, because it was stopped. */
  notReached: number;
  applied: boolean;
  rescanned: boolean;
  capability: Capability;
  plans: MovePlan[];
  /**
   * Exactly what was recorded against the run, one row per item — moved,
   * already in place, or left alone with the reason why. Returned as well as
   * stored so `--details` and the run's page in the web UI say the same thing.
   */
  report: RunItemInput[];
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
  /** Single-file items passed over, so a dry run can say so out loud. */
  const loose: Array<{ title: string; reason: string }> = [];
  const declined: Partial<Record<NoMoveCode, number>> = {};
  // One row per item read, keyed so the apply loop below can say what actually
  // became of the ones it planned to move.
  const rows = new Map<string, RunItemInput>();
  let scanned = 0;

  for (const library of libraries) {
    // Expanded, because the path template renders {series} and {sequence} from
    // the structured series field. A minified item has neither, so every book
    // in a series would plan a move to Author/Title — physically lifting it out
    // of its series folder on apply.
    const items = await collectItems(ctx, [library], { limit: options.limit, expand: true });
    for (const item of items) {
      scanned += 1;
      if (item.isFile && !options.singleFiles) {
        // Reported rather than hidden at debug. A library that is mostly loose
        // m4b files would otherwise see "0 items to move" and conclude the tool
        // had nothing to offer it, when in fact it had declined to look.
        loose.push({ title: itemTitle(item), reason: 'single file — pass --single-files to include it' });
        rows.set(item.id, {
          ...itemIdentity(item),
          status: 'skipped',
          codes: ['single-file'],
          detail: ['A loose file rather than a book folder — pass --single-files to file it away'],
        });
        continue;
      }

      const outcome = planMoveOutcome(item, library, template, ctx.connection);
      if (outcome.plan) {
        plans.push(outcome.plan);
        rows.set(item.id, {
          ...itemIdentity(item),
          status: 'action',
          codes: ['planned'],
          // Conditional until it has happened; the apply loop below rewrites
          // this line for the ones it actually moves.
          detail: [`Would move: ${outcome.plan.from} → ${outcome.plan.to}`],
        });
        continue;
      }

      declined[outcome.code] = (declined[outcome.code] ?? 0) + 1;
      rows.set(item.id, {
        ...itemIdentity(item),
        // Already in the right place is the library being correct, not the run
        // refusing; the other reasons are the run unable to answer.
        status: outcome.code === 'in-place' ? 'clean' : 'skipped',
        codes: [outcome.code],
        detail: [`Not moving: ${outcome.reason}`],
      });
    }
  }

  if (loose.length > 0) {
    log.info(
      `${plural(loose.length, 'single-file item')} left alone. --single-files files them into ` +
        'the folder the template describes.',
    );
  }

  // What the template made of the library, rather than only the part of it that
  // is going to move. An item with no plan had a reason for having none, and
  // until now every one of those reasons was reported as silence.
  const inPlace = declined['in-place'] ?? 0;
  log.info(
    `${scanned} item(s) read — ${plans.length} to move, ${inPlace} already in place` +
      `${loose.length > 0 ? `, ${loose.length} loose file(s)` : ''}`,
  );
  const unanswerable = Object.entries(declined).filter(([code]) => code !== 'in-place');
  for (const [code, count] of unanswerable) {
    const example = [...rows.values()].find((row) => row.codes.includes(code));
    log.warn(`${plural(count, 'item')} could not be placed (${code}) — e.g. ${example?.detail[0] ?? code}`);
  }

  const skipped: Array<{ title: string; reason: string }> = [...loose];
  let moved = 0;
  let rescanned = false;
  /** Planned moves the run was stopped before reaching. */
  let unreached = 0;

  const finish = (applied: boolean): OrganizeTaskResult => {
    const report = [...rows.values()];
    reportItems(ctx, report);
    return {
      template,
      scanned,
      planned: plans.length,
      moved,
      inPlace,
      skipped,
      declined,
      stopped: Boolean(ctx.signal?.aborted),
      notReached: unreached,
      applied,
      rescanned,
      capability,
      plans,
      report,
    };
  };

  if (!options.apply) {
    log.info(`${plural(plans.length, 'item')} would move. Apply to move files on disk.`);
    return finish(false);
  }

  const touchedLibraries = new Set<string>();
  let blocked = 0;
  for (const plan of plans) {
    // Between whole items only. A stopped run leaves the moves it already made
    // in place — they are on disk and correct — and the rescan below still
    // fires for the libraries it touched, so AudiobookShelf is never left
    // pointing at paths that moved out from under it.
    if (ctx.signal?.aborted) {
      log.warn(`stopped after ${moved} move(s) — the rest were left where they are.`);
      // Marked individually, so the report distinguishes a book the run never
      // got to from one it looked at and refused to move.
      for (const rest of plans.slice(plans.indexOf(plan))) {
        unreached += 1;
        const row = rows.get(rest.itemId);
        if (row) {
          row.status = 'skipped';
          row.codes = ['not-reached'];
          row.detail = [
            `Not moved: ${rest.from} → ${rest.to}`,
            'The run was stopped before reaching this one',
          ];
        }
      }
      break;
    }
    const reason = await moveBlockedReason(plan);
    if (reason) {
      log.warn(`skipping "${plan.title}" — ${reason}`);
      skipped.push({ title: plan.title, reason });
      blocked += 1;
      const row = rows.get(plan.itemId);
      if (row) {
        row.status = 'skipped';
        row.codes = ['blocked'];
        row.detail = [`Not moved: ${plan.from} → ${plan.to}`, reason];
      }
      continue;
    }
    await movePath(plan.fromLocal, plan.toLocal, plan.rootLocal);
    touchedLibraries.add(plan.libraryId);
    moved += 1;
    const row = rows.get(plan.itemId);
    if (row) {
      row.codes = ['moved'];
      row.detail = [`Moved: ${plan.from} → ${plan.to}`];
    }
    log.debug(`moved ${plan.from} -> ${plan.to}`);
  }
  log.success(
    `Moved ${plural(moved, 'item')} of ${plans.length} planned` +
      `${blocked > 0 ? `; ${blocked} blocked` : ''}${unreached > 0 ? `; ${unreached} not reached` : ''}.`,
  );

  if (moved > 0 && !options.noScan) {
    for (const libraryId of touchedLibraries) await ctx.client.scanLibrary(libraryId);
    rescanned = true;
    log.success('Triggered a rescan so AudiobookShelf picks up the new paths.');
  }

  return finish(true);
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
  if (plan.fromFile) {
    if (source.isDirectory()) return `expected a file at ${plan.fromLocal}, found a folder`;
  } else if (!source.isDirectory()) {
    return `expected a folder at ${plan.fromLocal}`;
  }
  return null;
}
