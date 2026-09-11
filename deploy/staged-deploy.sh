#!/bin/bash
# Staged deployment script for agent-team service
# Implements blue-green deployment with health checks and rollback

set -euo pipefail

# Пути вынесены в переменные окружения ТОЛЬКО ради тестируемости: значения по
# умолчанию — боевые, вызывающая сторона их не задаёт.
DEPLOY_PATH="${DEPLOY_PATH:-/opt/agent-team}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
BLUE_SERVICE="agent-team-blue"
GREEN_SERVICE="agent-team-green"
# Реальный прод — один юнит (CLAUDE.md §1). blue/green здесь — альтернативная
# схема, которая в проде никогда не включалась.
SINGLE_SERVICE="agent-team.service"
PROD_PORT=8787
# Аудит 2026-09-11: здесь стояло 8788 — порт моста (DEFAULT_MAC_BRIDGE_PORT в
# agent/lib/constants.ts), и его докстрока прямо объясняет, зачем он отличается
# от 8787. Мост поднимается в ТОМ ЖЕ процессе, что и Mini App, на 127.0.0.1 —
# то есть при включённом MAC_BRIDGE_SECRET боевой процесс уже держит 8788, и
# staging-экземпляр не мог встать на него никогда. Промах при этом молчаливый:
# старт Mini App обёрнут в try/catch и падает в лог, а health_check на 8788
# попадал в мост и получал 403 — исправный билд откатывался «по нездоровью».
# Пара портов проверяется тестом agent/tests/audit-2026-09-11-staging-port-vs-bridge.
STAGING_PORT=8789
HEALTH_TIMEOUT=30
ROLLBACK_TIMEOUT=15
STAGED_DEPLOY_EXPERIMENTAL="${STAGED_DEPLOY_EXPERIMENTAL:-0}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Аудит 2026-08-12: скрипт молча запускался рядом с боевым agent-team.service.
# Оба юнита смотрят в один WorkingDirectory=/opt/agent-team, то есть в одну
# SQLite и один .env с токенами ботов. Второй процесс на тех же токенах — это
# второй потребитель getUpdates: Telegram отдаёт апдейт кому-то одному, и живой
# прод начинает терять сообщения. Поэтому — отказ, а не предупреждение.
# Аудит 2026-08-29: blue/green здесь — танец портами, а НЕ изоляция кода.
# Оба юнита объявлены с WorkingDirectory=$DEPLOY_PATH, то есть читают одно
# дерево, и rsync успевает переписать его ДО запуска этого скрипта. Значит
# «откат» на прежний цвет возвращал процесс, но не код: поднимался тот же
# новый (плохой) код, а в лог писалось «Successfully restored». Ложный успех
# в логе хуже отсутствия отката — оператор видит «откатились» и уходит спать.
#
# Единственный способ вернуть код — снапшот, снятый ДО rsync. Ровно такой
# делает шаг 1 в deploy/deploy.sh: /var/lib/agent-team/deploy-snapshots/agent-team-predeploy-<timestamp>.
# Без него откат невозможен, поэтому отказываемся на старте, а не в момент
# аварии, когда чинить уже нечем.
assert_code_snapshot() {
    CODE_SNAPSHOT="${STAGED_DEPLOY_SNAPSHOT:-}"
    # EnvironmentFile/скрипт-вызыватель отдают пустую строку и пробелы, а не
    # unset — проверяем именно содержимое.
    if [[ -z "${CODE_SNAPSHOT//[[:space:]]/}" ]]; then
        log "ОТКАЗ: не задан STAGED_DEPLOY_SNAPSHOT — каталог со снапшотом кода."
        log "Без него откат вернёт процесс, но не код: оба цвета работают из"
        log "$DEPLOY_PATH, куда новый код уже приехал."
        log "Снапшот делает шаг 1 в deploy/deploy.sh (/var/lib/agent-team/deploy-snapshots/agent-team-predeploy-*)."
        exit 1
    fi
    if [[ ! -d "$CODE_SNAPSHOT" ]]; then
        log "ОТКАЗ: STAGED_DEPLOY_SNAPSHOT=$CODE_SNAPSHOT — не каталог."
        log "Укажите снапшот кода, снятый ДО rsync (см. шаг 1 в deploy/deploy.sh)."
        exit 1
    fi
    log "Снапшот для отката: $CODE_SNAPSHOT"
}

