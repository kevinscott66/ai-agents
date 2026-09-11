/**
 * Telegram Mini App initData HMAC verification (C13a).
 *
 * Реализует стандартный алгоритм Telegram WebApp:
 *  1. Парсим initData как URLSearchParams; извлекаем `hash`,
 *     остальные пары сортируем по ключу и склеиваем `key=value\n...`.
 *  2. secret_key = HMAC_SHA256(key="WebAppData", msg=botToken).
 *  3. computed   = HMAC_SHA256(key=secret_key,  msg=data-check-string).hex().
 *  4. Canonical-hex проверка hash, затем constant-time сравнение.
 *  5. auth_date не старше maxAgeSec.
 *  6. Парсим JSON-поле user.
 *
 * См. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface MiniAppUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export type VerifyResult =
  | { ok: true; user: MiniAppUser; authDate: number }
  | { ok: false; reason: string };

/** Allow small clock skew, but never accept a credential from far in the future. */
export const INIT_DATA_MAX_FUTURE_SKEW_SEC = 5 * 60;

export function verifyInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSec = 86400,
): VerifyResult {
  if (!initDataRaw) return { ok: false, reason: "empty initData" };
  if (!botToken) return { ok: false, reason: "missing bot token" };

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  // Telegram отдаёт hash строчным hex, но Buffer.from(…, "hex") регистр
  // игнорирует — без этой проверки одна и та же подпись принимается в 2^31
  // написаниях. Само по себе это не обход подписи, но всё, что метит initData
  // по строке hash, обходится сменой регистра: каждое написание даёт новый
  // ключ. Канонизируем на входе.
  //
  // Аудит 2026-09-11: здесь стояло «одноразовость мутаций». Такого свойства
  // система не даёт и не пытается: метку ставит `MiniAppSessionStore`, и живёт
  // она `MINIAPP_SESSION_TTL_MS` (5 минут), а подпись годна `maxAgeSec`
  // (сутки). То есть одна и та же строка initData принимается снова каждые
  // пять минут в течение суток — это пинит тест `miniapp-auth-replay`, и
  // иначе нельзя: Telegram выдаёт initData один раз на запуск Mini App и не
  // обновляет её, а клиенту она нужна на каждый POST /api/sse-ticket, то есть
  // на каждое переподключение SSE за всё время жизни вкладки. Канонизация
  // закрывает размножение ключей метки, а не повтор запроса.
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "bad hash" };
  params.delete("hash");

  const pairs: [string, string][] = [];
  for (const [k, v] of params.entries()) pairs.push([k, v]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad hash" };
  }

  const authDateStr = params.get("auth_date");
  if (!authDateStr) return { ok: false, reason: "missing auth_date" };
  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate)) {
    return { ok: false, reason: "bad auth_date" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > maxAgeSec) {
    return { ok: false, reason: "stale auth_date" };
  }
  if (authDate - nowSec > INIT_DATA_MAX_FUTURE_SKEW_SEC) {
    return { ok: false, reason: "future auth_date" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing user" };
  let user: MiniAppUser;
  try {
    user = JSON.parse(userRaw) as MiniAppUser;
  } catch {
    return { ok: false, reason: "bad user JSON" };
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    return { ok: false, reason: "bad user shape" };
  }

  return { ok: true, user, authDate };
}

/**
 * Токен, которым проверяется подпись initData. Fallback — токен оркестратора:
 * Mini App открывается его кнопкой, значит и hash считан его токеном.
 *
 * Раньше здесь стояло `TG_TOKEN_ORCHESTRATOR` — переменная, которой в проекте
 * нет: имя токена оркестратора задаёт `envToken` в characters/index.ts, и это
 * `TELEGRAM_BOT_TOKEN`. Fallback был мёртв, а текст ошибки советовал задать
 * фантом, то есть чинить конфиг способом, который ломает auth тише: initData
 * начал бы проверяться посторонним токеном, и вместо внятного «нет токена» все
 * пользователи получили бы «bad hash».
 *
 * Имя оставлено литералом намеренно — тянуть в auth-модуль системные промпты
 * ради одной строки не стоит. Связь держит tests/env-example-tokens.test.ts:
 * он сверяет и это сообщение, и `.env.example` с `CHARACTERS`.
 */
const ORCHESTRATOR_TOKEN_ENV = ["TELEGRAM", "BOT", "TOKEN"].join("_");

export function getBotTokenForAuth(): string {
  // `??`, а не `||`, воскрешал бы ровно ту беду, что описана выше: пустая
  // строка не nullish, поэтому `MINIAPP_BOT_TOKEN=` (обычный способ «выключить»
  // переменную в .env) убивал fallback, и сервер отказывался стартовать, называя
  // переменную, которая задана. `.trim()` — про тот же тихий отказ с другого
  // конца: значение из dotenv приезжает с хвостовым переводом строки, уходит в
  // HMAC как есть, и «bad hash» получают все пользователи разом.
  const t =
    process.env.MINIAPP_BOT_TOKEN?.trim() ||
    process.env[ORCHESTRATOR_TOKEN_ENV]?.trim();
  if (!t) {
    throw new Error(
      `miniapp: no bot token (set MINIAPP_BOT_TOKEN or ${ORCHESTRATOR_TOKEN_ENV})`,
    );
  }
  return t;
}

/**
 * Хелпер для тестов / интеграций: построить валидный initData по boт-токену
 * и payload-полям (auth_date, user, query_id, ...). hash считается тем же
 * алгоритмом, что и verifyInitData.
 */
export function buildInitData(
  botToken: string,
  fields: Record<string, string>,
): string {
  // `hash` среди полей — footgun. Он попал бы в data-check-string, а потом был
  // бы затёрт вычисленным ниже; verifyInitData удаляет hash ДО подсчёта, так
  // что подпись не сошлась бы никогда, и тест падал бы с «bad hash», указывая
  // не туда. Своё написание hash подставляют, переписывая готовую строку.
  if ("hash" in fields) {
    throw new Error("buildInitData: hash задаётся вычислением, а не полем");
  }
  const pairs = Object.entries(fields).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) sp.set(k, v);
  sp.set("hash", hash);
  return sp.toString();
}
