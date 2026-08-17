#!/bin/sh
# Runs the abs-butler CLI once, or on a repeating interval when BUTLER_SCHEDULE
# is set. Every argument is passed straight through to the CLI.
set -eu

CLI="/app/dist/index.js"

# Accepts 900, 15m, 6h, or 1d and prints seconds.
parse_interval() {
  value="$1"
  number="${value%[smhd]}"
  unit="${value#"$number"}"

  case "$number" in
    '' | *[!0-9]*)
      echo "abs-butler: BUTLER_SCHEDULE must be a number optionally followed by s/m/h/d (got '$value')" >&2
      exit 2
      ;;
  esac

  case "$unit" in
    '' | s) echo "$number" ;;
    m) echo $((number * 60)) ;;
    h) echo $((number * 3600)) ;;
    d) echo $((number * 86400)) ;;
  esac
}

if [ -z "${BUTLER_SCHEDULE:-}" ]; then
  exec node "$CLI" "$@"
fi

# A schedule needs a subcommand to repeat. Checking for "no arguments" is not
# enough: the image's default CMD is --help, so an operator who sets a schedule
# but forgets the command would otherwise loop printing usage forever.
case "${1:-}" in
  '' | -*)
    echo "abs-butler: BUTLER_SCHEDULE is set but no subcommand was given (try: audit)" >&2
    exit 2
    ;;
esac

interval="$(parse_interval "$BUTLER_SCHEDULE")"
echo "abs-butler: running '$*' every ${interval}s" >&2

# Wake promptly on SIGTERM instead of sitting out the remaining sleep.
trap 'echo "abs-butler: stopping" >&2; exit 0' TERM INT

first=1
while true; do
  if node "$CLI" "$@"; then
    first=0
  elif [ "$first" -eq 1 ]; then
    # Nothing has ever succeeded, so this is almost certainly bad configuration
    # rather than a blip. Exit loudly and let the restart policy surface it,
    # instead of looping quietly on an error that will never fix itself.
    echo "abs-butler: first scheduled run failed — exiting so the problem is visible" >&2
    exit 1
  else
    # Once a run has worked, later failures are treated as transient.
    echo "abs-butler: run failed, retrying at the next interval" >&2
  fi

  # Backgrounded sleep + wait so the TERM trap fires immediately.
  sleep "$interval" &
  wait $!
done
