#!/usr/bin/env bash
# Fixed privileged operations for the non-root deployment account.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/agent-team}"
SESSION_PATH="$APP_DIR/data/userbot.session"

case "${1-}" in
  restore-session)
    tmp="$(mktemp /tmp/agent-team-session.XXXXXX)"
    trap 'rm -f "$tmp"' EXIT
    umask 077
    base64 -d >"$tmp"
    test -s "$tmp"
    install -d -o agent-team -g agent-team -m 0750 "$APP_DIR/data"
    if test -s "$SESSION_PATH"; then
      echo "userbot.session already exists - keep"
    else
      install -o agent-team -g agent-team -m 0600 "$tmp" "$SESSION_PATH"
      echo "Restored userbot.session from deploy secret"
    fi
    ;;
  restart)
    exec systemctl restart agent-team
    ;;
  is-active)
    exec systemctl is-active agent-team
    ;;
  *)
    echo "usage: $0 restore-session|restart|is-active" >&2
    exit 2
    ;;
esac
