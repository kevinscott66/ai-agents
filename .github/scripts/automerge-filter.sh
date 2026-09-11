#!/usr/bin/env bash
# Решение «мёрджить или нет» — вынесено из воркфлоу auto-merge.yml, чтобы его
# можно было прогнать тестами (agent/tests/automerge-filter.test.ts).
#
# Аудит 2026-09-11: воркфлоу удалён при публичном релизе 2026-09-01, и с тех
# пор этот файл НИЧЕГО не решает — его не запускает ни один воркфлоу, он
# остался записанной политикой и проверяется только тестами. Единственный
# живой автомерж — isAutoMergeable() в agent/lib/dispatch/github.ts. Правка
# здесь не меняет поведения репозитория; чтобы изменилось, править надо там.
#
# Вход: на stdin — JSON-массив от
#   gh pr list --json number,headRefName,isDraft,mergeable,mergeStateStatus,labels,files,statusCheckRollup
# Выход: по строке на PR —
#   MERGE <number> <headRefName>
#   SKIP  <number> <причина>
# Код возврата 0, даже если мёрджить нечего. Ненулевой — только если вход не JSON.
#
# Аудит 2026-08-12 — почему логика переехала сюда и что в ней было сломано:
#
# 1. Блокирующие метки проверялись как `grep -qE ',(hold|risky|needs-human|
#    do-not-merge),'` по склеенному запятыми списку. Настоящая метка в репо
#    называется `needs-human-review`, то есть ',needs-human-review,' под
#    ',needs-human,' не подходит НИКОГДА. Замер на живом списке (40 открытых
#    PR, 2026-08-12): 24 PR прошли бы фильтр, и все 24 помечены
#    needs-human-review. Метка, которая существует ровно чтобы звать человека,
#    не блокировала ничего.
#
# 2. CI-гейта не было вовсе, хотя шапка auto-merge.yml обещала «CI зелёный».
#    Единственной проверкой был mergeStateStatus, а BLOCKED появляется только
#    при branch protection — на приватном репо free-плана она недоступна
#    (GET /branches/main/protection → 403 «Upgrade to GitHub Pro»). Все 24 PR
#    были UNSTABLE с «Test suite baseline floor (>=670 pass) FAILURE» — то есть
#    вливались бы с красными тестами.
#
# Обе дыры чинятся здесь: метки сверяются по точному имени (плюс семейство
# needs-human*), а статусы чеков обязаны быть зелёными — «нет чеков» и «чеки
# ещё идут» считаются НЕ зелёным (fail-closed: следующий прогон по крону
# вернётся к этому PR, когда CI отработает).
#
# Аудит 2026-08-29 — ещё две дыры того же рода:
#
# 3. Личность автора не проверялась вообще: воркфлоу не запрашивал ни `author`,
#    ни `isCrossRepository`, а фильтр их не смотрел. Посторонний PR из форка
#    останавливало только требование зелёного CI — у первого PR нового
#    контрибьютора воркфлоу ждут ручного одобрения, поэтому чеков нет. Дыру
#    закрывала настройка GitHub, а не наш код: второму PR того же автора
#    одобрение уже не нужно. Теперь форк отсекается, а автор обязан быть в
#    аллоу-листе (AUTOMERGE_ALLOWED_AUTHORS, по умолчанию — владелец репо).
#
# 4. `.gitignore` лежал в безопасном списке. Это файл, который держит вне git
#    рантайм-БД (`agent/data/*.db`) и StringSession юзербота (`*.session` —
#    учётные данные). PR, удаляющий эти строки, трогает ТОЛЬКО `.gitignore`,
#    то есть проходил все остальные гейты. Убран из безопасных.

set -euo pipefail

INPUT=$(cat)

# Пустой вход — нечего решать (jq на пустой строке падает).
if [ -z "${INPUT//[[:space:]]/}" ]; then
  exit 0
fi

