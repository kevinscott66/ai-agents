# mac-daemon (Stage A)

Bun-скрипт, который подключается по WebSocket к бэкенду агентной команды
(VPS), ждёт команд `MAC_RUN_CLAUDE` и спавнит локальный `claude` CLI в
разрешённом проекте, стримя stdout/stderr обратно.

## Зависимости

- Bun >= 1.1
- установленный `claude` CLI в `PATH` (или путь в `CLAUDE_BIN`)

## Переменные окружения

| Переменная           | Назначение                                                                |
|----------------------|---------------------------------------------------------------------------|
| `MAC_BRIDGE_URL`     | WebSocket URL бэкенда, напр. `ws://localhost:8788`.                    |
| `MAC_BRIDGE_SECRET`  | Shared secret (>= 32 символа). Должен совпадать с бэкендом.               |
| `MAC_PROJECT_ROOTS`  | CSV абсолютных путей-корней, под которыми разрешён `project`.             |
| `CLAUDE_BIN`         | Опционально — путь до бинаря `claude` (default: `claude` из `PATH`).      |
| `MAC_BRIDGE_INSECURE_PLAINTEXT` | `1` — разрешить `ws://` на не-петлевой хост (см. ниже). По умолчанию выключено. |

### Требования к `MAC_BRIDGE_URL`

Демон проверяет мост взаимным HMAC-рукопожатием со случайными nonce и не передаёт секрет. Команды и результаты подписаны отдельно для каждого направления, соединения и порядкового номера. Адрес дополнительно проверяется на старте (`bridge-url.ts`):

- `wss://` — куда угодно;
- `ws://` — только на петлю (`localhost`, `127.0.0.0/8`, `::1`);
- всё остальное — демон не стартует и печатает, что именно не так.

Если между демоном и бриджем уже есть шифрованный транспорт (SSH-туннель на
не-петлевой адрес, Tailscale), запрет снимается явным
`MAC_BRIDGE_INSECURE_PLAINTEXT=1`.

Подмена локального порта не позволяет выдать команды или результаты без ключа. HMAC не шифрует содержимое; для конфиденциальности требуется TLS или SSH-туннель.

### Обновление протокола

Сначала обновить backend (включая `mac-daemon/auth-handshake.ts`), затем Mac-демон. Новый демон не откатывается к старому рукопожатию. После обновления демона установить на backend `MAC_BRIDGE_ALLOW_LEGACY_AUTH=false` и перезапустить сервис, чтобы отключить совместимость со старыми клиентами. Откат требует согласованных версий обеих сторон.

