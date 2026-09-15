# Агент: ежедневные сценарии и iPhone

## Поведение

Лид отзывается на имя «Агент». Голосовые Telegram-сообщения после распознавания продолжают обычный ход с исходным пользователем и чатом: allowlist/пауза перепроверяются, ingest и дедуп не списываются второй раз. Делегирование и инструменты используют существующие permissions.

Команды (текст или голос):

- «Агент, начни мой день» / `/day`: три приоритета текущего чата, календарь владельца, статус связи с Mac.
- «Агент, покажи календарь» / `/calendar`: события сегодняшнего дня в часовом поясе Mac, включая повторяющиеся и весь день; максимум 40 полученных / 12 показанных событий; пересечения времени.
- «Агент, итоги дня» / `/evening`: открытые приоритеты и завершённые сегодня задачи текущего чата.
- «Агент, открой рабочие приложения» / `/workspace`: приложения из локального списка bundle ID.
- «Агент, включи уведомления» / `/alerts_on`, `/alerts_off`: opt-in уведомления в личный Telegram о трёх последовательных отказах проверки роли и о восстановлении. Используется существующий health scheduler, новых таймеров нет; повтор неизменного состояния подавляется сохранённой отметкой доставки.

Календарь, workspace, pairing и настройки уведомлений доступны только пользователю из `MAC_USER_IDS` в его личном allowlisted чате. Календарь не попадает в общую wiki или LLM-контекст. Задачи остаются chat-scoped, сводка не подтягивает чужие чаты.

## Mac

1. `sh agent/mac-daemon/build-calendar.sh` собирает локальный EventKit helper.
2. Запустить `agent/mac-daemon/bin/agent-calendar authorize` из пользовательской сессии Mac и разрешить доступ в системном диалоге.
3. В окружении Mac daemon установить `MAC_CALENDAR_ENABLED=true`; для открытия приложений задать `MAC_WORKSPACE_APPS`, пример в `agent/mac-daemon/assistant.env.example`.
4. Перезапустить обновлённый демон после разрешённого развёртывания.

`today` никогда сам не вызывает окно разрешений. В протокол добавлены только фиксированные `calendar_today` и `open_workspace`; удалённый запрос не содержит shell, URL, пути приложения или произвольного AppleScript. Обе команды имеют общий дедлайн 20 секунд; cancel/stop/обрыв соединения прерывают текущий дочерний процесс и предотвращают запуск следующих приложений. Уже открывшееся приложение не закрывается автоматически. Старый демон не поддерживает эти команды; сервер сообщает недоступность по ограниченному таймауту.

