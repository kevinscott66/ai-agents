#!/usr/bin/env bash
# Гейт на известные уязвимости в зависимостях: `bun audit --json` по каждому
# пакету репозитория, сверка находок с явным списком исключений.
#
# Аудит 2026-09-29: в CI не было НИ ОДНОЙ проверки зависимостей — ни в
# checks.yml, ни в native.yml, ни в deploy.yml, и ни одного dependabot/renovate
# конфига. На момент появления этого гейта `bun audit` показывал 41
# предупреждение: 26 в agent (8 high), 8 в agent/miniapp (5 high), 7 в site/web
# (5 high). Все они закрыты semver-совместимыми `overrides` в том же PR; гейт
# нужен, чтобы вернувшаяся дыра краснела сама, а не ждала следующего ручного
# аудита.
#
# Почему нельзя просто посмотреть на код возврата:
#   * с находками `bun audit --json` выходит с 1, но с тем же 1 он выходит и
#     когда не нашёл lockfile или не смог достучаться до реестра. Первое — это
#     «есть уязвимости», второе — «проверка не состоялась», и путать их нельзя:
#     сеть в CI мигает, и молча зелёный гейт хуже отсутствующего.
#   * поэтому источник правды здесь — сам JSON на stdout. Разобрался — значит
#     аудит состоялся: `{}` это чисто, объект с пакетами это находки. Не
#     разобрался — exit 2 и «refusing to pass», как в остальных гейтах репо.
#
# Список исключений двусторонний: неизвестная находка краснеет, но и запись,
# которая больше ничего не ловит, тоже краснеет — иначе он повторит судьбу
# вкомпилированного FLOOR=670 из test-baseline и со временем начнёт разрешать
# то, о чём никто уже не помнит.
#
# usage: check-dependency-audit.sh <allowlist-file> <package-dir> [<package-dir>...]

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <allowlist-file> <package-dir> [<package-dir>...]" >&2
  exit 2
fi

ALLOWLIST=$1
shift

if [ ! -f "$ALLOWLIST" ]; then
  echo "check-dependency-audit: нет файла исключений '$ALLOWLIST'; refusing to pass." >&2
  exit 2
fi

for TOOL in bun node; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo "check-dependency-audit: в PATH нет '$TOOL' — аудит не состоится; refusing to pass." >&2
    exit 2
  fi
done

DIR_COUNT=$#

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Разобранные находки: "<dir> <package> <id> <severity> <title>".
FINDINGS="$WORK/findings.txt"
: >"$FINDINGS"

for DIR in "$@"; do
  DIR=${DIR%/}
  if [ ! -f "$DIR/package.json" ] || [ ! -f "$DIR/bun.lock" ]; then
    echo "check-dependency-audit: в '$DIR' нет package.json/bun.lock — аудит не состоится; refusing to pass." >&2
    exit 2
  fi

  OUT="$WORK/out"
  ERR="$WORK/err"
  RC=0
  (cd "$DIR" && bun audit --json) >"$OUT" 2>"$ERR" || RC=$?

  if ! node "$(dirname "$0")/dependency-audit-flatten.mjs" "$DIR" <"$OUT" >>"$FINDINGS"; then
    echo "check-dependency-audit: '$DIR' — bun audit не отдал разбираемый JSON (код $RC); refusing to pass." >&2
    echo "--- stderr bun audit (последние строки) ---" >&2
    tail -n 5 "$ERR" >&2 || true
    exit 2
  fi
done

# Исключения: "<dir> <package> <advisory-id>" плюс необязательный комментарий
# после '#'. Пустые строки и строки-комментарии игнорируются.
ACK="$WORK/ack.txt"
: >"$ACK"
LINE_NO=0
while IFS= read -r RAW || [ -n "$RAW" ]; do
  LINE_NO=$((LINE_NO + 1))
  ENTRY=${RAW%%#*}
  read -r A_DIR A_PKG A_ID A_REST <<<"$ENTRY"
  if [ -z "${A_DIR:-}" ]; then
    continue
  fi
  if [ -z "${A_ID:-}" ] || [ -n "${A_REST:-}" ]; then
    echo "check-dependency-audit: $ALLOWLIST:$LINE_NO — ожидается '<dir> <package> <advisory-id>'; refusing to pass." >&2
    exit 2
  fi
  printf '%s %s %s\n' "${A_DIR%/}" "$A_PKG" "$A_ID" >>"$ACK"
done <"$ALLOWLIST"

UNACKED=0
while IFS= read -r FINDING || [ -n "$FINDING" ]; do
  [ -n "$FINDING" ] || continue
  KEY=$(printf '%s\n' "$FINDING" | cut -d' ' -f1-3)
  if grep -Fxq "$KEY" "$ACK"; then
    continue
  fi
  if [ "$UNACKED" -eq 0 ]; then
    echo "check-dependency-audit: известные уязвимости в зависимостях:" >&2
  fi
  echo "  $FINDING" >&2
  UNACKED=$((UNACKED + 1))
done <"$FINDINGS"

STALE=0
while IFS= read -r KEY || [ -n "$KEY" ]; do
  [ -n "$KEY" ] || continue
  if cut -d' ' -f1-3 "$FINDINGS" | grep -Fxq "$KEY"; then
    continue
  fi
  if [ "$STALE" -eq 0 ]; then
    echo "check-dependency-audit: записи в $ALLOWLIST больше ничего не ловят — удали их:" >&2
  fi
  echo "  $KEY" >&2
  STALE=$((STALE + 1))
done <"$ACK"

if [ "$UNACKED" -gt 0 ] || [ "$STALE" -gt 0 ]; then
  if [ "$UNACKED" -gt 0 ]; then
    echo "" >&2
    echo "Починка: поднять версию в package.json, а для транзитивной зависимости —" >&2
    echo "добавить её в \"overrides\" того же package.json (голый 'bun update' двигает" >&2
    echo "только прямые, а 'bun update <name>' записывает пакет в прямые). Если" >&2
    echo "обновиться нельзя — строка в $ALLOWLIST с причиной." >&2
  fi
  exit 1
fi

COUNT=$(wc -l <"$FINDINGS" | tr -d ' ')
echo "check-dependency-audit: чисто — $DIR_COUNT пакет(ов), находок $COUNT, исключений $(wc -l <"$ACK" | tr -d ' ')."
