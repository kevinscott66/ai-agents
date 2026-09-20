#!/usr/bin/env bash
#
# disk-guard.sh — порог свободного места на проде. Смотрит и говорит; не удаляет.
#
# Зачем. Корневой раздел VPS — 9.6 ГБ, и на нём живёт всё сразу: код агента с
# node_modules, каталоги релизов сайта, ночные снапшоты SQLite, журнал systemd,
# кэш apt. Аудит AUD-20260919-026 застал раздел на 85% (1.5 ГБ свободно). ENOSPC
# в середине выкатки — худший из отказов: rsync обрывается на половине, а
# `bun install` оставляет node_modules в состоянии, из которого сервис не
# поднимается. Откат при этом тоже требует места.
#
# Чего этот скрипт НЕ делает. Не удаляет ничего и никогда — ни кэшей, ни старых
# релизов, ни журналов. Так решено в приёмке AUD-026: автоматический уборщик на
# 9.6-гигабайтном разделе однажды снесёт то, что окажется единственной копией.
# Место освобождает человек, разово и осознанно; дело сторожа — предупредить
# заранее и не дать выкатке начаться впритык.
#
# Две роли:
#   1. Таймер на проде (disk-guard.timer) — раз в час пишет отчёт в журнал.
#      Падает (exit 2) только на критическом пороге, поэтому `systemctl
#      --failed` остаётся чистым, пока запас в норме, и краснеет ровно тогда,
#      когда пора вмешаться.
#   2. Предполётная проверка выкатки — `--need <МиБ>` спрашивает не «сколько
#      свободно вообще», а «останется ли резерв, если я сейчас займу столько».
#      Это разные вопросы: 600 МиБ свободных выглядят прилично, но выкатка,
#      которой нужно 550, оставит после себя 50 — и следующий же ротейт журнала
#      упрётся в ноль.
#
# Пороги заданы в МиБ свободного места, а не в процентах: проценты на разделах
# разного размера означают разное, а «сколько влезет ещё» — величина в байтах.
#
# Использование:
#   deploy/disk-guard.sh                        # проверить локальный /
#   deploy/disk-guard.sh --host user@vps        # то же по ssh
#   deploy/disk-guard.sh --need 550             # хватит ли на выкатку
#   deploy/disk-guard.sh --json                 # машинный вывод
#
# Коды возврата: 0 — запас в норме; 1 — ниже порога предупреждения; 2 — ниже
# критического порога либо запрошенное `--need` не помещается.

set -euo pipefail

PATH_TO_CHECK="${DISK_GUARD_PATH:-/}"
WARN_MIB="${DISK_GUARD_WARN:-1024}"
CRIT_MIB="${DISK_GUARD_CRIT:-512}"
NEED_MIB="${DISK_GUARD_NEED:-0}"
HOST="${DISK_GUARD_HOST-}"
SSH_KEY="${DISK_GUARD_SSH_KEY-}"
JSON=0
LABEL="${DISK_GUARD_LABEL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --path)  PATH_TO_CHECK="${2-}"; shift 2 ;;
    --warn)  WARN_MIB="${2-}"; shift 2 ;;
    --crit)  CRIT_MIB="${2-}"; shift 2 ;;
    --need)  NEED_MIB="${2-}"; shift 2 ;;
    --host)  HOST="${2-}"; shift 2 ;;
    --key)   SSH_KEY="${2-}"; shift 2 ;;
    --label) LABEL="${2-}"; shift 2 ;;
    --json)  JSON=1; shift ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'disk-guard: неизвестный аргумент %s\n' "$1" >&2; exit 64 ;;
  esac
done

for v in WARN_MIB CRIT_MIB NEED_MIB; do
  case "${!v}" in
    ''|*[!0-9]*) printf 'disk-guard: %s должен быть целым числом МиБ, получено «%s»\n' "$v" "${!v}" >&2; exit 64 ;;
  esac
done

