#!/usr/bin/env bash
#
# version-manifest.sh — какой коммит ФАКТИЧЕСКИ работает в каждом компоненте.
#
# Зачем. Аудит 2026-09-19 (AUD-027): sha выкатки жил ровно в одном месте — в
# строке «✅ deploy OK — local health 200 (deployed main@b7e618c9)», то есть в
# терминале оператора, который закрывается. На самом проде /opt/agent-team не
# git-чекаут вовсе: `git log` там не работает, и ответить «что сейчас в бою»
# можно было только по памяти. Отсюда и вся находка: рабочая папка на Mac
# стояла на одной ветке, прод жил на другой, launcher Mac указывал на третий
# релиз, а записи «VERIFIED» из прошлых аудитов относились неизвестно к чему.
#
# Чем это кончается. Правка «чинит» код, который в бою давно другой, либо
# откатывает чужую свежую реализацию: обе ошибки не видны до следующей выкатки.
# И обратно — из sha, записанного в отчёте, нельзя восстановить компонент,
# если неизвестно, тот ли это sha, что реально уехал.
#
# Как устроено. `record` кладёт рядом с компонентом файл `key=value`: полный
# коммит, короткий, ветка, путь на той стороне и время UTC. Не JSON намеренно —
# писать и читать его приходится удалённым `sh`, где нет ни jq, ни гарантий про
# кавычки. `show` собирает манифест всех компонентов: server и site читаются с
# той стороны, mac берётся из живого процесса демона, ios — из Info.plist и
# последнего коммита, тронувшего ios/, checkout — из каталога, откуда позвали.
#
# Хостов скрипт не печатает: вывод уходит в отчёты и в публичный репозиторий.
#
# Usage:
#   DEPLOY_HOST=... DEPLOY_RECORD_PATH=/opt/agent-team deploy/version-manifest.sh record server
#   DEPLOY_HOST=... deploy/version-manifest.sh show
#   DEPLOY_HOST=... deploy/version-manifest.sh show --json
#
# Env:
#   DEPLOY_HOST          куда ходить за server/site (без него они показываются
#                        как «не опрошен», локальные компоненты — как обычно)
#   DEPLOY_SSH_KEY       ключ; как в deploy.sh, без него ssh с IdentitiesOnly
#                        ключ не подберёт
#   DEPLOY_MANIFEST_SSH  команда ssh с опциями (default: собирается из ключа)
#   DEPLOY_MANIFEST_DIR  каталог манифестов на той стороне
#                        (default /var/lib/agent-team/deployed)
#   DEPLOY_RECORD_PATH   что записать в поле path у `record`
#   DEPLOY_RECORD_REPO   из какого чекаута брать коммит (default: репозиторий
#                        этого скрипта)
#   DEPLOY_RECORD_COMMIT назвать коммит явно, вместо HEAD чекаута — для отката,
#                        где работает не то, что лежит в чекауте
#   DEPLOY_RECORD_BRANCH то же для ветки
#   MAC_DAEMON_PS        команда, перечисляющая процессы (default "ps -eo args=")
#   IOS_PLIST            путь к Info.plist (default ios/Agent/Info.plist в репо)
#
# Exit codes: 0 — ок; 2 — ошибка вызова; 5 — не удалось записать манифест
# (для вызывающего это предупреждение, а не повод валить прошедшую выкатку).

set -euo pipefail

# Пустая строка из EnvironmentFile — это не «переменная не задана»; пробел тоже
# пустой. Тот же nonblank, что в deploy-lock.sh, и ровно по той же причине.
nonblank() {
  local raw="${1-}" fallback="${2-}"
  if [ -z "${raw//[[:space:]]/}" ]; then printf '%s' "$fallback"; else printf '%s' "$raw"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(nonblank "${DEPLOY_RECORD_REPO-}" "$(cd "$SCRIPT_DIR/.." && pwd)")"
HOST="$(nonblank "${DEPLOY_HOST-}" "")"
MANIFEST_DIR="$(nonblank "${DEPLOY_MANIFEST_DIR-}" "/var/lib/agent-team/deployed")"
PS_CMD="$(nonblank "${MAC_DAEMON_PS-}" "ps -eo args=")"
IOS_PLIST="$(nonblank "${IOS_PLIST-}" "$REPO_ROOT/ios/Agent/Info.plist")"

# Ключ уезжает и в ssh: у оператора в ~/.ssh/config стоит IdentitiesOnly yes, и
# голый ssh ключ не подберёт — см. ту же оговорку в deploy.sh.
if [ -n "$(nonblank "${DEPLOY_MANIFEST_SSH-}" "")" ]; then
  SSH_CMD="$DEPLOY_MANIFEST_SSH"
elif [ -n "$(nonblank "${DEPLOY_SSH_KEY-}" "")" ]; then
  SSH_CMD="ssh -i $DEPLOY_SSH_KEY -o IdentitiesOnly=yes"
else
  SSH_CMD="ssh"
fi

# Имя компонента уезжает на ту сторону частью пути к файлу. Сужаем алфавит,
# чтобы оно оставалось одним словом и не зависело от кавычек удалённого шелла.
check_component() {
  case "${1-}" in
    ''|*[!a-z0-9-]*)
      echo "version-manifest: компонент — из [a-z0-9-], а не «${1-}»" >&2
      exit 2
      ;;
  esac
}

