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

Демон отдаёт `MAC_BRIDGE_SECRET` первым же фреймом при открытии сокета — до
любого обмена. Поэтому адрес проверяется на старте (`bridge-url.ts`):

- `wss://` — куда угодно;
- `ws://` — только на петлю (`localhost`, `127.0.0.0/8`, `::1`);
- всё остальное — демон не стартует и печатает, что именно не так.

Если между демоном и бриджем уже есть шифрованный транспорт (SSH-туннель на
не-петлевой адрес, Tailscale), запрет снимается явным
`MAC_BRIDGE_INSECURE_PLAINTEXT=1`.

Оговорка: на петле это не защищает от локального процесса, успевшего занять
порт раньше бриджа. Такой процесс идёт от имени того же пользователя и может
прочитать окружение демона напрямую — эта дыра здесь не закрывается.

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
