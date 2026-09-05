#!/usr/bin/env node
/**
 * Builds a deliberately messy AudiobookShelf library to develop against.
 *
 * The audio is two seconds of generated silence. Nothing is downloaded and no
 * copyrighted work is involved: what matters for abs-butler is the *metadata*,
 * and a real audiobook would be a gigabyte of nothing useful to a test.
 *
 * The books themselves are real, and mostly public domain, because the
 * providers have to be able to find them — a library of invented titles would
 * exercise the plumbing and none of the matching. Every entry below is here to
 * provoke a specific behaviour; the `exercises` field says which, and the
 * README lists what each one should produce.
 *
 * ffmpeg comes from the AudiobookShelf image, so there is nothing to install.
 *
 *   node seed.mjs           # build the library and trigger a scan
 *   node seed.mjs --clean   # delete it and start over
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY = join(HERE, 'library');
const ABS_IMAGE = 'ghcr.io/advplyr/audiobookshelf:latest';

/**
 * @typedef {object} Seed
 * @property {string} folder      where it lands on disk, relative to the library root
 * @property {string} title       as stored, warts and all
 * @property {string} author      as stored — "Last, First" where that is the point
 * @property {string} [narrator]
 * @property {string} [series]
 * @property {string} [sequence]
 * @property {string} [asin]      set through the API after the scan
 * @property {string} exercises   the behaviour this row exists to provoke
 */

/** @type {Seed[]} */
const BOOKS = [
  // --- A series two thirds of the library spells one way -------------------
  {
    folder: 'Edgar Rice Burroughs/Barsoom/01 - A Princess of Mars',
    title: 'A Princess of Mars',
    author: 'Edgar Rice Burroughs',
    narrator: 'Mark Nelson',
    series: 'Barsoom',
    sequence: '1',
    exercises: 'baseline — already correct, must be left alone',
  },
  {
    folder: 'Edgar Rice Burroughs/Barsoom/02 - The Gods of Mars',
    title: 'The Gods of Mars',
    author: 'Edgar Rice Burroughs',
    narrator: 'Mark Nelson',
    series: 'Barsoom',
    sequence: '2',
    exercises: 'baseline — establishes the majority spelling of the series',
  },
  {
    folder: 'Burroughs, Edgar Rice/barsoom/03 - Warlord of Mars',
    title: 'Warlord of Mars',
    author: 'Burroughs, Edgar Rice',
    narrator: 'Nelson, Mark',
    // Same series, spelled differently. Case is the difference no local rule
    // can adjudicate, which is exactly what consensus is for.
    series: 'barsoom',
    sequence: '3',
    exercises: 'consensus (series case), local (author + narrator name order)',
  },

  // --- Inverted names, the single most common real mismatch ----------------
  {
    folder: 'L. Frank Baum/Oz/01 - The Wonderful Wizard of Oz',
    title: 'The Wonderful Wizard of Oz',
    author: 'L. Frank Baum',
    narrator: 'Phil Chenevert',
    series: 'Oz',
    sequence: '1',
    exercises: 'baseline',
  },
  {
    folder: 'Baum, L. Frank/Oz/02 - The Marvelous Land of Oz',
    title: 'The Marvelous Land of Oz',
    author: 'Baum, L. Frank',
    narrator: 'Phil Chenevert',
    series: 'Oz',
    sequence: '2',
    exercises: 'local (author name order), consensus (author)',
  },

  // --- Edition noise in the title ------------------------------------------
  {
    folder: 'Arthur Conan Doyle/Sherlock Holmes/01 - A Study in Scarlet',
    title: 'A Study in Scarlet',
    author: 'Arthur Conan Doyle',
    narrator: 'David Clarke',
    series: 'Sherlock Holmes',
    sequence: '1',
    exercises: 'baseline',
  },
  {
    folder: 'Arthur Conan Doyle/Sherlock Holmes/05 - The Hound of the Baskervilles',
    title: 'The Hound of the Baskervilles (Unabridged)',
    author: 'Arthur Conan Doyle',
    narrator: 'David Clarke',
    series: 'Sherlock Holmes',
    sequence: '5',
    exercises: 'local (edition noise stripped from the title)',
  },

  // --- A duplicate pair that normalizes to one book ------------------------
  {
    folder: 'Bram Stoker/Dracula',
    title: 'Dracula',
    author: 'Bram Stoker',
    narrator: 'Tadhg Hynes',
    exercises: 'duplicate detection (pairs with the next entry)',
  },
  {
    folder: 'Stoker, Bram/Dracula (Unabridged)',
    title: 'Dracula (Unabridged)',
    author: 'Stoker, Bram',
    exercises: 'duplicate + local (title noise, author order), missing narrator',
  },

  // --- The co-author case, which used to lose a person ---------------------
  {
    folder: 'Mark Twain/The Gilded Age',
    title: 'The Gilded Age: A Tale of Today',
    author: 'Mark Twain & Charles Dudley Warner',
    narrator: 'John Greenman',
    exercises: 'co-author preservation — both names must survive an apply',
  },

  // --- A title stored in sort order ----------------------------------------
  {
    folder: 'H.G. Wells/Time Machine, The',
    title: 'Time Machine, The',
    author: 'H.G. Wells',
    narrator: 'Mark F. Smith',
    exercises: 'local (trailing article restored to the front)',
  },
  {
    folder: 'Wells, H.G./The War of the Worlds',
    title: 'The War of the Worlds',
    author: 'Wells, H.G.',
    narrator: 'Rebecca Dittman',
    exercises: 'local (author name order) — canonicalizes to H.G. Wells',
  },
  {
    folder: 'H. G. Wells/The Invisible Man',
    title: 'The Invisible Man',
    author: 'H. G. Wells',
    narrator: 'Alex Foster',
    // Spaced initials against the library's two unspaced ones. Nothing but the
    // majority can decide between them, so this is the author consensus case.
    exercises: 'consensus (author spelling, 2:1 against spaced initials)',
  },

  // --- Nothing to work from: no narrator, no series, no identifiers --------
  {
    folder: 'Mary Shelley/Frankenstein',
    title: 'Frankenstein',
    author: 'Mary Shelley',
    exercises: 'metadata fill — blank description, year, publisher, narrator',
  },
  {
    folder: 'Jane Austen/Pride and Prejudice',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    narrator: 'Karen Savage',
    exercises: 'metadata fill against a title every provider knows',
  },

  // --- The provider tier, which needs a real ASIN to fire ------------------
  //
  // Metadata only: the audio is the same generated silence as everything else.
  // An ASIN is just a catalogue identifier, and this is the one row that
  // exercises Audnexus — narrator, series and title from an exact edition
  // match, which is the only evidence normalize will rewrite a title on.
  {
    folder: 'J.K. Rowling/Harry Potter and the Sorcerers Stone',
    title: "Harry Potter and the Sorcerer's Stone",
    author: 'J.K. Rowling',
    narrator: 'Dale, Jim',
    asin: 'B017V4IM1G',
    exercises: 'provider tier — Audnexus supplies narrator + series by ASIN',
  },
];

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * Two seconds of silence carrying the tags AudiobookShelf reads on scan.
 *
 * Written by ffmpeg inside the AudiobookShelf image, mounted at the book's own
 * folder — so the container only ever sees the one directory it is writing to.
 */
