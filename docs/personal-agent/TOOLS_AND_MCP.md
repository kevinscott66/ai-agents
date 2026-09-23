# Инструменты и MCP личного агента

## Добавлено

GET_CAPABILITIES: конфигурация подключений, Mac heartbeat и зарегистрированные для роли инструменты. Конфигурация не доказывает вход в аккаунт или реальную готовность сервиса. Фильтр конкретного хода может дополнительно ограничивать инструменты.

GITHUB_MCP_READ: официальный remote GitHub MCP, операции file (path/ref), issue и pull_request (number). Фиксированы endpoint, repository из GITHUB_REPO и read-only method. Общая TOOLS-схема подключает инструмент к raw runtime и внутреннему team MCP. Только Lead в личном чате проверенного владельца; штатные role/pause/locked/rate-limit gates остаются.

Включение: GITHUB_MCP_ENABLED=true и существующий серверный GITHUB_READ_TOKEN. По умолчанию отключён. PAT должен давать только чтение выбранного repo. Не копировать OAuth/секреты из Codex. Новый публичный MCP/shell endpoint на VPS не открывается.

Transport: https://api.githubcopilot.com/mcp/readonly, redirects запрещены, X-MCP-Readonly=true, только get_file_contents/issue_read/pull_request_read. JSON/SSE; 512 КиБ на ответ, 40 тысяч символов выдачи, 30 секунд на вызов. Готовый SSE-ответ не ждёт закрытия потока. Результат считается недоверенными данными. Ни URL, ни токен, ни repo, ни произвольный remote method модель не выбирает.

Официальные источники: https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md и https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md .

## Набор по сценариям

| Сценарий | Средства | Условие исполнения |
| --- | --- | --- |
| Интернет | Штатные web search/fetch | Флаг, доменная политика, бюджет и доступность провайдера |
| GitHub | GET_GITHUB_STATUS, новый GITHUB_MCP_READ, ограниченный CODE_TASK | PAT/repo; публикация/merge отдельно |
| Файлы/код/CLI | MAC_RUN_CLAUDE | Доступный Mac, разрешённый проект и команды |
| Компьютер | MAC_CONTROL, календарь/workspace | Разрешения ОС и список операций |
| Серверы | Существующий проектный исполнитель + SSH | Точный разрешённый target и согласованный deploy |
| DNS | CLOUDFLARE_DNS_LIST / CLOUDFLARE_DNS | Разрешённая зона, credential, approval |
| Яндекс | quote/checkout/status/order/cancel, order-watch | Mac browser, login, селекторы, подпись и лимиты |
| Медиа | Генераторы + Higgsfield MCP | Личный OAuth, стоимость, лимиты, status |
| Команда/память | tasks/delegation/knowledge/approvals/reminders | Owner/chat scope и policy |
| Т-Банк личный | Локальная iPhone-подготовка; EXECUTION_DESIGN.md | Банковский executor ещё не реализован |

Инструменты приложения Codex не становятся автоматически инструментами серверного агента. Для дополнительного сервиса нужен ограниченный адаптер и собственная авторизация. Автоустановка произвольного MCP по инструкции сайта/репозитория не предусмотрена.

## Проверка и поставка

Тесты: JSON/SSE и незакрытый поток, фиксированные URL/repo/method, чужой владелец/группа/роль, неверные параметры, размер, protocol ID, отзыв доступа и отсутствие секрета в статусе. Дополнительно штатные role/locked/rate-limit/SDK тесты. Реальная read-only приёмка фиксируется в приватном handoff.

Код не развёрнут. Для включения нужны CI и отдельное разрешение на production-коммит. Эта поставка не подключает все сторонние аккаунты и не реализует банковский executor или серверный браузер.
