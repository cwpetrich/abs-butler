import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { itemAuthor, itemTitle, type TaskContext } from '../context.js';
import type { RunItemInput } from '../db/runItems.js';
import { clearRunItemPlans, listRunItemPlans } from '../db/runItems.js';
import { getRun, type RunCommand } from '../db/runs.js';
import { log } from '../logger.js';
import { checkLocalRoot } from './capability.js';
import type { FieldChange } from './metadata.js';
import {
  currentText,
  isAdditive,
  planToPatch,
  REWRITE_DISABLED,
  type FieldProposal,
} from './normalize.js';
import {
  moveBlockedReason,
  movePath,
  unavailableMessage,
  WRITES_DISABLED,
  type MovePlan,
} from './organize.js';
import type { ItemPlan } from './plans.js';
import { brief, itemPath, plural, reportItems } from './report.js';
import { applyPatch } from './revisions.js';

/**
 * Carrying out what a run already decided.
 *
 * Every other command answers a question and then, on `--apply`, acts on the
 * answer in the same breath — which meant the only way to act on a report
 * somebody had read and agreed with was to ask the whole question again. Over a
 * large library that is an hour of provider lookups repeated to reach the same
 * conclusions, and it is not even guaranteed to reach them: providers revise
 * their answers, and the library moves underneath.
 *
 * So a run's decisions are kept (see core/plans.ts) and this replays them. The
 * whole report, or a handful of books picked out of it — which is the same code
 * path with a shorter list, because "apply this one book" and "apply all of it"
 * should not be two different things that can disagree.
 *
 * What it is not is a blind replay. A recorded change is written only where the
 * book still looks the way it did when the change was worked out; anything
 * edited since is named and left alone, the same bargain `revert` makes. The
 * switches are re-read here too rather than trusted from the original run, so
 * turning "Allow metadata rewrite" on and applying the report is the supported
 * way to get the changes that were held back.
 */

export interface ApplyTaskOptions {
  /** The run whose recorded results are being carried out. */
  applyFrom: number;
  /** Restrict to these books. Absent means the whole report. */
  items?: string[];
  apply?: boolean;
  /**
   * The command this run was created under, guarded rather than assumed. A run
   * row saying `audit` while the work it does is a normalize would make history
   * lie, and its report would be labelled in the wrong vocabulary.
   */
  command?: RunCommand;
}

export interface ApplyTaskResult {
  /** The run this is carrying out. */
  replayOf: number;
  command: RunCommand;
  /** Recorded changes this run was asked to carry out. */
  selected: number;
  applied: boolean;
  /** Books written to, or moved. */
  written: number;
  /** Books that already say what the recorded change would have said. */
  unchanged: number;
  /** Books edited since the run decided, so the recorded change is out of date. */
  stale: number;
  /** Individual changes refused by "Allow metadata rewrite". */
  heldBack: number;
  /** Books where every recorded change was held back. */
  itemsHeldBack: number;
  /** Books no longer on the server, or files no longer where they were. */
  missing: number;
  /** Moves the filesystem refused — a destination that now exists, usually. */
  blocked: number;
  stopped: boolean;
  /** Books it never got to, because it was stopped. */
  notReached: number;
  rescanned: boolean;
  /** One row per book, recorded against this run the way every command does. */
  report: RunItemInput[];
}

export const NOTHING_TO_APPLY =
  'That run has nothing left to carry out. Only a dry run of rate, metadata, normalize or ' +
  'organize keeps its decisions — an audit has none to keep, and anything a run already wrote ' +
  'is done. Detail is kept for the ten most recent runs, so an older run has had its plans ' +
  'pruned along with the rest of its per-book report.';

/** What became of one book, before any of it is written. */
type Outcome = { held?: number } & (
  | { act: 'write'; patch: AbsMediaPatch; lines: string[]; codes: string[] }
  | { act: 'move'; move: MovePlan; lines: string[] }
  | { act: 'none'; status: 'clean' | 'skipped'; code: string; lines: string[]; keep: boolean }
);

