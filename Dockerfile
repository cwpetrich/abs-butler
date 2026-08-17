# syntax=docker/dockerfile:1

# ---- build stage: full dependencies, compile TypeScript ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production dependencies only ----
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM, which matters in scheduled mode
# where the process sleeps between runs.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/abs-butler-entrypoint
RUN chmod +x /usr/local/bin/abs-butler-entrypoint

# The node image ships a `node` user at uid/gid 1000. Override at run time with
# `--user $(id -u):$(id -g)` so files written by `organize` keep your ownership.
USER node

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/abs-butler-entrypoint"]
CMD ["--help"]
