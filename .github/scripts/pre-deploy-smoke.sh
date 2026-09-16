#!/usr/bin/env bash
#
# Предеплойный смоук — единственный гейт между чекаутом и `systemctl restart`
# на проде. Звал его шаг «Pre-deploy smoke (local)» воркфлоу deploy.yml.
#
# Аудит 2026-09-11: воркфлоу удалён при публичном релизе 2026-09-01, и полторы
# недели этот файл не вызывался ничем — гейт выглядел существующим, а прогонов
# не делал. Теперь его зовёт deploy/deploy.sh перед замком выкатки, то есть
# единственный оставшийся путь в прод. Сверка — в
# agent/tests/audit-2026-09-11-predeploy-smoke-unwired.test.ts.
#
# Аудит 2026-08-20: раньше это был инлайн в воркфлоу, обёрнутый в
#
#     if [ -f bun.lockb ] || [ -f package.json ]; then
#
# В корне репозитория нет ни того, ни другого и никогда не было: манифестов два
# (`agent/package.json`, `agent/miniapp/package.json`), лок-файл —
# `agent/bun.lock`. Условие ложно всегда, тело шага целиком пропускалось, шаг
# зеленел, и сразу за ним шли rsync `--delete` и рестарт юнита. Плюс две
# ошибки внутри самого тела, которые обнулили бы гейт и при верном условии:
# `bun test 2>&1 | tail -20` отдаёт код выхода `tail`, то есть ноль при любом
# провале, а прогон из корня не видит `agent/bunfig.toml` с
# `preload = ["./tests/_setup.ts"]` и идёт по живой data/memory.db.
#
# Здесь — то же самое, но работающее, и вынесенное в отдельный файл, чтобы
# прогоняться тестами (agent/tests/audit-2026-08-20-pre-deploy-smoke.test.ts),
# как automerge-filter.sh.
#
# Usage: pre-deploy-smoke.sh [repo-root]
set -euo pipefail

ROOT="${1:-.}"

# Неполный чекаут — это отказ, а не «нечего проверять». Ровно так же устроена
# защита перед rsync в deploy/deploy.sh: нет `git ls-files` — выкатки нет.
if [ ! -f "$ROOT/agent/package.json" ]; then
  echo "::error::$ROOT/agent/package.json отсутствует или недоступен — чекаут неполный, смоук отменён." >&2
  exit 1
fi

LOG="$(mktemp -t pre-deploy-smoke.XXXXXX)"
trap 'rm -f "$LOG"' EXIT

# Прогон + компактный лог. Полный вывод показываем только при провале: на
# успехе это четыреста строк с именами файлов, а на провале нужен именно он.
step() {
  local title="$1"
  shift
  echo "--- $title"
  if ! "$@" >"$LOG" 2>&1; then
    echo "::error::$title — провал, деплой отменён." >&2
    tail -60 "$LOG" >&2
    exit 1
  fi
  tail -5 "$LOG"
}

cd "$ROOT/agent"
step "bun install (agent)" bun install --frozen-lockfile
# Именно `bun test tests` из agent/: рабочий каталог решает, будет ли прочитан
# bunfig.toml с preload, а без него тесты берут боевую БД.
step "bun test (agent)" bun test tests

cd miniapp
step "bun install (miniapp)" bun install --frozen-lockfile
step "vite build (miniapp)" bun run build

echo "Предеплойный смоук пройден."