export async function runApplyTask(
  ctx: TaskContext,
  options: ApplyTaskOptions,
): Promise<ApplyTaskResult> {
  const source = getRun(ctx.db, options.applyFrom);
  if (!source) {
    throw new Error(`No run #${options.applyFrom} in history. List them with: abs-butler runs`);
  }

  const command = source.command;
  if (options.command && options.command !== command) {
    throw new Error(
      `Run ${source.id} is a ${command} run — it cannot be applied as ${options.command}.`,
    );
  }

  const rows = listRunItemPlans(ctx.db, source.id, options.items);
  if (rows.length === 0) throw new Error(NOTHING_TO_APPLY);

  // Named rather than passed over in silence: a selection that has been pruned,
  // or applied by somebody else in between, is worth knowing about before the
  // run reports a smaller number than the one that was asked for.
  if (options.items && options.items.length > rows.length) {
    log.warn(
      `${options.items.length - rows.length} of the ${options.items.length} book(s) asked for are ` +
        `no longer waiting to be applied — they were applied already, or their detail was pruned.`,
    );
  }

  // Checked before the first call, like organize itself: an apply that is going
  // to be refused should say so immediately.
  if (command === 'organize' && options.apply) {
    if (!ctx.settings.allowFileChanges) throw new Error(WRITES_DISABLED);
    const local = checkLocalRoot(ctx.connection);
    if (!local.canManageFiles) throw new Error(unavailableMessage(local.reason));
  }

  const mayReplace = ctx.settings.allowMetadataRewrite;

  log.info(
    `applying ${plural(rows.length, 'recorded change')} from run ${source.id} (${command})` +
      `${options.items ? ' — the selected books only' : ''}…`,
  );

  const report: RunItemInput[] = [];
  const touchedLibraries = new Set<string>();
  /**
   * Books this run settled one way or another, so the run it came from stops
   * offering them. Not the ones still waiting on somebody — a held-back change
   * needs a switch turned on, a blocked move needs the destination cleared, and
   * both are appliable again once that happens.
   */
  const settled: string[] = [];
  let written = 0;
  let unchanged = 0;
  let stale = 0;
  let heldBack = 0;
  let itemsHeldBack = 0;
  let missing = 0;
  let blocked = 0;
  let notReached = 0;
  let rescanned = false;

  for (const row of rows) {
    // Between whole books, and an ending rather than a failure — the same
    // bargain every other command makes. What was written stays written, with
    // this run's undo record covering exactly that much, and the books it never
    // reached keep their plan so they can be applied again.
    if (ctx.signal?.aborted) {
      for (const rest of rows.slice(rows.indexOf(row))) {
        notReached += 1;
        report.push({
          itemId: rest.itemId,
          title: rest.title,
          author: rest.author,
          path: rest.path,
          status: 'skipped',
          codes: ['not-reached'],
          detail: ['The run was stopped before reaching this one'],
          plan: rest.plan,
        });
      }
      log.warn(`stopped after ${written} of ${rows.length} — the rest were left alone.`);
      break;
    }

    let item: AbsLibraryItem | null = null;
    try {
      item = await ctx.client.getItem(row.itemId);
    } catch {
      // A book deleted since the run has nothing to apply onto, and inventing
      // it is not this command's business.
      missing += 1;
      if (options.apply) settled.push(row.itemId);
      report.push({
        itemId: row.itemId,
        title: row.title,
        author: row.author,
        path: row.path,
        status: 'skipped',
        codes: ['missing'],
        detail: ['No longer on the server'],
        plan: null,
      });
      continue;
    }

    const outcome = decide(row.plan, item, { mayReplace, apply: Boolean(options.apply) });
    heldBack += outcome.held ?? 0;

    const identity = {
      itemId: item.id,
      title: itemTitle(item),
      author: itemAuthor(item),
      path: itemPath(item),
    };

    if (outcome.act === 'none') {
      if (outcome.code === 'held-back') itemsHeldBack += 1;
      else if (outcome.code === 'changed-since') stale += 1;
      else unchanged += 1;

      if (options.apply && !outcome.keep) settled.push(row.itemId);
      report.push({
        ...identity,
        status: outcome.status,
        codes: [outcome.code],
        detail: outcome.lines,
        plan: outcome.keep ? row.plan : null,
      });
      continue;
    }

    if (!options.apply) {
      // A dry run of an apply is still worth having: it is the answer to "is
      // this report still true?", which is exactly the question a report read
      // yesterday raises. The plan travels on to this run's own rows, so the
      // preview can be applied in turn.
      report.push({
        ...identity,
        status: 'action',
        codes: outcome.act === 'move' ? ['planned'] : outcome.codes,
        detail: outcome.lines,
        plan: row.plan,
      });
      continue;
    }

    if (outcome.act === 'move') {
      const reason = await moveBlockedReason(outcome.move);
      if (reason) {
        blocked += 1;
        log.warn(`skipping "${outcome.move.title}" — ${reason}`);
        report.push({
          ...identity,
          status: 'skipped',
          codes: ['blocked'],
          detail: [`Not moved: ${outcome.move.from} → ${outcome.move.to}`, reason],
          // Kept: a destination that already exists is a thing somebody can
          // clear, and then this is appliable again.
          plan: row.plan,
        });
        continue;
      }
      await movePath(outcome.move.fromLocal, outcome.move.toLocal, outcome.move.rootLocal);
      touchedLibraries.add(outcome.move.libraryId);
      written += 1;
      settled.push(row.itemId);
      report.push({
        ...identity,
        status: 'action',
        codes: ['moved'],
        detail: [`Moved: ${outcome.move.from} → ${outcome.move.to}`],
        plan: null,
      });
      log.debug(`moved ${outcome.move.from} -> ${outcome.move.to}`);
      continue;
    }

    await applyPatch(ctx, item, outcome.patch);
    written += 1;
    settled.push(row.itemId);
    report.push({
      ...identity,
      status: 'action',
      codes: outcome.codes,
      detail: outcome.lines,
      plan: null,
    });
    if (written % 25 === 0) log.info(`  wrote ${written}/${rows.length}`);
  }

  if (heldBack > 0) {
    const one = heldBack === 1;
    log.warn(
      `${plural(heldBack, 'change')} ${options.apply ? (one ? 'was' : 'were') : 'would be'} held ` +
        `back — ${one ? 'it replaces' : 'they replace'} an existing value` +
        `${itemsHeldBack > 0 ? `, and ${plural(itemsHeldBack, 'book')} had nothing else to write` : ''}. ` +
        REWRITE_DISABLED,
    );
  }
  if (stale > 0) {
    log.warn(
      `${plural(stale, 'book')} changed since run ${source.id} decided, so what it recorded is ` +
        'out of date — re-run the command to work them out again.',
    );
  }
  if (missing > 0) {
    log.warn(`${plural(missing, 'book')} ${missing === 1 ? 'is' : 'are'} no longer on the server`);
  }

  if (command === 'organize' && written > 0 && touchedLibraries.size > 0) {
    for (const libraryId of touchedLibraries) await ctx.client.scanLibrary(libraryId);
    rescanned = true;
    log.success('Triggered a rescan so AudiobookShelf picks up the new paths.');
  }

  if (options.apply) {
    log.success(
      `Applied ${plural(written, 'book')} of ${rows.length} recorded` +
        `${unchanged > 0 ? `; ${unchanged} already said the same thing` : ''}` +
        `${stale > 0 ? `; ${stale} out of date` : ''}.`,
    );
  } else {
    const appliable = report.filter((r) => r.status === 'action').length;
    log.info(
      `${plural(appliable, 'book')} of ${rows.length} recorded are still current. Apply to write.`,
    );
  }

  reportItems(ctx, report);
  if (settled.length > 0) clearRunItemPlans(ctx.db, source.id, settled);

  return {
    replayOf: source.id,
    command,
    selected: rows.length,
    applied: Boolean(options.apply),
    written,
    unchanged,
    stale,
    heldBack,
    itemsHeldBack,
    missing,
    blocked,
    stopped: Boolean(ctx.signal?.aborted),
    notReached,
    rescanned,
    report,
  };
}

