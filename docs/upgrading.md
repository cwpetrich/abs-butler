[abs-butler](../README.md) › Upgrading from older versions

# Upgrading from older versions

## Upgrading to 0.4

The database migrates on first start; nothing to do there. Two things changed around it:

- **The Docker UI is published on loopback now.** `docker-compose.yml` used to publish on every
  interface, which put the anonymous first-run setup page in front of the whole network. It now
  binds `127.0.0.1` by default. If you reached abs-butler from another machine, set
  `BUTLER_BIND=0.0.0.0` in `.env` to get that back.
- **`BUTLER_PORT` works properly.** It was both the app's listen port and the host side of the port
  mapping, so setting it to anything but `13380` moved the listener while the mapping stayed put and
  the UI simply vanished. Both sides follow it now, so an existing `BUTLER_PORT` that appeared to do
  nothing will start taking effect.

New, and optional: connecting with an admin username and password instead of an API token, and
`install.sh` for setting up beside AudiobookShelf.

## Upgrading from 0.3

Nothing to do — the database migrates on first start, adding the provider answer cache.

Two things are new and both are **off or empty until you act**:

- `normalize` appears as a command, and `normalize --apply` is refused until **Allow metadata
  rewrite** is switched on in Settings. Existing schedules are untouched.
- **Audnexus** joins the provider list for new installs. An existing install keeps the provider list
  it already had, so add `audnexus` in Settings → Metadata providers to get narrator and series
  data. Nothing else changes if you do not.

The first `metadata` or `rate` run after upgrading is the usual speed; the ones after it are much
faster, since answers are now cached.

## Upgrading from 0.2

Your database migrates automatically on first start. Because 0.2 could hold several servers and 0.3
holds one, **the first server configured becomes the connection**, and runs and schedules belonging
to the others are removed rather than silently re-attributed to a server they never ran on. Settings
and the surviving server's history are kept.

Two things change in `.env`, which is now almost empty:

- `BUTLER_PASSWORD` is ignored. Passwords are set in the UI and stored as a salted hash, so you go
  through the setup screen once on first start.
- `BUTLER_SECRET` still works and takes precedence over the generated key file — but if you unset
  it, abs-butler cannot read a token that was sealed with it. Re-enter the API token after removing
  it, or leave it in place.
