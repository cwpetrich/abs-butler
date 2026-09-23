#!/bin/sh
# Runs install.sh against the host's Docker, from inside a container.
#
# The one thing a container cannot see is where it is on the host. install.sh
# writes compose files with relative paths (./data), and compose turns those
# into absolute ones before handing them to the daemon -- which resolves them on
# the host. Resolved against /install they would point nowhere. So the host path
# of /install is read back from this container's own mounts, recreated here as a
# link to /install, and everything runs from there: the paths compose sends are
# then the host's own.
set -eu

die() { printf 'abs-butler: %s\n' "$*" >&2; exit 1; }

# Plain words for the three things anybody runs this for; flags pass through.
case "${1:-}" in
  -h|--help|help) exec sh /opt/abs-butler-installer/install.sh --help ;;
  install) shift ;;
  repair) shift; set -- --repair "$@" ;;
  update) shift; set -- --update "$@" ;;
  # The nightly job, for a host whose scheduler cannot run a shell script
  # itself. install.sh --auto-update writes update.sh; this runs it, from the
  # folder whose name the host knows.
  auto-update) auto_update_run=1 ;;
esac

[ -S /var/run/docker.sock ] || die "the Docker socket is not mounted. Add: -v /var/run/docker.sock:/var/run/docker.sock"
docker info >/dev/null 2>&1 || die "Docker is not answering on the mounted socket."

src="${ABS_BUTLER_HOST_DIR:-}"
if [ -z "$src" ]; then
  src=$(docker inspect "$(hostname)" \
    --format '{{range .Mounts}}{{if eq .Destination "/install"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
fi
[ -n "$src" ] || die 'no folder is mounted to install into. Run it from that folder with: -v "${PWD}:/install"'

# The same folder has two names: the one the person typed (C:\abs-butler) and
# the one the daemon knows it by, which on Docker Desktop is a path inside its
# own Linux VM. Compose sends the daemon's name, so that is the one needed
# here -- and it is not guessable: the two Docker Desktop backends differ, and
# a wrong guess would fail much later, as a bind mount of an empty folder.
#
# So each candidate is tried rather than assumed: a marker is written here, and
# a throwaway container mounts the candidate and looks for it. The one that
# finds it is the folder, proven rather than believed.
marker=".abs-butler-installer-probe.$$"
: > "/install/$marker" 2>/dev/null || die "/install is not writable. Mount a folder you own."
# The installer's own image, so the probe pulls nothing.
probe_image=$(docker inspect "$(hostname)" --format '{{.Config.Image}}' 2>/dev/null || true)
[ -n "$probe_image" ] || probe_image="alpine"

sees_marker() {
  docker run --rm --pull never --entrypoint sh \
    --mount "type=bind,src=$1,dst=/probe,readonly" "$probe_image" \
    -c "[ -f '/probe/$marker' ]" >/dev/null 2>&1
}

# Named outright, for a setup neither backend below matches.
if [ -n "${ABS_BUTLER_DAEMON_DIR:-}" ]; then
  candidates="$ABS_BUTLER_DAEMON_DIR"
else
  candidates="$src"
fi
case "$src" in
  [A-Za-z]:\\*|[A-Za-z]:/*)
    drive=$(printf '%s' "$src" | cut -c1 | tr '[:upper:]' '[:lower:]')
    rest=$(printf '%s' "$src" | cut -c3- | tr '\\' '/')
    # WSL 2 backend, then the Hyper-V one.
    [ -n "${ABS_BUTLER_DAEMON_DIR:-}" ] || candidates="$src
/run/desktop/mnt/host/$drive$rest
/host_mnt/$drive$rest"
    ;;
esac

# One candidate per line, and a folder name may hold spaces.
work=""
old_ifs="$IFS"
IFS='
'
for candidate in $candidates; do
  IFS="$old_ifs"
  [ -n "$candidate" ] || continue
  if sees_marker "$candidate"; then work="$candidate"; break; fi
  IFS='
'
done
IFS="$old_ifs"
rm -f "/install/$marker"

if [ -z "$work" ]; then
  printf 'abs-butler: could not work out where %s is, as Docker knows it. Tried:\n' "$src" >&2
  printf '%s\n' "$candidates" | sed 's/^/  /' >&2
  die "install into a folder on a local drive that Docker Desktop shares -- a network path (\\\\server\\share) or a drive it cannot see will not work. To name the path yourself, set ABS_BUTLER_DAEMON_DIR."
fi

if [ "$work" != "/install" ]; then
  [ -e "$work" ] && [ ! -L "$work" ] && die "$work already exists inside the installer; run it from another folder."
  mkdir -p "$(dirname "$work")"
  ln -sfn /install "$work"
fi
cd "$work"

# What to call the folder when talking to the person who ran this: the path as
# their own machine names it.
ABS_BUTLER_HOST_DIR="$src"
export ABS_BUTLER_HOST_DIR

if [ "${auto_update_run:-0}" = "1" ]; then
  [ -f ./update.sh ] || die "there is no update.sh here. Turn automatic updates on first: ... repair --auto-update"
  exec sh ./update.sh
fi

exec sh /opt/abs-butler-installer/install.sh --dir "$work" "$@"
