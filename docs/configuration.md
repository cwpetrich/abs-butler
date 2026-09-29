[abs-butler](../README.md) › Configuration

# Configuration

Everything is edited in the UI and stored in the database. Only a few deployment facts stay outside
it, and none of them is a secret. Under snap they are `snap set abs-butler port=…` and friends;
everywhere else they are environment variables:

| Variable | Purpose |
| --- | --- |
| `BUTLER_DATA_DIR` | Where the database and encryption key live. Defaults to `~/.local/share/abs-butler`, and `/data` in Docker. |
| `BUTLER_HOST` / `BUTLER_PORT` | Listen address *inside* the process. Defaults to `0.0.0.0:13380` — one above AudiobookShelf's `13378` and `abs-sync`'s `13379`, so the tools for one server sit together. |
| `BUTLER_BIND` | Docker only: which host address the compose file publishes on. Defaults to `127.0.0.1`, so the UI is reachable from the machine it runs on and nowhere else. Set it to `0.0.0.0` to reach abs-butler from another machine — and read the note under [About that first-run password](install.md#about-that-first-run-password) before you do. |

The listen address deliberately stays out of the UI: a wrong value set there would lock you out of
the only thing that could fix it, and under Docker the internal port is remapped host-side anyway.

Two optional variables exist for hardening: `BUTLER_SETUP_CODE` (above) and `BUTLER_SECRET`, which
lets you manage the encryption key yourself instead of letting abs-butler generate one.

## Credentials at rest

Connecting with a username and password stores neither: they are exchanged for an API token in a
single request, and only that token is kept. Leave the secret off the command line and `connect`
asks for it at the terminal without echoing it, which also keeps it out of the shell history. With
no terminal attached — a container started without a TTY, or a CI job — it does not wait for an
answer nobody can give: it exits naming the flag to pass instead. The AudiobookShelf API token is sealed with AES-256-GCM
before it is written to the database. The
key lives in `secret.key` beside the database — deliberately *not in* it, since a key stored next to
its own ciphertext is obfuscation rather than encryption. The point is that a copy of the database,
which is what a backup or a support bundle contains, is not a copy of your credentials.

It generates itself on first use, so encryption is on by default rather than something you have to
remember to turn on. You can rotate it from Settings, which re-encrypts the stored token under the
new key rather than orphaning it.

**Back up `BUTLER_DATA_DIR` as a unit** — it holds the database *and* the key. If you want them
separated, back up `abs-butler.db` alone and keep `secret.key` somewhere else.
