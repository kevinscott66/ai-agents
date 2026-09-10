#!/bin/bash
# test-config.sh - Validate deployment configuration files
# Can be run locally before deployment

set -euo pipefail

# Все пути ниже — относительные (`Caddyfile`, `caddy.service`,
# `setup-caddy.sh`), то есть скрипт работал только из самого `deploy/`. Из корня
# репозитория — то есть ровно оттуда, откуда запускают всё остальное, и как
# написано в его же собственной шапке «run locally before deployment», — он
# падал на первой же проверке: «❌ Caddyfile missing», exit 1. Отличить это от
# настоящей поломки конфигурации по выводу нельзя.
#
# Идиома та же, что в deploy/deploy.sh:31.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Agent Team Deploy Config Test ==="

# Check required files exist
echo "Checking required files..."
files=(
    "Caddyfile"
    "caddy.service" 
    "setup-caddy.sh"
    "README.md"
)

for file in "${files[@]}"; do
    if [[ -f "$file" ]]; then
        echo "✅ $file exists"
    else
        echo "❌ $file missing"
        exit 1
    fi
done

# Validate Caddyfile syntax if Caddy is available
if command -v caddy &> /dev/null; then
    echo "Validating Caddyfile syntax..."
    if caddy validate --config Caddyfile --adapter caddyfile; then
        echo "✅ Caddyfile syntax valid"
    else
        echo "❌ Caddyfile syntax error"
        exit 1
    fi
else
    echo "⚠️  Caddy not available - skipping syntax check"
fi

# Check systemd service syntax
echo "Checking systemd service file..."
if systemd-analyze verify caddy.service 2>/dev/null; then
    echo "✅ Systemd service file valid"
elif command -v systemd-analyze &> /dev/null; then
    echo "⚠️  Systemd service validation warnings (may be OK)"
    systemd-analyze verify caddy.service || true
else
    echo "⚠️  systemd-analyze not available - skipping service check"
fi

# Check script permissions
if [[ -x setup-caddy.sh ]]; then
    echo "✅ setup-caddy.sh is executable"
else
    echo "❌ setup-caddy.sh is not executable"
    exit 1
fi

# Check for required domain in Caddyfile
if grep -q "agents.example.com" Caddyfile; then
    echo "✅ Domain configured in Caddyfile"
else
    echo "❌ Domain not found in Caddyfile"
    exit 1
fi

# Check reverse proxy configuration
if grep -q "reverse_proxy localhost:8787" Caddyfile; then
    echo "✅ Reverse proxy configured for port 8787"
else
    echo "❌ Reverse proxy configuration missing"
    exit 1
fi

echo ""
echo "✅ All configuration tests passed!"
echo ""
echo "Ready for deployment. Next steps:"
echo "1. Ensure DNS: agents.example.com → 203.0.113.10"  
echo "2. Deploy files to VPS: DEPLOY_HOST=agent-deploy@203.0.113.10 deploy/deploy.sh"
echo "3. Run setup: ssh <admin-user>@203.0.113.10 'cd /opt/agent-team && sudo bash deploy/setup-caddy.sh'"
echo "4. Start service: ssh <admin-user>@203.0.113.10 'sudo systemctl start caddy'"
echo "5. Test: curl -fsS https://agents.example.com/api/health"
