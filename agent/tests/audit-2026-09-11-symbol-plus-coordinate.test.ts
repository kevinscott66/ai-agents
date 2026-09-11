/**
 * Аудит 2026-09-11, круг 24: связка «имя символа плюс номер строки» —
 * `symbol` (file.ts:N) — врала в 19 случаях из 25.
 *
 * Круг 20 завёл проверку «координата указывает хоть на что-то» и сам же в
 * своей докстроке сформулировал правило на будущее: «НЕ подгонять номер.
 * Убрать номер и назвать символ». Правило осталось советом, и связка, в
 * которой символ УЖЕ назван, продолжала копиться — а вместе с ней и её гниль.
 * Замер по дереву: 25 мест, где за именем в обратных кавычках сразу идёт
 * скобка с координатой; 19 из них указывали мимо на 8–500 строк.
 * `LOW_FRICTION_ACTIONS` (permissions.ts) звали по номеру 860 при настоящем
 * 347, `snapshotOf` (mac-bridge.ts) — по 294 при 517.
 *
 * Ровно в этой связке номер не добавляет НИЧЕГО: имя уже сказано, найти его
 * grep'ом дешевле, чем открыть файл на строке. Зато ломается номер от любой
 * вставки выше по файлу — а имя не ломается вовсе. Поэтому здесь не «сверь
 * номер», а «номера тут быть не должно»: проверка, которую не нужно чинить
 * после каждого рефакторинга, и которую нельзя удовлетворить подгонкой.
 *
 * Что делать, когда тест упал: убрать `:N`. `foo` (bar.ts) — законно,
 * `foo` в bar.ts — тоже. Номер остаётся законным там, где называть нечего,
 * и это по-прежнему стережёт tests/audit-2026-09-11-stale-line-coordinates.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["lib", "orchestrator", "tests", "tools", "mac-daemon", "miniapp/src"];

/**
 * Имя в обратных кавычках, сразу за ним — скобка с координатой.
 *
 * «Сразу за ним» важно: между именем и координатой нельзя пускать прозу,
 * иначе в связку попадут предложения, где номер относится не к этому имени.
 * Пробел допускаем, слова — нет.
 */
const SYMBOL_THEN_COORD =
  /`[A-Za-z_][A-Za-z0-9_]*`\s*\(`?[A-Za-z0-9_./-]+\.tsx?:\d+`?\)/;

/** Дефект — врущий комментарий; в коде такая строка это фикстура. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("имя символа и номер строки не ходят парой", () => {
  test("после имени в кавычках не стоит координата", () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (!COMMENT_LINE.test(line)) return;
            const m = line.match(SYMBOL_THEN_COORD);
            if (m) found.push(`${file}:${i + 1} → ${m[0]}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});
