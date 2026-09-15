/** Lifecycle gate. The daemon must verify the v2 HMAC handshake before marking authenticated. */
import type { ParsedMsg } from "./protocol.ts";

/**
 * Что мост вправе прислать до `auth_ok`.
 *
 * `ping` здесь потому, что мост пингует сокет и считает мак мёртвым без `pong`;
 * молчать в ответ на пинг — значит ломать живое соединение ради проверки,
 * которая от пинга ничего не защищает (он ничего не исполняет). `auth_ok` и
 * `auth_fail` — сами кадры рукопожатия.
 *
 * Всё остальное исполняет или останавливает процессы на машине владельца и
 * ждёт своей очереди: `run`, `cancel`, `stop`, а также `bad_run` — ответ на
 * него подтверждает «демон здесь и слушает» тому, кто ещё никто.
 */
const PRE_AUTH_ALLOWED: ReadonlySet<string> = new Set([
  "ping",
  "auth_ok",
  "auth_challenge",
  "auth_fail",
]);

export interface BridgeAuthGate {
  /** Приходил ли `auth_ok` в этом соединении. */
  readonly authenticated: boolean;
  /** Отметить, что мост подтвердил себя. */
  markAuthenticated(): void;
  /** Можно ли исполнять этот кадр в текущем состоянии соединения. */
  accepts(msg: ParsedMsg): boolean;
}

/** Новый гейт для одного соединения. */
export function createAuthGate(): BridgeAuthGate {
  let authed = false;
  return {
    get authenticated(): boolean {
      return authed;
    },
    markAuthenticated(): void {
      authed = true;
    },
    accepts(msg: ParsedMsg): boolean {
      if (msg === null) return false;
      if (authed) return true;
      return PRE_AUTH_ALLOWED.has(msg.type);
    },
  };
}
