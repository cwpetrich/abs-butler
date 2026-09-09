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

# The shape of the files this script generates. Bumped whenever a change here
# needs an existing install to do something, and recorded in .env so a later
# run can tell how far behind that install is. Notes for each step live in
# migration_notes().
INSTALL_VERSION=2
IMAGE_DEFAULT="ghcr.io/cwpetrich/abs-butler:latest"
COMPOSE_URL="https://raw.githubusercontent.com/cwpetrich/abs-butler/main/docker-compose.yml"

library=""
nfs=""
install_dir=""
port=""
bind=""
puid=""
pgid=""
image=""
assume_yes=0
dry_run=0
abs_url=""
abs_username=""
abs_password=""
abs_network=""
path_prefix=""
no_discover=0
setup_code=""
remote=0
do_update=0

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

Connecting to AudiobookShelf (all optional — it looks for it by itself):
  --abs-url URL         Skip discovery and use this URL
  --abs-username NAME   Admin username, to connect during install
  --abs-password PW     Admin password; prompted for if a username is given
  --no-discover         Do not look for a running AudiobookShelf at all

Options:
  --dir PATH            Where to install (default: /opt/abs-butler as root,
                        otherwise ./abs-butler)
  --port N              Port for the web UI (default: 13380)
  --local               Publish on 127.0.0.1 only, reachable from this machine
                        alone. The default is every interface, like the server
                        abs-butler manages.
  --bind ADDR           Address to publish on (default: 0.0.0.0)
  --setup-code CODE     Require this code to set the first password. Generated
                        automatically whenever the UI is not on loopback.
  --puid N / --pgid N   Ownership for files 'organize' creates. Defaults to the
                        owner of the library directory, which is what keeps
                        AudiobookShelf able to read its own library.
  --image REF           Container image (default: $IMAGE_DEFAULT)
  -y, --yes             Do not prompt; fail instead if something is missing
  --update              Bring an existing install up to date: refresh the
                        compose file, pull the current image, restart, and
                        report anything that needs a decision. Changes no
                        settings of its own.
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
    --abs-url) [ $# -ge 2 ] || usage_error "--abs-url needs a URL"; abs_url="$2"; shift 2 ;;
    --abs-url=*) abs_url="${1#*=}"; shift ;;
    --abs-username) [ $# -ge 2 ] || usage_error "--abs-username needs a name"; abs_username="$2"; shift 2 ;;
    --abs-username=*) abs_username="${1#*=}"; shift ;;
    --abs-password) [ $# -ge 2 ] || usage_error "--abs-password needs a password"; abs_password="$2"; shift 2 ;;
    --abs-password=*) abs_password="${1#*=}"; shift ;;
    --no-discover) no_discover=1; shift ;;
    --update) do_update=1; no_discover=1; shift ;;
    --remote) remote=1; shift ;;                       # kept: it was the old spelling of the default
    --local) bind="127.0.0.1"; shift ;;
    --setup-code) [ $# -ge 2 ] || usage_error "--setup-code needs a value"; setup_code="$2"; shift 2 ;;
    --setup-code=*) setup_code="${1#*=}"; shift ;;
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

# ---- finding AudiobookShelf ------------------------------------------------
#
# A container running AudiobookShelf answers three questions at once, which is
# why this looks at Docker before it looks at ports: the published port gives
# the URL, and the library bind mount gives both the host path to mount here
# and the path AudiobookShelf itself reports. That second half is the path
# prefix, the setting people most often get wrong, and it stops being a guess.
#
# /status is unauthenticated and names the application, so a candidate can be
# confirmed as really being AudiobookShelf rather than whatever else happens to
# hold the port.

# Everything ABS mounts that is not the library.
is_library_mount() {
  case "$1" in
    /config|/metadata|/config/*|/metadata/*) return 1 ;;
    *) return 0 ;;
  esac
}

abs_version_at() {
  curl -s --max-time 3 "http://$1/status" 2>/dev/null \
    | sed -n 's/.*"app":"audiobookshelf".*"serverVersion":"\([^"]*\)".*/\1/p' | head -1
}