# Возврат дерева на предеплойное состояние. --delete обязателен: иначе файлы,
# появившиеся в неудачном деплое, остаются лежать рядом со старыми. node_modules
# и data исключены — первое ставится отдельно, второе это боевая SQLite.
restore_code() {
    log "ROLLBACK: восстанавливаю код $CODE_SNAPSHOT -> $DEPLOY_PATH"
    if rsync -a --delete --exclude node_modules --exclude data \
        "$CODE_SNAPSHOT/" "$DEPLOY_PATH/"; then
        log "ROLLBACK: код восстановлен"
        return 0
    fi
    return 1
}

assert_no_single_unit() {
    if systemctl is-active --quiet "$SINGLE_SERVICE" 2>/dev/null; then
        log "ОТКАЗ: активен $SINGLE_SERVICE — одноюнитовый прод."
        log "blue/green поднимет ВТОРОЙ процесс на той же БД и тех же токенах"
        log "ботов (getUpdates эксклюзивен — живой прод начнёт терять апдейты)."
        log "Сначала осознанно решите, какая схема деплоя здесь основная."
        exit 1
    fi
}

# Blue/green is retained as an experimental reference path only. Both color
# units still share the production WorkingDirectory, SQLite, .env, and Telegram
# credentials, so starting the second process can duplicate consumers. Make
# that risk an explicit operator decision instead of an accidental invocation.
require_experimental_opt_in() {
    if [[ "$STAGED_DEPLOY_EXPERIMENTAL" != "1" ]]; then
        log "ОТКАЗ: staged-deploy.sh — экспериментальный blue/green путь отключён."
        log "Оба цвета разделяют код, SQLite, .env и Telegram-сессии; используйте"
        log "deploy/deploy.sh для штатного одноюнитового production-деплоя."
        log "Для осознанного эксперимента задайте STAGED_DEPLOY_EXPERIMENTAL=1."
        exit 1
    fi
}

# Порт задаётся drop-in'ом, а не правкой юнит-файла, и задаётся ЯВНО обоим
# цветам — и на staging, и на проде.
#
# Аудит 2026-08-12, две ошибки в одном месте.
#
# Первая: здесь стоял
#   sed 's/MINIAPP_PORT=8788/MINIAPP_PORT=8787/' …green.service > /tmp/… && cp …
# то есть юнит green переписывался НАСОВСЕМ. После первого же успешного цикла
# green объявлен на 8787 навсегда, а таблица get_service_port продолжала считать
# его 8788. Второй прогон health-чекал порт, на котором никого нет, и откат
# проверял ровно тот же несуществующий порт.
#
# Вторая, глубже: staging-порт брался из цвета. У blue в юните 8787 — тот же
# боевой. Схема работала ровно один раз, blue→green: когда живым становился
# green, следующий цикл поднимал blue как staging на 8787 рядом с занятым 8787.
# Поэтому staging всегда на $STAGING_PORT, прод всегда на $PROD_PORT, а какой
# сейчас цвет — на выбор порта не влияет.
override_dir() {
    echo "$SYSTEMD_UNIT_DIR/$1.service.d"
}

write_port_override() {
    local service=$1 port=$2 dir
    dir=$(override_dir "$service")
    log "drop-in: $service слушает порт $port"
    mkdir -p "$dir"
    printf '[Service]\nEnvironment=MINIAPP_PORT=%s\n' "$port" \
        > "$dir/10-deploy-port.conf"
    systemctl daemon-reload
}

apply_prod_port() {
    write_port_override "$1" "$PROD_PORT"
}

apply_staging_port() {
    write_port_override "$1" "$STAGING_PORT"
}

clear_port_override() {
    local service=$1 dir
    dir=$(override_dir "$service")
    if [[ -e "$dir/10-deploy-port.conf" ]]; then
        log "Снимаю drop-in с $service — возвращается порт из юнит-файла"
        rm -f "$dir/10-deploy-port.conf"
        rmdir "$dir" 2>/dev/null || true
        systemctl daemon-reload
    fi
}

health_check() {
    local port=$1
    local timeout=${2:-$HEALTH_TIMEOUT}
    
    log "Health checking http://localhost:$port/api/health (timeout: ${timeout}s)"
    
    if timeout $timeout curl -fsS "http://localhost:$port/api/health" | jq -r '.ok' | grep -q '^true$'; then
        log "Health check passed on port $port"
        return 0
    else
        log "Health check failed on port $port"
        return 1
    fi
}

get_active_service() {
    if systemctl is-active --quiet $BLUE_SERVICE 2>/dev/null; then
        echo "$BLUE_SERVICE"
    elif systemctl is-active --quiet $GREEN_SERVICE 2>/dev/null; then
        echo "$GREEN_SERVICE"  
    else
        # Fallback: assume blue is primary if neither is active
        echo "$BLUE_SERVICE"
    fi
}

