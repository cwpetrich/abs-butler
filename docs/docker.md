# Running abs-butler in Docker

abs-butler runs as a long-lived web service, with the same CLI available for one-off work against the
same database.

## Quick start

Make a folder for abs-butler, open a terminal in it, and run one line.

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.ps1 | iex
```

**macOS and Linux**:

```bash
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer
```

Docker is the only thing the machine needs. `install.ps1` is a wrapper and nothing more: it checks
Docker is installed and answering, picks the folder, and runs exactly the command above — which it
prints, so nothing is hidden. Run it a second time in a folder that already holds an install and it
repairs rather than reinstalls. To read it before running it, or to pass a word of your own:

```powershell
irm https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.ps1 -OutFile abs-butler.ps1
.\abs-butler.ps1 repair
``` The installer runs once, writes its files into the folder, starts abs-butler, and
exits.

It finds AudiobookShelf first. A container running it answers three questions at once: its published
port gives the URL, its network lets abs-butler reach it by name, and its library mount gives the
library, including where AudiobookShelf sees it. That last one is the path prefix, the setting
people most often get wrong. Several servers means it asks (`--abs-container NAME` answers up front);
it never picks one for you.

The folder you run it in has two names: the one you typed (`C:\abs-butler`) and the one Docker's own
daemon knows it by, which on Docker Desktop is a path inside its Linux VM. The installer works out
which is which by proof rather than by guessing — it writes a marker into the folder and mounts each
candidate until one shows the marker — because the two Docker Desktop backends name it differently
and a wrong guess would fail later as an empty mount. If none of them match, it says what it tried
and stops; `ABS_BUTLER_DAEMON_DIR` names the path yourself. A network path
(`\\server\share`) or a drive Docker Desktop does not share cannot be installed into.

**Why it gets the Docker socket, and why that is fine.** The socket is root on the host. The
installer holds it for as long as the command runs, because you ran it, and never again. abs-butler
itself — the web UI on your network — never gets it, and cannot change its own mounts. That is the
point of doing this with a separate, short-lived container.

### When something is wrong: repair

Run the same command with `repair` on the end, from the same folder — or on Windows,
`.\abs-butler.ps1 repair`, or simply the one-liner again, which repairs an install it finds:

```bash
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer repair
```

It does everything an update does, then checks the install from end to end and prints one line per
check:

```
Checks:
  ok   now mounting AudiobookShelf's library (volume audiobookshelf_synology_media)
  ok   Docker sees 2 entries in volume audiobookshelf_synology_media
  ok   abs-butler is up and answering
  ok   the container sees the library at /nas
  ok   on AudiobookShelf's network (audiobookshelf_default)
  ok   the connection's library root is now /nas
