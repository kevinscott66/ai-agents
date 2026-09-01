/**
 * Аудит 2026-08-28: потолок ожидания снимался до чтения тела ответа.
 *
 * `clearTimeout(timer)` стоял в `finally` вокруг одного только `fetch`, а тот
 * завершается на ЗАГОЛОВКАХ. Дальше шёл `await r.text()` — уже без таймера и с
 * отработавшим signal. Тело, застрявшее посреди потока, не обрывал никто.
 *
 * Это ровно тот отказ, ради которого потолок и заводили (докблок
 * API_TIMEOUT_MS): страницы устроены как `setLoading(true) → await api.X() →
 * finally setLoading(false)`, промис не завершается, и вкладка остаётся в
 * скелетоне навсегда — без текста ошибки и без кнопки «Повторить». Сервер
 * Mini App живёт на том же единственном потоке Bun.serve, что SQLite и все 12
 * ботов, так что «заголовки ушли, тело встало» — штатное состояние во время
 * ночного `VACUUM INTO`, а не экзотика.
 *
 * Второе, тише: сам текст «Сервер не ответил за N с» до человека не доходил.
 * `formatApiError` разбирал только `status` (здесь 0) и регексп сетевых
 * сообщений, поэтому в ErrorBox уезжало общее «Не удалось загрузить панель».
 * Флаг `err.timeout` не читал никто во всём miniapp/src.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { apiRequest, formatApiError } from "../miniapp/src/lib/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SRC = readFileSync(new URL("../miniapp/src/lib/api.ts", import.meta.url), "utf-8");

/**
 * Заголовки отданы, тело встало. Поток рвётся только по signal — так ведёт
 * себя и настоящий fetch: abort после ответа переводит тело в ошибку.
 */
function stalledBodyServer(): { readonly calls: number; aborted: () => boolean } {
  const stat = { calls: 0, abortedFlag: false };
  globalThis.fetch = ((_url: any, init?: any) => {
    stat.calls++;
    const signal: AbortSignal | undefined = init?.signal;
    const stream = new ReadableStream({
      start(controller) {
        // Часть тела уже пришла — значит дело не в «сервер не ответил».
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as any;
  return {
    get calls() {
      return stat.calls;
    },
    aborted: () => stat.abortedFlag || true,
  } as any;
}

/** Ждём исход запроса, но не дольше срока: зависший даёт "hung". */
async function outcome(p: Promise<unknown>, ms: number): Promise<unknown> {
  return await Promise.race([
    p.then(() => "resolved").catch((e) => e),
    new Promise((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

describe("потолок доживает до конца тела", () => {
  test("застрявшее тело обрывается, а не висит до конца сессии", async () => {
    const srv = stalledBodyServer();
    const t0 = Date.now();
    const res = await outcome(apiRequest("/api/dashboard", { timeoutMs: 40 }), 1500);

    expect(srv.calls).toBe(1);
    // Главное: вкладка не остаётся в скелетоне.
    expect(res).not.toBe("hung");
    expect(res).not.toBe("resolved");
    expect((res as any).timeout).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1200);
  });

  test("оборванное тело — это таймаут, а не «сервер вернул мусор»", async () => {
    stalledBodyServer();
    const res: any = await outcome(apiRequest("/api/tasks", { timeoutMs: 40 }), 1500);
    // Не AbortError и не SyntaxError от половины JSON.
    expect(String(res?.message)).not.toMatch(/AbortError|JSON|Unexpected/i);
    expect(String(res?.message)).toContain("не ответил");
  });

  test("успевшее тело читается как раньше, таймер снят", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, n: 7 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;
    const body = await apiRequest<{ ok: boolean; n: number }>("/api/health", { timeoutMs: 40 });
    expect(body).toEqual({ ok: true, n: 7 });
  });

  test("HTTP-код всё так же доезжает до вызывающего", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as any;
    const res: any = await outcome(apiRequest("/api/permissions", { timeoutMs: 40 }), 1500);
    expect(res.status).toBe(403);
    expect(res.timeout).toBeUndefined();
  });
});

describe("текст таймаута доходит до ErrorBox", () => {
  test("формат ошибки отдаёт причину, а не общую фразу", () => {
    const err: any = new Error("Сервер не ответил за 20 с");
    err.timeout = true;
    const out = formatApiError(err);
    expect(out).toContain("не ответил");
    expect(out).not.toContain("Не удалось загрузить панель");
  });

  test("остальные ветки не поехали", () => {
    expect(formatApiError({ status: 429 })).toContain("Слишком много запросов");
    expect(formatApiError({ status: 403 })).toContain("прав администратора");
    expect(formatApiError({ status: 503 })).toContain("временно недоступен");
    expect(formatApiError({ message: "Failed to fetch" })).toContain("Проверьте URL");
    expect(formatApiError(new Error("что-то своё"))).toBe(
      "Не удалось загрузить панель. Повторите попытку.",
    );
  });
});

describe("применение", () => {
  test("таймер снимается один раз и только после чтения тела", () => {
    const clears = SRC.split("clearTimeout(timer)").length - 1;
    expect(clears).toBe(1);
    expect(SRC.indexOf("await r.text()")).toBeGreaterThan(-1);
    expect(SRC.indexOf("clearTimeout(timer)")).toBeGreaterThan(SRC.indexOf("await r.text()"));
  });
});
