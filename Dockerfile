# syntax=docker/dockerfile:1

# ── Stage 1: build the desktop client's web bundle ──
# The server serves this bundle as a plain SPA for any browser on the LAN,
# in addition to the native Electron app. See server/src/index.js — it
# resolves ../../desktop/dist relative to itself, so the runtime stage below
# reproduces that same relative layout.
FROM node:24-alpine AS desktop-build
WORKDIR /app/desktop
COPY desktop/package.json desktop/package-lock.json ./
RUN npm ci
COPY desktop/ ./
RUN npm run build

# ── Stage 2: install server production dependencies only ──
FROM node:24-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 3: minimal runtime image ──
FROM node:24-alpine AS runtime

# Dedicated unprivileged user — the process never needs root once files are
# in place, and the base image otherwise defaults to running as root. The
# user name predates the CentyChat rename; it is an internal identifier that
# nobody sees, so it stays "mychat".
RUN addgroup -S mychat && adduser -S mychat -G mychat

WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=desktop-build /app/desktop/dist ../desktop/dist

# server/data (SQLite DB, uploads, backups, the auto-generated JWT secret)
# MUST be mounted as a volume in production — see docker-compose.yml. Without
# it, every `docker compose up` after a rebuild starts from an empty
# database and a brand new JWT secret (logging everyone out).
RUN mkdir -p /app/server/data && chown -R mychat:mychat /app/server/data

USER mychat

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 2004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2004/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