CLI запускается отдельной группой процессов; отмена и тайм-аут посылают SIGINT группе, затем SIGKILL после grace period, включая оставшиеся shell/tool-процессы. Ответ `EPERM` на сигнал группе на macOS значит «в группе одни зомби» и считается, как `ESRCH`, завершением, а не ошибкой: раньше он пробрасывался и ронял демон на отмене (#42).

## Запуск вручную

```bash
cd mac-daemon
MAC_BRIDGE_URL=ws://localhost:8788 \
MAC_BRIDGE_SECRET=$(cat ~/.config/mac-daemon/secret) \
MAC_PROJECT_ROOTS=/Users/dobropalm/programs \
bun run start
```

## Установка через launchd

Сохрани в `~/Library/LaunchAgents/com.dobropalm.mac-daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dobropalm.mac-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>/Users/dobropalm/programs/ai_agents/agent/mac-daemon/daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAC_BRIDGE_URL</key>
    <string>ws://localhost:8788</string>
    <key>MAC_BRIDGE_SECRET</key>
    <string>REPLACE_WITH_>=32_CHAR_SECRET</string>
    <key>MAC_PROJECT_ROOTS</key>
    <string>/Users/dobropalm/programs</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/mac-daemon.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/mac-daemon.err.log</string>
</dict>
</plist>
```

Загрузить:

```bash
launchctl load -w ~/Library/LaunchAgents/com.dobropalm.mac-daemon.plist
launchctl list | grep mac-daemon
```

Выгрузить:

```bash
launchctl unload ~/Library/LaunchAgents/com.dobropalm.mac-daemon.plist
```

## Безопасность Stage B

- Наши 5 режимов отображаются в 4 режима CLI и уходят **флагом** `--permission-mode`
  (не переменной окружения — `sanitizeChildEnv` вырезала бы её из окружения ребёнка):
  `ask`→`default`, `accept_edits`→`acceptEdits`, `auto`→`acceptEdits`, `plan`→`plan`,
  `bypass`→`bypassPermissions`. Отдельного «исполнять всё без спроса» между `acceptEdits`
  и `bypassPermissions` у CLI нет, поэтому `auto` — синоним `accept_edits`, а не
  третий уровень: он НЕ обходит `MAC_ALLOW_BYPASS`. См. `toPermissionMode` в `protocol.ts`.
- `bypass` режим доступен только при `MAC_ALLOW_BYPASS=true` в env бэкенда.
- Denied patterns: бэкенд проверяет промпт против regex-ов из `MAC_DENIED_PROMPT_PATTERNS` (CSV).
- Kill switch: команда `MAC_STOP` от бэкенда останавливает все активные Claude процессы
  `SIGINT`-ом, а через `KILL_GRACE_MS` (5 с) эскалирует до `SIGKILL` — см. `kill.ts`.
  Один только `SIGINT` процесс, игнорирующий его, не останавливает.
- `MAC_PROJECT_ROOTS` — единственный белый список путей. Всё, что вне корней, отклоняется без спавна.
- Одновременно демон держит один WebSocket; при разрыве — kill активных детей (SIGINT,
  затем SIGKILL) и реконнект 1→2→5→10 секунд.

## Codex sessions

The app's Mac form selects Claude Code or Codex. The existing `MAC_RUN_CLAUDE` action accepts `provider: "claude" | "codex"` (default Claude for compatibility). Codex travels as `run_codex`; an old daemon cannot silently run Claude for this request. Deploy the backend first, then the daemon, then disable legacy authentication as described above.

Install/sign in to Codex locally (`codex login status`). `CODEX_BIN` optionally names its executable; otherwise it must be in the daemon PATH. Prompts use stdin and the same project allowlist, stream limits and cancellation handling. Codex uses `exec`: ask/plan → read-only, accept_edits/auto → workspace-write, approval policy never (headless), network access for workspace commands disabled. User config and execpolicy overrides are ignored for this controlled invocation. Authentication still belongs to the local Codex installation, not daemon environment credentials. Codex bypass is rejected; there is no fallback to Claude on failure.

CLI reference: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). Verified against the locally installed CLI help and a control response with production argv/sanitized environment.

## Opt-in provider fallback

`allowFallback: true` permits selecting Codex before a Claude task starts. Omitted/false preserves the original behavior. Results retain `requestedProvider` and identify the selected `provider`, plus a structured `fallbackReason` when used.

Before an eligible Claude run, the daemon checks `claude auth status --json` (5 seconds, 16 KiB maximum). Exact `loggedIn:false` permits fallback. With `loggedIn:true`, a separate readiness request checks provider availability (10 seconds, 64 KiB maximum). This sends only the fixed text “Reply only OK.” in a disposable directory; the user's task and project content are not sent. It can consume a small model request. The command disables tools, MCP, hooks, skills, session persistence, Chrome integration and filesystem settings sources. Standard local OAuth/keychain authentication remains available. Both probes are skipped when user, ancestor/project, or managed configuration selects a custom model/provider/auth helper, contains custom settings-based environment overrides, or cannot be inspected safely; the actual Claude task retains its normal configuration. Only the three non-secret inference flags `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, `MAX_THINKING_TOKENS`, and `CLAUDE_CODE_DISABLE_1M_CONTEXT` may pass from settings into the readiness environment; other environment overrides disable probes. Configuration values are never logged.

The readiness parser requires the CLI's initialization frame to confirm empty tools/MCP and accepts only typed `assistant.error` or `system/api_retry.error`: `rate_limit` → `quota_exhausted`, `billing_error` → `billing_unavailable`, `authentication_failed` → `authentication_unavailable`. Billing failures may include an expired subscription; the daemon does not infer subscription status from freeform text. These fields follow the [official Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript). Malformed output, unknown errors, policy refusals, timeouts and model-generated text never authorize a provider switch. Unknown preflight results proceed with the original provider.

