import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Environment configuration.
 *
 * Since 0.2 the database is the source of truth for servers and settings — the
 * web UI edits them live. Environment variables cover only what must be known
 * before the database can be opened (where it lives, how it is encrypted, how
 * the web server listens), plus a one-time import of a pre-0.2 single-server
 * `.env` so upgrades keep working.
 */

const EnvServerSchema = z.object({
  name: z.string().min(1).optional(),
  absUrl: z.string().url(),
  absToken: z.string().min(1).optional(),
  libraryRoot: z.string().min(1).optional(),
  absPathPrefix: z.string().min(1).optional(),
  googleBooksApiKey: z.string().min(1).optional(),
  providerConcurrency: z.coerce.number().int().positive().max(16).optional(),
});

export type EnvServerConfig = z.infer<typeof EnvServerSchema>;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Returns null when no legacy server configuration is present, which is normal. */
export function loadEnvConfig(): EnvServerConfig | null {
  const absUrl = clean(process.env.ABS_URL);
  if (!absUrl) return null;

  const parsed = EnvServerSchema.safeParse({
    name: clean(process.env.ABS_SERVER_NAME),
    absUrl: absUrl.replace(/\/+$/, ''),
    absToken: clean(process.env.ABS_TOKEN),
    libraryRoot: clean(process.env.LIBRARY_ROOT),
    absPathPrefix: clean(process.env.ABS_PATH_PREFIX),
    googleBooksApiKey: clean(process.env.GOOGLE_BOOKS_API_KEY),
    providerConcurrency: clean(process.env.PROVIDER_CONCURRENCY),
  });

  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${details.join('\n')}`);
  }
  return parsed.data;
}

const WebSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(8478),
  /** When set, the UI requires this password to log in. */
  password: z.string().min(1).optional(),
  /** When set, API keys are encrypted at rest with a key derived from it. */
  secret: z.string().min(1).optional(),
});

export type WebConfig = z.infer<typeof WebSchema>;

export function loadWebConfig(): WebConfig {
  const parsed = WebSchema.safeParse({
    host: clean(process.env.BUTLER_HOST) ?? '0.0.0.0',
    port: clean(process.env.BUTLER_PORT) ?? 8478,
    password: clean(process.env.BUTLER_PASSWORD),
    secret: clean(process.env.BUTLER_SECRET),
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid web configuration:\n${details.join('\n')}`);
  }
  return parsed.data;
}