```

- It compares the library mounted into abs-butler with the one AudiobookShelf uses, and offers to
  switch when they differ.
- It asks Docker what a container actually sees there. An empty folder, an unmounted share, or a
  mapped drive Docker Desktop cannot see all fail here, by name.
- It confirms the running container sees books, and that it is on AudiobookShelf's network.
- It keeps what the install already has: its database, its port, and who can reach it. An install
  made by hand from `docker-compose.yml` is adopted as it is, including its database.

Each change is offered, not made; `-y` accepts them all. abs-butler shows the same command in its
sidebar when it can tell from inside that something is wrong — most often, a library folder with
nothing in it.

### Which setup is yours

| AudiobookShelf runs… | Its library is… | What the installer does |
| --- | --- | --- |
| In Docker, on this machine | A folder on this machine | Mounts the same folder |
| In Docker, on this machine | A Docker volume — how a NAS share usually reaches Docker Desktop on Windows or macOS | Mounts **the same volume**, at the same path AudiobookShelf sees it, so no path prefix is needed and no NAS credentials are copied |
| Directly on this machine (no container) | A folder | Asks for the folder (`--library PATH`) |
| On the NAS itself | — | Run abs-butler on the NAS too, where the library is a local folder |

A mapped drive (`S:\AudioBooks`) or a `\\server\share` path is never the answer on Windows. Those
belong to your login session, and Docker cannot see them. If AudiobookShelf reads the share, it
does so through a Docker volume, and the installer reuses that.

### Without the installer image

On Linux or macOS the same installer also runs as a script, which is what the image contains:

```bash
curl -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.sh
sh install.sh                 # or: sh install.sh --repair
```

Where the server is on a Docker network, the generated override joins it and addresses the server by
container name on its **internal** port. That is deliberate: `host.docker.internal` resolves to the
bridge gateway on Linux, so a server published on `127.0.0.1` — the sensible default — is
unreachable from another container that way. Joining the network works regardless of the binding.

It derives `PUID`/`PGID` from the library, so files `organize` creates stay readable by
AudiobookShelf. On a volume or a network share that means the owner the mount reports, which is
what decides who may write. The database goes in `./data` next to the compose file, or in a Docker
volume on Windows, where SQLite over Docker Desktop's file sharing is slow. `--nfs HOST:/EXPORT`
mounts a NAS export directly for shares that are not already mounted on the host, and `--dry-run`
prints every file it would write. The rest of this page is what it automates.

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

abs-butler asks GitHub every few hours whether a newer version has been tagged, and says so in the
sidebar with a link to what changed. It does not update itself, which is the same choice
AudiobookShelf makes: replacing a running container means handing the application the Docker socket,
and that is root on the host. A web UI reachable from the network should not hold that. So the
notice tells you, and you decide when.

Turn the check off in Settings if you would rather it made no outbound request at all.


```bash
cd /opt/abs-butler
docker compose pull
docker compose up -d
```

That is the whole update, and it is what AudiobookShelf asks of you too: the image tag is
`:latest`, so pulling and recreating is a new version. `./data` is a bind mount and is not touched.

#### Automatically

The installer can schedule that update for you. It is off unless you ask — an interactive install
asks once, and the answer is kept in `.env` as `BUTLER_AUTO_UPDATE`:

```bash
sh install.sh --auto-update --dir /opt/abs-butler      # turn it on
sh install.sh --no-auto-update --dir /opt/abs-butler   # and off again
```

Run from the installer image, `--auto-update` writes `update.sh` and prints the one line to
schedule, rather than scheduling it: a container has no way to create a task on the host, and a job
somebody believes in but does not have is worse than none. The job it prints runs `update.sh`
through the installer image, so Windows can run it too:

```powershell
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer repair --auto-update
schtasks /create /tn abs-butler-update /sc daily /st 04:00 /tr "docker run --rm --pull always -v /var/run/docker.sock:/var/run/docker.sock -v \"C:\abs-butler:/install\" ghcr.io/cwpetrich/abs-butler-installer auto-update"
```

This keeps the rule above: the job runs on the host, as whoever ran `install.sh`, and abs-butler
itself still never touches the Docker socket. It writes `update.sh` beside `.env` and runs it
nightly — from a systemd timer between 04:00 and 05:00 when installed as root
(`journalctl -u abs-butler-update`), otherwise from a crontab line or scheduled task (logged to
`update.log`). Each night it:

- pulls `BUTLER_IMAGE`, and stops there if the running container already has it;
- leaves a container you stopped stopped;
- waits until the next night if a run is queued or in progress, rather than cutting it off;
- recreates the container, and if the new one does not become healthy within two minutes, puts the
  previous image back and restarts on that.

It only ever pulls the image — never `install.sh` or `docker-compose.yml`, which are fetched from
`main` rather than from a release. A release that needs `--update` still says so in the sidebar.

To take only patch releases, pin the minor version in `.env`, e.g.
`BUTLER_IMAGE=ghcr.io/cwpetrich/abs-butler:0.13`. Run `./update.sh` by hand to update right away.
On macOS, cron may need Full Disk Access to reach an install under your home folder.

#### What install.sh is for

`install.sh` is not involved, because a new version of abs-butler does not need it. It is needed
only when the scaffolding around the container changes — a new key in `.env`, or a fix to
`docker-compose.yml` — and a release that needs it says so:

```bash
sh install.sh --update --dir /opt/abs-butler
```

`--update` updates `install.sh` itself before doing anything else, then re-runs with the new copy,
so the rest of the update is performed by the current script rather than by whatever was on disk.
The replaced copy is kept as `install.sh.bak`.

The downloaded script is validated before it replaces anything — a truncated file, or the HTML a
captive portal returns, downloads perfectly well, and replacing a working script with one of those
is worse than staying out of date.

A copy older than this behaviour cannot bootstrap itself. Fetch it once:

```bash
curl -fsSL -O https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.sh
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

