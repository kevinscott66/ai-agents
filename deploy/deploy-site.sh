#!/usr/bin/env bash
#
# deploy-site.sh — выкатка site/ (delabs.space) на прод.
#
# Прод раскладывает site/ ПЛОСКО, как и agent/:
#   репо  site/server/*  ==  прод  /opt/web3-puls/server/*
#   репо  site/web/*     ==  прод  /opt/web3-puls/web/*
# Юнит: web3-puls.service (WorkingDirectory=/opt/web3-puls/server, PORT=8790),
# наружу — nginx: delabs.space:80 и :8443 → 127.0.0.1:8790.
# (Порт 443 на этом хосте занят посторонним xray VPN — не трогаем.)
#
# Статику сервер отдаёт из server/../web/dist, то есть /opt/web3-puls/web/dist.
# Собираем ЛОКАЛЬНО (`bun run build` = `tsc --noEmit && vite build`) и везём
# готовый dist: на проде нет ни tsc, ни гарантии, что node_modules там свежие,
# а падение сборки посреди выкатки оставило бы сайт с новым сервером и старым
# фронтом. Локальная сборка падает ДО того, как что-либо уехало.
#
# Usage:
#   DEPLOY_HOST=agent-deploy@203.0.113.10 DEPLOY_SSH_KEY=~/.ssh/site_deploy deploy/deploy-site.sh
#   DRY_RUN=1 DEPLOY_HOST=agent-deploy@203.0.113.10 DEPLOY_SSH_KEY=... deploy/deploy-site.sh
#
# DEPLOY_SSH_KEY формально не обязателен, практически — да: у оператора в
# ~/.ssh/config на этот хост стоит `IdentitiesOnly yes`, и rsync, запущенный с
# голым `-e ssh`, ключ сам не подберёт — выкатка падала на
# `Permission denied (publickey)` ещё в dry-run. Лечение то же, что в deploy.sh.
#
# DEPLOY_ALLOW_ROOT=1 — осознанный обход запрета на root ниже. Прод сайта пока
# не умеет иначе: /opt/web3-puls принадлежит root, снапшот кладётся в /root,
# рестарт — systemctl. Выделенного site-deploy пользователя и sudo-обёртки для
# него нет (обёртка agent-deploy умеет только agent-team). Пока их не заведёт
# владелец сервера, единственный работающий путь — root; лучше явным флагом,
# чем скриптом, который не выкатывает ничего.
#
# На проде выполняется только `bun install --frozen-lockfile` в server/ и рестарт
# юнита. Скрипт НЕ трогает прод .env, server/data/ (боевой SQLite) и systemd drop-in'ы.

set -euo pipefail

HOST="${DEPLOY_HOST-}"
REMOTE="${DEPLOY_SITE_PATH:-/opt/web3-puls}"
SERVICE="${DEPLOY_SITE_SERVICE:-web3-puls}"
LOCAL_HEALTH="${DEPLOY_SITE_LOCAL_HEALTH:-http://127.0.0.1:8790/api/health}"
PUBLIC_HEALTH="${DEPLOY_SITE_HEALTH_URL:-https://delabs.space:8443/api/health}"
DRY_RUN="${DRY_RUN:-0}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY-}"
ALLOW_ROOT="${DEPLOY_ALLOW_ROOT:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_SERVER="$REPO_ROOT/site/server/"
SRC_WEB="$REPO_ROOT/site/web/"

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
red()  { printf '\033[31m%s\033[0m\n' "$*"; }

if [ -z "${HOST//[[:space:]]/}" ]; then
  red "DEPLOY_HOST обязателен: укажите выделенного deploy-пользователя и хост."
  exit 2
fi
case "$HOST" in
  root|root@*)
    if [ "$ALLOW_ROOT" != "1" ]; then
      red "DEPLOY_HOST не может использовать root; настройте выделенного deploy-пользователя."
      red "  Если выделенного пользователя ещё нет — осознанно: DEPLOY_ALLOW_ROOT=1."
      exit 2
    fi
    red "WARNING: выкатываем под root (DEPLOY_ALLOW_ROOT=1). Это временно, см. шапку."
    ;;
esac

