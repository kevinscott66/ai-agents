#!/usr/bin/env bash
###############################################################################
# Автономный цикл на VPS — замена GitHub Actions (минуты приватного репо
# исчерпаны). Одна итерация:
#   fresh branch from main → claude headless (role-scoped, подписка) → commit →
#   push → PR с лейблом needs-human-review.
#
# ГАРАНТИИ БЕЗОПАСНОСТИ:
#   - Никогда НЕ пушит в main (только per-iteration ветка + PR на ревью).
#   - Изолирован в отдельном clone ($WORKDIR), НЕ трогает прод /opt/agent-team.
#   - node_modules переиспользуется из прод-деплоя через симлинк (экономия диска).
#   - claude с file-tools, но permission-mode=acceptEdits + явный allowedTools;
#     systemd запускает цикл от отдельного непривилегированного пользователя.
#   - timeout 9 мин на итерацию (cap на токены/runaway).
#
# Требует в /etc/agent-autonomous/credentials (доступен только service account):
#   - CLAUDE_CODE_OAUTH_TOKEN  (подписка claude; уже есть)
#   - GH_TOKEN                 (fine-grained PAT: repo ai-agents, Contents R/W +
#                               Pull requests R/W) — добавляет владелец.
###############################################################################
set -euo pipefail

REPO="kevinscott66/ai-agents"
WORKDIR="${AUTO_WORKDIR:-/opt/agent-autonomous}"
PROD_NM="/opt/agent-team/node_modules"
LOG="${AUTO_LOG:-/var/log/agent-autonomous.log}"
STRUCTURED_LOG="${AUTO_STRUCTURED_LOG:-/var/log/agent-autonomous.jsonl}"
ROLE="${1:-${AUTO_ROLE:-}}"
HINT="${2:-}"
CLAUDE="${CLAUDE_BIN:-/usr/local/bin/claude}"
CLAUDE_TIMEOUT_SEC="${AUTO_CLAUDE_TIMEOUT_SEC:-540}"
case "$CLAUDE_TIMEOUT_SEC" in (*[!0-9]*|'') CLAUDE_TIMEOUT_SEC=540;; esac

# Readiness is deliberately an explicit operator-controlled file.  The timer
# may remain installed, but an absent/non-green file keeps the cycle inert.
READINESS_FILE="${AUTO_READINESS_FILE:-/etc/agent-autonomous/readiness}"
DISABLE_FILE="${AUTO_DISABLE_FILE:-/etc/agent-autonomous/disabled}"
LOCK_DIR="${AUTO_LOCK_DIR:-/run/lock/agent-autonomous-cycle}"
STATE_DIR="${AUTO_STATE_DIR:-/var/lib/agent-autonomous}"
REPORT_DIR="${AUTO_REPORT_DIR:-/var/log/agent-autonomous-reports}"
BACKOFF_BASE_SEC="${AUTO_BACKOFF_BASE_SEC:-300}"
BACKOFF_MAX_SEC="${AUTO_BACKOFF_MAX_SEC:-21600}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$STRUCTURED_LOG")" \
  "$(dirname "$LOCK_DIR")" "$STATE_DIR" "$REPORT_DIR"

# --- роль: детерминированная ротация по счётчику запусков (без рандома) ---
#
# Было `(<день года>*24 + <час>) % ${#ROLES[@]}`. Ролей двенадцать, 24 кратно
# двенадцати — слагаемое с днём всегда давало 0, и формула сводилась к
# `<час> % 12`. Таймер срабатывает раз в два часа, то есть всегда на часах одной
# чётности: шесть ролей из двенадцати не выбирались НИКОГДА, сколько бы месяцев
# цикл ни работал. День в формуле создавал видимость, что перебор идёт.
#
# Счётчик в STATE_DIR даёт то, что и подразумевалось словом «ротация»: каждый
# следующий запуск берёт следующую роль, независимо от расписания таймера.
# Потеря файла состояния начинает круг заново — это хуже, чем ничего не терять,
# и гораздо лучше, чем не покрывать половину ролей.
ROLES=(backend frontend tgdev aieng qa smm copy design perm orchestrator pm product)
ROLE_STATE="$STATE_DIR/role-index"

