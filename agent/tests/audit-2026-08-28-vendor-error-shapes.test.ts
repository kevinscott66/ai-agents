/**
 * Аудит 2026-08-28: разбор вендорской ошибки знал две формы из многих.
 *
 * `vendorErrorDetail` читает тело один раз и достаёт из него пояснение. Разбор
 * был такой: `typeof e === "string" ? e : e?.message ?? ""`. То есть на любой
 * форме, кроме строки и объекта с `.message`, функция возвращала ПУСТУЮ строку —
 * и притом затирала уже прочитанное тело, единственный оставшийся источник.
 *
 * Пояснение исчезало ровно тогда, когда оно нужнее всего: по коду статуса
 * причину не отличить, и оператору доставалось голое «OpenAI image API error
 * 429». Обе точки вызова — `lib/openai-image.ts:83` и
 * `lib/openai-whisper.ts:81`.
 */
import { describe, expect, test } from "bun:test";
import { vendorErrorDetail } from "../lib/errors.ts";

function body(o: unknown, status = 400): Response {
  return new Response(JSON.stringify(o), { status });
}

describe("формы, на которых пояснение терялось", () => {
  test("`error` — флаг, пояснение рядом", async () => {
    expect(await vendorErrorDetail(body({ error: true, message: "quota exceeded" }))).toBe(
      "quota exceeded",
    );
  });

  test("`error` — число, пояснение в `description` (форма Telegram Bot API)", async () => {
    expect(
      await vendorErrorDetail(body({ error: 429, description: "Too Many Requests" }, 429)),
    ).toBe("Too Many Requests");
  });

  test("`error` — массив, пояснение рядом", async () => {
    expect(await vendorErrorDetail(body({ error: ["a", "b"], message: "bad input" }))).toBe(
      "bad input",
    );
  });

  test("`error` — объект с одним кодом: код и есть пояснение", async () => {
    expect(await vendorErrorDetail(body({ error: { code: "rate_limit_exceeded" }, }, 429))).toBe(
      "rate_limit_exceeded",
    );
  });

  test("`detail` без ключа `error` (форма FastAPI-прокси)", async () => {
    expect(await vendorErrorDetail(body({ detail: "invalid model" }))).toBe("invalid model");
  });

  test("`error_description` без ключа `error` (форма OAuth-шлюза)", async () => {
    expect(await vendorErrorDetail(body({ error_description: "token expired" }, 401))).toBe(
      "token expired",
    );
  });
});

describe("порядок носителей", () => {
  test("`message` внутри `error` важнее соседнего", async () => {
    expect(
      await vendorErrorDetail(body({ error: { message: "внутри" }, message: "снаружи" })),
    ).toBe("внутри");
  });

  test("`message` важнее `code` в том же объекте", async () => {
    expect(
      await vendorErrorDetail(body({ error: { code: "x", message: "человеческое" } })),
    ).toBe("человеческое");
  });

  test("пустая строка не считается пояснением — берётся следующий носитель", async () => {
    expect(await vendorErrorDetail(body({ error: { message: "   ", code: "empty_msg" } }))).toBe(
      "empty_msg",
    );
  });
});

describe("что осталось как было", () => {
  test("строковый `error`", async () => {
    expect(await vendorErrorDetail(body({ error: "invalid_api_key" }, 401))).toBe(
      "invalid_api_key",
    );
  });

  test("объект `error` с `message`", async () => {
    expect(await vendorErrorDetail(body({ error: { message: "You exceeded your quota" } }))).toBe(
      "You exceeded your quota",
    );
  });

  test("не-JSON тело отдаётся целиком", async () => {
    const res = new Response("<html>502 от шлюза</html>", { status: 502 });
    expect(await vendorErrorDetail(res)).toBe("<html>502 от шлюза</html>");
  });

  test("структурный ответ без единого носителя — пусто, а не сырой JSON", async () => {
    expect(await vendorErrorDetail(body({ error: { retryable: true, status: 429 } }))).toBe("");
    expect(await vendorErrorDetail(body({ error: {} }))).toBe("");
    expect(await vendorErrorDetail(body({ error: null }))).toBe("");
  });

  test("JSON незнакомой формы — тело как есть", async () => {
    expect(await vendorErrorDetail(body({ nope: "nope" }))).toBe('{"nope":"nope"}');
    expect(await vendorErrorDetail(body(["a", "b"]))).toBe('["a","b"]');
  });

  test("пустое тело — пустая строка", async () => {
    expect(await vendorErrorDetail(new Response("", { status: 500 }))).toBe("");
  });

  test("пояснение всё ещё проходит через скраббер и схлопывание строк", async () => {
    const res = body({ error: { message: "строка\nвторая\nтретья" } });
    expect(await vendorErrorDetail(res)).toBe("строка вторая третья");
  });

  test("пояснение всё ещё режется по потолку", async () => {
    const res = body({ error: { message: "x".repeat(500) } });
    expect(await vendorErrorDetail(res, 20)).toBe("x".repeat(19) + "…");
  });
});
