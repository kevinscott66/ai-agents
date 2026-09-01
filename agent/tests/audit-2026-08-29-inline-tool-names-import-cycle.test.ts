// Аудит 2026-08-29: круг импортов делал часть файлов гейта незапускаемой
// поодиночке.
//
// `INLINE_TOOL_NAMES` объявлялся в lib/tools-schema.ts, а lib/agent-sdk-runtime.ts
// выводил из него `SDK_SIDE_EFFECT_FREE_TOOLS` спредом на верхнем уровне модуля.
// Стоило tools-schema.ts оказаться первым вычисляемым модулем — он тянул
// цепочку, доходившую обратно до agent-sdk-runtime.ts, тот брал ещё не
// инициализированный биндинг и падал с «Cannot access 'INLINE_TOOL_NAMES'
// before initialization». Падал при этом не один тест, а загрузка всего файла.
//
// В полном прогоне (786 файлов в одном процессе) порядок задавали соседи, и
// проблема пряталась целиком: гейт был зелёный, а `bun test tests/<файл>.ts`
// на тех же файлах не запускался вообще — то есть отладить упавший тест по
// одному файлу было нельзя.
//
// Лечится не порядком импортов в тестах (он ни на что не влияет — падает вся
// пачка), а переездом константы в лист. Здесь закреплено ровно это.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INLINE_TOOL_NAMES } from "../lib/constants.ts";
import { INLINE_TOOL_NAMES as VIA_SCHEMA } from "../lib/tools-schema.ts";
import { SDK_SIDE_EFFECT_FREE_TOOLS } from "../lib/agent-sdk-runtime.ts";

const LIB = join(import.meta.dir, "..", "lib");
const src = (name: string) => readFileSync(join(LIB, name), "utf8");

/** Строки импорта без комментариев: комментарии тут упоминают имена модулей. */
function importLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .filter((l) => /^\s*(import|}\s*from)\b/.test(l) || /\bfrom\s+"\./.test(l));
}

describe("аудит 2026-08-29: INLINE_TOOL_NAMES живёт в листе", () => {
  test("constants.ts ничего не импортирует — иначе он перестаёт быть листом", () => {
    const offenders = importLines(src("constants.ts"));
    expect(offenders).toEqual([]);
  });

  test("agent-sdk-runtime берёт набор из constants.ts, а не из tools-schema", () => {
    const text = src("agent-sdk-runtime.ts");
    // Именно эта связка и давала TDZ: спред по набору стоит на верхнем уровне.
    const fromSchema = importLines(text).filter(
      (l) => l.includes("INLINE_TOOL_NAMES") && l.includes("tools-schema"),
    );
    expect(fromSchema).toEqual([]);
    expect(text).toContain("SDK_SIDE_EFFECT_FREE_TOOLS");
  });

  test("реэкспорт из tools-schema остался — старые импорты рабочие", () => {
    // Файлов, импортирующих имя оттуда, полдюжины; ломать их переезд не должен.
    expect(VIA_SCHEMA).toBe(INLINE_TOOL_NAMES);
  });

  test("производный набор считается и не пуст", () => {
    // Проверка, что спред отработал по инициализированному биндингу, а не по
    // пустому: при TDZ сюда бы вообще не дошли, при частичной инициализации —
    // получили бы пустое множество.
    expect(SDK_SIDE_EFFECT_FREE_TOOLS.size).toBe(INLINE_TOOL_NAMES.size - 1);
    expect(SDK_SIDE_EFFECT_FREE_TOOLS.has("READ_WIKI")).toBe(true);
    expect(SDK_SIDE_EFFECT_FREE_TOOLS.has("CANCEL_SCHEDULED_POST")).toBe(false);
  });
});
