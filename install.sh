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
#   ./install.sh --repair                         # check an install and fix it
#
# It also runs as a container, which is how it runs on Windows -- see
# installer/Dockerfile. Everything below works the same either way: what it
# needs to know about the host it asks Docker, not the filesystem.
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
INSTALLER_IMAGE="${ABS_BUTLER_INSTALLER_IMAGE:-ghcr.io/cwpetrich/abs-butler-installer:latest}"
COMPOSE_URL="https://raw.githubusercontent.com/cwpetrich/abs-butler/main/docker-compose.yml"
SELF_URL="https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.sh"

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
abs_container=""
abs_username=""
abs_password=""
abs_network=""
path_prefix=""
no_discover=0
setup_code=""
remote=0
do_update=0
repair=0
library_changed=0
library_volume=""
library_target=""
# Set by installer/entrypoint.sh: this script is in a container, with the host's
# Docker behind the socket. Host paths are then only Docker's to look at.
in_container="${ABS_BUTLER_IN_CONTAINER:-0}"
auto_update=""

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
  --library-volume NAME[:/PATH]
                        A Docker volume that already holds the library -- the
                        one AudiobookShelf mounts, typically. Mounted at PATH
                        (default /audiobooks). Found by itself when
                        AudiobookShelf runs in Docker on this machine.

Connecting to AudiobookShelf (all optional — it looks for it by itself):
  --abs-url URL         Skip discovery and use this URL
  --abs-container NAME  The AudiobookShelf container to use, when there are
                        several on this machine
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
  --repair              Check an existing install end to end and fix what it
                        can: everything --update does, and then look for
                        AudiobookShelf again, compare its library with the one
                        mounted here, and confirm the container can see books.
                        Offers each change rather than making it.
  --auto-update         Pull and restart onto each new release by itself, from
                        a nightly job on this host (a systemd timer as root,
                        otherwise a crontab line). Off unless asked for.
  --no-auto-update      Remove that job again
  --update              Bring an existing install up to date: refresh the
                        compose file, pull the current image, restart, and
                        report anything that needs a decision. Changes no
                        settings of its own. Updates this script first, then
                        re-runs with it.
  --dry-run             Print what would be written, change nothing
  -h, --help            This text

The AudiobookShelf URL, the API token or username and password, and the library
root all go in the browser after this finishes. None of them belong here.
EOF
}

# ---- keeping this script current -------------------------------------------
#
# install.sh is downloaded rather than installed, so a copy is whatever was
# published the day it was fetched -- and a copy older than a flag cannot run
# it. On --update it therefore replaces itself first and re-runs, so the rest
# of the update is performed by the current script rather than by whatever
# happened to be on disk.
#
# Only on --update. A plain install run must not silently swap the script
# someone is reading.
self_update() {
  su_new="${TMPDIR:-/tmp}/abs-butler-install.$$"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$SELF_URL" -o "$su_new" 2>/dev/null || { rm -f "$su_new"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$su_new" "$SELF_URL" 2>/dev/null || { rm -f "$su_new"; return 1; }
  else
    return 1
  fi

  # A truncated download, a captive-portal login page, or an HTML error would
  # all "download" fine. Replacing a working script with one of those is worse
  # than staying out of date, so it has to parse first.
  if [ ! -s "$su_new" ] || ! sh -n "$su_new" 2>/dev/null; then
    rm -f "$su_new"
    return 1
  fi

  if cmp -s "$su_self" "$su_new" 2>/dev/null; then
    rm -f "$su_new"
    return 1   # already current: nothing to announce, nothing to re-run
  fi

  printf 'abs-butler: %s\n' "updating install.sh itself first" >&2
  # The copy on disk is replaced so the next run starts current, but the
  # running shell is never asked to read a file that changed underneath it:
  # the new script is exec'd from its own path.
  if [ -w "$su_self" ]; then
    cp "$su_self" "$su_self.bak" 2>/dev/null || true
    if cat "$su_new" > "$su_self" 2>/dev/null; then
      rm -f "$su_new"
      su_run="$su_self"
    else
      su_run="$su_new"
    fi
  else
    printf 'abs-butler: %s\n' "  (${su_self} is not writable; running the new copy without replacing it)" >&2
    su_run="$su_new"
  fi

  # The guard stops the new copy doing this again: without it a difference the
  # comparison cannot resolve would loop forever.
  ABS_BUTLER_SELF_UPDATED=1
  export ABS_BUTLER_SELF_UPDATED
  exec sh "$su_run" "$@"
}

su_self=$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")
# In a container the image is the update: there is no copy on disk to replace.
if [ "$in_container" != "1" ] && [ "${ABS_BUTLER_SELF_UPDATED:-0}" != "1" ] && [ -f "$su_self" ]; then
  for su_arg in "$@"; do
    if [ "$su_arg" = "--update" ] || [ "$su_arg" = "--repair" ]; then
      self_update "$@" || true
      break
    fi
  done
