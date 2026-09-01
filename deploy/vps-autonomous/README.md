# Автономный цикл на VPS (замена GitHub Actions)

Минуты GitHub Actions приватного репо `kevinscott66/ai-agents` исчерпаны → автономный
цикл перенесён на всегда-включённый VPS как systemd-таймер (по образцу `delabs-daily-draft`).

## Что делает
После явного readiness-gate и далее каждые 2 часа `autonomous-cycle.sh`:
1. Обновляет изолированный clone `/opt/agent-autonomous` до `origin/main`.
2. Режет свежую ветку `agent/<role>-vps-<ts>`.
3. Запускает заранее авторизованный локальный `claude` headless с role-scoped
   промптом из внутреннего collaboration contract. GitHub Actions workflow не
   используется как scheduler или executor.
4. Коммитит → пушит ветку → открывает **PR с лейблом `needs-human-review`**.

**Никогда не пушит в main.** Все изменения идут через PR на ревью.

## Readiness gate и управление циклом

Установка unit/timer сама по себе не даёт циклу права запускать Claude. Скрипт
перед чтением `.env` требует файл `/etc/agent-autonomous/readiness` с одной
строкой `ready` или `green`. Отсутствующий файл и любое другое содержимое дают
успешный no-op и JSONL-событие `readiness_missing_or_red`. Этот файл создаётся
только после финального зелёного quality-gate всех текущих проектов и отдельного
решения владельца; в репозитории и на VPS он заранее не создаётся.

Дополнительные предохранители:

- `/etc/agent-autonomous/disabled` или `AUTO_DISABLED=1` — disable/no-op;
- атомарный lock `/run/lock/agent-autonomous-cycle` — второй цикл не стартует;
- `/var/lib/agent-autonomous/{failures,next-run}` — экспоненциальный backoff после
  ошибки, с пределом 6 часов;
- отчёт каждой ошибки сохраняется как JSON в
  `/var/log/agent-autonomous-reports/`, без prompt, env или stderr;
- `DRY_RUN=1` сохраняет существующий режим без commit/push/PR;
- `AUTO_ROLLBACK=1` возвращает только изолированный `$AUTO_WORKDIR` к
  `origin/main`, не касаясь `/opt/agent-team` и production;
- child Claude получает только явный безопасный базовый env и не получает
  `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` или другие
  секреты. Для запуска нужен заранее авторизованный локальный Claude CLI.

Скрипт и timer оставляются установленными, но не активируются этим изменением.
Перед будущей активацией нужно отдельно проверить readiness-файл, dry-run,
rollback, права на state/log directories и non-root deployment path.

## Безопасность
- Изолирован в `/opt/agent-autonomous`, не трогает прод `/opt/agent-team`.
- `permission-mode=acceptEdits` + явный allowedTools; systemd запускает цикл от
  отдельного непривилегированного пользователя `agent-autonomous`.
- timeout 540s на claude-итерацию.
- Промпт запрещает читать секреты/трогать прод-сервис/БД/systemd.
- node_modules — симлинк на прод-деплой (экономия 566M; не коммитится).

## Установка (нужны секреты только для обёртки)

### 1. Создать fine-grained GitHub PAT (только владелец)
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
- **Repository access:** только `kevinscott66/ai-agents`
- **Permissions:** `Contents` → Read and write, `Pull requests` → Read and write
- Скопировать токен (`github_pat_...`).

### 2. Создать service account и credentials на VPS
```bash
ssh root@203.0.113.10
useradd --system --home-dir /var/lib/agent-autonomous --create-home --shell /usr/sbin/nologin agent-autonomous || true
install -d -o agent-autonomous -g agent-autonomous -m 0750 /opt/agent-autonomous
install -d -o root -g agent-autonomous -m 0750 /etc/agent-autonomous
umask 077
cat > /etc/agent-autonomous/credentials <<'EOF'
GH_TOKEN=github_pat_xxx
CLAUDE_CODE_OAUTH_TOKEN=oauth_xxx
EOF
chown root:agent-autonomous /etc/agent-autonomous/credentials
chmod 0640 /etc/agent-autonomous/credentials
```
Установите Claude CLI в `/usr/local/bin/claude` с владельцем `root:root` и без
права записи для service account. Эти credentials читаются только обёрткой;
дочернему Claude они не передаются.

### 3. Поставить скрипт + юниты (делает ассистент после шага 2)
```bash
ssh root@203.0.113.10 'mkdir -p /opt/vps-autonomous'
scp deploy/vps-autonomous/autonomous-cycle.sh     root@203.0.113.10:/opt/vps-autonomous/
scp deploy/vps-autonomous/scan-staged-secrets.sh  root@203.0.113.10:/opt/vps-autonomous/
scp deploy/vps-autonomous/agent-autonomous.*      root@203.0.113.10:/etc/systemd/system/
ssh root@203.0.113.10 'chmod +x /opt/vps-autonomous/*.sh && systemctl daemon-reload'
```
`scan-staged-secrets.sh` обязателен: без него обёртка отказывается коммитить.
Лежать он должен именно **рядом с обёрткой**, а не браться из рабочего дерева —
в дереве его только что мог переписать сам агент (у него Write).

