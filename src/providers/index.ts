import type { Config } from '../config.js';
import { log } from '../logger.js';
import { GoogleBooksProvider } from './googlebooks.js';
import { OpenLibraryProvider } from './openlibrary.js';
import type { MetadataProvider } from './types.js';

/**
 * Build the active provider set.
 *
 * Goodreads is deliberately absent: its public API was retired in 2020 and its
 * terms forbid scraping. See docs/content-ratings.md for the sources that could
 * be added here (Hardcover, StoryGraph, Common Sense Media) and what each needs.
 */
export function buildProviders(config: Config, only?: string[]): MetadataProvider[] {
  if (!config.googleBooksApiKey) {
    // The keyless quota is shared across everyone on your IP and is routinely
    // exhausted, so runs quietly fall back to Open Library alone.
    log.warn('GOOGLE_BOOKS_API_KEY is not set — Google Books lookups will often be rate limited.');
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

export { OpenLibraryProvider, GoogleBooksProvider };
export type { MetadataProvider };
