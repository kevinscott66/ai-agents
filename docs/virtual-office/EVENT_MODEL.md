# Agent event protocol v1 — proposed contract

Статус: спецификация, не существующий endpoint. Реальные доступные сигналы: [EXISTING_SYSTEM](EXISTING_SYSTEM.md).

## Envelope

```json
{
  "schemaVersion": 1,
  "streamId": "office-owner-scope-epoch",
  "seq": 42,
  "eventId": "018-example-uuid",
  "sourceEventId": "adapter-session:123",
  "type": "agent.state.changed",
  "timestamp": "2026-09-23T12:00:00.000Z",
  "observedAt": "2026-09-23T12:00:00.010Z",
  "source": "mock",
  "agentId": "backend",
  "runId": "run-example",
  "taskId": "task-example",
  "payload": {
    "state": "CODING",
    "project": "AirChat",
    "task": "Implement reconnect logic",
    "resource": "src/socket/client.ts",
    "progress": null,
    "summary": "Updating reconnect handling"
  }
}
```

Это **mock fixture**, не найденная задача. source = mock | backend. agentId/taskId/runId nullable для событий других сущностей; sourceEventId nullable для reconciliation. seq монотонен внутри streamId, целое <= JS MAX_SAFE_INTEGER; epoch меняется при потере журнала, несовместимом reset или смене scope. UUID eventId уникален; source ID используется для dedup до назначения seq. timestamp — источник, observedAt — gateway; порядок задаёт seq, не часы.

progress — null либо подтверждённое конечное число [0,1]. Не вычислять процент из времени или количества токенов. resource/branch/repository/test counts разрешены только при подтверждённом telemetry source; обычный model text не доказательство изменения файла.

## Event types и payload

| type | payload / смысл |
|---|---|
| agent.state.changed | полная AgentState revision, run correlation |
| agent.availability.changed | online/offline/unknown, paused/disabled, freshness |
| task.upserted / task.removed | безопасная Task либо ID+tombstone |
| action.observed | action ID, safe tool name, phase started/finished, outcome; phase только если известна |
| communication.observed | from/to IDs, safe summary, correlation, importance; отображение AGENT_COMMUNICATION |
| meeting.upserted / meeting.removed | intent ID, participants, topics, status; без выдуманного meeting на каждый delegate |
| project.upserted / project.removed | ID, name, safe repository references |
| infrastructure.upserted / infrastructure.removed | provider ID, capability, разрешённые показатели |
| source.health.changed | connected/degraded/disconnected, freshness |

Snapshot содержит те же entities. Entity upsert заменяет запись целиком, отсутствующее поле очищается; не использовать неоднозначный merge. Неизвестный optional event можно пропустить с advancing cursor; неизвестное обязательное изменение/major version — protocol_error и resync, без частично применённого мира.

## Transport и reconnect

Предлагаются GET `/office/v1/capabilities`, POST `/office/v1/stream-ticket`, WSS `/office/v1/stream`, POST `/office/v1/commands`, GET `/office/v1/commands/:id`. Это новые office endpoints, не существующие agent API.

1. После auth клиент отправляет hello(version, streamId?, lastAppliedSeq?). Gateway фиксирует authorized scope.
2. Writer фиксирует barrier N, берёт согласованный snapshot N и буферизует события >N для подписчика до отправки snapshot. Клиент атомарно заменяет projection, затем применяет N+1… Без окна между REST snapshot и subscribe.
3. Если epoch/scope совпадают и журнал содержит непрерывный suffix, gateway отправляет resume.accepted и replay от lastAppliedSeq+1. Иначе snapshot заново.
4. Duplicate seq <= cursor игнорируется; gap вызывает resync. До него не применять события вне порядка. Client хранит cursor вместе с projection или запрашивает snapshot после restart.
5. Протокольный heartbeat каждые 15 секунд, timeout 45 секунд (начальные параметры). Retry exponential 0.5–30 секунд с jitter. 401/revoked прекращает reconnect до повторной авторизации.
6. Начальные лимиты: frame 64 KiB, snapshot 2 MiB, outbound queue 1 MiB/client; overflow отключает медленного клиента с resync-required. Большие snapshots потребуют pagination/chunks перед ростом.
7. Journal retention: до 24 часов И не более 10000 событий на scope. За пределами — snapshot. Server restart восстанавливает projection+seq транзакционно; потеря DB создаёт новый epoch. TTL чувствительных summaries и удаления применяются также к replay.

Не заявляем exactly-once transport: доставка at-least-once с dedup. На MVP polling/reconcile 5–15 секунд компенсирует потери существующей шины; это наблюдение, не запуск автономных задач.

## Commands

`{commandId, kind, agentId, conversationId?, expectedRevision?, payload}`. actor/owner выводится только из сессии. kind сначала chat.send/task.create; task assignment проходит backend capability checks. Ответ accepted/queued — не completed. Результат коррелируется commandId и backend run/task ID.

Idempotency key scoped by owner + commandId, payload hash конфликтует при изменённом повторе. После network timeout читать результат, не повторять дорогую/опасную операцию вслепую. Mock и live sessions/journals разделены; mock commands физически не могут попасть в real adapter.

## Обязательные проверки перед live

Atomic snapshot race; duplicate/out-of-order/gap; retention expiry; restart epoch; clock skew; slow client; auth revoke и cross-owner replay; malformed/oversized input; task rollback invalidation; command duplicate/ambiguous outcome; secret and reasoning fixture exclusion. Нагрузка офиса не должна задерживать LLM/tool turn.
