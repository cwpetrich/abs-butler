import { existsSync } from 'node:fs';
import { stat, utimes } from 'node:fs/promises';
import type { AbsAudioFile, AbsChapter, AbsLibraryItem } from '../abs/types.js';
import { collectItems, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import type { RunItemInput } from '../db/runItems.js';
import { recordRevision, updateRevisionAfter } from '../db/revisions.js';
import { log } from '../logger.js';
import { checkLocalRoot, toLocalPath } from './capability.js';
import type { ItemPlan } from './plans.js';
import { breakdown, itemIdentity, plural, reportItems } from './report.js';

/**
 * Mending an item that lists every audio file twice.
 *
 * When a library moves to new storage — new paths and new inodes at once — a
 * rescan updates each file on disk in place but cannot match it back to the
 * audio record it belonged to, so it adds a second record beside the first. The
 * old one points at an inode that no longer exists, so it 404s; the new one
 * plays. The item's length is the sum of both, and every client plays one copy
 * against a timeline twice as long. No rescan removes the old record, and
 * "Remove items with issues" never sees it, because nothing is missing.
 *
 * Excluding the dead records in "Manage tracks" looks like the fix and is not.
 * It mends the track list, but the item's length is a stored number that only a
 * rescan recomputes, and a rescan adds up every record — excluded ones too. So
 * the dead records have to leave the item entirely, and then a rescan has to be
 * given a reason to recompute: it does so only when a file changed on disk or
 * the number of records disagrees with the number of files. There are four
 * ways to arrange that, all verified against AudiobookShelf 2.36:
 *
 *   rescan-one  Drop the dead records and one live track. The rescan finds a
 *               file with no record, adds it back, and recomputes. API only,
 *               and the item is never without tracks — but it needs two.
 *   touch       Drop the dead records and touch one live file, so the rescan
 *               sees a change. For a one-file book; needs the media mounted
 *               here and "Allow file changes".
 *   clear       Empty the track list, so the rescan rebuilds it from disk. For
 *               a one-file book when touching is not possible. The item has no
 *               tracks until the rescan finishes, and it relies on a field ABS
 *               has marked for removal.
 *   library-scan  For a book that is a bare file at the library root, which
 *               ABS refuses to rescan on its own. Drop the dead records and
 *               touch the file, then scan the whole library: a library scan
 *               rescans an item whose file changed, and recomputes its length
 *               from the records left. Needs the same access as a touch, and
 *               every such book in a run shares one scan.
 *   records-only  For a bare file this install cannot touch. Drop the dead
 *               records and trim the chapters to the real length, all over the
 *               API, and stop there: the stored length stays doubled until
 *               AudiobookShelf next rescans the file. Partial, and said to be —
 *               but nothing plays a file that is gone any more, and the plan is
 *               kept so an apply can finish it once the file is in reach.
 *
 * A length left doubled — by records-only, or by somebody removing the dead
 * records by hand — is damage of its own: the item has no dead records left to
 * find, so it is recognised by its stored length running past what its tracks
 * add up to, and mended by the same routes minus the records to drop.
 *
 * Chapters are rebuilt by the same rescan when the book has several files or
 * chapters embedded in one. A one-file book without them keeps its doubled
 * chapters, so those are trimmed back to the real length afterwards.
 */

/**
 * Above this, an inode is one an SMB mount invented because it had no real one
 * to report. They can change on the next scan, which would do all this again.
 */
export const SYNTHETIC_INODE = 2 ** 49;

export const TRACK_REPAIR_DISABLED =
  'Track repair is turned off, so repair can find the damage but not mend it. ' +
  'Turn on "Allow track repair" in Settings, or run: abs-butler configure --track-repair on\n' +
  "It rewrites an item's track list and rescans it. It never changes what is in a file, but " +
  'it does change what AudiobookShelf plays, so it is something to choose rather than a default.';

export type RepairMethod = 'rescan-one' | 'touch' | 'clear' | 'library-scan' | 'records-only';

export const REPAIR_METHODS: readonly RepairMethod[] = ['rescan-one', 'touch', 'clear', 'library-scan', 'records-only'];

/** How often to ask whether a library scan has finished, and how long to wait for one. */
const SCAN_POLL_MS = 2000;
const SCAN_TIMEOUT_MS = 30 * 60_000;

/** What an item's audio records say, and whether they can be mended safely. */
export interface Assessment {
  /** Records whose inode is no longer among the files on disk. */
  dead: AbsAudioFile[];
  /** Every other record, in the order the item plays them. */
  live: AbsAudioFile[];
  durationBefore: number;
  /**
   * The length once the dead records are gone, by AudiobookShelf's own
   * arithmetic: every remaining record, excluded ones included.
   */
  durationAfter: number;
  /**
   * No dead records, but a stored length longer than the tracks add up to: the
   * records were dropped and nothing has rescanned the item since.
   */
  staleLength: boolean;
  /** Why the item is left alone, when it is. */
  problem: string | null;
  /** Whether a live file carries an inode an SMB mount made up. */
  synthetic: boolean;
}

/** Durations are floats probed from files; two copies of one file agree to well within this. */
function durationTolerance(seconds: number): number {
  return Math.max(1, seconds * 0.005);
}

export function assessItem(item: AbsLibraryItem): Assessment {
  const records = item.media?.audioFiles;
  const files = item.libraryFiles;
  const durationBefore = item.media?.duration ?? 0;
  if (!records || !files) {
    return {
      dead: [],
      live: [],
      durationBefore,
      durationAfter: durationBefore,
      staleLength: false,
      problem: 'Its track list could not be read',
      synthetic: false,
    };
  }

  const onDisk = new Set(files.map((file) => String(file.ino)));
  const dead = records.filter((record) => !onDisk.has(String(record.ino)));
  const live = records.filter((record) => onDisk.has(String(record.ino)));
  const durationAfter = live.reduce((sum, record) => sum + (Number(record.duration) || 0), 0);
  const synthetic = live.some((record) => Number(record.ino) > SYNTHETIC_INODE);
  const staleLength = dead.length === 0 && durationBefore > durationAfter + durationTolerance(durationAfter);
  const assessment = { dead, live, durationBefore, durationAfter, staleLength, problem: null, synthetic };
  if (!isDamaged(assessment)) return assessment;

  return { ...assessment, problem: ambiguity(dead, live) };
}

export function isDamaged(assessment: Pick<Assessment, 'dead' | 'staleLength'>): boolean {
  return assessment.dead.length > 0 || assessment.staleLength;
}

/**
 * Whether it is certain that the dead records are copies of the live ones.
 *
 * Every dead record needs a live counterpart of its own — same file name, and
 * the same size or length — or the "dead" copy might be the only record of a
 * part that is genuinely gone, and removing it would hide a real loss. Two real
 * copies of a book (an m4b beside an mp3 set) are not this at all: both are on
 * disk, so neither is dead, and they never reach here.
 */
function ambiguity(dead: AbsAudioFile[], live: AbsAudioFile[]): string | null {
  if (!live.some((record) => !record.exclude)) {
    return 'No playable track would remain once the dead records were gone';
  }

  const unclaimed = [...live];
  for (const record of dead) {
    const match = unclaimed.findIndex(
      (candidate) =>
        candidate.metadata?.filename === record.metadata?.filename &&
        (candidate.metadata?.size === record.metadata?.size ||
          Math.abs(Number(candidate.duration) - Number(record.duration)) <=
            durationTolerance(Number(record.duration))),
    );
    if (match === -1) {
      return `No file on disk matches the dead record for "${record.metadata?.filename ?? record.ino}"`;
    }
    unclaimed.splice(match, 1);
  }
  return null;
}

/**
 * The file a touch would change, or why none can be.
 *
 * Worked out once per run: whether abs-butler may write to the library is a
 * property of the install, not of the book.
 */
export interface TouchAccess {
  allowed: boolean;
  reason: string;
}

export function touchAccess(ctx: TaskContext): TouchAccess {
  if (!ctx.settings.allowFileChanges) {
    return { allowed: false, reason: '"Allow file changes" is off' };
  }
  const local = checkLocalRoot(ctx.connection);
  if (!local.canManageFiles) return { allowed: false, reason: local.reason };
  return { allowed: true, reason: '' };
}

function touchTarget(ctx: TaskContext, assessment: Assessment, access: TouchAccess): string | null {
  if (!access.allowed) return null;
  for (const record of assessment.live) {
    const local = toLocalPath(record.metadata?.path ?? '', ctx.connection);
    if (local && existsSync(local)) return local;
  }
  return null;
}

/**
 * Why a book's length cannot be put right from here — a matter of this install
 * rather than of the book, so it is worth saying what would change it.
 *
 * Only a bare file has such a reason. AudiobookShelf rescans one of those only
 * as part of a library scan, and only once its file has changed, so the file
 * has to be touched; every other book has a route that needs nothing but the
 * API. Its dead records can still be dropped (records-only); a book with none
 * left has nothing that can be done for it until then.
 */
export function lengthPendingReason(
  ctx: TaskContext,
  item: AbsLibraryItem,
  assessment: Assessment,
  access: TouchAccess,
): string | null {
  if (!item.isFile || touchTarget(ctx, assessment, access) !== null) return null;
  const why = access.allowed ? 'its file is not somewhere this machine can reach' : access.reason;
  return (
    'It is a single file at the library root, which AudiobookShelf rescans only in a library scan ' +
    `and only once the file has changed — so setting its length means touching the file, and ${why}`
  );
}

export function chooseMethod(assessment: Assessment, canTouch: boolean, isFile = false): RepairMethod {
  if (isFile) return canTouch ? 'library-scan' : 'records-only';
  if (assessment.live.filter((record) => !record.exclude).length >= 2) return 'rescan-one';
  return canTouch ? 'touch' : 'clear';
}

function methodLine(method: RepairMethod, apply: boolean): string {
  const verb = apply ? 'Repaired' : 'Would repair';
  switch (method) {
    case 'rescan-one':
      return `${verb} by dropping the dead records and one live track, then rescanning the item — the rescan adds the track back and recomputes the length`;
    case 'touch':
      return `${verb} by dropping the dead records and touching one of its files, so a rescan of the item recomputes the length`;
    case 'clear':
      return `${verb} by emptying the track list and rescanning the item, which rebuilds it from the files on disk`;
    case 'library-scan':
      return `${verb} by dropping the dead records and touching its file, then scanning the library — AudiobookShelf will not rescan a bare file on its own`;
    case 'records-only':
      return `${apply ? 'Partly repaired' : 'Would partly repair'} by dropping the dead records and trimming its chapters, so nothing plays a file that is gone — its length stays doubled until AudiobookShelf rescans the file`;
  }
}

/** "16h37m", "4m12s", "9s" — the lengths are the point of the report. */
export function clock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** The lines every report of a damaged item opens with, dry run or not. */
export function describeDamage(assessment: Assessment, doubledProgress = 0): string[] {
  const total = assessment.dead.length + assessment.live.length;
  const lines = [
    assessment.dead.length > 0
      ? `${assessment.dead.length} of ${total} audio records point at files no longer on disk`
      : 'Its dead audio records are gone, but its length was never recomputed without them',
    `Length ${clock(assessment.durationBefore)} → ${clock(assessment.durationAfter)}`,
  ];
  if (doubledProgress > 0) {
    lines.push(
      `${plural(doubledProgress, 'listening position')} saved against the doubled length — ` +
        'reported, not changed',
    );
  }
  if (assessment.synthetic) {
    lines.push(
      'Its files carry inodes an SMB mount made up, which can change on the next scan and ' +
        'bring this back',
    );
  }
  return lines;
}

/** Codes a damaged item's row carries, whatever became of it. */
function damageCodes(assessment: Assessment, doubledProgress: number): string[] {
  const codes = [assessment.dead.length > 0 ? 'dead-audio-record' : 'stale-length'];
  if (doubledProgress > 0) codes.push('doubled-progress');
  if (assessment.synthetic) codes.push('synthetic-inode');
  return codes;
}

export function planFor(assessment: Assessment): ItemPlan {
  return {
    kind: 'repair',
    dead: assessment.dead.map((record) => String(record.ino)),
    live: assessment.live.map((record) => String(record.ino)),
    durationBefore: assessment.durationBefore,
    durationAfter: assessment.durationAfter,
  };
}

/**
 * Chapters that run past the end of the book, cut back to it.
 *
 * Null when nothing needs cutting, or when cutting would leave nothing — a
 * chapter list that bears no relation to the book's length is not something to
 * guess at.
 */
export function trimChapters(chapters: AbsChapter[], duration: number): AbsChapter[] | null {
  const slack = 0.5;
  if (!chapters.some((chapter) => chapter.end > duration + slack)) return null;
  const kept = chapters
    .filter((chapter) => chapter.start < duration - slack)
    .map((chapter, id) => ({ id, start: chapter.start, end: Math.min(chapter.end, duration), title: chapter.title }));
  if (kept.length === 0) return null;
  kept[kept.length - 1]!.end = duration;
  return kept;
}

/**
 * Why a repaired item is still not right, or null when it is. The length is
 * left out of it for a records-only repair, which does not claim to set it.
 */
export function verifyRepair(item: AbsLibraryItem, assessment: Assessment, checkLength = true): string | null {
  const records = item.media?.audioFiles ?? [];
  const onDisk = new Set((item.libraryFiles ?? []).map((file) => String(file.ino)));
  const deadLeft = records.filter((record) => !onDisk.has(String(record.ino))).length;
  if (deadLeft > 0) return `${plural(deadLeft, 'dead record')} still on the item`;

  const present = new Set(records.map((record) => String(record.ino)));
  const lost = assessment.live.find((record) => !present.has(String(record.ino)));
  if (lost) return `"${lost.metadata?.filename ?? lost.ino}" did not come back from the rescan`;

  const duration = item.media?.duration ?? 0;
  if (checkLength && Math.abs(duration - assessment.durationAfter) > durationTolerance(assessment.durationAfter)) {
    return `its length is ${clock(duration)}, not the ${clock(assessment.durationAfter)} its tracks add up to`;
  }
  return null;
}

export interface RepairOutcome {
  ok: boolean;
  method: RepairMethod;
  lines: string[];
  codes: string[];
}

export interface RepairTarget {
  item: AbsLibraryItem;
  assessment: Assessment;
}

/** A repair whose writes are done, waiting on the rescan that makes them count. */
interface Begun extends RepairTarget {
  method: RepairMethod;
  revisionId: number | undefined;
  /** For records-only: why the length could not be set too. */
  pending: string | null;
}

/**
 * Carries out repairs and checks each one took.
 *
 * A book in a folder is rescanned the moment it has been mended. A bare file
 * cannot be — AudiobookShelf refuses — so those are all readied first and then
 * share one scan of their library, since each scan is a walk of the whole
 * library and a run can hold hundreds of them.
 *
 * The undo record is written before the first call, like every other write, and
 * holds the track and chapter lists whole. It is completed with what the rescan
 * actually produced, so `revert` can tell if the item has changed since. What it
 * cannot put back is the length: nothing but a rescan sets that, and a revert
 * restoring the dead records leaves the next rescan to double it again.
 *
 * Never throws for a failure on the server; a half-done repair is reported as a
 * failure of that book, and the run moves on to the next. The outcomes come
 * back in the order given, with null for a book the run was stopped before
 * reaching.
 */
export async function repairItems(
  ctx: TaskContext,
  targets: RepairTarget[],
  access: TouchAccess,
): Promise<Array<RepairOutcome | null>> {
  const outcomes: Array<RepairOutcome | null> = targets.map(() => null);
  const waiting = new Map<string, Array<{ index: number; begun: Begun }>>();

  for (const [index, target] of targets.entries()) {
    // Between whole items, so a stopped run never leaves one half-mended.
    if (ctx.signal?.aborted) break;
    const begun = await beginRepair(ctx, target, access);
    if ('ok' in begun) {
      outcomes[index] = begun;
    } else if (begun.method === 'records-only') {
      // Nothing to rescan: nothing this install can do would make it count.
      outcomes[index] = await finishRepair(ctx, begun);
    } else if (begun.method === 'library-scan') {
      const group = waiting.get(begun.item.libraryId) ?? [];
      group.push({ index, begun });
      waiting.set(begun.item.libraryId, group);
    } else {
      outcomes[index] = await rescanAndFinish(ctx, begun);
    }
    if ((index + 1) % 25 === 0) log.info(`  repaired ${index + 1}/${targets.length}`);
  }

  // Scanned even when the run has been stopped: these books have already lost
  // their dead records and been touched, and the scan is what finishes them.
  for (const [libraryId, group] of waiting) {
    log.info(`scanning the library so AudiobookShelf rescans ${plural(group.length, 'bare-file book')}…`);
    const problem = await scanLibraryAndWait(ctx, libraryId);
    for (const { index, begun } of group) {
      outcomes[index] = problem ? unfinished(begun, problem) : await finishRepair(ctx, begun);
    }
  }
  return outcomes;
}

/** Records the undo and makes the writes, stopping short of the rescan. */
async function beginRepair(
  ctx: TaskContext,
  { item, assessment }: RepairTarget,
  access: TouchAccess,
): Promise<Begun | RepairOutcome> {
  const touchPath = touchTarget(ctx, assessment, access);
  const method = chooseMethod(assessment, touchPath !== null, Boolean(item.isFile));

  // With no dead records left to drop, records-only would write nothing at all.
  const pending = lengthPendingReason(ctx, item, assessment, access);
  if (pending && assessment.dead.length === 0) {
    return { ok: false, method, lines: [`Not repaired: ${pending}`], codes: ['needs-file-changes'] };
  }

  const revisionId =
    ctx.runId === undefined
      ? undefined
      : recordRevision(ctx.db, {
          runId: ctx.runId,
          itemId: item.id,
          title: itemTitle(item),
          before: { audioFiles: item.media.audioFiles ?? [], chapters: item.media.chapters ?? [] },
          after: { audioFiles: assessment.live },
        });

  try {
    // Every live record, with the exclusions somebody chose kept as they were.
    const keep = assessment.live.map((record) => ({ ino: String(record.ino), exclude: Boolean(record.exclude) }));
    switch (method) {
      case 'rescan-one': {
        let last = -1;
        keep.forEach((entry, index) => {
          if (!entry.exclude) last = index;
        });
        keep.splice(last, 1);
        await ctx.client.updateTracks(item.id, keep);
        break;
      }
      case 'records-only':
        await ctx.client.updateTracks(item.id, keep);
        break;
      case 'touch':
      case 'library-scan': {
        await ctx.client.updateTracks(item.id, keep);
        // The modification time only; the contents are not opened.
        const { atime } = await stat(touchPath!);
        await utimes(touchPath!, atime, new Date());
        break;
      }
      case 'clear':
        await ctx.client.patchItemMedia(item.id, { audioFiles: [] });
        break;
    }
    return { item, assessment, method, revisionId, pending };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return failedPartWay(method, err);
  }
}

async function rescanAndFinish(ctx: TaskContext, begun: Begun): Promise<RepairOutcome> {
  try {
    const verdict = await ctx.client.scanItem(begun.item.id);
    log.debug(`rescanned ${begun.item.id}: ${verdict}`);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return failedPartWay(begun.method, err);
  }
  return finishRepair(ctx, begun);
}

/** After the rescan: trims what it left too long, completes the undo, and checks. */
async function finishRepair(
  ctx: TaskContext,
  { item, assessment, method, revisionId, pending }: Begun,
): Promise<RepairOutcome> {
  const partial = method === 'records-only';
  try {
    let after = await ctx.client.getItem(item.id);

    const lines = [methodLine(method, true)];
    // A records-only repair has no rescan to trust for the length, so the
    // chapters are cut to what the tracks add up to instead — the same number
    // a rescan would arrive at.
    const length = partial ? assessment.durationAfter : (after.media?.duration ?? 0);
    const trimmed = trimChapters(after.media?.chapters ?? [], length);
    if (trimmed) {
      await ctx.client.updateChapters(item.id, trimmed);
      after = await ctx.client.getItem(item.id);
      lines.push(`Trimmed its chapters to ${plural(trimmed.length, 'chapter')} ending at ${clock(length)}`);
    }
    if (partial) {
      lines.push(`Its length is still ${clock(after.media?.duration ?? 0)}: ${pending ?? 'it needs a rescan'}`);
      lines.push('Run repair again once that is fixed, or apply this run again, to set it');
    }

    if (revisionId !== undefined) {
      updateRevisionAfter(ctx.db, revisionId, {
        audioFiles: after.media?.audioFiles ?? [],
        chapters: after.media?.chapters ?? [],
      });
    }

    const problem = verifyRepair(after, assessment, !partial);
    if (problem) {
      return { ok: false, method, lines: [...lines, `Not right afterwards: ${problem}`], codes: ['failed', method] };
    }
    return { ok: true, method, lines, codes: [partial ? 'partly-repaired' : 'repaired', method] };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return failedPartWay(method, err);
  }
}

function failedPartWay(method: RepairMethod, err: unknown): RepairOutcome {
  return {
    ok: false,
    method,
    lines: [`Repair failed part-way: ${(err as Error).message}`, 'Its earlier track list is kept — `revert` puts it back'],
    codes: ['failed', method],
  };
}

/** A bare file that was readied but never saw the scan that would finish it. */
function unfinished(begun: Begun, problem: string): RepairOutcome {
  return {
    ok: false,
    method: begun.method,
    lines: [
      `Its dead records are gone and its file was touched, but ${problem}`,
      'The next scan of the library sets its length; run repair again afterwards to check it',
    ],
    codes: ['failed', begun.method],
  };
}

/**
 * Scans a library and waits for the scan to end, or says why it did not.
 *
 * A scan already running would swallow this one, and may already be past the
 * books that need it, so that one is waited out first.
 */
async function scanLibraryAndWait(ctx: TaskContext, libraryId: string): Promise<string | null> {
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  const settle = async () => {
    while (await ctx.client.isScanningLibrary(libraryId)) {
      if (Date.now() > deadline) return false;
      await pause(SCAN_POLL_MS, ctx.signal);
    }
    return true;
  };
  try {
    if (!(await settle())) return 'a library scan already running had not finished after 30 minutes';
    await ctx.client.scanLibrary(libraryId);
    if (!(await settle())) return 'the library scan had not finished after 30 minutes';
    return null;
  } catch (err) {
    return ctx.signal?.aborted
      ? 'the run was stopped before the library scan finished'
      : `the library scan failed: ${(err as Error).message}`;
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('stopped'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('stopped'));
      },
      { once: true },
    );
  });
}

