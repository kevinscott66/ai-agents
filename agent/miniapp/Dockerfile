# syntax=docker/dockerfile:1.7
# ---- build stage ----
FROM oven/bun:1.2-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .
RUN bun run build

# ---- serve stage ----
FROM nginx:alpine AS serve

# Custom nginx config with proper cache headers.
# - /assets/ → immutable, 1 year
# - /index.html → no-store (always re-validate)
RUN rm /etc/nginx/conf.d/default.conf
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # Hashed asset bundle — safe to cache forever.
  location /assets/ {
    access_log off;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
  }

  # SPA entry — never cache.
  location = /index.html {
    add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    expires off;
    try_files $uri =404;
  }

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