# One tab-separated candidate per line:
#   name  network  internal_port  host_endpoint  lib_source  lib_dest  version
discover_candidates() {
  docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null \
    | grep -i 'audiobookshelf' | cut -f1 | while read -r c; do
      [ -n "$c" ] || continue
      dc_net=$(docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}')
      dc_iport=$(docker inspect "$c" --format '{{range $p,$conf := .NetworkSettings.Ports}}{{$p}} {{end}}' 2>/dev/null | awk '{print $1}' | cut -d/ -f1)
      dc_hend=$(docker inspect "$c" --format '{{range $p,$conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' 2>/dev/null | awk '{print $1}')
      dc_src=""; dc_dst=""
      # shellcheck disable=SC2016
      docker inspect "$c" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null > "$TMPDIR_ABS/mounts.$$" || true
      while IFS='|' read -r m_src m_dst; do
        [ -n "$m_dst" ] || continue
        if is_library_mount "$m_dst"; then dc_src="$m_src"; dc_dst="$m_dst"; break; fi
      done < "$TMPDIR_ABS/mounts.$$"
      rm -f "$TMPDIR_ABS/mounts.$$"
      dc_ver=""
      case "$dc_hend" in
        *:*) dc_ver=$(abs_version_at "127.0.0.1:${dc_hend##*:}") ;;
      esac
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$c" "$dc_net" "${dc_iport:-80}" "$dc_hend" "$dc_src" "$dc_dst" "$dc_ver"
    done
}

# Only consulted when no container matched: AudiobookShelf installed directly
# on the host still answers /status, it just has nothing to introspect.
discover_bare() {
  for db_p in 13378 13379 8080; do
    db_v=$(abs_version_at "127.0.0.1:$db_p")
    [ -n "$db_v" ] && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "(not in a container)" "" "$db_p" "127.0.0.1:$db_p" "" "" "$db_v"
  done
}

# ---- what changed between generations --------------------------------------
#
# Printed on any run that finds an older stamp, newest step last. A note is
# only worth adding here when an existing install has to decide something: a
# change that applies itself needs no paragraph, and a change nobody has to act
# on is release notes, not this.
migration_notes() {
  from="$1"
  if [ "$from" -lt 2 ]; then
    say "  Since generation 1:"
    say "    - The UI is now published on every interface by default, as"
    say "      AudiobookShelf is. Your install keeps whatever it already had;"
    say "      --bind 0.0.0.0 adopts the new default, --local keeps loopback."
    say "    - Setting the first password needs a generated code whenever the UI"
    say "      is not on loopback. Only relevant if no password is set yet."
    say "    - Failed logins are throttled from 0.4.2 on. Update the image to"
    say "      get it: --update does."
  fi
}

# ---- where to install, and what is already there ---------------------------

if [ -z "$install_dir" ]; then
  if [ "$(id -u)" -eq 0 ]; then install_dir="/opt/abs-butler"; else install_dir="$PWD/abs-butler"; fi
fi

# An existing .env is the answer to every question it already covers. Re-running
# to pick up a newer compose file, or to change one thing, must not quietly
# revert the rest to defaults -- reverting BUTLER_BIND alone would take a
# working remote install off the network.
env_value() {
  [ -f "$install_dir/.env" ] || return 0
  sed -n "s/^$1=//p" "$install_dir/.env" | tail -1
}

if [ -f "$install_dir/.env" ]; then
  existing_env=1
  [ -n "$bind" ]        || bind=$(env_value BUTLER_BIND)
  [ -n "$port" ]        || port=$(env_value BUTLER_PORT)
  [ -n "$image" ]       || image=$(env_value BUTLER_IMAGE)
  [ -n "$puid" ]        || puid=$(env_value PUID)
  [ -n "$pgid" ]        || pgid=$(env_value PGID)
  [ -n "$library" ]     || library=$(env_value HOST_LIBRARY_PATH)
  [ -n "$setup_code" ]  || setup_code=$(env_value BUTLER_SETUP_CODE)
  installed_version=$(env_value BUTLER_INSTALL_VERSION)
  # Absent means it predates the stamp, which is generation 1.
  [ -n "$installed_version" ] || installed_version=1
else
  existing_env=0
  installed_version="$INSTALL_VERSION"
fi

# Whatever is still unanswered falls back to the defaults.
[ -n "$port" ] || port="13380"
[ -n "$image" ] || image="$IMAGE_DEFAULT"

# ---- preflight -------------------------------------------------------------

TMPDIR_ABS="${TMPDIR:-/tmp}"

