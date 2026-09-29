[abs-butler](../README.md) › The web UI

# The web UI

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
