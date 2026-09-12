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

**Docker, with the installer** — recommended when abs-butler runs on the same machine as
AudiobookShelf. It settles the one thing the UI cannot: which host directory gets mounted in, since
a bind mount is fixed when the container is created.

```bash
curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.sh
sh install.sh                               # finds AudiobookShelf and asks about it
```

It looks for AudiobookShelf running on the same machine and, from the container, reads three things
at once: the URL, the host directory holding the library, and the path AudiobookShelf itself reports
— which is the path prefix, otherwise the easiest setting to get wrong. It will not guess between
several servers. Give it an admin username and it connects on the spot, so one command goes from
nothing to connected; decline and it just fills in the form for you.

It derives file ownership from the library directory and prints what to do next. `--library` skips
the search, `--no-discover` turns it off, and `--dry-run` shows every file it would write without
touching anything.

The UI is published on every interface, the same as AudiobookShelf itself — most of these servers
are headless, and a loopback default would leave nothing able to open it. Two things make that
safe rather than merely convenient:

- **Setup needs a code**, generated during install, printed at the end, and stored as
  `BUTLER_SETUP_CODE`. Until a password exists the setup page has to answer an anonymous visitor,
  so without this the first person on the network to load it would take the account. With the code
  set it is required whether or not the 15-minute window is open — the race closes and the clock
  stops mattering.
- **Failed logins are throttled** per client address, backing off to a 15-minute wait. A weak
  password stops being brute-forceable at network speed.

`--local` publishes on `127.0.0.1` instead, if you would rather reach it over SSH or Tailscale.

Updating later is the same script:

```bash
cd /opt/abs-butler && docker compose pull && docker compose up -d
```

