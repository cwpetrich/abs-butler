[abs-butler](../README.md) › Installing

# Installing

Three ways to install it. All three run the same code against the same database format and are
configured the same way — from the web UI.

**Snap** — a supervised system service, on any distribution with snapd:

```bash
sudo snap install abs-butler
sudo snap connect abs-butler:removable-media    # only if you want to organize files
```

**Docker, with the installer** — recommended when abs-butler runs on the same machine as
AudiobookShelf. It settles the one thing the UI cannot: which library gets mounted in, since a
mount is fixed when the container is created. From a new folder — on Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.ps1 | iex
```

On macOS and Linux, the same installer, which is what that one-liner runs:

```bash
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer
```

The same command with `repair` on the end checks an existing install and fixes what it finds —
including one made by hand. On Linux and macOS the installer also runs as a plain script
(`curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.sh && sh install.sh`).
See [Quick start](docker.md#quick-start) for what it does and why it is given the Docker socket.

It looks for AudiobookShelf running on the same machine and, from the container, reads three things
at once: the URL, the host directory holding the library, and the path AudiobookShelf itself reports
— which is the path prefix, otherwise the easiest setting to get wrong. It will not guess between
several servers. Give it an admin username and it connects on the spot, so one command goes from
nothing to connected; decline and it just fills in the form for you.

It derives file ownership from the library directory and prints what to do next. `--library` skips
the search, `--no-discover` turns it off, and `--dry-run` shows every file it would write without
touching anything.

The UI is published on every interface, the same as AudiobookShelf itself — most of these servers
are headless, and a loopback default would leave nothing able to open it. Two things make that
safe rather than merely convenient:

- **Setup needs a code**, generated during install, printed at the end, and stored as
  `BUTLER_SETUP_CODE`. Until a password exists the setup page has to answer an anonymous visitor,
  so without this the first person on the network to load it would take the account. With the code
  set it is required whether or not the 15-minute window is open — the race closes and the clock
  stops mattering.
- **Failed logins are throttled** per client address, backing off to a 15-minute wait. A weak
  password stops being brute-forceable at network speed.

`--local` publishes on `127.0.0.1` instead, if you would rather reach it over SSH or Tailscale.

Updating later is the same script:

```bash
cd /opt/abs-butler && docker compose pull && docker compose up -d
```

The image tag is `:latest`, so that is the whole update — the same thing AudiobookShelf asks of you.
To have it done nightly instead, `install.sh --auto-update` schedules exactly that on the host —
off unless you turn it on; see [Automatically](docker.md#automatically).
`install.sh --update` exists for the rarer case where the scaffolding around the container changed
rather than abs-butler itself, and a release that needs it says so. See
[Updating](docker.md#updating). Read it before you run it — it is one file, and it
is meant to be read.

**Docker, by hand** — the compose file pulls a published multi-arch image:

```bash
curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/docker-compose.yml
docker compose up -d butler
```

**From source**, if you would rather not use either:

```bash
npm install && npm run build
node dist/index.js serve
```

Then open <http://localhost:13380>, pick a password, and add your server's URL along with either an
API token (AudiobookShelf → Settings → Users → your user → API Token) or an admin username and
password. The token is the better choice — it can be revoked in AudiobookShelf without changing the
account's password — but signing in saves the trip through the settings, and comes out the same
either way: abs-butler exchanges the credentials for that same token and stores only the token.

That's the whole setup. There is nothing to configure before first launch: abs-butler generates its
own encryption key and keeps everything else in its database.

## Which to pick

| | Supervised | Data lives in | Reaching your library |
| --- | --- | --- | --- |
| **Snap** | yes, via systemd | `/var/snap/abs-butler/common` | `/mnt`, `/media`, `/run/media` only — [why](snap.md#reaching-your-library) |
| **Docker** | yes, restart policy | the `butler-data` volume | any path you bind-mount, with `PUID`/`PGID` set |
| **Source** | no — bring your own unit | `~/.local/share/abs-butler` | ordinary file permissions; the only one with no extra step |

Snap is the least work on Ubuntu and most distributions. Docker is the least surprising if
AudiobookShelf already runs in a container. From source is the most flexible and the only one where
`organize` writes as your own user with nothing to configure — at the cost of supervising it
yourself.

## About that first-run password

Setting a password has to be reachable by someone who has not logged in yet — there is nothing to
log in against. So it is bounded rather than left open: **setup accepts a password for 15 minutes
after startup**, and the first browser to open the page claims it, so nobody can submit one behind
your back once you are there.

If the window closes before you get to it, restart abs-butler (`docker compose restart butler`) and
it reopens. A setup code is also printed at startup if you would rather not restart.

On a home network that is the right trade. If you expose this port beyond your own network, set
`BUTLER_SETUP_CODE` and the code is required as well.