/**
 * What to do with one recorded change, given the book as it stands now.
 *
 * The three answers are: write it, it is already true, or the book has moved on
 * and this is out of date. Which one applies is decided per field — a run that
 * proposed a title and a narrator, where somebody has since fixed the title by
 * hand, still has a narrator worth writing.
 */
function decide(
  plan: ItemPlan,
  item: AbsLibraryItem,
  context: { mayReplace: boolean; apply: boolean },
): Outcome {
  switch (plan.kind) {
    case 'rate':
      return decideRate(plan.added, plan.removed, item, context.apply);
    case 'metadata':
      return decideMetadata(plan.changes, item, context.apply);
    case 'normalize':
      return decideNormalize(plan.proposals, item, context);
    case 'organize':
      return decideOrganize(plan.move, item);
  }
}

/**
 * A rating is applied as the delta it recorded, not as the tag list it wanted.
 *
 * The list was computed against the tags the book carried at the time, so
 * writing it back now would quietly delete anything added since — including
 * tags abs-butler does not own and has no business touching. Adding and
 * removing exactly what the run decided leaves everything else alone.
 */
function decideRate(
  added: string[],
  removed: string[],
  item: AbsLibraryItem,
  apply: boolean,
): Outcome {
  const current = item.media?.tags ?? [];
  const drop = new Set(removed);
  const next = [...current.filter((tag) => !drop.has(tag))];
  for (const tag of added) if (!next.includes(tag)) next.push(tag);

  if (sameSet(current, next)) {
    return {
      act: 'none',
      status: 'clean',
      code: 'already-applied',
      lines: ['Already carries exactly these tags'],
      keep: false,
    };
  }

  const lines: string[] = [];
  const gained = added.filter((tag) => !current.includes(tag));
  const lost = removed.filter((tag) => current.includes(tag));
  if (gained.length > 0) lines.push(`${apply ? 'Added' : 'Would add'} ${gained.join(', ')}`);
  if (lost.length > 0) lines.push(`${apply ? 'Removed' : 'Would remove'} ${lost.join(', ')}`);

  return { act: 'write', patch: { tags: next }, lines, codes: tagCodes(gained, lost) };
}