The image tag is `:latest`, so that is the whole update — the same thing AudiobookShelf asks of you.
`install.sh --update` exists for the rarer case where the scaffolding around the container changed
rather than abs-butler itself, and a release that needs it says so. See
[Updating](docs/docker.md#updating). Read it before you run it — it is one file, and it
is meant to be read.

**Docker, by hand** — the compose file pulls a published multi-arch image:

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
| **Run detail** | Live-tailing log, options used, and a breakdown of what the run found or changed — with tick boxes to apply a dry run's findings, per book or all at once. |
| **Schedules** | Recurring jobs, at an interval you choose. |
| **Logs** | Every line from every run, filterable by level and searchable. |
| **Connection** | The server URL, API token, and library paths. Test shows exactly which paths were probed. |
| **Settings** | Whether file changes and metadata rewrites are allowed at all, provider keys and region, concurrency, rating confidence, cache and history retention, your password, and the encryption key. |

Jobs run **one at a time**. They hammer both AudiobookShelf and third-party metadata providers, and
two concurrent rating runs against the same library would double the request rate for no gain. The
queue lives in the database, so a restart doesn't lose it — and any run interrupted by a restart is
marked failed rather than left claiming to be running forever.

**Any run can be stopped**, from the Runs list or from its own page. A queued run disappears; a
running one is asked to stop and ends within a request or two — it finishes the book it is on
rather than being cut off mid-write. Whatever it already applied stays applied, and Undo on the run
covers exactly that much. A stopped run is recorded as `cancelled`, not failed.

### Where the data comes from

| Provider | Key needed | What it is for |
| --- | --- | --- |
| **Audible** | No | Audible's own catalogue, asked directly. The largest audiobook source: **narrator**, series name and position, publisher, and hierarchical categories that carry the audience level. Searchable by title, so it answers for books AudiobookShelf never matched. |
| **AudioSilo Meta** | No | An open, community-maintained audiobook database (CC0). The only source here that is not a retailer, and the only one that models a **work** separately from its **recordings** — so an ASIN from *any* marketplace resolves to one specific narration, not just a book. |
| **Audnexus** | No | Audible's catalogue by way of a maintained community proxy, keyed on ASIN. Kept alongside the other two rather than behind them: when one stops answering, the others are already configured. |
| **Open Library** | No | Crowd-sourced subjects, the richest audience signal for `rate`. |
| **Google Books** | Optional | Publisher-assigned BISAC categories and an explicit maturity rating. |
| **Apple Books** | No | Free and keyless, and the only source that covers ebooks as well as audiobooks. Its categories are the only ones that separate a picture book from a chapter book. It publishes no ISBN or ASIN, so it fills blanks and rates but can never rewrite a field. |

The first three describe an audio **edition** — they are the only sources that know a narrator
exists. The last two describe the **work**, and carry the shelving that `rate` reads. Letting
AudiobookShelf match your books first still gives the best results, since an ASIN identifies one
exact edition, but it is no longer the difference between an answer and nothing.

**Sources agreeing does not inflate a rating.** Each provider is scored independently and a rule
counts at most once within one, so two of them saying the same thing raises the winning band and
the runner-up together — leaving the margin, and therefore the confidence, where it was.

**An adult book is recognized by what nobody says about it.** Every band is inferred from a
*positive* juvenile or teenage label, because that is what catalogues state outright — nobody
shelves a thriller as "adult fiction". So adult novels matched no rule, scored zero, and came back
`unknown`, which mattered more than it sounds: `--max-age` lists the books too old for a reader and
skips `unknown`, so the books it exists to surface were the ones it could not see. When two or more
sources describe a book and none of them mentions an audience, it is banded adult — at a lower
confidence than any stated label reaches, and never over one. A book nobody described stays
`unknown`; no data, no guess.

**One provider, one vote.** A rule counts at most once per *source*, however many editions that
source returned. This is worth stating because it was not true until recently: the deduplication
was per result, and a source answering with eight editions of one book — Apple does exactly that
for *The Very Hungry Caterpillar*, mostly spin-offs — got eight votes. The chattiest source was
quietly the loudest.

**A provider that stops answering is dropped for the rest of the run.** Google Books without an API
key shares an anonymous quota with everyone else on your address, and that quota is usually already
spent — every lookup comes back rate limited. After three refusals in a row abs-butler stops asking
that provider until the next run and says so once in the log, instead of paying two requests and a
backoff per book to be told the same thing a thousand times. Anything it had already cached is
still used.

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
| `BUTLER_HOST` / `BUTLER_PORT` | Listen address *inside* the process. Defaults to `0.0.0.0:13380` — one above AudiobookShelf's `13378` and `abs-sync`'s `13379`, so the tools for one server sit together. |
| `BUTLER_BIND` | Docker only: which host address the compose file publishes on. Defaults to `127.0.0.1`, so the UI is reachable from the machine it runs on and nowhere else. Set it to `0.0.0.0` to reach abs-butler from another machine — and read the note under [About that first-run password](#about-that-first-run-password) before you do. |

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

abs-butler audit --details              # metadata and file problems, book by book
abs-butler metadata                     # fill blank description/year/publisher/ISBN
abs-butler normalize                    # make titles, authors, narrators, series consistent
abs-butler normalize --fields work      # stamp Open Library work identities only
abs-butler rate                         # age bands and content flags
abs-butler organize                     # plan a folder reorganization

abs-butler runs                         # recent runs, what is waiting, and what can be undone
abs-butler apply <runId>                # carry out what a run decided, or part of it
abs-butler revert <runId>               # put back what a run changed

abs-butler serve                        # the web UI and scheduler
```

Under Docker, prefix with `docker compose run --rm cli`. Add `--json` to anything for piping, and
`--limit N` for a quick trial against part of a library.

### What to run, in what order

Two of these depend on each other; the rest is preference.

1. **`audit`** — read-only. What is wrong, and how much of it.
2. **`metadata`** — fills blank description, year, publisher, language and **ISBN**.
3. **`normalize`** — titles, subtitles, authors, narrators, series.
4. **`rate`** — age bands and content flags.
5. **`organize`** — moves folders on disk. Last, always.

`metadata` before `normalize` is a real dependency: an item with no ASIN and no ISBN is skipped by
`normalize` outright, because a fuzzy match is capped below the rewrite threshold by design and so
could not change the outcome. Filling ISBNs first is what lets providers correct those books at all.

`organize` last matters more. The default template is `{author}/{series}/{sequence} - {title}`, so
it bakes whatever the metadata says at that moment into the folder path. Run it before `normalize`
and every path is rebuilt from names that are about to change.

`rate` after `normalize` is a softer preference: lookups match on title and author, so cleaner
values match better.

Every command is a dry run until `--apply`. `organize` is the one `revert` cannot undo — it moves
files and records no revisions — so its dry run is the only preview you get.

A dry run is not throwaway: what it decided is kept, and `abs-butler apply <runId>` carries it out
without asking the providers anything again. See [Saying yes to a dry
run](#saying-yes-to-a-dry-run).

### What a run says it did

Every run records a row per book — what it did to that book, or why it did not — and keeps it with
the run. Counts alone are not actionable: "37 books have no narrator" cannot be acted on until you
know which 37, and "tagged 300 item(s)" says nothing about what any of them were tagged with, or on
whose word.

```
abs-butler audit     --details   # every issue found, per book
abs-butler rate      --details   # the band, the flags, the tags, and the evidence behind them
abs-butler metadata  --details   # every value it would write, and which provider supplied it
abs-butler normalize --details   # every rewrite, its evidence tier, and what was held back
abs-butler organize  --details   # where each book is going, or why it is staying put
```

`--only-changed` (`--only-issues` for `audit`) leaves out the items the run had nothing to do to.
They are listed by default on purpose: a book absent from a report is indistinguishable from one
that was never reached, and "which of my books are fine" is as much a question as "which are not".

The same report is on the run's page in the web UI, under **What this run did**. Every count doubles
as a filter — click *Adult* to see exactly those books, *Held back* to see the changes the rewrite
switch refused, or *Already in place* to see what `organize` looked at and left alone. It is also
where you say yes to it, book by book or all at once.

Each run's log carries the same information in one line per kind: which bands a `rate` run landed
on, which fields a `metadata` run filled and who answered for them, which of the three evidence
tiers a `normalize` run relied on.

**A stopped run reports what it got through.** Stopping is an ending, not a failure: the books it
had already decided on are recorded with the rest, the summary says how many it never reached, and
anything already written stays written with this run's undo record covering exactly that much. A
book it had decided on but was stopped before writing says so — `not-written`, and its line stays in
the conditional, because the server does not have that change.

Detail is kept for the ten most recent runs and pruned after that — one row per book per run is the
bulky part. The counts in each run's summary survive for as long as the run is in history, and a
pruned run has nothing left to apply.

### Saying yes to a dry run

A dry run works out exactly what it would write to each book. That is the thing you read and agree
with — so it is kept, and applying it carries out those decisions rather than making new ones:

```
abs-butler runs                         # WAITING says how much each run has left to carry out
abs-butler apply 12                     # what is still current, and what has moved on since
abs-butler apply 12 --apply             # carry out all of it
abs-butler apply 12 --items li_abc --apply   # or just this book
```

In the web UI it is the same thing with tick boxes: the run's page offers **Apply all N change(s)**,
and every row still waiting has a box, so three books out of four hundred is three ticks and a
click. Selection survives changing the filter, so you can take two books from *Adult* and one from
*Held back* in one go.

Why it matters more than saving the wait: **it applies what you read**. Running the command again
with `--apply` asks every provider afresh, and providers revise their answers — so the second run
can write something the report you approved never mentioned. Applying skips the lookups entirely,
which on a large library is the difference between an hour and a minute.

What it will not do is write over somebody's work:

- A book **edited since the run** is left alone and named, the same bargain `revert` makes. Its line
  says what it now reads and what the run expected.
- A book that **already says what the run proposed** is reported as such, not written to again —
  applying the same report twice is harmless.
- A rating is applied as the **tags it adds and removes**, never as the whole list, so a tag you
  added in between survives.
- The **switches are re-read**. Turning on *Allow metadata rewrite* and applying the report is the
  supported way to get the changes a `normalize` held back; until then they stay held and stay
  waiting.
- A `normalize` patch is **rebuilt against the book as it stands**, so a series keeps the sequence
  your library already knows.

An apply is a run like any other: it queues behind other work, keeps its own log, and — for
everything but `organize` — records how to put every change back. What it carries out stops being
offered by the run it came from, so `WAITING` only ever counts work that is genuinely outstanding.

A run stopped partway leaves the books it decided on but never wrote — those are waiting too, so
`apply` is also how you finish a run that was interrupted.

### Auditing

Issue codes: `missing-on-disk`, `invalid`, `no-audio`, `missing-title`, `missing-author`,
`missing-cover`, `unmatched`, `missing-description`, `missing-year`, `missing-narrator`, `unrated`,
`duplicate`.

Duplicates are found by normalizing title and author, so `The Hobbit` by `J.R.R. Tolkien` and
`Hobbit, The (Unabridged)` by `Tolkien, J.R.R.` land in the same group.

**Ebooks are not broken audiobooks.** A book library can hold EPUBs and PDFs, and one of those has
no audio by its nature. `no-audio` is raised only when an item has neither audio files nor an ebook
— an import that produced an empty record — and an ebook-only item is not asked for a narrator it
was never going to have. An item holding both an audiobook and an ebook is still audited as an
audiobook.

The same goes for duplicates: the EPUB and the audiobook of one book are two formats, not a
mistake, so they are not reported against each other. Two copies of the *same* format still are —
that is the case worth catching. Settings → Auditing turns the cross-format pairs back on if you
want to see them.

`normalize` will not write a narrator onto a reading copy either. That one mattered: an ISBN match
scores 0.97, above the rewrite threshold, so a source carrying narrators for a recording could have
written an audiobook's cast onto an EPUB — plausible enough that nobody would question it.

**A first audit flags everything, and that is not a fault.** `unrated` is true of every book until
`rate` has run once, so a fresh library reports 100% affected. Read the breakdown, not the total.

Every audited item is kept with the run, passes included — see [What a run says it
did](#what-a-run-says-it-did):

```
abs-butler audit --details                 # every item, worst first, clean ones trailing
abs-butler audit --details --only-issues   # just the problems
```

The one count worth reading first is **`unmatched`**. Those books carry no ISBN and no ASIN, so no
provider can rewrite them — if that number is high, `metadata` is doing real work before
`normalize` can.

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
| **provider** | An **exact ASIN or ISBN match**, and nothing weaker | Audible knows this exact audio edition's narrator |
| **consensus** | The library disagreeing with itself, resolved toward the majority | four books say "The Stormlight Archive", one says "Stormlight Archive" |
| **local** | A deterministic repair of how the text is written | "Hobbit, The" → "The Hobbit"; "King, Stephen" → "Stephen King" |

A fuzzy title match can **never** rename a book — the scoring caps it below the threshold a rewrite
requires, by construction. So a library AudiobookShelf has never matched still gets its consensus
and local repairs, with no provider consulted and no network call made at all.

Higher tiers win when two disagree, so an outside source **outranks the library's own habit**: if
every provider says "The Mistborn Saga" and the shelf says "Mistborn Saga", the shelf is what gets
corrected. Consensus only decides what no provider could — it never invents a name, it only picks
between spellings the library already holds, and only where the library contradicts itself.
`--fields` narrows what is touched and `--no-consensus` turns off the library-agreement tier.

### Sources vote, field by field

Within the provider tier, **every** source that identified the exact edition gets a say, and each
field is settled on its own. The most-agreed value wins; a tie goes to the most trusted source that
offered it, in the order listed under [Where the data comes from](#where-the-data-comes-from).

Two things follow, and both are visible in a dry run, which names the sources behind every change:

- A source that has nothing to say about a field **abstains** rather than winning it. AudioSilo
  carries no subtitles, so it cannot blank one that Audible and Audnexus both supply.
- Where sources genuinely disagree — "The Mistborn Saga" against "Mistborn" — the answer is decided
  by how many say it, not by which one happens to be listed first.

```
-> subtitle  "" => "Mistborn Book 1"      [provider: audible + audnexus]
-> narrator  "Wrong Narrator" => "Michael Kramer"   [provider: audible + audiosilo + audnexus]
-> series    "Mistborn Saga" => "The Mistborn Saga" [provider: audible + audnexus]
```

Counting sources does not lower the bar: only matches that already cleared the rewrite threshold
are allowed to vote, so this changes *which* identified answer is chosen, never whether an
unidentified one may be used.

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
abs-butler runs                  # recent runs, what is waiting, and what can be undone
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

#### Single-file books

A bare `The Hobbit.m4b` sitting in a library root is a perfectly ordinary AudiobookShelf item, and
for many libraries it is most of them. Those are **left alone by default** and reported as skipped,
rather than passed over in silence as they were before:

```
abs-butler organize --single-files          # dry run, showing where each loose file would go
abs-butler organize --single-files --apply
```

Each one is given the folder the template describes, so the library ends up uniform:

```
The Hobbit.m4b  ->  J.R.R. Tolkien/The Hobbit/The Hobbit.m4b
mistborn1.m4b   ->  Brandon Sanderson/Mistborn/01 - The Final Empire/The Final Empire.m4b
```

The file inside is named from the title rather than from the last template segment, so a series
book does not become `01 - The Final Empire.m4b` inside a folder already called `01 - The Final
Empire`. A file with no extension is left alone — it cannot be named on the far side without
inventing a media type.

It is off by default because it is the one change that *creates* structure rather than rearranging
it, on the items most likely to be numerous, and no move can be undone by `revert`. Dry run first.

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

## Upgrading to 0.4

The database migrates on first start; nothing to do there. Two things changed around it:

- **The Docker UI is published on loopback now.** `docker-compose.yml` used to publish on every
  interface, which put the anonymous first-run setup page in front of the whole network. It now
  binds `127.0.0.1` by default. If you reached abs-butler from another machine, set
  `BUTLER_BIND=0.0.0.0` in `.env` to get that back.
- **`BUTLER_PORT` works properly.** It was both the app's listen port and the host side of the port
  mapping, so setting it to anything but `13380` moved the listener while the mapping stayed put and
  the UI simply vanished. Both sides follow it now, so an existing `BUTLER_PORT` that appeared to do
  nothing will start taking effect.

New, and optional: connecting with an admin username and password instead of an API token, and
`install.sh` for setting up beside AudiobookShelf.

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
