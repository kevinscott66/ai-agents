# Agent Team Production Deployment

> ⚠️ **DEPRECATED (2026-06-06).** The **Caddy-based** scripts in this directory are **no longer used**.
> Production migrated to `203.0.113.10` where HTTPS is served by **nginx** (vhost
> `agents.example.com`, `listen 8443 ssl → 127.0.0.1:8787`; port 443 belongs to an
> unrelated xray VPN). TLS is Let's Encrypt via certbot (auto-renew, webroot). The old
> `203.0.113.11` references below are historical. See
> `.claude/memory/notes/server-migration-2026-06-06.md` for the live setup.
>
> **▶️ To deploy now, run `deploy/deploy.sh`** (one command: snapshot → rsync `agent/` → bun install →
> rebuild Mini App → restart → health-check, with rollback hint on failure). `DRY_RUN=1 deploy/deploy.sh`
> previews changes without restarting. The Caddy/blue-green files below are kept for reference only.

This directory contains production deployment configurations for the agent-team project.

## Overview

The deployment uses Caddy as a reverse proxy to provide HTTPS termination with automatic Let's Encrypt certificates for the Mini App and Mac Bridge WebSocket endpoints.

## Files

- `Caddyfile` - Caddy reverse proxy configuration with automatic HTTPS
- `caddy.service` - Systemd service unit for Caddy
- `setup-caddy.sh` - Installation script for VPS setup
- `README.md` - This documentation

## Architecture

```
Internet (HTTPS :8443) → nginx → agent-team (:8787)
                    ↓ 
                 Let's Encrypt
```

## Prerequisites

1. **DNS Setup**: Ensure `agents.example.com` points to your VPS IP
   ```bash
   dig +short agents.example.com A
   # Should return the current VPS address (203.0.113.10 at migration time)
   ```

2. **Agent Team Running**: the agent-team service must be running on port 8787;
   the public Mini App entry point is `https://agents.example.com:8443`.
   ```bash
   systemctl status agent-team
   ss -tlnp | grep :8787
   ```

## Installation

1. **Copy deployment files to VPS**:
   ```bash
   # Files are deployed via GitHub Actions deploy workflow
   # Or manually, with the configured deploy user:
   DEPLOY_HOST=agent-deploy@203.0.113.10 deploy/deploy.sh
   ```

2. **Run setup script on VPS** (with an administrator account and `sudo`):
   ```bash
   ssh <admin-user>@203.0.113.10
   cd /opt/agent-team
   sudo bash deploy/setup-caddy.sh
   ```

3. **Start Caddy**:
   ```bash
   systemctl start caddy
   systemctl enable caddy
   ```

4. **Update environment variables**:
   ```bash
   # Add to /opt/agent-team/.env:
   echo "MINIAPP_PUBLIC_URL=https://agents.example.com:8443" >> /opt/agent-team/.env
   
   # Restart agent-team to pick up new env var
   systemctl restart agent-team
   ```

## Verification

1. **Check Caddy status**:
   ```bash
   systemctl status caddy
   journalctl -u caddy -f
   ```

2. **Test HTTPS endpoint**:
   ```bash
   curl -fsS https://agents.example.com:8443/api/health
   # Should return: {"ok":true,"mac_online":false,"timestamp":"..."}
   ```

3. **Test Mini App in Telegram**:
   - Open any chat with @MultiAgentPanelbot
   - Use the Mini App button or menu command
   - Should load over HTTPS without certificate warnings

## Monitoring

- **Caddy logs**: `/var/log/caddy/agents.log` (JSON format)
- **Access logs**: `/var/log/caddy/access.log` 
- **System logs**: `journalctl -u caddy -f`
- **Health check**: Built into Caddy config, checks `/api/health` every 30s

## Security Features

- **Automatic HTTPS**: Let's Encrypt certificates auto-renewed
- **Rate limiting**: 100 requests/min per IP, 60 API requests/min
- **Security headers**: XSS protection, content type sniffing prevention
- **CSP**: Content Security Policy optimized for Telegram Web Apps
- **Connection limits**: Keepalive pools, timeouts configured

## Troubleshooting

### Certificate Issues
```bash
# Check certificate status
caddy list-certificates

# Force certificate renewal
systemctl stop caddy
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

### Port Conflicts
```bash
# Check what's using ports 80/443
ss -tlnp | grep -E ':(80|443)\b'

# If nginx is running, you may need to disable it or reconfigure
systemctl stop nginx
systemctl disable nginx
```

### DNS Issues
```bash
# Test DNS propagation
dig +short agents.example.com A @1.1.1.1
dig +short agents.example.com A @8.8.8.8

# Test from different locations
curl --resolve agents.example.com:8443:203.0.113.10 \
  https://agents.example.com:8443/api/health
```

### Backend Issues
```bash
# Ensure agent-team is running and listening
systemctl status agent-team
ss -tlnp | grep :8787

# Test direct connection to backend
curl -fsS http://localhost:8787/api/health
```

## Rollback

To rollback to nginx if needed:
```bash
systemctl stop caddy
systemctl disable caddy
systemctl start nginx
systemctl enable nginx
```

## Performance

- **Connection pooling**: 10 keepalive connections with 30s timeout
- **Health checks**: Backend health monitored every 30s
- **Log rotation**: 100MB max size, keep 5 files
- **Rate limiting**: Prevents abuse while allowing normal usage

## Updates

Configuration updates can be applied without downtime:
```bash
# Test new config
caddy validate --config /etc/caddy/Caddyfile

# Hot reload (zero downtime)
systemctl reload caddy
```