# `df -P` — POSIX-формат: ровно одна строка на файловую систему, что бы ни было
# в её имени. Без -P длинные имена устройств переносятся, и awk читает вторую
# строку как продолжение первой. -k — килобайты, одинаково на Linux и macOS.
df_line() {
  if [ -n "${HOST//[[:space:]]/}" ]; then
    # IdentitiesOnly=yes вместе с ключом — не украшение: в ~/.ssh/config для
    # прода прописан ключ root'а, и без этой опции ssh предъявляет его первым,
    # а deploy-пользователь получает Permission denied при полностью рабочем
    # доступе. Тот же приём в deploy.sh (SSH_ARGS).
    local ssh_opts=(-o BatchMode=yes)
    [ -n "${SSH_KEY//[[:space:]]/}" ] && ssh_opts+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
    ssh "${ssh_opts[@]}" "$HOST" "df -Pk -- '$PATH_TO_CHECK'" | awk 'NR==2 {print $2, $3, $4; exit}'
  else
    df -Pk -- "$PATH_TO_CHECK" | awk 'NR==2 {print $2, $3, $4; exit}'
  fi
}

raw="$(df_line || true)"
if [ -z "${raw//[[:space:]]/}" ]; then
  printf 'disk-guard: не удалось прочитать df для %s%s\n' "$PATH_TO_CHECK" "${HOST:+ на $HOST}" >&2
  exit 3
fi

read -r total_k used_k free_k <<<"$raw"
total=$(( total_k / 1024 ))
used=$(( used_k / 1024 ))
free=$(( free_k / 1024 ))
# Процент считается от total, а не от used+free: на ext4 часть блоков
# зарезервирована за root, и used+free меньше total на эти пять процентов.
pct=0
[ "$total" -gt 0 ] && pct=$(( used * 100 / total ))

# Остаток ПОСЛЕ гипотетической выкатки — то, на что и смотрит предполётная
# проверка. Без --need это просто текущий запас.
after=$(( free - NEED_MIB ))

status=ok
code=0
if [ "$after" -lt "$CRIT_MIB" ]; then
  status=crit
  code=2
elif [ "$after" -lt "$WARN_MIB" ]; then
  status=warn
  code=1
fi

where="$PATH_TO_CHECK${HOST:+ на $HOST}"
tag="${LABEL:+[$LABEL] }"

if [ "$JSON" = 1 ]; then
  printf '{"path":"%s","host":"%s","label":"%s","total_mib":%d,"used_mib":%d,"free_mib":%d,"used_pct":%d,"need_mib":%d,"free_after_mib":%d,"warn_mib":%d,"crit_mib":%d,"status":"%s"}\n' \
    "$PATH_TO_CHECK" "$HOST" "$LABEL" "$total" "$used" "$free" "$pct" "$NEED_MIB" "$after" "$WARN_MIB" "$CRIT_MIB" "$status"
  exit "$code"
fi

case "$status" in
  ok)
    printf '%sзапас диска в норме: %s — свободно %d МиБ из %d (занято %d%%), порог предупреждения %d МиБ\n' \
      "$tag" "$where" "$free" "$total" "$pct" "$WARN_MIB"
    [ "$NEED_MIB" -gt 0 ] && printf '%sвыкатке нужно %d МиБ, после неё останется %d МиБ\n' "$tag" "$NEED_MIB" "$after"
    ;;
  warn)
    printf '%s⚠ запас диска тает: %s — свободно %d МиБ из %d (занято %d%%)\n' "$tag" "$where" "$free" "$total" "$pct" >&2
    [ "$NEED_MIB" -gt 0 ] && printf '%s⚠ выкатке нужно %d МиБ, после неё останется %d МиБ при пороге %d\n' "$tag" "$NEED_MIB" "$after" "$WARN_MIB" >&2
    printf '%sНичего не удалено и не будет: разбор кандидатов — deploy/disk-budget.md.\n' "$tag" >&2
    ;;
  crit)
    printf '%s❌ запаса диска нет: %s — свободно %d МиБ из %d (занято %d%%), критический порог %d МиБ\n' "$tag" "$where" "$free" "$total" "$pct" "$CRIT_MIB" >&2
    [ "$NEED_MIB" -gt 0 ] && printf '%s❌ выкатке нужно %d МиБ — останется %d МиБ, это ниже критического порога\n' "$tag" "$NEED_MIB" "$after" >&2
    printf '%sНичего не удалено: место освобождает человек. Кандидаты — deploy/disk-budget.md.\n' "$tag" >&2
    ;;
esac

exit "$code"
