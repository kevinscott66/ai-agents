/**
 * Аудит 2026-08-20: у HTTP-слоя Mini App не было потолка ожидания.
 *
 * `req()` в miniapp/src/lib/api.ts делал голый `fetch(path, ...)` без
 * AbortController. Пока ответ не пришёл, промис не завершается — а страницы
 * устроены как `setLoading(true) → await api.X() → finally setLoading(false)`.
 * То есть зависший запрос оставляет вкладку в скелетоне навсегда: ни текста
 * ошибки, ни кнопки «Повторить» (ErrorBox рисуется только при пойманной
 * ошибке), ни возможности что-то сделать кроме перезапуска Mini App.
 *
 * Сценарий не гипотетический и специфичен именно для этого проекта: сервер
 * Mini App живёт на том же единственном потоке `Bun.serve`, что и SQLite и все
 * 12 ботов (об этом прямо написано в докблоке lib/coalesce.ts). Ночной бэкап
 * делает `VACUUM INTO` по всей базе плюс `tar` по вики синхронно
 * (lib/backup.ts) — соединение принято, ответа нет. Браузер такой сокет сам не
 * рвёт: он открыт и «жив», просто молчит.
 *
 * Проверяем три вещи: потолок срабатывает, обычный запрос он не трогает, и
 * ошибка распознаётся как таймаут (страницы по ней покажут «Повторить»).
 */
import { test, expect, describe, afterEach } from "bun:test";
import { apiRequest, API_TIMEOUT_MS } from "../miniapp/src/lib/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Сервер принял соединение и молчит. Рвётся только по signal. */
function silentServer(): { calls: number; aborted: () => boolean } {
  const stat = { calls: 0, abortedFlag: false };
  globalThis.fetch = ((_url: any, init?: any) => {
    stat.calls++;
    return new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (!signal) return; // нет потолка — висим вечно
      signal.addEventListener("abort", () => {
        stat.abortedFlag = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as any;
  return {
    get calls() {
      return stat.calls;
    },
    aborted: () => stat.abortedFlag,
  } as any;
}

describe("Mini App: потолок ожидания HTTP", () => {
  test("молчащий сервер не оставляет страницу в вечной загрузке", async () => {
    const srv = silentServer();
    const t0 = Date.now();
    let caught: any = null;
    try {
      await apiRequest("/api/health", { timeoutMs: 40 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - t0;

    // Контроль: запрос действительно был сделан, а не отбит до fetch.
    expect(srv.calls).toBe(1);
    expect(caught).not.toBe(null);
    expect(srv.aborted()).toBe(true);
    // Потолок именно потолок: уложились в него с запасом, а не ждали минуты.
    expect(elapsed).toBeLessThan(2000);
  });

  test("ошибка распознаётся как таймаут — страница покажет «Повторить»", async () => {
    silentServer();
    let caught: any = null;
    try {
      await apiRequest("/api/dashboard", { timeoutMs: 40 });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBe(null);
    // Пометка для UI: не сетевой сбой и не HTTP-код.
    expect(caught.timeout).toBe(true);
    // Текст идёт прямо в ErrorBox, значит он для человека, а не "AbortError".
    expect(String(caught.message)).not.toMatch(/AbortError/i);
    expect(String(caught.message).length).toBeGreaterThan(10);
  });

  test("успевший ответ потолок не трогает, и дефолт разумный", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, ts: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;

    const body = await apiRequest<{ ok: boolean; ts: number }>("/api/health", {
      timeoutMs: 40,
    });
    expect(body.ok).toBe(true);
    expect(body.ts).toBe(1);

    // Дефолт должен быть заметно больше «медленного, но живого» ответа и
    // заметно меньше браузерного молчания в несколько минут.
    expect(API_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(API_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