### 4. Dry-run (одна итерация вручную) → проверка → readiness → enable таймера
`DRY_RUN=1` прогоняет весь путь (clone → ветка → claude → стейдж), но **не коммитит,
не пушит и не открывает PR** — печатает список файлов и diffstat. Только так и
проверять: без него «прогон» сразу создаёт PR.
```bash
ssh root@203.0.113.10 'sudo -u agent-autonomous env DRY_RUN=1 AUTO_ENV_FILE=/etc/agent-autonomous/credentials bash /opt/vps-autonomous/autonomous-cycle.sh qa "smoke test"'
cat /var/log/agent-autonomous/agent-autonomous.log      # staged files + diffstat
```
Сначала убедиться, что readiness отсутствует или цикл отключён, затем проверить,
что в staged **нет** `agent/node_modules` и что диф осмысленный. После финального
зелёного quality-gate всех проектов владелец может явно создать readiness-файл:

```bash
printf 'green\n' | ssh root@203.0.113.10 'umask 077; mkdir -p /etc/agent-autonomous; cat > /etc/agent-autonomous/readiness'
```

Только после отдельного подтверждения владельца разрешено:

```bash
ssh root@203.0.113.10 'systemctl enable --now agent-autonomous.timer'
```

Проверено вживую 2026-08-02 (роль qa): подписка ОК, PR не создан, симлинк не в стейдже.
Учти — агент попутно создаёт черновые файлы, а `git add -A` метёт их в PR; ловится
на ревью (лейбл `needs-human-review`).

## Петля обратной связи (обязательна, добавлена 2026-08-13)

Первая редакция цикла её не имела, и это стоило 114 открытых PR за 11 дней:
итерация делала задачу и открывала PR → PR никто не мержил → задача в TASKS.md
оставалась открытой → следующая итерация видела её сверху и делала заново.
`tools-schema.ts` переписан десять раз, `self-diag.ts` семь.

Четыре слоя, в порядке надёжности:

1. **Потолок открытых PR — `AUTO_MAX_OPEN_PRS` (по умолчанию 5).** Проверяется
   ДО запуска claude: если очередь не разобрана, итерация не тратит ни токена и
   выходит с `[skip]`. Единственный слой, не зависящий от поведения агента.
   Не удалось спросить GitHub — тоже стоп (`[fatal]`), а не «ну и ладно».
2. **Список занятых задач в промпте.** Обёртка собирает id из заголовков
   открытых PR цикла и отдаёт агенту блоком ALREADY TAKEN.
3. **Очередь роли (YOUR QUEUE).** Обёртка сама разбирает TASKS.md
   (`queue-filter.awk`), выкидывает закрытые / `needs-human:` / `dropped:` /
   `deferred:` / уже занятые и отдаёт агенту до пяти готовых id.
   Фильтр берётся рядом с обёрткой, а не из рабочего дерева — там его мог
   переписать сам агент. Файла нет — не фатал: очередь это удобство, без неё
   агент выбирает сам, как выбирал раньше.
   **Очередь пуста → claude не запускается вообще** (`[skip]`, ноль трат).
   Раньше пустая очередь значила «выбирай сам» — и это тот самый режим, из
   которого выросли ~75 PR без единой строки кода: своей задачи агент не нашёл,
   но итерация уже оплачена, и он правил `.claude/memory/**` и TASKS.md, лишь бы
   не выйти пустым. Пропускаем только когда фильтр отработал и вернул ноль; нет
   TASKS.md или фильтра — это «неизвестно», а не «пусто», и итерация идёт. Явный
   HINT человека сильнее очереди.
4. **Отказ открыть дубликат.** Агент пишет взятую задачу в `.autonomous-task-id`
   (одна строка `T-<число>`); обёртка её санитизирует, сверяет со списком и при
   совпадении PR не создаёт — ветка остаётся локально в `$WORKDIR`.

Почему нужны все: слой 2 живёт в промпте, а промпт собирается из TASKS.md и
файлов памяти — текста, который правит тот же агент. Слой 4 полагается на то,
что агент вообще написал файл, и написал в нужном формате. Мержить очередь всё
равно надо руками — потолок лишь не даёт ей расти.

Слой 3 появился после живого прогона: на просьбу «напиши id задачи» агент
записал слаг `loop-dedup`. Санитайзер его отбраковал (fail-safe: PR получил бы
лейбл `no-task-id`), но дедупликация для такой итерации не работает. Точную
строку неоткуда взять, если агент не сматчил заголовок сам — теперь id лежит
готовым в промпте. **Подставлять id за агента нельзя:** он может уйти работать
не туда, и PR получит чужой номер — это хуже, чем отсутствие номера.

### Проверка промпта без трат