get_staging_service() {
    local active=$1
    if [[ "$active" == "$BLUE_SERVICE" ]]; then
        echo "$GREEN_SERVICE"
    else
        echo "$BLUE_SERVICE"
    fi
}

# get_service_port удалён вместе с таблицей «цвет → порт»: порт теперь свойство
# роли (staging/прод), а не цвета, и выставляется drop-in'ом выше.

wait_for_stop() {
    local service=$1
    local timeout=${2:-10}
    
    log "Waiting for $service to stop (timeout: ${timeout}s)"
    for i in $(seq 1 $timeout); do
        if ! systemctl is-active --quiet $service; then
            log "$service stopped"
            return 0
        fi
        sleep 1
    done
    
    log "WARNING: $service did not stop within ${timeout}s"
    return 1
}

rollback() {
    local active_service=$1
    local staging_service=$2
    
    log "ROLLBACK: Starting rollback procedure"
    
    # Stop the failed staging service
    log "ROLLBACK: Stopping failed staging service $staging_service"
    systemctl stop $staging_service || true
    # И снимаем с него боевой порт: иначе неудавшийся цвет остаётся объявленным
    # на $PROD_PORT и подерётся с живым при первом же Restart=always.
    clear_port_override "$staging_service"

    # Сначала код, потом процесс — иначе поднимем прежний цвет на новом коде.
    local code_ok=0
    if restore_code; then
        code_ok=1
    else
        log "ROLLBACK: CRITICAL - код НЕ восстановлен из $CODE_SNAPSHOT"
        log "ROLLBACK: на диске остался код неудачного деплоя — чинить руками"
    fi

    # Перезапуск активного цвета обязателен ДАЖЕ если он не падал: он держит в
    # памяти прежний код, а на диске лежал новый. Оставить как есть — значит
    # отложить катастрофу до первого Restart=always, который молча поднимет
    # то, что мы только что откатывали.
    log "ROLLBACK: Restarting $active_service on restored code"
    apply_prod_port "$active_service"
    systemctl stop $active_service || true
    systemctl start $active_service
    sleep 3
    if ! health_check "$PROD_PORT" $ROLLBACK_TIMEOUT; then
        log "ROLLBACK: CRITICAL - Failed to restore $active_service"
        return 1
    fi
    if [[ $code_ok -eq 1 ]]; then
        log "ROLLBACK: Successfully restored code and $active_service"
        return 0
    fi
    log "ROLLBACK: $active_service поднят, но НА НОВОМ КОДЕ — откат неполный"
    return 1
}

main() {
    log "Starting staged deployment"

    require_experimental_opt_in
    assert_no_single_unit
    assert_code_snapshot

    # Determine active and staging services
    ACTIVE_SERVICE=$(get_active_service)
    STAGING_SERVICE=$(get_staging_service $ACTIVE_SERVICE)

    log "Active service: $ACTIVE_SERVICE"
    log "Staging service: $STAGING_SERVICE (port $STAGING_PORT)"
    
    # Step 1: Install dependencies in staging area (already done by rsync)
    log "Dependencies already installed by rsync"
    
    # Step 2: Start staging service
    # Порт staging'а выставляем явно: у blue в юнит-файле стоит боевой 8787, и
    # без этого staging-blue поднимался бы рядом с живым green на том же порту.
    apply_staging_port "$STAGING_SERVICE"
    log "Starting staging service $STAGING_SERVICE"
    systemctl start $STAGING_SERVICE
    sleep 3

    # Step 3: Health check staging service
    if ! health_check "$STAGING_PORT"; then
        log "DEPLOYMENT FAILED: Staging health check failed"
        rollback $ACTIVE_SERVICE $STAGING_SERVICE || log "ROLLBACK: неуспешно"
        exit 1
    fi
    
    # Step 4: Switch services
    log "Switching from $ACTIVE_SERVICE to $STAGING_SERVICE"
    
    # Stop active service.
    # Аудит 2026-08-12: `wait_for_stop` возвращает 1 по таймауту, и при set -e
    # это молча убивало скрипт ровно в середине переключения: активный цвет уже
    # остановлен, новый ещё не поднят на боевом порту, отката не будет. Ловим.
    systemctl stop $ACTIVE_SERVICE
    if ! wait_for_stop $ACTIVE_SERVICE; then
        log "DEPLOYMENT FAILED: $ACTIVE_SERVICE не остановился — переключение отменено"
        rollback $ACTIVE_SERVICE $STAGING_SERVICE || log "ROLLBACK: неуспешно"
        exit 1
    fi


    # Reconfigure staging to production port and start
    log "Reconfiguring $STAGING_SERVICE to production port $PROD_PORT"

    # Юнит-файл не трогаем: цвет остаётся собой, боевой порт — это временное
    # состояние, снимаемое одной командой. Симметрично для обоих цветов —
    # blue после переключения тоже должен стоять на боевом порту явно, а не
    # «случайно совпасть» со своим дефолтом.
    systemctl stop $STAGING_SERVICE
    wait_for_stop $STAGING_SERVICE || log "WARNING: $STAGING_SERVICE тормозит с остановкой"
    apply_prod_port "$STAGING_SERVICE"

    systemctl start $STAGING_SERVICE
    sleep 3

    # Step 5: Final health check on production port
    if ! health_check "$PROD_PORT"; then
        log "DEPLOYMENT FAILED: Production health check failed"
        rollback $ACTIVE_SERVICE $STAGING_SERVICE || log "ROLLBACK: неуспешно"
        exit 1
    fi
    
    log "DEPLOYMENT SUCCESS: $STAGING_SERVICE is now active on production port"
    
    # Step 6: Update service symlinks/aliases for next deployment
    # The "active" service is now $STAGING_SERVICE
    log "Deployment completed successfully"
}

