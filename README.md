# abs-butler

A butler for your [AudiobookShelf](https://www.audiobookshelf.org/) servers. Manage one or many from
a single web UI: audit libraries for problems, fill in missing metadata, enforce a folder naming
scheme, and — the reason it exists — tag books with **age bands and content flags** so a library can
be filtered by what's appropriate for whom.

Servers are managed over their HTTP API, so **abs-butler does not need to run on the same machine**.
The one exception is file organization: it moves files, abs-butler has no remote file transport, and
so it is **disabled entirely** for any server whose media this machine cannot reach. That is detected
per server and stated plainly in the UI, rather than failing once a job is already running.

Every operation is a **dry run by default**. Nothing is written until you explicitly apply it.

## Quick start

```bash
cp .env.example .env       # set BUTLER_PASSWORD and BUTLER_SECRET
docker compose up -d butler
```

Open <http://localhost:8478>, sign in, and add a server with its URL and an API key
(AudiobookShelf → Settings → Users → your user → API Token).

Without Docker:

```bash
npm install && npm run build
BUTLER_PASSWORD=... BUTLER_SECRET=... node dist/index.js serve
```

## The web UI

| Page | What it does |
| --- | --- |
| **Servers** | Add, edit, and test servers. Each card shows whether files are manageable from this machine, and exactly which paths were probed. |
| **Runs** | Start a job and watch it. Full history of every run — manual, scheduled, or from the CLI — with the result summary. |
| **Run detail** | Live-tailing log, options used, and a breakdown of what the run found or changed. |
| **Schedules** | Recurring jobs per server and command, at an interval you choose. |
| **Logs** | Every line from every run, filterable by level and searchable. |
| **Settings** | Provider keys, concurrency, rating confidence threshold, and history/log retention. |

Jobs run **one at a time**. They hammer both AudiobookShelf and third-party metadata providers, and
two concurrent rating runs against the same library would double the request rate for no gain. The
queue lives in the database, so a restart doesn't lose it — and any run interrupted by a restart is
marked failed rather than left claiming to be running forever.

## Configuration

Servers and settings live in a SQLite database and are edited from the UI. Only what must be known
*before* the database opens stays an environment variable:

| Variable | Purpose |
| --- | --- |
| `BUTLER_PASSWORD` | Required to log in. **Without it the UI is unauthenticated.** |
| `BUTLER_SECRET` | Encrypts stored API keys at rest with AES-256-GCM. Without it they are stored in plaintext, and the UI says so. |
| `BUTLER_HOST` / `BUTLER_PORT` | Listen address. Defaults to `0.0.0.0:8478`. |
| `BUTLER_DATA_DIR` | Where the database lives. Defaults to `./data`, and `/data` in Docker. |

Set `BUTLER_SECRET` to a long random string (`openssl rand -base64 32`) and keep it. Changing it
makes existing keys unreadable — abs-butler will say so plainly rather than failing mysteriously,
but you will have to re-enter each key.

Upgrading from 0.1? Leave your old `ABS_URL` and `ABS_TOKEN` in `.env` and they are imported into the
database once, on first run.

## Commands

Everything in the UI is also a CLI command. Use `--server <name>` to pick a server when more than one
is configured.

```bash
abs-butler server add --name home --url http://192.168.1.10:13378 --api-key <key>
abs-butler server list
abs-butler server test                  # connectivity + file capability, per server

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

**This is the one command that needs the media mounted where abs-butler runs.** It moves files
directly, and abs-butler has no remote file transport — no SSH, no agent. So for any server whose
media this machine cannot reach, organization is **disabled outright**: not offered in the UI, not
schedulable, and refused by the CLI and API with the reason. It does not generate a plan it could
never carry out.

"Where abs-butler runs" means a writable local path, which you get either by running on the same
machine as the media or by mounting it over NFS/SMB. Either satisfies the check; abs-butler probes
the library root and reports one of:

| State | Meaning |
| --- | --- |
| `read-write` | Organization available. |
| `read-only` | The path exists but this process cannot write to it — still disabled. |
| `unreachable` | The path does not exist on this machine — still disabled. |
| `not-configured` | No library root set. This server is managed over the API only. |

The probe runs at three points: when the UI lists servers (a local stat, no call to
AudiobookShelf), when a run or schedule is created, and again immediately before the job executes —
because a mount can disappear between queueing a job and running it, and a half-finished
reorganization is far worse than one that never started.

Everything else — `audit`, `rate`, `metadata` — works purely over the API, so a server on another
machine is fully manageable for those.

Take a backup and run without applying first. Always.

## Development

```bash
npm run typecheck    # server and web
npm test             # 85 tests
npm run build

npm run dev:web      # Vite dev server on :5473, proxying /api to :8478
```

Layout: `src/core/` holds the logic and task runners, `src/commands/` is thin CLI presentation,
`src/db/` is the SQLite layer, `src/web/` is the HTTP API, and `web/` is the React UI. The CLI and
the job runner call the same task functions, so a scheduled run and a typed one take exactly the same
code path.

## Documentation

- [docs/docker.md](docs/docker.md) — running in Docker, networking, and paths
- [docs/content-ratings.md](docs/content-ratings.md) — where rating data comes from, and its limits

## License

MIT
