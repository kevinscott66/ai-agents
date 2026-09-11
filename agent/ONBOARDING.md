# ONBOARDING.md

Шпаргалка для возвращения к проекту после перерыва. Читается за 10 минут.

## 1. Что это

Многоагентная команда из 12 виртуальных персонажей, говорящих в одной Telegram-группе. Все агенты ходят через **один** Telegram-бот (идентичность собирается из system-prompt роли), плюс **userbot** (MTProto, gramjs) как 13-я «личность» для реакций и удаления служебных сообщений. Бэкенд оркеструет Anthropic Claude по ролям, прогоняет действия через permissions/approvals gate с режимами автономии. **Mini App** — это веб-панель управления (одобрения, задачи, права, логи).

Стек: Bun + TypeScript, telegraf, gramjs, Anthropic SDK, SQLite (better-sqlite3 через `bun:sqlite`), Preact + Vite для Mini App. 248+ тестов (baseline 248/4/0), прод на VPS `203.0.113.11` под systemd-юнитом `agent-team.service`.

## 2. Архитектура одной диаграммой

```
                       ┌──────────────────────┐
  Telegram chat ─────► │  telegraf bot        │ ◄── webhook/polling
                       │  orchestrator-team.ts│
                       └──────────┬───────────┘
                                  │ user msg
                                  ▼
                       ┌──────────────────────┐
                       │  per-agent loop      │   Anthropic Claude
                       │  lib/tool-loop.ts    │◄─►lib/anthropic-client.ts
                       └──────────┬───────────┘
                                  │ structured action
                                  ▼
                       ┌──────────────────────┐
                       │  action-dispatch.ts  │
                       │  + permissions-gate  │── approvals row
                       └──────┬──────────┬────┘
                              │          │
                              ▼          ▼
                  telegram-actions   userbot (gramjs)
                       (bot API)     SET_REACTION / DELETE
                              │          │
                              └────┬─────┘
                                   ▼
                       audit / agent_actions / tasks
                                   │
                                   ▼
                       ┌──────────────────────┐
                       │  miniapp-server      │── SSE ──► Preact Mini App
                       │  (SQLite store)      │           (6 tabs)
                       └──────────────────────┘
```

SSE-канал в Mini App, SQLite (`data/memory.db`) как единственное хранилище состояния, gramjs-сессия в `data/userbot.session`.

## 3. Карта кода

### `lib/` — ядро

**После R1-R4 рефакторинга (2026-05-22):** action-dispatch.ts увеличился до 1245 LOC, добавлены новые утилиты http-utils.ts, auth-middleware.ts, mac-bridge.ts, db-maint.ts. Миграции #019-#020 поддерживают DB maintenance и Mac Control.
| Файл | Назначение |
|---|---|
| `action-dispatch.ts` | Маршрутизатор: получает структурированный action, прогоняет через gate, вызывает исполнителя. |
| `action-payload.ts` | Нормализация полезной нагрузки действий, валидация. |
| `actions.ts` | Перечень и константы поддерживаемых действий. |
| `admin-commands.ts` | Обработка `/`-команд от админа в чате. |
| `anthropic-client.ts` | Обёртка над SDK + лимит конкурентности (`ANTHROPIC_MAX_CONCURRENCY`). |
| `anti-dup.ts` | Защита от дублирующих сообщений/действий. |
| `approvals.ts` | Таблица approvals, lifecycle (pending→approved/rejected). |
| `audit.ts` | Запись в `audit_logs`. |
| `backup.ts` | Ротация SQLite-бэкапов в `data/backups/`. |
| `db-maint.ts` | Database maintenance: daily archive (>30d rows → _archive), VACUUM scheduler. |
| `mac-bridge.ts` | Mac Control WebSocket bridge + health check ping/pong protocol. |
| `http-utils.ts` | HTTP utilities extracted from miniapp-server refactoring. |
| `auth-middleware.ts` | Authentication middleware extracted from miniapp-server. |
| `commands.ts` | Парсер встроенных команд. |
| `compactor.ts` | Свёртка истории контекста, чтобы не упереться в лимит токенов. |
| `db.ts` | Открытие SQLite, миграции, prepared-statements. |
| `digest.ts` | Ежедневный сводный отчёт (см. tab «Сводка»). |
| `events-bus.ts` | Внутренняя шина для SSE и подписчиков. |
| `handoff.ts` | Делегирование между ролями, anti-cycle (max 5 hops). |
| `health.ts` | Watchdog для «молчащих» агентов. |
| `memory.ts` | Долговременная память per-agent. |
| `migrations.ts` | DDL/ALTER миграции по версиям. |
| `miniapp-auth.ts` | HMAC-проверка Telegram WebApp initData. |
| `miniapp-server.ts` | HTTP+SSE сервер для Mini App. **Большой и append-friendly** — не рефакторить ради рефакторинга. |
| `openai-image.ts` | `GENERATE_IMAGE` (требует OPENAI_API_KEY, опционально). |
| `permissions.ts` | Scopes (global/chat/agent), режимы автономии. |
| `rate-limits.ts` | Per-agent/per-chat rate limiting. |
| `role-skills.ts` | Декларация скиллов на роль. |
| `self-diag.ts` | Диагностика упавших действий, создаёт diag-task для aieng. |
| `svg-render.ts` | Серверный рендер SVG → PNG (resvg). |
| `tasks.ts` | Таблица tasks, parent/child, rollup. |
| `telegraf-patch.ts` | Мелкие фиксы поверх telegraf. |
| `telegram-actions.ts` | Реализация Bot API действий. |
| `telegram-chunking.ts` | Разрезание длинных сообщений. |
| `token-budget.ts` | Учёт токенов в `agent_token_usage`. |
| `tool-loop.ts` | Главный loop: Claude → tool_use → dispatch → result → repeat. |
| `tools-schema.ts` | JSON-схемы тулов для Claude. |
| `types.ts` | Общие типы. |
| `userbot.ts` | gramjs-обёртка: реакции, удаления, история. |
| `watchdog.ts` | Health-мониторинг агентов. |

