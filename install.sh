#!/bin/sh
# Sets up an abs-butler instance next to an AudiobookShelf server.
#
# abs-butler configures itself in the browser: the server URL, the credentials
# and the library paths are all entered there and kept in its database. This
# script exists for the one decision the UI cannot make for itself — which host
# directory gets mounted into the container. A bind mount is fixed when the
# container is created, so it has to be settled before the first start.
#
#   ./install.sh                                  # asks where the library is
#   ./install.sh --library /srv/audiobooks        # or say so up front
#   ./install.sh --nfs 192.168.1.10:/volume1/audiobooks
#
# Everything else has a working default. Run with --dry-run to see what it
# would write without touching anything.
set -eu

VERSION="0.4.0"
IMAGE_DEFAULT="ghcr.io/cwpetrich/abs-butler:latest"
COMPOSE_URL="https://raw.githubusercontent.com/cwpetrich/abs-butler/main/docker-compose.yml"

library=""
nfs=""
install_dir=""
port="13380"
bind="127.0.0.1"
puid=""
pgid=""
image="$IMAGE_DEFAULT"
assume_yes=0
dry_run=0

say()  { printf '%s\n' "$*"; }
note() { printf 'abs-butler: %s\n' "$*"; }
warn() { printf 'abs-butler: %s\n' "$*" >&2; }
die()  { printf 'abs-butler: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'abs-butler: %s\n' "$*" >&2; printf "Try '%s --help'.\n" "$0" >&2; exit 2; }

usage() {
  cat <<EOF
abs-butler installer ($VERSION)

Usage: $0 [options]

Where the audiobooks are (pick one; asked for if omitted):
  --library PATH        Host directory AudiobookShelf reads. An already-mounted
                        NAS share is just a path — use this for it.
  --nfs HOST:/EXPORT    An NFS export, mounted by Docker itself. Use this only
                        when the share is not already mounted on the host.

Options:
  --dir PATH            Where to install (default: /opt/abs-butler as root,
                        otherwise ./abs-butler)
  --port N              Port for the web UI (default: 13380)
  --bind ADDR           Address to publish on (default: 127.0.0.1; use 0.0.0.0
                        to expose it to the network, and read the warning)
  --puid N / --pgid N   Ownership for files 'organize' creates. Defaults to the
                        owner of the library directory, which is what keeps
                        AudiobookShelf able to read its own library.
  --image REF           Container image (default: $IMAGE_DEFAULT)
  -y, --yes             Do not prompt; fail instead if something is missing
  --dry-run             Print what would be written, change nothing
  -h, --help            This text

The AudiobookShelf URL, the API token or username and password, and the library
root all go in the browser after this finishes. None of them belong here.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --library) [ $# -ge 2 ] || usage_error "--library needs a path"; library="$2"; shift 2 ;;
    --library=*) library="${1#*=}"; shift ;;
    --nfs) [ $# -ge 2 ] || usage_error "--nfs needs HOST:/EXPORT"; nfs="$2"; shift 2 ;;
    --nfs=*) nfs="${1#*=}"; shift ;;
    --dir) [ $# -ge 2 ] || usage_error "--dir needs a path"; install_dir="$2"; shift 2 ;;
    --dir=*) install_dir="${1#*=}"; shift ;;
    --port) [ $# -ge 2 ] || usage_error "--port needs a number"; port="$2"; shift 2 ;;
    --port=*) port="${1#*=}"; shift ;;
    --bind) [ $# -ge 2 ] || usage_error "--bind needs an address"; bind="$2"; shift 2 ;;
    --bind=*) bind="${1#*=}"; shift ;;
    --puid) [ $# -ge 2 ] || usage_error "--puid needs a number"; puid="$2"; shift 2 ;;
    --puid=*) puid="${1#*=}"; shift ;;
    --pgid) [ $# -ge 2 ] || usage_error "--pgid needs a number"; pgid="$2"; shift 2 ;;
    --pgid=*) pgid="${1#*=}"; shift ;;
    --image) [ $# -ge 2 ] || usage_error "--image needs a reference"; image="$2"; shift 2 ;;
    --image=*) image="${1#*=}"; shift ;;
    -y|--yes) assume_yes=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done

interactive() { [ "$assume_yes" -eq 0 ] && [ -t 0 ]; }

