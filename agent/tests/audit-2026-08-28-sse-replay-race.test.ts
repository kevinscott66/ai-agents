/**
 * Аудит 2026-08-28: гонка анти-реплея убивала живые обновления на весь сеанс.
 *
 * `/api/sse-ticket` — POST, то есть для сервера это мутация, и он гоняет её
 * через анти-реплей (`auth-middleware.ts` → `MiniAppSessionStore.issue`).
 * Отпечаток initData помечается израсходованным в момент ВЫДАЧИ сессии, а
 * cookie с токеном уезжает лишь в хвосте ответа (`miniapp-server.ts`). Пока
 * она не вернулась в браузер, второй одновременный POST с тем же initData
 * зовёт `issue()` ещё раз и получает 401 `{"error":"replayed initData"}` — при
 * том что его initData совершенно валиден. Проигравшим бывает и билет по
 * таймеру переподключения, и обычная мутация пользователя.
 *
 * Клиент считал любой 401 терминальным: `authFailed = true` снимается только
 * `close()`, а его в `miniapp/src` не зовёт никто. Итог — SSE мёртв до
 * перезапуска приложения, а App.tsx показывает «Сессия Telegram истекла», хотя
 * сессия не истекала.
 *
 * Инвариант: 401 гонки — временный (ретраится и чинится сам), остальные 401 и
 * все 403 — по-прежнему терминальные.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { subscribe, close, currentState } from "../miniapp/src/lib/sse.ts";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

const realEventSource = (globalThis as any).EventSource;
const realFetch = globalThis.fetch;

/** Очередь ответов `/api/sse-ticket`; последний повторяется, когда кончится. */
let ticketPlan: { status: number; body: unknown }[] = [];
let ticketCalls = 0;

const OK = { status: 200, body: { ticket: "t", expiresInSec: 30 } };
const RACE = { status: 401, body: { error: "replayed initData" } };
const EXPIRED = { status: 401, body: { error: "bad initData" } };
const FORBIDDEN = { status: 403, body: { error: "user not allowed" } };

beforeAll(() => {
  (globalThis as any).EventSource = FakeEventSource;
  globalThis.fetch = (async (url: any) => {
    if (!String(url).includes("/api/sse-ticket")) {
      return new Response("{}", { status: 200 });
    }
    const step = ticketPlan[Math.min(ticketCalls, ticketPlan.length - 1)] ?? OK;
    ticketCalls++;
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  close();
  (globalThis as any).EventSource = realEventSource;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  // Модульное состояние sse.ts (authFailed, шаг бэкоффа, таймер) течёт между
  // файлами — bun гоняет весь каталог одним процессом.
  close();
  FakeEventSource.instances.length = 0;
  ticketPlan = [OK];
  ticketCalls = 0;
});

/** Даём connect() пройти свой await за билетом. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("401 гонки анти-реплея — временный отказ", () => {
  test("не переводит клиента в unauthorized", async () => {
    ticketPlan = [RACE];
    const un = subscribe("task.created", () => {});
    await settle();

    expect(currentState()).toBe("reconnecting");
    un();
  });

  test("попытка повторяется и поднимает поток, когда cookie доехала", async () => {
    // Первый билет проиграл гонку, второй пришёл уже с cookie победителя.
    ticketPlan = [RACE, OK];
    const un = subscribe("task.created", () => {});
    await settle();
    expect(currentState()).toBe("reconnecting");

    // Первый шаг бэкоффа — 1000 мс.
    await new Promise((r) => setTimeout(r, 1200));
    await settle();

    expect({
      state: currentState(),
      streams: FakeEventSource.instances.length,
      calls: ticketCalls,
    }).toEqual({ state: "connecting", streams: 1, calls: 2 });
    un();
  });
});

describe("остальные отказы остались терминальными", () => {
  test("401 не про гонку — по-прежнему unauthorized", async () => {
    ticketPlan = [EXPIRED];
    const un = subscribe("task.created", () => {});
    await settle();

    expect({
      state: currentState(),
      streams: FakeEventSource.instances.length,
    }).toEqual({ state: "unauthorized", streams: 0 });
    un();
  });

  test("401 без разбираемого тела — тоже unauthorized (fail-closed)", async () => {
    // Например ответ прокси в HTML: причина неизвестна → считаем терминальным,
    // как было до этого аудита.
    ticketPlan = [{ status: 401, body: "<html>401</html>" }];
    const un = subscribe("task.created", () => {});
    await settle();

    expect(currentState()).toBe("unauthorized");
    un();
  });

  test("403 — unauthorized, тело не смотрим", async () => {
    ticketPlan = [FORBIDDEN];
    const un = subscribe("task.created", () => {});
    await settle();

    expect(currentState()).toBe("unauthorized");
    un();
  });

  test("после терминального отказа сервер больше не дёргается", async () => {
    ticketPlan = [EXPIRED];
    const un = subscribe("task.created", () => {});
    await settle();
    const afterFirst = ticketCalls;
    const more = subscribe("task.updated", () => {});
    await settle();

    expect({ afterFirst, total: ticketCalls }).toEqual({ afterFirst: 1, total: 1 });
    un();
    more();
  });
});

describe("сервер и клиент говорят об одном и том же", () => {
  test("формулировка отказа в auth-middleware совпадает с той, что ищет клиент", async () => {
    // Текстовое сравнение — единственная связь между двумя файлами. Если
    // сообщение на сервере переименуют, тест упадёт здесь, а не превратится в
    // молчаливо мёртвый ретрай в проде.
    const mw = await Bun.file(
      new URL("../lib/auth-middleware.ts", import.meta.url).pathname,
    ).text();
    const client = await Bun.file(
      new URL("../miniapp/src/lib/sse.ts", import.meta.url).pathname,
    ).text();
    expect(mw).toContain('error: "replayed initData"');
    expect(client).toContain('body?.error === "replayed initData"');
  });
});
