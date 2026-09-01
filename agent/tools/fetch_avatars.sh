#!/usr/bin/env bash
# Тянем 12 аватарок ролей через DiceBear (style: personas).
# Каждой роли: уникальный seed + уникальный backgroundColor.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p avatars
STYLE=personas
SIZE=512

# key:seed:bg
ROLES=(
  "orchestrator:lead-anchor:1e1b4b"
  "pm:planner-quill:0ea5e9"
  "product:product-compass:10b981"
  "backend:server-stack:374151"
  "frontend:pixel-builder:f97316"
  "tgdev:telegram-tide:0088cc"
  "aieng:neural-spark:7c3aed"
  "qa:bug-hunter:dc2626"
  "smm:trend-pulse:facc15"
  "copy:wordsmith-jet:a16207"
  "design:canvas-glow:ec4899"
  "perm:gatekeeper:1f2937"
)
for entry in "${ROLES[@]}"; do
  IFS=":" read -r key seed bg <<<"$entry"
  url="https://api.dicebear.com/9.x/${STYLE}/png?seed=${seed}&backgroundColor=${bg}&size=${SIZE}"
  echo "→ ${key} (seed=${seed}, bg=#${bg})"
  curl -fsSL -o "avatars/${key}.png" "$url"
done
ls -la avatars/*.png
