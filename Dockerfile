# syntax=docker/dockerfile:1

# ---- build stage: full dependencies, compile server and UI ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---- runtime stage: production dependencies only ----
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    BUTLER_DATA_DIR=/data \
    BUTLER_HOST=0.0.0.0 \
    BUTLER_PORT=8478

# tini reaps zombies and forwards SIGTERM, so `serve` shuts down cleanly and a
# scheduled run is not truncated mid-write.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/abs-butler-entrypoint
RUN chmod +x /usr/local/bin/abs-butler-entrypoint

# The database lives here. Mount a volume or it is lost with the container.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

EXPOSE 8478

# The node image ships a `node` user at uid/gid 1000. Override at run time with
# `--user $(id -u):$(id -g)` so files written by `organize` keep your ownership.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BUTLER_PORT||8478)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/abs-butler-entrypoint"]
# Default to the web UI; pass any other subcommand to use the CLI instead.
CMD ["serve"]
