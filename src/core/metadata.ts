import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { collectItems, itemAuthor, itemTitle, resolveLibraries, type TaskContext } from '../context.js';
import { log } from '../logger.js';
import { mapLimitPartial } from '../providers/http.js';
import type { ProviderResult } from '../providers/types.js';
import { isBlank } from '../util/text.js';
import { lookupItem, lookupDepsFor, type LookupDeps } from './lookup.js';
import type { RunItemInput } from '../db/runItems.js';
import { breakdown, brief, itemPath, plural, reportItems } from './report.js';
import { applyPatch } from './revisions.js';
import { itemQuery } from './query.js';

/**
 * Only fields where a provider answer is safe to trust. Notably absent: title
 * and author — a wrong provider match would rename the book, and matching is
 * AudiobookShelf's job via its own quick-match.
 */
export const FILLABLE = ['description', 'publishedYear', 'publisher', 'isbn', 'language'] as const;
export type Fillable = (typeof FILLABLE)[number];

export interface FieldChange {
  field: Fillable;
  from: string | null;
  to: string;
  source: string;
}

export interface MetadataPlan {
  itemId: string;
  title: string;
  author: string | null;
  changes: FieldChange[];
}

function currentValue(item: AbsLibraryItem, field: Fillable): string | null {
  const metadata = item.media?.metadata;
  switch (field) {
    case 'description':
      return metadata?.description ?? null;
    case 'publishedYear':
      return metadata?.publishedYear ?? null;
    case 'publisher':
      return metadata?.publisher ?? null;
    case 'isbn':
      return metadata?.isbn ?? null;
    case 'language':
      return metadata?.language ?? null;
  }
}

function providerValue(result: ProviderResult, field: Fillable): string | null {
  switch (field) {
    case 'description':
      return result.description ?? null;
    case 'publishedYear':
      return result.publishedYear ?? null;
    case 'publisher':
      return result.publisher ?? null;
    case 'isbn':
      return result.isbn ?? null;
    case 'language':
      return result.language ?? null;
  }
}

export async function planMetadata(
  item: AbsLibraryItem,
  deps: LookupDeps,
  options: { fields: Fillable[]; overwrite?: boolean },
): Promise<MetadataPlan> {
  const { results } = await lookupItem(deps, itemQuery(item));

  const changes: FieldChange[] = [];
  for (const field of options.fields) {
    const existing = currentValue(item, field);
    if (!options.overwrite && !isBlank(existing)) continue;

    for (const result of results) {
      const candidate = providerValue(result, field);
      if (isBlank(candidate) || candidate === existing) continue;
      changes.push({ field, from: existing, to: candidate!, source: result.provider });
      break; // Results arrive best-match first, so the strongest answer wins.
    }
  }

  return { itemId: item.id, title: itemTitle(item), author: itemAuthor(item), changes };
}

export interface MetadataTaskOptions {
  library?: string;
  apply?: boolean;
  limit?: number;
  providers?: string[];
  fields?: string[];
  overwrite?: boolean;
}

export interface MetadataTaskResult {
  scanned: number;
  itemsToUpdate: number;
  fieldsToFill: number;
  updated: number;
  applied: boolean;
  fields: Fillable[];
  /** How many books each field would be filled in on. */
  fieldCounts: Record<string, number>;
  /** How many values each provider supplied — which ones are earning their keep. */
  sourceCounts: Record<string, number>;
  /** True when the run was stopped before it reached every item. */
  stopped: boolean;
  /** Items it never got to, because it was stopped. */
  notReached: number;
  plans: MetadataPlan[];
  /**
   * Exactly what was recorded against the run, one row per book — including the
   * ones with nothing missing. Returned as well as stored so `--details` and
   * the run's page in the web UI say the same thing.
   */
  report: RunItemInput[];
}

/**
 * One line per field the run writes, saying what it is replacing and who said
 * so. The value is shown, not just named: "description from googlebooks" is not
 * something anyone can approve or object to without reading it.
 *
 * In the conditional until it is true — a dry run has set nothing.
 */
function metadataDetail(plan: MetadataPlan, applied: boolean): string[] {
  return plan.changes.map(
    (change) =>
      `${applied ? 'Set' : 'Would set'} ${change.field}: ${brief(change.from)} → ` +
      `${brief(change.to, 90)} (from ${change.source})`,
  );
}

