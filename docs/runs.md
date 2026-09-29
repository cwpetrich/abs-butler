[abs-butler](../README.md) › Runs: reports, applying and undoing

# Runs: reports, applying and undoing

## What a run says it did

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

## Saying yes to a dry run

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

## Undoing a run

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
