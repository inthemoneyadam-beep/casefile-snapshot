# CaseFile on Railway (docs/DEPLOY.md). One image: the API (TypeScript run by tsx) and the built client.
# The case itself never goes into the image: it lives on the Railway volume (/data), arrives through
# "Restore from a backup" on the setup screen, and .dockerignore/.railwayignore keep every private file out of the
# build (npm run deploy:check proves it).
FROM node:24-bookworm-slim

# - python3, make, g++: a fallback only. better-sqlite3-multiple-ciphers and better-sqlite3 ship ready-made N-API
#   binaries for linux-x64 glibc (they need glibc 2.34; bookworm has 2.36), so nothing is compiled unless a future
#   version stops shipping them.
# - chromium and fonts (Liberation for Arial/Helvetica, DejaVu for the rest): PDF packets.
# - tzdata: TZ (UTC here; the host sets its own zone, so set TZ to the case's local zone; Node also carries its own zone data). ca-certificates: HTTPS to the Anthropic API.
# - tini: PID 1, passes Railway's stop signal on and reaps Chromium's children.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ \
      chromium fonts-liberation fonts-dejavu-core \
      tzdata ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && command -v setpriv \
 && chromium --version

WORKDIR /app

# Dependencies first (cached while package-lock.json is unchanged). Dev dependencies too: tsx runs the server and
# Vite with the TanStack plugin builds the client (the plugin writes the route tree). NODE_ENV stays unset here,
# since npm would otherwise leave the dev dependencies out.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN sed -i 's/\r$//' scripts/docker-entrypoint.sh && chmod 0755 scripts/docker-entrypoint.sh

# The build, then a smoke test of the hosted server on this very system (encrypted SQLite, setup code, cookie,
# CSP, backups, MuPDF; Chromium is tried). A failure stops the build here instead of a crash after deploy.
RUN npm run build && test -f dist/index.html
RUN node --import tsx scripts/container-smoke.ts

# The commit Railway built from, for the startup log and /healthz (Railway passes it as a build argument).
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV CASEFILE_BUILD_SHA=${RAILWAY_GIT_COMMIT_SHA} \
    NODE_ENV=production \
    CASEFILE_HOSTED=1 \
    TZ=UTC \
    CASEFILE_CHROME_PATH=/usr/bin/chromium \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# The image files belong to root and are only read; the server runs as "node" (scripts/docker-entrypoint.sh hands
# the volume to that user, then drops root).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/server/index.ts"]
