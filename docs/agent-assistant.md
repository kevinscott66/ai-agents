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