A synchronous task-spawn `ENOENT` also permits fallback only when the executable is independently absent (`executable_not_found`). Once any actual task child starts, its failures, quota errors, cancellation or timeout never replay the task with another provider. Both probes are tracked by run ID and killed on cancel/stop/disconnect; cancellation prevents a subsequent task launch. The project allowlist is revalidated after probes finish. Probe output is not forwarded or logged.

Fallback is disabled in bypass mode. Codex → Claude is blocked (`fallbackBlocked: permission_mismatch`) because Claude's permission modes cannot preserve Codex's filesystem/network sandbox. A separately requested Claude session remains possible under the normal approval flow.

Verification: local installed Claude accepted the readiness command and produced the structured `authentication_unavailable` classification with sanitized daemon environment; no raw provider output was logged. Quota/billing cases are covered with isolated subprocess fixtures, not a live exhausted account.

## Управление Mac (MAC_CONTROL)

Закрытый список команд без Claude CLI: `lock`, `sleep`, `volume`, `mute`, `unmute`,
`open_app`, `reminders`, `reminder_add`, `event_add`, `shutdown`, `restart`.
Сервер и демон разбирают команду одним строгим разбором (`lib/mac-control.ts`);
исполнитель `macctl.ts` превращает её в фиксированный argv без оболочки.
Команда принимается только из лички владельца, только от оркестратора;
выключение и перезагрузка всегда идут через подтверждение в чате
(`docs/approval-policy.md`).

Всё выключено по умолчанию. Включает владелец в окружении демона:

- `MAC_CONTROL_ENABLED=true` — сам выключатель;
- `MAC_APPS=alias=bundle.id,...` — единственный способ назвать приложение для `open_app`;
- `MAC_CALENDAR_ENABLED=true` — напоминания и события (помощник EventKit);
- `MAC_CALENDAR_BIN_DIR=/абсолютный/путь` — постоянная папка помощника вне папки
  релиза. Разрешение macOS привязано к пути бинаря, поэтому из релиза оно теряется
  на каждой выкатке; без переменной остаётся путь внутри релиза.

Разрешения macOS выдаёт только владелец, руками:

1. `sh build-calendar.sh` собирает два бинаря: помощника `bin/agent-calendar` и
   прокладку `bin/agent-calendar-run`, через которую его и зовут. Прокладка нужна
   не для удобства: разрешение TCC спрашивается у «ответственного» процесса, а им
   для всего поддерева демона становится bun — у него нет строки о том, зачем ему
   календарь, поэтому диалог не показывается и доступ отказывается молча.
   Подробности — в `calendar-spawn.c`.
2. Диалоги «Календари» и «Напоминания» приходят только когда помощник отвечает сам
   за себя, то есть под launchd или под прокладкой:
   `bin/agent-calendar-run authorize` и `bin/agent-calendar-run authorize-reminders`.
   Из оболочки агента диалога не будет — ответственным окажется терминал.
3. Громкость, выключение и перезагрузка через `osascript` попросят
   «Автоматизация → System Events» при первом вызове; без него демон вернёт
   `automation_access_required`.

Проверка вручную: `bun macctl.ts '{"command":"volume","level":30}'`.
Наружу уходят только фиксированные коды ошибок, stderr не пересылается.

## Такси (Яндекс Go)

Операции `quote`, `prepare`, `confirm`, `abandon`, `status`, `cancel` приходят
кадром `taxi` и разбираются строго (`lib/taxi.ts`). Браузер — обычный Chrome через
`playwright-core` с отдельным профилем; никаких стелс-приёмов. Капча или страница
входа — отказ и скриншот владельцу. Всё про вёрстку — в `taxi-selectors.ts`.

Всё выключено по умолчанию. Подготовка — только руками владельца:

1. Отдельный аккаунт Яндекса для агента и карта с лимитом расходов; основной
   аккаунт в профиль агента не вносить.