/**
 * Filling blanks, where they are still blank.
 *
 * `metadata` only ever writes into an empty field, so a value that has appeared
 * since is not a conflict to resolve — it is somebody having answered the
 * question already, and the recorded answer has nothing to add.
 */
function decideMetadata(changes: FieldChange[], item: AbsLibraryItem, apply: boolean): Outcome {
  const metadata = (item.media?.metadata ?? {}) as unknown as Record<string, unknown>;
  const patch: Record<string, string> = {};
  const lines: string[] = [];
  const codes: string[] = [];
  let outdated = 0;
  let done = 0;

  for (const change of changes) {
    const now = (metadata[change.field] ?? null) as string | null;
    if (now === change.to) {
      done += 1;
      continue;
    }
    if (!same(now, change.from)) {
      outdated += 1;
      lines.push(
        `Left ${change.field} alone — it now reads ${brief(now)}, not ${brief(change.from)}`,
      );
      continue;
    }
    patch[change.field] = change.to;
    codes.push(change.field);
    lines.push(
      `${apply ? 'Set' : 'Would set'} ${change.field}: ${brief(change.from)} → ` +
        `${brief(change.to, 90)} (from ${change.source})`,
    );
  }

  if (Object.keys(patch).length > 0) {
    if (outdated > 0) codes.push('changed-since');
    return { act: 'write', patch: { metadata: patch }, lines, codes };
  }
  if (outdated > 0) {
    return { act: 'none', status: 'skipped', code: 'changed-since', lines, keep: false };
  }
  return {
    act: 'none',
    status: 'clean',
    code: 'already-applied',
    lines: [`Already carries ${plural(done, 'value')} the run proposed`],
    keep: false,
  };
}

