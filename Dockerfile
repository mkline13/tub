# Tub sync server. Runs plain HTTP behind a TLS-terminating reverse proxy
# (see deploy/ and README "Deploying with Docker and Caddy").
FROM oven/bun:1.3-slim

WORKDIR /app

# Install dependencies first so source edits don't invalidate this layer.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN bun install --frozen-lockfile --production --filter @mkline13/tub-server

COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src

# `tub` on PATH, so admin tasks work with `docker exec <container> tub ...`.
RUN printf '#!/bin/sh\nexec bun /app/packages/server/src/cli/index.ts "$@"\n' > /usr/local/bin/tub \
 && chmod +x /usr/local/bin/tub \
 && mkdir /data && chown bun:bun /data

# The database lives on a volume. TUB_BEHIND_PROXY allows plain HTTP on the
# container's network; only publish this port to a TLS-terminating proxy.
ENV TUB_DB=/data/tub.db \
    TUB_HOST=0.0.0.0 \
    TUB_PORT=8787 \
    TUB_BEHIND_PROXY=1
VOLUME /data
EXPOSE 8787
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e 'fetch("http://127.0.0.1:" + process.env.TUB_PORT + "/health").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))'

# `tub init` creates the database on first start and migrates it afterwards.
CMD ["sh", "-c", "tub init && exec tub serve"]
