/**
 * T-810: у SSE-события может не быть эмиттера, и заметить это неоткуда —
 * подписка молча ждёт вечно, а панель в Mini App просто пустая. Ровно так жил
 * `mac.output`: имя встречалось в репо дважды — подписка в Mini App и
 * тавтологический тест «структура события валидна», который строил объект из
 * собственного локального интерфейса и проверял типы его же полей. Тест был
 * зелёным при любом состоянии репозитория и создавал впечатление, что событие
 * реализовано.
 *
 * Этот тест проверяет обратное направление: у каждого имени, на которое Mini
 * App подписан, должен быть эмиттер в коде сервера. Известные исключения
 * перечислены явно и списком, который может только сокращаться.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * `mac.output` — поток вывода claude-сессии с Mac. Мост (`mac-daemon`) отдаёт
 * только финальный результат вызова, потокового канала у него нет, так что
 * эмиттер потребует отдельной работы на стороне демона и рестарта на Mac.
 * Подписка оставлена намеренно: она безвредна и включится сама, когда эмиттер
 * появится. Список — не «разрешено забить», а «известно и посчитано».
 */
const KNOWN_UNIMPLEMENTED = ["mac.output"];

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

function namesFrom(files: string[], re: RegExp): Set<string> {
  const found = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) found.add(m[1]!);
  }
  return found;
}

const SUBSCRIBE_RE = /sseSubscribe\(\s*"([a-z][a-z.]*)"/g;
// И `emit(...)` из events-bus, и реэкспорт `busEmit(...)` — оба варианта в ходу.
const EMIT_RE = /\bbus[Ee]mit\(\s*"([a-z][a-z.]*)"|(?<![a-zA-Z])emit\(\s*"([a-z][a-z.]*)"/g;

function emitted(): Set<string> {
  const files = ["lib", "orchestrator", "tools"].flatMap((d) =>
    walk(join(ROOT, d), [".ts"]),
  );
  const found = new Set<string>();
  for (const f of files) {
    if (f.endsWith("events-bus.ts")) continue; // объявление шины, а не эмиссия
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(EMIT_RE)) found.add((m[1] ?? m[2])!);
  }
  return found;
}

const subscribed = namesFrom(
  walk(join(ROOT, "miniapp", "src"), [".ts", ".tsx"]),
  SUBSCRIBE_RE,
);

describe("T-810: у каждой SSE-подписки есть эмиттер", () => {
  test("Mini App вообще на что-то подписан (сторож самого теста)", () => {
    expect(subscribed.size).toBeGreaterThan(4);
    expect(subscribed.has("task.updated")).toBe(true);
  });

  test("нет подписок без эмиттера, кроме известного списка", () => {
    const live = emitted();
    const dead = [...subscribed]
      .filter((n) => !live.has(n))
      .filter((n) => !KNOWN_UNIMPLEMENTED.includes(n))
      .sort();
    expect(dead).toEqual([]);
  });

  test("список известных исключений не разросся", () => {
    // Если эмиттер появился — имя убирается отсюда, и предыдущий тест начинает
    // его сторожить. Если список пополнился — это осознанное решение, а не
    // побочный эффект правки.
    expect(KNOWN_UNIMPLEMENTED).toEqual(["mac.output"]);
  });

  test("известное исключение всё ещё исключение, а не забытое имя", () => {
    // Обратная сторона: если mac.output кто-то реализовал, тест напомнит убрать
    // его из списка, а не оставит вечное «известное» пятно.
    const live = emitted();
    for (const n of KNOWN_UNIMPLEMENTED) {
      expect(live.has(n)).toBe(false);
      expect(subscribed.has(n)).toBe(true);
    }
  });
});
