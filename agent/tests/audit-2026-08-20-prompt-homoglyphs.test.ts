/**
 * Аудит 2026-08-20: в system-промпте нашлась армянская «Ո» (U+0548) вместо
 * кириллической «О» — в слове ЗАГЛУШОК, то есть ровно в том запрете, ради
 * которого блок DELEGATED_EXECUTION_MANDATE и написан.
 *
 * Такую опечатку не видно ни глазами, ни в code review: символы отрисованы
 * одинаково. Для модели это разные токены, и ключевое слово запрета
 * превращается в мусор. Проверить это можно только машинно — чем тест и
 * занимается.
 *
 * Скоуп — файлы, чей текст уезжает в system-промпт дословно. В комментариях
 * смешение алфавитов безвредно, поэтому комментарии вырезаются.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}

/** Файлы, чей текст попадает в system-промпт как есть. */
const PROMPT_SOURCES = [
  join(ROOT, "lib", "agent-prompts.ts"),
  ...walk(join(ROOT, "characters"), [".ts", ".md"]),
];

/** Комментарии — не промпт. Плюс escape-последовательности: `\nТекст` иначе
 *  читается как слово `nТекст` и даёт ложное «латиница + кириллица». */
function promptTextOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\\[nrtvfb0'"\\]/g, " ")
    .replace(/\\u\{?[0-9a-fA-F]+\}?/g, " ")
    .replace(/\\x[0-9a-fA-F]{2}/g, " ");
}

const SCRIPTS: Array<[string, RegExp]> = [
  ["CYRILLIC", /\p{Script=Cyrillic}/u],
  ["LATIN", /\p{Script=Latin}/u],
  ["GREEK", /\p{Script=Greek}/u],
  ["ARMENIAN", /\p{Script=Armenian}/u],
  ["HEBREW", /\p{Script=Hebrew}/u],
  ["ARABIC", /\p{Script=Arabic}/u],
];

function scriptsOf(word: string): string[] {
  return SCRIPTS.filter(([, re]) => re.test(word)).map(([n]) => n);
}

/**
 * Слова, где смешение алфавитов осмысленно. Пусто — и пусть остаётся пустым:
 * каждая запись сюда это «мы решили, что вот это читать не надо».
 */
const ALLOWED_MIXED = new Set<string>([]);

const WORD = /[\p{L}]{2,}/gu;

function mixedWordsIn(file: string): string[] {
  const text = promptTextOf(readFileSync(file, "utf8"));
  const bad: string[] = [];
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (ALLOWED_MIXED.has(w)) continue;
    if (scriptsOf(w).length > 1) bad.push(w);
  }
  return bad;
}

describe("в system-промптах нет гомоглифов", () => {
  it("сканер вообще что-то нашёл (защита от пустого списка файлов)", () => {
    expect(PROMPT_SOURCES.length).toBeGreaterThanOrEqual(5);
    for (const f of PROMPT_SOURCES) {
      expect(readFileSync(f, "utf8").length).toBeGreaterThan(0);
    }
  });

  for (const file of PROMPT_SOURCES) {
    const rel = file.slice(ROOT.length + 1);
    it(`${rel} — ни одного слова со смешанными алфавитами`, () => {
      expect(mixedWordsIn(file)).toEqual([]);
    });
  }

  it("сам детектор работает: подсунутая армянская Ո ловится", () => {
    // Иначе тест выше зелен ровно потому, что ничего не проверяет.
    const w = "ЗАГЛУШ\u0548К";
    expect(scriptsOf(w).sort()).toEqual(["ARMENIAN", "CYRILLIC"]);
    expect(scriptsOf("ЗАГЛУШОК")).toEqual(["CYRILLIC"]);
  });

  it("escape-последовательности не дают ложных срабатываний", () => {
    // `"\nТекст"` в исходнике — это не слово `nТекст`.
    expect(scriptsOf("nТекст").length).toBe(2);
    expect(promptTextOf('"\\nТекст"')).not.toContain("nТекст");
  });

  it("комментарии не сканируются", () => {
    expect(promptTextOf("// Хардening\nconst a = 1;")).not.toContain("Хардening");
    expect(promptTextOf("/* boт */\nconst a = 1;")).not.toContain("boт");
  });
});

describe("конкретно тот запрет, который был сломан", () => {
  it("DELEGATED_EXECUTION_MANDATE содержит ЗАГЛУШОК кириллицей", async () => {
    const { DELEGATED_EXECUTION_MANDATE } = await import("../lib/agent-prompts.ts");
    expect(DELEGATED_EXECUTION_MANDATE).toContain("НИКАКИХ ЗАГЛУШОК");
    expect(scriptsOf("ЗАГЛУШОК")).toEqual(["CYRILLIC"]);
    expect(DELEGATED_EXECUTION_MANDATE).not.toContain("\u0548");
  });
});
