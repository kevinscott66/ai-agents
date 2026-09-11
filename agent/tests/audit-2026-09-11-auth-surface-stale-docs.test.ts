/**
 * Аудит 2026-09-11: четыре объяснения на auth-поверхности Mini App пережили
 * код, который объясняли, плюс один ответ уходил без заголовков безопасности.
 *
 * Класс тот же, что у прошлых раундов: комментарий в настоящем времени
 * утверждает устройство, которого в проекте уже нет. Разбирающий инцидент
 * читает его как карту и ищет не там.
 *
 *   1. `cookieFor` (lib/miniapp-session.ts) обещал «единственный боевой вызов
 *      `cookie()`» и бросок «прямо в Bun.serve». Прямых вызовов `cookie()`
 *      сегодня нет ни одного (это отдельно запинено в
 *      audit-2026-08-28-miniapp-response-tail), а хвост пост-обработки обёрнут
 *      собственным try/catch.
 *   2. Шапка lib/auth-middleware.ts обещала «401/403», а `authOr401` умеет
 *      ещё и 503 — fail-closed для мутации без стора антиреплея.
 *   3. Комментарий у `SENSITIVE_KEY` (lib/log.ts) объяснял слово `initdata`
 *      тем, что SSE передаёт initData в query. Не передаёт с 2026-08-04:
 *      у потока одноразовый билет. Само слово в списке остаётся — оно стережёт
 *      ВОЗВРАТ канала, и это теперь так и написано.
 *   4. Обоснование рейт-лимита у `/api/events` считало стоимостью захода HMAC
 *      по initData. HMAC переехал на выдачу билета; заход гасит билет.
 *
 * И одна правка поведения: `catch` хвоста пост-обработки — единственный ответ
 * сервера мимо `applyCorsToResponse`, то есть без CSP, nosniff и HSTS. Ветка
 * редкая (бросок внутри самого хвоста), тело — константа, утечки нет; но
 * заголовки ставятся теперь и здесь.
 *
 * Чего эти проверки НЕ покрывают: живого запроса, доходящего до `catch`
 * пост-обработки, тут нет — туда попадают только броском внутри gzip/ETag.
 * Форма ветки проверяется по исходнику, а поведение `json` с этими
 * заголовками — напрямую.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_stale_docs";

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authOr401 } from "../lib/auth-middleware.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { json, SECURITY_HEADERS } from "../lib/http-utils.ts";
import { scrubSecretString } from "../lib/log.ts";

const BOT_TOKEN = "test_bot_token_stale_docs";
const UID = 44009011;

const src = (...parts: string[]) =>
  readFileSync(join(import.meta.dir, "..", ...parts), "utf8");

const initData = () =>
  buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "qstale",
    user: JSON.stringify({
      id: UID,
      username: `u${UID}`,
      first_name: "T",
      is_bot: false,
    }),
  });

describe("мутация без стора антиреплея: 503, и шапка об этом говорит", () => {
  test("ветка отвечает 503, а не пропускает мутацию", async () => {
    const req = new Request("http://x/api/tasks", {
      method: "POST",
      headers: { "x-telegram-init-data": initData() },
    });
    const r = authOr401(req, new URL(req.url), {
      botToken: BOT_TOKEN,
      allowedUserIds: [UID],
      mutation: true,
      // sessionStore не передан намеренно — это и есть проверяемый случай.
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("ожидался отказ");
    expect(r.resp.status).toBe(503);
  });

  test("шапка файла называет все коды, которые модуль отдаёт", () => {
    const SRC = src("lib", "auth-middleware.ts");
    const head = SRC.slice(0, SRC.indexOf("export type AuthOpts"));
    expect(head).toContain("503");
    expect(head).not.toMatch(/ready-to-send 401\/403 Response/);
  });
});

describe("cookieFor: объяснение не обещает того, чего в коде нет", () => {
  const SESSION = src("lib", "miniapp-session.ts");
  const SERVER = src("lib", "miniapp-server.ts");

  test("докблок не утверждает живой прямой вызов cookie()", () => {
    const doc = SESSION.slice(
      SESSION.indexOf("Не-бросающий вариант"),
      SESSION.indexOf("cookieFor(token: string)"),
    );
    expect(doc.length).toBeGreaterThan(200);
    expect(doc).not.toContain("единственный боевой вызов `cookie()` стоит");
    // Опорный факт: прямых вызовов cookie() в сервере нет.
    expect(SERVER).not.toContain("sessionStore.cookie(");
    expect(SERVER).toContain("sessionStore.cookieFor(");
  });

  test("хвост пост-обработки ловит свой бросок сам", () => {
    // Это и есть причина, по которой прежняя формулировка устарела.
    expect(SERVER).toContain('log.error("[miniapp] post-processing error"');
  });
});

describe("scrubber: слово initdata остаётся, объяснение — про возврат канала", () => {
  test("URL с initData по-прежнему чистится", () => {
    const dirty = "https://x/api/events?initData=user%3D1%26hash%3Ddeadbeef";
    expect(scrubSecretString(dirty)).not.toContain("deadbeef");
  });

  test("комментарий не утверждает, что SSE шлёт initData в query сегодня", () => {
    const LOG = src("lib", "log.ts");
    const at = LOG.indexOf("// initdata:");
    expect(at).toBeGreaterThan(-1);
    const note = LOG.slice(at, at + 700);
    expect(note).toContain("initdata");
    expect(note).not.toContain("SSE-подключение Mini App передаёт initData в query");
    expect(note).toContain("sse-ticket.ts");
  });
});

describe("рейт-лимит SSE: стоимость захода названа верно", () => {
  const SERVER = src("lib", "miniapp-server.ts");

  test("вход в поток — билет, а не HMAC", () => {
    expect(SERVER).toContain('redeemSseTicket(url.searchParams.get("ticket"))');
    const at = SERVER.indexOf("Потолок соединений ограничивает ОДНОВРЕМЕННОСТЬ");
    expect(at).toBeGreaterThan(-1);
    // Комментарий перенесён по строкам, поэтому сначала склеиваем его обратно
    // в одну: иначе проверка ищет строку, которой в исходнике не бывает никогда.
    const note = SERVER.slice(at, at + 700)
      .replace(/\n\s*\/\/ ?/g, " ")
      .replace(/\s+/g, " ");
    expect(note).toContain("Потолок соединений");
    expect(note).not.toContain("заход считает HMAC");
    expect(note).toContain("гасит билет");
  });
});

describe("отказ пост-обработки уходит с заголовками безопасности", () => {
  test("ветка catch отдаёт их явно", () => {
    const SERVER = src("lib", "miniapp-server.ts");
    expect(SERVER).toContain(
      'return json({ error: "internal error" }, 500, SECURITY_HEADERS);',
    );
  });

  test("этого набора действительно хватает: nosniff и CSP на месте", () => {
    const r = json({ error: "internal error" }, 500, SECURITY_HEADERS);
    expect(r.status).toBe(500);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors");
    // ACAO на отказе не нужен и не ставится.
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});