# Не полагаемся на ssh-agent и ~/.ssh/config оператора: глобальный
# `IdentitiesOnly yes` молча игнорирует ключ, добавленный в агент, и rsync
# падает на publickey. Один и тот же ключ уходит и в ssh, и в rsync.
# Раскрытие через `${SSH_ARGS[@]+...}` — чтобы пустой массив не ронял скрипт под
# `set -u` в bash 3.2 (/bin/bash на macOS): там голое "${a[@]}" даёт
# `unbound variable`.
SSH_ARGS=()
RSYNC_SSH="ssh"
SSH_HINT=""
if [ -n "${DEPLOY_SSH_KEY//[[:space:]]/}" ]; then
  case "$DEPLOY_SSH_KEY" in
    *[!A-Za-z0-9_./-]*)
      red "DEPLOY_SSH_KEY должен быть простым локальным путём без shell-символов."
      exit 2
      ;;
  esac
  [ -r "$DEPLOY_SSH_KEY" ] || { red "DEPLOY_SSH_KEY не читается: $DEPLOY_SSH_KEY"; exit 2; }
  SSH_ARGS=(-i "$DEPLOY_SSH_KEY" -o IdentitiesOnly=yes)
  RSYNC_SSH="ssh -i $DEPLOY_SSH_KEY -o IdentitiesOnly=yes"
  SSH_HINT="-i $DEPLOY_SSH_KEY -o IdentitiesOnly=yes "
fi

ssh_remote() {
  ssh ${SSH_ARGS[@]+"${SSH_ARGS[@]}"} "$@"
}

[ -d "$SRC_SERVER" ] || { red "site/server не найден: $SRC_SERVER"; exit 1; }
[ -d "$SRC_WEB" ]    || { red "site/web не найден: $SRC_WEB"; exit 1; }

BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
[ "$BRANCH" = "main" ] || red "WARNING: выкатываем из '$BRANCH', не из main."

# Показываем ровно то, что уедет: правки в agent/ или в памяти на сайт не влияют.
DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- site/ 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  red "WARNING: в site/ есть незакоммиченные изменения — они уедут в прод, но их нет в git:"
  printf '%s\n' "$DIRTY" | head -20
  red "  Откатить такой деплой git'ом будет не к чему — закоммить перед выкаткой."
fi
cyan "Deploying site ${BRANCH}@${COMMIT} → ${HOST}:${REMOTE}"

# data/ — боевой SQLite (SITE_DB_PATH=/opt/web3-puls/server/data/site.db).
SERVER_EXCLUDES=(
  --exclude 'node_modules/' --exclude 'data/' --exclude '.env' --exclude '.env.*'
  --exclude '.DS_Store'
)
# dist/ везём отдельно, уже собранный; src/ и конфиги — для воспроизводимости.
WEB_EXCLUDES=(
  --exclude 'node_modules/' --exclude 'dist/' --exclude '.DS_Store'
)

# Аудит 2026-08-19: то же, что и в deploy.sh, — в прод не должно уезжать ничего,
# чего нет в коммите. Иначе черновик из рабочего каталога живёт на сервере, а
# откатить его `git checkout` не к чему; rsync без `--delete` не уберёт его и
# потом. Игнорируемое гитом отфильтровывает `--exclude-standard`, так что маски
# выше остаются нужны.
UNTRACKED_SERVER="$(mktemp)"
UNTRACKED_WEB="$(mktemp)"
trap 'rm -f "$UNTRACKED_SERVER" "$UNTRACKED_WEB"' EXIT
#
# Аудит 2026-08-20: `|| true` в конце этих пайплайн проглатывал падение самого
# `git ls-files` (каталог без .git, git не на PATH, занятый index). Файл
# исключений оставался пустым, счётчик — нулевым, вывод — молчаливым: гейт
# выключался, ничего об этом не сказав. Подробности — в deploy.sh.
if ! git -C "$REPO_ROOT" ls-files --others --exclude-standard -- site/server/ \
     | sed 's|^site/server/||' > "$UNTRACKED_SERVER" \
   || ! git -C "$REPO_ROOT" ls-files --others --exclude-standard -- site/web/ \
     | sed 's|^site/web/||' > "$UNTRACKED_WEB"; then
  red "git ls-files не отработал в $REPO_ROOT — нечем отличить код из коммита"
  red "  от черновика в рабочем каталоге. Выкатка остановлена."
  exit 1
