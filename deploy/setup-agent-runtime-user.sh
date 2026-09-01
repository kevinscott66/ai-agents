#!/usr/bin/env bash
# Prepare the least-privileged account and directories for Agent Team units.
set -euo pipefail

RUNTIME_USER="${RUNTIME_USER:-agent-team}"
RUNTIME_GROUP="${RUNTIME_GROUP:-agent-team}"
DEPLOY_USER="${DEPLOY_USER:-agent-deploy}"
DEPLOY_GROUP="${DEPLOY_GROUP:-agent-deploy}"
APP_DIR="${APP_DIR:-/opt/agent-team}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
BUN_SOURCE="${BUN_SOURCE:-/root/.bun/bin/bun}"
CLAUDE_BIN="${CLAUDE_BIN:-/usr/local/bin/claude}"
CLAUDE_SOURCE="${CLAUDE_SOURCE:-/root/.local/bin/claude}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

if ! getent group "$RUNTIME_GROUP" >/dev/null; then
  groupadd --system "$RUNTIME_GROUP"
fi
if ! id -u "$RUNTIME_USER" >/dev/null 2>&1; then
  useradd --system --gid "$RUNTIME_GROUP" --home-dir /nonexistent --shell /usr/sbin/nologin "$RUNTIME_USER"
fi

if ! getent group "$DEPLOY_GROUP" >/dev/null; then
  groupadd --system "$DEPLOY_GROUP"
fi
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --gid "$DEPLOY_GROUP" --create-home --home-dir "/home/$DEPLOY_USER" --shell /bin/bash "$DEPLOY_USER"
fi

if [ ! -x "$BUN_BIN" ]; then
  if [ ! -x "$BUN_SOURCE" ]; then
    echo "Bun binary not found: expected $BUN_BIN or legacy $BUN_SOURCE" >&2
    exit 1
  fi
  install -d -o root -g root -m 0755 "$(dirname "$BUN_BIN")"
  install -o root -g root -m 0755 "$BUN_SOURCE" "$BUN_BIN"
fi

# Draft timers may use the standalone Claude executable. Make it visible to a
# non-root systemd unit before ProtectHome=true hides /root.
if [ ! -x "$CLAUDE_BIN" ] && [ -x "$CLAUDE_SOURCE" ]; then
  install -d -o root -g root -m 0755 "$(dirname "$CLAUDE_BIN")"
  install -o root -g root -m 0755 "$CLAUDE_SOURCE" "$CLAUDE_BIN"
fi

install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0755 "$APP_DIR"
# The deploy account owns code and dependencies; the runtime account owns only
# mutable state. Keep .env and runtime trees out of this ownership change.
for entry in "$APP_DIR"/* "$APP_DIR"/.[!.]*; do
  [ -e "$entry" ] || continue
  case "$(basename "$entry")" in
    data|backups|memory|.env|.env.*|.eliza) continue ;;
  esac
  chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$entry"
done

for dir in data backups memory; do
  install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0750 "$APP_DIR/$dir"
  chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$APP_DIR/$dir"
done
install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0750 /opt/web3-puls/drafts
chown -R "$RUNTIME_USER:$RUNTIME_GROUP" /opt/web3-puls/drafts
install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0700 /var/lib/agent-team/deploy-snapshots

if [ -f "$APP_DIR/data/userbot.session" ]; then
  chown "$RUNTIME_USER:$RUNTIME_GROUP" "$APP_DIR/data/userbot.session"
  chmod 0600 "$APP_DIR/data/userbot.session"
fi

if [ -f "$APP_DIR/.env" ]; then
  chown root:"$RUNTIME_GROUP" "$APP_DIR/.env"
  chmod 0640 "$APP_DIR/.env"
fi

# deploy-lock.sh atomically creates its child under the standard /run/lock
# parent. Do not pre-create the lock path: that would make every deployment
# look busy forever.

install -o root -g root -m 0755 "$SCRIPT_DIR/agent-team-deploy-helper.sh" /usr/local/sbin/agent-team-deploy
cat > /etc/sudoers.d/agent-team-deploy <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/local/sbin/agent-team-deploy
EOF
chmod 0440 /etc/sudoers.d/agent-team-deploy
visudo -cf /etc/sudoers.d/agent-team-deploy >/dev/null

install -o root -g root -m 0644 "$SCRIPT_DIR/agent-team.service" "$SYSTEMD_UNIT_DIR/agent-team.service"
for unit in delabs-daily-draft.service delabs-approve-poll.service delabs-weekly-draft.service; do
  install -o root -g root -m 0644 "$SCRIPT_DIR/systemd/$unit" "$SYSTEMD_UNIT_DIR/$unit"
done
systemctl daemon-reload
echo "Prepared runtime=$RUNTIME_USER deploy=$DEPLOY_USER and installed agent-team plus Delabs units"
