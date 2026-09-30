[abs-butler](../README.md) › Filling and normalizing metadata

# Filling and normalizing metadata

## Filling in metadata

`metadata` fills fields that are **blank**: `description`, `publishedYear`, `publisher`, `isbn`,
`language`. Existing values are left alone unless you pass `--overwrite`. Nobody is surprised by a
description appearing where there was none, so the bar for writing one is low — a candidate has to
match the book, but it does not have to be provably the same edition.

Rewriting a value someone can already read is a different question, and lives in `normalize` below.

## Normalizing what's already there

`normalize` is the command for mismatches: the same series spelled two ways, an author stored as
"King, Stephen" on one book and "Stephen King" on the next, a title carrying "(Unabridged)" that
none of its siblings do. It covers `title`, `subtitle`, `author`, `narrator`, `series` and `genre`,
and `tag` when asked for.

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

## Sources vote, field by field

Within the provider tier, **every** source that identified the exact edition gets a say, and each
field is settled on its own. The most-agreed value wins; a tie goes to the most trusted source that
offered it, in the order listed under [Where the data comes from](providers.md).

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

## Who counts as an author

A wrong name on an author list is the most visible mistake metadata can make, so the rules for
changing one are stricter than for any other field:

- **No single source can add a person.** A provider list that puts somebody new on a book needs two
  independent catalogues to agree (Audnexus and Audible count as one). Google Books credits a print
  edition's illustrator as an author, which is how Brandon Dorman ended up beside Brandon Mull on
  *Fablehaven*; one source saying so is no longer enough. An empty author list can still be filled
  from one source.
- **A co-author the identified sources don't credit is removed.** It has to be left out by at least
  two catalogues, by more than credit them, and by at least one that describes the written work (Open
  Library or Google Books). That last condition protects real collaborations, since Audible often
  lists only the lead author. The first-credited author is never removed this way.
- **A series agrees on its author.** If at least three books and a strict majority of a series
  credit the same people, a book in it that credits those people *plus someone else* has the extra
  name proposed for removal. That doesn't happen if an identified source credits the extra person on
  that very book, so a genuine guest co-author stays. A book in the series by somebody else entirely
  is left alone.

```
-> author  "Dakota Krout, Luke Daniels" => "Dakota Krout"
           [consensus: 12 of 14 books in The Completionist Chronicles credit Dakota Krout]
```

## Genres and tags a series shares

Genres come from whatever AudiobookShelf matched each book against on the day it matched it, so a
series often ends up with LitRPG on three books and not the other eleven. `normalize` treats a genre
carried by **at least two books and at least a quarter of a series** as the series' genre, and adds
it to the books that lack one. It also respells genres the way most of the library writes them
("Litrpg" → "LitRPG").

Adding a genre replaces nothing, so it goes through with **Allow metadata rewrite** off; respelling
one is a replacement and is held back like any other.

Tags work the same way but are off by default, because tags are also where people keep their own
lists ("Favorites", "Read with Sam"). Turn them on with `--series-tags`, or **Also copy tags a series
shares** in the web UI. abs-butler's own tags (age bands, content flags, work identity) are never
copied.

## Work identity, for clients reading several servers

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

**A box set is several works**, so it carries one tag per book inside it. `normalize` never writes
those: a lookup can only name one work, and for a set that is usually book 1, whose title it shares
— telling every other server the set *is* book 1. An item whose sequence is a range (`1-3`), or that
already carries more than one work tag, is left to the tags you give it by hand, and those are kept
through every other write.

The bar to write one is deliberately higher than for filling a blank field: a wrong
description is noise on one server, while a wrong identity is repeated to every
client that reads it. In practice the author has to have actually agreed, not merely
been absent.