fi
UNTRACKED_N="$(cat "$UNTRACKED_SERVER" "$UNTRACKED_WEB" | wc -l | tr -d ' ')"
if [ "$UNTRACKED_N" != "0" ]; then
  cyan "== не уедет в прод: $UNTRACKED_N неотслеживаемый(х) файл(ов) в site/ =="
  cat "$UNTRACKED_SERVER" "$UNTRACKED_WEB" | head -10
fi
SERVER_EXCLUDES+=(--exclude-from "$UNTRACKED_SERVER")
WEB_EXCLUDES+=(--exclude-from "$UNTRACKED_WEB")

if [ "$DRY_RUN" = "1" ]; then
  cyan "== DRY RUN: rsync --dry-run, без сборки и рестарта =="
  cyan "-- server --"
  rsync -az --dry-run --itemize-changes "${SERVER_EXCLUDES[@]}" -e "$RSYNC_SSH" "$SRC_SERVER" "$HOST:$REMOTE/server/"
  cyan "-- web (без dist) --"
  rsync -az --dry-run --itemize-changes "${WEB_EXCLUDES[@]}" -e "$RSYNC_SSH" "$SRC_WEB" "$HOST:$REMOTE/web/"
  exit 0
fi

# --- 0. сборка фронта ЛОКАЛЬНО, до любых изменений на проде ---
cyan "== 0. build site/web (tsc --noEmit && vite build) =="
BUILD_LOG="$(mktemp)"
if ! ( cd "$SRC_WEB" && bun run build ) >"$BUILD_LOG" 2>&1; then
  red "сборка фронта упала — на прод ничего не поехало:"
  tail -30 "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"
[ -f "$SRC_WEB/dist/index.html" ] || { red "после сборки нет dist/index.html"; exit 1; }

# --- 1. снапшот прода для отката ---
cyan "== 1. snapshot prod on remote =="
# Аудит 2026-08-29: три дефекта разом, все те же, что уже вычинены в deploy.sh.
#
# Имя снапшота считается НА СЕРВЕРЕ, и сюда оно не возвращалось: подсказка про
# откат печатала литеральное `<TS>` ровно в тот момент, когда она нужна.
# Забираем его в $SNAP.
#
# chmod 700 — внутрь снапшота попадает прод-`.env` сайта (там
# SITE_INGEST_TOKEN). Исключить его нельзя: без него откат не восстанавливает
# работающий сервис. Поэтому ограничиваем права и не копим копии — держим
# последние SNAP_KEEP, остальные удаляем. Раньше не удалялась ни одна.
SNAP_KEEP="${DEPLOY_SITE_SNAPSHOT_KEEP:-5}"
SNAP_OUT="$(ssh_remote "$HOST" "cd '$REMOTE' && SNAP=/root/web3-puls-predeploy-\$(date +%Y%m%d-%H%M%S) && mkdir -p \$SNAP && chmod 700 \$SNAP && rsync -a --exclude node_modules --exclude server/data ./ \$SNAP/ && ls -1d /root/web3-puls-predeploy-* 2>/dev/null | sort -r | tail -n +$(( SNAP_KEEP + 1 )) | xargs -r rm -rf; echo snapshot=\$SNAP")"
printf '%s\n' "$SNAP_OUT"
SNAP="$(printf '%s\n' "$SNAP_OUT" | sed -n 's/^snapshot=//p' | tail -1)"
[ -n "$SNAP" ] || SNAP="/root/web3-puls-predeploy-<TS>"

# Подсказка нужна из ДВУХ мест — падение шага 3 и красный health-gate.
# `--delete` обязателен: без него откат возвращает старые файлы, но оставляет
# новые, которые привёз неудачный деплой. Исключённые node_modules и
# server/data (боевой SQLite) rsync при `--delete` не трогает.
# `bun install` в откате — по той же причине, по какой он есть в шаге 3: откат
# возвращает старый package.json, а node_modules на проде остался от неудачной
# выкатки. Ставим ДО рестарта.
rollback_hint() {
  red "Rollback: ssh ${SSH_HINT}$HOST 'rsync -a --delete --exclude node_modules --exclude server/data $SNAP/ $REMOTE/ && export PATH=/root/.bun/bin:\$PATH && cd $REMOTE/server && bun install --frozen-lockfile && systemctl restart $SERVICE'"
}

