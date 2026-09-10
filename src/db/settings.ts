import type { Db } from './index.js';
import { z } from 'zod';

/**
 * Application settings live in the database so the web UI can change them
 * without a restart. Anything that must exist before the database opens
 * (BUTLER_SECRET, the data directory, the listen port) stays an env var.
 */
export const SettingsSchema = z.object({
  /** Providers consulted for ratings and metadata, in order of trust. */
  providers: z
    .array(z.string())
    .default(['audible', 'audiosilo', 'audnexus', 'openlibrary', 'googlebooks']),
  googleBooksApiKey: z.string().default(''),
  /**
   * Ask GitHub, once every few hours, whether a newer version has been tagged.
   * On by default: an instance that quietly runs an old build is the more
   * likely harm. It is the only request abs-butler makes that is not about
   * your library, and turning it off stops it entirely.
   */
  checkForUpdates: z.boolean().default(true),
  /** Audible marketplace Audnexus is asked about; a book absent from it 404s. */
  audibleRegion: z.enum(['us', 'ca', 'uk', 'au', 'fr', 'de', 'jp', 'it', 'in', 'es']).default('us'),
  providerConcurrency: z.number().int().min(1).max(16).default(4),
  /**
   * How long a cached provider answer stays good. Answers about published
   * books do not change, so this is generous; "nothing found" expires at a
   * quarter of it, since that usually reflects the library rather than the book.
   */
  lookupCacheDays: z.number().int().min(1).max(365).default(30),
  /** Confidence an age band needs before `rate` will write its tag. */
  minConfidence: z.number().min(0).max(1).default(0.35),
  /**
   * Master switch for `normalize --apply`, the one command that rewrites
   * metadata a person can already see.
   *
   * The same reasoning as allowFileChanges: filling a blank description is
   * unremarkable, but rewriting a title, author, narrator or series is a
   * change someone will notice in their library, and it should be something
   * they chose rather than something a default allowed. Off on a fresh install.
   */
  allowMetadataRewrite: z.boolean().default(false),
  /** Runs kept in history; older ones are pruned. */
  historyLimit: z.number().int().min(10).max(10_000).default(500),
  /** Days of log retention. */
  logRetentionDays: z.number().int().min(1).max(365).default(30),
  /**
   * Master switch for anything that touches the filesystem.
   *
   * `organize --apply` is refused while this is off, whether it comes from the
   * UI, the CLI, or a schedule. It replaces the read-only bind mount that used
   * to serve this purpose under Docker: the mount flag was fixed at container
   * creation and kernel-enforced, so turning it off meant editing .env and
   * recreating the container — and a guard that costs a restart is one people
   * set to rw permanently. It also had no equivalent under snap or a native
   * install, where nothing set the flag at all.
   *
   * Off by default, so a fresh install cannot move a file until someone says so.
   */
  allowFileChanges: z.boolean().default(false),
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