`PROMPT_ONLY=1` печатает собранный промпт и выходит, не запуская claude. Блоки
ALREADY TAKEN и YOUR QUEUE берутся из GitHub и TASKS.md, то есть меняются сами
по себе — смотреть на них полным прогоном значит платить $1.5 и девять минут за
просмотр двух списков.

```bash
ssh root@203.0.113.10 'PROMPT_ONLY=1 bash /opt/vps-autonomous/autonomous-cycle.sh backend ""'
```

### Грязное дерево больше не заклинивает цикл

Любой ранний выход (`DRY_RUN`, отказ по дубликату, красный гейт секретов)
оставлял рабочее дерево грязным, а следующая итерация падала на
`checkout -B main` с «local changes would be overwritten» — и так каждый раз,
навсегда. Поймано живьём 2026-08-13 сразу после dry-run. Теперь
`reset --hard HEAD` + `clean -fd` идут ДО checkout.

Следствие: наработки в грязном дереве живут ровно до следующего запуска. Поэтому
на пути «дубликат» они сохраняются локальным коммитом (после гейта секретов, не
до), а красный гейт секретов прямо пишет, что смотреть надо сейчас — коммитить
флагнутое им нельзя даже локально.

### Что проверено вживую (2026-08-13)

| Слой | Как проверен | Результат |
|---|---|---|
| 1 потолок | `AUTO_MAX_OPEN_PRS=0` | `[skip]`, exit 0, claude не запускался |
| 1 fail-closed | `GH_TOKEN=ghp_invalid…` | `[fatal]`, exit 1, итерация не начата |
| 2 ALREADY TAKEN | синтетический `gh pr list --json` | два PR на одну задачу схлопнулись в `T-742 — PR #401, #404` |
| 3 очередь | греп по боевому TASKS.md | `role:qa` → `T-805`; `T-80` не съеден фильтром `T-802` |
| 4 санитайзер | `DRY_RUN=1`, агент написал `loop-dedup` | отбраковано, `no-task-id`, PR не создан |
| 4 инъекция | `.autonomous-task-id` = `"T-1; rm -rf /"` | отбраковано регуляркой до `gh pr create` |
| промпт целиком | `PROMPT_ONLY=1 … backend ""` | YOUR QUEUE = 5 задач role:backend, ALREADY TAKEN = «(none)» |
| грязное дерево | тот же стейдж, что уронил `checkout` | exit 0, дерево сброшено, заклин снят |
| 3 фильтр очереди | 12 ролей на боевом TASKS.md | отсеклись 8 протухших rework-задач; T-735 (открытая) осталась |
| 3 пустая очередь | `role:design` (очередь 0) | `[skip]`, exit 0, claude не запускался |

Про фильтр очереди отдельно: первая редакция грепала только заголовок, а
`needs-human:` в TASKS.md стоит в заголовке ноль раз и в теле — семь, то есть
задачи «только для человека» уходили боту. Вторая редакция смотрела всё тело до
следующего `###` и отсекала открытую T-735 (audit_logs пуст) по чужой сводке в
конце секции. Итог: заголовок + первые шесть непустых строк. Смещение
неравноценно — лишняя задача в очереди хуже недостающей, поэтому при сомнении
исключаем.

**id задачи вшивается в заголовок PR**, а не в тело: тело правят руками, и
дедупликация сломалась бы молча. PR без объявленной задачи получает лейбл
`no-task-id` — дедупликация для него не работает, это видно на списке PR.

Перед каждым новым запуском VPS-обёртка выполняет T-513 control loop
(`bun run agent --role orchestrator --mode review`). Он проверяет свежие PR,
пропускает уже отмеченные маркером control-loop комментарии и оставляет даже
зелёные PR для человеческого approval: control-loop не имеет merge-capability.
При недоступности GitHub итерация останавливается. `AUTO_CONTROL_LOOP=0` —
только явное временное отключение владельцем.

## Управление
- Логи: `/var/log/agent-autonomous/agent-autonomous.log`
- Разовый запуск роли: `systemctl start agent-autonomous.service` (роль задаётся
  drop-in'ом, а readiness-gate остаётся обязательным)
- Пауза: `systemctl disable --now agent-autonomous.timer`
- Сменить частоту: править `OnCalendar` в `agent-autonomous.timer`.
- Поднять потолок разово: `AUTO_MAX_OPEN_PRS=8 bash /opt/vps-autonomous/autonomous-cycle.sh`

## Состояние на 2026-08-13

Таймер **выключен** (`systemctl disable --now agent-autonomous.timer`) по просьбе
владельца. Скрипт с петлёй выкачен и готов; включение — решение владельца:

```
systemctl enable --now agent-autonomous.timer
```

Отдельно: до 2026-08-13 на VPS лежала редакция от 02.08, а ужесточения аудита
12.08 (чтение из `.env` ровно двух переменных вместо всего файла, `env -u
GH_TOKEN` для headless-claude, гейт `scan-staged-secrets.sh` перед коммитом)
туда не выкатывались. Теперь версии сверены по sha256.
