/**
 * Аудит 2026-08-28: хвост обработчика Mini App стоял ЗА своим же catch.
 *
 * После `catch (e: any)` в `miniapp-server.ts` шли ещё четыре шага: сжатие с
 * ETag, CORS, выдача cookie сессии и строка access-лога. Ни один из них не был
 * защищён, а опции `error` у `Bun.serve` в этом сервере нет — значит бросок
 * там уходил прямо в рантайм. Цена: уже готовый и корректный ответ (тело
 * посчитано, gzip наложен, заголовки проставлены) заменялся голым 500, а
 * строка лога — она печаталась ПОСЛЕ — не писалась вовсе, то есть в логах на
 * месте запроса оставалась дырка.
 *
 * Конкретный бросающий вызов — `sessionStore.cookie(token)`: он по контракту
 * кидает на неизвестный токен, а TTL сессии всего пять минут и `prune()`
 * зовётся из `issue()`/`validate()` ЛЮБОГО параллельного запроса. Обработчик,
 * выдавший сессию и ушедший в инструмент, вполне переживает свою запись.
 *
 * Заодно: единственное место в файле, где telegram user_id уезжал в лог
 * целиком (лимит SSE-соединений на пользователя).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_tail_0828";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { MiniAppSessionStore } from "../lib/miniapp-session.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { cleanupChat } from "./_helpers.ts";

const BOT_TOKEN = "test_bot_token_tail_0828";
const USER_ID = 828_001;
const E2E_CHAT = -1_000_828;

const SRC = readFileSync(
  new URL("../lib/miniapp-server.ts", import.meta.url),
  "utf8",
);

describe("MiniAppSessionStore.cookieFor", () => {
  test("неизвестный токен → null, а не исключение", () => {
    const store = new MiniAppSessionStore();
    expect(store.cookieFor("нет такого токена")).toBeNull();
    // Строгий контракт самого cookie() остаётся: это инвариант для тех, кто
    // зовёт его там, где исключение ловится.
    expect(() => store.cookie("нет такого токена")).toThrow();
  });

  test("живая сессия → та же строка, что у cookie()", () => {
    const store = new MiniAppSessionStore();
    const fp = MiniAppSessionStore.fingerprint("query_id=a&hash=aa");
    const token = store.issue(USER_ID, fp);
    expect(token).toBeString();
    expect(store.cookieFor(token!)).toBe(store.cookie(token!));
  });

  test("сессия, вычищенная по TTL параллельным запросом → null", () => {
    // Ровно тот сценарий, из-за которого хвост и падал: пока обработчик держал
    // ответ, соседний запрос позвал issue(), тот — prune(), и записи не стало.
    let now = 1_000_000;
    const store = new MiniAppSessionStore({ now: () => now, ttlMs: 1000 });
    const token = store.issue(
      USER_ID,
      MiniAppSessionStore.fingerprint("query_id=a&hash=aa"),
    );
    expect(token).toBeString();
    now += 5000;
    // Параллельный запрос: его issue() тянет за собой prune().
    store.issue(USER_ID, MiniAppSessionStore.fingerprint("query_id=b&hash=bb"));
    expect(store.cookieFor(token!)).toBeNull();
    expect(() => store.cookie(token!)).toThrow();
  });
});

describe("хвост обработчика защищён", () => {
  test("пост-обработка — первый оператор внутри try", () => {
    // Проверка текстовая, потому что защищает именно РАСПОЛОЖЕНИЕ: вынести
    // строку из try обратно не сломает ни одного функционального теста.
    expect(SRC).toMatch(
      /try \{\n\s*const compressed = await applyCompressionAndEtag\(req, resp\);/,
    );
    expect(SRC).toContain('log.error("[miniapp] post-processing error"');
  });

  test("cookie выдаётся не-бросающим вариантом", () => {
    expect(SRC).toContain("sessionStore.cookieFor(");
    expect(SRC).not.toContain("sessionStore.cookie(");
  });

  test("user_id в логе лимита SSE редактируется", () => {
    expect(SRC).toContain("redactUserId(sseUserId)");
    expect(SRC).not.toMatch(/userId: sseUserId,/);
  });
});

describe("сквозная проверка: cookie по-прежнему выдаётся", () => {
  let server: MiniappServerHandle;
  let base: string;

  beforeAll(() => {
    server = startMiniappServer({
      port: 0,
      allowedUserIds: [USER_ID],
      adminUserIds: [USER_ID],
      botToken: BOT_TOKEN,
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop();
    cleanupChat(E2E_CHAT);
  });

  test("успешный запрос отдаёт set-cookie с __Host-префиксом", async () => {
    const initData = buildInitData(BOT_TOKEN, {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "qtail0828",
      user: JSON.stringify({ id: USER_ID, username: "t", first_name: "T" }),
    });
    // Сессия выдаётся только на мутации (auth-middleware.ts: opts.mutation),
    // поэтому проверяем на POST.
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "хвост ответа", chat_id: E2E_CHAT }),
    });
    expect(res.status).toBe(201);
    await res.text();
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-miniapp_session_");
    expect(cookie).toContain("; HttpOnly");
  });
});