/**
 * How many saved listening positions, per item, were written against a length
 * well beyond the real one.
 *
 * Reported and never changed. A listener's place is theirs, and the doubled
 * timeline interleaves dead and live copies track by track, so there is no
 * simple rescaling that would put it back where they were. Null when progress
 * could not be read — it needs an admin token.
 */
export async function doubledProgress(
  ctx: TaskContext,
  expected: Map<string, number>,
): Promise<Map<string, number> | null> {
  if (expected.size === 0) return new Map();
  try {
    const counts = new Map<string, number>();
    for (const user of await ctx.client.listUsers()) {
      for (const progress of await ctx.client.getUserProgress(user.id)) {
        const length = expected.get(progress.libraryItemId);
        if (length === undefined || progress.episodeId) continue;
        if (progress.duration > length * 1.25) {
          counts.set(progress.libraryItemId, (counts.get(progress.libraryItemId) ?? 0) + 1);
        }
      }
    }
    return counts;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    log.warn(`could not read listening progress, so positions saved against the doubled length are not counted: ${(err as Error).message}`);
    return null;
  }
}

export interface RepairTaskOptions {
  library?: string;
  limit?: number;
  apply?: boolean;
}

export interface RepairTaskResult {
  scanned: number;
  /** Items with at least one dead record. */
  affected: number;
  /** Of those, the ones certain enough to mend. */
  repairable: number;
  /** Damaged, and left alone because the dead records could not be matched. */
  ambiguous: number;
  /**
   * Bare files with nothing left that the API can mend: their dead records are
   * already gone, and only a touch of the file would set their length.
   */
  needsFileChanges: number;
  repaired: number;
  /** Repaired records-only: dead records gone, length still waiting on a rescan. */
  partlyRepaired: number;
  failed: number;
  applied: boolean;
  /** How each repairable item was, or would be, mended. */
  methods: Partial<Record<RepairMethod, number>>;
  /** Listening positions saved against a doubled length. Null if unreadable. */
  doubledProgress: number | null;
  /** Damaged items whose files carry SMB-invented inodes. */
  syntheticInodes: number;
  stopped: boolean;
  notReached: number;
  report: RunItemInput[];
}