2. `cd agent/mac-daemon && bun install` — ставит `playwright-core` (браузер не
   скачивается, используется установленный Chrome).
3. Окружение демона:
   - `TAXI_ENABLED=true`;
   - `TAXI_PROFILE_DIR` — абсолютный путь к каталогу профиля, владелец — текущий
     пользователь, права `700` (иначе `profile_insecure`);
   - `TAXI_HEADLESS=true` — по желанию, без окна (Яндекс чаще показывает капчу);
   - `TAXI_BROWSER_CHANNEL` — по умолчанию `chrome`.
4. Вход: `TAXI_PROFILE_DIR=… bun taxi.ts login` — окно Chrome, владелец входит
   сам и жмёт Enter в терминале. Агент пароли и коды не вводит.
5. Сверка локаторов: `bun taxi.ts probe` печатает дерево доступности страницы,
   `bun taxi.ts quote "откуда" "куда"` — расчёт без заказа. Если тексты кнопок
   и полей отличаются, правится только `taxi-selectors.ts`.
6. Яндекс Go работает из российского региона: при VPN на Mac проверь, что
   `taxi.yandex.ru` открывается без редиректа.
7. На сервере: `TAXI_ENABLED=true`, владелец в `MAC_USER_IDS` и
   `MINIAPP_ADMIN_USER_IDS`, активный ключ подписи в приложении.

Заказ — два шага: `prepare` (маршрут, тариф, цена; ничего не нажимается) и
`confirm` (цена ещё раз, сверка с подписанным потолком, одно нажатие «Заказать»).
Сессия `prepare` одноразовая и живёт 3 минуты. Браузер закрывается после
5 минут простоя.

## Доставка (курьер Яндекс Go)

Кадр `delivery`, операции те же, что у такси (`lib/delivery.ts`); код — `delivery.ts`,
страница — `delivery-playwright.ts`, вёрстка — `delivery-selectors.ts`. Страница —
`dostavka.yandex.ru/order/express/`: адреса и расчёт экспресс-курьера сверены на живом
профиле. «Курьер» и «Грузовой» на этой странице не предлагаются — в расчёте их нет,
а заказ такого тарифа — отказ. Контакты и кнопка заказа сверены 2026-09-18; комментарий и статусы — «НЕ сверено»:
пока их не сверили, исполнитель упрётся в отказ до нажатия — деньги не спишутся.

1. Окружение демона:
   - `DELIVERY_ENABLED=true`;
   - `DELIVERY_PROFILE_DIR` — отдельный от `TAXI_PROFILE_DIR` каталог профиля (Chrome
     запирает профиль; совпадение — отказ `profile_shared`), права `700`;
   - `DELIVERY_HEADLESS`, `DELIVERY_BROWSER_CHANNEL` — как у такси.
2. Вход: `DELIVERY_PROFILE_DIR=… bun delivery.ts login` — владелец входит сам, Enter.
   Телефон отправителя подставляет Яндекс Go из аккаунта; пустой телефон получателя
   исполнитель заполняет тем же номером (из поля в поле, наружу не читается). Другое
   пустое обязательное поле — отказ `contact_required`. Способ оплаты привязывает
   владелец в Яндекс Go: без него кнопка «Заказать» неактивна — отказ `payment_needs_owner`.
   Если вместо «Заказать» висит «Подтвердите данные» (имя, телефон, код из SMS) —
   отказ `data_confirm_needs_owner`: подтверждает владелец в Яндекс Go, агент кодов не вводит.
3. Сверка: `bun delivery.ts probe` печатает `guard`, `contact_required` и дерево
   доступности; `bun delivery.ts quote "откуда" "куда"` — расчёт без заказа. Сверь
   поле комментария, контакты, кнопку заказа и `DELIVERY_STATE_TEXT`. Правится только `delivery-selectors.ts`.
4. На сервере: `DELIVERY_ENABLED=true`, владелец в `MAC_USER_IDS` и
   `MINIAPP_ADMIN_USER_IDS`, активный ключ подписи.

