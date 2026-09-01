/**
 * Аудит 2026-08-11: страницы Mini App применяли ответ независимо от того,
 * актуален он ещё или нет.
 *
 * `load()` ждёт сеть и кладёт результат в состояние. Порядок ответов не
 * гарантирован, а вызывают `load()` не только руками:
 *
 *  • Tasks.tsx — на каждое изменение фильтра (`useEffect(…, [status,
 *    assignee])`) и на каждое событие task.created / task.updated от любого из
 *    12 агентов. Быстро переключил фильтр → ответ на предыдущий фильтр приехал
 *    вторым и перезаписал список. В UI выбран один фильтр, на экране данные
 *    другого, и само это не рассосётся: ререндер данные не перезапрашивает.
 *
 *  • Approvals.tsx — `decideMany` оптимистично убирает строки, шлёт решения и
 *    зовёт `load()`. Параллельно то же решение прилетает событием
 *    approval.decided — ещё один `load()`. Запрос, ушедший ДО записи решения в
 *    БД, вернёт апрув всё ещё pending; придёт он вторым — только что одобренное
 *    действие снова окажется в списке и его предложат одобрить второй раз.
 *    Аппрув стоит ровно на необратимых действиях (публикация, отправка
 *    сообщения), так что второй тап — это второй пост в канал.
 *
 * Инвариант: результат применяет только последний запуск загрузки.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLatestRun } from "../miniapp/src/lib/stale.ts";

const SRC = join(import.meta.dir, "..", "miniapp", "src");

/** Тело функции по её сигнатуре — по балансу фигурных скобок. */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`не нашёл в исходнике: ${signature}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`не сошлись скобки: ${signature}`);
}

describe("createLatestRun", () => {
  test("свежий запуск отменяет предыдущий", () => {
    const begin = createLatestRun();
    const first = begin();
    expect(first()).toBe(true);

    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  test("предикат не сбрасывается сам по себе", () => {
    const begin = createLatestRun();
    const only = begin();
    expect(only()).toBe(true);
    expect(only()).toBe(true);
  });

  test("ответ на устаревший запрос не перезаписывает свежий", async () => {
    // Ровно сценарий Tasks.tsx: сменили фильтр, пока первый запрос в пути,
    // и первый ответ пришёл вторым.
    const applied: string[] = [];
    const begin = createLatestRun();

    async function load(filter: string, delayMs: number) {
      const isCurrent = begin();
      await new Promise((r) => setTimeout(r, delayMs));
      if (!isCurrent()) return;
      applied.push(filter);
    }

    const slowOld = load("pending", 30);
    const fastNew = load("done", 1);
    await Promise.all([slowOld, fastNew]);

    // Ответ на "pending" пришёл вторым, но применён быть не должен.
    expect(applied).toEqual(["done"]);
  });

  test("у каждой страницы свой счётчик", () => {
    const a = createLatestRun();
    const b = createLatestRun();
    const aRun = a();
    b();
    b();
    expect(aRun()).toBe(true);
  });
});

describe("страницы используют защиту", () => {
  const PAGES: { file: string; setter: string }[] = [
    { file: "pages/Tasks.tsx", setter: "setTasks(" },
    { file: "pages/Approvals.tsx", setter: "setItems(" },
  ];

  for (const { file, setter } of PAGES) {
    test(`${file}: load() применяет результат только если запрос актуален`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).toContain("useLatestRun");

      const body = bodyOf(src, "async function load()");
      const guardAt = body.indexOf("if (!isCurrent()) return");
      const setterAt = body.indexOf(setter);

      expect(guardAt).toBeGreaterThan(-1);
      expect(setterAt).toBeGreaterThan(-1);
      // Проверка должна стоять ДО записи в состояние, иначе она бесполезна.
      expect(guardAt).toBeLessThan(setterAt);
      // Устаревший запрос не должен гасить индикатор: актуальный ещё в пути.
      expect(body).toContain("if (isCurrent()) setLoading(false)");
    });
  }
});

/**
 * Wiki.tsx — тот же класс, но последствие другое: не «список отстал», а
 * «текст под чужим заголовком».
 *
 * Reader-вью рисует scope/slug из состояния `open`, а тело — из `content`.
 * Открыли страницу A, вернулись, открыли B: ответ по A приходит вторым и
 * зовёт setContent — на экране шапка B и содержимое A. Вики — это память
 * агентов, по ней человек делает выводы; страница с чужим текстом под
 * правильным именем хуже, чем пустая.
 */
describe("Wiki.tsx: страница не показывает чужой текст", () => {
  const src = readFileSync(join(SRC, "pages/Wiki.tsx"), "utf8");

  test("openPage применяет ответ только если он ещё актуален", () => {
    expect(src).toContain("useLatestRun");

    const body = bodyOf(src, "async function openPage(");
    const guardAt = body.indexOf("if (!isCurrent()) return");
    const setterAt = body.indexOf("setContent(r.content)");

    expect(guardAt).toBeGreaterThan(-1);
    expect(setterAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(setterAt);
    expect(body).toContain("if (isCurrent()) setPageLoading(false)");
  });

  test("устаревшая ошибка не всплывает поверх открытой страницы", () => {
    const body = bodyOf(src, "async function openPage(");
    const catchAt = body.indexOf("catch (e: any) {");
    expect(catchAt).toBeGreaterThan(-1);
    const inCatch = body.slice(catchAt);
    // Проверяем инвариант, а не написание: до первого сеттера в catch обязана
    // стоять проверка актуальности. Ранний `if (!isCurrent()) return` и
    // обёртка `if (isCurrent()) setPageErr(…)` одинаково верны — важно, что
    // ответ по закрытой странице не доедет до состояния.
    const guardAt = Math.min(
      ...["if (!isCurrent()) return", "if (isCurrent()) setPageErr("]
        .map((s) => inCatch.indexOf(s))
        .filter((i) => i > -1),
    );
    expect(Number.isFinite(guardAt)).toBe(true);
    const firstSetter = Math.min(
      ...["setPageErr(", "setPageDenied("]
        .map((s) => inCatch.indexOf(s))
        .filter((i) => i > -1),
    );
    expect(guardAt).toBeLessThanOrEqual(firstSetter);
  });
});
