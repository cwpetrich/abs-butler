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
esac

[ -S /var/run/docker.sock ] || die "the Docker socket is not mounted. Add: -v /var/run/docker.sock:/var/run/docker.sock"
docker info >/dev/null 2>&1 || die "Docker is not answering on the mounted socket."

src=$(docker inspect "$(hostname)" \
  --format '{{range .Mounts}}{{if eq .Destination "/install"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
[ -n "$src" ] || die 'no folder is mounted to install into. Run it from that folder with: -v "${PWD}:/install"'

# Docker Desktop on Windows reports a folder as C:\... ; the daemon, which runs
# in Linux, knows the same folder under /run/desktop/mnt/host/c/...
case "$src" in
  [A-Za-z]:\\*|[A-Za-z]:/*)
    drive=$(printf '%s' "$src" | cut -c1 | tr '[:upper:]' '[:lower:]')
    rest=$(printf '%s' "$src" | cut -c3- | tr '\\' '/')
    work="/run/desktop/mnt/host/$drive$rest"
    ;;
  *) work="$src" ;;
esac

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
exec sh /opt/abs-butler-installer/install.sh --dir "$work" "$@"
