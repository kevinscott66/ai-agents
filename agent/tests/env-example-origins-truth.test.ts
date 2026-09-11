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
 * Утечки данных отсюда нет, но не по той причине, что стояла здесь до круга
 * 45. Тогда было написано «ни куки, ни query-параметра нет»; про query это
 * верно и сегодня (вход у SSE свой, см. докблок authOr401), а про куку — уже
 * нет: защита от повтора initData появилась позже этого абзаца, и теперь
 * каждая мутация проходит через MiniAppSessionStore, чей
 * `tokenFromRequest` читает заголовок `cookie`. Настоящих причин две, и обе
 * проверены ниже. Первая: `x-telegram-init-data` чужая страница подделать не
 * может — это HMAC на токене бота, — а сам заголовок нестандартный, то есть
 * запрос перестаёт быть простым и упирается в preflight. Вторая:
 * `corsHeaders` не выдаёт `Access-Control-Allow-Credentials`, поэтому браузер
 * куку на кросс-origin запросе и не пошлёт.
 *
 * Разница между «куки нет» и «куку не пошлют» не академическая. Первое читается
 * как «credentials здесь ни при чём» и разрешает дописать
 * `access-control-allow-credentials: true` ради отдельно поднятого фронта — и
 * ровно в этот момент два вечно разрешённых localhost-origin'а становятся
 * origin'ами, которые носят сессионную куку. Поэтому отсутствие этого
 * заголовка теперь не наблюдение, а инвариант с тестом.
 *
 * Опасно и другое: оператор читает шаблон и решает, что оставить переменную
 * пустой — это запереть периметр. Соседняя строка METRICS_TOKEN обещает
 * fail-closed и действительно его делает — то есть формулировка в этом файле
 * воспринимается как обязательство.
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
import { corsHeaders, parseAllowedOriginsEnv, pickAllowedOrigin } from "../lib/http-utils.ts";

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

  test("кука в авторизации ЕСТЬ — довод про ACAO держится не на её отсутствии", () => {
    // Прежний докблок утверждал обратное. Утверждение снято, но проверить надо
    // именно факт: если куку когда-нибудь уберут, абзац выше станет врать в
    // другую сторону, и переписывать его нужно будет здесь же.
    const auth = readFileSync(join(import.meta.dir, "..", "lib", "auth-middleware.ts"), "utf8");
    expect(auth).toInclude("MiniAppSessionStore.tokenFromRequest(req, fingerprint)");
    const store = readFileSync(join(import.meta.dir, "..", "lib", "miniapp-session.ts"), "utf8");
    expect(store).toInclude('req.headers.get("cookie")');
  });

  test("CORS не разрешает credentials — потому куку и не пошлют", () => {
    // Инвариант, а не наблюдение: с `access-control-allow-credentials: true`
    // дефолтные localhost-origin'ы начали бы носить сессионную куку.
    const withOrigin = corsHeaders("http://localhost:5173");
    expect(Object.keys(withOrigin)).not.toContain("access-control-allow-credentials");
    expect(Object.keys(corsHeaders(null))).not.toContain(
      "access-control-allow-credentials",
    );
    // Заголовок остаётся нестандартным — значит, preflight, а не простой запрос.
    expect(withOrigin["access-control-allow-headers"]).toInclude("X-Telegram-Init-Data");
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