# Prompts go to stderr, always. ask() is called inside a command substitution,
# so anything written to stdout would be captured as the answer instead of
# reaching the person typing it.
#
# Asks only when there is a terminal to answer. Without one the script names the
# missing flag rather than blocking on a read nobody can service — the same rule
# the CLI follows.
ask() {
  ask_prompt="$1"; ask_flag="$2"; ask_default="${3:-}"
  if ! interactive; then
    die "$ask_flag is required when there is no terminal to ask."
  fi
  if [ -n "$ask_default" ]; then
    printf '%s [%s]: ' "$ask_prompt" "$ask_default" >&2
  else
    printf '%s: ' "$ask_prompt" >&2
  fi
  read -r ask_reply || die "cancelled."
  [ -n "$ask_reply" ] || ask_reply="$ask_default"
  printf '%s' "$ask_reply"
}

# --yes is a standing answer of yes. Without it and without a terminal the
# answer is no, which is the safe direction for every question asked here.
confirm() {
  [ "$assume_yes" -eq 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [y/N]: ' "$1" >&2
  read -r reply || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ---- preflight -------------------------------------------------------------

command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is not available. The old 'docker-compose' script will not do."
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable. Start it, or add your user to the 'docker' group."

case "$port" in ''|*[!0-9]*) usage_error "--port must be a number (got '$port')" ;; esac

if [ -n "$library" ] && [ -n "$nfs" ]; then
  usage_error "--library and --nfs are two answers to the same question; pick one."
fi

# ---- where the audiobooks are ----------------------------------------------

if [ -z "$library" ] && [ -z "$nfs" ]; then
  say "abs-butler needs to see the same audiobooks AudiobookShelf does."
  say "Give the directory on this machine. An already-mounted NAS share is just a path."
  say ""
  library="$(ask 'Library directory' '--library')"
fi

if [ -n "$library" ]; then
  case "$library" in
    /*) : ;;
    *) die "the library path must be absolute (got '$library')." ;;
  esac
  [ -e "$library" ] || die "$library does not exist. Create it, or mount the share first."
  [ -d "$library" ] || die "$library is not a directory."
  [ -r "$library" ] || die "$library is not readable by $(id -un)."

  # Files that organize creates inherit this ownership. Matching the library's
  # own owner is what keeps AudiobookShelf able to read what abs-butler moved,
  # and getting it wrong is the most common way this ends up half-working.
  if [ -z "$puid" ]; then
    puid="$(stat -c %u "$library" 2>/dev/null || stat -f %u "$library" 2>/dev/null || echo 1000)"
  fi
  if [ -z "$pgid" ]; then
    pgid="$(stat -c %g "$library" 2>/dev/null || stat -f %g "$library" 2>/dev/null || echo 1000)"
  fi

  # A network mount that goes away takes organize's target with it. Worth
  # naming now rather than as a puzzling failure during a run.
  fstype="$(stat -f -c %T "$library" 2>/dev/null || echo '')"
  case "$fstype" in
    nfs*|smb*|cifs*|fuseblk)
      warn "$library is on a $fstype mount. If it is not mounted at boot, abs-butler will start with an empty library — consider an fstab entry or autofs."
      ;;
  esac
fi

if [ -n "$nfs" ]; then
  case "$nfs" in
    *:/*) : ;;
    *) usage_error "--nfs expects HOST:/EXPORT (got '$nfs')" ;;
  esac
  nfs_host="${nfs%%:*}"
  nfs_export="${nfs#*:}"
  [ -n "$puid" ] || puid=1000
  [ -n "$pgid" ] || pgid=1000
fi

[ -n "$puid" ] || puid=1000
[ -n "$pgid" ] || pgid=1000

# ---- where to install ------------------------------------------------------

if [ -z "$install_dir" ]; then
  if [ "$(id -u)" -eq 0 ]; then install_dir="/opt/abs-butler"; else install_dir="$PWD/abs-butler"; fi
fi

if [ "$bind" = "0.0.0.0" ]; then
  warn "publishing on 0.0.0.0 exposes the UI to the whole network. Until a password is set — the first 15 minutes — the setup page is reachable by anyone who can see the port, and the first visitor claims the account."
  if ! confirm "Continue with 0.0.0.0?"; then
    die "stopped. Re-run without --bind to keep it on 127.0.0.1."
  fi
fi

# ---- what gets written -----------------------------------------------------

env_body="# Written by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ').
# The AudiobookShelf URL, credentials and library root are NOT here — those are
# set in the browser and kept in abs-butler's database.
BUTLER_IMAGE=$image
BUTLER_BIND=$bind
BUTLER_PORT=$port
PUID=$puid
PGID=$pgid
"
if [ -n "$library" ]; then
  env_body="${env_body}HOST_LIBRARY_PATH=$library
"
fi

# The database moves to a bind mount, always.
#
# The shipped compose file keeps it in a named volume, which is right when the
# container runs as uid 1000 — the uid the image prepares /data for. It stops
# being right the moment PUID is anything else, and deriving PUID from a real
# library makes that the normal case. Docker re-initialises an *empty* named
# volume from the image on every start, ownership included, so chowning it
# beforehand does not survive the next `up`: the container comes back unable to
# open its own database. A bind mount is never re-initialised, so the ownership
# set here is the ownership it keeps.
#
# !override replaces the mount list outright. Without it compose appends, and
# two sources collide on the same target. Needs Compose v2.24 or newer.
if [ -n "$nfs" ]; then
  library_mount="      - audiobooks:/audiobooks:rw"
  nfs_volume="
volumes:
  audiobooks:
    driver: local
    driver_opts:
      type: nfs
      o: addr=$nfs_host,rw,nfsvers=4,soft
      device: \":$nfs_export\"
"
else
  library_mount="      - \${HOST_LIBRARY_PATH}:/audiobooks:rw"
  nfs_volume=""
fi

override_body="# Written by install.sh.
#
# The database lives beside this file rather than in a named volume, so that it
# is owned by PUID:PGID and stays that way. Back up ./data and you have backed
# up everything abs-butler knows.
services:
  butler:
    volumes: !override
      - ./data:/data
$library_mount
  cli:
    volumes: !override
      - ./data:/data
$library_mount
$nfs_volume"

if [ "$dry_run" -eq 1 ]; then
  say "Would install into: $install_dir"
  say "Would fetch:        docker-compose.yml (if absent)"
  say ""
  say "--- .env ---"
  printf '%s' "$env_body"
  say ""
  say "--- docker-compose.override.yml ---"
  printf '%s' "$override_body"
  say ""
  say "Would then run: docker compose up -d butler"
  exit 0
fi

mkdir -p "$install_dir" || die "could not create $install_dir. Run as root, or pass --dir somewhere writable."
cd "$install_dir"

if [ ! -f docker-compose.yml ]; then
  note "fetching docker-compose.yml"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$COMPOSE_URL" -o docker-compose.yml || die "could not download docker-compose.yml. If the repository is private, copy the file here yourself."
  elif command -v wget >/dev/null 2>&1; then
    wget -qO docker-compose.yml "$COMPOSE_URL" || die "could not download docker-compose.yml. If the repository is private, copy the file here yourself."
  else
    die "neither curl nor wget is available. Copy docker-compose.yml into $install_dir and re-run."
  fi
else
  note "using the docker-compose.yml already in $install_dir"
fi

if [ -f .env ] && ! confirm "$install_dir/.env exists. Overwrite it?"; then
  die "stopped, leaving the existing .env alone."
fi

printf '%s' "$env_body" > .env
chmod 600 .env
note "wrote $install_dir/.env"

printf '%s' "$override_body" > docker-compose.override.yml
note "wrote $install_dir/docker-compose.override.yml"

# ---- start it --------------------------------------------------------------

mkdir -p data || die "could not create $install_dir/data."
if ! chown "${puid}:${pgid}" data 2>/dev/null; then
  # Fine when the directory already belongs to them; a real problem otherwise,
  # and the symptom is unmistakable once it starts.
  if [ "$(stat -c %u data 2>/dev/null || stat -f %u data 2>/dev/null || echo '')" != "$puid" ]; then
    warn "could not give $install_dir/data to ${puid}:${pgid} — re-run as root if the log says 'unable to open database file'."
  fi
fi

note "pulling and starting"
docker compose up -d butler || die "compose failed to start. 'docker compose logs butler' has the detail. If the pull was denied, the image may be private — run 'docker login ghcr.io' first."

# The container has its own healthcheck; this just waits for the port to answer
# so the closing message is not a lie.
i=0
url="http://${bind}:${port}"
[ "$bind" = "0.0.0.0" ] && url="http://localhost:${port}"
while [ "$i" -lt 60 ]; do
  if curl -fsS "$url/api/health" >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 1
done

say ""
if [ "$i" -ge 60 ]; then
  warn "started, but $url/api/health did not answer within 60s. Check 'docker compose logs -f butler'."
else
  note "up at $url"
fi

cat <<EOF

Next, in the browser — none of this is configured here:

  1. Open $url and set a password. The setup page stays open for 15
     minutes after start; 'docker compose restart butler' reopens it, and the
     startup log carries a code that works after it closes.

  2. Add your AudiobookShelf server. If it runs in Docker on this same host,
     the URL is http://host.docker.internal:13378 — already wired up.
     Sign in with an admin username and password, or paste an API token.

  3. For file organizing, set the library root to /audiobooks. That is where
     this container sees $([ -n "$nfs" ] && echo "the NAS export" || echo "$library"), whatever the path is outside it.

Useful later:

  cd $install_dir
  docker compose logs -f butler
  docker compose run --rm cli status
  docker compose down
EOF
