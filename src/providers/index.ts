import { log } from '../logger.js';
import { GoogleBooksProvider } from './googlebooks.js';
import { OpenLibraryProvider } from './openlibrary.js';
import type { MetadataProvider } from './types.js';

export interface ProviderConfig {
  googleBooksApiKey?: string | undefined;
  providerConcurrency?: number;
}

let warnedAboutKey = false;

/**
 * Build the active provider set, ordered by how much their answers are trusted.
 *
 * Goodreads is deliberately absent: its public API was retired in 2020 and its
 * terms forbid scraping. See docs/content-ratings.md for the sources that could
 * be added here (Hardcover, StoryGraph, Common Sense Media) and what each needs.
 */
export function buildProviders(config: ProviderConfig, only?: string[]): MetadataProvider[] {
  if (!config.googleBooksApiKey && !warnedAboutKey) {
    // The keyless quota is shared across everyone on your IP and is routinely
    // exhausted, so runs quietly fall back to Open Library alone. Warned once
    // per process rather than once per run, to keep job logs readable.
    warnedAboutKey = true;
    log.warn('No Google Books API key configured — those lookups will often be rate limited.');
  }

  const all: MetadataProvider[] = [
    new OpenLibraryProvider(),
    new GoogleBooksProvider(config.googleBooksApiKey),
  ];

  const enabled = all.filter((p) => p.isAvailable());
  if (!only || only.length === 0) return enabled;

  const wanted = new Set(only.map((n) => n.toLowerCase()));
  const selected = enabled.filter((p) => wanted.has(p.name));
  if (selected.length === 0) {
    throw new Error(
      `No providers matched ${only.join(', ')}. Available: ${enabled.map((p) => p.name).join(', ')}`,
    );
  }
  return selected;
}

export const PROVIDER_NAMES = ['openlibrary', 'googlebooks'] as const;

export { OpenLibraryProvider, GoogleBooksProvider };
export type { MetadataProvider };
