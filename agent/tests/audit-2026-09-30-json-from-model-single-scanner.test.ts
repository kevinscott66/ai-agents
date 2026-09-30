/**
 * Аудит 30.09.2026 — сканер JSON из ответа модели должен быть ОДИН.
 *
 * Предыстория. Функция «найди первый сбалансированный {...}» жила в трёх копиях:
 * `tools/daily-draft.ts`, `lib/fact-check.ts`, `tools/site-editorial.ts`. Ошибку
 * с сырым переводом строки (AUD-043) починили в первой — и прод продолжил падать,
 * потому что на шаге доработки статьи вызывалась вторая. Тесты ниже закрепляют
 * две вещи: обе точки входа обезврежены, и копий больше не появилось.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { balancedJsonSlice } from "../lib/json-from-model.ts";
import { extractJson as extractFactCheckJson } from "../lib/fact-check.ts";

const AGENT_DIR = join(import.meta.dir, "..");

describe("общий сканер", () => {
  test("сырой перевод строки внутри строки больше не ломает разбор", () => {
    const found = balancedJsonSlice('{"body":"первый абзац\nвторой абзац"}');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // Содержимое сохраняется: экранируется запись, а не текст.
    expect((JSON.parse(found.json) as { body: string }).body).toBe("первый абзац\nвторой абзац");
  });

  test("возврат каретки и табуляция тоже", () => {
    const found = balancedJsonSlice('{"a":"x\ry\tz"}');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect((JSON.parse(found.json) as { a: string }).a).toBe("x\ry\tz");
  });

  test("корректный JSON проходит без изменений", () => {
    const src = '{"a":"строка с \\n внутри","b":[1,2,{"c":true}]}';
    const found = balancedJsonSlice(src);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.json).toBe(src);
  });

  test("экранированная кавычка не закрывает строку", () => {
    const found = balancedJsonSlice('{"a":"он сказал \\"да\\" и ушёл"}');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect((JSON.parse(found.json) as { a: string }).a).toBe('он сказал "да" и ушёл');
  });

  test("настоящий обрыв ответа отличим от управляющего символа", () => {
    // Это и есть разница, которую сообщение «Unterminated string» скрывало:
    // у оборванного ответа НЕ СХОДЯТСЯ СКОБКИ.
    const found = balancedJsonSlice('{"articles":[{"title":"начало');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.reason).toBe("unbalanced");
  });

  test("текст без объекта вовсе", () => {
    const found = balancedJsonSlice("извините, не могу помочь");
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.reason).toBe("no-object");
  });

  test("пустой и никакой вход не бросают", () => {
    for (const bad of ["", null, undefined]) {
      const found = balancedJsonSlice(bad as unknown as string);
      expect(found.ok).toBe(false);
    }
  });
});

describe("фактчекер — вторая точка входа, которую починка AUD-043 не закрыла", () => {
  test("сырой перевод строки в ответе фактчекера разбирается", () => {
    const out = extractFactCheckJson('{"verdict":"ok","note":"первая строка\nвторая"}');
    expect(out.verdict).toBe("ok");
    expect(out.note).toBe("первая строка\nвторая");
  });

  test("свои сообщения об ошибках сохранены", () => {
    expect(() => extractFactCheckJson("нет тут ничего")).toThrow("в ответе фактчекера нет JSON-объекта");
    expect(() => extractFactCheckJson('{"a":[{"b":1')).toThrow("незакрытые скобки JSON");
  });
});

test("копий сканера больше не появилось", () => {
  // Признак копии — собственный цикл по символам с флагом «внутри строки».
  // Ищем по всему дереву агента, кроме самого модуля и тестов.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "tests" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith(".ts") || full.endsWith("json-from-model.ts")) continue;
      const src = readFileSync(full, "utf8");
      // Тот самый рукописный сканер: объявление inStr рядом с разбором скобок.
      if (/let\s+inStr\s*=/.test(src) && /depth\s*(\+\+|--)/.test(src)) {
        offenders.push(full.slice(AGENT_DIR.length + 1));
      }
    }
  };
  walk(AGENT_DIR);
  expect(offenders).toEqual([]);
});
