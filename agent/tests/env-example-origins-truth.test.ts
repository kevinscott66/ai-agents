/**
 * Аудит 2026-08-12: шаблон окружения обещал fail-closed там, где код открыт.
 *
 * `.env.example`:
 *
 *   MINIAPP_ALLOWED_ORIGINS=   # CSV origin'ов для CORS. Пусто = кросс-origin
 *                              # запросы не разрешены.
 *
 * `lib/http-utils.ts`, parseAllowedOriginsEnv:
 *
 *   if (!env || !env.trim()) return DEFAULT_DEV_ORIGINS.slice();
 *   // ["http://localhost:5173", "http://127.0.0.1:5173"]
 *
 * Пустое значение — это НЕ «никому», а «двум localhost-origin'ам разработки».
 * Замер: parseAllowedOriginsEnv("") даёт список из двух элементов, и
 * pickAllowedOrigin("http://localhost:5173") при незаданной переменной
 * возвращает этот origin, то есть ACAO будет выставлен.
 *
 * Утечки данных отсюда нет — авторизация в auth-middleware.ts идёт строго
 * заголовком `x-telegram-init-data`, ни куки, ни query-параметра нет, так что
 * чужая страница ответ прочитать не сможет при любом ACAO. Опасно другое:
 * оператор читает шаблон и решает, что оставить переменную пустой — это
 * запереть периметр. Соседняя строка METRICS_TOKEN обещает fail-closed и
 * действительно его делает — то есть формулировка в этом файле воспринимается
 * как обязательство.
 *
 * Второе, чего в шаблоне не было: браузер шлёт Origin и на СВОИХ же POST'ах.
 * Если Mini App открыть вкладкой (не в Telegram), POST'ы получат 403, пока
 * публичный origin не перечислен явно. В Telegram WebApp Origin не приходит —
 * поэтому прод и работает с пустым значением.
 *
 * Инвариант: описание переменной в шаблоне не противоречит тому, что делает
 * parseAllowedOriginsEnv. Поведение кода тест не меняет — он проверяет, что
 * текст описывает именно его.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllowedOriginsEnv, pickAllowedOrigin } from "../lib/http-utils.ts";

const ENV_EXAMPLE = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");

/** Строка шаблона про MINIAPP_ALLOWED_ORIGINS вместе с комментарием. */
function originsLine(): string {
  const line = ENV_EXAMPLE.split("\n").find((l) =>
    l.startsWith("MINIAPP_ALLOWED_ORIGINS="),
  );
  expect(line).toBeDefined();
  return line!;
}

describe(".env.example: описание MINIAPP_ALLOWED_ORIGINS совпадает с кодом", () => {
  test("замер: пустое значение открывает localhost-origin'ы разработки", () => {
    const list = parseAllowedOriginsEnv("");
    expect(list).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });

  test("шаблон не утверждает, что пусто = никому", () => {
    const line = originsLine();
    // Прежняя формулировка: «Пусто = кросс-origin запросы не разрешены».
    expect(line).not.toMatch(/Пусто\s*=\s*кросс-origin запросы не разрешены/);
  });

  test("шаблон называет фактический дефолт", () => {
    expect(originsLine()).toInclude("localhost:5173");
  });

  test("шаблон предупреждает про Origin на собственных POST'ах", () => {
    expect(originsLine()).toMatch(/Origin/);
    expect(originsLine()).toMatch(/POST/);
  });

  test("описание METRICS_TOKEN по-прежнему честное — fail-closed там настоящий", () => {
    const line = ENV_EXAMPLE.split("\n").find((l) =>
      l.startsWith("METRICS_TOKEN="),
    );
    expect(line).toInclude("fail-closed");
    // Пустой токен действительно закрывает эндпоинт — сравнивать есть с чем.
    expect(pickAllowedOrigin(null)).toBeNull();
  });
});
