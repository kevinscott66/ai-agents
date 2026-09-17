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
| `dns` | `CLOUDFLARE_DNS` (зарезервировано до шага 8); промпт про DNS, Cloudflare, CNAME, A-запись |
| `push_main` | `REVIEW_AND_MERGE_PR`; промпт с `git push … main`, force-push, «пуш в main» |
| `delete` | `DELETE_MESSAGE`; промпт с `rm -rf`, `git reset --hard`, `drop table`, «удали» |
| `shutdown` | `MAC_CONTROL` с `shutdown`/`restart`; промпт про shutdown/reboot/«выключи мак» |
| `third_party_message` | `SEND_MESSAGE`, `SET_REACTION`, `DELETE_MESSAGE` с `via_userbot: true`; промпт «отправь сообщение», «напиши ему» |

Правила для промпта `MAC_RUN_CLAUDE` — эвристика, а не песочница: они не
применяются к `mode: "plan"` (план ничего не исполняет), и их можно обойти
переформулировкой. Это пол, а не единственный рубеж: остаются
`MAC_DENIED_PROMPT_PATTERNS`, права macOS и ревью изменений.

## Что вне политики

- Разрешения macOS (Календари, Напоминания, Автоматизация) выдаёт только владелец руками.
- Изменения `agent/mac-daemon/**`, `agent/lib/permissions.ts`,
  `agent/lib/approval-policy.ts` и схем инструментов — только через PR.
- Деплой — только по команде владельца.
