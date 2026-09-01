/**
 * Аудит 2026-08-14: вкладка «Логи» показывала ответ не того запроса.
 *
 * `load()` писала результат в состояние безусловно, а звали её из четырёх мест
 * сразу: смена фильтра, живое событие `action.executed`, кнопка «Обновить» и
 * повтор после ошибки. Ни одно из них не ждало предыдущего, а сеть порядок
 * ответов не гарантирует.
 *
 *   1. Переключили агента. Эффект чистит список и шлёт запрос. Старый, ещё не
 *      вернувшийся, приходит вторым — и заполняет список действиями ПРЕЖНЕГО
 *      агента. В фильтре стоит один, на экране другой, и никакого признака,
 *      что это рассинхрон.
 *   2. Двенадцать агентов работают постоянно, `action.executed` идёт пачками.
 *      Каждое событие на первой странице — свой `load(true)`. Выигрывает тот,
 *      кто вернулся последним, а это не обязательно самый свежий.
 *   3. Проигравший забег дёргал `setLoading(false)` в `finally`: спиннер
 *      актуального запроса гас раньше времени, а кнопка «Показать ещё»
 *      разблокировалась посреди загрузки — и давала догрузить страницу
 *      «после» набора, которого на экране ещё нет.
 *
 * Инвариант: в состояние пишет только тот запрос, после которого не стартовал
 * другой. Отмена запроса тут не помогает — ответ уже может быть в пути.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunGate } from "../miniapp/src/pages/Logs.tsx";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Logs.tsx"),
  "utf8",
);

describe("право записи принадлежит последнему забегу", () => {
  test("одинокий запрос пишет в состояние", () => {
    const gate = createRunGate();
    const run = gate.start();
    expect(gate.isCurrent(run)).toBe(true);
  });

  test("старт нового забега отбирает право у предыдущего", () => {
    const gate = createRunGate();
    const first = gate.start();
    const second = gate.start();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  test("порядок возврата ответов роли не играет", () => {
    // Ровно тот случай, что ломал экран: старый ответ приходит последним.
    const gate = createRunGate();
    const old = gate.start();
    const fresh = gate.start();
    expect(gate.isCurrent(fresh)).toBe(true); // свежий вернулся первым
    expect(gate.isCurrent(old)).toBe(false); // старый — вторым, и отброшен
  });

  test("пачка живых событий: побеждает последний, а не самый медленный", () => {
    const gate = createRunGate();
    const runs = [gate.start(), gate.start(), gate.start(), gate.start()];
    const winners = runs.filter((r) => gate.isCurrent(r));
    expect(winners).toEqual([runs[runs.length - 1]]);
  });
});

describe("сценарий смены фильтра целиком", () => {
  /** Модель `load()`: номер берётся до await, запись — только если он ещё последний. */
  async function simulate(order: "stale-last" | "stale-first") {
    const gate = createRunGate();
    let items: string[] = [];
    let loading = false;

    const load = async (label: string, delayMs: number) => {
      const run = gate.start();
      loading = true;
      try {
        await new Promise((res) => setTimeout(res, delayMs));
        if (!gate.isCurrent(run)) return;
        items = [`${label}-1`, `${label}-2`];
      } finally {
        if (gate.isCurrent(run)) loading = false;
      }
    };

    const staleDelay = order === "stale-last" ? 30 : 1;
    const both = [load("pm", staleDelay), load("qa", 10)];
    await Promise.all(both);
    return { items, loading };
  }

  test("медленный ответ прежнего фильтра не заполняет экран", async () => {
    // До правки здесь оказывалось ["pm-1","pm-2"] при выбранном qa.
    const { items } = await simulate("stale-last");
    expect(items).toEqual(["qa-1", "qa-2"]);
  });

  test("быстрый ответ прежнего фильтра тоже не побеждает", async () => {
    const { items } = await simulate("stale-first");
    expect(items).toEqual(["qa-1", "qa-2"]);
  });

  test("спиннер гаснет ровно один раз — по актуальному запросу", async () => {
    const { loading } = await simulate("stale-last");
    expect(loading).toBe(false);
  });
});

describe("страница действительно проходит через воротца", () => {
  const load = SRC.slice(SRC.indexOf("async function load("));
  const body = load.slice(0, load.indexOf("\n  }\n") + 5);

  test("номер забега берётся до сетевого вызова", () => {
    expect(body.indexOf("gate.start()")).toBeGreaterThan(-1);
    expect(body.indexOf("gate.start()")).toBeLessThan(body.indexOf("await api.actions"));
  });

  test("все три ветки — успех, ошибка и finally — спрашивают воротца", () => {
    const checks = body.match(/gate\.isCurrent\(run\)/g) ?? [];
    expect(checks.length).toBe(3);
  });

  test("setItems и setLoading не вызываются в обход проверки", () => {
    const afterAwait = body.slice(body.indexOf("await api.actions"));
    expect(afterAwait.indexOf("gate.isCurrent(run)")).toBeLessThan(
      afterAwait.indexOf("setItems("),
    );
    expect(afterAwait).not.toMatch(/finally\s*\{\s*setLoading\(false\)/);
  });

  test("воротца живут в ref, а не пересоздаются на каждый рендер", () => {
    expect(SRC).toContain("gateRef.current === null");
  });
});
