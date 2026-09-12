import type { FieldChange } from './metadata.js';
import type { FieldProposal } from './normalize.js';
import type { MovePlan } from './organize.js';
import type { RunCommand } from '../db/runs.js';

/**
 * What a run decided to do to one book, kept so it can be carried out later.
 *
 * A dry run's whole purpose is to be read and judged, and until now the thing
 * being judged did not survive being printed — approving a report meant running
 * the command again and trusting it to reach the same conclusions. These are
 * those conclusions, stored beside the row that describes them, so `apply` is
 * replaying a decision rather than making a new one.
 *
 * Each kind is the *change*, not the resulting state. That distinction is what
 * makes replaying safe on a library that has moved on: a rating carries the
 * tags it adds and removes rather than the whole list it wanted, so a tag
 * somebody added in between survives; a normalize carries its proposals rather
 * than a finished patch, so the patch is rebuilt against the book as it is now.
 */
export type ItemPlan =
  | { kind: 'rate'; added: string[]; removed: string[] }
  | { kind: 'metadata'; changes: FieldChange[] }
  | { kind: 'normalize'; proposals: FieldProposal[] }
  | { kind: 'organize'; move: MovePlan };

export type PlanKind = ItemPlan['kind'];

/**
 * The commands whose reports carry a plan. One per kind, and named the same —
 * a plan belongs to the command that produced it, and `apply` runs under that
 * command so the new run reads as what it is.
 */
export const PLAN_COMMANDS: ReadonlySet<RunCommand> = new Set<RunCommand>([
  'rate',
  'metadata',
  'normalize',
  'organize',
]);

export function planKindFor(command: RunCommand): PlanKind | null {
  return PLAN_COMMANDS.has(command) ? (command as PlanKind) : null;
}

/**
 * Whether a value read back out of the database is still a plan this version
 * understands. Rows outlive the code that wrote them — a database restored from
 * a backup, or a downgrade — and a malformed plan should leave the row
 * unappliable rather than reach the apply path and throw.
 */
export function isItemPlan(value: unknown): value is ItemPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as { kind?: unknown };
  switch (plan.kind) {
    case 'rate':
      return (
        Array.isArray((plan as ItemPlan & { kind: 'rate' }).added) &&
        Array.isArray((plan as ItemPlan & { kind: 'rate' }).removed)
      );
    case 'metadata':
      return Array.isArray((plan as ItemPlan & { kind: 'metadata' }).changes);
    case 'normalize':
      return Array.isArray((plan as ItemPlan & { kind: 'normalize' }).proposals);
    case 'organize':
      return Boolean((plan as ItemPlan & { kind: 'organize' }).move);
    default:
      return false;
  }
}
