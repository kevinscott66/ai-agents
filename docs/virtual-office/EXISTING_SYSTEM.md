# Existing system — discovery checkpoint

Дата: 2026-09-23. Исследован checkout `claude/site-editorial-every-30min`, HEAD `bd12dab1eaa209c72063e1b3a329856efaa4b10f`. Это проверка кода и конфигурации, не live-аудит VPS. Значения секретов, runtime DB и личная переписка не читались. Наличие адаптера не доказывает подключение внешнего аккаунта или доступность модели.

## Карта workspace

| Область | Назначение / источник |
|---|---|
| `agent/` | Bun/TypeScript runtime; entry `agent/orchestrator-team.ts`, зависимости `agent/package.json` |
| `agent/miniapp/` | существующий web UI; API в `agent/lib/miniapp-server.ts` |
| `ios/` | самостоятельный native-клиент, API в `agent/lib/native-api.ts` |
| `agent/mac-daemon/` | исполнение разрешённых локальных действий через Mac bridge |
| `site/` | отдельный сайт; `site/web/**` принадлежит другой сессии и исключён из изменений |
| `eliza/` | отдельное присутствующее дерево, не tracked в текущем репозитории; не считать production runtime этой команды |
| `deploy/` | deploy scripts и service templates; README содержит исторические конфигурации |
| `memory/`, `data/`, `agent/data/` | память/локальное состояние; не копировать в офис или Git |

Незакоммиченные изменения iOS/OpenFlux и site уже существовали до этой задачи. Текущий Git важнее устаревшего сообщения в CURRENT_STATE о main.

## Реальный roster

Источник идентификаторов и специализаций: `agent/characters/index.ts` (`RoleKey`, `CHARACTERS`). **Всего 12, включая Lead**, а не 12 + Lead.

| agentId | Персонаж | Ответственность |
|---|---|---|
| orchestrator | Lead | маршрутизация, координация, делегирование |
| pm | PM | задачи, сроки, риски |
| product | Product | ценность, сценарии, приоритеты |
| backend | Backend | API, данные, бизнес-логика |
| frontend | Frontend | React/UI, доступность |
| tgdev | TG-Dev | Telegram Bot API, MTProto, Mini Apps |
| aieng | AI Eng | LLM, prompts, tools, RAG, evaluations |
| qa | QA | тестирование и регрессии |
| smm | SMM | социальные каналы и аналитика |
| copy | Copy | тексты и контент |
| design | Design | дизайн |
| perm | Permissions | действия и разрешения |

iOS и Security не отдельные identities. Нельзя создать их визуально и объявить реальными. Конфигурация офиса допускает 13 мест; по умолчанию 12 заняты, одно резервное. Изменение состава команды — отдельная backend-задача.

## Исполнение, коммуникация, модели

`agent/orchestrator/message-handler.ts` маршрутизирует упоминания и ответы ролей. `DELEGATE_TO_ROLE` запускает поддержанную роль через существующий dispatcher; `CREATE_TASK`, `ASSIGN_TASK`, `UPDATE_TASK_STATUS`, `REQUEST_REVIEW`, `COMMENT_TASK` управляют задачами. Присвоить задаче исполнителя не значит начать её выполнение.

`agent/lib/role-runtime.ts` и `role-runtime-worker.ts`: отдельная durable SQLite queue временных ролей; queued/running/done/failed, lease/heartbeat/recovery, providers internal/claude/codex. Это не 12 постоянно работающих независимых ОС-процессов. Межагентная работа проходит через backend и общий контекст; animated meeting не запускает делегирование.

`agent/lib/role-models.ts`: значения по умолчанию в коде — Lead: Claude Opus 5 либо Codex gpt-5.6-sol; инженерные роли: Claude Sonnet 5 либо gpt-5.6-terra, high; PM/Product/Design/Copy/SMM: та же базовая модель, medium. Есть overrides по ролям. Это конфигурация, не подтверждение live-доступности этих моделей. `docs/inference-providers.md` описывает provider switch, `agent/lib/agent-sdk-runtime.ts` — SDK путь, `codex-runtime.ts` — CLI adapter.

## Tools, MCP, GitHub

Каталог backend-инструментов: `agent/lib/tools-schema.ts`; выполнение и ограничения: `action-dispatch.ts`, `dispatch/`, `approval-policy.ts`. Категории: задачи, wiki, Telegram, media, web search, Mac, GitHub, сайт, DNS, бытовые сервисы. SDK регистрирует внутренний MCP server `team`. Higgsfield integration документирована в `docs/higgsfield-mcp.md`: ограниченный image API с approval/role gates; это не все инструменты MCP текущей Codex-сессии.

`agent/lib/dispatch/github.ts` реализует PR review/merge с проверками; `code-task.ts` — разрешённую задачу Mac с результатом PR. GitHub Actions используется для CI/PR checks, не как runtime агентов. Офис не запускает старые agent workflows.

## Память и инфраструктура

`agent/lib/db.ts`: SQLite messages и рабочие данные; `memory.ts`: короткий контекст + Markdown wiki по `_team`/role с FTS5. Native conversation/knowledge — отдельный слой (`native-context.ts`, `native-knowledge.ts`, `native-db-path.ts`). Engineering memory описана в `docs/engineering-memory.md`. Офис хранит только производную проекцию, не вторую память агента.

Серверная форма: Bun service, reverse proxy, durable storage; Mac daemon подключается отдельно по WebSocket (`mac-bridge.ts`). `deploy/README.md` прямо помечает Caddy/blue-green материалы историческими. Точные live-хосты, состояние сервисов, env и rollout нужно сверять по приватному `~/programs/ai-agents-ops/HANDOFF.md` при фазе интеграции; здесь не публикуются и не подтверждены. Infrastructure API для полноценной server room пока не установлен исследованием.

## Доступные поверхности наблюдения

| Источник | Что даёт | Ограничение |
|---|---|---|
| GET `/api/agents`, `/api/dashboard` | roster/health, агрегаты | Telegram health не execution state |
| GET `/api/tasks`, `/api/actions` | задачи и audit summaries | нет гарантии текущего файла/процента |
| POST `/api/sse-ticket`, GET `/api/events` | task.created/updated, action.executed, health, autonomy, paused, approvals | одноразовый билет; процессная шина без replay/sequence |
| `events-bus.ts`, `task-events.ts` | дешёвые invalidation hooks | task payload — ID, требуется committed reread; другие процессы не видны |
| `/api/native/status`, `/api/native/turns`, conversations | paired native transport, история и jobs | turn ingress сейчас Lead-centric; не готовый direct-role office API |
| `/api/web/*` | browser gateway для native API | собственные origin/credential ограничения |
| `mac-bridge.ts` | authenticated daemon WebSocket | privileged execution channel, НЕ office event feed |

Mini App REST использует свою auth/ACL; нельзя переиспользовать её через подделку Telegram initData. Native API отклоняет browser Origin/cookies. Офису нужен собственный scoped transport.

Пассивное наблюдение: read-only projections + существующие invalidations, периодическая reconciliation. Не вызывать LLM, tools или getMe дополнительно ради анимации. Аудит завершённого tool call не доказывает, что инструмент всё ещё выполняется. Полного feed tool.started/finished/turn.started/finished и устойчивого cursor сейчас нет — это явный integration gap.
