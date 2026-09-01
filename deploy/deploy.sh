#!/usr/bin/env bash
#
# deploy.sh — one-command deploy of the local repo's agent/ to production.
#
# Created 2026-06-06 (server migration follow-up). Production runs a FLAT copy:
#   repo  agent/*  ==  prod  /opt/agent-team/*
# so we rsync agent/ → /opt/agent-team/ (never --delete; .env + data/ + node_modules
# are excluded and stay put), then bun install, rebuild the Mini App, restart the unit,
# and health-check. A pre-deploy snapshot of prod code is taken for instant rollback.
#
# Prod (since 2026-06-06): dedicated deploy user on 203.0.113.10, Mini App HTTPS https://agents.example.com:8443
# (nginx → 127.0.0.1:8787; port 443 is an unrelated xray VPN — untouched).
#
# Usage:
#   DEPLOY_HOST=agent-deploy@203.0.113.10 DEPLOY_SSH_KEY=~/.ssh/agent_team_deploy deploy/deploy.sh
#   DRY_RUN=1 DEPLOY_HOST=agent-deploy@203.0.113.10 DEPLOY_SSH_KEY=~/.ssh/agent_team_deploy deploy/deploy.sh
#
# Requires: ssh access to the prod host from this machine (the user's Mac has it).
# This script intentionally does NOT touch prod .env, data/, or the xray VPN.

set -euo pipefail

HOST="${DEPLOY_HOST-}"
REMOTE="${DEPLOY_PATH:-/opt/agent-team}"
SERVICE="${DEPLOY_SERVICE:-agent-team}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-https://agents.example.com:8443/api/health}"
DRY_RUN="${DRY_RUN:-0}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY-}"

# Resolve repo root from this script's location (deploy/ is at repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/agent/"

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
red()  { printf '\033[31m%s\033[0m\n' "$*"; }

if [ -z "${HOST//[[:space:]]/}" ]; then
  red "DEPLOY_HOST обязателен: укажите выделенного deploy-пользователя и хост."
  exit 2
fi
case "$HOST" in
  root|root@*)
    red "DEPLOY_HOST не может использовать root; настройте выделенного deploy-пользователя."
    exit 2
    ;;
esac

# Do not depend on the operator's SSH agent/config. In particular, a global
# `IdentitiesOnly yes` can silently ignore a key that was just added to the
# agent. The explicit key is used consistently by ssh, rsync, and deploy-lock.
SSH_ARGS=()
RSYNC_SSH="ssh"
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
  export DEPLOY_LOCK_SSH="$RSYNC_SSH"
fi

ssh_remote() {
  ssh "${SSH_ARGS[@]}" "$@"
}

# Замок берётся ниже (шаг 0), но снимать его нужно из trap на EXIT, который
# ставится раньше — вместе с уборкой временного файла исключений. Пока
# LOCK_HELD не выставлен, функция ничего не делает: DRY_RUN и любой отказ до
# шага 0 не должны трогать чужой замок.
LOCK_HELD=0
release_deploy_lock() {
  [ "$LOCK_HELD" = "1" ] || return 0
  "$SCRIPT_DIR/deploy-lock.sh" release >/dev/null 2>&1 || true
  LOCK_HELD=0
}

[ -d "$SRC" ] || { red "agent/ not found at $SRC"; exit 1; }

# --- sanity: branch + cleanliness (warn, don't block) ---
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
[ "$BRANCH" = "main" ] || red "WARNING: deploying from '$BRANCH', not main."
# Аудит 2026-08-12: предупреждение «working tree has uncommitted changes» само по
# себе бесполезно — скрипт синхронизирует ТОЛЬКО agent/, и правки в site/ или в
# памяти на прод не влияют вовсе, а одна незакоммиченная строка в agent/lib/
# означает, что в проде окажется код, которого нет ни в одном коммите: откатить
# его `git checkout` будет не к чему. Показываем именно то, что уедет.
DIRTY_IN_AGENT="$(git -C "$REPO_ROOT" status --porcelain -- agent/ 2>/dev/null || true)"
if [ -n "$DIRTY_IN_AGENT" ]; then
  red "WARNING: в agent/ есть незакоммиченные изменения — они уедут в прод, но их нет в git:"
  printf '%s\n' "$DIRTY_IN_AGENT" | head -20
  COUNT="$(printf '%s\n' "$DIRTY_IN_AGENT" | wc -l | tr -d ' ')"
  # Именно if: при set -e непройденный `[ ]` в конце &&-списка валит скрипт.
  if [ "$COUNT" -gt 20 ]; then red "  … и ещё $((COUNT - 20)) файл(ов)."; fi
  red "  Откатить такой деплой git'ом будет не к чему — закоммить перед выкаткой."