fi

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
    --abs-container) [ $# -ge 2 ] || usage_error "--abs-container needs a name"; abs_container="$2"; shift 2 ;;
    --abs-container=*) abs_container="${1#*=}"; shift ;;
    --abs-username) [ $# -ge 2 ] || usage_error "--abs-username needs a name"; abs_username="$2"; shift 2 ;;
    --abs-username=*) abs_username="${1#*=}"; shift ;;
    --abs-password) [ $# -ge 2 ] || usage_error "--abs-password needs a password"; abs_password="$2"; shift 2 ;;
    --abs-password=*) abs_password="${1#*=}"; shift ;;
    --no-discover) no_discover=1; shift ;;
    --update) do_update=1; no_discover=1; shift ;;
    --repair) repair=1; do_update=1; shift ;;
    --library-volume) [ $# -ge 2 ] || usage_error "--library-volume needs a volume name"; library_volume="$2"; shift 2 ;;
    --library-volume=*) library_volume="${1#*=}"; shift ;;
    --auto-update) auto_update=1; shift ;;
    --no-auto-update) auto_update=0; shift ;;
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

# Repairing starts by looking again, whatever --update implies.
[ "$repair" -eq 1 ] && no_discover=0
case "$library_volume" in
  *:/*) library_target="${library_volume#*:}"; library_volume="${library_volume%%:*}" ;;
esac

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

# A published port is on the host, which a container reaches by another name.
if [ "$in_container" = "1" ]; then probe_host="host.docker.internal"; else probe_host="127.0.0.1"; fi

abs_version_at() {
  curl -s --max-time 3 "http://$1/status" 2>/dev/null \
    | sed -n 's/.*"app":"audiobookshelf".*"serverVersion":"\([^"]*\)".*/\1/p' | head -1
}

# One tab-separated candidate per line:
#   name  network  internal_port  host_endpoint  lib_type  lib_source  lib_dest  version
#
# lib_type is bind or volume. For a volume, lib_source is its name: the path
# Docker reports for one is inside Docker's own storage, and means nothing to
# anybody -- it is the volume that can be mounted again, not the path.
discover_candidates() {
  if [ -n "$abs_container" ]; then
    printf '%s\n' "$abs_container"
  else
    docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i 'audiobookshelf' | cut -f1
  fi | while read -r c; do
      [ -n "$c" ] || continue
      dc_net=$(docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}')
      dc_iport=$(docker inspect "$c" --format '{{range $p,$conf := .NetworkSettings.Ports}}{{$p}} {{end}}' 2>/dev/null | awk '{print $1}' | cut -d/ -f1)
      dc_hend=$(docker inspect "$c" --format '{{range $p,$conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' 2>/dev/null | awk '{print $1}')
      dc_type=""; dc_src=""; dc_dst=""
      # shellcheck disable=SC2016
      docker inspect "$c" --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null > "$TMPDIR_ABS/mounts.$$" || true
      while IFS='|' read -r m_type m_name m_src m_dst; do
        [ -n "$m_dst" ] || continue
        if is_library_mount "$m_dst"; then
          dc_type="$m_type"; dc_dst="$m_dst"
          if [ "$m_type" = "volume" ]; then dc_src="$m_name"; else dc_src="$m_src"; fi
          break
        fi
      done < "$TMPDIR_ABS/mounts.$$"
      rm -f "$TMPDIR_ABS/mounts.$$"
      dc_ver=""
      case "$dc_hend" in
        *:*) dc_ver=$(abs_version_at "$probe_host:${dc_hend##*:}") ;;
      esac
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$c" "$dc_net" "${dc_iport:-80}" "$dc_hend" "$dc_type" "$dc_src" "$dc_dst" "$dc_ver"
    done
}