command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is not available. The old 'docker-compose' script will not do."
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable. Start it, or add your user to the 'docker' group."

case "$port" in ''|*[!0-9]*) usage_error "--port must be a number (got '$port')" ;; esac

if [ -n "$library" ] && [ -n "$nfs" ]; then
  usage_error "--library and --nfs are two answers to the same question; pick one."
fi

# ---- where the audiobooks are ----------------------------------------------

CANDIDATES="$TMPDIR_ABS/abs-candidates.$$"
: > "$CANDIDATES"
trap 'rm -f "$CANDIDATES"' EXIT INT TERM

if [ "$no_discover" -eq 0 ] && [ -z "$nfs" ]; then
  discover_candidates > "$CANDIDATES" 2>/dev/null || true
  [ -s "$CANDIDATES" ] || discover_bare > "$CANDIDATES" 2>/dev/null || true
fi

found=$(wc -l < "$CANDIDATES" | tr -d ' ')
chosen=""

if [ "$found" -gt 0 ]; then
  say "Found AudiobookShelf:"
  say ""
  i=0
  while IFS="$(printf '\t')" read -r c_name c_net c_iport c_hend c_src c_dst c_ver; do
    i=$((i + 1))
    printf '  %d) %s%s\n' "$i" "$c_name" "${c_ver:+  (v$c_ver)}"
    [ -n "$c_hend" ] && printf '       reachable at %s\n' "$c_hend"
    [ -n "$c_src" ] && printf '       library      %s\n' "$c_src"
  done < "$CANDIDATES"
  say ""

  if [ "$found" -eq 1 ]; then
    # Nothing to disambiguate, so confirming is the only question worth asking.
    if [ "$assume_yes" -eq 1 ] || confirm "Use this one?"; then
      chosen=$(head -1 "$CANDIDATES")
    fi
  elif interactive; then
    pick="$(ask "Which one? 1-$found, or blank to skip" '--abs-url' '')"
    case "$pick" in
      ''|*[!0-9]*) : ;;
      *) [ "$pick" -ge 1 ] && [ "$pick" -le "$found" ] && chosen=$(sed -n "${pick}p" "$CANDIDATES") ;;
    esac
  else
    # Guessing between several servers is exactly the decision that must not be
    # made silently; organize moves files in whichever one is picked.
    warn "several found and no terminal to ask — pass --abs-url to choose one."
  fi
fi

if [ -n "$chosen" ]; then
  d_name=$(printf '%s' "$chosen" | cut -f1)
  d_net=$(printf '%s' "$chosen" | cut -f2)
  d_iport=$(printf '%s' "$chosen" | cut -f3)
  d_hend=$(printf '%s' "$chosen" | cut -f4)
  d_src=$(printf '%s' "$chosen" | cut -f5)
  d_dst=$(printf '%s' "$chosen" | cut -f6)

  [ -z "$library" ] && [ -n "$d_src" ] && library="$d_src"

  # What AudiobookShelf reports for its own folders is the path inside its
  # container, which is only /audiobooks by coincidence. When it differs, that
  # difference is the path prefix.
  [ -n "$d_dst" ] && [ "$d_dst" != "/audiobooks" ] && path_prefix="$d_dst"

  if [ -z "$abs_url" ]; then
    if [ -n "$d_net" ]; then
      # Joining its network and using the container name works whatever the
      # host binding is. host.docker.internal does not: on Linux it resolves to
      # the bridge gateway, and a server published on 127.0.0.1 -- the common,
      # sensible default -- is unreachable from there.
      abs_network="$d_net"
      abs_url="http://${d_name}:${d_iport}"
    elif [ -n "$d_hend" ]; then
      abs_url="http://host.docker.internal:${d_hend##*:}"
    fi
  fi
  note "using $abs_url${library:+, library $library}"
fi

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

# Published on every interface, like AudiobookShelf itself and every other
# service of this kind. A loopback default is wrong on the machine this is
# built for -- a headless server has no browser to open it with -- and being
# stricter than the server being managed buys nothing: the same network can
# already reach AudiobookShelf, which can delete the library outright.
#
# What makes that safe is below, not here: setup needs a code, and failed
# logins are throttled.
[ -n "$bind" ] || bind="0.0.0.0"

