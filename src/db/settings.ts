import type { Db } from './index.js';
import { z } from 'zod';

/**
 * Application settings live in the database so the web UI can change them
 * without a restart. Anything that must exist before the database opens
 * (BUTLER_SECRET, the data directory, the listen port) stays an env var.
 */
export const SettingsSchema = z.object({
  /** Providers consulted for ratings and metadata, in order of trust. */
  providers: z.array(z.string()).default(['openlibrary', 'googlebooks']),
  googleBooksApiKey: z.string().default(''),
  providerConcurrency: z.number().int().min(1).max(16).default(4),
  /** Confidence an age band needs before `rate` will write its tag. */
  minConfidence: z.number().min(0).max(1).default(0.35),
  /** Runs kept in history; older ones are pruned. */
  historyLimit: z.number().int().min(10).max(10_000).default(500),
  /** Days of log retention. */
  logRetentionDays: z.number().int().min(1).max(365).default(30),
  /** Refuse to start a job that would write, unless explicitly confirmed. */
  requireDryRunFirst: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export function getSettings(db: Db): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as Array<{
    key: string;
    value: string;
  }>;

  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      raw[row.key] = row.value;
    }
  }

  const parsed = SettingsSchema.safeParse(raw);
  // A corrupt or half-written settings row must not brick startup.
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  const merged = SettingsSchema.parse({ ...getSettings(db), ...patch });

  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(merged)) {
    stmt.run(key, JSON.stringify(value));
  }
  return merged;
}

/** Raw key/value access for internal state that is not user-facing settings. */
export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`meta:${key}`) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(`meta:${key}`, value);
}
