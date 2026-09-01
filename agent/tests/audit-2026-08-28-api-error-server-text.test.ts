/**
 * Аудит 2026-08-28: панель выбрасывала текст, которым сервер объяснял отказ.
 *
 * `formatApiError` разбирает только 401/403/404/429 и `>= 500`. Всё
 * остальное — «Не удалось загрузить панель. Повторите попытку.» Для мутаций
 * это не просто бесполезно, а неверно: панель загрузилась, отказала запись.
 *
 * А отказывает она с внятным текстом. `POST /api/permissions` отвечает 409
 * «строка не подействует: …» (lib/miniapp-server.ts:1686), создание задачи и
 * переход по FSM — 400 с сообщением исключения (:1319, :1352), пермишены и
 * бюджеты — 400 «bad body: …». Всё это `apiRequest` уже кладёт в `err.body`,
 * и никто не читал.
 *
 * Отдельно `POST /api/mac/stop`: 503 с телом `mac_offline` (:971) попадал под
 * ветку `>= 500` и превращался в «Сервер панели временно недоступен» — сервер
 * панели при этом жив, не на связи Mac.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apiRequest, formatApiError } from "../miniapp/src/lib/api.ts";

const SERVER_SRC = readFileSync(new URL("../lib/miniapp-server.ts", import.meta.url), "utf8");

describe("предпосылки: сервер отвечает текстом, клиент его получает", () => {
  test("409 и 503 с телом действительно существуют", () => {
    expect(SERVER_SRC).toContain('return json({ error: `строка не подействует: ${ineffective}` }, 409);');
    expect(SERVER_SRC).toContain('return json({ ok: false, error: result.error }, 503);');
  });

  test("apiRequest кладёт тело отказа в err.body", async () => {
    const prev = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "bad body: chat_id must be an integer" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      let caught: any = null;
      try {
        await apiRequest("/api/tasks", { method: "POST", body: "{}" });
      } catch (e) {
        caught = e;
      }
      expect(caught?.status).toBe(400);
      expect(caught?.body?.error).toBe("bad body: chat_id must be an integer");
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe("текст сервера доходит до человека", () => {
  test("409 показывает, чем именно правило не подействует", () => {
    const err = {
      status: 409,
      body: { error: "строка не подействует: SEND_PHOTO не выдан роли 'qa'" },
    };
    expect(formatApiError(err)).toBe("строка не подействует: SEND_PHOTO не выдан роли 'qa'");
  });

  test("400 показывает, что именно не так с телом", () => {
    const err = { status: 400, body: { error: "bad body: inherit requires agent" } };
    expect(formatApiError(err)).toBe("bad body: inherit requires agent");
  });

  test("502 от моста тоже не прячется", () => {
    const err = { status: 502, body: { ok: false, error: "bridge timeout" } };
    expect(formatApiError(err)).toBe("bridge timeout");
  });

  test("длинный текст обрезается, а не уезжает в тост целиком", () => {
    const err = { status: 400, body: { error: "ы".repeat(500) } };
    const out = formatApiError(err);
    // Метка входит в бюджет — общее правило Mini App, lib/text.ts.
    expect(out.length).toBe(300);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("машинные коды переводятся, а не показываются как есть", () => {
  test("mac_offline говорит про Mac, а не про сервер панели", () => {
    const out = formatApiError({ status: 503, body: { ok: false, error: "mac_offline" } });
    expect(out).toContain("Mac");
    expect(out).not.toContain("mac_offline");
    expect(out).not.toContain("Сервер панели");
  });
});

describe("прежние ветки не тронуты", () => {
  test("401/403/404/429 держат свой текст даже с телом", () => {
    const body = { error: "forbidden" };
    expect(formatApiError({ status: 401, body })).toContain("Telegram");
    expect(formatApiError({ status: 403, body })).toContain("доступа");
    expect(formatApiError({ status: 404, body })).toContain("Маршрут");
    expect(formatApiError({ status: 429, body })).toContain("Слишком много");
  });

  test("5xx без тела — прежняя общая строка", () => {
    expect(formatApiError({ status: 503 })).toContain("Сервер панели");
    expect(formatApiError({ status: 500, body: "<html>502 Bad Gateway</html>" })).toContain(
      "Сервер панели",
    );
  });

  test("400 без error в теле — прежняя общая строка", () => {
    expect(formatApiError({ status: 400 })).toContain("Не удалось загрузить панель");
    expect(formatApiError({ status: 400, body: { ok: false } })).toContain(
      "Не удалось загрузить панель",
    );
    expect(formatApiError({ status: 400, body: { error: "   " } })).toContain(
      "Не удалось загрузить панель",
    );
  });

  test("таймаут по-прежнему главнее тела", () => {
    const err: any = new Error("Сервер не ответил за 20 с");
    err.timeout = true;
    err.status = 400;
    err.body = { error: "bad body" };
    expect(formatApiError(err)).toBe("Сервер не ответил за 20 с");
  });

  test("сетевая ошибка без статуса — прежняя строка", () => {
    expect(formatApiError(new Error("Failed to fetch"))).toContain("DNS");
  });
});
