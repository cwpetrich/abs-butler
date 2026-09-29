[abs-butler](../README.md) › Auditing

# Auditing

Issue codes: `missing-on-disk`, `invalid`, `no-audio`, `missing-title`, `missing-author`,
`missing-cover`, `unmatched`, `missing-description`, `missing-year`, `missing-narrator`, `unrated`,
`box-set-sequence`, `duplicate`.

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

**Box sets are numbered by the books they hold.** A box set of books 1–3 belongs in its series with
the sequence `1-3`, not `1`. AudiobookShelf keeps the sequence as text, so a range saves as written,
and a tool counting what a series is missing can then read the set as books 1, 2 and 3 rather than
reporting 2 and 3 as gaps. A fractional end counts too: an omnibus `1-3.5` holds the novella after
book 3. `box-set-sequence` flags an item in a series whose title or subtitle says it is a set — "Box
Set", "Boxed Set", "Omnibus", "Books 1-3" — but whose sequence names one book or none.

**A first audit flags everything, and that is not a fault.** `unrated` is true of every book until
`rate` has run once, so a fresh library reports 100% affected. Read the breakdown, not the total.

Every audited item is kept with the run, passes included — see [What a run says it
did](runs.md#what-a-run-says-it-did):

```
abs-butler audit --details                 # every item, worst first, clean ones trailing
abs-butler audit --details --only-issues   # just the problems
```

The one count worth reading first is **`unmatched`**. Those books carry no ISBN and no ASIN, so no
provider can rewrite them — if that number is high, `metadata` is doing real work before
`normalize` can.
