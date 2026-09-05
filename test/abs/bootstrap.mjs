#!/usr/bin/env node
/**
 * Takes the container from empty to a library that is messy on purpose.
 *
 * Creates the root user, adds the library, scans it, then writes the intended
 * mess over the scanned result and hands back an API token.
 *
 * The mess is applied through the API rather than baked into the audio tags,
 * because AudiobookShelf normalizes some of it during a scan — "Stoker, Bram"
 * comes back as "Bram Stoker" without being asked. A library seeded from tags
 * alone arrives already half-tidy, so the cases abs-butler exists to fix would
 * never appear. Applying it afterwards also mirrors how libraries really go
 * wrong: an import, another tool, or a hand edit, long after the scan.
 *
 * Idempotent — safe to re-run, and the way to reset the library to its messy
 * starting state between runs of `abs-butler normalize --apply`.
 *
 *   node bootstrap.mjs          # set everything up, print the token
 *   node bootstrap.mjs --reset  # re-apply the mess over whatever is there now
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY = join(HERE, 'library');
const TOKEN_FILE = join(HERE, '.token');
const BASE = process.env.ABS_TEST_URL ?? 'http://127.0.0.1:13377';

// No secret worth protecting: this server holds fifteen files of silence and
// listens on localhost only.
const ROOT = { username: 'root', password: 'buttertest' };

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureInitialized() {
  const status = await api('/status');
  if (status.isInit) return;
  console.log('creating the root user…');
  await api('/init', { method: 'POST', body: { newRoot: ROOT } });
}

async function login() {
  const res = await api('/login', { method: 'POST', body: ROOT });
  return res.user.token;
}

async function ensureLibrary(token) {
  const { libraries } = await api('/api/libraries', { token });
  const existing = libraries.find((l) => l.folders.some((f) => f.fullPath === '/audiobooks'));
  if (existing) return existing;

  console.log('creating the library…');
  await api('/api/libraries', {
    method: 'POST',
    token,
    body: {
      name: 'Audiobooks',
      folders: [{ fullPath: '/audiobooks' }],
      mediaType: 'book',
      provider: 'audible',
    },
  });

  const after = await api('/api/libraries', { token });
  return after.libraries.find((l) => l.folders.some((f) => f.fullPath === '/audiobooks'));
}

/** Scans, then waits for the item count to settle rather than guessing at a delay. */
async function scanAndWait(token, libraryId, expected) {
  await api(`/api/libraries/${libraryId}/scan`, { method: 'POST', token });
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    const page = await api(`/api/libraries/${libraryId}/items?limit=200`, { token });
    if ((page.total ?? 0) >= expected) return page.results;
    if (attempt === 29) return page.results;
  }
  return [];
}

/**
 * Writes the seed's intended values over what the scan produced.
 *
 * Matched on the title the scan derived from the audio tag, which is stable
 * because seed.mjs writes it deliberately — the folder path is not, since
 * `organize --apply` is one of the things being tested and moves it.
 */
async function applyMess(token, items, books) {
  const byTitle = new Map(items.map((i) => [i.media?.metadata?.title, i]));
  let changed = 0;

  for (const book of books) {
    const item = byTitle.get(book.title);
    if (!item) {
      console.warn(`  ! no scanned item for "${book.title}"`);
      continue;
    }

    const metadata = {
      title: book.title,
      authors: splitPeople(book.author).map((name) => ({ name })),
      narrators: book.narrator ? splitPeople(book.narrator) : [],
      series: book.series ? [{ name: book.series, sequence: book.sequence ?? null }] : [],
      ...(book.asin ? { asin: book.asin } : {}),
    };

    await api(`/api/items/${item.id}/media`, { method: 'PATCH', token, body: { metadata } });
    changed += 1;
  }
  return changed;
}

/** Mirrors the splitting abs-butler itself does: never on a bare comma. */
function splitPeople(value) {
  return value
    .split(/\s*(?:;|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

async function main() {
  if (!existsSync(join(LIBRARY, 'SEED.json'))) {
    console.error('No library yet. Run: node seed.mjs');
    process.exit(1);
  }
  const { books } = JSON.parse(readFileSync(join(LIBRARY, 'SEED.json'), 'utf8'));

  await ensureInitialized();
  const token = await login();
  const library = await ensureLibrary(token);

  console.log('scanning…');
  const items = await scanAndWait(token, library.id, books.length);
  console.log(`  ${items.length} item(s) scanned`);

  console.log('applying the intended mess…');
  const changed = await applyMess(token, items, books);
  console.log(`  ${changed} item(s) set`);

  writeFileSync(TOKEN_FILE, `${token}\n`);

  console.log(`
Ready. Server: ${BASE}   (root / ${ROOT.password})
API token written to test/abs/.token

Point abs-butler at it — its own database, kept out of your real one:

  export BUTLER_DATA_DIR=${join(HERE, 'butler-data')}
  node ../../dist/index.js connect \\
    --url ${BASE} \\
    --api-key $(cat ${TOKEN_FILE}) \\
    --library-root ${LIBRARY}

  node ../../dist/index.js normalize          # dry run
  node bootstrap.mjs --reset                  # put the mess back afterwards
`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
