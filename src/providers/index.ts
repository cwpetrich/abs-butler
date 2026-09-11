import { log } from '../logger.js';
import { AppleBooksProvider } from './applebooks.js';
import { AudibleProvider } from './audible.js';
import { AudioSiloProvider } from './audiosilo.js';
import { AudnexusProvider } from './audnexus.js';
import { GoogleBooksProvider } from './googlebooks.js';
import { OpenLibraryProvider } from './openlibrary.js';
import type { MetadataProvider } from './types.js';

export interface ProviderConfig {
  googleBooksApiKey?: string | undefined;
  audibleRegion?: string | undefined;
  providerConcurrency?: number;
}

/**
 * Build the active provider set, ordered by how much their answers are trusted.
 *
 * The audiobook sources lead, because they are the only ones that describe an
 * audio *edition* rather than the work behind it — narrator, series position
 * and publisher-assigned categories all come from there.
 *
 * Audible direct is first: the largest catalogue, asked by title as well as by
 * identifier. AudioSilo follows because it is genuinely independent — open
 * data, not a retailer — and because it resolves an ASIN from any marketplace
 * to one specific narration, which is the best identification available for a
 * library matched outside the configured region. Audnexus sits behind both as
 * the sanctioned route to Audible's catalogue, which matters on the day an
 * undocumented endpoint stops answering.
 *
 * Open Library and Google Books sit behind them and describe the work. They are
 * not redundant: crowd shelving and BISAC categories are the richest audience
 * signals available, and neither audiobook source carries anything like them.
 *
 * Apple Books is last and is a category source, not a metadata one. It
 * publishes no identifier to match on, so it can never rewrite a field — but it
 * needs no account of any kind, which makes it the one source that works on a
 * fresh install, and its ebook categories are specific in the way age banding
 * wants. It is also the only source here that describes ebooks as well as
 * audiobooks.
 *
 * Sources agreeing does not inflate a rating. Each provider's signals are
 * scored independently and a rule counts at most once within one — so two of
 * them saying the same thing raises both the winning band and the runner-up,
 * leaving the margin, and therefore the confidence, where it was.
 *
 * Goodreads is deliberately absent: its public API was retired in 2020 and its
 * terms forbid scraping. See docs/content-ratings.md for the sources that could
 * be added here (Hardcover, StoryGraph, Common Sense Media) and what each needs.
 */
export function buildProviders(config: ProviderConfig, only?: string[]): MetadataProvider[] {
  const all: MetadataProvider[] = [
    new AudibleProvider(config.audibleRegion),
    new AudioSiloProvider(),
    new AudnexusProvider(config.audibleRegion),
    new OpenLibraryProvider(),
    new GoogleBooksProvider(config.googleBooksApiKey),
    new AppleBooksProvider(),
  ];

  const enabled = all.filter((p) => p.isAvailable());
  const wanted = only && only.length > 0 ? new Set(only.map((n) => n.toLowerCase())) : null;
  const selected = wanted ? enabled.filter((p) => wanted.has(p.name)) : enabled;
  if (selected.length === 0) {
    throw new Error(
      `No providers matched ${only!.join(', ')}. Available: ${enabled.map((p) => p.name).join(', ')}`,
    );
  }

  // Said once per run, and only when Google Books is actually going to be
  // asked. Its keyless quota is shared across everyone on your address and is
  // routinely exhausted, so the run falls back to Open Library alone — worth
  // knowing up front rather than inferring from an hour of empty lookups.
  if (!config.googleBooksApiKey && selected.some((p) => p.name === 'googlebooks')) {
    log.warn(
      'No Google Books API key configured — those lookups are likely to be rate limited. ' +
        'Set one in Settings, or drop googlebooks from the provider list.',
    );
  }

  return selected;
}

export const PROVIDER_NAMES = [
  'audible',
  'audiosilo',
  'audnexus',
  'openlibrary',
  'googlebooks',
  'applebooks',
] as const;

export {
  AppleBooksProvider,
  AudibleProvider,
  AudioSiloProvider,
  AudnexusProvider,
  OpenLibraryProvider,
  GoogleBooksProvider,
};
export type { MetadataProvider };
