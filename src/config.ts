import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const ConfigSchema = z
  .object({
    absUrl: z.string().url('ABS_URL must be a full URL, e.g. http://localhost:13378'),
    absToken: z.string().min(1).optional(),
    absUsername: z.string().min(1).optional(),
    absPassword: z.string().min(1).optional(),
    googleBooksApiKey: z.string().min(1).optional(),
    libraryRoot: z.string().min(1).optional(),
    absPathPrefix: z.string().min(1).optional(),
    providerConcurrency: z.coerce.number().int().positive().max(16).default(4),
  })
  .refine((c) => Boolean(c.absToken) || Boolean(c.absUsername && c.absPassword), {
    message: 'Set ABS_TOKEN, or both ABS_USERNAME and ABS_PASSWORD.',
  });

export type Config = z.infer<typeof ConfigSchema>;

/** A config file lets you keep settings out of the environment. Env always wins. */
function readConfigFile(explicitPath?: string): Record<string, unknown> {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        join(process.cwd(), 'config.json'),
        join(homedir(), '.config', 'abs-butler', 'config.json'),
      ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Could not parse config file ${path}: ${(err as Error).message}`);
    }
  }
  return {};
}

/** camelCase config key -> the env var that sets it, for error messages. */
function envVarFor(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase() || 'config';
}

function pick(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

export function loadConfig(options: { configPath?: string } = {}): Config {
  const file = readConfigFile(options.configPath);
  const env = process.env;

  const merged = {
    absUrl: pick(env.ABS_URL, file.absUrl)?.replace(/\/+$/, ''),
    absToken: pick(env.ABS_TOKEN, file.absToken),
    absUsername: pick(env.ABS_USERNAME, file.absUsername),
    absPassword: pick(env.ABS_PASSWORD, file.absPassword),
    googleBooksApiKey: pick(env.GOOGLE_BOOKS_API_KEY, file.googleBooksApiKey),
    libraryRoot: pick(env.LIBRARY_ROOT, file.libraryRoot),
    absPathPrefix: pick(env.ABS_PATH_PREFIX, file.absPathPrefix),
    providerConcurrency: pick(env.PROVIDER_CONCURRENCY, file.providerConcurrency) ?? 4,
  };

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => {
        const field = i.path.join('.');
        // Zod's bare "Required" is useless without the field and its env var.
        const message = i.message === 'Required' ? `${envVarFor(field)} is required` : i.message;
        return `  - ${message}`;
      })
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}\n\nSee .env.example for the full list.`);
  }
  return parsed.data;
}
