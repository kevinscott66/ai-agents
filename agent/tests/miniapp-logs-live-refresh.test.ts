/**
 * Аудит 2026-08-10: живое обновление логов отматывало чтение к первой странице.
 *
 * Подписка на `action.executed` звала `load(true)` — полный сброс набора.
 * Пока страница одна, это и есть желаемое поведение: свежие действия
 * появляются сами. Но после «Показать ещё» тот же сброс выбрасывает все
 * догруженные страницы, а событие приходит на каждое исполненное действие
 * любого из 12 агентов в любом чате. Чем дальше пользователь ушёл в историю,
 * тем вернее его оттуда выкинет — и тем меньше шансов дочитать.
 *
 * Инвариант: живое событие не уничтожает то, что пользователь уже догрузил.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveActionMode } from "../miniapp/src/pages/Logs.tsx";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Logs.tsx"),
  "utf8",
);

describe("живое событие не сбрасывает догруженные страницы", () => {
  test("на первой странице обновляем сразу", () => {
    expect(liveActionMode(false)).toBe("reload");
  });

  test("после догрузки — только помечаем", () => {
    expect(liveActionMode(true)).toBe("notify");
  });

  test("подписка проходит через это решение, а не зовёт сброс напрямую", () => {
    const handler = SRC.slice(
      SRC.indexOf('sseSubscribe("action.executed"'),
    ).slice(0, 300);
    expect(handler).toContain("liveActionMode");
    // Прежняя форма — `sseSubscribe("action.executed", () => load(true))`.
    expect(handler).not.toMatch(/sseSubscribe\("action\.executed",\s*\(\)\s*=>\s*load\(true\)\)/);
  });

  test("пометка снимается только перезагрузкой набора", () => {
    // Иначе баннер «есть новые» останется висеть после обновления.
    // Оба якоря проверяем: пропавший конец даёт -1, `slice(start, -1)` —
    // весь остаток файла, и утверждение начинает выполняться где угодно, а не
    // внутри `load()`. Проверено переименованием якоря — тест оставался
    // зелёным.
    const start = SRC.indexOf("async function load(");
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf("// Reload server-side");
    expect(end).toBeGreaterThan(start);
    const body = SRC.slice(start, end);
    expect(body).toContain("setLiveWaiting(false)");
    expect(body).toContain("paged.current = true");
  });

  test("у пользователя есть чем подтянуть новые записи", () => {
    expect(SRC).toContain("liveWaiting &&");
    expect(SRC).toMatch(/liveWaiting[\s\S]{0,400}onClick=\{\(\) => load\(true\)\}/);
  });
});
