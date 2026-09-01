#!/usr/bin/env bash
#
# deploy-lock.sh — взаимный замок против двух одновременных выкаток в прод.
#
# Зачем. Выкатывать в /opt/agent-team умеют ДВА независимых пути:
#   * `deploy/deploy.sh` с Mac владельца;
#   * workflow `.github/workflows/deploy.yml` в CI (свой rsync и свой рестарт).
# Между собой workflow уже сериализуются общей `concurrency: group: deploy-vps`
# (её же переиспользует nightly-deploy.yml, который сам ничего не катит, а
# только дёргает deploy.yml). А вот Mac про эту группу не знает вообще, и CI
# про Mac — тоже.
#
# Чем это кончается. Два rsync в один каталог — это ещё полбеды (файлы просто
# перемешиваются). Хуже другое: каждая выкатка первым делом снимает «снапшот
# прода до деплоя» для отката. Вторая выкатка снимает его с уже наполовину
# перезаписанного дерева — то есть откатываться становится некуда, обе копии
# бракованные. Плюс два `systemctl restart` подряд на разном коде.
#
# Как устроено. Атомарный `mkdir` на удалённой машине — тот же приём, что в
# deploy/vps-autonomous/autonomous-cycle.sh. Каталог замка лежит в /run/lock
# (tmpfs), поэтому перезагрузка VPS снимает протухший замок бесплатно.
# Внутри — token (кто именно держит), owner (человекочитаемо) и started (unix
# time). Замок старше DEPLOY_LOCK_STALE_SEC снимается принудительно и громко:
# выкатка, убитая по Ctrl-C или таймауту раннера, не должна блокировать прод
# навсегда. Release удаляет каталог ТОЛЬКО если token совпал — иначе владелец,
# у которого замок уже отобрали как протухший, снёс бы чужой.
#
# Usage:
#   DEPLOY_LOCK_TOKEN=... deploy/deploy-lock.sh acquire
#   DEPLOY_LOCK_TOKEN=... deploy/deploy-lock.sh release
#   deploy/deploy-lock.sh status
#
# Env:
#   DEPLOY_HOST            куда ходить (обязателен; root запрещён)
#   DEPLOY_LOCK_SSH        команда ssh с опциями (default "ssh"); в CI сюда
#                          уезжает `ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=yes`
#   DEPLOY_LOCK_DIR        каталог замка (default /run/lock/agent-team-deploy.lock)
#   DEPLOY_LOCK_STALE_SEC  через сколько секунд замок считается протухшим (default 1800)
#   DEPLOY_LOCK_TOKEN      уникальный идентификатор владельца (обязателен для acquire/release)
#   DEPLOY_LOCK_OWNER      человекочитаемая подпись в сообщениях (default "unknown")
#
# Exit codes: 0 — ок; 2 — ошибка вызова/конфига; 3 — замок занят; 4 — release
# не наш замок (предупреждение, не повод валить уже прошедший деплой).

set -euo pipefail

# EnvironmentFile/CI отдают ПУСТУЮ строку для `KEY=`, а не «переменная не
# задана», поэтому `${VAR:-default}` тут недостаточно: пробел тоже пустой.
nonblank() {
  local raw="${1-}" fallback="${2-}"
  if [ -z "${raw//[[:space:]]/}" ]; then printf '%s' "$fallback"; else printf '%s' "$raw"; fi
}

ACTION="$(nonblank "${1-}" "")"
HOST="$(nonblank "${DEPLOY_HOST-}" "")"
SSH_CMD="$(nonblank "${DEPLOY_LOCK_SSH-}" "ssh")"
LOCK_DIR="$(nonblank "${DEPLOY_LOCK_DIR-}" "/run/lock/agent-team-deploy.lock")"
TOKEN="$(nonblank "${DEPLOY_LOCK_TOKEN-}" "")"
OWNER="$(nonblank "${DEPLOY_LOCK_OWNER-}" "unknown")"

case "$HOST" in
  ''|root|root@*)
    echo "deploy-lock: DEPLOY_HOST обязателен и не может использовать root" >&2
    exit 2
    ;;
esac

STALE_RAW="$(nonblank "${DEPLOY_LOCK_STALE_SEC-}" "1800")"
case "$STALE_RAW" in
  ''|*[!0-9]*) STALE=1800 ;;
  *) STALE="$STALE_RAW"; [ "$STALE" -gt 0 ] || STALE=1800 ;;
esac

