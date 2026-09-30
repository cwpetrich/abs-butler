[abs-butler](../README.md) › Repairing books that list every file twice

# Repairing books that list every file twice

After a library moves to new storage — new paths and new inodes at once — AudiobookShelf can keep
the old record of each audio file beside the new one. The old record points at a file that no longer
exists, so it 404s; the book's length is the sum of both, so it plays against a timeline twice as
long. No rescan removes the old records, and "Remove items with issues" never sees them.

```bash
abs-butler repair                    # which books, and each length before → after
abs-butler configure --track-repair on
abs-butler repair --apply            # or: abs-butler apply <runId> --items <id> …
```

Excluding the dead copies in **Manage tracks** is not enough: it fixes the track list, but the
length is a stored number, and a rescan recomputes it by adding up every record — excluded ones
included. So a repair removes the dead records and then gives a rescan a reason to recompute:

- **A book with two or more files** — one live track is left out as well, and the rescan adds it
  back. API only, and the book is never without tracks.
- **A one-file book, with Allow file changes on** — one of its files has its modified time updated
  (nothing in it is changed), so the rescan sees a change.
- **A one-file book otherwise** — its track list is emptied and the rescan rebuilds it from the
  file. It has no tracks for the moment the rescan takes.
- **A single file at the library root** (a bare `Book.m4b` rather than a folder) — AudiobookShelf
  refuses to rescan one of these on its own, so its dead records are removed, its file is touched,
  and the whole library is scanned: a library scan rescans an item whose file changed. Every such
  book in a run shares one scan, and the run waits for it to finish. This needs **Allow file
  changes** and the library mounted where abs-butler can reach it.
- **A single file at the library root that abs-butler cannot reach** — repaired **partly**: the
  dead records are removed and the chapters trimmed, over the API alone, so nothing plays a file
  that is gone. The stored length stays doubled until AudiobookShelf rescans the file, and the
  report says what would let abs-butler do that. The run keeps its plan: once the file is in reach,
  applying the same run again finishes it, and so does a fresh `repair`, which recognises a length
  the tracks do not add up to even with no dead records left.

Chapters that still run past the new end are trimmed. Every repair is checked afterwards — no dead
records left, every live track back, and the length the tracks add up to — and one that did not take
is reported as such.

Only books where every dead record has a live copy on disk with the same name and size or length are
repaired; anything else is reported and left alone. Two real copies of a book (an m4b beside an mp3
set) are both on disk and are never touched.

Listening positions saved while a book was doubled are **counted, not changed** — dead and live
copies are interleaved track by track, so no simple rescaling puts a listener back where they were.

`revert` puts the track and chapter lists back as they were. It cannot put the doubled length back,
since nothing but a rescan sets that, and the next rescan would double it again.
