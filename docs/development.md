[abs-butler](../README.md) › Development

# Development

```bash
npm run typecheck    # server and web
npm test
npm run build

npm run dev:web      # Vite dev server on :5473, proxying /api to :13380
```

Layout: `src/core/` holds the logic and task runners, `src/commands/` is thin CLI presentation,
`src/db/` is the SQLite layer, `src/web/` is the HTTP API, and `web/` is the React UI. The CLI and
the job runner call the same task functions, so a scheduled run and a typed one take exactly the same
code path.

Two modules in `src/core/` are worth reading before changing anything that talks to a provider:
`matching.ts` decides whether a result describes the book in hand and how strongly, and `lookup.ts`
is the single door every provider call goes through, so caching and scoring cannot be bypassed by
accident.

CI runs typecheck, tests (on Node 24 and on 22.13, the floor `engines` declares), and a build on
every push, plus the Docker image for amd64 and arm64 and the snap for amd64. Releases are cut by
pushing a `v*` tag, which publishes the multi-arch image and both snap architectures.
