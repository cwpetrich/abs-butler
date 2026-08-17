# Running abs-butler in Docker

abs-butler runs as a long-lived web service, with the same CLI available for one-off work against the
same database.

## Quick start

```bash
cp .env.example .env      # set BUTLER_PASSWORD and BUTLER_SECRET
docker compose up -d butler
docker compose logs -f butler
```

The UI is on <http://localhost:8478>. Add servers there — nothing about them belongs in `.env`.

Set both secrets before first launch:

```bash
# .env
BUTLER_PASSWORD=something-long
BUTLER_SECRET=$(openssl rand -base64 32)
```

Without `BUTLER_PASSWORD` the UI is unauthenticated and anyone who reaches the port can manage your
servers. Without `BUTLER_SECRET` the AudiobookShelf API keys are stored in plaintext. Both conditions
are logged loudly at startup and shown as banners in the UI — abs-butler will run, but it will not
pretend the setup is safe.

## The CLI against the same database

```bash
docker compose run --rm cli server list
docker compose run --rm cli audit --details
docker compose run --rm cli rate --max-age 12
```

The `cli` service shares the `butler-data` volume, so it sees the same servers, settings, and
history. Anything after the service name is passed straight through.

Without compose:

```bash
docker build -t abs-butler .
docker run -d --name abs-butler -p 8478:8478 \
  -e BUTLER_PASSWORD=... -e BUTLER_SECRET=... \
  -v abs-butler-data:/data abs-butler
```

## Persistence

The SQLite database lives at `/data/abs-butler.db`, backed by the `butler-data` named volume. **It
holds your servers, API keys, run history, and settings — losing it means re-adding everything.**

To back it up:

```bash
docker compose stop butler
docker run --rm -v abs-butler_butler-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/abs-butler-backup.tar.gz -C /data .
docker compose start butler
```

Stopping first matters: SQLite in WAL mode has a sidecar file, and copying a live database can
capture a torn state.

## Reaching your AudiobookShelf servers

`localhost` inside the container means *the container*, so `http://localhost:13378` will not work as
a server URL. Pick whichever matches your setup:

| Where AudiobookShelf runs | Server URL to enter in the UI |
| --- | --- |
| Directly on this host | `http://host.docker.internal:13378` (the compose file already adds the `host-gateway` mapping) |
| On this host, simplest fallback | `http://192.168.x.x:13378` — your machine's LAN IP |
| In Docker, same compose project | `http://audiobookshelf:80` — the service name |
| On another machine entirely | Its LAN address. This is fully supported — only `organize` needs local files. |
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

Only `organize` touches the filesystem. `audit`, `rate`, and `metadata` work purely over the API and
need no mount at all — a server on another machine is fully manageable for those.

There are up to three different names for the same directory, which is where this usually goes wrong:

| Setting | Whose view | Example |
| --- | --- | --- |
| `HOST_LIBRARY_PATH` | This machine | `/mnt/media/audiobooks` |
| Library root (in the UI) | Inside the butler container | always `/library` — compose sets this |
| Path prefix (in the UI) | Inside the **AudiobookShelf** container | `/audiobooks` |

The path prefix is what AudiobookShelf itself reports for the library. The Servers page shows it: hit
**Test** and the table lists each folder's path on the server, the path it maps to here, and whether
that path is reachable and writable. If AudiobookShelf is not containerized, its paths already match
the host and you can leave the prefix blank.

The library is mounted **read-only by default**. To actually move files:

```bash
# .env
LIBRARY_MOUNT_MODE=rw
```

Then restart, run `organize` as a dry run, read the plan, and only then apply it. Set the mode back
to `ro` afterwards.

## File ownership

Files created by `organize` are owned by whoever the container runs as. Set `PUID`/`PGID` in `.env`
to the user that owns your library, or you will end up with folders you cannot write to:

```bash
id -u    # -> PUID
id -g    # -> PGID
```

The image runs as a non-root user (uid 1000) by default and never needs root.

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
  image**. Secrets are supplied at run time.