# Settings inherited from an existing .env are reported, not applied quietly.
# Preserving them is right -- a re-run must not undo what a previous one set --
# but silence about it reads as the installer ignoring its own default, which
# is exactly how it looks when the inherited value is loopback and the new
# default is not.
if [ "$existing_env" -eq 1 ] && [ "$installed_version" -lt "$INSTALL_VERSION" ]; then
  say ""
  say "This install came from an older install.sh (generation $installed_version; this is $INSTALL_VERSION)."
  say "None of the following is applied on its own — each is a decision left to you."
  migration_notes "$installed_version"
  say ""
fi

if [ "$existing_env" -eq 1 ]; then
  note "keeping the settings already in $install_dir/.env; flags override them"
  if [ "$bind" = "127.0.0.1" ] || [ "$bind" = "localhost" ]; then
    note "  BUTLER_BIND=$bind — reachable only from this machine."
    note "  To publish it to the network:  sh $0 --dir $install_dir --bind 0.0.0.0"
  fi
fi

# Publishing beyond loopback without this is the one genuinely unsafe
# combination: until a password exists the setup page must be reachable by an
# anonymous visitor, so on a network the first person to load it takes the
# account. Setting BUTLER_SETUP_CODE changes the rule — the code is then
# required whether or not the 15-minute window is open, which both closes the
# race and removes the rush.
if [ "$bind" != "127.0.0.1" ] && [ "$bind" != "localhost" ]; then
  if [ -z "$setup_code" ]; then
    setup_code=$(od -An -tx1 -N10 /dev/urandom 2>/dev/null | tr -d ' \n' | tr '[:lower:]' '[:upper:]')
    [ -n "$setup_code" ] || setup_code=$(date +%s | tr -d '\n')
  fi
fi

# ---- what gets written -----------------------------------------------------

env_body="# Written by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ').
# Which generation of this file this is. install.sh reads it to work out what
# an older install still needs told; do not edit it by hand.
BUTLER_INSTALL_VERSION=$INSTALL_VERSION
# The AudiobookShelf URL, credentials and library root are NOT here — those are
# set in the browser and kept in abs-butler's database.
BUTLER_IMAGE=$image
BUTLER_BIND=$bind
BUTLER_PORT=$port
PUID=$puid
PGID=$pgid
"
if [ -n "$setup_code" ]; then
  env_body="${env_body}# Required to set the first password, instead of the 15-minute open window.
BUTLER_SETUP_CODE=$setup_code
"
fi
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

# Joining AudiobookShelf's own network means the butler container resolves it by
# name on its internal port, with no dependence on how -- or whether -- the
# server publishes a port to the host. Naming `default` explicitly is required:
# listing any network at all replaces the implicit one.
network_block=""
if [ -n "$abs_network" ]; then
  network_block="    networks: !override
      - default
      - abs
"
  network_decl="
networks:
  abs:
    external: true
    name: $abs_network
"
else
  network_decl=""
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
$network_block  cli:
    volumes: !override
      - ./data:/data
$library_mount
$network_block$nfs_volume$network_decl"

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

# docker-compose.yml is generated, not configuration: what belongs to this
# install lives in .env and the override beside it. So it is refreshed rather
# than left alone -- an install that keeps its original copy forever never
# receives a fix made to it, which is how BUTLER_BIND would have failed to
# reach anyone who installed before it existed.
fetch_compose() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$COMPOSE_URL" -o "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$1" "$COMPOSE_URL"
  else
    return 2
  fi
}

if [ ! -f docker-compose.yml ]; then
  note "fetching docker-compose.yml"
  fetch_compose docker-compose.yml || die "could not download docker-compose.yml. Copy it into $install_dir yourself, or check the network."
else
  if fetch_compose docker-compose.yml.new 2>/dev/null && [ -s docker-compose.yml.new ]; then
    if cmp -s docker-compose.yml docker-compose.yml.new; then
      rm -f docker-compose.yml.new
    else
      # Kept rather than discarded: a hand-edited compose file is not the
      # supported arrangement, but losing someone's edit silently is worse.
      cp docker-compose.yml docker-compose.yml.bak
      mv docker-compose.yml.new docker-compose.yml
      note "docker-compose.yml updated (previous copy kept as docker-compose.yml.bak)"
    fi
  else
    rm -f docker-compose.yml.new
    [ "$do_update" -eq 1 ] && warn "could not reach GitHub to refresh docker-compose.yml; keeping the existing one."
  fi