pick_role() {
  prev=$(cat "$ROLE_STATE" 2>/dev/null || printf '')
  case "$prev" in ('' | *[!0-9]*) prev=-1 ;; esac
  idx=$(( (prev + 1) % ${#ROLES[@]} ))
  if [ "${1:-}" = "advance" ]; then
    printf '%s\n' "$idx" >"$ROLE_STATE"
  fi
  printf '%s\n' "${ROLES[$idx]}"
}

if [ "${ROLE:-}" = "--print-role" ]; then
  # Диагностический режим: какая роль пойдёт следующей. По умолчанию состояние
  # не трогается — оператор не должен сдвигать очередь одним лишь взглядом на
  # неё. Аргумент `advance` сдвигает, как это делает боевой путь ниже.
  pick_role "${HINT:-}"
  exit 0
fi

exec >>"$LOG" 2>&1
echo "================ $(date -u +%FT%TZ) autonomous-cycle ================"

log_event() {
  # Event names and numeric fields are fixed/sanitized so logs stay valid JSON
  # without ever interpolating prompts, paths containing secrets, or stderr.
  #
  # Перевод строки обязан быть В КАЖДОМ printf, а не в подстановке: `$( )`
  # срезает завершающий \n, поэтому формат с ним ничего не давал, а оба
  # `printf '%s'` дописывали событие встык к предыдущему. Файл .jsonl был одной
  # бесконечной строкой — не JSONL, а конкатенация, которую не читает ни
  # `jq -s`, ни построчный парсер.
  line=$(printf '{"ts":"%s","event":"%s","pid":%s}' \
    "$(date -u +%FT%TZ)" "$1" "$$")
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$STRUCTURED_LOG"
}

if [ "${AUTO_DISABLED:-0}" = "1" ] || [ -e "$DISABLE_FILE" ]; then
  log_event disabled
  echo "[skip] autonomous cycle disabled"
  exit 0
fi

if [ ! -f "$READINESS_FILE" ] || ! grep -qE '^(ready|green)$' "$READINESS_FILE"; then
  log_event readiness_missing_or_red
  echo "[skip] readiness gate is absent or not green"
  exit 0
fi

# mkdir is atomic across systemd invocations and avoids relying on a shared
# process table.  The directory contains only this cycle's pid marker.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log_event already_active
  echo "[skip] another autonomous cycle is already active"
  exit 0
fi
printf '%s\n' "$$" >"$LOCK_DIR/pid"

CYCLE_FAILED=0
REPORT_TS=$(date -u +%Y%m%dT%H%M%SZ)
cleanup_cycle() {
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
finish_cycle() {
  rc=$?
  status=success
  if [ "$rc" -ne 0 ] || [ "$CYCLE_FAILED" -ne 0 ]; then
    status=failure
    failures=0
    if [ -f "$STATE_DIR/failures" ]; then
      failures=$(cat "$STATE_DIR/failures" 2>/dev/null || printf '0')
    fi
    case "$failures" in (*[!0-9]*|'') failures=0;; esac
    failures=$((failures + 1))
    delay=$BACKOFF_BASE_SEC
    i=1
    while [ "$i" -lt "$failures" ] && [ "$delay" -lt "$BACKOFF_MAX_SEC" ]; do
      delay=$((delay * 2))
      i=$((i + 1))
    done
    [ "$delay" -gt "$BACKOFF_MAX_SEC" ] && delay="$BACKOFF_MAX_SEC"
    printf '%s\n' "$failures" >"$STATE_DIR/failures"
    printf '%s\n' "$(( $(date +%s) + delay ))" >"$STATE_DIR/next-run"
    log_event cycle_failed
  else
    printf '0\n' >"$STATE_DIR/failures"
    rm -f "$STATE_DIR/next-run"
    log_event cycle_succeeded
  fi
  printf '{"ts":"%s","status":"%s","exit_code":%s,"pid":%s}\n' \
    "$(date -u +%FT%TZ)" "$status" "$rc" "$$" >"$REPORT_DIR/$REPORT_TS.json"
  cleanup_cycle
}
trap finish_cycle EXIT

if [ -f "$STATE_DIR/next-run" ]; then
  NEXT_RUN=$(cat "$STATE_DIR/next-run" 2>/dev/null || printf '0')
  case "$NEXT_RUN" in (*[!0-9]*|'') NEXT_RUN=0;; esac
  if [ "$(date +%s)" -lt "$NEXT_RUN" ]; then
    log_event backoff_active
    echo "[skip] failure backoff is active"
    trap - EXIT
    cleanup_cycle
    exit 0
  fi
fi

if [ "${AUTO_ROLLBACK:-0}" = "1" ]; then
  # Rollback is limited to the isolated autonomous clone; production is never
  # addressed by this path.  It is explicit and therefore bypasses readiness.
  if [ -d "$WORKDIR/.git" ]; then
    git -C "$WORKDIR" fetch origin main --depth 50
    git -C "$WORKDIR" checkout -B main origin/main
    git -C "$WORKDIR" reset --hard origin/main
    git -C "$WORKDIR" clean -fd
  fi
  log_event rollback_completed
  exit 0
fi

# --- env: РОВНО две переменные из .env, а не весь файл ---
#
# Аудит 2026-08-12: здесь стояло `set -a; . /opt/agent-team/.env; set +a`, то
# есть в окружение процесса уезжал ВЕСЬ прод-.env: токены двенадцати ботов, ключ
# OpenAI, сессия юзербота, ingest-токен. Дальше это окружение наследовал
# headless-claude, запущенный с `--allowedTools "Bash …"`. Единственным запретом
# была строка в промпте, а промпт собирается из TASKS.md и файлов памяти —
# текста, который правит тот же агент. Явный `unset` трёх ANTHROPIC_*
# (он был нужен, чтобы CLI шёл по подписке, а не в raw API) закрывал три
# переменные из полутора десятков.
#
# Читаем .env в СУБШЕЛЛЕ и забираем только то, что нужно самой обёртке.
ENV_FILE="${AUTO_ENV_FILE:-/opt/agent-team/.env}"
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  ( set -a; . "$ENV_FILE"; set +a; printf '%s' "${!1:-}" )
}
GH_TOKEN="${GH_TOKEN:-$(env_value GH_TOKEN)}"
CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-$(env_value CLAUDE_CODE_OAUTH_TOKEN)}"
: "${GH_TOKEN:?GH_TOKEN не задан в $ENV_FILE — нужен fine-grained PAT}"
: "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN не задан}"
export GH_TOKEN GITHUB_TOKEN="$GH_TOKEN" CLAUDE_CODE_OAUTH_TOKEN

# Страховка на случай, если ANTHROPIC_* пришли из окружения юнита, а не из .env:
# claude CLI с ними идёт в raw API вместо подписки и падает на «Credit balance is
# too low». Зеркалим buildSubscriptionEnv() (agent/lib/agent-sdk-runtime.ts:120):
# аутентификация — строго CLAUDE_CODE_OAUTH_TOKEN.
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN

# --- роль: если не задана — ротация по счётчику (см. pick_role выше) ---
if [ -z "$ROLE" ]; then
  ROLE="$(pick_role advance)"
fi
echo "[info] role=$ROLE hint='${HINT}'"

# --- ПЕТЛЯ ОБРАТНОЙ СВЯЗИ: не начинать итерацию, пока очередь не разобрана ---
#
# 2026-08-13: без этого блока цикл за 11 дней открыл 114 PR. Механика была такая:
# итерация делает задачу и открывает PR → PR никто не мержит → задача в TASKS.md
# остаётся открытой → следующая итерация видит её сверху списка и делает С НУЛЯ.
# `tools-schema.ts` переписан десять раз, `self-diag.ts` семь, `styles.css` семь.
#
# Потолок стоит ПЕРЕД запуском claude: если очередь не разобрана, итерация не
# тратит ни токена. Это единственный из трёх слоёв защиты, который не зависит от
# поведения агента, — два других (список занятых задач в промпте и отказ открыть
# дубликат) полагаются на то, что агент declares задачу, а промпт правит он сам.
#
# Ошибку запроса считаем стоп-сигналом, а не «ну и ладно»: неизвестное число
# открытых PR — это ровно тот случай, ради которого потолок и заведён.
MAX_OPEN="${AUTO_MAX_OPEN_PRS:-5}"
OPEN_CNT=$(gh pr list --repo "$REPO" --state open --label needs-human-review \
             --limit 200 --json number --jq 'length' 2>/dev/null || true)
if ! printf '%s' "$OPEN_CNT" | grep -qE '^[0-9]+$'; then
  echo "[fatal] не удалось узнать число открытых PR цикла — итерацию не начинаю."
  exit 1
fi
if [ "$OPEN_CNT" -ge "$MAX_OPEN" ]; then
  echo "[skip] открытых PR цикла: $OPEN_CNT (потолок $MAX_OPEN)."
  echo "[skip] смержите или закройте их — до этого цикл стоит. Потолок: AUTO_MAX_OPEN_PRS."
  exit 0
fi
echo "[info] открытых PR цикла: $OPEN_CNT / $MAX_OPEN"

# Задачи, по которым PR уже открыт: их id вшит в заголовок PR (см. TITLE ниже).
CLAIMED_LIST=$(gh pr list --repo "$REPO" --state open --label needs-human-review \
                 --limit 200 --json number,title \
                 --jq '[.[] | select(.title | test("T-[0-9]+"))
                        | {t: (.title | capture("(?<t>T-[0-9]+)").t), n: .number}]
                       | group_by(.t)
                       | map("\(.[0].t) — PR \(map("#\(.n)") | join(", "))")
                       | .[]' 2>/dev/null || true)
if [ -n "$CLAIMED_LIST" ]; then
  CLAIMED_BLOCK="$CLAIMED_LIST"
  echo "[info] задачи в открытых PR:"; printf '%s\n' "$CLAIMED_LIST" | sed 's/^/    /'
else
  CLAIMED_BLOCK="(none — no task is currently held by an open PR)"
fi

# --- clone или обновление до origin/main ---
# Токен НЕ вшиваем в URL: git пишет remote.url в .git/config открытым текстом
# (было 644 root:root ⇒ секрет с правом записи читаем любым юзером на машине).
# Вместо этого — credential-helper, который берёт $GH_TOKEN из окружения в момент
# вызова. В .git/config попадает только текст хелпера, без самого секрета.
CLEAN_URL="https://github.com/${REPO}.git"
CRED_HELPER='!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f'
if [ ! -d "$WORKDIR/.git" ]; then
  echo "[info] cloning $REPO → $WORKDIR"
  git -c credential.helper="$CRED_HELPER" clone --depth 50 "$CLEAN_URL" "$WORKDIR"
fi
cd "$WORKDIR"
git remote set-url origin "$CLEAN_URL"
git config credential.helper "$CRED_HELPER"
chmod 600 .git/config
git fetch origin main --depth 50
# Убираем следы прошлой итерации ДО checkout, а не после. Любой ранний выход —
# DRY_RUN, отказ открыть дубликат, красный гейт секретов — оставляет рабочее
# дерево грязным, и тогда `checkout -B main` падает с «local changes would be
# overwritten» и цикл заклинивает навсегда: каждая следующая итерация умирает на
# том же месте. Поймано живьём 2026-08-13 сразу после dry-run.
git reset --hard HEAD
git clean -fd
git checkout -B main origin/main
git reset --hard origin/main
git clean -fd

# --- переиспользуем node_modules из прод-деплоя (экономия 566M) ---
if [ -d "$PROD_NM" ] && [ ! -e agent/node_modules ]; then
  ln -s "$PROD_NM" agent/node_modules
  echo "[info] symlinked agent/node_modules → $PROD_NM"
fi
# .gitignore содержит "node_modules/" — паттерн со слэшем матчит ТОЛЬКО директории,
# а симлинк git считает блобом ⇒ без этого он попадает в `git add -A` и в PR.
# .git/info/exclude — локальный, не меняет .gitignore в репо.
if ! grep -qx "agent/node_modules" .git/info/exclude 2>/dev/null; then
  echo "agent/node_modules" >> .git/info/exclude
fi

# --- fresh per-iteration ветка ---
TS=$(date -u +%Y%m%d-%H%M%S)
BR="agent/${ROLE}-vps-${TS}"
git checkout -b "$BR"
git config user.name "vps-autonomous"
git config user.email "noreply@anthropic.com"

# T-513: review open autonomous PRs before taking another task. This closes the
# feedback loop locally when GitHub Actions minutes are unavailable. The review
# mode is fail-closed: if GitHub is unreachable, do not start new agent work.
if [ "${AUTO_CONTROL_LOOP:-1}" != "0" ]; then
  echo "[info] running orchestrator control loop before iteration..."
  (cd agent && bun run agent --role orchestrator --mode review)
fi

# --- очередь роли: обёртка сама достаёт id из TASKS.md ---
# Живой прогон 2026-08-13 показал, почему этого мало — «напиши id задачи»: агент
# написал слаг `loop-dedup`. Он не ленится, ему просто негде взять точную строку,
# если он не сматчил заголовок сам. Готовый список id снимает этот шаг: копировать
# из промпта нечего перепутать. Сам id всё равно объявляет агент — подставлять его
# за агента нельзя, он может уйти работать не туда, и PR получит чужой номер.
QUEUE_BLOCK="(TASKS.md не прочитан — выбирай сам по правилам ниже)"
# Фильтр берём РЯДОМ С ОБЁРТКОЙ, а не из $WORKDIR — в рабочем дереве его только
# что мог переписать сам агент (у него Write), ровно как гейт секретов ниже.
# Нет файла — не фатал: очередь всего лишь удобство, без неё агент выбирает сам,
# как выбирал до неё. Фатал тут остановил бы цикл из-за подсказки.
QFILTER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/queue-filter.awk"
if [ ! -f "$QFILTER" ]; then
  echo "[warn] нет $QFILTER — очередь роли не собираю, агент выберет задачу сам"
elif [ -f TASKS.md ]; then
  # Без обрезки строк: `cut -c` при локали POSIX режет по байтам и рвёт UTF-8
  # посреди буквы. Пять заголовков — меньше килобайта, экономить тут нечего.
  QUEUE=$(awk -v ROLE_RE="role:${ROLE}[^a-z-]" -f "$QFILTER" TASKS.md 2>/dev/null \
          | sed -E 's/^### (T-[0-9]+)[[:space:]]*(—[[:space:]]*)?/\1 — /' || true)
  CLAIMED_IDS=$(printf '%s\n' "$CLAIMED_LIST" | grep -oE '^T-[0-9]+' \
                | tr '\n' '|' | sed 's/|$//' || true)
  if [ -n "$CLAIMED_IDS" ]; then
    QUEUE=$(printf '%s\n' "$QUEUE" | grep -avE "^(${CLAIMED_IDS}) " || true)
  fi
  QUEUE=$(printf '%s\n' "$QUEUE" | grep -av '^$' | head -5 || true)
  if [ -n "$QUEUE" ]; then
    QUEUE_BLOCK="$QUEUE"
    echo "[info] очередь role=${ROLE}:"; printf '%s\n' "$QUEUE" | sed 's/^/    /'
  else
    QUEUE_BLOCK="(нет открытых задач role:${ROLE} — действуй по шагу 1)"
    QUEUE_EMPTY=1
    echo "[info] очередь role=${ROLE}: пусто"
  fi
fi

# --- prompt for the internal role-agent supervisor ---
read -r -d '' PROMPT <<EOF || true
You are the **${ROLE}** agent in a 12-role Telegram team. You are running
autonomously on a fresh per-iteration branch cut from main. Just edit files in the
working tree — the WRAPPER SCRIPT commits, pushes, and opens a scoped PR for you.
Do NOT git push or git commit yourself.

BEFORE anything else:
  1. Read CLAUDE.md at repo root (token-economy + hard rules).
  2. Read AGENT.md (autonomy rules).
  3. Read .claude/memory/MEMORY.md and .claude/memory/facts/current-state.md.
  4. Read TASKS.md.

ROLE SCOPE — pick tasks tagged \`role:${ROLE}\` (or untagged tasks that explicitly
fall into your responsibility). Skip \`needs-human:\` tasks.

ALREADY TAKEN — a PR is open for each of these and is waiting for review. They are
still open in TASKS.md, and they are NOT yours to take. Redoing one produces a
duplicate PR of work that already exists; that is how 114 of them accumulated:
${CLAIMED_BLOCK}

YOUR QUEUE — open \`role:${ROLE}\` tasks from TASKS.md, already filtered for you
(closed, \`needs-human:\` and ALREADY TAKEN ones are removed), topmost first.
Take the first one you can actually finish in this iteration, and copy its id
character-for-character into \`.autonomous-task-id\` (step 0 below):
${QUEUE_BLOCK}

Budget per iteration: ~\$1.5, ~60 turns, ~5 min wall-time. Keep the diff small.

Workflow:
  0. BEFORE you start editing, write the id of the task you took into
     \`.autonomous-task-id\` at repo root: one line, nothing else, in the form
     \`T-805\` — the id copied verbatim from the \`### T-<number>\` heading in
     TASKS.md that you picked. A slug or a description of the work
     ("loop-dedup", "fix digest tests") is NOT an id: the wrapper discards it,
     the PR gets the \`no-task-id\` label, and the next iteration cannot tell
     what you took and will redo it. If you are not taking a task from TASKS.md,
     do not create the file at all. The wrapper reads this to refuse duplicate
     PRs and to title the PR; it does not commit the file.
  1. Pick the topmost actionable task tagged \`role:${ROLE}\` that is not in the
     ALREADY TAKEN list above. If none — append a "nothing to do" line to
     STATUS-${ROLE}.md and stop. Do NOT invent work, and do NOT pick a taken task
     "to improve it".
  2. Make focused progress on exactly one task.
  3. If the change touches agent/lib, agent/orchestrator*, agent/tools, agent/tests
     — run \`bun test\` in agent/ and keep it green before finishing.
  4. Update memory: atomic note under
     .claude/memory/notes/role-${ROLE}/<slug>.md + an episode line in
     .claude/memory/episodes/<iso-date>.md tagged [${ROLE}].
  5. Append "## Iteration — <UTC ts>" to STATUS-${ROLE}.md.
  6. If stuck two iterations on the same task → write BLOCKED-${ROLE}.md and stop.

DEFINITION OF DONE — an iteration is INCOMPLETE without steps 4 and 5.
Memory is not paperwork: you start every iteration with a cold context, so a note
you skip today is analysis the next iteration pays for again in tokens. Write the
note even when the change is small, and even when you ran out of budget mid-task —
in that case the note says what you learned and where you stopped.
You have write access (permission-mode=acceptEdits): if an edit to an existing
memory file seems blocked, that is not a permissions problem — retry it. Do NOT
silently drop steps 4-5 to save turns; finish them before you stop.

HARD RULES:
  - Never git push/commit yourself; the wrapper handles it on a per-iteration
    branch → PR. Never push to main.
  - Never modify agent/characters/* without an explicit task.
  - Never read or print secrets from /opt or .env; never touch the prod service,
    DB, or systemd. You are in an isolated checkout — stay in it.
  - All risky changes go through the PR the wrapper opens.

Optional focus hint: "${HINT}"
EOF

# PROMPT_ONLY=1 — напечатать собранный промпт и выйти, НЕ запуская claude.
# Блоки ALREADY TAKEN и YOUR QUEUE собираются из GitHub и TASKS.md, то есть
# меняются сами по себе; проверять их полным прогоном — это $1.5 и девять минут
# за просмотр двух списков. Секретов в промпте нет.
if [ "${PROMPT_ONLY:-0}" = "1" ]; then
  echo "[prompt-only] собранный промпт (claude НЕ запускается):"
  printf '%s\n' "$PROMPT"
  echo "[prompt-only] ветка $BR оставлена локально в $WORKDIR"
  exit 0
fi

# Пустая очередь — не запускаем claude вообще.
#
# Раньше пустая очередь означала «выбирай сам», и это ровно тот режим, из которого
# выросли ~75 PR без единой строки кода: агент не находил своей задачи, но итерацию
# ему уже оплатили, и он писал в `.claude/memory/**` и TASKS.md, чтобы не выйти с
# пустыми руками. Ротация ролей детерминированная (день+час), так что пропуск —
# это просто «у этой роли сейчас нет работы»: через два часа придёт следующая.
#
# Пропускаем ТОЛЬКО когда фильтр отработал и вернул ноль. Нет TASKS.md, нет
# queue-filter.awk, grep упал — это «неизвестно», а не «пусто»: там QUEUE_EMPTY не
# выставлен, и итерация идёт как раньше. Явный HINT от человека тоже сильнее
# очереди: если попросили конкретное — делаем, даже если в TASKS.md пусто.
if [ "${QUEUE_EMPTY:-0}" = "1" ] && [ -z "$HINT" ]; then
  echo "[skip] нет открытых задач role:${ROLE} — claude не запускаю, итерация бесплатная."
  echo "[skip] следующая роль по ротации придёт через 2 часа."
  exit 0
fi

# --- claude headless (file-tools включены, в non-root sandbox) ---
# permission-mode=acceptEdits, а НЕ default:
# на dry-run 2 (2026-08-02) агент под `default` не смог дописать существующие
# .claude/memory/MEMORY.md и episodes/<date>.md («require approval») — новые файлы
# создавались, правка существующих блокировалась, и шаг 4 промпта (обновить память)
# тихо отваливался. acceptEdits авто-принимает правки файлов, оставаясь строже
# bypassPermissions. --max-budget-usd — жёсткий потолок трат (в дополнение к timeout).
#
# Аудит 2026-08-12: GH_TOKEN сюда не передаём. Промпт выше прямо запрещает агенту
# коммитить и пушить — этим занимается обёртка ниже, уже после гейта секретов.
# Значит токену с правом записи в репозиторий нечего делать в окружении процесса,
# у которого включён Bash.
echo "[info] running claude (timeout ${CLAUDE_TIMEOUT_SEC}s, budget \$2)…"
# Keep the wrapper's GitHub and Claude credentials out of the child process.
# The Claude CLI must use its own pre-authenticated local credential store.
env -i \
  PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/var/lib/agent-autonomous}" \
  USER="${USER:-agent-autonomous}" LOGNAME="${LOGNAME:-${USER:-agent-autonomous}}" \
  SHELL="${SHELL:-/bin/sh}" LANG="${LANG:-C}" TERM="${TERM:-dumb}" \
  PWD="$WORKDIR" \
timeout "$CLAUDE_TIMEOUT_SEC" "$CLAUDE" -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools "Bash Edit Write Read Glob Grep WebFetch WebSearch" \
  --max-budget-usd 2 \
  --output-format text \
  || { CYCLE_FAILED=1; echo "[warn] claude exited non-zero or timed out"; exit 1; }

# --- какую задачу агент объявил ---
# Файл служебный: в коммит не попадает (иначе он бы уехал в PR и в main).
if ! grep -qx ".autonomous-task-id" .git/info/exclude 2>/dev/null; then
  echo ".autonomous-task-id" >> .git/info/exclude
fi
TASK_ID=""
if [ -f .autonomous-task-id ]; then
  TASK_ID=$(head -1 .autonomous-task-id | tr -d '[:space:]')
  rm -f .autonomous-task-id
fi
# В заголовок PR идёт только то, что действительно похоже на id: строка оттуда
# попадает в `gh pr create --title`, а пишет её агент.
if [ -n "$TASK_ID" ] && ! printf '%s' "$TASK_ID" | grep -qE '^T-[0-9]+$'; then
  echo "[warn] .autonomous-task-id = '$TASK_ID' — не похоже на T-<число>, игнорирую"
  TASK_ID=""
fi

if [ -z "$TASK_ID" ]; then
  echo "[warn] агент не объявил задачу — PR будет помечен лейблом no-task-id."
fi

# --- есть изменения? ---
if git diff --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "[info] no changes — exit cleanly"
  exit 0
fi

git add -A
# страховка: симлинк не должен попасть в коммит (см. .git/info/exclude выше)
git rm --cached --quiet agent/node_modules 2>/dev/null || true

# hard rule CLAUDE.md #5 — `git add -A` вслепую запрещён; логируем, что реально стажим
echo "[info] staged files:"
git diff --staged --name-only | sed 's/^/    /'

# --- гейт секретов: между `git add -A` и коммитом ---
# Логирование имён файлов выше — это отчёт, а не проверка: никто его не читает
# до того, как ветка уже запушена и PR открыт. Содержимое смотрит скрипт.
# Коды: 0 чисто, 1 нашёл, 2 проверку выполнить не удалось — второе тоже стоп.
#
# Берём скрипт РЯДОМ С ОБЁРТКОЙ (/opt/vps-autonomous/), а не из $WORKDIR: в
# рабочем дереве его только что мог переписать сам агент — у него Write. Гейт,
# который проверяемый и правит, не гейт. Нет файла — не коммитим вовсе.
SCAN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-staged-secrets.sh"
if [ ! -f "$SCAN" ]; then
  echo "[fatal] нет $SCAN — коммит без проверки секретов запрещён."
  echo "[fatal] скопируйте его рядом с обёрткой: см. deploy/vps-autonomous/README.md"
  exit 1
fi
if ! bash "$SCAN"; then
  echo "[fatal] гейт секретов не пропустил стейдж — НЕ коммичу, НЕ пушу, PR НЕ создаю."
  echo "[fatal] ветка $BR в $WORKDIR. Смотрите СЕЙЧАС: следующая итерация начнётся"
  echo "[fatal] с reset --hard и сотрёт дерево. Коммитить флагнутое гейтом нельзя."
  exit 1
fi

# Дубликат: агент взял задачу, которая уже в открытом PR. Промпт это запрещает,
# но промпт — текст, который правит он же; проверка обязана быть здесь.
#
# Стоит ПОСЛЕ гейта секретов намеренно: наработки сохраняем локальным коммитом,
# чтобы не потерять их при `reset --hard` в начале следующей итерации, — а
# коммитить непроверенный стейдж нельзя, даже если он никуда не уедет.
if [ -n "$TASK_ID" ] && printf '%s\n' "$CLAIMED_LIST" | grep -q "^${TASK_ID} "; then
  echo "[skip] $TASK_ID уже в открытом PR — дубликат не создаю."
  git commit -q -m "wip(${ROLE}): ${TASK_ID} — дубликат открытого PR, не пушим"
  echo "[skip] наработки в локальном коммите на ветке $BR ($WORKDIR). Не запушены."
  exit 0
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[dry-run] НЕ коммичу, НЕ пушу, PR НЕ создаю."
  echo "[dry-run] diffstat:"
  git --no-pager diff --staged --stat | sed 's/^/    /'
  echo "[dry-run] ветка $BR в $WORKDIR; дерево грязное — следующий запуск его сбросит."
  exit 0
fi

# id задачи вшивается в ЗАГОЛОВОК PR — оттуда его читает следующая итерация
# (CLAIMED_LIST выше). Тело PR для этого не годится: его правят руками.
if [ -n "$TASK_ID" ]; then
  TITLE="agent(${ROLE}): ${TASK_ID} — autonomous VPS iteration ${TS}"
else
  TITLE="agent(${ROLE}): autonomous VPS iteration ${TS}"
fi

git commit -m "$TITLE"
git push -u origin "$BR"

# --- PR ---
gh label create needs-human-review --color FBCA04 \
  --description "PR from autonomous agent — needs human review" 2>/dev/null || true
gh label create no-task-id --color D93F0B \
  --description "Автономный PR без объявленной задачи — дедупликация не сработает" 2>/dev/null || true
if gh pr create --repo "$REPO" --head "$BR" --base main \
     --title "$TITLE" \
     --body "Автономный PR от роли **${ROLE}** (VPS-таймер, замена GitHub Actions). Требует ревью человеком перед мерджем.

Задача: ${TASK_ID:-не объявлена}

Пока этот PR открыт, цикл не возьмёт эту задачу повторно. Потолок открытых PR цикла — \`AUTO_MAX_OPEN_PRS\` (по умолчанию 5); при его достижении итерации не запускаются вовсе."; then
  gh pr edit "$BR" --add-label needs-human-review || true
  [ -z "$TASK_ID" ] && gh pr edit "$BR" --add-label no-task-id || true
  echo "[ok] PR opened for $BR (задача: ${TASK_ID:-не объявлена})"
else
  echo "[warn] gh pr create failed (ветка запушена: $BR)"
fi
echo "================ done $BR ================"
