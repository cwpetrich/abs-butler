[abs-butler](../README.md) › Commands

# Commands

Everything in the UI is also a CLI command, against the same database.

```bash
abs-butler connect --url http://localhost:13378 --api-key <key>
abs-butler connect --url http://localhost:13378 --username admin   # prompts for the password
abs-butler connect --url http://localhost:13378                    # prompts for either
abs-butler status                       # connectivity + file capability
abs-butler configure --library-root /audiobooks
abs-butler configure --file-changes on      # let organize --apply move files
abs-butler configure --metadata-rewrite on  # let normalize --apply replace titles and names
abs-butler configure --track-repair on      # let repair --apply rewrite track lists
abs-butler disconnect                   # forget the connection, keep history

abs-butler audit --details              # metadata and file problems, book by book
abs-butler metadata                     # fill blank description/year/publisher/ISBN
abs-butler normalize                    # make titles, authors, narrators, series, genres consistent
abs-butler normalize --fields work      # stamp Open Library work identities only
abs-butler rate                         # age bands and content flags
abs-butler organize                     # plan a folder reorganization
abs-butler repair                       # books listing every file twice after a storage move

abs-butler runs                         # recent runs, what is waiting, and what can be undone
abs-butler apply <runId>                # carry out what a run decided, or part of it
abs-butler revert <runId>               # put back what a run changed

abs-butler serve                        # the web UI and scheduler
```

Under Docker, prefix with `docker compose run --rm cli`. Add `--json` to anything for piping, and
`--limit N` for a quick trial against part of a library.

## What to run, in what order

Two of these depend on each other; the rest is preference.

1. **`audit`** — read-only. What is wrong, and how much of it.
2. **`metadata`** — fills blank description, year, publisher, language and **ISBN**.
3. **`normalize`** — titles, subtitles, authors, narrators, series, genres.
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
run](runs.md#saying-yes-to-a-dry-run).