# Токен уезжает на ту сторону аргументом; сузим алфавит, чтобы он оставался
# одним словом и не зависел от кавычек удалённого шелла.
case "$TOKEN" in
  *[!A-Za-z0-9._:@-]*) echo "deploy-lock: недопустимый DEPLOY_LOCK_TOKEN (разрешены A-Za-z0-9._:@-)" >&2; exit 2 ;;
esac
OWNER="$(printf '%s' "$OWNER" | tr -d '\n\r')"

run_remote() {
  local script="$1"; shift
  local out rc
  set +e
  # SSH_CMD разбивается по словам НАМЕРЕННО: это команда с опциями.
  # shellcheck disable=SC2086
  out="$(printf '%s' "$script" | $SSH_CMD "$HOST" sh -s -- "$@" 2>&1)"
  rc=$?
  set -e
  [ -n "$out" ] && printf '%s\n' "$out"
  return $rc
}

# $1 dir, $2 stale, $3 token, $4 owner
REMOTE_ACQUIRE='
set -u
D=$1; S=$2; T=$3; O=$4
mkdir -p "$(dirname "$D")" 2>/dev/null || true
take() {
  printf "%s\n" "$T" > "$D/token"
  printf "%s\n" "$O" > "$D/owner"
  date -u +%s > "$D/started"
}
if mkdir "$D" 2>/dev/null; then
  take
  echo "acquired dir=$D owner=$O"
  exit 0
fi
NOW=$(date -u +%s)
ST=$(cat "$D/started" 2>/dev/null || echo "")
case "$ST" in ""|*[!0-9]*) ST="" ;; esac
# started ещё не записан (микроокно между mkdir и take) или испорчен — возраст
# берём по самому каталогу, а не считаем замок мгновенно протухшим.
if [ -z "$ST" ]; then ST=$(stat -c %Y "$D" 2>/dev/null || stat -f %m "$D" 2>/dev/null || echo 0); fi
case "$ST" in ""|*[!0-9]*) ST=0 ;; esac
AGE=$((NOW - ST))
[ "$AGE" -ge 0 ] || AGE=0
HOLDER=$(cat "$D/owner" 2>/dev/null || echo unknown)
if [ "$AGE" -ge "$S" ]; then
  echo "stale age=${AGE}s holder=$HOLDER — снимаем протухший замок"
  rm -rf "$D"
  if mkdir "$D" 2>/dev/null; then
    take
    echo "acquired-after-stale dir=$D owner=$O"
    exit 0
  fi
  echo "busy holder=$HOLDER age=${AGE}s"
  exit 3
fi
echo "busy holder=$HOLDER age=${AGE}s"
exit 3
'

# $1 dir, $2 token
REMOTE_RELEASE='
set -u
D=$1; T=$2
if [ ! -d "$D" ]; then echo "not-held dir=$D"; exit 0; fi
CUR=$(cat "$D/token" 2>/dev/null || echo "")
if [ "$CUR" != "$T" ]; then
  echo "held-by-other holder=$(cat "$D/owner" 2>/dev/null || echo unknown) — чужой замок не трогаем"
  exit 4
fi
rm -rf "$D"
echo "released dir=$D"
'

# $1 dir
REMOTE_STATUS='
set -u
D=$1
if [ ! -d "$D" ]; then echo "free dir=$D"; exit 0; fi
NOW=$(date -u +%s)
ST=$(cat "$D/started" 2>/dev/null || echo 0)
case "$ST" in ""|*[!0-9]*) ST=0 ;; esac
echo "held holder=$(cat "$D/owner" 2>/dev/null || echo unknown) age=$((NOW - ST))s dir=$D"
'

case "$ACTION" in
  acquire)
    [ -n "$TOKEN" ] || { echo "deploy-lock: acquire требует DEPLOY_LOCK_TOKEN" >&2; exit 2; }
    run_remote "$REMOTE_ACQUIRE" "$LOCK_DIR" "$STALE" "$TOKEN" "$OWNER"
    ;;
  release)
    [ -n "$TOKEN" ] || { echo "deploy-lock: release требует DEPLOY_LOCK_TOKEN" >&2; exit 2; }
    run_remote "$REMOTE_RELEASE" "$LOCK_DIR" "$TOKEN"
    ;;
  status)
    run_remote "$REMOTE_STATUS" "$LOCK_DIR"
    ;;
  *)
    echo "usage: DEPLOY_LOCK_TOKEN=<id> $0 acquire|release   |   $0 status" >&2
    exit 2
    ;;
esac
