/**
 * Аудит 2026-08-11: SSE-клиент Mini App вешал по нативному слушателю на каждую
 * пересборку подписки, а снимал их только вместе с соединением.
 *
 * `subscribe()` навешивал `es.addEventListener(name, …)` в ветке «первый
 * обработчик на это имя», а отписка при опустевшем наборе делала
 * `handlers.delete(name)` — то есть следующая подписка на то же имя снова
 * считалась первой и вешала ВТОРОЙ слушатель на то же живое соединение. Оба
 * слушателя ходят в один и тот же набор обработчиков, поэтому одно событие
 * вызывало `load()` столько раз, сколько было циклов подписки.
 *
 * Циклы — это не край: `Tasks.tsx` пересобирает подписку на каждое изменение
 * фильтра (`useEffect(..., [status, assignee])`), а уход со страницы и возврат
 * делают то же самое на Dashboard (там имён семь). Соединение при этом живёт:
 * `es` не закрывается, пока не порвётся сеть.
 *
 * Цена — не только лишние ререндеры. Каждый дубль это ещё один GET /api/tasks;
 * GET'ы ходят в общее ведро рейт-лимита (miniapp-server.ts, комментарий про
 * `get:`), а Bun.serve однопоточный и делит поток с SQLite и 12 ботами. То есть
 * пользователь, потыкавший фильтры, сначала выбивает 429 себе, а потом
 * подтормаживает всю команду.
 *
 * Инвариант: на одно имя события — один нативный слушатель на соединение,
 * сколько бы раз подписку ни пересобирали.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { subscribe, close } from "../miniapp/src/lib/sse.ts";

type Listener = (ev: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, Listener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: Listener) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  close() {
    this.closed = true;
  }
  /** Сколько нативных слушателей навешано на это имя. */
  countFor(name: string): number {
    return (this.listeners.get(name) ?? []).length;
  }
  emit(name: string, payload: unknown) {
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data: JSON.stringify(payload) });
    }
  }
}

const realEventSource = (globalThis as any).EventSource;
const realFetch = globalThis.fetch;

beforeAll(() => {
  (globalThis as any).EventSource = FakeEventSource;
  // Билет на подключение: клиент берёт его POST'ом до открытия потока.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ticket: "test-ticket", expiresInSec: 30 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});

afterAll(() => {
  close();
  (globalThis as any).EventSource = realEventSource;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  close();
  FakeEventSource.instances.length = 0;
});

/** Ждём, пока connect() пройдёт свой await за билетом и создаст поток. */
async function waitForStream(): Promise<FakeEventSource> {
  for (let i = 0; i < 50 && FakeEventSource.instances.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const es = FakeEventSource.instances[0];
  if (!es) throw new Error("поток так и не открылся");
  return es;
}

describe("одно имя события — один нативный слушатель", () => {
  test("пересборка подписки не удваивает слушателей", async () => {
    const un1 = subscribe("task.created", () => {});
    const es = await waitForStream();
    expect(es.countFor("task.created")).toBe(1);

    // Ровно то, что делает Tasks.tsx при смене фильтра: отписка и подписка
    // заново на живом соединении.
    un1();
    const un2 = subscribe("task.created", () => {});
    expect(es.countFor("task.created")).toBe(1);

    un2();
  });

  test("десять циклов подписки — обработчик всё ещё вызывается один раз", async () => {
    let calls = 0;
    let un = subscribe("task.updated", () => {
      calls++;
    });
    const es = await waitForStream();
    for (let i = 0; i < 10; i++) {
      un();
      un = subscribe("task.updated", () => {
        calls++;
      });
    }
    es.emit("task.updated", { id: "t-1" });
    expect(calls).toBe(1);
    un();
  });

  test("разные имена получают свои слушатели", async () => {
    const unA = subscribe("approval.created", () => {});
    const es = await waitForStream();
    const unB = subscribe("approval.decided", () => {});
    expect(es.countFor("approval.created")).toBe(1);
    expect(es.countFor("approval.decided")).toBe(1);
    unA();
    unB();
  });

  test("новое соединение получает слушатели заново", async () => {
    const un = subscribe("agent.health", () => {});
    const first = await waitForStream();
    expect(first.countFor("agent.health")).toBe(1);

    // Разрыв: клиент гасит поток и переподключается по бэкоффу. Учёт
    // навешанного привязан к соединению, а не к процессу, иначе после обрыва
    // события перестанут доходить вовсе.
    first.onerror?.();
    for (let i = 0; i < 300 && FakeEventSource.instances.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = FakeEventSource.instances[1];
    expect(second).toBeDefined();
    expect(second!.countFor("agent.health")).toBe(1);
    un();
  });

  test("payload доходит распарсенным ровно один раз", async () => {
    const seen: unknown[] = [];
    const un = subscribe("action.executed", (p) => seen.push(p));
    const es = await waitForStream();
    es.emit("action.executed", { actionType: "SEND_MESSAGE" });
    expect(seen).toEqual([{ actionType: "SEND_MESSAGE" }]);
    un();
  });
});
