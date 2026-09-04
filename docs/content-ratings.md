# Content ratings: sources, method, and limits

The goal of `abs-butler rate` is to make an AudiobookShelf library filterable by age
appropriateness. This document explains where the data comes from, how the age band is derived, and
— importantly — what this approach cannot tell you.

## Why not Goodreads

Goodreads is the obvious first thought and it is not available:

- Goodreads **retired its public API in December 2020**. No new developer keys have been issued
  since, and the remaining endpoints were shut down.
- Its terms of service prohibit scraping, and the site actively blocks it.
- Goodreads has no structured age-rating or content-warning field anyway. Age information there
  lives in user-created shelves ("ya", "middle-grade") and in free-text reviews — the shelf data is
  essentially the same signal Open Library exposes legitimately.

So this tool uses sources with real APIs and permissive terms.

## Sources in use

| Provider | Key needed | What it contributes |
| --- | --- | --- |
| **Audnexus** | No | Audible's own publisher-assigned categories, plus an `isAdult` flag. Only answers for books that carry an ASIN, but when it does the answer is about the exact audio edition rather than the work, so its categories are weighted above the other two. |
| **Open Library** | No | Crowd-sourced `subject` lists. The richest audience signal available without scraping: carries library shelving like "Juvenile fiction" and "Young adult fiction" alongside content subjects like "Massacres" or "Drug abuse". |
| **Google Books** | Optional | Publisher-assigned BISAC categories ("Juvenile Fiction / Social Themes / Bullying") and an explicit `maturityRating` of `MATURE`/`NOT_MATURE`. |

**Set a Google Books API key** in Settings → Providers. Without a key, Google Books uses an anonymous per-IP quota that is
shared with everyone else on your address and is very often already exhausted — in testing from a
residential connection it returned HTTP 429 for every request. The tool warns when the key is
missing and carries on with Open Library alone, so a run can silently be working from one source.
BISAC categories are the more reliable signal of the two, so losing them measurably degrades results.

## Sources considered and not implemented

| Source | Status |
| --- | --- |
| **Common Sense Media** | The best age-rating data that exists, with per-category ratings for violence, sex, language, and consumerism. No public API and its terms forbid scraping. Would need a licensing conversation. |
| **Hardcover** | Has a public GraphQL API and modern shelving data. Requires an account token. The strongest candidate to add next. |
| **StoryGraph** | Has the content warnings this tool most wants, contributed per-book by readers. No public API today. |
| **Audible / Audnexus** | **Now implemented** — see the table above. Its audience signal is thin next to Open Library's shelving, but its categories are edition-accurate, and it is the source of narrator and series data for `normalize`. |

Adding one means implementing `MetadataProvider` in `src/providers/` and registering it in
`src/providers/index.ts`. Anything that emits `ContentSignal`s feeds the existing scoring with no
other changes.

## How the band is derived

1. Each provider returns **signals** — one per subject, category, or maturity flag — each carrying a
   weight reflecting how much that source's own labeling should be trusted (BISAC categories 0.85,
   crowd subjects 0.7).
2. Signals are matched against a rule table (`src/content/ageRating.ts`). A rule can push toward an
   age band, raise content flags, or both.
3. **Each rule scores at most once per provider**, taking its strongest match. This matters: Open
   Library shelves *The Very Hungry Caterpillar* under "Children's fiction", "Juvenile fiction",
   "Juvenile", *and* "Children's stories, American" simultaneously. Summing every match let one
   restated idea outvote the single more precise signal ("Board books") and banded a picture book as
   middle-grade.
4. The winning band's confidence combines **volume** (how strong the evidence is, scaled against one
   full-strength rule) with **margin** (how clearly it beat the runner-up). Two adjacent bands
   scoring nearly the same yields low confidence by design.
5. AudiobookShelf's own `explicit` flag, when set, overrides everything to `adult`.
6. Tags are emitted only above `--min-confidence` (default 0.35). The `abs-butler:rated` marker is
   always written, so an item that got no usable signal is still distinguishable from one never
   checked.

Observed behavior against live Open Library data, no Google Books key:

| Book | Band | Confidence | Flags |
| --- | --- | --- | --- |
| The Very Hungry Caterpillar | early-reader | 0.45 | — |
| The Lightning Thief | young-adult | 0.45 | horror |
| The Hate U Give | young-adult | 0.45 | — |
| Blood Meridian | adult | 0.70 | violence |

*The Lightning Thief* is a fair illustration of the ceiling here: it is usually considered middle
grade, but it is genuinely shelved as both middle grade and YA, and the 0.45 confidence reflects
that ambiguity rather than papering over it.

## What this cannot do

Be clear-eyed about this before using it to decide what a child can see.

- **It rates shelving, not content.** It knows a book is catalogued as juvenile fiction. It has not
  read the book. A single graphic chapter in an otherwise gentle novel is invisible to it.
- **Content flags are coarse.** `content:violence` covers a cozy mystery's off-page murder and a war
  novel's battlefield alike. There is no intensity scale.
- **Coverage is uneven.** Children's and YA books are shelved by audience consistently; adult
  literary fiction often carries no audience subject at all, which is why *Blood Meridian* was
  `unknown` until a content rule caught "Massacres".
- **Absence of a flag means nothing.** A book with no `content:` tags was not cleared — it may just
  be poorly catalogued.
- **Crowd data carries crowd bias**, including in what gets flagged and what does not.

Treat the output as a **triage tool**: it sorts a large library into "obviously fine", "obviously
adult", and "worth a look". The last group is the one that needs a human, and low confidence scores
are how the tool asks for one.