export async function runMetadataTask(
  ctx: TaskContext,
  options: MetadataTaskOptions = {},
): Promise<MetadataTaskResult> {
  const requested = (options.fields ?? [...FILLABLE]) as Fillable[];
  const invalid = requested.filter((f) => !FILLABLE.includes(f));
  if (invalid.length > 0) {
    throw new Error(`Unknown field(s): ${invalid.join(', ')}. Valid: ${FILLABLE.join(', ')}`);
  }

  const deps = lookupDepsFor(ctx, options.providers);

  const libraries = await resolveLibraries(ctx, options.library);
  const items = await collectItems(ctx, libraries, { limit: options.limit });
  log.info(`checking ${plural(items.length, 'item')} for missing ${requested.join(', ')}…`);

  // Partial on purpose: a run stopped partway has still checked everything up to
  // that point, and those answers are worth keeping.
  const planned = await mapLimitPartial(
    items,
    ctx.settings.providerConcurrency,
    (item) => planMetadata(item, deps, { fields: requested, overwrite: options.overwrite }),
    { signal: ctx.signal },
  );
  const plans = planned.results;
  if (planned.stopped) {
    log.warn(
      `stopped after checking ${plans.length} of ${items.length} item(s) — ` +
        `${planned.unreached} were not reached.`,
    );
  }
  const actionable = plans.filter((p) => p.changes.length > 0);
  const fieldsToFill = actionable.reduce((sum, p) => sum + p.changes.length, 0);

  const fieldCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  for (const plan of actionable) {
    for (const change of plan.changes) {
      fieldCounts[change.field] = (fieldCounts[change.field] ?? 0) + 1;
      sourceCounts[change.source] = (sourceCounts[change.source] ?? 0) + 1;
    }
  }

  const byId = new Map(items.map((item) => [item.id, item]));

  // Which books were actually written to, so the report can tell a value that
  // was written from one that was only ever going to be.
  const written = new Set<string>();
  let updated = 0;
  if (options.apply) {
    for (const plan of actionable) {
      // Between whole items, and an ending rather than a failure: what was
      // written stays written, and the report says which books never got there.
      if (ctx.signal?.aborted) {
        log.warn(`stopped after writing ${updated} of ${actionable.length} — the rest were left alone.`);
        break;
      }
      const patch: AbsMediaPatch = { metadata: {} };
      for (const change of plan.changes) {
        (patch.metadata as Record<string, string>)[change.field] = change.to;
      }
      await applyPatch(ctx, byId.get(plan.itemId)!, patch);
      written.add(plan.itemId);
      updated += 1;
      if (updated % 25 === 0) log.info(`  wrote ${updated}/${actionable.length}`);
    }
  }

  // Which fields were short, and who answered for them. The counts on their own
  // say how much work there is without saying what kind: "38 item(s) would be
  // updated" reads the same whether it is 38 missing descriptions or one field
  // missing everywhere.
  if (fieldsToFill > 0) {
    log.info(
      `${plural(fieldsToFill, 'gap')} to fill across ${plural(actionable.length, 'item')} — ` +
        `${breakdown(fieldCounts, requested)}`,
    );
    log.info(`answered by — ${breakdown(sourceCounts)}`);
  }

  if (options.apply) {
    log.success(
      `Updated ${plural(updated, 'item')} of ${plans.length} checked` +
        `; ${plans.length - actionable.length} had nothing missing.`,
    );
  } else if (actionable.length === 0) {
    log.success(`Nothing to fill in — all ${plural(plans.length, 'item')} already have ${requested.join(', ')}.`);
  } else {
    log.info(
      `${plural(actionable.length, 'item')} would be updated` +
        `; ${plans.length - actionable.length} had nothing missing. Apply to write.`,
    );
  }

  // Every book checked, including the ones with nothing missing — which is the
  // answer to "did it look at this one and find it complete, or not look at all".
  const report: RunItemInput[] = plans.map((plan) => ({
    itemId: plan.itemId,
    title: plan.title,
    author: plan.author,
    path: itemPath(byId.get(plan.itemId)!),
    status: plan.changes.length > 0 ? ('action' as const) : ('clean' as const),
    codes: [
      ...plan.changes.map((change) => change.field),
      ...(options.apply && plan.changes.length > 0 && !written.has(plan.itemId)
        ? ['not-written']
        : []),
    ],
    detail:
      plan.changes.length > 0
        ? [
            ...metadataDetail(plan, written.has(plan.itemId)),
            ...(options.apply && !written.has(plan.itemId)
              ? ['The run was stopped before this was written']
              : []),
          ]
        : ['Nothing missing'],
    // Kept so the report can be acted on as it stands, rather than by running
    // the whole lookup again and hoping the providers answer the same way.
    // Nothing is kept for a value this run has already written.
    plan:
      plan.changes.length > 0 && !written.has(plan.itemId)
        ? { kind: 'metadata' as const, changes: plan.changes }
        : null,
  }));
  reportItems(ctx, report);

  return {
    // What it actually checked. A stopped run read the whole library listing and
    // then got through part of it; the part it got through is the honest number,
    // and `notReached` is the rest.
    scanned: plans.length,
    itemsToUpdate: actionable.length,
    fieldsToFill,
    updated,
    applied: Boolean(options.apply),
    fields: requested,
    fieldCounts,
    sourceCounts,
    stopped: planned.stopped || Boolean(ctx.signal?.aborted),
    notReached: planned.unreached,
    plans: actionable,
    report,
  };
}
