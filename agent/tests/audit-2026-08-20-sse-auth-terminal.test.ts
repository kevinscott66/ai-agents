/**
 * Аудит 2026-08-20: SSE-клиент Mini App не отличал «отказано навсегда» от
 * «не получилось сейчас».
 *
 * `fetchTicket()` в `miniapp/src/lib/sse.ts` делал `if (!r.ok) return null` —
 * статус ответа выбрасывался целиком. Дальше `connect()` на любой `null` шёл в
 * `scheduleReconnect()`, а `backoffStep` обнуляется только в `es.onopen`,
 * которого в этом сценарии не бывает. То есть отказ упирался в потолок бэкоффа
 * и стучался в `/api/sse-ticket` каждые 10 секунд до закрытия приложения.
 *
 * Сценарий не гипотетический: ручка стоит ЗА стеной аутентификации
 * (`miniapp-server.ts`, `authOr401`), а Telegram initData живёт сутки. Вкладка,
 * провисевшая ночь, получает 401 на каждую попытку. Пользователь при этом видит
 * «Переподключение…» — то есть UI обещает, что вот-вот починится, хотя не
 * починится никогда, а данные на экране молча устаревают.
 *
 * Границы: 401 (подпись/срок initData) и 403 (аллоу-лист, origin) повтором
 * того же запроса не лечатся. 429 и 5xx — лечатся, их ретраим как раньше.
 *
 * Инвариант: терминальный отказ виден пользователю и не порождает вечных
 * запросов; временный — по-прежнему ретраится.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { subscribe, close, currentState, onState } from "../miniapp/src/lib/sse.ts";

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

/** Что отдаёт `/api/sse-ticket` в текущем тесте. */
let ticketStatus = 200;
let ticketCalls = 0;

beforeAll(() => {
  (globalThis as any).EventSource = FakeEventSource;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("/api/sse-ticket")) ticketCalls++;
    if (ticketStatus !== 200) {
      return new Response(JSON.stringify({ error: "nope" }), {
        status: ticketStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ ticket: "test-ticket", expiresInSec: 30 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterAll(() => {
  close();
  (globalThis as any).EventSource = realEventSource;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  // `close()` снимает и таймер бэкоффа, и терминальный флаг — иначе тесты
  // текли бы друг в друга через состояние модуля.
  close();
  FakeEventSource.instances.length = 0;
  ticketCalls = 0;
  ticketStatus = 200;
});

/** Даём connect() пройти свой await за билетом. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("SSE-билет: терминальный отказ", () => {
  for (const status of [401, 403]) {
    test(`${status} → состояние unauthorized, поток не поднимается`, async () => {
      ticketStatus = status;
      const un = subscribe("task.created", () => {});
      await settle();

      expect({
        state: currentState(),
        streams: FakeEventSource.instances.length,
      }).toEqual({ state: "unauthorized", streams: 0 });
      un();
    });
  }

  test("после терминального отказа новые подписки не долбят сервер", async () => {
    ticketStatus = 401;
    const un = subscribe("task.created", () => {});
    await settle();
    const afterFirst = ticketCalls;

    // Ровно то, что делает навигация по вкладкам: каждая страница
    // подписывается заново и вызывает connect().
    const more = [
      subscribe("task.updated", () => {}),
      subscribe("approval.created", () => {}),
      subscribe("agent.health", () => {}),
    ];
    await settle();

    expect({ afterFirst, total: ticketCalls, state: currentState() }).toEqual({
      afterFirst: 1,
      total: 1,
      state: "unauthorized",
    });
    un();
    for (const f of more) f();
  });

  test("состояние доезжает до подписчика (баннер в App.tsx)", async () => {
    ticketStatus = 403;
    const seen: string[] = [];
    const offState = onState((s) => seen.push(s));
    const un = subscribe("task.created", () => {});
    await settle();

    expect(seen[seen.length - 1]).toBe("unauthorized");
    offState();
    un();
  });

  test("close() снимает терминальный флаг — модуль не отравлен навсегда", async () => {
    ticketStatus = 401;
    const un = subscribe("task.created", () => {});
    await settle();
    expect(currentState()).toBe("unauthorized");
    un();

    close();
    ticketStatus = 200;
    const un2 = subscribe("task.created", () => {});
    await settle();
    expect(FakeEventSource.instances.length).toBe(1);
    un2();
  });
});

describe("SSE-билет: временный отказ ретраится как раньше", () => {
  test("429 → reconnecting, а не unauthorized", async () => {
    ticketStatus = 429;
    const un = subscribe("task.created", () => {});
    await settle();

    expect(currentState()).toBe("reconnecting");
    un();
  });

  test("500 → reconnecting", async () => {
    ticketStatus = 500;
    const un = subscribe("task.created", () => {});
    await settle();

    expect(currentState()).toBe("reconnecting");
    un();
  });

  test("200 → поток открывается (контроль)", async () => {
    const un = subscribe("task.created", () => {});
    await settle();

    expect(FakeEventSource.instances.length).toBe(1);
    un();
  });
});
