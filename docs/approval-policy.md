# Политика подтверждений владельца

Правило: **деньги, DNS, пуш в main, удаление, выключение машины и сообщения третьим
лицам — только после подтверждения владельца в чате.** Режим автономии
(`auto`, `semi_auto`), `MAC_AUTONOMOUS` и формулировка запроса этого не меняют;
исключение одно — режим `locked`, где действие не исполняется вовсе.

## Где живёт

- `agent/lib/approval-policy.ts` — категории и правила, модуль без побочек.
- `permissions.payloadForcesApproval` вызывает `approvalPolicyReason` последним
  шагом; гейт (`evaluateGate({forceApproval})`) отвечает `approval`.
- Причина попадает в карточку подтверждения: «политика владельца: … — только с подтверждением».

## Категории

| Категория | Что попадает |
| --- | --- |
| `money` | `ORDER_TAXI`, `ORDER_FOOD`, `ORDER_DELIVERY`, `MARKET_PURCHASE` (зарезервированы до шагов 9–10, дополнительно идут через подписанный гейт); промпт `MAC_RUN_CLAUDE` про оплату/покупку/заказ |
| `dns` | `CLOUDFLARE_DNS` (любое изменение записи); промпт про DNS, Cloudflare, CNAME, A-запись |
| `push_main` | `REVIEW_AND_MERGE_PR`; промпт с `git push … main`, force-push, «пуш в main» |
| `delete` | `DELETE_MESSAGE`; промпт с `rm -rf`, `git reset --hard`, `drop table`, «удали» |
| `shutdown` | `MAC_CONTROL` с `shutdown`/`restart`; промпт про shutdown/reboot/«выключи мак» |
| `third_party_message` | `USERBOT_SEND_DM` (личное сообщение по @username); `SEND_MESSAGE`, `SET_REACTION`, `DELETE_MESSAGE` с `via_userbot: true`; промпт «отправь сообщение», «напиши ему» |

Правила для промпта `MAC_RUN_CLAUDE` — эвристика, а не песочница: они не
применяются к `mode: "plan"` (план ничего не исполняет), и их можно обойти
переформулировкой. Это пол, а не единственный рубеж: остаются
`MAC_DENIED_PROMPT_PATTERNS`, права macOS и ревью изменений.

## Личные сообщения от аккаунта владельца

`USERBOT_SEND_DM {username, text}` (`agent/lib/userbot-dm.ts`):

- выключено до `USERBOT_DM_ENABLED=true`;
- только оркестратор, только по просьбе владельца (`MINIAPP_ADMIN_USER_IDS`) в его личном чате, не делегированием;
- адресат — только публичный @username: не id и не телефон; перед отправкой проверяется, что это человек, а не бот, канал или сам владелец;
- одно сообщение до 4096 символов без разметки; невидимые и управляющие символы — отказ;
- карточка подтверждения показывает адресата и весь текст без обрезки;
- лимиты: 20 заявок в час и общее анти-flood ведро аккаунта.

## DNS в Cloudflare

`CLOUDFLARE_DNS {op, name, type, content?, previous?, ttl?, proxied?}` и
инлайновое чтение `CLOUDFLARE_DNS_LIST {name?, type?}` (`agent/lib/cloudflare-dns.ts`):

- выключено до `CLOUDFLARE_DNS_ENABLED=true`;
- токен `CLOUDFLARE_DNS_API_TOKEN` выпускает владелец: Custom token, одно право
  «Zone → DNS → Edit», Zone Resources — только нужные зоны; по желанию —
  фильтр по IP сервера и срок действия. Zone Read не нужен: id зон лежат в
  `CLOUDFLARE_DNS_ZONES` (`имя=id` через запятую). Токен не попадает ни в
  payload, ни в ошибки: наружу уходят только HTTP-статус и коды Cloudflare;
- только оркестратор, только по просьбе владельца в его личном чате, не делегированием;
- типы A, AAAA, CNAME, TXT. NS, MX, CAA и прочие не поддерживаются;
- корень зоны, wildcard и имена из `CLOUDFLARE_DNS_PROTECTED` не меняются;
- `update` и `delete` несут `previous`: карточка показывает «было → станет»,
  а хендлер меняет запись, только если она всё ещё такая;
- зоны и защищённые имена сверяются заново после одобрения;
- лимиты: 10 изменений в час, чтение — 10 в минуту.

## Что вне политики

- Разрешения macOS (Календари, Напоминания, Автоматизация) выдаёт только владелец руками.
- Изменения `agent/mac-daemon/**`, `agent/lib/permissions.ts`,
  `agent/lib/approval-policy.ts` и схем инструментов — только через PR.
- Деплой — только по команде владельца.