Заказ — `prepare` (маршрут, тариф, комментарий, цена) и `confirm` (цена, сверка с
потолком, одно нажатие). Сессия живёт 3 минуты, браузер закрывается после 5 минут простоя.

## Яндекс Лавка

Операции `quote`, `prepare`, `confirm`, `abandon`, `status` приходят кадром `shop`
и разбираются строго (`lib/shop.ts`). Браузер и правила — как у такси: отдельный
профиль Chrome, без стелс-приёмов, капча или вход — отказ и скриншот. Вёрстка —
в `shop-selectors.ts`. Поиск и карточки товаров сверены на публичных страницах;
корзина, оформление, оплата и заказы видны только после входа — их локаторы
сверяет владелец.

Всё выключено по умолчанию. Подготовка — только руками владельца:

1. Тот же отдельный аккаунт Яндекса и карта с лимитом, что для такси.
2. Окружение демона:
   - `SHOP_ENABLED=true`;
   - `SHOP_PROFILE_DIR` — отдельный каталог профиля (не профиль такси), права `700`;
   - `SHOP_HEADLESS`, `SHOP_BROWSER_CHANNEL` — как у такси.
3. Вход и адреса: `SHOP_PROFILE_DIR=… bun shop.ts login` — владелец входит сам,
   добавляет свои адреса доставки и привязывает карту (или SberPay/Яндекс Пэй),
   затем Enter. Карту агент не вводит: без сохранённого способа оплаты —
   `payment_needs_owner`. Новых адресов агент не заводит; по просьбе владельца он
   умеет только переключиться на один из уже сохранённых (`set_address`): открывает
   окно адресов, выбирает адрес, чьей подписи хватает словам запроса, — и только
   если такой ровно один, — затем перечитывает шапку. Не нашлось или подходит
   нескольким — окно закрывается, адрес прежний. Без адреса — `address_required`.
4. Сверка локаторов: `bun shop.ts quote "молоко" "хлеб"` — поиск без корзины;
   `bun shop.ts probe` — дерево доступности текущей страницы: открой руками
   корзину с товаром, страницу оформления (до оплаты) и «Мои заказы», на каждой
   нажми Enter. Если тексты отличаются — правится только `shop-selectors.ts`.
5. Корзина профиля должна быть пустой: чужие товары — отказ `cart_not_empty`.
6. На сервере: `SHOP_ENABLED=true`, владелец в `MAC_USER_IDS` и
   `MINIAPP_ADMIN_USER_IDS`, активный ключ подписи.

Заказ — `prepare` (подписанные товары в пустую корзину, итог со страницы
оформления, ничего не оплачивается) и `confirm` (итог ещё раз, сверка с
подписанным потолком, одно нажатие «Оплатить»). Любой отказ до оплаты убирает
добавленные товары из корзины. Сессия одноразовая и живёт 5 минут.

## Яндекс Еда

Тот же кадр `shop`, тот же `SHOP_ENABLED` и тот же профиль `SHOP_PROFILE_DIR`
(один вход в Яндекс на Лавку и Еду). Вёрстка — в `eda-selectors.ts`, код
страницы — `eda-playwright.ts`. На живом профиле сверены поиск ресторанов, адрес
в шапке, стоимость доставки, карточки меню (`product-card-v2-*`), окно блюда и
корзина; оформление, оплата и заказы — предположения,
помеченные «НЕ сверено». Пока владелец их не сверил, исполнитель
упрётся в отказ до оплаты (`address_required`, `place_not_found`, `cart_mismatch`,
`price_unreadable`) — заказ не пройдёт, но и деньги не спишутся.

Сверка — только руками владельца:

1. Вход и адрес: `SHOP_PROFILE_DIR=… bun shop.ts login eda` — войти, выбрать адрес
   доставки, проверить сохранённую карту, Enter.
2. `bun shop.ts eda-quote "название ресторана" "блюдо"` — поиск ресторана и блюд
   без корзины. `place_not_found` — поправить `edaSearchUrl` или `placeLink`/`placeTitle`;
   пустой список блюд — `dishCard`/`dishTitle`/`dishPrice`/`dishMeta`.