# --- 2. rsync ---
# Падение rsync обязано прерывать выкатку ДО рестарта: перезапуск поверх
# наполовину синхронизированного кода — это и есть худший из исходов.
cyan "== 2. rsync server + web =="
RSYNC_LOG="$(mktemp)"
if ! { rsync -az --stats "${SERVER_EXCLUDES[@]}" -e "$RSYNC_SSH" "$SRC_SERVER" "$HOST:$REMOTE/server/" \
       && rsync -az --stats "${WEB_EXCLUDES[@]}" -e "$RSYNC_SSH" "$SRC_WEB" "$HOST:$REMOTE/web/" \
       && rsync -az --stats -e "$RSYNC_SSH" "$SRC_WEB/dist/" "$HOST:$REMOTE/web/dist/"; } \
     >"$RSYNC_LOG" 2>&1; then
  red "rsync упал — прод НЕ перезапускаем, код остаётся прежним:"
  tail -20 "$RSYNC_LOG"
  rm -f "$RSYNC_LOG"
  exit 1
fi
grep -E 'Number of files transferred|Total transferred' "$RSYNC_LOG" || true
rm -f "$RSYNC_LOG"
# --delete для dist/ нет намеренно: старые хешированные ассеты никому не мешают
# и дают доиграть уже открытым вкладкам, которые тянут их по старому index.html.

# --- 3. установка зависимостей и рестарт ---
cyan "== 3. bun install + restart $SERVICE =="
# Без обёртки `set -e` убивал скрипт прямо здесь: до health-gate и до
# единственной подсказки про откат дело не доходило никогда, хотя код на проде
# к этому моменту уже новый.
#
# Аудит 2026-08-29: шага install тут не было вовсе. rsync везёт package.json и
# bun.lock, но node_modules стоит в SERVER_EXCLUDES — на проде он оставался
# прежним, а сервис перезапускался как ни в чём не бывало. Пока в site/server
# одна devDependency (@types/bun), это ничего не ломает; сработает в день, когда
# у сайта появится первая рантайм-зависимость. Обратная сторона та же: удалённая
# из package.json зависимость продолжает жить в node_modules прода, и код,
# который на чистой машине не собрался бы, там работает. deploy/deploy.sh делает
# ровно это уже давно — здесь тот же порядок: сначала зависимости, потом рестарт.
#
# --frozen-lockfile: расхождение bun.lock с package.json на выкатке — повод
# отказаться, а не молча переписать локфайл на проде и разъехаться с репо.
# PATH: ssh без логин-шелла не знает про /root/.bun/bin.
if ! ssh_remote "$HOST" "set -e; export PATH=/root/.bun/bin:\$PATH; cd '$REMOTE/server'; \
  bun install --frozen-lockfile >/tmp/deploy-site-install.log 2>&1 || { tail -20 /tmp/deploy-site-install.log; exit 1; }; \
  systemctl restart '$SERVICE'; sleep 3; systemctl is-active '$SERVICE'"; then
  red "❌ шаг 3 (bun install / restart $SERVICE) упал — на проде уже новый код, но сервис не поднялся."
  ssh_remote "$HOST" "tail -30 /var/log/${SERVICE}.log" || true
  rollback_hint
  exit 1
fi

# --- 4. health gate ---
cyan "== 4. health check (local, with retries) =="
OK=0
for i in $(seq 1 10); do
  CODE="$(ssh_remote "$HOST" "curl -sS -o /dev/null -w '%{http_code}' '$LOCAL_HEALTH' --max-time 6" 2>/dev/null || echo 000)"
  if [ "$CODE" = "200" ]; then OK=1; break; fi
  sleep 3
done
if [ "$OK" = "1" ]; then
  cyan "✅ site deploy OK — local health 200 (deployed ${BRANCH}@${COMMIT})"
  PUB="$(curl -sSk -o /dev/null -w '%{http_code}' "$PUBLIC_HEALTH" --max-time 25 || echo 000)"
  cyan "   public $PUBLIC_HEALTH → $PUB"
else
  red "❌ health check FAILED (local $LOCAL_HEALTH не отдал 200 за ~30с). Лог:"
  ssh_remote "$HOST" "tail -30 /var/log/${SERVICE}.log" || true
  rollback_hint
  exit 1
fi
