# Deploy

## Local

```bash
cp .env.example .env
# edit .env — fill CLAUDE_CODE_OAUTH_TOKEN and TG_TOKEN_* for the roles you use
# Agent SDK is selected automatically when the OAuth token is present.
# Set USE_AGENT_SDK=false and ANTHROPIC_API_KEY only for the raw API fallback.
docker compose up -d
docker compose logs -f agent-team
```

Mini App is served by the main process at `http://localhost:8787`.
For standalone Mini App dev (nginx-served `dist/` only):

```bash
docker compose --profile miniapp-dev up miniapp-dev   # → http://localhost:8080
```

## Production (VPS)

Same flow as local: `cp .env.example .env`, edit, `docker compose up -d`.
This runs alongside (or as a replacement for) the existing `agent-team.service`
systemd unit — pick one. Don't run both at once.

### nginx reverse-proxy snippet

`/etc/nginx/sites-available/agents.example.com`:

```nginx
server {
  listen 443 ssl http2;
  server_name agents.example.com;

  ssl_certificate     /etc/letsencrypt/live/agents.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/agents.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Operations

- Logs: `docker compose logs -f agent-team`
- Restart: `docker compose restart agent-team`
- Stop: `docker compose down`
- Backups: SQLite snapshots and memory exports land in `./backups/` on the host
  (mounted into the container). Rotate / sync off-box from there.
- Persistent state on host: `./data` (SQLite), `./memory` (wiki), `./backups`.
