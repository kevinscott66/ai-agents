#!/usr/bin/env bash
# Аудит 2026-09-29 (AUD-042): ночной детектор нестабильности был красным пять
# ночей подряд (25–29.09), и заметил это человек, а не репозиторий. Артефакт с
# выводом надо открыть руками, письма о падении крона приходят только владельцу
# и тонут, а обязательный гейт (одиночный проход) всё это время зелёный —
# падения там не воспроизводятся.
#
# Поэтому отказ ночного прогона теперь заводит задачу и догоняет её
# комментариями, а первый зелёный прогон эту задачу закрывает. Задача одна:
# ищется по точному заголовку среди открытых, а не по поисковому индексу
# GitHub — индекс обновляется с задержкой и на двух прогонах подряд завёл бы
# два дубля.
#
# usage: nightly-red-issue.sh fail|ok [output-file]

set -euo pipefail

MODE=${1:-}
OUTPUT=${2:-}
TITLE="Ночной прогон с повторами красный"

case "$MODE" in
  fail | ok) ;;
  *)
    echo "usage: $0 fail|ok [output-file]" >&2
    exit 2
    ;;
esac

RUN_URL=${RUN_URL:-"(ссылка на прогон не передана)"}

# Точное совпадение заголовка, а не поиск: gh issue list --search читает индекс,
# который отстаёт от записи на минуты.
NUMBER=$(
  gh issue list --state open --limit 100 --json number,title \
    --jq "map(select(.title == \"$TITLE\")) | .[0].number // empty"
)

if [ "$MODE" = ok ]; then
  if [ -z "$NUMBER" ]; then
    echo "ночной прогон зелёный, открытой задачи нет — делать нечего"
    exit 0
  fi
  gh issue comment "$NUMBER" --body "Ночной прогон снова зелёный: $RUN_URL

Задача закрывается автоматически. Следующий отказ откроет новую."
  gh issue close "$NUMBER"
  echo "закрыта задача #$NUMBER"
  exit 0
fi

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

{
  echo "Прогон: $RUN_URL"
  echo
  if [ -n "$OUTPUT" ] && [ -s "$OUTPUT" ]; then
    echo "Итог прогона:"
    echo
    echo '```'
    grep -E "^ *[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests" "$OUTPUT" | tail -6 || true
    echo '```'
    echo
    echo "Упавшие проверки (без повторов):"
    echo
    echo '```'
    grep -oE "\(fail\) .*" "$OUTPUT" | sed -E 's/ \[[0-9.]+m?s\]$//' | sort -u | head -20
    echo '```'
    echo
  else
    echo "Вывод прогона не сохранился — смотреть логи джобы."
    echo
  fi
  echo "Полный вывод — в артефакте прогона (\`flaky-test-output-*\`, 14 дней)."
  echo
  echo "Красный ночной прогон — не всегда нестабильный тест: в прошлые разы это"
  echo "были то нехватка \`preact\` в окружении, то утечка состояния между"
  echo "файлами (порядок файлов у bun не фиксирован, а \`--rerun-each\` копит"
  echo "строки в общей БД). Прежде чем править утверждение, стоит проверить эти"
  echo "два объяснения."
} >"$BODY"

if [ -n "$NUMBER" ]; then
  gh issue comment "$NUMBER" --body-file "$BODY"
  echo "дописан комментарий в задачу #$NUMBER"
else
  gh issue create --title "$TITLE" --body-file "$BODY"
  echo "заведена задача"
fi
