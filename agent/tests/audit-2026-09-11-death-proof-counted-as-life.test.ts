/**
 * Аудит 2026-09-11: доказательство смерти символа сторож засчитывал за
 * доказательство его жизни.
 *
 * `audit-2026-09-11-stale-symbol-names` ищет имена в обратных кавычках и
 * требует, чтобы такое имя где-то в дереве существовало. «Существует» он
 * определяет грубо и намеренно: любое слово из НЕ-комментарной строки попадает
 * в codeIdents. Но SCAN_ROOTS включает tests/, а тест на удалённый символ
 * пишется ровно двумя способами — `expect(SRC).not.toContain("имя")` и
 * заголовок `test("имя удалён")`. Обе строки не комментарии, обе несут имя
 * дословно. То есть файл, доказывающий, что символа нет, был единственным, что
 * убеждало сторожа в обратном.
 *
 * Цена: двадцать три имени в кавычках пережили собственное удаление —
 * acceptQueryParam, extractPortOnly, gatedAction, deriveBannerTitle,
 * mockSettings, budgetMap, knownTab, TG_TOKEN_ORCHESTRATOR,
 * agent_actions_total, messages_total, read_timeout, write_timeout. Кавычки
 * обещают читателю существование: по такому имени идут грепом и не находят
 * ничего, а комментарий рядом выглядит описанием живого кода.
 *
 * Правка узкая. Из harvest'а вырезаются два куска текста: литеральный аргумент
 * ТЕКСТОВОЙ проверки на отсутствие (`not.toContain`, `not.toMatch`,
 * toContainEqual) и литерал-заголовок `test`/`describe`/`it`. Левая часть
 * выражения и тело блока остаются: имена оттуда настоящие. `not.toBe` не
 * трогается вовсе — он сравнивает значения, а не текст исходника.
 *
 * Чего правка не даёт: смерть доказывают ещё и через
 * `expect("имя" in mod).toBe(false)`, `SRC.indexOf("имя(") === -1` и фильтр по
 * `line.includes("имя")` с пустым результатом. Литерал там неотличим от живого
 * имени без разбора выражения. Четыре таких призрака — checkBacklogAlerts в
 * alerting.ts и db-maint.ts, lastHour/lastDay в trigger-anti-dup.ts, hardSlice
 * в telegram-chunking.ts — сняты чтением и закреплены здесь поимённо, потому
 * что сторож их по-прежнему не увидит.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ABSENCE_ARG,
  TITLE_ARG,
} from "./audit-2026-09-11-stale-symbol-names.test.ts";

/** Обе регулярки с флагом `g`, поэтому только `replace` — `test` нёс бы lastIndex. */
const strip = (s: string) =>
  s.replace(ABSENCE_ARG, ".not.to(").replace(TITLE_ARG, "test(");

const src = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url).pathname, "utf8");

const GUARD = src("tests/audit-2026-09-11-stale-symbol-names.test.ts");

describe("проверка на отсутствие не считается жизнью", () => {
  test("литерал у not.toContain выброшен, а левая часть цела", () => {
    const out = strip('expect(SRC).not.toContain("deriveBannerTitle");');
    expect(out).not.toContain("deriveBannerTitle");
    expect(out).toContain("expect(SRC)");
  });

  test("то же у not.toMatch с регулярным литералом", () => {
    const out = strip("expect(SRC).not.toMatch(/setEditingBudgets\\(budgetMap\\(/);");
    expect(out).not.toContain("budgetMap");
  });

  test("аргумент на следующей строке тоже выброшен", () => {
    const out = strip('expect(SRC).not.toContain(\n  "deriveBannerTitle",\n);');
    expect(out).not.toContain("deriveBannerTitle");
  });

  test("одинарные кавычки и обратные — тот же случай", () => {
    expect(strip("expect(S).not.toContain('knownTab');")).not.toContain("knownTab");
    expect(strip("expect(S).not.toContain(`knownTab`);")).not.toContain("knownTab");
  });

  test("проверка на НАЛИЧИЕ не трогается — это доказательство жизни", () => {
    expect(strip('expect(SRC).toContain("deriveTitle");')).toContain("deriveTitle");
  });

  test("not.toBe остаётся: он про значение, а не про текст исходника", () => {
    const line = 'expect(coldStorageFileName("messages_archive", NOW)).not.toBe("x");';
    expect(strip(line)).toContain("messages_archive");
  });
});

describe("заголовок теста — проза, а не код", () => {
  test("имя из заголовка test() не засчитывается", () => {
    expect(strip('test("deriveBannerTitle удалён", () => {')).not.toContain(
      "deriveBannerTitle",
    );
  });

  test("то же у describe() и it()", () => {
    expect(strip('describe("мёртвая hardSlice удалена", () => {')).not.toContain(
      "hardSlice",
    );
    expect(strip('it("gatedAction не вернулся", () => {')).not.toContain("gatedAction");
  });

  test("тело блока остаётся — имена оттуда настоящие", () => {
    const out = strip('test("заголовок", () => {\n  expect(deriveTitle("a")).toBe("a");');
    expect(out).toContain("deriveTitle");
  });

  test("нелитеральный заголовок не трогаем", () => {
    expect(strip("test(nameFromVariable, () => {")).toContain("nameFromVariable");
  });

  test("вырезается ровно заголовок, а не всё до конца строки", () => {
    const out = strip('test("проза", () => expect(realSymbolName).toBe(1));');
    expect(out).toContain("realSymbolName");
  });
});

describe("призраки, которых сторож не увидит, сняты руками", () => {
  const bare = (file: string, name: string) => {
    const s = src(file);
    expect(s).toContain(name);
    expect(s).not.toContain(`\`${name}\``);
    expect(s).not.toContain(`\`${name}()\``);
  };

  test("checkBacklogAlerts без кавычек в обоих файлах", () => {
    bare("lib/alerting.ts", "checkBacklogAlerts");
    bare("lib/db-maint.ts", "checkBacklogAlerts");
  });

  test("lastHour и lastDay без кавычек, а живой total рядом — в кавычках", () => {
    bare("lib/trigger-anti-dup.ts", "lastHour");
    bare("lib/trigger-anti-dup.ts", "lastDay");
    // `total` поле возвращаемого типа, оно есть — кавычки тут честные.
    expect(src("lib/trigger-anti-dup.ts")).toContain("`total`");
  });

  test("hardSlice: файл больше не противоречит сам себе", () => {
    bare("lib/telegram-chunking.ts", "hardSlice");
  });
});

describe("сторож остался сторожем", () => {
  test("tests/ по-прежнему в SCAN_ROOTS — иначе вырезать было бы нечего", () => {
    const roots = GUARD.slice(GUARD.indexOf("const SCAN_ROOTS"), GUARD.indexOf("]", GUARD.indexOf("const SCAN_ROOTS")));
    expect(roots).toContain('"tests"');
  });

  test("вырезание применяется в harvest, а не объявлено впустую", () => {
    const fn = GUARD.slice(GUARD.indexOf("function collectIdents"));
    expect(fn).toContain("ABSENCE_ARG");
    expect(fn).toContain("TITLE_ARG");
  });

  test("api_id и api_hash ушли в EXTERNAL, а не в кавычки-без-проверки", () => {
    const ext = GUARD.slice(GUARD.indexOf("const EXTERNAL:"), GUARD.indexOf("const COMMENT_LINE"));
    expect(ext).toContain('api_id: "telegram"');
    expect(ext).toContain('api_hash: "telegram"');
  });
});
