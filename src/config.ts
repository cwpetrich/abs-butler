import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Environment configuration.
 *
 * Almost nothing lives here. The connection, the password, provider keys and
 * every other setting are edited in the web UI and stored in the database; the
 * encryption key generates itself. What remains is the handful of deployment
 * facts that must be known before the database can be opened or reached at all:
 * where it lives, and what address to listen on.
 *
 * The listen address deliberately stays out of the UI — a wrong value there
 * locks you out of the only thing that could fix it, and under Docker the
 * internal port is remapped host-side anyway.
 *
 * 13380 sits directly above AudiobookShelf's own 13378 and abs-sync's 13379,
 * so the tools for one server occupy one contiguous, guessable block rather
 * than scattering across the port space.
 */

const WebSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(13380),
});

export type WebConfig = z.infer<typeof WebSchema>;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadWebConfig(): WebConfig {
  const parsed = WebSchema.safeParse({
    host: clean(process.env.BUTLER_HOST) ?? '0.0.0.0',
    port: clean(process.env.BUTLER_PORT) ?? 13380,
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid web configuration:\n${details.join('\n')}`);
  }
  return parsed.data;
}

/**
 * Optional hard lock on first-run setup.
 *
 * Unset (the default), setup is guarded by a time window and a browser claim,
 * which is the right trade for a LAN install. Set it and the code is required
 * as well — worth doing if the port is reachable from outside your network.
 */
export function setupCode(): string | undefined {
  return clean(process.env.BUTLER_SETUP_CODE);
}
