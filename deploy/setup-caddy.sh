#!/bin/bash
# setup-caddy.sh - Install and configure Caddy reverse proxy for agent-team
# Run as root on the VPS: bash /opt/agent-team/deploy/setup-caddy.sh

set -euo pipefail

# Источник конфигов — каталог самого скрипта. Раньше здесь был захардкоженный
# /opt/agent-team/deploy/, которого на хосте не существует: deploy/deploy.sh
# синхронизирует только agent/ → /opt/agent-team/. Скрипт запускают из клона
# репозитория, где бы тот ни лежал.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Единственный путь к боевому конфигу: сюда кладём, это же валидируем, это же
# читает caddy.service.
CADDYFILE_DEST="/etc/caddy/Caddyfile"

echo "=== Agent Team Caddy Setup ==="
echo "Installing Caddy and configuring HTTPS reverse proxy for agents.example.com"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "ERROR: This script must be run as root (use sudo)"
   exit 1
fi

# Аудит 2026-08-12: проверка занятости :443 стояла В КОНЦЕ скрипта и была
# всего лишь «⚠️ may conflict with Caddy» — а `systemctl enable caddy` к тому
# моменту уже отработал. То есть на этом хосте скрипт молча ставил в автозапуск
# сервис, который после первого же ребута полез бы за :443 — портом стороннего
# xray VPN. CLAUDE.md про него говорит прямо: «порт 443 на этом хосте занят
# сторонним xray VPN — НЕ трогать». Caddy с автоматическим HTTPS слушает :443
# по умолчанию, поэтому проверка переехала СЮДА и стала отказом, а не
# предупреждением. Прод сейчас ходит через nginx на :8443 — Caddy тут
# альтернативный путь, и включать его вслепую нельзя.
if command -v ss &>/dev/null && ss -tlnp | grep -q ':443\b'; then
    echo "ERROR: порт 443 уже занят — вероятно xray VPN. Caddy его отберёт."
    ss -tlnp | grep ':443' || true
    echo "Если Caddy здесь действительно нужен, сначала явно решите судьбу :443"
    echo "и пропишите Caddy другой порт в deploy/Caddyfile."
    exit 1
fi
if command -v ss &>/dev/null && ss -tlnp | grep -q ':80\b'; then
    echo "ERROR: порт 80 уже занят — Caddy не сможет пройти ACME HTTP-01."
    ss -tlnp | grep ':80' || true
    exit 1
fi

# Create caddy user if it doesn't exist
if ! id "caddy" &>/dev/null; then
    echo "Creating caddy user..."
    useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
fi

# Install Caddy if not already installed
if ! command -v caddy &> /dev/null; then
    echo "Installing Caddy..."
    
    # Install dependencies
    apt update
    apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    
    # Add Caddy official repository
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    
    # Install Caddy
    apt update
    apt install -y caddy
    
    echo "Caddy installed successfully"
else
    echo "Caddy already installed at $(which caddy)"
fi

# Create log directory
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
chmod 755 /var/log/caddy

# Copy configuration files
if [[ ! -f "$SCRIPT_DIR/Caddyfile" ]]; then
    echo "ERROR: нет $SCRIPT_DIR/Caddyfile — запускайте скрипт из каталога deploy/"
    exit 1
fi
if [[ ! -f "$SCRIPT_DIR/caddy.service" ]]; then
    echo "ERROR: нет $SCRIPT_DIR/caddy.service — запускайте скрипт из каталога deploy/"
    exit 1
fi

echo "Installing Caddyfile..."
mkdir -p "$(dirname "$CADDYFILE_DEST")"
cp "$SCRIPT_DIR/Caddyfile" "$CADDYFILE_DEST"
chown root:root "$CADDYFILE_DEST"
chmod 644 "$CADDYFILE_DEST"

# Install systemd service
echo "Installing systemd service..."
cp "$SCRIPT_DIR/caddy.service" /etc/systemd/system/caddy.service
chown root:root /etc/systemd/system/caddy.service
chmod 644 /etc/systemd/system/caddy.service

# Аудит 2026-08-29: валидация переехала СЮДА, до автозапуска. Раньше
# `systemctl enable caddy` стоял выше, и битый конфиг оставлял юнит в
# автозапуске: скрипт выходил 1, а хост после первого же ребута лез за :80/:443
# — тем самым :443, который занят сторонним xray VPN (CLAUDE.md §1).
# Валидируется ровно тот файл, который читает ExecStart в caddy.service.
echo "Testing Caddyfile syntax..."
if caddy validate --config "$CADDYFILE_DEST"; then
    echo "✅ Caddyfile syntax is valid"
else
    echo "❌ Caddyfile syntax error - please fix before starting"
    echo "   Автозапуск НЕ включён: битый конфиг не попадёт в ребут."
    exit 1
fi

# Reload systemd and enable service
systemctl daemon-reload
systemctl enable caddy

# Check if agent-team service is running on :8787
echo "Checking if agent-team is running on :8787..."
if ss -tlnp | grep -q ':8787'; then
    echo "✅ Port 8787 is open (agent-team running)"
else
    echo "⚠️  Port 8787 not found - ensure agent-team service is running"
    echo "   Check: systemctl status agent-team"
fi

# Порты 80/443 проверены в начале скрипта — до systemctl enable.

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start Caddy:"
echo "  systemctl start caddy"
echo ""
echo "To check status:"  
echo "  systemctl status caddy"
echo "  curl -fsS https://agents.example.com/api/health"
echo ""
echo "Logs:"
echo "  journalctl -u caddy -f"
echo "  tail -f /var/log/caddy/agents.log"
echo ""
echo "⚠️  Make sure DNS record exists: agents.example.com → $(curl -s ifconfig.me)"