### `characters/`
- `index.ts` — все 12 персонажей: имя, аватар, system-prompt, роль, fallback-цепочки.

### Корень
- `orchestrator-team.ts` — entrypoint (`bun run start`).
- `orchestrator-bot.ts`, `orchestrator-userbot.ts` — отдельные точки входа (исторические/диагностические).
- `join-group.ts`, `list-dialogs.ts`, `login-userbot.ts`, `send-test.ts` — служебные одноразовые скрипты.

### `miniapp/` — фронт (Preact + Vite)
- `src/` — компоненты вкладок, SSE-клиент.
- `dist/` — собранный билд, что деплоится на VPS.

### `tests/`
- `_helpers.ts` — общие фикстуры.
- `c<N>-*.test.ts` — нумерованные группы по итерациям (c2…c31). Самые свежие: `c30-mac-bridge` (Mac health check), `c30-userbot`, `c31-db-maint` (database maintenance), `c31-userbot-knowledge`.
- `bugfix-rate-limit-reaction.test.ts` — точечный регресс.

### `tools/`
- `userbot-login.ts` — интерактивный вход в MTProto (генерирует `data/userbot.session`).
- `fetch_avatars.sh`, `make_avatars.py` — генерация аватарок.
- `test-handoff.ts` — ручной прогон делегирования.

### `data/`
- `memory.db` — SQLite.
- `backups/` — ротация.
- `userbot.session` — gramjs сессия (**не удалять**).

## 4. Запуск локально

```bash
bun install
cp .env.example .env   # если есть, иначе создать руками
bun run dev            # hot-reload через bun --watch
bun test               # вся свита (248+, baseline 248/4/0)
bun run test:e2e       # отдельный smoke
```

Минимальный `.env`:

```
TELEGRAM_BOT_TOKEN=...      # основной бот команды
MINIAPP_BOT_TOKEN=...       # тот же или отдельный, для WebApp initData HMAC
# Основной режим через Claude Code subscription:
CLAUDE_CODE_OAUTH_TOKEN=...
USE_AGENT_SDK=             # пусто = выбирается subscription при наличии OAuth
# ANTHROPIC_API_KEY=...    # только для явного USE_AGENT_SDK=false
ALLOWED_CHAT_IDS=-100123,-100456
TG_API_ID=...               # MTProto
TG_API_HASH=...
TG_PHONE=+7...
USERBOT_SESSION_KEY=...     # шифрование сессии на диске
MINIAPP_PUBLIC_URL=https://agents.example.com:8443 # URL кнопки Mini App; только HTTPS
MINIAPP_ALLOWED_ORIGINS=https://agents.example.com:8443   # опционально
ANTHROPIC_MAX_CONCURRENCY=4                              # опционально
OPENAI_API_KEY=...                                       # опционально, для GENERATE_IMAGE (текущий статус: billing hard limit)
MAC_BRIDGE_SECRET=...                                     # опционально, для Mac Control Stage A bridge
MAC_USER_IDS=...                                          # whitelist user IDs для Mac Control (например, 100000001)
MAC_DENIED_PROMPT_PATTERNS="rm -rf,sudo.*delete"         # опционально, denied patterns (CSV regex)
```

Mini App локально:
```bash
cd miniapp && bun install && bun run dev
```

В Telegram Lead-бот на старте синхронизирует menu button с
`MINIAPP_PUBLIC_URL`. Для production URL — `https://agents.example.com:8443`;
если DNS или сервис недоступны, кнопка может быть настроена, но панель не откроется
до восстановления внешнего доступа.

