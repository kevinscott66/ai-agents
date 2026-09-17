/**
 * Аудит 2026-08-11: всплеск SSE-событий превращался во всплеск запросов к API.
 *
 * Страницы вешают `load()` напрямую на события: Dashboard — на семь имён,
 * включая `action.executed`, Tasks — на task.created/updated. Один ход команды
 * это десятки действий подряд от 12 агентов, то есть десятки событий за
 * секунды. Каждое уходило в полную перезагрузку.
 *
 * Цена измерима: `/api/dashboard` (ветка `GET /api/dashboard` в miniapp-server.ts) делает ~45
 * синхронных запросов к SQLite — agent_states, 12×(getDailyUsage+getBudget),
 * 1+10 getTask, listPendingApprovals, 1+20 getAction. Пятнадцать действий в
 * ходе = ~700 запросов к базе на одну открытую вкладку. `Bun.serve`
 * однопоточный и делит поток с SQLite и всеми 12 ботами: вкладка со сводкой
 * тормозит ту самую команду, которую показывает. Плюс GET'ы ходят в общее ведро
 * рейт-лимита — вкладка выбивает 429 сама себе.
 *
 * Инвариант: всплеск схлопывается в один запуск, но обновление не теряется —
 * последнее событие всплеска обязательно доезжает.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCoalescer, SSE_COALESCE_MS } from "../miniapp/src/lib/coalesce.ts";

const SRC = join(import.meta.dir, "..", "miniapp", "src");

/** Управляемые часы: тест не должен зависеть от реального времени. */
function fakeClock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function fakeTimers(clock: ReturnType<typeof fakeClock>) {
  type TimerHandle = ReturnType<typeof setTimeout>;
  type Job = { dueAt: number; run: () => void };
  let nextId = 0;
  const jobs = new Map<number, Job>();

  const setTimer = (run: () => void, delayMs: number): TimerHandle => {
    const id = ++nextId;
    jobs.set(id, { dueAt: clock.now() + delayMs, run });
    return id as unknown as TimerHandle;
  };
  const clearTimer = (timer: TimerHandle) => {
    jobs.delete(timer as unknown as number);
  };
  const advance = (ms: number) => {
    clock.advance(ms);
    while (true) {
      const due = [...jobs.entries()]
        .filter(([, job]) => job.dueAt <= clock.now())
        .sort(([, a], [, b]) => a.dueAt - b.dueAt)[0];
      if (!due) return;
      jobs.delete(due[0]);
      due[1].run();
    }
  };

  return { setTimer, clearTimer, advance };
}

describe("createCoalescer", () => {
  test("первое событие уходит сразу", () => {
    const clock = fakeClock();
    const c = createCoalescer(700, clock.now);
    let runs = 0;
    c.schedule(() => runs++);
    expect(runs).toBe(1);
    c.cancel();
  });

  test("всплеск из 15 событий — один немедленный запуск и один хвостовой", () => {
    // Тот самый ход команды: 12 агентов, десятки action.executed подряд.
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const c = createCoalescer(20, clock.now, timers.setTimer, timers.clearTimer);
    let runs = 0;
    for (let i = 0; i < 15; i++) c.schedule(() => runs++);
    expect(runs).toBe(1); // ведущий

    timers.advance(60);
    expect(runs).toBe(2); // хвостовой — последнее состояние не потеряно
    c.cancel();
  });

  test("непрерывный поток событий не откладывает обновление бесконечно", () => {
    // Ключевое отличие от простого debounce: пока команда работает, события
    // не прекращаются, и чистый debounce не обновил бы экран никогда.
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const c = createCoalescer(20, clock.now, timers.setTimer, timers.clearTimer);
    let runs = 0;
    c.schedule(() => runs++);
    for (let i = 0; i < 30; i++) {
      c.schedule(() => runs++);
      timers.advance(5);
    }
    timers.advance(20);
    expect(runs).toBeGreaterThan(2);
    c.cancel();
  });

  test("редкие события проходят без задержки", () => {
    const clock = fakeClock();
    const c = createCoalescer(700, clock.now);
    let runs = 0;
    c.schedule(() => runs++);
    clock.advance(1000);
    c.schedule(() => runs++);
    clock.advance(1000);
    c.schedule(() => runs++);
    expect(runs).toBe(3);
    c.cancel();
  });

  test("cancel снимает отложенный запуск", () => {
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const c = createCoalescer(20, clock.now, timers.setTimer, timers.clearTimer);
    let runs = 0;
    c.schedule(() => runs++);
    c.schedule(() => runs++);
    c.cancel();
    timers.advance(60);
    expect(runs).toBe(1);
  });

  test("окно по умолчанию покрывает всплеск одного хода", () => {
    expect(SSE_COALESCE_MS).toBeGreaterThanOrEqual(300);
    expect(SSE_COALESCE_MS).toBeLessThanOrEqual(2000);
  });
});

describe("страницы схлопывают всплески", () => {
  const PAGES = [
    "pages/Dashboard.tsx",
    "pages/Tasks.tsx",
    "pages/Agents.tsx",
    "pages/Logs.tsx",
  ];

  for (const file of PAGES) {
    test(`${file}: SSE-подписки не зовут перезагрузку напрямую`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).toContain("useCoalescer");

      // Прямой `sseSubscribe("x", () => load())` — это и есть непожатый
      // всплеск. Должно идти через коалесер.
      const direct = [...src.matchAll(/sseSubscribe\([^)]*?,\s*\(\)\s*=>\s*(\w+)\(\)/g)]
        .map((m) => m[1]);
      expect(direct).toEqual([]);
    });
  }
});