`organize` moves files, and `repair` touches the one file of a book that is a single file at the
library root, since that is the only way to make AudiobookShelf recompute its length. Everything
else — `audit`, `rate`, `metadata`, `normalize` — works purely over the API and needs no mount at
all. The installer sets all of this up; this section is what it does, for doing it by hand.

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

You rarely have to work either one out. Leave both blank when connecting and abs-butler fills them
in by **finding your books**: it takes a few books AudiobookShelf reports, say
`/nas/AudioBooks/Jane Austen/Emma`, and looks for `Jane Austen/Emma` under everything mounted into
its container. Where it turns up gives both paths. Because it looks for the books themselves, an
empty folder never passes, even though it exists and is writable.

**Connection → Test** runs the same search on an existing connection. If the paths are wrong it
offers the right ones with a **Use these paths** button. It also lists each folder's path on the
server, the path it maps to here, and whether that path is reachable and writable.
`abs-butler status` reports the same from the CLI.

If none of the books can be found, no setting will fix it, because the library is not mounted into
abs-butler at all. Test then shows what *is* mounted. The usual causes:

- **`HOST_LIBRARY_PATH` is not set.** Compose then mounts an empty `audiobooks` folder beside
  `docker-compose.yml`, and abs-butler says so.
- **It points at a different folder than AudiobookShelf's**, or at a different level of the same
  share. Copy the left-hand side of AudiobookShelf's own volume line (`docker inspect
  <container> --format "{{json .Mounts}}"` prints it).
- **It is a Windows mapped drive or `\\server\share` path.** See below.

### Libraries on a NAS

If the share is already mounted on the machine running Docker (an fstab entry on Linux, say), it is
just a path: set `HOST_LIBRARY_PATH` to it.

**Docker Desktop on Windows or macOS cannot bind-mount a mapped network drive** (`Z:\AudioBooks`) or
a `\\server\share` path. Those belong to your login session, and Docker's VM never sees them. Have
Docker mount the share itself instead, in a `docker-compose.override.yml` beside the compose file:

```yaml
services:
  butler:
    volumes: !override
      - butler-data:/data
      - nas-audiobooks:/audiobooks
  cli:
    volumes: !override
      - butler-data:/data
      - nas-audiobooks:/audiobooks
volumes:
  nas-audiobooks:
    driver: local
    driver_opts:
      type: cifs
      device: "//192.168.1.50/AudioBooks"
      o: "username=USER,password=PASS,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,vers=3.0"
```

- **Use the NAS's IP address.** Its hostname often does not resolve from inside Docker's VM.
- **Ownership on an SMB share comes from `uid`/`gid` and the modes in `o:`**, not from the files, so
  `PUID`/`PGID` do not change what abs-butler may write. Match `uid`/`gid` to `PUID`/`PGID` (1000
  by default).
- **An NFS export** works the same way: `type: nfs`, `o: addr=192.168.1.50,rw,nfsvers=4`,
  `device: ":/volume1/AudioBooks"`. `install.sh --nfs` writes this for you on Linux.

Then run `docker compose up -d` and press **Test**.

If AudiobookShelf itself runs on the NAS, the simpler setup is to run abs-butler there too. The
library is then a local path, and `install.sh` finds everything.

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