## 5. Деплой

VPS: `203.0.113.11`, путь `/opt/agent-team`, юнит `agent-team.service`.

**Автоматический деплой (рекомендуется):**
```bash
git push origin main  # GitHub Actions автоматически деплоит на VPS
```

**Ручной деплой (fallback):**
```bash
# backend
rsync -avz --delete \
  --exclude node_modules --exclude data --exclude .git \
  ./ root@203.0.113.11:/opt/agent-team/
ssh root@203.0.113.11 'cd /opt/agent-team && bun install && systemctl restart agent-team'

# frontend
cd miniapp && bun run build
rsync -avz --delete dist/ root@203.0.113.11:/opt/agent-team/miniapp/dist/
```

Перед Bun-сервером стоит **nginx** (SNI :14443 → bun:8787), сертификаты Let's Encrypt через certbot. **Mac bridge** слушает на `:8788` (`DEFAULT_MAC_BRIDGE_PORT`); `:8787` — это HTTP-порт Mini App (`DEFAULT_MINIAPP_PORT`), порты разные и путать их нельзя. Бэкапы SQLite — в `/opt/agent-team/data/backups/`, ротация настроена `lib/backup.ts`. **DB maintenance**: ежедневный архив в 04:00 UTC (`agent_actions_archive`, `audit_logs_archive`).

## 6. 12 ролей + userbot

| Роль | Зона ответственности |
|---|---|
| orchestrator | Маршрутизация, разруливание споров. |
| pm | Планирование, статусы, рулоны. |
| product | Продуктовые решения. |
| backend | Серверный код. |
| frontend | Mini App UI. |
| tgdev | Интеграции с Telegram. |
| aieng | Промпты, self-diag, AI-фичи. |
| qa | Тесты, регресс. |
| smm | Контент-план, посты. |
| copywriter | Тексты. |
| design | SVG/превью. |
| perm | Контроль прав и аппрувов. |

Все 12 живут под **одним** `TELEGRAM_BOT_TOKEN`. «Голос» агента — это system-prompt + префикс. **Userbot** (`@owner_darkside`, gramjs) — отдельная идентичность для действий, которых Bot API не умеет: произвольные реакции, удаление чужих сообщений, чтение истории.

## 7. Права и автономия

Режимы (`lib/permissions.ts`):

| Режим | Что делает gate |
|---|---|
| `locked` | Любое действие отклоняется. |
| `manual` | Каждое действие → approvals, ждёт человека. |
| `semi_auto` | «Безопасные» (текст в свой чат, реакция) — сразу; «опасные» (delete, ban, рассылка) — approval. |
| `auto` | Всё проходит, только аудит. |

Scopes комбинируются: **global → chat → agent**. Узкий бьёт широкий. Решения принимает админ во вкладке **«Аппрувы»** Mini App.

## 8. Задачи и делегирование

- `DELEGATE_TO_ROLE` — передать таску другой роли.
- **Anti-cycle**: максимум 5 hops, запрещён немедленный ping-pong (A→B→A).
- `ROLE_FALLBACKS` (в `characters/index.ts`) — если целевая роль молчит/упала, идём по цепочке.
- `SPLIT_TASK` — параллельный fan-out на несколько ролей; parent ждёт всех детей, потом `rollup`.
- `tasks`-таблица хранит дерево; closure через статусы `done/failed/cancelled`.

## 9. Userbot

Поднимается из `lib/userbot.ts`. Действия с флагом `via_userbot: true`:
- `SET_REACTION` — любые эмодзи, не только дефолтные.
- `DELETE_MESSAGE` — служебные сообщения и не свои.
- `LIST_RECENT_MESSAGES` — подтягивание истории чата.

Bot-API остаётся fallback’ом, если userbot недоступен. Новый логин — один раз через `bun run tools/userbot-login.ts`, кладёт `data/userbot.session` (зашифровано `USERBOT_SESSION_KEY`). Если существующий файл plaintext, его можно перевести без SMS и без обращения к Telegram: `USERBOT_SESSION_KEY=... bun run tools/migrate-userbot-session.ts`.

## 10. Mini App

Preact + Vite, деплой на `https://miniapp.dobropalm.com`. Авторизация — Telegram WebApp `initData`, HMAC проверка в `lib/miniapp-auth.ts`. Живые обновления — SSE из `lib/miniapp-server.ts`.

Вкладки:
1. **Сводка** — дневной digest.
2. **Задачи** — дерево tasks.
3. **Аппрувы** — pending approvals.
4. **Агенты** — статусы, токены.
5. **Права** — permissions matrix.
6. **Логи** — audit + agent_actions.

## 11. Self-diagnostics

