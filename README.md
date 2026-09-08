# abs-butler

A butler for your [AudiobookShelf](https://www.audiobookshelf.org/) library. Set it up once and it
keeps the library's **metadata** correct and consistent: it discovers what's missing and fills it
in, and it normalizes what's already there — titles, authors, narrators, series names — so the same
book is described the same way wherever it appears.

Around that it audits the library for problems, enforces a folder naming scheme on disk, and tags
books with age bands and content flags so a library can be filtered by what's appropriate for whom.

One butler, one server, running side by side. abs-butler is meant to live on the same machine as
AudiobookShelf and share its library mount, which is what lets it organize files as well as manage
them over the API. Everything except `organize` works purely over the API, so a butler on another
machine still does the whole metadata job — it just needs the library reachable to move files.

Every operation is a **dry run by default**, and the two that change something you can see are
gated separately. `organize --apply` needs **Allow file changes**; `normalize --apply` needs **Allow
metadata rewrite**. Neither is on after a fresh install.

## Quick start

Three ways to install it. All three run the same code against the same database format and are
configured the same way — from the web UI.

**Snap** — a supervised system service, on any distribution with snapd:

```bash
sudo snap install abs-butler
sudo snap connect abs-butler:removable-media    # only if you want to organize files
```

**Docker** — nothing to clone; the compose file pulls a published multi-arch image:

```bash
curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/docker-compose.yml
docker compose up -d butler
```

**From source**, if you would rather not use either:

```bash
npm install && npm run build
node dist/index.js serve
```

Then open <http://localhost:13380>, pick a password, and add your server's URL along with either an
API token (AudiobookShelf → Settings → Users → your user → API Token) or an admin username and
password. The token is the better choice — it can be revoked in AudiobookShelf without changing the
account's password — but signing in saves the trip through the settings, and comes out the same
either way: abs-butler exchanges the credentials for that same token and stores only the token.

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
| **Settings** | Whether file changes and metadata rewrites are allowed at all, provider keys and region, concurrency, rating confidence, cache and history retention, your password, and the encryption key. |

Jobs run **one at a time**. They hammer both AudiobookShelf and third-party metadata providers, and
two concurrent rating runs against the same library would double the request rate for no gain. The
queue lives in the database, so a restart doesn't lose it — and any run interrupted by a restart is
marked failed rather than left claiming to be running forever.

### Where the data comes from

| Provider | Key needed | What it is for |
| --- | --- | --- |
| **Audnexus** | No | The audiobook source, and the only one that knows a **narrator** exists. Keyed on ASIN — the identifier AudiobookShelf itself matches on — so it answers for one exact audio edition, or not at all. Series name and position come from here too. |
| **Open Library** | No | Crowd-sourced subjects, the richest audience signal for `rate`. |
| **Google Books** | Optional | Publisher-assigned BISAC categories and an explicit maturity rating. |

Audnexus only answers for books that have an ASIN, so the other two carry an unmatched library.
Letting AudiobookShelf match your books first is what makes `normalize` able to do its best work.

**Answers are cached.** A provider is asked about a book once and the answer is reused — for the
rest of that run, for the other commands, and for the next scheduled run. Without this a nightly
job re-asks every provider about every book forever, mostly to re-learn the same nothing. Hits are
kept for **Provider cache (days)** (30 by default); "nothing found" expires at a quarter of that,
since a miss usually reflects the library rather than the book.

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

Connecting with a username and password stores neither: they are exchanged for an API token in a
single request, and only that token is kept. Leave the secret off the command line and `connect`
asks for it at the terminal without echoing it, which also keeps it out of the shell history. With
no terminal attached — a container started without a TTY, or a CI job — it does not wait for an
answer nobody can give: it exits naming the flag to pass instead. The AudiobookShelf API token is sealed with AES-256-GCM
before it is written to the database. The
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
abs-butler connect --url http://localhost:13378 --username admin   # prompts for the password
abs-butler connect --url http://localhost:13378                    # prompts for either
abs-butler status                       # connectivity + file capability
abs-butler configure --library-root /audiobooks
abs-butler configure --file-changes on      # let organize --apply move files
abs-butler configure --metadata-rewrite on  # let normalize --apply replace titles and names
abs-butler disconnect                   # forget the connection, keep history

abs-butler audit --details              # metadata and file problems
abs-butler metadata                     # fill blank description/year/publisher/ISBN
abs-butler normalize                    # make titles, authors, narrators, series consistent
abs-butler normalize --fields work      # stamp Open Library work identities only
abs-butler rate                         # age bands and content flags
abs-butler organize                     # plan a folder reorganization

abs-butler runs                         # recent runs, and what can still be undone
abs-butler revert <runId>               # put back what a run changed

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

`metadata` fills fields that are **blank**: `description`, `publishedYear`, `publisher`, `isbn`,
`language`. Existing values are left alone unless you pass `--overwrite`. Nobody is surprised by a
description appearing where there was none, so the bar for writing one is low — a candidate has to
match the book, but it does not have to be provably the same edition.

Rewriting a value someone can already read is a different question, and lives in `normalize` below.

### Normalizing what's already there

`normalize` is the command for mismatches: the same series spelled two ways, an author stored as
"King, Stephen" on one book and "Stephen King" on the next, a title carrying "(Unabridged)" that
none of its siblings do. It covers `title`, `subtitle`, `author`, `narrator` and `series`.

Every proposed change carries the evidence it rests on, and there are three tiers:

| Tier | What it means | Example |
| --- | --- | --- |
| **provider** | An **exact ASIN or ISBN match**, and nothing weaker | Audnexus knows this exact audio edition's narrator |
| **consensus** | The library disagreeing with itself, resolved toward the majority | four books say "The Stormlight Archive", one says "Stormlight Archive" |
| **local** | A deterministic repair of how the text is written | "Hobbit, The" → "The Hobbit"; "King, Stephen" → "Stephen King" |

A fuzzy title match can **never** rename a book — the scoring caps it below the threshold a rewrite
requires, by construction. So a library AudiobookShelf has never matched still gets its consensus
and local repairs, with no provider consulted and no network call made at all.

Higher tiers win when two disagree. `--fields` narrows what is touched and `--no-consensus` turns
off the library-agreement tier.

**Allow metadata rewrite** gates *replacing* a value, not supplying a missing one. With it off,
`--apply` still fills what was blank — a subtitle, a series a book never had, a work identity — and
holds back every change that would overwrite something, saying how many it held. Wanting work tags
for a multi-server client should not require consenting to have your titles rewritten.

Take a dry run first and read the `WHY` column. It is the whole point of the output.

### Work identity, for clients reading several servers

`normalize --fields work` stamps each book with the Open Library **work** key it
resolves to, as a tag:

```
abs-butler:work:OL27482W
```

A work is the book, not the recording. Two servers holding different narrations of
*The Return of the King* hold the same work — which is why this is not an ASIN, and
not an ISBN: those identify one audio edition and one printing respectively, and
would deny a match that a reader would call obvious.

It exists for tools that read across servers and have to decide whether two entries
are the same book. AudiobookShelf itself has no use for it, nothing here depends on
it, and a library that never runs it is no worse off.

**What it is worth, measured.** Sampled across 2,230 items on two live servers,
against pairs of the same book held by both: when both sides resolve, they agree on
the work **13 times out of 13**. But only about a third resolve at all — Open Library
is thin on self-published and LitRPG titles, which is much of what those libraries
hold. So it is a high-precision, low-recall signal.

That shapes how a client should use it: **a work tag should only ever merge, never
split.** Two copies that disagree, or where only one carries a tag, are no worse off
than before and should fall back to matching on title and author. Used that way it
can only add correct merges.

The bar to write one is deliberately higher than for filling a blank field: a wrong
description is noise on one server, while a wrong identity is repeated to every
client that reads it. In practice the author has to have actually agreed, not merely
been absent.

### Undoing a run

Every applied change records how to put it back, so an apply is something you
can reconsider:

```bash
abs-butler runs                  # recent runs, and what can still be undone
abs-butler revert 42             # what it would restore
abs-butler revert 42 --apply
```

The record is the patch that would restore the item, in the same shape and
against the same endpoint the original write used — so an undo cannot drift
away from the thing it undoes. Only the fields a run actually touched are
captured, which means an unrelated edit made in between is left alone.

**An item edited since the run is skipped, not overwritten.** Correcting a title
by hand and then having a revert quietly throw that away would be worse than the
value being fixed, so those are named and left, and `--force` is how you say you
meant it anyway. A book deleted since the run is skipped for the same reason.

`organize` is the exception: it moves files, and this cannot undo that by
writing to the API. Its plan is a dry run by default and its own switch guards
the apply — take a backup and read the plan, which is the advice it has always
carried.

The web UI offers the same thing on a run's page, preview first.

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
npm test             # 224 tests
npm run build

npm run dev:web      # Vite dev server on :5473, proxying /api to :13380
```

Layout: `src/core/` holds the logic and task runners, `src/commands/` is thin CLI presentation,
`src/db/` is the SQLite layer, `src/web/` is the HTTP API, and `web/` is the React UI. The CLI and
the job runner call the same task functions, so a scheduled run and a typed one take exactly the same
code path.

Two modules in `src/core/` are worth reading before changing anything that talks to a provider:
`matching.ts` decides whether a result describes the book in hand and how strongly, and `lookup.ts`
is the single door every provider call goes through, so caching and scoring cannot be bypassed by
accident.

CI runs typecheck, tests (on Node 24 and on 22.13, the floor `engines` declares), and a build on
every push, plus the Docker image for amd64 and arm64 and the snap for amd64. Releases are cut by
pushing a `v*` tag, which publishes the multi-arch image and both snap architectures.

## Upgrading from 0.3

Nothing to do — the database migrates on first start, adding the provider answer cache.

Two things are new and both are **off or empty until you act**:

- `normalize` appears as a command, and `normalize --apply` is refused until **Allow metadata
  rewrite** is switched on in Settings. Existing schedules are untouched.
- **Audnexus** joins the provider list for new installs. An existing install keeps the provider list
  it already had, so add `audnexus` in Settings → Metadata providers to get narrator and series
  data. Nothing else changes if you do not.

The first `metadata` or `rate` run after upgrading is the usual speed; the ones after it are much
faster, since answers are now cached.

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
- [docs/releasing.md](docs/releasing.md) — cutting a release, and the one-time publishing setup

## License

MIT
