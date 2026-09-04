# Running abs-butler as a snap

The snap installs abs-butler as a system service, supervised by systemd, with the same CLI available
against the same database.

## Quick start

```bash
sudo snap install abs-butler
sudo snap connect abs-butler:removable-media    # only needed for organize
```

Open <http://localhost:13380>, set a password, and add your server's URL and API token. The service
starts automatically on install and on boot.

Built for **amd64 and arm64**, so a Raspberry Pi or an ARM NAS running AudiobookShelf can host the
butler beside it.

That second command is not optional if you want to organize files, and it has no equivalent
elsewhere — see [Reaching your library](#reaching-your-library).

### The setup window

Until a password exists there is nothing to authenticate against, so the setup screen has to be
reachable by an anonymous visitor. Rather than leave that open indefinitely it is bounded: setup
accepts a password for **15 minutes after startup**, and the first browser to open the page claims
it.

Miss the window and the page tells you to restart:

```bash
sudo snap restart abs-butler.butler
```

That reopens it for another 15 minutes. If you would rather not restart, a setup code is printed at
startup and works after the window has closed:

```bash
sudo snap logs abs-butler.butler | grep 'setup code'
```

For an instance reachable from outside your network, `sudo snap set abs-butler setup-code=…` makes a
code required always, window or not.

## Configuration

Almost everything — the connection, provider keys, retention, your password — is edited in the web
UI and stored in the database. Only the listen address and the setup code are snap configuration,
because they must be known before the UI can be reached at all:

```bash
sudo snap set abs-butler port=13380
sudo snap set abs-butler host=0.0.0.0
sudo snap set abs-butler setup-code=SOMECODE

sudo snap get abs-butler            # show what is set
sudo snap unset abs-butler setup-code
```

Each change validates the value and restarts the service. A bad port is rejected rather than
accepted and left to crash the daemon in a restart loop.

## Reaching your library

`audit`, `rate`, `metadata` and `normalize` work purely over the AudiobookShelf API and need no
file access at all. **Only `organize` touches the filesystem**, and that is where confinement
matters.

A strictly-confined snap cannot see arbitrary paths. The interface that grants media access,
`removable-media`, covers exactly three roots:

| Reachable | Not reachable |
| --- | --- |
| `/mnt/...` | `/srv/...` |
| `/media/...` | `/home/...` |
| `/run/media/...` | anywhere else |

It is not connected automatically, so this is always a manual step:

```bash
sudo snap connect abs-butler:removable-media
```

If your library lives outside those roots, no snap interface reaches it. Bind-mount it instead:

```bash
sudo mkdir -p /mnt/audiobooks
echo '/srv/audiobooks  /mnt/audiobooks  none  bind  0 0' | sudo tee -a /etc/fstab
sudo mount /mnt/audiobooks
```

Then set the library root to `/mnt/audiobooks` in the UI.

**Connection → Test** diagnoses this directly rather than making you guess. An unconnected interface
makes a directory fail to `stat`, which is indistinguishable from a missing one at the system call
level, so abs-butler names the likely cause instead of claiming your library does not exist:

> `/mnt/external1/Audiobooks` cannot be read by abs-butler. A strictly-confined snap sees no media
> until the interface granting it is connected, so this reports the same way as a missing directory
> even when the path is really there. Connect the interface and restart:
> `sudo snap connect abs-butler:removable-media`

### File ownership

Snap daemons run as root, and snapd offers no equivalent of Docker's `--user` to change that. So
`organize` runs as root — but new `Author/` and `Series/` folders inherit their ownership and
permissions from the directory they are created inside, not from the process. Your library stays
writable by the account that owns it.

Applying an `organize` plan is refused until **Allow file changes** is turned on under Settings, and
it starts off. Connecting the interface makes the files reachable; it does not make them writable by
abs-butler on its own.

## The CLI

```bash
sudo abs-butler status
sudo abs-butler audit --details
sudo abs-butler rate --max-age 12
```

`sudo` is required for anything that writes. The database lives in `/var/snap/abs-butler/common`,
which is root-owned because the daemon that writes it is — so reads succeed without `sudo` and only
writes fail, which means a command can appear to work right up until it doesn't:

```
$ abs-butler configure --file-changes on
✖ attempt to write a readonly database
✖ /var/snap/abs-butler/common belongs to root, because the abs-butler service that writes it
  runs as root. Reads work without it, which is why this got as far as it did — run the
  command with sudo.
```

Use `sudo` for all of it and the distinction never comes up.

## Service management

```bash
sudo snap start abs-butler.butler
sudo snap stop abs-butler.butler
sudo snap restart abs-butler.butler
snap services abs-butler
sudo snap logs -f abs-butler.butler
```

## Persistence and backup

`/var/snap/abs-butler/common` holds the SQLite database **and** the encryption key (`secret.key`).

`SNAP_COMMON` is used rather than `SNAP_DATA` on purpose: `SNAP_DATA` is revision-scoped and snapd
copies it on every refresh, and copying a live WAL database is how you capture a torn one.

**Losing this directory means re-adding everything**, and a copy of it is a copy of your
credentials — treat a backup accordingly.

```bash
sudo snap stop abs-butler.butler
sudo tar czf abs-butler-backup.tar.gz -C /var/snap/abs-butler/common .
sudo snap start abs-butler.butler
```

Stopping first matters: SQLite in WAL mode has a sidecar file.

If you want the database and its key separated — so a leaked backup is not a leaked token — back up
`abs-butler.db` on its own and keep `secret.key` somewhere else. Restoring one without the other
leaves the stored API token unreadable, and abs-butler says so plainly rather than failing
mysteriously; you would re-enter the token.

## Building from source

```bash
sudo snap install snapcraft --classic
sudo lxd init --auto
snapcraft pack --use-lxd
sudo snap install --dangerous ./abs-butler_*.snap
```

`--dangerous` is required for a locally built snap, which carries no store signature.

The build bundles Node from nodejs.org, pinned by checksum in `snap/snapcraft.yaml`, because Ubuntu
24.04 ships Node 18 and `node:sqlite` needs 22.5 or newer. Nothing in abs-butler compiles: the only
runtime dependencies are `commander`, `dotenv`, and `zod`, and SQLite is built into Node.