Когда action падает (`action-dispatch` ловит исключение или ненулевой результат), `lib/self-diag.ts` создаёт **diag-task** на роль **aieng**. Тот предлагает retry с изменённой полезной нагрузкой. Лимит: **1 retry на одну ошибку** (чтобы не зациклиться). Всё логируется в `audit_logs`.

## 12. Наблюдаемость

Таблицы:
- `agent_actions` — каждый отдиспатченный action.
- `audit_logs` — нормализованный аудит.
- `tasks` — дерево задач.
- `approvals` — очередь и решения.
- `messages` — все Telegram-сообщения, прошедшие через бота.
- `agent_token_usage` — Anthropic токены per-agent/per-day.

Плюс: дневной digest (`lib/digest.ts`), watchdog «молчащих» (`lib/watchdog.ts` + `lib/health.ts`), database maintenance scheduler с ежедневным архивированием в 04:00 UTC, Mac Control health checks через WebSocket bridge.

## 13. Частые операции

```bash
# tail прод-логов
ssh root@203.0.113.11 'journalctl -u agent-team -f'

# прогнать тесты
bun test

# деплой бэкенда
rsync -avz --delete --exclude node_modules --exclude data ./ \
  root@203.0.113.11:/opt/agent-team/ \
  && ssh root@203.0.113.11 'cd /opt/agent-team && bun install && systemctl restart agent-team'

# деплой фронта
cd miniapp && bun run build \
  && rsync -avz --delete dist/ root@203.0.113.11:/opt/agent-team/miniapp/dist/

# заглянуть в прод-БД
ssh root@203.0.113.11 'sqlite3 /opt/agent-team/data/memory.db'

# ручной бэкап
ssh root@203.0.113.11 'cp /opt/agent-team/data/memory.db /opt/agent-team/data/backups/manual-$(date +%F).db'
```

Ротация journald — уже сконфигурирована в `/etc/systemd/journald.conf.d/agent-team-cap.conf` (200 MB / 14 дней).

## 14. Подводные камни

- **Один Bot API токен = один polling**. Локальный `bun run dev` плюс прод одновременно — 409 от Telegram. Останови один.
- **Anthropic rate-limits**: концентратор в `lib/anthropic-client.ts`, регулируется `ANTHROPIC_MAX_CONCURRENCY`. Если ловишь 529 — снижай.
- **`data/userbot.session` нельзя удалять**. Иначе потребуется повторный логин с SMS-кодом, что больно из-под systemd. Plaintext-файл не удаляй: сначала мигрируй его через `tools/migrate-userbot-session.ts`.
- **`lib/miniapp-server.ts` большой и append-friendly**. Не пытаться красиво распилить, пока не приспичит — туда добавляются ручки, и так норм.
- **`ALLOWED_CHAT_IDS`** — без него бот не отвечает ни в одной группе. Частая причина «не работает».
- SQLite через `bun:sqlite` — не пытаться подключать `better-sqlite3` параллельно.

## 15. Mac Control (Stage A/B готово)

Управление macOS через WebSocket bridge + Claude agent.

**Готовые возможности:**
- **5 режимов**: ask (спрашивает), accept_edits (принимает правки), plan (планирует), auto (автоматически), bypass (обходит ограничения)
- **Kill switch**: MAC_STOP для немедленной остановки выполнения
- **Denied patterns**: MAC_DENIED_PROMPT_PATTERNS блокирует опасные команды
- **Health check**: ping/pong протокол, /api/health показывает статус Mac
- **Dashboard UI**: индикатор Mac online/offline в Mini App

**Нужно для запуска:**
- Запустить `agent/mac-daemon/daemon.ts` на Mac через launchd (Mac daemon не запущен — нужен launchd + TLS)
- Настроить TLS перед `:8788` (ssh tunnel или nginx upstream)
- Проверить: `curl -s https://<host>/api/health | jq .mac_online` → `true`

**Архитектура:**
```
Claude Agent → MAC_RUN_CLAUDE action → WebSocket :8788 → Mac daemon → Bun.spawn("claude")
```

Stage B (5 режимов) готово, Stage C (Mini App UI вкладка для Mac-сессий) в разработке.

## 16. Что не сделано / next

- **Mac Control Stage C** — веб-вкладка в Mini App для Mac-сессий с realtime stdout (T-107).
- **Per-agent bot-токены** — сейчас всё ещё 1 бот → 12 характеров. Разнести можно, но удорожает админку.
- **GENERATE_IMAGE** — OpenAI billing hard limit достигнут, SVG fallback активен через Claude.
- **Прод-мониторинг** — только watchdog + journald. Нет alerting (PagerDuty/Telegram-алерты), нет метрик в Prometheus/Grafana.
- **Тесты Mini App E2E** — `c26-miniapp-e2e` есть, но покрытие фронта ограничено.
