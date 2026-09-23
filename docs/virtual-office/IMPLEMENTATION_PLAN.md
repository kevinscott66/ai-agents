# Implementation plan и checkpoint

Текущий результат: A/B checkpoint принят сообщением «приступай»; реализован первый C/D increment. См. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) для выполненных проверок и отличий от целевой архитектуры. Production и чужие изменения не менялись.

## Инкременты и критерии выхода

| Фаза | Доставка | Gate |
|---|---|---|
| A Discovery | EXISTING_SYSTEM, roster, источники и integration gaps | каждое утверждение отделяет code/config/live |
| B Architecture | остальные четыре документа | engine decision, protocol, trust boundary и scope понятны |
| C Skeleton | Vite/React/R3F web app, player/camera, одна комната, contract fixtures, loopback mock gateway | production web build и запуск в браузере; screenshot/playtest, reconnect smoke |
| D One-agent vertical slice | один Backend NPC + рабочее место + навигация/seat + inspect/chat | mock event → gateway → snapshot/delta → NPC → interaction → mock chat; reset/reconnect без ложных состояний |
| E Scale / MVP | config-driven персонажи реального roster, все места, basic zones | 12 существующих агентов (Lead включён), reserved slot, полный checklist MVP ниже |
| F Real integration | owner-scoped projection, passive adapter, lifecycle hooks, direct-role ingress | read-only shadow compare, ACL/security tests, затем один реальный agent и масштабирование |
| G Polish / Phase 2 | realistic assets, advanced IK, eyes/faces, objects/kitchen, meetings, infrastructure/Git views | asset licenses, animation QA, performance budget; инфраструктура только при наличии API |
| Phase 3 | voice/lip sync/spatial audio, mobile, notifications, rooms/customization/day-night, VR | отдельные spikes, input/audio/security acceptance |

MVP gate E: office, third-person movement/collision, 12-agent roster workstations, initial rigged characters, navigation, sitting/walking, real-state/visual FSM separation, mock gateway, WebSocket simulation, statuses, approach/E, inspect overlay, direct mock chat, working/idle/waiting animations. Все mock элементы заметно помечены. Никакого live inference до F. Масштабирование запрещено до демонстрации D.

## Планируемые repository changes

```text
# checkpoint — создаются сейчас
docs/virtual-office/
  EXISTING_SYSTEM.md
  ARCHITECTURE.md
  EVENT_MODEL.md
  AGENT_STATE_MODEL.md
  IMPLEMENTATION_PLAN.md

# после checkpoint, отдельные инкременты
virtual-office/
  contracts/                 # JSON schemas + fixtures; без engine/runtime imports
  gateway/                   # Bun service, projection, journal, WSS, auth
  adapters/mock/             # deterministic scenarios; никогда live dispatch
  adapters/agent-team/       # F only; scoped backend client
  tests/                     # protocol, reducers, isolation, replay
  web/                       # React/R3F/Three.js, DOM overlay, glTF assets
  assets/manifest.json       # source, license, skeleton, texture/LOD budgets

# F only, точные diff paths после review
agent/lib/office-observer.ts       # sanitised projection and lifecycle seam
agent/lib/office-api.ts            # scoped ingress/read API
agent/lib/miniapp-server.ts        # явная регистрация новой auth boundary
agent/orchestrator/message-handler.ts # shared direct-role execution seam
agent/tests/office-*.test.ts
```

Это план имён файлов, не существующий API. Office имеет отдельные зависимости, lockfile и scripts; существующий package.json не трогаем на C–E. Build outputs/cache не коммитим; лицензии и delivery budget ассетов фиксируем до добавления тяжёлых glTF/textures. Не используем site/web как hosting root. Новый код — feature branch `codex/virtual-office-*` из проверенной базы или isolated worktree; не переключать dirty checkout другой сессии. Каждый завершённый инкремент — адресный commit; не broad stage и не auto-push.

## Spike C: инструменты и производительность

Проверить WebGL2 в целевых браузерах, выбрать и зафиксировать совместимые версии React/R3F/Three.js. Сделать spike загрузки rigged glTF, animation blending, navigation/collision и sit/stand. Проверить production build и browser playtest. Размещение: отдельный static web deployment/CDN и WSS gateway за TLS proxy; конкретный hostname/hosting выбрать перед публикацией. Существующий site/web не менять. Серверный GPU не требуется для этого варианта: 3D рендерится браузером. Если пользователь требует полностью удалённый рендеринг, пересмотреть решение до C и отдельно оценить GPU streaming.

Начальные измеряемые цели (не результаты): 1080p, >=30 FPS, p95 frame <=33.3 ms при полном initial roster, без длительных hitch >100 ms при обычном event burst. На D измеряем одного NPC, на E полный roster, 10 минут движения/inspect/reconnect. Записываем total memory, CPU/GPU frame, draw calls и startup. Бюджеты meshes/textures/LOD выбираем по этим замерам; 1–2K textures и animation LOD вне фокуса как исходная настройка. Качество героя важнее дальних лиц. Не полагаться на аппаратные функции, отсутствующие на M1.

## Тесты по инкрементам

C/D: schema validation, reducer causality, snapshot barrier, gap/replay/epoch, heartbeat/reconnect, mock/live isolation; ручной browser playtest sit/walk/E/overlay/chat.

E: roster completeness, identity uniqueness, seat contention, concurrent updates, performance scene. F: owner isolation, token revocation, redaction canaries, duplicate command, approval binding, observer failure/overflow и отсутствие задержки реального turn; task transaction rollback и multi-process reconciliation. Backend changes требуют `cd agent && bun test tests` и `bun run typecheck` по `.ai/QUALITY_GATES.md`, плюс targeted tests. PR для auth/dispatch изменений, независимое review соответствующей границы.

Rollback: отключить office observer/route feature flag, остановить gateway; существующие Telegram/iOS/Mini App продолжают работу. Office DB производная, восстановима; backend DB не мигрировать ради visual state. Production activation — отдельный шаг, не следствие локального MVP.

## Решения и ограничения checkpoint

- Выбран Web/R3F по уточнению пользователя о сайте; backend engine-independent.
- Реальный состав 12 включая Lead; 13-е место reserved. Если нужен ещё один специалист, сначала определить его реальную роль/права в backend.
- Live runtime/models/infra не проверены; точные состояния потребуют hooks.
- Direct-role office chat пока отсутствует; используем mock на D, реальный ingress только F.
- Веб-размещение не устраняет локальную GPU-нагрузку; обязательны adaptive quality, 30 FPS cap, pause hidden tab и доступный 2D режим.
- Следующий шаг после проверенного one-agent slice: reusable controller/configuration и glTF/animation asset spike, затем E. Начальный articulated placeholder проверен; реалистичные ассеты и production auth ещё не реализованы.
