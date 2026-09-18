// Зависший шаг исполнителя не держит замок вечно (2026-09-18: браузера нет,
// а на каждый запрос shop_busy, пока демон не перезапустили руками).
import { describe, expect, test } from "bun:test";
import { settleOrRelease } from "../mac-daemon/runner-kit.ts";
import { ShopRunner, SHOP_RUN_DEADLINE_MS } from "../mac-daemon/shop.ts";
import { TaxiRunner, TAXI_RUN_DEADLINE_MS } from "../mac-daemon/taxi.ts";
import { DeliveryRunner, DELIVERY_RUN_DEADLINE_MS } from "../mac-daemon/delivery.ts";
import { MAC_DELIVERY_TIMEOUT_MS, MAC_SHOP_TIMEOUT_MS, MAC_TAXI_TIMEOUT_MS } from "../lib/mac-bridge.ts";

const never = () => new Promise<never>(() => {});

/**
 * Браузер, у которого любой шаг страницы висит, пока браузер не закроют, —
 * как Playwright: на закрытой странице висящий вызов падает сразу.
 */
function hungBrowser() {
  const st = { launches: 0, closes: 0 };
  const waiters = new Set<(e: Error) => void>();
  const page = new Proxy({}, {
    // Не thenable: иначе `await browser.page()` принял бы страницу за промис.
    get: (_t, key) => key === "then" ? undefined : () => new Promise((_, reject) => { waiters.add(reject); }),
  });
  const launch = async () => {
    st.launches++;
    return {
      page: () => page as never,
      close: async () => { st.closes++; for (const w of waiters) w(new Error("Target page, context or browser has been closed")); waiters.clear(); },
    };
  };
  return { st, launch };
}

const opts = (launch: () => Promise<unknown>, deadlineMs: number) => ({
  launch: launch as never,
  checkProfile: () => "/profile",
  sleep: async () => {},
  idleMs: 60_000,
  deadlineMs,
  selfSettleMs: 5,
});

describe("settleOrRelease", () => {
  test("успешная работа проходит как есть, release не зовётся", async () => {
    let released = 0;
    const v = await settleOrRelease(Promise.resolve(7), { deadlineMs: 1_000, release: async () => { released++; } });
    expect(v).toBe(7);
    expect(released).toBe(0);
  });

  test("отказ работы пробрасывается без release", async () => {
    let released = 0;
    const err = new Error("place_not_found");
    await expect(settleOrRelease(Promise.reject(err), { deadlineMs: 1_000, release: async () => { released++; } })).rejects.toBe(err);
    expect(released).toBe(0);
  });

  test("срок вышел — release и runner_stuck", async () => {
    let released = 0;
    await expect(settleOrRelease(never(), { deadlineMs: 10, graceMs: 10, selfSettleMs: 5, release: async () => { released++; } })).rejects.toThrow("runner_stuck");
    expect(released).toBe(1);
  });

  test("отмена моста — release и assistant_cancelled, даже если шаг её не слышит", async () => {
    const ac = new AbortController();
    let released = 0;
    const p = settleOrRelease(never(), { signal: ac.signal, deadlineMs: 60_000, graceMs: 10, selfSettleMs: 5, release: async () => { released++; } });
    ac.abort();
    await expect(p).rejects.toThrow("assistant_cancelled");
    expect(released).toBe(1);
  });

  test("шаг, не упавший и после закрытия браузера, не держит вызывающего дольше grace", async () => {
    const t0 = Date.now();
    await expect(settleOrRelease(never(), { deadlineMs: 5, graceMs: 20, selfSettleMs: 5, release: async () => {} })).rejects.toThrow("runner_stuck");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("исполнители: после зависания следующий запрос не получает *_busy", () => {
  const cases = [
    { name: "shop", make: (l: () => Promise<unknown>, d: number) => new ShopRunner({ SHOP_ENABLED: "true", SHOP_PROFILE_DIR: "/profile" }, opts(l, d)), req: { op: "status", service: "lavka" } as never, busy: "shop_busy" },
    { name: "taxi", make: (l: () => Promise<unknown>, d: number) => new TaxiRunner({ TAXI_ENABLED: "true", TAXI_PROFILE_DIR: "/profile" }, opts(l, d)), req: { op: "status" } as never, busy: "taxi_busy" },
    { name: "delivery", make: (l: () => Promise<unknown>, d: number) => new DeliveryRunner({ DELIVERY_ENABLED: "true", DELIVERY_PROFILE_DIR: "/profile" }, opts(l, d)), req: { op: "status" } as never, busy: "delivery_busy" },
  ];

  for (const c of cases) {
    test(`${c.name}: срок вышел — браузер закрыт, замок снят`, async () => {
      const b = hungBrowser();
      const r = c.make(b.launch, 20);
      await expect(r.run(c.req)).rejects.toThrow("runner_stuck");
      expect(b.st.closes).toBe(1);
      // Раньше тут навсегда было *_busy. Теперь — новый браузер и снова срок.
      await expect(r.run(c.req)).rejects.toThrow("runner_stuck");
      expect(b.st.launches).toBe(2);
    });

    test(`${c.name}: отмена моста снимает зависший запрос`, async () => {
      const b = hungBrowser();
      const r = c.make(b.launch, 60_000);
      const ac = new AbortController();
      const p = r.run(c.req, ac.signal);
      await new Promise((res) => setTimeout(res, 5));
      ac.abort();
      await expect(p).rejects.toThrow("assistant_cancelled");
      const second = r.run(c.req, AbortSignal.abort());
      await expect(second).rejects.toThrow("assistant_cancelled");
      await expect(second).rejects.not.toMatchObject({ code: c.busy });
    });

    test(`${c.name}: браузер, запустившийся после срока, закрывается, а не подбирается`, async () => {
      let finish!: (b: { page: () => never; close: () => Promise<void> }) => void;
      let lateClosed = 0;
      const launch = () => new Promise<unknown>((res) => { finish = res as never; });
      const r = c.make(launch, 20);
      await expect(r.run(c.req)).rejects.toThrow("runner_stuck");
      finish({ page: () => ({}) as never, close: async () => { lateClosed++; } });
      await new Promise((res) => setTimeout(res, 5));
      expect(lateClosed).toBe(1);
    }, 15_000); // запуск не падает от close(), так что run() честно ждёт весь grace
  }
});

test("медленный, но живой шаг после отмены заканчивается сам: браузер не закрывают, его уборка не обрывается", async () => {
  const ac = new AbortController();
  let released = 0;
  const work = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("assistant_cancelled")), 30));
  const p = settleOrRelease(work, { signal: ac.signal, deadlineMs: 60_000, selfSettleMs: 1_000, release: async () => { released++; } });
  ac.abort();
  await expect(p).rejects.toThrow("assistant_cancelled");
  expect(released).toBe(0);
});

test("срок демона длиннее ожидания моста: сервер не получит отказ раньше своего таймаута", () => {
  expect(SHOP_RUN_DEADLINE_MS).toBeGreaterThan(MAC_SHOP_TIMEOUT_MS);
  expect(TAXI_RUN_DEADLINE_MS).toBeGreaterThan(MAC_TAXI_TIMEOUT_MS);
  expect(DELIVERY_RUN_DEADLINE_MS).toBeGreaterThan(MAC_DELIVERY_TIMEOUT_MS);
});
