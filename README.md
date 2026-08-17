# abs-butler

A command-line butler for an [AudiobookShelf](https://www.audiobookshelf.org/) server. It audits a
library for problems, fills in missing metadata, enforces a folder naming scheme, and — the reason it
exists — tags books with **age bands and content flags** so the library can be filtered by what's
appropriate for whom.

Every command that changes something is a **dry run by default**. Nothing is written to
AudiobookShelf or moved on disk until you add `--apply`.

## Setup

### With Docker

```bash
cp .env.example .env      # fill in ABS_URL, ABS_TOKEN
docker compose build
docker compose run --rm butler libraries      # connectivity check
docker compose run --rm butler audit --details
```

Anything after the service name is passed to the CLI. For recurring runs,
`docker compose up -d scheduled-audit` re-audits every `BUTLER_SCHEDULE` (default 12h).

Two things that catch people out — `localhost` inside a container isn't your host, and `organize`
needs the library mounted read-write. Both are covered in **[docs/docker.md](docs/docker.md)**.

### Without Docker

```bash
npm install
cp .env.example .env   # then fill in ABS_URL and ABS_TOKEN
npm run build
node dist/index.js libraries   # connectivity check
```

For development without building, `npm run dev -- <command>` runs straight from source.

Configuration is read from environment variables, a `.env` file, `./config.json`, or
`~/.config/abs-butler/config.json` — in that precedence order. See `.env.example` for every setting.

Commands are shown below as `node dist/index.js <command>`; under Docker the equivalent is
`docker compose run --rm butler <command>`. Flags are identical either way.

## Commands

| Command | What it does |
| --- | --- |
| `libraries` | Lists libraries on the server. Use it to confirm your token works. |
| `audit` | Reports metadata and file problems: missing covers, unmatched books, duplicates, items missing from disk. |
| `rate` | Looks books up in external sources and tags them with an age band and content flags. |
| `metadata` | Fills blank metadata fields (description, publisher, year, ISBN) from providers. |
| `organize` | Moves book folders on disk into a consistent `Author/Series/Vol - Title` layout. |

Global flags: `--library <idOrName>` to target one library, `--config <path>`, `--verbose`, `--quiet`.
Most commands also accept `--json` for piping and `--limit <n>` for a quick trial run.

### Auditing

```bash
node dist/index.js audit                      # summary counts by issue
node dist/index.js audit --details            # list every affected item
node dist/index.js audit --only unmatched duplicate
node dist/index.js audit --json > reports/audit.json
```

Issue codes: `missing-on-disk`, `invalid`, `no-audio`, `missing-title`, `missing-author`,
`missing-cover`, `unmatched`, `missing-description`, `missing-year`, `missing-narrator`, `unrated`,
`duplicate`.

Duplicates are found by normalizing title and author, so `The Hobbit` and `Hobbit, The (Unabridged)`
by `Tolkien, J.R.R.` land in the same group.

### Age ratings and content flags

```bash
node dist/index.js rate                        # dry run, prints what it would tag
node dist/index.js rate --apply                # write tags to AudiobookShelf
node dist/index.js rate --max-age 12           # show only books banded above age 12
node dist/index.js rate --min-confidence 0.6   # only tag when fairly sure
node dist/index.js rate --force --apply        # re-rate books already tagged
```

AudiobookShelf has no rating field, so results are written as **tags**, which its filter UI already
supports:

- `age:early-reader`, `age:middle-grade`, `age:young-adult`, `age:adult`
- `content:violence`, `content:sexual-content`, `content:profanity`, `content:substance-use`,
  `content:horror`, `content:romance`, `content:self-harm`, `content:religion`
- `abs-butler:rated` — a marker so re-runs can skip already-rated books

Tags outside those namespaces are never touched, so your own tags survive a re-run.

**Read [docs/content-ratings.md](docs/content-ratings.md) before trusting this for parental
controls.** The short version: this infers audience from how librarians and publishers *shelve* a
book. It is reliable for "this is shelved as juvenile fiction" and blind to "chapter 14 is graphic".
Low-confidence results are a prompt to check a title yourself, not a verdict.

### Filling in metadata

```bash
node dist/index.js metadata                              # dry run
node dist/index.js metadata --apply
node dist/index.js metadata --fields description publisher --apply
```

Only fields that are safe to infer are eligible: `description`, `publishedYear`, `publisher`, `isbn`,
`language`. Blank fields are filled; existing values are left alone unless you pass `--overwrite`.
Title and author are deliberately never written — a bad provider match would rename the book, and
matching is a job for AudiobookShelf's own quick-match. As a further guard, a fuzzy (non-ISBN) match
is only used when the provider's title agrees with yours.

### Organizing files on disk

```bash
node dist/index.js organize                                    # dry run: prints the move plan
node dist/index.js organize --apply
node dist/index.js organize --template '{author}/{title} ({year})' --apply
```

Template placeholders: `{author}`, `{title}`, `{series}`, `{sequence}`, `{year}`. Empty segments
collapse, so a standalone book renders `Author/Title` rather than leaving an empty series folder.
Sequence numbers are zero-padded so book 2 sorts before book 10.

This command **touches your files directly**, so:

- It needs filesystem access to the library from the machine it runs on. Under Docker that means
  setting `HOST_LIBRARY_PATH` and `LIBRARY_MOUNT_MODE=rw` — the mount is read-only by default.
- If AudiobookShelf runs in Docker, set `LIBRARY_ROOT` (host path) and `ABS_PATH_PREFIX`
  (in-container path) so reported paths can be translated. `libraries` prints the paths ABS reports.
- It skips any move whose destination already exists, rather than merging.
- It triggers a library rescan afterwards so AudiobookShelf picks up the new paths (`--no-scan` to
  skip).

Take a backup, and run without `--apply` first. Always.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests cover the rating heuristic, path templating, and text normalization — the pieces with real
logic. There are no tests against a live server; the ABS client is a thin pass-through.

## License

MIT