3. `bun shop.ts probe eda`: руками открой ресторан, положи одно блюдо (посмотри
   счётчик и «минус» на карточке), открой корзину, страницу оформления до оплаты и
   «Мои заказы»; на каждой нажми Enter. Сверь `dishCounter`, `dishMinus`,
   `addressButton`, `cartRow*`, окно адресов (`addressDialog`, `addressRadio`),
   тексты `checkout`, `pay`, `total`, `savedCard` и
   `EDA_STATE_TEXT`. Если отличаются — правится только `eda-selectors.ts`.
4. Корзина Еды должна быть пустой. Если после «В корзину» остаётся окно
   («корзина другого ресторана» и т. п.) — исполнитель закрывает его и отказывает.

Окно блюда и корзина сверены на живом профиле (Папа Джонс): название, вес, цена,
количество, группы опций (`h4` с подсказкой, `label` с доплатой «+ N ₽», радио —
обязательный выбор одного, чекбоксы «Выберите до N»), кнопка «В корзину»
(`product-full-card-add-to-cart[-disabled]`) и строки корзины
(`product-card-row-root`: название, опции, сумма строки, вес, количество). Расчёт
открывает окно каждого найденного блюда (до трёх на запрос) и отдаёт группы опций;
незнакомую подсказку или доплату не угадываем — блюдо в расчёт не попадает.
Исполнитель отмечает подписанные опции, выставляет количество, перечитывает окно
(`options_mismatch` при расхождении) и жмёт «В корзину».

## Яндекс Маркет

Тот же кадр `shop`, `SHOP_ENABLED` и профиль `SHOP_PROFILE_DIR`. Вёрстка — в
`market-selectors.ts`, код страницы — `market-playwright.ts`. Поиск, карточка и
адрес сверены на живом профиле; корзина, оформление и статусы помечены «НЕ
сверено» — пока их не сверили, исполнитель упрётся в отказ до оплаты.

Товар — номер карточки из ссылки `/card/<slug>/<номер>`.
Доставка на расчёте не читается (`delivery_rub: null`): её цена видна только на
оформлении, и итог сверяется с подписанным потолком.

1. `SHOP_PROFILE_DIR=… bun shop.ts login market` — войти, выбрать адрес, проверить
   сохранённую карту (не «при получении»), Enter.
2. `bun shop.ts market-quote "товар"` — поиск без корзины. Пустой список —
   `marketSearchUrl`, `snippet*`; id не читается — `snippetLink` и `marketIdFromHref`.
3. `bun shop.ts probe market`: руками открой карточку товара, положи его в корзину
   (посмотри счётчик и «плюс»/«минус»), открой корзину, оформление до оплаты и
   «Мои заказы»; на каждой нажми Enter. Сверь `productTitle`, `productOffer`,
   `cartButton`, `qty*`, `addressButton`, `cartItem*`, тексты `checkout`, `pay`,
   `total`, `savedCard`, `payOnDelivery` и `MARKET_STATE_TEXT`. Правится только
   `market-selectors.ts`.
4. Корзина Маркета должна быть пустой. Если после «В корзину» страница просит
   выбрать размер или цвет — отказ `options_required`; допродажу исполнитель закрывает.

## Починка селекторов (SHOP_REPAIR)

Кадр `repair {service, code}` (`selector-repair.ts`): свежая ветка от
`origin/main` в `<SELECTOR_REPAIR_REPO>/.claude/worktrees/`, `bun install`,
`claude --print` с неизменяемым заданием, проверка изменённых путей, коммит,
пуш ветки и `gh pr create`. Мержа нет.

- `SELECTOR_REPAIR_REPO` — клон репозитория с доступом `git push` и `gh`,
  внутри `MAC_PROJECT_ROOTS`. Не задан — `repair_disabled`.
- `bun shop.ts selfcheck [eda|market]` — только чтение: открывает страницу поиска
  в профиле покупок и печатает счётчики селекторов и имена
  `data-testid` / `data-auto` / `data-zone-name` (без текста страницы).
- На время починки браузер покупок закрыт, покупки получают `shop_busy`.