EventKit требует full access для чтения; код не создаёт и не меняет события. [Документация Apple](https://developer.apple.com/documentation/technotes/tn3152-migrating-to-the-latest-calendar-access-levels).

## iPhone и API

Исходники: `ios/`, визуальная спецификация: `ios/DESIGN.md`. Сборка: `sh ios/build-unsigned.sh`. Артефакт: `ios/build/Agent-unsigned.ipa` либо путь `AGENT_IOS_BUILD_DIR`.

Для подключения после согласованного деплоя:

1. На сервере включить `NATIVE_APP_ENABLED=true`; Telegram user ID владельца должен входить в `MAC_USER_IDS` и `TELEGRAM_ALLOWED_GROUP_IDS`.
2. В личном чате с лидом отправить `/pair_native`.
3. В приложении указать HTTPS origin сервера и одноразовый код (5 минут).
4. Новый код выдаётся только в Telegram; существующее iPhone-устройство не может выпустить ещё один ключ через native-команду.
5. `/revoke_native` отзывает все устройства владельца; начатые задачи автоматически не отменяет.

Маршруты: POST `/api/native/pair`, GET `/api/native/status`, POST `/api/native/turns`, GET `/api/native/turns/:id`. Native API не принимает browser Origin, cookies или ID пользователя из тела запроса. Проверяет bearer, срок, текущий allowlist и владельца до чтения тела защищённого запроса. JSON-тело ограничено 16 KiB и общим дедлайном 5 секунд. Те же live-права владельца проверяются перед отправкой health-уведомлений. Один выполняющийся ход на владельца, UUID запроса идемпотентен в пределах хранения. Нативный ответ специалиста возвращается в тот же job; completion ждёт каскад делегирования.

Новый SQLite-файл `native.db` рядом с основной БД (override `NATIVE_STATE_PATH`) хранит SHA-256 хеши pairing/device credentials, задания, ответы и opt-in health state. Права файла 0600, срок device token 30 дней, результаты 7 дней. Рестарт помечает running как interrupted, не повторяет действия. Ключ iPhone хранится в Keychain `WhenUnlockedThisDeviceOnly`; обновление атомарное, предыдущий ключ не удаляется при ошибке сохранения. Клиент ограничивает HTTP-ответ 4 MiB и 30 секундами, проверяет ID/статус задания и формат ответов. При сетевой неопределённости приложение сохраняет ID запроса; второй Send заблокирован до завершения или явного сброса ожидания.

## Сервисы и границы версии

GitHub/серверы/домены/Cloudflare: iPhone передаёт запросы существующему лиду. Исполнение зависит от его инструментов, прав и подключённого Mac, где установлены CLI/коннекторы. Новые учётные данные сервисов в приложение не копируются. Наличие кнопки не означает, что внешний аккаунт уже подключён. Существующие approval-карточки остаются в Telegram-панели.

Такси: адреса → локальная форма → геокодирование Apple → проверяемый маршрут → [официальная ссылка Яндекс Go](https://yandex.ru/support/taxi-distr/ru/api/deeplinks). Цена, тариф и окончательный заказ выбираются в Go.

Т-Банк: форма подготовки реквизитов/суммы, локальное копирование на 2 минуты, переход в [интернет-банк](https://www.tbank.ru/mybank/). Это не API автоматического денежного перевода. Реквизиты формы не отправляются лиду.

Микрофон включается по нажатию; постоянного фонового прослушивания нет. Озвучивание ответов — системное iOS TTS. Push через APNs, автоматическая утренняя рассылка, полное управление произвольными iPhone-приложениями и новые внешние аккаунты в этой версии не настраиваются. Сервер, Mac daemon и Calendar TCC требуют отдельной активации после review/разрешения на деплой.

## iPhone team panel

The companion bundles all Mini App sections (dashboard, tasks, approvals, agents, permissions, logs, wiki, settings, Mac). `ios/build-unsigned.sh` builds the native web bundle before Xcode packaging. The normal Telegram web build is unchanged.

Panel API requests may authenticate using an enabled native device bearer, subject to both the live assistant-owner ACL and `MINIAPP_ALLOWED_USER_IDS`. Existing `MINIAPP_ADMIN_USER_IDS`, chat scoping and action-specific owner gates still apply. Origin-bearing native authentication is rejected. No bearer enters HTML, JavaScript, cookies or URLs; a bounded Swift bridge injects it into HTTPS requests to an explicit data-route allowlist. The bundled WebKit page has no remote script/network/frame capability. Bearer revocation also revokes panel access.

## Confirmations in native chat

Pending approvals for the authenticated owner's direct-chat ID appear as inline cards in the conversation, refreshed every5 seconds while active. The user can inspect parameters and explicitly approve/reject via the existing admin-gated decision endpoint. Status is shown in the same card. The client freezes a decision before POST and never automatically retries an ambiguous outcome. Card/request identity is bound to the current Keychain credential; re-pairing invalidates prior cards. `GET /api/native/status` now includes the authenticated `userId` for scoping.

## Synchronized native dialogs (0.1.3)

GET/POST `/api/native/conversations` and GET `/api/native/conversations/:id?before=<seq>` use the authenticated owner, never a client-supplied owner ID. The index returns pages of 200 conversations, an opaque `nextCursor`, `more`, and owner-wide running state. The client retains loaded pages and can request older dialogs. History pages contain up to 100 messages with a backwards cursor. A turn optionally names an owned `conversationId`; messages are archived transactionally and shared across that owner's paired devices. Polling remains device-bound. The short context passed to both lead and delegates uses the selected dialog; shared assistant memory/wiki remain shared.

`native.db` adds `conversations`, `conversation_turns`, and `conversation_messages`. The archive has no automatic seven-day deletion; only polling rows expire. Persistent turn links prevent replay of archived IDs. Startup migrates retained legacy app messages into owner-scoped, randomly identified «Ранее в приложении» dialogs before pruning. The `legacy-` namespace cannot be newly created by clients. Previously expired messages cannot be recovered by this migration. Back up the database before deployment.

The iPhone restores the selected dialog and polls history while foregrounded. Pending request recovery stores the dialog ID and original server and only polls, never re-submits the action. Server/credential changes invalidate asynchronous display writes. Connection settings are disabled during pending work. No separate cross-device account is required: pair each device to the same assistant owner.

The native Mac section accepts a project and task, then submits an ordinary explicit user request through the existing lead and permission/approval pipeline. The bridge acknowledges local acceptance, not execution completion. Result and approval are shown in chat; completed execution enters the existing Mac action journal. This does not bypass `MAC_RUN_CLAUDE` permissions or guarantee that an offline Mac can run a session.

### Mac executor selection (0.1.4)

Mac session form offers Claude Code and Codex. The chosen provider is explicitly passed through the native chat request and MAC_RUN_CLAUDE payload, appears in the action history, and selects the actual daemon executable. Omitted provider retains Claude compatibility. Codex does not silently fall back to Claude. See `agent/mac-daemon/README.md` for CLI requirements and mode mapping; native launch still uses the existing lead/approval pipeline.

### Mac result delivery (0.1.7)

The central tool payload builder validates/preserves `provider` before approval creation (previously it was silently dropped despite the UI/tool schema). Successful Mac action results retain bounded scrubbed stdout, actual provider and the execution context's approvalId. Existing action content redaction protects this output. Mac results correlate owner + exact approvalId; approval status alone does not prove completion. Legacy completed actions without stored output cannot retroactively supply it.

### Durable confirmations and audit fixes (0.1.8)

Trusted AsyncLocalStorage ingress context records owner, turn and conversation in `native_approval_links` within the main approval-creation transaction. Model payloads cannot set this association. `native.db` contains the derived `conversation_approvals` links and completion state. The conversation-scoped `/api/native/conversations/:id/approvals` endpoint requires live owner and Mini App admin ACLs and repairs derived links/results from durable main records, including an audited Mac result after a crash. Repair never executes the action. Approved continuations restore the trusted dialog context.

Execution output is a stable assistant archive message `approval:<id>:result`, synchronized across devices and shown outside/below its confirmation card. The card contains parameters and status only. Client terminal states win over late POST errors; relaunch reads all statuses for the selected conversation. Main completion records and archived messages are idempotent. Old approvals created before durable association cannot be assigned to a dialog retroactively.

Legacy clients are archived when each turn starts, so retention pruning during long uptime cannot erase their messages. Native input/title limits use the backend UTF-16 contract. Mac protocol now uses mutual HMAC authentication and sequenced signatures in both directions; CLI cancellation targets the process group. See the daemon README for backend-first rollout and strict legacy-auth setting.
