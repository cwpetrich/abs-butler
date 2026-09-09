# Running abs-butler in Docker

abs-butler runs as a long-lived web service, with the same CLI available for one-off work against the
same database.

## Quick start

`install.sh` is the shortest path when abs-butler runs beside AudiobookShelf:

```bash
curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.sh
sh install.sh --library /srv/audiobooks
```

It finds AudiobookShelf first. A container running it answers three questions at once — the
published port gives the URL, and the library bind mount gives both the host path to mount and the
path AudiobookShelf reports for it, which is the path prefix. `/status` confirms the candidate is
really AudiobookShelf rather than whatever else holds the port, and a host install with no container
is found the same way. Several servers means it asks; it never picks one for you.

Where the server is on a Docker network, the generated override joins it and addresses the server by
container name on its **internal** port. That is deliberate: `host.docker.internal` resolves to the
bridge gateway on Linux, so a server published on `127.0.0.1` — the sensible default — is
unreachable from another container that way. Joining the network works regardless of the binding.

It also asks for the library directory if none was found or passed, derives `PUID`/`PGID` from that
directory so files `organize` creates stay readable by AudiobookShelf, publishes the UI on
loopback, and writes an override putting the database in `./data` next to the compose file.
`--nfs HOST:/EXPORT` mounts a NAS export directly for shares that are not already mounted on the
host, and `--dry-run` prints every file it would write. The rest of this page is what it automates.

### By hand

The compose file pulls a published image built for amd64 and arm64, so there is nothing to clone
and nothing to compile:

```bash
curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/docker-compose.yml
docker compose up -d butler
docker compose logs -f butler
```

To run your own working tree instead of the published image, add the build override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build butler
```

It is a separate file on purpose. With `build:` in the main compose file, a plain `up` quietly
compiles from source whenever the image is missing locally — a long and surprising first run for
someone who only wanted to start the thing.

Open <http://localhost:13380>, set a password, and add your server's URL and API token. Nothing needs
to be configured before that first launch — no password file, no secret to generate. `.env` is
optional and mostly exists to tell abs-butler where your audiobooks are.

### Reaching it from another machine

Nothing to do: the UI is published on every interface, the same as AudiobookShelf. A loopback
default would be wrong for the machine this runs on — a headless server has no browser — and being
stricter than the server being managed buys little, since anyone who can reach abs-butler can
already reach AudiobookShelf, which can delete the library outright.

Two things carry that default:

- `install.sh` generates a `BUTLER_SETUP_CODE`. Until a password exists the setup page must answer
  an anonymous visitor, so on a network the first person to load it would otherwise take the
  account. With the code set it is required whether or not the 15-minute window is open — the race
  closes and the limit stops applying together.
- Failed logins and failed setup codes are throttled per client address: five free attempts, then a
  doubling wait to a 15-minute cap. scrypt already makes each guess expensive; this makes a run of
  them pointless.

`--local` publishes on `127.0.0.1` instead, for reaching it over SSH
(`ssh -L 13380:127.0.0.1:13380 you@server`) or Tailscale
(`tailscale serve --bg --https=13380 http://127.0.0.1:13380`), neither of which needs an open port.

### Updating

```bash
sh install.sh --update --dir /opt/abs-butler
```

That refreshes `docker-compose.yml`, pulls the current image, restarts, and changes no settings of
its own. The compose file is treated as generated rather than as configuration — what belongs to an
install lives in `.env` and the override beside it — so a fix made to it reaches existing installs
instead of only new ones. The previous copy is kept as `docker-compose.yml.bak`.

`.env` records the generation of the files that produced it as `BUTLER_INSTALL_VERSION`. When a
later `install.sh` finds an older stamp it prints what changed since, and the flag that adopts each
one:

```
This install came from an older install.sh (generation 1; this is 2).
None of the following is applied on its own — each is a decision left to you.
  Since generation 1:
    - The UI is now published on every interface by default …
      --bind 0.0.0.0 adopts the new default, --local keeps loopback.
```

Nothing there applies itself. A change that would alter how an install is reached is a decision, not
a side effect of updating, so `--update` never makes one.

### Re-running it

`install.sh` is safe to run again on an existing install, and it is the way to pick up a newer
compose file. Anything already in `.env` is kept — the binding, the port, the ownership, the setup
code — so a second run does not quietly revert what the first one set. Flags still win, so a
setting is changed by naming it:

```bash
sh install.sh --bind 127.0.0.1     # stop publishing to the network
sh install.sh --remote             # and put it back
```

The database lives in `./data` and is untouched by any of this.

### The setup window

Until a password exists, abs-butler has nothing to authenticate against, so the setup screen has to
be reachable by an anonymous visitor. Rather than leaving that open indefinitely it is bounded:
setup accepts a password for **15 minutes after startup**, and the first browser to open the page
claims it.

Miss the window and the page tells you to restart:

```bash
docker compose restart butler
```

That reopens it for another 15 minutes. If you would rather not restart, the startup log carries a
setup code that works after the window has closed:

```bash
docker compose logs butler | grep 'setup code'
```

For an instance reachable from outside your network, set `BUTLER_SETUP_CODE` in `.env` and the code
is required always, window or not.

## The CLI against the same database

```bash
docker compose run --rm cli status
docker compose run --rm cli audit --details
docker compose run --rm cli rate --max-age 12
```

The `cli` service shares the `butler-data` volume, so it sees the same connection, settings, and
history. Anything after the service name is passed straight through.

Without compose:

```bash
docker build -t abs-butler .
docker run -d --name abs-butler -p 13380:13380 -v abs-butler-data:/data abs-butler
```

## Persistence

