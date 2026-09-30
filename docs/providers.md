[abs-butler](../README.md) › Where the data comes from

# Where the data comes from

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
