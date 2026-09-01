# syntax=docker/dockerfile:1.7
# ---- deps stage: install production dependencies only ----
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app

# Copy manifests; bun.lock (text lockfile) is present in this repo.
COPY package.json bun.lock* ./

# Production install (skip devDependencies)
RUN bun install --production --frozen-lockfile || bun install --production

# ---- runtime stage ----
FROM oven/bun:1.2-alpine AS runtime
WORKDIR /app

# wget is provided by busybox in alpine and is sufficient for HEALTHCHECK
ENV NODE_ENV=production \
    MINIAPP_PORT=8787

# Bring in installed deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy source (note: .dockerignore strips data/memory/backups/node_modules/etc.)
COPY . .

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8787/api/health >/dev/null 2>&1 || exit 1

CMD ["bun", "orchestrator-team.ts"]
