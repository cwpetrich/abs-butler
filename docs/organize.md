[abs-butler](../README.md) › Organizing files on disk

# Organizing files on disk

Default layout is `Author/Series/01 - Title`. Placeholders: `{author}`, `{title}`, `{series}`,
`{sequence}`, `{year}`. Empty segments collapse, so a standalone book renders `Author/Title` rather
than leaving an empty series folder. Sequence numbers are zero-padded so book 2 sorts before book 10,
and a box set's range is padded at both ends — `1-3` becomes `01-03` — so it sorts beside `04`.

**This is the one command that touches the filesystem.** `audit`, `rate`, and `metadata` work purely
over the API and need no mount at all.

### Single-file books

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

You rarely need to fill in either one. Leave both blank when connecting and abs-butler finds them by
looking for a few of your books from where it runs. **Connection → Test** (or `abs-butler status`)
does the same later, offers the right paths when the saved ones are wrong, and says what is mounted
when the books cannot be found at all. It never settles for a folder that merely exists: an empty
one is reported as empty. A library on a NAS under Docker Desktop has its own notes in
[Libraries on a NAS](docker.md#libraries-on-a-nas).

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
