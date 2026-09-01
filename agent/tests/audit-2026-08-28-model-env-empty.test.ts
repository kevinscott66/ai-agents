/**
 * Аудит 2026-08-28: модель из окружения бралась через `??`.
 *
 * `??` отсекает только отсутствие имени. systemd `EnvironmentFile` на строку
 * `NAME=` заводит переменную с ПУСТОЙ строкой — и это не экзотика, а штатный
 * дефолт поставки: `.env.example` шлёт все четыре ANTHROPIC_*MODEL* пустыми и
 * сам же велит скопировать себя в `.env`.
 *
 * Цена пустой модели разная по путям, и обе плохие: raw-клиент отдаёт
 * `model: ""` в messages.create без нормализации (400 на каждый вызов), а
 * SDK-обёртка собирает аргумент как `...(opts.model ? { model } : {})` — ключ
 * выпадает как falsy, и заявленная дешёвая модель молча подменяется дефолтом
 * CLI. Репозиторий этот класс уже решил у resolveDbPath, resolveMemoryDir и
 * sdkModelOverride; шесть точек выбора модели из договорённости выпали.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "data",
  "backups",
  "coverage",
  ".git",
  "tests",
  "miniapp",
  // Прототип на eliza, снятый с эксплуатации: ни systemd, ни импортом его
  // никто не заводит, чинить мёртвый код ради гейта смысла нет.
  "archive",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("предпосылки", () => {
  test("пустая строка проходит `??` и не проходит `||`", () => {
    const empty = "";
    expect(empty ?? "fallback").toBe("");
    expect(empty || "fallback").toBe("fallback");
  });

  test("поставляемый .env.example задаёт все модели пустыми", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf-8");
    for (const name of [
      "ANTHROPIC_SMALL_MODEL",
      "ANTHROPIC_LARGE_MODEL",
      "ANTHROPIC_SMALL_MODEL_SDK",
      "ANTHROPIC_LARGE_MODEL_SDK",
    ]) {
      expect(env).toMatch(new RegExp(`^${name}=\\s*(#|$)`, "m"));
    }
  });
});

describe("выбор модели", () => {
  const files = walk(ROOT);

  test("дерево обойдено, а не пустой список", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("ни одна модель не берётся из окружения через `??`", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf-8"));
      for (const line of src.split("\n")) {
        if (/process\.env\.ANTHROPIC_\w*MODEL\w*\s*\?\?/.test(line)) {
          hits.push(`${f.slice(ROOT.length)}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("каждое чтение модели обрезает пробелы", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf-8"));
      for (const line of src.split("\n")) {
        if (!/process\.env\.ANTHROPIC_\w*MODEL\w*/.test(line)) continue;
        if (!line.includes("?.trim()")) hits.push(`${f.slice(ROOT.length)}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
