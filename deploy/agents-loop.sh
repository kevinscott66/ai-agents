#!/usr/bin/env bash
# Retired legacy runner. It launched a Bash-capable Claude process directly,
# frequently from a root-owned checkout, outside the readiness gate and the
# systemd sandbox. Keep this file as a loud fail-closed tombstone so old cron
# entries cannot silently revive that path.
set -euo pipefail

echo "[fatal] deploy/agents-loop.sh is retired; use agent-autonomous.service" >&2
echo "[fatal] the supported path enforces readiness and a non-root sandbox" >&2
exit 1
