/**
 * Аудит 2026-08-29: аварийный стоп исчезал ровно тогда, когда был нужен, а
 * 5xx показывался машинной английской строкой.
 *
 * 1. `Mac.tsx` начинался с двух ранних возвратов — `if (loading)` и
 *    `if (error)`. Оба стояли ВЫШЕ блока с кнопкой `POST /api/mac/stop`,
 *    единственной точкой входа в аварийный стоп во всей панели. Значит любой
 *    отказ ЧТЕНИЯ истории (`GET /api/actions`) отбирал право на ЗАПИСЬ, хотя
 *    ручки друг от друга не зависят. `handleStopAll` этот урок уже усвоил и
 *    пишет свои отказы в тост — с комментарием, объясняющим почему.
 *
 * 2. `formatApiError` проверял `status >= 400` перед `status >= 500`, а
 *    сервер на необработанном исключении отвечает `{"error":"internal
 *    error"}` (`lib/miniapp-server.ts`). Строка непустая, поэтому первая
 *    ветка забирала управление, и пользователь видел `internal error` вместо
 *    русского «Сервер панели временно недоступен. Повторите попытку позже.»
 *
 * Тесты ниже — на чистых функциях и на исходнике страницы: JSX здесь не
 * рендерится (в наборе агента нет DOM), поэтому вторая часть — source-guard.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatApiError } from "../miniapp/src/lib/api.ts";

const MAC_SRC = readFileSync(new URL("../miniapp/src/pages/Mac.tsx", import.meta.url), "utf-8");

/** Строки без комментариев: докблок этого файла и самой страницы цитирует то, что запрещает. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

const MAC_CODE = codeLines(MAC_SRC);
const macHas = (needle: string) => MAC_CODE.some((l) => l.includes(needle));

describe("formatApiError: 5xx", () => {
  test("JSON-500 от сервера даёт русскую строку про временную недоступность", () => {
    const out = formatApiError({ status: 500, body: { error: "internal error" } });
    expect(out).toBe("Сервер панели временно недоступен. Повторите попытку позже.");
  });

  test("осмысленный текст моста на 502/503 проходит нетронутым", () => {
    // Ровно то, ради чего правка точечная: `result.error` от моста
    // (miniapp-server.ts, ветки 502/503) — это диагноз, а не шум.
    expect(formatApiError({ status: 502, body: { ok: false, error: "bridge timeout" } })).toBe(
      "bridge timeout",
    );
    expect(formatApiError({ status: 503, body: { ok: false, error: "mac_stopped" } })).toBe(
      "mac_stopped",
    );
  });

  test("непрозрачная константа глушится на любом статусе, а не только на 500", () => {
    for (const status of [500, 502, 503]) {
      expect(formatApiError({ status, body: { error: "internal error" } })).toBe(
        "Сервер панели временно недоступен. Повторите попытку позже.",
      );
    }
  });

  test("mac_offline остаётся собственной строкой, а не общей про панель", () => {
    // Приходит с 503, и «панель недоступна» для него прямо неверна: панель
    // жива, оффлайн мост.
    const out = formatApiError({ status: 503, body: { error: "mac_offline" } });
    expect(out).not.toBe("Сервер панели временно недоступен. Повторите попытку позже.");
    expect(out).toContain("Mac");
  });

  test("4xx по-прежнему показывает текст сервера дословно", () => {
    expect(formatApiError({ status: 409, body: { error: "строка не подействует" } })).toBe(
      "строка не подействует",
    );
    expect(formatApiError({ status: 400, body: { error: "bad body: chat_id" } })).toBe(
      "bad body: chat_id",
    );
  });

  test("жёсткие ветки 401/403/404/429 не задеты", () => {
    expect(formatApiError({ status: 401, body: { error: "x" } })).toContain("Telegram");
    expect(formatApiError({ status: 403, body: { error: "x" } })).toContain("доступа");
    expect(formatApiError({ status: 404, body: { error: "x" } })).toContain("Маршрут");
    expect(formatApiError({ status: 429, body: { error: "x" } })).toContain("Слишком много");
  });

  test("5xx без тела не оставляет пользователя с пустой строкой", () => {
    expect(formatApiError({ status: 500 })).toBe(
      "Сервер панели временно недоступен. Повторите попытку позже.",
    );
    expect(formatApiError({ status: 500, body: { error: "   " } })).toBe(
      "Сервер панели временно недоступен. Повторите попытку позже.",
    );
  });

  test("таймаут по-прежнему говорит своим текстом", () => {
    expect(formatApiError({ timeout: true, message: "Сервер не ответил за 20 с" })).toBe(
      "Сервер не ответил за 20 с",
    );
  });
});

describe("Mac.tsx: кнопка стопа переживает отказ чтения истории", () => {
  test("ранних возвратов по loading и error в странице нет", () => {
    const bad = MAC_CODE.filter(
      (l) => /if\s*\(loading\)\s*return/.test(l) || /if\s*\(error\)\s*return/.test(l),
    );
    expect(bad).toEqual([]);
  });

  test("скелет и ErrorBox стоят ниже блока с кнопкой стопа", () => {
    const stop = MAC_SRC.indexOf("canStop &&");
    expect(stop).toBeGreaterThan(0);
    for (const needle of ["<SkeletonList />", "<ErrorBox"]) {
      const at = MAC_SRC.indexOf(needle);
      expect(at).toBeGreaterThan(stop);
    }
  });

  test("состояния списка выражены тернарником внутри разметки", () => {
    expect(macHas("{loading ? (")).toBe(true);
    expect(macHas(") : error ? (")).toBe(true);
    expect(macHas(") : sessions.length === 0 ? (")).toBe(true);
  });

  test("ErrorBox получает проп message и кнопку повтора", () => {
    expect(macHas("<ErrorBox message={error} onRetry={loadMacHistory} />")).toBe(true);
  });

  test("handleStopAll по-прежнему не трогает setError", () => {
    // Его отказы идут в тост: иначе неудачный стоп прятал бы кнопку стопа.
    const from = MAC_SRC.indexOf("async function handleStopAll");
    const to = MAC_SRC.indexOf("function selectProps");
    // Обе границы обязаны найтись. Аудит 2026-09-11: концом среза стояла
    // `function statusBadge` — такого символа в Mac.tsx нет (есть
    // `getStatusBadge`), `indexOf` отдавал −1, и `slice(from, -1)` резал до
    // конца файла. Проверка «не трогает setError» тихо расширилась на всю
    // остальную страницу, а проверять должна была одну функцию.
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = MAC_SRC.slice(from, to);
    expect(body.length).toBeGreaterThan(100);
    expect(codeLines(body).some((l) => l.includes("setError("))).toBe(false);
  });
});
