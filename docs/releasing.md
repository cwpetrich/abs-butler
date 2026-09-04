# Releasing

Cutting a release is one command:

```bash
git tag v0.4.0
git push --tags
```

That fires `.github/workflows/release.yml`, which publishes the Docker image to GHCR and builds
both snap architectures. Everything below is the setup that has to exist first, and it is one-time.

## What runs when

| Workflow | Trigger | Publishes |
| --- | --- | --- |
| **CI** | every push to `main`, every PR | nothing — it validates, and keeps the built snap and an amd64 image as downloadable artifacts |
| **Release** | pushing a `v*` tag | the multi-arch Docker image, and the snap if store credentials are configured |

CI is deliberately incapable of publishing. Nothing reaches a user because a branch was merged.

## Before the first release

### 1. Make the GHCR package public

The first `docker push` to `ghcr.io` **creates the package as private**, and the workflow cannot
change that — it is a repository setting, not something a token can grant itself. So the first
release appears to succeed and then `docker pull` returns a 401 for everyone who is not you.

After the first release run: repository → **Packages** → `abs-butler` → **Package settings** →
**Change visibility** → Public. It stays public for every release after that.

While you are there, "Connect repository" links the package to the repo so it shows up on the repo
front page and inherits its README.

Verify from a machine that is not signed in:

```bash
docker pull ghcr.io/cwpetrich/abs-butler:latest
```

### 2. Register the snap name and add store credentials

Until this is done the snap job still runs — it builds both architectures and uploads them as
artifacts — but the publish step is skipped rather than failed, so a release is not blocked by it.

```bash
snapcraft register abs-butler          # once, and the name has to be free
snapcraft export-login --snaps abs-butler \
  --acls package_access,package_push,package_update,package_release -
```

That prints a credential blob. Copy it into the repository's
**Settings → Secrets and variables → Actions → New repository secret**, named
`SNAPCRAFT_STORE_CREDENTIALS`.

The credential **expires** (a year by default). When it does, the publish step starts failing while
everything else keeps working — re-run `export-login` and replace the secret.

## What a release produces

- `ghcr.io/cwpetrich/abs-butler:0.4.0`, `:0.4`, and `:latest`, each a manifest covering amd64 and
  arm64, so `docker pull` gets the right one with no flags.
- Two `.snap` files on the run's artifacts, and the same builds pushed to the store's stable
  channel.

`docker-compose.yml` points at `:latest`, so an existing install upgrades with:

```bash
docker compose pull butler && docker compose up -d butler
```

Pin to `:0.4` in `BUTLER_IMAGE` if you would rather take patch releases only.

## Version numbers

`package.json` is the single source of truth — the snap reads it via `craftctl set version`, and the
Docker tags come from the git tag. **Bump `package.json` and commit it before tagging**, or the snap
will publish a version that disagrees with its image.

```bash
npm version 0.4.0 --no-git-tag-version
git commit -am "Release 0.4.0"
git tag v0.4.0
git push && git push --tags
```

## If a release fails halfway

Use **Re-run jobs** on the original workflow run rather than re-tagging. It keeps the tag the run
was triggered from, which is where the version comes from; a fresh dispatch has no tag to read, and
the workflow is tag-only for exactly that reason.

Re-running a successful Docker publish is harmless — it overwrites the same tags with the same
content. Re-running a snap publish uploads a new revision to the store, which is also fine, just
noisier in the store's revision history.

## Trying a change before releasing it

Every CI run keeps the artifacts for 14 days, so a PR can be installed rather than only reviewed:

```bash
# from the run page: Artifacts → docker-image-amd64
docker load -i abs-butler-image.tar
docker run --rm -p 13380:13380 -v butler-test:/data abs-butler:ci

# from the run page: Artifacts → snap-amd64
sudo snap install --dangerous ./abs-butler_*.snap
```

`--dangerous` is required because the artifact is unsigned — it never went through the store.