fi
cyan "Deploying ${BRANCH}@${COMMIT} → ${HOST}:${REMOTE}"

# Аудит 2026-08-08: `memory/` — это РАНТАЙМ-состояние, а не код.
# agent/lib/memory.ts пишет вики в `MEMORY_DIR ?? "memory"` относительно cwd, а cwd
# юнита — /opt/agent-team. То есть боевые index.md/log.md каждой из 12 ролей лежат
# ровно там, куда бьёт этот rsync. В репозитории те же пути лежат ЗАГОТОВКАМИ,
# закоммиченными один раз при бутстрапе (7b2abea) и с тех пор не менявшимися.
# rsync -a сравнивает size+mtime, а не «кто новее», и --update здесь нет: каждый
# деплой затирал накопленный append-only log.md пустой трёхстрочной шапкой.
# Отдельно неприятно для страниц: их содержимое дублируется в FTS5 (wiki_fts в
# data/, а data/ исключён) — после деплоя SEARCH_WIKI находил страницу, а
# READ_WIKI отдавал откатившийся файл. Заготовки прод переживёт без них:
# wikiAppendLog/wikiWrite делают mkdirSync(recursive) сами.
RSYNC_EXCLUDES=(
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude '.env.*'
  --exclude 'memory'
  --exclude 'backups' --exclude 'miniapp/node_modules' --exclude 'miniapp/dist'
  --exclude '.DS_Store' --exclude 'debug-*.ts' --exclude 'probe-*.ts' --exclude 'smoke-*.ts'
)

# Аудит 2026-08-19: списка масок (`probe-*`, `debug-*`, `smoke-*`) недостаточно —
# он ловит только те черновики, чьё имя кто-то заранее угадал. `send-test-trigger.ts`
# и `test-banner.ts` под маски не подошли и уехали в прод, где и лежали, пока их
# не заметили: rsync без `--delete` не убирает то, что однажды доставил.
#
# Поэтому вдобавок к маскам исключаем ВСЁ, чего git не отслеживает. Гейт на
# уровне «есть ли это в коммите», а не «похоже ли имя на черновик»: в прод
# уезжает ровно тот код, который можно откатить `git checkout`. Игнорируемое
# гитом (`node_modules/`, `data/`, `.env`) сюда не попадает — `--exclude-standard`
# его отфильтровывает, поэтому маски выше остаются нужны.
UNTRACKED_EXCLUDES="$(mktemp)"
trap 'rm -f "$UNTRACKED_EXCLUDES"; release_deploy_lock' EXIT
#
# Аудит 2026-08-20: здесь стояло `… > "$UNTRACKED_EXCLUDES" || true`, и `|| true`
# относился ко ВСЕЙ пайплайне. Не отработал `git ls-files` (каталог без .git —
# распакованный архив или копия без истории; git не на PATH; занятый index) —
# `>` уже усёк файл, ошибку проглотили, список исключений остался ПУСТЫМ.
# UNTRACKED_COUNT=0, ветка ниже не срабатывает, в выводе об этом ни строчки:
# гейт беззвучно деградировал до одних масок выше — ровно то состояние, из-за
# которого send-test-trigger.ts и test-banner.ts оказались в проде.
# Без git мы не знаем, что отслеживается, — значит и выкатывать нечего.
if ! git -C "$REPO_ROOT" ls-files --others --exclude-standard -- agent/ \
     | sed 's|^agent/||' > "$UNTRACKED_EXCLUDES"; then
  red "git ls-files не отработал в $REPO_ROOT — нечем отличить код из коммита"
  red "  от черновика в рабочем каталоге. Выкатка остановлена."
  exit 1
fi
UNTRACKED_COUNT="$(wc -l < "$UNTRACKED_EXCLUDES" | tr -d ' ')"
if [ "$UNTRACKED_COUNT" != "0" ]; then
  cyan "== не уедет в прод: $UNTRACKED_COUNT неотслеживаемый(х) файл(ов) в agent/ =="
  head -10 "$UNTRACKED_EXCLUDES"
fi
RSYNC_EXCLUDES+=(--exclude-from "$UNTRACKED_EXCLUDES")

if [ "$DRY_RUN" = "1" ]; then
  cyan "== DRY RUN: rsync --dry-run, no restart =="
  rsync -az --dry-run --itemize-changes "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_SSH" "$SRC" "$HOST:$REMOTE/"
  exit 0
fi

