[abs-butler](../README.md) › Age ratings and content flags

# Age ratings and content flags

AudiobookShelf has no rating field, so results are written as **tags**, which its filter UI already
supports:

- `age:early-reader`, `age:middle-grade`, `age:young-adult`, `age:adult`
- `content:violence`, `content:sexual-content`, `content:profanity`, `content:substance-use`,
  `content:horror`, `content:romance`, `content:self-harm`, `content:religion`
- `abs-butler:rated` — a marker so re-runs can skip already-rated books

Tags outside those namespaces are never touched, so your own tags survive a re-run.

**Read [Content ratings](content-ratings.md) before trusting this for parental
controls.** The short version: this infers audience from how librarians and publishers *shelve* a
book. It is reliable for "this is shelved as juvenile fiction" and blind to "chapter 14 is graphic".
Low confidence is how the tool asks a human to look.
