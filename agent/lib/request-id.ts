/**
 * T-410 (T-303 HIGH #2): request-id propagation helper.
 *
 * Generates a short URL-safe id (nanoid-style, 12 chars) that we attach to
 * `DispatchCtx.requestId` and carry through dispatch + audit_log + structured
 * log lines.
 *
 * Аудит 2026-08-28: докблок перечислял четыре точки входа (telegram-апдейт,
 * HTTP Mini App, команда mac-bridge, тик планировщика). Родится id ровно в
 * одной из них — `orchestrator/message-handler.ts` на ходе пользователя.
 * Остальные три либо не диспатчат вовсе (mac-bridge, планировщик), либо
 * делают ровно один диспатч на запрос (`/api/mac/stop` в miniapp-server), где
 * ленивый минт внутри `dispatchAndAudit` даёт тот же результат. Отдельно от
 * них стоит путь апрува: `lib/commands.ts` протаскивает id ИСХОДНОГО хода из
 * строки апрува — там ленивый минт как раз ломал связь, и это уже починено.
 * Список точек входа держит `tests/audit-2026-08-28-docblock-promises.test.ts`.
 *
 * No external dep — we use crypto.getRandomValues + a URL-safe alphabet so the
 * id round-trips through query strings, JSON, and journald without escaping.
 */
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";

const ID_LEN = 12;

/**
 * Generate a 12-char URL-safe request id. ~71 bits of entropy — well above
 * what we need for correlating a single Telegram update through a few hops.
 */
export function genRequestId(): string {
  const buf = new Uint8Array(ID_LEN);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < ID_LEN; i++) {
    out += ALPHABET[buf[i]! & 63];
  }
  return out;
}