# --- 0. взаимный замок против второй выкатки ---
# Катить в /opt/agent-team умеют два независимых пути: этот скрипт с Mac и
# workflow .github/workflows/deploy.yml в CI. Между СОБОЙ workflow уже
# сериализуются общей `concurrency: group: deploy-vps` (её же переиспользует
# nightly-deploy.yml, который сам ничего не катит, а лишь дёргает deploy.yml).
# Про эту группу Mac не знает вовсе, и CI про Mac — тоже.
#
# Два одновременных rsync в один каталог — это ещё полбеды. Хуже шаг 1 ниже:
# каждая выкатка снимает «снапшот прода до деплоя», и вторая снимает его с уже
# наполовину перезаписанного дерева. То есть в момент, когда откат нужен,
# откатываться становится некуда — обе копии бракованные.
cyan "== 0. замок выкатки на $HOST =="
# Отдельная проверка, чтобы «нет файла» не выглядело как «занято»: причины
# разные, а действие оператора — тоже. Катить без замка нельзя, ради этого он
# и добавлен, поэтому отсутствие хелпера останавливает выкатку.
if [ ! -x "$SCRIPT_DIR/deploy-lock.sh" ]; then
  red "❌ нет $SCRIPT_DIR/deploy-lock.sh — без замка выкатка не начнётся."
  red "   Похоже на частичный чекаут: проверьте, что репозиторий цел."
  exit 1
fi
DEPLOY_LOCK_TOKEN="mac-$$-$(date +%s)"
DEPLOY_LOCK_OWNER="mac ${USER:-?}@$(hostname -s 2>/dev/null || echo '?') ${BRANCH}@${COMMIT}"
export DEPLOY_LOCK_TOKEN DEPLOY_LOCK_OWNER
if ! LOCK_OUT="$("$SCRIPT_DIR/deploy-lock.sh" acquire 2>&1)"; then
  red "❌ на $HOST уже идёт выкатка — вторая не начнётся:"
  printf '%s\n' "$LOCK_OUT" | sed 's/^/   /'
  red "   Дождитесь её конца. Если она точно мертва — снимите замок вручную:"
  red "   ssh $HOST 'rm -rf ${DEPLOY_LOCK_DIR:-/run/lock/agent-team-deploy.lock}'"
  exit 1
fi
printf '%s\n' "$LOCK_OUT"
LOCK_HELD=1

# --- 1. pre-deploy snapshot for rollback ---
cyan "== 1. snapshot prod code on remote =="
# Имя снапшота считается НА СЕРВЕРЕ, поэтому его нужно забрать сюда. Без этого
# подсказка про откат печатала литеральное `<TS>`: ровно в тот момент, когда она
# нужна, оператор всё равно шёл искать каталог руками.
#
# Снапшоты лежат в deploy-owned каталоге, а `.env` в них НЕ попадает: runtime
# секреты принадлежат root:agent-team и не должны становиться доступными deploy
# account. Откат кода не должен заменять production environment.
SNAP_KEEP="${DEPLOY_SNAPSHOT_KEEP:-5}"
SNAP_DIR="${DEPLOY_SNAPSHOT_DIR:-/var/lib/agent-team/deploy-snapshots}"
SNAP_OUT="$(ssh_remote "$HOST" "set -e; cd '$REMOTE' && SNAP='$SNAP_DIR/agent-team-predeploy-'\$(date +%Y%m%d-%H%M%S) && mkdir -p \"\$SNAP\" && chmod 700 \"\$SNAP\" && rsync -a --exclude node_modules --exclude data --exclude .env --exclude '.env.*' --exclude memory --exclude backups --exclude .eliza --exclude miniapp/node_modules --exclude miniapp/dist ./ \"\$SNAP/\" && ls -1d '$SNAP_DIR'/agent-team-predeploy-* 2>/dev/null | sort -r | tail -n +$(( SNAP_KEEP + 1 )) | xargs -r rm -rf && echo snapshot=\$SNAP")"
printf '%s\n' "$SNAP_OUT"
SNAP="$(printf '%s\n' "$SNAP_OUT" | sed -n 's/^snapshot=//p' | tail -1)"
[ -n "$SNAP" ] || SNAP="$SNAP_DIR/agent-team-predeploy-<TS>"

# Подсказка про откат нужна из ДВУХ мест — падение шага 3 и красный health-gate.
# `--delete` обязателен: без него откат возвращает старые файлы, но оставляет
# новые, которые привёз неудачный деплой. Исключённые node_modules и data
# rsync при `--delete` не трогает.
rollback_hint() {
  red "Rollback: ssh $HOST 'rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude \".env.*\" --exclude memory --exclude backups --exclude .eliza --exclude miniapp/node_modules --exclude miniapp/dist $SNAP/ $REMOTE/ && cd $REMOTE && /usr/local/bin/bun install && sudo -n /usr/local/sbin/agent-team-deploy restart'"
}