usage() {
    cat >&2 <<'EOF'
Использование: staged-deploy.sh [--dry-run|--help]

  (без аргументов)  выкатка blue/green с health-check и откатом
  --dry-run         только проверки и план: ничего не запускает и не пишет
  --help            эта справка

Переменные окружения:
  STAGED_DEPLOY_SNAPSHOT  обязателен: каталог со снапшотом кода, снятым ДО
                          rsync (его делает шаг 1 в deploy/deploy.sh)
  STAGED_DEPLOY_EXPERIMENTAL=1  обязателен для настоящего blue/green запуска;
                          путь экспериментальный и разделяет runtime-состояние
                          с production, поэтому по умолчанию отключён
  DEPLOY_PATH             дерево кода (по умолчанию /opt/agent-team)
  SYSTEMD_UNIT_DIR        каталог юнитов (по умолчанию /etc/systemd/system)
EOF
}

# Аудит 2026-08-29: раньше --dry-run печатал «no changes will be made» и выходил
# 0, не посмотрев ни на что. Зелёный прогон, который ничего не проверил, хуже
# отсутствия режима: он выдаёт мнение за проверку. Теперь здесь ровно те же
# предполётные условия, что и у настоящей выкатки, и ни одной мутации:
# systemctl только is-active, никаких start/stop/daemon-reload и rsync.
dry_run() {
    log "DRY RUN: ничего не запускается и не пишется"
    assert_no_single_unit
    assert_code_snapshot

    local active staging failed=0
    active=$(get_active_service)
    staging=$(get_staging_service "$active")
    log "DRY RUN: активный цвет $active"
    log "DRY RUN: staging $staging — поднимется на $STAGING_PORT, затем переедет на $PROD_PORT"

    local svc
    for svc in "$BLUE_SERVICE" "$GREEN_SERVICE"; do
        if [[ -f "$SYSTEMD_UNIT_DIR/$svc.service" ]]; then
            log "DRY RUN: юнит $svc.service на месте"
        else
            log "DRY RUN: ОТКАЗ: нет $SYSTEMD_UNIT_DIR/$svc.service"
            failed=1
        fi
    done

    if [[ ! -d "$DEPLOY_PATH" ]]; then
        log "DRY RUN: ОТКАЗ: нет каталога кода $DEPLOY_PATH"
        failed=1
    fi

    if [[ $failed -ne 0 ]]; then
        log "DRY RUN: проверки НЕ пройдены — настоящая выкатка упала бы здесь"
        return 1
    fi
    log "DRY RUN: проверки пройдены"
    return 0
}

# Аргументы разбираются строго. Раньше всё, кроме точного «--dry-run», молча
# проваливалось в main: опечатка в флаге (--dryrun, --dry_run, -n) означала
# настоящую выкатку на прод вместо холостого прогона.
if [[ $# -gt 1 ]]; then
    log "ОТКАЗ: лишние аргументы: $*"
    usage
    exit 2
fi

case "${1:-}" in
    "")
        main
        ;;
    --dry-run)
        dry_run
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        log "ОТКАЗ: неизвестный аргумент: $1"
        usage
        exit 2
        ;;
esac