/**
 * Replaying a normalize, proposal by proposal.
 *
 * The patch is rebuilt here rather than stored, because building it reads the
 * book: a series keeps the sequence the library already knows, and the work tag
 * is merged into whatever tags the book carries now rather than the ones it
 * carried when the run looked. A stored patch would have baked in both.
 */
function decideNormalize(
  proposals: FieldProposal[],
  item: AbsLibraryItem,
  context: { mayReplace: boolean; apply: boolean },
): Outcome {
  const keep: FieldProposal[] = [];
  const lines: string[] = [];
  const codes: string[] = [];
  let outdated = 0;
  let held = 0;
  let done = 0;

  for (const proposal of proposals) {
    const now = currentText(item, proposal.field);
    if (now === proposal.to) {
      done += 1;
      continue;
    }
    if (!context.mayReplace && !isAdditive(proposal)) {
      held += 1;
      lines.push(`Held back ${proposal.field} — it would replace ${brief(proposal.from)}`);
      continue;
    }
    if (!same(now, proposal.from)) {
      outdated += 1;
      lines.push(`Left ${proposal.field} alone — it now reads ${brief(now)}, not ${brief(proposal.from)}`);
      continue;
    }
    keep.push(proposal);
    codes.push(proposal.field, proposal.source);
    lines.push(
      `${context.apply ? 'Set' : 'Would set'} ${proposal.field}: ${brief(proposal.from)} → ` +
        `${brief(proposal.to, 90)} (${proposal.source}: ${proposal.detail})`,
    );
  }

  if (keep.length > 0) {
    if (outdated > 0) codes.push('changed-since');
    if (held > 0) codes.push('held-back');
    const patch = planToPatch(item, {
      itemId: item.id,
      title: itemTitle(item),
      author: itemAuthor(item),
      proposals: keep,
    });
    return { act: 'write', patch, lines, codes: [...new Set(codes)], held };
  }
  // Held back leads: it is the one of the three the switch in Settings can
  // change, so it is the one worth naming when nothing else got through.
  if (held > 0) return { act: 'none', status: 'skipped', code: 'held-back', lines, keep: true, held };
  if (outdated > 0) return { act: 'none', status: 'skipped', code: 'changed-since', lines, keep: false };
  return {
    act: 'none',
    status: 'clean',
    code: 'already-applied',
    lines: [`Already reads the way the run proposed (${plural(done, 'field')})`],
    keep: false,
  };
}

/**
 * A move is still the move that was planned only while the book is still where
 * it was. Anything else — a rescan that re-imported it elsewhere, a move made
 * by hand — means the recorded destination was computed from a path that no
 * longer describes this book, and carrying it out would be moving something
 * else somewhere arbitrary.
 */
function decideOrganize(move: MovePlan, item: AbsLibraryItem): Outcome {
  const currentRel = (item.relPath ?? '').replace(/^\/+/, '');
  if (currentRel && currentRel !== move.from) {
    return {
      act: 'none',
      status: 'skipped',
      code: 'changed-since',
      lines: [`Not moved: it now sits at ${currentRel}, not ${move.from}`],
      keep: false,
    };
  }
  return { act: 'move', move, lines: [`Would move: ${move.from} → ${move.to}`] };
}

/** The age band and content flags a rating writes, as filterable facets. */
function tagCodes(added: string[], removed: string[]): string[] {
  const codes = [...added, ...removed]
    .filter((tag) => tag.includes(':'))
    .map((tag) => tag.slice(tag.indexOf(':') + 1));
  return codes.length > 0 ? [...new Set(codes)] : ['tags'];
}

/** Blank and absent are the same answer, and providers supply both. */
function same(a: string | null, b: string | null): boolean {
  return (a ?? '') === (b ?? '');
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}
