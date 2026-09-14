#!/usr/bin/env bash
# Check added PR content for credential-shaped values without printing them.
# Historical credentials require rotation and a separately approved history
# rewrite; this gate prevents the next leak from entering the repository.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

BASE=$1
HEAD=$2
PLACEHOLDER='(your|example|placeholder|changeme|dummy|sample|xxxx|redacted|test|fake|local|dev|ci|\.{3}|\$\{|\$\(|<|>|\*\*\*)'

PATTERNS=(
  '[0-9]{8,10}:[A-Za-z0-9_-]{35}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{40,}'
  'sk-[a-z]{2,12}-[A-Za-z0-9_-]{20,}'
  'ghp_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{40,}'
  '(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|API_HASH|SESSION)[A-Z0-9_]*[[:space:]]*=[[:space:]]*["'"'"']?[A-Za-z0-9_/+.:-]{16,}'
  '(^|[^A-Za-z0-9+/=])1[A-Za-z0-9+/=_-]{250,}'
)
LABELS=(
  "telegram-bot-token"
  "anthropic-key"
  "openai-key"
  "openai-key-prefixed"
  "github-pat-classic"
  "github-pat-fine-grained"
  "secret-assignment"
  "telegram-string-session"
)

DIFF=$(mktemp)
trap 'rm -f "$DIFF"' EXIT

if ! git diff --no-ext-diff --no-color --unified=0 "$BASE" "$HEAD" -- \
  . \
  ':!deploy/vps-autonomous/scan-staged-secrets.sh' \
  ':!**/node_modules/**' \
  ':!**/dist/**' \
  ':!**/build/**' >"$DIFF"; then
  echo "check-secret-hygiene: could not read git range; refusing to pass." >&2
  exit 2
fi

# Restrict the scan to added lines. Context and deleted lines are not entering
# the repository in this PR and should not make a clean patch look unsafe.
ADDED=$(mktemp)
trap 'rm -f "$DIFF" "$ADDED"' EXIT
awk '/^\+\+\+ / { next } /^\+/ { sub(/^\+/, ""); print }' "$DIFF" >"$ADDED"

FOUND=0
for I in "${!PATTERNS[@]}"; do
  # Заглушка ищется в самом совпавшем значении (-o), а не в строке вокруг него.
  # Раньше фильтр применялся ко всей строке без якорей: любое слово из
  # PLACEHOLDER где угодно в строке гасило находку целиком. Список широкий и
  # содержит dev, ci, test, local, <, > — то есть открывался обычным видом
  # строки, а не экзотикой: `TELEGRAM_BOT_TOKEN_DEV=<токен>` выпадал из-за
  # подстроки DEV, а `curl -H "Authorization: Bearer <ключ>" > out.json` — из-за
  # перенаправления. sed дополнительно снимает префикс `ИМЯ=` у совпадений
  # класса secret-assignment: имя переменной — не значение, и слово `DEV` в нём
  # не делает секрет заглушкой. Само сравнение по-прежнему нечувствительно к
  # регистру, поэтому `YOUR-TOKEN-HERE` остаётся заглушкой.
  if grep -aoE -- "${PATTERNS[$I]}" "$ADDED" \
    | sed -E 's/^[A-Za-z0-9_]+[[:space:]]*=[[:space:]]*["'"'"']?//' \
    | grep -avE '^process\.env\.[A-Za-z0-9_]+' \
    | grep -avEi -- "$PLACEHOLDER" >/dev/null; then
    echo "::error::Secret-shaped value added in PR (${LABELS[$I]}). Review the changed lines without printing credentials." >&2
    FOUND=1
  fi
done

if [ "$FOUND" -ne 0 ]; then
  exit 1
fi

echo "check-secret-hygiene: no credential-shaped values in added lines."
