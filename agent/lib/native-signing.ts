/**
 * Эндпоинты подписи платных действий для нативного приложения:
 *   GET  /api/native/signing/key                         — активный ключ;
 *   POST /api/native/signing/keys {device, spki}         — регистрация, код уходит в Telegram;
 *   POST /api/native/signing/keys/:id/activate {code}    — активация ключа кодом;
 *   GET  /api/native/signing/actions                     — действия, ждущие подписи;
 *   POST /api/native/signing/actions/:nonce/approve {signature}
 *   POST /api/native/signing/actions/:nonce/reject
 *
 * Токен устройства здесь только пропускает к эндпоинтам. Завести ключ без кода
 * из личных сообщений бота нельзя, подтвердить действие без подписи ключом из
 * Secure Enclave — тоже. Спецификация — docs/signed-actions.md.
 */
import { db } from "./db.ts";
import { parseUserIdList } from "./allowlist.ts";
import { readNativeJson } from "./native-request.ts";
import { SignedActionRefusal, SignedActions, type SignedActionError } from "./signed-actions.ts";
import { log } from "./log.ts";

export type SigningCodeSender = (userId: string, text: string) => Promise<void>;
let sender: SigningCodeSender | undefined;
let shared: SignedActions | undefined;

export function configureSigningCodeSender(send: SigningCodeSender) {
  const previous = sender;
  sender = send;
  return () => { sender = previous; };
}

/**
 * Исполнители платных действий: зовутся после успешной подписи, не блокируя
 * ответ телефону. Каждый сам узнаёт свой nonce (чужой пропускает), делает
 * claim и всё дальнейшее; ошибки — только в журнал.
 */
export type SignedActionExecutor = (nonce: string) => Promise<void>;
const executors = new Set<SignedActionExecutor>();

export function registerSignedActionExecutor(run: SignedActionExecutor) {
  executors.add(run);
  return () => { executors.delete(run); };
}

function startExecutors(runs: Iterable<SignedActionExecutor>, nonce: string) {
  for (const run of runs) {
    run(nonce).catch((error) => log.error("[signing] executor failed", { error: String(error) }));
  }
}

export function signedActions(): SignedActions {
  shared ??= new SignedActions(db);
  return shared;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

const STATUS: Record<SignedActionError, number> = {
  key_invalid: 400, payload_invalid: 400, signature_invalid: 400, code_invalid: 400,
  key_unknown: 404, nonce_unknown: 404,
  key_not_pending: 409, code_expired: 409, no_active_key: 409, nonce_used: 409, expired: 409,
  key_revoked: 409, payload_mismatch: 409, price_deviation: 409, price_unchecked: 409, limit_amount: 409, limit_daily: 409,
  code_attempts: 429, registration_limit: 429,
};

/** Имя устройства приходит от клиента: в сообщение идёт только безопасная короткая строка. */
export function deviceLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/[^\p{L}\p{N} ._\-’']/gu, "").trim().slice(0, 40);
  return label || null;
}

export async function signingApi(
  req: Request,
  owner: string,
  authorized: () => boolean,
  deps: { gate?: SignedActions; send?: SigningCodeSender; now?: () => number; execute?: SignedActionExecutor } = {},
): Promise<Response> {
  if (!parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS).includes(Number(owner))) return json({ error: "forbidden" }, 403);
  const gate = deps.gate ?? signedActions();
  const send = deps.send ?? sender;
  const now = deps.now ?? Date.now;
  const path = new URL(req.url).pathname;
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try { body = await readNativeJson(req, 5_000, 4_096); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "json_required") return json({ error: code }, 415);
      if (code === "body_too_large") return json({ error: code }, 413);
      return json({ error: "invalid_body" }, 400);
    }
    // Тело читалось асинхронно: устройство могли отозвать за это время.
    if (!authorized()) return json({ error: "unauthorized" }, 401);
  }
  try {
    if (path === "/api/native/signing/key" && req.method === "GET") {
      const key = gate.activeKey();
      return json({ key: key ? { id: key.id, device: key.device, activated: key.activated } : null });
    }
    if (path === "/api/native/signing/keys" && req.method === "POST") {
      const device = deviceLabel(body.device);
      if (!device || typeof body.spki !== "string") return json({ error: "key_invalid" }, 400);
      if (!send) return json({ error: "signing_unavailable" }, 503);
      const { keyId, code } = await gate.registerKey(device, body.spki, now());
      try {
        await send(owner, `Код привязки ключа подписи для «${device}»: ${code}\nДействует 10 минут. Если вы не добавляли телефон в приложении «Агент», не вводите код и отзовите устройство.`);
      } catch (error) {
        gate.revokeKey(keyId, now());
        log.error("[signing] code delivery failed", { error: String(error) });
        return json({ error: "code_delivery_failed" }, 502);
      }
      return json({ keyId }, 201);
    }
    const activate = path.match(/^\/api\/native\/signing\/keys\/([0-9a-f-]{36})\/activate$/);
    if (activate && req.method === "POST") {
      if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) return json({ error: "code_invalid" }, 400);
      gate.activateKey(activate[1], body.code, now());
      return json({ key: gate.activeKey() });
    }
    if (path === "/api/native/signing/actions" && req.method === "GET") return json({ actions: gate.pending(now()) });
    const decide = path.match(/^\/api\/native\/signing\/actions\/([A-Za-z0-9_-]{43})\/(approve|reject)$/);
    if (decide && req.method === "POST") {
      if (decide[2] === "reject") gate.reject(decide[1], now());
      else {
        if (typeof body.signature !== "string") return json({ error: "signature_invalid" }, 400);
        await gate.approve(decide[1], body.signature, now());
        startExecutors(deps.execute ? [deps.execute] : executors, decide[1]);
      }
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof SignedActionRefusal) return json({ error: error.code }, STATUS[error.code]);
    log.error("[signing] request failed", { error: String(error) });
    return json({ error: "signing_failed" }, 500);
  }
}
