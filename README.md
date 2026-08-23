# abs-butler

A butler for your [AudiobookShelf](https://www.audiobookshelf.org/) library. It audits the library
for problems, fills in missing metadata, enforces a folder naming scheme, and — the reason it exists
— tags books with **age bands and content flags** so a library can be filtered by what's appropriate
for whom.

One butler, one server, running side by side. abs-butler is meant to live on the same machine as
AudiobookShelf and share its library mount, which is what lets it organize files as well as manage
them over the API. If you run several AudiobookShelf servers, run a butler beside each.

Every operation is a **dry run by default**. Nothing is written until you explicitly apply it, and
moving files takes a second deliberate step: `organize --apply` is refused until **Allow file
changes** is switched on in Settings, which it is not on a fresh install.

## Quick start

Three ways to install it. All three run the same code against the same database format and are
configured the same way — from the web UI.

**Snap** — a supervised system service, on any distribution with snapd:

```bash
sudo snap install abs-butler
sudo snap connect abs-butler:removable-media    # only if you want to organize files
```

**Docker**:

```bash
docker compose up -d butler
```

**From source**, if you would rather not use either:

```bash
npm install && npm run build
node dist/index.js serve
```

Then open <http://localhost:13380>, pick a password, and add your server's URL and an API token
(AudiobookShelf → Settings → Users → your user → API Token).

That's the whole setup. There is nothing to configure before first launch: abs-butler generates its
own encryption key and keeps everything else in its database.

### Which to pick

| | Supervised | Data lives in | Reaching your library |
| --- | --- | --- | --- |
| **Snap** | yes, via systemd | `/var/snap/abs-butler/common` | `/mnt`, `/media`, `/run/media` only — [why](docs/snap.md#reaching-your-library) |
| **Docker** | yes, restart policy | the `butler-data` volume | any path you bind-mount, with `PUID`/`PGID` set |
| **Source** | no — bring your own unit | `~/.local/share/abs-butler` | ordinary file permissions; the only one with no extra step |

Snap is the least work on Ubuntu and most distributions. Docker is the least surprising if
AudiobookShelf already runs in a container. From source is the most flexible and the only one where
`organize` writes as your own user with nothing to configure — at the cost of supervising it
yourself.

### About that first-run password

Setting a password has to be reachable by someone who has not logged in yet — there is nothing to
log in against. So it is bounded rather than left open: **setup accepts a password for 15 minutes
after startup**, and the first browser to open the page claims it, so nobody can submit one behind
your back once you are there.

If the window closes before you get to it, restart abs-butler (`docker compose restart butler`) and
it reopens. A setup code is also printed at startup if you would rather not restart.

On a home network that is the right trade. If you expose this port beyond your own network, set
`BUTLER_SETUP_CODE` and the code is required as well.

## The web UI

| Page | What it does |
| --- | --- |
| **Runs** | Start a job and watch it. Full history of every run — manual, scheduled, or from the CLI — with the result summary. |
| **Run detail** | Live-tailing log, options used, and a breakdown of what the run found or changed. |
| **Schedules** | Recurring jobs, at an interval you choose. |
| **Logs** | Every line from every run, filterable by level and searchable. |
| **Connection** | The server URL, API token, and library paths. Test shows exactly which paths were probed. |
| **Settings** | Whether file changes are allowed at all, provider keys, concurrency, rating confidence, retention, your password, and the encryption key. |

Jobs run **one at a time**. They hammer both AudiobookShelf and third-party metadata providers, and
two concurrent rating runs against the same library would double the request rate for no gain. The
queue lives in the database, so a restart doesn't lose it — and any run interrupted by a restart is
marked failed rather than left claiming to be running forever.

## Configuration

Everything is edited in the UI and stored in the database. Only a few deployment facts stay outside
it, and none of them is a secret. Under snap they are `snap set abs-butler port=…` and friends;
everywhere else they are environment variables:

| Variable | Purpose |
| --- | --- |
| `BUTLER_DATA_DIR` | Where the database and encryption key live. Defaults to `~/.local/share/abs-butler`, and `/data` in Docker. |
| `BUTLER_HOST` / `BUTLER_PORT` | Listen address. Defaults to `0.0.0.0:13380` — one above AudiobookShelf's `13378` and `abs-sync`'s `13379`, so the tools for one server sit together. |

The listen address deliberately stays out of the UI: a wrong value set there would lock you out of
the only thing that could fix it, and under Docker the internal port is remapped host-side anyway.

Two optional variables exist for hardening: `BUTLER_SETUP_CODE` (above) and `BUTLER_SECRET`, which
lets you manage the encryption key yourself instead of letting abs-butler generate one.

### Credentials at rest

The AudiobookShelf API token is sealed with AES-256-GCM before it is written to the database. The
key lives in `secret.key` beside the database — deliberately *not in* it, since a key stored next to
its own ciphertext is obfuscation rather than encryption. The point is that a copy of the database,
which is what a backup or a support bundle contains, is not a copy of your credentials.

It generates itself on first use, so encryption is on by default rather than something you have to
remember to turn on. You can rotate it from Settings, which re-encrypts the stored token under the
new key rather than orphaning it.

**Back up `BUTLER_DATA_DIR` as a unit** — it holds the database *and* the key. If you want them
separated, back up `abs-butler.db` alone and keep `secret.key` somewhere else.

## Commands

Everything in the UI is also a CLI command, against the same database.

```bash
abs-butler connect --url http://localhost:13378 --api-key <key>
abs-butler status                       # connectivity + file capability
abs-butler configure --library-root /audiobooks
abs-butler configure --file-changes on      # let organize --apply move files
abs-butler disconnect                   # forget the connection, keep history

abs-butler audit --details              # metadata and file problems
abs-butler rate                         # age bands and content flags
abs-butler metadata                     # fill blank description/year/publisher/ISBN
abs-butler organize                     # plan a folder reorganization

abs-butler serve                        # the web UI and scheduler
```

Under Docker, prefix with `docker compose run --rm cli`. Add `--json` to anything for piping, and
`--limit N` for a quick trial against part of a library.

### Auditing

Issue codes: `missing-on-disk`, `invalid`, `no-audio`, `missing-title`, `missing-author`,
`missing-cover`, `unmatched`, `missing-description`, `missing-year`, `missing-narrator`, `unrated`,
`duplicate`.

Duplicates are found by normalizing title and author, so `The Hobbit` by `J.R.R. Tolkien` and
`Hobbit, The (Unabridged)` by `Tolkien, J.R.R.` land in the same group.

### Age ratings and content flags

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
Low confidence is how the tool asks a human to look.

### Filling in metadata

Only fields safe to infer are eligible: `description`, `publishedYear`, `publisher`, `isbn`,
`language`. Blank fields are filled; existing values are left alone unless you ask to overwrite.
Title and author are deliberately never written — a bad provider match would rename the book, and
matching is AudiobookShelf's own job. As a further guard, a fuzzy (non-ISBN) match is only used when
the provider's title agrees with yours.

### Organizing files on disk

Default layout is `Author/Series/01 - Title`. Placeholders: `{author}`, `{title}`, `{series}`,
`{sequence}`, `{year}`. Empty segments collapse, so a standalone book renders `Author/Title` rather
than leaving an empty series folder. Sequence numbers are zero-padded so book 2 sorts before book 10.

**This is the one command that touches the filesystem.** `audit`, `rate`, and `metadata` work purely
over the API and need no mount at all.

Because AudiobookShelf reports paths as *it* sees them — and a containerized ABS sees
`/audiobooks/...`, not your host path — abs-butler needs two settings to translate:

| Setting | Whose view of the library | Example |
| --- | --- | --- |
| **Path prefix** | AudiobookShelf's | `/audiobooks` |
| **Library root** | abs-butler's | `/audiobooks` in Docker, or `/mnt/media/audiobooks` natively |

Leave the prefix blank if the two already agree, which they do when AudiobookShelf runs natively.
**Connection → Test** shows each library folder, the path it maps to here, and whether that path is
reachable and writable — the fastest way to get this right.

If the library root is unset or unreachable, organizing is **disabled outright**: not offered in the
UI, not schedulable, and refused by the CLI and API with the reason. It does not generate a plan it
could never carry out. The check runs when the page loads, when a run or schedule is created, and
again immediately before the job executes — because a mount can disappear between queueing a job and
running it, and a half-finished reorganization is far worse than one that never started.

Two separate things have to be true before a file moves, and they fail for different reasons:

| | What it answers | Where it lives |
| --- | --- | --- |
| **File capability** | Can abs-butler reach the media at all? | The filesystem — a mount, a permission bit, a snap interface |
| **Allow file changes** | Is it permitted to? | Settings, off by default |

The first is probed automatically and explains itself in terms of your actual install: under Docker
it reports the uid and gid to set, under snap the interface to connect, natively the group to join.
The second is a switch, so an apply is always something you chose rather than something a leftover
config allowed.

New folders created by `organize` inherit ownership and permissions from the directory they land in,
so a library organized by a root daemon stays writable by the account that owns it.

Take a backup and run without applying first. Always.

## Development

```bash
npm run typecheck    # server and web
npm test             # 114 tests
npm run build

npm run dev:web      # Vite dev server on :5473, proxying /api to :13380
```

Layout: `src/core/` holds the logic and task runners, `src/commands/` is thin CLI presentation,
`src/db/` is the SQLite layer, `src/web/` is the HTTP API, and `web/` is the React UI. The CLI and
the job runner call the same task functions, so a scheduled run and a typed one take exactly the same
code path.

## Upgrading from 0.2

Your database migrates automatically on first start. Because 0.2 could hold several servers and 0.3
holds one, **the first server configured becomes the connection**, and runs and schedules belonging
to the others are removed rather than silently re-attributed to a server they never ran on. Settings
and the surviving server's history are kept.

Two things change in `.env`, which is now almost empty:

- `BUTLER_PASSWORD` is ignored. Passwords are set in the UI and stored as a salted hash, so you go
  through the setup screen once on first start.
- `BUTLER_SECRET` still works and takes precedence over the generated key file — but if you unset
  it, abs-butler cannot read a token that was sealed with it. Re-enter the API token after removing
  it, or leave it in place.

## Documentation

- [docs/snap.md](docs/snap.md) — running as a snap, confinement, and reaching your library
- [docs/docker.md](docs/docker.md) — running in Docker, networking, and paths
- [docs/content-ratings.md](docs/content-ratings.md) — where rating data comes from, and its limits

## License

MIT