fi


# Values already in the file were adopted above, so this rewrite preserves them
# and only applies what was asked for on this run.
if [ -f .env ] && [ "$assume_yes" -eq 0 ] && ! confirm "$install_dir/.env exists. Update it?"; then
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

if [ "$do_update" -eq 1 ]; then
  note "pulling the current image"
  docker compose pull butler 2>&1 | grep -viE '^$' | tail -3 || true
fi

note "pulling and starting"
docker compose up -d butler || die "compose failed to start. 'docker compose logs butler' has the detail. If the pull was denied, the image may be private — run 'docker login ghcr.io' first."

# The container has its own healthcheck; this just waits for the port to answer
# so the closing message is not a lie.
# The address to print. On a machine with no browser, "localhost" is useless
# advice, so a routable address is worked out and shown instead.
host_address() {
  ha=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ha" ] || ha=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -n "$ha" ] || ha=$(hostname 2>/dev/null || echo localhost)
  printf '%s' "$ha"
}

i=0
probe_url="http://127.0.0.1:${port}"
if [ "$bind" = "127.0.0.1" ] || [ "$bind" = "localhost" ]; then
  url="http://127.0.0.1:${port}"
else
  url="http://$(host_address):${port}"
fi
while [ "$i" -lt 60 ]; do
  if curl -fsS "$probe_url/api/health" >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 1
done

# ---- connect it -----------------------------------------------------------
#
# The one thing discovery cannot supply is a credential: /status is the only
# unauthenticated endpoint AudiobookShelf offers and it reveals nothing else.
# So the URL and the paths are filled in, and only the login is asked for.
connected=0
if [ -n "$abs_url" ]; then
  if [ -z "$abs_username" ] && interactive; then
    say ""
    say "abs-butler can connect to $abs_url now. It stores the API token it is"
    say "given in exchange, never the password."
    if confirm "Sign in and connect?"; then
      abs_username="$(ask 'Admin username' '--abs-username')"
    fi
  fi

  if [ -n "$abs_username" ]; then
    # Passed through to the CLI, which prompts for the password itself when it
    # was not given as a flag -- and does not echo it.
    set -- connect --url "$abs_url" --username "$abs_username" --library-root /audiobooks
    [ -n "$abs_password" ] && set -- "$@" --password "$abs_password"
    [ -n "$path_prefix" ] && set -- "$@" --path-prefix "$path_prefix"
    # -T only without a terminal: with one, the CLI prompts for the password
    # itself and needs the TTY to do it without echoing.
    if interactive; then tty_flag=""; else tty_flag="-T"; fi
    # shellcheck disable=SC2086
    if docker compose run --rm $tty_flag cli "$@"; then
      connected=1
    else
      warn "could not connect automatically. Add the server in the browser instead."
    fi
  fi
fi

say ""
if [ "$i" -ge 60 ]; then
  warn "started, but $probe_url/api/health did not answer within 60s. Check 'docker compose logs -f butler'."
else
  note "up at $url"
fi

if [ -n "$setup_code" ]; then
  cat <<EOF

  The UI is published on $bind, so setting the first password needs this code:

      $setup_code

  It is in $install_dir/.env as BUTLER_SETUP_CODE. Because it is set, the
  15-minute window does not apply — nobody can claim the account without the
  code, and there is no rush.
EOF
fi

if [ "$connected" -eq 1 ]; then
  cat <<EOF

AudiobookShelf is already connected: $abs_url

  1. Open $url from any machine on the network and set a password.

  2. Nothing else to configure. Check what it can see with:
     docker compose run --rm cli status
EOF
else
cat <<EOF

Next, in the browser — none of this is configured here:

  1. Open $url and set a password. The setup page stays open for 15
     minutes after start; 'docker compose restart butler' reopens it, and the
     startup log carries a code that works after it closes.

  2. Add your AudiobookShelf server${abs_url:+ at $abs_url}.
     Sign in with an admin username and password, or paste an API token.

  3. For file organizing, set the library root to /audiobooks. That is where
     this container sees $([ -n "$nfs" ] && echo "the NAS export" || echo "$library"), whatever the path is outside it.
EOF
fi
cat <<EOF

Useful later:

  cd $install_dir
  docker compose logs -f butler
  docker compose run --rm cli status
  docker compose down
EOF