# Значение, приехавшее снаружи (из RELEASE на том конце, из переменной
# вызывающего), уезжает обратно на ту сторону позиционным аргументом ssh —
# а ssh склеивает аргументы через пробел и отдаёт их УДАЛЁННОМУ шеллу. То
# есть кавычки и пробелы там разъезжаются, а точка с запятой была бы дырой.
# Поэтому чужое значение либо укладывается в алфавит, либо не уезжает вовсе.
safe_value() {
  case "${1-}" in
    ''|*[!a-zA-Z0-9._/-]*) printf '%s' "${2-?}" ;;
    *) printf '%s' "$1" ;;
  esac
}

git_at() { git -C "$REPO_ROOT" "$@" 2>/dev/null || true; }

remote_sh() {
  local script="$1"; shift
  # SSH_CMD разбивается по словам НАМЕРЕННО: это команда с опциями.
  # shellcheck disable=SC2086
  printf '%s' "$script" | $SSH_CMD "$HOST" sh -s -- "$@"
}

# --- record --------------------------------------------------------------

# $1 dir, $2 component, $3 commit, $4 short, $5 branch, $6 path
REMOTE_RECORD='
set -eu
D=$1; C=$2; FULL=$3; SHORT=$4; BR=$5; P=$6
mkdir -p "$D"
chmod 700 "$D" 2>/dev/null || true
T=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Через временный файл: манифест читают отчёты, и оборванная запись выглядела
# бы как «компонент без коммита», а не как сбой связи.
printf "component=%s\ncommit=%s\nshort=%s\nbranch=%s\npath=%s\nat=%s\n" \
  "$C" "$FULL" "$SHORT" "$BR" "$P" "$T" > "$D/.$C.tmp"
mv "$D/.$C.tmp" "$D/$C.txt"
echo "recorded $C $SHORT at=$T"
'

do_record() {
  local component="$1"
  check_component "$component"
  [ -n "$HOST" ] || { echo "version-manifest: record требует DEPLOY_HOST" >&2; exit 2; }
  local full short branch path
  # Обычный случай — коммит берётся из чекаута, который позвал скрипт: он и
  # уехал. Но у сайта есть откат: `deploy.sh rollback` возвращает ПРЕЖНИЙ
  # релиз, и HEAD чекаута в этот момент говорит про другой коммит. Поэтому
  # вызывающий может назвать коммит сам (delabs читает его из RELEASE в
  # каталоге релиза) — тогда манифест описывает то, что правда работает, а не
  # то, что лежит в папке у оператора.
  if [ -n "$(nonblank "${DEPLOY_RECORD_COMMIT-}" "")" ]; then
    # Назвали явно — значит HEAD здесь не при чём. Негодное значение
    # становится «?», а НЕ коммитом чекаута: манифест, уверенно называющий не
    # тот код, вреднее манифеста, честно признавшего незнание.
    full="$(safe_value "$DEPLOY_RECORD_COMMIT" "?")"
    short="$(printf '%.7s' "$full")"
  else
    full="$(nonblank "$(git_at rev-parse HEAD)" "?")"
    short="$(nonblank "$(git_at rev-parse --short HEAD)" "?")"
  fi
  branch="$(safe_value "$(nonblank "${DEPLOY_RECORD_BRANCH-}" "$(nonblank "$(git_at rev-parse --abbrev-ref HEAD)" "?")")" "?")"
  path="$(safe_value "$(nonblank "${DEPLOY_RECORD_PATH-}" "?")" "?")"
  if ! remote_sh "$REMOTE_RECORD" "$MANIFEST_DIR" "$component" "$full" "$short" "$branch" "$path"; then
    echo "version-manifest: манифест $component не записался" >&2
    exit 5
  fi
}