function writeAudio(book) {
  const folder = join(LIBRARY, book.folder);
  mkdirSync(folder, { recursive: true });

  // Tags carry only what a clean import would: AudiobookShelf reads `album` as
  // the book's title, not the series. The deliberate mess is applied afterwards
  // through the API by bootstrap.mjs, because ABS tidies some of it during a
  // scan — it turns "Stoker, Bram" back into "Bram Stoker" on its own — so a
  // library seeded purely from tags arrives already half-fixed and proves
  // nothing. Real libraries get messy from imports, other tools and hand edits
  // long after the scan, which is exactly what the API path reproduces.
  const tags = [
    ['title', book.title],
    ['artist', book.author],
    ['album_artist', book.author],
    ['album', book.title],
    ['composer', book.narrator ?? ''],
  ].flatMap(([key, value]) => (value ? ['-metadata', `${key}=${value}`] : []));

  run('docker', [
    'run', '--rm',
    '-v', `${folder}:/out`,
    '--entrypoint', 'ffmpeg',
    ABS_IMAGE,
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono',
    '-t', '2',
    ...tags,
    '-q:a', '9',
    '-y', `/out/${safeName(book.title)}.mp3`,
  ]);
}

/** Filenames only — the folder layout is what carries the structure. */
function safeName(value) {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function clean() {
  if (!existsSync(LIBRARY)) return;
  // Guard against ever pointing this at something that is not the test library.
  if (!resolve(LIBRARY).endsWith(join('test', 'abs', 'library'))) {
    throw new Error(`refusing to delete ${LIBRARY}`);
  }
  rmSync(LIBRARY, { recursive: true, force: true });
  console.log('removed the test library');
}

function main() {
  if (process.argv.includes('--clean')) {
    clean();
    if (!process.argv.includes('--seed')) return;
  }

  mkdirSync(LIBRARY, { recursive: true });
  console.log(`building ${BOOKS.length} books in ${LIBRARY}`);

  for (const [index, book] of BOOKS.entries()) {
    writeAudio(book);
    console.log(`  ${String(index + 1).padStart(2)}/${BOOKS.length}  ${book.folder}`);
  }

  // A manifest of intent, so a failing run can be read against what the library
  // was built to provoke rather than against a guess.
  writeFileSync(
    join(LIBRARY, 'SEED.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), books: BOOKS }, null, 2)}\n`,
  );

  console.log(`\nLibrary built. Now: node bootstrap.mjs\n`);
}

main();
