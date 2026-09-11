/**
 * Mini App auth middleware extracted from lib/miniapp-server.ts (R1).
 *
 * `authOr401` verifies the Telegram initData taken ONLY from the
 * X-Telegram-Init-Data header, and checks the allow-list. Returns either a
 * typed MiniAppUser or a ready-to-send 401/403/503 Response. The 503 is the
 * fail-closed branch for a mutation called without a replay store: no live
 * caller can reach it today (miniapp-server always passes one), and it exists
 * so that a future caller cannot accidentally get an unprotected mutation.
 *
 * Audit 2026-09-11: this header advertised an `initData` query parameter "for
 * SSE" — a channel that no longer exists here and is contradicted twenty lines
 * below by the docblock on `authOr401` itself. SSE authenticates with a
 * one-shot ticket instead; a header that still offers a query channel invites
 * putting a credential back into a URL (logs, Referer, history).
 */
import { verifyInitData, type MiniAppUser } from "./miniapp-auth.ts";
import { json } from "./http-utils.ts";
import { isAllowlisted, warnIfEmptyAllowlist } from "./allowlist.ts";
import { MiniAppSessionStore } from "./miniapp-session.ts";

export interface AuthOpts {
  botToken: string;
  allowedUserIds?: number[];
  mutation?: boolean;
  sessionStore?: MiniAppSessionStore;
}

export type AuthResult =
  | { ok: true; user: MiniAppUser; sessionToken?: string }
  /**
   * `user` заполнен ТОЛЬКО когда подпись сошлась, а отказал аллоу-лист.
   * Вызывающий кладёт его в строку access-лога: отказ проверенному — это
   * известный человек, а не аноним (аудит 2026-08-21). Для 401 поля нет и
   * быть не должно: там id либо отсутствует, либо не проверен.
   */
  | { ok: false; resp: Response; user?: MiniAppUser };

/**
 * initData принимается ТОЛЬКО заголовком.
 *
 * Аудит 2026-08-04: раньше SSE-маршрут включал приём того же credential из
 * `?initData=`, потому что EventSource не умеет заголовки. Цена — суточный
 * ключ ко всем /api/* в query-строке, которую пишет access-лог nginx. Теперь у
 * потока свой вход: одноразовый билет на 30 секунд (lib/sse-ticket.ts),
 * который выдаёт POST /api/sse-ticket — уже по заголовку. Параметра
 * acceptQueryParam больше нет специально: пока он существует, его снова
 * кто-нибудь включит.
 */
export function authOr401(
  req: Request,
  _url: URL,
  opts: AuthOpts,
): AuthResult {
  const raw = req.headers.get("x-telegram-init-data");
  if (!raw) {
    return { ok: false, resp: json({ error: "missing initData" }, 401) };
  }
  const v = verifyInitData(raw, opts.botToken);
  if (!v.ok) {
    return { ok: false, resp: json({ error: `auth: ${v.reason}` }, 401) };
  }
  // SEC-5 / T-603: fail-closed — an empty allow-list denies everyone.
  warnIfEmptyAllowlist("MINIAPP_ALLOWED_USER_IDS", opts.allowedUserIds);
  if (!isAllowlisted(v.user.id, opts.allowedUserIds)) {
    // Отдаём проверенный id наверх — см. комментарий у AuthResult.
    return {
      ok: false,
      resp: json({ error: "user not allowed" }, 403),
      user: v.user,
    };
  }
  if (opts.mutation) {
    // A mutation without a replay store cannot be authenticated safely. Keep
    // this fail-closed even for future callers that bypass miniapp-server.
    if (!opts.sessionStore) {
      return { ok: false, resp: json({ error: "replay protection unavailable" }, 503) };
    }
    const fingerprint = MiniAppSessionStore.fingerprint(raw);
    const sessionToken = MiniAppSessionStore.tokenFromRequest(req, fingerprint);
    if (opts.sessionStore.validate(sessionToken, v.user.id, fingerprint)) {
      return { ok: true, user: v.user };
    }
    const issued = opts.sessionStore.issue(v.user.id, fingerprint);
    if (!issued) {
      return { ok: false, resp: json({ error: "replayed initData" }, 401) };
    }
    return { ok: true, user: v.user, sessionToken: issued };
  }
  return { ok: true, user: v.user };
}
