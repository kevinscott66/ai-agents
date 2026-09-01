#!/usr/bin/env bash
###############################################################################
# Гейт между `git add -A` и `git commit` в автономном цикле.
#
# Аудит 2026-08-12: autonomous-cycle.sh коммитил всё, что написал headless-claude
# с `--allowedTools "Bash Edit Write …"`, на машине, где рядом лежит
# /opt/agent-team/.env — токены 12 ботов, ключ OpenAI, сессия юзербота,
# ingest-токен. Запрет «never read or print secrets» жил только в промпте, а сам
# промпт собирается в том числе из TASKS.md и файлов памяти, которые правит тот
# же агент. `git add -A` не отличает заметку от дампа окружения, и следующая
# строка скрипта пушит ветку и открывает PR.
#
# Коды выхода:
#   0 — в стейдже секретов не найдено (или стейдж пуст)
#   1 — найдено; печатаются ИМЕНА файлов и класс совпадения, но не значения
#   2 — проверку выполнить не удалось (не репозиторий, git недоступен)
#
# Код 2 — отдельный намеренно: «проверка не выполнена» ≠ «чисто». Ровно на этом
# в check-conflict-markers.sh CI-джоба годами была зелёной, ничего не проверяя.
#
# Запускается из корня проверяемого репозитория:
#   bash deploy/vps-autonomous/scan-staged-secrets.sh
###############################################################################
set -uo pipefail

# Формы — те, что реально лежат в .env этого проекта.
PATTERNS=(
  '[0-9]{8,10}:[A-Za-z0-9_-]{35}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{40,}'
  'sk-[a-z]{2,12}-[A-Za-z0-9_-]{20,}'
  'ghp_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{40,}'
  '(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|SESSION)[A-Z0-9_]*[[:space:]]*=[[:space:]]*["'"'"']?[A-Za-z0-9_/+.:-]{16,}'
)
LABELS=(
  "telegram-bot-token"
  "anthropic-key"
  "openai-key"
  "openai-key-prefixed"
  "github-pat-classic"
  "github-pat-fine-grained"
  "secret-assignment"
)

# Строки-заглушки: .env.example, документация, подстановки воркфлоу. Без этого
# фильтра гейт ловил бы `TOKEN=<your-token-here>` и глушил весь автономный цикл.
PLACEHOLDER='(your|example|placeholder|changeme|dummy|sample|xxxx|redacted|\.\.\.|\$\{|\$\(|<|>|\*\*\*)'

ERRLOG=$(mktemp)
trap 'rm -f "$ERRLOG"' EXIT

FILES=$(git diff --staged --name-only --diff-filter=d 2>"$ERRLOG")
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "scan-staged-secrets: git diff завершился с кодом $RC — проверка НЕ выполнена." >&2
  cat "$ERRLOG" >&2
  exit 2
fi

if [ -z "$FILES" ]; then
  echo "scan-staged-secrets: стейдж пуст, секретов не найдено."
  exit 0
fi

FOUND=0
while IFS= read -r F; do
  [ -z "$F" ] && continue
  # Содержимое именно из индекса, а не с диска: коммитится оно.
  CONTENT=$(git show ":$F" 2>/dev/null) || continue
  for I in "${!PATTERNS[@]}"; do
    # Заглушку ищем в самом совпавшем значении (-o), а не в строке вокруг него:
    # без этого любое `<`/`>` в строке гасило находку целиком (аудит 2026-08-29,
    # тот же дефект был в .github/scripts/check-secret-hygiene.sh). sed снимает
    # префикс `ИМЯ=` у класса secret-assignment — имя переменной не значение.
    HIT=$(printf '%s\n' "$CONTENT" \
      | grep -aoE -- "${PATTERNS[$I]}" \
      | sed -E 's/^[A-Za-z0-9_]+[[:space:]]*=[[:space:]]*["'"'"']?//' \
      | grep -avE '^process\.env\.[A-Za-z0-9_]+' \
      | grep -avEi -- "$PLACEHOLDER")
    if [ -n "$HIT" ]; then
      # Печатаем файл и класс — но НИКОГДА само значение: этот вывод уходит в
      # /var/log/agent-autonomous.log, то есть разгласил бы ровно то, что ловит.
      COUNT=$(printf '%s\n' "$HIT" | wc -l | tr -d ' ')
      echo "СЕКРЕТ: $F — совпадений с ${LABELS[$I]}: $COUNT" >&2
      FOUND=1
    fi
  done
done <<< "$FILES"

if [ "$FOUND" -ne 0 ]; then
  echo "scan-staged-secrets: коммит запрещён. Разберитесь руками, что попало в стейдж." >&2
  exit 1
fi

echo "scan-staged-secrets: секретов не найдено."
exit 0
