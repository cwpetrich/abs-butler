# Running abs-butler in Docker

abs-butler is a CLI, not a server, so "spinning it up" means one of two things:

- **One-shot** — run a command, print the result, exit. This is the normal way to use it.
- **Scheduled** — a long-running container that re-runs a command on an interval.

Both use the same image.

## Quick start

```bash
cp .env.example .env      # fill in ABS_URL, ABS_TOKEN, HOST_LIBRARY_PATH
docker compose build

docker compose run --rm butler libraries          # connectivity check
docker compose run --rm butler audit --details
```

Anything after the service name goes straight to the CLI, so every flag in the README works:

```bash
docker compose run --rm butler rate --max-age 12
docker compose run --rm butler audit --json > reports/audit.json
```

Without compose:

```bash
docker build -t abs-butler .
docker run --rm --env-file .env abs-butler audit
```

## Scheduled runs

```bash
docker compose up -d scheduled-audit      # re-audits every BUTLER_SCHEDULE (default 12h)
docker compose logs -f scheduled-audit
```

`BUTLER_SCHEDULE` accepts a number with an optional `s`/`m`/`h`/`d` suffix: `900`, `30m`, `12h`, `1d`.

A second service re-tags books on a schedule. It is behind a profile because it **writes to your
AudiobookShelf**, so it should be a deliberate choice:

```bash
docker compose --profile tagging up -d scheduled-rate
```

Behavior worth knowing:

- If the **first** run fails, the container exits rather than looping. A failure at startup is nearly
  always bad configuration, and a crash-looping container in `docker ps` is far easier to notice than
  a healthy-looking one quietly erroring every 12 hours.
- Once a run has succeeded, later failures are treated as transient and it keeps going.
- `SIGTERM` is handled immediately, so `docker compose stop` returns at once instead of waiting out
  the sleep.

To run on an interval without a long-lived container, use host cron instead:

```cron
0 4 * * * cd /home/conrad/repos/abs-butler && docker compose run --rm butler audit --json > reports/audit.json
```

## Reaching your AudiobookShelf server

`localhost` inside the container means *the container*, so `ABS_URL=http://localhost:13378` will not
work. Pick whichever matches your setup:

| Where AudiobookShelf runs | `ABS_URL` |
| --- | --- |
| Directly on this host | `http://host.docker.internal:13378` (the compose file already adds the `host-gateway` mapping) |
| On this host, simplest fallback | `http://192.168.x.x:13378` — your machine's LAN IP |
| In Docker, same compose project | `http://audiobookshelf:80` — the service name |
| In Docker, a different project | Join its network, then use the service name (below) |

To reach a container in another compose project, attach to its network:

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

Only `organize` touches the filesystem; `audit`, `rate`, and `metadata` work purely over the API and
need no mount at all.

There are up to three different names for the same directory, which is where this usually goes wrong:

| Setting | Whose view | Example |
| --- | --- | --- |
| `HOST_LIBRARY_PATH` | This machine | `/mnt/media/audiobooks` |
| `LIBRARY_ROOT` | Inside the butler container | always `/library` — compose sets this, don't override it |
| `ABS_PATH_PREFIX` | Inside the **AudiobookShelf** container | `/audiobooks` |

`ABS_PATH_PREFIX` is the path AudiobookShelf itself reports for your library — check
`docker compose run --rm butler libraries`, which prints each library's folder paths as ABS sees
them. If AudiobookShelf is *not* containerized, its paths already match the host and you can leave
`ABS_PATH_PREFIX` empty.

The library is mounted **read-only by default**. To actually move files:

```bash
# .env
LIBRARY_MOUNT_MODE=rw
```

```bash
docker compose run --rm butler organize             # dry run first. always.
docker compose run --rm butler organize --apply
```

Set `LIBRARY_MOUNT_MODE` back to `ro` afterwards.

## File ownership

Files created by `organize` are owned by whoever the container runs as. Set `PUID`/`PGID` in `.env`
to the user that owns your library, or you will end up with folders you cannot write to:

```bash
id -u    # -> PUID
id -g    # -> PGID
```

The image runs as a non-root user (uid 1000) by default and never needs root.

## Image notes

- Multi-stage build: TypeScript is compiled with full dependencies, then only `dist/` and production
  dependencies are copied into the runtime stage. ~244 MB on `node:24-alpine`.
- `tini` is PID 1, so signals are forwarded and zombies reaped during scheduled sleeps.
- `.dockerignore` excludes `.env`, `config.json`, and `.git`, so **no credentials are baked into the
  image**. Secrets are supplied at run time via `--env-file` / `env_file`.
- `env_file` is marked optional, so the image still runs from pure environment variables with no
  `.env` present.
