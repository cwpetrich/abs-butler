# abs-butler

A butler for your [AudiobookShelf](https://www.audiobookshelf.org/) library. Set it up once and it
keeps the library's **metadata** correct and consistent: it discovers what's missing and fills it
in, and it normalizes what's already there — titles, authors, narrators, series names — so the same
book is described the same way wherever it appears.

Around that it audits the library for problems, enforces a folder naming scheme on disk, and tags
books with age bands and content flags so a library can be filtered by what's appropriate for whom.

One butler, one server, running side by side. abs-butler is meant to live on the same machine as
AudiobookShelf and share its library mount, which is what lets it organize files as well as manage
them over the API. Everything except `organize` works purely over the API, so a butler on another
machine still does the whole metadata job — it just needs the library reachable to move files.
(`repair` works over the API too, and uses the library only when it can, for its gentlest route.)

Every operation is a **dry run by default**, and the three that change something you can see are
gated separately. `organize --apply` needs **Allow file changes**; `normalize --apply` needs **Allow
metadata rewrite**; `repair --apply` needs **Allow track repair**. None is on after a fresh install.

## Quick start

**Docker** — recommended when abs-butler runs on the same machine as AudiobookShelf. The installer
finds your server and library, connects, and prints what to do next. From a new folder:

```powershell
# Windows, in PowerShell
irm https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.ps1 | iex
```

```bash
# macOS and Linux
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer
```

**Snap** — a supervised system service, on any distribution with snapd:

```bash
sudo snap install abs-butler
sudo snap connect abs-butler:removable-media    # only if you want to organize files
```

Then open <http://localhost:13380>, pick a password, and connect to your AudiobookShelf server with
an API token or an admin username and password. There is nothing to configure before first launch.

Docker by hand, running from source, updating, and which install to pick: see
**[Installing](docs/install.md)**.

## What it does

| Command | What it does | Read more |
| --- | --- | --- |
| `audit` | Read-only report of what is wrong: missing covers, unmatched books, duplicates, misnumbered box sets | [Auditing](docs/audit.md) |
| `metadata` | Fills blank descriptions, years, publishers, ISBNs and languages | [Metadata](docs/metadata.md#filling-in-metadata) |
| `normalize` | Makes titles, authors, narrators, series and genres consistent across the library | [Metadata](docs/metadata.md#normalizing-whats-already-there) |
| `rate` | Tags books with age bands and content flags | [Age ratings](docs/age-ratings.md) |
| `organize` | Moves folders on disk to match a naming template | [Organizing files](docs/organize.md) |
| `repair` | Fixes books that list every file twice after a storage move | [Repair](docs/repair.md) |

Run them in that order; [Commands](docs/commands.md#what-to-run-in-what-order) says why. Every run
keeps a per-book report, can be applied later exactly as you read it, and can be undone — see
[Runs](docs/runs.md).

## Documentation

**Getting started**
- [Installing](docs/install.md) — every way to install, and which to pick
- [Docker](docs/docker.md) — the installer, networking, paths, NAS libraries, updating
- [Snap](docs/snap.md) — confinement, and reaching your library
- [Configuration](docs/configuration.md) — environment variables, and how credentials are stored
- [Upgrading from older versions](docs/upgrading.md)

**Using it**
- [The web UI](docs/web-ui.md) — runs, schedules, logs, settings
- [Commands](docs/commands.md) — the CLI, and the order to run things in
- [Runs](docs/runs.md) — reading a report, applying a dry run, undoing a run
- [Auditing](docs/audit.md) — issue codes, ebooks, box sets
- [Metadata](docs/metadata.md) — filling blanks, normalizing, author rules, work identity
- [Age ratings and content flags](docs/age-ratings.md)
- [Organizing files on disk](docs/organize.md)
- [Repairing doubled track lists](docs/repair.md)

**How it works**
- [Where the data comes from](docs/providers.md) — the metadata providers, and how they are trusted
- [Content ratings](docs/content-ratings.md) — how age bands are derived, and their limits

**Contributing**
- [Development](docs/development.md)
- [Releasing](docs/releasing.md)

## Support

abs-butler is free and always will be. If it saves you time on your library and you'd like to say
thanks, you can [buy me a coffee on Ko-fi](https://ko-fi.com/conradigan) — no account needed.
Bug reports and ideas in [Issues](https://github.com/cwpetrich/abs-butler/issues) help just as much.

## License

MIT