# --- 2. rsync code ---
cyan "== 2. rsync agent/ → $REMOTE =="
# Аудит 2026-08-12: раньше здесь было
#   rsync … | grep -E 'Number of files|transferred' || true
# и `|| true` глотал результат ВСЕЙ пайплайны, включая падение самого rsync
# (оборвалась сеть, кончилось место, отвалились права). Скрипт как ни в чём не
# бывало шёл на шаг 3 и делал systemctl restart поверх наполовину
# синхронизированного кода. `|| true` должен относиться только к grep, которому
# нечего показать, а не к передаче файлов.
RSYNC_LOG="$(mktemp)"
if ! rsync -az --stats "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_SSH" "$SRC" "$HOST:$REMOTE/" \
     >"$RSYNC_LOG" 2>&1; then
  red "rsync упал — прод НЕ перезапускаем, код остаётся прежним:"
  tail -20 "$RSYNC_LOG"
  rm -f "$RSYNC_LOG"
  exit 1
fi
grep -E 'Number of files|transferred' "$RSYNC_LOG" || true
rm -f "$RSYNC_LOG"

# --- 3. install deps, rebuild Mini App, restart ---
cyan "== 3. bun install + miniapp build + restart =="
# Шаг не был обёрнут вовсе. При `set -euo pipefail` любой его отказ — упавший
# `bun install`, сломанный билд Mini App, сервис, не поднявшийся после restart —
# убивал скрипт прямо здесь. До health-gate и до подсказки про откат дело не
# доходило НИКОГДА: оператор видел голый ненулевой код ssh в момент, когда прод
# уже перезапущен поверх нового кода, и оставался без единственной строчки,
# которая говорит, как вернуться.
if ! ssh_remote "$HOST" "set -e; export PATH=/usr/local/bin:\$PATH; cd '$REMOTE'; \
  install_log=\$(mktemp /tmp/agent-team-install.XXXXXX); build_log=\$(mktemp /tmp/agent-team-build.XXXXXX); \
  bun install >\"\$install_log\" 2>&1 || { tail -20 \"\$install_log\"; rm -f \"\$install_log\" \"\$build_log\"; exit 1; }; \
  ( cd miniapp && bun install >/dev/null 2>&1 && bun run build >\"\$build_log\" 2>&1 ) || { tail -20 \"\$build_log\"; rm -f \"\$install_log\" \"\$build_log\"; exit 1; }; \
  rm -f \"\$install_log\" \"\$build_log\"; \
  sudo -n /usr/local/sbin/agent-team-deploy restart; sleep 7; sudo -n /usr/local/sbin/agent-team-deploy is-active"; then
  red "❌ шаг 3 (install / miniapp build / restart) упал — прод в неопределённом состоянии."
  ssh_remote "$HOST" "tail -30 /var/log/${SERVICE}.log" || true
  rollback_hint
  exit 1
fi

# --- 4. health gate ---
# True readiness signal is the LOCAL endpoint (127.0.0.1:8787) — instant.
# The public HTTPS URL goes through nginx and can take 10-15s right after a
# restart (cold TLS/proxy), which previously caused a single-shot 20s timeout
# to print a scary (and false) rollback hint. Poll local with retries instead.
cyan "== 4. health check (local, with retries) =="
LOCAL_HEALTH="${DEPLOY_LOCAL_HEALTH_URL:-http://127.0.0.1:8787/api/health}"
OK=0
for i in $(seq 1 12); do
  CODE="$(ssh_remote "$HOST" "curl -sS -o /dev/null -w '%{http_code}' '$LOCAL_HEALTH' --max-time 6" 2>/dev/null || echo 000)"
  if [ "$CODE" = "200" ]; then OK=1; break; fi
  sleep 3
done
if [ "$OK" = "1" ]; then
  cyan "✅ deploy OK — local health 200 (deployed ${BRANCH}@${COMMIT})"
  # Best-effort public probe (informational only — never fails the deploy).
  PUB="$(curl -sS -o /dev/null -w '%{http_code}' "$HEALTH_URL" --max-time 25 || echo 000)"
  cyan "   public $HEALTH_URL → $PUB"
else
  red "❌ health check FAILED (local $LOCAL_HEALTH never returned 200 за ~108s: 12 попыток по 6s ожидания curl + 3s паузы). Recent log:"
  ssh_remote "$HOST" "tail -30 /var/log/${SERVICE}.log" || true
  rollback_hint
  exit 1
fi