export async function runRepairTask(
  ctx: TaskContext,
  options: RepairTaskOptions = {},
): Promise<RepairTaskResult> {
  // Refused before the first call, like organize: an apply that is going to be
  // turned away should say so before reading an entire library.
  if (options.apply && !ctx.settings.allowTrackRepair) throw new Error(TRACK_REPAIR_DISABLED);

  const libraries = await resolveLibraries(ctx, options.library);
  // Expanded, one request per item: the minified listing has neither the audio
  // records nor the files on disk, and the damage is the gap between the two.
  const items = await collectItems(ctx, libraries, { limit: options.limit, expand: true });
  const access = touchAccess(ctx);

  const assessed = items.map((item) => ({ item, assessment: assessItem(item) }));
  const damaged = assessed.filter(({ assessment }) => isDamaged(assessment));
  const progress = await doubledProgress(
    ctx,
    new Map(damaged.map(({ item, assessment }) => [item.id, assessment.durationAfter])),
  );

  const report: RunItemInput[] = [];
  const methods: Partial<Record<RepairMethod, number>> = {};
  let ambiguous = 0;
  let needsFileChanges = 0;
  let repairable = 0;
  let repaired = 0;
  let partlyRepaired = 0;
  let failed = 0;
  let notReached = 0;
  let syntheticInodes = 0;
  const targets: Array<
    RepairTarget & { identity: ReturnType<typeof itemIdentity>; lines: string[]; codes: string[] }
  > = [];

  for (const { item, assessment } of assessed) {
    const identity = itemIdentity(item);

    if (!isDamaged(assessment)) {
      report.push({
        ...identity,
        status: assessment.problem ? 'skipped' : 'clean',
        codes: assessment.problem ? ['unreadable'] : [],
        detail: [assessment.problem ?? 'Every audio record points at a file on disk'],
        plan: null,
      });
      continue;
    }

    const doubled = progress?.get(item.id) ?? 0;
    const lines = describeDamage(assessment, doubled);
    const codes = damageCodes(assessment, doubled);
    if (assessment.synthetic) syntheticInodes += 1;

    if (assessment.problem) {
      ambiguous += 1;
      report.push({
        ...identity,
        status: 'skipped',
        codes: [...codes, 'ambiguous'],
        detail: [...lines, `Left alone: ${assessment.problem}`],
        plan: null,
      });
      continue;
    }

    // Mendable, but not from this install as it is set up. Said plainly, with
    // what would change it, rather than filed with the uncertain ones. A book
    // that still has dead records is not this: dropping them is worth doing
    // even while the length has to wait.
    const pending = lengthPendingReason(ctx, item, assessment, access);
    const blocked = pending && assessment.dead.length === 0 ? pending : null;
    if (blocked) {
      needsFileChanges += 1;
      report.push({
        ...identity,
        status: 'skipped',
        codes: [...codes, 'needs-file-changes'],
        detail: [...lines, `Left alone: ${blocked}`],
        plan: null,
      });
      continue;
    }
    repairable += 1;

    if (!options.apply) {
      const method = chooseMethod(assessment, touchTarget(ctx, assessment, access) !== null, Boolean(item.isFile));
      methods[method] = (methods[method] ?? 0) + 1;
      const extra =
        method === 'clear' && !access.allowed
          ? [`A touch would be gentler, but ${access.reason}`]
          : method === 'records-only' && pending
            ? [`Only partly: ${pending}`]
            : [];
      report.push({
        ...identity,
        status: 'action',
        codes: [...codes, method],
        detail: [...lines, methodLine(method, false), ...extra],
        plan: planFor(assessment),
      });
      continue;
    }

    // Carried out together once every item has been read, so the bare files
    // among them can share one library scan.
    targets.push({ item, assessment, identity, lines, codes });
  }

  const outcomes = await repairItems(ctx, targets, access);
  for (const [index, { assessment, identity, lines, codes }] of targets.entries()) {
    const outcome = outcomes[index];
    if (!outcome) {
      notReached += 1;
      report.push({
        ...identity,
        status: 'skipped',
        codes: [...codes, 'not-reached'],
        detail: [...lines, 'The run was stopped before reaching this one'],
        plan: planFor(assessment),
      });
      continue;
    }
    methods[outcome.method] = (methods[outcome.method] ?? 0) + 1;
    const partial = outcome.ok && outcome.method === 'records-only';
    if (partial) partlyRepaired += 1;
    else if (outcome.ok) repaired += 1;
    else failed += 1;
    report.push({
      ...identity,
      status: outcome.ok ? 'action' : 'skipped',
      codes: [...codes, ...outcome.codes],
      detail: [...lines, ...outcome.lines],
      // Kept for a partial repair, so an apply can finish it once the file is
      // in reach: the plan's dead records are gone by then, and its length is
      // what is left to do.
      plan: partial ? planFor(assessment) : null,
    });
  }

  const doubledTotal = progress ? [...progress.values()].reduce((a, b) => a + b, 0) : null;

  log.info(`checked ${plural(items.length, 'item')} across ${plural(libraries.length, 'library', 'libraries')}`);
  if (damaged.length === 0) {
    log.success('No item lists an audio file that is no longer on disk.');
  } else {
    log.info(
      `${plural(damaged.length, 'item')} ${damaged.length === 1 ? 'has' : 'have'} dead audio records or a doubled length — ` +
        `${repairable} repairable, ${ambiguous + needsFileChanges} left alone` +
        (Object.keys(methods).length > 0 ? ` (${breakdown(methods as Record<string, number>, REPAIR_METHODS)})` : ''),
    );
    if (options.apply) {
      log.success(
        `Repaired ${plural(repaired, 'item')}` +
          `${partlyRepaired > 0 ? `, and partly repaired ${partlyRepaired}` : ''}` +
          `${failed > 0 ? `; ${failed} failed` : ''}.`,
      );
      if (failed > 0) log.warn('Open the run to see what went wrong with each; revert puts their track lists back.');
    } else if (repairable > 0) {
      log.info(ctx.settings.allowTrackRepair ? 'Apply to repair them.' : TRACK_REPAIR_DISABLED.split('\n')[0]!);
    }
    const lengthPending = needsFileChanges + (methods['records-only'] ?? 0);
    if (lengthPending > 0) {
      log.warn(
        `${plural(lengthPending, 'item')} ${lengthPending === 1 ? 'is a bare file' : 'are bare files'} at the ` +
          'library root, whose length is set only by touching the file and scanning the library. ' +
          'Their dead records can be dropped without that, but their length stays doubled until then. ' +
          (!ctx.settings.allowFileChanges
            ? 'Turn on "Allow file changes" in Settings, then run repair again.'
            : access.allowed
              ? 'Their files are not somewhere this machine can reach — check the library root on the Connection page.'
              : `This install cannot touch them: ${access.reason}.`),
      );
    }
    if (doubledTotal) {
      log.warn(
        `${plural(doubledTotal, 'listening position')} ${doubledTotal === 1 ? 'was' : 'were'} saved against a ` +
          'doubled length. They are left as they are — a repair does not move anybody\'s place.',
      );
    }
    if (syntheticInodes > 0) {
      log.warn(
        `${plural(syntheticInodes, 'damaged item')} sit on a mount that invents inodes (SMB), which can ` +
          'change on the next scan and do this again.',
      );
    }
  }

  reportItems(ctx, report);

  return {
    scanned: items.length,
    affected: damaged.length,
    repairable,
    ambiguous,
    needsFileChanges,
    repaired,
    partlyRepaired,
    failed,
    applied: Boolean(options.apply),
    methods,
    doubledProgress: doubledTotal,
    syntheticInodes,
    stopped: Boolean(ctx.signal?.aborted),
    notReached,
    report,
  };
}
