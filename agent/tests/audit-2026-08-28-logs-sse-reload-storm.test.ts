/**
 * Аудит 2026-08-28: вкладка «Логи» перезагружалась на каждое действие команды.
 *
 * Подписка звала `load(true)` напрямую:
 *
 *     sseSubscribe("action.executed", () => {
 *       if (liveActionMode(paged.current) === "notify") setLiveWaiting(true);
 *       else load(true);
 *     });
 *
 * `liveActionMode` защищает только догруженный набор (`paged.current === true`,
 * режим `notify`). В состоянии по умолчанию — первая страница — режим
 * `reload`, то есть один GET `/api/actions` на КАЖДОЕ событие. А
 * `action.executed` шина шлёт на каждую записанную строку действия любой из 12
 * ролей (lib/audit.ts:190).
 *
 * Ход команды на ~15 действий — это ~15 GET за пару секунд из ведра
 * `capacity: 120, refillPerSec: 4` (`GET_LIMIT` в lib/miniapp-server.ts),
 * каждый со
 * сканом `agent_actions` и полусотней `getAction` на том же единственном
 * потоке `Bun.serve`, где живут SQLite и все 12 ботов. Открывают эту вкладку
 * ровно тогда, когда за командой наблюдают, — то есть в момент всплеска.
 *
 * Тот же класс уже починен на Dashboard, Tasks и Agents коалесером
 * (аудит 2026-08-11). Инвариант в tests/miniapp-sse-reload-storm.test.ts
 * перечисляет три страницы поимённо, и `Logs.tsx` в списке не было; его
 * регексп ловит только `sseSubscribe("x", () => load())`, а здесь колбэк —
 * блок с условием, поэтому проверка молчала бы и после добавления в список.
 *
 * Проводка проверяется чтением исходника: DOM-харнесса у Mini App нет.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCoalescer, SSE_COALESCE_MS } from "../miniapp/src/lib/coalesce.ts";

const RAW = readFileSync(new URL("../miniapp/src/pages/Logs.tsx", import.meta.url), "utf8");
// Комментарии цитируют убранный код — проверяем исполняемый текст.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** Эффект подписки целиком: от вызова до списка зависимостей. */
const EFFECT = SRC.slice(
  SRC.indexOf('sseSubscribe("action.executed"'),
  SRC.indexOf("[agent, status, typeQuery]"),
);

describe("предпосылки", () => {
  test("событие шлётся на каждую записанную строку действия", () => {
    const audit = readFileSync(new URL("../lib/audit.ts", import.meta.url), "utf8");
    expect(audit).toContain('busEmit("action.executed"');
  });

  test("ведро GET'ов конечное — всплеск в него упирается", () => {
    const server = readFileSync(new URL("../lib/miniapp-server.ts", import.meta.url), "utf8");
    expect(server).toContain("const GET_LIMIT: RateLimitOpts = { capacity: 120, refillPerSec: 4 };");
  });
});

describe("всплеск схлопывается", () => {
  test("пятнадцать событий подряд дают два запроса, а не пятнадцать", () => {
    let t = 1000;
    const timers: Array<{ at: number; run: () => void }> = [];
    const c = createCoalescer(
      SSE_COALESCE_MS,
      () => t,
      (run, delay) => {
        const h = { at: t + delay, run };
        timers.push(h);
        return h as unknown as ReturnType<typeof setTimeout>;
      },
      (h) => {
        const i = timers.indexOf(h as unknown as { at: number; run: () => void });
        if (i >= 0) timers.splice(i, 1);
      },
    );
    let runs = 0;
    // Ход команды: пятнадцать действий за 300 мс.
    for (let i = 0; i < 15; i++) {
      t += 20;
      c.schedule(() => runs++);
    }
    expect(runs).toBe(1); // ведущий ушёл сразу
    // Хвост окна.
    t += SSE_COALESCE_MS;
    for (const h of timers.splice(0)) if (h.at <= t) h.run();
    expect(runs).toBe(2);
  });
});

describe("страница подключена к коалесеру", () => {
  test("хук импортирован и создан", () => {
    expect(SRC).toContain("useCoalescer");
    expect(SRC).toMatch(/const\s+coalescer\s*=\s*useCoalescer\(\)/);
  });

  test("перезагрузку по событию планирует коалесер, а не сама подписка", () => {
    expect(EFFECT.length).toBeGreaterThan(0);
    expect(EFFECT).toContain("coalescer.schedule(");
    // Прямой вызов внутри колбэка — это и есть непожатый всплеск.
    expect(EFFECT).not.toMatch(/else\s+load\(/);
  });

  test("смена фильтра грузит сразу, без окна", () => {
    // Первый `load(true)` в эффекте — не по событию, а по смене зависимостей:
    // задерживать его нечем и незачем.
    const head = SRC.slice(SRC.indexOf("setHasMore(true);"), SRC.indexOf('sseSubscribe("action.executed"'));
    expect(head).toContain("load(true)");
  });

  test("снятие подписки отменяет и отложенный запуск", () => {
    // Аудит 2026-08-13 на Tasks: оставшийся таймер держит замыкание на load()
    // со старым фильтром и переписывает свежий набор.
    expect(EFFECT).toContain("coalescer.cancel()");
  });
});