# --- show ----------------------------------------------------------------

# Читаем ровно те ключи, которые сами же пишем: чужую строку в файле манифеста
# показывать в отчёте незачем.
read_remote() {
  local component="$1"
  [ -n "$HOST" ] || { echo "state=не опрошен (нет DEPLOY_HOST)"; return 0; }
  local out
  if ! out="$(remote_sh '
set -u
D=$1; C=$2
[ -f "$D/$C.txt" ] || { echo "state=нет манифеста"; exit 0; }
grep -E "^(component|commit|short|branch|path|at)=" "$D/$C.txt"
' "$MANIFEST_DIR" "$component" 2>/dev/null)"; then
    echo "state=не прочитан"
    return 0
  fi
  nonblank "$out" "state=пусто"
  printf '\n'
}

# Какой релиз крутится на Mac, видно только из живого процесса: launcher
# указывает на run-daemon.sh, а тот — на releases/<sha8>. Печатаем ровно sha,
# а не строку запуска: в ней пути и переменные владельца.
read_mac() {
  local args sha
  # shellcheck disable=SC2086
  args="$($PS_CMD 2>/dev/null || true)"
  sha="$(printf '%s\n' "$args" \
    | grep -oE 'releases/[0-9a-f]{7,40}/agent/mac-daemon/daemon\.ts' \
    | head -1 | cut -d/ -f2)"
  if [ -n "$sha" ]; then
    printf 'short=%s\nstate=запущен\n' "$sha"
  else
    printf 'state=демон не запущен\n'
  fi
}

read_ios() {
  local version build commit
  if [ -r "$IOS_PLIST" ]; then
    version="$(sed -n 's/.*<key>CFBundleShortVersionString<\/key><string>\([^<]*\)<\/string>.*/\1/p' "$IOS_PLIST" | head -1)"
    build="$(sed -n 's/.*<key>CFBundleVersion<\/key><string>\([^<]*\)<\/string>.*/\1/p' "$IOS_PLIST" | head -1)"
  fi
  # Клиент собирается не выкаткой, а вручную (ios/build-unsigned.sh), поэтому
  # «версия в бою» здесь — это версия в чекауте и последний коммит по ios/.
  commit="$(nonblank "$(git_at log -1 --format=%h -- ios/)" "?")"
  printf 'version=%s\nbuild=%s\nshort=%s\nstate=из чекаута\n' \
    "$(nonblank "${version-}" "?")" "$(nonblank "${build-}" "?")" "$commit"
}

read_checkout() {
  local dirty
  dirty="$(git_at status --porcelain)"
  printf 'path=%s\nbranch=%s\nshort=%s\ncommit=%s\nstate=%s\n' \
    "$REPO_ROOT" \
    "$(nonblank "$(git_at rev-parse --abbrev-ref HEAD)" "?")" \
    "$(nonblank "$(git_at rev-parse --short HEAD)" "?")" \
    "$(nonblank "$(git_at rev-parse HEAD)" "?")" \
    "$([ -n "$dirty" ] && echo "есть незакоммиченные правки" || echo "чисто")"
}

component_fields() {
  case "$1" in
    server|site) read_remote "$1" ;;
    mac) read_mac ;;
    ios) read_ios ;;
    checkout) read_checkout ;;
  esac
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

do_show() {
  local json=0
  [ "${1-}" = "--json" ] && json=1
  local components="checkout server site mac ios"
  if [ "$json" = "1" ]; then
    printf '{\n'
    local first=1 c line k v
    for c in $components; do
      [ "$first" = "1" ] || printf ',\n'
      first=0
      printf '  "%s": {' "$c"
      local inner=1
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        k="${line%%=*}"; v="${line#*=}"
        [ "$inner" = "1" ] || printf ','
        inner=0
        printf ' "%s": "%s"' "$(json_escape "$k")" "$(json_escape "$v")"
      done <<EOF
$(component_fields "$c")
EOF
      printf ' }'
    done
    printf '\n}\n'
  else
    local c line
    for c in $components; do
      printf '%s:\n' "$c"
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        printf '  %s\n' "$line"
      done <<EOF
$(component_fields "$c")
EOF
    done
  fi
}

case "${1-}" in
  record) shift; do_record "${1-}" ;;
  show) shift; do_show "${1-}" ;;
  *)
    echo "usage: $0 record <component>   |   $0 show [--json]" >&2
    exit 2
    ;;
esac