`/data` holds the SQLite database **and** the encryption key (`secret.key`), backed by the
`butler-data` named volume. **Losing it means re-adding everything**, and a copy of it is a copy of
your credentials — treat a backup accordingly.

```bash
docker compose stop butler
docker run --rm -v abs-butler_butler-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/abs-butler-backup.tar.gz -C /data .
docker compose start butler
```

Stopping first matters: SQLite in WAL mode has a sidecar file, and copying a live database can
capture a torn state.

If you want the database and its key separated — so a leaked backup is not a leaked token — back up
`abs-butler.db` on its own and keep `secret.key` somewhere else. Restoring one without the other
leaves the stored token unreadable, and abs-butler will say so plainly rather than failing
mysteriously; you would re-enter the API token.

## Reaching AudiobookShelf

`localhost` inside the container means *the container*, so `http://localhost:13378` will not work as
a server URL. Pick whichever matches your setup:

| Where AudiobookShelf runs | Server URL to enter in the UI |
| --- | --- |
| In Docker, same compose project | `http://audiobookshelf:80` — the service name |
| Directly on this host | `http://host.docker.internal:13378` (the compose file already adds the `host-gateway` mapping) |
| On this host, simplest fallback | `http://192.168.x.x:13378` — your machine's LAN IP |
| In Docker, a different project | Join its network, then use the service name (below) |

To reach a container in another compose project:

```yaml
# docker-compose.override.yml
services:
  butler:
    networks: [audiobookshelf_default]
networks:
  audiobookshelf_default:
    external: true
```

## Paths, for `organize`

Only `organize` touches the filesystem. `audit`, `rate`, `metadata` and `normalize` work purely over the API and
need no mount at all.

Point `HOST_LIBRARY_PATH` at the same directory AudiobookShelf uses:

```bash
# .env
HOST_LIBRARY_PATH=/mnt/external1/Audiobooks
```

Compose mounts that at `/audiobooks` inside the butler container, so **enter `/audiobooks` as the
library root in the UI**.

There are up to three names for the same directory, which is where this usually goes wrong:

| Name | Whose view | Example |
| --- | --- | --- |
| `HOST_LIBRARY_PATH` | This machine | `/mnt/external1/Audiobooks` |
| Library root (in the UI) | Inside the butler container | `/audiobooks` — compose mounts it there |
| Path prefix (in the UI) | Inside the **AudiobookShelf** container | whatever ABS maps it to |

The path prefix is what AudiobookShelf itself reports for the library, and it is only needed when
that differs from the library root. If ABS maps the same directory to `/audiobooks` too, the two
agree and you can leave the prefix blank. If it maps it to `/library`, set the prefix to `/library`.

**Connection → Test** settles it: the table lists each folder's path on the server, the path it maps
to here, and whether that path is reachable and writable.

The library is mounted read-write, but that on its own does not let abs-butler move anything.
**Applying an `organize` plan is refused until "Allow file changes" is turned on** under Settings →
File changes, and it starts off.

This used to be a `LIBRARY_MOUNT_MODE` flag here instead. The mount flag was strictly stronger — the
kernel enforced it, so it held even against a bug in abs-butler — but changing it meant editing
`.env` and recreating the container, which in practice means people set it to `rw` once and leave it
there forever. A guard you have to dismantle to use is not a guard. The UI switch costs one click,
so it is realistic to actually turn back off, and it works identically under Docker, snap, and a
native install.

Run `organize` as a dry run, read the plan, then enable the switch and apply.

## File ownership

Set `PUID`/`PGID` in `.env` to the user that owns your library:

```bash
id -u    # -> PUID
id -g    # -> PGID
```

The image runs as a non-root user (uid 1000) by default and never needs root. If these do not match
your library's owner, the container cannot write to it — and often cannot even read it, which looks
identical to a missing directory.

You should not have to work the numbers out by hand. **Connection → Test** reports the uid and gid
abs-butler is running as alongside the owner and mode of the library root, and names the values to
set:

> `/audiobooks` is not writable by abs-butler (running as uid 1000, gid 1000; the directory is owned
> by uid 1000, gid 1003, mode 0750). Set `PUID=1000` and `PGID=1003` in `.env` and recreate the
> container. If that is already the case, the mount itself is read-only.

New `Author/` and `Series/` folders created by `organize` inherit their ownership and permissions
from the directory they are created inside, rather than from whoever abs-butler runs as. A library
whose folders slowly become unwritable by its real owner is a worse outcome than one that was never
organized, because nothing announces it.

## Scheduling

Recurring jobs are configured on the **Schedules** page and run inside the `serve` process, so they
survive restarts and are visible in the run history alongside everything else. That is the intended
path.

`BUTLER_SCHEDULE` still exists for wrapping a *CLI* invocation in a sleep loop, which is occasionally
useful for one-off setups. It is ignored for `serve`, which schedules jobs itself.

For a cron-style approach instead, use host cron against the `cli` service:

```cron
0 4 * * * cd /path/to/abs-butler && docker compose run --rm cli audit --json > reports/audit.json
```

## Image notes

- Multi-stage build: the TypeScript server and the React UI compile with full dependencies, then only
  `dist/` and production dependencies land in the runtime stage. ~245 MB on `node:24-alpine`.
- SQLite comes from Node's built-in `node:sqlite`, so there is no native module to compile and no
  build toolchain in the image.
- `tini` is PID 1, so `SIGTERM` is forwarded and `serve` shuts down cleanly instead of truncating a
  run's log mid-write. A `docker compose restart` takes about a second.
- A `HEALTHCHECK` polls `/api/health`, so an unhealthy container is visible in `docker ps`.
- `.dockerignore` excludes `.env`, `config.json`, and `.git`, so **no credentials are baked into the
  image**. The encryption key is generated at run time, inside the volume.