# Безопасные пути. Список обязан совпадать с isAutoMergeable() в
# agent/lib/dispatch/github.ts — сверку держит
# agent/tests/pr-risky-paths-allowlist.test.ts, там же перечислены намеренные
# расхождения. Раньше здесь стояло «совпадать с шапкой auto-merge.yml»: шапки
# нет с 2026-09-01, и сверять список было не с чем.
# Memory, task boards, and status files сюда НЕ входят: автономный Claude
# читает их в будущих запусках, поэтому их правку человек смотрит глазами.
is_safe_path() {
  case "$1" in
    docs/*|README*.md) return 0 ;;
    .github/workflows/README*.md) return 0 ;;
    # `.gitignore` тут был до аудита 2026-08-29 — см. пункт 4 в шапке.
    *) return 1 ;;
  esac
}

# Кому вообще позволено вливаться автоматически. Список задаётся через
# окружение (для тестов и на случай второго аккаунта), пустая или пробельная
# переменная означает «не задано» — как `KEY=` в EnvironmentFile, где значение
# приходит пустой строкой, а не отсутствует.
ALLOWED_AUTHORS="${AUTOMERGE_ALLOWED_AUTHORS:-}"
if [ -z "${ALLOWED_AUTHORS//[[:space:]]/}" ]; then
  ALLOWED_AUTHORS="kevinscott66"
fi

is_allowed_author() {
  # Пустой логин — это «поля author в JSON не было», а не «автор неважен».
  [ -n "$1" ] || return 1
  case ",$ALLOWED_AUTHORS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# gh отдаёт максимум 100 файлов на PR; ровно 100 — повод считать список
# обрезанным и не решать по нему судьбу мёрджа.
FILES_PAGE_LIMIT=100

while IFS= read -r PR; do
  # `<<<` всегда даёт хотя бы одну строку, в том числе пустую: без этой
  # проверки пустой список PR превращался бы в один разбор пустышки.
  [ -z "$PR" ] && continue

  NUM=$(jq -r '.number' <<< "$PR")
  BR=$(jq -r '.headRefName' <<< "$PR")

  # Личность — раньше всех прочих проверок: про чужой PR полезнее узнать, что
  # он чужой, чем что он черновик.
  if [ "$(jq -r '.isCrossRepository' <<< "$PR")" = "true" ]; then
    echo "SKIP $NUM fork_pr"; continue
  fi

  AUTHOR=$(jq -r '.author.login // ""' <<< "$PR")
  if ! is_allowed_author "$AUTHOR"; then
    echo "SKIP $NUM untrusted_author:${AUTHOR:-<unknown>}"; continue
  fi

  if [ "$(jq -r '.isDraft' <<< "$PR")" = "true" ]; then
    echo "SKIP $NUM draft"; continue
  fi

  # Метки — точное сравнение имени, без склейки в строку: имя с запятой внутри
  # ломало бы разбор, а подстрока ловила бы не то.
  BLOCKING=$(jq -r '
    [ .labels[].name
      | select(. == "hold" or . == "risky" or . == "do-not-merge"
               or startswith("needs-human")) ]
    | join(",")' <<< "$PR")
  if [ -n "$BLOCKING" ]; then
    echo "SKIP $NUM blocking_label:$BLOCKING"; continue
  fi

  MERGEABLE=$(jq -r '.mergeable' <<< "$PR")
  if [ "$MERGEABLE" != "MERGEABLE" ]; then
    echo "SKIP $NUM not_mergeable:$MERGEABLE"; continue
  fi

  MSTATE=$(jq -r '.mergeStateStatus' <<< "$PR")
  if [ "$MSTATE" = "DIRTY" ] || [ "$MSTATE" = "BLOCKED" ]; then
    echo "SKIP $NUM merge_state:$MSTATE"; continue
  fi

  # CI-гейт. У чек-рана итог лежит в .conclusion, у статуса коммита — в .state.
  # Зелёными считаем только SUCCESS/NEUTRAL/SKIPPED; всё остальное (FAILURE,
  # ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, PENDING, QUEUED, IN_PROGRESS,
  # null у ещё не стартовавшего чека) — не зелёное.
  ROLLUP=$(jq -r '.statusCheckRollup // [] | length' <<< "$PR")
  if [ "$ROLLUP" = "0" ]; then
    echo "SKIP $NUM no_checks"; continue
  fi
  BAD=$(jq -r '
    [ .statusCheckRollup[]
      | { n: (.name // .context // "check"),
          s: (.conclusion // .state // "PENDING") }
      | select((.s | ascii_upcase) as $s
               | $s != "SUCCESS" and $s != "NEUTRAL" and $s != "SKIPPED")
      | "\(.n)=\(.s)" ]
    | join(",")' <<< "$PR")
  if [ -n "$BAD" ]; then
    echo "SKIP $NUM ci_not_green:$BAD"; continue
  fi

  # Пустой список файлов — это «не знаю, что в PR», а не «в PR ничего опасного».
  FILE_COUNT=$(jq -r '.files // [] | length' <<< "$PR")
  if [ "$FILE_COUNT" = "0" ]; then
    echo "SKIP $NUM no_files"; continue
  fi
  if [ "$FILE_COUNT" -ge "$FILES_PAGE_LIMIT" ]; then
    echo "SKIP $NUM file_list_truncated:$FILE_COUNT"; continue
  fi

  UNSAFE=""
  while IFS= read -r F; do
    [ -z "$F" ] && continue
    is_safe_path "$F" || UNSAFE="$UNSAFE $F"
  done <<< "$(jq -r '.files[].path' <<< "$PR")"

  if [ -n "$UNSAFE" ]; then
    echo "SKIP $NUM unsafe_paths:${UNSAFE# }"; continue
  fi

  echo "MERGE $NUM $BR"
done <<< "$(jq -c '.[]' <<< "$INPUT")"
