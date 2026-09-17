# Подписанные платные действия

Платное действие (первое — заказ такси) выполняется только после того, как владелец
подписал на iPhone точные параметры сделки. «Да» в чате, кнопка в Telegram или токен
устройства такого действия не открывают: токен живёт на сервере и в приложении, а
закрытый ключ — только в Secure Enclave телефона под Face ID.

Код: `agent/lib/signed-actions.ts` (гейт) и `agent/lib/native-signing.ts` (HTTP для приложения),
тесты: `agent/tests/signed-actions.test.ts`, `agent/tests/native-signing.test.ts`.

## Ключ

- Алгоритм: ECDSA P-256, SHA-256. На iOS — `SecureEnclave.P256.Signing.PrivateKey`
  с `accessControl` `.privateKeyUsage` + `.biometryCurrentSet`: новый отпечаток или лицо
  делают ключ непригодным, нужна перерегистрация.
- Открытый ключ передаётся как SPKI DER (`publicKey.derRepresentation`) в base64.
- Подпись — 64 байта r‖s (`signature.rawRepresentation`) в base64.
- Регистрация создаёт ключ в статусе `pending` и шестизначный код. Код уходит владельцу
  по другому каналу (личка бота в Telegram), ключ становится `active` только после ввода
  кода. На ввод 10 минут и 5 попыток. Так утёкший токен устройства не даёт завести свой ключ.
- Активным бывает один ключ. Активация нового отзывает прежний (смена телефона);
  отозванный ключ не оживает.
- Не больше 3 регистраций в час (`registration_limit`), чтобы не засыпать личку кодами.

## Жизненный цикл действия

```
issued ──approve──▶ approved ──claim──▶ executing ──complete──▶ executed | failed
   │                   │                   └──checkFinal (превышение)──▶ aborted
   └─ неверная подпись ─▶ rejected         (просрочка на любом шаге — отказ)
```

1. **issue** — сервер фиксирует действие и отдаёт `nonce` и канонический `payload`.
   Сразу проверяются потолок суммы и дневной лимит.
2. **approve** — телефон показывает карточку, собранную из байтов `payload` (не из
   отдельных полей ответа), и подписывает эти байты. Сервер проверяет подпись над
   сохранённой копией. Первая неверная подпись переводит действие в `rejected`.
3. **claim** — исполнитель передаёт `payload`, который собирается выполнить; он должен
   совпасть с подписанным побайтово. Переход в `executing` атомарный: второй claim
   получит `nonce_used`.
4. **checkFinal** — перед последним кликом исполнитель сверяет итоговую цену с
   `max_final_rub`. Больше — `aborted`, владельцу уходит скриншот.
5. **complete** — итог выполнения.

## Канонический payload

JSON без пробелов, ключи объектов отсортированы по кодовым точкам, строки UTF-8,
числа — только целые. Дробные числа, `NaN`, `undefined` отвергаются: у разных языков
разное их представление, а подпись идёт над байтами.

```json
{"action":"order_taxi","amount_rub":450,"expires_at":1789627818,"issued_at":1789627698,
 "key_id":"…","kind":"paid_action","max_final_rub":517,"nonce":"…",
 "params":{"from":"…","tariff":"econom","to":"…"},"service":"yandex_go","v":1}
```

- `nonce` — 32 случайных байта base64url, выдаёт сервер, одноразовый.
- `issued_at`, `expires_at` — секунды Unix. TTL подтверждения 120 с.
- `max_final_rub = floor(amount_rub × (100 + отклонение) / 100)` — порог виден
  владельцу на карточке и входит в подпись.
- `key_id` — подписывать может только этот ключ.

## Лимиты

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `PAID_ACTION_MAX_RUB` | 1000 | Потолок одного действия. Выше — отказ, владелец делает это сам. |
| `PAID_ACTION_DAILY_MAX` | 5 | Действий в сутки по Москве (подтверждённые, выполняемые, выполненные). |
| `PAID_ACTION_PRICE_DEVIATION_PCT` | 15 | Допустимый рост итоговой цены. |
| — | 5 мин | Окно между подтверждением и claim. |

## Эндпоинты приложения

Все под токеном устройства и только для `MINIAPP_ADMIN_USER_IDS`. Токен лишь пропускает
к эндпоинтам: ключ без кода из лички не заводится, действие без подписи не подтверждается.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /api/native/signing/key` | — | `{key: {id, device, activated} \| null}` |
| `POST /api/native/signing/keys` | `{device, spki}` | `201 {keyId}`; код уходит в личку бота и в ответ не попадает. Не доставился — ключ отзывается, `502 code_delivery_failed` |
| `POST /api/native/signing/keys/:id/activate` | `{code}` | `{key}` |
| `GET /api/native/signing/actions` | — | `{actions: [{nonce, payload}]}` — ждут подписи, не больше 20 |
| `POST /api/native/signing/actions/:nonce/approve` | `{signature}` | `{ok: true}` |
| `POST /api/native/signing/actions/:nonce/reject` | — | `{ok: true}` |

Отказ гейта приходит как `{error: <код>}`: 400 — неверные данные, 404 — неизвестный ключ
или nonce, 409 — неподходящее состояние или лимит, 429 — `code_attempts`, `registration_limit`.

## Коды отказа

`key_invalid`, `key_unknown`, `key_not_pending`, `code_invalid`, `code_expired`,
`code_attempts`, `no_active_key`, `payload_invalid`, `limit_amount`, `limit_daily`,
`nonce_unknown`, `nonce_used`, `expired`, `key_revoked`, `signature_invalid`,
`payload_mismatch`, `price_deviation`, `registration_limit`.

## Чего модуль не делает

Не выполняет действие и не знает про такси: исполнитель вызывает `claim`,
`checkFinal` и `complete`. Не хранит реквизиты карт и пароли аккаунтов.
