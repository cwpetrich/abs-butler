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
| **Audible** | No | Audible's category *ladders* — full paths like "Children's Audiobooks > Literature & Fiction > Chapter Books & Readers > Early Readers" — plus an `is_adult_product` flag. Publisher-assigned against one exact audio edition, and searchable by title, so it answers whether or not AudiobookShelf matched the book. |
| **AudioSilo Meta** | No | A curated, retailer-neutral genre vocabulary from an open CC0 database — "Young Adult", "Childrens", "Dystopian". Community-reviewed rather than crowd-tagged, so weighted above Open Library's shelving and below a category a publisher assigned to the recording itself. Descriptions are deliberately not read; see below. |
| **Audnexus** | No | The same Audible categories by way of a community proxy, flattened into a list and keyed on ASIN. Kept alongside as the sanctioned route to that data. |
| **Open Library** | No | Crowd-sourced `subject` lists. The richest audience signal available without scraping: carries library shelving like "Juvenile fiction" and "Young adult fiction" alongside content subjects like "Massacres" or "Drug abuse". |
| **Google Books** | Optional | Publisher-assigned BISAC categories ("Juvenile Fiction / Social Themes / Bullying") and an explicit `maturityRating` of `MATURE`/`NOT_MATURE`. |

**Set a Google Books API key** in Settings → Providers. Without a key, Google Books uses an anonymous per-IP quota that is
shared with everyone else on your address and is very often already exhausted — in testing from a
residential connection it returned HTTP 429 for every request. The tool warns at the start of every
run where the key is missing, and carries on with Open Library alone, so a run can silently be
working from one source. BISAC categories are the more reliable signal of the two, so losing them
measurably degrades results.

Once a provider has refused three lookups in a row it is dropped for the remainder of that run.
Without that, a keyless Google Books turns a library-wide `rate` into hours of retries and
backoffs that can never succeed — the run appears to hang, and there is nothing at the end of it.
A single 429 is not enough to trip it: a keyed account can clip a per-minute limit and recover
within the same run.

## Sources considered and not implemented

| Source | Status |
| --- | --- |
| **Common Sense Media** | The best age-rating data that exists, with per-category ratings for violence, sex, language, and consumerism. No public API and its terms forbid scraping. Would need a licensing conversation. |
| **Hardcover** | Has a public GraphQL API and modern shelving data. Requires an account token. The strongest candidate to add next. |
| **StoryGraph** | Has the content warnings this tool most wants, contributed per-book by readers. No public API today. |
| **Audible / Audnexus** | **Now implemented** — see the table above. Edition-accurate, the source of narrator and series data for `normalize`, and since the ladders arrived the strongest audience signal here for anything Audible sells. |
| **Amazon Product Advertising API** | Not viable, and no longer exists. PA-API 5.0 was retired in May 2026; its replacement, the Creators API, requires an active Associates account with ~10 qualifying sales in a trailing 30-day window and revokes credentials after a dry spell. A self-hosted metadata tool makes no sales, so the keys would be pulled within a month. It also carried no narrator data and restricted how long fetched data could be retained, which is incompatible with the lookup cache. |
| **AudiMeta** (audimeta.de) | Was the obvious extended-Audible provider and is **archived** — the maintainer shut the service down in March 2026. Still widely recommended in AudiobookShelf docs and forums; do not build on it. |
| **AudioSilo Meta** (meta.audiosilo.app) | **Now implemented** — see the table above. |
| **Apple Books** (iTunes Search API) | **Implemented.** Free, keyless, and the only source here covering ebooks as well as audiobooks. Its categories are the only ones that distinguish a picture book from a chapter book — "Basic Concepts for Kids", "Learning to Read", "Counting & Numbers" — which is the boundary every other source gets wrong. Two corrections were needed first, both recorded in `providers/applebooks.ts`: Apple double-files middle-grade books under "Young Adult", so its young-adult labels are discounted to 0.35; and its storefront sections ("Kids", "Young Adult") duplicate its specific labels, so they are dropped before scoring. Without those, adding Apple scored 3/8 against Open Library's 4/8. With them, Apple and Open Library together score 8/11 where Open Library alone scores 7. |

Adding one means implementing `MetadataProvider` in `src/providers/` and registering it in
`src/providers/index.ts`. Anything that emits `ContentSignal`s feeds the existing scoring with no
other changes.

### A note on hierarchical categories

A source that returns category *paths* rather than a flat list needs care. Audible nests specific
under general in ways that invert what a reader would infer: *The Very Hungry Caterpillar* is filed
under "Early Readers", whose parent is "Chapter Books & Readers" — and a chapter book is middle
grade. Weighted equally, the parent and the kids shelf outvoted the leaf and banded a picture book
as middle grade.

So the node a book was actually filed under is weighted 0.9 and every node above it 0.55. The
ancestors are context; the leaf is the claim.

The same hazard reappears **across** providers, where the guard does not reach: band scores sum
over sources, so three of them each contributing a vague "kids book" term outvote one naming a band
outright. That is what happened to *The Very Hungry Caterpillar* the day a third kids-shelf source
was added. The fix is in the rule rather than the provider — a term spanning ages 0-12 is scored at
0.3 however many sources repeat it, well under the 1.0 of "Early Readers". A book that only a kids
shelf knows about therefore lands below the confidence floor and goes untagged, which is the honest
answer for evidence that broad.

### Why AudioSilo descriptions are not read

The community-written descriptions there are CC BY-SA 4.0. Writing one into a library would put
that person's metadata under a share-alike licence they never chose, and the `/abs/search` endpoint
appends a plain-text attribution line to the text for exactly that reason. They also exist for 471
of 277,628 works. Publisher blurbs come from the retailer sources instead, which is where they
belong.

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

Observed behavior against live Open Library and Audible data, no Google Books key:

| Book | Band | Confidence | Flags | Open Library alone |
| --- | --- | --- | --- | --- |
| The Very Hungry Caterpillar | early-reader | 0.60 | — | early-reader 0.45 |
| The Lightning Thief | middle-grade | 0.61 | horror | young-adult 0.45 |
| The Hate U Give | young-adult | 0.70 | violence | young-adult 0.45 |
| Blood Meridian | adult | 1.00 | violence | adult 0.70 |

*The Lightning Thief* is the clearest illustration of what the second source buys. It is usually
considered middle grade, but Open Library shelves it as both middle grade and YA and the tool
picked the wrong one at low confidence. Audible files that exact recording under its children's
shelf, and the two together land on middle grade — where it belongs.

Confidence rises across the board, but not merely because two sources agree: a rule scores at most
once per provider, and agreement lifts the runner-up as much as the winner. What actually improves
is *coverage* — Audible answers for editions Open Library has never heard of, and it answers about
the recording rather than the work.

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