# Only consulted when no container matched: AudiobookShelf installed directly
# on the host still answers /status, it just has nothing to introspect.
discover_bare() {
  for db_p in 13378 13379 8080; do
    db_v=$(abs_version_at "$probe_host:$db_p")
    [ -n "$db_v" ] && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "(not in a container)" "" "$db_p" "$probe_host:$db_p" "" "" "" "$db_v"
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
  if [ -z "$library" ] && [ -z "$library_volume" ]; then
    library_volume=$(env_value BUTLER_LIBRARY_VOLUME)
    library_target=$(env_value BUTLER_LIBRARY_TARGET)
  fi
  project=$(env_value COMPOSE_PROJECT_NAME)
  data_mode=$(env_value BUTLER_DATA)
  [ -n "$setup_code" ]  || setup_code=$(env_value BUTLER_SETUP_CODE)
  [ -n "$auto_update" ] || auto_update=$(env_value BUTLER_AUTO_UPDATE)
  installed_version=$(env_value BUTLER_INSTALL_VERSION)
  # Absent means it predates the stamp, which is generation 1.
  [ -n "$installed_version" ] || installed_version=1
else
  existing_env=0
  installed_version="$INSTALL_VERSION"
  project=""
  data_mode=""
fi

# Whatever is still unanswered falls back to the defaults -- the port once a
# running install has had its say, below.
[ -n "$image" ] || image="$IMAGE_DEFAULT"

# ---- preflight -------------------------------------------------------------

TMPDIR_ABS="${TMPDIR:-/tmp}"

command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is not available. The old 'docker-compose' script will not do."
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable. Start it, or add your user to the 'docker' group."

# ---- what is already running ------------------------------------------------
#
# The container is always called abs-butler, so there is only ever one, and a
# second compose project would collide with it rather than replace it. Whatever
# project it belongs to is therefore the one to keep -- including an install
# made by hand from docker-compose.yml, which has no .env to say so, and whose
# database is in that project's volume.
existing_project=$(docker inspect abs-butler --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
if [ -n "$existing_project" ]; then
  project="$existing_project"
elif [ -z "$project" ]; then
  # What compose itself would call it, spelled out so that a run from inside a
  # container, whose folder has another name, agrees with one from outside.
  project=$(basename "$install_dir" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  [ -n "$project" ] || project="abs-butler"
fi
# An install with no .env to go by is described by its container instead. Who
# can reach it is the one thing that must not change on the way through: the
# compose file publishes on loopback unless told otherwise, and a repair that
# quietly put it on the network would be a repair nobody asked for.
if [ "$existing_env" -eq 0 ] && [ -n "$existing_project" ]; then
  note "found an abs-butler already running (compose project '$existing_project'); keeping its data and its address."
  eb_binding=$(docker inspect abs-butler \
    --format '{{range $p,$c := .HostConfig.PortBindings}}{{range $c}}{{.HostIp}} {{.HostPort}}{{end}}{{end}}' 2>/dev/null || true)
  # shellcheck disable=SC2086
  set -- $eb_binding
  if [ $# -eq 2 ]; then
    [ -n "$bind" ] || bind="$1"
    [ -n "$port" ] || port="$2"
  elif [ $# -eq 1 ]; then
    # No address at all is every address.
    [ -n "$bind" ] || bind="0.0.0.0"
    [ -n "$port" ] || port="$1"
  fi
fi

[ -n "$port" ] || port="13380"
case "$port" in ''|*[!0-9]*) usage_error "--port must be a number (got '$port')" ;; esac

# Where the database lives. A folder beside this file is the default, and what
# an install from this script has always had. A named volume is kept where one
# already holds a database -- a hand install -- and used on Windows, where
# SQLite over Docker Desktop's file sharing is slow and its locking unreliable.
data_volume="${project}_butler-data"
if [ -z "$data_mode" ]; then
  if [ -n "$(ls -A "$install_dir/data" 2>/dev/null)" ]; then
    data_mode="folder"
  elif docker volume inspect "$data_volume" >/dev/null 2>&1; then
    data_mode="volume"
  else
    case "${ABS_BUTLER_HOST_DIR:-}" in
      [A-Za-z]:*) data_mode="volume" ;;
      *) data_mode="folder" ;;
    esac
  fi
fi

# What an install is found to be, and what was done about it. Printed at the end
# of every run, which is the point of --repair.
checks=""
check_ok()  { checks="${checks}  ok   $*
"; }
check_bad() { checks="${checks}  FIX  $*
"; }

if [ -n "$library" ] && [ -n "$nfs" ]; then
  usage_error "--library and --nfs are two answers to the same question; pick one."
fi

# ---- where the audiobooks are ----------------------------------------------

CANDIDATES="$TMPDIR_ABS/abs-candidates.$$"
: > "$CANDIDATES"
trap 'rm -f "$CANDIDATES"' EXIT INT TERM

if [ -n "$abs_container" ] && ! docker inspect "$abs_container" >/dev/null 2>&1; then
  die "there is no container called $abs_container."
fi

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
  while IFS="$(printf '\t')" read -r c_name c_net c_iport c_hend c_type c_src c_dst c_ver; do
    i=$((i + 1))
    printf '  %d) %s%s\n' "$i" "$c_name" "${c_ver:+  (v$c_ver)}"
    [ -n "$c_hend" ] && printf '       reachable at %s\n' "$c_hend"
    if [ "$c_type" = "volume" ]; then
      printf '       library      volume %s, which it sees at %s\n' "$c_src" "$c_dst"
    elif [ -n "$c_src" ]; then
      printf '       library      %s\n' "$c_src"
    fi
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
  d_type=$(printf '%s' "$chosen" | cut -f5)
  d_src=$(printf '%s' "$chosen" | cut -f6)
  d_dst=$(printf '%s' "$chosen" | cut -f7)

  if [ -n "$d_src" ] && [ -z "$nfs" ]; then
    if [ "$d_type" = "volume" ]; then theirs="volume $d_src"; else theirs="$d_src"; fi
    if [ -n "$library_volume" ]; then ours="volume $library_volume"; else ours="$library"; fi

    adopt=0
    if [ -z "$ours" ]; then
      adopt=1
    elif [ "$ours" != "$theirs" ]; then
      # Kept unless somebody says otherwise: a library set by hand may be set
      # that way on purpose. But a repair says so, because this is the commonest
      # way an install ends up looking at the wrong folder.
      if [ "$repair" -eq 1 ]; then
        say ""
        say "This install mounts:        $ours"
        say "AudiobookShelf's library is: $theirs"
        if confirm "Mount AudiobookShelf's library instead?"; then adopt=1; library_changed=1; fi
      fi
    else
      check_ok "the library mounted here is the one AudiobookShelf uses ($theirs)"
    fi

    if [ "$adopt" -eq 1 ]; then
      if [ "$d_type" = "volume" ]; then
        # The same volume, at the same path AudiobookShelf sees it at: every
        # path it reports is then a path here too, and there is no prefix to
        # get wrong.
        library_volume="$d_src"; library_target="$d_dst"; library=""
      else
        library="$d_src"; library_volume=""; library_target=""
      fi
      if [ "$repair" -eq 1 ]; then
        library_changed=1
        check_ok "now mounting AudiobookShelf's library ($theirs)"
      fi
    fi
  fi

  # What AudiobookShelf reports for its own folders is the path inside its
  # container, which is only /audiobooks by coincidence. When it differs, that
  # difference is the path prefix. A volume mounted where ABS mounts it has
  # none.
  if [ -z "$library_volume" ] && [ -n "$d_dst" ] && [ "$d_dst" != "/audiobooks" ]; then
    path_prefix="$d_dst"
  fi

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

if [ -z "$library" ] && [ -z "$nfs" ] && [ -z "$library_volume" ]; then
  say "abs-butler needs to see the same audiobooks AudiobookShelf does."
  say "Give the directory on this machine. An already-mounted NAS share is just a path."
  say ""
  library="$(ask 'Library directory' '--library')"
fi

if [ -n "$library" ]; then
  case "$library" in
    /*) : ;;
    [A-Za-z]:*) [ "$in_container" = "1" ] || die "the library path must be absolute (got '$library')." ;;
    *) die "the library path must be absolute (got '$library')." ;;
  esac
fi

# From a container, the host's filesystem is not here to look at; what Docker
# sees of it is checked below instead.
if [ -n "$library" ] && [ "$in_container" != "1" ]; then
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

# ---- what Docker sees --------------------------------------------------------
#
# The question that matters is not whether the library exists but whether a
# container sees books in it, and only Docker can answer that: a mapped drive
# exists for Windows and not for Docker Desktop, and a share that was not
# mounted yet exists as an empty folder. So a throwaway container mounts it
# exactly as abs-butler will, and says what it finds -- and whose it is, since
# on a volume or a network share that decides who may write, not the files.
if [ -n "$library_volume" ]; then library_desc="volume $library_volume"; else library_desc="$library"; fi

probe_library() {
  if [ -n "$library_volume" ]; then
    # Mounting a volume that does not exist would create it, empty.
    docker volume inspect "$library_volume" >/dev/null 2>&1 || return 1
    pl_mount="type=volume,src=$library_volume,dst=/probe,readonly,volume-nocopy"
  else
    pl_mount="type=bind,src=$library,dst=/probe,readonly"
  fi
  docker run --rm --user 0:0 --entrypoint sh --mount "$pl_mount" "$image" \
    -c 'stat -c "%u %g" /probe && ls -A /probe | wc -l' 2>/dev/null | tr '\n' ' '
}

if [ -n "$library$library_volume" ] && [ "$dry_run" -eq 0 ]; then
  note "checking what Docker sees in ${library_desc}…"
  probed=$(probe_library || true)
  # shellcheck disable=SC2086
  set -- $probed
  if [ $# -lt 3 ]; then
    if [ -n "$library_volume" ]; then
      die "there is no Docker volume called $library_volume."
    fi
    die "Docker cannot mount $library. If it is a mapped drive or a \\\\server\\share path, Docker Desktop cannot see it: mount the share as a volume instead (docs/docker.md, \"Libraries on a NAS\"), or point this at the volume AudiobookShelf uses with --library-volume."
  fi
  [ -n "$puid" ] || puid="$1"
  [ -n "$pgid" ] || pgid="$2"
  if [ "$3" -eq 0 ]; then
    check_bad "Docker sees nothing in $library_desc -- if it is a network share, check it is mounted"
    if [ "$repair" -eq 0 ] && ! confirm "Docker sees nothing in $library_desc. Install with it anyway?"; then
      die "stopped. Point it at the folder AudiobookShelf uses."
    fi
  else
    check_ok "Docker sees $3 $([ "$3" -eq 1 ] && echo entry || echo entries) in $library_desc"
  fi
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

# ---- updating unattended ---------------------------------------------------
#
# abs-butler does not update itself, and that stays true: replacing a running
# container takes the Docker socket, which is root on the host, and a web UI on
# the network should not hold it. What --auto-update adds is a job that runs on
# the host, as whoever ran this script, doing what an operator would type:
# pull, and recreate if the image moved.
#
# It only ever pulls the image. install.sh and docker-compose.yml are fetched
# from main, which is not a release, so running --update unattended would put
# unreleased code on a machine nobody is watching. An image tag moves only when
# a release is published. A release that also needs --update says so in the
# sidebar, as it always has.
AUTO_UPDATE_MARK="abs-butler-auto-update"
AUTO_UPDATE_UNIT="abs-butler-update"
UNIT_DIR="/etc/systemd/system"

# A system timer needs root to install. Without root, a user unit would need
# lingering turned on to fire while nobody is logged in, which is its own
# decision; a crontab line has no such catch.
use_systemd() {
  [ "$(id -u)" -eq 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1
}

crontab_without_ours() {
  crontab -l 2>/dev/null | grep -v "# $AUTO_UPDATE_MARK\$" || true
}

has_our_crontab_line() {
  command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q "# $AUTO_UPDATE_MARK\$"
}

# Rewritten on every run with --auto-update in effect, so --update also brings
# the job itself up to date.
write_update_script() {
  # cron starts with PATH=/usr/bin:/bin, which on macOS and many NAS systems
  # does not contain docker. Where it was found now is where it will be then.
  wus_docker_dir=$(dirname "$(command -v docker)")
  # Already covered by the fallbacks below, in the common case.
  case ":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:" in
    *":$wus_docker_dir:"*) wus_docker_dir="" ;;
  esac
  {
    printf '#!/bin/sh\n'
    printf '# Written by install.sh --auto-update, and rewritten by each run of it --\n'
    printf '# change the flags, not this file. Run it by hand to update now.\n'
    printf 'PATH="%s/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"\n' "${wus_docker_dir:+$wus_docker_dir:}"
    printf 'export PATH\n'
    cat <<'EOF'
set -eu
cd "$(dirname "$0")"

say() { printf '%s abs-butler: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Stopped on purpose is a decision this must not overrule.
cid=$(docker compose ps -q butler 2>/dev/null || true)
if [ -z "$cid" ]; then
  say "not running, so leaving it stopped. 'docker compose up -d butler' starts it."
  exit 0
fi
running=$(docker inspect -f '{{.Image}}' "$cid")

ref=$(sed -n 's/^BUTLER_IMAGE=//p' .env 2>/dev/null | tail -1)
[ -n "$ref" ] || ref="ghcr.io/cwpetrich/abs-butler:latest"

if ! docker compose pull -q butler; then
  say "could not pull $ref; trying again next time."
  exit 1
fi
pulled=$(docker image inspect -f '{{.Id}}' "$ref")

# Compared with what the container runs, not with what was here before the
# pull: an update put off last night is still owed tonight.
if [ "$pulled" = "$running" ]; then
  say "already current."
  exit 0
fi

version_of() {
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true
}
from=$(version_of "$running"); to=$(version_of "$pulled")

# A restart abandons whatever is running, and a run abandoned partway through
# organize leaves books half-moved. Asked of the running container, not of a
# fresh `cli` one: that would start the new version against the database while
# the old one still holds it. If the question cannot be answered at all, the
# update goes ahead -- skipping on every failure would mean never updating.
if docker compose exec -T butler node /app/dist/index.js runs --json --limit 20 2>/dev/null \
    | grep -Eq '"status": *"(running|queued)"'; then
  say "a run is in progress; updating to ${to:-$ref} next time instead of interrupting it."
  exit 0
fi

say "updating ${from:-?} -> ${to:-?}"
docker compose up -d butler

# Healthy is the image's own healthcheck; an image without one counts as up
# once it is running.
state=""
i=0
while [ "$i" -lt 24 ]; do
  cid=$(docker compose ps -q butler 2>/dev/null || true)
  state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
  case "$state" in healthy|running) break ;; esac
  i=$((i + 1))
  sleep 5
done

case "$state" in
  healthy|running)
    # The old image only, by id. `docker image prune` would also take anything
    # else on this host that happens to be dangling.
    docker image rm "$running" >/dev/null 2>&1 || true
    say "now on ${to:-$ref}."
    ;;
  *)
    # Put the old image back under the tag and recreate onto it, so a bad
    # release costs one failed restart rather than an outage until someone
    # notices. The next pull moves the tag forward again, and tries again.
    say "${to:-the new version} did not come up ($state); going back to ${from:-the previous one}."
    docker tag "$running" "$ref"
    docker compose up -d butler
    say "rolled back. 'docker compose logs butler' has what went wrong."
    exit 1
    ;;
esac
EOF
  } > update.sh
  chmod 755 update.sh
}

# The command that runs update.sh nightly. From a container there is no host
# scheduler to reach -- writing to this container's own crontab would schedule
# nothing -- so the job is the installer image itself, which is also the only
# form Windows can run: update.sh is a shell script, and the image is the shell.
auto_update_command() {
  if [ "$in_container" = "1" ]; then
    printf 'docker run --rm --pull always -v /var/run/docker.sock:/var/run/docker.sock -v "%s:/install" %s auto-update' \
      "${ABS_BUTLER_HOST_DIR:-$install_dir}" "$INSTALLER_IMAGE"
  else
    printf "/bin/sh '%s/update.sh'" "$install_dir"
  fi
}

install_auto_update() {
  write_update_script
  if [ "$in_container" = "1" ]; then
    # Said rather than done: scheduling on the host is the host's to do, and
    # guessing at it from in here would leave somebody believing in a nightly
    # job that does not exist.
    say ""
    say "Automatic updates need a scheduled task, which an installer in a container cannot"
    say "create. update.sh is written; schedule this, once a night:"
    say ""
    say "  $(auto_update_command)"
    say ""
    case "${ABS_BUTLER_HOST_DIR:-}" in
      [A-Za-z]:*)
        say "On Windows, in an administrator PowerShell:"
        say ""
        say "  schtasks /create /tn abs-butler-update /sc daily /st 04:00 /tr \"$(auto_update_command)\""
        ;;
      *)
        say "With cron (crontab -e):"
        say ""
        say "  17 4 * * * $(auto_update_command) >> '${ABS_BUTLER_HOST_DIR:-$install_dir}/update.log' 2>&1"
        ;;
    esac
    return 0
  fi
  if use_systemd; then
    cat > "$UNIT_DIR/$AUTO_UPDATE_UNIT.service" <<EOF
# Written by install.sh --auto-update.
[Unit]
Description=Update abs-butler to its latest published image
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$install_dir
ExecStart=/bin/sh "$install_dir/update.sh"
EOF
    # Persistent catches up on a night the machine was off. The random delay
    # keeps every install from pulling from ghcr.io in the same minute.
    cat > "$UNIT_DIR/$AUTO_UPDATE_UNIT.timer" <<EOF
# Written by install.sh --auto-update.
[Unit]
Description=Update abs-butler nightly

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$AUTO_UPDATE_UNIT.timer" >/dev/null 2>&1 \
      || { warn "could not enable $AUTO_UPDATE_UNIT.timer; 'systemctl status $AUTO_UPDATE_UNIT.timer' says why."; return 0; }
    # One schedule, not two, if an earlier run without root left a cron line.
    has_our_crontab_line && crontab_without_ours | crontab -
    note "automatic updates on: nightly between 04:00 and 05:00 (journalctl -u $AUTO_UPDATE_UNIT)"
  elif command -v crontab >/dev/null 2>&1; then
    iau_minute=$(od -An -tu2 -N2 /dev/urandom 2>/dev/null | tr -d ' \n')
    iau_minute=$(( ${iau_minute:-0} % 60 ))
    { crontab_without_ours
      printf "%s 4 * * * /bin/sh '%s/update.sh' >> '%s/update.log' 2>&1 # %s\n" \
        "$iau_minute" "$install_dir" "$install_dir" "$AUTO_UPDATE_MARK"
    } | crontab - || { warn "could not write the crontab entry."; return 0; }
    note "automatic updates on: nightly at 04:$(printf '%02d' "$iau_minute") (log in $install_dir/update.log)"
  else
    warn "nothing here to schedule it with: no systemd as root, and no crontab."
    warn "  $install_dir/update.sh is written; run it from whatever scheduler this machine has."
  fi
}

# Only removes what is there, so it is safe to call on every run with it off.
remove_auto_update() {
  rau_removed=0
  if [ "$in_container" = "1" ]; then
    if [ -f update.sh ]; then
      rm -f update.sh
      note "update.sh removed. Delete the scheduled task that ran it (Windows: schtasks /delete /tn abs-butler-update)."
    fi
    return 0
  fi
  if [ -f "$UNIT_DIR/$AUTO_UPDATE_UNIT.timer" ] && use_systemd; then
    systemctl disable --now "$AUTO_UPDATE_UNIT.timer" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$AUTO_UPDATE_UNIT.timer" "$UNIT_DIR/$AUTO_UPDATE_UNIT.service"
    systemctl daemon-reload
    rau_removed=1
  fi
  if has_our_crontab_line; then
    crontab_without_ours | crontab -
    rau_removed=1
  fi
  [ -f update.sh ] && { rm -f update.sh; rau_removed=1; }
  [ "$rau_removed" -eq 1 ] && note "automatic updates off; the nightly job is removed."
  return 0
}

# Updating unattended is opt-in, and asked about once: the answer is recorded
# either way, so a re-run does not ask again. --update never asks -- it changes
# no settings -- and without a terminal the answer is the default, off. --yes
# is not a yes here: it means "take the defaults", and the default is off.
if [ -z "$auto_update" ]; then
  if [ "$do_update" -eq 0 ] && [ "$in_container" != "1" ] && interactive; then
    say ""
    say "abs-butler can keep itself current: a nightly job on this machine pulls"
    say "each new release and restarts onto it, waiting out any run in progress."
    if confirm "Update automatically?"; then auto_update=1; else auto_update=0; fi
  else
    auto_update=0
    [ "$do_update" -eq 1 ] && note "automatic updates are available now: re-run with --auto-update to turn them on."
  fi
fi

# ---- what gets written -----------------------------------------------------

env_body="# Written by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ').
# Which generation of this file this is. install.sh reads it to work out what
# an older install still needs told; do not edit it by hand.
BUTLER_INSTALL_VERSION=$INSTALL_VERSION
# The AudiobookShelf URL, credentials and library root are NOT here — those are
# set in the browser and kept in abs-butler's database.
# Named so that running this from inside a container, from a folder of another
# name, still means the same install.
COMPOSE_PROJECT_NAME=$project
BUTLER_IMAGE=$image
BUTLER_BIND=$bind
BUTLER_PORT=$port
PUID=$puid
PGID=$pgid
# 1 when install.sh --auto-update scheduled update.sh to run nightly.
BUTLER_AUTO_UPDATE=$auto_update
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
if [ -n "$library_volume" ]; then
  env_body="${env_body}# The library is this Docker volume -- AudiobookShelf's own -- mounted at the
# same path AudiobookShelf sees it at.
BUTLER_LIBRARY_VOLUME=$library_volume
BUTLER_LIBRARY_TARGET=${library_target:-/audiobooks}
"
fi
env_body="${env_body}# Where the database is: folder (./data) or volume ($data_volume).
BUTLER_DATA=$data_mode
"

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
if [ "$data_mode" = "volume" ]; then
  data_line="      - butler-data:/data"
else
  data_line="      - ./data:/data"
fi

if [ -n "$library_volume" ]; then
  library_mount="      - abs-library:${library_target:-/audiobooks}:rw"
  # external: this install uses the volume and never creates, changes or
  # removes it. It belongs to AudiobookShelf, and so do its credentials.
  nfs_volume="
volumes:
  abs-library:
    external: true
    name: $library_volume
"
elif [ -n "$nfs" ]; then
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

override_body="# Written by install.sh. Re-run it (or --repair) rather than editing this.
#
# The database is in $([ "$data_mode" = "volume" ] && echo "the $data_volume volume" || echo "./data, beside this file, so that it is owned by PUID:PGID and stays that way"). Back
# that up and you have backed up everything abs-butler knows.
services:
  butler:
    volumes: !override
$data_line
$library_mount
$network_block  cli:
    volumes: !override
$data_line
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
  if [ "$auto_update" = "1" ]; then
    if use_systemd; then
      say "Would schedule:     update.sh nightly, via $UNIT_DIR/$AUTO_UPDATE_UNIT.timer"
    else
      say "Would schedule:     update.sh nightly, via crontab"
    fi
  fi
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
  # The installer image carries the compose file of its own release.
  if [ "$in_container" = "1" ] && [ -f /opt/abs-butler-installer/docker-compose.yml ]; then
    cp /opt/abs-butler-installer/docker-compose.yml "$1"
  elif command -v curl >/dev/null 2>&1; then
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

if [ "$data_mode" = "folder" ]; then
mkdir -p data || die "could not create $install_dir/data."
if ! chown "${puid}:${pgid}" data 2>/dev/null; then
  # Fine when the directory already belongs to them; a real problem otherwise,
  # and the symptom is unmistakable once it starts.
  if [ "$(stat -c %u data 2>/dev/null || stat -f %u data 2>/dev/null || echo '')" != "$puid" ]; then
    warn "could not give $install_dir/data to ${puid}:${pgid} — re-run as root if the log says 'unable to open database file'."
  fi
fi
fi

if [ "$do_update" -eq 1 ]; then
  note "pulling the current image"
  docker compose pull butler 2>&1 | grep -viE '^$' | tail -3 || true
fi

# A named volume starts out owned by the image's own user, and Docker copies that
# ownership into it again whenever it is empty. So it is created first, given to
# PUID:PGID, and given a file, so there is never an empty volume to re-copy into.
if [ "$data_mode" = "volume" ] && [ "$puid:$pgid" != "1000:1000" ]; then
  docker compose create butler >/dev/null 2>&1 || true
  docker run --rm --user 0:0 --entrypoint sh -v "$data_volume:/data" "$image" \
    -c "touch /data/.keep && chown -R $puid:$pgid /data" >/dev/null 2>&1 \
    || warn "could not give the $data_volume volume to ${puid}:${pgid}."
fi

note "pulling and starting"
docker compose up -d butler || die "compose failed to start. 'docker compose logs butler' has the detail. If the pull was denied, the image may be private — run 'docker login ghcr.io' first."

if [ "$auto_update" = "1" ]; then install_auto_update; else remove_auto_update; fi

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
if [ "$bind" = "127.0.0.1" ] || [ "$bind" = "localhost" ]; then
  url="http://127.0.0.1:${port}"
elif [ "$in_container" = "1" ]; then
  # A container has no idea what the machine it is on is called.
  url="http://localhost:${port}"
else
  url="http://$(host_address):${port}"
fi
# Asked from inside the container, the way its own healthcheck asks, so the
# answer is the same whether this runs on the host or in a container beside it.
while [ "$i" -lt 60 ]; do
  if docker exec abs-butler node -e "fetch('http://127.0.0.1:'+(process.env.BUTLER_PORT||13380)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -lt 60 ]; then
  check_ok "abs-butler is up and answering"
  # The last word on the library: what the running container itself sees.
  mount_path="${library_target:-/audiobooks}"
  seen=$(docker exec abs-butler sh -c "ls -A '$mount_path' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' \n')
  if [ "${seen:-0}" -gt 0 ]; then
    check_ok "the container sees the library at $mount_path"
  else
    check_bad "the container sees nothing at $mount_path"
  fi
  if [ -n "$abs_network" ]; then
    if docker inspect abs-butler --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw "$abs_network"; then
      check_ok "on AudiobookShelf's network ($abs_network)"
    else
      check_bad "not on AudiobookShelf's network ($abs_network)"
    fi
  fi
else
  check_bad "abs-butler did not answer within 60s -- 'docker compose logs butler' says why"
fi

# A repair that moved the library tells the saved connection where it went. The
# same values connecting would have used; Test on the Connection page checks
# them against real books either way.
if [ "$library_changed" -eq 1 ] && [ "$i" -lt 60 ]; then
  set -- configure --library-root "${library_target:-/audiobooks}"
  if [ -n "$path_prefix" ]; then set -- "$@" --path-prefix "$path_prefix"; else set -- "$@" --path-prefix "${library_target:-/audiobooks}"; fi
  if cf_out=$(docker compose run --rm -T cli "$@" 2>&1); then
    check_ok "the connection's library root is now ${library_target:-/audiobooks}"
  elif ! printf '%s' "$cf_out" | grep -q 'Not connected'; then
    check_bad "set the library root to ${library_target:-/audiobooks} on the Connection page"
  fi
fi

# ---- connect it -----------------------------------------------------------
#
# The one thing discovery cannot supply is a credential: /status is the only
# unauthenticated endpoint AudiobookShelf offers and it reveals nothing else.
# So the URL and the paths are filled in, and only the login is asked for.
connected=0
# A repair leaves the existing connection alone rather than signing in again.
if [ -n "$abs_url" ] && [ "$repair" -eq 0 ]; then
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
    set -- connect --url "$abs_url" --username "$abs_username" --library-root "${library_target:-/audiobooks}"
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

show_dir="${ABS_BUTLER_HOST_DIR:-$install_dir}"
if [ "$in_container" = "1" ]; then
  repair_cmd='docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer repair'
else
  repair_cmd="sh install.sh --repair"
fi

say ""
say "Checks:"
printf '%s' "$checks"
say ""
if [ "$i" -lt 60 ]; then
  note "up at $url"
fi

# A repair is done here: the rest is first-install instructions.
if [ "$repair" -eq 1 ]; then
  if printf '%s' "$checks" | grep -q '^  FIX'; then
    say ""
    say "Each FIX above says what is still wrong. Put it right and run the repair again,"
    say "from $show_dir:"
    say ""
    say "  $repair_cmd"
  else
    say "Nothing left to fix. Test on the Connection page confirms the paths against real books."
  fi
  exit 0
fi

if [ -n "$setup_code" ]; then
  cat <<EOF

  The UI is published on $bind, so setting the first password needs this code:

      $setup_code

  It is in the .env file in $show_dir as BUTLER_SETUP_CODE. Because it is set, the
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

  3. For file organizing, set the library root to ${library_target:-/audiobooks}. That is where
     this container sees $([ -n "$nfs" ] && echo "the NAS export" || echo "$library_desc"), whatever the path is outside it.
EOF
fi
cat <<EOF

Useful later, from $show_dir:

  docker compose logs -f butler
  docker compose run --rm cli status
  docker compose down

If anything stops working, from the same folder:

  $repair_cmd
EOF
